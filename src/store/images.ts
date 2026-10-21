// What ship knows about screenshot and app preview files without asking
// Apple: the display and preview types App Store Connect takes, the pixel
// sizes each accepts, and an image's format and size read from its header
// (no dependencies, so PNG and JPEG are parsed by hand).

import { createHash } from "node:crypto";

// MARK: Types

/** App Store Connect's ScreenshotDisplayType values, with what they're called in its web page. */
export const SCREENSHOT_TYPES = {
  APP_IPHONE_67: '6.9" iPhone',
  APP_IPHONE_65: '6.5" iPhone',
  APP_IPHONE_61: '6.3" iPhone',
  APP_IPHONE_58: '6.1" iPhone',
  APP_IPHONE_55: '5.5" iPhone',
  APP_IPHONE_47: '4.7" iPhone',
  APP_IPHONE_40: '4" iPhone',
  APP_IPHONE_35: '3.5" iPhone',
  APP_IPAD_PRO_3GEN_129: '13" iPad',
  APP_IPAD_PRO_3GEN_11: '11" iPad',
  APP_IPAD_PRO_129: '12.9" iPad (2nd generation)',
  APP_IPAD_105: '10.5" iPad',
  APP_IPAD_97: '9.7" iPad',
  APP_DESKTOP: "Mac",
  APP_WATCH_ULTRA: "Apple Watch Ultra",
  APP_WATCH_SERIES_10: "Apple Watch Series 10",
  APP_WATCH_SERIES_7: "Apple Watch Series 7",
  APP_WATCH_SERIES_4: "Apple Watch Series 4",
  APP_WATCH_SERIES_3: "Apple Watch Series 3",
  APP_APPLE_TV: "Apple TV",
  APP_APPLE_VISION_PRO: "Apple Vision Pro",
  IMESSAGE_APP_IPHONE_67: '6.9" iPhone (iMessage)',
  IMESSAGE_APP_IPHONE_61: '6.3" iPhone (iMessage)',
  IMESSAGE_APP_IPHONE_65: '6.5" iPhone (iMessage)',
  IMESSAGE_APP_IPHONE_58: '6.1" iPhone (iMessage)',
  IMESSAGE_APP_IPHONE_55: '5.5" iPhone (iMessage)',
  IMESSAGE_APP_IPHONE_47: '4.7" iPhone (iMessage)',
  IMESSAGE_APP_IPHONE_40: '4" iPhone (iMessage)',
  IMESSAGE_APP_IPAD_PRO_3GEN_129: '13" iPad (iMessage)',
  IMESSAGE_APP_IPAD_PRO_3GEN_11: '11" iPad (iMessage)',
  IMESSAGE_APP_IPAD_PRO_129: '12.9" iPad (iMessage)',
  IMESSAGE_APP_IPAD_105: '10.5" iPad (iMessage)',
  IMESSAGE_APP_IPAD_97: '9.7" iPad (iMessage)',
} as const;

export type ScreenshotType = keyof typeof SCREENSHOT_TYPES;

/** App Store Connect's PreviewType values: the screenshot types without APP_, and no Watch or iMessage. */
export const PREVIEW_TYPES = [
  "IPHONE_67",
  "IPHONE_65",
  "IPHONE_61",
  "IPHONE_58",
  "IPHONE_55",
  "IPHONE_47",
  "IPHONE_40",
  "IPHONE_35",
  "IPAD_PRO_3GEN_129",
  "IPAD_PRO_3GEN_11",
  "IPAD_PRO_129",
  "IPAD_105",
  "IPAD_97",
  "DESKTOP",
  "APPLE_TV",
  "APPLE_VISION_PRO",
] as const;

export type PreviewType = (typeof PREVIEW_TYPES)[number];

export const isScreenshotType = (value: string): value is ScreenshotType => Object.hasOwn(SCREENSHOT_TYPES, value);
export const isPreviewType = (value: string): value is PreviewType => (PREVIEW_TYPES as readonly string[]).includes(value);

/** How many screenshots and previews one set holds. */
export const MAX_SCREENSHOTS = 10;
export const MAX_PREVIEWS = 3;
/** The largest app preview App Store Connect takes. */
export const MAX_PREVIEW_BYTES = 500 * 1024 * 1024;

export const SCREENSHOT_EXTENSIONS = [".png", ".jpg", ".jpeg"];
export const PREVIEW_EXTENSIONS = [".mp4", ".mov", ".m4v"];

/** The MIME type App Store Connect wants for a preview file. */
export const previewMimeType = (name: string) => (name.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4");

/** The ship platforms a display or preview type belongs to (iPhone, iPad, Watch, and iMessage are iOS). */
export function typePlatform(type: string): "ios" | "macos" | "tvos" | "visionos" {
  if (/DESKTOP$/.test(type)) return "macos";
  if (/APPLE_TV$/.test(type)) return "tvos";
  if (/APPLE_VISION_PRO$/.test(type)) return "visionos";
  return "ios";
}

// MARK: Sizes

type Size = readonly [number, number];

/** Portrait sizes, each also accepted turned to landscape. */
const turnable = (...sizes: Size[]): Size[] => sizes.flatMap(([w, h]) => [[w, h] as const, [h, w] as const]);

const IPHONE_MEDIUM = turnable([1179, 2556], [1206, 2622], [1170, 2532], [1125, 2436], [1080, 2340]);

/**
 * The pixel sizes each display type accepts, from Apple's screenshot
 * specifications (developer.apple.com/help/app-store-connect/reference/screenshot-specifications).
 * iPhone and iPad take portrait or landscape; Mac, Apple TV, and Vision Pro
 * landscape; Watch portrait. The older iPhones and the 9.7" iPad also take
 * sizes without the status bar, whose landscape isn't a plain turn.
 */
export const SCREENSHOT_SIZES: Record<string, Size[]> = {
  APP_IPHONE_67: turnable([1260, 2736], [1290, 2796], [1320, 2868]),
  APP_IPHONE_65: turnable([1242, 2688], [1284, 2778]),
  APP_IPHONE_61: IPHONE_MEDIUM,
  APP_IPHONE_58: IPHONE_MEDIUM,
  APP_IPHONE_55: turnable([1242, 2208]),
  APP_IPHONE_47: turnable([750, 1334]),
  APP_IPHONE_40: [...turnable([640, 1136]), [640, 1096], [1136, 600]],
  APP_IPHONE_35: [...turnable([640, 960]), [640, 920], [960, 600]],
  APP_IPAD_PRO_3GEN_129: turnable([2064, 2752], [2048, 2732]),
  APP_IPAD_PRO_3GEN_11: turnable([1488, 2266], [1668, 2420], [1668, 2388], [1640, 2360]),
  APP_IPAD_PRO_129: turnable([2048, 2732]),
  APP_IPAD_105: turnable([1668, 2224]),
  APP_IPAD_97: [...turnable([1536, 2048], [768, 1024]), [1536, 2008], [2048, 1496], [768, 1004], [1024, 748]],
  APP_DESKTOP: [
    [1280, 800],
    [1440, 900],
    [2560, 1600],
    [2880, 1800],
  ],
  APP_APPLE_TV: [
    [1920, 1080],
    [3840, 2160],
  ],
  APP_APPLE_VISION_PRO: [[3840, 2160]],
  APP_WATCH_ULTRA: [
    [410, 502],
    [422, 514],
  ],
  APP_WATCH_SERIES_10: [[416, 496]],
  APP_WATCH_SERIES_7: [[396, 484]],
  APP_WATCH_SERIES_4: [[368, 448]],
  APP_WATCH_SERIES_3: [[312, 390]],
};

/** The sizes a display type accepts; iMessage types take their app type's. */
export const sizesFor = (type: string): Size[] => SCREENSHOT_SIZES[type.replace(/^IMESSAGE_/, "")] ?? [];

/** Why an image of this size can't go in this display type's set, or undefined when it can. */
export function sizeProblem(type: string, width: number, height: number): string | undefined {
  const sizes = sizesFor(type);
  if (!sizes.length || sizes.some(([w, h]) => w === width && h === height)) return undefined;
  const title = isScreenshotType(type) ? SCREENSHOT_TYPES[type] : type;
  const list = sizes.map(([w, h]) => `${w}x${h}`).join(", ");
  return `${width}x${height} isn't a ${title} screenshot size (${type} takes ${list})`;
}

// MARK: Image headers

export interface ImageInfo {
  format: "png" | "jpeg";
  width: number;
  height: number;
  /** Whether the image can be transparent (an alpha channel or a tRNS chunk). Apple rejects transparency. */
  alpha: boolean;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const u16 = (bytes: Uint8Array, at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
const u32 = (bytes: Uint8Array, at: number) => ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

function pngInfo(bytes: Uint8Array): ImageInfo | undefined {
  // Signature, then IHDR: length (4), "IHDR", width (4), height (4), bit depth, color type.
  if (bytes.length < 26 || ascii(bytes, 12, 4) !== "IHDR") return undefined;
  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  const colorType = bytes[25]!;
  let alpha = colorType === 4 || colorType === 6;
  // A tRNS chunk before the image data makes a palette or RGB image transparent too.
  let at = 8;
  while (!alpha && at + 8 <= bytes.length) {
    const length = u32(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    if (type === "tRNS") alpha = true;
    if (type === "IDAT" || type === "IEND") break;
    at += 12 + length;
  }
  if (!width || !height) return undefined;
  return { format: "png", width, height, alpha };
}

/** SOFn markers carry the frame size: C0–CF, except C4 (DHT), C8 (JPG), and CC (DAC). */
const isStartOfFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function jpegInfo(bytes: Uint8Array): ImageInfo | undefined {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1]!;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at++;
      continue;
    }
    // Markers without a length: TEM, RSTn, SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    // EOI or start of scan before a frame header: there's no size to find.
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = u16(bytes, at + 2);
    if (length < 2) return undefined;
    if (isStartOfFrame(marker)) {
      // Length (2), precision (1), height (2), width (2).
      if (at + 9 > bytes.length) return undefined;
      const height = u16(bytes, at + 5);
      const width = u16(bytes, at + 7);
      return width && height ? { format: "jpeg", width, height, alpha: false } : undefined;
    }
    at += 2 + length;
  }
  return undefined;
}

/** The format, size, and transparency of a PNG or JPEG from its header; undefined for anything else. */
export function imageInfo(bytes: Uint8Array): ImageInfo | undefined {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return pngInfo(bytes);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegInfo(bytes);
  return undefined;
}

// MARK: Files

/** The MD5 of some bytes as hex, which is what App Store Connect's sourceFileChecksum holds. */
export const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");

/** A file's MD5, read in chunks so a 500 MB preview isn't held in memory. */
export async function fileMd5(path: string): Promise<string> {
  const hash = createHash("md5");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

/** Compares file names the way people number them: "2-a" before "10-b". */
export function naturalCompare(a: string, b: string): number {
  const split = (text: string) => text.toLowerCase().match(/\d+|\D+/g) ?? [];
  const [x, y] = [split(a), split(b)];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const [p, q] = [x[i]!, y[i]!];
    if (p === q) continue;
    const numeric = /^\d/.test(p) && /^\d/.test(q);
    if (numeric) {
      const difference = Number(p) - Number(q);
      if (difference) return difference;
      // "01" and "1": the shorter one first, so the order is stable.
      if (p.length !== q.length) return p.length - q.length;
      continue;
    }
    return p < q ? -1 : 1;
  }
  return x.length - y.length || (a < b ? -1 : a > b ? 1 : 0);
}
