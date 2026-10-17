// Archiving, exporting, checking, and uploading an app build.

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "./config";
import type { Credentials } from "./credentials";
import { run, runOrThrow } from "./exec";
import { ShipError, ui } from "./ui";
import { setPackageBuild, target } from "./xcode";

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
export async function archive(project: Project, build: string, creds?: Credentials, key?: { path: string }) {
  const paths = buildPaths(project, build);
  rmSync(paths.dir, { recursive: true, force: true });
  mkdirSync(paths.dir, { recursive: true });
  const container = { kind: project.config.kind, path: project.projectPath };
  if (container.kind === "swiftpm") {
    // App Playground packages take their build number from Package.swift.
    await setPackageBuild(container.path, build);
  }
  const { args, cwd } = target(container);
  await runOrThrow(
    [
      "xcodebuild", "archive",
      ...args,
      "-scheme", project.config.scheme,
      "-configuration", "Release",
      "-destination", "generic/platform=iOS",
      "-archivePath", paths.archive,
      "-derivedDataPath", join(project.workDir, "DerivedData"),
      ...authArgs(creds, key),
      // SHIP_JOBS limits parallel compile jobs, for machines that bog down.
      ...(process.env.SHIP_JOBS ? ["-jobs", process.env.SHIP_JOBS] : []),
      // Projects read the build number from this setting.
      `CURRENT_PROJECT_VERSION=${build}`,
    ],
    { cwd, logFile: paths.archiveLog, what: "Archiving" },
  );
  return paths.archive;
}

/** Exports an App Store Connect .ipa from the archive. */
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
  const ipa = readdirSync(paths.exportDir).find((name) => name.endsWith(".ipa"));
  if (!ipa) throw new ShipError("The export made no .ipa", "no-ipa", `See ${paths.exportLog}`);
  return join(paths.exportDir, ipa);
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

/** Uploads an .ipa to App Store Connect with altool and the API key. */
export async function upload(project: Project, build: string, ipa: string, creds: Credentials, key: { dir: string }) {
  const paths = buildPaths(project, build);
  const result = await run(
    ["xcrun", "altool", "--upload-app", "-f", ipa, "-t", "ios", "--apiKey", creds.keyId, "--apiIssuer", creds.issuerId, "--output-format", "json"],
    { env: { API_PRIVATE_KEYS_DIR: key.dir }, logFile: paths.uploadLog },
  );
  if (result.code !== 0) {
    let messages: string[] = [];
    try {
      const json = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
      messages = (json["product-errors"] ?? []).map((e: { message: string }) => e.message);
    } catch {
      messages = result.stderr.trim().split("\n").slice(-4);
    }
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

function plist(values: Record<string, string | boolean>): string {
  const entries = Object.entries(values)
    .map(([key, value]) =>
      typeof value === "boolean" ? `\t<key>${key}</key>\n\t<${value}/>` : `\t<key>${key}</key>\n\t<string>${value}</string>`,
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
