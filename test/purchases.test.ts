// In-app purchases: the files in appstore/purchases/, what push would change, and the requests it sends.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { availabilityBody, priceScheduleBody, purchaseCreateBody, purchasePrice } from "../src/asc/purchases";
import { policy } from "../src/asc/client";
import { type Context, findCommand, parseFlags } from "../src/command";
import { commands } from "../src/commands";
import { appsPath } from "../src/config";
import { useCredentials } from "../src/credentials";
import { availabilityJSON } from "../src/store/catalog";
import { type LocalPurchase, type RemotePurchase, planPurchases, readPurchases, validatePurchases } from "../src/store/purchases";
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

/** Writes a purchase folder: purchase.json, notes, and languages. */
function purchaseFolder(root: string, productId: string, json: unknown, locales: Record<string, Record<string, string>> = {}, notes?: string) {
  const dir = join(root, "appstore", "purchases", productId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "purchase.json"), JSON.stringify(json));
  if (notes !== undefined) writeFileSync(join(dir, "review-notes.txt"), notes);
  for (const [locale, files] of Object.entries(locales)) {
    mkdirSync(join(dir, locale), { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, locale, file), text);
  }
  return dir;
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

interface FakePurchase {
  id: string;
  productId: string;
  type?: string;
  name?: string;
  familySharable?: boolean;
  reviewNote?: string | null;
  localizations?: { id: string; locale: string; name: string; description?: string }[];
  price?: { territory: string; pointId: string; amount: string; others?: { territory: string; amount: string; startDate?: string; endDate?: string }[] };
  availability?: { id: string; territories: string[]; newTerritories: boolean };
}

/** Answers for an app with `purchases`; prices come from `points` (territory → amounts). */
function asc(purchases: FakePurchase[], points: Record<string, string[]> = { USA: ["0.99", "1.99", "4.99", "9.99"] }) {
  return (call: AscCall) => {
    const { method, path } = call;
    if (method === "GET" && path === `/v1/apps/${APP}/inAppPurchasesV2`) {
      return {
        json: jsonApi(
          purchases.map((p) =>
            resource("inAppPurchases", p.id, { productId: p.productId, inAppPurchaseType: p.type ?? "NON_CONSUMABLE", name: p.name ?? p.productId, familySharable: p.familySharable ?? false, reviewNote: p.reviewNote ?? null, state: "READY_TO_SUBMIT" }),
          ),
        ),
      };
    }
    if (method === "GET" && path === "/v1/territories") return { json: jsonApi(TERRITORIES.map((id) => resource("territories", id, { currency: "USD" }))) };
    const sub = path.match(/^\/v2\/inAppPurchases\/([^/]+)\/(\w+)$/);
    const purchase = sub && purchases.find((p) => p.id === sub[1]);
    if (method === "GET" && sub && sub[2] === "pricePoints") {
      const territory = call.query["filter[territory]"]!;
      return { json: jsonApi((points[territory] ?? []).map((amount, i) => resource("inAppPurchasePricePoints", `pp-${territory}-${i}`, { customerPrice: amount }))) };
    }
    if (method === "GET" && purchase && sub![2] === "inAppPurchaseLocalizations") {
      return { json: jsonApi((purchase.localizations ?? []).map((l) => resource("inAppPurchaseLocalizations", l.id, { locale: l.locale, name: l.name, description: l.description ?? null }))) };
    }
    if (method === "GET" && purchase && sub![2] === "iapPriceSchedule") {
      if (!purchase.price) return { status: 404, json: { errors: [{ status: "404", code: "NOT_FOUND" }] } };
      return { json: jsonApi(resource("inAppPurchasePriceSchedules", `sched-${purchase.id}`, {}, { baseTerritory: { data: { type: "territories", id: purchase.price.territory } } })) };
    }
    const manual = path.match(/^\/v1\/inAppPurchasePriceSchedules\/sched-([^/]+)\/manualPrices$/);
    if (method === "GET" && manual) {
      const p = purchases.find((x) => x.id === manual[1])!.price!;
      return {
        json: jsonApi(
          [
            resource("inAppPurchasePrices", "old", { startDate: null, endDate: "2020-01-01" }, { territory: { data: { type: "territories", id: p.territory } }, inAppPurchasePricePoint: { data: { type: "inAppPurchasePricePoints", id: "pp-old" } } }),
            resource("inAppPurchasePrices", "now", { startDate: "2020-01-01", endDate: null }, { territory: { data: { type: "territories", id: p.territory } }, inAppPurchasePricePoint: { data: { type: "inAppPurchasePricePoints", id: p.pointId } } }),
            ...(p.others ?? []).map((o, i) =>
              resource("inAppPurchasePrices", `other${i}`, { startDate: o.startDate ?? null, endDate: o.endDate ?? null }, { territory: { data: { type: "territories", id: o.territory } }, inAppPurchasePricePoint: { data: { type: "inAppPurchasePricePoints", id: `pp-other${i}` } } }),
            ),
          ],
          {
            included: [
              resource("inAppPurchasePricePoints", "pp-old", { customerPrice: "0.49" }),
              resource("inAppPurchasePricePoints", p.pointId, { customerPrice: p.amount }),
              ...(p.others ?? []).map((o, i) => resource("inAppPurchasePricePoints", `pp-other${i}`, { customerPrice: o.amount })),
            ],
          },
        ),
      };
    }
    if (method === "GET" && purchase && sub![2] === "inAppPurchaseAvailability") {
      if (!purchase.availability) return { status: 404, json: { errors: [{ status: "404", code: "NOT_FOUND" }] } };
      return { json: jsonApi(resource("inAppPurchaseAvailabilities", purchase.availability.id, { availableInNewTerritories: purchase.availability.newTerritories })) };
    }
    const territories = path.match(/^\/v1\/inAppPurchaseAvailabilities\/([^/]+)\/availableTerritories$/);
    if (method === "GET" && territories) {
      const a = purchases.find((p) => p.availability?.id === territories[1])!.availability!;
      return { json: jsonApi(a.territories.map((id) => resource("territories", id, {}))) };
    }
    if (method === "POST" && path === "/v2/inAppPurchases") {
      const attributes = (call.body as any).data.attributes;
      return { status: 201, json: jsonApi(resource("inAppPurchases", "new1", { ...attributes, state: "MISSING_METADATA" })) };
    }
    if (method === "PATCH" || method === "DELETE") return { status: method === "DELETE" ? 204 : 200, json: method === "DELETE" ? undefined : jsonApi(resource("x", "x", {})) };
    if (method === "POST") return { status: 201, json: jsonApi(resource("x", "created", {})) };
    return undefined;
  };
}

const remote = (overrides: Partial<RemotePurchase> & { productId?: string } = {}): RemotePurchase => ({
  purchase: { id: "p1", productId: overrides.productId ?? "com.example.pro", type: "NON_CONSUMABLE", referenceName: "Pro", reviewNote: null, familySharable: false, state: "APPROVED" },
  localizations: [],
  price: null,
  otherPrices: [],
  availability: null,
  ...overrides,
});

const local = (file: LocalPurchase["file"], extra: Partial<LocalPurchase> = {}): LocalPurchase => ({ productId: "com.example.pro", file, unknownKeys: [], locales: {}, ...extra });

// MARK: Tests

describe("purchase files", () => {
  test("validate catches what Apple would refuse, offline", () => {
    const problems = validatePurchases([
      local({ type: "AUTO_RENEWABLE" as never, referenceName: "x".repeat(65), familySharing: "yes" as never, price: { territory: "us", amount: "0.9999" }, availability: { territories: ["us"] } }, {
        productId: "bad id",
        unknownKeys: ["tier"],
        locales: { "en-US": { name: "x".repeat(36), description: "y".repeat(56) }, xx: { name: "" } },
      }),
    ]);
    const messages = problems.map((p) => `${p.severity} ${p.field ?? p.file}: ${p.message}`);
    expect(messages.filter((m) => m.startsWith("error"))).toHaveLength(10);
    expect(messages.join("\n")).toContain("isn't a product id");
    expect(messages.join("\n")).toContain("auto-renewing subscriptions aren't in-app purchases");
    expect(messages.join("\n")).toContain("The display name is 36 characters; the most is 35");
    expect(messages.join("\n")).toContain("The description is 56 characters; the most is 55");
    expect(messages.filter((m) => m.startsWith("warning"))).toEqual([
      "warning tier: tier isn't an in-app purchase field; ship ignores it",
      "warning purchases/bad id/xx: xx isn't a language App Store Connect lists; check the folder's name",
    ]);
    expect(validatePurchases([local({ type: "CONSUMABLE", referenceName: "Coins", price: { territory: "USA", amount: "0.99" }, availability: { territories: "all" } })])).toEqual([]);
    // Sold nowhere is what App Store Connect has for a purchase off sale, and a three-decimal currency's amount is fine.
    expect(validatePurchases([local({ price: { territory: "KWT", amount: "0.290" }, availability: { territories: [] } })])).toEqual([]);
    const more = validatePurchases([local({ type: "CONSUMABLE", familySharing: true, availability: { territories: ["USA", "USA"] } })]).map((p) => p.message);
    expect(more).toEqual(["Family Sharing is only for non-consumable purchases (and subscriptions), not CONSUMABLE", "availability.territories lists a territory twice"]);
  });

  test("reads the folders", async () => {
    const root = temp();
    purchaseFolder(root, "com.example.pro", { type: "NON_CONSUMABLE", referenceName: "Pro", extra: 1 }, { "en-US": { "name.txt": "Pro\n", "description.txt": "Everything." } }, "Tap Upgrade.");
    const [purchase] = await readPurchases(join(root, "appstore", "purchases"));
    expect(purchase).toEqual({
      productId: "com.example.pro",
      file: { type: "NON_CONSUMABLE", referenceName: "Pro" },
      unknownKeys: ["extra"],
      notes: "Tap Upgrade.",
      locales: { "en-US": { name: "Pro", description: "Everything." } },
    });
  });

  test("availability of every territory reads as all", () => {
    expect(availabilityJSON({ territories: TERRITORIES, newTerritories: true }, TERRITORIES)).toEqual({ territories: "all", newTerritories: true });
    expect(availabilityJSON({ territories: ["USA"], newTerritories: false }, TERRITORIES)).toEqual({ territories: ["USA"], newTerritories: false });
  });
});

describe("planning a push", () => {
  test("a new purchase needs a type and a reference name", async () => {
    expect(await rejected(() => planPurchases([local({ referenceName: "Pro" })], [], TERRITORIES))).toMatchObject({ code: "missing-purchase-fields" });
    const plan = planPurchases([local({ type: "NON_CONSUMABLE", referenceName: "Pro", price: { territory: "USA", amount: "4.99" } }, { locales: { "en-US": { name: "Pro" } } })], [], TERRITORIES);
    expect(plan.purchases[0]).toMatchObject({ create: { type: "NON_CONSUMABLE", referenceName: "Pro" }, price: { territory: "USA", amount: "4.99" }, localizations: { create: [{ locale: "en-US", name: "Pro" }] } });
    expect(plan.changes.map((c) => `${c.kind} ${c.scope} ${c.field}`)).toEqual(["add purchases/com.example.pro purchase", "add purchases/com.example.pro/en-US name", "add purchases/com.example.pro price"]);
    const shared = planPurchases([local({ type: "NON_CONSUMABLE", referenceName: "Pro", familySharing: true }, { notes: "Tap Upgrade." })], [], TERRITORIES);
    expect(shared.changes.map((c) => c.field)).toEqual(["purchase", "familySharing", "reviewNotes"]);
  });

  test("a new price would replace prices set by hand, so it needs --prune", async () => {
    const existing = remote({ price: { territory: "USA", amount: "4.99" }, otherPrices: [{ territory: "GBR", amount: "3.99", startDate: null, endDate: null }, { territory: "USA", amount: "5.99", startDate: "2027-01-01", endDate: null }] });
    const files = local({ price: { territory: "USA", amount: "9.99" } });
    const error = await rejected(() => planPurchases([files], [existing], TERRITORIES));
    expect(error).toMatchObject({ code: "manual-prices", exitCode: 5 });
    expect(error.message).toContain("3.99 in GBR; 5.99 in USA from 2027-01-01");
    const pruned = planPurchases([files], [existing], TERRITORIES, { prune: true });
    expect(pruned.changes.filter((c) => c.field === "price").map((c) => c.kind)).toEqual(["change", "remove", "remove"]);
    // Without a new price, they're left alone.
    expect(planPurchases([local({ price: { territory: "USA", amount: "4.99" } })], [existing], TERRITORIES).changes).toEqual([]);
  });

  test("a type can't change, and Family Sharing can't go off", async () => {
    expect(await rejected(() => planPurchases([local({ type: "CONSUMABLE" })], [remote()], TERRITORIES))).toMatchObject({ code: "purchase-type-fixed", exitCode: 5, details: { type: "NON_CONSUMABLE" } });
    const sharing = remote();
    sharing.purchase.familySharable = true;
    expect(await rejected(() => planPurchases([local({ familySharing: false })], [sharing], TERRITORIES))).toMatchObject({ code: "family-sharing-fixed" });
  });

  test("changes only what differs, and the same price written differently is the same", () => {
    const existing = remote({
      localizations: [
        { id: "l1", locale: "en-US", name: "Pro", description: "Old" },
        { id: "l2", locale: "fr-FR", name: "Pro", description: null },
      ],
      price: { territory: "USA", amount: "4.99" },
      availability: { territories: TERRITORIES, newTerritories: true },
    });
    const files = local({ referenceName: "Pro", price: { territory: "USA", amount: "4.990" }, availability: { territories: "all", newTerritories: true } }, { locales: { "en-US": { name: "Pro", description: "Everything." } }, notes: "Tap Upgrade." });
    const plan = planPurchases([files], [existing], TERRITORIES);
    expect(plan.purchases).toEqual([
      { productId: "com.example.pro", id: "p1", update: { reviewNote: "Tap Upgrade." }, localizations: { create: [], update: [{ locale: "en-US", id: "l1", attributes: { description: "Everything." } }], delete: [] } },
    ]);
    expect(plan.onlyRemoteLocales).toEqual(["com.example.pro/fr-FR"]);
    // Changes name the files' fields; the update has Apple's.
    expect(plan.changes.find((c) => c.scope === "purchases/com.example.pro")).toEqual({ scope: "purchases/com.example.pro", field: "reviewNotes", kind: "add", to: "Tap Upgrade." });
    expect(planPurchases([files], [existing], TERRITORIES, { prune: true }).purchases[0]!.localizations.delete).toEqual([{ locale: "fr-FR", id: "l2" }]);
    // A new price and fewer territories.
    const moved = planPurchases([local({ price: { territory: "USA", amount: "9.99" }, availability: { territories: ["USA", "CAN"] } })], [existing], TERRITORIES);
    expect(moved.purchases[0]).toMatchObject({ price: { territory: "USA", amount: "9.99" }, availability: { territories: ["CAN", "USA"], newTerritories: true } });
    expect(moved.changes.find((c) => c.field === "price")).toEqual({ scope: "purchases/com.example.pro", field: "price", kind: "change", from: "4.99 in USA", to: "9.99 in USA" });
  });
});

describe("the requests", () => {
  test("bodies for making a purchase, its price, and where it's sold", () => {
    expect(purchaseCreateBody(APP, { productId: "com.example.pro", type: "NON_CONSUMABLE", referenceName: "Pro", familySharable: true })).toEqual({
      data: {
        type: "inAppPurchases",
        attributes: { name: "Pro", productId: "com.example.pro", inAppPurchaseType: "NON_CONSUMABLE", familySharable: true },
        relationships: { app: { data: { type: "apps", id: APP } } },
      },
    });
    const schedule = priceScheduleBody("p1", "USA", "pp-1");
    expect(schedule.data.relationships).toEqual({
      inAppPurchase: { data: { type: "inAppPurchases", id: "p1" } },
      baseTerritory: { data: { type: "territories", id: "USA" } },
      manualPrices: { data: [{ type: "inAppPurchasePrices", id: "${price}" }] },
    });
    expect(schedule.included[0]!.relationships.inAppPurchasePricePoint).toEqual({ data: { type: "inAppPurchasePricePoints", id: "pp-1" } });
    expect(availabilityBody("p1", { territories: ["USA"], newTerritories: false }).data).toEqual({
      type: "inAppPurchaseAvailabilities",
      attributes: { availableInNewTerritories: false },
      relationships: { inAppPurchase: { data: { type: "inAppPurchases", id: "p1" } }, availableTerritories: { data: [{ type: "territories", id: "USA" }] } },
    });
  });

  test("the price is today's in the base territory, and none before one is set", async () => {
    mock = mockAsc(asc([{ id: "p1", productId: "a", price: { territory: "USA", pointId: "pp-9", amount: "4.99" } }, { id: "p2", productId: "b" }]));
    expect(await purchasePrice("p1")).toEqual({ price: { territory: "USA", amount: "4.99" }, others: [] });
    expect(await purchasePrice("p2")).toEqual({ price: null, others: [] });
  });
});

describe("ship purchases", () => {
  const pro: FakePurchase = {
    id: "p1",
    productId: "com.example.pro",
    name: "Pro",
    familySharable: true,
    localizations: [{ id: "l1", locale: "en-US", name: "Pro", description: "Everything." }],
    price: { territory: "USA", pointId: "pp-USA-2", amount: "4.99" },
    availability: { id: "av1", territories: TERRITORIES, newTerritories: true },
  };

  test("pull writes the folders, and a second pull changes nothing", async () => {
    const root = setup();
    mock = mockAsc(asc([pro]));
    const first = await ship(["purchases", "pull"]);
    expect(first.written).toEqual(["com.example.pro/purchase.json", "com.example.pro/review-notes.txt", "com.example.pro/en-US/name.txt", "com.example.pro/en-US/description.txt"]);
    expect(JSON.parse(readFileSync(join(root, "appstore", "purchases", "com.example.pro", "purchase.json"), "utf8"))).toEqual({
      type: "NON_CONSUMABLE",
      referenceName: "Pro",
      familySharing: true,
      price: { territory: "USA", amount: "4.99" },
      availability: { territories: "all", newTerritories: true },
    });
    expect((await ship(["purchases", "pull"])).written).toEqual([]);
    expect(writes(mock.calls)).toEqual([]);
    writeFileSync(join(root, "appstore", "purchases", "com.example.pro", "en-US", "name.txt"), "Lift Pro\n");
    expect((await rejected(() => ship(["purchases", "pull"]))).code).toBe("local-changes");
    // After a pull, diff is quiet.
    writeFileSync(join(root, "appstore", "purchases", "com.example.pro", "en-US", "name.txt"), "Pro\n");
    expect((await ship(["purchases", "diff"])).hasChanges).toBe(false);
  });

  test("push makes a new purchase, then its language, price, and availability", async () => {
    const root = setup();
    purchaseFolder(root, "com.example.coins", { type: "CONSUMABLE", referenceName: "100 coins", familySharing: false, price: { territory: "USA", amount: "0.99" }, availability: { territories: ["USA", "CAN"], newTerritories: false } }, { "en-US": { "name.txt": "100 Coins" } }, "Buy them in the shop.");
    mock = mockAsc(asc([]));
    const dry = await ship(["purchases", "push", "--dry-run"]);
    expect(dry).toMatchObject({ dryRun: true, applied: false, created: ["com.example.coins"] });
    expect(writes(mock.calls)).toEqual([]);

    const pushed = await ship(["purchases", "push"]);
    expect(pushed.applied).toBe(true);
    expect(writes(mock.calls)).toEqual(["POST /v2/inAppPurchases", "POST /v1/inAppPurchaseLocalizations", "POST /v1/inAppPurchasePriceSchedules", "POST /v1/inAppPurchaseAvailabilities"]);
    const post = (path: string) => mock!.calls.find((call) => call.method === "POST" && call.path === path)!.body as any;
    expect(post("/v2/inAppPurchases").data.attributes).toEqual({ name: "100 coins", productId: "com.example.coins", inAppPurchaseType: "CONSUMABLE", reviewNote: "Buy them in the shop.", familySharable: false });
    expect(post("/v1/inAppPurchaseAvailabilities").data.attributes).toEqual({ availableInNewTerritories: false });
    expect(post("/v1/inAppPurchaseLocalizations").data).toEqual({
      type: "inAppPurchaseLocalizations",
      attributes: { locale: "en-US", name: "100 Coins" },
      relationships: { inAppPurchaseV2: { data: { type: "inAppPurchases", id: "new1" } } },
    });
    expect(post("/v1/inAppPurchasePriceSchedules").included[0].relationships.inAppPurchasePricePoint.data.id).toBe("pp-USA-0");
    expect(post("/v1/inAppPurchaseAvailabilities").data.relationships.availableTerritories.data.map((t: { id: string }) => t.id)).toEqual(["CAN", "USA"]);
  });

  test("a price Apple doesn't have stops the push before anything changes", async () => {
    const root = setup();
    purchaseFolder(root, "com.example.pro", { price: { territory: "USA", amount: "5.00" } });
    mock = mockAsc(asc([pro]));
    const error = await rejected(() => ship(["purchases", "push"]));
    expect(error).toMatchObject({ code: "no-price-point", exitCode: 4, details: { nearest: ["0.99", "1.99", "4.99", "9.99"] } });
    expect(writes(mock.calls)).toEqual([]);
  });

  test("a new purchase whose price Apple doesn't have stops right after it's made", async () => {
    const root = setup();
    purchaseFolder(root, "com.example.coins", { type: "CONSUMABLE", referenceName: "Coins", price: { territory: "USA", amount: "5.00" } }, { "en-US": { "name.txt": "Coins" } });
    mock = mockAsc(asc([]));
    const error = await rejected(() => ship(["purchases", "push"]));
    expect(error).toMatchObject({ code: "no-price-point", details: { created: ["com.example.coins"] } });
    expect(error.hint).toContain("was made, without its languages, price, or where it's sold");
    expect(writes(mock.calls)).toEqual(["POST /v2/inAppPurchases"]);
  });

  test("an existing purchase: a new price, a changed language, and --prune", async () => {
    const root = setup();
    purchaseFolder(root, "com.example.pro", { price: { territory: "USA", amount: "9.99" } }, { "en-US": { "name.txt": "Pro", "description.txt": "All of it." } });
    mock = mockAsc(asc([{ ...pro, localizations: [...pro.localizations!, { id: "l2", locale: "fr-FR", name: "Pro" }] }]));
    await ship(["purchases", "push", "--prune"]);
    expect(writes(mock.calls)).toEqual(["PATCH /v1/inAppPurchaseLocalizations/l1", "DELETE /v1/inAppPurchaseLocalizations/l2", "POST /v1/inAppPurchasePriceSchedules"]);
    expect(mock.calls.find((c) => c.method === "PATCH")!.body).toEqual({ data: { type: "inAppPurchaseLocalizations", id: "l1", attributes: { description: "All of it." } } });
    const schedule = mock.calls.find((c) => c.path === "/v1/inAppPurchasePriceSchedules")!.body as any;
    expect(schedule.data.relationships.baseTerritory).toEqual({ data: { type: "territories", id: "USA" } });
    expect(schedule.included[0].relationships.inAppPurchasePricePoint.data.id).toBe("pp-USA-3");
  });

  test("pull --product names a purchase App Store Connect doesn't have", async () => {
    setup();
    mock = mockAsc(asc([pro]));
    expect(await rejected(() => ship(["purchases", "pull", "--product", "com.example.typo"]))).toMatchObject({ code: "no-purchase", exitCode: 4, details: { choices: ["com.example.pro"] } });
    expect((await ship(["purchases", "pull", "--product", "com.example.pro"])).written).toHaveLength(4);
  });

  test("purchases only in App Store Connect are listed, never deleted; --product narrows it", async () => {
    const root = setup();
    purchaseFolder(root, "com.example.pro", { referenceName: "Pro Unlock" });
    mock = mockAsc(asc([pro, { id: "p2", productId: "com.example.other" }]));
    const diff = await ship(["purchases", "diff"]);
    expect(diff).toMatchObject({ hasChanges: true, onlyRemote: ["com.example.other"] });
    expect((await ship(["purchases", "diff", "--product", "com.example.pro"])).onlyRemote).toEqual([]);
    await ship(["purchases", "push"]);
    expect(writes(mock.calls)).toEqual(["PATCH /v2/inAppPurchases/p1"]);
    expect(mock.calls.at(-1)!.body).toEqual({ data: { type: "inAppPurchases", id: "p1", attributes: { name: "Pro Unlock" } } });
    expect((await rejected(() => ship(["purchases", "diff", "--product", "com.example.nope"]))).code).toBe("usage");
    expect((await rejected(() => ship(["purchases", "pull", "--prune"]))).code).toBe("usage");
  });

  test("validate runs offline, and read-only mode stops a push", async () => {
    const root = setup();
    purchaseFolder(root, "com.example.pro", { type: "NON_CONSUMABLE", referenceName: "Pro" }, { "en-US": { "name.txt": "x".repeat(40) } });
    const result = await ship(["purchases", "validate"]);
    expect(result.valid).toBe(false);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    writeFileSync(join(root, "appstore", "purchases", "com.example.pro", "en-US", "name.txt"), "Pro");
    mock = mockAsc(asc([]));
    policy.readOnly = true;
    expect(await rejected(() => ship(["purchases", "push"]))).toMatchObject({ code: "read-only", exitCode: 6 });
  });
});
