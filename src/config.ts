// ship.json (the repo's settings), and the machine's files in
// ~/.config/ship: the apps set up here, and settings like the API key's
// references.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { run } from "./exec";
import { canonicalRoot, checkoutTop, mainCheckout, worktreeRoots } from "./git";
import { ShipError, ui } from "./ui";

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

export const appsPath = appsFile;

// MARK: The machine's apps

const sameBundle = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const byName = (a: AppEntry, b: AppEntry) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root);

/**
 * Heals the app list: entries for the same app (bundle id) in the same repo
 * (canonical root, which maps a worktree to its main checkout) collapse into
 * one at the canonical root, keeping the earliest addedAt. An entry whose
 * folder is gone (`canonical` returns undefined) is dropped when another
 * entry has the same bundle id.
 */
export function dedupeApps(entries: AppEntry[], canonical: (root: string) => string | undefined): AppEntry[] {
  const groups = new Map<string, { entries: AppEntry[]; root: string }>();
  const gone: AppEntry[] = [];
  for (const entry of entries) {
    const root = canonical(entry.root);
    if (root === undefined) {
      gone.push(entry);
      continue;
    }
    const key = `${entry.bundleId.toLowerCase()}\0${root}`;
    const group = groups.get(key) ?? { entries: [], root };
    group.entries.push(entry);
    groups.set(key, group);
  }
  const healed = [...groups.values()].map(({ entries: group, root }) => {
    const earliest = group.reduce((a, b) => (b.addedAt < a.addedAt ? b : a));
    const latest = group.reduce((a, b) => (b.addedAt > a.addedAt ? b : a));
    // The name from the main checkout's entry, else the newest (init again renames it).
    const named = group.find((entry) => entry.root === root) ?? latest;
    return { name: named.name, bundleId: named.bundleId, root, addedAt: earliest.addedAt };
  });
  for (const entry of gone) {
    if (!healed.some((other) => sameBundle(other.bundleId, entry.bundleId))) healed.push(entry);
  }
  return healed.sort(byName);
}

/** The apps this machine knows, healed of duplicates from worktrees (written back when that changed something). */
export async function loadApps(): Promise<AppEntry[]> {
  const entries = await readJSON<AppEntry[]>(appsFile, []);
  if (!Array.isArray(entries)) {
    throw new ShipError(`${appsFile} isn't a list of apps`, "bad-json", `Fix or delete ${appsFile}, then run \`ship init\` in each app's repo.`);
  }
  // Only apps listed more than once can be duplicates, so only they cost a git call.
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.bundleId.toLowerCase(), (counts.get(entry.bundleId.toLowerCase()) ?? 0) + 1);
  const roots = new Map<string, string | undefined>();
  await Promise.all(
    entries.map(async (entry) => {
      const exists = existsSync(entry.root);
      roots.set(entry.root, !exists ? undefined : (counts.get(entry.bundleId.toLowerCase()) ?? 0) > 1 ? await canonicalRoot(entry.root) : entry.root);
    }),
  );
  const healed = dedupeApps(entries, (root) => roots.get(root));
  if (JSON.stringify(healed) !== JSON.stringify([...entries].sort(byName))) await writeJSON(appsFile, healed);
  return healed;
}

/**
 * Adds an app, at its canonical root: `ship init` in a worktree registers the
 * main checkout, so worktrees never show up as apps of their own. Replaces an
 * entry for the same app in the same repo, keeping when it was first added.
 * Returns the root it saved.
 */
export async function rememberApp(entry: Omit<AppEntry, "addedAt">) {
  const root = await canonicalRoot(entry.root);
  const apps = await loadApps();
  const replaced: AppEntry[] = [];
  const kept: AppEntry[] = [];
  for (const app of apps) {
    const same = app.root === root || app.root === entry.root || (sameBundle(app.bundleId, entry.bundleId) && (await canonicalRoot(app.root)) === root);
    (same ? replaced : kept).push(app);
  }
  const addedAt = replaced.map((app) => app.addedAt).sort()[0] ?? new Date().toISOString();
  kept.push({ ...entry, root, addedAt });
  await writeJSON(appsFile, kept.sort(byName));
  return root;
}

/** Forgets the app at `root` (or at the main checkout `root` is a worktree of). Returns whether it was known. */
export async function forgetApp(root: string) {
  const canonical = await canonicalRoot(root);
  const apps = await loadApps();
  const kept = apps.filter((app) => app.root !== root && app.root !== canonical);
  await writeJSON(appsFile, kept);
  return apps.length !== kept.length;
}

/** Apps whose name or bundle id is `query`, ignoring case. */
export function matchApps(apps: AppEntry[], query: string): AppEntry[] {
  const q = query.trim().toLowerCase();
  return apps.filter((app) => app.name.toLowerCase() === q || app.bundleId.toLowerCase() === q);
}

/**
 * The app `--app <query>` means: a name or bundle id, ignoring case. Two
 * different apps with the name is an error naming their bundle ids; the same
 * app in two clones picks the one whose ship.json is there.
 */
export async function findApp(query: string): Promise<AppEntry> {
  const apps = await loadApps();
  const matches = matchApps(apps, query);
  if (!matches.length) {
    throw new ShipError(
      `No app called "${query}" on this machine`,
      "unknown-app",
      apps.length ? `Known apps: ${apps.map((a) => a.name).join(", ")}. See \`ship apps\`.` : "Run `ship init` in the app's repo first.",
      { choices: apps.map((a) => a.name) },
    );
  }
  const bundles = [...new Set(matches.map((app) => app.bundleId))];
  if (bundles.length > 1) {
    throw new ShipError(
      `${matches.length} apps are called "${query}": ${bundles.join(", ")}`,
      "ambiguous-app",
      `Pick one by bundle id: --app ${bundles[0]}`,
      { choices: bundles },
      2,
    );
  }
  return matches.find((app) => existsSync(join(app.root, CONFIG_FILE))) ?? matches[0]!;
}

/**
 * Where an app's ship.json is: its root, or when that checkout doesn't have
 * it yet (ship init ran in a worktree that isn't merged), the first worktree
 * that does, for the same bundle id. undefined when there's none.
 */
export async function locateConfig(entry: AppEntry): Promise<string | undefined> {
  if (existsSync(join(entry.root, CONFIG_FILE))) return entry.root;
  const [main, top] = await Promise.all([mainCheckout(entry.root), checkoutTop(entry.root)]);
  const sub = main && top ? relative(top, entry.root) : "";
  for (const worktree of await worktreeRoots(entry.root)) {
    const root = join(worktree, sub);
    if (root === entry.root || !existsSync(join(root, CONFIG_FILE))) continue;
    const config = await readJSON<Partial<ProjectConfig> | null>(join(root, CONFIG_FILE), null).catch(() => null);
    if (config?.bundleId && sameBundle(config.bundleId, entry.bundleId)) return root;
  }
  return undefined;
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
  if (options.app) return projectFor(await findApp(options.app));
  const root = findConfigRoot(options.cwd ?? process.cwd());
  if (!root) {
    throw new ShipError(
      "This folder isn't set up for ship",
      "no-config",
      "Run `ship init` at the repo root, or pass `--app <name>` (see `ship apps`).",
    );
  }
  return projectAt(root);
}

/** An app from the machine's list, preferring its main checkout; a worktree's ship.json when the main one has none yet. */
export async function projectFor(entry: AppEntry): Promise<Project> {
  const root = await locateConfig(entry);
  if (!root) {
    throw new ShipError(
      `${entry.name}'s ship.json is missing from ${entry.root}`,
      "missing-config",
      `The repo may have moved. Run \`ship init\` there again, or \`ship remove --app ${entry.bundleId}\`.`,
    );
  }
  if (root !== entry.root) ui.note(`Using ${root}: ${entry.root} has no ${CONFIG_FILE} yet`);
  return projectAt(root);
}

/** The project whose ship.json is in `root`. */
async function projectAt(root: string): Promise<Project> {
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
