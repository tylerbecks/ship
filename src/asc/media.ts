// Screenshots and app previews in App Store Connect: the sets on a
// version's localizations, the files in each set, and Apple's upload flow
// (reserve, send the parts to the URLs Apple gives, commit with the MD5,
// wait for processing). Screenshots and previews work the same way, so one
// set of functions serves both, told apart by a MediaKind.

import { ShipError } from "../ui";
import { AscError, type Resource, TIMEOUT_MS, all, del, get, one, patch, post, retry, retryDelay } from "./client";

export type MediaKind = "screenshots" | "previews";

/** The names App Store Connect uses for each kind. */
const NAMES = {
  screenshots: {
    set: "appScreenshotSets",
    asset: "appScreenshots",
    setRelation: "appScreenshotSet",
    typeAttribute: "screenshotDisplayType",
    fields: "fileName,fileSize,sourceFileChecksum,imageAsset,assetDeliveryState",
    noun: "screenshot",
  },
  previews: {
    set: "appPreviewSets",
    asset: "appPreviews",
    setRelation: "appPreviewSet",
    typeAttribute: "previewType",
    fields: "fileName,fileSize,sourceFileChecksum,mimeType,videoUrl,assetDeliveryState,videoDeliveryState",
    noun: "preview",
  },
} as const;

/** Polling settings. Tests set `sleep` to skip the waiting. */
export const polling = {
  intervalMs: 2000,
  /** How long to wait for Apple to process a screenshot, then a preview. */
  timeoutMs: { screenshots: 5 * 60_000, previews: 15 * 60_000 } as Record<MediaKind, number>,
  sleep: (ms: number): Promise<void> => Bun.sleep(ms),
};

// MARK: Localizations and sets

export interface VersionLocalization {
  id: string;
  locale: string;
}

/** The version's localizations (one per language on the page). */
export async function versionLocalizations(versionId: string): Promise<VersionLocalization[]> {
  const { data } = await all<{ locale: string }>(
    `/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=locale&limit=200`,
  );
  return data.map((item) => ({ id: item.id, locale: item.attributes.locale }));
}

/** Adds a language to the version. If it's already there (made in the meantime), returns that one. */
export async function createVersionLocalization(versionId: string, locale: string): Promise<VersionLocalization> {
  try {
    const doc = await post<{ locale: string }>("/v1/appStoreVersionLocalizations", {
      data: {
        type: "appStoreVersionLocalizations",
        attributes: { locale },
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } },
      },
    });
    const created = one(doc);
    if (created) return { id: created.id, locale: created.attributes.locale ?? locale };
  } catch (error) {
    if (!(error instanceof AscError && error.status === 409)) throw error;
  }
  const found = (await versionLocalizations(versionId)).find((item) => item.locale === locale);
  if (!found) {
    throw new ShipError(
      `App Store Connect didn't add ${locale} to the version`,
      "no-localization",
      `Add ${locale} on the version's page in App Store Connect, then push again.`,
    );
  }
  return found;
}

export interface MediaSet {
  id: string;
  kind: MediaKind;
  /** The display type (APP_IPHONE_67) or preview type (IPHONE_67). */
  type: string;
}

/** A localization's screenshot or preview sets. */
export async function mediaSets(kind: MediaKind, localizationId: string): Promise<MediaSet[]> {
  const n = NAMES[kind];
  const { data } = await all<Record<string, string>>(
    `/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}/${n.set}?fields[${n.set}]=${n.typeAttribute}&limit=200`,
  );
  return data.map((item) => ({ id: item.id, kind, type: item.attributes[n.typeAttribute] ?? "" }));
}

/** Makes a set for a type. If one appeared in the meantime, returns that. */
export async function createMediaSet(kind: MediaKind, localizationId: string, type: string): Promise<MediaSet> {
  const n = NAMES[kind];
  try {
    const created = one(
      await post(`/v1/${n.set}`, {
        data: {
          type: n.set,
          attributes: { [n.typeAttribute]: type },
          relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: localizationId } } },
        },
      }),
    );
    if (created) return { id: created.id, kind, type };
  } catch (error) {
    if (!(error instanceof AscError && error.status === 409)) throw error;
  }
  const found = (await mediaSets(kind, localizationId)).find((set) => set.type === type);
  if (!found) {
    throw new ShipError(`App Store Connect didn't make the ${type} set`, "no-media-set", "Try again; if it keeps failing, add one in App Store Connect first.");
  }
  return found;
}

export const deleteMediaSet = (kind: MediaKind, setId: string) => del(`/v1/${NAMES[kind].set}/${encodeURIComponent(setId)}`);

// MARK: Assets

/** AppMediaAssetState (or AppMediaVideoState for a preview's video). */
export interface AssetState {
  /** AWAITING_UPLOAD, UPLOAD_COMPLETE, PROCESSING, COMPLETE, or FAILED. */
  state?: string;
  errors?: { code?: string; description?: string }[];
  warnings?: { code?: string; description?: string }[];
}

/** One screenshot or preview in a set. */
export interface MediaAsset {
  id: string;
  fileName: string;
  fileSize?: number;
  /** The MD5 of the uploaded file, as sent when it was committed. */
  checksum?: string;
  /** The delivery state: assetDeliveryState, or videoDeliveryState for a preview. */
  state?: AssetState;
  /** Screenshots: a URL with {w}, {h}, and {f} to fill in, and the image's size. */
  image?: { templateUrl: string; width: number; height: number };
  /** Previews: where the processed video can be downloaded. */
  videoUrl?: string;
  mimeType?: string;
}

type AssetAttributes = {
  fileName?: string;
  fileSize?: number;
  sourceFileChecksum?: string | null;
  imageAsset?: { templateUrl?: string; width?: number; height?: number } | null;
  assetDeliveryState?: AssetState | null;
  videoDeliveryState?: AssetState | null;
  videoUrl?: string | null;
  mimeType?: string | null;
  uploadOperations?: UploadOperation[] | null;
};

export function toAsset(resource: Resource<AssetAttributes>): MediaAsset {
  const a = resource.attributes;
  const asset: MediaAsset = { id: resource.id, fileName: a.fileName ?? "" };
  if (a.fileSize !== undefined) asset.fileSize = a.fileSize;
  if (a.sourceFileChecksum) asset.checksum = a.sourceFileChecksum;
  const state = a.videoDeliveryState ?? a.assetDeliveryState;
  if (state) asset.state = state;
  if (a.imageAsset?.templateUrl) {
    asset.image = { templateUrl: a.imageAsset.templateUrl, width: a.imageAsset.width ?? 0, height: a.imageAsset.height ?? 0 };
  }
  if (a.videoUrl) asset.videoUrl = a.videoUrl;
  if (a.mimeType) asset.mimeType = a.mimeType;
  return asset;
}

/** The set's screenshots or previews, in the order the App Store shows them. */
export async function mediaAssets(kind: MediaKind, setId: string): Promise<MediaAsset[]> {
  const n = NAMES[kind];
  const { data } = await all<AssetAttributes>(`/v1/${n.set}/${encodeURIComponent(setId)}/${n.asset}?fields[${n.asset}]=${n.fields}&limit=200`);
  return data.map(toAsset);
}

export const deleteMediaAsset = (kind: MediaKind, assetId: string) => del(`/v1/${NAMES[kind].asset}/${encodeURIComponent(assetId)}`);

/** Puts the set's screenshots or previews in this order (every id in the set, once). */
export async function reorderMedia(kind: MediaKind, setId: string, assetIds: string[]): Promise<void> {
  const n = NAMES[kind];
  await patch(`/v1/${n.set}/${encodeURIComponent(setId)}/relationships/${n.asset}`, { data: assetIds.map((id) => ({ type: n.asset, id })) });
}

// MARK: Uploading

/** One part of an upload: send bytes [offset, offset + length) to url. */
export interface UploadOperation {
  method?: string;
  url?: string;
  length?: number;
  offset?: number;
  requestHeaders?: { name?: string; value?: string }[];
}

/** Reserves a place for a file in the set; Apple answers with where to send its parts. */
export async function reserveMedia(
  kind: MediaKind,
  setId: string,
  file: { fileName: string; fileSize: number; mimeType?: string },
): Promise<{ id: string; operations: UploadOperation[] }> {
  const n = NAMES[kind];
  const attributes: Record<string, unknown> = { fileName: file.fileName, fileSize: file.fileSize };
  if (kind === "previews" && file.mimeType) attributes.mimeType = file.mimeType;
  const created = one(
    await post<AssetAttributes>(`/v1/${n.asset}`, {
      data: { type: n.asset, attributes, relationships: { [n.setRelation]: { data: { type: n.set, id: setId } } } },
    }),
  );
  if (!created) {
    throw new ShipError(`App Store Connect didn't reserve ${file.fileName}`, "api-bad-response", "Try again shortly; developer.apple.com/system-status shows outages.");
  }
  return { id: created.id, operations: created.attributes.uploadOperations ?? [] };
}

/** How many times an upload part is retried after a server error or a dropped connection. */
export const UPLOAD_RETRIES = 3;

/**
 * Sends a file's parts to the URLs Apple gave. These aren't App Store
 * Connect, so the request carries exactly Apple's headers and never the API
 * token. Server errors and network failures are retried.
 */
export async function uploadParts(operations: UploadOperation[], file: Blob, fileName: string): Promise<void> {
  if (!operations.length) {
    throw new ShipError(`App Store Connect gave no upload address for ${fileName}`, "upload-failed", "Push again; ship deletes the unfinished reservation first.");
  }
  for (const operation of operations) {
    const url = operation.url ?? "";
    let host: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") throw new Error("not https");
      host = parsed.host;
    } catch {
      throw new ShipError(`App Store Connect gave an upload address ship won't use for ${fileName}`, "upload-failed", "Push again; if it keeps happening, upload it in App Store Connect.", { url });
    }
    const offset = operation.offset ?? 0;
    const length = operation.length ?? file.size - offset;
    const headers = new Headers();
    for (const header of operation.requestHeaders ?? []) if (header.name) headers.set(header.name, header.value ?? "");
    const body = file.slice(offset, offset + length, headers.get("content-type") ?? "");
    let attempt = 0;
    while (true) {
      let status: number | "network";
      let detail = "";
      try {
        // Read fetch at call time, so tests can swap it.
        const response = await globalThis.fetch(url, { method: operation.method ?? "PUT", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS * 5) });
        status = response.status;
        detail = response.ok ? "" : (await response.text().catch(() => "")).slice(0, 200);
        if (response.ok) break;
      } catch (error) {
        status = "network";
        detail = error instanceof Error ? error.message : String(error);
      }
      if ((status === "network" || status >= 500 || status === 429) && attempt < UPLOAD_RETRIES) {
        await retry.sleep(retryDelay(attempt++));
        continue;
      }
      throw new ShipError(
        `Uploading ${fileName} to ${host} failed (${status === "network" ? detail : `${status}${detail ? `: ${detail}` : ""}`})`,
        "upload-failed",
        "Check your connection and push again; ship deletes the unfinished upload first.",
        { status },
      );
    }
  }
}

/** Tells App Store Connect the parts are there, with the whole file's MD5. */
export async function commitMedia(kind: MediaKind, assetId: string, checksum: string): Promise<void> {
  const n = NAMES[kind];
  await patch(`/v1/${n.asset}/${encodeURIComponent(assetId)}`, {
    data: { type: n.asset, id: assetId, attributes: { uploaded: true, sourceFileChecksum: checksum } },
  });
}

/** A screenshot's or preview's delivery state now. */
export async function mediaState(kind: MediaKind, assetId: string): Promise<AssetState | undefined> {
  const n = NAMES[kind];
  const fields = kind === "previews" ? "assetDeliveryState,videoDeliveryState" : "assetDeliveryState";
  const resource = one(await get<AssetAttributes>(`/v1/${n.asset}/${encodeURIComponent(assetId)}?fields[${n.asset}]=${fields}`));
  return resource ? toAsset(resource).state : undefined;
}

/** Apple's reasons a file failed, as one line. */
export const stateErrors = (state: AssetState | undefined) =>
  (state?.errors ?? []).map((error) => error.description || error.code).filter(Boolean).join("; ") || "no reason given";

/**
 * Waits until Apple has processed an upload. FAILED is an error with
 * Apple's reasons; running out of time returns the last state, since the
 * file may still finish.
 */
export async function waitForMedia(kind: MediaKind, assetId: string, fileName: string): Promise<AssetState | undefined> {
  const tries = Math.max(1, Math.ceil(polling.timeoutMs[kind] / polling.intervalMs));
  let state: AssetState | undefined;
  for (let attempt = 0; attempt < tries; attempt++) {
    state = await mediaState(kind, assetId);
    if (state?.state === "COMPLETE") return state;
    if (state?.state === "FAILED") {
      throw new ShipError(
        `App Store Connect couldn't process ${fileName}: ${stateErrors(state)}`,
        "media-failed",
        `Fix the file (\`ship screenshots validate\` checks sizes and types) and push again.`,
        { file: fileName, errors: state.errors ?? [] },
      );
    }
    await polling.sleep(polling.intervalMs);
  }
  return state;
}

// MARK: Downloading

/** A screenshot's download URL at its full size, as PNG. */
export const screenshotUrl = (image: { templateUrl: string; width: number; height: number }) =>
  image.templateUrl.replace("{w}", String(image.width)).replace("{h}", String(image.height)).replace("{f}", "png");

/** Downloads a processed screenshot or preview from Apple's CDN (no API token; it isn't App Store Connect). */
export async function download(url: string, fileName: string): Promise<Uint8Array> {
  if (!url.startsWith("https://")) {
    throw new ShipError(`App Store Connect gave a download address ship won't use for ${fileName}`, "download-failed", "Download it from App Store Connect instead.", { url });
  }
  let attempt = 0;
  while (true) {
    let status: number | "network";
    try {
      const response = await globalThis.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS * 5) });
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      status = response.status;
      await response.body?.cancel();
    } catch {
      status = "network";
    }
    if ((status === "network" || status >= 500 || status === 429) && attempt < UPLOAD_RETRIES) {
      await retry.sleep(retryDelay(attempt++));
      continue;
    }
    throw new ShipError(`Downloading ${fileName} failed (${status})`, "download-failed", "Check your connection and pull again.", { status });
  }
}
