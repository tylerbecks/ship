// The App Store page as files: reads the store folder (app.json,
// review-notes.txt, and each locale folder's text files), reads the same
// things from App Store Connect, and works out what pull writes and what
// push sends. Planning is pure, so it's tested without App Store Connect;
// fetchRemote and applyPlan are the only parts that talk to it.
//
// Apple only takes most changes while a version is being prepared, so every
// change is checked against what's editable now: promotional text and
// content rights any time, App Info fields (name, subtitle, privacy URLs,
// categories, age rating) on the App Info being prepared, and the rest on
// an editable version.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { api } from "../asc/client";
import {
  APP_INFO_LOCALIZATIONS,
  type AgeRating,
  type AppRecord,
  type Categories,
  type Localization,
  REVIEW_DETAILS,
  type ReviewDetail,
  VERSION_LOCALIZATIONS,
  ageRating,
  ageRatingBody,
  ageRatingPath,
  appBody,
  appCategories,
  appInfoCategories,
  appInfoLocalizationBody,
  appInfoLocalizations,
  appInfoPath,
  appPath,
  appRecord,
  categoriesBody,
  localizationPath,
  newAppInfoLocalization,
  newReviewDetail,
  newVersionLocalization,
  reviewDetail,
  reviewDetailBody,
  reviewDetailPath,
  versionBody,
  versionLocalizationBody,
  versionLocalizations,
  versionPath,
} from "../asc/metadata";
import { phasedRelease } from "../asc/release";
import {
  type AppInfo,
  type AppStoreVersion,
  EDITABLE_APP_INFO_STATES,
  LIVE_VERSION_STATES,
  appInfos,
  appStoreVersions,
  editableAppInfo,
  isEditableVersion,
  liveAppInfo,
  pickVersion,
} from "../asc/versions";
import type { Project } from "../config";
import { loadSettings } from "../config";
import { type Change, MASK, changesJSON, diffRecord } from "../diff";
import { type AscPlatform, platformInfo } from "../platform";
import { isSecretReference, resolveSecret } from "../secrets";
import { ShipError, ui } from "../ui";
import type { Problem } from "./check";
import { type PushResult, type StoreApp, localeDirs, orderStoreApp, readText, writeStoreApp, writeText } from "./files";
import {
  AGE_RATING_DEPRECATED,
  AGE_RATING_KEYS,
  LOCALE_FIELDS,
  type LocaleTarget,
  PLAINTEXT_SECRET,
  REVIEW_NOTES_FILE,
  STORE_FILES,
  type StoreSnapshot,
  fieldForFile,
  keywordsFromApi,
  keywordsToApi,
  validateSnapshot,
} from "./limits";

export type { PushResult };

/** A field push left alone, and why. */
export interface Skip {
  scope: string;
  field: string;
  reason: string;
}

// MARK: Reading the store folder

/** What the store folder says the page should be. */
export interface LocalMetadata {
  /** app.json, when there is one. */
  app?: StoreApp;
  /** review-notes.txt, when there is one. */
  reviewNotes?: string;
  /** Each locale folder's metadata files, by file name ("description.txt" → text). */
  locales: Record<string, Record<string, string>>;
}

const inScope = (locale: string, locales?: string[]) => !locales?.length || locales.includes(locale);

/** Reads the store folder as validate sees it: raw app.json text, review notes, and each locale's files. */
export async function readSnapshot(storeDir: string, locales?: string[]): Promise<StoreSnapshot> {
  const snapshot: StoreSnapshot = { locales: [], unknown: [] };
  if (!existsSync(storeDir)) return snapshot;
  snapshot.appJson = await readText(join(storeDir, "app.json"));
  snapshot.reviewNotes = await readText(join(storeDir, REVIEW_NOTES_FILE));
  for (const entry of readdirSync(storeDir, { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.startsWith(".") && !STORE_FILES.includes(entry.name)) snapshot.unknown!.push(entry.name);
  }
  snapshot.unknown!.sort();
  for (const locale of localeDirs(storeDir).filter((name) => inScope(name, locales))) {
    const files: Record<string, string> = {};
    const unknown: string[] = [];
    // Folders (screenshots/, previews/) and dotfiles belong to others.
    for (const entry of readdirSync(join(storeDir, locale), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      if (fieldForFile(entry.name)) files[entry.name] = (await readText(join(storeDir, locale, entry.name))) ?? "";
      else unknown.push(entry.name);
    }
    snapshot.locales.push({ locale, files, unknown });
  }
  return snapshot;
}

/** The parsed store folder. Bad app.json is an error naming the file (validate reports it as a problem instead). */
export function localFromSnapshot(snapshot: StoreSnapshot, storeDir: string): LocalMetadata {
  let app: StoreApp | undefined;
  if (snapshot.appJson !== undefined) {
    const path = join(storeDir, "app.json");
    try {
      app = snapshot.appJson.trim() ? JSON.parse(snapshot.appJson) : {};
    } catch (error) {
      throw new ShipError(`${path} isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`, "bad-store-file", `Fix it (\`ship metadata validate\` points at the problem), or delete it and pull again.`, { file: path });
    }
    if (typeof app !== "object" || app === null || Array.isArray(app)) {
      throw new ShipError(`${path} should hold a JSON object`, "bad-store-file", "Start it with { and end it with }, or delete it and pull again.", { file: path });
    }
  }
  return { app, reviewNotes: snapshot.reviewNotes, locales: Object.fromEntries(snapshot.locales.map(({ locale, files }) => [locale, files])) };
}

/** Every problem in the store folder (validate's list). */
export async function validateStore(storeDir: string): Promise<Problem[]> {
  return validateSnapshot(await readSnapshot(storeDir));
}

// MARK: Reading App Store Connect

/** The page as App Store Connect has it. */
export interface RemoteMetadata {
  app: AppRecord;
  /** The version being read or changed: --version, else the one being prepared, else the live one. */
  version?: AppStoreVersion;
  /** No version has ever been on the App Store (What's New doesn't apply yet). */
  firstVersion: boolean;
  appInfo?: AppInfo;
  categories?: Categories;
  ageRating?: AgeRating;
  appInfoLocalizations: Localization[];
  versionLocalizations: Localization[];
  review?: ReviewDetail;
  /** Whether the version has a phased release (read for pull only). */
  phased?: boolean;
}

/** Version states that mean the app has been on the App Store. */
const RELEASED_STATES = ["READY_FOR_DISTRIBUTION", "PROCESSING_FOR_DISTRIBUTION", "REPLACED_WITH_NEW_VERSION", "REMOVED_FROM_SALE", "DEVELOPER_REMOVED_FROM_SALE"];

/** Whether `version` is the app's first: no other version was ever released. */
export function isFirstVersion(versions: AppStoreVersion[], version?: AppStoreVersion): boolean {
  return !versions.some((other) => other.id !== version?.id && RELEASED_STATES.includes(other.state));
}

/**
 * The version and App Info to read or change. The version is --version, else
 * the one being prepared, else the live one. The App Info follows it: the
 * one being prepared for an editable version, else the live one.
 */
export function pickTargets(versions: AppStoreVersion[], infos: AppInfo[], versionString?: string): { version?: AppStoreVersion; appInfo?: AppInfo } {
  let version: AppStoreVersion | undefined;
  if (versionString) {
    version = pickVersion(versions, versionString);
    if (!version) {
      const choices = versions.map((v) => v.versionString);
      throw new ShipError(
        `There's no App Store version ${versionString}`,
        "no-version",
        choices.length ? `Pick one: --version ${choices.join(" | ")}` : "Start one with `ship release prepare --version <x.y>`.",
        { choices },
        2,
      );
    }
  } else {
    version = pickVersion(versions) ?? versions.find((v) => LIVE_VERSION_STATES.includes(v.state)) ?? versions[0];
  }
  const editing = !version || isEditableVersion(version);
  const appInfo = editing ? (editableAppInfo(infos) ?? liveAppInfo(infos) ?? infos[0]) : (liveAppInfo(infos) ?? infos[0]);
  return { version, appInfo };
}

/** Reads the page from App Store Connect: the app, its App Info, and one version. */
export async function fetchRemote(appId: string, platform: AscPlatform, options: { version?: string; phased?: boolean } = {}): Promise<RemoteMetadata> {
  const [app, versions, infos] = await Promise.all([appRecord(appId), appStoreVersions(appId, platform), appInfos(appId)]);
  const { version, appInfo } = pickTargets(versions, infos, options.version);
  const [categories, rating, infoLocalizations, localizations, review, phased] = await Promise.all([
    appInfo ? appInfoCategories(appInfo.id) : undefined,
    appInfo ? ageRating(appInfo.id) : undefined,
    appInfo ? appInfoLocalizations(appInfo.id) : [],
    version ? versionLocalizations(version.id) : [],
    version ? reviewDetail(version.id) : undefined,
    version && options.phased ? phasedRelease(version.id).then(Boolean) : undefined,
  ]);
  return {
    app,
    version,
    firstVersion: isFirstVersion(versions, version),
    appInfo,
    categories,
    ageRating: rating,
    appInfoLocalizations: infoLocalizations,
    versionLocalizations: localizations,
    review,
    phased,
  };
}

// MARK: Field mapping

/** A locale folder's files for one target, as App Store Connect attributes (keywords joined with commas). */
export function localeAttributes(files: Record<string, string>, target: LocaleTarget): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const entry of LOCALE_FIELDS) {
    const text = files[entry.file];
    if (entry.target !== target || text === undefined) continue;
    attributes[entry.field] = entry.field === "keywords" ? keywordsToApi(text) : text;
  }
  return attributes;
}

/** A localization's attributes as files (keywords one per line). Empty fields are left out. */
export function localeFiles(attributes: Record<string, unknown>, target: LocaleTarget): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of LOCALE_FIELDS) {
    const value = attributes[entry.field];
    if (entry.target !== target || typeof value !== "string") continue;
    const text = entry.field === "keywords" ? keywordsFromApi(value) : value.replace(/\r\n?/g, "\n").trimEnd();
    if (text) files[entry.file] = text;
  }
  return files;
}

/** Remote attributes in the form local ones take, so equal pages compare equal ("a, b" keywords are "a,b"). */
const comparable = (attributes: Record<string, unknown> = {}) =>
  typeof attributes.keywords === "string" ? { ...attributes, keywords: keywordsToApi(attributes.keywords) } : attributes;

/** "" and null clear a field: App Store Connect wants null. */
const sendable = (value: unknown) => (value === "" || value === undefined ? null : value);

/** Only the set values, for creating something. */
const present = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null && value !== ""));

/** app.json's categories in one flat record, so a diff names each part. Empty lists are null. */
function flatCategories(categories: Partial<Categories> | undefined): Record<string, unknown> {
  if (!categories) return {};
  const list = (value: string[] | undefined | null) => (value === undefined ? undefined : value?.length ? value : null);
  return {
    "categories.primary": categories.primary,
    "categories.primarySubcategories": list(categories.primarySubcategories),
    "categories.secondary": categories.secondary,
    "categories.secondarySubcategories": list(categories.secondarySubcategories),
  };
}

// MARK: Planning

/** One request push makes. */
export interface Op {
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  /** What it changes (secrets masked). */
  changes: Change[];
  /** For progress lines, like "en-US (App Info)". */
  label: string;
}

export interface Plan {
  /** Every difference that push would make if everything were editable (secrets masked). */
  all: Change[];
  /** The requests push sends, in order. */
  ops: Op[];
  /** Changes Apple won't take in the current state (push refuses, or skips them with --partial). */
  blocked: Skip[];
  /** Changes push never makes here, and why (What's New on a first version, a scheduled release). */
  skipped: Skip[];
  /** Things worth saying that aren't changes. */
  notes: string[];
  created: { locales: string[] };
  deleted: { locales: string[] };
  /** The categories after push, to check with Apple first; undefined when they don't change. */
  categories?: Categories;
}

export interface PlanOptions {
  /** Only these languages. */
  locales?: string[];
  /** Delete languages that have no folder. */
  prune?: boolean;
  /** The demo account password app.json's reference points at, or why it couldn't be read. */
  password?: { value?: string; error?: string };
}

type Need = "always" | "appInfo" | "version";

const VERSION_STATE_REASON = (version: AppStoreVersion) =>
  `version ${version.versionString} is ${version.state.toLowerCase().replaceAll("_", " ")}; this changes while a version is being prepared`;

/** Masks a secret change's values, so nothing downstream can print them. */
function maskSecrets(changes: Change[]): Change[] {
  return changes.map((change) =>
    change.secret
      ? { ...change, ...(change.from !== undefined ? { from: change.from === null ? null : MASK } : {}), ...(change.to !== undefined ? { to: change.to === null ? null : MASK } : {}) }
      : change,
  );
}

/** The attributes a set of changes sends, read from `desired` (renamed with `rename` where app.json's names differ). */
function attributesFor(changes: Change[], desired: Record<string, unknown>, rename: Record<string, string> = {}): Record<string, unknown> {
  return Object.fromEntries(changes.map((change) => [rename[change.field] ?? change.field, sendable(desired[change.field])]));
}

/**
 * What push would do to make App Store Connect match the store folder.
 * Pure: `remote` is what fetchRemote read. Throws for a language that can't
 * be created (no name.txt) and for pruning the primary language.
 */
export function planMetadata(local: LocalMetadata, remote: RemoteMetadata, options: PlanOptions = {}): Plan {
  const plan: Plan = { all: [], ops: [], blocked: [], skipped: [], notes: [], created: { locales: [] }, deleted: { locales: [] } };
  const app = local.app ?? {};
  const { version, appInfo } = remote;
  const reasons: Record<Need, string | undefined> = {
    always: undefined,
    appInfo: !appInfo
      ? "App Store Connect has no App Info for this app"
      : EDITABLE_APP_INFO_STATES.includes(appInfo.state)
        ? undefined
        : "App Info (name, subtitle, privacy URLs, categories, age rating) changes only while a new version is being prepared",
    version: !version ? "there's no App Store version to change" : isEditableVersion(version) ? undefined : VERSION_STATE_REASON(version),
  };

  /** Records changes, and returns the ones that can be made now. */
  const gate = (changes: Change[], need: (change: Change) => Need): Change[] => {
    const masked = maskSecrets(changes);
    plan.all.push(...masked);
    return masked.filter((change) => {
      const reason = reasons[need(change)];
      if (reason) plan.blocked.push({ scope: change.scope, field: change.field, reason });
      return !reason;
    });
  };
  const skip = (changes: Change[], reason: string) => {
    for (const change of changes) plan.skipped.push({ scope: change.scope, field: change.field, reason });
  };

  // The app: content rights, any time.
  if (app.contentRights !== undefined) {
    const desired = { contentRights: app.contentRights };
    const allowed = gate(diffRecord("app", { contentRights: remote.app.contentRights }, desired), () => "always");
    if (allowed.length) {
      plan.ops.push({ method: "PATCH", path: appPath(remote.app.id), body: appBody(remote.app.id, attributesFor(allowed, desired, { contentRights: "contentRightsDeclaration" })), changes: allowed, label: "app" });
    }
  }

  // Categories, on the App Info.
  if (app.categories) {
    const desired = flatCategories(app.categories);
    const allowed = gate(diffRecord("app", flatCategories(remote.categories), desired), () => "appInfo");
    if (allowed.length && appInfo) {
      const changed = (key: keyof Categories) => allowed.some((change) => change.field === `categories.${key}`);
      const parts: Partial<Categories> = {};
      if (changed("primary")) parts.primary = app.categories.primary ?? null;
      if (changed("primarySubcategories")) parts.primarySubcategories = app.categories.primarySubcategories ?? [];
      if (changed("secondary")) parts.secondary = app.categories.secondary ?? null;
      if (changed("secondarySubcategories")) parts.secondarySubcategories = app.categories.secondarySubcategories ?? [];
      const current = remote.categories ?? { primary: null, primarySubcategories: [], secondary: null, secondarySubcategories: [] };
      plan.categories = { ...current, ...parts };
      plan.ops.push({ method: "PATCH", path: appInfoPath(appInfo.id), body: categoriesBody(appInfo.id, parts), changes: allowed, label: "categories" });
    }
  }

  // Age rating, on the App Info.
  if (app.ageRating) {
    const changes = diffRecord("ageRating", remote.ageRating?.attributes, app.ageRating);
    if (changes.length && !remote.ageRating && appInfo) {
      skip(changes, "App Store Connect has no age rating declaration for this App Info yet; set one in App Store Connect first");
    } else {
      const allowed = gate(changes, () => "appInfo");
      if (allowed.length && remote.ageRating) {
        const id = remote.ageRating.id;
        plan.ops.push({ method: "PATCH", path: ageRatingPath(id), body: ageRatingBody(id, attributesFor(allowed, app.ageRating)), changes: allowed, label: "age rating" });
      }
    }
  }

  const primary = remote.app.primaryLocale;
  const localLocales = Object.keys(local.locales).filter((locale) => inScope(locale, options.locales));
  const hasTarget = (files: Record<string, string>, target: LocaleTarget) => LOCALE_FIELDS.some((entry) => entry.target === target && files[entry.file] !== undefined);
  const hasAny = (files: Record<string, string>) => hasTarget(files, "appInfo") || hasTarget(files, "version");
  const refusePrimary = (locale: string) =>
    new ShipError(
      `${locale} is the app's primary language, which App Store Connect can't delete`,
      "primary-locale",
      `Keep a ${locale}/ folder (pull it with \`ship metadata pull --locale ${locale}\`), or push without --prune.`,
      { locale },
    );

  // App Info languages: name, subtitle, privacy URLs.
  const infoByLocale = new Map(remote.appInfoLocalizations.map((loc) => [loc.locale, loc]));
  const infoLocales = [...new Set([...localLocales, ...[...infoByLocale.keys()].filter((locale) => inScope(locale, options.locales))])].sort();
  for (const locale of infoLocales) {
    const files = local.locales[locale];
    const existing = infoByLocale.get(locale);
    if (files && existing) {
      const desired = localeAttributes(files, "appInfo");
      const allowed = gate(diffRecord(locale, existing.attributes, desired), () => "appInfo");
      if (allowed.length) {
        const path = localizationPath(APP_INFO_LOCALIZATIONS, existing.id);
        plan.ops.push({ method: "PATCH", path, body: appInfoLocalizationBody(existing.id, attributesFor(allowed, desired)), changes: allowed, label: `${locale} (App Info)` });
      }
    } else if (files && hasAny(files) && appInfo) {
      // A new language needs its App Info half (with the name) too.
      const desired = localeAttributes(files, "appInfo");
      const allowed = gate(diffRecord(locale, undefined, desired), () => "appInfo");
      if (!reasons.appInfo) {
        if (!desired.name) {
          throw new ShipError(
            `${locale} is a new language, and App Store Connect needs the app's name in it`,
            "missing-name",
            `Write the name to ${locale}/name.txt (2 to 30 characters), then push again.`,
            { locale },
          );
        }
        plan.created.locales.push(locale);
        plan.ops.push({ method: "POST", path: APP_INFO_LOCALIZATIONS, body: newAppInfoLocalization(appInfo.id, { locale, ...present(desired) }), changes: allowed, label: `${locale} (new App Info language)` });
      }
    } else if (!files && existing && options.prune) {
      if (locale === primary) throw refusePrimary(locale);
      const allowed = gate([{ scope: locale, field: "appInfoLocalization", kind: "remove", from: existing.attributes.name ?? locale, to: null }], () => "appInfo");
      if (allowed.length) {
        plan.deleted.locales.push(locale);
        plan.ops.push({ method: "DELETE", path: localizationPath(APP_INFO_LOCALIZATIONS, existing.id), changes: allowed, label: `${locale} (delete App Info language)` });
      }
    }
  }

  // The version: copyright and release type.
  const versionDesired: Record<string, unknown> = {};
  if (app.copyright !== undefined) versionDesired.copyright = app.copyright;
  const releaseType = app.release?.type;
  if (releaseType !== undefined) {
    if (releaseType === "SCHEDULED" && version?.releaseType !== "SCHEDULED") {
      plan.skipped.push({ scope: "app", field: "release.type", reason: "a scheduled release needs a date: use `ship release submit --release <date>`" });
    } else {
      versionDesired["release.type"] = releaseType;
    }
  }
  if (Object.keys(versionDesired).length) {
    const current = { copyright: version?.copyright, "release.type": version?.releaseType };
    const allowed = gate(diffRecord("app", current, versionDesired), () => "version");
    if (allowed.length && version) {
      plan.ops.push({ method: "PATCH", path: versionPath(version.id), body: versionBody(version.id, attributesFor(allowed, versionDesired, { "release.type": "releaseType" })), changes: allowed, label: `version ${version.versionString}` });
    }
  }

  // Version languages: description, keywords, promotional text, What's New, URLs.
  const versionByLocale = new Map(remote.versionLocalizations.map((loc) => [loc.locale, loc]));
  const versionLocales = [...new Set([...localLocales, ...[...versionByLocale.keys()].filter((locale) => inScope(locale, options.locales))])].sort();
  const firstVersionNote = "What's New doesn't apply to an app's first version";
  for (const locale of versionLocales) {
    const files = local.locales[locale];
    const existing = versionByLocale.get(locale);
    if (files && existing) {
      const desired = localeAttributes(files, "version");
      let changes = diffRecord(locale, comparable(existing.attributes), desired);
      if (remote.firstVersion) {
        skip(changes.filter((change) => change.field === "whatsNew"), firstVersionNote);
        changes = changes.filter((change) => change.field !== "whatsNew");
      }
      // Promotional text can change any time, even on the live version.
      const allowed = gate(changes, (change) => (change.field === "promotionalText" ? "always" : "version"));
      if (allowed.length) {
        const path = localizationPath(VERSION_LOCALIZATIONS, existing.id);
        plan.ops.push({ method: "PATCH", path, body: versionLocalizationBody(existing.id, attributesFor(allowed, desired)), changes: allowed, label: locale });
      }
    } else if (files && hasTarget(files, "version")) {
      const desired = localeAttributes(files, "version");
      let changes = diffRecord(locale, undefined, desired);
      if (remote.firstVersion) {
        skip(changes.filter((change) => change.field === "whatsNew"), firstVersionNote);
        changes = changes.filter((change) => change.field !== "whatsNew");
        delete desired.whatsNew;
      }
      const allowed = gate(changes.length ? changes : [{ scope: locale, field: "appStoreVersionLocalization", kind: "add", to: locale }], () => "version");
      if (allowed.length && version) {
        if (!plan.created.locales.includes(locale)) plan.created.locales.push(locale);
        plan.ops.push({ method: "POST", path: VERSION_LOCALIZATIONS, body: newVersionLocalization(version.id, { locale, ...present(desired) }), changes: allowed, label: `${locale} (new language)` });
      }
    } else if (!files && existing && options.prune) {
      if (locale === primary) throw refusePrimary(locale);
      const from = typeof existing.attributes.description === "string" && existing.attributes.description ? existing.attributes.description : locale;
      const allowed = gate([{ scope: locale, field: "appStoreVersionLocalization", kind: "remove", from, to: null }], () => "version");
      if (allowed.length) {
        if (!plan.deleted.locales.includes(locale)) plan.deleted.locales.push(locale);
        plan.ops.push({ method: "DELETE", path: localizationPath(VERSION_LOCALIZATIONS, existing.id), changes: allowed, label: `${locale} (delete language)` });
      }
    }
  }

  // App Review: contact, demo account, notes.
  planReview(plan, local, remote, options, gate);
  plan.created.locales.sort();
  plan.deleted.locales.sort();
  return plan;
}

/** The App Review details part of the plan. The password is compared, never shown. */
function planReview(plan: Plan, local: LocalMetadata, remote: RemoteMetadata, options: PlanOptions, gate: (changes: Change[], need: () => Need) => Change[]) {
  const review = local.app?.review;
  if (review === undefined && local.reviewNotes === undefined) return;
  const { demoAccountPassword: reference, ...fields } = review ?? {};
  const desired: Record<string, unknown> = { ...fields };
  if (local.reviewNotes !== undefined) desired.notes = local.reviewNotes;
  const existing = remote.review;
  let deferred = false;
  if (reference === null || reference === "") {
    desired.demoAccountPassword = null;
  } else if (reference !== undefined) {
    const password = options.password;
    if (password?.value === undefined) {
      plan.notes.push(`The demo account password wasn't compared${password?.error ? `: ${password.error}` : ""}.`);
    } else if (!existing || "demoAccountPassword" in existing.attributes) {
      desired.demoAccountPassword = password.value;
    } else {
      deferred = true;
    }
  }
  const changes = diffRecord("review", existing?.attributes, desired, { secret: ["demoAccountPassword"] });
  if (deferred) {
    // App Store Connect didn't say what the password is, so it's sent along with other review changes.
    if (changes.length) {
      desired.demoAccountPassword = options.password!.value;
      changes.push({ scope: "review", field: "demoAccountPassword", kind: "change", from: MASK, to: MASK, secret: true });
      plan.notes.push("App Store Connect doesn't return the demo account password, so push sends it with the other App Review changes.");
    } else {
      plan.notes.push("App Store Connect doesn't return the demo account password, so it can't be compared; push sends it when other App Review details change.");
    }
  }
  const allowed = gate(changes, () => "version");
  const version = remote.version;
  if (!allowed.length || !version) return;
  if (existing) {
    plan.ops.push({ method: "PATCH", path: reviewDetailPath(existing.id), body: reviewDetailBody(existing.id, attributesFor(allowed, desired)), changes: allowed, label: "App Review details" });
  } else {
    plan.ops.push({ method: "POST", path: REVIEW_DETAILS, body: newReviewDetail(version.id, present(desired)), changes: allowed, label: "App Review details" });
  }
}

/** The error push stops with when something can't change now. */
export function notEditable(blocked: Skip[]): ShipError {
  const lines = blocked.map((item) => `${item.scope} ${item.field}: ${item.reason}`);
  return new ShipError(
    `${blocked.length} change${blocked.length === 1 ? "" : "s"} can't be made now:\n  ${lines.join("\n  ")}`,
    "not-editable",
    "Start the next version with `ship release prepare --version <x.y>`, or pass --partial to push only what can change now (like promotional text).",
    { blocked },
  );
}

/** Checks the categories push would set against Apple's list for the platform. */
export function checkCategories(categories: Categories, known: Map<string, string[]>): void {
  const top = [...known.keys()].sort();
  for (const key of ["primary", "secondary"] as const) {
    const id = categories[key];
    if (id && !known.has(id)) {
      throw new ShipError(`"${id}" isn't an App Store category`, "bad-category", `Set categories.${key} in app.json to one of: ${top.join(", ")}`, { field: `categories.${key}`, choices: top });
    }
    const subs = categories[`${key}Subcategories`];
    const allowed = id ? (known.get(id) ?? []) : [];
    for (const sub of subs) {
      if (!allowed.includes(sub)) {
        throw new ShipError(
          `"${sub}" isn't a subcategory of ${id ?? "the " + key + " category"}`,
          "bad-category",
          allowed.length ? `Set categories.${key}Subcategories to some of: ${allowed.join(", ")}` : `${id ?? "That category"} has no subcategories; remove categories.${key}Subcategories from app.json.`,
          { field: `categories.${key}Subcategories`, choices: allowed },
        );
      }
    }
  }
}

// MARK: Pushing

/** A version as --json shows it. */
export const versionSummary = (version?: AppStoreVersion) => (version ? { id: version.id, versionString: version.versionString, state: version.state } : null);
export const appInfoSummary = (info?: AppInfo) => (info ? { id: info.id, state: info.state } : null);

/** What push did, with what it changed it on. */
export interface MetadataPushResult extends PushResult {
  dryRun: boolean;
  version: ReturnType<typeof versionSummary>;
  appInfo: ReturnType<typeof appInfoSummary>;
  created: { locales: string[] };
  deleted: { locales: string[] };
  notes: string[];
}

/** Sends the plan's requests in order. A failure says what was already applied. */
export async function applyPlan(ops: Op[]): Promise<Change[]> {
  const applied: Change[] = [];
  for (const op of ops) {
    ui.step(`Updating ${op.label}`);
    try {
      await api(op.method, op.path, op.body);
    } catch (error) {
      if (!(error instanceof ShipError) || !applied.length) throw error;
      throw new ShipError(
        `${error.message} (while updating ${op.label}; ${applied.length} change${applied.length === 1 ? " was" : "s were"} already made)`,
        error.code,
        `${error.hint ?? ""} Fix it and push again; push only sends what still differs.`.trim(),
        { ...error.details, applied: changesJSON(applied) },
        error.exitCode,
      );
    }
    applied.push(...op.changes);
  }
  return applied;
}

/** Reads the password app.json points at. strict: a failure is an error (push); otherwise it's a note (diff). */
export async function reviewPassword(local: LocalMetadata, strict: boolean): Promise<PlanOptions["password"]> {
  const reference = local.app?.review?.demoAccountPassword;
  if (!reference || !isSecretReference(reference)) return undefined;
  try {
    return { value: await resolveSecret(reference, { opAccount: (await loadSettings()).opAccount }) };
  } catch (error) {
    if (strict || !(error instanceof ShipError)) throw error;
    return { error: error.message };
  }
}

export interface MetadataOptions {
  appId: string;
  version?: string;
  locales?: string[];
  prune?: boolean;
  platform?: AscPlatform;
}

/** Reads both sides and plans. Shared by diff and push. */
export async function prepare(project: Project, options: MetadataOptions & { strict: boolean }): Promise<{ local: LocalMetadata; remote: RemoteMetadata; plan: Plan }> {
  const snapshot = await readSnapshot(project.storeDir, options.locales);
  const errors = validateSnapshot(snapshot).filter((item) => item.severity === "error");
  if (errors.length) {
    // A password written out is the one problem worth its own code: it must never be sent from the repo.
    const plaintext = errors.some((item) => (item as { code?: string }).code === PLAINTEXT_SECRET);
    throw new ShipError(
      `The store folder has ${errors.length} problem${errors.length === 1 ? "" : "s"}:\n  ${errors.map((item) => `${item.file}${item.field ? ` ${item.field}` : ""}: ${item.message}`).join("\n  ")}`,
      plaintext ? PLAINTEXT_SECRET : "invalid-metadata",
      plaintext
        ? "Save the password with `ship secret set keychain:ship/<name> --stdin`, write \"keychain:ship/<name>\" in app.json instead, and take it out of git history if it was committed."
        : "Fix them and try again; `ship metadata validate` lists them.",
      { problems: errors },
    );
  }
  const local = localFromSnapshot(snapshot, project.storeDir);
  const remote = await fetchRemote(options.appId, options.platform ?? platformInfo(project.platform).asc, { version: options.version });
  const password = await reviewPassword(local, options.strict);
  const plan = planMetadata(local, remote, { locales: options.locales, prune: options.prune, password });
  return { local, remote, plan };
}

/**
 * Pushes the store folder's text and app.json to App Store Connect. Refuses
 * (code not-editable) when something can't change in the current state,
 * unless `partial`, which pushes the rest. Without a store folder it does
 * nothing.
 */
export async function pushMetadata(
  project: Project,
  options: { appId: string; version?: string; dryRun?: boolean; partial?: boolean; prune?: boolean; locales?: string[]; platform?: AscPlatform },
): Promise<MetadataPushResult> {
  const dryRun = Boolean(options.dryRun);
  if (!existsSync(project.storeDir)) {
    return { changes: [], applied: false, skipped: [], dryRun, version: null, appInfo: null, created: { locales: [] }, deleted: { locales: [] }, notes: [] };
  }
  const { remote, plan } = await prepare(project, { ...options, strict: !dryRun });
  if (plan.blocked.length && !options.partial) throw notEditable(plan.blocked);
  if (plan.categories) checkCategories(plan.categories, await appCategories(options.platform ?? platformInfo(project.platform).asc));
  const changes = plan.ops.flatMap((op) => op.changes);
  const skipped = [...plan.skipped, ...(options.partial ? plan.blocked : [])];
  const result = (applied: boolean): MetadataPushResult => ({
    changes,
    applied,
    skipped,
    dryRun,
    version: versionSummary(remote.version),
    appInfo: appInfoSummary(remote.appInfo),
    created: plan.created,
    deleted: plan.deleted,
    notes: plan.notes,
  });
  if (dryRun || !plan.ops.length) return result(false);
  await applyPlan(plan.ops);
  return result(true);
}

// MARK: Pulling

/** What pull writes: file contents by path in the store folder, and the paths to empty when they exist. */
export interface PullPlan {
  files: Record<string, string>;
  /** Fields App Store Connect has empty: their files are emptied if they have text, and never created. */
  clear: string[];
  app: StoreApp;
  locales: string[];
  warnings: string[];
}

/** The store folder pull would write, from what App Store Connect has. Pure. */
export function planPull(remote: RemoteMetadata, existing: StoreApp | undefined, options: { locales?: string[]; appName?: string } = {}): PullPlan {
  const files: Record<string, string> = {};
  const clear: string[] = [];
  const warnings: string[] = [];
  const infoByLocale = new Map(remote.appInfoLocalizations.map((loc) => [loc.locale, loc]));
  const versionByLocale = new Map(remote.versionLocalizations.map((loc) => [loc.locale, loc]));
  const locales = [...new Set([...infoByLocale.keys(), ...versionByLocale.keys()])].filter((locale) => inScope(locale, options.locales)).sort();
  for (const locale of locales) {
    const written = { ...localeFiles(infoByLocale.get(locale)?.attributes ?? {}, "appInfo"), ...localeFiles(versionByLocale.get(locale)?.attributes ?? {}, "version") };
    for (const entry of LOCALE_FIELDS) {
      const path = `${locale}/${entry.file}`;
      if (written[entry.file] !== undefined) files[path] = written[entry.file]!;
      else clear.push(path);
    }
  }
  const notes = remote.review?.attributes.notes;
  if (typeof notes === "string" && notes.trim()) files[REVIEW_NOTES_FILE] = notes.replace(/\r\n?/g, "\n").trimEnd();
  else clear.push(REVIEW_NOTES_FILE);

  const app: StoreApp = { ...(existing ?? {}) };
  const set = <K extends keyof StoreApp>(key: K, value: StoreApp[K] | undefined | null | "") => {
    if (value === undefined || value === null || value === "") delete app[key];
    else app[key] = value;
  };
  if (remote.categories) {
    const { primary, primarySubcategories, secondary, secondarySubcategories } = remote.categories;
    const categories: NonNullable<StoreApp["categories"]> = {};
    if (primary) categories.primary = primary;
    if (primarySubcategories.length) categories.primarySubcategories = primarySubcategories;
    if (secondary) categories.secondary = secondary;
    if (secondarySubcategories.length) categories.secondarySubcategories = secondarySubcategories;
    set("categories", Object.keys(categories).length ? categories : undefined);
  }
  set("contentRights", remote.app.contentRights as StoreApp["contentRights"]);
  if (remote.version) set("copyright", remote.version.copyright);
  if (remote.ageRating) {
    // Only attributes ship knows, so a question Apple adds later doesn't make validate fail on a fresh pull.
    const rating = Object.fromEntries(
      Object.entries(remote.ageRating.attributes).filter(
        ([key, value]) => value !== null && value !== undefined && AGE_RATING_KEYS.includes(key) && !AGE_RATING_DEPRECATED.includes(key),
      ),
    ) as Record<string, string | boolean>;
    set("ageRating", Object.keys(rating).length ? rating : undefined);
  }
  if (remote.version) {
    const review = pullReview(remote.review, existing?.review, options.appName ?? remote.app.name, warnings);
    set("review", review);
    const release = { ...(existing?.release ?? {}) };
    if (remote.version.releaseType) release.type = remote.version.releaseType as NonNullable<StoreApp["release"]>["type"];
    if (remote.phased !== undefined) release.phased = remote.phased;
    set("release", Object.keys(release).length ? release : undefined);
  }
  return { files, clear, app: orderStoreApp(app), locales, warnings };
}

/** app.json's review from App Store Connect's: never the password, which stays a reference. */
function pullReview(detail: ReviewDetail | undefined, existing: StoreApp["review"], appName: string | undefined, warnings: string[]): StoreApp["review"] {
  if (!detail) return undefined;
  const review: NonNullable<StoreApp["review"]> = {};
  const attributes = detail.attributes;
  for (const key of ["contactFirstName", "contactLastName", "contactEmail", "contactPhone", "demoAccountName"] as const) {
    const value = attributes[key];
    if (typeof value === "string" && value) review[key] = value;
  }
  if (typeof attributes.demoAccountRequired === "boolean") review.demoAccountRequired = attributes.demoAccountRequired;
  const reference = existing?.demoAccountPassword;
  const remotePassword = attributes.demoAccountPassword;
  if (reference && isSecretReference(reference)) {
    review.demoAccountPassword = reference;
  } else if (typeof remotePassword === "string" && remotePassword) {
    // The password itself never goes in the repo. Leaving it out keeps App Store Connect's.
    const name = `${(appName ?? "app").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app"}-demo-password`;
    warnings.push(
      `The App Review demo password isn't saved in app.json. Save it with \`ship secret set keychain:ship/${name} --stdin\` and set review.demoAccountPassword to "keychain:ship/${name}".`,
    );
  } else if (reference === null) {
    review.demoAccountPassword = null;
  }
  return Object.keys(review).length ? review : undefined;
}

const normalizeText = (text: string) => text.replace(/\r\n?/g, "\n").trimEnd();

export interface PullResult {
  dir: string;
  version: ReturnType<typeof versionSummary>;
  appInfo: ReturnType<typeof appInfoSummary>;
  locales: string[];
  written: string[];
  unchanged: string[];
  warnings: string[];
}

/**
 * Writes the store folder from App Store Connect. Refuses (code
 * local-changes) to overwrite files that differ, unless `force`. A second
 * pull with nothing changed writes nothing.
 */
export async function pullMetadata(project: Project, options: MetadataOptions & { force?: boolean }): Promise<PullResult> {
  const dir = project.storeDir;
  const remote = await fetchRemote(options.appId, options.platform ?? platformInfo(project.platform).asc, { version: options.version, phased: true });
  const existingText = await readText(join(dir, "app.json"));
  const existing = existingText === undefined ? undefined : localFromSnapshot({ appJson: existingText, locales: [] }, dir).app;
  const pull = planPull(remote, existing, { locales: options.locales, appName: remote.app.name || project.config.name });

  const writes: [string, string][] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  const consider = (path: string, current: string | undefined, next: string, differs: boolean) => {
    if (!differs) unchanged.push(path);
    else if (current !== undefined && !options.force) conflicts.push(path);
    else writes.push([path, next]);
  };
  for (const [path, text] of Object.entries(pull.files)) {
    const current = await readText(join(dir, path));
    consider(path, current, text, current !== normalizeText(text));
  }
  for (const path of pull.clear) {
    const current = await readText(join(dir, path));
    if (current) consider(path, current, "", true);
  }
  const appChanged = existing === undefined ? Object.keys(pull.app).length > 0 : JSON.stringify(orderStoreApp(existing)) !== JSON.stringify(pull.app);
  if (existing !== undefined || appChanged) consider("app.json", existingText, "", appChanged);

  if (conflicts.length) {
    throw new ShipError(
      `${conflicts.length} file${conflicts.length === 1 ? "" : "s"} in ${dir} differ${conflicts.length === 1 ? "s" : ""} from App Store Connect:\n  ${conflicts.join("\n  ")}`,
      "local-changes",
      "See what differs with `ship metadata diff` (push them with `ship metadata push`), or pass --force to overwrite them with App Store Connect's.",
      { files: conflicts },
    );
  }
  for (const [path, text] of writes) {
    if (path === "app.json") await writeStoreApp(project, pull.app);
    else await writeText(join(dir, path), text);
  }
  return {
    dir,
    version: versionSummary(remote.version),
    appInfo: appInfoSummary(remote.appInfo),
    locales: pull.locales,
    written: writes.map(([path]) => path).sort(),
    unchanged: unchanged.sort(),
    warnings: pull.warnings,
  };
}
