// The team and account commands (ship users, ship devices, ship sandbox) and
// moving from fastlane (ship metadata import, ship screenshots import).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { policy } from "../src/asc/client";
import { invitationBody, toMember } from "../src/asc/users";
import { type Context, findCommand, parseFlags } from "../src/command";
import { commands } from "../src/commands";
import { checkUdid, findDevice, parseDevicePlatform } from "../src/commands/devices";
import { findTesters, parseRenewal } from "../src/commands/sandbox";
import { findMember, parseRole } from "../src/commands/users";
import { appsPath } from "../src/config";
import { useCredentials } from "../src/credentials";
import { categoryId, mergeStoreApp, readFastlaneMetadata, screenshotTypeFor } from "../src/store/fastlane";
import { ShipError, ui } from "../src/ui";
import { captureLog, jsonApi, mockAsc, noRetryDelay, resource, temp, testCredentials } from "./helpers";

const APP = "1234567890";

/** A repo with ship.json, known to this machine as "Lift". Returns its root. */
function setup() {
  const root = realpathSync(temp());
  writeFileSync(join(root, "ship.json"), JSON.stringify({ name: "Lift", kind: "xcodeproj", path: "App.xcodeproj", scheme: "App", bundleId: "com.example.lift", ascAppId: APP }));
  writeFileSync(appsPath, JSON.stringify([{ name: "Lift", bundleId: "com.example.lift", root, addedAt: "1" }]));
  return root;
}

/** Runs `ship <argv> --app Lift --json` in-process and returns its JSON. */
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

const writes = (calls: { method: string; path: string }[]) => calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`);

let mock: ReturnType<typeof mockAsc> | undefined;
let delay: ReturnType<typeof noRetryDelay>;

beforeEach(async () => {
  await testCredentials();
  delay = noRetryDelay();
});

afterEach(() => {
  mock?.restore();
  mock = undefined;
  delay.restore();
  useCredentials(undefined);
  policy.readOnly = false;
  ui.json = false;
  ui.quiet = false;
  process.exitCode = 0;
});

// MARK: ship users

const user = (id: string, email: string, roles: string[], attributes: Record<string, unknown> = {}) =>
  resource("users", id, { username: email, firstName: "Ada", lastName: id, roles, allAppsVisible: true, provisioningAllowed: false, ...attributes });

describe("ship users", () => {
  test("roles and members", async () => {
    expect(parseRole("app-manager")).toBe("APP_MANAGER");
    expect(parseRole("Customer_Support")).toBe("CUSTOMER_SUPPORT");
    expect((await rejected(() => parseRole("boss"))).details?.choices).toContain("app-manager");
    expect((await rejected(() => parseRole("account-holder"))).message).toContain("one Account Holder");
    const members = [toMember(user("u1", "ada@example.com", ["ADMIN"]), false)];
    expect(findMember(members, " ADA@example.com ").id).toBe("u1");
    expect(await rejected(() => findMember(members, "bob@example.com"))).toMatchObject({ code: "no-user", exitCode: 4 });
  });

  test("an invitation to some apps names them; to every app it doesn't", () => {
    const base = { email: "b@example.com", firstName: "B", lastName: "C", roles: ["DEVELOPER"], provisioningAllowed: true };
    expect(invitationBody({ ...base, allAppsVisible: false, visibleApps: [APP] }).data).toEqual({
      type: "userInvitations",
      attributes: { email: "b@example.com", firstName: "B", lastName: "C", roles: ["DEVELOPER"], allAppsVisible: false, provisioningAllowed: true },
      relationships: { visibleApps: { data: [{ type: "apps", id: APP }] } },
    });
    expect(invitationBody({ ...base, allAppsVisible: true, visibleApps: [] }).data).not.toHaveProperty("relationships");
  });

  test("list, invite, and remove", async () => {
    setup();
    mock = mockAsc((call) => {
      if (call.path === "/v1/users") return { json: jsonApi([user("u1", "ada@example.com", ["ACCOUNT_HOLDER", "ADMIN"]), user("u2", "bo@example.com", ["DEVELOPER"], { allAppsVisible: false }, )]) };
      if (call.path === "/v1/userInvitations" && call.method === "GET") return { json: jsonApi([resource("userInvitations", "i1", { email: "cy@example.com", firstName: "Cy", lastName: "D", roles: ["MARKETING"], allAppsVisible: true, expirationDate: "2026-11-20T00:00:00Z" })]) };
      if (call.path === "/v1/userInvitations" && call.method === "POST") return { status: 201, json: jsonApi(resource("userInvitations", "i2", (call.body as any).data.attributes)) };
      if (call.method === "DELETE") return { status: 204 };
      return undefined;
    });
    const list = await ship(["users"]);
    expect(list.users.map((u: { email: string; invited: boolean }) => [u.email, u.invited])).toEqual([
      ["ada@example.com", false],
      ["bo@example.com", false],
      ["cy@example.com", true],
    ]);

    const dry = await ship(["users", "invite", "new@example.com", "--first", "New", "--last", "Person", "--role", "developer", "--apps", "Lift", "--dry-run"]);
    expect(dry.invitation).toMatchObject({ allAppsVisible: false, visibleApps: [APP], roles: ["DEVELOPER"] });
    expect(writes(mock.calls)).toEqual([]);
    const invited = await ship(["users", "invite", "new@example.com", "--first", "New", "--last", "Person", "--role", "developer", "--role", "marketing"]);
    expect(invited.invitation).toMatchObject({ id: "i2", email: "new@example.com", invited: true, roles: ["DEVELOPER", "MARKETING"] });
    expect((await rejected(() => ship(["users", "invite", "bo@example.com", "--first", "B", "--last", "O", "--role", "admin"])))).toMatchObject({ code: "user-exists", exitCode: 5 });
    expect((await rejected(() => ship(["users", "invite", "x@example.com", "--first", "X", "--last", "Y"])))).toMatchObject({ message: "Which role? Pass --role" });

    await ship(["users", "remove", "cy@example.com"]);
    await ship(["users", "remove", "BO@example.com"]);
    expect(writes(mock.calls).slice(-2)).toEqual(["DELETE /v1/userInvitations/i1", "DELETE /v1/users/u2"]);
    expect((await rejected(() => ship(["users", "remove", "ada@example.com"]))).code).toBe("account-holder");
    expect((await rejected(() => ship(["users", "remove", "ada@example.com", "--role", "admin"]))).code).toBe("usage");
  });
});

// MARK: ship devices

const device = (id: string, name: string, udid: string, status = "ENABLED") =>
  resource("devices", id, { name, udid, platform: "IOS", deviceClass: "IPHONE", model: "iPhone 17 Pro", status, addedDate: "2026-01-01T00:00:00Z" });

describe("ship devices", () => {
  const UDID = "00008030-001A2D2E0C38802E";

  test("UDIDs, platforms, and finding one", async () => {
    expect(checkUdid(` ${UDID} `)).toBe(UDID);
    expect(checkUdid("a".repeat(40))).toBe("a".repeat(40));
    expect(checkUdid("12345678-1234-1234-1234-123456789ABC")).toBe("12345678-1234-1234-1234-123456789ABC");
    expect((await rejected(() => checkUdid("nope"))).code).toBe("usage");
    expect(parseDevicePlatform("visionOS")).toBe("IOS");
    expect(parseDevicePlatform("macos")).toBe("MAC_OS");
    expect(parseDevicePlatform(undefined)).toBeUndefined();
    expect((await rejected(() => parseDevicePlatform("android"))).code).toBe("usage");
    const devices = [device("d1", "Ada's iPhone", UDID), device("d2", "Test", "a".repeat(40)), device("d3", "Test", "b".repeat(40))].map((r) => ({
      id: r.id,
      name: r.attributes.name as string,
      udid: r.attributes.udid as string,
      platform: "IOS",
      deviceClass: "IPHONE",
      model: null,
      status: "ENABLED",
      addedDate: null,
    }));
    expect(findDevice(devices, "ada's IPHONE").id).toBe("d1");
    expect(findDevice(devices, UDID.toLowerCase()).id).toBe("d1");
    expect((await rejected(() => findDevice(devices, "Test"))).details?.choices).toEqual(["a".repeat(40), "b".repeat(40)]);
    expect(await rejected(() => findDevice(devices, "Nope"))).toMatchObject({ code: "no-device", exitCode: 4 });
  });

  test("list, add, rename, and disable", async () => {
    setup();
    mock = mockAsc((call) => {
      if (call.path === "/v1/devices" && call.method === "GET") return { json: jsonApi([device("d1", "Ada's iPhone", UDID)]) };
      if (call.path === "/v1/devices" && call.method === "POST") return { status: 201, json: jsonApi(device("d9", (call.body as any).data.attributes.name, (call.body as any).data.attributes.udid)) };
      if (call.method === "PATCH") {
        const { attributes } = (call.body as any).data;
        return { json: jsonApi(device("d1", attributes.name ?? "Ada's iPhone", UDID, attributes.status ?? "ENABLED")) };
      }
      return undefined;
    });
    expect((await ship(["devices", "--platform", "ios"])).devices).toHaveLength(1);
    expect(mock.calls[0]!.query["filter[platform]"]).toBe("IOS");

    const added = await ship(["devices", "add", "c".repeat(40), "--name", "Bo's iPad"]);
    expect(added.device).toMatchObject({ id: "d9", name: "Bo's iPad" });
    expect(mock.calls.at(-1)!.body).toEqual({ data: { type: "devices", attributes: { name: "Bo's iPad", udid: "c".repeat(40), platform: "IOS" } } });
    expect(await rejected(() => ship(["devices", "add", UDID, "--name", "Again"]))).toMatchObject({ code: "device-exists", exitCode: 5 });

    expect((await ship(["devices", "rename", "Ada's iPhone", "Ada's old iPhone"])).device.name).toBe("Ada's old iPhone");
    expect((await ship(["devices", "disable", UDID])).device.status).toBe("DISABLED");
    expect(mock.calls.at(-1)!.body).toEqual({ data: { type: "devices", id: "d1", attributes: { status: "DISABLED" } } });

    const before = writes(mock.calls).length;
    expect((await ship(["devices", "enable", UDID, "--dry-run"])).dryRun).toBe(true);
    expect(writes(mock.calls)).toHaveLength(before);
    expect((await rejected(() => ship(["devices", "rename", "Ada's iPhone"]))).message).toContain("takes 2 arguments");
  });
});

// MARK: ship sandbox

const sandboxTester = (id: string, email: string) =>
  resource("sandboxTesters", id, { acAccountName: email, firstName: "S", lastName: id, territory: "USA", interruptPurchases: false, subscriptionRenewalRate: "MONTHLY_RENEWAL_EVERY_ONE_HOUR" });

describe("ship sandbox", () => {
  test("renewal rates and finding testers", async () => {
    expect(parseRenewal("5M")).toBe("MONTHLY_RENEWAL_EVERY_FIVE_MINUTES");
    expect(parseRenewal(undefined)).toBeUndefined();
    expect((await rejected(() => parseRenewal("2m"))).details?.choices).toEqual(["1h", "30m", "15m", "5m", "3m"]);
    const testers = [{ id: "s1", email: "a@sandbox.test", firstName: "", lastName: "", territory: null, interruptPurchases: false, subscriptionRenewalRate: null, applePayCompatible: false }];
    expect(findTesters(testers, ["A@sandbox.test"]).map((t) => t.id)).toEqual(["s1"]);
    expect(await rejected(() => findTesters(testers, ["b@sandbox.test"]))).toMatchObject({ code: "no-sandbox-tester", exitCode: 4 });
  });

  test("list, clear, and set", async () => {
    setup();
    mock = mockAsc((call) => {
      if (call.path === "/v2/sandboxTesters") return { json: jsonApi([sandboxTester("s1", "a@sandbox.test"), sandboxTester("s2", "b@sandbox.test")]) };
      if (call.path === "/v2/sandboxTestersClearPurchaseHistoryRequest") return { status: 201, json: jsonApi(resource("sandboxTestersClearPurchaseHistoryRequest", "r1")) };
      if (call.method === "PATCH") return { json: jsonApi(resource("sandboxTesters", "s1", { acAccountName: "a@sandbox.test", ...(call.body as any).data.attributes })) };
      return undefined;
    });
    expect((await ship(["sandbox"])).testers.map((t: { email: string }) => t.email)).toEqual(["a@sandbox.test", "b@sandbox.test"]);

    expect((await ship(["sandbox", "clear", "--all"])).cleared).toEqual(["a@sandbox.test", "b@sandbox.test"]);
    expect(mock.calls.at(-1)!.body).toEqual({
      data: {
        type: "sandboxTestersClearPurchaseHistoryRequest",
        relationships: { sandboxTesters: { data: [{ type: "sandboxTesters", id: "s1" }, { type: "sandboxTesters", id: "s2" }] } },
      },
    });
    expect((await rejected(() => ship(["sandbox", "clear"]))).message).toBe("Whose purchases? Pass emails or --all");
    expect((await rejected(() => ship(["sandbox", "clear", "a@sandbox.test", "--all"]))).message).toBe("Pass emails or --all, not both");

    const set = await ship(["sandbox", "set", "a@sandbox.test", "--territory", "gbr", "--interrupt", "--renewal", "3m"]);
    expect(set.changes).toEqual({ territory: "GBR", interruptPurchases: true, subscriptionRenewalRate: "MONTHLY_RENEWAL_EVERY_THREE_MINUTES" });
    expect(mock.calls.at(-1)).toMatchObject({ method: "PATCH", path: "/v2/sandboxTesters/s1" });
    expect((await rejected(() => ship(["sandbox", "set", "a@sandbox.test"]))).message).toBe("Nothing to set");
    expect((await rejected(() => ship(["sandbox", "set", "a@sandbox.test", "--interrupt", "--no-interrupt"]))).code).toBe("usage");
  });

  test("read-only mode stops a clear", async () => {
    setup();
    mock = mockAsc((call) => (call.path === "/v2/sandboxTesters" ? { json: jsonApi([sandboxTester("s1", "a@sandbox.test")]) } : undefined));
    policy.readOnly = true;
    expect(await rejected(() => ship(["sandbox", "clear", "--all"]))).toMatchObject({ code: "read-only", exitCode: 6 });
  });
});

// MARK: fastlane

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, data: number[]) => [...be32(data.length), ...Buffer.from(type), ...data, 0, 0, 0, 0];
const png = (width: number, height: number, seed = 0) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [...be32(width), ...be32(height), 8, 2, 0, 0, 0]), ...chunk("IDAT", [seed, 1, 2, 3]), ...chunk("IEND", [])]);

/** A fastlane folder like `fastlane deliver init` makes. */
function fastlaneFolder(root: string) {
  const write = (path: string, text: string | Uint8Array) => {
    mkdirSync(join(root, "fastlane", path, ".."), { recursive: true });
    writeFileSync(join(root, "fastlane", path), text);
  };
  write("metadata/en-US/name.txt", "Lift\n");
  write("metadata/en-US/subtitle.txt", "Lift more\n");
  write("metadata/en-US/keywords.txt", "gym, workout,strength\n");
  write("metadata/en-US/release_notes.txt", "Fixes.\r\n");
  write("metadata/en-US/privacy_url.txt", "https://example.com/privacy");
  write("metadata/en-US/apple_tv_privacy_policy.txt", "TV policy");
  write("metadata/de-DE/name.txt", "Heben");
  write("metadata/default/support_url.txt", "https://example.com/support");
  write("metadata/copyright.txt", "2026 Example");
  write("metadata/primary_category.txt", "MZGenre.HealthAndFitness");
  write("metadata/secondary_category.txt", "SPORTS");
  write("metadata/review_information/first_name.txt", "Ada");
  write("metadata/review_information/email_address.txt", "ada@example.com");
  write("metadata/review_information/demo_user.txt", "demo@example.com");
  write("metadata/review_information/demo_password.txt", "hunter2");
  write("metadata/review_information/notes.txt", "Sign in with the demo account.");
  write("screenshots/en-US/0_APP_IPHONE_65_0.png", png(1242, 2688));
  write("screenshots/en-US/1_iPhone 16 Pro Max-home.png", png(1320, 2868));
  write("screenshots/en-US/2_iPhone 16 Pro Max-workout.png", png(1320, 2868, 1));
  write("screenshots/en-US/odd.png", png(100, 100));
  write("screenshots/de-DE/iPad Pro.png", png(2064, 2752));
}

describe("fastlane import", () => {
  test("category names become App Store Connect ids", () => {
    expect(categoryId("HEALTH_AND_FITNESS")).toBe("HEALTH_AND_FITNESS");
    expect(categoryId("MZGenre.HealthAndFitness")).toBe("HEALTH_AND_FITNESS");
    expect(categoryId("MZGenre.Apps.Productivity")).toBe("PRODUCTIVITY");
    expect(categoryId("Food & Drink")).toBe("FOOD_AND_DRINK");
    expect(categoryId("  ")).toBeUndefined();
  });

  test("a screenshot's type comes from its size, or its name when sizes are shared", () => {
    expect(screenshotTypeFor(1320, 2868)).toBe("APP_IPHONE_67");
    expect(screenshotTypeFor(2868, 1320)).toBe("APP_IPHONE_67");
    expect(screenshotTypeFor(1179, 2556)).toBe("APP_IPHONE_61");
    expect(screenshotTypeFor(1179, 2556, "x_APP_IPHONE_58_1.png")).toBe("APP_IPHONE_58");
    expect(screenshotTypeFor(100, 100)).toBeUndefined();
  });

  test("reads the text, categories, and review details, and says what it left", async () => {
    const root = temp();
    fastlaneFolder(root);
    const read = await readFastlaneMetadata(join(root, "fastlane"));
    expect(read.files).toEqual({
      "en-US/name.txt": "Lift",
      "en-US/subtitle.txt": "Lift more",
      "en-US/keywords.txt": "gym\nworkout\nstrength",
      "en-US/whats-new.txt": "Fixes.",
      "en-US/privacy-policy-url.txt": "https://example.com/privacy",
      "en-US/support-url.txt": "https://example.com/support",
      "de-DE/name.txt": "Heben",
      "de-DE/support-url.txt": "https://example.com/support",
      "review-notes.txt": "Sign in with the demo account.",
    });
    expect(read.app).toEqual({
      copyright: "2026 Example",
      categories: { primary: "HEALTH_AND_FITNESS", secondary: "SPORTS" },
      review: { contactFirstName: "Ada", contactEmail: "ada@example.com", demoAccountName: "demo@example.com", demoAccountRequired: true },
    });
    expect(read.warnings.join("\n")).toContain("demo_password.txt holds the password itself");
    expect(read.warnings.join("\n")).toContain("en-US/apple_tv_privacy_policy.txt");
    expect(read.warnings.join("\n")).toContain('"MZGenre.HealthAndFitness" became HEALTH_AND_FITNESS');
    // Pointing at metadata/ itself works too.
    expect((await readFastlaneMetadata(join(root, "fastlane", "metadata"))).files["de-DE/name.txt"]).toBe("Heben");
    expect(await rejected(() => readFastlaneMetadata(root + "/nope"))).toMatchObject({ code: "no-fastlane" });
  });

  test("app.json keeps what fastlane doesn't say, and notes what it would replace", () => {
    const { app, replaced } = mergeStoreApp(
      { copyright: "2025 Old", categories: { primary: "SPORTS", primarySubcategories: [] }, review: { contactPhone: "+1 555" }, release: { phased: true } },
      { copyright: "2026 Example", categories: { primary: "SPORTS", secondary: "HEALTH_AND_FITNESS" }, review: { contactFirstName: "Ada" } },
    );
    expect(app).toEqual({
      copyright: "2026 Example",
      categories: { primary: "SPORTS", primarySubcategories: [], secondary: "HEALTH_AND_FITNESS" },
      review: { contactPhone: "+1 555", contactFirstName: "Ada" },
      release: { phased: true },
    });
    expect(replaced).toEqual(["copyright"]);
  });

  test("ship metadata import writes the store folder, and won't overwrite without --force", async () => {
    const root = setup();
    fastlaneFolder(root);
    const dry = await ship(["metadata", "import", "--dry-run"]);
    expect(dry.dryRun).toBe(true);
    expect(dry.written).toContain("app.json");
    expect(existsSync(join(root, "appstore"))).toBe(false);

    const first = await ship(["metadata", "import"]);
    expect(first.written).toEqual([
      "app.json",
      "de-DE/name.txt",
      "de-DE/support-url.txt",
      "en-US/keywords.txt",
      "en-US/name.txt",
      "en-US/privacy-policy-url.txt",
      "en-US/subtitle.txt",
      "en-US/support-url.txt",
      "en-US/whats-new.txt",
      "review-notes.txt",
    ]);
    expect(readFileSync(join(root, "appstore", "en-US", "keywords.txt"), "utf8")).toBe("gym\nworkout\nstrength\n");
    expect(JSON.parse(readFileSync(join(root, "appstore", "app.json"), "utf8")).categories.primary).toBe("HEALTH_AND_FITNESS");
    // Again: nothing to do.
    expect((await ship(["metadata", "import"])).written).toEqual([]);

    writeFileSync(join(root, "appstore", "en-US", "name.txt"), "Lift Pro\n");
    const conflict = await rejected(() => ship(["metadata", "import"]));
    expect(conflict).toMatchObject({ code: "local-changes", details: { files: ["en-US/name.txt"] } });
    expect((await ship(["metadata", "import", "--force"])).written).toEqual(["en-US/name.txt"]);
    expect((await rejected(() => ship(["metadata", "import", "--locale", "en-US"]))).code).toBe("usage");
  });

  test("ship screenshots import files each image under its type, in fastlane's order", async () => {
    const root = setup();
    fastlaneFolder(root);
    const result = await ship(["screenshots", "import"]);
    expect(result.written).toEqual([
      "de-DE/screenshots/APP_IPAD_PRO_3GEN_129/01-ipad-pro.png",
      "en-US/screenshots/APP_IPHONE_65/01-app_iphone_65_0.png",
      "en-US/screenshots/APP_IPHONE_67/01-iphone-16-pro-max-home.png",
      "en-US/screenshots/APP_IPHONE_67/02-iphone-16-pro-max-workout.png",
    ]);
    expect(result.warnings).toEqual(["Skipped en-US/odd.png: 100x100 isn't a screenshot size App Store Connect takes"]);
    expect(existsSync(join(root, "appstore", "en-US", "screenshots", "APP_IPHONE_67", "02-iphone-16-pro-max-workout.png"))).toBe(true);
    expect((await ship(["screenshots", "import"])).unchanged).toHaveLength(4);
    writeFileSync(join(root, "appstore", "de-DE", "screenshots", "APP_IPAD_PRO_3GEN_129", "01-ipad-pro.png"), png(2064, 2752, 9));
    expect((await rejected(() => ship(["screenshots", "import"]))).code).toBe("local-changes");
    expect((await rejected(() => ship(["screenshots", "import", "--type", "APP_IPHONE_67"]))).code).toBe("usage");
  });
});
