// Moving from fastlane: reads a fastlane deliver folder (fastlane/metadata,
// fastlane/screenshots) and writes the store-folder files it becomes, the
// same files a pull would. Like pull, it won't overwrite a file that differs
// unless asked to.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Project } from "../config";
import { ShipError } from "../ui";
import { LOCALE_PATTERN, type StoreApp, readStoreApp, readText, writeStoreApp, writeText } from "./files";
import { SCREENSHOT_EXTENSIONS, SCREENSHOT_TYPES, type ScreenshotType, imageInfo, naturalCompare, sizesFor } from "./images";
import { REVIEW_NOTES_FILE, keywordsFromApi } from "./limits";

/** fastlane's per-language files, and the store file each becomes. */
export const FASTLANE_LOCALE_FILES: Record<string, string> = {
  "name.txt": "name.txt",
  "subtitle.txt": "subtitle.txt",
  "privacy_url.txt": "privacy-policy-url.txt",
  "description.txt": "description.txt",
  "keywords.txt": "keywords.txt",
  "promotional_text.txt": "promotional-text.txt",
  "release_notes.txt": "whats-new.txt",
  "support_url.txt": "support-url.txt",
  "marketing_url.txt": "marketing-url.txt",
};

/** fastlane's per-language files ship has no place for. */
const SKIPPED_LOCALE_FILES: Record<string, string> = {
  "apple_tv_privacy_policy.txt": "the Apple TV privacy policy isn't in the store folder yet",
};

/** fastlane's category files, and where each goes in app.json's categories. */
const CATEGORY_FILES = {
  "primary_category.txt": "primary",
  "secondary_category.txt": "secondary",
  "primary_first_sub_category.txt": "primarySubcategories",
  "primary_second_sub_category.txt": "primarySubcategories",
  "secondary_first_sub_category.txt": "secondarySubcategories",
  "secondary_second_sub_category.txt": "secondarySubcategories",
} as const;

/** fastlane's review_information files, and the app.json review key each becomes. */
const REVIEW_FILES: Record<string, "contactFirstName" | "contactLastName" | "contactEmail" | "contactPhone" | "demoAccountName"> = {
  "first_name.txt": "contactFirstName",
  "last_name.txt": "contactLastName",
  "email_address.txt": "contactEmail",
  "phone_number.txt": "contactPhone",
  "demo_user.txt": "demoAccountName",
};

export interface FastlaneMetadata {
  /** The folder read, like /repo/fastlane/metadata. */
  from: string;
  /** Store files by path in the store folder, like "en-US/name.txt" or "review-notes.txt". */
  files: Record<string, string>;
  /** What goes in app.json (only what fastlane had). */
  app: StoreApp;
  /** What wasn't brought over, and why. */
  warnings: string[];
}

export interface FastlaneScreenshots {
  from: string;
  /** Each image and where it goes, like en-US/screenshots/APP_IPHONE_67/01-home.png. */
  copies: { from: string; to: string }[];
  warnings: string[];
}

/** A fastlane folder's subfolder (`metadata` or `screenshots`): <dir>/<name>, or <dir> itself when it's already that folder. */
export function fastlaneFolder(dir: string, name: "metadata" | "screenshots"): string {
  const root = resolve(dir);
  const inside = join(root, name);
  if (existsSync(inside) && statSync(inside).isDirectory()) return inside;
  if (basename(root) === name && existsSync(root)) return root;
  throw new ShipError(
    `No fastlane ${name} folder in ${dir}`,
    "no-fastlane",
    `Point --from at the fastlane folder (the one with ${name}/ in it), like --from ./fastlane.`,
    { dir: root },
  );
}

const subfolders = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];

/**
 * A fastlane category as App Store Connect's id: HEALTH_AND_FITNESS from
 * itself, from "MZGenre.HealthAndFitness", or from "Health & Fitness".
 */
export function categoryId(value: string): string | undefined {
  const raw = value.trim().replace(/^MZGenre\./, "").replace(/^Apps\./, "");
  if (!raw) return undefined;
  if (/^[A-Z][A-Z0-9_]*$/.test(raw)) return raw;
  const words = raw
    .replace(/&/g, " and ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return words.length ? words.join("_").toUpperCase() : undefined;
}

/** What a fastlane metadata folder becomes in the store folder. */
export async function readFastlaneMetadata(dir: string): Promise<FastlaneMetadata> {
  const from = fastlaneFolder(dir, "metadata");
  const files: Record<string, string> = {};
  const warnings: string[] = [];
  const locales = subfolders(from).filter((name) => LOCALE_PATTERN.test(name));
  const others = subfolders(from).filter((name) => !LOCALE_PATTERN.test(name) && !["default", "review_information", "trade_representative_contact_information"].includes(name));
  for (const name of others) warnings.push(`Skipped ${name}/: it isn't a language App Store Connect knows`);
  if (subfolders(from).includes("trade_representative_contact_information")) warnings.push("Skipped trade_representative_contact_information/: set it in App Store Connect (App Information)");

  // default/ fills in what a language folder doesn't have, as deliver does.
  const defaults = join(from, "default");
  if (existsSync(defaults) && !locales.length) warnings.push("Skipped default/: there's no language folder for it to fill in");
  for (const locale of locales) {
    for (const [source, target] of Object.entries(FASTLANE_LOCALE_FILES)) {
      const text = (await readText(join(from, locale, source))) ?? (await readText(join(defaults, source)));
      if (text === undefined) continue;
      files[`${locale}/${target}`] = source === "keywords.txt" ? keywordsFromApi(text) : text;
    }
    for (const [source, reason] of Object.entries(SKIPPED_LOCALE_FILES)) {
      if (await readText(join(from, locale, source))) warnings.push(`Skipped ${locale}/${source}: ${reason}`);
    }
  }

  const app: StoreApp = {};
  const copyright = await readText(join(from, "copyright.txt"));
  if (copyright) app.copyright = copyright;

  const categories: NonNullable<StoreApp["categories"]> = {};
  for (const [source, key] of Object.entries(CATEGORY_FILES)) {
    const text = await readText(join(from, source));
    if (!text) continue;
    const id = categoryId(text);
    if (!id) continue;
    if (id !== text.trim()) warnings.push(`${source}: "${text.trim()}" became ${id}; \`ship metadata validate\` and push check it`);
    if (key === "primary" || key === "secondary") categories[key] = id;
    else categories[key] = [...(categories[key] ?? []), id];
  }
  if (Object.keys(categories).length) app.categories = categories;

  const reviewDir = join(from, "review_information");
  const review: NonNullable<StoreApp["review"]> = {};
  for (const [source, key] of Object.entries(REVIEW_FILES)) {
    const text = await readText(join(reviewDir, source));
    if (text) review[key] = text;
  }
  if (review.demoAccountName) review.demoAccountRequired = true;
  if (await readText(join(reviewDir, "demo_password.txt"))) {
    warnings.push(
      `review_information/demo_password.txt holds the password itself, and ship keeps only a reference. Save it with \`ship secret set keychain:ship/demo-password --from-file ${join(reviewDir, "demo_password.txt")}\`, then set "demoAccountPassword": "keychain:ship/demo-password" in app.json`,
    );
  }
  if (Object.keys(review).length) app.review = review;
  const notes = await readText(join(reviewDir, "notes.txt"));
  if (notes) files[REVIEW_NOTES_FILE] = notes;
  if (await readText(join(from, "app_rating_config.json"))) warnings.push("Skipped app_rating_config.json: answer the age rating questions in app.json's ageRating (`ship metadata pull` writes them)");

  return { from, files, app, warnings };
}

/** The screenshot display type an image this size fits, preferring a type named in its file name. */
export function screenshotTypeFor(width: number, height: number, fileName = ""): ScreenshotType | undefined {
  const types = (Object.keys(SCREENSHOT_TYPES) as ScreenshotType[]).filter((type) => !type.startsWith("IMESSAGE_"));
  const fits = types.filter((type) => sizesFor(type).some(([w, h]) => w === width && h === height));
  const named = fits.find((type) => fileName.toUpperCase().includes(type));
  return named ?? fits[0];
}

/** A file name for the store folder: lowercase, dashes for spaces and odd characters. */
const cleanName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-(?=\.)/g, "");

/** What a fastlane screenshots folder becomes: each image in its display type's folder, numbered in fastlane's order. */
export async function readFastlaneScreenshots(dir: string): Promise<FastlaneScreenshots> {
  const from = fastlaneFolder(dir, "screenshots");
  const copies: { from: string; to: string }[] = [];
  const warnings: string[] = [];
  for (const locale of subfolders(from)) {
    if (!LOCALE_PATTERN.test(locale)) {
      warnings.push(`Skipped ${locale}/: it isn't a language App Store Connect knows`);
      continue;
    }
    if (subfolders(join(from, locale)).length) warnings.push(`Skipped the folders in ${locale}/ (like iMessage/): put those in appstore/${locale}/screenshots/<type>/ by hand`);
    const images = readdirSync(join(from, locale), { withFileTypes: true })
      .filter((entry) => entry.isFile() && SCREENSHOT_EXTENSIONS.includes(extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort(naturalCompare);
    const byType = new Map<ScreenshotType, string[]>();
    for (const name of images) {
      const info = imageInfo(new Uint8Array(await Bun.file(join(from, locale, name)).arrayBuffer()));
      const type = info && screenshotTypeFor(info.width, info.height, name);
      if (!type) {
        warnings.push(`Skipped ${locale}/${name}: ${info ? `${info.width}x${info.height} isn't a screenshot size App Store Connect takes` : "ship can't read it as a PNG or JPEG"}`);
        continue;
      }
      byType.set(type, [...(byType.get(type) ?? []), name]);
    }
    for (const [type, names] of byType) {
      names.forEach((name, i) => {
        // fastlane names often start with their own number; ship's order prefix replaces it.
        const stem = cleanName(name.replace(/^\d+[_-]?/, "")) || `screenshot${extname(name).toLowerCase()}`;
        copies.push({ from: join(from, locale, name), to: `${locale}/screenshots/${type}/${String(i + 1).padStart(2, "0")}-${stem}` });
      });
    }
  }
  return { from, copies, warnings };
}

// MARK: Writing

export interface ImportResult {
  from: string;
  written: string[];
  unchanged: string[];
  warnings: string[];
  dryRun: boolean;
}

function conflictError(conflicts: string[], storeDir: string, command: string): ShipError {
  return new ShipError(
    `${conflicts.length} file${conflicts.length === 1 ? "" : "s"} in ${storeDir} already say${conflicts.length === 1 ? "s" : ""} something else:\n  ${conflicts.join("\n  ")}`,
    "local-changes",
    `Keep yours (leave it), or pass --force to replace ${conflicts.length === 1 ? "it" : "them"} with fastlane's: ship ${command} import --force`,
    { files: conflicts },
  );
}

/** app.json with fastlane's values laid over it, and the keys whose value it changes from one already there. */
export function mergeStoreApp(existing: StoreApp, imported: StoreApp): { app: StoreApp; replaced: string[] } {
  const app: StoreApp = { ...existing };
  const replaced: string[] = [];
  const differs = (a: unknown, b: unknown) => a !== undefined && a !== null && a !== "" && JSON.stringify(a) !== JSON.stringify(b);
  if (imported.copyright !== undefined) {
    if (differs(existing.copyright, imported.copyright)) replaced.push("copyright");
    app.copyright = imported.copyright;
  }
  for (const section of ["categories", "review"] as const) {
    const values = imported[section] as Record<string, unknown> | undefined;
    if (!values) continue;
    const current = { ...((existing[section] as Record<string, unknown> | undefined) ?? {}) };
    for (const [key, value] of Object.entries(values)) {
      if (differs(current[key], value)) replaced.push(`${section}.${key}`);
      current[key] = value;
    }
    (app as Record<string, unknown>)[section] = current;
  }
  return { app, replaced };
}

/** Writes a fastlane metadata folder into the store folder. */
export async function importMetadata(project: Project, options: { from: string; force?: boolean; dryRun?: boolean }): Promise<ImportResult> {
  const read = await readFastlaneMetadata(options.from);
  const written: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  const writes: [string, string][] = [];
  for (const [path, text] of Object.entries(read.files)) {
    const current = await readText(join(project.storeDir, path));
    const next = text.replace(/\r\n?/g, "\n").trimEnd();
    if (current === next) unchanged.push(path);
    else if (current && !options.force) conflicts.push(path);
    else writes.push([path, next]);
  }
  const existing = (await readStoreApp(project)) ?? {};
  const { app, replaced } = mergeStoreApp(existing, read.app);
  const appChanged = Object.keys(read.app).length > 0 && JSON.stringify(app) !== JSON.stringify(existing);
  if (replaced.length && !options.force) conflicts.push(...replaced.map((key) => `app.json (${key})`));
  if (conflicts.length) throw conflictError(conflicts, project.storeDir, "metadata");
  if (!options.dryRun) {
    for (const [path, text] of writes) await writeText(join(project.storeDir, path), text);
    if (appChanged) await writeStoreApp(project, app);
  }
  written.push(...writes.map(([path]) => path), ...(appChanged ? ["app.json"] : []));
  if (Object.keys(read.app).length && !appChanged) unchanged.push("app.json");
  return { from: read.from, written: written.sort(), unchanged: unchanged.sort(), warnings: read.warnings, dryRun: Boolean(options.dryRun) };
}

/** Copies a fastlane screenshots folder into the store folder, one folder per display type. */
export async function importScreenshots(project: Project, options: { from: string; force?: boolean; dryRun?: boolean }): Promise<ImportResult> {
  const read = await readFastlaneScreenshots(options.from);
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  const copies: { from: string; to: string }[] = [];
  for (const copy of read.copies) {
    const target = join(project.storeDir, copy.to);
    if (!existsSync(target)) copies.push(copy);
    else if (Buffer.compare(Buffer.from(await Bun.file(target).arrayBuffer()), Buffer.from(await Bun.file(copy.from).arrayBuffer())) === 0) unchanged.push(copy.to);
    else if (options.force) copies.push(copy);
    else conflicts.push(copy.to);
  }
  if (conflicts.length) throw conflictError(conflicts, project.storeDir, "screenshots");
  if (!options.dryRun) {
    for (const copy of copies) {
      const target = join(project.storeDir, copy.to);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(copy.from, target);
    }
  }
  return { from: read.from, written: copies.map((copy) => copy.to).sort(), unchanged: unchanged.sort(), warnings: read.warnings, dryRun: Boolean(options.dryRun) };
}
