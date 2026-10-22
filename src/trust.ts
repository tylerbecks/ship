// Xcode's trust prompt for Swift macros and package plugins. Xcode won't
// build a package's macro or run its build plugin until someone clicks Trust &
// Enable, and a command-line build can't ask, so it just fails. ship reads the
// failure from the log and says what to do, and ship.json's "build" settings
// can skip the check for a repo that has decided to.

import type { ProjectConfig } from "./config";
import { ShipError } from "./ui";

export interface Untrusted {
  kind: "macro" | "plugin";
  name: string;
  /** The package it comes from, when the log says. */
  package?: string;
}

/** The phrase Xcode ends the error with, for macros and plugins alike. */
const NEEDS_TRUST = /must be enabled before it can be used/i;

/** `Macro "PerceptionMacros" from package "swift-perception" must be enabled…`, or the same for a plugin. */
const NAMED = /\b(macro|plug-?in)\s+["“']([^"”'\n]+)["”'](?:\s+(?:from|in)\s+(?:package|project)\s+["“']([^"”'\n]+)["”'])?[^\n]*?must be enabled/gi;

/**
 * What an archive log says needs trusting: the macros and plugins it names,
 * an empty list when it asks for trust without naming them, or undefined when
 * the build failed for some other reason.
 */
export function untrustedPackages(log: string): Untrusted[] | undefined {
  if (!NEEDS_TRUST.test(log)) return undefined;
  const found = new Map<string, Untrusted>();
  for (const match of log.matchAll(NAMED)) {
    const kind = match[1]!.toLowerCase() === "macro" ? "macro" : "plugin";
    const name = match[2]!.trim();
    found.set(`${kind}:${name}`, { kind, name, package: match[3]?.trim() });
  }
  return [...found.values()];
}

/** The ship.json settings that skip the check for what's listed (both when the log names nothing). */
export function skipSettings(untrusted: Untrusted[]): string[] {
  const kinds = new Set(untrusted.map((item) => item.kind));
  const settings: string[] = [];
  if (!kinds.size || kinds.has("macro")) settings.push("skipMacroValidation");
  if (!kinds.size || kinds.has("plugin")) settings.push("skipPackagePluginValidation");
  return settings;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 Swift macros", "1 package plugin", "2 Swift macros and 1 package plugin". */
function describe(untrusted: Untrusted[]): string {
  const macros = untrusted.filter((item) => item.kind === "macro").length;
  const plugins = untrusted.length - macros;
  if (!untrusted.length) return "a Swift macro or package plugin";
  return [macros && count(macros, "Swift macro", "Swift macros"), plugins && count(plugins, "package plugin", "package plugins")]
    .filter(Boolean)
    .join(" and ");
}

/** One line per package: "StructuredQueriesMacros, StructuredQueriesSQLiteMacros (swift-structured-queries)". */
function byPackage(untrusted: Untrusted[]): string[] {
  const groups = new Map<string, string[]>();
  for (const item of untrusted) groups.set(item.package ?? "", [...(groups.get(item.package ?? "") ?? []), item.name]);
  return [...groups].map(([pkg, names]) => (pkg ? `${names.join(", ")} (${pkg})` : names.join(", ")));
}

/**
 * The error for an archive Xcode stopped over trust: what it is, why, and
 * the two ways out. `open` is the command that opens the project in Xcode,
 * possibly wrapped in a terminal link.
 */
export function trustError(untrusted: Untrusted[], options: { open: string; projectPath: string; log: string; openCommand: string }): ShipError {
  const settings = skipSettings(untrusted);
  const them = untrusted.length > 1 ? "them" : "it";
  const setting = `"build": { ${settings.map((name) => `"${name}": true`).join(", ")} }`;
  return new ShipError(
    `Xcode won't build ${describe(untrusted)} until you trust ${them}`,
    "untrusted-package",
    [
      ...byPackage(untrusted),
      `A command-line build can't ask, so trust ${them} once in Xcode:`,
      // `open` may carry a terminal link's escape codes, so pad by the command's visible length.
      `  ${options.open}${" ".repeat(Math.max(2, 17 - options.openCommand.length))}then build (⌘B) and click Trust & Enable`,
      "Then run ship again. Or skip the check for this repo, in ship.json:",
      `  ${setting}`,
    ].join("\n  "),
    { untrusted, projectPath: options.projectPath, openCommand: options.openCommand, settings: settings.map((name) => `build.${name}`), log: options.log },
  );
}

/** The xcodebuild arguments ship.json's "build" settings add to the archive. */
export function buildSettingArgs(build: ProjectConfig["build"]): string[] {
  return [
    ...(build?.skipMacroValidation ? ["-skipMacroValidation"] : []),
    ...(build?.skipPackagePluginValidation ? ["-skipPackagePluginValidation"] : []),
    ...(build?.xcodebuildArgs ?? []),
  ];
}

/** Checks ship.json's "build" settings, so a typo fails before a long archive instead of during it. */
export function checkBuildSettings(build: unknown, file: string): void {
  if (build === undefined) return;
  const bad = (what: string) =>
    new ShipError(`${file} has a bad "build" setting: ${what}`, "bad-config", 'For example: "build": { "skipMacroValidation": true, "xcodebuildArgs": ["-quiet"] }');
  if (typeof build !== "object" || build === null || Array.isArray(build)) throw bad("it must be an object");
  const known = ["skipMacroValidation", "skipPackagePluginValidation", "xcodebuildArgs"];
  for (const [key, value] of Object.entries(build)) {
    if (!known.includes(key)) throw bad(`unknown key "${key}" (it takes ${known.join(", ")})`);
    if (key === "xcodebuildArgs") {
      if (!Array.isArray(value) || value.some((arg) => typeof arg !== "string")) throw bad("xcodebuildArgs must be a list of strings");
    } else if (typeof value !== "boolean") {
      throw bad(`${key} must be true or false`);
    }
  }
}
