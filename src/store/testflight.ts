// TestFlight's test information as files in the store folder
// (appstore/testflight/ by default): what testers see about the beta, per
// language, and the contact and sign-in details for Beta App Review.
//
//   testflight/review.json          contact and demo account (the password is a reference)
//   testflight/review-notes.txt     notes for Beta App Review
//   testflight/<locale>/description.txt  feedback-email.txt  marketing-url.txt
//                       privacy-policy-url.txt  tvos-privacy-policy.txt
//
// A missing file isn't managed; an empty one clears the field. All of it can
// change any time, unlike the App Store page. The demo account password is
// a reference (keychain:, op://, env:, file:), never the password: null
// leaves App Store Connect's alone (pull writes null), and "" clears it.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type BetaLocalization,
  type BetaLocalizationAttributes,
  type BetaReviewAttributes,
  betaLocalizations,
  betaReviewDetail,
  createBetaLocalization,
  deleteBetaLocalization,
  updateBetaLocalization,
  updateBetaReviewDetail,
} from "../asc/testflight";
import { type Project, loadSettings } from "../config";
import { type Change, MASK, diffRecord, same } from "../diff";
import { isSecretReference, resolveSecret } from "../secrets";
import { ShipError, ui } from "../ui";
import { type Problem, chars, isEmail, isHttpUrl, passwordProblem } from "./check";
import { ASC_LOCALES, LOCALE_PATTERN, type PushResult, type ReviewDetails, localeDirs, readText, writeText } from "./files";

/** The testflight folder inside the store folder. */
export const testflightDir = (project: Project) => join(project.storeDir, "testflight");

export type LocalizationField = keyof BetaLocalizationAttributes;

/** Each per-language field and its file. */
export const LOCALIZATION_FILES: Record<LocalizationField, string> = {
  description: "description.txt",
  feedbackEmail: "feedback-email.txt",
  marketingUrl: "marketing-url.txt",
  privacyPolicyUrl: "privacy-policy-url.txt",
  tvOsPrivacyPolicy: "tvos-privacy-policy.txt",
};

const FIELDS = Object.keys(LOCALIZATION_FILES) as LocalizationField[];

/** review.json's keys, in the order ship writes them. */
export const REVIEW_KEYS: (keyof ReviewDetails)[] = [
  "contactFirstName",
  "contactLastName",
  "contactEmail",
  "contactPhone",
  "demoAccountRequired",
  "demoAccountName",
  "demoAccountPassword",
];

/** The longest a beta description can be. */
export const DESCRIPTION_LIMIT = 4000;
/** Where ship warns about Beta App Review notes (Apple's App Review limit). */
export const NOTES_LIMIT = 4000;

export const REVIEW_FILE = "review.json";
export const NOTES_FILE = "review-notes.txt";

// MARK: Reading the files

/** What the testflight folder holds. Missing files are left out (not managed). */
export interface BetaInfoFiles {
  /** review.json, when there is one. */
  review?: ReviewDetails;
  /** review-notes.txt, when there is one. */
  notes?: string;
  /** Per locale folder, the fields whose files exist. */
  locales: Record<string, BetaLocalizationAttributes>;
  /** review.json keys ship doesn't know. */
  unknownKeys: string[];
  /** Files in locale folders ship doesn't read, like "en-US/whats-new.txt". */
  unknownFiles: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** review.json's text as an object, or a bad-store-file error naming the file. */
export function parseReviewJSON(text: string, file: string): Record<string, unknown> {
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new ShipError(
      `${file} isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "bad-store-file",
      `Fix ${file} (a missing comma or quote?), or delete it and run \`ship testflight pull\`.`,
      { file },
    );
  }
  if (!isObject(json)) {
    throw new ShipError(`${file} should hold a JSON object`, "bad-store-file", "Start it with { and end it with }, or delete it and run `ship testflight pull`.", { file });
  }
  return json;
}

/** Reads the testflight folder (`dir`). */
export async function readBetaInfo(dir: string): Promise<BetaInfoFiles> {
  const info: BetaInfoFiles = { locales: {}, unknownKeys: [], unknownFiles: [] };
  const reviewText = await readText(join(dir, REVIEW_FILE));
  if (reviewText !== undefined) {
    const json = parseReviewJSON(reviewText, join(dir, REVIEW_FILE));
    info.review = Object.fromEntries(REVIEW_KEYS.filter((key) => key in json).map((key) => [key, json[key]])) as ReviewDetails;
    info.unknownKeys = Object.keys(json).filter((key) => !(REVIEW_KEYS as string[]).includes(key));
  }
  info.notes = await readText(join(dir, NOTES_FILE));
  const known = new Set(Object.values(LOCALIZATION_FILES));
  for (const locale of localeDirs(dir)) {
    const fields: BetaLocalizationAttributes = {};
    for (const field of FIELDS) {
      const text = await readText(join(dir, locale, LOCALIZATION_FILES[field]));
      if (text !== undefined) fields[field] = text;
    }
    info.locales[locale] = fields;
    for (const entry of readdirSync(join(dir, locale), { withFileTypes: true })) {
      if (!entry.name.startsWith(".") && !known.has(entry.name)) info.unknownFiles.push(`${locale}/${entry.name}`);
    }
  }
  return info;
}

// MARK: Pulling

/** What App Store Connect has. */
export interface RemoteBetaInfo {
  review: { id: string; attributes: BetaReviewAttributes };
  localizations: BetaLocalization[];
}

export async function fetchBetaInfo(appId: string): Promise<RemoteBetaInfo> {
  const [review, localizations] = await Promise.all([betaReviewDetail(appId), betaLocalizations(appId)]);
  return { review, localizations };
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const orNull = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : null);

/**
 * The files for what App Store Connect has, by path in the testflight
 * folder. The password is never written: review.json keeps `passwordRef`
 * (the reference already there), or null. tvos-privacy-policy.txt is written
 * only for tvOS apps or when it has text.
 */
export function filesFromRemote(remote: RemoteBetaInfo, options: { passwordRef?: string | null; tvos?: boolean } = {}): Map<string, string> {
  const files = new Map<string, string>();
  const a = remote.review.attributes;
  const review: Record<string, unknown> = {
    contactFirstName: orNull(a.contactFirstName),
    contactLastName: orNull(a.contactLastName),
    contactEmail: orNull(a.contactEmail),
    contactPhone: orNull(a.contactPhone),
    demoAccountRequired: Boolean(a.demoAccountRequired),
    demoAccountName: orNull(a.demoAccountName),
    demoAccountPassword: options.passwordRef ?? null,
  };
  files.set(REVIEW_FILE, `${JSON.stringify(review, null, 2)}\n`);
  files.set(NOTES_FILE, text(a.notes));
  for (const localization of [...remote.localizations].sort((x, y) => x.locale.localeCompare(y.locale))) {
    for (const field of FIELDS) {
      const value = text(localization.attributes[field]);
      if (field === "tvOsPrivacyPolicy" && !options.tvos && !value.trim()) continue;
      files.set(`${localization.locale}/${LOCALIZATION_FILES[field]}`, value);
    }
  }
  return files;
}

/** Whether a file already says what `content` says (text normalized; review.json compared as JSON). */
export function sameFile(path: string, existing: string, content: string): boolean {
  const norm = (value: string) => value.replace(/\r\n?/g, "\n").trimEnd();
  if (path === REVIEW_FILE) {
    try {
      return same(JSON.parse(existing), JSON.parse(content));
    } catch {
      return false;
    }
  }
  return norm(existing) === norm(content);
}

/** The hint for a demo account password ship won't write to a file. */
export const passwordHint = (project: Project) => {
  const name = `${project.config.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app"}-beta-demo-password`;
  return `ship secret set keychain:ship/${name} --stdin, then put "keychain:ship/${name}" in testflight/review.json as demoAccountPassword`;
};

export interface PullResult {
  dir: string;
  /** Files written, relative to dir. */
  written: string[];
  /** Files that already matched. */
  unchanged: string[];
  warnings: string[];
}

/**
 * Writes what App Store Connect has into the testflight folder. A file that
 * differs from App Store Connect is local work: pull stops and names it,
 * unless `force`. Pulling twice changes nothing.
 */
export async function pullBetaInfo(project: Project, options: { appId: string; force?: boolean }): Promise<PullResult> {
  const dir = testflightDir(project);
  const remote = await fetchBetaInfo(options.appId);
  // Keep the password reference already in review.json; never the password.
  const reviewText = await readText(join(dir, REVIEW_FILE));
  let passwordRef: string | null = null;
  if (reviewText) {
    try {
      const ref = parseReviewJSON(reviewText, join(dir, REVIEW_FILE)).demoAccountPassword;
      if (typeof ref === "string" && isSecretReference(ref)) passwordRef = ref;
    } catch {
      // A broken review.json counts as a local change below.
    }
  }
  const files = filesFromRemote(remote, { passwordRef, tvos: project.platform === "tvos" });
  const written: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  for (const [path, content] of files) {
    const existing = await readText(join(dir, path));
    if (existing === undefined) written.push(path);
    else if (sameFile(path, existing, content)) unchanged.push(path);
    else if (options.force) written.push(path);
    else conflicts.push(path);
  }
  if (conflicts.length) {
    throw new ShipError(
      `${conflicts.length === 1 ? "A file in" : `${conflicts.length} files in`} ${dir} differ${conflicts.length === 1 ? "s" : ""} from App Store Connect: ${conflicts.join(", ")}`,
      "local-changes",
      "See what differs with `ship testflight diff`, send it with `ship testflight push`, or replace it with App Store Connect's with `ship testflight pull --force`.",
      { files: conflicts },
    );
  }
  for (const path of written) await writeText(join(dir, path), files.get(path)!);
  const warnings: string[] = [];
  const a = remote.review.attributes;
  if (!passwordRef && (a.demoAccountRequired || orNull(a.demoAccountPassword))) {
    warnings.push(`The demo account password isn't written to review.json. Save it with \`${passwordHint(project)}\`.`);
  }
  return { dir, written, unchanged, warnings };
}

// MARK: Diffing

/** What a push would change. */
export interface BetaInfoPlan {
  changes: Change[];
  /** Locales with no localization in App Store Connect yet, and what to create them with. */
  create: Record<string, BetaLocalizationAttributes>;
  /** Existing localizations to change: their id and the changed fields. */
  update: { locale: string; id: string; attributes: BetaLocalizationAttributes }[];
  /** Locales in App Store Connect with no folder here (push --prune deletes them). */
  onlyRemote: { locale: string; id: string }[];
  /** Review fields to change (the password not included). */
  review: BetaReviewAttributes;
  /** Whether push sends the password: "set" resolves the reference, "clear" sends null. */
  password?: "set" | "clear";
  /** True when App Store Connect doesn't show the password, so push can't tell whether it differs. */
  passwordHidden: boolean;
}

/**
 * What would change, from the files (`local`) to App Store Connect
 * (`remote`). `resolvedPassword` is the password the reference points at,
 * needed only when App Store Connect shows its password (to compare). When
 * it doesn't (the attribute isn't sent), the password goes along with any
 * other review change. `locales` limits the languages.
 */
export function planBetaInfo(local: BetaInfoFiles, remote: RemoteBetaInfo, options: { locales?: string[]; resolvedPassword?: string; prune?: boolean } = {}): BetaInfoPlan {
  const plan: BetaInfoPlan = { changes: [], create: {}, update: [], onlyRemote: [], review: {}, passwordHidden: false };
  const wanted = (locale: string) => !options.locales?.length || options.locales.includes(locale);

  // Review details and notes.
  const { demoAccountPassword, ...details } = local.review ?? {};
  const desired: Record<string, unknown> = { ...details };
  if (local.notes !== undefined) desired.notes = local.notes;
  const reviewChanges = diffRecord("testflight/review", remote.review.attributes, desired);
  for (const change of reviewChanges) (plan.review as Record<string, unknown>)[change.field] = change.to ?? null;
  plan.changes.push(...reviewChanges);

  // Unlike other fields, a null password isn't managed: pull writes null because it never writes
  // the password, and pushing that mustn't clear App Store Connect's. "" clears it.
  if (typeof demoAccountPassword === "string") {
    const shown = "demoAccountPassword" in remote.review.attributes;
    const remotePassword = remote.review.attributes.demoAccountPassword;
    const clear = demoAccountPassword === "";
    if (!shown) {
      // Apple didn't say, so it can't be compared: send it with the other changes.
      plan.passwordHidden = true;
      if (reviewChanges.length) plan.password = clear ? "clear" : "set";
    } else if (clear ? Boolean(remotePassword) : !remotePassword || (options.resolvedPassword !== undefined && remotePassword !== options.resolvedPassword)) {
      plan.password = clear ? "clear" : "set";
      const kind = clear ? "remove" : remotePassword ? "change" : "add";
      // The change never holds the password itself, even before it's masked for output.
      plan.changes.push({ scope: "testflight/review", field: "demoAccountPassword", kind, ...(remotePassword ? { from: MASK } : {}), to: clear ? null : MASK, secret: true });
    }
  }

  // Localizations.
  const byLocale = new Map(remote.localizations.map((l) => [l.locale, l]));
  for (const [locale, fields] of Object.entries(local.locales).sort(([x], [y]) => x.localeCompare(y))) {
    if (!wanted(locale)) continue;
    const existing = byLocale.get(locale);
    const changes = diffRecord(`testflight/${locale}`, existing?.attributes as Record<string, unknown> | undefined, fields);
    if (!changes.length) continue;
    plan.changes.push(...changes);
    const attributes = Object.fromEntries(changes.map((c) => [c.field, c.to ?? null])) as BetaLocalizationAttributes;
    if (existing) plan.update.push({ locale, id: existing.id, attributes });
    else plan.create[locale] = Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== null)) as BetaLocalizationAttributes;
  }
  for (const localization of remote.localizations) {
    if (localization.locale in local.locales || !wanted(localization.locale)) continue;
    plan.onlyRemote.push({ locale: localization.locale, id: localization.id });
    if (options.prune) {
      plan.changes.push({ scope: `testflight/${localization.locale}`, field: "localization", kind: "remove", from: localization.locale, to: null });
    }
  }
  return plan;
}

// MARK: Validating

/** A Problem, with a code for the ones scripts act on (like "plaintext-secret"). */
export type BetaProblem = Problem & { code?: string };

/** Offline checks of the testflight folder. File paths are relative to the store folder. */
export function validateBetaInfo(info: BetaInfoFiles): BetaProblem[] {
  const problems: BetaProblem[] = [];
  const reviewFile = `testflight/${REVIEW_FILE}`;
  const error = (file: string, message: string, field?: string, code?: string) =>
    problems.push({ file, ...(field ? { field } : {}), message, severity: "error", ...(code ? { code } : {}) });
  const warning = (file: string, message: string, field?: string) => problems.push({ file, ...(field ? { field } : {}), message, severity: "warning" });

  const review = info.review;
  if (review) {
    for (const key of REVIEW_KEYS) {
      const value = review[key];
      if (value === undefined || value === null) continue;
      if (key === "demoAccountRequired" ? typeof value !== "boolean" : typeof value !== "string") {
        error(reviewFile, `${key} should be ${key === "demoAccountRequired" ? "true or false" : "text (or null to clear it)"}`, key);
      }
    }
    for (const key of info.unknownKeys) warning(reviewFile, `${key} isn't a Beta App Review field; ship ignores it`, key);
    if (typeof review.contactEmail === "string" && review.contactEmail && !isEmail(review.contactEmail)) {
      error(reviewFile, `contactEmail isn't an email address: ${review.contactEmail}`, "contactEmail");
    }
    if (typeof review.contactPhone === "string" && review.contactPhone && !/\d/.test(review.contactPhone)) {
      error(reviewFile, `contactPhone has no digits: ${review.contactPhone}`, "contactPhone");
    }
    const password = typeof review.demoAccountPassword === "string" ? review.demoAccountPassword : undefined;
    const plaintext = passwordProblem(reviewFile, "demoAccountPassword", password);
    if (plaintext) problems.push({ ...plaintext, code: "plaintext-secret" });
    // A missing key isn't managed (App Store Connect may have it); an empty one would clear it.
    if (review.demoAccountRequired === true) {
      if (!review.demoAccountName && review.demoAccountName !== undefined) {
        error(reviewFile, "demoAccountRequired is true, so Beta App Review needs demoAccountName", "demoAccountName");
      }
      if (password === "") {
        error(reviewFile, "demoAccountRequired is true, so Beta App Review needs demoAccountPassword (a reference like keychain:ship/<name>)", "demoAccountPassword");
      } else if (review.demoAccountPassword === null) {
        warning(reviewFile, "demoAccountPassword is null, so ship leaves App Store Connect's password as it is. Point it at a reference to manage it.", "demoAccountPassword");
      }
    }
  }
  if (info.notes !== undefined && chars(info.notes) > NOTES_LIMIT) {
    warning(`testflight/${NOTES_FILE}`, `The notes are ${chars(info.notes)} characters; App Review takes up to ${NOTES_LIMIT}`);
  }

  for (const [locale, fields] of Object.entries(info.locales)) {
    const file = (field: LocalizationField) => `testflight/${locale}/${LOCALIZATION_FILES[field]}`;
    if (!ASC_LOCALES.includes(locale)) warning(`testflight/${locale}`, `${locale} isn't a language App Store Connect lists; check the folder's name`);
    if (fields.description && chars(fields.description) > DESCRIPTION_LIMIT) {
      error(file("description"), `The description is ${chars(fields.description)} characters; the most is ${DESCRIPTION_LIMIT}`);
    }
    if (fields.feedbackEmail && !isEmail(fields.feedbackEmail)) error(file("feedbackEmail"), `Not an email address: ${fields.feedbackEmail}`);
    for (const field of ["marketingUrl", "privacyPolicyUrl"] as const) {
      const value = fields[field];
      if (value && !isHttpUrl(value)) error(file(field), `Not an http(s) URL: ${value}`);
    }
  }
  for (const path of info.unknownFiles) warning(`testflight/${path}`, "ship doesn't read this file");
  return problems;
}

/** The first plaintext-password problem as an error that stops a push. */
export function refusePlaintext(problems: BetaProblem[], project: Project) {
  const plaintext = problems.find((p) => p.code === "plaintext-secret");
  if (plaintext) {
    throw new ShipError(
      `testflight/review.json has the demo account password in plain text`,
      "plaintext-secret",
      `Save it with \`${passwordHint(project)}\`.`,
      { file: join(testflightDir(project), REVIEW_FILE) },
    );
  }
}

// MARK: Pushing

export interface BetaPushResult extends PushResult {
  /** Locales whose localization was (or would be) created. */
  created: { locales: string[] };
  /** Locales whose localization was (or would be) deleted (--prune). */
  deleted: { locales: string[] };
  /** Locales in App Store Connect with no folder, left alone without --prune. */
  onlyRemote: string[];
}

/** The password a reference points at, never logged. */
const resolvePassword = async (ref: string) => (await resolveSecret(ref, { opAccount: (await loadSettings()).opAccount })) ?? "";

/** Reads the folder, checks it, and compares it with App Store Connect. Resolves the password only when Apple shows its own. */
export async function diffBetaInfo(project: Project, options: { appId: string; locales?: string[]; prune?: boolean }) {
  const dir = testflightDir(project);
  if (!existsSync(dir)) {
    throw new ShipError(`There's no ${dir} yet`, "no-store", "Make it from App Store Connect with `ship testflight pull`.");
  }
  const local = await readBetaInfo(dir);
  const problems = validateBetaInfo(local);
  refusePlaintext(problems, project);
  for (const locale of options.locales ?? []) {
    if (!LOCALE_PATTERN.test(locale) || !(locale in local.locales)) {
      throw new ShipError(
        `There's no testflight/${locale} folder`,
        "usage",
        Object.keys(local.locales).length ? `Pass one of: ${Object.keys(local.locales).join(", ")}` : "Make one with `ship testflight pull`.",
        { choices: Object.keys(local.locales) },
        2,
      );
    }
  }
  const remote = await fetchBetaInfo(options.appId);
  const ref = local.review?.demoAccountPassword;
  const resolvedPassword = ref && remote.review.attributes.demoAccountPassword ? await resolvePassword(ref) : undefined;
  const plan = planBetaInfo(local, remote, { locales: options.locales, resolvedPassword, prune: options.prune });
  return { local, remote, plan, problems };
}

/** Sends the testflight folder to App Store Connect (or with dryRun, says what it would send). */
export async function pushBetaInfo(project: Project, options: { appId: string; dryRun?: boolean; locales?: string[]; prune?: boolean }): Promise<BetaPushResult> {
  const { local, remote, plan, problems } = await diffBetaInfo(project, options);
  const errors = problems.filter((p) => p.severity === "error");
  if (errors.length) {
    throw new ShipError(
      `testflight/ has ${errors.length} problem${errors.length === 1 ? "" : "s"}: ${errors[0]!.file}: ${errors[0]!.message}`,
      "invalid-store",
      "See them all with `ship testflight validate`.",
      { problems: errors },
    );
  }
  if (options.prune && plan.onlyRemote.length && !Object.keys(local.locales).length) {
    throw new ShipError(
      "testflight/ has no language folders, so --prune would delete every localization",
      "usage",
      "Pull them first with `ship testflight pull`, or drop --prune.",
      undefined,
      2,
    );
  }
  const result: BetaPushResult = {
    changes: plan.changes,
    applied: false,
    skipped: [],
    created: { locales: Object.keys(plan.create) },
    deleted: { locales: options.prune ? plan.onlyRemote.map((l) => l.locale) : [] },
    onlyRemote: options.prune ? [] : plan.onlyRemote.map((l) => l.locale),
  };
  const reviewFields = Object.keys(plan.review).length;
  if (options.dryRun || (!plan.changes.length && !plan.password)) return result;

  if (reviewFields || plan.password) {
    const attributes: BetaReviewAttributes = { ...plan.review };
    if (plan.password === "set") attributes.demoAccountPassword = await resolvePassword(local.review!.demoAccountPassword!);
    if (plan.password === "clear") attributes.demoAccountPassword = null;
    ui.step("Updating the Beta App Review details");
    await updateBetaReviewDetail(remote.review.id, attributes);
  }
  for (const { locale, id, attributes } of plan.update) {
    ui.step(`Updating ${locale}`);
    await updateBetaLocalization(id, attributes);
  }
  for (const [locale, attributes] of Object.entries(plan.create)) {
    ui.step(`Adding ${locale}`);
    await createBetaLocalization(options.appId, locale, attributes);
  }
  if (options.prune) {
    for (const { locale, id } of plan.onlyRemote) {
      ui.step(`Deleting ${locale}`);
      await deleteBetaLocalization(id);
    }
  }
  result.applied = true;
  return result;
}
