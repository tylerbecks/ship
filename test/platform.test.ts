import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { archiveInfoPlist, findPackage, plist, xmlEscape } from "../src/build";
import { choosePlatform } from "../src/commands/init";
import { PLATFORMS, checkCatalyst, detectPlatform, fromAscPlatform, parsePlatform, platformInfo, supportedPlatforms } from "../src/platform";
import { parseAppSettings } from "../src/xcode";
import { temp } from "./helpers";

describe("platforms", () => {
  test("map to xcodebuild, altool, and App Store Connect names", () => {
    expect(Object.values(PLATFORMS).map((p) => [p.name, p.destination, p.altool, p.asc, p.sdk, p.package])).toEqual([
      ["ios", "generic/platform=iOS", "ios", "IOS", "iphoneos", ".ipa"],
      ["macos", "generic/platform=macOS", "macos", "MAC_OS", "macosx", ".pkg"],
      ["tvos", "generic/platform=tvOS", "appletvos", "TV_OS", "appletvos", ".ipa"],
      ["visionos", "generic/platform=visionOS", "visionos", "VISION_OS", "xros", ".ipa"],
    ]);
    expect(platformInfo().name).toBe("ios");
    expect(fromAscPlatform("TV_OS")).toBe("tvos");
    expect(fromAscPlatform("WATCH_OS")).toBeUndefined();
  });

  test("parsePlatform accepts ship's and Apple's names", () => {
    expect(parsePlatform("macOS")).toBe("macos");
    expect(parsePlatform("VISION_OS")).toBe("visionos");
    expect(() => parsePlatform("watchos")).toThrow();
  });

  test("detection prefers iOS, then reads SDKROOT", () => {
    expect(detectPlatform({ SUPPORTED_PLATFORMS: "iphonesimulator iphoneos" })).toBe("ios");
    expect(detectPlatform({ SUPPORTED_PLATFORMS: "macosx iphoneos iphonesimulator" })).toBe("ios");
    expect(detectPlatform({ SUPPORTED_PLATFORMS: "macosx" })).toBe("macos");
    expect(detectPlatform({ SUPPORTED_PLATFORMS: "appletvos appletvsimulator" })).toBe("tvos");
    expect(detectPlatform({ SUPPORTED_PLATFORMS: "xros xrsimulator" })).toBe("visionos");
    expect(detectPlatform({ SDKROOT: "/Applications/Xcode.app/.../MacOSX15.0.sdk" })).toBe("macos");
    expect(detectPlatform({ SDKROOT: "iphoneos" })).toBe("ios");
    expect(detectPlatform({})).toBeUndefined();
    expect(supportedPlatforms({ SUPPORTED_PLATFORMS: "xros macosx iphoneos" })).toEqual(["ios", "macos", "visionos"]);
  });

  test("Mac Catalyst is an error with a hint", () => {
    expect(() => checkCatalyst("macos", { SUPPORTED_PLATFORMS: "iphoneos", SUPPORTS_MACCATALYST: "YES" })).toThrow(/Mac Catalyst/);
    expect(() => checkCatalyst("macos", { SUPPORTED_PLATFORMS: "iphoneos macosx", SUPPORTS_MACCATALYST: "YES" })).not.toThrow();
    expect(() => checkCatalyst("ios", { SUPPORTED_PLATFORMS: "iphoneos", SUPPORTS_MACCATALYST: "YES" })).not.toThrow();
  });

  test("choosePlatform: the flag wins when the target supports it", () => {
    expect(choosePlatform(undefined, { platform: "tvos", platforms: ["tvos"] })).toBe("tvos");
    expect(choosePlatform(undefined, {})).toBe("ios");
    expect(choosePlatform("macos", { platform: "ios", platforms: ["ios", "macos"] })).toBe("macos");
    expect(() => choosePlatform("tvos", { platform: "ios", platforms: ["ios"] })).toThrow(/doesn't build for tvOS/);
  });

  test("reads the app target's settings from xcodebuild's JSON", () => {
    const stdout = `noise before\n${JSON.stringify([
      { target: "Kit", buildSettings: { PRODUCT_TYPE: "com.apple.product-type.framework" } },
      {
        target: "App",
        buildSettings: {
          PRODUCT_TYPE: "com.apple.product-type.application",
          PRODUCT_NAME: "Lift",
          PRODUCT_BUNDLE_IDENTIFIER: "com.example.lift",
          DEVELOPMENT_TEAM: "ABC",
          MARKETING_VERSION: "1.2",
          CURRENT_PROJECT_VERSION: "7",
          SUPPORTED_PLATFORMS: "macosx",
          SDKROOT: "macosx",
        },
      },
    ])}`;
    expect(parseAppSettings(stdout, "App")).toMatchObject({ productName: "Lift", bundleId: "com.example.lift", build: "7", platform: "macos", platforms: ["macos"] });
    expect(() => parseAppSettings("not json", "App")).toThrow(/build settings/);
  });
});

describe("packages", () => {
  test("findPackage prefers the platform's kind", () => {
    expect(findPackage(["DistributionSummary.plist", "App.ipa"], ".ipa")).toBe("App.ipa");
    expect(findPackage(["App.pkg", "Packaging.log"], ".pkg")).toBe("App.pkg");
    expect(findPackage(["App.ipa"], ".pkg")).toBe("App.ipa");
    expect(findPackage(["ExportOptions.plist"], ".ipa")).toBeUndefined();
  });

  test("archiveInfoPlist finds iOS and macOS apps", () => {
    const ios = join(temp(), "App.xcarchive");
    mkdirSync(join(ios, "Products/Applications/App.app"), { recursive: true });
    writeFileSync(join(ios, "Products/Applications/App.app/Info.plist"), "");
    expect(archiveInfoPlist(ios)).toBe(join(ios, "Products/Applications/App.app/Info.plist"));
    const mac = join(temp(), "Mac.xcarchive");
    mkdirSync(join(mac, "Products/Applications/Mac.app/Contents"), { recursive: true });
    writeFileSync(join(mac, "Products/Applications/Mac.app/Contents/Info.plist"), "");
    expect(archiveInfoPlist(mac)).toBe(join(mac, "Products/Applications/Mac.app/Contents/Info.plist"));
    expect(archiveInfoPlist(join(temp(), "none"))).toBeUndefined();
  });

  test("ExportOptions values are XML-escaped", () => {
    expect(xmlEscape(`a&b<c>"d'`)).toBe("a&amp;b&lt;c&gt;&quot;d&apos;");
    const text = plist({ teamID: "A&B", uploadSymbols: true });
    expect(text).toContain("<string>A&amp;B</string>");
    expect(text).toContain("<key>uploadSymbols</key>\n\t<true/>");
  });
});
