import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Build, BUILD_USE_QUERY, DAY_MS, buildDetails, buildsPath, daysLeft, expiresLabel, listBuilds } from "../src/asc/builds";
import type { Context } from "../src/command";
import { commands, expireAll, listFilter, parseAge, pickBuildsToExpire } from "../src/commands/builds";
import { expiringSoon } from "../src/commands/status";
import { loadProject } from "../src/config";
import {
  cleanSubject,
  commitSubjects,
  compareBuildNumbers,
  fitLines,
  gitNotes,
  notesFromCommits,
  previousBuild,
  readNotesFile,
  resolveNotes,
  wantsGitNotes,
  whatToTest,
} from "../src/notes";
import { ui } from "../src/ui";
import { captureLog, git, jsonApi, mockAsc, noRetryDelay, resource, temp, testCredentials } from "./helpers";

const ctx = (flags: Context["flags"] = {}, args: string[] = []): Context => ({ args, flags, implicit: false });

const code = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (error) {
    return error as { code?: string; exitCode?: number; hint?: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected an error");
};

const NOW = Date.parse("2026-10-21T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY_MS).toISOString();

const build = (number: string, extra: Partial<Build> = {}): Build => ({
  id: `id-${number}`,
  number,
  version: "1.0",
  uploadedDate: ago(Number(number)),
  processingState: "VALID",
  expired: false,
  ...extra,
});

// MARK: Cleaning subjects

describe("cleanSubject", () => {
  test("handles this repo's emoji conventional commits", () => {
    expect(cleanSubject("🚀 feat: tag each TestFlight upload with its commit (#1)")).toEqual({ type: "feat", text: "Tag each TestFlight upload with its commit" });
    expect(cleanSubject("🐛 fix: skip internal groups that get every build automatically")).toEqual({
      type: "fix",
      text: "Skip internal groups that get every build automatically",
    });
  });

  test("strips multi-codepoint emoji: variation selectors, joiners, skin tones, flags", () => {
    expect(cleanSubject("🛠️ refactor: split the client")).toEqual({ type: "refactor", text: "Split the client" });
    expect(cleanSubject("👨‍👩‍👧 family sharing")).toEqual({ text: "Family sharing" });
    expect(cleanSubject("👍🏽 thumbs")).toEqual({ text: "Thumbs" });
    expect(cleanSubject("🇺🇸 US storefront")).toEqual({ text: "US storefront" });
    expect(cleanSubject("⚡ perf: faster search")).toEqual({ type: "perf", text: "Faster search" });
  });

  test("strips gitmoji codes", () => {
    expect(cleanSubject(":sparkles: add login")).toEqual({ text: "Add login" });
    expect(cleanSubject(":bug: :ambulance: fix: crash on launch")).toEqual({ type: "fix", text: "Crash on launch" });
  });

  test("strips scopes, the breaking !, and an emoji after the prefix", () => {
    expect(cleanSubject("feat(search): match tags")).toEqual({ type: "feat", text: "Match tags" });
    expect(cleanSubject("feat(api)!: drop v1")).toEqual({ type: "feat", text: "Drop v1" });
    expect(cleanSubject("fix!: reset state")).toEqual({ type: "fix", text: "Reset state" });
    expect(cleanSubject("ui(button): rounder")).toEqual({ type: "ui", text: "Rounder" });
    expect(cleanSubject("fix: ✨ shinier")).toEqual({ type: "fix", text: "Shinier" });
    expect(cleanSubject("Fix: Capital type")).toEqual({ type: "fix", text: "Capital type" });
  });

  test("strips trailing PR references", () => {
    expect(cleanSubject("Add sharing (#123)")).toEqual({ text: "Add sharing" });
    expect(cleanSubject("Add sharing (#12) (#13)")).toEqual({ text: "Add sharing" });
    expect(cleanSubject("Add sharing (org/repo#7)")).toEqual({ text: "Add sharing" });
    expect(cleanSubject("Support #hashtags in notes")).toEqual({ text: "Support #hashtags in notes" });
  });

  test("leaves plain subjects alone, apart from the first letter", () => {
    expect(cleanSubject("Plain subject")).toEqual({ text: "Plain subject" });
    expect(cleanSubject("lowercase start")).toEqual({ text: "Lowercase start" });
    expect(cleanSubject("  padded  ")).toEqual({ text: "Padded" });
    // A word that already has capitals keeps them, and "Word:" isn't a type.
    expect(cleanSubject("iOS 18 widgets")).toEqual({ text: "iOS 18 widgets" });
    expect(cleanSubject("README: install steps")).toEqual({ text: "README: install steps" });
    expect(cleanSubject("Note: this is a sentence")).toEqual({ text: "Note: this is a sentence" });
    expect(cleanSubject("🚀")).toEqual({ text: "" });
  });
});

// MARK: Notes from commits

describe("notesFromCommits", () => {
  test("one line per change, newest first, without chores", () => {
    const subjects = ["🧹 chore: bump deps", "🚀 feat: widgets (#4)", "🧪 test: more", "Merge branch 'x'", "🐛 fix: crash", "📚 docs: readme", "ci: cache"];
    expect(notesFromCommits(subjects)).toBe("• Widgets\n• Crash");
  });

  test("drops refactor, style, build, and fixups too", () => {
    expect(notesFromCommits(["refactor: a", "style: b", "build: c", "fixup! feat: d", "feat: e"])).toBe("• E");
  });

  test("keeps everything when everything would be dropped", () => {
    expect(notesFromCommits(["chore: bump deps", "docs: readme"])).toBe("• Bump deps\n• Readme");
  });

  test("drops repeats, ignoring case", () => {
    expect(notesFromCommits(["feat: Add login", "fix: add login", "feat: other"])).toBe("• Add login\n• Other");
  });

  test("is empty with no commits", () => {
    expect(notesFromCommits([])).toBe("");
    expect(notesFromCommits(["🚀"])).toBe("");
  });

  test("cuts on a line to fit, saying how many more", () => {
    const subjects = Array.from({ length: 10 }, (_, i) => `feat: change number ${i}`);
    const text = notesFromCommits(subjects, 60);
    expect(text).toBe("• Change number 0\n• Change number 1\n…and 8 more");
    expect([...text].length).toBeLessThanOrEqual(60);
  });

  test("fits exactly at the limit, counting code points", () => {
    // 20 code points each (38 UTF-16 units).
    const lines = ["a", "b", "c"].map((letter) => `• ${letter}${"😀".repeat(17)}`);
    const text = lines.join("\n");
    expect([...text].length).toBe(62);
    expect(fitLines(lines, 62)).toBe(text);
    expect(fitLines(lines, 61)).toBe(`${lines[0]}\n${lines[1]}\n…and 1 more`);
    expect([...fitLines(lines, 53)].length).toBe(53);
    expect(fitLines(lines, 52)).toBe(`${lines[0]}\n…and 2 more`);
  });

  test("never goes over the limit, even with one long line", () => {
    const long = `feat: ${"x".repeat(5000)}`;
    const text = notesFromCommits([long, "feat: short"], 4000);
    expect([...text].length).toBeLessThanOrEqual(4000);
    expect(text.endsWith("…\n…and 1 more")).toBe(true);
    expect(fitLines(["• abc", "• def"], 3).length).toBeLessThanOrEqual(3);
    expect(fitLines(["• abc"], 0)).toBe("");
  });
});

test("compareBuildNumbers compares numerically, part by part", () => {
  expect(["10", "9", "1.2.10", "1.2.9", "100"].sort(compareBuildNumbers)).toEqual(["1.2.9", "1.2.10", "9", "10", "100"]);
  expect(compareBuildNumbers("3", "3.0")).toBe(0);
});

// MARK: Git

async function commit(cwd: string, subject: string, file = subject.replace(/\W+/g, "-")) {
  writeFileSync(join(cwd, `${file}.txt`), subject);
  await git(cwd, "add", ".");
  await git(cwd, "commit", "--quiet", "-m", subject);
  return git(cwd, "rev-parse", "HEAD");
}

async function repo() {
  const dir = temp();
  await git(dir, "init", "--quiet");
  return dir;
}

describe("previousBuild and commitSubjects", () => {
  test("pick the highest tagged build in HEAD's history, not HEAD itself", async () => {
    const dir = await repo();
    const a = await commit(dir, "feat: a");
    const b = await commit(dir, "feat: b");
    await git(dir, "tag", "testflight/9", a);
    await git(dir, "tag", "testflight/10", b);
    const c = await commit(dir, "🚀 feat: c (#3)");
    const d = await commit(dir, "fix: d");
    // A build from a branch HEAD doesn't contain.
    await git(dir, "switch", "--quiet", "-c", "side", a);
    const side = await commit(dir, "feat: side");
    await git(dir, "tag", "testflight/11", side);
    await git(dir, "switch", "--quiet", "-");

    expect(await previousBuild(dir, d)).toEqual({ build: "10", commit: b });
    // HEAD itself is tagged: the build before it.
    await git(dir, "tag", "testflight/12", d);
    expect(await previousBuild(dir, d)).toEqual({ build: "10", commit: b });
    expect(await previousBuild(dir, d, { below: "10" })).toEqual({ build: "9", commit: a });
    expect(await previousBuild(dir, a)).toBeUndefined();

    expect(await commitSubjects(dir, b, d)).toEqual(["fix: d", "🚀 feat: c (#3)"]);
    expect(await commitSubjects(dir, undefined, c)).toEqual(["🚀 feat: c (#3)", "feat: b", "feat: a"]);
    expect(await commitSubjects(dir, "nope", d)).toEqual([]);
  });

  test("leave out merges", async () => {
    const dir = await repo();
    const base = await commit(dir, "feat: base");
    await git(dir, "tag", "testflight/1", base);
    await git(dir, "switch", "--quiet", "-c", "feature");
    await commit(dir, "feat: on a branch");
    await git(dir, "switch", "--quiet", "-");
    await commit(dir, "fix: on main");
    await git(dir, "-c", "user.name=Ship", "merge", "--quiet", "--no-ff", "-m", "Merge branch 'feature'", "feature");
    const head = await git(dir, "rev-parse", "HEAD");
    expect((await commitSubjects(dir, base, head)).sort()).toEqual(["feat: on a branch", "fix: on main"]);
  });

  test("gitNotes combines them", async () => {
    const dir = await repo();
    writeFileSync(join(dir, "ship.json"), JSON.stringify(shipJson));
    const first = await commit(dir, "feat: first");
    await git(dir, "tag", "testflight/41", first);
    await commit(dir, "🧹 chore: bump");
    const head = await commit(dir, "🚀 feat: dark mode (#9)");
    const project = await loadProject({ cwd: dir });
    expect(await gitNotes(project, head)).toEqual({ text: "• Dark mode", from: "41", count: 2 });
  });
});

// MARK: Notes for ship beta

describe("resolveNotes", () => {
  test("--notes, then the file, then git, with blank lines between", () => {
    expect(resolveNotes({ notes: "Try login", file: "From a file", fromGit: true, git: "• A" })).toEqual({
      text: "Try login\n\nFrom a file\n\n• A",
      source: "flag+file+git",
    });
    expect(resolveNotes({ notes: "Try login" })).toEqual({ text: "Try login", source: "flag" });
    expect(resolveNotes({ file: "From a file\n" })).toEqual({ text: "From a file", source: "file" });
  });

  test("ship.json's notesFromGit applies only without --notes or --notes-file", () => {
    expect(wantsGitNotes({ configDefault: true })).toBe(true);
    expect(wantsGitNotes({ configDefault: true, notes: "x" })).toBe(false);
    expect(wantsGitNotes({ configDefault: true, file: "x" })).toBe(false);
    expect(wantsGitNotes({ notes: "x", fromGit: true })).toBe(true);
    expect(wantsGitNotes({})).toBe(false);
    expect(resolveNotes({ configDefault: true, git: "• A" })).toEqual({ text: "• A", source: "git" });
    expect(resolveNotes({ configDefault: true, notes: "x", git: "• A" })).toEqual({ text: "x", source: "flag" });
    expect(resolveNotes({ notes: "x", fromGit: true, git: "• A" })).toEqual({ text: "x\n\n• A", source: "flag+git" });
  });

  test("nothing is null; empty --notes is empty and turns the default off", () => {
    expect(resolveNotes({})).toEqual({ text: null, source: null });
    expect(resolveNotes({ fromGit: true })).toEqual({ text: null, source: null });
    expect(resolveNotes({ notes: "", configDefault: true, git: "• A" })).toEqual({ text: "", source: null });
    expect(resolveNotes({ notes: "", fromGit: true, git: "• A" })).toEqual({ text: "• A", source: "git" });
  });
});

const shipJson = { name: "App", kind: "xcodeproj", path: "App.xcodeproj", scheme: "App", bundleId: "com.example.app", ascAppId: "123" };

describe("whatToTest", () => {
  afterEach(() => {
    ui.quiet = false;
  });

  test("reads git notes by default when ship.json asks, up to HEAD or the build's tag", async () => {
    ui.quiet = true;
    const dir = await repo();
    writeFileSync(join(dir, "ship.json"), JSON.stringify({ ...shipJson, beta: { notesFromGit: true } }));
    const first = await commit(dir, "feat: first");
    await git(dir, "tag", "testflight/1", first);
    const second = await commit(dir, "feat: second");
    await git(dir, "tag", "testflight/2", second);
    await commit(dir, "feat: third");
    const project = await loadProject({ cwd: dir });

    expect(await whatToTest(project, { build: "3", at: "head" })).toEqual({ text: "• Third", source: "git", from: "2" });
    // Redistributing build 2 lists what changed since build 1, not since HEAD.
    expect(await whatToTest(project, { build: "2", at: "tag" })).toEqual({ text: "• Second", source: "git", from: "1" });
    // --notes turns the default off; --notes-from-git adds git's after it.
    expect(await whatToTest(project, { notes: "Hi", build: "3", at: "head" })).toEqual({ text: "Hi", source: "flag", from: null });
    expect(await whatToTest(project, { notes: "Hi", notesFromGit: true, build: "3", at: "head" })).toEqual({ text: "Hi\n\n• Third", source: "flag+git", from: "2" });
  });

  test("an empty range sets no notes", async () => {
    ui.quiet = true;
    const dir = await repo();
    writeFileSync(join(dir, "ship.json"), JSON.stringify(shipJson));
    await commit(dir, "feat: base");
    await git(dir, "switch", "--quiet", "-c", "feature");
    const branch = await commit(dir, "feat: on the branch");
    await git(dir, "switch", "--quiet", "-");
    await git(dir, "merge", "--quiet", "--no-ff", "-m", "Merge branch 'feature'", "feature");
    const merge = await git(dir, "rev-parse", "HEAD");
    await commit(dir, "feat: later");
    await git(dir, "tag", "testflight/5", merge);
    const project = await loadProject({ cwd: dir });
    // With no earlier build tagged, the last commits up to build 5's tag (not HEAD).
    expect(await whatToTest(project, { notesFromGit: true, build: "5", at: "tag" })).toEqual({
      text: "• On the branch\n• Base",
      source: "git",
      from: null,
    });
    // Build 4 came from the branch, so build 5 only adds the merge.
    await git(dir, "tag", "testflight/4", branch);
    expect(await whatToTest(project, { notesFromGit: true, build: "5", at: "tag" })).toEqual({ text: null, source: null, from: "4" });
  });

  test("reads --notes-file, and a missing one is an error with a hint", async () => {
    const dir = temp();
    writeFileSync(join(dir, "ship.json"), JSON.stringify(shipJson));
    writeFileSync(join(dir, "notes.txt"), "Line one\r\nLine two\n\n");
    const project = await loadProject({ cwd: dir });
    expect(await readNotesFile(join(dir, "notes.txt"))).toBe("Line one\nLine two");
    expect(await whatToTest(project, { notesFile: join(dir, "notes.txt"), build: "1", at: "head" })).toEqual({
      text: "Line one\nLine two",
      source: "file",
      from: null,
    });
    const error = await code(() => whatToTest(project, { notesFile: join(dir, "missing.txt"), build: "1", at: "head" }));
    expect(error.code).toBe("notes-file-missing");
    expect(error.hint).toContain("--notes");
    expect((await code(() => readNotesFile(dir))).code).toBe("notes-file-missing");
  });

  test("notes over TestFlight's 4,000 characters are an error", async () => {
    const dir = temp();
    writeFileSync(join(dir, "ship.json"), JSON.stringify(shipJson));
    const project = await loadProject({ cwd: dir });
    const error = await code(() => whatToTest(project, { notes: "x".repeat(4001), build: "1", at: "head" }));
    expect(error.code).toBe("notes-too-long");
  });
});

// MARK: Expiry

describe("daysLeft", () => {
  test("rounds up, is 0 once expired, and null without a date", () => {
    const exp = (days: number) => new Date(NOW + days * DAY_MS).toISOString();
    expect(daysLeft({ expired: false, processingState: "VALID", expirationDate: exp(12) }, NOW)).toBe(12);
    expect(daysLeft({ expired: false, processingState: "VALID", expirationDate: exp(11.2) }, NOW)).toBe(12);
    expect(daysLeft({ expired: false, processingState: "VALID", expirationDate: exp(0.1) }, NOW)).toBe(1);
    expect(daysLeft({ expired: false, processingState: "VALID", expirationDate: exp(-1) }, NOW)).toBe(0);
    expect(daysLeft({ expired: true, processingState: "VALID", expirationDate: exp(5) }, NOW)).toBe(0);
    expect(daysLeft({ expired: false, processingState: "PROCESSING", expirationDate: exp(90) }, NOW)).toBeNull();
    expect(daysLeft({ expired: false, processingState: "VALID" }, NOW)).toBeNull();
    expect(daysLeft({ expired: false, processingState: "VALID", expirationDate: "garbage" }, NOW)).toBeNull();
  });

  test("labels", () => {
    const exp = (days: number) => new Date(NOW + days * DAY_MS).toISOString();
    expect(expiresLabel({ expired: false, processingState: "VALID", expirationDate: exp(12) }, NOW)).toBe("in 12 days");
    expect(expiresLabel({ expired: false, processingState: "VALID", expirationDate: exp(0.5) }, NOW)).toBe("in 1 day");
    expect(expiresLabel({ expired: true, processingState: "VALID" }, NOW)).toBe("expired");
    expect(expiresLabel({ expired: false, processingState: "PROCESSING" }, NOW)).toBe("");
  });

  test("status mentions a newest build that expires within a week", () => {
    const exp = (days: number) => new Date(NOW + days * DAY_MS).toISOString();
    expect(expiringSoon([build("5", { expirationDate: exp(3) }), build("4")], NOW)).toBe("Build 5 expires in 3 days. Upload a new one with `ship beta`.");
    expect(expiringSoon([build("5", { expirationDate: exp(30) })], NOW)).toBeUndefined();
    expect(expiringSoon([build("5", { processingState: "PROCESSING" })], NOW)).toBeUndefined();
    expect(expiringSoon([build("5", { expired: true })], NOW)).toBeUndefined();
    expect(expiringSoon([], NOW)).toBeUndefined();
  });
});

test("parseAge reads hours, days, and weeks", async () => {
  expect(parseAge("12h")).toBe(12 * 60 * 60 * 1000);
  expect(parseAge("30d")).toBe(30 * DAY_MS);
  expect(parseAge("2W")).toBe(14 * DAY_MS);
  for (const bad of ["30", "d", "0d", "-3d", "1.5d", "3m", "thirty days"]) {
    const error = await code(() => parseAge(bad));
    expect(error.code).toBe("usage");
    expect(error.exitCode).toBe(2);
    expect(error.hint).toContain("30d");
  }
});

describe("pickBuildsToExpire", () => {
  const inReview = { id: "v1", versionString: "1.0", state: "WAITING_FOR_REVIEW" };
  const editing = { id: "v2", versionString: "1.1", state: "PREPARE_FOR_SUBMISSION" };

  test("needs numbers or --older-than, not both, and --keep only with --older-than", async () => {
    expect((await code(() => pickBuildsToExpire([], {}))).code).toBe("usage");
    expect((await code(() => pickBuildsToExpire([], { numbers: ["1"], olderThan: DAY_MS }))).message).toContain("not both");
    expect((await code(() => pickBuildsToExpire([], { numbers: ["1"], keep: 2 }))).message).toContain("--keep");
  });

  test("by number: skips expired and processing builds", () => {
    const builds = [build("1"), build("2", { expired: true }), build("3", { processingState: "PROCESSING" }), build("4", { appStoreVersion: editing })];
    const pick = pickBuildsToExpire(builds, { numbers: ["1", "2", "3", "4", "1"] });
    expect(pick.expire.map((b) => b.number)).toEqual(["1", "4"]);
    expect(pick.skipped).toEqual([
      { number: "2", reason: "already expired" },
      { number: "3", reason: "still processing" },
    ]);
  });

  test("by number: an unknown build, a build number in two versions, and a build in review are errors", async () => {
    expect((await code(() => pickBuildsToExpire([build("1")], { numbers: ["9"] }))).code).toBe("no-build");
    const twice = await code(() => pickBuildsToExpire([build("1"), build("1", { id: "other", version: "2.0" })], { numbers: ["1"] }));
    expect(twice.code).toBe("usage");
    expect(twice.details).toEqual({ choices: ["1.0", "2.0"] });
    const used = await code(() => pickBuildsToExpire([build("1", { appStoreVersion: inReview })], { numbers: ["1"] }));
    expect(used.code).toBe("build-in-use");
    expect(used.details).toEqual({ number: "1", version: "1.0", state: "WAITING_FOR_REVIEW" });
  });

  /** Build `number`, uploaded `days` ago. */
  const aged = (number: string, days: number, extra: Partial<Build> = {}) => build(number, { uploadedDate: ago(days), ...extra });

  test("by age: keeps the newest valid builds and builds in use", () => {
    const builds = [
      aged("46", 40),
      aged("47", 34, { appStoreVersion: { ...inReview, state: "READY_FOR_DISTRIBUTION" } }),
      aged("49", 32, { processingState: "PROCESSING" }),
      aged("50", 31),
      aged("48", 33, { processingState: "FAILED" }),
      aged("45", 50, { appStoreVersion: editing }),
    ];
    const pick = pickBuildsToExpire(builds, { olderThan: 30 * DAY_MS, keep: 1, now: NOW });
    // Newest first. A version being prepared doesn't protect its build.
    expect(pick.expire.map((b) => b.number)).toEqual(["48", "46", "45"]);
    expect(pick.skipped).toEqual([
      { number: "50", reason: "one of the newest valid build (--keep)" },
      { number: "49", reason: "still processing" },
      { number: "47", reason: "in App Store version 1.0 (ready for distribution)" },
    ]);
    // A newer build (younger than the cutoff) is the one kept, so 50 goes too.
    const newer = pickBuildsToExpire([...builds, aged("51", 2)], { olderThan: 30 * DAY_MS, now: NOW });
    expect(newer.expire.map((b) => b.number)).toEqual(["50", "48", "46", "45"]);
  });

  test("by age: keep counts only valid builds, and defaults to 1", () => {
    const builds = [aged("4", 10, { processingState: "FAILED" }), aged("3", 20), aged("2", 30), aged("1", 40)];
    const expired = (keep?: number) => pickBuildsToExpire(builds, { olderThan: DAY_MS, keep, now: NOW }).expire.map((b) => b.number);
    expect(expired()).toEqual(["4", "2", "1"]);
    expect(expired(2)).toEqual(["4", "1"]);
    expect(expired(0)).toEqual(["4", "3", "2", "1"]);
    expect(pickBuildsToExpire(builds, { olderThan: 100 * DAY_MS, now: NOW })).toEqual({ expire: [], skipped: [] });
  });
});

// MARK: App Store Connect

describe("with App Store Connect", () => {
  let mock: ReturnType<typeof mockAsc> | undefined;
  let delays: ReturnType<typeof noRetryDelay>;
  const cwd = process.cwd();

  beforeEach(async () => {
    await testCredentials();
    delays = noRetryDelay();
  });

  afterEach(() => {
    mock?.restore();
    mock = undefined;
    delays.restore();
    process.chdir(cwd);
    ui.json = false;
    ui.quiet = false;
  });

  const buildResource = (number: string, attributes: Record<string, unknown> = {}, relationships: Record<string, unknown> = {}) =>
    resource(
      "builds",
      `b${number}`,
      { version: number, uploadedDate: ago(Number(number)), processingState: "VALID", expired: false, expirationDate: new Date(NOW + 30 * DAY_MS).toISOString(), ...attributes },
      { preReleaseVersion: { data: { type: "preReleaseVersions", id: "pre1" } }, ...relationships } as never,
    );
  const preRelease = resource("preReleaseVersions", "pre1", { version: "1.0", platform: "IOS" });

  test("the list's flags become the builds query", () => {
    const query = (flags: Context["flags"]) => Object.fromEntries(new URL(`https://x${buildsPath("123", listFilter(ctx(flags), "IOS"))}`).searchParams);
    const base = { "filter[app]": "123", "filter[preReleaseVersion.platform]": "IOS", sort: "-uploadedDate", limit: "20" };
    const plain = query({});
    expect(plain).toMatchObject({ ...base, "filter[expired]": "false" });
    expect(plain["filter[processingState]"]).toBeUndefined();
    expect(query({ version: "1.2", limit: "5" })).toMatchObject({ ...base, "filter[preReleaseVersion.version]": "1.2", limit: "5", "filter[expired]": "false" });
    expect(query({ processing: true })["filter[processingState]"]).toBe("PROCESSING");
    expect(query({ failed: true })["filter[processingState]"]).toBe("FAILED,INVALID");
    expect(query({ processing: true, failed: true })["filter[processingState]"]).toBe("PROCESSING,FAILED,INVALID");
    expect(query({ expired: true })["filter[expired]"]).toBe("true");
    expect(query({ all: true })["filter[expired]"]).toBeUndefined();
    expect(query({ all: true, expired: true })["filter[expired]"]).toBeUndefined();
  });

  test("ship builds lists builds with their days left as JSON", async () => {
    const dir = temp();
    writeFileSync(join(dir, "ship.json"), JSON.stringify(shipJson));
    process.chdir(dir);
    mock = mockAsc((call) => {
      if (call.path === "/v1/builds") return { json: jsonApi([buildResource("7")], { included: [preRelease] }) };
    });
    ui.json = true;
    const out = await captureLog(() => commands[0]!.run(ctx({ version: "1.0" })));
    const result = JSON.parse(out);
    expect(result.builds).toHaveLength(1);
    expect(result.builds[0]).toMatchObject({ number: "7", version: "1.0", platform: "IOS", commit: null });
    expect(typeof result.builds[0].daysLeft).toBe("number");
    expect(mock.calls[0]!.query["filter[preReleaseVersion.version]"]).toBe("1.0");
  });

  test("a misplaced flag or unknown action is a usage error", async () => {
    const run = commands[0]!.run;
    expect((await code(() => run(ctx({ "older-than": "3d" })))).message).toContain("ship builds expire");
    expect((await code(() => run(ctx({ limit: "3" }, ["expire", "1"])))).code).toBe("usage");
    const unknown = await code(() => run(ctx({}, ["42"])));
    expect(unknown.details).toEqual({ choices: ["list", "show", "expire"] });
    expect(unknown.hint).toBe("To see build 42: ship builds show 42");
    expect((await code(() => run(ctx({}, ["show"])))).hint).toContain("ship builds");
  });

  test("show reads groups, What to Test, Beta App Review, and the App Store version", async () => {
    mock = mockAsc((call) => {
      if (call.path !== "/v1/builds") return undefined;
      return {
        json: jsonApi(
          [
            buildResource("7", { minOsVersion: "17.0" }, {
              betaGroups: { data: [{ type: "betaGroups", id: "g1" }, { type: "betaGroups", id: "g2" }] },
              betaBuildLocalizations: { data: [{ type: "betaBuildLocalizations", id: "l1" }] },
              betaAppReviewSubmission: { data: { type: "betaAppReviewSubmissions", id: "r1" } },
              appStoreVersion: { data: { type: "appStoreVersions", id: "v1" } },
            }),
          ],
          {
            included: [
              preRelease,
              resource("betaGroups", "g1", { name: "Friends", isInternalGroup: false }),
              resource("betaGroups", "g2", { name: "Team", isInternalGroup: true }),
              resource("betaBuildLocalizations", "l1", { locale: "en-US", whatsNew: "• Dark mode" }),
              resource("betaAppReviewSubmissions", "r1", { betaReviewState: "APPROVED" }),
              resource("appStoreVersions", "v1", { versionString: "1.0", appStoreState: "READY_FOR_SALE" }),
            ],
          },
        ),
      };
    });
    const [detail] = await buildDetails("123", "7", { platform: "IOS" });
    expect(detail).toMatchObject({
      number: "7",
      version: "1.0",
      minOsVersion: "17.0",
      groups: ["Friends", "Team"],
      whatToTest: { "en-US": "• Dark mode" },
      betaReview: "APPROVED",
      appStoreVersion: { id: "v1", versionString: "1.0", state: "READY_FOR_DISTRIBUTION" },
    });
    const query = mock.calls[0]!.query;
    expect(query["filter[version]"]).toBe("7");
    expect(query.include).toBe("preReleaseVersion,buildBetaDetail,betaAppReviewSubmission,appStoreVersion,betaGroups,betaBuildLocalizations");
    expect(query["fields[betaBuildLocalizations]"]).toBe("locale,whatsNew");
    expect(query["limit[betaGroups]"]).toBe("50");
  });

  test("show and expire print for people", async () => {
    const dir = temp();
    writeFileSync(join(dir, "ship.json"), JSON.stringify(shipJson));
    process.chdir(dir);
    mock = mockAsc((call) => {
      if (call.method === "PATCH") return { json: jsonApi(resource("builds", "b40")) };
      return { json: jsonApi([buildResource("40", {}, { appStoreVersion: { data: null } })], { included: [preRelease] }) };
    });
    ui.quiet = true;
    const shown = await captureLog(() => commands[0]!.run(ctx({}, ["show", "40"])));
    expect(shown).toContain("Build 40 (1.0) · IOS");
    expect(shown).toContain("Commit       not tagged");
    expect(shown).toContain("App Store    not in a version");
    expect(shown).toContain("No What to Test yet.");
    const listed = await captureLog(() => commands[0]!.run(ctx({})));
    expect(listed.split("\n")[0]).toEndWith("EXPIRES");
    // Relative to today, so only its shape is fixed.
    expect(listed.split("\n")[1]).toMatch(/(in \d+ days?|expired)$/);
    expect(await captureLog(() => commands[0]!.run(ctx({ "dry-run": true }, ["expire", "40"])))).toStartWith("Would expire 1 build:");
    expect(mock.calls.some((call) => call.method === "PATCH")).toBe(false);
    expect(await captureLog(() => commands[0]!.run(ctx({}, ["expire", "40"])))).toBe("Expired 1 build: 40.");
    expect(mock.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  });

  test("show for an unknown build says how to list them", async () => {
    const dir = temp();
    writeFileSync(join(dir, "ship.json"), JSON.stringify(shipJson));
    process.chdir(dir);
    mock = mockAsc((call) => (call.path === "/v1/builds" ? { json: jsonApi([]) } : undefined));
    const error = await code(() => commands[0]!.run(ctx({}, ["show", "99"])));
    expect(error.code).toBe("no-build");
    expect(error.hint).toContain("ship builds");
  });

  test("builds read for expiring say which App Store version they're in", async () => {
    mock = mockAsc(() => ({
      json: jsonApi(
        [buildResource("1", {}, { appStoreVersion: { data: { type: "appStoreVersions", id: "v1" } } }), buildResource("2", {}, { appStoreVersion: { data: null } })],
        { included: [preRelease, resource("appStoreVersions", "v1", { versionString: "1.0", appVersionState: "IN_REVIEW" })] },
      ),
    }));
    const builds = await listBuilds("123", { number: ["1", "2"] }, BUILD_USE_QUERY);
    expect(builds.map((b) => b.appStoreVersion)).toEqual([{ id: "v1", versionString: "1.0", state: "IN_REVIEW" }, null]);
    expect(mock.calls[0]!.query["filter[version]"]).toBe("1,2");
    expect(mock.calls[0]!.query.include).toBe("preReleaseVersion,buildBetaDetail,appStoreVersion");
    // Without the include, builds don't have the field at all (status and beta JSON stay the same).
    mock.restore();
    mock = mockAsc(() => ({ json: jsonApi([buildResource("1")], { included: [preRelease] }) }));
    expect("appStoreVersion" in (await listBuilds("123"))[0]!).toBe(false);
  });

  test("expire PATCHes each build in turn", async () => {
    mock = mockAsc((call) => (call.method === "PATCH" ? { json: jsonApi(resource("builds", call.path.split("/").pop()!, { expired: true })) } : undefined));
    ui.quiet = true;
    const done = await expireAll([build("1"), build("2")]);
    expect(done).toEqual([
      { number: "1", id: "id-1", version: "1.0", uploadedDate: ago(1) },
      { number: "2", id: "id-2", version: "1.0", uploadedDate: ago(2) },
    ]);
    expect(mock.calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["PATCH", "/v1/builds/id-1", { data: { type: "builds", id: "id-1", attributes: { expired: true } } }],
      ["PATCH", "/v1/builds/id-2", { data: { type: "builds", id: "id-2", attributes: { expired: true } } }],
    ]);
  });

  test("a failed expire says what was expired before it", async () => {
    mock = mockAsc((call) =>
      call.path.endsWith("id-2") ? { status: 409, json: { errors: [{ status: "409", title: "Conflict", detail: "Nope" }] } } : { json: jsonApi(resource("builds", "x")) },
    );
    ui.quiet = true;
    const error = await code(() => expireAll([build("1"), build("2"), build("3")]));
    expect(error.code).toBe("api-409");
    expect(error.message).toContain("build 2");
    expect(error.hint).toStartWith("Already expired: 1.");
    expect(error.details).toMatchObject({ failed: "2", expired: [{ number: "1" }] });
    expect(mock.calls).toHaveLength(2);
  });

  test("ship builds expire --older-than --dry-run changes nothing", async () => {
    const dir = temp();
    writeFileSync(join(dir, "ship.json"), JSON.stringify(shipJson));
    process.chdir(dir);
    mock = mockAsc((call) => {
      if (call.method === "GET" && call.path === "/v1/builds") {
        return { json: jsonApi([buildResource("1"), buildResource("40"), buildResource("50")], { included: [preRelease] }) };
      }
    });
    ui.json = true;
    ui.quiet = true;
    const out = await captureLog(() => commands[0]!.run(ctx({ "older-than": "30d", "dry-run": true }, ["expire"])));
    const result = JSON.parse(out);
    expect(result.dryRun).toBe(true);
    // Build 1 is the newest valid build, so it's kept whatever today's date is; 40 and 50 are over 30 days old.
    expect(result.expired.map((b: { number: string }) => b.number)).toEqual(["40", "50"]);
    expect(result.expired[0]).toEqual({ number: "40", id: "b40", version: "1.0", uploadedDate: ago(40) });
    expect(mock.calls.every((call) => call.method === "GET")).toBe(true);
    expect(mock.calls[0]!.query["filter[expired]"]).toBe("false");
  });
});
