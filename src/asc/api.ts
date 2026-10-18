// The App Store Connect API calls ship uses, with the shapes it needs.

import { type Resource, all, api } from "./client";

export interface App {
  id: string;
  name: string;
  bundleId: string;
}

export async function lookupApp(bundleId: string): Promise<App | undefined> {
  const doc = await api<{ name: string; bundleId: string }>(
    "GET",
    `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=name,bundleId&limit=1`,
  );
  const app = (Array.isArray(doc?.data) ? doc.data : [])[0];
  return app && { id: app.id, name: app.attributes.name, bundleId: app.attributes.bundleId };
}

export interface Build {
  id: string;
  /** The build number (CFBundleVersion). */
  number: string;
  /** The app version (CFBundleShortVersionString). */
  version?: string;
  uploadedDate: string;
  /** PROCESSING, FAILED, INVALID, or VALID. */
  processingState: string;
  expired: boolean;
  expirationDate?: string;
  usesNonExemptEncryption?: boolean | null;
  /** TestFlight state for internal testers, like IN_BETA_TESTING or MISSING_EXPORT_COMPLIANCE. */
  internalState?: string;
  /** TestFlight state for external testers, like WAITING_FOR_BETA_REVIEW or IN_BETA_TESTING. */
  externalState?: string;
}

type BuildAttributes = {
  version: string;
  uploadedDate: string;
  processingState: string;
  expired: boolean;
  expirationDate?: string;
  usesNonExemptEncryption?: boolean | null;
};

function toBuild(resource: Resource<BuildAttributes>, included: Resource[]): Build {
  const related = (name: string) => {
    const ref = resource.relationships?.[name]?.data;
    const id = ref && !Array.isArray(ref) ? ref.id : undefined;
    return included.find((item) => item.id === id);
  };
  const preRelease = related("preReleaseVersion");
  const beta = related("buildBetaDetail");
  return {
    id: resource.id,
    number: resource.attributes.version,
    version: preRelease?.attributes.version as string | undefined,
    uploadedDate: resource.attributes.uploadedDate,
    processingState: resource.attributes.processingState,
    expired: resource.attributes.expired,
    expirationDate: resource.attributes.expirationDate,
    usesNonExemptEncryption: resource.attributes.usesNonExemptEncryption,
    internalState: beta?.attributes.internalBuildState as string | undefined,
    externalState: beta?.attributes.externalBuildState as string | undefined,
  };
}

const BUILD_QUERY =
  "include=preReleaseVersion,buildBetaDetail" +
  "&fields[builds]=version,uploadedDate,processingState,expired,expirationDate,usesNonExemptEncryption,preReleaseVersion,buildBetaDetail" +
  "&fields[preReleaseVersions]=version" +
  "&fields[buildBetaDetails]=internalBuildState,externalBuildState";

/** The app's most recent builds, newest first. */
export async function recentBuilds(appId: string, limit = 10): Promise<Build[]> {
  const doc = await api<BuildAttributes>("GET", `/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=${limit}&${BUILD_QUERY}`);
  const data = Array.isArray(doc?.data) ? doc.data : [];
  return data.map((resource) => toBuild(resource, doc?.included ?? []));
}

/** One build by its number, if App Store Connect has it (it appears a few minutes after upload). */
export async function findBuild(appId: string, number: string): Promise<Build | undefined> {
  const doc = await api<BuildAttributes>(
    "GET",
    `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(number)}&limit=1&${BUILD_QUERY}`,
  );
  const data = Array.isArray(doc?.data) ? doc.data : [];
  return data[0] && toBuild(data[0], doc?.included ?? []);
}

/** The highest build number uploaded so far, across every version. */
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

export interface BetaGroup {
  id: string;
  name: string;
  isInternal: boolean;
  publicLink?: string;
  publicLinkEnabled?: boolean;
  /** An internal group that gets every build automatically; builds can't be added to it by hand. */
  automatic?: boolean;
}

export async function betaGroups(appId: string): Promise<BetaGroup[]> {
  const { data } = await all<{
    name: string;
    isInternalGroup: boolean;
    publicLink?: string;
    publicLinkEnabled?: boolean;
    hasAccessToAllBuilds?: boolean;
  }>(`/v1/apps/${appId}/betaGroups?fields[betaGroups]=name,isInternalGroup,publicLink,publicLinkEnabled,hasAccessToAllBuilds&limit=200`,
  );
  return data.map((group) => ({
    id: group.id,
    name: group.attributes.name,
    isInternal: group.attributes.isInternalGroup,
    publicLink: group.attributes.publicLink,
    publicLinkEnabled: group.attributes.publicLinkEnabled,
    automatic: group.attributes.isInternalGroup && Boolean(group.attributes.hasAccessToAllBuilds),
  }));
}

export async function addBuildToGroup(groupId: string, buildId: string) {
  await api("POST", `/v1/betaGroups/${groupId}/relationships/builds`, {
    data: [{ type: "builds", id: buildId }],
  });
}

/** Sets the build's "What to Test" notes, shown to testers in TestFlight. */
export async function setWhatToTest(buildId: string, notes: string, locale = "en-US") {
  const doc = await api<{ locale: string }>("GET", `/v1/builds/${buildId}/betaBuildLocalizations?fields[betaBuildLocalizations]=locale`);
  const existing = (Array.isArray(doc?.data) ? doc.data : []).find((item) => item.attributes.locale === locale);
  if (existing) {
    await api("PATCH", `/v1/betaBuildLocalizations/${existing.id}`, {
      data: { type: "betaBuildLocalizations", id: existing.id, attributes: { whatsNew: notes } },
    });
  } else {
    await api("POST", "/v1/betaBuildLocalizations", {
      data: {
        type: "betaBuildLocalizations",
        attributes: { locale, whatsNew: notes },
        relationships: { build: { data: { type: "builds", id: buildId } } },
      },
    });
  }
}

/** Submits a build to Beta App Review, needed before external testers get it. */
export async function submitForBetaReview(buildId: string) {
  await api("POST", "/v1/betaAppReviewSubmissions", {
    data: {
      type: "betaAppReviewSubmissions",
      relationships: { build: { data: { type: "builds", id: buildId } } },
    },
  });
}

export interface Tester {
  id: string;
  email: string;
  name: string;
  /** NOT_INVITED, INVITED, ACCEPTED, INSTALLED, or REVOKED. */
  state?: string;
}

export async function groupTesters(groupId: string): Promise<Tester[]> {
  const { data } = await all<{ email: string; firstName?: string; lastName?: string; state?: string }>(
    `/v1/betaGroups/${groupId}/betaTesters?fields[betaTesters]=email,firstName,lastName,state&limit=200`,
  );
  return data.map((tester) => ({
    id: tester.id,
    email: tester.attributes.email,
    name: [tester.attributes.firstName, tester.attributes.lastName].filter(Boolean).join(" "),
    state: tester.attributes.state,
  }));
}

/** Invites someone to a group. Adding someone who's already a tester just adds the group. */
export async function addTester(groupId: string, email: string) {
  await api("POST", "/v1/betaTesters", {
    data: {
      type: "betaTesters",
      attributes: { email },
      relationships: { betaGroups: { data: [{ type: "betaGroups", id: groupId }] } },
    },
  });
}
