// In-app purchases as files in the store folder (appstore/purchases/), one
// folder per product id:
//
//   purchases/<product id>/purchase.json      type, reference name, Family Sharing, price, availability
//   purchases/<product id>/review-notes.txt   notes for App Review
//   purchases/<product id>/<locale>/name.txt  description.txt
//
// As everywhere in the store folder, a missing file or key isn't managed and
// an empty one clears. push creates and changes purchases but never deletes
// one (Apple only lets a purchase that was never submitted go); --prune
// deletes languages a purchase has no folder for, and the prices set by hand
// that a new price would replace.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Availability,
  type OtherPrice,
  PURCHASE_TYPES,
  type Price,
  type Purchase,
  type PurchaseLocalization,
  type PurchaseType,
  type PurchaseUpdate,
  allTerritories,
  createPurchase,
  createPurchaseLocalization,
  deletePurchaseLocalization,
  listPurchases,
  pricePoints,
  purchaseAvailability,
  purchaseLocalizations,
  purchasePrice,
  sameAmount,
  setPurchaseAvailability,
  setPurchasePrice,
  updatePurchase,
  updatePurchaseLocalization,
} from "../asc/purchases";
import type { Project } from "../config";
import { type Change, diffRecord } from "../diff";
import { ShipError, ui } from "../ui";
import { type AvailabilityFile, availabilityJSON, inBatches, jsonSame, parseProductJSON, planPriceAndAvailability, priceAndAvailabilityProblems } from "./catalog";
import { type Problem, chars } from "./check";
import { ASC_LOCALES, localeDirs, readText, writeText } from "./files";

export const PURCHASE_FILE = "purchase.json";
export const NOTES_FILE = "review-notes.txt";
export const LOCALIZATION_FILES = { name: "name.txt", description: "description.txt" } as const;

/** Apple's limits for in-app purchases. */
export const PURCHASE_LIMITS = { referenceName: 64, name: 35, description: 55, reviewNote: 4000 };

/** A product id Apple takes: letters, digits, periods, and underscores. */
export const PRODUCT_ID = /^[A-Za-z0-9._]+$/;

const KEYS = ["type", "referenceName", "familySharing", "price", "availability"];

export const purchasesDir = (project: Project) => join(project.storeDir, "purchases");

/** purchase.json, as the repo says it. A missing key isn't managed. */
export interface PurchaseFile {
  type?: PurchaseType;
  referenceName?: string;
  familySharing?: boolean;
  /** One territory's price; Apple sets the others to match. null clears nothing (a sold purchase needs a price). */
  price?: Price;
  availability?: AvailabilityFile;
}

/** One purchase folder. */
export interface LocalPurchase {
  productId: string;
  file: PurchaseFile;
  /** Keys in purchase.json ship doesn't know. */
  unknownKeys: string[];
  notes?: string;
  locales: Record<string, { name?: string; description?: string }>;
}

// MARK: Reading the files

/** Every purchase folder under `dir`, by product id. */
export async function readPurchases(dir: string): Promise<LocalPurchase[]> {
  if (!existsSync(dir)) return [];
  const purchases: LocalPurchase[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name))) {
    const folder = join(dir, entry.name);
    const text = await readText(join(folder, PURCHASE_FILE));
    const json = text === undefined ? {} : parseProductJSON(text, join(folder, PURCHASE_FILE), "purchases");
    const locales: LocalPurchase["locales"] = {};
    for (const locale of localeDirs(folder)) {
      const fields: { name?: string; description?: string } = {};
      for (const [field, file] of Object.entries(LOCALIZATION_FILES) as [keyof typeof LOCALIZATION_FILES, string][]) {
        const value = await readText(join(folder, locale, file));
        if (value !== undefined) fields[field] = value;
      }
      locales[locale] = fields;
    }
    purchases.push({
      productId: entry.name,
      file: Object.fromEntries(KEYS.filter((key) => key in json).map((key) => [key, json[key]])) as PurchaseFile,
      unknownKeys: Object.keys(json).filter((key) => !KEYS.includes(key)),
      notes: await readText(join(folder, NOTES_FILE)),
      locales,
    });
  }
  return purchases;
}

// MARK: Validating

/** Offline checks of the purchases folder. File paths are relative to the store folder. */
export function validatePurchases(purchases: LocalPurchase[]): Problem[] {
  const problems: Problem[] = [];
  for (const purchase of purchases) {
    const base = `purchases/${purchase.productId}`;
    const json = `${base}/${PURCHASE_FILE}`;
    const error = (file: string, message: string, field?: string) => problems.push({ file, ...(field ? { field } : {}), message, severity: "error" });
    const warning = (file: string, message: string, field?: string) => problems.push({ file, ...(field ? { field } : {}), message, severity: "warning" });
    const { file } = purchase;
    if (!PRODUCT_ID.test(purchase.productId)) error(base, `"${purchase.productId}" isn't a product id: use letters, digits, periods, and underscores`);
    if (file.type !== undefined && !(PURCHASE_TYPES as readonly string[]).includes(file.type)) {
      error(json, `type is one of ${PURCHASE_TYPES.join(", ")} (auto-renewing subscriptions aren't in-app purchases), not ${JSON.stringify(file.type)}`, "type");
    }
    if (file.referenceName !== undefined && (typeof file.referenceName !== "string" || !file.referenceName.trim())) error(json, "referenceName should be text", "referenceName");
    else if (file.referenceName && chars(file.referenceName) > PURCHASE_LIMITS.referenceName) error(json, `referenceName is ${chars(file.referenceName)} characters; the most is ${PURCHASE_LIMITS.referenceName}`, "referenceName");
    if (file.familySharing !== undefined && typeof file.familySharing !== "boolean") error(json, "familySharing should be true or false", "familySharing");
    else if (file.familySharing === true && file.type && file.type !== "NON_CONSUMABLE") error(json, `Family Sharing is only for non-consumable purchases (and subscriptions), not ${file.type}`, "familySharing");
    problems.push(...priceAndAvailabilityProblems(json, file.price, file.availability));
    for (const key of purchase.unknownKeys) warning(json, `${key} isn't an in-app purchase field; ship ignores it`, key);
    if (purchase.notes && chars(purchase.notes) > PURCHASE_LIMITS.reviewNote) warning(`${base}/${NOTES_FILE}`, `The notes are ${chars(purchase.notes)} characters; App Review takes up to ${PURCHASE_LIMITS.reviewNote}`);
    for (const [locale, fields] of Object.entries(purchase.locales)) {
      const at = (field: keyof typeof LOCALIZATION_FILES) => `${base}/${locale}/${LOCALIZATION_FILES[field]}`;
      if (!ASC_LOCALES.includes(locale)) warning(`${base}/${locale}`, `${locale} isn't a language App Store Connect lists; check the folder's name`);
      if (fields.name !== undefined && !fields.name.trim()) error(at("name"), "A language needs a display name (or no folder)");
      if (fields.name && chars(fields.name) > PURCHASE_LIMITS.name) error(at("name"), `The display name is ${chars(fields.name)} characters; the most is ${PURCHASE_LIMITS.name}`);
      if (fields.description && chars(fields.description) > PURCHASE_LIMITS.description) error(at("description"), `The description is ${chars(fields.description)} characters; the most is ${PURCHASE_LIMITS.description}`);
    }
  }
  return problems;
}

// MARK: What App Store Connect has

export interface RemotePurchase {
  purchase: Purchase;
  localizations: PurchaseLocalization[];
  price: Price | null;
  /** Prices set by hand besides today's base one (other territories, changes to come): a new price replaces them. */
  otherPrices: OtherPrice[];
  availability: Availability | null;
}

/** Every purchase with its localizations, price, and availability; `only` limits it to these product ids. */
export async function fetchPurchases(appId: string, only?: string[]): Promise<{ purchases: RemotePurchase[]; territories: string[] }> {
  const [list, territories] = await Promise.all([listPurchases(appId), allTerritories()]);
  const wanted = list.filter((p) => !only?.length || only.includes(p.productId));
  const purchases = await inBatches(wanted, 5, async (purchase) => {
    const [localizations, { price, others }, availability] = await Promise.all([purchaseLocalizations(purchase.id), purchasePrice(purchase.id), purchaseAvailability(purchase.id)]);
    return { purchase, localizations, price, otherPrices: others, availability };
  });
  return { purchases, territories };
}

/** The files for what App Store Connect has, by path in the purchases folder. */
export function filesFromRemote(remote: RemotePurchase, territories: string[]): Map<string, string> {
  const files = new Map<string, string>();
  const base = remote.purchase.productId;
  const json: PurchaseFile = {
    type: remote.purchase.type,
    referenceName: remote.purchase.referenceName,
    familySharing: remote.purchase.familySharable,
    ...(remote.price ? { price: remote.price } : {}),
    ...(remote.availability ? { availability: availabilityJSON(remote.availability, territories) } : {}),
  };
  files.set(`${base}/${PURCHASE_FILE}`, `${JSON.stringify(json, null, 2)}\n`);
  files.set(`${base}/${NOTES_FILE}`, remote.purchase.reviewNote ?? "");
  for (const localization of [...remote.localizations].sort((a, b) => a.locale.localeCompare(b.locale))) {
    files.set(`${base}/${localization.locale}/${LOCALIZATION_FILES.name}`, localization.name);
    files.set(`${base}/${localization.locale}/${LOCALIZATION_FILES.description}`, localization.description ?? "");
  }
  return files;
}

// MARK: Planning

/** What push would do to one purchase. */
export interface PurchasePlan {
  productId: string;
  /** Not in App Store Connect yet: push creates it. */
  create?: { type: PurchaseType; referenceName: string; familySharable?: boolean; reviewNote?: string | null };
  /** The existing purchase's id and attribute changes. */
  id?: string;
  update: PurchaseUpdate;
  localizations: {
    create: { locale: string; name: string; description?: string | null }[];
    update: { locale: string; id: string; attributes: { name?: string; description?: string | null } }[];
    delete: { locale: string; id: string }[];
  };
  price?: Price;
  availability?: Availability;
}

export interface PurchasesPlan {
  changes: Change[];
  purchases: PurchasePlan[];
  /** Product ids in App Store Connect with no folder here (push leaves them alone). */
  onlyRemote: string[];
  /** Locales a purchase has in App Store Connect but no folder for, left alone without --prune. */
  onlyRemoteLocales: string[];
}

/** What would change, from the folders (`local`) to App Store Connect (`remote`). Pure: it asks nothing. */
export function planPurchases(local: LocalPurchase[], remote: RemotePurchase[], territories: string[], options: { prune?: boolean } = {}): PurchasesPlan {
  const plan: PurchasesPlan = { changes: [], purchases: [], onlyRemote: [], onlyRemoteLocales: [] };
  const byProduct = new Map(remote.map((r) => [r.purchase.productId, r]));
  for (const purchase of local) {
    const existing = byProduct.get(purchase.productId);
    const scope = `purchases/${purchase.productId}`;
    const { file } = purchase;
    const item: PurchasePlan = { productId: purchase.productId, update: {}, localizations: { create: [], update: [], delete: [] } };

    if (!existing) {
      if (!file.type || !file.referenceName) {
        throw new ShipError(
          `${scope} isn't in App Store Connect yet, and making it needs a type and a referenceName`,
          "missing-purchase-fields",
          `Add them to ${scope}/${PURCHASE_FILE}, like { "type": "NON_CONSUMABLE", "referenceName": "Pro" }.`,
          { productId: purchase.productId },
        );
      }
      item.create = { type: file.type, referenceName: file.referenceName, ...(file.familySharing !== undefined ? { familySharable: file.familySharing } : {}), ...(purchase.notes ? { reviewNote: purchase.notes } : {}) };
      plan.changes.push({ scope, field: "purchase", kind: "add", to: `${file.type} "${file.referenceName}"` });
      if (file.familySharing !== undefined) plan.changes.push({ scope, field: "familySharing", kind: "add", to: file.familySharing });
      if (purchase.notes) plan.changes.push({ scope, field: "reviewNotes", kind: "add", to: purchase.notes });
    } else {
      item.id = existing.purchase.id;
      if (file.type && file.type !== existing.purchase.type) {
        throw new ShipError(
          `${scope} is ${existing.purchase.type} in App Store Connect; a purchase's type can't change`,
          "purchase-type-fixed",
          `Set "type": "${existing.purchase.type}" in ${scope}/${PURCHASE_FILE}, or make a new purchase with another product id.`,
          { productId: purchase.productId, type: existing.purchase.type },
        );
      }
      if (file.familySharing === false && existing.purchase.familySharable) {
        throw new ShipError(`${scope} has Family Sharing on, and Apple doesn't let it go off again`, "family-sharing-fixed", `Set "familySharing": true in ${scope}/${PURCHASE_FILE}.`, { productId: purchase.productId });
      }
      // Changes name the files' fields (what you edit); the update takes Apple's.
      const desired: Record<string, unknown> = {};
      if (file.referenceName !== undefined) desired.referenceName = file.referenceName;
      if (file.familySharing !== undefined) desired.familySharing = file.familySharing;
      if (purchase.notes !== undefined) desired.reviewNotes = purchase.notes;
      const current = { referenceName: existing.purchase.referenceName, familySharing: existing.purchase.familySharable, reviewNotes: existing.purchase.reviewNote };
      const changes = diffRecord(scope, current, desired);
      const apiField: Record<string, keyof PurchaseUpdate> = { referenceName: "name", familySharing: "familySharable", reviewNotes: "reviewNote" };
      for (const change of changes) (item.update as Record<string, unknown>)[apiField[change.field]!] = change.to ?? null;
      plan.changes.push(...changes);
    }

    // Languages.
    const remoteLocales = new Map((existing?.localizations ?? []).map((l) => [l.locale, l]));
    for (const [locale, fields] of Object.entries(purchase.locales)) {
      const current = remoteLocales.get(locale);
      const changes = diffRecord(`${scope}/${locale}`, current ? { name: current.name, description: current.description } : undefined, fields);
      if (!changes.length) continue;
      plan.changes.push(...changes);
      if (current) item.localizations.update.push({ locale, id: current.id, attributes: Object.fromEntries(changes.map((c) => [c.field, c.to ?? null])) });
      else if (!fields.name) {
        throw new ShipError(`${scope}/${locale} has no name.txt, and a new language needs a display name`, "missing-purchase-fields", `Write ${scope}/${locale}/${LOCALIZATION_FILES.name}.`, { productId: purchase.productId, locale });
      } else item.localizations.create.push({ locale, name: fields.name, ...(fields.description ? { description: fields.description } : {}) });
    }
    for (const localization of existing?.localizations ?? []) {
      if (localization.locale in purchase.locales) continue;
      if (options.prune) {
        item.localizations.delete.push({ locale: localization.locale, id: localization.id });
        plan.changes.push({ scope: `${scope}/${localization.locale}`, field: "localization", kind: "remove", from: localization.locale, to: null });
      } else plan.onlyRemoteLocales.push(`${purchase.productId}/${localization.locale}`);
    }

    // Price and availability.
    const priced = planPriceAndAvailability(scope, purchase.productId, file, existing ?? null, territories, options);
    plan.changes.push(...priced.changes);
    if (priced.price) item.price = priced.price;
    if (priced.availability) item.availability = priced.availability;

    if (item.create || Object.keys(item.update).length || item.price || item.availability || Object.values(item.localizations).some((list) => list.length)) plan.purchases.push(item);
  }
  const localIds = new Set(local.map((p) => p.productId));
  plan.onlyRemote = remote.map((r) => r.purchase.productId).filter((id) => !localIds.has(id));
  return plan;
}

// MARK: pull, diff, push

export interface PurchasesPullResult {
  dir: string;
  written: string[];
  unchanged: string[];
}

/** Writes what App Store Connect has into the purchases folder. A file that differs is local work: pull stops and names it, unless `force`. */
export async function pullPurchases(project: Project, options: { appId: string; products?: string[]; force?: boolean }): Promise<PurchasesPullResult> {
  const dir = purchasesDir(project);
  const { purchases, territories } = await fetchPurchases(options.appId, options.products);
  const missing = (options.products ?? []).filter((id) => !purchases.some((p) => p.purchase.productId === id));
  if (missing.length) {
    const all = await listPurchases(options.appId);
    throw new ShipError(
      `App Store Connect has no purchase ${missing.join(", ")}`,
      "no-purchase",
      all.length ? `The app's purchases: ${all.map((p) => p.productId).join(", ")}` : "The app has no in-app purchases yet.",
      { choices: all.map((p) => p.productId) },
    );
  }
  const written: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  const files = new Map<string, string>();
  for (const remote of purchases) for (const [path, text] of filesFromRemote(remote, territories)) files.set(path, text);
  for (const [path, content] of files) {
    const existing = await readText(join(dir, path));
    const sameContent = existing !== undefined && (path.endsWith(".json") ? jsonSame(existing, content) : existing === content.replace(/\r\n?/g, "\n").trimEnd());
    if (existing === undefined) written.push(path);
    else if (sameContent) unchanged.push(path);
    else if (options.force) written.push(path);
    else conflicts.push(path);
  }
  if (conflicts.length) {
    throw new ShipError(
      `${conflicts.length === 1 ? "A file in" : `${conflicts.length} files in`} ${dir} differ${conflicts.length === 1 ? "s" : ""} from App Store Connect: ${conflicts.join(", ")}`,
      "local-changes",
      "See what differs with `ship purchases diff`, send it with `ship purchases push`, or replace it with App Store Connect's with `ship purchases pull --force`.",
      { files: conflicts },
    );
  }
  for (const path of written) await writeText(join(dir, path), files.get(path)!);
  return { dir, written, unchanged };
}

/** Reads the folder, checks it, and compares it with App Store Connect. Stops on validation errors before asking App Store Connect anything. */
export async function diffPurchases(project: Project, options: { appId: string; products?: string[]; prune?: boolean }) {
  const dir = purchasesDir(project);
  if (!existsSync(dir)) throw new ShipError(`There's no ${dir} yet`, "no-store", "Start it from App Store Connect with `ship purchases pull`, or make purchases/<product id>/purchase.json.");
  const all = await readPurchases(dir);
  for (const id of options.products ?? []) {
    if (!all.some((p) => p.productId === id)) {
      throw new ShipError(`There's no purchases/${id} folder`, "usage", all.length ? `Pass one of: ${all.map((p) => p.productId).join(", ")}` : "Make one, or `ship purchases pull`.", { choices: all.map((p) => p.productId) }, 2);
    }
  }
  const local = all.filter((p) => !options.products?.length || options.products.includes(p.productId));
  const errors = validatePurchases(local).filter((p) => p.severity === "error");
  if (errors.length) {
    throw new ShipError(`purchases/ has ${errors.length} problem${errors.length === 1 ? "" : "s"}: ${errors[0]!.file}: ${errors[0]!.message}`, "invalid-store", "See them all with `ship purchases validate`.", { problems: errors });
  }
  const { purchases: remote, territories } = await fetchPurchases(options.appId, options.products);
  const plan = planPurchases(local, remote, territories, { prune: options.prune });
  return { plan, territories };
}

export interface PurchasesPushResult {
  changes: Change[];
  applied: boolean;
  created: string[];
  onlyRemote: string[];
  onlyRemoteLocales: string[];
}

/** The price point for `price`, or an error naming the nearest amounts. */
async function pricePointFor(purchaseId: string, productId: string, price: Price): Promise<string> {
  const points = await pricePoints(purchaseId, price.territory);
  const match = points.find((point) => sameAmount(point.amount, price.amount));
  if (match) return match.id;
  const near = [...points].sort((a, b) => Math.abs(Number(a.amount) - Number(price.amount)) - Math.abs(Number(b.amount) - Number(price.amount))).slice(0, 4).map((p) => p.amount).sort((a, b) => Number(a) - Number(b));
  throw new ShipError(
    `${price.amount} isn't a price ${price.territory} can have for ${productId}`,
    "no-price-point",
    near.length ? `Apple's nearest prices there: ${near.join(", ")}. Set one in purchases/${productId}/${PURCHASE_FILE}.` : `${price.territory} has no prices for it; check the territory.`,
    { productId, territory: price.territory, nearest: near },
  );
}

/** Sends the purchases folder to App Store Connect (or with dryRun, says what it would send). */
export async function pushPurchases(project: Project, options: { appId: string; products?: string[]; prune?: boolean; dryRun?: boolean }): Promise<PurchasesPushResult> {
  const { plan } = await diffPurchases(project, options);
  const result: PurchasesPushResult = {
    changes: plan.changes,
    applied: false,
    created: plan.purchases.filter((p) => p.create).map((p) => p.productId),
    onlyRemote: plan.onlyRemote,
    onlyRemoteLocales: plan.onlyRemoteLocales,
  };
  if (options.dryRun || !plan.changes.length) return result;
  // Prices of purchases that exist are found before anything changes, so a price Apple doesn't have stops the push untouched.
  const points = new Map<string, string>();
  for (const item of plan.purchases) if (item.price && item.id) points.set(item.productId, await pricePointFor(item.id, item.productId, item.price));

  const created: string[] = [];
  for (const item of plan.purchases) {
    let id = item.id;
    if (item.create) {
      ui.step(`Making ${item.productId}`);
      id = (await createPurchase(options.appId, { productId: item.productId, ...item.create })).id;
      created.push(item.productId);
      // Its price points exist only now; a price Apple doesn't have stops here, before its languages and the rest.
      if (item.price) {
        try {
          points.set(item.productId, await pricePointFor(id, item.productId, item.price));
        } catch (error) {
          if (!(error instanceof ShipError)) throw error;
          throw new ShipError(
            error.message,
            error.code,
            `${item.productId} was made, without its languages, price, or where it's sold. ${error.hint ?? ""} Then push again; it carries on from there.`.trim(),
            { ...error.details, created },
          );
        }
      }
    } else if (Object.keys(item.update).length) {
      ui.step(`Updating ${item.productId}`);
      await updatePurchase(id!, item.update);
    }
    for (const localization of item.localizations.update) await updatePurchaseLocalization(localization.id, localization.attributes);
    for (const { locale, ...attributes } of item.localizations.create) {
      ui.step(`Adding ${item.productId}'s ${locale}`);
      await createPurchaseLocalization(id!, locale, attributes);
    }
    for (const localization of item.localizations.delete) {
      ui.step(`Deleting ${item.productId}'s ${localization.locale}`);
      await deletePurchaseLocalization(localization.id);
    }
    if (item.price) {
      ui.step(`Setting ${item.productId}'s price to ${item.price.amount} in ${item.price.territory}`);
      await setPurchasePrice(id!, item.price.territory, points.get(item.productId) ?? (await pricePointFor(id!, item.productId, item.price)));
    }
    if (item.availability) {
      ui.step(`Setting where ${item.productId} is sold`);
      await setPurchaseAvailability(id!, item.availability);
    }
  }
  result.applied = true;
  return result;
}
