// The App Store page's text and settings in App Store Connect: the app's
// content rights, the App Info (categories, age rating, and per-language
// name, subtitle, and privacy URLs), and the version's per-language text and
// App Review details. Read by `ship metadata pull|diff`, written by push.

import { AscError, type Resource, all, get, one, relationshipId } from "./client";

const id = (value: string) => encodeURIComponent(value);

/** A JSON:API body for a PATCH. */
const update = (type: string, resourceId: string, attributes: Record<string, unknown>) => ({ data: { type, id: resourceId, attributes } });

/** undefined for a 404, so a missing to-one resource (no review details yet) reads as none. */
async function orNone<T>(request: Promise<T>): Promise<T | undefined> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof AscError && error.status === 404) return undefined;
    throw error;
  }
}

// MARK: App

export interface AppRecord {
  id: string;
  name: string;
  /** The language App Store Connect falls back to; it can't be deleted. */
  primaryLocale: string;
  contentRights: string | null;
}

export async function appRecord(appId: string): Promise<AppRecord> {
  const app = one(await get<{ name?: string; primaryLocale?: string; contentRightsDeclaration?: string | null }>(
    `/v1/apps/${id(appId)}?fields[apps]=name,primaryLocale,contentRightsDeclaration`,
  ));
  return {
    id: app?.id ?? appId,
    name: app?.attributes.name ?? "",
    primaryLocale: app?.attributes.primaryLocale ?? "en-US",
    contentRights: app?.attributes.contentRightsDeclaration ?? null,
  };
}

export const appPath = (appId: string) => `/v1/apps/${id(appId)}`;
export const appBody = (appId: string, attributes: Record<string, unknown>) => update("apps", appId, attributes);

// MARK: Categories

/** The App Info's category relationships, by name, as app.json holds them. */
export interface Categories {
  primary: string | null;
  primarySubcategories: string[];
  secondary: string | null;
  secondarySubcategories: string[];
}

/** The App Info relationships that hold categories. */
export const CATEGORY_RELATIONSHIPS = {
  primary: "primaryCategory",
  primarySubcategories: ["primarySubcategoryOne", "primarySubcategoryTwo"],
  secondary: "secondaryCategory",
  secondarySubcategories: ["secondarySubcategoryOne", "secondarySubcategoryTwo"],
} as const;

const ALL_CATEGORY_RELATIONSHIPS = ["primaryCategory", "primarySubcategoryOne", "primarySubcategoryTwo", "secondaryCategory", "secondarySubcategoryOne", "secondarySubcategoryTwo"];

/** The categories an App Info resource points at. */
export function toCategories(info: Resource<any>): Categories {
  const ids = (names: readonly string[]) => names.map((name) => relationshipId(info, name)).filter((value): value is string => Boolean(value));
  return {
    primary: relationshipId(info, CATEGORY_RELATIONSHIPS.primary) ?? null,
    primarySubcategories: ids(CATEGORY_RELATIONSHIPS.primarySubcategories),
    secondary: relationshipId(info, CATEGORY_RELATIONSHIPS.secondary) ?? null,
    secondarySubcategories: ids(CATEGORY_RELATIONSHIPS.secondarySubcategories),
  };
}

export async function appInfoCategories(appInfoId: string): Promise<Categories> {
  const list = ALL_CATEGORY_RELATIONSHIPS.join(",");
  const info = one(await get(`/v1/appInfos/${id(appInfoId)}?fields[appInfos]=${list}&include=${list}&fields[appCategories]=platforms`));
  return info ? toCategories(info) : { primary: null, primarySubcategories: [], secondary: null, secondarySubcategories: [] };
}

/**
 * The relationships a PATCH of an App Info sends to change categories. Only
 * the parts in `changed` are sent; a missing subcategory slot is cleared.
 */
export function categoriesBody(appInfoId: string, desired: Partial<Categories>) {
  const link = (category: string | null | undefined) => ({ data: category ? { type: "appCategories", id: category } : null });
  const relationships: Record<string, { data: { type: string; id: string } | null }> = {};
  if (desired.primary !== undefined) relationships.primaryCategory = link(desired.primary);
  if (desired.secondary !== undefined) relationships.secondaryCategory = link(desired.secondary);
  for (const key of ["primarySubcategories", "secondarySubcategories"] as const) {
    const list = desired[key];
    if (list === undefined) continue;
    CATEGORY_RELATIONSHIPS[key].forEach((name, index) => {
      relationships[name] = link(list[index]);
    });
  }
  return { data: { type: "appInfos", id: appInfoId, relationships } };
}

export const appInfoPath = (appInfoId: string) => `/v1/appInfos/${id(appInfoId)}`;

/** Top-level category ids on a platform, each with its subcategory ids. */
export async function appCategories(platform: string): Promise<Map<string, string[]>> {
  const { data } = await all(`/v1/appCategories?filter[platforms]=${platform}&exists[parent]=false&include=subcategories&limit[subcategories]=50&limit=200`);
  const categories = new Map<string, string[]>();
  for (const category of data) {
    const subs = category.relationships?.subcategories?.data;
    categories.set(category.id, Array.isArray(subs) ? subs.map((link) => link.id) : []);
  }
  return categories;
}

// MARK: Age rating

export interface AgeRating {
  id: string;
  attributes: Record<string, unknown>;
}

/** The App Info's age rating declaration (there's no GET by its own id). */
export async function ageRating(appInfoId: string): Promise<AgeRating | undefined> {
  const doc = await orNone(get(`/v1/appInfos/${id(appInfoId)}/ageRatingDeclaration`));
  const declaration = one(doc);
  return declaration ? { id: declaration.id, attributes: declaration.attributes } : undefined;
}

export const ageRatingPath = (declarationId: string) => `/v1/ageRatingDeclarations/${id(declarationId)}`;
export const ageRatingBody = (declarationId: string, attributes: Record<string, unknown>) => update("ageRatingDeclarations", declarationId, attributes);

// MARK: Localizations

/** One language of the App Info or of a version. */
export interface Localization {
  id: string;
  locale: string;
  attributes: Record<string, unknown>;
}

const APP_INFO_LOCALIZATION_FIELDS = ["locale", "name", "subtitle", "privacyPolicyUrl", "privacyChoicesUrl"];
const VERSION_LOCALIZATION_FIELDS = ["locale", "description", "keywords", "marketingUrl", "promotionalText", "supportUrl", "whatsNew"];

const toLocalization = (resource: Resource): Localization => ({
  id: resource.id,
  locale: String(resource.attributes.locale ?? ""),
  attributes: resource.attributes,
});

export async function appInfoLocalizations(appInfoId: string): Promise<Localization[]> {
  const { data } = await all(
    `/v1/appInfos/${id(appInfoId)}/appInfoLocalizations?fields[appInfoLocalizations]=${APP_INFO_LOCALIZATION_FIELDS.join(",")}&limit=200`,
  );
  return data.map(toLocalization);
}

export async function versionLocalizations(versionId: string): Promise<Localization[]> {
  const { data } = await all(
    `/v1/appStoreVersions/${id(versionId)}/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=${VERSION_LOCALIZATION_FIELDS.join(",")}&limit=200`,
  );
  return data.map(toLocalization);
}

export const APP_INFO_LOCALIZATIONS = "/v1/appInfoLocalizations";
export const VERSION_LOCALIZATIONS = "/v1/appStoreVersionLocalizations";
export const localizationPath = (base: string, localizationId: string) => `${base}/${id(localizationId)}`;

export const appInfoLocalizationBody = (localizationId: string, attributes: Record<string, unknown>) => update("appInfoLocalizations", localizationId, attributes);
export const versionLocalizationBody = (localizationId: string, attributes: Record<string, unknown>) =>
  update("appStoreVersionLocalizations", localizationId, attributes);

/** A POST body for a new App Info language (name is required). */
export const newAppInfoLocalization = (appInfoId: string, attributes: Record<string, unknown>) => ({
  data: { type: "appInfoLocalizations", attributes, relationships: { appInfo: { data: { type: "appInfos", id: appInfoId } } } },
});

/** A POST body for a new version language. */
export const newVersionLocalization = (versionId: string, attributes: Record<string, unknown>) => ({
  data: { type: "appStoreVersionLocalizations", attributes, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } } },
});

// MARK: Versions

export const versionPath = (versionId: string) => `/v1/appStoreVersions/${id(versionId)}`;
export const versionBody = (versionId: string, attributes: Record<string, unknown>) => update("appStoreVersions", versionId, attributes);

// MARK: App Review

export interface ReviewDetail {
  id: string;
  attributes: Record<string, unknown>;
}

const REVIEW_FIELDS = ["contactFirstName", "contactLastName", "contactPhone", "contactEmail", "demoAccountName", "demoAccountPassword", "demoAccountRequired", "notes"];

/** The version's App Review contact, demo account, and notes; undefined when none were ever entered. */
export async function reviewDetail(versionId: string): Promise<ReviewDetail | undefined> {
  const doc = await orNone(get(`/v1/appStoreVersions/${id(versionId)}/appStoreReviewDetail?fields[appStoreReviewDetails]=${REVIEW_FIELDS.join(",")}`));
  const detail = one(doc);
  return detail ? { id: detail.id, attributes: detail.attributes } : undefined;
}

export const REVIEW_DETAILS = "/v1/appStoreReviewDetails";
export const reviewDetailPath = (detailId: string) => `${REVIEW_DETAILS}/${id(detailId)}`;
export const reviewDetailBody = (detailId: string, attributes: Record<string, unknown>) => update("appStoreReviewDetails", detailId, attributes);
export const newReviewDetail = (versionId: string, attributes: Record<string, unknown>) => ({
  data: { type: "appStoreReviewDetails", attributes, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } } },
});
