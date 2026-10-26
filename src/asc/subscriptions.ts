// Auto-renewable subscriptions: groups (with their display name per
// language), the subscriptions in them (period, level, display name and
// description per language), their prices, and where they're sold.
//
// A subscription has a price per territory, not one schedule: setting one
// territory's price means adding Apple's equivalent price (its
// equalization) in every other territory. ship manages the standard plan,
// paid up front each period (planType UPFRONT), not monthly installments.

import { ShipError } from "../ui";
import { type Resource, all, del, one, patch, post, relationshipId } from "./client";
import type { Availability } from "./purchases";

export const PERIODS = ["ONE_WEEK", "ONE_MONTH", "TWO_MONTHS", "THREE_MONTHS", "SIX_MONTHS", "ONE_YEAR"] as const;
export type Period = (typeof PERIODS)[number];

/** The plan ship manages: the price paid up front each period. */
const PLAN = "UPFRONT";

// MARK: Groups

export interface SubscriptionGroup {
  id: string;
  referenceName: string;
}

export async function listGroups(appId: string): Promise<SubscriptionGroup[]> {
  const { data } = await all<{ referenceName?: string }>(`/v1/apps/${encodeURIComponent(appId)}/subscriptionGroups?limit=200`);
  return data.map(({ id, attributes }) => ({ id, referenceName: attributes.referenceName ?? "" })).sort((a, b) => a.referenceName.localeCompare(b.referenceName));
}

export async function createGroup(appId: string, referenceName: string): Promise<SubscriptionGroup> {
  const created = one(await post<{ referenceName?: string }>("/v1/subscriptionGroups", { data: { type: "subscriptionGroups", attributes: { referenceName }, relationships: { app: { data: { type: "apps", id: appId } } } } }));
  if (!created) throw new ShipError(`App Store Connect didn't say what it made for the group ${referenceName}`, "api-bad-response", "It may have been made anyway: `ship subscriptions diff` shows whether it's there now.");
  return { id: created.id, referenceName: created.attributes.referenceName ?? referenceName };
}

export interface GroupLocalization {
  id: string;
  locale: string;
  /** The group's display name. */
  name: string;
  /** The app's name as shown with the group, when it differs. */
  customAppName: string | null;
}

export async function groupLocalizations(groupId: string): Promise<GroupLocalization[]> {
  const { data } = await all<{ locale?: string; name?: string; customAppName?: string | null }>(`/v1/subscriptionGroups/${encodeURIComponent(groupId)}/subscriptionGroupLocalizations?limit=200`);
  return data.map(({ id, attributes }) => ({ id, locale: attributes.locale ?? "", name: attributes.name ?? "", customAppName: attributes.customAppName ?? null }));
}

export async function createGroupLocalization(groupId: string, locale: string, attributes: { name: string; customAppName?: string | null }): Promise<void> {
  await post("/v1/subscriptionGroupLocalizations", {
    data: {
      type: "subscriptionGroupLocalizations",
      attributes: { locale, name: attributes.name, ...(attributes.customAppName ? { customAppName: attributes.customAppName } : {}) },
      relationships: { subscriptionGroup: { data: { type: "subscriptionGroups", id: groupId } } },
    },
  });
}

export async function updateGroupLocalization(id: string, attributes: { name?: string; customAppName?: string | null }): Promise<void> {
  await patch(`/v1/subscriptionGroupLocalizations/${encodeURIComponent(id)}`, { data: { type: "subscriptionGroupLocalizations", id, attributes } });
}

export const deleteGroupLocalization = (id: string) => del(`/v1/subscriptionGroupLocalizations/${encodeURIComponent(id)}`);

// MARK: Subscriptions

export interface Subscription {
  id: string;
  productId: string;
  /** The reference name only you see. */
  referenceName: string;
  period: Period | null;
  /** Its level in the group: 1 is the highest, the one people upgrade to. */
  level: number | null;
  familySharable: boolean;
  reviewNote: string | null;
  state: string;
}

interface SubscriptionAttributes {
  name?: string;
  productId?: string;
  subscriptionPeriod?: Period | null;
  groupLevel?: number | null;
  familySharable?: boolean;
  reviewNote?: string | null;
  state?: string;
}

const toSubscription = ({ id, attributes }: Resource<SubscriptionAttributes>): Subscription => ({
  id,
  productId: attributes.productId ?? "",
  referenceName: attributes.name ?? "",
  period: attributes.subscriptionPeriod ?? null,
  level: attributes.groupLevel ?? null,
  familySharable: attributes.familySharable ?? false,
  reviewNote: attributes.reviewNote ?? null,
  state: attributes.state ?? "",
});

export async function groupSubscriptions(groupId: string): Promise<Subscription[]> {
  const { data } = await all<SubscriptionAttributes>(`/v1/subscriptionGroups/${encodeURIComponent(groupId)}/subscriptions?limit=200`);
  return data.map(toSubscription).sort((a, b) => a.productId.localeCompare(b.productId));
}

export interface NewSubscription {
  productId: string;
  referenceName: string;
  period: Period;
  level?: number;
  familySharable?: boolean;
  reviewNote?: string | null;
}

export function subscriptionCreateBody(groupId: string, subscription: NewSubscription) {
  return {
    data: {
      type: "subscriptions",
      attributes: {
        name: subscription.referenceName,
        productId: subscription.productId,
        subscriptionPeriod: subscription.period,
        ...(subscription.level !== undefined ? { groupLevel: subscription.level } : {}),
        ...(subscription.familySharable !== undefined ? { familySharable: subscription.familySharable } : {}),
        ...(subscription.reviewNote ? { reviewNote: subscription.reviewNote } : {}),
      },
      relationships: { group: { data: { type: "subscriptionGroups", id: groupId } } },
    },
  };
}

export async function createSubscription(groupId: string, subscription: NewSubscription): Promise<Subscription> {
  const created = one(await post<SubscriptionAttributes>("/v1/subscriptions", subscriptionCreateBody(groupId, subscription)));
  if (!created) {
    throw new ShipError(`App Store Connect didn't say what it made for ${subscription.productId}`, "api-bad-response", "It may have been made anyway: `ship subscriptions diff` shows whether it's there now, and push carries on from where it is.", { productId: subscription.productId });
  }
  return toSubscription(created);
}

/** Attributes that can change after a subscription is made (its product id and group can't). */
export type SubscriptionUpdate = { name?: string; subscriptionPeriod?: Period; groupLevel?: number; familySharable?: boolean; reviewNote?: string | null };

export async function updateSubscription(id: string, attributes: SubscriptionUpdate): Promise<void> {
  await patch(`/v1/subscriptions/${encodeURIComponent(id)}`, { data: { type: "subscriptions", id, attributes } });
}

export interface SubscriptionLocalization {
  id: string;
  locale: string;
  name: string;
  description: string | null;
}

export async function subscriptionLocalizations(subscriptionId: string): Promise<SubscriptionLocalization[]> {
  const { data } = await all<{ locale?: string; name?: string; description?: string | null }>(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}/subscriptionLocalizations?limit=200`);
  return data.map(({ id, attributes }) => ({ id, locale: attributes.locale ?? "", name: attributes.name ?? "", description: attributes.description ?? null }));
}

export async function createSubscriptionLocalization(subscriptionId: string, locale: string, attributes: { name: string; description?: string | null }): Promise<void> {
  await post("/v1/subscriptionLocalizations", {
    data: {
      type: "subscriptionLocalizations",
      attributes: { locale, name: attributes.name, ...(attributes.description ? { description: attributes.description } : {}) },
      relationships: { subscription: { data: { type: "subscriptions", id: subscriptionId } } },
    },
  });
}

export async function updateSubscriptionLocalization(id: string, attributes: { name?: string; description?: string | null }): Promise<void> {
  await patch(`/v1/subscriptionLocalizations/${encodeURIComponent(id)}`, { data: { type: "subscriptionLocalizations", id, attributes } });
}

export const deleteSubscriptionLocalization = (id: string) => del(`/v1/subscriptionLocalizations/${encodeURIComponent(id)}`);

// MARK: Prices

/** One territory's price: the price point it charges, and from when (null: from the start). */
export interface TerritoryPrice {
  id: string;
  territory: string;
  pointId: string;
  amount: string;
  startDate: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The subscription's prices on the up-front plan: the one in effect today in
 * each territory, and the ones scheduled to start later.
 */
export async function subscriptionPrices(subscriptionId: string): Promise<{ current: TerritoryPrice[]; scheduled: TerritoryPrice[] }> {
  const { data, included } = await all<{ startDate?: string | null; planType?: string | null }>(
    `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/prices?include=subscriptionPricePoint,territory&fields[subscriptionPricePoints]=customerPrice&limit=200`,
  );
  const now = today();
  const prices = data
    .filter((price) => !price.attributes.planType || price.attributes.planType === PLAN)
    .map((price) => {
      const pointId = relationshipId(price, "subscriptionPricePoint") ?? "";
      const amount = included.find((item) => item.type === "subscriptionPricePoints" && item.id === pointId)?.attributes.customerPrice;
      return { id: price.id, territory: relationshipId(price, "territory") ?? "", pointId, amount: typeof amount === "string" ? amount : "", startDate: price.attributes.startDate ?? null };
    });
  const current = new Map<string, TerritoryPrice>();
  for (const price of prices) {
    if (price.startDate && price.startDate > now) continue;
    const seen = current.get(price.territory);
    if (!seen || (price.startDate ?? "") > (seen.startDate ?? "")) current.set(price.territory, price);
  }
  return { current: [...current.values()].sort((a, b) => a.territory.localeCompare(b.territory)), scheduled: prices.filter((p) => p.startDate && p.startDate > now) };
}

/** The amounts a subscription can charge in a territory, on the up-front plan (a point doesn't say its plan, so the filter must). */
export async function subscriptionPricePoints(subscriptionId: string, territory: string): Promise<{ id: string; amount: string }[]> {
  const { data } = await all<{ customerPrice?: string }>(
    `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/pricePoints?filter[territory]=${encodeURIComponent(territory)}&filter[planType]=${PLAN}&fields[subscriptionPricePoints]=customerPrice&limit=8000`,
  );
  return data.map((point) => ({ id: point.id, amount: point.attributes.customerPrice ?? "" }));
}

/** Apple's equivalent of a subscription's price point in every other territory, on the up-front plan. */
export async function equalizations(subscriptionId: string, pointId: string): Promise<{ id: string; territory: string; amount: string }[]> {
  const { data } = await all<{ customerPrice?: string }>(
    `/v1/subscriptionPricePoints/${encodeURIComponent(pointId)}/equalizations?filter[subscription]=${encodeURIComponent(subscriptionId)}&filter[planType]=${PLAN}&include=territory&fields[subscriptionPricePoints]=customerPrice,territory&limit=8000`,
  );
  return data.map((point) => ({ id: point.id, territory: relationshipId(point, "territory") ?? "", amount: point.attributes.customerPrice ?? "" }));
}

/** The body that adds a price in one territory, from today. `preserve` keeps current subscribers on the price they have. */
export function priceCreateBody(subscriptionId: string, territory: string, pointId: string, preserve: boolean) {
  return {
    data: {
      type: "subscriptionPrices",
      attributes: { preserveCurrentPrice: preserve, planType: PLAN },
      relationships: {
        subscription: { data: { type: "subscriptions", id: subscriptionId } },
        territory: { data: { type: "territories", id: territory } },
        subscriptionPricePoint: { data: { type: "subscriptionPricePoints", id: pointId } },
      },
    },
  };
}

export async function addSubscriptionPrice(subscriptionId: string, territory: string, pointId: string, preserve: boolean): Promise<void> {
  await post("/v1/subscriptionPrices", priceCreateBody(subscriptionId, territory, pointId, preserve));
}

export const deleteSubscriptionPrice = (id: string) => del(`/v1/subscriptionPrices/${encodeURIComponent(id)}`);

// MARK: Availability

/** Where the up-front plan is sold, with its id (to change it), or null when that hasn't been set. */
export async function subscriptionAvailability(subscriptionId: string): Promise<(Availability & { id: string }) | null> {
  const { data } = await all<{ planType?: string | null; availableInNewTerritories?: boolean }>(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}/planAvailabilities?limit=200`);
  const plan = data.find((availability) => (availability.attributes.planType ?? PLAN) === PLAN);
  if (!plan) return null;
  const territories = await all(`/v1/subscriptionPlanAvailabilities/${encodeURIComponent(plan.id)}/availableTerritories?limit=200`);
  return { id: plan.id, territories: territories.data.map((t) => t.id).sort(), newTerritories: plan.attributes.availableInNewTerritories ?? false };
}

const territoryData = (territories: string[]) => ({ data: territories.map((id) => ({ type: "territories", id })) });

/** Sets where the up-front plan is sold: changes the plan's availability when it has one (`existingId`), else makes it. */
export async function setSubscriptionAvailability(subscriptionId: string, availability: Availability, existingId?: string): Promise<void> {
  if (existingId) {
    await patch(`/v1/subscriptionPlanAvailabilities/${encodeURIComponent(existingId)}`, {
      data: { type: "subscriptionPlanAvailabilities", id: existingId, attributes: { availableInNewTerritories: availability.newTerritories }, relationships: { availableTerritories: territoryData(availability.territories) } },
    });
    return;
  }
  await post("/v1/subscriptionPlanAvailabilities", {
    data: {
      type: "subscriptionPlanAvailabilities",
      attributes: { availableInNewTerritories: availability.newTerritories, planType: PLAN },
      relationships: { availableTerritories: territoryData(availability.territories), subscription: { data: { type: "subscriptions", id: subscriptionId } } },
    },
  });
}
