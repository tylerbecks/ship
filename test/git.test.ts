import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/exec";
import { buildCommits, describeSince, fetchBuildTags, headCommit, sinceBuild, tagBuild } from "../src/git";

const temp = () => mkdtempSync(join(tmpdir(), "ship-git-"));

async function git(cwd: string, ...args: string[]) {
  const result = await run(["git", "-c", "user.name=Ship", "-c", "user.email=ship@example.com", "-c", "init.defaultBranch=main", ...args], { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function commit(cwd: string, file: string) {
  writeFileSync(join(cwd, file), file);
  await git(cwd, "add", file);
  await git(cwd, "commit", "--quiet", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
}

/** A clone of a bare origin with one pushed commit on main, and origin/HEAD set. */
async function repo() {
  const dir = temp();
  await git(dir, "init", "--quiet", "--bare", "origin.git");
  await git(dir, "clone", "--quiet", "origin.git", "app");
  const app = join(dir, "app");
  const first = await commit(app, "a");
  await git(app, "push", "--quiet", "origin", "HEAD:main");
  await git(app, "remote", "set-head", "origin", "main");
  return { dir, app, origin: join(dir, "origin.git"), first };
}

describe("headCommit", () => {
  test("is undefined outside a repo", async () => {
    expect(await headCommit(temp())).toBeUndefined();
  });

  test("reports the branch, uncommitted changes, and whether origin's default branch has it", async () => {
    const { app, first } = await repo();
    expect(await headCommit(app)).toEqual({
      sha: first,
      short: first.slice(0, 7),
      branch: "main",
      changes: [],
      defaultBranch: "origin/main",
      onDefaultBranch: true,
    });

    await git(app, "switch", "--quiet", "-c", "feature");
    await commit(app, "b");
    writeFileSync(join(app, "a"), "edited");
    writeFileSync(join(app, "new"), "untracked");
    const head = await headCommit(app);
    expect(head?.branch).toBe("feature");
    expect(head?.onDefaultBranch).toBe(false);
    expect(head?.changes).toEqual([" M a", "?? new"]);
  });
});

describe("build tags", () => {
  test("tags a build, pushes the tag, and reads it back", async () => {
    const { app, origin, first } = await repo();
    expect(await tagBuild(app, "42", first)).toEqual({ tag: "testflight/42", pushed: true, warnings: [] });
    expect(await git(origin, "rev-parse", "testflight/42")).toBe(first);
    expect(await buildCommits(app)).toEqual(new Map([["42", first]]));

    // Re-tagging the same commit is fine; another commit is left alone.
    expect((await tagBuild(app, "42", first)).warnings).toEqual([]);
    const second = await commit(app, "b");
    expect((await tagBuild(app, "42", second)).warnings[0]).toContain("already points at");
  });

  test("keeps the tag local when there's no origin", async () => {
    const app = temp();
    await git(app, "init", "--quiet");
    const sha = await commit(app, "a");
    const tagging = await tagBuild(app, "1", sha);
    expect(tagging.pushed).toBe(false);
    expect(tagging.warnings[0]).toContain("No origin remote");
    expect(await buildCommits(app)).toEqual(new Map([["1", sha]]));
  });

  test("reads hand-made annotated tags as their commit", async () => {
    const { app, first } = await repo();
    await git(app, "tag", "-a", "testflight/7", "-m", "backfill", first);
    expect(await buildCommits(app)).toEqual(new Map([["7", first]]));
  });

  test("fetches tags pushed from another clone", async () => {
    const { dir, app, first } = await repo();
    await git(dir, "clone", "--quiet", "origin.git", "other");
    await tagBuild(join(dir, "other"), "9", first);
    expect((await buildCommits(app)).size).toBe(0);
    await fetchBuildTags(app);
    expect(await buildCommits(app)).toEqual(new Map([["9", first]]));
  });
});

test("fetching keeps local tags origin doesn't have, even with fetch.prune", async () => {
  const { app, first } = await repo();
  await git(app, "config", "fetch.prune", "true");
  await git(app, "tag", "testflight/5", first);
  await fetchBuildTags(app);
  expect(await buildCommits(app)).toEqual(new Map([["5", first]]));
});

describe("sinceBuild", () => {
  test("counts the default branch's commits since a build", async () => {
    const { app, first } = await repo();
    await commit(app, "b");
    await commit(app, "c");
    await git(app, "push", "--quiet", "origin", "HEAD:main");
    await git(app, "fetch", "--quiet", "origin");
    const since = await sinceBuild(app, "3", first);
    expect(since).toEqual({ build: "3", commit: first, branch: "origin/main", onBranch: true, commits: 2 });
    expect(describeSince(since!)).toBe(`origin/main has 2 commits since build 3 (${first.slice(0, 7)}): git log --oneline ${first.slice(0, 7)}..origin/main`);
  });

  test("says when a build's commit isn't on the default branch", () => {
    const since = { build: "3", commit: "abcdef1234", branch: "origin/main", onBranch: false, commits: 5 };
    expect(describeSince(since)).toBe("Newest tagged build 3 (abcdef1) came from a commit that isn't on origin/main.");
    expect(describeSince({ ...since, onBranch: true, commits: 0 })).toBe("Newest tagged build 3 (abcdef1) is up to date with origin/main.");
  });
});
