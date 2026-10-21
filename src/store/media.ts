// Screenshots and app previews as files in the store folder, kept in sync
// with App Store Connect:
//
//   appstore/<locale>/screenshots/<display type>/01-home.png
//   appstore/<locale>/previews/<preview type>/01-intro.mp4
//
// Files show in file name order. A file matches an uploaded one when its MD5
// is the upload's sourceFileChecksum. Pulled files are re-encoded by Apple's
// CDN, so their bytes differ from the original; media.lock.json remembers
// which local file stands for which upload, so a pull followed by a push
// changes nothing.
//
// A locale's screenshots/ (or previews/) folder is what makes ship manage
// them; without one, push leaves that locale's screenshots alone, even with
// --prune.

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import {
  type MediaAsset,
  type MediaKind,
  type MediaSet,
  type VersionLocalization,
  commitMedia,
  createMediaSet,
  createVersionLocalization,
  deleteMediaAsset,
  deleteMediaSet,
  download,
  mediaAssets,
  mediaSets,
  reorderMedia,
  reserveMedia,
  screenshotUrl,
  stateErrors,
  uploadParts,
  versionLocalizations,
  waitForMedia,
} from "../asc/media";
import { type AppStoreVersion, LIVE_VERSION_STATES, appStoreVersions, isEditableVersion } from "../asc/versions";
import type { Project } from "../config";
import type { Change } from "../diff";
import { type Platform, platformInfo } from "../platform";
import { ShipError, ui } from "../ui";
import type { Problem } from "./check";
import { ASC_LOCALES, type PushResult, localeDirs } from "./files";
import {
  MAX_PREVIEWS,
  MAX_PREVIEW_BYTES,
  MAX_SCREENSHOTS,
  PREVIEW_EXTENSIONS,
  PREVIEW_TYPES,
  SCREENSHOT_EXTENSIONS,
  SCREENSHOT_TYPES,
  fileMd5,
  imageInfo,
  isPreviewType,
  isScreenshotType,
  md5,
  naturalCompare,
  previewMimeType,
  sizeProblem,
  typePlatform,
} from "./images";

export type { MediaKind } from "../asc/media";

export const MEDIA_KINDS: MediaKind[] = ["screenshots", "previews"];

const NOUN: Record<MediaKind, [string, string]> = { screenshots: ["screenshot", "screenshots"], previews: ["preview", "previews"] };
const MAX: Record<MediaKind, number> = { screenshots: MAX_SCREENSHOTS, previews: MAX_PREVIEWS };
const EXTENSIONS: Record<MediaKind, string[]> = { screenshots: SCREENSHOT_EXTENSIONS, previews: PREVIEW_EXTENSIONS };

const plural = (count: number, kind: MediaKind) => `${count} ${NOUN[kind][count === 1 ? 0 : 1]}`;

/** Which locales and types a command works on; empty means all. */
export interface MediaFilter {
  locales?: string[];
  types?: string[];
}

const wanted = (list: string[] | undefined, value: string) => !list?.length || list.includes(value);

// MARK: Local files

export interface LocalFile {
  /** Relative to the store folder, with "/": en-US/screenshots/APP_IPHONE_67/01-home.png. */
  path: string;
  name: string;
  /** Absolute. */
  file: string;
  size: number;
  /** Filled in by hashSet. */
  md5?: string;
}

/** One type folder: en-US/screenshots/APP_IPHONE_67/. */
export interface LocalSet {
  locale: string;
  kind: MediaKind;
  type: string;
  /** The media files in display order. */
  files: LocalFile[];
  /** Other files in the folder, which push skips (relative paths). */
  ignored: string[];
}

export interface LocalMedia {
  sets: LocalSet[];
  /** The locales and kinds whose folder exists, so ship manages them. */
  managed: { locale: string; kind: MediaKind }[];
  /** Files sitting in a screenshots/ or previews/ folder instead of a type folder inside it. */
  stray: string[];
}

const visible = (name: string) => !name.startsWith(".");

/** Every screenshot and preview folder in the store, filtered, with files in display order. */
export function localMedia(storeDir: string, filter: MediaFilter = {}): LocalMedia {
  const result: LocalMedia = { sets: [], managed: [], stray: [] };
  for (const locale of localeDirs(storeDir)) {
    if (!wanted(filter.locales, locale)) continue;
    for (const kind of MEDIA_KINDS) {
      const kindDir = join(storeDir, locale, kind);
      if (!existsSync(kindDir) || !statSync(kindDir).isDirectory()) continue;
      result.managed.push({ locale, kind });
      for (const entry of readdirSync(kindDir, { withFileTypes: true }).filter((e) => visible(e.name))) {
        if (!entry.isDirectory()) {
          result.stray.push(`${locale}/${kind}/${entry.name}`);
          continue;
        }
        const type = entry.name;
        if (!wanted(filter.types, type)) continue;
        const set: LocalSet = { locale, kind, type, files: [], ignored: [] };
        const typeDir = join(kindDir, type);
        const names = readdirSync(typeDir, { withFileTypes: true })
          .filter((e) => visible(e.name))
          .map((e) => ({ name: e.name, isFile: e.isFile() }))
          .sort((a, b) => naturalCompare(a.name, b.name));
        for (const { name, isFile } of names) {
          const path = `${locale}/${kind}/${type}/${name}`;
          if (!isFile || !EXTENSIONS[kind].includes(extname(name).toLowerCase())) {
            set.ignored.push(path);
            continue;
          }
          const file = join(typeDir, name);
          set.files.push({ path, name, file, size: statSync(file).size });
        }
        result.sets.push(set);
      }
    }
  }
  return result;
}

/** Fills in each file's MD5. */
export async function hashSet(set: LocalSet): Promise<LocalSet> {
  for (const file of set.files) file.md5 ??= await fileMd5(file.file);
  return set;
}

// MARK: The lock file

export const LOCK_FILE = "media.lock.json";

/** Local path → the local file's MD5 and the upload's sourceFileChecksum it stands for. */
export type MediaLock = Record<string, { md5: string; checksum: string }>;

export const lockPath = (storeDir: string) => join(storeDir, LOCK_FILE);

export async function readLock(storeDir: string): Promise<MediaLock> {
  const path = lockPath(storeDir);
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  let json: unknown;
  try {
    const text = await file.text();
    json = text.trim() ? JSON.parse(text) : {};
  } catch (error) {
    throw new ShipError(
      `${path} isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "bad-store-file",
      `Fix ${path} (a merge conflict?), or delete it and run \`ship screenshots pull\` to make it again.`,
      { file: path },
    );
  }
  const lock: MediaLock = {};
  if (typeof json !== "object" || json === null || Array.isArray(json)) return lock;
  for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
    const entry = value as { md5?: unknown; checksum?: unknown } | null;
    if (typeof entry?.md5 === "string" && typeof entry.checksum === "string") lock[key] = { md5: entry.md5, checksum: entry.checksum };
  }
  return lock;
}

/** The lock with `uploaded` files recorded (their MD5 is the checksum) and `removed` paths dropped, keys sorted. */
export function updateLock(lock: MediaLock, changes: { uploaded?: { path: string; md5: string }[]; removed?: string[] }): MediaLock {
  const next: MediaLock = { ...lock };
  for (const { path, md5 } of changes.uploaded ?? []) next[path] = { md5, checksum: md5 };
  for (const path of changes.removed ?? []) delete next[path];
  return sortLock(next);
}

/** Sorted keys, each entry md5 then checksum, so the file never churns. */
export const sortLock = (lock: MediaLock): MediaLock =>
  Object.fromEntries(
    Object.keys(lock)
      .sort()
      .map((key) => [key, { md5: lock[key]!.md5, checksum: lock[key]!.checksum }]),
  );

/** Writes the lock without entries for files that are gone. Doesn't create an empty one. */
export async function writeLock(storeDir: string, lock: MediaLock): Promise<void> {
  const kept = sortLock(Object.fromEntries(Object.entries(lock).filter(([path]) => existsSync(join(storeDir, path)))));
  const path = lockPath(storeDir);
  if (!Object.keys(kept).length && !existsSync(path)) return;
  mkdirSync(storeDir, { recursive: true });
  await Bun.write(path, `${JSON.stringify(kept, null, 2)}\n`);
}

// MARK: Planning

/** One remote screenshot or preview, as the plan sees it. */
export interface RemoteItem {
  id: string;
  fileName: string;
  checksum?: string;
  /** A failed or never-finished upload, which push always deletes. */
  broken?: boolean;
}

export interface PlanInput {
  locale: string;
  kind: MediaKind;
  type: string;
  /** The repo's files in display order. */
  local: { path: string; md5: string }[];
  /** App Store Connect's, in display order. */
  remote: RemoteItem[];
  lock: MediaLock;
  prune?: boolean;
}

/** What push does to one set. The JSON fields are an API. */
export interface SetPlan {
  locale: string;
  type: string;
  kind: MediaKind;
  /** New files to upload. */
  upload: string[];
  /** Changed files to upload in place of the one uploaded before. */
  replace: string[];
  /** Remote file names to delete. */
  delete: string[];
  /** Remote files that aren't in the repo and stay (without --prune), after the repo's. */
  keep: number;
  /** Whether the order changes (beyond adding new files at the end). */
  reorder: boolean;
  /** Delete the whole set (--prune, and its folder is gone). */
  deleteSet?: boolean;
}

/** A plan with the ids push needs. */
export interface FullPlan extends SetPlan {
  /** Local path → the remote id it matches. */
  matched: Map<string, string>;
  deleteIds: string[];
  /** Remote id → the local file a replacement upload stands for (for the change's "from"). */
  replaced: Map<string, RemoteItem>;
  keptIds: string[];
  /** The order push ends with: remote ids, and "local:<path>" for uploads. */
  order: string[];
  /** The input, for changes and rendering. */
  input: PlanInput;
}

const LOCAL = "local:";

/**
 * What to do to one set so App Store Connect matches the repo. A local file
 * matches an upload when its MD5 is the upload's checksum, or when the lock
 * says this path stands for that upload and the file hasn't changed since. A
 * locked file that changed replaces its upload: the new one goes up and the
 * old one is deleted. Uploads nobody matches are deleted with --prune, and
 * otherwise kept after the repo's files.
 */
export function planSet(input: PlanInput): FullPlan {
  const { locale, kind, type, local, remote, lock, prune = false } = input;
  const scope = `${locale}/${kind}/${type}`;
  const used = new Set<string>();
  const matched = new Map<string, string>();
  const usable = remote.filter((item) => !item.broken && item.checksum);
  const take = (test: (item: RemoteItem) => boolean) => {
    const found = usable.find((item) => !used.has(item.id) && test(item));
    if (found) used.add(found.id);
    return found;
  };

  // The lock first, since it ties a path to one upload; then plain checksums.
  for (const file of local) {
    const entry = lock[file.path];
    if (entry && entry.md5 === file.md5) {
      const found = take((item) => item.checksum === entry.checksum);
      if (found) matched.set(file.path, found.id);
    }
  }
  for (const file of local) {
    if (matched.has(file.path)) continue;
    const found = take((item) => item.checksum === file.md5);
    if (found) matched.set(file.path, found.id);
  }

  const upload: string[] = [];
  const replace: string[] = [];
  const deleteIds: string[] = [];
  const replaced = new Map<string, RemoteItem>();
  for (const file of local) {
    const entry = lock[file.path];
    // A file the lock knows that changed: its old upload goes, whether or not the new one matches something.
    const old = entry && entry.md5 !== file.md5 ? take((item) => item.checksum === entry.checksum) : undefined;
    if (old) {
      deleteIds.push(old.id);
      replaced.set(old.id, old);
    }
    if (matched.has(file.path)) continue;
    (old ? replace : upload).push(file.path);
  }

  for (const item of remote) if (item.broken) deleteIds.push(item.id);
  const extras = usable.filter((item) => !used.has(item.id));
  const keptIds: string[] = [];
  for (const item of extras) (prune ? deleteIds : keptIds).push(item.id);

  const max = MAX[kind];
  if (local.length > max) {
    throw new ShipError(`${scope} has ${plural(local.length, kind)}; App Store Connect takes up to ${max}`, "too-many-media", `Remove some from ${scope}/.`, {
      scope,
      count: local.length,
      max,
    });
  }
  if (local.length + keptIds.length > max) {
    throw new ShipError(
      `${scope} would have ${local.length + keptIds.length} ${NOUN[kind][1]}: ${local.length} in the repo and ${keptIds.length} in App Store Connect that aren't`,
      "too-many-media",
      `Pass --prune to delete the ones that aren't in the repo, or remove some from ${scope}/.`,
      { scope, count: local.length + keptIds.length, max },
    );
  }

  const order = [...local.map((file) => matched.get(file.path) ?? `${LOCAL}${file.path}`), ...keptIds];
  const deleted = new Set(deleteIds);
  const uploads = new Set([...upload, ...replace]);
  // Where things end up without a reorder: what stays, in its order, then uploads as they're sent.
  const natural = [
    ...remote.filter((item) => !deleted.has(item.id)).map((item) => item.id),
    ...local.filter((file) => uploads.has(file.path)).map((file) => `${LOCAL}${file.path}`),
  ];
  const byId = new Map(remote.map((item) => [item.id, item]));
  return {
    locale,
    type,
    kind,
    upload,
    replace,
    delete: deleteIds.map((id) => byId.get(id)!.fileName),
    keep: keptIds.length,
    reorder: order.join("\n") !== natural.join("\n"),
    matched,
    deleteIds,
    replaced,
    keptIds,
    order,
    input,
  };
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A plan as diff changes: + new, ~ replaced, - deleted, and ~ order when only the order differs. */
export function planChanges(plan: FullPlan): Change[] {
  const { locale, kind, type, input } = plan;
  const scope = `${locale}/${kind}/${type}`;
  const md5 = new Map(input.local.map((file) => [file.path, file.md5]));
  const byId = new Map(input.remote.map((item) => [item.id, item]));
  const changes: Change[] = [];
  for (const path of plan.upload) changes.push({ scope, field: baseName(path), kind: "add", to: md5.get(path) });
  for (const path of plan.replace) {
    const old = input.lock[path]?.checksum;
    changes.push({ scope, field: baseName(path), kind: "change", from: old, to: md5.get(path) });
  }
  for (const id of plan.deleteIds) {
    if (plan.replaced.has(id)) continue;
    const item = byId.get(id)!;
    changes.push({ scope, field: item.fileName, kind: "remove", from: item.checksum ?? null, to: null });
  }
  if (plan.reorder) {
    const name = (token: string) => (token.startsWith(LOCAL) ? baseName(token.slice(LOCAL.length)) : (byId.get(token)?.fileName ?? token));
    const before = input.remote.filter((item) => !plan.deleteIds.includes(item.id)).map((item) => item.fileName);
    changes.push({ scope, field: "order", kind: "change", from: before, to: plan.order.map(name) });
  }
  return changes;
}

/** A plan's JSON (the API fields only). */
export function setJSON(plan: SetPlan): SetPlan {
  const { locale, type, kind, upload, replace, delete: remove, keep, reorder, deleteSet } = plan;
  return { locale, type, kind, upload, replace, delete: remove, keep, reorder, ...(deleteSet ? { deleteSet } : {}) };
}

/** For people: per set, + new, ~ replaced, - deleted, and the new order. */
export function renderMediaChanges(changes: Change[]): string {
  const lines: string[] = [];
  let scope = "";
  for (const change of changes) {
    if (change.scope !== scope) {
      scope = change.scope;
      lines.push(scope);
    }
    if (change.field === "order" && Array.isArray(change.to)) {
      lines.push(`  ~ order: ${(change.to as string[]).join(", ")}`);
    } else if (change.kind === "add") {
      lines.push(`  + ${change.field}`);
    } else if (change.kind === "change") {
      lines.push(`  ~ ${change.field} (changed)`);
    } else {
      lines.push(`  - ${change.field}`);
    }
  }
  return lines.join("\n");
}

// MARK: Validating

function unknownTypeProblem(set: { locale: string; kind: MediaKind; type: string }): Problem {
  const file = `${set.locale}/${set.kind}/${set.type}`;
  const screenshots = set.kind === "screenshots";
  const valid: readonly string[] = screenshots ? Object.keys(SCREENSHOT_TYPES) : PREVIEW_TYPES;
  // The common mix-ups: lowercase, and a preview type for screenshots or the other way round.
  const upper = set.type.toUpperCase();
  const twin = valid.includes(upper) ? upper : screenshots ? `APP_${upper}` : upper.replace(/^APP_/, "");
  const suggestion = valid.includes(twin) ? ` Did you mean ${twin}?` : "";
  return {
    file,
    severity: "error",
    message: `"${set.type}" isn't a ${screenshots ? "screenshot display" : "preview"} type.${suggestion} The types are ${valid.join(", ")}.`,
  };
}

/** Whether a type folder's name is one App Store Connect takes for its kind. */
export const isKnownType = (kind: MediaKind, type: string) => (kind === "screenshots" ? isScreenshotType(type) : isPreviewType(type));

/**
 * Checks the store's screenshots and previews offline: type folders, file
 * types, counts, sizes, and transparency. Errors stop a push; warnings don't.
 */
export async function validateMedia(storeDir: string, options: MediaFilter & { platform?: Platform } = {}): Promise<{ problems: Problem[]; files: number }> {
  const media = localMedia(storeDir, options);
  const problems: Problem[] = [];
  let files = 0;
  for (const { locale, kind } of media.managed) {
    if (!ASC_LOCALES.includes(locale)) {
      problems.push({ file: `${locale}/${kind}`, severity: "warning", message: `${locale} isn't a language App Store Connect lists; check the folder name.` });
    }
  }
  for (const path of media.stray) {
    const kind = path.split("/")[1];
    problems.push({
      file: path,
      severity: "warning",
      message: `push skips files directly in ${kind}/; put it in a ${kind === "screenshots" ? "display" : "preview"} type folder, like ${kind === "screenshots" ? "APP_IPHONE_67" : "IPHONE_67"}/.`,
    });
  }
  for (const set of media.sets) {
    const folder = `${set.locale}/${set.kind}/${set.type}`;
    if (!isKnownType(set.kind, set.type)) {
      problems.push(unknownTypeProblem(set));
      continue;
    }
    const platform = typePlatform(set.type);
    if (options.platform && platform !== options.platform) {
      problems.push({
        file: folder,
        severity: "warning",
        message: `${set.type} is for ${platformInfo(platform).title} apps, and this one is ${platformInfo(options.platform).title} (ship.json "platform").`,
      });
    }
    for (const path of set.ignored) {
      problems.push({ file: path, severity: "warning", message: `push skips it: ${set.kind} are ${EXTENSIONS[set.kind].join(", ")} files.` });
    }
    if (!set.files.length) problems.push({ file: folder, severity: "warning", message: `No ${set.kind} in this folder.` });
    if (set.files.length > MAX[set.kind]) {
      problems.push({ file: folder, severity: "error", message: `${plural(set.files.length, set.kind)}; App Store Connect takes up to ${MAX[set.kind]} per set.` });
    }
    for (const file of set.files) {
      files++;
      if (!file.size) {
        problems.push({ file: file.path, severity: "error", message: "The file is empty." });
        continue;
      }
      if (set.kind === "previews") {
        if (file.size > MAX_PREVIEW_BYTES) problems.push({ file: file.path, severity: "error", message: "App previews can be up to 500 MB." });
        continue;
      }
      const info = imageInfo(new Uint8Array(await Bun.file(file.file).arrayBuffer()));
      if (!info) {
        problems.push({ file: file.path, severity: "error", message: "This isn't a PNG or JPEG image ship can read." });
        continue;
      }
      const ext = extname(file.name).toLowerCase();
      if ((info.format === "png") !== (ext === ".png")) {
        problems.push({ file: file.path, severity: "warning", message: `It's a ${info.format.toUpperCase()} named ${ext}; rename it to match.` });
      }
      const size = sizeProblem(set.type, info.width, info.height);
      if (size) problems.push({ file: file.path, severity: "error", message: `${size}.` });
      if (info.alpha) {
        problems.push({ file: file.path, severity: "warning", message: "It can be transparent (an alpha channel); App Store Connect rejects transparency. Export it without alpha." });
      }
    }
  }
  return { problems, files };
}

// MARK: Versions

export interface VersionJSON {
  id: string;
  versionString: string;
  state: string;
}

export const versionJSON = (version: AppStoreVersion): VersionJSON => ({ id: version.id, versionString: version.versionString, state: version.state });

const PREPARE_HINT = "Start the next version with `ship release prepare --version <x.y>`.";

/**
 * The version to work on: --version, else the one being prepared, else (for
 * pull and diff) the live one. Push needs an editable version.
 */
export function chooseVersion(versions: AppStoreVersion[], options: { version?: string; editable?: boolean }): AppStoreVersion {
  const chosen = options.version
    ? versions.find((version) => version.versionString === options.version)
    : (versions.find(isEditableVersion) ?? (options.editable ? undefined : versions.find((version) => LIVE_VERSION_STATES.includes(version.state))));
  if (!chosen) {
    const choices = versions.map((version) => version.versionString);
    if (options.version) {
      throw new ShipError(
        `App Store Connect has no version ${options.version}`,
        "no-version",
        choices.length ? `Pick one: ${choices.map((v) => `--version ${v}`).join(", ")}. Or ${PREPARE_HINT[0]!.toLowerCase()}${PREPARE_HINT.slice(1)}` : PREPARE_HINT,
        { choices },
      );
    }
    throw new ShipError(
      options.editable ? "No App Store version is being prepared" : "The app has no App Store version yet",
      "no-version",
      PREPARE_HINT,
      { choices },
    );
  }
  if (options.editable && !isEditableVersion(chosen)) {
    throw new ShipError(
      `Version ${chosen.versionString} is ${chosen.state}, so its screenshots can't change`,
      "not-editable",
      PREPARE_HINT,
      { version: versionJSON(chosen) },
    );
  }
  return chosen;
}

// MARK: Comparing with App Store Connect

/** Failed uploads, and reservations whose upload never finished. */
const isBroken = (asset: MediaAsset) => asset.state?.state === "FAILED" || asset.state?.state === "AWAITING_UPLOAD";

const toRemote = (asset: MediaAsset): RemoteItem => ({
  id: asset.id,
  fileName: asset.fileName,
  ...(asset.checksum ? { checksum: asset.checksum } : {}),
  ...(isBroken(asset) ? { broken: true } : {}),
});

export interface MediaOptions extends MediaFilter {
  appId: string;
  /** The version string; default the one being prepared. */
  version?: string;
  /** Default the project's. */
  platform?: Platform;
  prune?: boolean;
  dryRun?: boolean;
  /** Wait for Apple to process uploads (default true). */
  wait?: boolean;
}

/** Everything push needs to apply a plan to one set. */
interface Planned extends FullPlan {
  localization?: VersionLocalization;
  set?: MediaSet;
  files: LocalFile[];
}

interface Comparison {
  version: AppStoreVersion;
  plans: Planned[];
  changes: Change[];
  lock: MediaLock;
  media: LocalMedia;
  localizations: VersionLocalization[];
  /** Remote files left alone: in App Store Connect, not in the repo, and no --prune. */
  skipped: PushResult["skipped"];
}

/** Compares the store's media with a version's, set by set. */
async function compare(project: Project, version: AppStoreVersion, media: LocalMedia, options: MediaOptions): Promise<Comparison> {
  const lock = await readLock(project.storeDir);
  const localizations = await versionLocalizations(version.id);
  const plans: Planned[] = [];
  for (const { locale, kind } of media.managed) {
    const localization = localizations.find((item) => item.locale === locale);
    const remoteSets = localization ? (await mediaSets(kind, localization.id)).filter((set) => wanted(options.types, set.type)) : [];
    const localSets = media.sets.filter((set) => set.locale === locale && set.kind === kind && isKnownType(kind, set.type));
    for (const local of localSets) {
      await hashSet(local);
      const set = remoteSets.find((item) => item.type === local.type);
      const assets = set ? await mediaAssets(kind, set.id) : [];
      const plan = planSet({
        locale,
        kind,
        type: local.type,
        local: local.files.map((file) => ({ path: file.path, md5: file.md5! })),
        remote: assets.map(toRemote),
        lock,
        prune: options.prune,
      });
      plans.push({ ...plan, localization, set, files: local.files });
    }
    // Sets with no folder: left alone, or with --prune emptied and deleted.
    for (const set of remoteSets.filter((item) => !localSets.some((local) => local.type === item.type))) {
      if (!options.prune) continue;
      const assets = await mediaAssets(kind, set.id);
      const plan = planSet({ locale, kind, type: set.type, local: [], remote: assets.map(toRemote), lock, prune: true });
      plans.push({ ...plan, deleteSet: true, localization, set, files: [] });
    }
  }
  const changes = plans.flatMap(planChanges);
  const skipped: PushResult["skipped"] = [];
  for (const plan of plans) {
    const names = new Map(plan.input.remote.map((item) => [item.id, item.fileName]));
    for (const id of plan.keptIds) {
      skipped.push({ scope: `${plan.locale}/${plan.kind}/${plan.type}`, field: names.get(id) ?? id, reason: "not in the repo; --prune deletes it" });
    }
    if (plan.keep) {
      ui.warn(
        `${plural(plan.keep, plan.kind)} in App Store Connect ${plan.keep === 1 ? "isn't" : "aren't"} in ${plan.locale}/${plan.kind}/${plan.type}; pass --prune to delete ${plan.keep === 1 ? "it" : "them"}`,
      );
    }
  }
  return { version, plans, changes, lock, media, localizations, skipped };
}

const platformOf = (project: Project, options: { platform?: Platform }) => options.platform ?? project.platform;

// MARK: Diff

export interface MediaDiff {
  version: VersionJSON;
  changes: Change[];
  sets: SetPlan[];
  hasChanges: boolean;
}

/** What push would change, against the version being prepared (or the live one). */
export async function diffMedia(project: Project, options: MediaOptions): Promise<MediaDiff | undefined> {
  const media = localMedia(project.storeDir, options);
  if (!media.managed.length) return undefined;
  // What push would refuse, so the diff doesn't look like the whole story.
  const { problems } = await validateMedia(project.storeDir, { ...options, platform: platformOf(project, options) });
  for (const problem of problems.filter((item) => item.severity === "error")) ui.warn(`${problem.file}: ${problem.message} (push stops on this)`);
  const versions = await appStoreVersions(options.appId, platformInfo(platformOf(project, options)).asc);
  const version = chooseVersion(versions, { version: options.version });
  const { plans, changes } = await compare(project, version, media, options);
  return { version: versionJSON(version), changes, sets: plans.map(setJSON), hasChanges: changes.length > 0 };
}

// MARK: Push

export interface MediaPushResult extends PushResult {
  /** null when the store has no screenshots or previews folders. */
  version: VersionJSON | null;
  dryRun: boolean;
  sets: SetPlan[];
  /** Local paths uploaded. */
  uploaded: string[];
  /** Remote file names deleted. */
  deleted: string[];
  /** "<locale>/<TYPE>" sets put in a new order. */
  reordered: string[];
}

/** Pushes the store's screenshots and previews (for `ship release`, which needs only the PushResult). */
export async function pushMedia(
  project: Project,
  options: { appId: string; version?: string; dryRun?: boolean; prune?: boolean; platform?: Platform },
): Promise<PushResult> {
  const { changes, applied, skipped } = await syncMedia(project, options);
  return { changes, applied, skipped };
}

/**
 * Makes App Store Connect's screenshots and previews match the store's:
 * uploads new and changed files, deletes replaced ones (and with prune,
 * ones not in the repo), and puts each set in file name order.
 */
export async function syncMedia(project: Project, options: MediaOptions): Promise<MediaPushResult> {
  const dryRun = options.dryRun ?? false;
  const media = localMedia(project.storeDir, options);
  const empty: MediaPushResult = { changes: [], applied: false, skipped: [], version: null, dryRun, sets: [], uploaded: [], deleted: [], reordered: [] };
  if (!media.managed.length) return empty;

  const platform = platformOf(project, options);
  const { problems } = await validateMedia(project.storeDir, { ...options, platform });
  const errors = problems.filter((problem) => problem.severity === "error");
  if (errors.length) {
    throw new ShipError(
      `${errors.length} problem${errors.length === 1 ? "" : "s"} with the screenshots: ${errors[0]!.file}: ${errors[0]!.message}`,
      "invalid-media",
      "See them all with `ship screenshots validate`.",
      { problems: errors },
    );
  }

  const versions = await appStoreVersions(options.appId, platformInfo(platform).asc);
  const version = chooseVersion(versions, { version: options.version, editable: true });
  const comparison = await compare(project, version, media, options);
  const result: MediaPushResult = {
    ...empty,
    version: versionJSON(version),
    changes: comparison.changes,
    skipped: comparison.skipped,
    sets: comparison.plans.map(setJSON),
  };
  if (dryRun || !comparison.changes.length) return result;

  const before = comparison.lock;
  let lock = before;
  try {
    for (const plan of comparison.plans) {
      await applyPlan(plan, comparison, options, {
        uploaded: (path, md5) => {
          result.uploaded.push(path);
          lock = updateLock(lock, { uploaded: [{ path, md5 }] });
        },
        // Apple rejected it and it was deleted: forget the upload, and keep what the lock said before.
        failed: (path) => {
          result.uploaded = result.uploaded.filter((item) => item !== path);
          lock = before[path] ? { ...lock, [path]: before[path] } : updateLock(lock, { removed: [path] });
        },
        deleted: (fileName) => result.deleted.push(fileName),
        reordered: () => result.reordered.push(`${plan.locale}/${plan.type}`),
      });
    }
  } catch (error) {
    await writeLock(project.storeDir, lock);
    if (!(error instanceof ShipError)) throw error;
    const done = result.uploaded.length || result.deleted.length ? ` (before that: ${result.uploaded.length} uploaded, ${result.deleted.length} deleted)` : "";
    throw new ShipError(`${error.message}${done}`, error.code, error.hint, { ...error.details, uploaded: result.uploaded, deleted: result.deleted }, error.exitCode);
  }
  await writeLock(project.storeDir, lock);
  result.applied = true;
  return result;
}

interface Progress {
  uploaded(path: string, md5: string): void;
  failed(path: string): void;
  deleted(fileName: string): void;
  reordered(): void;
}

async function applyPlan(plan: Planned, comparison: Comparison, options: MediaOptions, progress: Progress): Promise<void> {
  const { kind } = plan;
  const label = `${plan.locale}/${kind}/${plan.type}`;
  const uploads = plan.files.filter((file) => plan.upload.includes(file.path) || plan.replace.includes(file.path));
  if (!uploads.length && !plan.deleteIds.length && !plan.reorder) return;
  ui.step(label);

  const byId = new Map(plan.input.remote.map((item) => [item.id, item]));
  const deleteAll = async () => {
    for (const id of plan.deleteIds) {
      await deleteMediaAsset(kind, id);
      const name = byId.get(id)?.fileName ?? id;
      progress.deleted(name);
      ui.note(`- ${name}`);
    }
    plan.deleteIds = [];
  };

  // A full set has no room for new files until the old ones are gone.
  const remaining = plan.input.remote.length;
  if (remaining + uploads.length > MAX[kind]) await deleteAll();

  const created = new Map<string, string>();
  if (uploads.length) {
    let localization = plan.localization ?? comparison.localizations.find((item) => item.locale === plan.locale);
    if (!localization) {
      ui.note(`Adding ${plan.locale} to version ${comparison.version.versionString}`);
      localization = await createVersionLocalization(comparison.version.id, plan.locale);
      comparison.localizations.push(localization);
    }
    plan.set ??= await createMediaSet(kind, localization.id, plan.type);
    for (const file of uploads) {
      const reservation = await reserveMedia(kind, plan.set.id, {
        fileName: file.name,
        fileSize: file.size,
        ...(kind === "previews" ? { mimeType: previewMimeType(file.name) } : {}),
      });
      created.set(file.path, reservation.id);
      try {
        await uploadParts(reservation.operations, Bun.file(file.file), file.name);
        await commitMedia(kind, reservation.id, file.md5!);
      } catch (error) {
        // Don't leave a reservation that never finished behind.
        await deleteMediaAsset(kind, reservation.id).catch(() => undefined);
        throw error;
      }
      progress.uploaded(file.path, file.md5!);
      ui.note(`+ ${file.name}`);
    }
    if (options.wait !== false) {
      for (const file of uploads) {
        const id = created.get(file.path)!;
        try {
          const state = await waitForMedia(kind, id, file.name);
          if (state?.state !== "COMPLETE") ui.warn(`${file.name} is still processing (${state?.state ?? "unknown"}); check later with \`ship screenshots diff\``);
          else if (state.warnings?.length) ui.warn(`${file.name}: ${stateErrors({ errors: state.warnings })}`);
        } catch (error) {
          await deleteMediaAsset(kind, id).catch(() => undefined);
          progress.failed(file.path);
          throw error;
        }
      }
    }
  }

  await deleteAll();

  if (plan.deleteSet && plan.set) {
    await deleteMediaSet(kind, plan.set.id);
    ui.note(`Deleted the ${plan.type} set`);
    return;
  }
  // Apple adds uploads at the end; put everything in the repo's order.
  const order = plan.order.map((token) => (token.startsWith(LOCAL) ? created.get(token.slice(LOCAL.length))! : token));
  if (plan.set && order.length > 1 && (plan.reorder || created.size)) {
    await reorderMedia(kind, plan.set.id, order);
    if (plan.reorder) {
      progress.reordered();
      ui.note("Put in file name order");
    }
  }
}

// MARK: Pull

export interface MediaPullResult {
  dir: string;
  version: VersionJSON;
  /** Paths written, relative to the store folder. */
  written: string[];
  /** Local files that already match. */
  unchanged: string[];
  skipped: { path: string; reason: string }[];
}

/** NN-<name>.<ext> for the file at `index`, from the name it was uploaded with. */
export function mediaFileName(index: number, uploadedName: string, ext: string, fallback = "screenshot"): string {
  // Only the last part of a path-like name, so nothing lands outside the folder.
  const name = uploadedName.slice(Math.max(uploadedName.lastIndexOf("/"), uploadedName.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  const base = (dot >= 0 ? name.slice(0, dot) : name)
    .replace(/^\d+[-_. ]+/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return `${String(index + 1).padStart(2, "0")}-${base || fallback}${ext}`;
}

/** The extension a pulled file gets: PNG for screenshots (what ship asks the CDN for), the upload's for previews. */
function pulledExtension(kind: MediaKind, asset: MediaAsset): string {
  if (kind === "screenshots") return ".png";
  const ext = extname(asset.fileName).toLowerCase();
  if (PREVIEW_EXTENSIONS.includes(ext)) return ext;
  return asset.mimeType === "video/quicktime" ? ".mov" : ".mp4";
}

/** Which local file (if any) stands for each remote asset: by the lock, then by MD5. A file stands for one asset at most. */
export function matchPulled(assets: { checksum?: string }[], files: { path: string; md5: string }[], lock: MediaLock): (string | undefined)[] {
  const claimed = new Set<string>();
  const pick = (checksum: string | undefined, test: (file: { path: string; md5: string }) => boolean) => {
    if (!checksum) return undefined;
    const found = files.find((file) => !claimed.has(file.path) && test(file));
    if (found) claimed.add(found.path);
    return found?.path;
  };
  const byLock = assets.map((asset) => pick(asset.checksum, (file) => lock[file.path]?.md5 === file.md5 && lock[file.path]?.checksum === asset.checksum));
  return assets.map((asset, i) => byLock[i] ?? pick(asset.checksum, (file) => file.md5 === asset.checksum));
}

/**
 * Downloads a version's screenshots and previews into the store folder.
 * Files that already match are left alone; a different file in the way is
 * skipped unless force (a file that matches another screenshot never is).
 * Writes the lock, even after a failed download, so the next push sees no
 * change for what was pulled.
 */
export async function pullMedia(project: Project, options: MediaOptions & { force?: boolean }): Promise<MediaPullResult> {
  const versions = await appStoreVersions(options.appId, platformInfo(platformOf(project, options)).asc);
  const version = chooseVersion(versions, { version: options.version });
  const lock = await readLock(project.storeDir);
  const result: MediaPullResult = { dir: project.storeDir, version: versionJSON(version), written: [], unchanged: [], skipped: [] };
  const localizations = (await versionLocalizations(version.id)).filter((item) => wanted(options.locales, item.locale));
  try {
    for (const localization of localizations) {
      const { locale } = localization;
      for (const kind of MEDIA_KINDS) {
        for (const set of (await mediaSets(kind, localization.id)).filter((item) => wanted(options.types, item.type))) {
          const assets = await mediaAssets(kind, set.id);
          if (!assets.length) continue;
          const folder = `${locale}/${kind}/${set.type}`;
          ui.step(folder);
          const local = localMedia(project.storeDir, { locales: [locale], types: [set.type] }).sets.find((item) => item.kind === kind);
          const files = local ? (await hashSet(local)).files.map((file) => ({ path: file.path, md5: file.md5! })) : [];
          const matches = matchPulled(assets.map((asset) => (isBroken(asset) ? {} : asset)), files, lock);
          const taken = new Set(matches.filter((path): path is string => Boolean(path)));
          for (const [index, asset] of assets.entries()) {
            const match = matches[index];
            if (match) {
              result.unchanged.push(match);
              continue;
            }
            const name = mediaFileName(index, asset.fileName, pulledExtension(kind, asset), NOUN[kind][0]);
            const path = `${folder}/${name}`;
            if (isBroken(asset)) {
              result.skipped.push({ path, reason: `its upload ${asset.state?.state === "FAILED" ? `failed: ${stateErrors(asset.state)}` : "never finished"}` });
              continue;
            }
            const url = kind === "screenshots" ? (asset.image ? screenshotUrl(asset.image) : undefined) : asset.videoUrl;
            if (!url) {
              result.skipped.push({ path, reason: "App Store Connect has no download for it yet (still processing?)" });
              continue;
            }
            if (taken.has(path)) {
              result.skipped.push({ path, reason: "that file is another one in the set; number the files in App Store Connect's order and pull again" });
              continue;
            }
            const target = join(project.storeDir, path);
            if (existsSync(target) && !options.force) {
              result.skipped.push({ path, reason: "a different file is there; pass --force to overwrite it" });
              continue;
            }
            const bytes = await download(url, asset.fileName);
            mkdirSync(join(project.storeDir, folder), { recursive: true });
            await Bun.write(target, bytes);
            // Without Apple's checksum there's nothing to tie the file to; the next push uploads it again.
            if (asset.checksum) lock[path] = { md5: md5(bytes), checksum: asset.checksum };
            else delete lock[path];
            taken.add(path);
            result.written.push(path);
            ui.note(`↓ ${name}`);
          }
        }
      }
    }
  } finally {
    await writeLock(project.storeDir, lock);
  }
  return result;
}
