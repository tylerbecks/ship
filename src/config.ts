import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { run } from "./exec";
import { ShipError } from "./ui";

export const CONFIG_FILE = "ship.json";

/** What `ship init` writes to the repo. Committed, so every clone and worktree has it. */
export interface ProjectConfig {
  /** The app's name, for display. */
  name: string;
  /** `xcodeproj`, `xcworkspace`, or `swiftpm` (an App Playground package). */
  kind: ProjectKind;
  /** The project, workspace, or package, relative to the repo root. */
  path: string;
  scheme: string;
  bundleId: string;
  teamId?: string;
  /** The app's App Store Connect id, filled in once credentials are set up. */
  ascAppId?: string;
  /** TestFlight groups `ship beta` adds builds to. */
  groups?: {
    internal?: string[];
    external?: string[];
  };
}

export type ProjectKind = "xcodeproj" | "xcworkspace" | "swiftpm";

/** A project found from the current directory. */
export interface Project {
  /** The folder holding ship.json (normally the repo root). */
  root: string;
  config: ProjectConfig;
  /** Absolute path to the project, workspace, or package. */
  projectPath: string;
  /** Where build products and logs go, inside the repo so worktrees never collide. */
  workDir: string;
}

// MARK: Machine-level files

export const shipHome = process.env.SHIP_HOME ?? join(homedir(), ".config", "ship");
const appsFile = join(shipHome, "apps.json");
const settingsFile = join(shipHome, "config.json");

/** Machine settings. Values can be literal, `op://vault/item/field` (1Password), or `env:NAME`. */
export interface Settings {
  credentials?: {
    keyId?: string;
    issuerId?: string;
    /** The .p8 contents, as an op:// or env: reference, or `file:<path>`. */
    privateKey?: string;
  };
  /** The 1Password account for `op read`, when you have more than one. */
  opAccount?: string;
  /** Days to keep the resolved key in the macOS Keychain (default 7; 0 turns it off). */
  cacheDays?: number;
}

/** The apps this machine knows about, for `ship apps` and `--app`. */
export interface AppEntry {
  name: string;
  bundleId: string;
  root: string;
  addedAt: string;
}

async function readJSON<T>(path: string, fallback: T): Promise<T> {
  const file = Bun.file(path);
  if (!(await file.exists())) return fallback;
  try {
    return (await file.json()) as T;
  } catch {
    throw new ShipError(`${path} isn't valid JSON`, "bad-json", `Fix or delete ${path}.`);
  }
}

async function writeJSON(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(data, null, 2) + "\n");
}

export const loadSettings = () => readJSON<Settings>(settingsFile, {});
export const saveSettings = (settings: Settings) => writeJSON(settingsFile, settings);
export const settingsPath = settingsFile;

export const loadApps = () => readJSON<AppEntry[]>(appsFile, []);

export async function rememberApp(entry: Omit<AppEntry, "addedAt">) {
  const apps = (await loadApps()).filter((app) => app.root !== entry.root);
  apps.push({ ...entry, addedAt: new Date().toISOString() });
  apps.sort((a, b) => a.name.localeCompare(b.name));
  await writeJSON(appsFile, apps);
}

export async function forgetApp(root: string) {
  const apps = await loadApps();
  const kept = apps.filter((app) => app.root !== root);
  await writeJSON(appsFile, kept);
  return apps.length !== kept.length;
}

// MARK: Finding the project

/** The folder with ship.json at or above `from`. */
export function findConfigRoot(from: string): string | undefined {
  let dir = resolve(from);
  while (true) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The git repo root, or the folder itself when it isn't in a repo. */
export async function repoRoot(from: string): Promise<string> {
  const result = await run(["git", "rev-parse", "--show-toplevel"], { cwd: from });
  return result.code === 0 ? result.stdout.trim() : resolve(from);
}

/**
 * The project for this command: from `--app` (a name or bundle id this
 * machine knows), or from the ship.json at or above the current directory.
 */
export async function loadProject(options: { app?: string; cwd?: string } = {}): Promise<Project> {
  let root: string | undefined;
  if (options.app) {
    const apps = await loadApps();
    const query = options.app.toLowerCase();
    const match = apps.find(
      (app) => app.name.toLowerCase() === query || app.bundleId.toLowerCase() === query,
    );
    if (!match) {
      throw new ShipError(
        `No app called "${options.app}" on this machine`,
        "unknown-app",
        apps.length ? `Known apps: ${apps.map((a) => a.name).join(", ")}. See \`ship apps\`.` : "Run `ship init` in the app's repo first.",
      );
    }
    root = match.root;
    if (!existsSync(join(root, CONFIG_FILE))) {
      throw new ShipError(
        `${match.name}'s ship.json is missing from ${root}`,
        "missing-config",
        `The repo may have moved. Run \`ship init\` there again, or \`ship remove --app ${match.name}\`.`,
      );
    }
  } else {
    root = findConfigRoot(options.cwd ?? process.cwd());
    if (!root) {
      throw new ShipError(
        "This folder isn't set up for ship",
        "no-config",
        "Run `ship init` at the repo root, or pass `--app <name>` (see `ship apps`).",
      );
    }
  }
  const config = await readJSON<ProjectConfig | null>(join(root, CONFIG_FILE), null);
  if (!config?.path || !config.scheme || !config.bundleId || !config.kind) {
    throw new ShipError(
      `${join(root, CONFIG_FILE)} is missing required fields`,
      "bad-config",
      "Run `ship init --force` to detect them again.",
    );
  }
  return {
    root,
    config,
    projectPath: join(root, config.path),
    workDir: join(root, ".ship"),
  };
}

export async function saveProjectConfig(root: string, config: ProjectConfig) {
  await writeJSON(join(root, CONFIG_FILE), config);
}

export function removeProjectConfig(root: string) {
  rmSync(join(root, CONFIG_FILE), { force: true });
}

export const relativeTo = (root: string, path: string) => relative(root, path) || ".";
