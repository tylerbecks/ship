// The app's marketing version (CFBundleShortVersionString): comparing and
// bumping version strings, and finding and editing where the project keeps
// it. That's the MARKETING_VERSION build setting in an Xcode project (every
// target's, so extensions stay in line, which App Store Connect requires), or
// displayVersion in an App Playground's Package.swift.
//
// ship edits the files and never commits them; that's the developer's call.

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Project } from "./config";
import { ShipError } from "./ui";
import { appSettings, packageSettings } from "./xcode";

// MARK: Version strings

/** What App Store Connect accepts: one to three whole numbers, like 1, 1.4, or 1.4.2. */
export const VERSION_PATTERN = /^\d+(\.\d+){0,2}$/;

export type Bump = "major" | "minor" | "patch";
export const BUMPS: Bump[] = ["major", "minor", "patch"];

/** A version's numbers, or undefined when it isn't one App Store Connect accepts. */
export function parseVersion(value: string): number[] | undefined {
  const trimmed = value.trim();
  if (!VERSION_PATTERN.test(trimmed)) return undefined;
  return trimmed.split(".").map((part) => Number.parseInt(part, 10));
}

/** Negative when a < b, 0 when equal (1.4 equals 1.4.0), positive when a > b. Parts that aren't numbers count as 0. */
export function compareVersions(a: string, b: string): number {
  const numbers = (value: string) => value.trim().split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [numbers(a), numbers(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/** The version string, checked: a usage error with an example when App Store Connect wouldn't take it. */
export function checkVersion(value: string, flag = "--version"): string {
  const trimmed = value.trim();
  if (!parseVersion(trimmed)) {
    throw new ShipError(
      `"${value}" isn't a version App Store Connect accepts`,
      "bad-version",
      `Use one to three whole numbers, like ${flag} 1.4 or ${flag} 1.4.2.`,
      undefined,
      2,
    );
  }
  return trimmed;
}

/**
 * The next version, keeping the number of parts where that makes sense:
 * 1.4 minor → 1.5, 1.4 patch → 1.4.1, 1.4.2 major → 2.0.0, 1.4 major → 2.0.
 */
export function bumpVersion(value: string, part: Bump): string {
  const parts = parseVersion(value);
  if (!parts) throw new ShipError(`"${value}" isn't a version ship can bump`, "bad-version", "Set one first with `ship version set 1.0`.");
  const [major = 0, minor = 0, patch = 0] = parts;
  const count = parts.length;
  if (part === "major") return [major + 1, ...Array(Math.max(count, 2) - 1).fill(0)].join(".");
  if (part === "minor") return [major, minor + 1, ...(count === 3 ? [0] : [])].join(".");
  return [major, minor, patch + 1].join(".");
}

// MARK: Editing project files

/** What an edit changed: the new text, how many places, and the distinct values they had. */
export interface VersionEdit {
  text: string;
  count: number;
  previous: string[];
  /** Values that point at another setting, like $(APP_VERSION), left alone. */
  references: string[];
}

const MARKETING_VERSION = /\bMARKETING_VERSION(\s*=\s*)(?:"([^"\n]*)"|([^";\s]+))(\s*;)/g;

/** The literal MARKETING_VERSION values in a project.pbxproj, in order (with repeats). */
export function marketingVersions(pbxproj: string): string[] {
  return [...pbxproj.matchAll(MARKETING_VERSION)].map((match) => match[2] ?? match[3] ?? "").filter((value) => !value.includes("$"));
}

/**
 * Sets every `MARKETING_VERSION = x;` in a project.pbxproj (every target and
 * configuration, quoted or not) to `to`. Values that refer to another
 * setting, like $(APP_VERSION), are left alone and listed in `references`.
 */
export function setMarketingVersion(pbxproj: string, to: string): VersionEdit {
  const previous = new Set<string>();
  const references = new Set<string>();
  let count = 0;
  const text = pbxproj.replace(MARKETING_VERSION, (whole, equals: string, quoted: string | undefined, bare: string | undefined, semicolon: string) => {
    const value = quoted ?? bare ?? "";
    if (value.includes("$")) {
      references.add(value);
      return whole;
    }
    previous.add(value);
    count++;
    return `MARKETING_VERSION${equals}${quoted !== undefined ? `"${to}"` : to}${semicolon}`;
  });
  return { text, count, previous: [...previous], references: [...references] };
}

const DISPLAY_VERSION = /(\bdisplayVersion:\s*)"([^"\n]*)"/g;

/** Sets `displayVersion: "x"` in an App Playground's Package.swift. */
export function setDisplayVersion(packageSwift: string, to: string): VersionEdit {
  const previous = new Set<string>();
  let count = 0;
  const text = packageSwift.replace(DISPLAY_VERSION, (_whole, label: string, value: string) => {
    previous.add(value);
    count++;
    return `${label}"${to}"`;
  });
  return { text, count, previous: [...previous], references: [] };
}

// MARK: Workspaces

/**
 * The .xcodeproj paths a workspace's contents.xcworkspacedata refers to,
 * relative to the folder holding the .xcworkspace (or absolute). Groups nest
 * their `group:` paths; CocoaPods' Pods project is left out.
 */
export function workspaceProjects(xcworkspacedata: string): string[] {
  const found: string[] = [];
  const groups: string[] = [""];
  const tag = /<(\/?)(Group|FileRef)\b([^>]*?)(\/?)>/g;
  for (const match of xcworkspacedata.matchAll(tag)) {
    const [, closing, name, attributes = "", selfClosing] = match;
    if (closing) {
      if (name === "Group" && groups.length > 1) groups.pop();
      continue;
    }
    const location = attributes.match(/\blocation\s*=\s*"([^"]*)"/)?.[1] ?? "";
    const [kind, ...rest] = location.split(":");
    const path = rest.join(":");
    // group: is relative to the enclosing group; container: to the workspace's folder; absolute: is absolute.
    const full = kind === "group" ? join(groups.at(-1) ?? "", path) : path;
    if (name === "Group") {
      if (!selfClosing) groups.push(full);
      continue;
    }
    if (!full.endsWith(".xcodeproj")) continue;
    if (/(^|\/)Pods\.xcodeproj$/.test(full) || /(^|\/)Pods\//.test(full)) continue;
    if (!found.includes(full)) found.push(full);
  }
  return found;
}

/** A project file that may carry the version. */
export interface VersionCandidate {
  path: string;
  /** Its literal MARKETING_VERSION values. */
  values: string[];
  /** Whether it has the app's scheme. */
  hasScheme: boolean;
}

/**
 * Which of a workspace's projects to edit: the one with the app's scheme
 * (or the first that has a version), plus any other whose version matches
 * it, like a shared extensions project. Projects without a version are left out.
 */
export function pickVersionFiles(candidates: VersionCandidate[]): string[] {
  const versioned = candidates.filter((candidate) => candidate.values.length);
  if (versioned.length <= 1) return versioned.map((candidate) => candidate.path);
  const main = versioned.find((candidate) => candidate.hasScheme) ?? versioned[0]!;
  const current = mostCommon(main.values);
  return versioned.filter((candidate) => candidate === main || candidate.values.includes(current)).map((candidate) => candidate.path);
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

// MARK: The project's files

/** Where the project keeps its version. */
export interface VersionSource {
  /** MARKETING_VERSION (an Xcode build setting) or displayVersion (Package.swift). */
  kind: "MARKETING_VERSION" | "displayVersion";
  /** The files, absolute. */
  files: string[];
}

const NO_MARKETING_VERSION_HINT = "In Xcode's General tab set Version, which stores it as MARKETING_VERSION.";

/** Whether an .xcodeproj has a shared or user scheme by this name. */
function hasScheme(xcodeproj: string, scheme: string): boolean {
  if (existsSync(join(xcodeproj, "xcshareddata", "xcschemes", `${scheme}.xcscheme`))) return true;
  const users = join(xcodeproj, "xcuserdata");
  if (!existsSync(users)) return false;
  return readdirSync(users).some((user) => existsSync(join(users, user, "xcschemes", `${scheme}.xcscheme`)));
}

/** The files that hold the project's version. */
export async function versionSource(project: Project): Promise<VersionSource> {
  const { kind } = project.config;
  if (kind === "swiftpm") return { kind: "displayVersion", files: [join(project.projectPath, "Package.swift")] };
  if (kind === "xcodeproj") return { kind: "MARKETING_VERSION", files: [join(project.projectPath, "project.pbxproj")] };
  const data = await Bun.file(join(project.projectPath, "contents.xcworkspacedata"))
    .text()
    .catch(() => "");
  const base = dirname(project.projectPath);
  const candidates: VersionCandidate[] = [];
  for (const path of workspaceProjects(data)) {
    const xcodeproj = resolve(base, path);
    const file = join(xcodeproj, "project.pbxproj");
    if (!existsSync(file)) continue;
    candidates.push({ path: file, values: marketingVersions(await Bun.file(file).text()), hasScheme: hasScheme(xcodeproj, project.config.scheme) });
  }
  const files = pickVersionFiles(candidates);
  if (!files.length) {
    throw new ShipError(`No project in ${relative(project.root, project.projectPath)} sets MARKETING_VERSION`, "no-marketing-version", NO_MARKETING_VERSION_HINT);
  }
  return { kind: "MARKETING_VERSION", files };
}

/** The app's version and build as the project reports them (xcodebuild for Xcode projects), and where it's kept. */
export async function projectVersion(project: Project): Promise<{ version?: string; build?: string; source?: VersionSource }> {
  // The version can still be read when no file holds it (an Info.plist that hard-codes it).
  const source = await versionSource(project).catch((error) => {
    if (error instanceof ShipError) return undefined;
    throw error;
  });
  const settings =
    project.config.kind === "swiftpm"
      ? await packageSettings(project.projectPath)
      : await appSettings({ kind: project.config.kind, path: project.projectPath }, project.config.scheme, project.platform);
  return { version: settings.version, build: settings.build, source };
}

/** What a version change did (or with dryRun, would do). */
export interface VersionChange {
  from?: string;
  to: string;
  /** Edited files, relative to the project root. */
  files: string[];
  dryRun: boolean;
  warnings: string[];
}

/**
 * Sets the version in every file that holds it. Several distinct old values
 * (an extension behind the app) are all brought in line, with a warning.
 */
export async function writeProjectVersion(project: Project, to: string, options: { from?: string; dryRun?: boolean } = {}): Promise<VersionChange> {
  const source = await versionSource(project);
  const edits: { file: string; edit: VersionEdit }[] = [];
  for (const file of source.files) {
    const text = await Bun.file(file)
      .text()
      .catch(() => {
        throw new ShipError(`Couldn't read ${relative(project.root, file)}`, "no-marketing-version", "Check ship.json's path with `ship doctor`.");
      });
    const edit = source.kind === "displayVersion" ? setDisplayVersion(text, to) : setMarketingVersion(text, to);
    edits.push({ file, edit });
  }
  const total = edits.reduce((sum, { edit }) => sum + edit.count, 0);
  if (!total) {
    const references = [...new Set(edits.flatMap(({ edit }) => edit.references))];
    if (source.kind === "displayVersion") {
      throw new ShipError("Package.swift has no displayVersion to update", "no-marketing-version", 'Add `displayVersion: "1.0"` to the iOSApplication product.');
    }
    throw new ShipError(
      references.length ? `MARKETING_VERSION refers to ${references.join(", ")}, which ship doesn't edit` : "The project doesn't set MARKETING_VERSION",
      "no-marketing-version",
      references.length ? `Set the version where ${references[0]} is defined, or set Version in Xcode's General tab.` : NO_MARKETING_VERSION_HINT,
    );
  }
  const previous = [...new Set(edits.flatMap(({ edit }) => edit.previous))];
  const warnings: string[] = [];
  if (previous.length > 1) {
    warnings.push(`Targets had different versions (${previous.join(", ")}); all are now ${to}, as App Store Connect requires extensions to match the app`);
  }
  for (const reference of new Set(edits.flatMap(({ edit }) => edit.references))) warnings.push(`Left MARKETING_VERSION = ${reference} alone`);
  const changed = edits.filter(({ edit }) => edit.previous.some((value) => value !== to));
  if (!options.dryRun) for (const { file, edit } of changed) await Bun.write(file, edit.text);
  return {
    from: options.from ?? (previous.length === 1 ? previous[0] : undefined),
    to,
    files: changed.map(({ file }) => relative(project.root, file)),
    dryRun: Boolean(options.dryRun),
    warnings,
  };
}
