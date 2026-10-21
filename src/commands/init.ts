// ship init: find the app's project and scheme, and write ship.json.

import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { lookupApp } from "../asc/apps";
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
import { type Command, boolFlag, stringFlag } from "../command";
import { ShipError, ui } from "../ui";
import { DEFAULT_PLATFORM, type Platform, checkCatalyst, parsePlatform, platformInfo } from "../platform";
import { type AppSettings, type XcodeContainer, appSettings, findContainers, listSchemes, packageSettings } from "../xcode";

export const initHelp = `ship init [--project <path>] [--scheme <name>] [--platform <name>] [--force]

Sets up the current repo for ship: finds the Xcode project (or .swiftpm
package), the scheme that builds the app, and its bundle id, then writes
ship.json at the repo root. Commit that file: every clone and worktree is
then set up too.

When there's more than one project or scheme, it says which and how to pick.

  --project <path>  The .xcodeproj, .xcworkspace, or .swiftpm to use
  --scheme <name>   The scheme that builds the app
  --platform <name> ios, macos, tvos, or visionos (detected when left out)
  --force           Replace an existing ship.json`;

export async function init(options: { project?: string; scheme?: string; platform?: string; force?: boolean }) {
  const requested = options.platform !== undefined ? parsePlatform(options.platform) : undefined;
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
  if (container.kind === "swiftpm" && requested && requested !== "ios") {
    throw new ShipError("App Playground packages build for iOS only", "usage", "Leave out --platform, or pass --platform ios.", { choices: ["ios"] }, 2);
  }
  // Read as the scheme builds by default to see which platforms it supports, then as the chosen one.
  let settings = container.kind === "swiftpm" ? await packageSettings(container.path) : await appSettings(container, scheme);
  if (requested && settings.platformSettings) checkCatalyst(requested, settings.platformSettings);
  const platform = choosePlatform(requested, settings);
  if (container.kind !== "swiftpm" && (platform !== settings.platform || (settings.platforms?.length ?? 0) > 1)) {
    settings = { ...(await appSettings(container, scheme, platform)), platforms: settings.platforms };
  }
  if (platform !== "ios" || (settings.platforms?.length ?? 0) > 1) ui.ok(`Platform: ${platformInfo(platform).title}`);
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
    platform,
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
  const registered = await rememberApp({ name: config.name, bundleId, root });
  if (registered !== realpathSync(root)) ui.note(`This is a worktree; ship knows the app by its main checkout, ${registered}`);
  const ignored = await ignoreWorkDir(root);

  ui.result({ config, file: join(root, CONFIG_FILE) }, () => {
    console.log(`Set up ${config.name} (${bundleId}).`);
    console.log(`Wrote ${CONFIG_FILE}. Commit it, and every clone and worktree is set up too.`);
    if (ignored) console.log("Added .ship/ (build products and logs) to .gitignore.");
  });
}

/**
 * The platform to ship: --platform when given, else what the target builds
 * for first (iOS before macOS, tvOS, visionOS). A target that supports more
 * than one gets a note about --platform.
 */
export function choosePlatform(requested: Platform | undefined, settings: Pick<AppSettings, "platform" | "platforms">): Platform {
  if (requested) {
    if (settings.platforms?.length && !settings.platforms.includes(requested)) {
      throw new ShipError(
        `The app doesn't build for ${platformInfo(requested).title}`,
        "bad-platform",
        `It builds for ${settings.platforms.map((p) => platformInfo(p).title).join(", ")}: ship init --platform ${settings.platforms[0]}`,
        { choices: settings.platforms },
        2,
      );
    }
    return requested;
  }
  const platform = settings.platform ?? DEFAULT_PLATFORM;
  const others = (settings.platforms ?? []).filter((p) => p !== platform);
  if (others.length) ui.note(`It also builds for ${others.map((p) => platformInfo(p).title).join(", ")}; pick one with --platform.`);
  return platform;
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

export const commands: Command[] = [
  {
    name: "init",
    index: [{ section: "setup", label: "init", summary: "Find the app's project and scheme; write ship.json" }],
    help: initHelp,
    flags: { project: { type: "string" }, scheme: { type: "string" }, platform: { type: "string" }, force: { type: "boolean" } },
    maxArgs: 0,
    run: (ctx) =>
      init({ project: stringFlag(ctx, "project"), scheme: stringFlag(ctx, "scheme"), platform: stringFlag(ctx, "platform"), force: boolFlag(ctx, "force") }),
  },
];
