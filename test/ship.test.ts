import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bearerToken } from "../src/asc/client";
import { checkInfo } from "../src/build";
import { errorLines, run } from "../src/exec";
import { findContainers, packageSettings, setPackageBuild } from "../src/xcode";

const temp = () => mkdtempSync(join(tmpdir(), "ship-test-"));

describe("findContainers", () => {
  test("finds real projects and packages, and skips stand-ins", () => {
    const root = temp();
    mkdirSync(join(root, "apps/ios/App.xcodeproj"), { recursive: true });
    writeFileSync(join(root, "apps/ios/App.xcodeproj/project.pbxproj"), "");
    // A leftover project folder with no project file.
    mkdirSync(join(root, "Stale.xcodeproj/xcuserdata"), { recursive: true });
    // The hidden metadata folder Xcode keeps inside Swift packages.
    mkdirSync(join(root, "apps/ios/Kit/.swiftpm"), { recursive: true });
    // An App Playground package.
    mkdirSync(join(root, "Play.swiftpm"), { recursive: true });
    writeFileSync(join(root, "Play.swiftpm/Package.swift"), "");
    // Dependencies are never searched.
    mkdirSync(join(root, "node_modules/x/Other.xcodeproj"), { recursive: true });
    writeFileSync(join(root, "node_modules/x/Other.xcodeproj/project.pbxproj"), "");

    const found = findContainers(root).map((c) => `${c.kind}:${c.path.slice(root.length + 1)}`).sort();
    expect(found).toEqual(["swiftpm:Play.swiftpm", "xcodeproj:apps/ios/App.xcodeproj"]);
  });
});

describe("App Playground packages", () => {
  const manifest = `let package = Package(
    name: "MyPackage",
    products: [
        .iOSApplication(
            name: "My App",
            targets: ["AppModule"],
            bundleIdentifier: "com.example.app",
            teamIdentifier: "ABCDE12345",
            displayVersion: "1.0",
            bundleVersion: "4",
        )
    ]
)`;

  test("reads the app's settings from Package.swift", async () => {
    const dir = temp();
    writeFileSync(join(dir, "Package.swift"), manifest);
    expect(await packageSettings(dir)).toEqual({
      productName: "My App",
      bundleId: "com.example.app",
      teamId: "ABCDE12345",
      version: "1.0",
      build: "4",
    });
  });

  test("sets the build number", async () => {
    const dir = temp();
    writeFileSync(join(dir, "Package.swift"), manifest);
    await setPackageBuild(dir, "5");
    expect((await packageSettings(dir)).build).toBe("5");
  });
});

describe("checkInfo", () => {
  test("passes a build that matches", () => {
    const checks = checkInfo(
      { CFBundleIdentifier: "com.example.app", CFBundleVersion: "5", ITSAppUsesNonExemptEncryption: false },
      { bundleId: "com.example.app", build: "5" },
    );
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  test("flags a wrong build number and a missing compliance key", () => {
    const checks = checkInfo({ CFBundleIdentifier: "com.example.app", CFBundleVersion: "1" }, { bundleId: "com.example.app", build: "5" });
    expect(checks.map((c) => c.ok)).toEqual([true, false, false]);
  });
});

test("run removes environment variables set to undefined", async () => {
  process.env.SHIP_TEST_VAR = "set";
  const kept = await run(["sh", "-c", "echo ${SHIP_TEST_VAR-unset}"]);
  const removed = await run(["sh", "-c", "echo ${SHIP_TEST_VAR-unset}"], { env: { SHIP_TEST_VAR: undefined } });
  delete process.env.SHIP_TEST_VAR;
  expect(kept.stdout.trim()).toBe("set");
  expect(removed.stdout.trim()).toBe("unset");
});

test("errorLines keeps only the useful lines of a build log", () => {
  const log = "CompileSwift normal\n/x/A.swift:3:5: error: nope\n/x/A.swift:3:5: error: nope\nwarning: meh\n** ARCHIVE FAILED **";
  expect(errorLines(log)).toEqual(["/x/A.swift:3:5: error: nope", "** ARCHIVE FAILED **"]);
});

test("signs App Store Connect tokens that verify with the key", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;

  const jwt = await bearerToken({ keyId: "KEY123", issuerId: "issuer-uuid", privateKey: pem });
  const [header, payload, signature] = jwt.split(".");
  expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY123", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
  expect(claims.iss).toBe("issuer-uuid");
  expect(claims.aud).toBe("appstoreconnect-v1");
  expect(claims.exp - claims.iat).toBeLessThanOrEqual(20 * 60);

  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pair.publicKey,
    Buffer.from(signature!, "base64url"),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  expect(valid).toBe(true);
});
