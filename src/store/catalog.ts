// What in-app purchases (store/purchases.ts) and subscriptions
// (store/subscriptions.ts) share in the store folder: a JSON file per
// product, one territory's price, and where it's sold.

import { type Availability, type OtherPrice, type Price, sameAmount } from "../asc/purchases";
import { type Change, same } from "../diff";
import { ShipError } from "../ui";
import type { Problem } from "./check";
import { isObject } from "./files";

/** Where a product is sold, as its JSON file says it. */
export interface AvailabilityFile {
  /** "all" territories, or a list ([] is sold nowhere). */
  territories: "all" | string[];
  /** Whether territories Apple adds later get it too. */
  newTerritories?: boolean;
}

/** A product's JSON file as an object, or a bad-store-file error naming it; `command` is what pulls it, like "purchases". */
export function parseProductJSON(text: string, path: string, command: string): Record<string, unknown> {
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new ShipError(`${path} isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`, "bad-store-file", `Fix ${path} (a missing comma or quote?), or delete it and run \`ship ${command} pull\`.`, { file: path });
  }
  if (!isObject(json)) throw new ShipError(`${path} should hold a JSON object`, "bad-store-file", "Start it with { and end it with }.", { file: path });
  return json;
}

/** Whether two JSON texts say the same thing. */
export function jsonSame(a: string, b: string): boolean {
  try {
    return same(JSON.parse(a), JSON.parse(b));
  } catch {
    return false;
  }
}

/** Problems with a `price` and an `availability` from a product's JSON file at `file`. */
export function priceAndAvailabilityProblems(file: string, price: unknown, availability: unknown): Problem[] {
  const problems: Problem[] = [];
  const error = (message: string, field: string) => problems.push({ file, field, message, severity: "error" });
  if (price !== undefined) {
    if (!isObject(price) || typeof price.territory !== "string" || typeof price.amount !== "string") {
      error('price should be like { "territory": "USA", "amount": "0.99" } (the amount as text, so 0.90 stays 0.90)', "price");
    } else {
      if (!/^[A-Z]{3}$/.test(price.territory)) error(`price.territory is a three-letter territory like USA, not "${price.territory}"`, "price.territory");
      if (!/^\d+(\.\d{1,3})?$/.test(price.amount) || Number(price.amount) <= 0) error(`price.amount is what customers pay, like "0.99", not "${price.amount}"`, "price.amount");
    }
  }
  if (availability !== undefined) {
    const territories = isObject(availability) ? availability.territories : undefined;
    // [] is sold nowhere: it's what App Store Connect has for a product taken off sale everywhere.
    if (!isObject(availability) || !(territories === "all" || (Array.isArray(territories) && territories.every((t) => typeof t === "string" && /^[A-Z]{3}$/.test(t))))) {
      error('availability should be like { "territories": "all" } or { "territories": ["USA", "GBR"], "newTerritories": false }', "availability");
    } else if (Array.isArray(territories) && new Set(territories).size !== territories.length) {
      error("availability.territories lists a territory twice", "availability.territories");
    } else if (availability.newTerritories !== undefined && typeof availability.newTerritories !== "boolean") {
      error("availability.newTerritories should be true or false", "availability.newTerritories");
    }
  }
  return problems;
}

/** The availability as a JSON file says it: "all" when it's every territory. */
export function availabilityJSON(availability: Availability, territories: string[]): AvailabilityFile {
  const all = territories.length > 0 && territories.every((t) => availability.territories.includes(t));
  return { territories: all ? "all" : availability.territories, newTerritories: availability.newTerritories };
}

/** The availability a file asks for, with "all" spelled out; undefined when the file doesn't say. */
export function desiredAvailability(file: AvailabilityFile | undefined, territories: string[], remote: Availability | null): Availability | undefined {
  if (!file) return undefined;
  const list = file.territories === "all" ? territories : [...file.territories].sort();
  return { territories: list, newTerritories: file.newTerritories ?? remote?.newTerritories ?? file.territories === "all" };
}

/** Whether two availabilities are the same. */
export const sameAvailability = (a: Availability, b: Availability) => same(a.territories, b.territories) && a.newTerritories === b.newTerritories;

/** "4.99 in USA". */
export const showPrice = (price: Price) => `${price.amount} in ${price.territory}`;

/** "every territory, and new ones", or the list. */
export const showAvailability = (a: Availability, territories: string[]) =>
  `${a.territories.length === territories.length ? "every territory" : a.territories.length ? a.territories.join(", ") : "nowhere"}${a.newTerritories ? ", and new ones" : ""}`;

/**
 * The price and availability changes for one product: what the file asks
 * for against what App Store Connect has. A new price replaces the prices
 * set by hand that the file doesn't show (`otherPrices`), so those stop the
 * push with manual-prices unless `prune`, which lists them as removals.
 */
export function planPriceAndAvailability(
  scope: string,
  productId: string,
  file: { price?: Price; availability?: AvailabilityFile },
  existing: { price: Price | null; otherPrices: OtherPrice[]; availability: Availability | null } | null,
  territories: string[],
  options: { prune?: boolean } = {},
): { changes: Change[]; price?: Price; availability?: Availability } {
  const result: { changes: Change[]; price?: Price; availability?: Availability } = { changes: [] };
  if (file.price && !(existing?.price && existing.price.territory === file.price.territory && sameAmount(existing.price.amount, file.price.amount))) {
    result.price = file.price;
    result.changes.push({ scope, field: "price", kind: existing?.price ? "change" : "add", ...(existing?.price ? { from: showPrice(existing.price) } : {}), to: showPrice(file.price) });
    const others = existing?.otherPrices ?? [];
    const describe = (p: OtherPrice) => `${showPrice(p)}${p.startDate ? ` from ${p.startDate}` : ""}${p.endDate ? ` until ${p.endDate}` : ""}`;
    if (others.length && !options.prune) {
      throw new ShipError(
        `${scope} has prices set by hand that a new price would replace: ${others.map(describe).join("; ")}`,
        "manual-prices",
        "Push with --prune to replace them with the new price (Apple then sets every other territory to match), or change them in App Store Connect.",
        { productId, prices: others },
      );
    }
    for (const other of others) result.changes.push({ scope, field: "price", kind: "remove", from: describe(other), to: null });
  }
  const availability = desiredAvailability(file.availability, territories, existing?.availability ?? null);
  if (availability && !(existing?.availability && sameAvailability(existing.availability, availability))) {
    result.availability = availability;
    result.changes.push({ scope, field: "availability", kind: existing?.availability ? "change" : "add", ...(existing?.availability ? { from: showAvailability(existing.availability, territories) } : {}), to: showAvailability(availability, territories) });
  }
  return result;
}

/** Runs `body` on each item, a few at a time, so a big catalog doesn't send hundreds of requests at once. */
export async function inBatches<T, R>(items: T[], size: number, body: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) results.push(...(await Promise.all(items.slice(i, i + size).map(body))));
  return results;
}
