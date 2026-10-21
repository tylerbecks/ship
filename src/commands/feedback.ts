// ship feedback: the screenshots and crash reports testers send from
// TestFlight. Lists them, shows one, saves them to disk, and deletes the ones
// you've dealt with.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { findBuild } from "../asc/builds";
import { type Feedback, type FeedbackKind, crashLog, deleteFeedback, getFeedback, listFeedback } from "../asc/feedback";
import { type Command, type Context, boolFlag, intFlag, stringFlag } from "../command";
import { loadProject } from "../config";
import { platformInfo } from "../platform";
import { ShipError, table, ui } from "../ui";
import { appId } from "./status";

export const feedbackHelp = `ship feedback [list] [--build <n>] [--crashes | --screenshots] [--limit <n>]
ship feedback show <id>
ship feedback download [<id>...] [--out <dir>]
ship feedback delete <id>...

Shows what testers sent from TestFlight: screenshots with comments, and
crash reports. download saves the screenshots and crash logs to
.ship/feedback/ (or --out). delete removes feedback you've dealt with.

Without ids, download saves what list shows (the same flags pick it).

  --build <n>     Only feedback on this build number
  --crashes       Only crash reports
  --screenshots   Only screenshots
  --limit <n>     How many, newest first (default 20)
  --out <dir>     download: where to save (default .ship/feedback)`;

const ACTIONS = ["list", "show", "download", "delete"];

const FILTERS = ["build", "crashes", "screenshots", "limit"];

const ACTION_FLAGS: Record<string, string[]> = {
  list: FILTERS,
  show: [],
  download: [...FILTERS, "out"],
  delete: [],
};

/** Screenshot links closer than this to expiring are fetched again before downloading. */
const FRESH_MS = 5 * 60_000;

const usage = (message: string, hint: string, details?: Record<string, unknown>) => new ShipError(message, "usage", hint, details, 2);

// MARK: Pure parts

/** The folder one submission is saved in: its day and id, like 2026-10-21-AbC123. */
export function feedbackFolder(item: Pick<Feedback, "id" | "createdDate">): string {
  const day = /^\d{4}-\d{2}-\d{2}/.test(item.createdDate) ? item.createdDate.slice(0, 10) : "undated";
  // Ids come from Apple, but never let one leave the folder.
  return `${day}-${item.id.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "")}`;
}

/** A file extension for a downloaded image, from its Content-Type, else its URL, else png. */
export function imageExtension(contentType: string | null, url: string): string {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const byType: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/heic": "heic", "image/webp": "webp" };
  if (byType[type]) return byType[type]!;
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {}
  const ext = path.match(/\.(png|jpe?g|heic|webp)$/)?.[1];
  return ext === "jpeg" ? "jpg" : (ext ?? "png");
}

/** Whether a submission's screenshot links are missing an expiry or about to expire. */
export function expiresSoon(item: Feedback, now = Date.now()): boolean {
  return item.screenshots.some((s) => !s.expirationDate || Date.parse(s.expirationDate) - now < FRESH_MS);
}

/** Which kinds --crashes and --screenshots ask for. */
export function kindsFor(options: { crashes?: boolean; screenshots?: boolean }): FeedbackKind[] {
  if (options.crashes && options.screenshots) {
    throw usage("Pass --crashes or --screenshots, not both", "Leave both off for everything: ship feedback", { choices: ["--crashes", "--screenshots"] });
  }
  return options.crashes ? ["crash"] : options.screenshots ? ["screenshot"] : ["screenshot", "crash"];
}

const who = (item: Feedback) => (item.tester ? item.tester.name || item.tester.email : "");
const day = (date: string) => (date ? new Date(date).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const oneLine = (text: string | null, max = 50) => {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return [...line].length > max ? `${[...line].slice(0, max - 1).join("")}…` : line;
};

// MARK: Downloading

/** Fetches a signed screenshot URL. No Authorization header: the URL is its own permission. */
async function fetchImage(url: string): Promise<{ bytes: Uint8Array; ext: string }> {
  if (!url.startsWith("https://")) throw new ShipError(`Not downloading ${url}: it isn't https`, "bad-url", "Run `ship feedback show <id>` to see the links.");
  let response: Response;
  try {
    response = await globalThis.fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new ShipError(`Couldn't download a screenshot (${error instanceof Error ? error.message : String(error)})`, "network", "Check your connection and try again.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ShipError(
      `Couldn't download a screenshot (${response.status})`,
      "download-failed",
      "The link may have expired; run `ship feedback download <id>` again for a fresh one.",
    );
  }
  return { bytes: new Uint8Array(await response.arrayBuffer()), ext: imageExtension(response.headers.get("content-type"), url) };
}

/** Saves one submission in its own folder under `out`. Returns the files written. */
export async function saveFeedback(item: Feedback, out: string): Promise<string[]> {
  const dir = join(out, feedbackFolder(item));
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const write = async (name: string, data: string | Uint8Array) => {
    const path = join(dir, name);
    await Bun.write(path, data);
    files.push(path);
  };
  if (item.comment) await write("comment.txt", `${item.comment.trimEnd()}\n`);
  const saved: { file: string; width: number | null; height: number | null }[] = [];
  for (const [i, screenshot] of item.screenshots.entries()) {
    const { bytes, ext } = await fetchImage(screenshot.url);
    const name = `screenshot-${i + 1}.${ext}`;
    await write(name, bytes);
    saved.push({ file: name, width: screenshot.width, height: screenshot.height });
  }
  if (item.kind === "crash") {
    const log = await crashLog(item.id);
    if (log) await write("crash.log", log.endsWith("\n") ? log : `${log}\n`);
  }
  // The details, without the links (they expire).
  const { screenshots: _links, ...details } = item;
  await write("feedback.json", `${JSON.stringify({ ...details, screenshots: saved }, null, 2)}\n`);
  return files;
}

// MARK: Command

function checkFlags(ctx: Context, action: string) {
  const all = [...new Set(Object.values(ACTION_FLAGS).flat())];
  const extra = all.find((flag) => ctx.flags[flag] !== undefined && !ACTION_FLAGS[action]!.includes(flag));
  if (extra) throw usage(`--${extra} isn't for ${action}`, "See `ship feedback --help`.");
}

export async function feedback(ctx: Context) {
  const action = ctx.args[0] ?? "list";
  if (!ACTIONS.includes(action)) {
    throw usage(`Unknown feedback action "${action}"`, "ship feedback [list|show|download|delete] (see `ship feedback --help`)", { choices: ACTIONS });
  }
  checkFlags(ctx, action);
  const ids = [...new Set(ctx.args.slice(1).map((id) => id.trim()).filter(Boolean))];
  if (action === "list" && ids.length) throw usage("ship feedback list takes no ids", "To see one: ship feedback show <id>");
  if (action === "show" && ids.length !== 1) throw usage("Pass one id: ship feedback show <id>", "`ship feedback` lists the ids.");
  if (action === "delete" && !ids.length) throw usage("Pass the ids to delete: ship feedback delete <id>...", "`ship feedback` lists the ids.");
  if (action === "download" && ids.length && FILTERS.some((flag) => ctx.flags[flag] !== undefined)) {
    throw usage("Pass ids or filters, not both", "ship feedback download <id>..., or ship feedback download --build <n>");
  }
  const kinds = kindsFor({ crashes: boolFlag(ctx, "crashes"), screenshots: boolFlag(ctx, "screenshots") });
  const limit = intFlag(ctx, "limit", { min: 1, max: 200 }) ?? 20;
  const buildNumber = stringFlag(ctx, "build");

  const project = await loadProject({ app: ctx.app });
  const id = await appId(project);

  if (action === "show") {
    const item = await getFeedback(ids[0]!);
    if (!item) throw notFound(ids[0]!);
    const log = item.kind === "crash" ? ((await crashLog(item.id)) ?? null) : undefined;
    return ui.result({ feedback: { ...item, ...(log !== undefined ? { crashLog: log } : {}) } }, () => printOne(item, log));
  }

  if (action === "delete") {
    const deleted: string[] = [];
    const missing: string[] = [];
    for (const feedbackId of ids) {
      if (await deleteFeedback(feedbackId)) {
        deleted.push(feedbackId);
        ui.ok(`Deleted ${feedbackId}`);
      } else {
        missing.push(feedbackId);
        ui.warn(`No feedback with id ${feedbackId} (already deleted?)`);
      }
    }
    return ui.result({ deleted, notFound: missing }, () => console.log(`Deleted ${deleted.length} of ${ids.length}.`));
  }

  let buildId: string | undefined;
  if (buildNumber !== undefined) {
    const build = await findBuild(id, buildNumber, platformInfo(project.platform).asc);
    if (!build) throw new ShipError(`No build ${buildNumber} in App Store Connect`, "no-build", "`ship status` lists recent builds.", { build: buildNumber });
    buildId = build.id;
  }

  if (action === "list") {
    const items = await listFeedback(id, { kinds, buildId, limit });
    return ui.result({ feedback: items }, () => {
      if (!items.length) return console.log(buildNumber ? `No feedback on build ${buildNumber} yet.` : "No feedback yet.");
      console.log(
        table([
          ["ID", "DATE", "KIND", "BUILD", "TESTER", "COMMENT"],
          ...items.map((item) => [
            item.id,
            day(item.createdDate),
            item.kind === "crash" ? "crash" : `${item.screenshots.length} screenshot${item.screenshots.length === 1 ? "" : "s"}`,
            item.build?.number ?? "",
            who(item),
            oneLine(item.comment),
          ]),
        ]),
      );
    });
  }

  // download
  const out = resolve(stringFlag(ctx, "out") ?? join(project.workDir, "feedback"));
  const missing: string[] = [];
  let items: Feedback[];
  if (ids.length) {
    items = [];
    for (const feedbackId of ids) {
      const item = await getFeedback(feedbackId);
      if (item) items.push(item);
      else missing.push(feedbackId);
    }
  } else {
    items = await listFeedback(id, { kinds, buildId, limit });
  }
  const files: string[] = [];
  const failed: { id: string; message: string }[] = [];
  for (let item of items) {
    try {
      // Signed links expire: fetch the submission again when they're about to.
      if (expiresSoon(item)) item = (await getFeedback(item.id)) ?? item;
      ui.step(`Saving ${item.kind} ${item.id}`);
      files.push(...(await saveFeedback(item, out)));
    } catch (error) {
      if (!(error instanceof ShipError)) throw error;
      failed.push({ id: item.id, message: error.message });
      ui.warn(`Couldn't save ${item.id}: ${error.message}`);
      if (error.hint) ui.note(error.hint);
    }
  }
  for (const feedbackId of missing) ui.warn(`No feedback with id ${feedbackId}`);
  ui.result({ dir: out, files, notFound: missing, failed }, () => {
    if (!items.length) return console.log("No feedback to download.");
    console.log(`Saved ${items.length - failed.length} submission${items.length - failed.length === 1 ? "" : "s"} to ${out}`);
  });
  if (missing.length || failed.length) process.exitCode = 1;
}

function notFound(feedbackId: string) {
  return new ShipError(`No feedback with id ${feedbackId}`, "no-feedback", "`ship feedback` lists the ids (they're the long ones in the first column).", { id: feedbackId });
}

function printOne(item: Feedback, log: string | null | undefined) {
  const from = item.tester ? (item.tester.name ? `${item.tester.name} <${item.tester.email}>` : item.tester.email) : "a tester";
  const build = item.build?.number ? ` on build ${item.build.number}` : "";
  console.log(`${item.kind === "crash" ? "Crash" : "Screenshot"} from ${from}${build}, ${day(item.createdDate)}`);
  const device = [item.device.model, item.device.osVersion && `${item.device.platform ?? "OS"} ${item.device.osVersion}`, item.locale]
    .filter(Boolean)
    .join(", ");
  if (device) console.log(device + (item.batteryPercentage !== null ? `, battery ${item.batteryPercentage}%` : ""));
  if (item.comment) console.log(`\n${item.comment}`);
  if (item.screenshots.length) {
    console.log("\nScreenshots (the links expire; `ship feedback download` saves them):");
    item.screenshots.forEach((s, i) => console.log(`  ${i + 1}. ${s.url}`));
  }
  if (item.kind === "crash") console.log(log ? `\n${log.trimEnd()}` : "\nNo crash log yet.");
}

export const commands: Command[] = [
  {
    name: "feedback",
    index: [{ section: "testflight", label: "feedback", summary: "Screenshots and crashes testers sent" }],
    help: feedbackHelp,
    flags: {
      build: { type: "string" },
      limit: { type: "string" },
      out: { type: "string" },
      crashes: { type: "boolean" },
      screenshots: { type: "boolean" },
    },
    run: feedback,
  },
];
