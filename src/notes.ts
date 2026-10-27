// "What to Test" for a TestFlight build: from --notes, a file, and the commit
// subjects since the previous build.
//
// The previous build is the testflight/<build> tag (see git.ts) closest
// behind the commit being shipped, so the notes list what's new since testers
// last got a build. Subjects are cleaned of emoji, conventional-commit
// prefixes, and PR numbers, and chores are left out.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { compareBuildOrder } from "./buildnumber";
import type { Project } from "./config";
import { buildCommits, git, headCommit, tagFor } from "./git";
import { chars } from "./store/check";
import { ShipError, ui } from "./ui";

/** BetaBuildLocalization.whatsNew's limit, in characters. */
export const WHATS_NEW_LIMIT = 4000;

// MARK: Commits since the previous build

/**
 * The newest build already in TestFlight that `headSha` builds on: the
 * tagged build whose commit is closest to `headSha` among its ancestors
 * (`headSha` itself left out). Builds on the same commit go by build order,
 * so a counter comes after a timestamp-style number. `below` leaves out that
 * build and later ones (for redistributing an older build).
 */
export async function previousBuild(root: string, headSha: string, options: { below?: string } = {}): Promise<{ build: string; commit: string } | undefined> {
  const builds = await buildCommits(root);
  const merged = await git(root, ["for-each-ref", "--merged", headSha, "--format=%(refname:strip=3)", "refs/tags/testflight/"]);
  if (merged.code !== 0) return undefined;
  const ancestors = new Set(merged.stdout.split("\n").filter(Boolean));
  const candidates = [...builds].filter(
    ([build, commit]) => ancestors.has(build) && commit !== headSha && (options.below === undefined || compareBuildOrder(build, options.below) < 0),
  );
  let best: { build: string; commit: string; distance: number } | undefined;
  const distances = new Map<string, number>();
  for (const [build, commit] of candidates) {
    if (!distances.has(commit)) {
      const count = await git(root, ["rev-list", "--count", `${commit}..${headSha}`]);
      distances.set(commit, count.code === 0 ? Number(count.stdout.trim()) : Number.POSITIVE_INFINITY);
    }
    const distance = distances.get(commit)!;
    if (!best || distance < best.distance || (distance === best.distance && compareBuildOrder(build, best.build) > 0)) best = { build, commit, distance };
  }
  return best && { build: best.build, commit: best.commit };
}

/** How many commits to look at when there's no previous build. */
export const NO_BASE_COMMITS = 30;

/** Commit subjects in `from..to`, newest first, without merges. With no `from`, the last 30 commits. */
export async function commitSubjects(root: string, from: string | undefined, to: string): Promise<string[]> {
  const range = from ? [`${from}..${to}`] : [`--max-count=${NO_BASE_COMMITS}`, to];
  // --topo-order: a commit always comes before its parents, even when they share a timestamp.
  const result = await git(root, ["log", "--no-merges", "--topo-order", "--format=%s%x00", ...range, "--"]);
  if (result.code !== 0) return [];
  return result.stdout
    .split("\0")
    .map((subject) => subject.trim())
    .filter(Boolean);
}

// MARK: Cleaning subjects

/** Types that say nothing to testers. */
export const QUIET_TYPES = ["chore", "ci", "test", "tests", "docs", "doc", "style", "build", "refactor"];

/** Conventional commit types recognized without a scope (with a scope or !, any word is a type). */
const KNOWN_TYPES = [...QUIET_TYPES, "feat", "feature", "fix", "bugfix", "hotfix", "perf", "revert", "deps", "security", "release", "wip"];

/** Emoji, with the variation selectors, joiners, skin tones, and keycaps that make up one, and gitmoji :codes:. */
const LEADING_EMOJI = /^(?:[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]+|:[a-z0-9_+-]+:|\s+)+/u;
const PREFIX = /^([a-z][\w-]*)(\([^)]*\))?(!)?:\s+/i;
/** " (#123)", or several, at the end (squash merges on GitHub add these). */
const PR_REFS = /(?:\s*\((?:[\w.-]+\/[\w.-]+)?#\d+\))+\s*$/;

/**
 * A commit subject as a line for testers: emoji, gitmoji codes, the
 * conventional prefix ("fix(search)!: "), and trailing PR numbers removed, and
 * the first letter capitalized (unless the first word already has capitals,
 * like "iOS"). `type` is the conventional type, lowercased.
 */
export function cleanSubject(subject: string): { type?: string; text: string } {
  let text = subject.trim().replace(LEADING_EMOJI, "");
  let type: string | undefined;
  const prefix = text.match(PREFIX);
  if (prefix && (prefix[2] || prefix[3] || KNOWN_TYPES.includes(prefix[1]!.toLowerCase()))) {
    type = prefix[1]!.toLowerCase();
    text = text.slice(prefix[0].length).replace(LEADING_EMOJI, "");
  }
  text = text.replace(PR_REFS, "").trim();
  const firstWord = text.split(/\s/, 1)[0] ?? "";
  if (firstWord === firstWord.toLowerCase()) text = text.charAt(0).toUpperCase() + text.slice(1);
  return type ? { type, text } : { text };
}

/** Subjects that say nothing to testers on their own: merges, and fixups waiting to be squashed. */
const NOISE = /^(?:Merge |(?:fixup|squash|amend)! )/;

/**
 * "What to Test" from commit subjects (newest first): one "• text" line each,
 * leaving out chores (chore, ci, test, docs, style, build, refactor) and
 * merges unless that would leave nothing, and repeats (ignoring case). Cut
 * on a line to fit `limit` characters, ending with "…and N more".
 */
export function notesFromCommits(subjects: string[], limit = WHATS_NEW_LIMIT): string {
  const all = subjects
    .map((subject) => ({ subject, ...cleanSubject(subject) }))
    .filter((entry) => entry.text);
  const wanted = all.filter((entry) => !NOISE.test(entry.subject) && !QUIET_TYPES.includes(entry.type ?? ""));
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of wanted.length ? wanted : all) {
    const key = entry.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`• ${entry.text}`);
  }
  return fitLines(lines, limit);
}

/** Joins lines, dropping whole lines from the end (and saying how many) until the text fits. */
export function fitLines(lines: string[], limit: number): string {
  const text = lines.join("\n");
  if (chars(text) <= limit) return text;
  for (let kept = lines.length - 1; kept > 0; kept--) {
    const cut = `${lines.slice(0, kept).join("\n")}\n…and ${lines.length - kept} more`;
    if (chars(cut) <= limit) return cut;
  }
  // Not even one line fits: cut the first one short.
  const more = lines.length > 1 ? `\n…and ${lines.length - 1} more` : "";
  const room = limit - chars(more) - 1;
  if (room < 3) return [...`…and ${lines.length} more`].slice(0, Math.max(0, limit)).join("");
  return `${[...lines[0]!].slice(0, room).join("")}…${more}`;
}

// MARK: Notes for a build

export interface GitNotes {
  text: string;
  /** The previous build the notes start after, or null when none is tagged (then the last 30 commits). */
  from: string | null;
  /** Commits in the range, before chores and repeats were left out. */
  count: number;
}

/** What to Test from the commits since the previous build, up to `upToSha`. */
export async function gitNotes(project: Project, upToSha: string, options: { below?: string; limit?: number } = {}): Promise<GitNotes> {
  const previous = await previousBuild(project.root, upToSha, { below: options.below });
  const subjects = await commitSubjects(project.root, previous?.commit, upToSha);
  return { text: notesFromCommits(subjects, options.limit), from: previous?.build ?? null, count: subjects.length };
}

/** Where What to Test came from: "flag", "file", "git", or a mix like "flag+git". */
export type NotesSource = string;

/** Whether to add notes from git: --notes-from-git, or ship.json's beta.notesFromGit when neither --notes nor --notes-file was given. */
export function wantsGitNotes(options: { notes?: string; file?: string; fromGit?: boolean; configDefault?: boolean }): boolean {
  if (options.fromGit) return true;
  return Boolean(options.configDefault) && options.notes === undefined && options.file === undefined;
}

/**
 * The final What to Test: --notes, then the file, then (when wanted) git's,
 * separated by blank lines. null when nothing was given; "" when only empty
 * notes were (--notes "" sets none, and turns off the ship.json default).
 */
export function resolveNotes(options: { notes?: string; file?: string; fromGit?: boolean; configDefault?: boolean; git?: string }): {
  text: string | null;
  source: NotesSource | null;
} {
  const parts: [string, string | undefined][] = [
    ["flag", options.notes],
    ["file", options.file],
    ["git", wantsGitNotes(options) ? options.git : undefined],
  ];
  const given = parts.filter(([, text]) => text !== undefined);
  if (!given.length) return { text: null, source: null };
  const filled = given.filter(([, text]) => text!.trim());
  return {
    text: filled.map(([, text]) => text!.trim()).join("\n\n"),
    source: filled.length ? filled.map(([source]) => source).join("+") : null,
  };
}

/**
 * Fails when --notes-file - would read a terminal: waiting for someone to
 * type is a prompt, and ship never prompts. Commands call it before anything
 * else, so the mistake costs no requests.
 */
export function checkNotesStdin(path: string | undefined, isTTY = Boolean(process.stdin.isTTY)): void {
  if (path !== "-" || !isTTY) return;
  throw new ShipError(
    "--notes-file - reads What to Test from a pipe, not the terminal",
    "usage",
    'For example: git log -1 --format=%B | ship beta --notes-file -, or pass --notes "…"',
    undefined,
    2,
  );
}

/** A --notes-file's text ("-" reads stdin). */
export async function readNotesFile(path: string): Promise<string> {
  checkNotesStdin(path);
  if (path === "-") return (await Bun.stdin.text()).replace(/\r\n?/g, "\n").trimEnd();
  const full = resolve(path);
  if (!existsSync(full) || !statSync(full).isFile()) {
    throw new ShipError(
      `No notes file at ${path}`,
      "notes-file-missing",
      `Check the path (it's relative to ${process.cwd()}), or pass the text with --notes "…".`,
      { file: full },
    );
  }
  return (await Bun.file(full).text()).replace(/\r\n?/g, "\n").trimEnd();
}

export interface WhatToTest {
  /** The text to set, or null to leave What to Test alone. */
  text: string | null;
  source: NotesSource | null;
  /** The build git's notes start after, or null. */
  from: string | null;
}

/**
 * Works out What to Test for `ship beta` and `ship distribute`. Git's notes
 * run up to HEAD (`at: "head"`, the commit being built) or to the build's
 * testflight/<build> tag (`at: "tag"`, falling back to HEAD with a warning).
 */
export async function whatToTest(
  project: Project,
  options: { notes?: string; notesFile?: string; notesFromGit?: boolean; build: string; at: "head" | "tag" },
): Promise<WhatToTest> {
  const file = options.notesFile === undefined ? undefined : await readNotesFile(options.notesFile);
  const request = { notes: options.notes, file, fromGit: options.notesFromGit, configDefault: project.config.beta?.notesFromGit };
  let from: string | null = null;
  let git: string | undefined;
  if (wantsGitNotes(request)) {
    const to = await notesTarget(project, options.build, options.at);
    if (!to) {
      ui.warn("Not in a git repo with a commit, so there are no notes from git");
    } else {
      // Leave room for the --notes and file text, and the blank line between.
      const manual = resolveNotes({ notes: options.notes, file }).text ?? "";
      const limit = WHATS_NEW_LIMIT - (manual ? chars(manual) + 2 : 0);
      const notes = await gitNotes(project, to, { below: options.build, limit: Math.max(0, limit) });
      from = notes.from;
      const since = notes.from ? `since build ${notes.from}` : `in the last ${NO_BASE_COMMITS} commits (no earlier build is tagged)`;
      if (!notes.count) ui.note(`No notes from git: no commits ${since}`);
      else if (limit < 20) ui.note("No notes from git: --notes and the file already fill What to Test");
      else {
        git = notes.text;
        ui.ok(`What to Test from ${notes.count} commit${notes.count === 1 ? "" : "s"} ${since}`);
      }
    }
  }
  const resolved = resolveNotes({ ...request, git });
  if (resolved.text && chars(resolved.text) > WHATS_NEW_LIMIT) {
    throw new ShipError(
      `What to Test is ${chars(resolved.text)} characters; TestFlight allows ${WHATS_NEW_LIMIT}`,
      "notes-too-long",
      "Shorten --notes or the --notes-file.",
      { length: chars(resolved.text), limit: WHATS_NEW_LIMIT },
    );
  }
  return { ...resolved, from };
}

/** The commit git notes run up to. */
async function notesTarget(project: Project, build: string, at: "head" | "tag"): Promise<string | undefined> {
  if (at === "tag") {
    const tagged = (await buildCommits(project.root)).get(build);
    if (tagged) return tagged;
  }
  const head = await headCommit(project.root);
  if (at === "tag" && head) ui.warn(`No ${tagFor(build)} tag, so notes from git run up to HEAD (${head.short})`);
  return head?.sha;
}
