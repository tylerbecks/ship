// What makes ship safe and easy to drive from scripts and agents: exit codes
// by kind, read-only mode, --app by id, ship api, waiting, ship reviews,
// JUnit reports, and help as JSON.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, get, policy } from "../src/asc/client";
import { reviewsPath, toReview } from "../src/asc/reviews";
import { type Context, findCommand, indexJSON, parseFlags } from "../src/command";
import { commands } from "../src/commands";
import { parseRequest } from "../src/commands/api";
import { PROCESSING_TIMEOUT_MS, waitForProcessing } from "../src/commands/beta";
import { checkReply, parseRatings, parseTerritory, stars } from "../src/commands/reviews";
import { appsPath, findApp } from "../src/config";
import { useCredentials } from "../src/credentials";
import { checksSuite, junitXML, problemsSuite, writeJUnit } from "../src/junit";
import { EXIT, ShipError, exitCodeFor, ui } from "../src/ui";
import { describeDuration, parseDuration, polling, waitFor } from "../src/wait";
import { captureLog, jsonApi, mockAsc, noRetryDelay, resource, temp, testCredentials } from "./helpers";

const APP = "1234567890";

/** A repo with ship.json, known to this machine as "Lift". */
function setup() {
  const root = realpathSync(temp());
  writeFileSync(
    join(root, "ship.json"),
    JSON.stringify({ name: "Lift", kind: "xcodeproj", path: "App.xcodeproj", scheme: "App", bundleId: "com.example.lift", ascAppId: APP }),
  );
  writeFileSync(appsPath, JSON.stringify([{ name: "Lift", bundleId: "com.example.lift", root, addedAt: "1" }]));
  return root;
}

/** Runs `ship <argv> --app Lift --json` in-process and returns its JSON. */
async function ship(argv: string[]): Promise<any> {
  const [name, ...rest] = argv;
  const command = findCommand(commands, name)!;
  const { values, positionals } = parseFlags(rest, command.flags);
  const ctx: Context = { args: positionals, flags: values, app: "Lift", implicit: false };
  ui.json = true;
  ui.quiet = true;
  return JSON.parse(await captureLog(() => command.run(ctx)));
}

async function rejected(body: () => Promise<unknown>): Promise<ShipError> {
  try {
    await body();
  } catch (error) {
    if (error instanceof ShipError) return error;
    throw error;
  }
  throw new Error("expected a ShipError");
}

const caught = (body: () => unknown) => rejected(async () => body());

let mock: ReturnType<typeof mockAsc> | undefined;
let delay: ReturnType<typeof noRetryDelay>;
const realPolling = { ...polling };

beforeEach(async () => {
  await testCredentials();
  delay = noRetryDelay();
  ui.quiet = true;
});

afterEach(() => {
  mock?.restore();
  mock = undefined;
  delay.restore();
  useCredentials(undefined);
  Object.assign(polling, realPolling);
  policy.readOnly = false;
  ui.json = false;
  ui.quiet = false;
  process.exitCode = 0;
});

/** Makes waits instant: each sleep moves the clock forward and runs `onSleep`. */
function fastClock(onSleep: (slept: number) => void = () => {}) {
  let now = 0;
  let sleeps = 0;
  polling.now = () => now;
  polling.sleep = async (ms) => {
    now += ms;
    onSleep(++sleeps);
  };
  return { sleeps: () => sleeps };
}

// MARK: Exit codes

describe("exit codes", () => {
  test("each kind of failure has its own code", () => {
    expect(exitCodeFor("api-401")).toBe(EXIT.auth);
    expect(exitCodeFor("no-credentials")).toBe(EXIT.auth);
    expect(exitCodeFor("api-404")).toBe(EXIT.notFound);
    expect(exitCodeFor("no-build")).toBe(EXIT.notFound);
    expect(exitCodeFor("unknown-app")).toBe(EXIT.notFound);
    expect(exitCodeFor("api-409")).toBe(EXIT.conflict);
    expect(exitCodeFor("build-in-use")).toBe(EXIT.conflict);
    expect(exitCodeFor("read-only")).toBe(EXIT.readOnly);
    expect(exitCodeFor("processing-timeout")).toBe(EXIT.pending);
    expect(exitCodeFor("still-pending")).toBe(EXIT.pending);
    expect(exitCodeFor("usage")).toBe(EXIT.usage);
    expect(exitCodeFor("bad-ipa")).toBe(EXIT.failure);
    expect(Object.values(EXIT)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("a ShipError takes its code's kind unless it says otherwise", () => {
    expect(new ShipError("x", "no-build").exitCode).toBe(4);
    expect(new ShipError("x", "ambiguous-app", undefined, undefined, 2).exitCode).toBe(2);
    expect(new ShipError("x", "something-else").exitCode).toBe(1);
  });

  test("Apple's errors keep their status's kind", async () => {
    mock = mockAsc(() => ({ status: 409, json: { errors: [{ status: "409", code: "STATE_ERROR", title: "Nope" }] } }));
    const error = await rejected(() => api("PATCH", "/v1/builds/1", {}));
    expect(error).toMatchObject({ code: "api-409", exitCode: EXIT.conflict });
  });
});

// MARK: Read-only mode

describe("read-only mode", () => {
  test("reads go through; changes are refused before they're sent", async () => {
    mock = mockAsc(() => ({ json: jsonApi([]) }));
    policy.readOnly = true;
    await get("/v1/apps");
    const error = await rejected(() => api("PATCH", "/v1/builds/123?x=1", { data: {} }));
    expect(error).toMatchObject({ code: "read-only", exitCode: 6, details: { refused: "send PATCH /v1/builds/123" } });
    expect(error.hint).toContain("--dry-run");
    expect(mock.calls.map((call) => call.method)).toEqual(["GET"]);
  });

  test("ship api honors it too", async () => {
    setup();
    mock = mockAsc(() => ({ status: 204 }));
    policy.readOnly = true;
    const error = await rejected(() => ship(["api", "DELETE", "/v1/betaTesters/t1"]));
    expect(error.code).toBe("read-only");
    expect(mock.calls).toEqual([]);
  });
});

// MARK: --app

describe("--app", () => {
  test("takes the App Store Connect id from an app's ship.json", async () => {
    const root = setup();
    expect((await findApp(APP)).root).toBe(root);
    expect((await findApp("lift")).root).toBe(root);
    const error = await rejected(() => findApp("999"));
    expect(error).toMatchObject({ code: "unknown-app", exitCode: 4 });
    expect(error.message).toBe("No app on this machine has App Store Connect id 999");
  });
});

// MARK: ship api

describe("ship api", () => {
  test("parses a method and a path", async () => {
    expect(parseRequest(["/v1/apps"])).toEqual({ method: "GET", path: "/v1/apps" });
    expect(parseRequest(["patch", "/v1/builds/1"])).toEqual({ method: "PATCH", path: "/v1/builds/1" });
    expect(parseRequest(["https://api.appstoreconnect.apple.com/v1/apps?cursor=x"]).method).toBe("GET");
    expect((await caught(() => parseRequest([]))).code).toBe("usage");
    expect((await caught(() => parseRequest(["FETCH", "/v1/apps"]))).details?.choices).toContain("PATCH");
    expect((await caught(() => parseRequest(["apps"]))).hint).toContain("/v1/apps/{app}");
    expect((await caught(() => parseRequest(["GET", "/v1/apps", "extra"]))).exitCode).toBe(2);
  });

  test("{app} is the app's id, and Apple's document comes back as is", async () => {
    setup();
    mock = mockAsc((call) => (call.path === `/v1/apps/${APP}/builds` ? { json: jsonApi([resource("builds", "b1", { version: "7" })]) } : undefined));
    const output = await ship(["api", "/v1/apps/{app}/builds?limit=1"]);
    expect(output).toMatchObject({ ok: true, data: [{ type: "builds", id: "b1", attributes: { version: "7" } }] });
    expect(mock.calls[0]!.query.limit).toBe("1");
  });

  test("--all follows the pages", async () => {
    setup();
    mock = mockAsc((call) =>
      call.query.cursor
        ? { json: jsonApi([resource("apps", "2")]) }
        : { json: jsonApi([resource("apps", "1")], { next: "https://api.appstoreconnect.apple.com/v1/apps?cursor=two" }) },
    );
    const output = await ship(["api", "/v1/apps", "--all"]);
    expect(output.data.map((item: { id: string }) => item.id)).toEqual(["1", "2"]);
    expect((await rejected(() => ship(["api", "POST", "/v1/apps", "--all"]))).code).toBe("usage");
  });

  test("sends the body, checked as JSON first", async () => {
    setup();
    const file = join(temp(), "body.json");
    writeFileSync(file, JSON.stringify({ data: { type: "builds", id: "b1", attributes: { expired: true } } }));
    mock = mockAsc((call) => (call.method === "PATCH" ? { json: jsonApi(resource("builds", "b1", { expired: true })) } : undefined));
    const output = await ship(["api", "PATCH", "/v1/builds/b1", "--body-file", file]);
    expect(output.data.attributes.expired).toBe(true);
    expect(mock.calls[0]!.body).toEqual({ data: { type: "builds", id: "b1", attributes: { expired: true } } });
    expect((await rejected(() => ship(["api", "POST", "/v1/x", "--body", "{nope"]))).message).toContain("isn't valid JSON");
    expect((await rejected(() => ship(["api", "/v1/apps", "--body", "{}"]))).message).toBe("A GET has no body");
    expect(mock.calls).toHaveLength(1);
  });

  test("an empty answer is ok", async () => {
    setup();
    mock = mockAsc(() => ({ status: 204 }));
    expect(await ship(["api", "DELETE", "/v1/betaTesters/t1"])).toEqual({ ok: true });
  });
});

// MARK: Waiting

describe("waiting", () => {
  test("durations", async () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration(" 2H ")).toBe(2 * 60 * 60_000);
    expect(parseDuration("1d")).toBe(24 * 60 * 60_000);
    for (const bad of ["", "0m", "2", "1.5h", "2 weeks"]) expect((await caught(() => parseDuration(bad))).code).toBe("usage");
    expect(describeDuration(PROCESSING_TIMEOUT_MS)).toBe("1 hour");
    expect(describeDuration(90_000)).toBe("90 seconds");
    expect(describeDuration(30 * 60_000)).toBe("30 minutes");
    expect(describeDuration(2 * 24 * 60 * 60_000)).toBe("2 days");
  });

  test("waitFor reports each new state and gives up at the timeout", async () => {
    const clock = fastClock();
    const states: string[] = [];
    const error = await rejected(() =>
      waitFor({
        everyMs: 60_000,
        timeoutMs: 150_000,
        progress: (state) => states.push(state),
        check: async () => ({ done: false, state: clock.sleeps() < 2 ? "waiting" : "in review" }),
        timedOut: (last) => new ShipError(`still ${last}`, "still-pending"),
      }),
    );
    expect(error).toMatchObject({ message: "still in review", exitCode: 7 });
    expect(states).toEqual(["waiting", "in review"]);
    // 60 s, 60 s, then the last 30 s: never past the timeout.
    expect(clock.sleeps()).toBe(3);
  });

  const build = (state: string) => ({
    json: jsonApi([resource("builds", "b9", { version: "9", processingState: state, uploadedDate: "2026-10-20T10:00:00Z", expired: false })]),
  });

  test("a build: waits through processing", async () => {
    let state = "PROCESSING";
    fastClock((n) => {
      if (n === 2) state = "VALID";
    });
    mock = mockAsc((call) => (call.path === "/v1/builds" ? build(state) : undefined));
    const found = await waitForProcessing(APP, "9", "IOS");
    expect(found.processingState).toBe("VALID");
    expect(mock.calls).toHaveLength(3);
  });

  test("a build: still processing at the timeout exits 7, with how to pick up", async () => {
    fastClock();
    mock = mockAsc((call) => (call.path === "/v1/builds" ? build("PROCESSING") : undefined));
    const error = await rejected(() => waitForProcessing(APP, "9", "IOS", { timeoutMs: 60_000, later: "ship builds show 9 --wait" }));
    expect(error).toMatchObject({ code: "processing-timeout", exitCode: 7, details: { build: "9", processingState: "PROCESSING" } });
    expect(error.message).toBe("Build 9 is still processing after 1 minute");
    expect(error.hint).toBe("Finish later with: ship builds show 9 --wait");
  });

  test("ship builds show --wait, and --timeout needs --wait", async () => {
    setup();
    fastClock();
    let calls = 0;
    mock = mockAsc((call) => (call.path === "/v1/builds" ? build(++calls === 1 ? "PROCESSING" : "VALID") : undefined));
    const output = await ship(["builds", "show", "9", "--wait", "--timeout", "10m"]);
    expect(output.build).toMatchObject({ number: "9", processingState: "VALID" });
    expect((await rejected(() => ship(["builds", "show", "9", "--timeout", "10m"]))).message).toBe("--timeout goes with --wait");
    expect((await rejected(() => ship(["builds", "--wait"]))).code).toBe("usage");
  });
});

// MARK: ship reviews

const review = (id: string, rating: number, reply?: { id: string; body: string; state: string }) =>
  resource(
    "customerReviews",
    id,
    { rating, title: `Title ${id}`, body: `Body ${id}`, reviewerNickname: `nick${id}`, territory: "USA", createdDate: "2026-10-20T10:00:00Z" },
    { response: { data: reply ? { type: "customerReviewResponses", id: reply.id } : null } },
  );
const replyResource = (reply: { id: string; body: string; state: string }) =>
  resource("customerReviewResponses", reply.id, { responseBody: reply.body, state: reply.state, lastModifiedDate: "2026-10-21T10:00:00Z" });

describe("ship reviews", () => {
  test("flags", async () => {
    expect(parseRatings(["1", "2,1"])).toEqual([1, 2]);
    expect((await caught(() => parseRatings(["6"]))).code).toBe("usage");
    expect(parseTerritory("usa")).toBe("USA");
    expect(parseTerritory(undefined)).toBeUndefined();
    expect((await caught(() => parseTerritory("US"))).code).toBe("usage");
    expect(checkReply("  Thanks!\r\n")).toBe("Thanks!");
    expect((await caught(() => checkReply("   "))).message).toBe("The reply is empty");
    expect((await caught(() => checkReply("x".repeat(5971)))).message).toContain("up to 5970");
    expect(stars(4)).toBe("★★★★☆");
  });

  test("the list's query", () => {
    const path = reviewsPath(APP, { ratings: [1, 2], territory: "GBR", unanswered: true, sort: "lowest", limit: 500 });
    const query = Object.fromEntries(new URL(`https://x${path}`).searchParams);
    expect(query).toEqual({
      include: "response",
      sort: "rating",
      limit: "200",
      "filter[rating]": "1,2",
      "filter[territory]": "GBR",
      "exists[publishedResponse]": "false",
    });
  });

  test("a review with its reply", () => {
    const answer = { id: "r1", body: "Fixed!", state: "PUBLISHED" };
    expect(toReview(review("c1", 2, answer) as unknown as Parameters<typeof toReview>[0], [replyResource(answer)])).toEqual({
      id: "c1",
      rating: 2,
      title: "Title c1",
      body: "Body c1",
      reviewer: "nickc1",
      territory: "USA",
      createdDate: "2026-10-20T10:00:00Z",
      reply: { id: "r1", body: "Fixed!", state: "PUBLISHED", lastModifiedDate: "2026-10-21T10:00:00Z" },
    });
  });

  test("list, reply, and unreply", async () => {
    setup();
    const answer = { id: "r1", body: "Old answer", state: "PUBLISHED" };
    mock = mockAsc((call) => {
      if (call.path === `/v1/apps/${APP}/customerReviews`) return { json: jsonApi([review("c1", 1), review("c2", 5, answer)], { included: [replyResource(answer)] }) };
      if (call.path === "/v1/customerReviews/c1") return { json: jsonApi(review("c1", 1)) };
      if (call.path === "/v1/customerReviews/c2") return { json: jsonApi(review("c2", 5, answer), { included: [replyResource(answer)] }) };
      if (call.method === "POST" && call.path === "/v1/customerReviewResponses") {
        return { status: 201, json: jsonApi(replyResource({ id: "r2", body: (call.body as any).data.attributes.responseBody, state: "PENDING_PUBLISH" })) };
      }
      if (call.method === "DELETE" && call.path === "/v1/customerReviewResponses/r1") return { status: 204 };
      return undefined;
    });

    const list = await ship(["reviews", "--rating", "1", "--unanswered"]);
    expect(list.reviews.map((r: { id: string; reply: unknown }) => [r.id, Boolean(r.reply)])).toEqual([
      ["c1", false],
      ["c2", true],
    ]);
    expect(mock.calls[0]!.query).toMatchObject({ "filter[rating]": "1", "exists[publishedResponse]": "false" });

    const dry = await ship(["reviews", "reply", "c1", "--text", "Thanks!", "--dry-run"]);
    expect(dry).toMatchObject({ dryRun: true, replaced: false, reply: { body: "Thanks!" } });
    expect(mock.calls.filter((call) => call.method !== "GET")).toEqual([]);

    const replied = await ship(["reviews", "reply", "c1", "--text", "Thanks!"]);
    expect(replied).toMatchObject({ replaced: false, reply: { id: "r2", body: "Thanks!", state: "PENDING_PUBLISH" } });
    expect(mock.calls.at(-1)!.body).toEqual({
      data: { type: "customerReviewResponses", attributes: { responseBody: "Thanks!" }, relationships: { review: { data: { type: "customerReviews", id: "c1" } } } },
    });

    const removed = await ship(["reviews", "unreply", "c2"]);
    expect(removed).toMatchObject({ deleted: { id: "r1" }, review: { reply: null } });
    expect(mock.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/customerReviewResponses/r1" });

    expect(await rejected(() => ship(["reviews", "unreply", "c1"]))).toMatchObject({ code: "no-reply", exitCode: 4 });
    expect((await rejected(() => ship(["reviews", "reply", "c1"]))).message).toBe("What's the reply? Pass --text or --text-file");
    expect((await rejected(() => ship(["reviews", "show", "c1", "--rating", "1"]))).code).toBe("usage");
  });

  test("an unknown review id exits 4", async () => {
    setup();
    mock = mockAsc(() => undefined);
    expect(await rejected(() => ship(["reviews", "show", "nope"]))).toMatchObject({ code: "no-review", exitCode: 4 });
  });
});

// MARK: JUnit

describe("JUnit reports", () => {
  test("blocking checks fail, warnings pass with their detail, and text is escaped", () => {
    const xml = junitXML(
      checksSuite("ship release submit", [
        { name: "build", ok: true, detail: "Build 37", blocking: true },
        { name: "description", ok: false, detail: 'No description in "en-US" <here>', blocking: true, fix: "Write en-US/description.txt & push" },
        { name: "ipadScreenshots", ok: false, detail: "No iPad screenshots", blocking: false, fix: "Add some" },
      ]),
    );
    expect(xml).toContain('<testsuite name="ship release submit" tests="3" failures="1" errors="0" skipped="0">');
    expect(xml).toContain('<testcase classname="ship release submit" name="build"/>');
    expect(xml).toContain('<failure message="No description in &quot;en-US&quot; &lt;here&gt;">Write en-US/description.txt &amp; push</failure>');
    expect(xml).toContain("<system-out>No iPad screenshots\nAdd some</system-out>");
    // A doctor check has no blocking flag: a failure fails.
    expect(checksSuite("ship doctor", [{ name: "Xcode", ok: false, detail: "missing" }]).cases[0]!.failure).toEqual({ message: "missing", detail: undefined });
  });

  test("validate problems: errors fail, warnings pass, none is one passing case", async () => {
    expect(problemsSuite("ship metadata validate", [])).toEqual({ name: "ship metadata validate", cases: [{ name: "valid" }] });
    const suite = problemsSuite("ship metadata validate", [
      { file: "en-US/keywords.txt", message: "Over 100 bytes", severity: "error" },
      { file: "app.json", field: "review.contactPhone", message: "Looks short", severity: "warning" },
    ]);
    expect(suite.cases).toEqual([
      { name: "en-US/keywords.txt", failure: { message: "Over 100 bytes" } },
      { name: "app.json (review.contactPhone)", output: "Looks short" },
    ]);
    const path = join(temp(), "reports", "junit.xml");
    await writeJUnit(path, suite);
    expect(readFileSync(path, "utf8")).toStartWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="ship metadata validate" tests="2" failures="1">');
  });

  test("ship metadata validate --junit writes the report", async () => {
    const root = setup();
    const store = join(root, "appstore", "en-US");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "name.txt"), "x".repeat(31));
    const path = join(temp(), "metadata.xml");
    const output = await ship(["metadata", "validate", "--junit", path]);
    expect(output.valid).toBe(false);
    expect(readFileSync(path, "utf8")).toContain('<testcase classname="ship metadata validate" name="en-US/name.txt (name)">');
    expect((await rejected(() => ship(["metadata", "pull", "--junit", path]))).code).toBe("usage");
  });
});

// MARK: Help as JSON

describe("ship help --json", () => {
  test("lists every command with its usage and flags, the global flags, and the exit codes", () => {
    const index = indexJSON(commands, "1.0");
    const names = index.commands.map((command) => command.name);
    expect(names).toContain("api");
    expect(names).toContain("reviews");
    const reviews = index.commands.find((command) => command.name === "reviews")!;
    expect(reviews.usage[0]).toStartWith("ship reviews [list]");
    expect(reviews.flags).toContainEqual({ name: "rating", type: "string", multiple: true });
    expect(index.globalFlags.map((flag) => flag.name)).toEqual(["json", "app", "read-only", "quiet", "help"]);
    expect(index.exitCodes).toMatchObject({ 0: "success", 2: "usage", 6: "readOnly", 7: "pending" });
    expect(index.sections.at(-1)).toEqual({ section: "other", title: "Anything else" });
  });

  test("the CLI prints it, and help for one command", async () => {
    const env = { ...process.env, SHIP_HOME: temp() };
    const run = async (...args: string[]) => {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      return JSON.parse(text);
    };
    expect((await run("help", "--json")).commands.length).toBe(commands.length);
    expect((await run("reviews", "--help", "--json")).command.name).toBe("reviews");
  });
});
