// The store folder: the App Store page and TestFlight info as files in the
// repo (appstore/ next to ship.json by default), so a pull request shows
// exactly what changes on the page. This file has what every reader and
// writer shares: paths, text files, locale folders, and app.json.
//
// Rules: a missing file means "not managed" (push leaves that field alone);
// an empty file means "clear it". Text has one trailing newline; reads
// normalize CRLF and trim trailing whitespace. Passwords are references
// (keychain:, op://, env:, file:), never plaintext.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Project } from "../config";
import type { Change } from "../diff";
import { ShipError } from "../ui";

/** The store folder's default name, next to ship.json. */
export const STORE_DEFAULT = "appstore";

/** What a push did (or with dryRun, would do). */
export interface PushResult {
  changes: Change[];
  /** Whether the changes were sent to App Store Connect. */
  applied: boolean;
  /** Fields left alone, and why (like "the version is in review"). */
  skipped: { scope: string; field: string; reason: string }[];
}

// MARK: Text files

/** Reads a text file as the store keeps it: CRLF → LF, trailing whitespace trimmed. undefined when missing. */
export async function readText(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  return (await file.text()).replace(/\r\n?/g, "\n").trimEnd();
}

/** Writes text with one trailing newline; creates folders. An empty value makes an empty file. */
export async function writeText(path: string, value: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const text = value.replace(/\r\n?/g, "\n").trimEnd();
  await Bun.write(path, text ? `${text}\n` : "");
}

// MARK: Locales

/** A locale folder's name: en-US, zh-Hans, ca, pt-BR. */
export const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/;

/** The locales App Store Connect accepts. A folder for another locale only warns. */
export const ASC_LOCALES: string[] = [
  "ar-SA", "ca", "cs", "da", "de-DE", "el", "en-AU", "en-CA", "en-GB", "en-US", "es-ES", "es-MX", "fi", "fr-CA", "fr-FR",
  "he", "hi", "hr", "hu", "id", "it", "ja", "ko", "ms", "nl-NL", "no", "pl", "pt-BR", "pt-PT", "ro", "ru", "sk", "sv",
  "th", "tr", "uk", "vi", "zh-Hans", "zh-Hant",
  // Added by Apple in 2025.
  "bn-BD", "gu-IN", "kn-IN", "ml-IN", "mr-IN", "or-IN", "pa-IN", "sl-SI", "ta-IN", "te-IN", "ur-PK",
];

/** Folders in `root` that look like locales, sorted. testflight/, screenshots/, previews/, and dotfiles never match. */
export function localeDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && LOCALE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

// MARK: app.json

/** The App Store Review contact and demo account (AppStoreReviewDetail). */
export interface ReviewDetails {
  contactFirstName?: string | null;
  contactLastName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  demoAccountRequired?: boolean;
  demoAccountName?: string | null;
  /** A secret reference, never the password. */
  demoAccountPassword?: string | null;
}

/** app.json: the app-level parts of the page that aren't per locale. */
export interface StoreApp {
  /** appCategories ids, like HEALTH_AND_FITNESS; games add subcategories like GAMES_PUZZLE. */
  categories?: {
    primary?: string | null;
    primarySubcategories?: string[];
    secondary?: string | null;
    secondarySubcategories?: string[];
  };
  /** App.contentRightsDeclaration. */
  contentRights?: "DOES_NOT_USE_THIRD_PARTY_CONTENT" | "USES_THIRD_PARTY_CONTENT" | null;
  /** AppStoreVersion.copyright, like "2026 Tyler Becks". */
  copyright?: string | null;
  /** AgeRatingDeclaration attributes, with Apple's names and values. */
  ageRating?: Record<string, string | boolean | null>;
  review?: ReviewDetails;
  /** Defaults for `ship release`. */
  release?: {
    /** AppStoreVersion.releaseType. */
    type?: "MANUAL" | "AFTER_APPROVAL" | "SCHEDULED";
    /** Release over 7 days to people with automatic updates on. */
    phased?: boolean;
  };
}

const APP_KEYS = ["categories", "contentRights", "copyright", "ageRating", "review", "release"];
const CATEGORY_KEYS = ["primary", "primarySubcategories", "secondary", "secondarySubcategories"];
const REVIEW_KEYS = ["contactFirstName", "contactLastName", "contactEmail", "contactPhone", "demoAccountRequired", "demoAccountName", "demoAccountPassword"];
const RELEASE_KEYS = ["type", "phased"];

/** An object's keys in `order` first, then the rest alphabetically. */
function ordered(value: Record<string, unknown>, order: string[] = []): Record<string, unknown> {
  const rest = Object.keys(value)
    .filter((key) => !order.includes(key))
    .sort();
  return Object.fromEntries([...order.filter((key) => key in value), ...rest].map((key) => [key, value[key]]));
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** app.json in a stable key order, so a pull never reorders it. */
export function orderStoreApp(app: StoreApp): StoreApp {
  const top = ordered(app as Record<string, unknown>, APP_KEYS);
  const nested: Record<string, string[] | undefined> = { categories: CATEGORY_KEYS, ageRating: [], review: REVIEW_KEYS, release: RELEASE_KEYS };
  for (const [key, order] of Object.entries(nested)) {
    if (isObject(top[key])) top[key] = ordered(top[key] as Record<string, unknown>, order);
  }
  return top as StoreApp;
}

/** The store folder's app.json. */
export const storeAppPath = (project: Project) => join(project.storeDir, "app.json");

/** Reads app.json, or undefined when there isn't one. Bad JSON is an error naming the file. */
export async function readStoreApp(project: Project): Promise<StoreApp | undefined> {
  const path = storeAppPath(project);
  const text = await readText(path);
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new ShipError(
      `${path} isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "bad-store-file",
      `Fix ${path} (a missing comma or quote?), or delete it and pull it again.`,
      { file: path },
    );
  }
  if (!isObject(json)) {
    throw new ShipError(`${path} should hold a JSON object`, "bad-store-file", `Start it with { and end it with }, or delete it and pull it again.`, { file: path });
  }
  return json as StoreApp;
}

/** Writes app.json in a stable key order, 2-space JSON, with a trailing newline. */
export async function writeStoreApp(project: Project, app: StoreApp): Promise<void> {
  await writeText(storeAppPath(project), JSON.stringify(orderStoreApp(app), null, 2));
}
