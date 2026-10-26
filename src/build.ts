// Archiving, exporting, checking, and uploading an app build.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertWritable } from "./asc/client";
import { type Project, findConfigRoot } from "./config";
import type { Credentials } from "./credentials";
import { run, runOrThrow } from "./exec";
import { platformInfo } from "./platform";
import { buildSettingArgs, trustError, untrustedPackages } from "./trust";
import { ShipError, ui } from "./ui";
import { setPackageBuild, target } from "./xcode";

/** A build number as Apple takes it (CFBundleVersion): one to three dot-separated whole numbers, like 42 or 1.2.3. */
export const BUILD_NUMBER = /^\d+(\.\d+){0,2}$/;

/** Stops a --build value Apple would reject, before archiving for minutes. */
export function checkBuildNumber(value: string): string {
  if (!BUILD_NUMBER.test(value)) {
    throw new ShipError(
      `"${value}" isn't a build number`,
      "usage",
      "Use one to three dot-separated whole numbers, like --build 42 or --build 1.2.3.",
      undefined,
      2,
    );
  }
  return value;
}

/** Paths for one build's products and logs, under the repo's .ship folder. */
export function buildPaths(project: Project, build: string) {
  const dir = join(project.workDir, "builds", build);
  return {
    dir,
    archive: join(dir, `${project.config.scheme}.xcarchive`),
    exportDir: join(dir, "export"),
    exportOptions: join(dir, "ExportOptions.plist"),
    archiveLog: join(dir, "archive.log"),
    exportLog: join(dir, "export.log"),
    uploadLog: join(dir, "upload.log"),
  };
}

/**
 * Runs `body` with the API key written to a private temporary folder, as the
 * AuthKey_<id>.p8 file that xcodebuild and altool expect, and deletes it after.
 */
export async function withKeyFile<T>(creds: Credentials | undefined, body: (key?: { dir: string; path: string }) => Promise<T>): Promise<T> {
  if (!creds) return body();
  const dir = mkdtempSync(join(tmpdir(), "ship-key-"));
  chmodSync(dir, 0o700);
  const path = join(dir, `AuthKey_${creds.keyId}.p8`);
  try {
    await Bun.write(path, creds.privateKey.endsWith("\n") ? creds.privateKey : `${creds.privateKey}\n`);
    chmodSync(path, 0o600);
    return await body({ dir, path });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function authArgs(creds?: Credentials, key?: { path: string }): string[] {
  if (!creds || !key) return ["-allowProvisioningUpdates"];
  return [
    "-allowProvisioningUpdates",
    "-authenticationKeyPath", key.path,
    "-authenticationKeyID", creds.keyId,
    "-authenticationKeyIssuerID", creds.issuerId,
  ];
}

/** Archives the app as a Release build with the given build number. */
/** `commit` becomes the SHIP_COMMIT build setting; an Info.plist can read it as `$(SHIP_COMMIT)`. */
export async function archive(project: Project, build: string, creds?: Credentials, key?: { path: string }, commit?: string) {
  const paths = buildPaths(project, build);
  rmSync(paths.dir, { recursive: true, force: true });
  mkdirSync(paths.dir, { recursive: true });
  const container = { kind: project.config.kind, path: project.projectPath };
  if (container.kind === "swiftpm") {
    // App Playground packages take their build number from Package.swift.
    await setPackageBuild(container.path, build);
  }
  const { args, cwd } = target(container);
  const command = [
    "xcodebuild", "archive",
    ...args,
    "-scheme", project.config.scheme,
    "-configuration", "Release",
    "-destination", platformInfo(project.platform).destination,
    "-archivePath", paths.archive,
    "-derivedDataPath", join(project.workDir, "DerivedData"),
    ...authArgs(creds, key),
    // SHIP_JOBS limits parallel compile jobs, for machines that bog down.
    ...(process.env.SHIP_JOBS ? ["-jobs", process.env.SHIP_JOBS] : []),
    // Projects read the build number from this setting.
    `CURRENT_PROJECT_VERSION=${build}`,
    ...(commit ? [`SHIP_COMMIT=${commit}`] : []),
    // ship.json's "build" settings: skipping Xcode's trust prompt, and any other arguments.
    ...buildSettingArgs(project.config.build),
  ];
  try {
    await runOrThrow(command, { cwd, logFile: paths.archiveLog, what: "Archiving" });
  } catch (error) {
    if (!(error instanceof ShipError) || error.code !== "command-failed") throw error;
    const untrusted = untrustedPackages(await Bun.file(paths.archiveLog).text().catch(() => ""));
    if (!untrusted) throw error;
    const openCommand = openCommandFor(project);
    throw trustError(untrusted, {
      open: ui.link(openCommand, pathToFileURL(project.projectPath).href),
      openCommand,
      projectPath: project.projectPath,
      log: paths.archiveLog,
    });
  }
  return paths.archive;
}

/** The command that opens this project in Xcode: `ship open`, with --app when the current folder is another repo. */
export function openCommandFor(project: Project, cwd = process.cwd()): string {
  if (findConfigRoot(cwd) === project.root) return "ship open";
  const name = /^[\w.-]+$/.test(project.config.name) ? project.config.name : JSON.stringify(project.config.name);
  return `ship open --app ${name}`;
}

/** Exports an App Store Connect package from the archive: an .ipa, or a .pkg for macOS. */
export async function exportIPA(project: Project, build: string, creds?: Credentials, key?: { path: string }) {
  const paths = buildPaths(project, build);
  const options: Record<string, string | boolean> = {
    // A full App Store Connect build. Never "TestFlight Internal Only",
    // which can't go to external testers or the App Store.
    method: "app-store-connect",
    destination: "export",
    signingStyle: "automatic",
    uploadSymbols: true,
    // Keep the build number ship chose.
    manageAppVersionAndBuildNumber: false,
    testFlightInternalTestingOnly: false,
  };
  if (project.config.teamId) options.teamID = project.config.teamId;
  await Bun.write(paths.exportOptions, plist(options));
  const exportWith = (auth: string[]) =>
    runOrThrow(
      ["xcodebuild", "-exportArchive", "-archivePath", paths.archive, "-exportPath", paths.exportDir, "-exportOptionsPlist", paths.exportOptions, ...auth],
      { logFile: paths.exportLog, what: "Exporting" },
    );
  try {
    await exportWith(authArgs(creds, key));
  } catch (error) {
    // Signing for distribution as the API key needs access to cloud-managed
    // certificates, which App Manager keys don't have. The Apple account
    // signed in to Xcode normally does, so try that.
    const cloudSigning = error instanceof ShipError && JSON.stringify(error.details ?? {}).includes("Cloud signing permission");
    if (!creds || !cloudSigning) throw error;
    ui.note("The API key can't use cloud signing; exporting with the account signed in to Xcode instead");
    await exportWith(authArgs());
  }
  const made = findPackage(existsSync(paths.exportDir) ? readdirSync(paths.exportDir) : [], platformInfo(project.platform).package);
  if (!made) throw new ShipError(`The export made no ${platformInfo(project.platform).package}`, "no-ipa", `See ${paths.exportLog}`);
  return join(paths.exportDir, made);
}

/** The exported package among the export folder's files: the platform's kind first, then any .ipa or .pkg. */
export function findPackage(files: string[], preferred: ".ipa" | ".pkg"): string | undefined {
  return files.find((name) => name.endsWith(preferred)) ?? files.find((name) => name.endsWith(".ipa") || name.endsWith(".pkg"));
}

/** The app's Info.plist inside an archive: Products/Applications/<App>.app/Info.plist, or Contents/Info.plist for macOS. */
export function archiveInfoPlist(archive: string): string | undefined {
  const apps = join(archive, "Products", "Applications");
  if (!existsSync(apps)) return undefined;
  for (const app of readdirSync(apps).filter((name) => name.endsWith(".app")).sort()) {
    for (const candidate of [join(apps, app, "Contents", "Info.plist"), join(apps, app, "Info.plist")]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The built app's Info.plist: from the .ipa, or for a .pkg, from the archive it was exported from. */
export async function packageInfo(path: string, archive: string): Promise<Record<string, unknown>> {
  if (path.endsWith(".ipa")) return ipaInfo(path);
  const plistPath = archiveInfoPlist(archive);
  if (!plistPath) throw new ShipError("The archive has no app Info.plist", "bad-ipa", `Look inside ${archive}/Products/Applications.`);
  const json = await runOrThrow(["plutil", "-convert", "json", "-o", "-", plistPath], { what: "Reading Info.plist" });
  return JSON.parse(json.stdout);
}

/** The app's Info.plist from inside an .ipa. */
export async function ipaInfo(ipa: string): Promise<Record<string, unknown>> {
  const list = await runOrThrow(["unzip", "-Z1", ipa], { what: "Reading the .ipa" });
  const entry = list.stdout.split("\n").find((line) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(line));
  if (!entry) throw new ShipError("The .ipa has no app Info.plist", "bad-ipa");
  const dir = mkdtempSync(join(tmpdir(), "ship-plist-"));
  try {
    await runOrThrow(["unzip", "-o", "-q", ipa, entry, "-d", dir], { what: "Reading the .ipa" });
    const json = await runOrThrow(["plutil", "-convert", "json", "-o", "-", join(dir, entry)], { what: "Reading Info.plist" });
    return JSON.parse(json.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface Check {
  ok: boolean;
  message: string;
}

/** Catches mistakes App Store Connect would only report after upload. */
export function checkInfo(info: Record<string, unknown>, expected: { bundleId: string; build: string }): Check[] {
  return [
    {
      ok: info.CFBundleIdentifier === expected.bundleId,
      message: `Bundle id ${String(info.CFBundleIdentifier)} (expected ${expected.bundleId})`,
    },
    {
      ok: String(info.CFBundleVersion) === expected.build,
      message: `Build number ${String(info.CFBundleVersion)} (expected ${expected.build})`,
    },
    {
      ok: info.ITSAppUsesNonExemptEncryption === false,
      message:
        info.ITSAppUsesNonExemptEncryption === false
          ? "Export compliance declared (ITSAppUsesNonExemptEncryption = NO)"
          : "No ITSAppUsesNonExemptEncryption in Info.plist: ship answers the compliance question after upload, but adding the key skips it",
    },
  ];
}

/** Uploads an .ipa (or a macOS .pkg) to App Store Connect with altool and the API key. */
export async function upload(project: Project, build: string, ipa: string, creds: Credentials, key: { dir: string }) {
  assertWritable(`upload build ${build}`);
  const paths = buildPaths(project, build);
  const result = await run(
    ["xcrun", "altool", "--upload-app", "-f", ipa, "-t", platformInfo(project.platform).altool, "--apiKey", creds.keyId, "--apiIssuer", creds.issuerId, "--output-format", "json"],
    { env: { API_PRIVATE_KEYS_DIR: key.dir }, logFile: paths.uploadLog },
  );
  if (result.code !== 0) {
    let messages: string[] = [];
    try {
      const json = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
      messages = (json["product-errors"] ?? []).map((e: { message: string }) => e.message);
    } catch {
      messages = [];
    }
    if (!messages.length) messages = result.stderr.trim().split("\n").filter(Boolean).slice(-4);
    const duplicate = messages.some((m) => /bundle version must be higher|already been used|redundant binary/i.test(m));
    throw new ShipError(
      "Upload failed",
      duplicate ? "duplicate-build" : "upload-failed",
      [
        ...messages.slice(0, 4),
        duplicate ? "That build number is taken. Run `ship beta` again; it picks the next one." : `Full log: ${paths.uploadLog}`,
      ].join("\n  "),
      { messages },
    );
  }
  ui.note(`Upload log: ${paths.uploadLog}`);
}

/** Escapes text for an XML element. */
export const xmlEscape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** A flat property list of strings and booleans. */
export function plist(values: Record<string, string | boolean>): string {
  const entries = Object.entries(values)
    .map(([key, value]) =>
      typeof value === "boolean"
        ? `\t<key>${xmlEscape(key)}</key>\n\t<${value}/>`
        : `\t<key>${xmlEscape(key)}</key>\n\t<string>${xmlEscape(value)}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries}
</dict>
</plist>
`;
}
