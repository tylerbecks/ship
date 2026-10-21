// The Apple platforms ship builds for, and what each is called by
// xcodebuild, altool, and App Store Connect.

import { ShipError } from "./ui";

/** How ship.json names a platform. */
export type Platform = "ios" | "macos" | "tvos" | "visionos";

/** How App Store Connect names a platform (the `Platform` enum in its API). */
export type AscPlatform = "IOS" | "MAC_OS" | "TV_OS" | "VISION_OS";

export interface PlatformInfo {
  name: Platform;
  /** For people: "iOS", "macOS". */
  title: string;
  /** xcodebuild's -destination for an archive. */
  destination: string;
  /** altool's -t (--type). */
  altool: string;
  asc: AscPlatform;
  /** The device SDK, as in SDKROOT and SUPPORTED_PLATFORMS. */
  sdk: string;
  /** What an App Store Connect export makes. */
  package: ".ipa" | ".pkg";
}

/** In the order detection prefers them: iOS first. */
export const PLATFORMS: Record<Platform, PlatformInfo> = {
  ios: { name: "ios", title: "iOS", destination: "generic/platform=iOS", altool: "ios", asc: "IOS", sdk: "iphoneos", package: ".ipa" },
  macos: { name: "macos", title: "macOS", destination: "generic/platform=macOS", altool: "macos", asc: "MAC_OS", sdk: "macosx", package: ".pkg" },
  tvos: { name: "tvos", title: "tvOS", destination: "generic/platform=tvOS", altool: "appletvos", asc: "TV_OS", sdk: "appletvos", package: ".ipa" },
  visionos: { name: "visionos", title: "visionOS", destination: "generic/platform=visionOS", altool: "visionos", asc: "VISION_OS", sdk: "xros", package: ".ipa" },
};

export const PLATFORM_NAMES = Object.keys(PLATFORMS) as Platform[];

export const DEFAULT_PLATFORM: Platform = "ios";

export const isPlatform = (value: unknown): value is Platform => typeof value === "string" && value in PLATFORMS;

/** The platform's details; undefined means iOS, the default. */
export const platformInfo = (platform: Platform = DEFAULT_PLATFORM): PlatformInfo => PLATFORMS[platform];

/** A --platform value, as a usage error naming the choices when it isn't one. */
export function parsePlatform(value: string, flag = "--platform"): Platform {
  const name = value.trim().toLowerCase();
  if (isPlatform(name)) return name;
  // Accept App Store Connect's names too (IOS, MAC_OS).
  const asc = fromAscPlatform(value.trim().toUpperCase());
  if (asc) return asc;
  throw new ShipError(`Unknown platform "${value}"`, "usage", `Pick one: ${flag} ${PLATFORM_NAMES.join(" | ")}`, { choices: PLATFORM_NAMES }, 2);
}

/** ship's name for an App Store Connect platform. */
export function fromAscPlatform(value: string | undefined): Platform | undefined {
  return PLATFORM_NAMES.find((name) => PLATFORMS[name].asc === value);
}

// MARK: Detection

/** The SDK names in SUPPORTED_PLATFORMS ("iphoneos iphonesimulator") or SDKROOT ("iphoneos", or a path to iPhoneOS17.0.sdk). */
function sdks(settings: Record<string, string | undefined>): { supported: string[]; root?: string } {
  const supported = (settings.SUPPORTED_PLATFORMS ?? "").split(/\s+/).filter(Boolean);
  const root = (settings.SDKROOT ?? "")
    .split("/")
    .pop()
    ?.toLowerCase()
    .replace(/\.sdk$/, "")
    .replace(/[\d.]+$/, "");
  return { supported, root: root || undefined };
}

/**
 * The platform an app target builds for, from its build settings: the first
 * of iOS, macOS, tvOS, visionOS in SUPPORTED_PLATFORMS, else SDKROOT.
 * undefined when neither says.
 */
export function detectPlatform(settings: Record<string, string | undefined>): Platform | undefined {
  const { supported, root } = sdks(settings);
  return PLATFORM_NAMES.find((name) => supported.includes(PLATFORMS[name].sdk)) ?? PLATFORM_NAMES.find((name) => root === PLATFORMS[name].sdk);
}

/** Every platform the target supports, in preference order. */
export function supportedPlatforms(settings: Record<string, string | undefined>): Platform[] {
  const { supported, root } = sdks(settings);
  const found = PLATFORM_NAMES.filter((name) => supported.includes(PLATFORMS[name].sdk));
  if (!found.length && root) return PLATFORM_NAMES.filter((name) => root === PLATFORMS[name].sdk);
  return found;
}

/** Stops a macOS build of an iOS app that only reaches the Mac through Mac Catalyst, which ship doesn't ship. */
export function checkCatalyst(platform: Platform, settings: Record<string, string | undefined>) {
  if (platform !== "macos") return;
  const { supported } = sdks(settings);
  if (!supported.includes("macosx") && settings.SUPPORTS_MACCATALYST === "YES") {
    throw new ShipError(
      "This app reaches the Mac through Mac Catalyst, which ship doesn't build yet",
      "unsupported-platform",
      "Ship the iOS app with `ship init --force --platform ios`, and upload the Mac Catalyst build from Xcode (Product → Archive).",
    );
  }
}
