// Signing: certificates (and which this Mac can use), provisioning profiles, and installing them for Xcode.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { policy } from "../src/asc/client";
import { certificateSha1, isXcodeManaged, profileCreateBody } from "../src/asc/signing";
import { type Context, findCommand, parseFlags } from "../src/command";
import { commands } from "../src/commands";
import { daysUntil, parseCertificateKind } from "../src/commands/certificates";
import { parseProfileKind } from "../src/commands/profiles";
import { appsPath } from "../src/config";
import { useCredentials } from "../src/credentials";
import { security } from "../src/keychain";
import { certificateTypesFor, installProfile, installedProfiles, profileType, signingIdentities, signingPaths } from "../src/signing";
import { ShipError, ui } from "../src/ui";
import { type AscCall, captureLog, jsonApi, mockAsc, noRetryDelay, resource, temp, testCredentials } from "./helpers";

const APP = "1234567890";
const DER = Buffer.from("a certificate").toString("base64");
const SHA1 = certificateSha1(DER);
const OTHER = Buffer.from("another certificate").toString("base64");

function setup(platform = "ios") {
  const root = realpathSync(temp());
  writeFileSync(join(root, "ship.json"), JSON.stringify({ name: "Lift", kind: "xcodeproj", path: "App.xcodeproj", scheme: "App", bundleId: "com.example.lift", ascAppId: APP, platform }));
  writeFileSync(appsPath, JSON.stringify([{ name: "Lift", bundleId: "com.example.lift", root, addedAt: "1" }]));
  return root;
}

async function ship(argv: string[]): Promise<any> {
  const [name, ...rest] = argv;
  const command = findCommand(commands, name)!;
  const { values, positionals } = parseFlags(rest, command.flags);
  const ctx: Context = { args: positionals, flags: values, app: "Lift", implicit: false };
  ui.json = true;
  ui.quiet = true;
  return JSON.parse(await captureLog(() => command.run(ctx)));
}

async function rejected(body: () => unknown): Promise<ShipError> {
  try {
    await body();
  } catch (error) {
    if (error instanceof ShipError) return error;
    throw error;
  }
  throw new Error("expected a ShipError");
}

const writes = (calls: AscCall[]) => calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`);

let mock: ReturnType<typeof mockAsc> | undefined;
let delay: ReturnType<typeof noRetryDelay>;
const realSecurity = { ...security };
const realProfiles = signingPaths.profiles;
/** What `security` was asked to do. */
let securityCalls: string[][];

beforeEach(async () => {
  await testCredentials();
  delay = noRetryDelay();
  ui.quiet = true;
  signingPaths.profiles = join(temp(), "Provisioning Profiles");
  securityCalls = [];
  // The Keychain holds the private key for DER's certificate only.
  security.run = async (args) => {
    securityCalls.push(args);
    if (args[0] === "find-identity") return { code: 0, stdout: `  1) ${SHA1} "Apple Distribution: Ada (TEAM)"\n     1 valid identities found\n`, stderr: "" };
    if (args[0] === "import") return { code: 0, stdout: "1 certificate imported.\n", stderr: "" };
    throw new Error(`unexpected security ${args[0]}`);
  };
});

afterEach(() => {
  mock?.restore();
  mock = undefined;
  delay.restore();
  useCredentials(undefined);
  Object.assign(security, realSecurity);
  signingPaths.profiles = realProfiles;
  policy.readOnly = false;
  ui.json = false;
  ui.quiet = false;
  process.exitCode = 0;
});

const certificate = (id: string, type: string, content: string, expires = "2030-01-01T00:00:00Z") =>
  resource("certificates", id, { name: `${type} ${id}`, certificateType: type, serialNumber: `SER${id}`, platform: "IOS", expirationDate: expires, certificateContent: content });

const profile = (id: string, name: string, type = "IOS_APP_STORE", state = "ACTIVE") =>
  resource("profiles", id, { name, profileType: type, profileState: state, uuid: `0000000${id}-0000-0000-0000-000000000000`.slice(-36), expirationDate: "2027-01-01T00:00:00Z", profileContent: Buffer.from(`profile ${id}`).toString("base64") });

function asc(options: { certificates?: ReturnType<typeof certificate>[]; profiles?: ReturnType<typeof profile>[]; bundle?: boolean } = {}) {
  return (call: AscCall) => {
    const { method, path } = call;
    if (method === "GET" && path === "/v1/certificates") {
      const types = call.query["filter[certificateType]"]?.split(",");
      return { json: jsonApi((options.certificates ?? []).filter((c) => !types || types.includes(c.attributes.certificateType as string))) };
    }
    if (method === "GET" && path === "/v1/bundleIds") return { json: jsonApi(options.bundle === false ? [] : [resource("bundleIds", "B1", { identifier: "com.example.lift", name: "Lift", platform: "UNIVERSAL" }), resource("bundleIds", "B2", { identifier: "com.example.lift.widgets" })]) };
    if (method === "GET" && path === "/v1/bundleIds/B1/profiles") return { json: jsonApi(options.profiles ?? []) };
    if (method === "GET" && path === "/v1/devices") return { json: jsonApi([resource("devices", "d1", { name: "iPhone", udid: "a".repeat(40), platform: "IOS", status: "ENABLED" }), resource("devices", "d2", { name: "Old", udid: "b".repeat(40), platform: "IOS", status: "DISABLED" })]) };
    if (method === "POST" && path === "/v1/certificates") return { status: 201, json: jsonApi(certificate("new", (call.body as any).data.attributes.certificateType, OTHER)) };
    if (method === "POST" && path === "/v1/profiles") {
      const { name, profileType: type } = (call.body as any).data.attributes;
      return { status: 201, json: jsonApi(profile("9", name, type)) };
    }
    if (method === "DELETE") return { status: 204 };
    return undefined;
  };
}

describe("signing types", () => {
  test("profile and certificate kinds per platform", async () => {
    expect(profileType("ios", "app-store")).toBe("IOS_APP_STORE");
    expect(profileType("visionos", "ad-hoc")).toBe("IOS_APP_ADHOC");
    expect(profileType("tvos", "development")).toBe("TVOS_APP_DEVELOPMENT");
    expect(profileType("macos", "direct")).toBe("MAC_APP_DIRECT");
    expect((await rejected(() => profileType("ios", "direct"))).code).toBe("usage");
    expect((await rejected(() => profileType("macos", "ad-hoc"))).code).toBe("usage");
    expect(certificateTypesFor("ios", "app-store")).toEqual(["DISTRIBUTION", "IOS_DISTRIBUTION"]);
    expect(certificateTypesFor("macos", "development")).toEqual(["DEVELOPMENT", "MAC_APP_DEVELOPMENT"]);
    expect(certificateTypesFor("macos", "direct")).toEqual(["DEVELOPER_ID_APPLICATION_G2", "DEVELOPER_ID_APPLICATION"]);
    expect(parseCertificateKind("Developer-ID")).toBe("DEVELOPER_ID_APPLICATION_G2");
    expect((await rejected(() => parseCertificateKind("enterprise"))).details?.choices).toEqual(["distribution", "development", "developer-id", "mac-installer"]);
    expect(parseProfileKind(undefined)).toBe("app-store");
    expect((await rejected(() => parseProfileKind("store"))).code).toBe("usage");
    expect(daysUntil("2026-01-11T00:00:00Z", Date.parse("2026-01-01T00:00:00Z"))).toBe(10);
  });

  test("which profiles Xcode manages", () => {
    expect(isXcodeManaged("iOS Team Provisioning Profile: *")).toBe(true);
    expect(isXcodeManaged("iOS Team Store Provisioning Profile: com.example.lift")).toBe(true);
    expect(isXcodeManaged("XC iOS: com.example.lift")).toBe(true);
    expect(isXcodeManaged("Lift app-store (ship)")).toBe(false);
  });

  test("this Mac's identities, and installing a profile where Xcode looks", async () => {
    expect([...(await signingIdentities())]).toEqual([SHA1]);
    const path = await installProfile("12345678-1234-1234-1234-123456789ABC", Buffer.from("hello").toString("base64"));
    expect(path).toBe(join(signingPaths.profiles, "12345678-1234-1234-1234-123456789ABC.mobileprovision"));
    expect(readFileSync(path, "utf8")).toBe("hello");
    expect([...installedProfiles()]).toEqual(["12345678-1234-1234-1234-123456789ABC"]);
    expect((await rejected(() => installProfile("../escape", "eA=="))).code).toBe("bad-profile");
  });

  test("a profile's body", () => {
    expect(profileCreateBody({ name: "Lift", type: "IOS_APP_STORE", bundleId: "B1", certificates: ["c1"], devices: [] }).data).toEqual({
      type: "profiles",
      attributes: { name: "Lift", profileType: "IOS_APP_STORE" },
      relationships: { bundleId: { data: { type: "bundleIds", id: "B1" } }, certificates: { data: [{ type: "certificates", id: "c1" }] } },
    });
  });
});

describe("ship certificates", () => {
  test("list says which this Mac can sign with, and warns about one expiring soon", async () => {
    setup();
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    mock = mockAsc(asc({ certificates: [certificate("1", "DISTRIBUTION", DER), certificate("2", "DEVELOPMENT", OTHER, soon)] }));
    const result = await ship(["certificates"]);
    expect(result.certificates.map((c: any) => [c.id, c.onThisMac, c.expiresInDays <= 5])).toEqual([
      ["1", true, false],
      ["2", false, true],
    ]);
    expect(result.certificates[0]).not.toHaveProperty("content");
    await ship(["certificates", "--type", "distribution"]);
    expect(mock.calls.at(-1)!.query["filter[certificateType]"]).toBe("DISTRIBUTION");
  });

  test("create sends the signing request, never a key, and adds the certificate to the Keychain", async () => {
    setup();
    const dir = temp();
    const csr = join(dir, "request.certSigningRequest");
    writeFileSync(csr, "-----BEGIN CERTIFICATE REQUEST-----\nMIIB\n-----END CERTIFICATE REQUEST-----\n");
    const key = join(dir, "key.pem");
    writeFileSync(key, "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n");
    mock = mockAsc(asc());
    expect((await rejected(() => ship(["certificates", "create", "--type", "distribution", "--csr", key]))).message).toContain("isn't a signing request");
    expect((await ship(["certificates", "create", "--type", "distribution", "--csr", csr, "--dry-run"])).dryRun).toBe(true);
    expect(writes(mock.calls)).toEqual([]);

    const made = await ship(["certificates", "create", "--type", "distribution", "--csr", csr]);
    expect(mock.calls.at(-1)!.body).toEqual({ data: { type: "certificates", attributes: { certificateType: "DISTRIBUTION", csrContent: "-----BEGIN CERTIFICATE REQUEST-----\nMIIB\n-----END CERTIFICATE REQUEST-----" } } });
    // The new certificate's key isn't on this (fake) Mac, so it says so.
    expect(made.certificate).toMatchObject({ id: "new", onThisMac: false });
    const imported = securityCalls.find((args) => args[0] === "import")!;
    expect(imported.slice(2)).toEqual(["-t", "cert"]);
    expect(existsSync(imported[1]!)).toBe(false);
  });

  test("revoke by serial, and an unknown one", async () => {
    setup();
    mock = mockAsc(asc({ certificates: [certificate("1", "DISTRIBUTION", DER)] }));
    expect((await ship(["certificates", "revoke", "SER1", "--dry-run"])).dryRun).toBe(true);
    expect(writes(mock.calls)).toEqual([]);
    await ship(["certificates", "revoke", "ser1"]);
    expect(writes(mock.calls)).toEqual(["DELETE /v1/certificates/1"]);
    expect(await rejected(() => ship(["certificates", "revoke", "NOPE"]))).toMatchObject({ code: "no-certificate", exitCode: 4 });
    expect((await rejected(() => ship(["certificates", "revoke", "SER1", "--csr", "x"]))).code).toBe("usage");
  });
});

describe("ship profiles", () => {
  test("list, with which Xcode manages and which are installed", async () => {
    setup();
    await installProfile("00000001-0000-0000-0000-000000000000", "eA==");
    mock = mockAsc(asc({ profiles: [profile("1", "iOS Team Store Provisioning Profile: com.example.lift"), profile("2", "Lift ad-hoc (ship)", "IOS_APP_ADHOC")] }));
    const result = await ship(["profiles"]);
    expect(result.profiles.map((p: any) => [p.name, p.xcodeManaged, p.installed])).toEqual([
      ["iOS Team Store Provisioning Profile: com.example.lift", true, true],
      ["Lift ad-hoc (ship)", false, false],
    ]);
    // The bundle id is the exact one, not one that starts the same.
    expect(mock.calls.some((c) => c.path === "/v1/bundleIds/B2/profiles")).toBe(false);
  });

  test("create picks current certificates of the right kind, devices when it needs them, and installs it", async () => {
    setup();
    const expired = "2020-01-01T00:00:00Z";
    mock = mockAsc(asc({ certificates: [certificate("1", "DISTRIBUTION", DER), certificate("2", "DISTRIBUTION", OTHER, expired), certificate("3", "DEVELOPMENT", OTHER)] }));
    const made = await ship(["profiles", "create"]);
    expect(mock.calls.find((c) => c.path === "/v1/profiles")!.body).toEqual({
      data: { type: "profiles", attributes: { name: "Lift app-store (ship)", profileType: "IOS_APP_STORE" }, relationships: { bundleId: { data: { type: "bundleIds", id: "B1" } }, certificates: { data: [{ type: "certificates", id: "1" }] } } },
    });
    expect(made.profile).toMatchObject({ installed: true });
    expect(existsSync(made.path)).toBe(true);

    await ship(["profiles", "create", "--type", "development", "--name", "Dev"]);
    const dev = mock.calls.filter((c) => c.path === "/v1/profiles").at(-1)!.body as any;
    expect(dev.data.attributes).toEqual({ name: "Dev", profileType: "IOS_APP_DEVELOPMENT" });
    expect(dev.data.relationships.certificates.data).toEqual([{ type: "certificates", id: "3" }]);
    expect(dev.data.relationships.devices.data).toEqual([{ type: "devices", id: "d1" }]);
  });

  test("create needs a certificate; profiles need the bundle id registered", async () => {
    setup();
    mock = mockAsc(asc({ certificates: [certificate("3", "DEVELOPMENT", OTHER)] }));
    expect(await rejected(() => ship(["profiles", "create"]))).toMatchObject({ code: "no-certificate", exitCode: 4 });
    expect((await rejected(() => ship(["profiles", "create"]))).hint).toContain("--type distribution");
    mock.restore();
    mock = mockAsc(asc({ bundle: false }));
    expect(await rejected(() => ship(["profiles"]))).toMatchObject({ code: "no-bundle-id-record", exitCode: 4 });
  });

  test("install writes the valid ones; delete refuses one Xcode manages", async () => {
    setup();
    mock = mockAsc(asc({ profiles: [profile("1", "iOS Team Store Provisioning Profile: com.example.lift"), profile("2", "Lift ad-hoc (ship)", "IOS_APP_ADHOC"), profile("3", "Broken", "IOS_APP_STORE", "INVALID")] }));
    const installed = await ship(["profiles", "install"]);
    expect(installed.installed.map((p: any) => p.name)).toEqual(["iOS Team Store Provisioning Profile: com.example.lift", "Lift ad-hoc (ship)"]);
    expect((await ship(["profiles", "install", "broken"])).installed.map((p: any) => p.name)).toEqual(["Broken"]);
    expect(await rejected(() => ship(["profiles", "delete", "iOS Team Store Provisioning Profile: com.example.lift"]))).toMatchObject({ code: "xcode-managed", exitCode: 5 });
    await ship(["profiles", "delete", "Lift ad-hoc (ship)"]);
    expect(writes(mock.calls)).toEqual(["DELETE /v1/profiles/2"]);
    expect(await rejected(() => ship(["profiles", "delete", "nope"]))).toMatchObject({ code: "no-profile", exitCode: 4 });
  });

  test("read-only mode stops a create", async () => {
    setup();
    mock = mockAsc(asc({ certificates: [certificate("1", "DISTRIBUTION", DER)] }));
    policy.readOnly = true;
    expect(await rejected(() => ship(["profiles", "create"]))).toMatchObject({ code: "read-only", exitCode: 6 });
  });
});
