// Auto-renewable subscriptions: the files in appstore/subscriptions/, what push would change, and the requests it sends.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { policy } from "../src/asc/client";
import { priceCreateBody, subscriptionCreateBody } from "../src/asc/subscriptions";
import { type Context, findCommand, parseFlags } from "../src/command";
import { commands } from "../src/commands";
import { appsPath } from "../src/config";
import { useCredentials } from "../src/credentials";
import { type LocalGroup, type RemoteGroup, planSubscriptions, readSubscriptions, validateSubscriptions } from "../src/store/subscriptions";
import { ShipError, ui } from "../src/ui";
import { type AscCall, captureLog, jsonApi, mockAsc, noRetryDelay, resource, temp, testCredentials } from "./helpers";

const APP = "1234567890";
const TERRITORIES = ["CAN", "GBR", "USA"];

function setup() {
  const root = realpathSync(temp());
  writeFileSync(join(root, "ship.json"), JSON.stringify({ name: "Lift", kind: "xcodeproj", path: "App.xcodeproj", scheme: "App", bundleId: "com.example.lift", ascAppId: APP }));
  writeFileSync(appsPath, JSON.stringify([{ name: "Lift", bundleId: "com.example.lift", root, addedAt: "1" }]));
  return root;
}

const write = (root: string, path: string, text: string) => {
  const full = join(root, "appstore", "subscriptions", path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
};

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

beforeEach(async () => {
  await testCredentials();
  delay = noRetryDelay();
  ui.quiet = true;
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

// MARK: A fake App Store Connect

interface FakeSubscription {
  id: string;
  productId: string;
  name?: string;
  period?: string;
  level?: number;
  familySharable?: boolean;
  localizations?: { id: string; locale: string; name: string; description?: string }[];
  /** Prices by territory: [price id, point id, amount, startDate]. */
  prices?: [string, string, string, string, string | null][];
  availability?: { id: string; territories: string[]; newTerritories: boolean };
}

interface FakeGroup {
  id: string;
  name: string;
  localizations?: { id: string; locale: string; name: string; customAppName?: string }[];
  subscriptions: FakeSubscription[];
}

/** Price points: amount → id per territory, and each USA point's equivalents. */
const POINTS: Record<string, Record<string, string>> = {
  USA: { "4.99": "us-499", "9.99": "us-999" },
  GBR: { "4.99": "gb-499", "9.99": "gb-999" },
  CAN: { "6.99": "ca-699", "13.99": "ca-1399" },
};
const EQUAL: Record<string, [string, string, string][]> = {
  "us-499": [["gb-499", "GBR", "4.99"], ["ca-699", "CAN", "6.99"]],
  "us-999": [["gb-999", "GBR", "9.99"], ["ca-1399", "CAN", "13.99"]],
};

/** `fail` makes POSTs of these price points answer 409, as a push that breaks partway would see. */
function asc(groups: FakeGroup[], options: { fail?: string[] } = {}) {
  const subscriptions = groups.flatMap((g) => g.subscriptions);
  return (call: AscCall) => {
    const { method, path } = call;
    // Apple answers what's asked: without the plan filter or the include, these come back wrong, so the fake answers nothing.
    if (method === "GET" && /\/(pricePoints|equalizations)$/.test(path) && call.query["filter[planType]"] !== "UPFRONT") return undefined;
    if (method === "GET" && /^\/v1\/subscriptions\/[^/]+\/prices$/.test(path) && !call.query.include?.split(",").includes("territory")) return undefined;
    if (method === "POST" && path === "/v1/subscriptionPrices" && options.fail?.includes((call.body as any).data.relationships.subscriptionPricePoint.data.id)) {
      return { status: 409, json: { errors: [{ status: "409", code: "STATE_ERROR", title: "Not now" }] } };
    }
    if (method === "GET" && path === `/v1/apps/${APP}/subscriptionGroups`) return { json: jsonApi(groups.map((g) => resource("subscriptionGroups", g.id, { referenceName: g.name }))) };
    if (method === "GET" && path === "/v1/territories") return { json: jsonApi(TERRITORIES.map((id) => resource("territories", id, {}))) };
    const group = groups.find((g) => path.startsWith(`/v1/subscriptionGroups/${g.id}/`));
    if (method === "GET" && group && path.endsWith("/subscriptionGroupLocalizations")) {
      return { json: jsonApi((group.localizations ?? []).map((l) => resource("subscriptionGroupLocalizations", l.id, { locale: l.locale, name: l.name, customAppName: l.customAppName ?? null }))) };
    }
    if (method === "GET" && group && path.endsWith("/subscriptions")) {
      return {
        json: jsonApi(group.subscriptions.map((s) => resource("subscriptions", s.id, { productId: s.productId, name: s.name ?? s.productId, subscriptionPeriod: s.period ?? "ONE_MONTH", groupLevel: s.level ?? 1, familySharable: s.familySharable ?? false, reviewNote: null, state: "APPROVED" }))),
      };
    }
    const sub = subscriptions.find((s) => path.startsWith(`/v1/subscriptions/${s.id}/`));
    if (method === "GET" && sub && path.endsWith("/subscriptionLocalizations")) {
      return { json: jsonApi((sub.localizations ?? []).map((l) => resource("subscriptionLocalizations", l.id, { locale: l.locale, name: l.name, description: l.description ?? null }))) };
    }
    if (method === "GET" && sub && path.endsWith("/prices")) {
      const prices = sub.prices ?? [];
      return {
        json: jsonApi(
          prices.map(([id, territory, point, , start]) =>
            resource("subscriptionPrices", id, { startDate: start, planType: "UPFRONT" }, { territory: { data: { type: "territories", id: territory } }, subscriptionPricePoint: { data: { type: "subscriptionPricePoints", id: point } } }),
          ),
          { included: prices.map(([, , point, amount]) => resource("subscriptionPricePoints", point, { customerPrice: amount })) },
        ),
      };
    }
    const pointsFor = path.match(/^\/v1\/subscriptions\/([^/]+)\/pricePoints$/);
    if (method === "GET" && pointsFor) {
      const territory = call.query["filter[territory]"]!;
      return { json: jsonApi(Object.entries(POINTS[territory] ?? {}).map(([amount, id]) => resource("subscriptionPricePoints", id, { customerPrice: amount }))) };
    }
    const equal = path.match(/^\/v1\/subscriptionPricePoints\/([^/]+)\/equalizations$/);
    if (method === "GET" && equal && call.query["filter[subscription]"]) {
      return { json: jsonApi((EQUAL[equal[1]!] ?? []).map(([id, territory, amount]) => resource("subscriptionPricePoints", id, { customerPrice: amount }, { territory: { data: { type: "territories", id: territory } } }))) };
    }
    const plans = path.match(/^\/v1\/subscriptions\/([^/]+)\/planAvailabilities$/);
    if (method === "GET" && plans) {
      const a = subscriptions.find((s) => s.id === plans[1])?.availability;
      return { json: jsonApi(a ? [resource("subscriptionPlanAvailabilities", a.id, { planType: "UPFRONT", availableInNewTerritories: a.newTerritories })] : []) };
    }
    const planTerritories = path.match(/^\/v1\/subscriptionPlanAvailabilities\/([^/]+)\/availableTerritories$/);
    if (method === "GET" && planTerritories) {
      const a = subscriptions.find((s) => s.availability?.id === planTerritories[1])!.availability!;
      return { json: jsonApi(a.territories.map((id) => resource("territories", id, {}))) };
    }
    if (method === "POST" && path === "/v1/subscriptionGroups") return { status: 201, json: jsonApi(resource("subscriptionGroups", "g-new", (call.body as any).data.attributes)) };
    if (method === "POST" && path === "/v1/subscriptions") return { status: 201, json: jsonApi(resource("subscriptions", "s-new", (call.body as any).data.attributes)) };
    if (method === "DELETE") return { status: 204 };
    if (method === "POST" || method === "PATCH") return { status: method === "POST" ? 201 : 200, json: jsonApi(resource("x", "x", {})) };
    return undefined;
  };
}

const monthly: FakeSubscription = {
  id: "s1",
  productId: "com.example.monthly",
  name: "Monthly",
  period: "ONE_MONTH",
  level: 2,
  localizations: [{ id: "l1", locale: "en-US", name: "Monthly", description: "Every month." }],
  prices: [
    ["p-us", "USA", "us-499", "4.99", null],
    ["p-gb", "GBR", "gb-499", "4.99", null],
    ["p-ca", "CAN", "ca-699", "6.99", null],
  ],
  availability: { id: "av1", territories: TERRITORIES, newTerritories: true },
};
const pro: FakeGroup = { id: "g1", name: "Lift Pro", localizations: [{ id: "gl1", locale: "en-US", name: "Lift Pro", customAppName: "Lift" }], subscriptions: [monthly] };

// MARK: Tests

describe("subscription files", () => {
  test("a folder with subscription.json is a subscription, whatever it's called; any other is a language", async () => {
    const root = temp();
    write(root, "Lift Pro/en-US/name.txt", "Lift Pro");
    write(root, "Lift Pro/pro/subscription.json", JSON.stringify({ period: "ONE_YEAR", referenceName: "Yearly", extra: true }));
    write(root, "Lift Pro/pro/en-US/name.txt", "Yearly");
    const [group] = await readSubscriptions(join(root, "appstore", "subscriptions"));
    expect(group!.locales).toEqual({ "en-US": { name: "Lift Pro" } });
    expect(group!.subscriptions).toEqual([{ productId: "pro", file: { period: "ONE_YEAR", referenceName: "Yearly" }, unknownKeys: ["extra"], notes: undefined, locales: { "en-US": { name: "Yearly" } } }]);
  });

  test("validate catches what Apple would refuse, offline", () => {
    const group = (name: string, productId: string, file: Record<string, unknown>, locales = {}): LocalGroup => ({ referenceName: name, locales: {}, subscriptions: [{ productId, file: file as never, unknownKeys: [], locales }] });
    const problems = validateSubscriptions([
      group("Pro", "com.example.monthly", { period: "MONTHLY", level: 0, price: { territory: "USA", amount: "4.99", existingSubscribers: "drop" } }, { "en-US": { name: "x".repeat(36) } }),
      group("Other", "com.example.monthly", {}),
    ]);
    expect(problems.map((p) => p.message)).toEqual([
      "period is one of ONE_WEEK, ONE_MONTH, TWO_MONTHS, THREE_MONTHS, SIX_MONTHS, ONE_YEAR, not \"MONTHLY\"",
      "level is a whole number from 1 (the highest)",
      'price.existingSubscribers is "keep" (they go on paying what they pay) or "update"',
      "The display name is 36 characters; the most is 35",
      "com.example.monthly is also in subscriptions/Pro; a product id is in one group",
    ]);
    expect(validateSubscriptions([group("Pro", "com.example.monthly", { period: "ONE_MONTH", level: 1, price: { territory: "USA", amount: "4.99" }, availability: { territories: "all" } })])).toEqual([]);
  });
});

describe("planning a push", () => {
  const remote: RemoteGroup[] = [
    {
      group: { id: "g1", referenceName: "Lift Pro" },
      localizations: [],
      subscriptions: [
        {
          subscription: { id: "s1", productId: "com.example.monthly", referenceName: "Monthly", period: "ONE_MONTH", level: 2, familySharable: true, reviewNote: null, state: "APPROVED" },
          localizations: [],
          prices: { current: [{ id: "p-us", territory: "USA", pointId: "us-499", amount: "4.99", startDate: null }], scheduled: [] },
          availability: null,
        },
      ],
    },
  ];

  test("names the files' fields, and sends Apple's", () => {
    const plan = planSubscriptions([{ referenceName: "Lift Pro", locales: {}, subscriptions: [{ productId: "com.example.monthly", file: { level: 1, referenceName: "Monthly plan" }, unknownKeys: [], locales: {} }] }], remote, TERRITORIES);
    expect(plan.changes.map((c) => c.field)).toEqual(["referenceName", "level"]);
    expect(plan.groups[0]!.subscriptions[0]!.update).toEqual({ name: "Monthly plan", groupLevel: 1 });
  });

  test("a subscription can't move groups, and Family Sharing can't go off", async () => {
    const moved = await rejected(() => planSubscriptions([{ referenceName: "Other", locales: {}, subscriptions: [{ productId: "com.example.monthly", file: {}, unknownKeys: [], locales: {} }] }], remote, TERRITORIES));
    expect(moved).toMatchObject({ code: "subscription-group-fixed", exitCode: 5, details: { group: "Lift Pro" } });
    const off = await rejected(() => planSubscriptions([{ referenceName: "Lift Pro", locales: {}, subscriptions: [{ productId: "com.example.monthly", file: { familySharing: false }, unknownKeys: [], locales: {} }] }], remote, TERRITORIES));
    expect(off.code).toBe("family-sharing-fixed");
  });

  test("a new subscription needs a period and a reference name", async () => {
    const files: LocalGroup[] = [{ referenceName: "New", locales: {}, subscriptions: [{ productId: "com.example.yearly", file: { referenceName: "Yearly" }, unknownKeys: [], locales: {} }] }];
    expect((await rejected(() => planSubscriptions(files, [], TERRITORIES))).code).toBe("missing-subscription-fields");
  });

  test("bodies for making a subscription and adding a price", () => {
    expect(subscriptionCreateBody("g1", { productId: "com.example.yearly", referenceName: "Yearly", period: "ONE_YEAR", level: 1, familySharable: true }).data).toEqual({
      type: "subscriptions",
      attributes: { name: "Yearly", productId: "com.example.yearly", subscriptionPeriod: "ONE_YEAR", groupLevel: 1, familySharable: true },
      relationships: { group: { data: { type: "subscriptionGroups", id: "g1" } } },
    });
    expect(priceCreateBody("s1", "GBR", "gb-499", true).data).toEqual({
      type: "subscriptionPrices",
      attributes: { preserveCurrentPrice: true, planType: "UPFRONT" },
      relationships: {
        subscription: { data: { type: "subscriptions", id: "s1" } },
        territory: { data: { type: "territories", id: "GBR" } },
        subscriptionPricePoint: { data: { type: "subscriptionPricePoints", id: "gb-499" } },
      },
    });
  });
});

describe("ship subscriptions", () => {
  test("pull writes the group and its subscriptions, and a second pull changes nothing", async () => {
    const root = setup();
    mock = mockAsc(asc([pro]));
    const first = await ship(["subscriptions", "pull"]);
    expect(first.written).toEqual([
      "Lift Pro/en-US/name.txt",
      "Lift Pro/en-US/app-name.txt",
      "Lift Pro/com.example.monthly/subscription.json",
      "Lift Pro/com.example.monthly/review-notes.txt",
      "Lift Pro/com.example.monthly/en-US/name.txt",
      "Lift Pro/com.example.monthly/en-US/description.txt",
    ]);
    expect(JSON.parse(readFileSync(join(root, "appstore", "subscriptions", "Lift Pro", "com.example.monthly", "subscription.json"), "utf8"))).toEqual({
      period: "ONE_MONTH",
      level: 2,
      referenceName: "Monthly",
      familySharing: false,
      price: { territory: "USA", amount: "4.99" },
      availability: { territories: "all", newTerritories: true },
    });
    expect((await ship(["subscriptions", "pull"])).written).toEqual([]);
    expect((await ship(["subscriptions", "diff"])).hasChanges).toBe(false);
    expect(writes(mock.calls)).toEqual([]);
    expect(await rejected(() => ship(["subscriptions", "pull", "--product", "com.example.nope"]))).toMatchObject({ code: "no-subscription", exitCode: 4 });
  });

  test("push makes a group and a subscription, then its price everywhere and where it's sold", async () => {
    const root = setup();
    write(root, "Lift Plus/en-US/name.txt", "Lift Plus");
    write(root, "Lift Plus/com.example.plus/subscription.json", JSON.stringify({ period: "ONE_MONTH", referenceName: "Plus", level: 1, price: { territory: "USA", amount: "9.99" }, availability: { territories: ["USA", "GBR"], newTerritories: false } }));
    write(root, "Lift Plus/com.example.plus/en-US/name.txt", "Plus");
    mock = mockAsc(asc([]));
    expect((await ship(["subscriptions", "push", "--dry-run"])).created).toEqual(["com.example.plus"]);
    expect(writes(mock.calls)).toEqual([]);

    expect(await ship(["subscriptions", "push"])).toMatchObject({ applied: true, created: ["com.example.plus"] });
    expect(writes(mock.calls)).toEqual([
      "POST /v1/subscriptionGroups",
      "POST /v1/subscriptionGroupLocalizations",
      "POST /v1/subscriptions",
      "POST /v1/subscriptionLocalizations",
      "POST /v1/subscriptionPrices",
      "POST /v1/subscriptionPrices",
      "POST /v1/subscriptionPrices",
      "POST /v1/subscriptionPlanAvailabilities",
    ]);
    const prices = mock.calls.filter((c) => c.path === "/v1/subscriptionPrices").map((c) => (c.body as any).data);
    // Apple's equivalents first, the file's own territory last.
    expect(prices.map((p) => `${p.relationships.territory.data.id} ${p.relationships.subscriptionPricePoint.data.id} ${p.attributes.preserveCurrentPrice}`)).toEqual(["GBR gb-999 true", "CAN ca-1399 true", "USA us-999 true"]);
    const availability = mock.calls.find((c) => c.path === "/v1/subscriptionPlanAvailabilities")!.body as any;
    expect(availability.data.attributes).toEqual({ availableInNewTerritories: false, planType: "UPFRONT" });
    expect(availability.data.relationships.availableTerritories.data.map((t: { id: string }) => t.id)).toEqual(["GBR", "USA"]);
  });

  test("a new price for current subscribers too, and where it's sold changed in place", async () => {
    const root = setup();
    write(root, "Lift Pro/com.example.monthly/subscription.json", JSON.stringify({ price: { territory: "USA", amount: "9.99", existingSubscribers: "update" }, availability: { territories: ["USA"] } }));
    mock = mockAsc(asc([pro]));
    await ship(["subscriptions", "push"]);
    const prices = mock.calls.filter((c) => c.path === "/v1/subscriptionPrices").map((c) => (c.body as any).data.attributes.preserveCurrentPrice);
    expect(prices).toEqual([false, false, false]);
    expect(writes(mock.calls).at(-1)).toBe("PATCH /v1/subscriptionPlanAvailabilities/av1");
  });

  test("a price set by hand elsewhere, or one scheduled, stops a new price unless --prune", async () => {
    const root = setup();
    write(root, "Lift Pro/com.example.monthly/subscription.json", JSON.stringify({ price: { territory: "USA", amount: "9.99" } }));
    const handSet: FakeGroup = {
      ...pro,
      subscriptions: [{ ...monthly, prices: [["p-us", "USA", "us-499", "4.99", null], ["p-gb", "GBR", "gb-999", "9.99", null], ["p-ca", "CAN", "ca-699", "6.99", null], ["p-next", "USA", "us-999", "9.99", "2099-01-01"]] }],
    };
    mock = mockAsc(asc([handSet]));
    const error = await rejected(() => ship(["subscriptions", "push"]));
    expect(error).toMatchObject({ code: "manual-prices", exitCode: 5 });
    expect(error.message).toContain("9.99 in GBR; 9.99 in USA from 2099-01-01");
    expect(writes(mock.calls)).toEqual([]);
    await ship(["subscriptions", "push", "--prune"]);
    // The scheduled price goes first, then the new price everywhere (--prune also drops the languages with no folder).
    expect(writes(mock.calls).filter((w) => w.includes("subscriptionPrices"))).toEqual([
      "DELETE /v1/subscriptionPrices/p-next",
      "POST /v1/subscriptionPrices",
      "POST /v1/subscriptionPrices",
      "POST /v1/subscriptionPrices",
    ]);
  });

  test("a price change that breaks partway leaves the file's territory alone, so the next diff still shows it", async () => {
    const root = setup();
    write(root, "Lift Pro/com.example.monthly/subscription.json", JSON.stringify({ price: { territory: "USA", amount: "9.99" } }));
    mock = mockAsc(asc([pro], { fail: ["ca-1399"] }));
    expect((await rejected(() => ship(["subscriptions", "push"]))).code).toBe("api-409");
    const posted = mock.calls.filter((c) => c.path === "/v1/subscriptionPrices").map((c) => (c.body as any).data.relationships.territory.data.id);
    expect(posted).not.toContain("USA");
  });

  test("--product leaves the group's languages alone, even with --prune", async () => {
    const root = setup();
    write(root, "Lift Pro/com.example.monthly/subscription.json", JSON.stringify({ level: 1 }));
    mock = mockAsc(asc([pro]));
    // The subscription's own languages are in play; the group's aren't.
    const diff = await ship(["subscriptions", "diff", "--product", "com.example.monthly", "--prune"]);
    expect(diff.changes.map((c: { scope: string; field: string }) => `${c.scope} ${c.field}`)).toEqual([
      "subscriptions/Lift Pro/com.example.monthly level",
      "subscriptions/Lift Pro/com.example.monthly/en-US localization",
    ]);
    expect(diff.onlyRemoteLocales).toEqual([]);
    await ship(["subscriptions", "push", "--product", "com.example.monthly"]);
    expect(writes(mock.calls)).toEqual(["PATCH /v1/subscriptions/s1"]);
    // Without --product, the group's missing language folder is listed, and --prune would delete it.
    expect((await ship(["subscriptions", "diff"])).onlyRemoteLocales).toContain("Lift Pro/en-US");
    expect((await rejected(() => ship(["subscriptions", "diff", "--product", "com.example.nope"]))).code).toBe("usage");
  });

  test("a group's language: its changes are sent as Apple's fields", async () => {
    const root = setup();
    write(root, "Lift Pro/en-US/name.txt", "Lift Pro+");
    write(root, "Lift Pro/en-US/app-name.txt", "Lift");
    mock = mockAsc(asc([{ ...pro, subscriptions: [] }]));
    await ship(["subscriptions", "push"]);
    expect(mock.calls.find((c) => c.method === "PATCH")).toMatchObject({ path: "/v1/subscriptionGroupLocalizations/gl1", body: { data: { type: "subscriptionGroupLocalizations", id: "gl1", attributes: { name: "Lift Pro+" } } } });
  });

  test("a new subscription whose price Apple doesn't have stops right after it's made", async () => {
    const root = setup();
    write(root, "Lift Pro/com.example.yearly/subscription.json", JSON.stringify({ period: "ONE_YEAR", referenceName: "Yearly", price: { territory: "USA", amount: "5.00" } }));
    write(root, "Lift Pro/com.example.yearly/en-US/name.txt", "Yearly");
    mock = mockAsc(asc([{ ...pro, subscriptions: [] }]));
    const error = await rejected(() => ship(["subscriptions", "push"]));
    expect(error).toMatchObject({ code: "no-price-point", details: { created: ["com.example.yearly"] } });
    expect(error.hint).toContain("was made, without its languages, price, or where it's sold");
    expect(writes(mock.calls)).toEqual(["POST /v1/subscriptions"]);
  });

  test("validate runs offline and writes a JUnit report; pull refuses a group name that can't be a folder", async () => {
    const root = setup();
    write(root, "Lift Pro/com.example.monthly/subscription.json", JSON.stringify({ period: "WEEKLY" }));
    const report = join(temp(), "junit.xml");
    expect((await ship(["subscriptions", "validate", "--junit", report])).valid).toBe(false);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(readFileSync(report, "utf8")).toContain('name="subscriptions/Lift Pro/com.example.monthly/subscription.json (period)"');
    mock = mockAsc(asc([{ ...pro, name: "Pro/Plus" }]));
    expect(await rejected(() => ship(["subscriptions", "pull"]))).toMatchObject({ code: "bad-group-name" });
  });

  test("a price Apple doesn't have stops before anything changes; read-only stops a push", async () => {
    const root = setup();
    write(root, "Lift Pro/com.example.monthly/subscription.json", JSON.stringify({ price: { territory: "USA", amount: "5.00" } }));
    mock = mockAsc(asc([pro]));
    expect(await rejected(() => ship(["subscriptions", "push"]))).toMatchObject({ code: "no-price-point", details: { nearest: ["4.99", "9.99"] } });
    expect(writes(mock.calls)).toEqual([]);
    write(root, "Lift Pro/com.example.monthly/subscription.json", JSON.stringify({ level: 1 }));
    policy.readOnly = true;
    expect(await rejected(() => ship(["subscriptions", "push"]))).toMatchObject({ code: "read-only", exitCode: 6 });
  });
});
