import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../src/config";
import { bytes, chars, isEmail, isHttpUrl, passwordProblem } from "../src/store/check";
import { ASC_LOCALES, LOCALE_PATTERN, localeDirs, readStoreApp, readText, writeStoreApp, writeText } from "../src/store/files";
import { temp } from "./helpers";

const config = { name: "App", kind: "xcodeproj", path: "App.xcodeproj", scheme: "App", bundleId: "com.example.app" };

async function project(extra: Record<string, unknown> = {}) {
  const root = temp();
  writeFileSync(join(root, "ship.json"), JSON.stringify({ ...config, ...extra }));
  return loadProject({ cwd: root });
}

describe("ship.json", () => {
  test("an old ship.json still works, with iOS and appstore/ as defaults", async () => {
    const p = await project();
    expect(p.platform).toBe("ios");
    expect(p.storeDir).toBe(join(p.root, "appstore"));
    expect(p.config.beta).toBeUndefined();
  });

  test("platform, store, and beta are read", async () => {
    const p = await project({ platform: "macos", store: "metadata/store", beta: { notesFromGit: true } });
    expect(p.platform).toBe("macos");
    expect(p.storeDir).toBe(join(p.root, "metadata/store"));
    expect(p.config.beta?.notesFromGit).toBe(true);
  });

  test("an unknown platform is an error naming the choices", async () => {
    await expect(project({ platform: "watchos" })).rejects.toMatchObject({ code: "bad-config", details: { choices: ["ios", "macos", "tvos", "visionos"] } });
  });
});

describe("text files", () => {
  test("read normalized, written with one trailing newline", async () => {
    const dir = temp();
    const file = join(dir, "en-US", "description.txt");
    expect(await readText(file)).toBeUndefined();
    await writeText(file, "Line one\r\nLine two\n\n\n");
    expect(await Bun.file(file).text()).toBe("Line one\nLine two\n");
    expect(await readText(file)).toBe("Line one\nLine two");
    writeFileSync(file, "a  \r\n\r\n");
    expect(await readText(file)).toBe("a");
    await writeText(file, "");
    expect(await Bun.file(file).text()).toBe("");
    expect(await readText(file)).toBe("");
  });

  test("locale folders", () => {
    const dir = temp();
    for (const name of ["en-US", "zh-Hans", "ca", "pt-BR", "testflight", "screenshots", ".git", "english", "en_US"]) mkdirSync(join(dir, name));
    writeFileSync(join(dir, "de-DE"), "a file, not a folder");
    expect(localeDirs(dir)).toEqual(["ca", "en-US", "pt-BR", "zh-Hans"]);
    expect(localeDirs(join(dir, "missing"))).toEqual([]);
    for (const locale of ASC_LOCALES) expect(LOCALE_PATTERN.test(locale)).toBe(true);
  });
});

describe("app.json", () => {
  test("round-trips in a stable key order", async () => {
    const p = await project();
    expect(await readStoreApp(p)).toBeUndefined();
    await writeStoreApp(p, {
      release: { phased: true, type: "AFTER_APPROVAL" },
      review: { demoAccountPassword: "keychain:ship/demo", contactEmail: "a@example.com", contactFirstName: "Ty" },
      ageRating: { violenceRealistic: "NONE", gambling: false },
      copyright: "2026 Me",
      categories: { secondary: "SPORTS", primary: "HEALTH_AND_FITNESS" },
    });
    const text = await Bun.file(join(p.storeDir, "app.json")).text();
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(["categories", "copyright", "ageRating", "review", "release"]);
    expect(Object.keys(JSON.parse(text).categories)).toEqual(["primary", "secondary"]);
    expect(Object.keys(JSON.parse(text).ageRating)).toEqual(["gambling", "violenceRealistic"]);
    expect(Object.keys(JSON.parse(text).review)).toEqual(["contactFirstName", "contactEmail", "demoAccountPassword"]);
    expect(text).toContain('\n  "copyright": "2026 Me",\n');
    expect((await readStoreApp(p))?.release).toEqual({ type: "AFTER_APPROVAL", phased: true });
  });

  test("bad JSON names the file", async () => {
    const p = await project();
    mkdirSync(p.storeDir);
    writeFileSync(join(p.storeDir, "app.json"), '{ "copyright": "x" ');
    await expect(readStoreApp(p)).rejects.toMatchObject({ code: "bad-store-file", details: { file: join(p.storeDir, "app.json") } });
    writeFileSync(join(p.storeDir, "app.json"), "[]");
    await expect(readStoreApp(p)).rejects.toMatchObject({ code: "bad-store-file" });
  });
});

describe("checks", () => {
  test("count characters as Apple does, and bytes", () => {
    expect(chars("héllo 👋")).toBe(7);
    expect(bytes("héllo 👋")).toBe(11);
  });

  test("URLs and emails", () => {
    expect(isHttpUrl("https://example.com/privacy")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
    for (const bad of ["example.com", "ftp://example.com", "https://", "https://exa mple.com", "javascript:alert(1)"]) expect(isHttpUrl(bad)).toBe(false);
    expect(isEmail("a@example.com")).toBe(true);
    for (const bad of ["a@b", "a example@x.com", "@x.com", "a@@x.com"]) expect(isEmail(bad)).toBe(false);
  });

  test("passwords must be references", () => {
    expect(passwordProblem("app.json", "review.demoAccountPassword", "hunter2")).toMatchObject({ severity: "error" });
    expect(passwordProblem("app.json", "review.demoAccountPassword", "keychain:ship/demo")).toBeUndefined();
    expect(passwordProblem("app.json", "review.demoAccountPassword", null)).toBeUndefined();
  });
});
