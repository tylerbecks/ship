// ship api: one signed request to any App Store Connect endpoint, for what
// ship has no command for yet. Prints Apple's document as it came back.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type Document, type Method, all, api } from "../asc/client";
import { type Command, type Context, boolFlag, stringFlag } from "../command";
import { loadProject } from "../config";
import { ShipError, ui } from "../ui";
import { appId } from "./status";

export const apiHelp = `ship api [GET] <path> [--all]
ship api POST|PATCH|PUT|DELETE <path> [--body <json> | --body-file <path>]

Sends one request to the App Store Connect API, signed with ship's API key,
and prints Apple's JSON as it came back. For anything ship has no command
for yet; see developer.apple.com/documentation/appstoreconnectapi.

{app} in the path is the app's App Store Connect id (this repo's, or
--app's), so you never look it up:

  ship api /v1/apps/{app}/customerReviews?limit=5
  ship api /v1/apps/{app}/builds --all
  ship api PATCH /v1/builds/<id> --body-file build.json

ship retries when Apple is busy, like every command. --read-only (or
SHIP_READ_ONLY=1) refuses anything but GET.

  --all               GET: follow the next links and return every page's data
  --body <json>       The request body, as JSON
  --body-file <path>  The request body from a file (- reads stdin)`;

const METHODS: Method[] = ["GET", "POST", "PATCH", "PUT", "DELETE"];

const usage = (message: string, hint: string, details?: Record<string, unknown>) => new ShipError(message, "usage", hint, details, 2);

/** The method and path from `ship api [METHOD] <path>`. */
export function parseRequest(args: string[]): { method: Method; path: string } {
  const named = METHODS.find((method) => method === args[0]?.toUpperCase());
  const [path, ...extra] = named ? args.slice(1) : args;
  if (!path) throw usage("Which endpoint? ship api [METHOD] <path>", "For example: ship api /v1/apps/{app}/builds");
  if (!named && /^[A-Za-z]+$/.test(path) && args.length > 1) {
    throw usage(`"${args[0]}" isn't a method`, `Pick one: ${METHODS.join(", ")}`, { choices: METHODS });
  }
  if (extra.length) throw usage(`ship api takes a method and a path, not "${extra.join(" ")}"`, "Quote a path with spaces, and pass a body with --body or --body-file.");
  if (!/^\/v\d+\//.test(path) && !path.startsWith("https://api.appstoreconnect.apple.com/")) {
    throw usage(`"${path}" isn't an App Store Connect path`, "Paths start with the API version, like /v1/apps/{app} (or the full https://api.appstoreconnect.apple.com/... link).");
  }
  return { method: named ?? "GET", path };
}

/** The request body from --body or --body-file, parsed so a typo fails before anything is sent. */
async function readBody(ctx: Context, method: Method): Promise<unknown> {
  const inline = stringFlag(ctx, "body");
  const file = stringFlag(ctx, "body-file");
  if (inline === undefined && file === undefined) return undefined;
  if (inline !== undefined && file !== undefined) throw usage("Pass --body or --body-file, not both", "--body takes the JSON itself; --body-file a file with it.");
  if (method === "GET") throw usage("A GET has no body", "Put parameters in the path: ship api '/v1/apps/{app}/builds?limit=5'");
  let text = inline;
  if (file === "-") {
    if (process.stdin.isTTY) throw usage("--body-file - reads the body from a pipe, not the terminal", "For example: cat body.json | ship api POST /v1/… --body-file -");
    text = await Bun.stdin.text();
  } else if (file !== undefined) {
    const full = resolve(file);
    if (!existsSync(full) || !statSync(full).isFile()) throw usage(`No file at ${file}`, `Check the path (it's relative to ${process.cwd()}).`);
    text = await Bun.file(full).text();
  }
  try {
    return JSON.parse(text!);
  } catch (error) {
    throw usage(`The body isn't valid JSON (${error instanceof Error ? error.message : String(error)})`, "App Store Connect takes JSON:API documents, like {\"data\": {\"type\": …, \"attributes\": {…}}}.");
  }
}

async function apiCommand(ctx: Context) {
  const { method, path: given } = parseRequest(ctx.args);
  const pages = boolFlag(ctx, "all");
  if (pages && method !== "GET") throw usage("--all follows pages of a GET", `Drop --all for ${method}.`);
  const body = await readBody(ctx, method);
  let path = given;
  if (path.includes("{app}")) {
    const id = await appId(await loadProject({ app: ctx.app }));
    path = path.replaceAll("{app}", encodeURIComponent(id));
  }
  if (pages) {
    const doc = await all(path);
    return ui.result(doc, () => console.log(JSON.stringify(doc, null, 2)));
  }
  const doc: Document | undefined = await api(method, path, body);
  if (!doc) {
    ui.ok(`${method} ${path.split("?")[0]}: done (no content)`);
    return ui.result({});
  }
  ui.result(doc, () => console.log(JSON.stringify(doc, null, 2)));
}

export const commands: Command[] = [
  {
    name: "api",
    index: [{ section: "other", label: "api <path>", summary: "One request to any App Store Connect endpoint" }],
    help: apiHelp,
    flags: {
      all: { type: "boolean" },
      body: { type: "string" },
      "body-file": { type: "string" },
    },
    run: apiCommand,
  },
];
