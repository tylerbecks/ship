// Auto-renewable subscriptions as files in the store folder
// (appstore/subscriptions/), one folder per group, named for its reference
// name, holding its languages and one folder per subscription:
//
//   subscriptions/<group>/<locale>/name.txt  app-name.txt
//   subscriptions/<group>/<product id>/subscription.json   period, level, reference name, Family Sharing, price, availability
//   subscriptions/<group>/<product id>/review-notes.txt
//   subscriptions/<group>/<product id>/<locale>/name.txt  description.txt
//
// A folder with subscription.json in it is a subscription; any other is a
// language (a product id like "pro" looks like one). push makes groups and
// subscriptions and changes them, but never deletes either; --prune deletes
// languages without a folder, and the prices set by hand that a new price
// would replace.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Availability, type OtherPrice, type Price, allTerritories, sameAmount } from "../asc/purchases";
import {
  type GroupLocalization,
  PERIODS,
  type Period,
  type Subscription,
  type SubscriptionGroup,
  type SubscriptionLocalization,
  type SubscriptionUpdate,
  type TerritoryPrice,
  addSubscriptionPrice,
  createGroup,
  createGroupLocalization,
  createSubscription,
  createSubscriptionLocalization,
  deleteGroupLocalization,
  deleteSubscriptionLocalization,
  deleteSubscriptionPrice,
  equalizations,
  groupLocalizations,
  groupSubscriptions,
  listGroups,
  setSubscriptionAvailability,
  subscriptionAvailability,
  subscriptionLocalizations,
  subscriptionPricePoints,
  subscriptionPrices,
  updateGroupLocalization,
  updateSubscription,
  updateSubscriptionLocalization,
} from "../asc/subscriptions";
import type { Project } from "../config";
import { type Change, diffRecord } from "../diff";
import { ShipError, ui } from "../ui";
import { type AvailabilityFile, availabilityJSON, inBatches, jsonSame, parseProductJSON, planPriceAndAvailability, priceAndAvailabilityProblems } from "./catalog";
import { type Problem, chars } from "./check";
import { ASC_LOCALES, LOCALE_PATTERN, isObject, readText, writeText } from "./files";
import { PRODUCT_ID } from "./purchases";

export const SUBSCRIPTION_FILE = "subscription.json";
export const NOTES_FILE = "review-notes.txt";
export const GROUP_FILES = { name: "name.txt", customAppName: "app-name.txt" } as const;
export const SUBSCRIPTION_FILES = { name: "name.txt", description: "description.txt" } as const;

/** Apple's limits for subscriptions. */
export const SUBSCRIPTION_LIMITS = { referenceName: 64, name: 35, description: 55, reviewNote: 4000 };

const KEYS = ["period", "level", "referenceName", "familySharing", "price", "availability"];

export const subscriptionsDir = (project: Project) => join(project.storeDir, "subscriptions");

/** subscription.json, as the repo says it. A missing key isn't managed. */
export interface SubscriptionFile {
  period?: Period;
  /** Its level in the group: 1 is the highest. */
  level?: number;
  referenceName?: string;
  familySharing?: boolean;
  /** One territory's price; Apple's equivalent goes in every other. existingSubscribers: "keep" (the default) leaves current subscribers on what they pay. */
  price?: Price & { existingSubscribers?: "keep" | "update" };
  availability?: AvailabilityFile;
}

export interface LocalSubscription {
  productId: string;
  file: SubscriptionFile;
  unknownKeys: string[];
  notes?: string;
  locales: Record<string, { name?: string; description?: string }>;
}

export interface LocalGroup {
  /** The folder's name: the group's reference name. */
  referenceName: string;
  locales: Record<string, { name?: string; customAppName?: string }>;
  subscriptions: LocalSubscription[];
}

// MARK: Reading the files

const folders = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort()
    : [];

async function readFields<K extends string>(dir: string, files: Record<K, string>): Promise<Partial<Record<K, string>>> {
  const fields: Partial<Record<K, string>> = {};
  for (const [field, file] of Object.entries(files) as [K, string][]) {
    const value = await readText(join(dir, file));
    if (value !== undefined) fields[field] = value;
  }
  return fields;
}

/** Every group folder under `dir`, with its languages and subscriptions. */
export async function readSubscriptions(dir: string): Promise<LocalGroup[]> {
  const groups: LocalGroup[] = [];
  for (const name of folders(dir)) {
    const groupDir = join(dir, name);
    const group: LocalGroup = { referenceName: name, locales: {}, subscriptions: [] };
    for (const entry of folders(groupDir)) {
      const folder = join(groupDir, entry);
      const text = await readText(join(folder, SUBSCRIPTION_FILE));
      if (text === undefined && LOCALE_PATTERN.test(entry)) {
        group.locales[entry] = await readFields(folder, GROUP_FILES);
        continue;
      }
      const json = text === undefined ? {} : parseProductJSON(text, join(folder, SUBSCRIPTION_FILE), "subscriptions");
      const locales: LocalSubscription["locales"] = {};
      for (const locale of folders(folder).filter((f) => LOCALE_PATTERN.test(f))) locales[locale] = await readFields(join(folder, locale), SUBSCRIPTION_FILES);
      group.subscriptions.push({
        productId: entry,
        file: Object.fromEntries(KEYS.filter((key) => key in json).map((key) => [key, json[key]])) as SubscriptionFile,
        unknownKeys: Object.keys(json).filter((key) => !KEYS.includes(key)),
        notes: await readText(join(folder, NOTES_FILE)),
        locales,
      });
    }
    groups.push(group);
  }
  return groups;
}

// MARK: Validating

/** Offline checks of the subscriptions folder. File paths are relative to the store folder. */
export function validateSubscriptions(groups: LocalGroup[]): Problem[] {
  const problems: Problem[] = [];
  const error = (file: string, message: string, field?: string) => problems.push({ file, ...(field ? { field } : {}), message, severity: "error" });
  const warning = (file: string, message: string, field?: string) => problems.push({ file, ...(field ? { field } : {}), message, severity: "warning" });
  const languageWarning = (path: string, locale: string) => {
    if (!ASC_LOCALES.includes(locale)) warning(path, `${locale} isn't a language App Store Connect lists; check the folder's name`);
  };
  const seen = new Map<string, string>();
  for (const group of groups) {
    const base = `subscriptions/${group.referenceName}`;
    if (chars(group.referenceName) > SUBSCRIPTION_LIMITS.referenceName || group.referenceName !== group.referenceName.trim()) {
      error(base, `A group's folder is its reference name: up to ${SUBSCRIPTION_LIMITS.referenceName} characters, no spaces at the ends`);
    }
    for (const [locale, fields] of Object.entries(group.locales)) {
      languageWarning(`${base}/${locale}`, locale);
      if (fields.name !== undefined && !fields.name.trim()) error(`${base}/${locale}/${GROUP_FILES.name}`, "A language needs the group's display name (or no folder)");
    }
    for (const subscription of group.subscriptions) {
      const folder = `${base}/${subscription.productId}`;
      const json = `${folder}/${SUBSCRIPTION_FILE}`;
      const { file } = subscription;
      if (!PRODUCT_ID.test(subscription.productId)) error(folder, `"${subscription.productId}" isn't a product id: use letters, digits, periods, and underscores`);
      const other = seen.get(subscription.productId);
      if (other) error(folder, `${subscription.productId} is also in ${other}; a product id is in one group`);
      seen.set(subscription.productId, base);
      if (file.period !== undefined && !(PERIODS as readonly string[]).includes(file.period)) error(json, `period is one of ${PERIODS.join(", ")}, not ${JSON.stringify(file.period)}`, "period");
      if (file.level !== undefined && !(Number.isInteger(file.level) && file.level >= 1)) error(json, "level is a whole number from 1 (the highest)", "level");
      if (file.referenceName !== undefined && (typeof file.referenceName !== "string" || !file.referenceName.trim())) error(json, "referenceName should be text", "referenceName");
      else if (file.referenceName && chars(file.referenceName) > SUBSCRIPTION_LIMITS.referenceName) error(json, `referenceName is ${chars(file.referenceName)} characters; the most is ${SUBSCRIPTION_LIMITS.referenceName}`, "referenceName");
      if (file.familySharing !== undefined && typeof file.familySharing !== "boolean") error(json, "familySharing should be true or false", "familySharing");
      problems.push(...priceAndAvailabilityProblems(json, file.price, file.availability));
      const existing = isObject(file.price) ? file.price.existingSubscribers : undefined;
      if (existing !== undefined && existing !== "keep" && existing !== "update") error(json, 'price.existingSubscribers is "keep" (they go on paying what they pay) or "update"', "price.existingSubscribers");
      for (const key of subscription.unknownKeys) warning(json, `${key} isn't a subscription field; ship ignores it`, key);
      if (subscription.notes && chars(subscription.notes) > SUBSCRIPTION_LIMITS.reviewNote) warning(`${folder}/${NOTES_FILE}`, `The notes are ${chars(subscription.notes)} characters; App Review takes up to ${SUBSCRIPTION_LIMITS.reviewNote}`);
      for (const [locale, fields] of Object.entries(subscription.locales)) {
        const at = (field: keyof typeof SUBSCRIPTION_FILES) => `${folder}/${locale}/${SUBSCRIPTION_FILES[field]}`;
        languageWarning(`${folder}/${locale}`, locale);
        if (fields.name !== undefined && !fields.name.trim()) error(at("name"), "A language needs a display name (or no folder)");
        if (fields.name && chars(fields.name) > SUBSCRIPTION_LIMITS.name) error(at("name"), `The display name is ${chars(fields.name)} characters; the most is ${SUBSCRIPTION_LIMITS.name}`);
        if (fields.description && chars(fields.description) > SUBSCRIPTION_LIMITS.description) error(at("description"), `The description is ${chars(fields.description)} characters; the most is ${SUBSCRIPTION_LIMITS.description}`);
      }
    }
  }
  return problems;
}

// MARK: What App Store Connect has

export interface RemoteSubscription {
  subscription: Subscription;
  localizations: SubscriptionLocalization[];
  /** Today's price in each territory, and the ones scheduled to start later. */
  prices: { current: TerritoryPrice[]; scheduled: TerritoryPrice[] };
  availability: (Availability & { id: string }) | null;
}

export interface RemoteGroup {
  group: SubscriptionGroup;
  localizations: GroupLocalization[];
  subscriptions: RemoteSubscription[];
}

/**
 * Every group with its languages and subscriptions; `only` limits the
 * subscriptions to these product ids. Every group stays, even with none of
 * them: a new subscription goes in a group that already exists.
 */
export async function fetchSubscriptions(appId: string, only?: string[]): Promise<{ groups: RemoteGroup[]; territories: string[] }> {
  const [list, territories] = await Promise.all([listGroups(appId), allTerritories()]);
  const groups = await inBatches(list, 3, async (group) => {
    const [localizations, subscriptions] = await Promise.all([groupLocalizations(group.id), groupSubscriptions(group.id)]);
    const wanted = subscriptions.filter((s) => !only?.length || only.includes(s.productId));
    const remote = await inBatches(wanted, 5, async (subscription) => {
      const [locs, prices, availability] = await Promise.all([subscriptionLocalizations(subscription.id), subscriptionPrices(subscription.id), subscriptionAvailability(subscription.id)]);
      return { subscription, localizations: locs, prices, availability };
    });
    return { group, localizations, subscriptions: remote };
  });
  return { groups, territories };
}

/** The territory pull writes a subscription's price in: the US when it has one there, else its first. */
const baseTerritory = (current: TerritoryPrice[]) => (current.find((p) => p.territory === "USA") ?? current[0])?.territory;

/** The files for what App Store Connect has, by path in the subscriptions folder. */
export function filesFromRemote(group: RemoteGroup, territories: string[]): Map<string, string> {
  const files = new Map<string, string>();
  const base = group.group.referenceName;
  for (const localization of [...group.localizations].sort((a, b) => a.locale.localeCompare(b.locale))) {
    files.set(`${base}/${localization.locale}/${GROUP_FILES.name}`, localization.name);
    files.set(`${base}/${localization.locale}/${GROUP_FILES.customAppName}`, localization.customAppName ?? "");
  }
  for (const remote of group.subscriptions) {
    const { subscription, prices } = remote;
    const folder = `${base}/${subscription.productId}`;
    const territory = baseTerritory(prices.current);
    const price = prices.current.find((p) => p.territory === territory);
    const json: SubscriptionFile = {
      ...(subscription.period ? { period: subscription.period } : {}),
      ...(subscription.level !== null ? { level: subscription.level } : {}),
      referenceName: subscription.referenceName,
      familySharing: subscription.familySharable,
      ...(price ? { price: { territory: price.territory, amount: price.amount } } : {}),
      ...(remote.availability ? { availability: availabilityJSON(remote.availability, territories) } : {}),
    };
    files.set(`${folder}/${SUBSCRIPTION_FILE}`, `${JSON.stringify(json, null, 2)}\n`);
    files.set(`${folder}/${NOTES_FILE}`, subscription.reviewNote ?? "");
    for (const localization of [...remote.localizations].sort((a, b) => a.locale.localeCompare(b.locale))) {
      files.set(`${folder}/${localization.locale}/${SUBSCRIPTION_FILES.name}`, localization.name);
      files.set(`${folder}/${localization.locale}/${SUBSCRIPTION_FILES.description}`, localization.description ?? "");
    }
  }
  return files;
}

/**
 * The prices a new price in `territory` would replace without the files
 * showing them: scheduled ones, and territories whose price isn't Apple's
 * equivalent of today's price in `territory` (set by hand). Asks Apple for
 * that equivalent.
 */
export async function handSetPrices(subscriptionId: string, prices: RemoteSubscription["prices"], territory: string): Promise<(OtherPrice & { id: string })[]> {
  const show = (p: TerritoryPrice) => ({ id: p.id, territory: p.territory, amount: p.amount, startDate: p.startDate, endDate: null });
  const base = prices.current.find((p) => p.territory === territory);
  // With no price in the file's territory yet, every other territory's price is one the new price would replace.
  const equal = base ? new Map((await equalizations(subscriptionId, base.pointId)).map((p) => [p.territory, p.id])) : new Map<string, string>();
  const others = prices.current.filter((p) => p.territory !== territory && equal.get(p.territory) !== p.pointId);
  return [...others, ...prices.scheduled].map(show);
}

// MARK: Planning

export interface SubscriptionPlan {
  productId: string;
  create?: { referenceName: string; period: Period; level?: number; familySharable?: boolean; reviewNote?: string | null };
  id?: string;
  update: SubscriptionUpdate;
  localizations: {
    create: { locale: string; name: string; description?: string | null }[];
    update: { locale: string; id: string; attributes: { name?: string; description?: string | null } }[];
    delete: { locale: string; id: string }[];
  };
  price?: Price & { preserve: boolean };
  /** Scheduled prices to delete before the new price (--prune). */
  deletePrices: string[];
  availability?: Availability;
  availabilityId?: string;
}

export interface GroupPlan {
  referenceName: string;
  /** The existing group's id; undefined when push makes it. */
  id?: string;
  localizations: {
    create: { locale: string; name: string; customAppName?: string | null }[];
    update: { locale: string; id: string; attributes: { name?: string; customAppName?: string | null } }[];
    delete: { locale: string; id: string }[];
  };
  subscriptions: SubscriptionPlan[];
}

export interface SubscriptionsPlan {
  changes: Change[];
  groups: GroupPlan[];
  /** Groups and subscriptions in App Store Connect with no folder here (push leaves them alone). */
  onlyRemote: string[];
  /** Languages in App Store Connect with no folder, left alone without --prune. */
  onlyRemoteLocales: string[];
}

/** Language creates, updates, and (with prune) deletes for one thing's languages. */
function planLocales(
  scope: string,
  local: Record<string, Record<string, string | undefined>>,
  remote: readonly { id: string; locale: string }[],
  fields: string[],
  options: { prune?: boolean; what: string },
  plan: SubscriptionsPlan,
) {
  const result = { create: [] as ({ locale: string } & Record<string, string | null | undefined>)[], update: [] as { locale: string; id: string; attributes: Record<string, string | null> }[], delete: [] as { locale: string; id: string }[] };
  const byLocale = new Map(remote.map((r) => [r.locale, r]));
  for (const [locale, values] of Object.entries(local)) {
    const current = byLocale.get(locale);
    const changes = diffRecord(`${scope}/${locale}`, current ? Object.fromEntries(fields.map((f) => [f, (current as unknown as Record<string, unknown>)[f]])) : undefined, values);
    if (!changes.length) continue;
    plan.changes.push(...changes);
    if (current) result.update.push({ locale, id: current.id, attributes: Object.fromEntries(changes.map((c) => [c.field, (c.to as string | undefined) ?? null])) });
    else if (!values.name) throw new ShipError(`${scope}/${locale} has no name.txt, and a new language needs ${options.what}`, "missing-subscription-fields", `Write ${scope}/${locale}/name.txt.`, { locale });
    else result.create.push({ locale, ...Object.fromEntries(Object.entries(values).filter(([, v]) => v)) });
  }
  for (const localization of remote) {
    if (localization.locale in local) continue;
    if (options.prune) {
      result.delete.push({ locale: localization.locale, id: localization.id });
      plan.changes.push({ scope: `${scope}/${localization.locale}`, field: "localization", kind: "remove", from: localization.locale, to: null });
    } else plan.onlyRemoteLocales.push(`${scope.replace(/^subscriptions\//, "")}/${localization.locale}`);
  }
  return result;
}

/**
 * What would change, from the folders (`local`) to App Store Connect
 * (`remote`). `handSet` has, by product id, the prices a new price would
 * replace (see handSetPrices). Pure: it asks nothing.
 */
export function planSubscriptions(
  local: LocalGroup[],
  remote: RemoteGroup[],
  territories: string[],
  options: { prune?: boolean; handSet?: Record<string, (OtherPrice & { id: string })[]>; groupLanguages?: boolean } = {},
): SubscriptionsPlan {
  const plan: SubscriptionsPlan = { changes: [], groups: [], onlyRemote: [], onlyRemoteLocales: [] };
  const byName = new Map(remote.map((g) => [g.group.referenceName, g]));
  const remoteSubscription = (productId: string) => remote.flatMap((g) => g.subscriptions.map((s) => ({ group: g.group.referenceName, ...s }))).find((s) => s.subscription.productId === productId);
  for (const group of local) {
    const existing = byName.get(group.referenceName);
    const scope = `subscriptions/${group.referenceName}`;
    const item: GroupPlan = { referenceName: group.referenceName, ...(existing ? { id: existing.group.id } : {}), localizations: { create: [], update: [], delete: [] }, subscriptions: [] };
    if (!existing) plan.changes.push({ scope, field: "group", kind: "add", to: group.referenceName });
    // With --product, only those subscriptions are in play: an existing group's languages are left alone (a new group still gets its own).
    if (options.groupLanguages !== false || !existing) {
      item.localizations = planLocales(scope, group.locales, existing?.localizations ?? [], ["name", "customAppName"], { prune: options.prune, what: "the group's display name" }, plan) as GroupPlan["localizations"];
    }

    for (const subscription of group.subscriptions) {
      const sscope = `${scope}/${subscription.productId}`;
      const found = remoteSubscription(subscription.productId);
      if (found && found.group !== group.referenceName) {
        throw new ShipError(
          `${subscription.productId} is in the group ${found.group} in App Store Connect, not ${group.referenceName}`,
          "subscription-group-fixed",
          `A subscription can't move to another group. Move its folder to subscriptions/${found.group}/.`,
          { productId: subscription.productId, group: found.group },
        );
      }
      const { file } = subscription;
      const sub: SubscriptionPlan = { productId: subscription.productId, update: {}, localizations: { create: [], update: [], delete: [] }, deletePrices: [] };
      if (!found) {
        if (!file.period || !file.referenceName) {
          throw new ShipError(`${sscope} isn't in App Store Connect yet, and making it needs a period and a referenceName`, "missing-subscription-fields", `Add them to ${sscope}/${SUBSCRIPTION_FILE}, like { "period": "ONE_MONTH", "referenceName": "Monthly" }.`, { productId: subscription.productId });
        }
        sub.create = {
          referenceName: file.referenceName,
          period: file.period,
          ...(file.level !== undefined ? { level: file.level } : {}),
          ...(file.familySharing !== undefined ? { familySharable: file.familySharing } : {}),
          ...(subscription.notes ? { reviewNote: subscription.notes } : {}),
        };
        plan.changes.push({ scope: sscope, field: "subscription", kind: "add", to: `${file.period} "${file.referenceName}"` });
        for (const [field, value] of [["level", file.level], ["familySharing", file.familySharing], ["reviewNotes", subscription.notes || undefined]] as const) {
          if (value !== undefined) plan.changes.push({ scope: sscope, field, kind: "add", to: value });
        }
      } else {
        sub.id = found.subscription.id;
        if (file.familySharing === false && found.subscription.familySharable) {
          throw new ShipError(`${sscope} has Family Sharing on, and Apple doesn't let it go off again`, "family-sharing-fixed", `Set "familySharing": true in ${sscope}/${SUBSCRIPTION_FILE}.`, { productId: subscription.productId });
        }
        // Changes name the files' fields; the update takes Apple's.
        const desired: Record<string, unknown> = {};
        if (file.referenceName !== undefined) desired.referenceName = file.referenceName;
        if (file.period !== undefined) desired.period = file.period;
        if (file.level !== undefined) desired.level = file.level;
        if (file.familySharing !== undefined) desired.familySharing = file.familySharing;
        if (subscription.notes !== undefined) desired.reviewNotes = subscription.notes;
        const s = found.subscription;
        const changes = diffRecord(sscope, { referenceName: s.referenceName, period: s.period, level: s.level, familySharing: s.familySharable, reviewNotes: s.reviewNote }, desired);
        const apiField: Record<string, keyof SubscriptionUpdate> = { referenceName: "name", period: "subscriptionPeriod", level: "groupLevel", familySharing: "familySharable", reviewNotes: "reviewNote" };
        for (const change of changes) (sub.update as Record<string, unknown>)[apiField[change.field]!] = change.to ?? null;
        plan.changes.push(...changes);
      }
      sub.localizations = planLocales(sscope, subscription.locales, found?.localizations ?? [], ["name", "description"], { prune: options.prune, what: "a display name" }, plan) as SubscriptionPlan["localizations"];

      const filePrice = file.price ? { territory: file.price.territory, amount: file.price.amount } : undefined;
      const current = found && filePrice ? (found.prices.current.find((p) => p.territory === filePrice.territory) ?? null) : null;
      const handSet = (found && options.handSet?.[subscription.productId]) || [];
      const priced = planPriceAndAvailability(
        sscope,
        subscription.productId,
        { price: filePrice, availability: file.availability },
        found ? { price: current ? { territory: current.territory, amount: current.amount } : null, otherPrices: handSet, availability: found.availability } : null,
        territories,
        options,
      );
      plan.changes.push(...priced.changes);
      if (priced.price) {
        sub.price = { ...priced.price, preserve: file.price?.existingSubscribers !== "update" };
        sub.deletePrices = handSet.filter((p) => p.startDate && found?.prices.scheduled.some((s) => s.id === p.id)).map((p) => p.id);
      }
      if (priced.availability) {
        sub.availability = priced.availability;
        if (found?.availability) sub.availabilityId = found.availability.id;
      }
      if (sub.create || Object.keys(sub.update).length || sub.price || sub.availability || Object.values(sub.localizations).some((l) => l.length)) item.subscriptions.push(sub);
    }
    if (!existing || item.subscriptions.length || Object.values(item.localizations).some((l) => l.length)) plan.groups.push(item);
  }
  const localNames = new Set(local.map((g) => g.referenceName));
  const localProducts = new Set(local.flatMap((g) => g.subscriptions.map((s) => s.productId)));
  for (const group of remote) {
    if (!localNames.has(group.group.referenceName)) plan.onlyRemote.push(group.group.referenceName);
    else for (const s of group.subscriptions) if (!localProducts.has(s.subscription.productId)) plan.onlyRemote.push(`${group.group.referenceName}/${s.subscription.productId}`);
  }
  return plan;
}

// MARK: pull, diff, push

export interface SubscriptionsPullResult {
  dir: string;
  written: string[];
  unchanged: string[];
}

/** Writes what App Store Connect has into the subscriptions folder. A file that differs is local work: pull stops and names it, unless `force`. */
export async function pullSubscriptions(project: Project, options: { appId: string; products?: string[]; force?: boolean }): Promise<SubscriptionsPullResult> {
  const dir = subscriptionsDir(project);
  const fetched = await fetchSubscriptions(options.appId, options.products);
  const { territories } = fetched;
  // With --product, only the groups holding those subscriptions are written.
  const groups = options.products?.length ? fetched.groups.filter((g) => g.subscriptions.length) : fetched.groups;
  // A folder name can't hold a slash, ".." would write outside the folder, and a leading dot is a folder ship skips.
  const nested = groups.filter((g) => {
    const name = g.group.referenceName;
    return !name || /[/\\]/.test(name) || name !== name.trim() || name.startsWith(".");
  });
  if (nested.length) {
    throw new ShipError(
      `A group's folder is its reference name, and ${nested.map((g) => JSON.stringify(g.group.referenceName)).join(", ")} can't be a folder name`,
      "bad-group-name",
      "Rename the group in App Store Connect (no slashes, no spaces at the ends, not starting with a dot), then pull again.",
      { groups: nested.map((g) => g.group.referenceName) },
    );
  }
  const found = new Set(groups.flatMap((g) => g.subscriptions.map((s) => s.subscription.productId)));
  const missing = (options.products ?? []).filter((id) => !found.has(id));
  if (missing.length) throw new ShipError(`App Store Connect has no subscription ${missing.join(", ")}`, "no-subscription", "`ship subscriptions pull` without --product writes every one.", { missing });
  const files = new Map<string, string>();
  for (const group of groups) for (const [path, text] of filesFromRemote(group, territories)) files.set(path, text);
  const written: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
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
      "See what differs with `ship subscriptions diff`, send it with `ship subscriptions push`, or replace it with App Store Connect's with `ship subscriptions pull --force`.",
      { files: conflicts },
    );
  }
  for (const path of written) await writeText(join(dir, path), files.get(path)!);
  return { dir, written, unchanged };
}

/** Reads the folder, checks it, and compares it with App Store Connect. Stops on validation errors before asking App Store Connect anything. */
export async function diffSubscriptions(project: Project, options: { appId: string; products?: string[]; prune?: boolean }) {
  const dir = subscriptionsDir(project);
  if (!existsSync(dir)) throw new ShipError(`There's no ${dir} yet`, "no-store", "Start it from App Store Connect with `ship subscriptions pull`, or make subscriptions/<group>/<product id>/subscription.json.");
  const all = await readSubscriptions(dir);
  const known = all.flatMap((g) => g.subscriptions.map((s) => s.productId));
  for (const id of options.products ?? []) {
    if (!known.includes(id)) throw new ShipError(`There's no subscription folder for ${id}`, "usage", known.length ? `Pass one of: ${known.join(", ")}` : "Make one, or `ship subscriptions pull`.", { choices: known }, 2);
  }
  const local = options.products?.length ? all.map((g) => ({ ...g, subscriptions: g.subscriptions.filter((s) => options.products!.includes(s.productId)) })).filter((g) => g.subscriptions.length) : all;
  const errors = validateSubscriptions(local).filter((p) => p.severity === "error");
  if (errors.length) {
    throw new ShipError(`subscriptions/ has ${errors.length} problem${errors.length === 1 ? "" : "s"}: ${errors[0]!.file}: ${errors[0]!.message}`, "invalid-store", "See them all with `ship subscriptions validate`.", { problems: errors });
  }
  const { groups: remote, territories } = await fetchSubscriptions(options.appId, options.products);
  // Only a price change can replace hand-set prices, so only then is Apple asked which there are.
  const handSet: Record<string, (OtherPrice & { id: string })[]> = {};
  for (const group of local) {
    for (const subscription of group.subscriptions) {
      const price = subscription.file.price;
      const found = remote.flatMap((g) => g.subscriptions).find((s) => s.subscription.productId === subscription.productId);
      if (!price || !found) continue;
      const current = found.prices.current.find((p) => p.territory === price.territory);
      if (current && sameAmount(current.amount, price.amount)) continue;
      handSet[subscription.productId] = await handSetPrices(found.subscription.id, found.prices, price.territory);
    }
  }
  const plan = planSubscriptions(local, remote, territories, { prune: options.prune, handSet, groupLanguages: !options.products?.length });
  // With --product, every other group and subscription is out of play, not only in App Store Connect.
  if (options.products?.length) plan.onlyRemote = [];
  return { plan, territories };
}

export interface SubscriptionsPushResult {
  changes: Change[];
  applied: boolean;
  created: string[];
  onlyRemote: string[];
  onlyRemoteLocales: string[];
}

/** The price point for `price`, or an error naming the nearest amounts. */
async function pricePointFor(subscriptionId: string, productId: string, price: Price): Promise<string> {
  const points = await subscriptionPricePoints(subscriptionId, price.territory);
  const match = points.find((point) => sameAmount(point.amount, price.amount));
  if (match) return match.id;
  const near = [...points].sort((a, b) => Math.abs(Number(a.amount) - Number(price.amount)) - Math.abs(Number(b.amount) - Number(price.amount))).slice(0, 4).map((p) => p.amount).sort((a, b) => Number(a) - Number(b));
  throw new ShipError(
    `${price.amount} isn't a price ${price.territory} can have for ${productId}`,
    "no-price-point",
    near.length ? `Apple's nearest prices there: ${near.join(", ")}. Set one in ${productId}'s ${SUBSCRIPTION_FILE}.` : `${price.territory} has no prices for it; check the territory.`,
    { productId, territory: price.territory, nearest: near },
  );
}

/**
 * Adds Apple's equivalent of the price in every other territory, then the
 * price in its own. The file's territory goes last: a push that fails
 * partway leaves it on the old price, so the next diff still shows the
 * change and the next push redoes the set.
 */
async function setPrice(subscriptionId: string, territory: string, pointId: string, preserve: boolean): Promise<void> {
  const others = (await equalizations(subscriptionId, pointId)).filter((p) => p.territory && p.territory !== territory);
  await inBatches(others, 5, (point) => addSubscriptionPrice(subscriptionId, point.territory, point.id, preserve));
  await addSubscriptionPrice(subscriptionId, territory, pointId, preserve);
}

/** Sends the subscriptions folder to App Store Connect (or with dryRun, says what it would send). */
export async function pushSubscriptions(project: Project, options: { appId: string; products?: string[]; prune?: boolean; dryRun?: boolean }): Promise<SubscriptionsPushResult> {
  const { plan } = await diffSubscriptions(project, options);
  const result: SubscriptionsPushResult = {
    changes: plan.changes,
    applied: false,
    created: plan.groups.flatMap((g) => g.subscriptions.filter((s) => s.create).map((s) => s.productId)),
    onlyRemote: plan.onlyRemote,
    onlyRemoteLocales: plan.onlyRemoteLocales,
  };
  if (options.dryRun || !plan.changes.length) return result;
  // Prices of subscriptions that exist are found before anything changes, so a price Apple doesn't have stops the push untouched.
  const points = new Map<string, string>();
  for (const group of plan.groups) for (const s of group.subscriptions) if (s.price && s.id) points.set(s.productId, await pricePointFor(s.id, s.productId, s.price));

  const created: string[] = [];
  for (const group of plan.groups) {
    let groupId = group.id;
    if (!groupId) {
      ui.step(`Making the group ${group.referenceName}`);
      groupId = (await createGroup(options.appId, group.referenceName)).id;
    }
    for (const l of group.localizations.update) await updateGroupLocalization(l.id, l.attributes);
    for (const { locale, ...attributes } of group.localizations.create) await createGroupLocalization(groupId, locale, attributes);
    for (const l of group.localizations.delete) await deleteGroupLocalization(l.id);

    for (const s of group.subscriptions) {
      let id = s.id;
      if (s.create) {
        ui.step(`Making ${s.productId}`);
        id = (await createSubscription(groupId, { productId: s.productId, ...s.create })).id;
        created.push(s.productId);
        // Its price points exist only now; a price Apple doesn't have stops here, before its languages and the rest.
        if (s.price) {
          try {
            points.set(s.productId, await pricePointFor(id, s.productId, s.price));
          } catch (error) {
            if (!(error instanceof ShipError)) throw error;
            throw new ShipError(error.message, error.code, `${s.productId} was made, without its languages, price, or where it's sold. ${error.hint ?? ""} Then push again; it carries on from there.`.trim(), { ...error.details, created });
          }
        }
      } else if (Object.keys(s.update).length) {
        ui.step(`Updating ${s.productId}`);
        await updateSubscription(id!, s.update);
      }
      for (const l of s.localizations.update) await updateSubscriptionLocalization(l.id, l.attributes);
      for (const { locale, ...attributes } of s.localizations.create) await createSubscriptionLocalization(id!, locale, attributes);
      for (const l of s.localizations.delete) await deleteSubscriptionLocalization(l.id);
      if (s.price) {
        for (const price of s.deletePrices) await deleteSubscriptionPrice(price);
        ui.step(`Setting ${s.productId}'s price to ${s.price.amount} in ${s.price.territory}, and Apple's equivalent everywhere else`);
        await setPrice(id!, s.price.territory, points.get(s.productId)!, s.price.preserve);
      }
      if (s.availability) {
        ui.step(`Setting where ${s.productId} is sold`);
        await setSubscriptionAvailability(id!, s.availability, s.availabilityId);
      }
    }
  }
  result.applied = true;
  return result;
}
