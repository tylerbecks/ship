// ship release: ship a version to the App Store. prepare creates (or reuses)
// the version, attaches the build, and sets how it's released; submit also
// checks the page and sends it to App Review; status, go, cancel, and phased
// follow it from there.

import { type Build, findBuild, listBuilds, setExemptEncryption } from "../asc/builds";
import {
  CANCELABLE_STATES,
  type Check,
  type PhasedAction,
  PHASED_ACTIONS,
  type PhasedRelease,
  type ReleaseTiming,
  type ReviewSubmission,
  type VersionPlan,
  addSubmissionItem,
  appInfoLocalizations,
  appReleaseInfo,
  attachBuild,
  blockingFailures,
  cancelSubmission,
  checkBuild,
  createPhasedRelease,
  createSubmission,
  createVersion,
  deletePhasedRelease,
  hasVersion,
  IN_REVIEW_STATES,
  openSubmissions,
  phasedPercent,
  phasedRelease,
  phasedTransition,
  pickSubmission,
  planVersion,
  preflightChecks,
  requestRelease,
  reviewContact,
  screenshotTypes,
  setPhasedReleaseState,
  stateText,
  submitSubmission,
  updateVersion,
  versionCopyright,
  versionLocalizations,
} from "../asc/release";
import { type AppStoreVersion, LIVE_VERSION_STATES, appInfos, appStoreVersions, editableAppInfo, liveAppInfo, pickVersion } from "../asc/versions";
import { checkBuildNumber } from "../build";
import { type Command, type Context, boolFlag, stringFlag } from "../command";
import { type Project, loadProject } from "../config";
import { type AscPlatform, fromAscPlatform, parsePlatform, platformInfo } from "../platform";
import { type PushResult, type StoreApp, readStoreApp } from "../store/files";
import { pushMedia } from "../store/media";
import { pushMetadata } from "../store/metadata";
import { ShipError, ui } from "../ui";
import { checkVersion, projectVersion } from "../version";
import { appId } from "./status";

export const releaseHelp = `ship release [status] [--version <x.y>]
ship release prepare [--version <x.y>] [--build <n>] [--push] [--release <when>] [--phased | --no-phased] [--rename]
ship release submit [the same flags] [--dry-run]
ship release go [--version <x.y>]
ship release cancel [--version <x.y>]
ship release phased pause|resume|complete [--version <x.y>]

Ships a version to the App Store:
  prepare  creates the version (or reuses the one being prepared), attaches
           the build, and sets how it's released
  submit   prepares, checks that nothing's missing, and submits it for review
  status   shows review and release progress (also plain \`ship release\`)
  go       releases a version that's approved and waiting for you
  cancel   takes a submission out of review
  phased   pauses, resumes, or finishes a phased release

The version defaults to the project's version (see \`ship version\`), and the
build to the newest processed build of that version. Defaults for --release
and --phased can live in appstore/app.json under "release".

  --version <x.y>    The App Store version
  --build <n>        The build to attach (default: the newest valid one)
  --push             Push appstore/ (text and screenshots) first
  --release <when>   manual, auto (as soon as it's approved), or a date like 2026-11-03T09:00
  --phased           Release over 7 days to people with automatic updates
  --no-phased        Release to everyone at once
  --rename           Rename the version being prepared to --version (or the project's)
  --platform <p>     ios, macos, tvos, or visionos (default: ship.json's)
  --dry-run          Show the plan and checks without changing anything`;

export interface ReleaseOptions {
  /** The App Store version; the project's version when unset. */
  version?: string;
  /** A build number; the newest valid build of the version when unset. */
  build?: string;
  push?: boolean;
  /** manual, auto, or a date (see parseRelease). */
  release?: string;
  /** true for --phased, false for --no-phased, undefined to use app.json (or leave it). */
  phased?: boolean;
  rename?: boolean;
  dryRun?: boolean;
  platform?: AscPlatform;
  /** The current time (tests set it). */
  now?: Date;
}

// MARK: Release timing

const HOUR = 60 * 60 * 1000;

/**
 * A --release value as App Store Connect's release type: manual → MANUAL,
 * auto → AFTER_APPROVAL, a date or date and time → SCHEDULED. Dates without
 * a zone are local time. Apple schedules on the hour, so a time in between
 * is rounded up (`rounded` says so). A time that's past is a usage error.
 */
export function parseRelease(value: string, now = new Date()): { timing: ReleaseTiming; rounded: boolean } {
  const text = value.trim();
  const lower = text.toLowerCase();
  if (lower === "manual") return { timing: { releaseType: "MANUAL", earliestReleaseDate: null }, rounded: false };
  if (["auto", "automatic", "after-approval", "after_approval"].includes(lower)) {
    return { timing: { releaseType: "AFTER_APPROVAL", earliestReleaseDate: null }, rounded: false };
  }
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:\.\d+)?)?)?)?(Z|[+-]\d{2}:?\d{2})?$/i);
  const choices = ["manual", "auto", "2026-11-03", "2026-11-03T09:00"];
  if (!match) {
    throw new ShipError(`--release takes manual, auto, or a date, not "${value}"`, "usage", "For example: --release auto, or --release 2026-11-03T09:00", { choices }, 2);
  }
  const [, day = "", hours = "00", minutes = "00", seconds = "00", zone = ""] = match;
  const date = new Date(`${day}T${hours}:${minutes}:${seconds}${zone.toUpperCase().replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")}`);
  if (Number.isNaN(date.getTime()) || !realDate(day, hours, minutes, seconds)) {
    throw new ShipError(`"${value}" isn't a real date`, "usage", "For example: --release 2026-11-03T09:00", { choices }, 2);
  }
  const rounded = Math.ceil(date.getTime() / HOUR) * HOUR;
  if (rounded <= now.getTime()) {
    throw new ShipError(`${value} has already passed`, "usage", "Pick a time in the future, or --release auto to release as soon as it's approved.", { choices }, 2);
  }
  return {
    timing: { releaseType: "SCHEDULED", earliestReleaseDate: new Date(rounded).toISOString().replace(/\.\d{3}Z$/, "Z") },
    rounded: rounded !== date.getTime(),
  };
}

/** Whether a date and time exist: no February 30th or 25 o'clock (which Date would roll over). */
function realDate(day: string, hours: string, minutes: string, seconds: string): boolean {
  const [year = 0, month = 0, date = 0] = day.split("-").map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && date >= 1 && date <= days && Number(hours) < 24 && Number(minutes) < 60 && Number(seconds) < 60;
}

/** How to release, from --release or else app.json's "release". undefined leaves the version as it is. */
export function desiredTiming(flag: string | undefined, app: StoreApp | undefined, now = new Date()): { timing?: ReleaseTiming; notes: string[] } {
  if (flag !== undefined) {
    const { timing, rounded } = parseRelease(flag, now);
    return { timing, notes: rounded ? [`App Store Connect schedules on the hour, so it's ${localTime(timing.earliestReleaseDate!)}`] : [] };
  }
  const type = app?.release?.type;
  if (!type) return { notes: [] };
  if (type === "SCHEDULED") return { notes: ['app.json\'s release type is SCHEDULED, which needs a date: pass --release <date>. Leaving the release type alone'] };
  if (type !== "MANUAL" && type !== "AFTER_APPROVAL") {
    throw new ShipError(`app.json's release type "${String(type)}" isn't one App Store Connect knows`, "bad-store-file", 'Set "release": { "type": "MANUAL" } or "AFTER_APPROVAL" in appstore/app.json.', {
      choices: ["MANUAL", "AFTER_APPROVAL", "SCHEDULED"],
    });
  }
  return { timing: { releaseType: type, earliestReleaseDate: null }, notes: [] };
}

/** A date for people, in local time. */
export const localTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "2 hours ago", for a past date. */
export function ago(iso: string, now = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    const count = Math.floor(seconds / size);
    if (count >= 1) return `${count} ${name}${count === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

// MARK: Shared lookups

interface ReleaseContext {
  project: Project;
  appId: string;
  platform: AscPlatform;
  versions: AppStoreVersion[];
  storeApp?: StoreApp;
  now: Date;
}

/** The app, its versions, and (for prepare and submit, which read the release defaults) app.json. */
async function releaseContext(project: Project, options: ReleaseOptions, store = false): Promise<ReleaseContext> {
  const id = await appId(project);
  const platform = options.platform ?? platformInfo(project.platform).asc;
  // Only prepare and submit read app.json, so a broken one never hides the status.
  const [versions, storeApp] = await Promise.all([appStoreVersions(id, platform), store ? readStoreApp(project) : undefined]);
  return { project, appId: id, platform, versions, storeApp, now: options.now ?? new Date() };
}

/** --version, or the project's own version. */
async function wantedVersion(project: Project, flag: string | undefined): Promise<string> {
  if (flag !== undefined) return checkVersion(flag);
  ui.step("Reading the project's version");
  const { version } = await projectVersion(project);
  if (!version) {
    throw new ShipError(
      "The project doesn't say its version",
      "no-version",
      "Pass --version <x.y>, or set Version in Xcode's General tab (`ship version set 1.0`).",
    );
  }
  return checkVersion(version, "ship version set");
}

/** The build to attach: --build, or the newest valid App Store build of the version. */
async function selectBuild(context: ReleaseContext, versionString: string, number: string | undefined): Promise<Build> {
  const hint = `Upload one with \`ship beta\` (the project's version must be ${versionString}).`;
  if (number !== undefined) {
    // Build numbers only have to be unique within a version, so look in this one first.
    const [build] = await listBuilds(context.appId, { number, version: versionString, platform: context.platform, limit: 1 });
    const found = build ?? (await findBuild(context.appId, number, context.platform));
    if (!found) throw new ShipError(`App Store Connect has no build ${number}`, "no-build", `\`ship status\` lists the builds. ${hint}`, { build: number });
    return found;
  }
  const [build] = await listBuilds(context.appId, {
    version: versionString,
    platform: context.platform,
    processingState: ["VALID"],
    expired: false,
    audience: "APP_STORE_ELIGIBLE",
    sort: "-uploadedDate",
    limit: 1,
  });
  if (!build) throw new ShipError(`No processed build of ${versionString} can go to the App Store`, "no-build", hint, { version: versionString });
  return build;
}

/** Why a version that's past changing can't be prepared, and what to do instead. */
function lockedError(version: AppStoreVersion): ShipError {
  const hints: Record<string, string> = {
    WAITING_FOR_REVIEW: "It's with App Review: `ship release status` follows it, `ship release cancel` takes it back.",
    IN_REVIEW: "It's with App Review: `ship release status` follows it, `ship release cancel` takes it back.",
    PENDING_DEVELOPER_RELEASE: `It's approved: release it with \`ship release go --version ${version.versionString}\`.`,
    READY_FOR_DISTRIBUTION: "It's on the App Store. Bump the project's version with `ship version bump minor` for the next one.",
  };
  return new ShipError(
    `${version.versionString} is ${stateText(version.state)} and can't be changed`,
    "version-not-editable",
    hints[version.state] ?? "Bump the project's version with `ship version bump minor` for the next one, or check `ship release status`.",
    { version: version.versionString, state: version.state },
  );
}

// MARK: JSON

const buildJSON = (build: Build | undefined | null) => (build ? { id: build.id, number: build.number } : null);

export function phasedJSON(release: PhasedRelease | undefined | null, versionString?: string) {
  if (!release) return null;
  return {
    id: release.id,
    state: release.state,
    currentDayNumber: release.currentDayNumber,
    percent: phasedPercent(release),
    startDate: release.startDate,
    totalPauseDuration: release.totalPauseDuration,
    ...(versionString ? { versionString } : {}),
  };
}

const submissionJSON = (submission: ReviewSubmission | undefined | null) =>
  submission ? { id: submission.id, state: submission.state, submittedDate: submission.submittedDate } : null;

// MARK: prepare

export interface PrepareResult {
  version: string;
  versionId: string | null;
  created: boolean;
  renamed: boolean;
  build: { id: string; number: string } | null;
  releaseType: string | null;
  earliestReleaseDate: string | null;
  phased: boolean | null;
  pushed: { metadata: PushResult | null; media: PushResult | null };
  dryRun: boolean;
  /** What was done (or with dryRun, would be), for people. */
  steps: string[];
}

interface Prepared {
  result: PrepareResult;
  version?: AppStoreVersion;
  build: Build;
}

/** Brings the version to where it can be submitted. With dryRun, only reads. */
async function prepareVersion(context: ReleaseContext, versionString: string, plan: VersionPlan, options: ReleaseOptions): Promise<Prepared> {
  if (plan.action === "locked") throw lockedError(plan.version);
  const dryRun = Boolean(options.dryRun);
  const steps: string[] = [];
  const did = (done: string, planned: string) => {
    steps.push(dryRun ? planned : done);
    (dryRun ? ui.note : ui.ok).call(ui, dryRun ? `Would ${planned.charAt(0).toLowerCase()}${planned.slice(1)}` : done);
  };

  // Everything that can fail without changing anything comes first.
  const { timing, notes } = desiredTiming(options.release, context.storeApp, context.now);
  for (const note of notes) ui.note(note);
  const phased = options.phased ?? context.storeApp?.release?.phased;
  ui.step(options.build ? `Finding build ${options.build}` : `Finding the newest build of ${versionString}`);
  const build = await selectBuild(context, versionString, options.build);
  const { needsCompliance } = checkBuild(build, versionString);
  ui.ok(`Build ${build.number}`);

  let version: AppStoreVersion | undefined;
  let created = false;
  let renamed = false;
  let timingApplied = false;
  if (plan.action === "create") {
    if (!dryRun) {
      version = await createVersion(context.appId, context.platform, versionString, timing);
      timingApplied = Boolean(timing);
    }
    created = true;
    did(`Created version ${versionString}`, `Create version ${versionString}`);
  } else if (plan.action === "rename") {
    const from = plan.version.versionString;
    if (!dryRun) await updateVersion(plan.version.id, { versionString });
    version = { ...plan.version, versionString };
    renamed = true;
    did(`Renamed ${from} to ${versionString}`, `Rename ${from} to ${versionString}`);
  } else {
    version = plan.version;
    ui.ok(`Using version ${versionString} (${stateText(version.state)})`);
  }

  const pushed: PrepareResult["pushed"] = { metadata: null, media: null };
  if (options.push && dryRun && !version) {
    // A dry run doesn't create the version, so there's nothing yet to compare the store folder with.
    ui.warn(`--push: after ${versionString} is created, \`ship metadata diff --version ${versionString}\` shows what would change`);
  } else if (options.push) {
    // A dry-run rename hasn't renamed yet: compare with the version under its current name.
    const target = dryRun && plan.action === "rename" ? plan.version.versionString : versionString;
    ui.step("Pushing appstore/ text");
    pushed.metadata = await pushMetadata(context.project, { appId: context.appId, version: target, dryRun, platform: context.platform });
    ui.step("Pushing appstore/ screenshots");
    pushed.media = await pushMedia(context.project, { appId: context.appId, version: target, dryRun, platform: fromAscPlatform(context.platform) });
  }

  if (needsCompliance) {
    if (!dryRun) {
      await setExemptEncryption(build.id);
      build.usesNonExemptEncryption = false;
    }
    did("Answered export compliance (exempt: only Apple's encryption)", "Answer export compliance (exempt: only Apple's encryption)");
  }
  if (version?.buildId === build.id) ui.ok(`Build ${build.number} is already attached`);
  else {
    if (!dryRun && version) await attachBuild(version.id, build.id);
    did(`Attached build ${build.number}`, `Attach build ${build.number}`);
  }

  let releaseType = version?.releaseType ?? null;
  let earliestReleaseDate = version?.earliestReleaseDate ?? null;
  if (timing) {
    const changed = timing.releaseType !== releaseType || (timing.releaseType === "SCHEDULED" && !sameTime(timing.earliestReleaseDate, earliestReleaseDate));
    if (changed && !timingApplied && (version || dryRun)) {
      if (!dryRun && version) {
        await updateVersion(version.id, {
          releaseType: timing.releaseType,
          ...(timing.releaseType === "SCHEDULED" || earliestReleaseDate ? { earliestReleaseDate: timing.earliestReleaseDate } : {}),
        });
      }
      did(`Set the release to ${describeTiming(timing)}`, `Set the release to ${describeTiming(timing)}`);
    } else if (timingApplied) ui.ok(`Release: ${describeTiming(timing)}`);
    releaseType = timing.releaseType;
    earliestReleaseDate = timing.earliestReleaseDate;
  }

  let phasedNow: boolean | null = null;
  const current = version && !created ? await phasedRelease(version.id) : undefined;
  if (phased === true) {
    if (!current) {
      if (!dryRun && version) await createPhasedRelease(version.id);
      did("Turned on phased release (7 days)", "Turn on phased release (7 days)");
    }
    phasedNow = true;
  } else if (phased === false) {
    if (current && current.state === "INACTIVE") {
      if (!dryRun) await deletePhasedRelease(current.id);
      did("Turned off phased release", "Turn off phased release");
      phasedNow = false;
    } else if (current) {
      ui.warn(`The phased release has started (${stateText(current.state)}); \`ship release phased complete\` releases to everyone now`);
      phasedNow = true;
    } else phasedNow = false;
  } else if (version && !created) phasedNow = Boolean(current);
  else if (created) phasedNow = false;

  return {
    version,
    build,
    result: {
      version: versionString,
      versionId: version?.id ?? null,
      created,
      renamed,
      build: buildJSON(build),
      releaseType,
      earliestReleaseDate,
      phased: phasedNow,
      pushed,
      dryRun,
      steps,
    },
  };
}

const sameTime = (a: string | null, b: string | null) => (a && b ? new Date(a).getTime() === new Date(b).getTime() : a === b);

/** "after approval", "manually", "on Tue, Nov 3, 9:00 AM (after approval)". */
export function describeTiming(timing: { releaseType: string | null; earliestReleaseDate: string | null }): string {
  if (timing.releaseType === "MANUAL") return "manual (`ship release go` once it's approved)";
  if (timing.releaseType === "SCHEDULED" && timing.earliestReleaseDate) return `scheduled for ${localTime(timing.earliestReleaseDate)} (or approval, if later)`;
  return "automatic, as soon as it's approved";
}

export async function prepare(project: Project, options: ReleaseOptions): Promise<PrepareResult> {
  const context = await releaseContext(project, options, true);
  const versionString = await wantedVersion(project, options.version);
  const plan = planVersion(context.versions, versionString, { rename: options.rename });
  return (await prepareVersion(context, versionString, plan, options)).result;
}

// MARK: submit

export interface SubmitResult extends PrepareResult {
  checks: Check[];
  submission: { id: string; state: string; submittedDate: string | null } | null;
  submitted: boolean;
  alreadyInReview: boolean;
}

/** Everything the pre-submission checks read, after the version is prepared. */
async function preflight(context: ReleaseContext, version: AppStoreVersion, build: Build, dryRun: boolean): Promise<Check[]> {
  ui.step("Checking the version is ready for review");
  const [locales, infos, app, review, copyright] = await Promise.all([
    versionLocalizations(version.id),
    appInfos(context.appId),
    appReleaseInfo(context.appId),
    reviewContact(version.id),
    versionCopyright(version.id),
  ]);
  const info = editableAppInfo(infos) ?? liveAppInfo(infos) ?? infos[0];
  const primary = locales.find((locale) => locale.locale === app.primaryLocale) ?? locales[0];
  const [infoLocales, screenshots] = await Promise.all([info ? appInfoLocalizations(info.id) : [], primary ? screenshotTypes(primary.id) : []]);
  const checks = preflightChecks({
    platform: context.platform,
    update: context.versions.some((v) => LIVE_VERSION_STATES.includes(v.state)),
    primaryLocale: primary?.locale ?? app.primaryLocale,
    copyright,
    build,
    answersCompliance: dryRun,
    versionLocalizations: locales,
    infoLocalizations: infoLocales,
    screenshots,
    review,
    contentRights: app.contentRights,
  });
  for (const check of checks) {
    if (check.ok) ui.ok(check.detail);
    else (check.blocking ? ui.warn : ui.note).call(ui, check.blocking ? check.detail : `${check.detail} (not required)`);
  }
  return checks;
}

const emptyPrepare = (versionString: string, dryRun: boolean): PrepareResult => ({
  version: versionString,
  versionId: null,
  created: false,
  renamed: false,
  build: null,
  releaseType: null,
  earliestReleaseDate: null,
  phased: null,
  pushed: { metadata: null, media: null },
  dryRun,
  steps: [],
});

export async function submit(project: Project, options: ReleaseOptions): Promise<SubmitResult> {
  const dryRun = Boolean(options.dryRun);
  const context = await releaseContext(project, options, true);
  const versionString = await wantedVersion(project, options.version);
  const plan = planVersion(context.versions, versionString, { rename: options.rename });
  const submissions = await openSubmissions(context.appId, context.platform);

  // Already with Apple: nothing to do.
  const known = plan.action === "create" ? undefined : plan.version;
  const pick = pickSubmission(submissions, known?.id, versionString);
  if (pick.kind === "in-review" || (plan.action === "locked" && IN_REVIEW_STATES.includes(plan.version.state))) {
    const submission = pick.kind === "in-review" ? pick.submission : submissions.find((s) => known && hasVersion(s, known.id));
    ui.ok(`${versionString} is already ${versionStateText(known?.state ?? "WAITING_FOR_REVIEW")}`);
    return {
      ...emptyPrepare(versionString, dryRun),
      versionId: known?.id ?? null,
      build: known?.buildId ? { id: known.buildId, number: known.buildNumber ?? "" } : null,
      releaseType: known?.releaseType ?? null,
      earliestReleaseDate: known?.earliestReleaseDate ?? null,
      checks: [],
      submission: submissionJSON(submission),
      submitted: false,
      alreadyInReview: true,
    };
  }

  const { result, version, build } = await prepareVersion(context, versionString, plan, options);
  const checks = version ? await preflight(context, version, build, dryRun) : [];
  if (!version) ui.note("The checks run once the version exists");
  const blocking = blockingFailures(checks);
  if (blocking.length && !dryRun) {
    throw new ShipError(
      `${versionString} isn't ready for review: ${blocking.map((check) => check.name).join(", ")}`,
      "not-ready",
      [...new Set(blocking.map((check) => check.fix).filter(Boolean))].join("\n  "),
      { checks },
    );
  }

  if (dryRun) {
    const reuse = pick.kind === "reuse" ? pick.submission : undefined;
    const step = reuse ? `Submit ${versionString} with the ${reuse.state === "UNRESOLVED_ISSUES" ? "rejected" : "draft"} submission` : `Create a submission and submit ${versionString}`;
    result.steps.push(step);
    ui.note(`Would ${step.charAt(0).toLowerCase()}${step.slice(1)}`);
    return { ...result, checks, submission: submissionJSON(reuse), submitted: false, alreadyInReview: false };
  }

  let submission: ReviewSubmission;
  if (pick.kind === "reuse") {
    submission = pick.submission;
    ui.ok(`Using the ${submission.state === "UNRESOLVED_ISSUES" ? "rejected" : "draft"} submission`);
  } else {
    submission = await createSubmission(context.appId, context.platform);
    ui.ok("Started a submission");
  }
  if (!hasVersion(submission, version!.id)) {
    await addSubmissionItem(submission.id, version!.id);
    ui.ok(`Added ${versionString} to it`);
  }
  ui.step("Submitting for review");
  const sent = (await submitSubmission(submission.id)) ?? { ...submission, state: "WAITING_FOR_REVIEW" };
  ui.ok(`Submitted ${versionString} for review`);
  result.steps.push(`Submitted ${versionString} for review`);
  return { ...result, checks, submission: submissionJSON(sent), submitted: true, alreadyInReview: false };
}

// MARK: status

export interface StatusResult {
  app: string;
  platform: AscPlatform;
  version: {
    id: string;
    versionString: string;
    state: string;
    releaseType: string | null;
    earliestReleaseDate: string | null;
    build: { id: string; number: string } | null;
  } | null;
  live: { id: string; versionString: string; state: string; phasedRelease: ReturnType<typeof phasedJSON> } | null;
  submission: { id: string; state: string; submittedDate: string | null } | null;
  /** The phased release of `version`, or else of `live`; versionString says which. */
  phasedRelease: ReturnType<typeof phasedJSON>;
}

/** The newest version that isn't live yet (being prepared, in review, or approved), newer than the live one. */
export function pendingVersion(versions: AppStoreVersion[]): AppStoreVersion | undefined {
  const liveIndex = versions.findIndex((version) => LIVE_VERSION_STATES.includes(version.state));
  return versions.slice(0, liveIndex === -1 ? undefined : liveIndex).find((version) => version.state !== "REPLACED_WITH_NEW_VERSION");
}

/** The version --version names, or an error naming the versions there are. */
function namedVersion(versions: AppStoreVersion[], versionString: string): AppStoreVersion {
  const version = pickVersion(versions, checkVersion(versionString));
  if (!version) {
    throw new ShipError(
      `App Store Connect has no version ${versionString}`,
      "no-version",
      versions.length
        ? `It has ${versions.slice(0, 5).map((v) => v.versionString).join(", ")}. Start ${versionString} with \`ship release prepare --version ${versionString}\`.`
        : `Start it with \`ship release prepare --version ${versionString}\`.`,
      { choices: versions.map((v) => v.versionString) },
    );
  }
  return version;
}

export async function releaseStatus(project: Project, options: ReleaseOptions): Promise<StatusResult> {
  const context = await releaseContext(project, options);
  const version = options.version ? namedVersion(context.versions, options.version) : pendingVersion(context.versions);
  const live = context.versions.find((v) => LIVE_VERSION_STATES.includes(v.state));
  const [submissions, versionPhased, livePhased] = await Promise.all([
    openSubmissions(context.appId, context.platform),
    version && version !== live ? phasedRelease(version.id) : undefined,
    live ? phasedRelease(live.id) : undefined,
  ]);
  const submission = (version && submissions.find((s) => hasVersion(s, version.id))) || submissions[0];
  return {
    app: project.config.name,
    platform: context.platform,
    version: version
      ? {
          id: version.id,
          versionString: version.versionString,
          state: version.state,
          releaseType: version.releaseType ?? null,
          earliestReleaseDate: version.earliestReleaseDate ?? null,
          build: version.buildId ? { id: version.buildId, number: version.buildNumber ?? "" } : null,
        }
      : null,
    live: live ? { id: live.id, versionString: live.versionString, state: live.state, phasedRelease: phasedJSON(livePhased) } : null,
    submission: submissionJSON(submission),
    phasedRelease: version && version !== live && versionPhased ? phasedJSON(versionPhased, version.versionString) : live ? phasedJSON(livePhased, live.versionString) : null,
  };
}

/** What a version's state means, for people. */
const STATE_TEXT: Record<string, string> = {
  PREPARE_FOR_SUBMISSION: "being prepared",
  READY_FOR_REVIEW: "ready to submit",
  WAITING_FOR_REVIEW: "waiting for review",
  IN_REVIEW: "in review",
  ACCEPTED: "approved",
  PENDING_DEVELOPER_RELEASE: "approved, waiting for you to release it (`ship release go`)",
  PENDING_APPLE_RELEASE: "approved, releasing soon",
  PROCESSING_FOR_DISTRIBUTION: "approved, on its way to the App Store",
  READY_FOR_DISTRIBUTION: "live",
  REJECTED: "rejected (see App Store Connect's App Review messages)",
  METADATA_REJECTED: "rejected for its page (see App Store Connect's App Review messages)",
  DEVELOPER_REJECTED: "taken out of review",
  INVALID_BINARY: "rejected: the build is invalid",
  WAITING_FOR_EXPORT_COMPLIANCE: "waiting for export compliance",
};

export const versionStateText = (state: string) => STATE_TEXT[state] ?? stateText(state);

/** The status for people: "1.4 (build 37): waiting for review, submitted 2 hours ago. Releases …" */
export function statusLines(status: StatusResult, now = new Date()): string[] {
  const lines: string[] = [];
  const { version, live, submission } = status;
  // A live version is described by the live line below.
  if (version && version.id !== live?.id) {
    const build = version.build ? ` (build ${version.build.number})` : " (no build yet)";
    const submitted =
      submission?.submittedDate && ["WAITING_FOR_REVIEW", "IN_REVIEW"].includes(version.state) ? `, submitted ${ago(submission.submittedDate, now)}` : "";
    const phased = status.phasedRelease && status.phasedRelease.versionString === version.versionString ? ", phased over 7 days" : "";
    const release = `Releases ${
      version.releaseType === "MANUAL"
        ? "when you run `ship release go` after approval"
        : version.releaseType === "SCHEDULED" && version.earliestReleaseDate
          ? `after approval, no earlier than ${localTime(version.earliestReleaseDate)}`
          : "automatically after approval"
    }${phased}.`;
    lines.push(`${version.versionString}${build}: ${versionStateText(version.state)}${submitted}. ${release}`);
  }
  if (live) {
    const phased = live.phasedRelease;
    const rollout =
      phased?.state === "ACTIVE"
        ? `; phased release day ${phased.currentDayNumber ?? 1} of 7 (${phased.percent}%)`
        : phased?.state === "PAUSED"
          ? `; phased release paused on day ${phased.currentDayNumber ?? 1} (${phased.percent}%)`
          : "";
    lines.push(`${live.versionString} is live${rollout}.`);
  }
  if (!version && !live) lines.push("No App Store version yet. Start one with `ship release prepare`.");
  // The version's line already says when it was submitted.
  const described = version && submission?.submittedDate && ["WAITING_FOR_REVIEW", "IN_REVIEW"].includes(version.state);
  if (submission && !described) {
    const what: Record<string, string> = {
      READY_FOR_REVIEW: "a draft, not submitted yet (`ship release submit`)",
      UNRESOLVED_ISSUES: "rejected; fix what App Review found, then `ship release submit` again",
    };
    const when = submission.submittedDate ? `, submitted ${ago(submission.submittedDate, now)}` : "";
    lines.push(`Review submission: ${what[submission.state] ?? `${stateText(submission.state)}${when}`}.`);
  }
  return lines;
}

// MARK: go, cancel, phased

export async function releaseNow(project: Project, options: ReleaseOptions): Promise<{ version: string; released: boolean; dryRun: boolean }> {
  const context = await releaseContext(project, options);
  const version = options.version
    ? namedVersion(context.versions, options.version)
    : (context.versions.find((v) => v.state === "PENDING_DEVELOPER_RELEASE") ?? pendingVersion(context.versions));
  if (!version) throw new ShipError("There's no version to release", "no-version", "Start one with `ship release submit`.");
  if (version.state !== "PENDING_DEVELOPER_RELEASE") {
    const hints: Record<string, string> = {
      READY_FOR_DISTRIBUTION: "It's already on the App Store.",
      PENDING_APPLE_RELEASE: "It's approved and Apple is releasing it (it was set to release automatically or on a date).",
      PROCESSING_FOR_DISTRIBUTION: "It's already on its way to the App Store.",
      WAITING_FOR_REVIEW: "It's waiting for review; once approved, `ship release go` releases it. `ship release status` follows it.",
      IN_REVIEW: "It's in review; once approved, `ship release go` releases it. `ship release status` follows it.",
    };
    throw new ShipError(
      `${version.versionString} is ${versionStateText(version.state)}, not waiting to be released`,
      "not-pending-release",
      hints[version.state] ?? "Submit it first with `ship release submit`; with --release manual it waits for `ship release go` once approved.",
      { version: version.versionString, state: version.state },
    );
  }
  if (!options.dryRun) {
    ui.step(`Releasing ${version.versionString}`);
    await requestRelease(version.id);
  }
  return { version: version.versionString, released: !options.dryRun, dryRun: Boolean(options.dryRun) };
}

export async function cancelReview(project: Project, options: ReleaseOptions): Promise<{ submission: { id: string; state: string }; canceled: boolean; dryRun: boolean }> {
  const context = await releaseContext(project, options);
  const version = options.version ? namedVersion(context.versions, options.version) : undefined;
  const submissions = (await openSubmissions(context.appId, context.platform)).filter((s) => CANCELABLE_STATES.includes(s.state));
  const target = version ? submissions.find((s) => hasVersion(s, version.id)) : submissions[0];
  if (!target) {
    throw new ShipError(
      version ? `${version.versionString} has nothing in review` : "There's nothing in review",
      "nothing-in-review",
      "`ship release status` shows where things are.",
    );
  }
  if (options.dryRun) return { submission: { id: target.id, state: target.state }, canceled: false, dryRun: true };
  ui.step("Taking the submission out of review");
  const canceled = await cancelSubmission(target.id);
  return { submission: { id: target.id, state: canceled?.state ?? "CANCELING" }, canceled: true, dryRun: false };
}

export async function phasedCommand(project: Project, action: string | undefined, options: ReleaseOptions) {
  if (!action || !PHASED_ACTIONS.includes(action as PhasedAction)) {
    throw new ShipError(
      action ? `Unknown phased release action "${action}"` : "Pause, resume, or complete?",
      "usage",
      `Pick one: ship release phased ${PHASED_ACTIONS.join(" | ")}`,
      { choices: PHASED_ACTIONS },
      2,
    );
  }
  const context = await releaseContext(project, options);
  const version = options.version ? namedVersion(context.versions, options.version) : context.versions.find((v) => LIVE_VERSION_STATES.includes(v.state));
  if (!version) throw new ShipError("No version is live yet", "no-live-version", "A phased release starts once a version is released. `ship release status` shows where things are.");
  const release = await phasedRelease(version.id);
  if (!release) {
    throw new ShipError(
      `${version.versionString} isn't released in phases`,
      "no-phased-release",
      "Turn it on before release with `ship release prepare --phased`.",
    );
  }
  const to = phasedTransition(release.state, action as PhasedAction);
  if (options.dryRun) return { version: version.versionString, phasedRelease: phasedJSON(release), to, dryRun: true };
  const updated = await setPhasedReleaseState(release.id, to);
  return { version: version.versionString, phasedRelease: phasedJSON(updated), to, dryRun: false };
}

// MARK: Output

function printPrepare(result: PrepareResult) {
  const what = result.dryRun ? "Would prepare" : "Prepared";
  console.log(`${what} ${result.version}${result.build ? ` with build ${result.build.number}` : ""}.`);
  if (result.releaseType) console.log(`Release: ${describeTiming(result)}${result.phased ? ", phased over 7 days" : ""}.`);
  for (const [name, pushed] of Object.entries(result.pushed)) {
    if (pushed) console.log(`${name === "metadata" ? "Text" : "Screenshots"}: ${pushed.changes.length} change${pushed.changes.length === 1 ? "" : "s"}${pushed.applied ? " pushed" : ""}.`);
  }
}

function printChecks(checks: Check[]) {
  for (const check of checks) console.log(`${check.ok ? "✓" : check.blocking ? "✗" : "!"} ${check.detail}${!check.ok && check.fix ? `\n    ${check.fix}` : ""}`);
}

// MARK: Command

const ACTIONS = ["status", "prepare", "submit", "go", "cancel", "phased"];

function releaseOptions(ctx: Context): ReleaseOptions {
  if (boolFlag(ctx, "phased") && boolFlag(ctx, "no-phased")) {
    throw new ShipError("Pass --phased or --no-phased, not both", "usage", "--phased releases over 7 days; --no-phased to everyone at once.", { choices: ["--phased", "--no-phased"] }, 2);
  }
  const platform = stringFlag(ctx, "platform");
  const version = stringFlag(ctx, "version");
  const build = stringFlag(ctx, "build");
  // A bad --release is a usage error before anything talks to App Store Connect.
  const when = stringFlag(ctx, "release");
  if (when !== undefined) parseRelease(when);
  return {
    version: version === undefined ? undefined : checkVersion(version),
    build: build === undefined ? undefined : checkBuildNumber(build),
    push: boolFlag(ctx, "push"),
    release: stringFlag(ctx, "release"),
    phased: boolFlag(ctx, "phased") ? true : boolFlag(ctx, "no-phased") ? false : undefined,
    rename: boolFlag(ctx, "rename"),
    dryRun: boolFlag(ctx, "dry-run"),
    platform: platform === undefined ? undefined : platformInfo(parsePlatform(platform)).asc,
  };
}

async function release(ctx: Context) {
  const action = ctx.args[0] ?? "status";
  if (!ACTIONS.includes(action)) {
    throw new ShipError(`Unknown release action "${action}"`, "usage", `Pick one: ship release ${ACTIONS.join(" | ")}`, { choices: ACTIONS }, 2);
  }
  const options = releaseOptions(ctx);
  const project = await loadProject({ app: ctx.app });
  switch (action) {
    case "status": {
      const status = await releaseStatus(project, options);
      ui.result(status, () => console.log(statusLines(status).join("\n")));
      return;
    }
    case "prepare": {
      const result = await prepare(project, options);
      ui.result(result, () => printPrepare(result));
      return;
    }
    case "submit": {
      const result = await submit(project, options);
      ui.result(result, () => {
        if (result.alreadyInReview) {
          console.log(`${result.version} is already with App Review. \`ship release status\` follows it.`);
          return;
        }
        printPrepare(result);
        printChecks(result.checks);
        if (result.submitted) console.log(`Submitted ${result.version} for review (usually a day or two). \`ship release status\` follows it.`);
        else if (result.dryRun) {
          const blocking = blockingFailures(result.checks);
          console.log(blocking.length ? `Would stop: ${blocking.map((c) => c.name).join(", ")} must be fixed first.` : `Would submit ${result.version} for review.`);
        }
      });
      return;
    }
    case "go": {
      const result = await releaseNow(project, options);
      ui.result(result, () => console.log(result.dryRun ? `Would release ${result.version}.` : `Released ${result.version}. It reaches the App Store within a few hours.`));
      return;
    }
    case "cancel": {
      const result = await cancelReview(project, options);
      ui.result(result, () => console.log(result.dryRun ? "Would take the submission out of review." : "Took the submission out of review. Change what you need, then `ship release submit` again."));
      return;
    }
    case "phased": {
      const result = await phasedCommand(project, ctx.args[1], options);
      ui.result(result, () =>
        console.log(
          result.dryRun
            ? `Would set ${result.version}'s phased release to ${stateText(result.to)}.`
            : result.to === "COMPLETE"
              ? `${result.version} is now released to everyone.`
              : `${result.version}'s phased release is ${stateText(result.to)}${result.phasedRelease ? ` (day ${result.phasedRelease.currentDayNumber ?? "–"}, ${result.phasedRelease.percent}%)` : ""}.`,
        ),
      );
      return;
    }
  }
}

export const commands: Command[] = [
  {
    name: "release",
    index: [
      { section: "appstore", label: "release", summary: "Review and release status" },
      { section: "appstore", label: "release prepare", summary: "Create the version and attach a build" },
      { section: "appstore", label: "release submit", summary: "Submit a version for App Store review" },
    ],
    help: releaseHelp,
    flags: {
      version: { type: "string" },
      build: { type: "string" },
      release: { type: "string" },
      platform: { type: "string" },
      push: { type: "boolean" },
      phased: { type: "boolean" },
      "no-phased": { type: "boolean" },
      rename: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    run: release,
  },
];
