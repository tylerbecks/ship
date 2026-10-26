// In-app purchases (consumable, non-consumable, and non-renewing
// subscriptions; auto-renewing ones are subscriptions): the purchase, its
// display name and description per language, its price, and where it's sold.
//
// A price is a price point: Apple's fixed list of prices per territory. ship
// sets one base territory's price and lets Apple equalize the rest, as App
// Store Connect does unless you set territories by hand.

import { ShipError } from "../ui";
import { type Resource, all, del, get, one, patch, post, relationshipId } from "./client";

/** Apple's InAppPurchaseType. Auto-renewing subscriptions aren't in-app purchases in the API. */
export const PURCHASE_TYPES = ["CONSUMABLE", "NON_CONSUMABLE", "NON_RENEWING_SUBSCRIPTION"] as const;
export type PurchaseType = (typeof PURCHASE_TYPES)[number];

export interface Purchase {
  id: string;
  productId: string;
  type: PurchaseType;
  /** The reference name: only you see it, in App Store Connect and reports. */
  referenceName: string;
  reviewNote: string | null;
  familySharable: boolean;
  /** MISSING_METADATA, READY_TO_SUBMIT, WAITING_FOR_REVIEW, APPROVED, … */
  state: string;
}

interface PurchaseAttributes {
  name?: string;
  productId?: string;
  inAppPurchaseType?: PurchaseType;
  state?: string;
  reviewNote?: string | null;
  familySharable?: boolean;
}

export const toPurchase = ({ id, attributes }: Resource<PurchaseAttributes>): Purchase => ({
  id,
  productId: attributes.productId ?? "",
  type: attributes.inAppPurchaseType ?? "CONSUMABLE",
  referenceName: attributes.name ?? "",
  reviewNote: attributes.reviewNote ?? null,
  familySharable: attributes.familySharable ?? false,
  state: attributes.state ?? "",
});

/** The app's in-app purchases, by product id. */
export async function listPurchases(appId: string): Promise<Purchase[]> {
  const { data } = await all<PurchaseAttributes>(`/v1/apps/${encodeURIComponent(appId)}/inAppPurchasesV2?limit=200`);
  return data.map(toPurchase).sort((a, b) => a.productId.localeCompare(b.productId));
}

export interface NewPurchase {
  productId: string;
  type: PurchaseType;
  referenceName: string;
  reviewNote?: string | null;
  familySharable?: boolean;
}

export function purchaseCreateBody(appId: string, purchase: NewPurchase) {
  return {
    data: {
      type: "inAppPurchases",
      attributes: {
        name: purchase.referenceName,
        productId: purchase.productId,
        inAppPurchaseType: purchase.type,
        ...(purchase.reviewNote ? { reviewNote: purchase.reviewNote } : {}),
        ...(purchase.familySharable !== undefined ? { familySharable: purchase.familySharable } : {}),
      },
      relationships: { app: { data: { type: "apps", id: appId } } },
    },
  };
}

export async function createPurchase(appId: string, purchase: NewPurchase): Promise<Purchase> {
  const created = one(await post<PurchaseAttributes>("/v2/inAppPurchases", purchaseCreateBody(appId, purchase)));
  if (!created) {
    throw new ShipError(
      `App Store Connect didn't say what it made for ${purchase.productId}`,
      "api-bad-response",
      "It may have been made anyway: `ship purchases diff` shows whether it's there now, and push carries on from where it is.",
      { productId: purchase.productId },
    );
  }
  return toPurchase(created);
}

/** The attributes that can change after a purchase is made (its product id and type can't). */
export type PurchaseUpdate = { name?: string; reviewNote?: string | null; familySharable?: boolean };

export async function updatePurchase(id: string, attributes: PurchaseUpdate): Promise<void> {
  await patch(`/v2/inAppPurchases/${encodeURIComponent(id)}`, { data: { type: "inAppPurchases", id, attributes } });
}

// MARK: Localizations

export interface PurchaseLocalization {
  id: string;
  locale: string;
  name: string;
  description: string | null;
}

interface LocalizationAttributes {
  locale?: string;
  name?: string;
  description?: string | null;
}

export async function purchaseLocalizations(purchaseId: string): Promise<PurchaseLocalization[]> {
  const { data } = await all<LocalizationAttributes>(`/v2/inAppPurchases/${encodeURIComponent(purchaseId)}/inAppPurchaseLocalizations?limit=50`);
  return data.map(({ id, attributes }) => ({ id, locale: attributes.locale ?? "", name: attributes.name ?? "", description: attributes.description ?? null }));
}

export async function createPurchaseLocalization(purchaseId: string, locale: string, attributes: { name: string; description?: string | null }): Promise<void> {
  await post("/v1/inAppPurchaseLocalizations", {
    data: {
      type: "inAppPurchaseLocalizations",
      attributes: { locale, name: attributes.name, ...(attributes.description ? { description: attributes.description } : {}) },
      relationships: { inAppPurchaseV2: { data: { type: "inAppPurchases", id: purchaseId } } },
    },
  });
}

export async function updatePurchaseLocalization(id: string, attributes: { name?: string; description?: string | null }): Promise<void> {
  await patch(`/v1/inAppPurchaseLocalizations/${encodeURIComponent(id)}`, { data: { type: "inAppPurchaseLocalizations", id, attributes } });
}

export const deletePurchaseLocalization = (id: string) => del(`/v1/inAppPurchaseLocalizations/${encodeURIComponent(id)}`);

// MARK: Price

/** A price in one territory, as its customer sees it, like { territory: "USA", amount: "0.99" }. */
export interface Price {
  territory: string;
  amount: string;
}

/** Whether two prices are the same amount ("0.99" and "0.990" are). */
export const sameAmount = (a: string, b: string) => Number(a) === Number(b);

const today = () => new Date().toISOString().slice(0, 10);

/** A price set by hand in the schedule other than today's base one: another territory's, or a change scheduled for later. */
export interface OtherPrice extends Price {
  startDate: string | null;
  endDate: string | null;
}

/**
 * The price in effect today in the schedule's base territory (null when the
 * purchase has no price yet), and the other prices set by hand that are
 * current or still to come. Setting a price replaces the whole schedule, so
 * those would go.
 */
export async function purchasePrice(purchaseId: string): Promise<{ price: Price | null; others: OtherPrice[] }> {
  let schedule;
  try {
    schedule = one(await get(`/v2/inAppPurchases/${encodeURIComponent(purchaseId)}/iapPriceSchedule?include=baseTerritory`));
  } catch (error) {
    if ((error as { code?: string }).code === "api-404") return { price: null, others: [] };
    throw error;
  }
  const base = schedule && relationshipId(schedule, "baseTerritory");
  if (!schedule || !base) return { price: null, others: [] };
  const { data, included } = await all<{ startDate?: string | null; endDate?: string | null }>(
    `/v1/inAppPurchasePriceSchedules/${encodeURIComponent(schedule.id)}/manualPrices?include=inAppPurchasePricePoint,territory&fields[inAppPurchasePricePoints]=customerPrice,territory&limit=200`,
  );
  const now = today();
  const amountOf = (price: Resource) => {
    const pointId = relationshipId(price, "inAppPurchasePricePoint");
    const amount = included.find((item) => item.type === "inAppPurchasePricePoints" && item.id === pointId)?.attributes.customerPrice;
    return typeof amount === "string" ? amount : "";
  };
  const current = data.find((price) => {
    const { startDate, endDate } = price.attributes;
    return relationshipId(price, "territory") === base && (!startDate || startDate <= now) && (!endDate || endDate > now);
  });
  const others = data
    .filter((price) => price !== current && (!price.attributes.endDate || price.attributes.endDate > now))
    .map((price) => ({ territory: relationshipId(price, "territory") ?? "", amount: amountOf(price), startDate: price.attributes.startDate ?? null, endDate: price.attributes.endDate ?? null }));
  const amount = current ? amountOf(current) : "";
  return { price: amount ? { territory: base, amount } : null, others };
}

/** The price points a purchase can have in a territory: the amounts customers can be charged. */
export async function pricePoints(purchaseId: string, territory: string): Promise<{ id: string; amount: string }[]> {
  const { data } = await all<{ customerPrice?: string }>(
    `/v2/inAppPurchases/${encodeURIComponent(purchaseId)}/pricePoints?filter[territory]=${encodeURIComponent(territory)}&fields[inAppPurchasePricePoints]=customerPrice&limit=8000`,
  );
  return data.map((point) => ({ id: point.id, amount: point.attributes.customerPrice ?? "" }));
}

/** The body that makes `pricePointId` the purchase's price from now on, in `territory`, with Apple equalizing the rest. */
export function priceScheduleBody(purchaseId: string, territory: string, pricePointId: string) {
  const price = "${price}";
  return {
    data: {
      type: "inAppPurchasePriceSchedules",
      relationships: {
        inAppPurchase: { data: { type: "inAppPurchases", id: purchaseId } },
        baseTerritory: { data: { type: "territories", id: territory } },
        manualPrices: { data: [{ type: "inAppPurchasePrices", id: price }] },
      },
    },
    included: [
      {
        type: "inAppPurchasePrices",
        id: price,
        attributes: { startDate: null },
        relationships: {
          inAppPurchaseV2: { data: { type: "inAppPurchases", id: purchaseId } },
          inAppPurchasePricePoint: { data: { type: "inAppPurchasePricePoints", id: pricePointId } },
        },
      },
    ],
  };
}

export async function setPurchasePrice(purchaseId: string, territory: string, pricePointId: string): Promise<void> {
  await post("/v1/inAppPurchasePriceSchedules", priceScheduleBody(purchaseId, territory, pricePointId));
}

// MARK: Availability

/** Where a purchase is sold: territory ids, and whether new territories Apple adds get it too. */
export interface Availability {
  territories: string[];
  newTerritories: boolean;
}

/** Every territory the App Store has, like USA and GBR. */
export async function allTerritories(): Promise<string[]> {
  const { data } = await all("/v1/territories?limit=200");
  return data.map((territory) => territory.id).sort();
}

/** Where the purchase is sold, or null when that hasn't been set. */
export async function purchaseAvailability(purchaseId: string): Promise<Availability | null> {
  let availability;
  try {
    availability = one(await get<{ availableInNewTerritories?: boolean }>(`/v2/inAppPurchases/${encodeURIComponent(purchaseId)}/inAppPurchaseAvailability`));
  } catch (error) {
    if ((error as { code?: string }).code === "api-404") return null;
    throw error;
  }
  if (!availability) return null;
  const { data } = await all(`/v1/inAppPurchaseAvailabilities/${encodeURIComponent(availability.id)}/availableTerritories?limit=200`);
  return { territories: data.map((territory) => territory.id).sort(), newTerritories: availability.attributes.availableInNewTerritories ?? false };
}

export function availabilityBody(purchaseId: string, availability: Availability) {
  return {
    data: {
      type: "inAppPurchaseAvailabilities",
      attributes: { availableInNewTerritories: availability.newTerritories },
      relationships: {
        inAppPurchase: { data: { type: "inAppPurchases", id: purchaseId } },
        availableTerritories: { data: availability.territories.map((id) => ({ type: "territories", id })) },
      },
    },
  };
}

export async function setPurchaseAvailability(purchaseId: string, availability: Availability): Promise<void> {
  await post("/v1/inAppPurchaseAvailabilities", availabilityBody(purchaseId, availability));
}
