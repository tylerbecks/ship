// TestFlight in App Store Connect: beta groups, testers, What to Test, and
// Beta App Review.

import { all, api, get, many } from "./client";

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
  }>(`/v1/apps/${appId}/betaGroups?fields[betaGroups]=name,isInternalGroup,publicLink,publicLinkEnabled,hasAccessToAllBuilds&limit=200`);
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
  const doc = await get<{ locale: string }>(`/v1/builds/${buildId}/betaBuildLocalizations?fields[betaBuildLocalizations]=locale&limit=200`);
  const existing = many(doc).find((item) => item.attributes.locale === locale);
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
