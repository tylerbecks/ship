// What git knows about the commit a build comes from.
//
// `ship beta` tags the commit of every upload `testflight/<build>` and pushes
// the tag, so the repo itself records what's in TestFlight: `ship status`
// reads the tags, and `git log testflight/<build>..origin/main` lists what
// isn't shipped yet. The tag is made before archiving, as a claim on the
// number (see claimBuild), and annotated with the app, version, and platform.

import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
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
export const git = (root: string, args: string[]) => run(["git", ...args], { cwd: root, env: { GIT_TERMINAL_PROMPT: "0" } });

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
  /** Why it isn't tagged or pushed. These never fail the run. */
  warnings: string[];
}

/**
 * What an annotated build tag says: "MyApp 1.0.1 (10), iOS", then trailers
 * a reader (or a script) can pick out of `git tag -n99`.
 */
export function buildTagMessage(info: { app: string; bundleId: string; version?: string; build: string; platform: string; platformTitle: string; branch?: string }): string {
  const name = info.version ? `${info.app} ${info.version} (${info.build})` : `${info.app} build ${info.build}`;
  const trailers = [
    `Ship-Bundle-Id: ${info.bundleId}`,
    `Ship-Platform: ${info.platform}`,
    ...(info.version ? [`Ship-Version: ${info.version}`] : []),
    ...(info.branch ? [`Ship-Branch: ${info.branch}`] : []),
  ];
  return `${name}, ${info.platformTitle}\n\n${trailers.join("\n")}`;
}

/** Makes an annotated tag, as "ship" when git has no identity set (an annotated tag needs a tagger). */
async function annotatedTag(root: string, tag: string, sha: string, message: string) {
  const created = await git(root, ["tag", "-a", "-m", message, tag, sha]);
  if (created.code === 0) return created;
  return git(root, ["-c", "user.name=ship", "-c", "user.email=ship@localhost", "tag", "-a", "-m", message, tag, sha]);
}

/** Whether the repo has an origin remote to push tags to. */
export const hasOrigin = async (root: string) => (await git(root, ["remote", "get-url", "origin"])).code === 0;

/** Tags `sha` (annotated, with `message`) and pushes the tag to origin. A tag already at another commit is left alone. */
export async function tagCommit(root: string, tag: string, sha: string, message: string): Promise<Tagging> {
  const warnings: string[] = [];
  const existing = await git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
  if (existing.code === 0 && existing.stdout.trim() !== sha) {
    warnings.push(`${tag} already points at ${existing.stdout.trim().slice(0, 7)}; left it alone.`);
    return { tag, pushed: false, warnings };
  }
  if (existing.code !== 0) {
    const created = await annotatedTag(root, tag, sha, message);
    if (created.code !== 0) {
      warnings.push(`Couldn't create ${tag}: ${created.stderr.trim()}`);
      return { tag, pushed: false, warnings };
    }
  }
  if (!(await hasOrigin(root))) {
    warnings.push(`No origin remote, so ${tag} is only on this machine.`);
    return { tag, pushed: false, warnings };
  }
  // Pushing the tag also pushes its commit, so origin has it even from an unpushed branch.
  const pushed = await git(root, ["push", "--quiet", "origin", `refs/tags/${tag}`]);
  if (pushed.code !== 0) warnings.push(`Couldn't push ${tag}: ${pushed.stderr.trim()}. Push it with: git push origin ${tag}`);
  return { tag, pushed: pushed.code === 0, warnings };
}

/** Tags the commit a build was uploaded from and pushes the tag to origin. */
export const tagBuild = (root: string, build: string, sha: string, message = `Build ${build}`) => tagCommit(root, tagFor(build), sha, message);

/**
 * A claimed build number: tagged and pushed, or `taken` when another commit
 * already has it. `created` says whether this claim made the tag, rather than
 * finding it on the commit already (another platform's build, or an earlier
 * run's), which only the claim that made it may give back.
 */
export type Claim = (Tagging & { taken: false; created: boolean }) | { tag: string; taken: true; by: string };

/**
 * Claims a build number before archiving: tags `sha` testflight/<build>
 * locally (atomic across worktrees, which share tags) and pushes the tag
 * (origin refuses a tag it already has, so two machines can't both claim
 * it). Without origin, or offline, the claim is only local, with a warning.
 */
export async function claimBuild(root: string, build: string, sha: string, message: string): Promise<Claim> {
  const tag = tagFor(build);
  const existing = await git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
  if (existing.code === 0 && existing.stdout.trim() !== sha) return { tag, taken: true, by: existing.stdout.trim() };
  const created = existing.code !== 0;
  if (created) {
    const made = await annotatedTag(root, tag, sha, message);
    if (made.code !== 0) {
      // Another worktree made it between the check and now.
      const now = await git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
      if (now.code === 0 && now.stdout.trim() !== sha) return { tag, taken: true, by: now.stdout.trim() };
      return { tag, pushed: false, warnings: [`Couldn't create ${tag}: ${made.stderr.trim()}`], taken: false, created: false };
    }
  }
  if (!(await hasOrigin(root))) return { tag, pushed: false, warnings: [`No origin remote, so ${tag} is only on this machine.`], taken: false, created };
  const pushed = await git(root, ["push", "--quiet", "origin", `refs/tags/${tag}`]);
  if (pushed.code === 0) return { tag, pushed: true, warnings: [], taken: false, created };
  if (/already exists|\[rejected\]/.test(pushed.stderr)) {
    await git(root, ["tag", "-d", tag]);
    const fetched = await git(root, ["ls-remote", "origin", `refs/tags/${tag}^{}`, `refs/tags/${tag}`]);
    const by = fetched.stdout.trim().split("\n").at(-1)?.split(/\s/)[0] ?? "";
    // Another platform's build of this commit claimed it first: share its tag.
    if (by === sha && (await git(root, ["fetch", "--quiet", "origin", `refs/tags/${tag}:refs/tags/${tag}`])).code === 0) {
      return { tag, pushed: true, warnings: [], taken: false, created: false };
    }
    return { tag, taken: true, by };
  }
  return { tag, pushed: false, warnings: [`Couldn't push ${tag}, so another machine could pick the same number: ${pushed.stderr.trim()}`], taken: false, created };
}

/**
 * Gives up a claim whose upload failed, so the number is free again. Best
 * effort, and only for a tag the claim made: one it found may record another
 * build of the commit.
 */
export async function releaseClaim(root: string, claim: Tagging & { created: boolean }) {
  if (!claim.created) return;
  await git(root, ["tag", "-d", claim.tag]);
  if (claim.pushed) await git(root, ["push", "--quiet", "origin", `:refs/tags/${claim.tag}`]);
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
  // %(*objectname) is the commit behind an annotated tag; a lightweight one (older ship, or by hand) has only %(objectname).
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

// MARK: Worktrees

/** A path with symlinks resolved (/var → /private/var on macOS), as git reports paths. */
const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** The top of the checkout (main or worktree) that `dir` is in, or undefined outside git. */
export async function checkoutTop(dir: string): Promise<string | undefined> {
  if (!existsSync(dir)) return undefined;
  const result = await git(dir, ["rev-parse", "--show-toplevel"]);
  return result.code === 0 && result.stdout.trim() ? real(result.stdout.trim()) : undefined;
}

/**
 * The repo's main checkout (where its .git folder is), from inside it or any
 * of its worktrees. undefined outside git, or when the repo is bare or keeps
 * its git folder somewhere else (a submodule).
 */
export async function mainCheckout(dir: string): Promise<string | undefined> {
  if (!existsSync(dir)) return undefined;
  let result = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  // git before 2.31 has no --path-format; its answer is relative to `dir`.
  if (result.code !== 0) result = await git(dir, ["rev-parse", "--git-common-dir"]);
  if (result.code !== 0 || !result.stdout.trim()) return undefined;
  const common = real(resolve(dir, result.stdout.trim()));
  return basename(common) === ".git" ? dirname(common) : undefined;
}

/**
 * Whether `dir` is inside a linked worktree (or a submodule): the nearest
 * .git above it is a file pointing elsewhere, not the repo's folder. Only
 * the file system, so it's cheap enough to ask of every app.
 */
export function inLinkedCheckout(dir: string): boolean {
  for (let at = resolve(dir); ; at = dirname(at)) {
    const dotGit = join(at, ".git");
    if (existsSync(dotGit)) return statSync(dotGit).isFile();
    if (dirname(at) === at) return false;
  }
}

/**
 * Where a folder in a worktree lives in the main checkout: the same path
 * relative to the checkout's top, so a ship.json in a subfolder maps to the
 * same subfolder. Outside git (or in a bare repo) it's the folder itself.
 */
export async function canonicalRoot(configRoot: string): Promise<string> {
  const [main, top] = await Promise.all([mainCheckout(configRoot), checkoutTop(configRoot)]);
  if (!main || !top) return real(configRoot);
  return join(main, relative(top, real(configRoot)));
}

/** The top of every checkout of the repo `dir` is in, main checkout first (`git worktree list`). */
export async function worktreeRoots(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const result = await git(dir, ["worktree", "list", "--porcelain"]);
  return result.code === 0 ? parseWorktreeList(result.stdout) : [];
}

/** The checkouts in `git worktree list --porcelain` output, skipping a bare repo's entry. */
export function parseWorktreeList(output: string): string[] {
  return output
    .split(/\n\n+/)
    .map((block) => block.split("\n"))
    .filter((lines) => !lines.includes("bare"))
    .map((lines) => lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length))
    .filter((path): path is string => Boolean(path));
}
