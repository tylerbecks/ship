// ship builds: the app's builds with their commits and when they expire, one
// build in detail, and expiring old ones from TestFlight.

import {
  BUILD_USE_QUERY,
  type Build,
  type BuildDetail,
  type BuildFilter,
  DAY_MS,
  buildDetails,
  daysLeft,
  expireBuild,
  expiresLabel,
  listBuilds,
} from "../asc/builds";
import { type Command, type Context, boolFlag, intFlag, stringFlag } from "../command";
import { type Project, loadProject } from "../config";
import { buildCommits, fetchBuildTags } from "../git";
import { checkBuildNumber } from "../build";
import { type AscPlatform, platformInfo } from "../platform";
import { ShipError, table, ui } from "../ui";
import { appId, friendly, printBuilds } from "./status";

export const buildsHelp = `ship builds [--version <x.y>] [--limit <n>] [--processing | --failed] [--expired | --all]
ship builds show <n> [--version <x.y>]
ship builds expire <n>... [--dry-run]
ship builds expire --older-than <age> [--keep <n>] [--version <x.y>] [--dry-run]

Lists the app's builds, newest first, with the commit each came from, its
TestFlight state, and when it expires. show prints one build in detail:
What to Test, groups, Beta App Review, and the App Store version it's in.

expire takes builds out of TestFlight: testers can't install them anymore,
and it can't be undone. Pick builds by number or by age (like 30d, 2w, or
12h); --keep always keeps the newest few. Builds attached to an App Store
version in review, waiting to release, or live are never expired.

  --version <x.y>     Only builds of this version
  --limit <n>         How many to list (default 20)
  --processing        Only builds still processing
  --failed            Only builds that failed processing
  --expired           Only expired builds
  --all               Include expired builds
  --older-than <age>  expire: builds uploaded longer ago than this
  --keep <n>          expire: keep the newest n valid builds (default 1)
  --dry-run           expire: show what would expire`;

const ACTIONS = ["list", "show", "expire"];

const usage = (message: string, hint: string, details?: Record<string, unknown>) => new ShipError(message, "usage", hint, details, 2);

/** A build with its commit (from its testflight/<build> tag) and days until it expires. */
export type ListedBuild = Build & { commit: string | null; daysLeft: number | null };

/** Adds each build's commit, after fetching the tags from origin (best effort, like status). */
async function withCommits<B extends Build>(project: Project, builds: B[]): Promise<(B & { commit: string | null; daysLeft: number | null })[]> {
  await fetchBuildTags(project.root);
  const commits = await buildCommits(project.root);
  return builds.map((build) => ({ ...build, commit: commits.get(build.number) ?? null, daysLeft: daysLeft(build) }));
}

/** Flags that only one action takes. Passing them to another is a usage error, not silently ignored. */
function checkFlagsFor(ctx: Context, action: string) {
  const only: Record<string, string[]> = {
    list: ["limit", "processing", "failed", "expired", "all"],
    expire: ["older-than", "keep", "dry-run"],
  };
  for (const [owner, names] of Object.entries(only)) {
    if (owner === action) continue;
    const name = names.find((flag) => ctx.flags[flag] !== undefined && ctx.flags[flag] !== false);
    if (name) {
      throw usage(`--${name} works with \`ship builds${owner === "list" ? "" : ` ${owner}`}\`, not ${action}`, "See `ship builds --help`.");
    }
  }
}

// MARK: Listing

/** The list's filter from its flags. --processing and --failed together list both; --all wins over --expired. */
export function listFilter(ctx: Context, platform?: AscPlatform): BuildFilter {
  const states = [...(boolFlag(ctx, "processing") ? ["PROCESSING"] : []), ...(boolFlag(ctx, "failed") ? ["FAILED", "INVALID"] : [])];
  return {
    version: stringFlag(ctx, "version"),
    platform,
    processingState: states.length ? states : undefined,
    // Expired builds are hidden unless asked for.
    expired: boolFlag(ctx, "all") ? undefined : boolFlag(ctx, "expired"),
    limit: intFlag(ctx, "limit", { min: 1, max: 1000 }) ?? 20,
    sort: "-uploadedDate",
  };
}

export async function listCommand(ctx: Context) {
  const filter = listFilter(ctx);
  const project = await loadProject({ app: ctx.app });
  const id = await appId(project);
  const builds: ListedBuild[] = await withCommits(project, await listBuilds(id, { ...filter, platform: platformInfo(project.platform).asc }));
  const filtered = Boolean(filter.version || filter.processingState || filter.expired !== false);
  ui.result({ builds }, () => {
    if (!builds.length && filtered) console.log("No builds match. `ship builds --all` lists every build.");
    else printBuilds(builds);
  });
}

// MARK: Showing

export async function showCommand(ctx: Context) {
  const [number, ...extra] = ctx.args.slice(1);
  if (!number) throw usage("Which build? ship builds show <n>", "`ship builds` lists the build numbers.");
  if (extra.length) throw usage(`show takes one build number, not ${ctx.args.length - 1}`, `For example: ship builds show ${number}`);
  checkBuildNumber(number);
  const project = await loadProject({ app: ctx.app });
  const id = await appId(project);
  const version = stringFlag(ctx, "version");
  const matches = await buildDetails(id, number, { version, platform: platformInfo(project.platform).asc });
  const build = (await withCommits(project, [pickOne(number, matches, version)]))[0]!;
  ui.result({ build }, () => printDetail(build));
}

/** The one build with this number, or an error naming the versions to pick from. */
export function pickOne<B extends Build>(number: string, builds: B[], version?: string): B {
  if (!builds.length) {
    throw new ShipError(
      `No build ${number}${version ? ` of version ${version}` : ""} in App Store Connect`,
      "no-build",
      "`ship builds --all` lists them (a new upload appears a few minutes after it finishes).",
      { number },
    );
  }
  if (builds.length > 1) {
    const choices = builds.map((build) => build.version ?? "").filter(Boolean);
    throw usage(
      `${builds.length} builds are numbered ${number} (versions ${choices.join(", ")})`,
      `Pick one with --version, like --version ${choices[0] ?? "1.0"}`,
      { choices },
    );
  }
  return builds[0]!;
}

function printDetail(build: BuildDetail & { commit: string | null }) {
  const when = (date: string) => new Date(date).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const expires = expiresLabel(build);
  const rows: [string, string][] = [
    ["Uploaded", when(build.uploadedDate)],
    ["Commit", build.commit?.slice(0, 7) ?? "not tagged"],
    ["Processing", friendly(build.processingState)],
    ["Internal", friendly(build.internalState)],
    ["External", friendly(build.externalState)],
    ["Expires", expires && build.expirationDate && !build.expired ? `${expires} (${when(build.expirationDate)})` : expires],
    ["Beta review", build.betaReview ? friendly(build.betaReview) : "not submitted"],
    ["App Store", build.appStoreVersion ? `${build.appStoreVersion.versionString} (${friendly(build.appStoreVersion.state)})` : "not in a version"],
    ["Groups", build.groups.join(", ") || "none"],
    ["Min OS", build.minOsVersion ?? ""],
  ];
  const platform = build.platform ? ` · ${build.platform}` : "";
  console.log(`Build ${build.number}${build.version ? ` (${build.version})` : ""}${platform}`);
  console.log(table(rows.filter(([, value]) => value).map(([key, value]) => [`  ${key}`, value])));
  const locales = Object.entries(build.whatToTest).filter(([, text]) => text.trim());
  for (const [locale, text] of locales) console.log(`\nWhat to Test (${locale}):\n${text.replace(/^/gm, "  ")}`);
  if (!locales.length) console.log("\nNo What to Test yet. `ship distribute <n> --notes …` sets it.");
}

// MARK: Expiring

/** App Store version states in which a build stays: submitted, approved, releasing, or live. */
export const IN_USE_STATES = [
  "WAITING_FOR_EXPORT_COMPLIANCE",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "ACCEPTED",
  "PENDING_DEVELOPER_RELEASE",
  "PENDING_APPLE_RELEASE",
  "PROCESSING_FOR_DISTRIBUTION",
  "READY_FOR_DISTRIBUTION",
];

const inUse = (build: Build) => Boolean(build.appStoreVersion && IN_USE_STATES.includes(build.appStoreVersion.state));

const AGE_UNITS: Record<string, number> = { h: 60 * 60 * 1000, d: DAY_MS, w: 7 * DAY_MS };

/** An age like 30d, 2w, or 12h, in milliseconds. */
export function parseAge(value: string): number {
  const match = value.trim().match(/^(\d+)\s*([hdw])$/i);
  const amount = match ? Number(match[1]) : 0;
  if (!match || amount <= 0) {
    throw usage(`--older-than takes an age like 30d, not "${value}"`, "For example: --older-than 30d (days), 2w (weeks), or 12h (hours).");
  }
  return amount * AGE_UNITS[match[2]!.toLowerCase()]!;
}

export interface ExpirePick {
  expire: Build[];
  skipped: { number: string; reason: string }[];
}

export interface ExpireOptions {
  numbers?: string[];
  /** Milliseconds (see parseAge). */
  olderThan?: number;
  keep?: number;
  version?: string;
}

/** Usage errors for expire's arguments: numbers or --older-than (one of them), and --keep only with --older-than. */
export function checkExpireOptions(options: ExpireOptions) {
  const numbers = options.numbers ?? [];
  const example = "For example: ship builds expire 41 42, or ship builds expire --older-than 30d";
  if (numbers.length && options.olderThan !== undefined) throw usage("Pick builds by number or with --older-than, not both", example);
  if (!numbers.length && options.olderThan === undefined) throw usage("Which builds? ship builds expire <n>... or --older-than <age>", example);
  if (numbers.length && options.keep !== undefined) throw usage("--keep works with --older-than", example);
}

/**
 * Which builds to expire: the ones named by number, or the ones uploaded
 * more than `olderThan` ms before `now`, keeping the newest `keep` valid
 * builds. Builds still processing or already expired are skipped. A build in
 * an App Store version that's in review, releasing, or live is never
 * expired; naming one is an error.
 */
export function pickBuildsToExpire(builds: Build[], options: ExpireOptions & { now?: number }): ExpirePick {
  checkExpireOptions(options);
  const numbers = [...new Set(options.numbers ?? [])];
  const expire: Build[] = [];
  const skipped: ExpirePick["skipped"] = [];
  const skip = (build: Build): string | undefined =>
    build.expired ? "already expired" : build.processingState === "PROCESSING" ? "still processing" : undefined;

  if (numbers.length) {
    for (const number of numbers) {
      const build = pickOne(number, builds.filter((b) => b.number === number), options.version);
      if (inUse(build)) {
        const version = build.appStoreVersion!;
        throw new ShipError(
          `Build ${number} is in App Store version ${version.versionString} (${friendly(version.state)})`,
          "build-in-use",
          "Builds in review, waiting to release, or live stay in TestFlight. `ship builds` lists the others.",
          { number, version: version.versionString, state: version.state },
        );
      }
      const reason = skip(build);
      if (reason) skipped.push({ number, reason });
      else expire.push(build);
    }
    return { expire, skipped };
  }

  const keep = options.keep ?? 1;
  const cutoff = (options.now ?? Date.now()) - options.olderThan!;
  const newestFirst = [...builds].sort((a, b) => Date.parse(b.uploadedDate) - Date.parse(a.uploadedDate));
  const kept = new Set(newestFirst.filter((b) => b.processingState === "VALID" && !b.expired).slice(0, keep));
  for (const build of newestFirst) {
    if (build.expired || !(Date.parse(build.uploadedDate) < cutoff)) continue;
    const reason =
      skip(build) ??
      (kept.has(build) ? `one of the newest ${keep === 1 ? "valid build" : `${keep} valid builds`} (--keep)` : undefined) ??
      (inUse(build) ? `in App Store version ${build.appStoreVersion!.versionString} (${friendly(build.appStoreVersion!.state)})` : undefined);
    if (reason) skipped.push({ number: build.number, reason });
    else expire.push(build);
  }
  return { expire, skipped };
}

export interface Expired {
  number: string;
  id: string;
  version: string | null;
  uploadedDate: string;
}

const expiredEntry = (build: Build): Expired => ({ number: build.number, id: build.id, version: build.version ?? null, uploadedDate: build.uploadedDate });

/** Expires builds one at a time. A failure names the builds already expired, so a re-run knows where it stopped. */
export async function expireAll(builds: Build[]): Promise<Expired[]> {
  const done: Expired[] = [];
  for (const build of builds) {
    try {
      await expireBuild(build.id);
    } catch (error) {
      if (!(error instanceof ShipError)) throw error;
      const so = done.length ? `Already expired: ${done.map((b) => b.number).join(", ")}. ` : "Nothing was expired. ";
      throw new ShipError(`Couldn't expire build ${build.number}: ${error.message}`, error.code, `${so}${error.hint ?? ""}`.trim(), {
        ...error.details,
        expired: done,
        failed: build.number,
      }, error.exitCode);
    }
    done.push(expiredEntry(build));
    ui.ok(`Expired build ${build.number}${build.version ? ` (${build.version})` : ""}`);
  }
  return done;
}

export async function expireCommand(ctx: Context) {
  const age = stringFlag(ctx, "older-than");
  const options: ExpireOptions = {
    numbers: ctx.args.slice(1).map(checkBuildNumber),
    olderThan: age === undefined ? undefined : parseAge(age),
    keep: intFlag(ctx, "keep", { min: 0, max: 1000 }),
    version: stringFlag(ctx, "version"),
  };
  const dryRun = boolFlag(ctx, "dry-run");
  checkExpireOptions(options);

  const project = await loadProject({ app: ctx.app });
  const id = await appId(project);
  const platform = platformInfo(project.platform).asc;
  ui.step("Reading builds");
  // By number: those builds, expired or not, so the result can say so. By age: every build not expired yet.
  const builds = options.numbers!.length
    ? await listBuilds(id, { number: options.numbers, version: options.version, platform, limit: 200 }, BUILD_USE_QUERY)
    : await listBuilds(id, { version: options.version, platform, expired: false, limit: 5000 }, BUILD_USE_QUERY);
  const pick = pickBuildsToExpire(builds, options);
  for (const { number, reason } of pick.skipped) ui.note(`Keeping ${number}: ${reason}`);

  const expired = dryRun ? pick.expire.map(expiredEntry) : await expireAll(pick.expire);
  ui.result({ dryRun, expired, skipped: pick.skipped }, () => {
    if (!expired.length) return console.log(pick.skipped.length ? "No builds to expire." : "No builds that old.");
    if (dryRun) {
      console.log(`Would expire ${expired.length} build${expired.length === 1 ? "" : "s"}:`);
      console.log(table([["BUILD", "VERSION", "UPLOADED"], ...expired.map((b) => [b.number, b.version ?? "", new Date(b.uploadedDate).toLocaleDateString()])]));
    } else {
      console.log(`Expired ${expired.length} build${expired.length === 1 ? "" : "s"}: ${expired.map((b) => b.number).join(", ")}.`);
    }
  });
}

// MARK: Command

export const commands: Command[] = [
  {
    name: "builds",
    index: [{ section: "daily", label: "builds", summary: "Builds, their commits, and when they expire" }],
    help: buildsHelp,
    flags: {
      version: { type: "string" },
      limit: { type: "string" },
      "older-than": { type: "string" },
      keep: { type: "string" },
      processing: { type: "boolean" },
      failed: { type: "boolean" },
      expired: { type: "boolean" },
      all: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    run: async (ctx) => {
      const action = ctx.args[0] ?? "list";
      if (!ACTIONS.includes(action)) {
        const hint = /^\d/.test(action) ? `To see build ${action}: ship builds show ${action}` : "Use ship builds, ship builds show <n>, or ship builds expire <n>...";
        throw usage(`Unknown action "${action}"`, hint, { choices: ACTIONS });
      }
      checkFlagsFor(ctx, action);
      if (action === "show") return showCommand(ctx);
      if (action === "expire") return expireCommand(ctx);
      if (ctx.args.length > 1) throw usage(`ship builds takes no arguments, not "${ctx.args.slice(1).join(" ")}"`, `To see one build: ship builds show ${ctx.args[1]}`);
      return listCommand(ctx);
    },
  },
];
