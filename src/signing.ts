// Signing on this Mac: which certificates it can sign with (their private
// keys are in the Keychain), where Xcode keeps provisioning profiles, and
// which Apple types a platform's profiles and certificates are.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { security } from "./keychain";
import type { Platform } from "./platform";
import { ShipError } from "./ui";

/** Where Xcode (16 and later) looks for provisioning profiles. Tests point it at a temp folder. */
export const signingPaths = { profiles: join(homedir(), "Library", "Developer", "Xcode", "UserData", "Provisioning Profiles") };

/** The SHA-1s of the code signing identities in the Keychain: certificates whose private key is here too. */
export async function signingIdentities(): Promise<Set<string>> {
  const result = await security.run(["find-identity", "-v", "-p", "codesigning"]);
  const ids = [...result.stdout.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s/gm)].map((match) => match[1]!);
  return new Set(ids);
}

/** Adds a certificate (public: a .cer file) to the login Keychain, where it pairs with the private key its signing request came from. */
export async function importCertificate(path: string): Promise<void> {
  const result = await security.run(["import", path, "-t", "cert"]);
  // An identical certificate already there isn't a failure.
  if (result.code !== 0 && !/already exists/i.test(result.stderr)) {
    throw new ShipError(`Couldn't add the certificate to the Keychain: ${result.stderr.trim() || `security exited ${result.code}`}`, "keychain-failed", `Add it by hand: double-click ${path} (it's kept there).`, { file: path });
  }
}

/** The uuids of the profiles installed for Xcode. */
export function installedProfiles(): Set<string> {
  const dir = signingPaths.profiles;
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((name) => name.endsWith(".mobileprovision")).map((name) => name.replace(/\.mobileprovision$/, "")));
}

/** Writes a profile (its .mobileprovision, base64) where Xcode finds it; Xcode names every platform's that way. Returns the path. */
export async function installProfile(uuid: string, content: string): Promise<string> {
  if (!/^[0-9A-Fa-f-]{36}$/.test(uuid)) throw new ShipError(`"${uuid}" isn't a profile uuid`, "bad-profile", "`ship profiles` lists them.");
  mkdirSync(signingPaths.profiles, { recursive: true });
  const path = join(signingPaths.profiles, `${uuid}.mobileprovision`);
  await Bun.write(path, Buffer.from(content, "base64"));
  return path;
}

// MARK: Types

/** What a profile is for, as ship spells it. */
export const PROFILE_KINDS = ["app-store", "development", "ad-hoc", "direct"] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

/** Apple's profileType for a platform and kind; visionOS apps use iOS profiles. Throws for a kind the platform hasn't got. */
export function profileType(platform: Platform, kind: ProfileKind): string {
  const prefix = platform === "macos" ? "MAC_APP" : platform === "tvos" ? "TVOS_APP" : "IOS_APP";
  const suffix: Record<ProfileKind, string> = { "app-store": "STORE", development: "DEVELOPMENT", "ad-hoc": "ADHOC", direct: "DIRECT" };
  if (kind === "direct" && platform !== "macos") throw new ShipError("A direct (Developer ID) profile is for Mac apps", "usage", "Pick app-store, development, or ad-hoc.", { choices: ["app-store", "development", "ad-hoc"] }, 2);
  if (kind === "ad-hoc" && platform === "macos") throw new ShipError("Mac apps have no ad hoc profiles", "usage", "Pick app-store, development, or direct (Developer ID).", { choices: ["app-store", "development", "direct"] }, 2);
  return `${prefix}_${suffix[kind]}`;
}

/** The certificate types that can sign with a kind of profile on a platform. */
export function certificateTypesFor(platform: Platform, kind: ProfileKind): string[] {
  if (kind === "development") return platform === "macos" ? ["DEVELOPMENT", "MAC_APP_DEVELOPMENT"] : ["DEVELOPMENT", "IOS_DEVELOPMENT"];
  if (kind === "direct") return ["DEVELOPER_ID_APPLICATION_G2", "DEVELOPER_ID_APPLICATION"];
  return platform === "macos" ? ["DISTRIBUTION", "MAC_APP_DISTRIBUTION"] : ["DISTRIBUTION", "IOS_DISTRIBUTION"];
}

/** Whether a kind of profile lists devices (the ones it can install on). */
export const needsDevices = (kind: ProfileKind) => kind === "development" || kind === "ad-hoc";

/** What a certificate is for, as ship spells it, and Apple's type. */
export const CERTIFICATE_KINDS: Record<string, string> = {
  distribution: "DISTRIBUTION",
  development: "DEVELOPMENT",
  "developer-id": "DEVELOPER_ID_APPLICATION_G2",
  "mac-installer": "MAC_INSTALLER_DISTRIBUTION",
};

/** "Apple Distribution", for a certificate type. */
export function certificateKind(type: string): string {
  const names: Record<string, string> = {
    DISTRIBUTION: "Apple Distribution",
    DEVELOPMENT: "Apple Development",
    IOS_DISTRIBUTION: "iOS Distribution",
    IOS_DEVELOPMENT: "iOS Development",
    MAC_APP_DISTRIBUTION: "Mac App Distribution",
    MAC_APP_DEVELOPMENT: "Mac Development",
    MAC_INSTALLER_DISTRIBUTION: "Mac Installer Distribution",
    DEVELOPER_ID_APPLICATION: "Developer ID Application",
    DEVELOPER_ID_APPLICATION_G2: "Developer ID Application",
  };
  return names[type] ?? type.toLowerCase().replaceAll("_", " ");
}
