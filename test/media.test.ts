import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { polling } from "../src/asc/media";
import type { AppStoreVersion } from "../src/asc/versions";
import { commands } from "../src/commands/screenshots";
import { type Project, loadProject } from "../src/config";
import { imageInfo, md5, naturalCompare, sizeProblem } from "../src/store/images";
import {
  type MediaLock,
  chooseVersion,
  diffMedia,
  localMedia,
  matchPulled,
  mediaFileName,
  planChanges,
  planSet,
  pullMedia,
  pushMedia,
  readLock,
  renderMediaChanges,
  setJSON,
  syncMedia,
  updateLock,
  validateMedia,
  writeLock,
} from "../src/store/media";
import { ui } from "../src/ui";
import { type AscCall, type AscReply, captureLog, jsonApi, mockAsc, noRetryDelay, resource, temp, testCredentials } from "./helpers";

// MARK: Tiny images

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, data: number[]) => [...be32(data.length), ...Buffer.from(type), ...data, 0, 0, 0, 0];

/** A PNG header with IHDR (and optionally tRNS), enough for imageInfo. `seed` makes the bytes (and MD5) differ. */
function png(width: number, height: number, options: { colorType?: number; trns?: boolean; seed?: number } = {}): Uint8Array {
  const ihdr = chunk("IHDR", [...be32(width), ...be32(height), 8, options.colorType ?? 2, 0, 0, 0]);
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...ihdr,
    ...(options.trns ? chunk("tRNS", [0, 0]) : []),
    ...chunk("IDAT", [options.seed ?? 0, 1, 2, 3]),
    ...chunk("IEND", []),
  ]);
}

/** A JPEG with an APP0 and a DHT segment before the frame header. */
function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  const app0 = [0xff, 0xe0, 0, 16, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const dht = [0xff, 0xc4, 0, 5, 0, 0, 0];
  const frame = [0xff, sof, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...dht, ...frame, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
}

describe("image headers", () => {
  test("PNG size and transparency", () => {
    expect(imageInfo(png(1290, 2796))).toEqual({ format: "png", width: 1290, height: 2796, alpha: false });
    expect(imageInfo(png(10, 20, { colorType: 6 }))?.alpha).toBe(true);
    expect(imageInfo(png(10, 20, { colorType: 4 }))?.alpha).toBe(true);
    expect(imageInfo(png(10, 20, { colorType: 3, trns: true }))?.alpha).toBe(true);
    expect(imageInfo(png(70000, 3))?.width).toBe(70000);
  });

  test("JPEG size from the first frame header, past other segments", () => {
    expect(imageInfo(jpeg(1320, 2868))).toEqual({ format: "jpeg", width: 1320, height: 2868, alpha: false });
    expect(imageInfo(jpeg(640, 960, 0xc2))).toMatchObject({ width: 640, height: 960 });
  });

  test("anything else is undefined", () => {
    expect(imageInfo(new Uint8Array())).toBeUndefined();
    expect(imageInfo(Buffer.from("GIF89a and more bytes here"))).toBeUndefined();
    expect(imageInfo(png(10, 10).slice(0, 20))).toBeUndefined();
    expect(imageInfo(png(0, 10))).toBeUndefined();
    expect(imageInfo(jpeg(10, 10).slice(0, 30))).toBeUndefined();
    // A scan before any frame header.
    expect(imageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]))).toBeUndefined();
    expect(imageInfo(new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00]))).toBeUndefined();
  });
});

describe("sizes", () => {
  test("each type's sizes, portrait or landscape where Apple allows", () => {
    expect(sizeProblem("APP_IPHONE_67", 1290, 2796)).toBeUndefined();
    expect(sizeProblem("APP_IPHONE_67", 2868, 1320)).toBeUndefined();
    expect(sizeProblem("APP_IPHONE_61", 1179, 2556)).toBeUndefined();
    expect(sizeProblem("APP_IPHONE_58", 1179, 2556)).toBeUndefined();
    expect(sizeProblem("APP_IPHONE_40", 1136, 600)).toBeUndefined();
    expect(sizeProblem("APP_IPAD_PRO_3GEN_129", 2752, 2064)).toBeUndefined();
    expect(sizeProblem("APP_DESKTOP", 2880, 1800)).toBeUndefined();
    expect(sizeProblem("APP_WATCH_ULTRA", 422, 514)).toBeUndefined();
    expect(sizeProblem("IMESSAGE_APP_IPHONE_65", 1284, 2778)).toBeUndefined();
  });

  test("a wrong size names the type and its sizes", () => {
    expect(sizeProblem("APP_IPHONE_67", 1242, 2688)).toBe(
      '1242x2688 isn\'t a 6.9" iPhone screenshot size (APP_IPHONE_67 takes 1260x2736, 2736x1260, 1290x2796, 2796x1290, 1320x2868, 2868x1320)',
    );
    expect(sizeProblem("APP_DESKTOP", 800, 1280)).toContain("APP_DESKTOP takes");
    expect(sizeProblem("APP_WATCH_SERIES_10", 496, 416)).toBeDefined();
    expect(sizeProblem("APP_APPLE_TV", 1080, 1920)).toBeDefined();
  });

  test("an unknown type has nothing to check against", () => {
    expect(sizeProblem("APP_IPHONE_99", 1, 1)).toBeUndefined();
  });
});

test("natural order", () => {
  expect(["10-c.png", "2-b.png", "1-a.png", "01-z.png", "a.png"].sort(naturalCompare)).toEqual(["1-a.png", "01-z.png", "2-b.png", "10-c.png", "a.png"]);
  expect(["Shot 10", "shot 9"].sort(naturalCompare)).toEqual(["shot 9", "Shot 10"]);
});

test("pulled file names", () => {
  expect(mediaFileName(0, "Home Screen.png", ".png")).toBe("01-Home-Screen.png");
  expect(mediaFileName(11, "03-list.jpg", ".png")).toBe("12-list.png");
  expect(mediaFileName(1, "../../etc/passwd", ".png")).toBe("02-passwd.png");
  expect(mediaFileName(1, "C:\\shots\\a b.png", ".png")).toBe("02-a-b.png");
  expect(mediaFileName(2, ".png", ".png")).toBe("03-screenshot.png");
  expect(mediaFileName(0, "intro.mov", ".mov", "preview")).toBe("01-intro.mov");
});

// MARK: Planning

const base = { locale: "en-US", kind: "screenshots" as const, type: "APP_IPHONE_67", lock: {} as MediaLock };
const P = (name: string) => `en-US/screenshots/APP_IPHONE_67/${name}`;

describe("plan", () => {
  test("new files upload, in order", () => {
    const plan = planSet({ ...base, local: [{ path: P("01-a.png"), md5: "a" }, { path: P("02-b.png"), md5: "b" }], remote: [] });
    expect(setJSON(plan)).toEqual({ locale: "en-US", type: "APP_IPHONE_67", kind: "screenshots", upload: [P("01-a.png"), P("02-b.png")], replace: [], delete: [], keep: 0, reorder: false });
    expect(planChanges(plan)).toEqual([
      { scope: "en-US/screenshots/APP_IPHONE_67", field: "01-a.png", kind: "add", to: "a" },
      { scope: "en-US/screenshots/APP_IPHONE_67", field: "02-b.png", kind: "add", to: "b" },
    ]);
  });

  test("files whose MD5 is the upload's checksum are unchanged", () => {
    const plan = planSet({
      ...base,
      local: [{ path: P("01-a.png"), md5: "a" }, { path: P("02-b.png"), md5: "b" }],
      remote: [{ id: "1", fileName: "a.png", checksum: "a" }, { id: "2", fileName: "b.png", checksum: "b" }],
    });
    expect(planChanges(plan)).toEqual([]);
    expect(plan.reorder).toBe(false);
  });

  test("a pulled file matches its upload through the lock", () => {
    const lock = { [P("01-a.png")]: { md5: "pulled", checksum: "original" } };
    const plan = planSet({ ...base, lock, local: [{ path: P("01-a.png"), md5: "pulled" }], remote: [{ id: "1", fileName: "a.png", checksum: "original" }] });
    expect(planChanges(plan)).toEqual([]);
  });

  test("a locked file that changed replaces its upload, even without --prune", () => {
    const lock = { [P("01-a.png")]: { md5: "pulled", checksum: "original" } };
    const plan = planSet({
      ...base,
      lock,
      local: [{ path: P("01-a.png"), md5: "edited" }, { path: P("02-b.png"), md5: "b" }],
      remote: [{ id: "1", fileName: "a.png", checksum: "original" }, { id: "2", fileName: "b.png", checksum: "b" }],
    });
    expect(setJSON(plan)).toMatchObject({ upload: [], replace: [P("01-a.png")], delete: ["a.png"], keep: 0, reorder: true });
    expect(plan.order).toEqual([`local:${P("01-a.png")}`, "2"]);
    expect(planChanges(plan)).toEqual([
      { scope: "en-US/screenshots/APP_IPHONE_67", field: "01-a.png", kind: "change", from: "original", to: "edited" },
      { scope: "en-US/screenshots/APP_IPHONE_67", field: "order", kind: "change", from: ["b.png"], to: ["01-a.png", "b.png"] },
    ]);
  });

  test("uploads not in the repo stay after the repo's files, or go with --prune", () => {
    const input = { ...base, local: [{ path: P("01-a.png"), md5: "a" }], remote: [{ id: "x", fileName: "extra.png", checksum: "x" }, { id: "1", fileName: "a.png", checksum: "a" }] };
    const kept = planSet(input);
    expect(setJSON(kept)).toMatchObject({ delete: [], keep: 1, reorder: true });
    expect(kept.order).toEqual(["1", "x"]);
    const pruned = planSet({ ...input, prune: true });
    expect(setJSON(pruned)).toMatchObject({ delete: ["extra.png"], keep: 0, reorder: false });
    expect(planChanges(pruned)).toEqual([{ scope: "en-US/screenshots/APP_IPHONE_67", field: "extra.png", kind: "remove", from: "x", to: null }]);
  });

  test("an upload without a checksum is kept and counted like any other, or goes with --prune", () => {
    const input = { ...base, local: [{ path: P("01-a.png"), md5: "a" }], remote: [{ id: "1", fileName: "a.png", checksum: "a" }, { id: "n", fileName: "other.png" }] };
    const kept = planSet(input);
    expect(setJSON(kept)).toMatchObject({ delete: [], keep: 1, reorder: false });
    // The reorder PATCH replaces the whole list, so every member of the set is in it.
    expect(kept.order).toEqual(["1", "n"]);
    expect(planSet({ ...input, prune: true }).delete).toEqual(["other.png"]);
    const full = Array.from({ length: 10 }, (_, i) => ({ path: P(`${i}.png`), md5: `l${i}` }));
    expect(() => planSet({ ...input, local: full })).toThrow(expect.objectContaining({ code: "too-many-media" }));
  });

  test("failed and unfinished uploads are always deleted", () => {
    const plan = planSet({ ...base, local: [{ path: P("01-a.png"), md5: "a" }], remote: [{ id: "f", fileName: "a.png", checksum: "a", broken: true }] });
    expect(setJSON(plan)).toMatchObject({ upload: [P("01-a.png")], delete: ["a.png"], keep: 0 });
  });

  test("more than 10 with the kept ones is an error naming --prune", () => {
    const local = Array.from({ length: 9 }, (_, i) => ({ path: P(`${i}.png`), md5: `l${i}` }));
    const remote = [{ id: "x", fileName: "x.png", checksum: "x" }, { id: "y", fileName: "y.png", checksum: "y" }];
    expect(() => planSet({ ...base, local, remote })).toThrow(expect.objectContaining({ code: "too-many-media", hint: expect.stringContaining("--prune") }));
    expect(planSet({ ...base, local, remote, prune: true }).delete).toEqual(["x.png", "y.png"]);
    const previews = Array.from({ length: 4 }, (_, i) => ({ path: `p${i}`, md5: `${i}` }));
    expect(() => planSet({ ...base, kind: "previews", local: previews, remote: [] })).toThrow(expect.objectContaining({ code: "too-many-media" }));
  });

  test("only the order differs", () => {
    const plan = planSet({
      ...base,
      local: [{ path: P("01-b.png"), md5: "b" }, { path: P("02-a.png"), md5: "a" }],
      remote: [{ id: "1", fileName: "a.png", checksum: "a" }, { id: "2", fileName: "b.png", checksum: "b" }],
    });
    expect(setJSON(plan)).toMatchObject({ upload: [], replace: [], delete: [], reorder: true });
    expect(plan.order).toEqual(["2", "1"]);
    const changes = planChanges(plan);
    expect(changes).toEqual([{ scope: "en-US/screenshots/APP_IPHONE_67", field: "order", kind: "change", from: ["a.png", "b.png"], to: ["b.png", "a.png"] }]);
    expect(renderMediaChanges(changes)).toBe("en-US/screenshots/APP_IPHONE_67\n  ~ order: b.png, a.png");
  });

  test("pull matches by the lock first, then by MD5, one file per upload", () => {
    const files = [{ path: "01.png", md5: "m1" }, { path: "02.png", md5: "same" }, { path: "03.png", md5: "same" }];
    const lock = { "01.png": { md5: "m1", checksum: "orig" } };
    expect(matchPulled([{ checksum: "same" }, { checksum: "orig" }, { checksum: "same" }, { checksum: "same" }, {}], files, lock)).toEqual([
      "02.png",
      "01.png",
      "03.png",
      undefined,
      undefined,
    ]);
  });

  test("the same image twice matches two uploads", () => {
    const plan = planSet({
      ...base,
      local: [{ path: P("1.png"), md5: "s" }, { path: P("2.png"), md5: "s" }],
      remote: [{ id: "1", fileName: "1.png", checksum: "s" }],
    });
    expect(plan.upload).toEqual([P("2.png")]);
  });
});

// MARK: Files

describe("the store folder", () => {
  test("folders, order, dotfiles, and other files", () => {
    const dir = temp();
    const set = join(dir, "en-US", "screenshots", "APP_IPHONE_67");
    mkdirSync(set, { recursive: true });
    mkdirSync(join(dir, "en-US", "previews", "IPHONE_67"), { recursive: true });
    mkdirSync(join(dir, "testflight", "en-US"), { recursive: true });
    for (const name of ["10-c.PNG", "2-b.jpeg", "1-a.png", ".DS_Store", "notes.txt"]) writeFileSync(join(set, name), "x");
    writeFileSync(join(dir, "en-US", "screenshots", "loose.png"), "x");
    writeFileSync(join(dir, "en-US", "previews", "IPHONE_67", "01-intro.MOV"), "x");
    const media = localMedia(dir);
    expect(media.managed).toEqual([{ locale: "en-US", kind: "screenshots" }, { locale: "en-US", kind: "previews" }]);
    expect(media.stray).toEqual(["en-US/screenshots/loose.png"]);
    const screenshots = media.sets.find((s) => s.kind === "screenshots")!;
    expect(screenshots.files.map((f) => f.name)).toEqual(["1-a.png", "2-b.jpeg", "10-c.PNG"]);
    expect(screenshots.ignored).toEqual(["en-US/screenshots/APP_IPHONE_67/notes.txt"]);
    expect(media.sets.find((s) => s.kind === "previews")!.files.map((f) => f.path)).toEqual(["en-US/previews/IPHONE_67/01-intro.MOV"]);
    expect(localMedia(dir, { types: ["IPHONE_67"] }).sets.map((s) => s.type)).toEqual(["IPHONE_67"]);
    expect(localMedia(dir, { locales: ["ja"] }).managed).toEqual([]);
  });

  test("the lock: sorted, without files that are gone, and bad JSON names the file", async () => {
    const dir = temp();
    mkdirSync(join(dir, "en-US", "screenshots", "APP_IPHONE_67"), { recursive: true });
    writeFileSync(join(dir, P("b.png")), "x");
    writeFileSync(join(dir, P("a.png")), "x");
    expect(await readLock(dir)).toEqual({});
    await writeLock(dir, {});
    expect(existsSync(join(dir, "media.lock.json"))).toBe(false);
    let lock = updateLock({ [P("b.png")]: { md5: "1", checksum: "2" }, [P("gone.png")]: { md5: "3", checksum: "4" } }, { uploaded: [{ path: P("a.png"), md5: "5" }] });
    expect(Object.keys(lock)).toEqual([P("a.png"), P("b.png"), P("gone.png")]);
    await writeLock(dir, lock);
    expect(readFileSync(join(dir, "media.lock.json"), "utf8")).toBe(
      `{\n  "${P("a.png")}": {\n    "md5": "5",\n    "checksum": "5"\n  },\n  "${P("b.png")}": {\n    "md5": "1",\n    "checksum": "2"\n  }\n}\n`,
    );
    lock = updateLock(await readLock(dir), { removed: [P("a.png")] });
    expect(lock).toEqual({ [P("b.png")]: { md5: "1", checksum: "2" } });
    writeFileSync(join(dir, "media.lock.json"), "<<<<<<< HEAD");
    await expect(readLock(dir)).rejects.toMatchObject({ code: "bad-store-file", details: { file: join(dir, "media.lock.json") } });
  });

  test("validate", async () => {
    const dir = temp();
    const shots = join(dir, "en-US", "screenshots");
    mkdirSync(join(shots, "APP_IPHONE_67"), { recursive: true });
    mkdirSync(join(shots, "IPHONE_67"), { recursive: true });
    mkdirSync(join(shots, "APP_DESKTOP"), { recursive: true });
    mkdirSync(join(dir, "xx-YY", "previews", "APP_IPHONE_67"), { recursive: true });
    writeFileSync(join(shots, "APP_IPHONE_67", "01-ok.png"), png(1290, 2796));
    writeFileSync(join(shots, "APP_IPHONE_67", "02-small.png"), png(1242, 2688));
    writeFileSync(join(shots, "APP_IPHONE_67", "03-alpha.png"), png(1320, 2868, { colorType: 6 }));
    writeFileSync(join(shots, "APP_IPHONE_67", "04-named.png"), jpeg(1290, 2796));
    writeFileSync(join(shots, "APP_IPHONE_67", "05-broken.jpg"), "not an image");
    writeFileSync(join(shots, "APP_IPHONE_67", "06-empty.png"), "");
    writeFileSync(join(shots, "APP_DESKTOP", "01.png"), png(2880, 1800));
    const { problems, files } = await validateMedia(dir, { platform: "ios" });
    const find = (file: string) => problems.filter((p) => p.file === file).map((p) => `${p.severity}: ${p.message}`);
    expect(files).toBe(7);
    expect(find(P("01-ok.png"))).toEqual([]);
    expect(find(P("02-small.png"))[0]).toStartWith("error: 1242x2688 isn't");
    expect(find(P("03-alpha.png"))[0]).toStartWith("warning: It can be transparent");
    expect(find(P("04-named.png"))).toEqual(["warning: It's a JPEG named .png; rename it to match."]);
    expect(find(P("05-broken.jpg"))).toEqual(["error: This isn't a PNG or JPEG image ship can read."]);
    expect(find(P("06-empty.png"))).toEqual(["error: The file is empty."]);
    expect(find("en-US/screenshots/IPHONE_67")[0]).toContain('"IPHONE_67" isn\'t a screenshot display type. Did you mean APP_IPHONE_67?');
    expect(find("en-US/screenshots/APP_DESKTOP")[0]).toBe('warning: APP_DESKTOP is for macOS apps, and this one is iOS (ship.json "platform").');
    expect(find("xx-YY/previews")[0]).toStartWith("warning: xx-YY isn't a language");
    expect(find("xx-YY/previews/APP_IPHONE_67")[0]).toContain("Did you mean IPHONE_67?");

    for (let i = 0; i < 11; i++) writeFileSync(join(shots, "APP_IPHONE_67", `1${i}.png`), png(1290, 2796));
    const many = await validateMedia(dir, { types: ["APP_IPHONE_67"] });
    expect(many.problems.find((p) => p.file === "en-US/screenshots/APP_IPHONE_67")?.message).toBe("17 screenshots; App Store Connect takes up to 10 per set.");
  });
});

// MARK: Versions

const version = (versionString: string, state: string): AppStoreVersion => ({ id: `v${versionString}`, versionString, platform: "IOS", state });

describe("which version", () => {
  const versions = [version("1.1", "PREPARE_FOR_SUBMISSION"), version("1.0", "READY_FOR_DISTRIBUTION")];
  test("the one being prepared, else the live one (not for push)", () => {
    expect(chooseVersion(versions, {}).versionString).toBe("1.1");
    expect(chooseVersion([versions[1]!], {}).versionString).toBe("1.0");
    expect(() => chooseVersion([versions[1]!], { editable: true })).toThrow(expect.objectContaining({ code: "no-version" }));
    expect(chooseVersion(versions, { version: "1.0" }).versionString).toBe("1.0");
  });

  test("push refuses a version that can't change", () => {
    expect(() => chooseVersion(versions, { version: "1.0", editable: true })).toThrow(
      expect.objectContaining({ code: "not-editable", hint: "Start the next version with `ship release prepare --version <x.y>`." }),
    );
  });

  test("an unknown --version lists the choices", () => {
    expect(() => chooseVersion(versions, { version: "9" })).toThrow(expect.objectContaining({ code: "no-version", details: { choices: ["1.1", "1.0"] } }));
  });
});

// MARK: App Store Connect

const config = { name: "App", kind: "xcodeproj", path: "App.xcodeproj", scheme: "App", bundleId: "com.example.app", ascAppId: "APP" };

async function project(): Promise<Project> {
  const root = temp();
  writeFileSync(join(root, "ship.json"), JSON.stringify(config));
  return loadProject({ cwd: root });
}

function addFile(p: Project, path: string, bytes: Uint8Array) {
  const file = join(p.storeDir, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, bytes);
}

const versionResource = (state = "PREPARE_FOR_SUBMISSION") =>
  resource("appStoreVersions", "VER", { versionString: "1.1", platform: "IOS", appVersionState: state, createdDate: "2026-10-01T00:00:00Z" });

const shot = (id: string, fileName: string, checksum: string, state = "COMPLETE", extra: Record<string, unknown> = {}) =>
  resource("appScreenshots", id, { fileName, fileSize: 10, sourceFileChecksum: checksum, assetDeliveryState: { state }, ...extra });

interface Remote {
  versionState?: string;
  screenshots?: ReturnType<typeof shot>[];
  /** States the new screenshot reports, one per poll. */
  states?: { state: string; errors?: { code: string; description: string }[] }[];
  uploadStatuses?: number[];
}

/** A fake App Store Connect with one version, en-US, and an APP_IPHONE_67 set; plus the upload host. */
function fakeAsc(remote: Remote = {}) {
  const states = [...(remote.states ?? [{ state: "UPLOAD_COMPLETE" }, { state: "COMPLETE" }])];
  const uploadStatuses = [...(remote.uploadStatuses ?? [])];
  const bodies: { url: string; bytes: Uint8Array; headers: Headers }[] = [];
  const mock = mockAsc((call: AscCall): AscReply | undefined => {
    const route = `${call.method} ${call.url.host === "api.appstoreconnect.apple.com" ? call.path : call.url.href}`;
    if (route === "GET /v1/apps/APP/appStoreVersions") return { json: jsonApi([versionResource(remote.versionState)]) };
    if (route === "GET /v1/appStoreVersions/VER/appStoreVersionLocalizations") return { json: jsonApi([resource("appStoreVersionLocalizations", "LOC", { locale: "en-US" })]) };
    if (route === "GET /v1/appStoreVersionLocalizations/LOC/appScreenshotSets") {
      return { json: jsonApi([resource("appScreenshotSets", "SET", { screenshotDisplayType: "APP_IPHONE_67" })]) };
    }
    if (route === "GET /v1/appStoreVersionLocalizations/LOC/appPreviewSets") return { json: jsonApi([]) };
    if (route === "GET /v1/appScreenshotSets/SET/appScreenshots") return { json: jsonApi(remote.screenshots ?? []) };
    if (route === "POST /v1/appScreenshots") {
      return {
        status: 201,
        json: jsonApi(
          resource("appScreenshots", "NEW", {
            fileName: "x",
            uploadOperations: [
              { method: "PUT", url: "https://upload.example.com/part/1", offset: 0, length: 20, requestHeaders: [{ name: "Content-Type", value: "image/png" }] },
              { method: "PUT", url: "https://upload.example.com/part/2", offset: 20, length: 1000, requestHeaders: [{ name: "Content-Type", value: "image/png" }] },
            ],
          }),
        ),
      };
    }
    if (route.startsWith("PUT https://upload.example.com/")) return { status: uploadStatuses.shift() ?? 200 };
    if (route === "PATCH /v1/appScreenshots/NEW") return { json: jsonApi(shot("NEW", "x", "y", "UPLOAD_COMPLETE")) };
    if (route === "GET /v1/appScreenshots/NEW") return { json: jsonApi(resource("appScreenshots", "NEW", { assetDeliveryState: states.shift() ?? { state: "COMPLETE" } })) };
    if (route === "PATCH /v1/appScreenshotSets/SET/relationships/appScreenshots") return { status: 204 };
    if (call.method === "DELETE" && call.path.startsWith("/v1/appScreenshots/")) return { status: 204 };
    if (route.startsWith("GET https://cdn.example.com/fail/")) return { status: 404, text: "gone" };
    if (route.startsWith("GET https://cdn.example.com/")) return new Response(Buffer.from(png(1290, 2796, { seed: 9 })));
    return undefined;
  });
  // The mock sees no binary bodies; record what was sent to the upload host.
  const mocked = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://upload.example.com/")) {
      bodies.push({ url, bytes: new Uint8Array(await new Response(init?.body).arrayBuffer()), headers: new Headers(init?.headers) });
    }
    return mocked(input, init);
  }) as typeof fetch;
  return { ...mock, bodies };
}

describe("push and pull", () => {
  let mock: ReturnType<typeof fakeAsc> | undefined;
  let delays: ReturnType<typeof noRetryDelay>;
  const sleep = polling.sleep;

  beforeEach(async () => {
    await testCredentials();
    delays = noRetryDelay();
    polling.sleep = async () => {};
  });

  afterEach(() => {
    mock?.restore();
    mock = undefined;
    delays.restore();
    polling.sleep = sleep;
    ui.json = false;
    ui.quiet = false;
  });

  test("no media folders: nothing to do, and nothing asked of App Store Connect", async () => {
    const p = await project();
    mock = fakeAsc();
    expect(await pushMedia(p, { appId: "APP" })).toEqual({ changes: [], applied: false, skipped: [] });
    expect(await diffMedia(p, { appId: "APP" })).toBeUndefined();
    expect(mock.calls).toEqual([]);
  });

  test("uploads through the reservation, in parts, without the API token", async () => {
    const p = await project();
    const image = png(1290, 2796, { seed: 1 });
    addFile(p, P("01-home.png"), image);
    mock = fakeAsc({ screenshots: [shot("OLD", "old.png", "old-sum")] });
    const result = await syncMedia(p, { appId: "APP" });

    const post = mock.calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/v1/appScreenshots");
    expect(post.body).toEqual({
      data: {
        type: "appScreenshots",
        attributes: { fileName: "01-home.png", fileSize: image.length },
        relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: "SET" } } },
      },
    });
    expect(mock.bodies.map((b) => b.url)).toEqual(["https://upload.example.com/part/1", "https://upload.example.com/part/2"]);
    expect(mock.bodies[0]!.bytes).toEqual(image.slice(0, 20));
    expect(mock.bodies[1]!.bytes).toEqual(image.slice(20));
    for (const body of mock.bodies) {
      expect(body.headers.get("authorization")).toBeNull();
      expect(body.headers.get("content-type")).toBe("image/png");
    }
    const commit = mock.calls.find((c) => c.method === "PATCH" && c.path === "/v1/appScreenshots/NEW")!;
    expect(commit.body).toEqual({ data: { type: "appScreenshots", id: "NEW", attributes: { uploaded: true, sourceFileChecksum: md5(image) } } });
    expect(mock.calls.filter((c) => c.path === "/v1/appScreenshots/NEW" && c.method === "GET")).toHaveLength(2);
    expect(mock.calls.find((c) => c.path === "/v1/appScreenshots/NEW" && c.method === "GET")!.query).toEqual({ "fields[appScreenshots]": "assetDeliveryState" });

    // The old one isn't in the repo, so without --prune it stays, after the repo's.
    const reorder = mock.calls.find((c) => c.path.endsWith("/relationships/appScreenshots"))!;
    expect(reorder.body).toEqual({ data: [{ type: "appScreenshots", id: "NEW" }, { type: "appScreenshots", id: "OLD" }] });
    expect(mock.calls.some((c) => c.method === "DELETE")).toBe(false);

    expect(result).toMatchObject({ applied: true, dryRun: false, uploaded: [P("01-home.png")], deleted: [], reordered: ["en-US/APP_IPHONE_67"] });
    expect(result.version).toEqual({ id: "VER", versionString: "1.1", state: "PREPARE_FOR_SUBMISSION" });
    expect(await readLock(p.storeDir)).toEqual({ [P("01-home.png")]: { md5: md5(image), checksum: md5(image) } });
  });

  test("a part that fails with a server error is sent again", async () => {
    const p = await project();
    addFile(p, P("01-home.png"), png(1290, 2796));
    mock = fakeAsc({ uploadStatuses: [503, 200, 200] });
    await syncMedia(p, { appId: "APP", wait: false });
    expect(mock.bodies.map((b) => b.url)).toEqual(["https://upload.example.com/part/1", "https://upload.example.com/part/1", "https://upload.example.com/part/2"]);
    expect(mock.calls.some((c) => c.path === "/v1/appScreenshots/NEW" && c.method === "GET")).toBe(false);
  });

  test("Apple's processing error names the file and what's wrong", async () => {
    const p = await project();
    addFile(p, P("01-home.png"), png(1290, 2796));
    mock = fakeAsc({ states: [{ state: "FAILED", errors: [{ code: "IMAGE_TOOL_FAILURE", description: "The image is too dark." }] }] });
    const error = await syncMedia(p, { appId: "APP" }).catch((e) => e);
    expect(error).toMatchObject({ code: "media-failed", details: { file: "01-home.png", uploaded: [], deleted: [] } });
    expect(error.message).toContain("couldn't process 01-home.png: The image is too dark.");
    // The failed upload is deleted, and the lock doesn't claim it.
    expect(mock.calls.some((c) => c.method === "DELETE" && c.path === "/v1/appScreenshots/NEW")).toBe(true);
    expect(await readLock(p.storeDir)).toEqual({});
  });

  test("a replacement Apple rejects keeps the old upload and its lock entry", async () => {
    const p = await project();
    addFile(p, P("01-home.png"), png(1290, 2796, { seed: 3 }));
    const locked = { [P("01-home.png")]: { md5: "pulled", checksum: "first" } };
    writeFileSync(join(p.storeDir, "media.lock.json"), JSON.stringify(locked));
    mock = fakeAsc({ screenshots: [shot("A", "home.png", "first")], states: [{ state: "FAILED", errors: [{ code: "X", description: "Bad." }] }] });
    await expect(syncMedia(p, { appId: "APP" })).rejects.toMatchObject({ code: "media-failed" });
    expect(mock.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/v1/appScreenshots/NEW"]);
    expect(await readLock(p.storeDir)).toEqual(locked);
  });

  test("a push that stops after a replacement uploads deletes the old upload next time", async () => {
    const p = await project();
    const edited = png(1290, 2796, { seed: 4 });
    const added = png(1290, 2796, { seed: 5 });
    addFile(p, P("01-home.png"), edited);
    addFile(p, P("02-new.png"), added);
    const locked = { [P("01-home.png")]: { md5: "pulled", checksum: "first" } };
    writeFileSync(join(p.storeDir, "media.lock.json"), JSON.stringify(locked));
    // The replacement processes; the new file fails, so the push stops before deleting the old upload.
    mock = fakeAsc({ screenshots: [shot("A", "home.png", "first")], states: [{ state: "COMPLETE" }, { state: "FAILED", errors: [{ code: "X", description: "Bad." }] }] });
    await expect(syncMedia(p, { appId: "APP" })).rejects.toMatchObject({ code: "media-failed" });
    expect(mock.calls.some((c) => c.method === "DELETE" && c.path === "/v1/appScreenshots/A")).toBe(false);
    // The lock still names the old upload, so it isn't orphaned...
    const lock = await readLock(p.storeDir);
    expect(lock).toEqual(locked);
    // ...and the next push matches the replacement by its checksum and deletes the old one.
    const next = planSet({
      ...base,
      lock,
      local: [{ path: P("01-home.png"), md5: md5(edited) }, { path: P("02-new.png"), md5: md5(added) }],
      remote: [shot("A", "home.png", "first"), shot("R", "01-home.png", md5(edited))].map((item) => ({ id: item.id, fileName: String(item.attributes.fileName), checksum: String(item.attributes.sourceFileChecksum) })),
    });
    expect(setJSON(next)).toMatchObject({ upload: [P("02-new.png")], replace: [], delete: ["home.png"], keep: 0 });
  });

  test("files in App Store Connect that aren't in the repo are reported as skipped", async () => {
    const p = await project();
    const image = png(1290, 2796);
    addFile(p, P("01-home.png"), image);
    mock = fakeAsc({ screenshots: [shot("A", "home.png", md5(image)), shot("B", "extra.png", "x")] });
    expect(await pushMedia(p, { appId: "APP", dryRun: true })).toEqual({
      changes: [],
      applied: false,
      skipped: [{ scope: "en-US/screenshots/APP_IPHONE_67", field: "extra.png", reason: "not in the repo; --prune deletes it" }],
    });
  });

  test("a replaced file deletes its old upload; --prune deletes the rest", async () => {
    const p = await project();
    const edited = png(1290, 2796, { seed: 2 });
    addFile(p, P("01-home.png"), edited);
    writeFileSync(join(p.storeDir, "media.lock.json"), JSON.stringify({ [P("01-home.png")]: { md5: "pulled", checksum: "first" } }));
    mock = fakeAsc({ screenshots: [shot("A", "home.png", "first"), shot("B", "extra.png", "extra"), shot("C", "broken.png", "c", "FAILED")] });
    const result = await syncMedia(p, { appId: "APP", prune: true, wait: false });
    expect(result.sets).toEqual([{ locale: "en-US", type: "APP_IPHONE_67", kind: "screenshots", upload: [], replace: [P("01-home.png")], delete: ["home.png", "broken.png", "extra.png"], keep: 0, reorder: false }]);
    expect(mock.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/v1/appScreenshots/A", "/v1/appScreenshots/C", "/v1/appScreenshots/B"]);
    expect(result.deleted).toEqual(["home.png", "broken.png", "extra.png"]);
    expect(await readLock(p.storeDir)).toEqual({ [P("01-home.png")]: { md5: md5(edited), checksum: md5(edited) } });
  });

  test("--dry-run only reads", async () => {
    const p = await project();
    addFile(p, P("01-home.png"), png(1290, 2796));
    mock = fakeAsc();
    const result = await syncMedia(p, { appId: "APP", dryRun: true });
    expect(result).toMatchObject({ applied: false, dryRun: true, uploaded: [] });
    expect(result.changes).toEqual([{ scope: "en-US/screenshots/APP_IPHONE_67", field: "01-home.png", kind: "add", to: md5(png(1290, 2796)) }]);
    expect(mock.calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("push refuses a version that isn't being prepared", async () => {
    const p = await project();
    addFile(p, P("01-home.png"), png(1290, 2796));
    mock = fakeAsc({ versionState: "READY_FOR_DISTRIBUTION" });
    await expect(syncMedia(p, { appId: "APP" })).rejects.toMatchObject({ code: "no-version", hint: "Start the next version with `ship release prepare --version <x.y>`." });
    await expect(syncMedia(p, { appId: "APP", version: "1.1" })).rejects.toMatchObject({ code: "not-editable" });
  });

  test("push stops on files validate rejects, before asking App Store Connect", async () => {
    const p = await project();
    addFile(p, P("01-home.png"), png(100, 100));
    mock = fakeAsc();
    await expect(syncMedia(p, { appId: "APP" })).rejects.toMatchObject({ code: "invalid-media", hint: "See them all with `ship screenshots validate`." });
    expect(mock.calls).toEqual([]);
  });

  test("pull downloads at full size, and the next diff sees no change", async () => {
    const p = await project();
    const remote = [shot("A", "Home Screen.png", "orig", "COMPLETE", { imageAsset: { templateUrl: "https://cdn.example.com/a/{w}x{h}bb.{f}", width: 1290, height: 2796 } })];
    mock = fakeAsc({ screenshots: remote });
    const pulled = await pullMedia(p, { appId: "APP" });
    expect(pulled).toMatchObject({ written: [P("01-Home-Screen.png")], unchanged: [], skipped: [] });
    expect(mock.calls.find((c) => c.url.host === "cdn.example.com")!.url.href).toBe("https://cdn.example.com/a/1290x2796bb.png");
    expect(mock.calls.find((c) => c.url.host === "cdn.example.com")!.headers.get("authorization")).toBeNull();
    const bytes = new Uint8Array(readFileSync(join(p.storeDir, P("01-Home-Screen.png"))));
    expect(await readLock(p.storeDir)).toEqual({ [P("01-Home-Screen.png")]: { md5: md5(bytes), checksum: "orig" } });

    const diff = await diffMedia(p, { appId: "APP" });
    expect(diff).toMatchObject({ changes: [], hasChanges: false });
    const again = await pullMedia(p, { appId: "APP" });
    expect(again).toMatchObject({ written: [], unchanged: [P("01-Home-Screen.png")] });
  });

  test("a failed download still records what was pulled", async () => {
    const p = await project();
    const image = (url: string) => ({ imageAsset: { templateUrl: url, width: 1290, height: 2796 } });
    mock = fakeAsc({
      screenshots: [shot("A", "a.png", "sum-a", "COMPLETE", image("https://cdn.example.com/{w}x{h}.{f}")), shot("B", "b.png", "sum-b", "COMPLETE", image("https://cdn.example.com/fail/{w}.{f}"))],
    });
    await expect(pullMedia(p, { appId: "APP" })).rejects.toMatchObject({ code: "download-failed" });
    expect(Object.keys(await readLock(p.storeDir))).toEqual([P("01-a.png")]);
  });

  test("pull leaves a different local file alone without --force", async () => {
    const p = await project();
    addFile(p, P("01-home.png"), png(1290, 2796, { seed: 5 }));
    mock = fakeAsc({ screenshots: [shot("A", "home.png", "orig", "COMPLETE", { imageAsset: { templateUrl: "https://cdn.example.com/{w}x{h}.{f}", width: 1290, height: 2796 } })] });
    const pulled = await pullMedia(p, { appId: "APP" });
    expect(pulled.skipped).toEqual([{ path: P("01-home.png"), reason: "a different file is there; pass --force to overwrite it" }]);
    expect((await pullMedia(p, { appId: "APP", force: true })).written).toEqual([P("01-home.png")]);
  });
});

describe("the command", () => {
  const run = (args: string[], flags: Record<string, unknown> = {}) => commands[0]!.run({ args, flags: flags as never, implicit: false });

  test("an unknown action names the choices", async () => {
    await expect(run(["upload"])).rejects.toMatchObject({ code: "usage", exitCode: 2, details: { choices: ["pull", "diff", "push", "validate"] } });
    await expect(run([])).rejects.toMatchObject({ code: "usage", exitCode: 2 });
  });

  test("a bad --type or --locale is a usage error", async () => {
    await expect(run(["push"], { type: ["IPHONE_99"] })).rejects.toMatchObject({ code: "usage", exitCode: 2 });
    await expect(run(["push"], { locale: ["english"] })).rejects.toMatchObject({ code: "usage", exitCode: 2 });
  });

  test("an argument in a flag's place is a usage error naming the flag", async () => {
    await expect(run(["push", "en-US"], { "dry-run": true })).rejects.toMatchObject({ code: "usage", exitCode: 2, hint: "Pass it as --locale en-US" });
    await expect(run(["diff", "APP_IPHONE_67"])).rejects.toMatchObject({ code: "usage", hint: "Pass it as --type APP_IPHONE_67" });
  });

  test("validate without a store folder is no-store, not a pass", async () => {
    const p = await project();
    const cwd = process.cwd();
    process.chdir(p.root);
    try {
      await expect(run(["validate"])).rejects.toMatchObject({ code: "no-store", hint: "Start it with `ship screenshots pull`." });
    } finally {
      process.chdir(cwd);
    }
  });

  test("validate's JSON", async () => {
    const p = await project();
    addFile(p, P("01.png"), png(1, 1));
    const cwd = process.cwd();
    process.chdir(p.root);
    try {
      ui.json = true;
      const out = await captureLog(() => run(["validate"]));
      const json = JSON.parse(out);
      expect(json).toMatchObject({ ok: true, valid: false, problems: [{ file: P("01.png"), severity: "error" }] });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = 0;
      process.chdir(cwd);
      ui.json = false;
    }
  });
});
