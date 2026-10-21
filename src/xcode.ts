// Finding Xcode projects, workspaces, and App Playground packages, and
// reading their schemes and build settings.

import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProjectKind } from "./config";
import { run, runOrThrow } from "./exec";
import { type Platform, detectPlatform, platformInfo, supportedPlatforms } from "./platform";
import { ShipError } from "./ui";

/** An Xcode project, workspace, or App Playground package. */
export interface XcodeContainer {
  kind: ProjectKind;
  /** Absolute path. */
  path: string;
}

const SKIP = new Set(["node_modules", ".git", ".build", ".ship", "DerivedData", "Pods", "Carthage", "dist", "build"]);

/** Projects, workspaces, and packages up to `depth` folders below `root`. */
export function findContainers(root: string, depth = 4): XcodeContainer[] {
  const found: XcodeContainer[] = [];
  const walk = (dir: string, level: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      // Only real ones: a project with its project file, and an App Playground
      // package (not the hidden .swiftpm folder Xcode keeps inside packages).
      if (entry.name.endsWith(".xcodeproj")) {
        if (existsSync(join(path, "project.pbxproj"))) found.push({ kind: "xcodeproj", path });
      } else if (entry.name.endsWith(".xcworkspace")) {
        if (existsSync(join(path, "contents.xcworkspacedata"))) found.push({ kind: "xcworkspace", path });
      } else if (entry.name.endsWith(".swiftpm") && entry.name !== ".swiftpm") {
        if (existsSync(join(path, "Package.swift"))) found.push({ kind: "swiftpm", path });
      }
      else if (level < depth && !entry.name.startsWith(".")) walk(path, level + 1);
    }
  };
  walk(root, 0);
  // A workspace that only wraps a project of the same name adds nothing.
  return found.filter(
    (item) =>
      !(item.kind === "xcworkspace" &&
        found.some((other) => other.kind === "xcodeproj" && other.path.replace(/\.xcodeproj$/, "") === item.path.replace(/\.xcworkspace$/, ""))),
  );
}

/** The arguments and folder that point xcodebuild at a container. */
export function target(container: XcodeContainer): { args: string[]; cwd?: string } {
  switch (container.kind) {
    case "xcodeproj":
      return { args: ["-project", container.path] };
    case "xcworkspace":
      return { args: ["-workspace", container.path] };
    case "swiftpm":
      // xcodebuild opens an App Playground package from inside its folder.
      return { args: [], cwd: container.path };
  }
}

export async function listSchemes(container: XcodeContainer): Promise<string[]> {
  const { args, cwd } = target(container);
  const result = await run(["xcodebuild", "-list", "-json", ...args], { cwd });
  if (result.code !== 0) {
    throw new ShipError(
      `Couldn't read the schemes in ${basename(container.path)}`,
      "list-failed",
      result.stderr.trim().split("\n").slice(-3).join("\n  ") || undefined,
    );
  }
  try {
    const json = JSON.parse(result.stdout.slice(Math.max(0, result.stdout.indexOf("{"))));
    return (json.project?.schemes ?? json.workspace?.schemes ?? []) as string[];
  } catch {
    throw new ShipError(`Couldn't read the schemes in ${basename(container.path)}`, "list-failed", "Open the project in Xcode once (it may need to resolve packages), then try again.");
  }
}

/** The app target's settings for a scheme, in the Release configuration. */
export interface AppSettings {
  productName: string;
  bundleId: string;
  teamId?: string;
  version?: string;
  build?: string;
  /** The platform the target builds for first (iOS before macOS, tvOS, visionOS). */
  platform?: Platform;
  /** Every platform the target supports. */
  platforms?: Platform[];
  /** The raw settings detection reads (SUPPORTED_PLATFORMS, SDKROOT, SUPPORTS_MACCATALYST). */
  platformSettings?: Record<string, string | undefined>;
}

/** The app target's entry in `xcodebuild -showBuildSettings -json` output, as AppSettings. */
export function parseAppSettings(stdout: string, scheme: string): AppSettings {
  const start = stdout.indexOf("[");
  let entries: { target: string; buildSettings: Record<string, string> }[];
  try {
    entries = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
  } catch {
    throw new ShipError(`Couldn't read the build settings for ${scheme}`, "bad-settings", "Run `xcodebuild -showBuildSettings -scheme <scheme>` to see what's wrong.");
  }
  const app = entries.find((entry) => entry.buildSettings.PRODUCT_TYPE === "com.apple.product-type.application");
  if (!app) {
    throw new ShipError(`The scheme "${scheme}" doesn't build an app`, "no-app-target", "Pick the scheme that builds your app with --scheme.");
  }
  const settings = app.buildSettings;
  const platformSettings = {
    SUPPORTED_PLATFORMS: settings.SUPPORTED_PLATFORMS,
    SDKROOT: settings.SDKROOT,
    SUPPORTS_MACCATALYST: settings.SUPPORTS_MACCATALYST,
  };
  return {
    productName: settings.PRODUCT_NAME ?? app.target,
    bundleId: settings.PRODUCT_BUNDLE_IDENTIFIER ?? "",
    teamId: settings.DEVELOPMENT_TEAM || undefined,
    version: settings.MARKETING_VERSION || undefined,
    build: settings.CURRENT_PROJECT_VERSION || undefined,
    platform: detectPlatform(platformSettings),
    platforms: supportedPlatforms(platformSettings),
    platformSettings,
  };
}

/**
 * The app target's settings for a scheme, in the Release configuration, as
 * built for `platform`. Without one, they're read as the scheme builds by
 * default, which is how `ship init` detects the platform.
 */
export async function appSettings(container: XcodeContainer, scheme: string, platform?: Platform): Promise<AppSettings> {
  const { args, cwd } = target(container);
  const destination = platform ? ["-destination", platformInfo(platform).destination] : [];
  const result = await runOrThrow(
    ["xcodebuild", "-showBuildSettings", "-json", ...args, "-scheme", scheme, "-configuration", "Release", ...destination],
    { cwd, what: `Reading build settings for ${scheme}` },
  );
  return parseAppSettings(result.stdout, scheme);
}

// MARK: Packages (.swiftpm)

/** An App Playground's app settings, from Package.swift (xcodebuild doesn't report them). */
export async function packageSettings(packagePath: string): Promise<AppSettings> {
  const text = await Bun.file(join(packagePath, "Package.swift")).text();
  const value = (key: string) => text.match(new RegExp(`${key}:\\s*"([^"]*)"`))?.[1];
  return {
    productName: text.match(/\.iOSApplication\(\s*name:\s*"([^"]*)"/)?.[1] ?? value("name") ?? basename(packagePath, ".swiftpm"),
    bundleId: value("bundleIdentifier") ?? "",
    teamId: value("teamIdentifier"),
    version: value("displayVersion"),
    build: value("bundleVersion"),
  };
}

/** Sets `bundleVersion` in an App Playground's Package.swift. */
export async function setPackageBuild(packagePath: string, build: string) {
  const file = join(packagePath, "Package.swift");
  const text = await Bun.file(file).text();
  if (!/bundleVersion:\s*"[^"]*"/.test(text)) {
    throw new ShipError("Package.swift has no bundleVersion to update", "no-bundle-version", "Add `bundleVersion: \"1\"` to the iOSApplication product.");
  }
  await Bun.write(file, text.replace(/bundleVersion:\s*"[^"]*"/, `bundleVersion: "${build}"`));
}
