// Releasing to the App Store: creating and renaming versions, attaching the
// build, release type and phased release, review submissions, and releasing
// an approved version. Also what the pre-submission checks read (mapped from
// asc/metadata.ts's fetchers, so each endpoint is read one way), and the
// pure rules (which version to use, which build, which phased-release moves
// are allowed) that the release command and its tests share.

import type { AscPlatform } from "../platform";
import { ShipError } from "../ui";
import { compareVersions } from "../version";
import type { Build } from "./builds";
import { AscError, type Resource, all, del, get, one, patch, post, relatedMany, relationshipId } from "./client";
import type { Localization, ReviewDetail } from "./metadata";
import { type AppStoreVersion, LIVE_VERSION_STATES, isEditableVersion, toVersion } from "./versions";

// MARK: Versions

export type ReleaseType = "MANUAL" | "AFTER_APPROVAL" | "SCHEDULED";

export const RELEASE_TYPES: ReleaseType[] = ["MANUAL", "AFTER_APPROVAL", "SCHEDULED"];

/** How a version is released: the release type, and the date for SCHEDULED. */
export interface ReleaseTiming {
  releaseType: ReleaseType;
  earliestReleaseDate: string | null;
}

/** Creates an App Store version. */
export async function createVersion(appId: string, platform: AscPlatform, versionString: string, timing?: ReleaseTiming): Promise<AppStoreVersion> {
  const doc = await post<any>("/v1/appStoreVersions", {
    data: {
      type: "appStoreVersions",
      attributes: { platform, versionString, ...(timing ? { releaseType: timing.releaseType, earliestReleaseDate: timing.earliestReleaseDate } : {}) },
      relationships: { app: { data: { type: "apps", id: appId } } },
    },
  });
  const created = one(doc);
  if (!created) {
    throw new ShipError(`App Store Connect didn't return version ${versionString}`, "api-bad-response", "Check `ship release status`, then run it again.");
  }
  return toVersion(created, doc?.included);
}

/** Changes a version's string (renames it), release type, or release date. */
export async function updateVersion(
  versionId: string,
  attributes: { versionString?: string; releaseType?: ReleaseType; earliestReleaseDate?: string | null },
): Promise<void> {
  await patch(`/v1/appStoreVersions/${encodeURIComponent(versionId)}`, { data: { type: "appStoreVersions", id: versionId, attributes } });
}

/** Attaches the build App Review gets. */
export async function attachBuild(versionId: string, buildId: string): Promise<void> {
  await patch(`/v1/appStoreVersions/${encodeURIComponent(versionId)}/relationships/build`, { data: { type: "builds", id: buildId } });
}

/** A version's copyright as it is now (a push may have just changed it). */
export async function versionCopyright(versionId: string): Promise<string | null> {
  const doc = await get<{ copyright?: string | null }>(`/v1/appStoreVersions/${encodeURIComponent(versionId)}?fields[appStoreVersions]=copyright`);
  return one(doc)?.attributes.copyright ?? null;
}

/** Releases a version that's approved and waiting for the developer (PENDING_DEVELOPER_RELEASE). */
export async function requestRelease(versionId: string): Promise<void> {
  await post("/v1/appStoreVersionReleaseRequests", {
    data: { type: "appStoreVersionReleaseRequests", relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } } },
  });
}

// MARK: Phased release

export type PhasedReleaseState = "INACTIVE" | "ACTIVE" | "PAUSED" | "COMPLETE";

export interface PhasedRelease {
  id: string;
  /** INACTIVE until the version is released, then ACTIVE, PAUSED, or COMPLETE. */
  state: PhasedReleaseState;
  /** 1 to 7 while it's rolling out. */
  currentDayNumber: number | null;
  startDate: string | null;
  /** Days paused so far. */
  totalPauseDuration: number | null;
}

type PhasedAttributes = { phasedReleaseState?: PhasedReleaseState; currentDayNumber?: number | null; startDate?: string | null; totalPauseDuration?: number | null };

function toPhasedRelease(resource: Resource<PhasedAttributes>): PhasedRelease {
  return {
    id: resource.id,
    state: resource.attributes.phasedReleaseState ?? "INACTIVE",
    currentDayNumber: resource.attributes.currentDayNumber ?? null,
    startDate: resource.attributes.startDate ?? null,
    totalPauseDuration: resource.attributes.totalPauseDuration ?? null,
  };
}

/** A version's phased release, or undefined when it releases to everyone at once. */
export async function phasedRelease(versionId: string): Promise<PhasedRelease | undefined> {
  try {
    const doc = await get<PhasedAttributes>(`/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionPhasedRelease`);
    const resource = one(doc);
    return resource ? toPhasedRelease(resource) : undefined;
  } catch (error) {
    if (error instanceof AscError && error.status === 404) return undefined;
    throw error;
  }
}

/** Turns on phased release for a version that isn't released yet. */
export async function createPhasedRelease(versionId: string): Promise<PhasedRelease | undefined> {
  const doc = await post<PhasedAttributes>("/v1/appStoreVersionPhasedReleases", {
    data: {
      type: "appStoreVersionPhasedReleases",
      attributes: { phasedReleaseState: "INACTIVE" },
      relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } },
    },
  });
  const resource = one(doc);
  return resource ? toPhasedRelease(resource) : undefined;
}

/** Turns phased release off (only before the version is released). */
export const deletePhasedRelease = (id: string) => del(`/v1/appStoreVersionPhasedReleases/${encodeURIComponent(id)}`);

/** Pauses, resumes, or completes a phased release. */
export async function setPhasedReleaseState(id: string, state: PhasedReleaseState): Promise<PhasedRelease> {
  const doc = await patch<PhasedAttributes>(`/v1/appStoreVersionPhasedReleases/${encodeURIComponent(id)}`, {
    data: { type: "appStoreVersionPhasedReleases", id, attributes: { phasedReleaseState: state } },
  });
  const resource = one(doc);
  return resource ? toPhasedRelease(resource) : { id, state, currentDayNumber: null, startDate: null, totalPauseDuration: null };
}

/** The share of people with automatic updates who get the version on each day of a phased release. */
export const PHASED_PERCENT = [0, 1, 2, 5, 10, 20, 50, 100];

/** The percentage for a phased release's day (0 before it starts, 100 from day 7, and when it's complete). */
export function phasedPercent(release: Pick<PhasedRelease, "state" | "currentDayNumber">): number {
  if (release.state === "COMPLETE") return 100;
  const day = release.currentDayNumber ?? 0;
  return PHASED_PERCENT[Math.min(Math.max(0, day), 7)] ?? 0;
}

export type PhasedAction = "pause" | "resume" | "complete";
export const PHASED_ACTIONS: PhasedAction[] = ["pause", "resume", "complete"];

/** The state a phased-release action moves to, or an error saying why it can't from `current`. */
export function phasedTransition(current: PhasedReleaseState, action: PhasedAction): PhasedReleaseState {
  const allowed: Record<PhasedAction, { from: PhasedReleaseState[]; to: PhasedReleaseState }> = {
    pause: { from: ["ACTIVE"], to: "PAUSED" },
    resume: { from: ["PAUSED"], to: "ACTIVE" },
    complete: { from: ["ACTIVE", "PAUSED"], to: "COMPLETE" },
  };
  const rule = allowed[action];
  if (rule.from.includes(current)) return rule.to;
  const why: Record<PhasedReleaseState, string> = {
    INACTIVE: "the phased release hasn't started; it starts when the version is released",
    ACTIVE: "the phased release is already running",
    PAUSED: "the phased release is paused",
    COMPLETE: "the phased release is complete: everyone has the version",
  };
  const hints: Record<PhasedReleaseState, string> = {
    INACTIVE: "Release the version first (`ship release go`, or it releases after approval), or turn phasing off with `ship release prepare --no-phased`.",
    ACTIVE: "`ship release phased pause` pauses it; `ship release phased complete` releases to everyone now.",
    PAUSED: "`ship release phased resume` resumes it; `ship release phased complete` releases to everyone now.",
    COMPLETE: "Nothing left to do. `ship release status` shows where things are.",
  };
  throw new ShipError(`Can't ${action}: ${why[current]}`, "bad-phased-state", hints[current], { state: current, action });
}

// MARK: Review submissions

/** Submission states that are still open (not COMPLETE). */
export const OPEN_SUBMISSION_STATES = ["READY_FOR_REVIEW", "WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES", "CANCELING", "COMPLETING"];

/** States in which a submission is with Apple, and can't take another version. */
export const IN_REVIEW_STATES = ["WAITING_FOR_REVIEW", "IN_REVIEW"];

/** States `ship release cancel` can take back: with App Review, or rejected. A draft (READY_FOR_REVIEW) was never sent. */
export const CANCELABLE_STATES = [...IN_REVIEW_STATES, "UNRESOLVED_ISSUES"];

export interface SubmissionItem {
  id: string;
  /** READY_FOR_REVIEW, ACCEPTED, APPROVED, REJECTED, or REMOVED. */
  state: string;
  /** The App Store version it submits, when it's one. */
  versionId: string | null;
}

export interface ReviewSubmission {
  id: string;
  /** READY_FOR_REVIEW (a draft), WAITING_FOR_REVIEW, IN_REVIEW, UNRESOLVED_ISSUES (rejected), CANCELING, COMPLETING, or COMPLETE. */
  state: string;
  platform: string | null;
  submittedDate: string | null;
  /** The version App Review is looking at. */
  versionForReviewId: string | null;
  items: SubmissionItem[];
}

type SubmissionAttributes = { state?: string; platform?: string | null; submittedDate?: string | null };

function toSubmission(resource: Resource<SubmissionAttributes>, included: Resource[] = []): ReviewSubmission {
  return {
    id: resource.id,
    state: resource.attributes.state ?? "",
    platform: resource.attributes.platform ?? null,
    submittedDate: resource.attributes.submittedDate ?? null,
    versionForReviewId: relationshipId(resource, "appStoreVersionForReview") ?? null,
    items: relatedMany(resource, "items", included).map(toItem),
  };
}

const toItem = (resource: Resource<any>): SubmissionItem => ({
  id: resource.id,
  state: (resource.attributes?.state as string | undefined) ?? "",
  versionId: relationshipId(resource, "appStoreVersion") ?? null,
});

/** The app's submissions on a platform that aren't complete, newest first as Apple lists them. */
export async function openSubmissions(appId: string, platform: AscPlatform): Promise<ReviewSubmission[]> {
  const { data, included } = await all<SubmissionAttributes>(
    `/v1/reviewSubmissions?filter[app]=${encodeURIComponent(appId)}&filter[platform]=${platform}` +
      `&filter[state]=${OPEN_SUBMISSION_STATES.join(",")}` +
      "&include=items,appStoreVersionForReview&fields[reviewSubmissions]=platform,submittedDate,state,items,appStoreVersionForReview" +
      "&fields[reviewSubmissionItems]=state,appStoreVersion&limit[items]=50&limit=50",
  );
  return data.map((resource) => toSubmission(resource, included));
}

/** Starts a draft submission. */
export async function createSubmission(appId: string, platform: AscPlatform): Promise<ReviewSubmission> {
  const doc = await post<SubmissionAttributes>("/v1/reviewSubmissions", {
    data: { type: "reviewSubmissions", attributes: { platform }, relationships: { app: { data: { type: "apps", id: appId } } } },
  });
  const resource = one(doc);
  if (!resource) throw new ShipError("App Store Connect didn't return the new submission", "api-bad-response", "Check `ship release status`, then run it again.");
  return toSubmission(resource);
}

/** Adds an App Store version to a draft submission. */
export async function addSubmissionItem(submissionId: string, versionId: string): Promise<void> {
  await post("/v1/reviewSubmissionItems", {
    data: {
      type: "reviewSubmissionItems",
      relationships: {
        reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
        appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
      },
    },
  });
}

async function updateSubmission(id: string, attributes: { submitted?: boolean; canceled?: boolean }): Promise<ReviewSubmission | undefined> {
  const doc = await patch<SubmissionAttributes>(`/v1/reviewSubmissions/${encodeURIComponent(id)}`, { data: { type: "reviewSubmissions", id, attributes } });
  const resource = one(doc);
  return resource ? toSubmission(resource) : undefined;
}

/** Sends a submission to App Review. */
export const submitSubmission = (id: string) => updateSubmission(id, { submitted: true });

/** Takes a submission out of review. */
export const cancelSubmission = (id: string) => updateSubmission(id, { canceled: true });

/** Whether a submission has this version in it (an item that wasn't removed). */
export const hasVersion = (submission: ReviewSubmission, versionId: string) =>
  submission.versionForReviewId === versionId || submission.items.some((item) => item.versionId === versionId && item.state !== "REMOVED");

/**
 * What to do with the open submissions before submitting a version: it's
 * already in review; reuse a draft (READY_FOR_REVIEW) or a rejected one
 * (UNRESOLVED_ISSUES); or start a new one. Another version with Apple is an error.
 * `versions` names the other version in the hint.
 */
export function pickSubmission(
  submissions: ReviewSubmission[],
  versionId: string | undefined,
  versionString: string,
  versions: AppStoreVersion[] = [],
): { kind: "in-review"; submission: ReviewSubmission } | { kind: "reuse"; submission: ReviewSubmission } | { kind: "create" } {
  const mine = versionId ? submissions.find((submission) => hasVersion(submission, versionId)) : undefined;
  if (mine && IN_REVIEW_STATES.includes(mine.state)) return { kind: "in-review", submission: mine };
  // (mine can only be canceling or completing here.)
  const busy = submissions.find((submission) => [...IN_REVIEW_STATES, "CANCELING", "COMPLETING"].includes(submission.state));
  if (busy) {
    throw new ShipError(
      `Another submission is ${busy.state.toLowerCase().replaceAll("_", " ")}, so ${versionString} can't be submitted yet`,
      "submission-in-progress",
      busy.state === "CANCELING" || busy.state === "COMPLETING"
        ? "Wait a minute for App Store Connect to finish it, then run this again."
        : "Take it out of review with `ship release cancel`, or wait for App Review to finish it.",
      { submission: { id: busy.id, state: busy.state } },
    );
  }
  if (mine && ["READY_FOR_REVIEW", "UNRESOLVED_ISSUES"].includes(mine.state)) return { kind: "reuse", submission: mine };
  const draft =
    submissions.find((submission) => submission.state === "UNRESOLVED_ISSUES" && !otherVersion(submission, versionId)) ??
    submissions.find((submission) => submission.state === "READY_FOR_REVIEW" && !otherVersion(submission, versionId));
  if (draft) return { kind: "reuse", submission: draft };
  const blocked = submissions.find((submission) => ["READY_FOR_REVIEW", "UNRESOLVED_ISSUES"].includes(submission.state));
  if (blocked) {
    const otherId = blocked.items.find((item) => item.versionId && item.versionId !== versionId && item.state !== "REMOVED")?.versionId;
    const other = versions.find((version) => version.id === otherId)?.versionString;
    const rejected = blocked.state === "UNRESOLVED_ISSUES";
    // A rejected submission can be canceled; a draft was never sent, so cancel has nothing to take back.
    throw new ShipError(
      `A ${rejected ? "rejected" : "draft"} submission holds ${other ? `version ${other}` : "another App Store version"}`,
      "submission-has-other-version",
      rejected
        ? `Cancel it with \`ship release cancel --version ${other ?? "<x.y>"}\`, or remove that version from it in App Store Connect (App Review).`
        : `Submit that version first with \`ship release submit --version ${other ?? "<x.y>"}\`, or remove it from the draft in App Store Connect (App Review).`,
      { submission: { id: blocked.id, state: blocked.state }, ...(other ? { version: other } : {}) },
    );
  }
  return { kind: "create" };
}

/** Whether a submission has an App Store version other than this one in it. */
const otherVersion = (submission: ReviewSubmission, versionId: string | undefined) =>
  submission.items.some((item) => item.versionId && item.versionId !== versionId && item.state !== "REMOVED");

// MARK: Which version

/** States after review where a version is on its way out: approved, releasing, or waiting for its release. */
export const IN_FLIGHT_VERSION_STATES = [
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "WAITING_FOR_EXPORT_COMPLIANCE",
  "ACCEPTED",
  "PENDING_APPLE_RELEASE",
  "PENDING_DEVELOPER_RELEASE",
  "PROCESSING_FOR_DISTRIBUTION",
];

export type VersionPlan =
  | { action: "create" }
  | { action: "reuse"; version: AppStoreVersion }
  | { action: "rename"; version: AppStoreVersion }
  /** The version exists, but it's past the point of changing (in review, or released). */
  | { action: "locked"; version: AppStoreVersion };

/**
 * What to do to get an editable version called `wanted`: reuse it, rename
 * the one being prepared (with `rename`), or create it. Errors when the one
 * being prepared has another number, another version is with Apple, or
 * `wanted` isn't higher than what's already on the App Store.
 */
export function planVersion(versions: AppStoreVersion[], wanted: string, options: { rename?: boolean } = {}): VersionPlan {
  const exact = versions.find((version) => version.versionString === wanted);
  if (exact) return isEditableVersion(exact) ? { action: "reuse", version: exact } : { action: "locked", version: exact };

  const shipped = versions.filter((version) => !isEditableVersion(version) && version.state !== "REPLACED_WITH_NEW_VERSION");
  const highest = shipped.reduce<AppStoreVersion | undefined>((top, version) => (!top || compareVersions(version.versionString, top.versionString) > 0 ? version : top), undefined);
  if (highest && compareVersions(wanted, highest.versionString) <= 0) {
    const live = LIVE_VERSION_STATES.includes(highest.state);
    throw new ShipError(
      `${wanted} isn't higher than ${highest.versionString}, which is ${live ? "on the App Store" : stateText(highest.state)}`,
      "version-too-low",
      "Bump the project's version with `ship version bump minor` (or patch), or pass a higher --version.",
      { live: highest.versionString },
    );
  }

  const flying = versions.find((version) => IN_FLIGHT_VERSION_STATES.includes(version.state));
  if (flying) {
    throw new ShipError(
      `${flying.versionString} is ${stateText(flying.state)}; App Store Connect handles one version at a time`,
      "version-in-flight",
      flying.state === "PENDING_DEVELOPER_RELEASE"
        ? `Release it with \`ship release go --version ${flying.versionString}\` first.`
        : `Wait for it to be released, or take it out of review with \`ship release cancel\`.`,
      { version: flying.versionString, state: flying.state },
    );
  }

  const editable = versions.find(isEditableVersion);
  if (editable) {
    if (options.rename) return { action: "rename", version: editable };
    throw new ShipError(
      `App Store Connect is preparing ${editable.versionString}, not ${wanted}`,
      "version-in-progress",
      `Rename it with --rename (it becomes ${wanted}), or use it: --version ${editable.versionString}.`,
      { version: editable.versionString, choices: ["--rename", `--version ${editable.versionString}`] },
    );
  }
  return { action: "create" };
}

/** WAITING_FOR_REVIEW → "waiting for review". */
export const stateText = (state: string) => state.toLowerCase().replaceAll("_", " ");

// MARK: Which build

/**
 * Checks that a build can go to the App Store with this version: the same
 * version, processed, not expired, and not "TestFlight Internal Only".
 * Returns whether export compliance still needs answering.
 */
export function checkBuild(build: Build, versionString: string): { needsCompliance: boolean } {
  const reupload = `Upload one with \`ship beta\` (the project's version must be ${versionString}).`;
  if (build.version && build.version !== versionString) {
    throw new ShipError(`Build ${build.number} is version ${build.version}, not ${versionString}`, "wrong-build-version", reupload, {
      build: build.number,
      version: build.version,
    });
  }
  if (build.processingState !== "VALID") {
    const processing = build.processingState === "PROCESSING";
    throw new ShipError(
      `Build ${build.number} is ${processing ? "still processing" : stateText(build.processingState)}`,
      "build-not-ready",
      processing ? "Wait for processing to finish (`ship status`), then run this again." : reupload,
      { build: build.number, processingState: build.processingState },
    );
  }
  if (build.expired) throw new ShipError(`Build ${build.number} has expired`, "build-expired", reupload, { build: build.number });
  if (build.audience === "INTERNAL_ONLY") {
    throw new ShipError(
      `Build ${build.number} is "TestFlight Internal Only", which can't go to the App Store`,
      "build-internal-only",
      `${reupload} ship exports for App Store Connect, never Internal Only.`,
      { build: build.number },
    );
  }
  return { needsCompliance: build.usesNonExemptEncryption == null };
}

// MARK: Pre-submission checks

/** A version localization's fields the checks read. */
export interface VersionLocalization {
  id: string;
  locale: string;
  description: string | null;
  keywords: string | null;
  supportUrl: string | null;
  whatsNew: string | null;
}

/** The fields the checks read, from a version localization as asc/metadata.ts reads it. */
export const toVersionLocalization = ({ id, locale, attributes }: Localization): VersionLocalization => ({
  id,
  locale,
  description: text(attributes.description),
  keywords: text(attributes.keywords),
  supportUrl: text(attributes.supportUrl),
  whatsNew: text(attributes.whatsNew),
});

const text = (value: unknown) => (typeof value === "string" ? value : null);

export interface InfoLocalization {
  locale: string;
  name: string | null;
  privacyPolicyUrl: string | null;
}

/** The fields the checks read, from an App Info localization as asc/metadata.ts reads it. */
export const toInfoLocalization = ({ locale, attributes }: Localization): InfoLocalization => ({
  locale,
  name: text(attributes.name),
  privacyPolicyUrl: text(attributes.privacyPolicyUrl),
});

/** The screenshot display types a version localization has screenshots for. */
export async function screenshotTypes(localizationId: string): Promise<string[]> {
  const { data } = await all<{ screenshotDisplayType?: string }>(
    `/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}/appScreenshotSets` +
      "?fields[appScreenshotSets]=screenshotDisplayType,appScreenshots&include=appScreenshots&fields[appScreenshots]=fileName&limit[appScreenshots]=1&limit=50",
  );
  return data
    .filter((set) => {
      const shots = set.relationships?.appScreenshots?.data;
      // Without the relationship, count the set; Apple's own check catches an empty one.
      return shots === undefined || (Array.isArray(shots) && shots.length > 0);
    })
    .map((set) => set.attributes.screenshotDisplayType ?? "")
    .filter(Boolean);
}

export interface ReviewContact {
  contactFirstName: string | null;
  contactLastName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

/** The contact fields the checks read, from the review detail asc/metadata.ts reads (undefined when there's none yet). */
export const toReviewContact = (detail: ReviewDetail | undefined): ReviewContact | undefined =>
  detail && {
    contactFirstName: text(detail.attributes.contactFirstName),
    contactLastName: text(detail.attributes.contactLastName),
    contactEmail: text(detail.attributes.contactEmail),
    contactPhone: text(detail.attributes.contactPhone),
  };

/** One pre-submission check. A blocking one that fails stops `ship release submit`. */
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  blocking: boolean;
  /** What fixes it, when it fails. */
  fix?: string;
}

/** What the pre-submission checks look at. */
export interface PreflightData {
  platform: AscPlatform;
  /** Whether a version is already live (so this is an update). */
  update: boolean;
  primaryLocale: string;
  copyright: string | null;
  build?: Pick<Build, "number" | "processingState" | "usesNonExemptEncryption"> | null;
  /** Whether export compliance gets answered before submitting (so a missing answer is fine). */
  answersCompliance?: boolean;
  versionLocalizations: VersionLocalization[];
  infoLocalizations: InfoLocalization[];
  /** Screenshot display types the primary locale has. */
  screenshots: string[];
  review?: ReviewContact;
  contentRights: string | null;
}

const blank = (value: string | null | undefined) => !value?.trim();

/** Locales where a field is empty, as "en-US, de-DE". */
const missingIn = <T extends { locale: string }>(items: T[], field: keyof T) =>
  items.filter((item) => blank(item[field] as string | null)).map((item) => item.locale);

/** The screenshot sizes a platform needs, as alternatives (any one will do). */
const REQUIRED_SCREENSHOTS: Record<AscPlatform, { name: string; types: string[] }> = {
  IOS: { name: "6.9\" or 6.5\" iPhone", types: ["APP_IPHONE_67", "APP_IPHONE_65"] },
  MAC_OS: { name: "Mac", types: ["APP_DESKTOP"] },
  TV_OS: { name: "Apple TV", types: ["APP_APPLE_TV"] },
  VISION_OS: { name: "Apple Vision Pro", types: ["APP_APPLE_VISION_PRO"] },
};

/** Everything ship can check before App Review sees the version. Apple's own check (a 409 on submit) catches the rest. */
export function preflightChecks(data: PreflightData): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, fix: string, blocking = true) => checks.push({ name, ok, detail, blocking, ...(ok ? {} : { fix }) });
  const metadata = "Fill it in under appstore/ and run `ship metadata push`.";

  const build = data.build;
  if (!build) add("build", false, "No build attached", "Upload one with `ship beta`, then run this again.");
  else {
    const compliance = build.usesNonExemptEncryption != null || Boolean(data.answersCompliance);
    const ok = build.processingState === "VALID" && compliance;
    add(
      "build",
      ok,
      ok ? `Build ${build.number}` : build.processingState !== "VALID" ? `Build ${build.number} is ${stateText(build.processingState)}` : `Build ${build.number} needs its export compliance answer`,
      "Check the build with `ship status`; `ship distribute <build>` answers export compliance.",
    );
  }

  const locales = data.versionLocalizations;
  if (!locales.length) add("localizations", false, "The version has no localizations", metadata);
  for (const [field, label] of [
    ["description", "description"],
    ["keywords", "keywords"],
    ["supportUrl", "support URL"],
  ] as const) {
    const missing = missingIn(locales, field);
    if (locales.length) add(field, !missing.length, missing.length ? `No ${label} in ${missing.join(", ")}` : `Every locale has a ${label}`, metadata);
  }
  if (data.update && locales.length) {
    const missing = missingIn(locales, "whatsNew");
    add("whatsNew", !missing.length, missing.length ? `No "What's New" in ${missing.join(", ")}` : `Every locale says what's new`, metadata, false);
  }

  const info = data.infoLocalizations;
  const missingNames = missingIn(info, "name");
  add("name", info.length > 0 && !missingNames.length, !info.length ? "The app has no name" : missingNames.length ? `No name in ${missingNames.join(", ")}` : "Named in every locale", metadata);
  const primaryInfo = info.find((item) => item.locale === data.primaryLocale) ?? info[0];
  add(
    "privacyPolicyUrl",
    !blank(primaryInfo?.privacyPolicyUrl),
    blank(primaryInfo?.privacyPolicyUrl) ? `No privacy policy URL in ${primaryInfo?.locale ?? data.primaryLocale}` : "Privacy policy URL set",
    "Put it in appstore/<locale>/privacy-policy-url.txt and run `ship metadata push`.",
  );

  const required = REQUIRED_SCREENSHOTS[data.platform];
  const hasRequired = required.types.some((type) => data.screenshots.includes(type));
  add(
    "screenshots",
    hasRequired,
    hasRequired ? `${required.name} screenshots in ${data.primaryLocale}` : `No ${required.name} screenshots in ${data.primaryLocale}`,
    "Add them under appstore/<locale>/screenshots/ and run `ship screenshots push`.",
  );
  if (data.platform === "IOS") {
    const ipad = ["APP_IPAD_PRO_3GEN_129", "APP_IPAD_PRO_129"].some((type) => data.screenshots.includes(type));
    add(
      "ipadScreenshots",
      ipad,
      ipad ? "13\" iPad screenshots" : "No 13\" iPad screenshots (needed only if the app runs on iPad)",
      "Add APP_IPAD_PRO_3GEN_129 screenshots and run `ship screenshots push`.",
      false,
    );
  }

  add("copyright", !blank(data.copyright), blank(data.copyright) ? "No copyright" : `© ${data.copyright}`, 'Set "copyright" in appstore/app.json and run `ship metadata push`.');

  const review = data.review;
  const missingContact = (["contactFirstName", "contactLastName", "contactEmail", "contactPhone"] as const).filter((field) => blank(review?.[field]));
  add(
    "reviewContact",
    !missingContact.length,
    missingContact.length ? `App Review contact is missing ${missingContact.join(", ")}` : "App Review contact set",
    'Fill in "review" in appstore/app.json and run `ship metadata push`.',
  );

  add(
    "contentRights",
    !blank(data.contentRights),
    blank(data.contentRights) ? "Content rights aren't declared" : stateText(data.contentRights!),
    'Set "contentRights" in appstore/app.json and run `ship metadata push`.',
  );
  return checks;
}

/** The checks that fail and stop a submission. */
export const blockingFailures = (checks: Check[]) => checks.filter((check) => check.blocking && !check.ok);
