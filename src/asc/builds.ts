// Builds in App Store Connect: listing them, finding one by number, and
// answering export compliance.

import type { AscPlatform } from "../platform";
import { type Document, type Resource, api, get, many, relatedOne } from "./client";

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
  };
}

/** The include and fields parameters every build query uses. */
export const BUILD_QUERY =
  "include=preReleaseVersion,buildBetaDetail" +
  "&fields[builds]=version,uploadedDate,processingState,expired,expirationDate,usesNonExemptEncryption,buildAudienceType,minOsVersion,preReleaseVersion,buildBetaDetail" +
  "&fields[preReleaseVersions]=version,platform" +
  "&fields[buildBetaDetails]=internalBuildState,externalBuildState";

export interface BuildFilter {
  /** The app version (CFBundleShortVersionString), like 1.2. */
  version?: string;
  /** The build number (CFBundleVersion). */
  number?: string;
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

/** The GET /v1/builds path for a filter, with the first page's limit. */
export function buildsPath(appId: string, filter: BuildFilter = {}): string {
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
  return `/v1/builds?${params.join("&")}&${BUILD_QUERY}`;
}

/** The app's builds that match the filter, newest upload first unless `sort` says otherwise. */
export async function listBuilds(appId: string, filter: BuildFilter = {}): Promise<Build[]> {
  const limit = Math.max(1, filter.limit ?? 50);
  const builds: Build[] = [];
  let next: string | undefined = buildsPath(appId, filter);
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

/** Answers the export compliance question: only exempt encryption. */
export async function setExemptEncryption(buildId: string) {
  await api("PATCH", `/v1/builds/${buildId}`, {
    data: { type: "builds", id: buildId, attributes: { usesNonExemptEncryption: false } },
  });
}
