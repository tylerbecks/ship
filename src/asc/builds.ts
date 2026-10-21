// Builds in App Store Connect: listing them, finding one by number, the
// details `ship builds show` prints, expiring them, and answering export
// compliance.

import type { AscPlatform } from "../platform";
import { type Document, type Resource, api, get, many, relatedMany, relatedOne } from "./client";
import { versionState } from "./versions";

export interface Build {
  id: string;
  /** The build number (CFBundleVersion). */
  number: string;
  /** The app version (CFBundleShortVersionString). */
  version?: string;
  /** The platform the build is for, like IOS or MAC_OS. */
  platform?: AscPlatform;
  uploadedDate: string;
  /** PROCESSING, FAILED, INVALID, or VALID. */
  processingState: string;
  expired: boolean;
  expirationDate?: string;
  usesNonExemptEncryption?: boolean | null;
  /** APP_STORE_ELIGIBLE, or INTERNAL_ONLY for a "TestFlight Internal Only" build. */
  audience?: string;
  /** The lowest OS version the build runs on. */
  minOsVersion?: string;
  /** TestFlight state for internal testers, like IN_BETA_TESTING or MISSING_EXPORT_COMPLIANCE. */
  internalState?: string;
  /** TestFlight state for external testers, like WAITING_FOR_BETA_REVIEW or IN_BETA_TESTING. */
  externalState?: string;
  /**
   * The App Store version the build is attached to (state in appVersionState's
   * terms), or null when it isn't. Only there when the query asked for it
   * (BUILD_USE_QUERY or BUILD_DETAIL_QUERY).
   */
  appStoreVersion?: AttachedVersion | null;
}

/** The App Store version a build is attached to. */
export interface AttachedVersion {
  id: string;
  versionString: string;
  /** appVersionState, like WAITING_FOR_REVIEW or READY_FOR_DISTRIBUTION. */
  state: string;
}

export type BuildAttributes = {
  version: string;
  uploadedDate: string;
  processingState: string;
  expired: boolean;
  expirationDate?: string;
  usesNonExemptEncryption?: boolean | null;
  buildAudienceType?: string;
  minOsVersion?: string;
};

/** A build resource and what was included with it, as a Build. */
export function toBuild(resource: Resource<BuildAttributes>, included: Resource[]): Build {
  const preRelease = relatedOne(resource, "preReleaseVersion", included);
  const beta = relatedOne(resource, "buildBetaDetail", included);
  return {
    id: resource.id,
    number: resource.attributes.version,
    version: preRelease?.attributes.version as string | undefined,
    platform: preRelease?.attributes.platform as AscPlatform | undefined,
    uploadedDate: resource.attributes.uploadedDate,
    processingState: resource.attributes.processingState,
    expired: resource.attributes.expired,
    expirationDate: resource.attributes.expirationDate,
    usesNonExemptEncryption: resource.attributes.usesNonExemptEncryption,
    audience: resource.attributes.buildAudienceType,
    minOsVersion: resource.attributes.minOsVersion,
    internalState: beta?.attributes.internalBuildState as string | undefined,
    externalState: beta?.attributes.externalBuildState as string | undefined,
    // Only when asked for, so status and beta JSON stay as they were.
    ...(resource.relationships && "appStoreVersion" in resource.relationships ? { appStoreVersion: attachedVersion(resource, included) } : {}),
  };
}

/** The App Store version a build is attached to, from an include=appStoreVersion response. */
function attachedVersion(resource: Resource<BuildAttributes>, included: Resource[]): AttachedVersion | null {
  const version = relatedOne(resource, "appStoreVersion", included);
  if (!version) return null;
  const attributes = version.attributes as { versionString?: string; appVersionState?: string | null; appStoreState?: string | null };
  return { id: version.id, versionString: attributes.versionString ?? "", state: versionState(attributes) };
}

const BUILD_FIELDS =
  "version,uploadedDate,processingState,expired,expirationDate,usesNonExemptEncryption,buildAudienceType,minOsVersion,preReleaseVersion,buildBetaDetail";

/** The include and fields parameters every build query uses. */
export const BUILD_QUERY =
  "include=preReleaseVersion,buildBetaDetail" +
  `&fields[builds]=${BUILD_FIELDS}` +
  "&fields[preReleaseVersions]=version,platform" +
  "&fields[buildBetaDetails]=internalBuildState,externalBuildState";

const VERSION_FIELDS = "&fields[appStoreVersions]=versionString,appVersionState,appStoreState";

/** BUILD_QUERY plus the App Store version each build is attached to (what expiring checks). */
export const BUILD_USE_QUERY =
  "include=preReleaseVersion,buildBetaDetail,appStoreVersion" +
  `&fields[builds]=${BUILD_FIELDS},appStoreVersion` +
  "&fields[preReleaseVersions]=version,platform" +
  "&fields[buildBetaDetails]=internalBuildState,externalBuildState" +
  VERSION_FIELDS;

/** Everything `ship builds show` prints: groups, What to Test, Beta App Review, and the App Store version. */
export const BUILD_DETAIL_QUERY =
  "include=preReleaseVersion,buildBetaDetail,betaAppReviewSubmission,appStoreVersion,betaGroups,betaBuildLocalizations" +
  `&fields[builds]=${BUILD_FIELDS},betaAppReviewSubmission,appStoreVersion,betaGroups,betaBuildLocalizations` +
  "&fields[preReleaseVersions]=version,platform" +
  "&fields[buildBetaDetails]=internalBuildState,externalBuildState" +
  "&fields[betaAppReviewSubmissions]=betaReviewState,submittedDate" +
  VERSION_FIELDS +
  "&fields[betaGroups]=name,isInternalGroup" +
  "&fields[betaBuildLocalizations]=locale,whatsNew" +
  // Apple's most for included to-many relationships.
  "&limit[betaGroups]=50&limit[betaBuildLocalizations]=50";

export interface BuildFilter {
  /** The app version (CFBundleShortVersionString), like 1.2. */
  version?: string;
  /** The build number (CFBundleVersion), or several. */
  number?: string | string[];
  platform?: AscPlatform;
  /** Any of PROCESSING, FAILED, INVALID, VALID. */
  processingState?: string[];
  expired?: boolean;
  /** APP_STORE_ELIGIBLE or INTERNAL_ONLY. */
  audience?: string;
  /** How many builds (default 50). More than 200 takes several requests. */
  limit?: number;
  /** Newest upload first unless set: "-uploadedDate", "uploadedDate", "-version", "version", "-preReleaseVersion", "preReleaseVersion". */
  sort?: string;
}

/** The GET /v1/builds path for a filter, with the first page's limit. `query` says what's included. */
export function buildsPath(appId: string, filter: BuildFilter = {}, query = BUILD_QUERY): string {
  const params: string[] = [`filter[app]=${encodeURIComponent(appId)}`];
  // Lists stay comma-separated, as Apple documents them.
  const add = (name: string, value: string | string[] | undefined) => {
    const values = (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter((item) => item !== "");
    if (values.length) params.push(`${name}=${values.map(encodeURIComponent).join(",")}`);
  };
  add("filter[version]", filter.number);
  add("filter[preReleaseVersion.version]", filter.version);
  add("filter[preReleaseVersion.platform]", filter.platform);
  add("filter[processingState]", filter.processingState);
  add("filter[expired]", filter.expired === undefined ? undefined : String(filter.expired));
  add("filter[buildAudienceType]", filter.audience);
  add("sort", filter.sort ?? "-uploadedDate");
  add("limit", String(Math.min(Math.max(1, filter.limit ?? 50), 200)));
  return `/v1/builds?${params.join("&")}&${query}`;
}

/** The app's builds that match the filter, newest upload first unless `sort` says otherwise. */
export async function listBuilds(appId: string, filter: BuildFilter = {}, query = BUILD_QUERY): Promise<Build[]> {
  const limit = Math.max(1, filter.limit ?? 50);
  const builds: Build[] = [];
  let next: string | undefined = buildsPath(appId, filter, query);
  while (next && builds.length < limit) {
    const doc: Document<BuildAttributes> = await get<BuildAttributes>(next);
    builds.push(...many(doc).map((resource) => toBuild(resource, doc.included ?? [])));
    next = doc.links?.next;
  }
  return builds.slice(0, limit);
}

/** The app's most recent builds, newest first. */
export async function recentBuilds(appId: string, limit = 10, platform?: AscPlatform): Promise<Build[]> {
  return listBuilds(appId, { limit, platform });
}

/** One build by its number, if App Store Connect has it (it appears a few minutes after upload). */
export async function findBuild(appId: string, number: string, platform?: AscPlatform): Promise<Build | undefined> {
  const [build] = await listBuilds(appId, { number, platform, limit: 1 });
  return build;
}

/** The highest build number uploaded so far, across every version (and platform, so numbers never collide). */
export async function highestBuildNumber(appId: string): Promise<number> {
  const builds = await recentBuilds(appId, 50);
  return Math.max(0, ...builds.map((build) => Number.parseInt(build.number, 10)).filter(Number.isFinite));
}

// MARK: Details

/** A build with what `ship builds show` prints about it. */
export interface BuildDetail extends Build {
  /** "What to Test" by locale. */
  whatToTest: Record<string, string>;
  /** The groups it was added to, by name. Apple doesn't list internal groups that get every build. */
  groups: string[];
  /** WAITING_FOR_REVIEW, IN_REVIEW, REJECTED, or APPROVED; null when it was never submitted. */
  betaReview: string | null;
  appStoreVersion: AttachedVersion | null;
}

/** A build resource and its included groups, localizations, and review submission, as a BuildDetail. */
export function toBuildDetail(resource: Resource<BuildAttributes>, included: Resource[]): BuildDetail {
  const whatToTest: Record<string, string> = {};
  for (const localization of relatedMany(resource, "betaBuildLocalizations", included)) {
    const { locale, whatsNew } = localization.attributes as { locale?: string; whatsNew?: string | null };
    if (locale) whatToTest[locale] = whatsNew ?? "";
  }
  const review = relatedOne(resource, "betaAppReviewSubmission", included);
  return {
    ...toBuild(resource, included),
    appStoreVersion: attachedVersion(resource, included),
    whatToTest,
    groups: relatedMany(resource, "betaGroups", included).map((group) => String(group.attributes.name ?? group.id)),
    betaReview: (review?.attributes.betaReviewState as string | undefined) ?? null,
  };
}

/**
 * Every build with this number, in detail. Build numbers only have to be
 * unique within a version, so there can be more than one; `version` narrows it.
 */
export async function buildDetails(appId: string, number: string, filter: { version?: string; platform?: AscPlatform } = {}): Promise<BuildDetail[]> {
  const doc = await get<BuildAttributes>(buildsPath(appId, { ...filter, number, limit: 200 }, BUILD_DETAIL_QUERY));
  return many(doc).map((resource) => toBuildDetail(resource, doc.included ?? []));
}

// MARK: Expiring

export const DAY_MS = 24 * 60 * 60 * 1000;

type Expiry = Pick<Build, "expired" | "expirationDate" | "processingState">;

/** Days until a build leaves TestFlight, rounded up: 0 once it has, null when it has no date (still processing, or failed). */
export function daysLeft(build: Expiry, now = Date.now()): number | null {
  if (build.expired) return 0;
  if (build.processingState !== "VALID" || !build.expirationDate) return null;
  const expires = Date.parse(build.expirationDate);
  if (!Number.isFinite(expires)) return null;
  return Math.max(0, Math.ceil((expires - now) / DAY_MS));
}

/** "in 12 days", "in 1 day", "expired", or "" for a build with no date. */
export function expiresLabel(build: Expiry, now = Date.now()): string {
  const days = daysLeft(build, now);
  if (days === null) return "";
  if (days === 0) return "expired";
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/** Takes a build out of TestFlight. Testers can't install it anymore, and it can't be undone. */
export async function expireBuild(buildId: string) {
  await api("PATCH", `/v1/builds/${buildId}`, { data: { type: "builds", id: buildId, attributes: { expired: true } } });
}

// MARK: Export compliance

/** Answers the export compliance question: only exempt encryption. */
export async function setExemptEncryption(buildId: string) {
  await api("PATCH", `/v1/builds/${buildId}`, {
    data: { type: "builds", id: buildId, attributes: { usesNonExemptEncryption: false } },
  });
}
