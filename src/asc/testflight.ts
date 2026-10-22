// TestFlight in App Store Connect: beta groups, testers, What to Test,
// Beta App Review, and the test information testers see (beta app
// localizations and the Beta App Review contact).

import { type Resource, all, api, del, get, many, one, patch, post } from "./client";

// MARK: Groups

export interface BetaGroup {
  id: string;
  name: string;
  isInternal: boolean;
  publicLink?: string;
  publicLinkEnabled?: boolean;
  /** An internal group that gets every build automatically; builds can't be added to it by hand. */
  automatic?: boolean;
  /** The most testers the public link takes, when publicLinkLimitEnabled. */
  publicLinkLimit?: number;
  publicLinkLimitEnabled?: boolean;
  /** Whether testers in the group can send feedback from TestFlight. */
  feedbackEnabled?: boolean;
  createdDate?: string;
}

export type BetaGroupAttributes = {
  name: string;
  createdDate?: string;
  isInternalGroup: boolean;
  hasAccessToAllBuilds?: boolean;
  publicLink?: string;
  publicLinkEnabled?: boolean;
  publicLinkLimit?: number;
  publicLinkLimitEnabled?: boolean;
  feedbackEnabled?: boolean;
};

const GROUP_FIELDS =
  "fields[betaGroups]=name,createdDate,isInternalGroup,hasAccessToAllBuilds,publicLinkEnabled,publicLinkId,publicLinkLimitEnabled,publicLinkLimit,publicLink,feedbackEnabled";

/** A betaGroups resource as a BetaGroup. */
export function toBetaGroup(group: Resource<BetaGroupAttributes>): BetaGroup {
  const a = group.attributes;
  return {
    id: group.id,
    name: a.name,
    isInternal: a.isInternalGroup,
    publicLink: a.publicLink,
    publicLinkEnabled: a.publicLinkEnabled,
    automatic: a.isInternalGroup && Boolean(a.hasAccessToAllBuilds),
    publicLinkLimit: a.publicLinkLimit,
    publicLinkLimitEnabled: a.publicLinkLimitEnabled,
    feedbackEnabled: a.feedbackEnabled,
    createdDate: a.createdDate,
  };
}

export async function betaGroups(appId: string): Promise<BetaGroup[]> {
  const { data } = await all<BetaGroupAttributes>(`/v1/apps/${appId}/betaGroups?${GROUP_FIELDS}&limit=200`);
  return data.map(toBetaGroup);
}

/** The group called `name`, ignoring case (but nothing else: "Beta" isn't "Beta 2"). */
export function groupNamed<G extends { name: string }>(groups: G[], name: string): G | undefined {
  const wanted = name.trim().toLowerCase();
  return groups.find((group) => group.name.toLowerCase() === wanted);
}

/** How many testers a group has, from the list's paging total (one tiny request). */
export async function groupTesterCount(groupId: string): Promise<number> {
  const doc = await get(`/v1/betaGroups/${groupId}/betaTesters?fields[betaTesters]=email&limit=1`);
  return doc.meta?.paging?.total ?? many(doc).length;
}

/** What a new group starts with. Leave a field out to take Apple's default. */
export interface NewGroup {
  name: string;
  isInternalGroup?: boolean;
  hasAccessToAllBuilds?: boolean;
  publicLinkEnabled?: boolean;
  publicLinkLimitEnabled?: boolean;
  publicLinkLimit?: number;
  feedbackEnabled?: boolean;
}

/** The POST /v1/betaGroups body. */
export function groupCreateBody(appId: string, group: NewGroup) {
  const attributes = Object.fromEntries(Object.entries(group).filter(([, value]) => value !== undefined));
  return {
    data: {
      type: "betaGroups",
      attributes,
      relationships: { app: { data: { type: "apps", id: appId } } },
    },
  };
}

/** What can change on a group. */
export type GroupUpdate = Partial<Pick<NewGroup, "name" | "publicLinkEnabled" | "publicLinkLimitEnabled" | "publicLinkLimit" | "feedbackEnabled">>;

/** The PATCH /v1/betaGroups/{id} body. */
export function groupUpdateBody(groupId: string, update: GroupUpdate) {
  const attributes = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined));
  return { data: { type: "betaGroups", id: groupId, attributes } };
}

export async function createGroup(appId: string, group: NewGroup): Promise<BetaGroup> {
  const created = one(await post<BetaGroupAttributes>("/v1/betaGroups", groupCreateBody(appId, group)));
  if (!created) {
    // Apple always sends the group back; this is a fallback for an empty reply.
    const found = groupNamed(await betaGroups(appId), group.name);
    if (found) return found;
    return { id: "", name: group.name, isInternal: Boolean(group.isInternalGroup) };
  }
  return toBetaGroup(created);
}

/** Changes a group and returns it as it is now (`before` with the update, when Apple sends nothing back). */
export async function updateGroup(before: BetaGroup, update: GroupUpdate): Promise<BetaGroup> {
  const updated = one(await patch<BetaGroupAttributes>(`/v1/betaGroups/${before.id}`, groupUpdateBody(before.id, update)));
  return updated ? toBetaGroup(updated) : { ...before, ...update };
}

export async function deleteGroup(groupId: string) {
  await del(`/v1/betaGroups/${groupId}`);
}

export async function addBuildToGroup(groupId: string, buildId: string) {
  await api("POST", `/v1/betaGroups/${groupId}/relationships/builds`, {
    data: [{ type: "builds", id: buildId }],
  });
}

// MARK: Builds

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

// MARK: Testers

export interface Tester {
  id: string;
  email: string;
  name: string;
  /** NOT_INVITED, INVITED, ACCEPTED, INSTALLED, or REVOKED. */
  state?: string;
}

type TesterAttributes = { email: string; firstName?: string; lastName?: string; state?: string; inviteType?: string };

const toTester = (tester: Resource<TesterAttributes>): Tester => ({
  id: tester.id,
  email: tester.attributes.email,
  name: [tester.attributes.firstName, tester.attributes.lastName].filter(Boolean).join(" "),
  state: tester.attributes.state,
});

export async function groupTesters(groupId: string): Promise<Tester[]> {
  const { data } = await all<TesterAttributes>(`/v1/betaGroups/${groupId}/betaTesters?fields[betaTesters]=email,firstName,lastName,state&limit=200`);
  return data.map(toTester);
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

/** Whether two email addresses are the same person's (email addresses compare without case). */
export const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The app's tester with this email, if there is one. */
export async function findTester(appId: string, email: string): Promise<Tester | undefined> {
  const doc = await get<TesterAttributes>(
    `/v1/betaTesters?filter[email]=${encodeURIComponent(email.trim())}&filter[apps]=${appId}` +
      "&fields[betaTesters]=email,firstName,lastName,state,inviteType&limit=10",
  );
  const found = many(doc).find((tester) => sameEmail(tester.attributes.email ?? "", email));
  return found ? toTester(found) : undefined;
}

const testerLinkage = (ids: string[]) => ({ data: ids.map((id) => ({ type: "betaTesters", id })) });

/** Takes testers out of a group (they stay in the app's other groups). */
export async function removeTestersFromGroup(groupId: string, testerIds: string[]) {
  if (testerIds.length) await del(`/v1/betaGroups/${groupId}/relationships/betaTesters`, testerLinkage(testerIds));
}

/** Takes testers out of every group and the app's TestFlight. */
export async function removeTestersFromApp(appId: string, testerIds: string[]) {
  if (testerIds.length) await del(`/v1/apps/${appId}/relationships/betaTesters`, testerLinkage(testerIds));
}

// MARK: Test information

/** What testers see about the beta in one language (betaAppLocalizations). */
export type BetaLocalizationAttributes = {
  description?: string | null;
  feedbackEmail?: string | null;
  marketingUrl?: string | null;
  privacyPolicyUrl?: string | null;
  tvOsPrivacyPolicy?: string | null;
};

export interface BetaLocalization {
  id: string;
  locale: string;
  attributes: BetaLocalizationAttributes;
}

export async function betaLocalizations(appId: string): Promise<BetaLocalization[]> {
  const { data } = await all<BetaLocalizationAttributes & { locale: string }>(`/v1/apps/${appId}/betaAppLocalizations?limit=200`);
  return data.map(({ id, attributes: { locale, ...attributes } }) => ({ id, locale, attributes }));
}

export async function createBetaLocalization(appId: string, locale: string, attributes: BetaLocalizationAttributes) {
  await post("/v1/betaAppLocalizations", {
    data: {
      type: "betaAppLocalizations",
      attributes: { locale, ...attributes },
      relationships: { app: { data: { type: "apps", id: appId } } },
    },
  });
}

export async function updateBetaLocalization(id: string, attributes: BetaLocalizationAttributes) {
  await patch(`/v1/betaAppLocalizations/${id}`, { data: { type: "betaAppLocalizations", id, attributes } });
}

export async function deleteBetaLocalization(id: string) {
  await del(`/v1/betaAppLocalizations/${id}`);
}

/** The Beta App Review contact, demo account, and notes (betaAppReviewDetails). */
export type BetaReviewAttributes = {
  contactFirstName?: string | null;
  contactLastName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  demoAccountName?: string | null;
  demoAccountPassword?: string | null;
  demoAccountRequired?: boolean | null;
  notes?: string | null;
};

/** The app's Beta App Review details. Every app has one. */
export async function betaReviewDetail(appId: string): Promise<{ id: string; attributes: BetaReviewAttributes }> {
  const detail = one(await get<BetaReviewAttributes>(`/v1/apps/${appId}/betaAppReviewDetail`));
  // Apple gives it the app's id, so that's the fallback for an empty reply.
  return { id: detail?.id ?? appId, attributes: detail?.attributes ?? {} };
}

export async function updateBetaReviewDetail(id: string, attributes: BetaReviewAttributes) {
  await patch(`/v1/betaAppReviewDetails/${id}`, { data: { type: "betaAppReviewDetails", id, attributes } });
}
