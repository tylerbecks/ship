import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { lookupApp } from "../asc/api";
import { hasCredentials } from "../credentials";
import {
  CONFIG_FILE,
  type ProjectConfig,
  findConfigRoot,
  relativeTo,
  rememberApp,
  repoRoot,
  saveProjectConfig,
} from "../config";
import { ShipError, ui } from "../ui";
import { type XcodeContainer, appSettings, findContainers, listSchemes, packageSettings } from "../xcode";

export const initHelp = `ship init [--project <path>] [--scheme <name>] [--force]

Sets up the current repo for ship: finds the Xcode project (or .swiftpm
package), the scheme that builds the app, and its bundle id, then writes
ship.json at the repo root. Commit that file: every clone and worktree is
then set up too.

When there's more than one project or scheme, it says which and how to pick.

  --project <path>  The .xcodeproj, .xcworkspace, or .swiftpm to use
  --scheme <name>   The scheme that builds the app
  --force           Replace an existing ship.json`;

export async function init(options: { project?: string; scheme?: string; force?: boolean }) {
  const root = await repoRoot(process.cwd());
  const existing = findConfigRoot(process.cwd());
  if (existing && !options.force) {
    throw new ShipError(
      `Already set up: ${join(existing, CONFIG_FILE)}`,
      "already-initialized",
      "Run `ship init --force` to detect everything again, or `ship remove` to undo it.",
    );
  }

  ui.step("Looking for the app's Xcode project");
  const container = pickContainer(root, options.project);
  ui.ok(`Project: ${relativeTo(root, container.path)}`);

  const scheme = await pickScheme(root, container, options.scheme);
  ui.ok(`Scheme: ${scheme}`);

  ui.step("Reading build settings");
  const settings = container.kind === "swiftpm" ? await packageSettings(container.path) : await appSettings(container, scheme);
  const bundleId = settings.bundleId;
  if (!bundleId) {
    throw new ShipError(`The scheme "${scheme}" has no bundle identifier`, "no-bundle-id", "Set one in Xcode (Signing & Capabilities), then run `ship init` again.");
  }

  const config: ProjectConfig = {
    name: settings.productName,
    kind: container.kind,
    path: relativeTo(root, container.path),
    scheme,
    bundleId,
    teamId: settings.teamId,
  };

  // With App Store Connect credentials, link the app now so later commands
  // don't have to look it up.
  if (await hasCredentials()) {
    ui.step("Finding the app in App Store Connect");
    const app = await lookupApp(bundleId);
    if (app) {
      config.ascAppId = app.id;
      ui.ok(`App Store Connect: ${app.name} (${app.id})`);
    } else {
      ui.warn(`No App Store Connect app uses ${bundleId} yet. Create it, then run \`ship init --force\`.`);
    }
  }

  await saveProjectConfig(root, config);
  await rememberApp({ name: config.name, bundleId, root });
  const ignored = await ignoreWorkDir(root);

  ui.result({ config, file: join(root, CONFIG_FILE) }, () => {
    console.log(`Set up ${config.name} (${bundleId}).`);
    console.log(`Wrote ${CONFIG_FILE}. Commit it, and every clone and worktree is set up too.`);
    if (ignored) console.log("Added .ship/ (build products and logs) to .gitignore.");
  });
}

function pickContainer(root: string, project?: string): XcodeContainer {
  if (project) {
    const path = resolve(process.cwd(), project);
    const kind = path.endsWith(".xcodeproj") ? "xcodeproj" : path.endsWith(".xcworkspace") ? "xcworkspace" : path.endsWith(".swiftpm") ? "swiftpm" : undefined;
    if (!kind || !existsSync(path)) {
      throw new ShipError(`Not a project: ${project}`, "bad-project", "Pass a .xcodeproj, .xcworkspace, or .swiftpm folder.", undefined, 2);
    }
    return { kind, path };
  }
  const found = findContainers(root);
  if (found.length === 1) return found[0]!;
  if (found.length === 0) {
    throw new ShipError("No Xcode project, workspace, or .swiftpm package in this repo", "no-project", "Run `ship init` from the app's repo, or pass --project <path>.");
  }
  const choices = found.map((item) => relativeTo(root, item.path));
  throw new ShipError(
    `This repo has ${found.length} projects: ${choices.join(", ")}`,
    "ambiguous-project",
    `Pick one: ship init --project ${choices[0]}`,
    { choices },
    2,
  );
}

async function pickScheme(root: string, container: XcodeContainer, scheme?: string): Promise<string> {
  const schemes = await listSchemes(container);
  if (scheme) {
    if (!schemes.includes(scheme)) {
      throw new ShipError(`No scheme called "${scheme}"`, "bad-scheme", `Schemes: ${schemes.join(", ")}`, { choices: schemes }, 2);
    }
    return scheme;
  }
  if (schemes.length === 1) return schemes[0]!;
  // When one scheme is named after the project, that's almost always the app.
  const named = basename(container.path).replace(/\.(xcodeproj|xcworkspace|swiftpm)$/, "");
  const match = schemes.find((s) => s === named);
  if (match) {
    ui.note(`Picked "${match}" from ${schemes.join(", ")}. Use --scheme to choose another.`);
    return match;
  }
  throw new ShipError(
    `${relativeTo(root, container.path)} has ${schemes.length} schemes: ${schemes.join(", ")}`,
    "ambiguous-scheme",
    `Pick the one that builds the app: ship init --scheme "${schemes[0]}"`,
    { choices: schemes },
    2,
  );
}

/** Adds .ship/ to the repo's .gitignore. Returns whether it changed anything. */
async function ignoreWorkDir(root: string): Promise<boolean> {
  const file = Bun.file(join(root, ".gitignore"));
  const text = (await file.exists()) ? await file.text() : "";
  if (text.split("\n").some((line) => line.trim() === ".ship/" || line.trim() === ".ship")) return false;
  await Bun.write(join(root, ".gitignore"), `${text}${text && !text.endsWith("\n") ? "\n" : ""}# ship: build products and logs\n.ship/\n`);
  return true;
}
