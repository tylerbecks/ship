import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { status } from "../src/commands/status";
import {
  type AppEntry,
  appsPath,
  dedupeApps,
  findApp,
  forgetApp,
  loadApps,
  loadProject,
  locateConfig,
  matchApps,
  rememberApp,
} from "../src/config";
import { useCredentials } from "../src/credentials";
import { canonicalRoot, checkoutTop, inLinkedCheckout, mainCheckout, parseWorktreeList, worktreeRoots } from "../src/git";
import { ui } from "../src/ui";
import { captureLog, git, jsonApi, mockAsc, noRetryDelay, temp, testCredentials } from "./helpers";

const entry = (name: string, bundleId: string, root: string, addedAt: string): AppEntry => ({ name, bundleId, root, addedAt });

/** A repo with one commit at `<dir>/app`, and a worktree of it at `<dir>/app/.claude/worktrees/x`. */
async function repoWithWorktree() {
  const dir = realpathSync(temp());
  const main = join(dir, "app");
  mkdirSync(main);
  await git(main, "init", "--quiet");
  writeFileSync(join(main, "README"), "hi");
  await git(main, "add", "README");
  await git(main, "commit", "--quiet", "-m", "first");
  const worktree = join(main, ".claude", "worktrees", "x");
  await git(main, "worktree", "add", "--quiet", "-b", "x", worktree);
  return { dir, main, worktree };
}

const shipJSON = (bundleId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "App", kind: "xcodeproj", path: "App.xcodeproj", scheme: "App", bundleId, ...extra });

beforeEach(() => {
  rmSync(appsPath, { force: true });
});

describe("dedupeApps", () => {
  const canonical = (map: Record<string, string | undefined>) => (root: string) => (root in map ? map[root] : root);

  test("collapses a worktree into its main checkout, keeping the earliest addedAt", () => {
    const apps = [
      entry("SwiftUI for Humans", "com.swiftuiforhumans.app", "/c/s", "2026-05-01T00:00:00Z"),
      entry("SwiftUI for Humans", "com.swiftuiforhumans.app", "/c/s/.claude/worktrees/w", "2026-04-01T00:00:00Z"),
      entry("Lift", "com.tylerbecks.lift", "/c/lift", "2026-01-01T00:00:00Z"),
    ];
    expect(dedupeApps(apps, canonical({ "/c/s/.claude/worktrees/w": "/c/s" }))).toEqual([
      entry("Lift", "com.tylerbecks.lift", "/c/lift", "2026-01-01T00:00:00Z"),
      entry("SwiftUI for Humans", "com.swiftuiforhumans.app", "/c/s", "2026-04-01T00:00:00Z"),
    ]);
  });

  test("moves a lone worktree entry to its main checkout", () => {
    const apps = [entry("A", "com.a", "/c/a/wt", "2026-01-01T00:00:00Z")];
    expect(dedupeApps(apps, canonical({ "/c/a/wt": "/c/a" }))[0]!.root).toBe("/c/a");
  });

  test("drops a vanished folder only when the app is listed elsewhere", () => {
    const apps = [
      entry("A", "com.a", "/c/a", "2026-01-01T00:00:00Z"),
      entry("A", "com.A", "/gone/wt", "2026-01-02T00:00:00Z"),
      entry("B", "com.b", "/gone/b", "2026-01-03T00:00:00Z"),
    ];
    const healed = dedupeApps(apps, canonical({ "/gone/wt": undefined, "/gone/b": undefined }));
    expect(healed.map((app) => app.root)).toEqual(["/c/a", "/gone/b"]);
  });

  test("keeps two clones, and two apps in one repo, apart", () => {
    const apps = [
      entry("A", "com.a", "/c/one", "2026-01-01T00:00:00Z"),
      entry("A", "com.a", "/c/two", "2026-01-02T00:00:00Z"),
      entry("A Watch", "com.a.watch", "/c/one", "2026-01-03T00:00:00Z"),
    ];
    expect(dedupeApps(apps, (root) => root).length).toBe(3);
  });
});

describe("worktrees", () => {
  test("map to their main checkout, subfolders included", async () => {
    const { dir, main, worktree } = await repoWithWorktree();
    expect(await mainCheckout(worktree)).toBe(main);
    expect(await mainCheckout(main)).toBe(main);
    expect(await checkoutTop(worktree)).toBe(worktree);
    expect(await canonicalRoot(worktree)).toBe(main);
    mkdirSync(join(worktree, "ios"));
    expect(await canonicalRoot(join(worktree, "ios"))).toBe(join(main, "ios"));
    expect(await worktreeRoots(worktree)).toEqual([main, worktree]);
    // Outside git, a folder is its own root.
    const loose = join(dir, "loose");
    mkdirSync(loose);
    expect(await canonicalRoot(loose)).toBe(loose);
    expect(await mainCheckout(loose)).toBeUndefined();
    expect(await worktreeRoots(join(dir, "missing"))).toEqual([]);
  });

  test("parseWorktreeList skips a bare repo", () => {
    const output = "worktree /r/repo.git\nbare\n\nworktree /r/wt\nHEAD abc\nbranch refs/heads/x\n\nworktree /r/old\nHEAD def\ndetached\nprunable gitdir file points to non-existent location\n";
    expect(parseWorktreeList(output)).toEqual(["/r/wt", "/r/old"]);
  });
});

describe("the app list", () => {
  test("ship init in a worktree registers the main checkout once", async () => {
    const { main, worktree } = await repoWithWorktree();
    expect(await rememberApp({ name: "App", bundleId: "com.example.app", root: main })).toBe(main);
    const first = (await loadApps())[0]!.addedAt;
    expect(await rememberApp({ name: "App", bundleId: "com.example.app", root: worktree })).toBe(main);
    const apps = await loadApps();
    expect(apps).toEqual([{ name: "App", bundleId: "com.example.app", root: main, addedAt: first }]);
  });

  test("a lone worktree entry moves to the main checkout while the worktree is there", async () => {
    const { main, worktree } = await repoWithWorktree();
    writeFileSync(appsPath, JSON.stringify([entry("App", "com.example.app", worktree, "2026-01-01T00:00:00.000Z")]));
    const healed = [entry("App", "com.example.app", main, "2026-01-01T00:00:00.000Z")];
    expect(await loadApps()).toEqual(healed);
    expect(JSON.parse(await Bun.file(appsPath).text())).toEqual(healed);
    expect(inLinkedCheckout(worktree)).toBe(true);
    expect(inLinkedCheckout(join(worktree, "ios"))).toBe(true);
    expect(inLinkedCheckout(main)).toBe(false);
  });

  test("loading heals an apps.json that lists a worktree, and writes it back", async () => {
    const { main, worktree } = await repoWithWorktree();
    const legacy = [
      entry("App", "com.example.app", main, "2026-02-01T00:00:00.000Z"),
      entry("App", "com.example.app", worktree, "2026-01-01T00:00:00.000Z"),
    ];
    writeFileSync(appsPath, JSON.stringify(legacy));
    const healed = [entry("App", "com.example.app", main, "2026-01-01T00:00:00.000Z")];
    expect(await loadApps()).toEqual(healed);
    expect(JSON.parse(await Bun.file(appsPath).text())).toEqual(healed);
  });

  test("forgetting from a worktree forgets the app", async () => {
    const { main, worktree } = await repoWithWorktree();
    await rememberApp({ name: "App", bundleId: "com.example.app", root: main });
    expect(await forgetApp(worktree)).toBe(true);
    expect(await loadApps()).toEqual([]);
  });

  test("findApp matches a name or bundle id, ignoring case", async () => {
    const apps = [entry("Lift", "com.tylerbecks.lift", "/a", "1"), entry("Other", "com.other", "/b", "2")];
    expect(matchApps(apps, "lift").length).toBe(1);
    expect(matchApps(apps, "COM.TYLERBECKS.LIFT").length).toBe(1);
    writeFileSync(appsPath, JSON.stringify(apps));
    expect((await findApp("LIFT")).root).toBe("/a");
    await expect(findApp("nope")).rejects.toMatchObject({ code: "unknown-app" });
  });

  test("findApp won't guess between two apps with one name", async () => {
    writeFileSync(appsPath, JSON.stringify([entry("Lift", "com.a", "/a", "1"), entry("Lift", "com.b", "/b", "2")]));
    await expect(findApp("Lift")).rejects.toMatchObject({ code: "ambiguous-app", exitCode: 2, details: { choices: ["com.a", "com.b"] } });
  });

  test("--app uses a worktree's ship.json until the main checkout has one", async () => {
    const { main, worktree } = await repoWithWorktree();
    writeFileSync(join(worktree, "ship.json"), shipJSON("com.example.app"));
    await rememberApp({ name: "App", bundleId: "com.example.app", root: worktree });
    expect(await locateConfig((await loadApps())[0]!)).toBe(worktree);
    expect((await loadProject({ app: "app" })).root).toBe(worktree);
    writeFileSync(join(main, "ship.json"), shipJSON("com.example.app"));
    expect((await loadProject({ app: "com.example.app" })).root).toBe(main);
  });

  test("--app finds a worktree's ship.json in a subfolder the main checkout doesn't have yet", async () => {
    const { main, worktree } = await repoWithWorktree();
    mkdirSync(join(worktree, "ios"));
    writeFileSync(join(worktree, "ios", "ship.json"), shipJSON("com.example.app"));
    expect(await rememberApp({ name: "App", bundleId: "com.example.app", root: join(worktree, "ios") })).toBe(join(main, "ios"));
    const app = (await loadApps())[0]!;
    expect(app.root).toBe(join(main, "ios"));
    expect(await locateConfig(app)).toBe(join(worktree, "ios"));
    expect((await loadProject({ app: "App" })).root).toBe(join(worktree, "ios"));
  });

  test("a worktree's ship.json for another app doesn't count", async () => {
    const { main, worktree } = await repoWithWorktree();
    writeFileSync(join(worktree, "ship.json"), shipJSON("com.example.other"));
    writeFileSync(appsPath, JSON.stringify([entry("App", "com.example.app", main, "1")]));
    await expect(loadProject({ app: "App" })).rejects.toMatchObject({ code: "missing-config" });
  });
});

describe("status --all", () => {
  let mock: ReturnType<typeof mockAsc> | undefined;
  let delay: ReturnType<typeof noRetryDelay>;
  beforeEach(() => {
    delay = noRetryDelay();
  });
  afterEach(() => {
    mock?.restore();
    delay.restore();
    useCredentials(undefined);
    ui.json = false;
    ui.quiet = false;
  });

  test("skips an app whose ship.json is gone and reports the rest", async () => {
    await testCredentials();
    const { main } = await repoWithWorktree();
    writeFileSync(join(main, "ship.json"), shipJSON("com.example.app", { ascAppId: "123" }));
    writeFileSync(appsPath, JSON.stringify([entry("App", "com.example.app", main, "1"), entry("Gone", "com.gone", join(main, "nope"), "2")]));
    mock = mockAsc((call) => {
      if (call.path === "/v1/builds" || call.path === "/v1/apps/123/betaGroups") return { json: jsonApi([]) };
    });
    ui.json = true;
    ui.quiet = true;
    const output = JSON.parse(await captureLog(() => status({ all: true, limit: 5 })));
    expect(output.apps.map((app: { name: string }) => app.name)).toEqual(["App"]);
    expect(output.skipped).toEqual([{ name: "Gone", root: join(main, "nope"), reason: expect.stringContaining("ship.json is missing") }]);
  });
});
