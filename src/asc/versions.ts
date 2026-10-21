// App Store versions and App Infos: which one is being prepared (and can be
// edited), and which one is live. Shared by the metadata, screenshots, and
// release commands; they read these, and edit through their own modules.

import type { AscPlatform } from "../platform";
import { type Resource, all, relatedOne, relationshipId } from "./client";

// MARK: App Store versions

export interface AppStoreVersion {
  id: string;
  versionString: string;
  platform: AscPlatform;
  /** appVersionState, like PREPARE_FOR_SUBMISSION or READY_FOR_DISTRIBUTION. */
  state: string;
  releaseType?: string | null;
  earliestReleaseDate?: string | null;
  copyright?: string | null;
  createdDate?: string;
  /** The build attached for review, if any. */
  buildId?: string | null;
  /** That build's number (CFBundleVersion), when App Store Connect included it. */
  buildNumber?: string | null;
}

/** States in which a version's page and build can still be changed. */
export const EDITABLE_VERSION_STATES = [
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
];

/** The state of the version on the App Store (appStoreState's deprecated twin is READY_FOR_SALE). */
export const LIVE_VERSION_STATES = ["READY_FOR_DISTRIBUTION"];

/** appStoreState (deprecated) names that differ from appVersionState's. */
const LEGACY_VERSION_STATES: Record<string, string> = {
  READY_FOR_SALE: "READY_FOR_DISTRIBUTION",
  PROCESSING_FOR_APP_STORE: "PROCESSING_FOR_DISTRIBUTION",
  PREORDER_READY_FOR_SALE: "READY_FOR_DISTRIBUTION",
};

/** A version's state in appVersionState's terms, falling back to the deprecated appStoreState. */
export function versionState(attributes: { appVersionState?: string | null; appStoreState?: string | null }): string {
  if (attributes.appVersionState) return attributes.appVersionState;
  const legacy = attributes.appStoreState ?? "";
  return LEGACY_VERSION_STATES[legacy] ?? legacy;
}

export const isEditableVersion = (version: AppStoreVersion) => EDITABLE_VERSION_STATES.includes(version.state);

type VersionAttributes = {
  versionString: string;
  platform: AscPlatform;
  appVersionState?: string | null;
  appStoreState?: string | null;
  releaseType?: string | null;
  earliestReleaseDate?: string | null;
  copyright?: string | null;
  createdDate?: string;
};

export function toVersion(resource: Resource<VersionAttributes>, included: Resource[] = []): AppStoreVersion {
  const build = relatedOne(resource, "build", included);
  return {
    id: resource.id,
    versionString: resource.attributes.versionString,
    platform: resource.attributes.platform,
    state: versionState(resource.attributes),
    releaseType: resource.attributes.releaseType ?? null,
    earliestReleaseDate: resource.attributes.earliestReleaseDate ?? null,
    copyright: resource.attributes.copyright ?? null,
    createdDate: resource.attributes.createdDate,
    buildId: relationshipId(resource, "build") ?? null,
    buildNumber: (build?.attributes.version as string | undefined) ?? null,
  };
}

/** Newest first: by creation date, then by version number. */
export function sortVersions(versions: AppStoreVersion[]): AppStoreVersion[] {
  const numeric = (v: string) => v.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const compare = (a: string, b: string) => {
    const [x, y] = [numeric(a), numeric(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  };
  return [...versions].sort((a, b) => (b.createdDate ?? "").localeCompare(a.createdDate ?? "") || compare(b.versionString, a.versionString));
}

/** The app's App Store versions on a platform, newest first. */
export async function appStoreVersions(appId: string, platform: AscPlatform): Promise<AppStoreVersion[]> {
  const { data, included } = await all<VersionAttributes>(
    `/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?filter[platform]=${platform}` +
      "&fields[appStoreVersions]=platform,versionString,appStoreState,appVersionState,copyright,releaseType,earliestReleaseDate,createdDate,build" +
      "&include=build&fields[builds]=version&limit=200",
  );
  return sortVersions(data.map((resource) => toVersion(resource, included)));
}

/** The version called `versionString`, or without one, the version being prepared (the editable one). */
export function pickVersion(versions: AppStoreVersion[], versionString?: string): AppStoreVersion | undefined {
  if (versionString) return versions.find((version) => version.versionString === versionString);
  return versions.find(isEditableVersion);
}

// MARK: App Infos

/** The app-level page (name, subtitle, categories, age rating). There's a live one, and one being prepared alongside a new version. */
export interface AppInfo {
  id: string;
  /** Like PREPARE_FOR_SUBMISSION or READY_FOR_DISTRIBUTION. */
  state: string;
}

export const EDITABLE_APP_INFO_STATES = ["PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW", "DEVELOPER_REJECTED", "REJECTED"];

export async function appInfos(appId: string): Promise<AppInfo[]> {
  const { data } = await all<{ state?: string | null; appStoreState?: string | null }>(
    `/v1/apps/${encodeURIComponent(appId)}/appInfos?fields[appInfos]=state,appStoreState&limit=200`,
  );
  return data.map((info) => ({
    id: info.id,
    state: info.attributes.state ?? versionState({ appStoreState: info.attributes.appStoreState }),
  }));
}

/** The App Info being prepared, which is the one that can be edited. */
export const editableAppInfo = (infos: AppInfo[]) => infos.find((info) => EDITABLE_APP_INFO_STATES.includes(info.state));

/** The App Info on the App Store now. */
export const liveAppInfo = (infos: AppInfo[]) => infos.find((info) => info.state === "READY_FOR_DISTRIBUTION");
