import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCommandFor } from "../src/build";
import { type Project, loadProject } from "../src/config";
import { buildSettingArgs, checkBuildSettings, skipSettings, trustError, untrustedPackages } from "../src/trust";

const LOG = `$ xcodebuild archive -project Lift.xcodeproj -scheme Lift
note: Building targets in dependency order
error: Macro "PerceptionMacros" from package "swift-perception" must be enabled before it can be used. Enable it now? (in target 'Perception' from project 'swift-perception')
error: Macro "StructuredQueriesMacros" from package "swift-structured-queries" must be enabled before it can be used. Enable it now?
error: Macro "StructuredQueriesSQLiteMacros" from package "swift-structured-queries" must be enabled before it can be used. Enable it now?
error: Macro "PerceptionMacros" from package "swift-perception" must be enabled before it can be used. Enable it now?
** ARCHIVE FAILED **`;

describe("untrustedPackages", () => {
  test("names each macro once, with its package", () => {
    expect(untrustedPackages(LOG)).toEqual([
      { kind: "macro", name: "PerceptionMacros", package: "swift-perception" },
      { kind: "macro", name: "StructuredQueriesMacros", package: "swift-structured-queries" },
      { kind: "macro", name: "StructuredQueriesSQLiteMacros", package: "swift-structured-queries" },
    ]);
  });

  test("reads plugins too, however Xcode spells them", () => {
    const log = `error: Plug-in "SwiftLintBuildToolPlugin" from package "SwiftLintPlugins" must be enabled before it can be used.`;
    expect(untrustedPackages(log)).toEqual([{ kind: "plugin", name: "SwiftLintBuildToolPlugin", package: "SwiftLintPlugins" }]);
  });

  test("is an empty list when Xcode asks for trust without naming what", () => {
    expect(untrustedPackages("error: Target must be enabled before it can be used.")).toEqual([]);
  });

  test("is undefined for any other failure, even with the skip flags on the command line", () => {
    expect(untrustedPackages("$ xcodebuild archive -skipMacroValidation\nerror: No signing certificate\n** ARCHIVE FAILED **")).toBeUndefined();
  });
});

describe("trustError", () => {
  const error = trustError(untrustedPackages(LOG)!, { open: "ship open", openCommand: "ship open", projectPath: "/r/Lift.xcodeproj", log: "/r/.ship/builds/7/archive.log" });

  test("says what, why, and the two ways out, grouped by package", () => {
    expect(error.message).toBe("Xcode won't build 3 Swift macros until you trust them");
    expect(error.code).toBe("untrusted-package");
    expect(error.hint).toBe(
      [
        "PerceptionMacros (swift-perception)",
        "StructuredQueriesMacros, StructuredQueriesSQLiteMacros (swift-structured-queries)",
        "A command-line build can't ask, so trust them once in Xcode:",
        "  ship open        then build (⌘B) and click Trust & Enable",
        "Then run ship again. Or skip the check for this repo, in ship.json:",
        '  "build": { "skipMacroValidation": true }',
      ].join("\n  "),
    );
  });

  test("gives agents what they need to offer an Open in Xcode button", () => {
    expect(error.details).toEqual({
      untrusted: untrustedPackages(LOG),
      projectPath: "/r/Lift.xcodeproj",
      openCommand: "ship open",
      settings: ["build.skipMacroValidation"],
      log: "/r/.ship/builds/7/archive.log",
    });
  });

  test("pads by the command's visible length when it's a terminal link", () => {
    const linked = "\x1b]8;;file:///r/Lift.xcodeproj\x1b\\ship open\x1b]8;;\x1b\\";
    const hint = trustError([{ kind: "plugin", name: "Lint" }], { open: linked, openCommand: "ship open", projectPath: "/r", log: "/l" }).hint!;
    expect(hint).toContain(`  ${linked}        then build`);
  });

  test("speaks of one thing as it", () => {
    const one = trustError([{ kind: "plugin", name: "Lint", package: "lint" }], { open: "ship open", openCommand: "ship open", projectPath: "/r", log: "/l" });
    expect(one.message).toBe("Xcode won't build 1 package plugin until you trust it");
    expect(one.hint).toContain('"build": { "skipPackagePluginValidation": true }');
  });

  test("offers both settings when the log names nothing", () => {
    const unnamed = trustError([], { open: "ship open", openCommand: "ship open", projectPath: "/r", log: "/l" });
    expect(unnamed.message).toBe("Xcode won't build a Swift macro or package plugin until you trust it");
    expect(unnamed.hint).toContain('"build": { "skipMacroValidation": true, "skipPackagePluginValidation": true }');
  });
});

describe("ship.json build settings", () => {
  test("skipSettings matches what needs trusting", () => {
    expect(skipSettings([{ kind: "macro", name: "M" }, { kind: "plugin", name: "P" }])).toEqual(["skipMacroValidation", "skipPackagePluginValidation"]);
    expect(skipSettings([{ kind: "plugin", name: "P" }])).toEqual(["skipPackagePluginValidation"]);
  });

  test("become xcodebuild arguments, in order", () => {
    expect(buildSettingArgs(undefined)).toEqual([]);
    expect(buildSettingArgs({ skipMacroValidation: true, skipPackagePluginValidation: false, xcodebuildArgs: ["-quiet", "OTHER=1"] })).toEqual([
      "-skipMacroValidation",
      "-quiet",
      "OTHER=1",
    ]);
  });

  test("a typo fails before the archive, with an example", () => {
    const check = (build: unknown) => {
      try {
        checkBuildSettings(build, "ship.json");
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(check(undefined)).toBeUndefined();
    expect(check({ skipMacroValidation: true, xcodebuildArgs: [] })).toBeUndefined();
    expect(check({ skipMacroValidaton: true })).toContain('unknown key "skipMacroValidaton"');
    expect(check({ skipMacroValidation: "yes" })).toContain("skipMacroValidation must be true or false");
    expect(check({ xcodebuildArgs: "-quiet" })).toContain("xcodebuildArgs must be a list of strings");
    expect(check(["-quiet"])).toContain("it must be an object");
  });

  test("loadProject checks them", async () => {
    const root = mkdtempSync(join(tmpdir(), "ship-test-"));
    const config = { name: "App", kind: "xcodeproj", path: "App.xcodeproj", scheme: "App", bundleId: "com.example.app" };
    writeFileSync(join(root, "ship.json"), JSON.stringify({ ...config, build: { xcodebuildArgs: [1] } }));
    await expect(loadProject({ cwd: root })).rejects.toMatchObject({ code: "bad-config" });
    writeFileSync(join(root, "ship.json"), JSON.stringify({ ...config, build: { skipMacroValidation: true } }));
    expect((await loadProject({ cwd: root })).config.build).toEqual({ skipMacroValidation: true });
  });
});

describe("openCommandFor", () => {
  const root = mkdtempSync(join(tmpdir(), "ship-test-"));
  mkdirSync(join(root, "apps"));
  writeFileSync(join(root, "ship.json"), "{}");
  const project = (name: string) => ({ root, config: { name } }) as Project;

  test("is plain ship open inside the repo", () => {
    expect(openCommandFor(project("Lift"), join(root, "apps"))).toBe("ship open");
  });

  test("names the app from anywhere else, quoted when it needs to be", () => {
    expect(openCommandFor(project("Lift"), tmpdir())).toBe("ship open --app Lift");
    expect(openCommandFor(project("SwiftUI for Humans"), tmpdir())).toBe('ship open --app "SwiftUI for Humans"');
  });
});
