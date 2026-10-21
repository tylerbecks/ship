import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppStoreVersion } from "../src/asc/versions";
import { metadata, parseLocales } from "../src/commands/metadata";
import { loadProject } from "../src/config";
import { MASK, changesJSON, renderChanges } from "../src/diff";
import { readText, writeText } from "../src/store/files";
import {
  LOCALE_FIELDS,
  checkAppJson,
  checkKeywords,
  checkLocale,
  keywordList,
  keywordsFromApi,
  keywordsToApi,
  suggest,
  validateSnapshot,
} from "../src/store/limits";
import {
  type LocalMetadata,
  type RemoteMetadata,
  checkCategories,
  isFirstVersion,
  localeAttributes,
  localeFiles,
  pickTargets,
  planMetadata,
  planPull,
  pullMetadata,
  pushMetadata,
  readSnapshot,
} from "../src/store/metadata";
import { ui } from "../src/ui";
import { type AscCall, type AscReply, captureLog, fakeKeychain, jsonApi, mockAsc, resource, temp, testCredentials } from "./helpers";

// MARK: Fixtures

const version = (id: string, versionString: string, state: string, extra: Partial<AppStoreVersion> = {}): AppStoreVersion => ({
  id,
  versionString,
  platform: "IOS",
  state,
  releaseType: "AFTER_APPROVAL",
  copyright: "2026 Tyler Becks",
  ...extra,
});

/** A remote page with a version being prepared (2.0) and a live one (1.0). */
function remote(overrides: Partial<RemoteMetadata> = {}): RemoteMetadata {
  return {
    app: { id: "app1", name: "Lift", primaryLocale: "en-US", contentRights: "DOES_NOT_USE_THIRD_PARTY_CONTENT" },
    version: version("v2", "2.0", "PREPARE_FOR_SUBMISSION"),
    firstVersion: false,
    appInfo: { id: "info2", state: "PREPARE_FOR_SUBMISSION" },
    categories: { primary: "HEALTH_AND_FITNESS", primarySubcategories: [], secondary: "SPORTS", secondarySubcategories: [] },
    ageRating: { id: "age2", attributes: { violenceCartoonOrFantasy: "NONE", gambling: false, kidsAgeBand: null, ageRatingOverride: "NONE", someFutureQuestion: true } },
    appInfoLocalizations: [
      { id: "il-en", locale: "en-US", attributes: { locale: "en-US", name: "Lift", subtitle: "Track every set", privacyPolicyUrl: "https://lift.example.com/privacy", privacyChoicesUrl: null } },
      { id: "il-de", locale: "de-DE", attributes: { locale: "de-DE", name: "Lift", subtitle: "Jeder Satz zählt", privacyPolicyUrl: null, privacyChoicesUrl: null } },
    ],
    versionLocalizations: [
      {
        id: "vl-en",
        locale: "en-US",
        attributes: {
          locale: "en-US",
          description: "Lift tracks your workouts.\n\nFast and private.",
          keywords: "gym, workout,fitness",
          promotionalText: "New: rest timers",
          whatsNew: "Bug fixes",
          supportUrl: "https://lift.example.com",
          marketingUrl: null,
        },
      },
      { id: "vl-de", locale: "de-DE", attributes: { locale: "de-DE", description: "Lift zählt deine Sätze.", keywords: "fitness", promotionalText: null, whatsNew: null, supportUrl: "https://lift.example.com", marketingUrl: null } },
    ],
    review: {
      id: "rd2",
      attributes: {
        contactFirstName: "Tyler",
        contactLastName: "Becks",
        contactEmail: "tyler@example.com",
        contactPhone: "+1 555 0100",
        demoAccountRequired: true,
        demoAccountName: "review@example.com",
        demoAccountPassword: "s3cret-pass",
        notes: "Sign in with the demo account.",
      },
    },
    phased: false,
    ...overrides,
  };
}

/** LocalMetadata from what planPull would write. */
function localFromPull(pull: ReturnType<typeof planPull>, extra: Partial<LocalMetadata> = {}): LocalMetadata {
  const locales: Record<string, Record<string, string>> = {};
  let reviewNotes: string | undefined;
  for (const [path, text] of Object.entries(pull.files)) {
    if (path === "review-notes.txt") reviewNotes = text;
    else {
      const [locale, file] = path.split("/") as [string, string];
      (locales[locale] ??= {})[file] = text;
    }
  }
  return { app: structuredClone(pull.app), reviewNotes, locales, ...extra };
}

const fields = (plan: { all: { scope: string; field: string }[] }) => plan.all.map((change) => `${change.scope} ${change.field}`);

// MARK: Layout

describe("the field table", () => {
  test("every file maps to one field and target, with no duplicates", () => {
    expect(new Set(LOCALE_FIELDS.map((entry) => entry.file)).size).toBe(LOCALE_FIELDS.length);
    expect(LOCALE_FIELDS.filter((entry) => entry.target === "appInfo").map((entry) => entry.field)).toEqual(["name", "subtitle", "privacyPolicyUrl", "privacyChoicesUrl"]);
    expect(LOCALE_FIELDS.filter((entry) => entry.target === "version").map((entry) => entry.field)).toEqual([
      "description",
      "keywords",
      "promotionalText",
      "whatsNew",
      "supportUrl",
      "marketingUrl",
    ]);
  });

  test("keywords: one per line in the file, commas in App Store Connect", () => {
    expect(keywordsToApi("gym\n workout \n\nfitness")).toBe("gym,workout,fitness");
    expect(keywordsFromApi("gym, workout,fitness,")).toBe("gym\nworkout\nfitness");
    expect(keywordList("a,b\nc")).toEqual(["a", "b", "c"]);
    expect(keywordsToApi(keywordsFromApi("a , b"))).toBe("a,b");
  });

  test("attributes and files convert both ways", () => {
    const files = localeFiles({ locale: "en-US", description: "Hi\r\n", keywords: "a, b", whatsNew: "", promotionalText: null }, "version");
    expect(files).toEqual({ "description.txt": "Hi", "keywords.txt": "a\nb" });
    expect(localeAttributes({ ...files, "name.txt": "Lift", "whats-new.txt": "" }, "version")).toEqual({ description: "Hi", keywords: "a,b", whatsNew: "" });
    expect(localeAttributes({ "name.txt": "Lift", "description.txt": "x" }, "appInfo")).toEqual({ name: "Lift" });
  });

  test("remote → files → local → no changes", () => {
    const page = remote();
    const pull = planPull(page, undefined);
    expect(pull.files["en-US/keywords.txt"]).toBe("gym\nworkout\nfitness");
    expect(pull.files["en-US/name.txt"]).toBe("Lift");
    expect(pull.files["review-notes.txt"]).toBe("Sign in with the demo account.");
    expect(pull.clear).toContain("en-US/marketing-url.txt");
    expect(pull.app.categories).toEqual({ primary: "HEALTH_AND_FITNESS", secondary: "SPORTS" });
    expect(pull.app.ageRating).toEqual({ gambling: false, violenceCartoonOrFantasy: "NONE" });
    expect(pull.app.release).toEqual({ type: "AFTER_APPROVAL", phased: false });
    // The password never goes in the repo.
    expect(pull.app.review?.demoAccountPassword).toBeUndefined();
    expect(JSON.stringify(pull)).not.toContain("s3cret-pass");
    expect(pull.warnings[0]).toContain("ship secret set keychain:ship/lift-demo-password --stdin");
    const plan = planMetadata(localFromPull(pull), page);
    expect(plan.all).toEqual([]);
    expect(plan.ops).toEqual([]);
  });

  test("pull keeps an existing password reference and unknown keys", () => {
    const pull = planPull(remote(), { review: { demoAccountPassword: "keychain:ship/demo" }, release: { type: "MANUAL", phased: true } });
    expect(pull.app.review?.demoAccountPassword).toBe("keychain:ship/demo");
    expect(pull.warnings).toEqual([]);
    expect(pull.app.release).toEqual({ type: "AFTER_APPROVAL", phased: false });
  });

  test("pull --locale writes only that language", () => {
    const pull = planPull(remote(), undefined, { locales: ["de-DE"] });
    expect(pull.locales).toEqual(["de-DE"]);
    expect(Object.keys(pull.files).filter((path) => path.includes("/")).every((path) => path.startsWith("de-DE/"))).toBe(true);
  });
});

// MARK: Validation

describe("validate", () => {
  const errors = (problems: { severity: string; message: string }[]) => problems.filter((item) => item.severity === "error").map((item) => item.message);

  test("name, subtitle, promotional text, description, What's New limits", () => {
    expect(errors(checkLocale("en-US", { "name.txt": "L" }))).toEqual(["The name needs at least 2 characters"]);
    expect(errors(checkLocale("en-US", { "name.txt": "" }))).toEqual(["The app's name can't be empty"]);
    expect(errors(checkLocale("en-US", { "name.txt": "x".repeat(30), "subtitle.txt": "y".repeat(30) }))).toEqual([]);
    expect(errors(checkLocale("en-US", { "name.txt": "x".repeat(31) }))).toEqual(["31 characters; the limit is 30"]);
    expect(errors(checkLocale("en-US", { "subtitle.txt": "y".repeat(31) }))).toEqual(["31 characters; the limit is 30"]);
    // Characters are code points: 30 emoji fit.
    expect(errors(checkLocale("en-US", { "subtitle.txt": "👋".repeat(30) }))).toEqual([]);
    expect(errors(checkLocale("en-US", { "promotional-text.txt": "p".repeat(171), "description.txt": "d" }))).toEqual(["171 characters; the limit is 170"]);
    expect(errors(checkLocale("en-US", { "description.txt": "d".repeat(4001) }))).toEqual(["4001 characters; the limit is 4000"]);
    expect(errors(checkLocale("en-US", { "whats-new.txt": "w".repeat(4001), "description.txt": "d" }))).toEqual(["4001 characters; the limit is 4000"]);
    expect(errors(validateSnapshot({ reviewNotes: "n".repeat(4001), locales: [] }))).toEqual(["4001 characters; the limit is 4000"]);
  });

  test("keywords count bytes, so multi-byte letters fill them sooner", () => {
    const ascii = Array.from({ length: 20 }, (_, i) => `kw${String(i).padStart(2, "0")}`).join("\n"); // 20 × 4 + 19 commas = 99 bytes
    expect(errors(checkKeywords("en-US/keywords.txt", ascii))).toEqual([]);
    expect(errors(checkKeywords("en-US/keywords.txt", `${ascii}\nab`))[0]).toContain("102 bytes");
    // 34 characters of "é" are 68 bytes; 50 are 100; 51 are too many.
    expect(errors(checkKeywords("ja/keywords.txt", "é".repeat(50)))).toEqual([]);
    expect(errors(checkKeywords("ja/keywords.txt", "é".repeat(51)))[0]).toContain("102 bytes");
    expect(errors(checkKeywords("ja/keywords.txt", "日本".repeat(17)))[0]).toContain("102 bytes");
  });

  test("keywords warn on repeats, empty lines, commas, and the app's name", () => {
    const problems = checkKeywords("en-US/keywords.txt", "gym\n\nGym\nlift,run", "Lift");
    expect(problems.map((item) => item.severity)).toEqual(["warning", "warning", "warning", "warning"]);
    expect(problems.map((item) => item.message).join(" ")).toContain("Repeated: Gym");
    expect(problems.map((item) => item.message).join(" ")).toContain("app's name");
  });

  test("URLs, unknown files, unknown languages, and a missing description", () => {
    const problems = checkLocale("en-UK", { "support-url.txt": "lift.example.com", "privacy-policy-url.txt": "https://lift.example.com/privacy" }, ["descripton.txt"]);
    expect(errors(problems)).toEqual(['"lift.example.com" isn\'t an http(s) URL']);
    const warnings = problems.filter((item) => item.severity === "warning").map((item) => item.message);
    expect(warnings[0]).toContain("en-UK");
    expect(warnings[1]).toContain("did you mean description.txt?");
    expect(warnings[2]).toContain("No description");
    expect(suggest("whatsnew.txt", LOCALE_FIELDS.map((entry) => entry.file))).toBe("whats-new.txt");
  });

  test("app.json: keys, enums, email, and the demo account", () => {
    expect(checkAppJson("{")[0]!.message).toContain("Not valid JSON");
    expect(checkAppJson("[]")[0]!.message).toContain("JSON object");
    const problems = checkAppJson(
      JSON.stringify({
        categories: { primary: "HEALTH_AND_FITNESS", primarySubcategories: ["A", "B", "C"], secondry: "SPORTS" },
        contentRights: "MAYBE",
        ageRating: { violenceRealistic: "SOMETIMES", gambling: "no", contests: "INFREQUENT", kidsAgeBand: "TEENS", madeUp: true },
        review: { contactEmail: "not-an-email", demoAccountRequired: true, demoAccountName: "", demoAccountPassword: "hunter2" },
        release: { type: "WHENEVER" },
      }),
    );
    const byField = Object.fromEntries(problems.map((item) => [item.field, item]));
    expect(byField["categories.secondry"]?.message).toContain('did you mean "secondary"');
    expect(byField["categories.primarySubcategories"]?.message).toContain("at most 2");
    expect(byField.contentRights?.message).toContain("DOES_NOT_USE_THIRD_PARTY_CONTENT, USES_THIRD_PARTY_CONTENT");
    expect(byField["ageRating.violenceRealistic"]?.message).toContain("NONE, INFREQUENT_OR_MILD, FREQUENT_OR_INTENSE");
    expect(byField["ageRating.gambling"]?.message).toContain("true or false");
    expect(byField["ageRating.contests"]?.severity).toBe("warning");
    expect(byField["ageRating.kidsAgeBand"]?.message).toContain("FIVE_AND_UNDER");
    expect(byField["ageRating.madeUp"]?.severity).toBe("error");
    expect(byField["review.contactEmail"]?.severity).toBe("error");
    expect(byField["review.demoAccountName"]?.severity).toBe("error");
    expect(byField["release.type"]?.message).toContain("MANUAL, AFTER_APPROVAL, SCHEDULED");
  });

  test("a plaintext password is refused; references are fine", () => {
    const plain = checkAppJson(JSON.stringify({ review: { demoAccountPassword: "hunter2" } }));
    expect(plain).toHaveLength(1);
    expect(plain[0]).toMatchObject({ severity: "error", field: "review.demoAccountPassword", code: "plaintext-secret" });
    expect(plain[0]!.message).not.toContain("hunter2");
    for (const reference of ["keychain:ship/demo", "op://Private/Lift/password", "env:DEMO_PASSWORD", "file:~/demo.txt"]) {
      expect(checkAppJson(JSON.stringify({ review: { demoAccountRequired: true, demoAccountName: "a@example.com", demoAccountPassword: reference } }))).toEqual([]);
    }
    // A Keychain service without an account could resolve to ship's own API key.
    expect(checkAppJson(JSON.stringify({ review: { demoAccountPassword: "keychain:ship" } }))).toMatchObject([
      { severity: "error", field: "review.demoAccountPassword", message: expect.stringContaining("needs an account") },
    ]);
    // Leaving the password out keeps App Store Connect's: a warning, not an error.
    expect(checkAppJson(JSON.stringify({ review: { demoAccountRequired: true, demoAccountName: "a" } }))[0]?.severity).toBe("warning");
    expect(checkAppJson(JSON.stringify({ review: { demoAccountRequired: true, demoAccountName: "a", demoAccountPassword: null } }))[0]?.severity).toBe("error");
  });

  test("reads the store folder, ignoring screenshots and dotfiles", async () => {
    const dir = temp();
    await writeText(join(dir, "en-US", "name.txt"), "Lift");
    await writeText(join(dir, "en-US", ".DS_Store"), "x");
    await writeText(join(dir, "en-US", "notes.md"), "x");
    mkdirSync(join(dir, "en-US", "screenshots", "APP_IPHONE_67"), { recursive: true });
    mkdirSync(join(dir, "testflight", "en-US"), { recursive: true });
    await writeText(join(dir, "review-notes.txt"), "Hi");
    await writeText(join(dir, "app.jsn"), "{}");
    const snapshot = await readSnapshot(dir);
    expect(snapshot.locales).toEqual([{ locale: "en-US", files: { "name.txt": "Lift" }, unknown: ["notes.md"] }]);
    expect(snapshot.unknown).toEqual(["app.jsn"]);
    expect(snapshot.reviewNotes).toBe("Hi");
    expect(validateSnapshot(snapshot).find((item) => item.file === "app.jsn")?.message).toContain("did you mean app.json?");
  });
});

// MARK: Planning

describe("planning a push", () => {
  test("only changed fields, as attributes", () => {
    const page = remote();
    const local = localFromPull(planPull(page, undefined));
    local.locales["en-US"]!["description.txt"] = "Lift tracks your workouts.\n\nFast, private, free.";
    local.locales["en-US"]!["keywords.txt"] = "gym\nworkout\nstrength";
    local.locales["de-DE"]!["subtitle.txt"] = "";
    local.app!.copyright = "2027 Tyler Becks";
    const plan = planMetadata(local, page);
    expect(fields(plan)).toEqual(["de-DE subtitle", "app copyright", "en-US description", "en-US keywords"]);
    expect(plan.ops.map((op) => `${op.method} ${op.path}`)).toEqual([
      "PATCH /v1/appInfoLocalizations/il-de",
      "PATCH /v1/appStoreVersions/v2",
      "PATCH /v1/appStoreVersionLocalizations/vl-en",
    ]);
    expect(plan.ops[0]!.body).toEqual({ data: { type: "appInfoLocalizations", id: "il-de", attributes: { subtitle: null } } });
    expect(plan.ops[2]!.body).toEqual({
      data: { type: "appStoreVersionLocalizations", id: "vl-en", attributes: { description: "Lift tracks your workouts.\n\nFast, private, free.", keywords: "gym,workout,strength" } },
    });
  });

  test("a missing file is left alone", () => {
    const page = remote();
    const plan = planMetadata({ locales: { "en-US": { "promotional-text.txt": "New: rest timers" } } }, page);
    expect(plan.all).toEqual([]);
  });

  test("the app, categories, and age rating", () => {
    const local: LocalMetadata = {
      app: {
        contentRights: "USES_THIRD_PARTY_CONTENT",
        categories: { primary: "GAMES", primarySubcategories: ["GAMES_PUZZLE"], secondary: null },
        ageRating: { violenceCartoonOrFantasy: "INFREQUENT_OR_MILD", gambling: false, lootBox: true },
      },
      locales: {},
    };
    const plan = planMetadata(local, remote());
    expect(plan.ops.map((op) => op.body)).toEqual([
      { data: { type: "apps", id: "app1", attributes: { contentRightsDeclaration: "USES_THIRD_PARTY_CONTENT" } } },
      {
        data: {
          type: "appInfos",
          id: "info2",
          relationships: {
            primaryCategory: { data: { type: "appCategories", id: "GAMES" } },
            secondaryCategory: { data: null },
            primarySubcategoryOne: { data: { type: "appCategories", id: "GAMES_PUZZLE" } },
            primarySubcategoryTwo: { data: null },
          },
        },
      },
      { data: { type: "ageRatingDeclarations", id: "age2", attributes: { violenceCartoonOrFantasy: "INFREQUENT_OR_MILD", lootBox: true } } },
    ]);
    expect(plan.categories).toEqual({ primary: "GAMES", primarySubcategories: ["GAMES_PUZZLE"], secondary: null, secondarySubcategories: [] });
  });

  test("categories are checked against Apple's list", () => {
    const known = new Map([
      ["GAMES", ["GAMES_PUZZLE", "GAMES_ACTION"]],
      ["SPORTS", []],
    ]);
    expect(() => checkCategories({ primary: "GAMES", primarySubcategories: ["GAMES_PUZZLE"], secondary: "SPORTS", secondarySubcategories: [] }, known)).not.toThrow();
    expect(() => checkCategories({ primary: "GAME", primarySubcategories: [], secondary: null, secondarySubcategories: [] }, known)).toThrow(
      expect.objectContaining({ code: "bad-category", details: expect.objectContaining({ choices: ["GAMES", "SPORTS"] }) }),
    );
    expect(() => checkCategories({ primary: "GAMES", primarySubcategories: ["GAMES_CARD"], secondary: null, secondarySubcategories: [] }, known)).toThrow(
      expect.objectContaining({ code: "bad-category", details: expect.objectContaining({ choices: ["GAMES_PUZZLE", "GAMES_ACTION"] }) }),
    );
  });

  test("a live version: only promotional text and content rights can change", () => {
    const page = remote({ version: version("v1", "1.0", "READY_FOR_DISTRIBUTION"), appInfo: { id: "info1", state: "READY_FOR_DISTRIBUTION" } });
    const local = localFromPull(planPull(page, undefined));
    local.locales["en-US"]!["promotional-text.txt"] = "Spring sale";
    local.locales["en-US"]!["description.txt"] = "New description";
    local.locales["en-US"]!["name.txt"] = "Lift Pro";
    local.app!.contentRights = "USES_THIRD_PARTY_CONTENT";
    const plan = planMetadata(local, page);
    expect(plan.blocked.map((item) => `${item.scope} ${item.field}`)).toEqual(["en-US name", "en-US description"]);
    expect(plan.blocked[0]!.reason).toContain("while a new version is being prepared");
    expect(plan.blocked[1]!.reason).toContain("version 1.0 is ready for distribution");
    expect(plan.ops.map((op) => op.body)).toEqual([
      { data: { type: "apps", id: "app1", attributes: { contentRightsDeclaration: "USES_THIRD_PARTY_CONTENT" } } },
      { data: { type: "appStoreVersionLocalizations", id: "vl-en", attributes: { promotionalText: "Spring sale" } } },
    ]);
  });

  test("What's New is skipped on an app's first version", () => {
    const page = remote({ firstVersion: true });
    const local = localFromPull(planPull(page, undefined));
    local.locales["en-US"]!["whats-new.txt"] = "Everything is new";
    local.locales["fr-FR"] = { "name.txt": "Lift", "description.txt": "Bonjour", "whats-new.txt": "Tout" };
    const plan = planMetadata(local, page);
    expect(plan.skipped.map((item) => `${item.scope} ${item.field}`)).toEqual(["en-US whatsNew", "fr-FR whatsNew"]);
    expect(plan.blocked).toEqual([]);
    const created = plan.ops.find((op) => op.path === "/v1/appStoreVersionLocalizations");
    expect((created!.body as { data: { attributes: object } }).data.attributes).toEqual({ locale: "fr-FR", description: "Bonjour" });
    expect(isFirstVersion([version("v1", "1.0", "PREPARE_FOR_SUBMISSION")], version("v1", "1.0", "PREPARE_FOR_SUBMISSION"))).toBe(true);
    expect(isFirstVersion([version("v2", "2.0", "PREPARE_FOR_SUBMISSION"), version("v1", "1.0", "READY_FOR_DISTRIBUTION")], version("v2", "2.0", "PREPARE_FOR_SUBMISSION"))).toBe(false);
  });

  test("a new language creates both halves; without a name it's an error", () => {
    const page = remote();
    const local = localFromPull(planPull(page, undefined));
    local.locales["fr-FR"] = { "name.txt": "Lift", "subtitle.txt": "", "description.txt": "Bonjour", "keywords.txt": "sport\ngym" };
    const plan = planMetadata(local, page);
    expect(plan.created.locales).toEqual(["fr-FR"]);
    expect(plan.ops.map((op) => [op.method, op.path, op.body])).toEqual([
      ["POST", "/v1/appInfoLocalizations", { data: { type: "appInfoLocalizations", attributes: { locale: "fr-FR", name: "Lift" }, relationships: { appInfo: { data: { type: "appInfos", id: "info2" } } } } }],
      [
        "POST",
        "/v1/appStoreVersionLocalizations",
        {
          data: {
            type: "appStoreVersionLocalizations",
            attributes: { locale: "fr-FR", description: "Bonjour", keywords: "sport,gym" },
            relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "v2" } } },
          },
        },
      ],
    ]);
    local.locales["fr-FR"] = { "description.txt": "Bonjour" };
    expect(() => planMetadata(local, page)).toThrow(expect.objectContaining({ code: "missing-name" }));
    // A folder with only screenshots isn't a language for metadata.
    local.locales["fr-FR"] = {};
    expect(planMetadata(local, page).ops).toEqual([]);
  });

  test("--prune deletes languages without a folder, never the primary one", () => {
    const page = remote();
    const local = localFromPull(planPull(page, undefined));
    delete local.locales["de-DE"];
    expect(planMetadata(local, page).ops).toEqual([]);
    const plan = planMetadata(local, page, { prune: true });
    expect(plan.deleted.locales).toEqual(["de-DE"]);
    expect(plan.ops.map((op) => `${op.method} ${op.path}`)).toEqual(["DELETE /v1/appInfoLocalizations/il-de", "DELETE /v1/appStoreVersionLocalizations/vl-de"]);
    const withoutPrimary = localFromPull(planPull(page, undefined));
    delete withoutPrimary.locales["en-US"];
    expect(() => planMetadata(withoutPrimary, page, { prune: true })).toThrow(expect.objectContaining({ code: "primary-locale" }));
    // --locale limits pruning too.
    expect(planMetadata(withoutPrimary, page, { prune: true, locales: ["de-DE"] }).ops).toEqual([]);
  });

  test("a scheduled release is left to ship release", () => {
    const local: LocalMetadata = { app: { release: { type: "SCHEDULED" } }, locales: {} };
    const plan = planMetadata(local, remote());
    expect(plan.ops).toEqual([]);
    expect(plan.skipped[0]).toMatchObject({ field: "release.type" });
    expect(plan.skipped[0]!.reason).toContain("ship release submit --release <date>");
    expect(planMetadata({ app: { release: { type: "MANUAL", phased: true } }, locales: {} }, remote()).ops[0]!.body).toEqual({
      data: { type: "appStoreVersions", id: "v2", attributes: { releaseType: "MANUAL" } },
    });
  });

  test("the demo password is compared but never shown", () => {
    const page = remote();
    const local: LocalMetadata = { app: { review: { demoAccountPassword: "keychain:ship/demo" } }, locales: {} };
    expect(planMetadata(local, page, { password: { value: "s3cret-pass" } }).ops).toEqual([]);
    const plan = planMetadata(local, page, { password: { value: "n3w-pass" } });
    expect(plan.all).toEqual([{ scope: "review", field: "demoAccountPassword", kind: "change", from: MASK, to: MASK, secret: true }]);
    expect(plan.ops[0]!.body).toEqual({ data: { type: "appStoreReviewDetails", id: "rd2", attributes: { demoAccountPassword: "n3w-pass" } } });
    expect(renderChanges(plan.all)).not.toContain("pass");
    expect(JSON.stringify(changesJSON(plan.all))).not.toContain("pass\"");
    // Not compared when it couldn't be read.
    expect(planMetadata(local, page, { password: { error: "No Keychain item" } }).notes[0]).toContain("No Keychain item");
  });

  test("a password App Store Connect doesn't return is sent with other review changes", () => {
    const attributes = { ...remote().review!.attributes };
    delete attributes.demoAccountPassword;
    const page = remote({ review: { id: "rd2", attributes } });
    const local: LocalMetadata = { app: { review: { demoAccountPassword: "keychain:ship/demo" } }, locales: {} };
    const quiet = planMetadata(local, page, { password: { value: "s3cret" } });
    expect(quiet.ops).toEqual([]);
    expect(quiet.notes[0]).toContain("can't be compared");
    const plan = planMetadata({ ...local, reviewNotes: "New notes" }, page, { password: { value: "s3cret" } });
    expect(plan.ops[0]!.body).toEqual({ data: { type: "appStoreReviewDetails", id: "rd2", attributes: { notes: "New notes", demoAccountPassword: "s3cret" } } });
  });

  test("review details are created when there are none", () => {
    const local: LocalMetadata = { app: { review: { contactEmail: "a@example.com", demoAccountRequired: false } }, reviewNotes: "Hi", locales: {} };
    const plan = planMetadata(local, remote({ review: undefined }));
    expect(plan.ops[0]).toMatchObject({
      method: "POST",
      path: "/v1/appStoreReviewDetails",
      body: {
        data: {
          type: "appStoreReviewDetails",
          attributes: { contactEmail: "a@example.com", demoAccountRequired: false, notes: "Hi" },
          relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "v2" } } },
        },
      },
    });
  });

  test("which version and App Info", () => {
    const versions = [version("v2", "2.0", "PREPARE_FOR_SUBMISSION"), version("v1", "1.0", "READY_FOR_DISTRIBUTION")];
    const infos = [
      { id: "info1", state: "READY_FOR_DISTRIBUTION" },
      { id: "info2", state: "PREPARE_FOR_SUBMISSION" },
    ];
    expect(pickTargets(versions, infos)).toEqual({ version: versions[0], appInfo: infos[1] });
    expect(pickTargets(versions, infos, "1.0")).toEqual({ version: versions[1], appInfo: infos[0] });
    expect(pickTargets([versions[1]!], [infos[0]!])).toEqual({ version: versions[1], appInfo: infos[0] });
    expect(() => pickTargets(versions, infos, "3.0")).toThrow(expect.objectContaining({ code: "no-version", details: { choices: ["2.0", "1.0"] } }));
  });
});

// MARK: Against a mocked App Store Connect

/** A small App Store Connect that serves `page`; writes succeed without changing it. */
function asc(page: RemoteMetadata, options: { versions?: AppStoreVersion[]; infos?: { id: string; state: string }[] } = {}) {
  const versions = options.versions ?? [page.version!, version("v1", "1.0", "READY_FOR_DISTRIBUTION")];
  const infos = options.infos ?? [page.appInfo!, { id: "info1", state: "READY_FOR_DISTRIBUTION" }];
  const link = (id?: string | null) => ({ data: id ? { type: "appCategories", id } : null });
  return (call: AscCall): AscReply | undefined => {
    const { method, path } = call;
    if (method !== "GET") return method === "DELETE" ? { status: 204 } : { json: jsonApi(resource("x", "new")) };
    if (path === "/v1/apps/app1") return { json: jsonApi(resource("apps", "app1", { name: page.app.name, primaryLocale: page.app.primaryLocale, contentRightsDeclaration: page.app.contentRights })) };
    if (path === "/v1/apps/app1/appStoreVersions") {
      return {
        json: jsonApi(
          versions.map((v) =>
            resource("appStoreVersions", v.id, { versionString: v.versionString, platform: "IOS", appVersionState: v.state, copyright: v.copyright, releaseType: v.releaseType }),
          ),
        ),
      };
    }
    if (path === "/v1/apps/app1/appInfos") return { json: jsonApi(infos.map((info) => resource("appInfos", info.id, { state: info.state }))) };
    const info = path.match(/^\/v1\/appInfos\/([^/]+)(\/.*)?$/);
    if (info) {
      if (!info[2]) {
        const c = page.categories!;
        return {
          json: jsonApi(
            resource("appInfos", info[1]!, {}, {
              primaryCategory: link(c.primary),
              primarySubcategoryOne: link(c.primarySubcategories[0]),
              primarySubcategoryTwo: link(c.primarySubcategories[1]),
              secondaryCategory: link(c.secondary),
              secondarySubcategoryOne: link(c.secondarySubcategories[0]),
              secondarySubcategoryTwo: link(c.secondarySubcategories[1]),
            }),
          ),
        };
      }
      if (info[2] === "/ageRatingDeclaration") return { json: jsonApi(resource("ageRatingDeclarations", page.ageRating!.id, page.ageRating!.attributes)) };
      if (info[2] === "/appInfoLocalizations") return { json: jsonApi(page.appInfoLocalizations.map((loc) => resource("appInfoLocalizations", loc.id, loc.attributes))) };
    }
    const v = path.match(/^\/v1\/appStoreVersions\/([^/]+)\/(.+)$/);
    if (v) {
      if (v[2] === "appStoreVersionLocalizations") {
        return { json: jsonApi(v[1] === page.version?.id ? page.versionLocalizations.map((loc) => resource("appStoreVersionLocalizations", loc.id, loc.attributes)) : []) };
      }
      if (v[2] === "appStoreReviewDetail") return page.review && v[1] === page.version?.id ? { json: jsonApi(resource("appStoreReviewDetails", page.review.id, page.review.attributes)) } : { json: { data: null } };
      if (v[2] === "appStoreVersionPhasedRelease") return { json: { data: null } };
    }
    if (path === "/v1/appCategories") {
      return {
        json: jsonApi([
          resource("appCategories", "HEALTH_AND_FITNESS", {}, { subcategories: { data: [] } }),
          resource("appCategories", "SPORTS", {}, { subcategories: { data: [] } }),
          resource("appCategories", "GAMES", {}, { subcategories: { data: [{ type: "appCategories", id: "GAMES_PUZZLE" }] } }),
        ]),
      };
    }
    return undefined;
  };
}

const serve = (...args: Parameters<typeof asc>) => mockAsc(asc(...args));

async function project() {
  const root = temp();
  writeFileSync(join(root, "ship.json"), JSON.stringify({ name: "Lift", kind: "xcodeproj", path: "Lift.xcodeproj", scheme: "Lift", bundleId: "com.example.lift", ascAppId: "app1" }));
  return loadProject({ cwd: root });
}

const writes = (calls: AscCall[]) => calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`);

describe("pull and push", () => {
  let mock: ReturnType<typeof mockAsc> | undefined;
  let keychain: ReturnType<typeof fakeKeychain> | undefined;
  const cwd = process.cwd();
  beforeEach(async () => {
    await testCredentials();
    keychain = fakeKeychain({ "ship/demo": "s3cret-pass" });
    ui.quiet = true;
  });
  afterEach(() => {
    mock?.restore();
    keychain?.restore();
    process.chdir(cwd);
    ui.json = false;
    ui.quiet = false;
  });

  test("pull writes the folder, refuses to overwrite local edits, and a second pull is a no-op", async () => {
    const p = await project();
    mock = serve(remote());
    const first = await pullMetadata(p, { appId: "app1" });
    expect(first.version).toEqual({ id: "v2", versionString: "2.0", state: "PREPARE_FOR_SUBMISSION" });
    expect(first.written).toContain("en-US/description.txt");
    expect(first.written).toContain("app.json");
    expect(await readText(join(p.storeDir, "en-US", "keywords.txt"))).toBe("gym\nworkout\nfitness");
    expect(await Bun.file(join(p.storeDir, "app.json")).text()).not.toContain("s3cret-pass");
    expect(first.warnings).toHaveLength(1);

    const second = await pullMetadata(p, { appId: "app1" });
    expect(second.written).toEqual([]);
    expect(second.unchanged).toEqual(first.written);

    await writeText(join(p.storeDir, "en-US", "description.txt"), "Edited here");
    await expect(pullMetadata(p, { appId: "app1" })).rejects.toMatchObject({ code: "local-changes", details: { files: ["en-US/description.txt"] } });
    expect(await readText(join(p.storeDir, "en-US", "description.txt"))).toBe("Edited here");
    const forced = await pullMetadata(p, { appId: "app1", force: true });
    expect(forced.written).toEqual(["en-US/description.txt"]);

    // A field App Store Connect has empty empties a file that has text, but never creates one.
    await writeText(join(p.storeDir, "en-US", "marketing-url.txt"), "https://old.example.com");
    expect((await pullMetadata(p, { appId: "app1", force: true })).written).toEqual(["en-US/marketing-url.txt"]);
    expect(await readText(join(p.storeDir, "en-US", "marketing-url.txt"))).toBe("");
    expect(await readText(join(p.storeDir, "de-DE", "marketing-url.txt"))).toBeUndefined();
  });

  test("push sends only what changed, and dry-run sends nothing", async () => {
    const p = await project();
    const page = remote();
    mock = serve(page);
    await pullMetadata(p, { appId: "app1" });
    await writeText(join(p.storeDir, "en-US", "whats-new.txt"), "Rest timers");
    await writeText(join(p.storeDir, "fr-FR", "name.txt"), "Lift");
    await writeText(join(p.storeDir, "fr-FR", "description.txt"), "Bonjour");

    const dry = await pushMetadata(p, { appId: "app1", dryRun: true });
    expect(dry.applied).toBe(false);
    expect(writes(mock.calls)).toEqual([]);
    expect(dry.changes.map((change) => `${change.scope} ${change.field}`)).toEqual(["fr-FR name", "en-US whatsNew", "fr-FR description"]);

    const result = await pushMetadata(p, { appId: "app1" });
    expect(result.applied).toBe(true);
    expect(result.created.locales).toEqual(["fr-FR"]);
    expect(writes(mock.calls)).toEqual(["POST /v1/appInfoLocalizations", "PATCH /v1/appStoreVersionLocalizations/vl-en", "POST /v1/appStoreVersionLocalizations"]);
    const patch = mock.calls.find((call) => call.method === "PATCH")!;
    expect(patch.body).toEqual({ data: { type: "appStoreVersionLocalizations", id: "vl-en", attributes: { whatsNew: "Rest timers" } } });
  });

  test("push refuses what can't change now; --partial pushes the rest", async () => {
    const p = await project();
    const live = remote({ version: version("v1", "1.0", "READY_FOR_DISTRIBUTION"), appInfo: { id: "info1", state: "READY_FOR_DISTRIBUTION" } });
    mock = serve(live, { versions: [live.version!], infos: [live.appInfo!] });
    await pullMetadata(p, { appId: "app1" });
    await writeText(join(p.storeDir, "en-US", "promotional-text.txt"), "Spring sale");
    await writeText(join(p.storeDir, "en-US", "description.txt"), "New description");

    const error = await pushMetadata(p, { appId: "app1" }).catch((e) => e);
    expect(error).toMatchObject({ code: "not-editable", details: { blocked: [{ scope: "en-US", field: "description" }] } });
    expect(error.hint).toContain("ship release prepare --version <x.y>");
    expect(error.hint).toContain("--partial");
    expect(writes(mock.calls)).toEqual([]);

    const result = await pushMetadata(p, { appId: "app1", partial: true });
    expect(writes(mock.calls)).toEqual(["PATCH /v1/appStoreVersionLocalizations/vl-en"]);
    expect(mock.calls.at(-1)!.body).toEqual({ data: { type: "appStoreVersionLocalizations", id: "vl-en", attributes: { promotionalText: "Spring sale" } } });
    expect(result.skipped).toEqual([{ scope: "en-US", field: "description", reason: expect.stringContaining("version 1.0") }]);
  });

  test("push refuses a store folder with errors, and unknown categories", async () => {
    const p = await project();
    mock = serve(remote());
    await pullMetadata(p, { appId: "app1" });
    await writeText(join(p.storeDir, "en-US", "subtitle.txt"), "x".repeat(31));
    await expect(pushMetadata(p, { appId: "app1" })).rejects.toMatchObject({ code: "invalid-metadata" });
    await writeText(join(p.storeDir, "en-US", "subtitle.txt"), "Track every set");
    const app = JSON.parse(await Bun.file(join(p.storeDir, "app.json")).text());
    app.categories.primary = "HEALTH";
    await Bun.write(join(p.storeDir, "app.json"), JSON.stringify(app));
    await expect(pushMetadata(p, { appId: "app1" })).rejects.toMatchObject({ code: "bad-category" });
    app.categories.primary = "SPORTS";
    app.review.demoAccountPassword = "hunter2";
    await Bun.write(join(p.storeDir, "app.json"), JSON.stringify(app));
    const plaintext = await pushMetadata(p, { appId: "app1" }).catch((e) => e);
    expect(plaintext).toMatchObject({ code: "plaintext-secret", hint: expect.stringContaining("ship secret set") });
    expect(JSON.stringify(plaintext.details)).not.toContain("hunter2");
    expect(writes(mock.calls)).toEqual([]);
  });

  test("a failure partway says what was already applied", async () => {
    const p = await project();
    const page = remote();
    const handler = asc(page);
    mock = mockAsc((call) =>
      call.method === "PATCH" && call.path.startsWith("/v1/appStoreVersionLocalizations")
        ? { status: 409, json: { errors: [{ status: "409", code: "STATE_ERROR", title: "Nope" }] } }
        : handler(call),
    );
    await pullMetadata(p, { appId: "app1" });
    await writeText(join(p.storeDir, "en-US", "subtitle.txt"), "Every set, every day");
    await writeText(join(p.storeDir, "en-US", "description.txt"), "Changed");
    const error = await pushMetadata(p, { appId: "app1" }).catch((e) => e);
    expect(error.code).toBe("api-409");
    expect(error.details.applied).toEqual([{ scope: "en-US", field: "subtitle", kind: "change", from: "Track every set", to: "Every set, every day" }]);
  });

  test("the password reaches Apple but never the output", async () => {
    const p = await project();
    const page = remote();
    mock = serve(page);
    await pullMetadata(p, { appId: "app1" });
    const app = JSON.parse(await Bun.file(join(p.storeDir, "app.json")).text());
    app.review.demoAccountPassword = "keychain:ship/demo";
    await Bun.write(join(p.storeDir, "app.json"), JSON.stringify(app));
    keychain!.items.set("ship/demo", "n3w-pass-123");

    process.chdir(p.root);
    ui.quiet = false;
    const stderr: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
    try {
      ui.json = true;
      const diff = JSON.parse(await captureLog(() => metadata("diff", { locales: [], force: false, dryRun: false, partial: false, prune: false, exitCode: false })));
      expect(diff.changes).toEqual([{ scope: "review", field: "demoAccountPassword", kind: "change", from: MASK, to: MASK, secret: true }]);
      expect(diff.hasChanges).toBe(true);
      const json = await captureLog(() => metadata("push", { locales: [], force: false, dryRun: false, partial: false, prune: false, exitCode: false }));
      ui.json = false;
      const human = await captureLog(() => metadata("diff", { locales: [], force: false, dryRun: false, partial: false, prune: false, exitCode: false }));
      for (const text of [JSON.stringify(diff), json, human, stderr.join("\n")]) {
        expect(text).not.toContain("n3w-pass-123");
        expect(text).not.toContain("s3cret-pass");
      }
      expect(JSON.parse(json)).toMatchObject({ ok: true, applied: true, changes: [{ field: "demoAccountPassword", to: MASK }] });
    } finally {
      console.error = error;
    }
    const patch = mock.calls.find((call) => call.method === "PATCH")!;
    expect(patch.body).toEqual({ data: { type: "appStoreReviewDetails", id: "rd2", attributes: { demoAccountPassword: "n3w-pass-123" } } });
  });

  test("validate and usage errors", async () => {
    const p = await project();
    process.chdir(p.root);
    const opts = { locales: [], force: false, dryRun: false, partial: false, prune: false, exitCode: false };
    await expect(metadata("validate", opts)).rejects.toMatchObject({ code: "no-store", hint: expect.stringContaining("ship metadata pull") });
    await expect(metadata("publish", opts)).rejects.toMatchObject({ code: "usage", exitCode: 2, details: { choices: ["pull", "diff", "push", "validate"] } });
    expect(() => parseLocales(["en_US"])).toThrow(expect.objectContaining({ code: "usage", exitCode: 2 }));
    await writeText(join(p.storeDir, "en-US", "name.txt"), "L");
    ui.json = true;
    const out = JSON.parse(await captureLog(async () => expect(await metadata("validate", opts)).toEqual({ failed: true })));
    expect(out).toMatchObject({ ok: true, valid: false, problems: [{ file: "en-US/name.txt", field: "name", severity: "error" }] });
  });
});
