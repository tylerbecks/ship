// What each store file holds and the limits App Store Connect enforces, so
// `ship metadata validate` (and push, before it sends anything) can catch a
// too-long subtitle or a plaintext password offline. Everything here is
// pure: the reading happens in store/metadata.ts.

import { type Problem, bytes, chars, isEmail, isHttpUrl, passwordProblem } from "./check";
import { APP_KEYS, ASC_LOCALES, CATEGORY_KEYS, RELEASE_KEYS, REVIEW_KEYS, isObject } from "./files";

// MARK: Files

/** Which App Store Connect resource a locale file belongs to. */
export type LocaleTarget = "appInfo" | "version";

export interface LocaleField {
  /** The file in a locale folder, like "description.txt". */
  file: string;
  /** The attribute on appInfoLocalizations or appStoreVersionLocalizations. */
  field: string;
  target: LocaleTarget;
  /** The longest it can be, in characters (keywords count bytes instead). */
  max?: number;
  /** Holds a URL. */
  url?: boolean;
}

/** Every per-locale file and the field it holds. The one place the layout is written down. */
export const LOCALE_FIELDS: LocaleField[] = [
  { file: "name.txt", field: "name", target: "appInfo", max: 30 },
  { file: "subtitle.txt", field: "subtitle", target: "appInfo", max: 30 },
  { file: "privacy-policy-url.txt", field: "privacyPolicyUrl", target: "appInfo", url: true },
  { file: "privacy-choices-url.txt", field: "privacyChoicesUrl", target: "appInfo", url: true },
  { file: "description.txt", field: "description", target: "version", max: 4000 },
  { file: "keywords.txt", field: "keywords", target: "version" },
  { file: "promotional-text.txt", field: "promotionalText", target: "version", max: 170 },
  { file: "whats-new.txt", field: "whatsNew", target: "version", max: 4000 },
  { file: "support-url.txt", field: "supportUrl", target: "version", url: true },
  { file: "marketing-url.txt", field: "marketingUrl", target: "version", url: true },
];

/** The App Review notes, next to app.json. */
export const REVIEW_NOTES_FILE = "review-notes.txt";

/** Files at the top of the store folder that ship knows. */
export const STORE_FILES = ["app.json", REVIEW_NOTES_FILE, "media.lock.json"];

export const fieldForFile = (file: string) => LOCALE_FIELDS.find((entry) => entry.file === file);
export const fileForField = (field: string) => LOCALE_FIELDS.find((entry) => entry.field === field);

/** The code on a problem (and push's error) for a password written out instead of referenced. */
export const PLAINTEXT_SECRET = "plaintext-secret";

/** Apple's limits beyond the per-file ones. */
export const LIMITS = { nameMin: 2, keywordBytes: 100, reviewNotes: 4000, subcategories: 2 };

// MARK: Keywords

/** keywords.txt (one per line) as App Store Connect stores it: trimmed, comma-separated, no spaces. */
export function keywordsToApi(text: string): string {
  return keywordList(text).join(",");
}

/** App Store Connect's comma-separated keywords as keywords.txt: one per line. */
export function keywordsFromApi(value: string): string {
  return keywordList(value).join("\n");
}

/** The keywords in either form (lines or commas), trimmed, empty ones dropped. */
export function keywordList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

// MARK: app.json values

/** AgeRatingDeclaration attributes rated NONE, INFREQUENT_OR_MILD, or FREQUENT_OR_INTENSE. */
export const AGE_RATING_LEVELS = [
  "alcoholTobaccoOrDrugUseOrReferences",
  "contests",
  "gamblingSimulated",
  "gunsOrOtherWeapons",
  "horrorOrFearThemes",
  "matureOrSuggestiveThemes",
  "medicalOrTreatmentInformation",
  "profanityOrCrudeHumor",
  "sexualContentGraphicAndNudity",
  "sexualContentOrNudity",
  "violenceCartoonOrFantasy",
  "violenceRealistic",
  "violenceRealisticProlongedGraphicOrSadistic",
];

/** AgeRatingDeclaration attributes that are yes or no. */
export const AGE_RATING_FLAGS = [
  "advertising",
  "ageAssurance",
  "gambling",
  "healthOrWellnessTopics",
  "lootBox",
  "messagingAndChat",
  "parentalControls",
  "socialMedia",
  "socialMediaAgeRestricted",
  "unrestrictedWebAccess",
  "userGeneratedContent",
];

export const LEVELS = ["NONE", "INFREQUENT_OR_MILD", "FREQUENT_OR_INTENSE"];
/** Older names Apple still accepts for the levels. */
export const LEGACY_LEVELS = ["INFREQUENT", "FREQUENT"];

/** The other AgeRatingDeclaration attributes, with their values (undefined: any text). */
export const AGE_RATING_CHOICES: Record<string, string[] | undefined> = {
  kidsAgeBand: ["FIVE_AND_UNDER", "SIX_TO_EIGHT", "NINE_TO_ELEVEN"],
  ageRatingOverrideV2: ["NONE", "NINE_PLUS", "THIRTEEN_PLUS", "SIXTEEN_PLUS", "EIGHTEEN_PLUS", "UNRATED"],
  ageRatingOverride: ["NONE", "NINE_PLUS", "THIRTEEN_PLUS", "SIXTEEN_PLUS", "SEVENTEEN_PLUS", "UNRATED"],
  koreaAgeRatingOverride: ["NONE", "ALL", "TWELVE_PLUS", "FIFTEEN_PLUS", "NINETEEN_PLUS"],
  developerAgeRatingInfoUrl: undefined,
  gracRatingClassificationNumber: undefined,
};

/** Every attribute app.json's ageRating can hold. */
export const AGE_RATING_KEYS = [...AGE_RATING_LEVELS, ...AGE_RATING_FLAGS, ...Object.keys(AGE_RATING_CHOICES)].sort();

/** Deprecated attributes pull leaves out of app.json. */
export const AGE_RATING_DEPRECATED = ["ageRatingOverride"];

export const CONTENT_RIGHTS = ["DOES_NOT_USE_THIRD_PARTY_CONTENT", "USES_THIRD_PARTY_CONTENT"];
export const RELEASE_TYPES = ["MANUAL", "AFTER_APPROVAL", "SCHEDULED"];

const REVIEW_TEXT_KEYS = REVIEW_KEYS.filter((key) => key !== "demoAccountRequired");

// MARK: Validating

/** Everything validate looks at, read from the store folder. */
export interface StoreSnapshot {
  /** app.json's text, when there is one. */
  appJson?: string;
  /** review-notes.txt, when there is one. */
  reviewNotes?: string;
  locales: {
    locale: string;
    /** Known files by name, like "name.txt" → "Lift". */
    files: Record<string, string>;
    /** Other files in the folder. */
    unknown: string[];
  }[];
  /** Files at the top of the store folder ship doesn't know. */
  unknown?: string[];
}

const problem = (file: string, message: string, severity: Problem["severity"] = "error", field?: string): Problem =>
  field ? { file, field, message, severity } : { file, message, severity };


/** Edit distance, for "did you mean". */
export function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** The closest of `choices` to a misspelled `name`, if one is close. */
export function suggest(name: string, choices: string[]): string | undefined {
  let best: { choice: string; score: number } | undefined;
  for (const choice of choices) {
    const score = distance(name.toLowerCase(), choice.toLowerCase());
    if (score <= Math.max(2, Math.floor(choice.length / 4)) && (!best || score < best.score)) best = { choice, score };
  }
  return best?.choice;
}

/** Unknown keys in an object, as problems naming the valid ones. */
function unknownKeys(value: Record<string, unknown>, known: string[], where: string): Problem[] {
  return Object.keys(value)
    .filter((key) => !known.includes(key))
    .map((key) => {
      const near = suggest(key, known);
      const field = where ? `${where}.${key}` : key;
      return problem("app.json", `Unknown key "${key}"${near ? ` (did you mean "${near}"?)` : ""}. Valid keys: ${known.join(", ")}`, "error", field);
    });
}

const isText = (value: unknown) => typeof value === "string";
const isTextOrNull = (value: unknown) => value === null || typeof value === "string";

function checkCategories(value: unknown): Problem[] {
  if (!isObject(value)) return [problem("app.json", 'categories should be an object like { "primary": "HEALTH_AND_FITNESS" }', "error", "categories")];
  const problems = unknownKeys(value, CATEGORY_KEYS, "categories");
  for (const key of ["primary", "secondary"]) {
    const id = value[key];
    if (id === undefined || id === null) continue;
    if (!isText(id) || !/^[A-Z][A-Z0-9_]*$/.test(id as string)) {
      problems.push(problem("app.json", `${key} should be an App Store category id like HEALTH_AND_FITNESS or GAMES`, "error", `categories.${key}`));
    }
  }
  if (value.primary === null || value.primary === "") {
    problems.push(problem("app.json", "Every app needs a primary category", "error", "categories.primary"));
  }
  for (const key of ["primarySubcategories", "secondarySubcategories"]) {
    const list = value[key];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list) || !list.every((id) => isText(id) && /^[A-Z][A-Z0-9_]*$/.test(id))) {
      problems.push(problem("app.json", `${key} should be a list of category ids like ["GAMES_PUZZLE"]`, "error", `categories.${key}`));
    } else if (list.length > LIMITS.subcategories) {
      problems.push(problem("app.json", `${key} can have at most ${LIMITS.subcategories} subcategories, not ${list.length}`, "error", `categories.${key}`));
    }
  }
  return problems;
}

function checkAgeRating(value: unknown): Problem[] {
  if (!isObject(value)) return [problem("app.json", 'ageRating should be an object like { "violenceCartoonOrFantasy": "NONE" }', "error", "ageRating")];
  const problems = unknownKeys(value, AGE_RATING_KEYS, "ageRating");
  for (const [key, rating] of Object.entries(value)) {
    const field = `ageRating.${key}`;
    if (rating === null) continue;
    if (AGE_RATING_LEVELS.includes(key)) {
      if (LEGACY_LEVELS.includes(rating as string)) {
        problems.push(problem("app.json", `${rating} is an older value; use ${rating === "INFREQUENT" ? "INFREQUENT_OR_MILD" : "FREQUENT_OR_INTENSE"}`, "warning", field));
      } else if (!LEVELS.includes(rating as string)) {
        problems.push(problem("app.json", `${key} should be one of ${LEVELS.join(", ")}, not ${JSON.stringify(rating)}`, "error", field));
      }
    } else if (AGE_RATING_FLAGS.includes(key)) {
      if (typeof rating !== "boolean") problems.push(problem("app.json", `${key} should be true or false, not ${JSON.stringify(rating)}`, "error", field));
    } else if (key in AGE_RATING_CHOICES) {
      const choices = AGE_RATING_CHOICES[key];
      if (!isText(rating)) problems.push(problem("app.json", `${key} should be text, not ${JSON.stringify(rating)}`, "error", field));
      else if (choices && !choices.includes(rating as string)) {
        problems.push(problem("app.json", `${key} should be one of ${choices.join(", ")} (or null), not ${JSON.stringify(rating)}`, "error", field));
      } else if (key === "developerAgeRatingInfoUrl" && rating && !isHttpUrl(rating as string)) {
        problems.push(problem("app.json", `${key} should be an http(s) URL`, "error", field));
      }
      if (AGE_RATING_DEPRECATED.includes(key)) problems.push(problem("app.json", `${key} is deprecated; use ageRatingOverrideV2`, "warning", field));
    }
  }
  return problems;
}

function checkReview(value: unknown): Problem[] {
  if (!isObject(value)) return [problem("app.json", "review should be an object with the App Review contact", "error", "review")];
  const problems = unknownKeys(value, REVIEW_KEYS, "review");
  for (const key of REVIEW_TEXT_KEYS) {
    if (value[key] !== undefined && !isTextOrNull(value[key])) problems.push(problem("app.json", `${key} should be text or null`, "error", `review.${key}`));
  }
  if (value.demoAccountRequired !== undefined && typeof value.demoAccountRequired !== "boolean") {
    problems.push(problem("app.json", "demoAccountRequired should be true or false", "error", "review.demoAccountRequired"));
  }
  const email = value.contactEmail;
  if (isText(email) && email && !isEmail(email as string)) {
    problems.push(problem("app.json", `contactEmail "${email}" isn't an email address`, "error", "review.contactEmail"));
  }
  const password = value.demoAccountPassword;
  if (isText(password)) {
    const plain = passwordProblem("app.json", "review.demoAccountPassword", password as string);
    if (plain) problems.push({ ...plain, code: PLAINTEXT_SECRET } as Problem);
  }
  if (value.demoAccountRequired === true) {
    if (!value.demoAccountName && value.demoAccountName !== undefined) {
      problems.push(problem("app.json", "demoAccountRequired is true, so App Review needs a demoAccountName", "error", "review.demoAccountName"));
    } else if (value.demoAccountName === undefined) {
      problems.push(problem("app.json", "demoAccountRequired is true but demoAccountName isn't here; App Store Connect keeps the one it has", "warning", "review.demoAccountName"));
    }
    if (password === undefined) {
      problems.push(
        problem(
          "app.json",
          "demoAccountRequired is true but demoAccountPassword isn't here; App Store Connect keeps the one it has. To manage it, save it with `ship secret set keychain:ship/<name> --stdin` and write that reference here",
          "warning",
          "review.demoAccountPassword",
        ),
      );
    } else if (!password) {
      problems.push(problem("app.json", "demoAccountRequired is true, so App Review needs a demoAccountPassword (a reference like keychain:ship/<name>)", "error", "review.demoAccountPassword"));
    }
  }
  return problems;
}

function checkRelease(value: unknown): Problem[] {
  if (!isObject(value)) return [problem("app.json", 'release should be an object like { "type": "AFTER_APPROVAL" }', "error", "release")];
  const problems = unknownKeys(value, RELEASE_KEYS, "release");
  if (value.type !== undefined && !RELEASE_TYPES.includes(value.type as string)) {
    problems.push(problem("app.json", `type should be one of ${RELEASE_TYPES.join(", ")}, not ${JSON.stringify(value.type)}`, "error", "release.type"));
  }
  if (value.phased !== undefined && typeof value.phased !== "boolean") {
    problems.push(problem("app.json", "phased should be true or false", "error", "release.phased"));
  }
  return problems;
}

/** Problems in app.json's text: bad JSON, unknown keys, values Apple doesn't take. */
export function checkAppJson(text: string): Problem[] {
  let json: unknown;
  try {
    json = text.trim() ? JSON.parse(text) : {};
  } catch (error) {
    return [problem("app.json", `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`)];
  }
  if (!isObject(json)) return [problem("app.json", "Should hold a JSON object ({ … })")];
  const problems = unknownKeys(json, APP_KEYS, "");
  if (json.categories !== undefined) problems.push(...checkCategories(json.categories));
  if (json.contentRights !== undefined && json.contentRights !== null && !CONTENT_RIGHTS.includes(json.contentRights as string)) {
    problems.push(problem("app.json", `contentRights should be one of ${CONTENT_RIGHTS.join(", ")}, not ${JSON.stringify(json.contentRights)}`, "error", "contentRights"));
  }
  if (json.copyright !== undefined && !isTextOrNull(json.copyright)) problems.push(problem("app.json", "copyright should be text, like \"2026 Your Name\"", "error", "copyright"));
  if (json.ageRating !== undefined) problems.push(...checkAgeRating(json.ageRating));
  if (json.review !== undefined) problems.push(...checkReview(json.review));
  if (json.release !== undefined) problems.push(...checkRelease(json.release));
  return problems;
}

/** Problems in one locale folder's files. */
export function checkLocale(locale: string, files: Record<string, string>, unknown: string[] = []): Problem[] {
  const problems: Problem[] = [];
  const at = (file: string) => `${locale}/${file}`;
  if (!ASC_LOCALES.includes(locale)) {
    const near = suggest(locale, ASC_LOCALES);
    problems.push(problem(locale, `App Store Connect doesn't list ${locale} as a language${near ? ` (did you mean ${near}?)` : ""}`, "warning"));
  }
  for (const name of unknown) {
    const near = suggest(name, LOCALE_FIELDS.map((entry) => entry.file));
    problems.push(problem(at(name), `ship doesn't use this file${near ? `; did you mean ${near}?` : ""}`, "warning"));
  }
  for (const entry of LOCALE_FIELDS) {
    const value = files[entry.file];
    if (value === undefined) continue;
    const file = at(entry.file);
    if (entry.url && value && !isHttpUrl(value)) problems.push(problem(file, `"${value}" isn't an http(s) URL`, "error", entry.field));
    if (entry.url && value.includes("\n")) problems.push(problem(file, "A URL file holds one line", "error", entry.field));
    if (entry.max !== undefined && chars(value) > entry.max) {
      problems.push(problem(file, `${chars(value)} characters; the limit is ${entry.max}`, "error", entry.field));
    }
  }
  const name = files["name.txt"];
  if (name !== undefined) {
    if (!name.trim()) problems.push(problem(at("name.txt"), "The app's name can't be empty", "error", "name"));
    else if (chars(name) < LIMITS.nameMin) problems.push(problem(at("name.txt"), `The name needs at least ${LIMITS.nameMin} characters`, "error", "name"));
    if (name.includes("\n")) problems.push(problem(at("name.txt"), "The name is one line", "error", "name"));
  }
  const subtitle = files["subtitle.txt"];
  if (subtitle?.includes("\n")) problems.push(problem(at("subtitle.txt"), "The subtitle is one line", "error", "subtitle"));
  const keywords = files["keywords.txt"];
  if (keywords !== undefined) problems.push(...checkKeywords(at("keywords.txt"), keywords, name));
  const hasVersionFiles = LOCALE_FIELDS.some((entry) => entry.target === "version" && files[entry.file] !== undefined);
  const description = files["description.txt"];
  if (hasVersionFiles && description === undefined) {
    problems.push(problem(at("description.txt"), "No description for this language; App Review needs one", "warning", "description"));
  } else if (description === "") {
    problems.push(problem(at("description.txt"), "The description is empty; App Review needs one", "warning", "description"));
  }
  return problems;
}

/** Keywords: 100 bytes once joined with commas, and worth a look when repeated or the same as the name. */
export function checkKeywords(file: string, text: string, name?: string): Problem[] {
  const problems: Problem[] = [];
  const joined = keywordsToApi(text);
  if (bytes(joined) > LIMITS.keywordBytes) {
    problems.push(problem(file, `${bytes(joined)} bytes once joined with commas; the limit is ${LIMITS.keywordBytes} (accented letters and non-Latin scripts take 2 to 4 bytes each)`, "error", "keywords"));
  }
  const lines = text.split("\n");
  if (lines.some((line) => !line.trim()) && lines.length > 1) problems.push(problem(file, "Has empty lines; they're dropped", "warning", "keywords"));
  if (lines.some((line) => line.includes(","))) problems.push(problem(file, "Write one keyword per line; commas split a line into several", "warning", "keywords"));
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const keyword of keywordList(text)) {
    const key = keyword.toLowerCase();
    if (seen.has(key)) repeated.add(keyword);
    seen.add(key);
  }
  if (repeated.size) problems.push(problem(file, `Repeated: ${[...repeated].join(", ")}`, "warning", "keywords"));
  const appName = name?.trim().toLowerCase();
  if (appName && seen.has(appName)) problems.push(problem(file, "A keyword is the app's name, which is already searched; use the room for something else", "warning", "keywords"));
  return problems;
}

/** Every problem in the store folder: app.json, review notes, and each locale folder. */
export function validateSnapshot(snapshot: StoreSnapshot): Problem[] {
  const problems: Problem[] = [];
  if (snapshot.appJson !== undefined) problems.push(...checkAppJson(snapshot.appJson));
  if (snapshot.reviewNotes !== undefined && chars(snapshot.reviewNotes) > LIMITS.reviewNotes) {
    problems.push(problem(REVIEW_NOTES_FILE, `${chars(snapshot.reviewNotes)} characters; the limit is ${LIMITS.reviewNotes}`, "error", "notes"));
  }
  for (const name of snapshot.unknown ?? []) {
    const near = suggest(name, STORE_FILES);
    problems.push(problem(name, `ship doesn't use this file${near ? `; did you mean ${near}?` : ""}`, "warning"));
  }
  for (const { locale, files, unknown } of snapshot.locales) problems.push(...checkLocale(locale, files, unknown));
  return problems;
}
