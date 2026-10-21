// What git knows about the commit a build comes from.
//
// `ship beta` tags the commit of every upload `testflight/<build>` and pushes
// the tag, so the repo itself records what's in TestFlight: `ship status`
// reads the tags, and `git log testflight/<build>..origin/main` lists what
// isn't shipped yet.

import { run } from "./exec";

export interface Commit {
  sha: string;
  short: string;
  /** The checked-out branch; undefined on a detached HEAD. */
  branch?: string;
  /** Uncommitted changes, as `git status --porcelain` lines (untracked files too, ignored ones not). */
  changes: string[];
  /** The remote's default branch, like `origin/main`, when the clone knows it. */
  defaultBranch?: string;
  /** Whether the default branch contains this commit. */
  onDefaultBranch?: boolean;
}

/** Git without a credential prompt: a fetch or push that needs one fails instead of hanging. */
const git = (root: string, args: string[]) => run(["git", ...args], { cwd: root, env: { GIT_TERMINAL_PROMPT: "0" } });

export const tagFor = (build: string) => `testflight/${build}`;

/** HEAD of the repo at `root`, or undefined outside a repo (or before its first commit). */
export async function headCommit(root: string): Promise<Commit | undefined> {
  const head = await git(root, ["rev-parse", "HEAD"]);
  if (head.code !== 0) return undefined;
  const sha = head.stdout.trim();
  const [branch, status, defaultBranch] = await Promise.all([
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(root, ["status", "--porcelain", "-z"]),
    remoteDefaultBranch(root),
  ]);
  return {
    sha,
    short: sha.slice(0, 7),
    branch: branch.code === 0 ? branch.stdout.trim() : undefined,
    changes: porcelainLines(status.stdout),
    defaultBranch,
    onDefaultBranch: defaultBranch ? await contains(root, defaultBranch, sha) : undefined,
  };
}

/** `git status --porcelain -z` as "XY path" lines, unquoted (so "My App.swiftpm" stays as is). */
export function porcelainLines(output: string): string[] {
  const fields = output.split("\0").filter(Boolean);
  const lines: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const line = fields[i]!;
    lines.push(line);
    // A rename or copy is followed by its original path.
    if (/^[RC]|^.[RC]/.test(line)) i++;
  }
  return lines;
}

async function remoteDefaultBranch(root: string): Promise<string | undefined> {
  const result = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

const contains = async (root: string, branch: string, sha: string) =>
  (await git(root, ["merge-base", "--is-ancestor", sha, branch])).code === 0;

export interface Tagging {
  tag: string;
  /** Whether origin has the tag now. */
  pushed: boolean;
  /** Why it isn't tagged or pushed. The upload already worked, so these never fail the run. */
  warnings: string[];
}

/** Tags the commit a build was uploaded from and pushes the tag to origin. */
export async function tagBuild(root: string, build: string, sha: string): Promise<Tagging> {
  const tag = tagFor(build);
  const warnings: string[] = [];
  const existing = await git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
  if (existing.code === 0 && existing.stdout.trim() !== sha) {
    warnings.push(`${tag} already points at ${existing.stdout.trim().slice(0, 7)}; left it alone.`);
    return { tag, pushed: false, warnings };
  }
  if (existing.code !== 0) {
    const created = await git(root, ["tag", tag, sha]);
    if (created.code !== 0) {
      warnings.push(`Couldn't create ${tag}: ${created.stderr.trim()}`);
      return { tag, pushed: false, warnings };
    }
  }
  if ((await git(root, ["remote", "get-url", "origin"])).code !== 0) {
    warnings.push(`No origin remote, so ${tag} is only on this machine.`);
    return { tag, pushed: false, warnings };
  }
  // Pushing the tag also pushes its commit, so origin has it even from an unpushed branch.
  const pushed = await git(root, ["push", "--quiet", "origin", `refs/tags/${tag}`]);
  if (pushed.code !== 0) warnings.push(`Couldn't push ${tag}: ${pushed.stderr.trim()}. Push it with: git push origin ${tag}`);
  return { tag, pushed: pushed.code === 0, warnings };
}

/**
 * Brings in the testflight/* tags and the default branch from origin, so
 * status sees uploads made from other machines. Best effort: offline, it
 * uses what the clone already has.
 */
export async function fetchBuildTags(root: string) {
  const defaultBranch = await remoteDefaultBranch(root);
  const branch = defaultBranch?.replace(/^origin\//, "");
  // --no-prune: with fetch.prune set, git would delete local tags origin doesn't have yet, like one whose push failed.
  await git(root, ["fetch", "--quiet", "--no-tags", "--no-prune", "origin", "refs/tags/testflight/*:refs/tags/testflight/*", ...(branch ? [branch] : [])]);
}

/** The commit each build was uploaded from, by build number. */
export async function buildCommits(root: string): Promise<Map<string, string>> {
  // %(*objectname) is the commit behind an annotated tag, for tags made by hand with -a.
  const result = await git(root, ["for-each-ref", "--format=%(refname:strip=3) %(objectname) %(*objectname)", "refs/tags/testflight/"]);
  const commits = new Map<string, string>();
  if (result.code !== 0) return commits;
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const [build, object, peeled] = line.split(" ");
    if (build && object) commits.set(build, peeled || object);
  }
  return commits;
}

/** Where the newest tagged build stands against the default branch. */
export interface Since {
  build: string;
  commit: string;
  /** Like `origin/main`. */
  branch: string;
  /** Whether the branch contains the build's commit (false for a build from an unmerged or squashed branch). */
  onBranch: boolean;
  /** Commits on the branch that aren't in the build. */
  commits: number;
}

export async function sinceBuild(root: string, build: string, commit: string): Promise<Since | undefined> {
  const branch = await remoteDefaultBranch(root);
  if (!branch) return undefined;
  const count = await git(root, ["rev-list", "--count", `${commit}..${branch}`]);
  if (count.code !== 0) return undefined;
  return { build, commit, branch, onBranch: await contains(root, branch, commit), commits: Number(count.stdout.trim()) };
}

export function describeSince(since: Since): string {
  const build = `build ${since.build} (${since.commit.slice(0, 7)})`;
  if (!since.onBranch) return `Newest tagged ${build} came from a commit that isn't on ${since.branch}.`;
  if (since.commits === 0) return `Newest tagged ${build} is up to date with ${since.branch}.`;
  return `${since.branch} has ${since.commits} commit${since.commits === 1 ? "" : "s"} since ${build}: git log --oneline ${since.commit.slice(0, 7)}..${since.branch}`;
}

/**
 * Why the checkout no longer matches `before` (HEAD moved, or files changed), or undefined when it
 * still does. `rewritten` lists repo-relative paths the build itself rewrites.
 */
export function drift(before: Commit, after: Commit | undefined, rewritten: string[] = []): string | undefined {
  if (!after) return "HEAD can't be read anymore";
  if (after.sha !== before.sha) return `HEAD moved from ${before.short} to ${after.short}`;
  // Porcelain lines are "XY path", with paths relative to the repo root.
  const changed = after.changes.filter((line) => !before.changes.includes(line) && !rewritten.includes(line.slice(3)));
  if (changed.length) return `changed: ${changed.slice(0, 5).map((line) => line.slice(3)).join(", ")}`;
  return undefined;
}

/** The SHIP_COMMIT build setting: the commit, marked when the build has uncommitted changes. */
export const commitSetting = (commit: Commit) => (commit.changes.length ? `${commit.sha}-dirty` : commit.sha);
