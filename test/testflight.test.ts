import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Feedback, feedbackPath, getFeedback, listFeedback, mergeFeedback, toFeedback } from "../src/asc/feedback";
import { type BetaGroup, groupCreateBody, groupNamed } from "../src/asc/testflight";
import type { Context } from "../src/command";
import { expiresSoon, feedback, feedbackFolder, imageExtension, kindsFor } from "../src/commands/feedback";
import { findGroup, groupJSON, groups, linkUpdate, newGroup } from "../src/commands/groups";
import { testflight } from "../src/commands/testflight";
import { INTERNAL_TESTER_HINT, checkEmails, matchTesters, testers, uniqueEmails } from "../src/commands/testers";
import { appsPath, loadProject } from "../src/config";
import { useCredentials } from "../src/credentials";
import { changesJSON, renderChanges } from "../src/diff";
import {
  type BetaInfoFiles,
  type RemoteBetaInfo,
  filesFromRemote,
  planBetaInfo,
  pullBetaInfo,
  readBetaInfo,
  testflightDir,
  validateBetaInfo,
} from "../src/store/testflight";
import { ui } from "../src/ui";
import { type AscCall, captureLog, jsonApi, mockAsc, noRetryDelay, resource, temp, testCredentials } from "./helpers";

const APP = "app1";

/** A repo with ship.json, known to this machine as "Lift". */
function setup(extra: Record<string, unknown> = {}) {
  const root = realpathSync(temp());
  writeFileSync(
    join(root, "ship.json"),
    JSON.stringify({ name: "Lift", kind: "xcodeproj", path: "App.xcodeproj", scheme: "App", bundleId: "com.example.tf", ascAppId: APP, ...extra }),
  );
  writeFileSync(appsPath, JSON.stringify([{ name: "Lift", bundleId: "com.example.tf", root, addedAt: "1" }]));
  return root;
}

const ctx = (args: string[], flags: Context["flags"] = {}): Context => ({ args, flags, app: "Lift", implicit: false });

/** Runs a command with --json and returns what it printed, parsed. */
async function json(body: () => Promise<unknown>): Promise<any> {
  ui.json = true;
  ui.quiet = true;
  const output = await captureLog(body);
  return JSON.parse(output);
}

const rejects = async (body: () => Promise<unknown>) => {
  try {
    await body();
  } catch (error) {
    return error as { code?: string; exitCode?: number; hint?: string; details?: Record<string, unknown>; message: string };
  }
  throw new Error("expected an error");
};

const group = (id: string, name: string, attributes: Record<string, unknown> = {}) =>
  resource("betaGroups", id, { name, isInternalGroup: false, publicLinkEnabled: false, ...attributes });
const tester = (id: string, email: string, firstName = "", lastName = "") => resource("betaTesters", id, { email, firstName, lastName, state: "ACCEPTED" });

let mock: ReturnType<typeof mockAsc> | undefined;
let delay: ReturnType<typeof noRetryDelay>;

beforeEach(async () => {
  await testCredentials();
  delay = noRetryDelay();
});

afterEach(() => {
  mock?.restore();
  mock = undefined;
  delay.restore();
  useCredentials(undefined);
  ui.json = false;
  ui.quiet = false;
  process.exitCode = 0;
});

const calls = (method: string, path?: string) => mock!.calls.filter((c) => c.method === method && (!path || c.path === path));

// MARK: Testers

describe("testers", () => {
  test("emails: once each, checked, and matched without case", () => {
    expect(uniqueEmails(["a@x.com", " A@X.com", "b@x.com", ""])).toEqual(["a@x.com", "b@x.com"]);
    expect(() => checkEmails([], "add")).toThrow();
    try {
      checkEmails(["a@x.com", "nope", "also bad"], "remove");
    } catch (error) {
      expect(error).toMatchObject({ code: "usage", exitCode: 2, details: { invalid: ["nope", "also bad"] } });
    }
    const list = [
      { id: "t1", email: "Ann@Example.com", name: "Ann" },
      { id: "t2", email: "bob@example.com", name: "Bob" },
    ];
    const { found, notFound } = matchTesters(list, ["ann@example.com", "cat@example.com"]);
    expect(found).toEqual([{ email: "ann@example.com", tester: list[0]! }]);
    expect(notFound).toEqual(["cat@example.com"]);
  });

  test("remove takes testers out of the group with one DELETE, and reports who wasn't there", async () => {
    setup();
    let members = [tester("t1", "ann@example.com", "Ann"), tester("t2", "bob@example.com", "Bob")];
    mock = mockAsc((call) => {
      if (call.path === `/v1/apps/${APP}/betaGroups`) return { json: jsonApi([group("g1", "Friends"), group("g2", "Team", { isInternalGroup: true })]) };
      if (call.method === "GET" && call.path === "/v1/betaGroups/g1/betaTesters") return { json: jsonApi(members) };
      if (call.method === "DELETE" && call.path === "/v1/betaGroups/g1/relationships/betaTesters") {
        const ids = (call.body as { data: { id: string }[] }).data.map((d) => d.id);
        members = members.filter((m) => !ids.includes(m.id));
        return { status: 204 };
      }
    });
    const output = await json(() => testers("remove", ["ANN@example.com", "cat@example.com"], { app: "Lift" }));
    expect(calls("DELETE")[0]!.body).toEqual({ data: [{ type: "betaTesters", id: "t1" }] });
    expect(output).toMatchObject({ group: "Friends", removed: ["ANN@example.com"], notFound: ["cat@example.com"], everywhere: false });
    expect(output.testers.map((t: { email: string }) => t.email)).toEqual(["bob@example.com"]);
    expect(Object.keys(output.testers[0])).toEqual(["id", "email", "name", "state"]);
  });

  test("remove --everywhere looks each tester up and takes them out of the app", async () => {
    setup();
    mock = mockAsc((call) => {
      if (call.path === `/v1/apps/${APP}/betaGroups`) return { json: jsonApi([group("g1", "Friends")]) };
      if (call.path === "/v1/betaTesters") {
        const email = call.query["filter[email]"];
        return { json: jsonApi(email === "ann@example.com" ? [tester("t1", "Ann@Example.com")] : []) };
      }
      if (call.method === "DELETE" && call.path === `/v1/apps/${APP}/relationships/betaTesters`) return { status: 204 };
      if (call.path === "/v1/betaGroups/g1/betaTesters") return { json: jsonApi([]) };
    });
    const output = await json(() => testers("remove", ["ann@example.com", "zed@example.com"], { app: "Lift", everywhere: true }));
    const lookup = calls("GET", "/v1/betaTesters")[0]!;
    expect(lookup.query["filter[apps]"]).toBe(APP);
    expect(lookup.query["fields[betaTesters]"]).toBe("email,firstName,lastName,state,inviteType");
    expect(calls("DELETE")[0]!.body).toEqual({ data: [{ type: "betaTesters", id: "t1" }] });
    expect(output).toMatchObject({ group: "Friends", removed: ["ann@example.com"], notFound: ["zed@example.com"], everywhere: true, testers: [] });
  });

  test("nobody found means no DELETE at all", async () => {
    setup();
    mock = mockAsc((call) => {
      if (call.path === `/v1/apps/${APP}/betaGroups`) return { json: jsonApi([group("g1", "Friends")]) };
      if (call.path === "/v1/betaGroups/g1/betaTesters") return { json: jsonApi([]) };
    });
    const output = await json(() => testers("remove", ["x@example.com"], { app: "Lift" }));
    expect(output.notFound).toEqual(["x@example.com"]);
    expect(calls("DELETE")).toEqual([]);
  });

  test("add keeps going after a failure, and explains internal groups", async () => {
    setup();
    mock = mockAsc((call) => {
      if (call.path === `/v1/apps/${APP}/betaGroups`) return { json: jsonApi([group("g1", "Friends"), group("g2", "Team", { isInternalGroup: true })]) };
      if (call.method === "POST" && call.path === "/v1/betaTesters") {
        const email = (call.body as { data: { attributes: { email: string } } }).data.attributes.email;
        if (email === "stranger@example.com") {
          return { status: 409, json: { errors: [{ status: "409", code: "ENTITY_ERROR", title: "Not allowed", detail: "Not a team member" }] } };
        }
        return { status: 201, json: { data: tester("t9", email) } };
      }
      if (call.path === "/v1/betaGroups/g2/betaTesters") return { json: jsonApi([tester("t9", "me@example.com")]) };
    });
    const output = await json(() => testers("add", ["stranger@example.com", "me@example.com"], { app: "Lift", group: "team" }));
    expect(calls("POST").length).toBe(2);
    expect(output.group).toBe("Team");
    expect(output.invited).toEqual(["me@example.com"]);
    expect(output.failed).toEqual([{ email: "stranger@example.com", message: expect.stringContaining("Not a team member"), code: "api-409", hint: INTERNAL_TESTER_HINT }]);
    expect(process.exitCode).toBe(1);
  });

  test("usage errors: unknown action, --everywhere with --group, a group that isn't there", async () => {
    expect(await rejects(() => testers("kick", [], {}))).toMatchObject({ code: "usage", exitCode: 2, details: { choices: ["list", "add", "remove"] } });
    expect(await rejects(() => testers("remove", ["a@x.com"], { group: "A", everywhere: true }))).toMatchObject({ code: "usage", exitCode: 2 });
    expect(await rejects(() => testers("add", ["a@x.com"], { everywhere: true }))).toMatchObject({ code: "usage" });
    setup();
    mock = mockAsc((call) => {
      if (call.path === `/v1/apps/${APP}/betaGroups`) return { json: jsonApi([group("g1", "Friends")]) };
    });
    expect(await rejects(() => testers("list", [], { app: "Lift", group: "Nope" }))).toMatchObject({ code: "no-group", details: { choices: ["Friends"] } });
  });
});

// MARK: Groups

describe("groups", () => {
  const external: BetaGroup = { id: "g1", name: "Friends", isInternal: false };
  const internal: BetaGroup = { id: "g2", name: "Team", isInternal: true };

  test("create checks combinations Apple doesn't have", () => {
    expect(() => newGroup("A", { allBuilds: true })).toThrow("--all-builds is for internal groups");
    expect(() => newGroup("A", { internal: true, publicLink: true })).toThrow("Internal groups have no public link");
    expect(() => newGroup("A", { internal: true, limit: 5 })).toThrow("Internal groups have no public link");
    expect(newGroup("A", { internal: true, allBuilds: true })).toEqual({ name: "A", isInternalGroup: true, hasAccessToAllBuilds: true });
    expect(newGroup("A", { limit: 50, noFeedback: true })).toEqual({
      name: "A",
      isInternalGroup: false,
      publicLinkEnabled: true,
      publicLinkLimitEnabled: true,
      publicLinkLimit: 50,
      feedbackEnabled: false,
    });
    expect(groupCreateBody("app1", { name: "A", isInternalGroup: false })).toEqual({
      data: { type: "betaGroups", attributes: { name: "A", isInternalGroup: false }, relationships: { app: { data: { type: "apps", id: "app1" } } } },
    });
  });

  test("link on, off, and limits", () => {
    expect(linkUpdate(external, "on", {})).toEqual({ publicLinkEnabled: true });
    expect(linkUpdate(external, "on", { limit: 25 })).toEqual({ publicLinkEnabled: true, publicLinkLimitEnabled: true, publicLinkLimit: 25 });
    expect(linkUpdate(external, "on", { noLimit: true })).toEqual({ publicLinkEnabled: true, publicLinkLimitEnabled: false });
    expect(linkUpdate(external, "off", {})).toEqual({ publicLinkEnabled: false });
    expect(() => linkUpdate(external, "off", { limit: 3 })).toThrow();
    expect(() => linkUpdate(external, "on", { limit: 3, noLimit: true })).toThrow();
    expect(() => linkUpdate(internal, "on", {})).toThrow("internal group");
    try {
      linkUpdate(external, undefined, {});
    } catch (error) {
      expect(error).toMatchObject({ code: "usage", details: { choices: ["on", "off"] } });
    }
  });

  test("names match without case, but exactly", () => {
    const list = [external, { ...external, id: "g3", name: "Friends 2" }];
    expect(groupNamed(list, "friends")?.id).toBe("g1");
    expect(groupNamed(list, "Friend")).toBeUndefined();
    expect(() => findGroup(list, "Nope")).toThrow('No TestFlight group called "Nope"');
  });

  test("list counts testers from the paging total", async () => {
    setup();
    mock = mockAsc((call) => {
      if (call.path === `/v1/apps/${APP}/betaGroups`) {
        return {
          json: jsonApi([
            group("g1", "Friends", { publicLinkEnabled: true, publicLink: "https://testflight.apple.com/join/abc", publicLinkLimitEnabled: true, publicLinkLimit: 100, feedbackEnabled: true }),
            group("g2", "Team", { isInternalGroup: true, hasAccessToAllBuilds: true }),
          ]),
        };
      }
      if (call.path === "/v1/betaGroups/g1/betaTesters") return { json: jsonApi([tester("t1", "a@x.com")], { total: 37 }) };
      if (call.path === "/v1/betaGroups/g2/betaTesters") return { json: jsonApi([], { total: 0 }) };
    });
    const output = await json(() => groups(ctx([])));
    expect(calls("GET", "/v1/betaGroups/g1/betaTesters")[0]!.query.limit).toBe("1");
    expect(output.groups).toEqual([
      {
        id: "g1",
        name: "Friends",
        isInternal: false,
        automatic: false,
        publicLink: "https://testflight.apple.com/join/abc",
        publicLinkEnabled: true,
        publicLinkLimit: 100,
        publicLinkLimitEnabled: true,
        feedbackEnabled: true,
        testers: 37,
        createdDate: null,
      },
      expect.objectContaining({ name: "Team", isInternal: true, automatic: true, publicLink: null, testers: 0 }),
    ]);
  });

  test("create sends what the flags say, and refuses a name that's taken", async () => {
    setup();
    mock = mockAsc((call) => {
      if (call.path === `/v1/apps/${APP}/betaGroups`) return { json: jsonApi([group("g1", "Friends")]) };
      if (call.method === "POST" && call.path === "/v1/betaGroups") {
        const attributes = (call.body as { data: { attributes: Record<string, unknown> } }).data.attributes;
        return { status: 201, json: { data: group("g9", attributes.name as string, attributes) } };
      }
    });
    const output = await json(() => groups(ctx(["create", "Beta"], { "public-link": true, limit: "200" })));
    expect(calls("POST")[0]!.body).toEqual({
      data: {
        type: "betaGroups",
        attributes: { name: "Beta", isInternalGroup: false, publicLinkEnabled: true, publicLinkLimitEnabled: true, publicLinkLimit: 200 },
        relationships: { app: { data: { type: "apps", id: APP } } },
      },
    });
    expect(output.group).toMatchObject({ id: "g9", name: "Beta", publicLinkLimit: 200, testers: 0 });

    expect(await rejects(() => groups(ctx(["create", "FRIENDS"])))).toMatchObject({ code: "group-exists" });
    expect(calls("POST").length).toBe(1);
  });

  test("usage errors come before any request", async () => {
    setup();
    mock = mockAsc(() => undefined);
    expect(await rejects(() => groups(ctx(["create", "A"], { limit: "0" })))).toMatchObject({ code: "usage", exitCode: 2 });
    expect(await rejects(() => groups(ctx(["create", "A"], { limit: "10001" })))).toMatchObject({ code: "usage" });
    expect(await rejects(() => groups(ctx(["create", "A"], { internal: true, "public-link": true })))).toMatchObject({ code: "usage" });
    expect(await rejects(() => groups(ctx(["create", "A"], { "all-builds": true })))).toMatchObject({ code: "usage" });
    expect(await rejects(() => groups(ctx(["rename", "A", "B"], { internal: true })))).toMatchObject({ code: "usage" });
    expect(await rejects(() => groups(ctx(["create", "Beta", "testers"])))).toMatchObject({ code: "usage", hint: expect.stringContaining('"Beta testers"') });
    expect(await rejects(() => groups(ctx(["delete"])))).toMatchObject({ code: "usage" });
    expect(await rejects(() => groups(ctx(["link", "Friends", "maybe"])))).toMatchObject({ code: "usage", details: { choices: ["on", "off"] } });
    expect(await rejects(() => testers("list", [], { app: "Lift", group: " " }))).toMatchObject({ code: "usage" });
    expect(await rejects(() => groups(ctx(["archive"])))).toMatchObject({ code: "usage", details: { choices: ["list", "create", "rename", "link", "delete"] } });
    expect(mock.calls).toEqual([]);
  });

  test("link, rename, and delete", async () => {
    setup({ groups: { external: ["Friends"] } });
    mock = mockAsc((call) => {
      if (call.path === `/v1/apps/${APP}/betaGroups`) return { json: jsonApi([group("g1", "Friends")]) };
      if (call.method === "PATCH" && call.path === "/v1/betaGroups/g1") {
        const attributes = (call.body as { data: { attributes: Record<string, unknown> } }).data.attributes;
        return { json: { data: group("g1", (attributes.name as string) ?? "Friends", { ...attributes, publicLink: "https://testflight.apple.com/join/x" }) } };
      }
      if (call.path === "/v1/betaGroups/g1/betaTesters") return { json: jsonApi([], { total: 4 }) };
      if (call.method === "DELETE" && call.path === "/v1/betaGroups/g1") return { status: 204 };
    });
    const linked = await json(() => groups(ctx(["link", "friends", "on"], { limit: "50" })));
    expect(calls("PATCH")[0]!.body).toEqual({ data: { type: "betaGroups", id: "g1", attributes: { publicLinkEnabled: true, publicLinkLimitEnabled: true, publicLinkLimit: 50 } } });
    expect(linked.group).toMatchObject({ publicLinkEnabled: true, publicLinkLimit: 50, testers: 4 });

    await json(() => groups(ctx(["link", "Friends", "off"])));
    expect(calls("PATCH")[1]!.body).toEqual({ data: { type: "betaGroups", id: "g1", attributes: { publicLinkEnabled: false } } });

    const renamed = await json(() => groups(ctx(["rename", "Friends", "Pals"])));
    expect(calls("PATCH")[2]!.body).toEqual({ data: { type: "betaGroups", id: "g1", attributes: { name: "Pals" } } });
    expect(renamed.group.name).toBe("Pals");

    expect(await json(() => groups(ctx(["delete", "FRIENDS"])))).toEqual({ ok: true, deleted: "Friends" });
    expect(calls("DELETE", "/v1/betaGroups/g1").length).toBe(1);
  });

  test("groupJSON always has every field", () => {
    expect(Object.keys(groupJSON(external, 2))).toEqual([
      "id",
      "name",
      "isInternal",
      "automatic",
      "publicLink",
      "publicLinkEnabled",
      "publicLinkLimit",
      "publicLinkLimitEnabled",
      "feedbackEnabled",
      "testers",
      "createdDate",
    ]);
  });
});

// MARK: Test information

const remoteInfo = (overrides: { review?: Record<string, unknown>; localizations?: RemoteBetaInfo["localizations"] } = {}): RemoteBetaInfo => ({
  review: {
    id: APP,
    attributes: {
      contactFirstName: "Tyler",
      contactLastName: "Becks",
      contactEmail: "tyler@example.com",
      contactPhone: "+1 555 0100",
      demoAccountName: "review@example.com",
      demoAccountPassword: "hunter2",
      demoAccountRequired: true,
      notes: "Sign in with the demo account.",
      ...overrides.review,
    },
  },
  localizations: overrides.localizations ?? [
    {
      id: "loc-en",
      locale: "en-US",
      attributes: {
        description: "Track every lift.\nAnd every set.",
        feedbackEmail: "beta@example.com",
        marketingUrl: "https://example.com",
        privacyPolicyUrl: "https://example.com/privacy",
        tvOsPrivacyPolicy: null,
      },
    },
  ],
});

/** Mocks App Store Connect's test information endpoints with `remote`. */
function mockBetaInfo(remote: RemoteBetaInfo, extra: (call: AscCall) => ReturnType<Parameters<typeof mockAsc>[0]> = () => undefined) {
  return mockAsc((call) => {
    if (call.method === "GET" && call.path === `/v1/apps/${APP}/betaAppReviewDetail`) {
      return { json: { data: resource("betaAppReviewDetails", remote.review.id, remote.review.attributes) } };
    }
    if (call.method === "GET" && call.path === `/v1/apps/${APP}/betaAppLocalizations`) {
      return { json: jsonApi(remote.localizations.map((l) => resource("betaAppLocalizations", l.id, { locale: l.locale, ...l.attributes }))) };
    }
    return extra(call);
  });
}

const emptyInfo = (): BetaInfoFiles => ({ locales: {}, unknownKeys: [], unknownFiles: [] });

describe("testflight test information", () => {
  test("files from App Store Connect never hold the password", () => {
    const files = filesFromRemote(remoteInfo());
    expect([...files.keys()]).toEqual([
      "review.json",
      "review-notes.txt",
      "en-US/description.txt",
      "en-US/feedback-email.txt",
      "en-US/marketing-url.txt",
      "en-US/privacy-policy-url.txt",
    ]);
    expect(JSON.parse(files.get("review.json")!)).toEqual({
      contactFirstName: "Tyler",
      contactLastName: "Becks",
      contactEmail: "tyler@example.com",
      contactPhone: "+1 555 0100",
      demoAccountRequired: true,
      demoAccountName: "review@example.com",
      demoAccountPassword: null,
    });
    expect([...files.values()].join("")).not.toContain("hunter2");
    expect(JSON.parse(filesFromRemote(remoteInfo(), { passwordRef: "keychain:ship/demo" }).get("review.json")!).demoAccountPassword).toBe("keychain:ship/demo");
    expect(filesFromRemote(remoteInfo(), { tvos: true }).has("en-US/tvos-privacy-policy.txt")).toBe(true);
  });

  test("pull writes the folder, round-trips with no changes, and is idempotent", async () => {
    setup();
    const remote = remoteInfo();
    mock = mockBetaInfo(remote);
    const project = await loadProject({ app: "Lift" });
    const first = await pullBetaInfo(project, { appId: APP });
    expect(first.written.length).toBe(6);
    expect(first.warnings[0]).toContain("ship secret set keychain:ship/lift-beta-demo-password --stdin");
    const dir = testflightDir(project);
    expect(readFileSync(join(dir, "review.json"), "utf8")).not.toContain("hunter2");
    expect(readFileSync(join(dir, "en-US/description.txt"), "utf8")).toBe("Track every lift.\nAnd every set.\n");

    const local = await readBetaInfo(dir);
    expect(local.review?.contactEmail).toBe("tyler@example.com");
    expect(local.notes).toBe("Sign in with the demo account.");
    // The password is null in the file, which leaves App Store Connect's alone.
    expect(local.review?.demoAccountPassword).toBeNull();
    expect(planBetaInfo(local, remote)).toMatchObject({ changes: [], update: [], create: {}, onlyRemote: [], review: {} });
    expect(planBetaInfo(local, remote).password).toBeUndefined();

    const second = await pullBetaInfo(project, { appId: APP });
    expect(second.written).toEqual([]);
    expect(second.unchanged.length).toBe(6);
  });

  test("pull stops at local changes unless --force, and keeps a password reference", async () => {
    setup();
    mock = mockBetaInfo(remoteInfo());
    const project = await loadProject({ app: "Lift" });
    await pullBetaInfo(project, { appId: APP });
    const dir = testflightDir(project);
    writeFileSync(join(dir, "en-US/description.txt"), "Mine now\n");
    const review = JSON.parse(readFileSync(join(dir, "review.json"), "utf8"));
    writeFileSync(join(dir, "review.json"), JSON.stringify({ ...review, demoAccountPassword: "env:DEMO_PW" }));
    expect(await rejects(() => pullBetaInfo(project, { appId: APP }))).toMatchObject({ code: "local-changes", details: { files: ["en-US/description.txt"] } });
    expect(readFileSync(join(dir, "en-US/description.txt"), "utf8")).toBe("Mine now\n");
    const forced = await pullBetaInfo(project, { appId: APP, force: true });
    expect(forced.written).toEqual(["en-US/description.txt"]);
    expect(forced.warnings).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "review.json"), "utf8")).demoAccountPassword).toBe("env:DEMO_PW");
  });

  test("plan: changes, clears, new languages, and languages only in App Store Connect", () => {
    const remote = remoteInfo({ localizations: [...remoteInfo().localizations, { id: "loc-de", locale: "de-DE", attributes: { description: "Hallo" } }] });
    const local: BetaInfoFiles = {
      ...emptyInfo(),
      notes: "New notes",
      locales: {
        "en-US": { description: "Track every lift.\nAnd every set.\nAnd rest.", marketingUrl: "" },
        "fr-FR": { description: "Bonjour", feedbackEmail: "" },
      },
    };
    const plan = planBetaInfo(local, remote);
    expect(plan.changes.map((c) => `${c.scope} ${c.field} ${c.kind}`)).toEqual([
      "testflight/review notes change",
      "testflight/en-US description change",
      "testflight/en-US marketingUrl remove",
      "testflight/fr-FR description add",
    ]);
    expect(plan.review).toEqual({ notes: "New notes" });
    expect(plan.update).toEqual([{ locale: "en-US", id: "loc-en", attributes: { description: "Track every lift.\nAnd every set.\nAnd rest.", marketingUrl: null } }]);
    expect(plan.create).toEqual({ "fr-FR": { description: "Bonjour" } });
    expect(plan.onlyRemote).toEqual([{ locale: "de-DE", id: "loc-de" }]);
    expect(planBetaInfo(local, remote, { prune: true }).changes.at(-1)).toMatchObject({ scope: "testflight/de-DE", field: "localization", kind: "remove" });
    expect(planBetaInfo(local, remote, { locales: ["fr-FR"] }).update).toEqual([]);
  });

  test("the password: compared when Apple shows it, sent with other changes when it doesn't, never printed", () => {
    const local: BetaInfoFiles = { ...emptyInfo(), review: { demoAccountPassword: "env:DEMO_PW" } };
    const shown = planBetaInfo(local, remoteInfo(), { resolvedPassword: "new-secret" });
    expect(shown.password).toBe("set");
    const rendered = renderChanges(shown.changes) + JSON.stringify(changesJSON(shown.changes)) + JSON.stringify(shown.changes);
    expect(rendered).not.toContain("new-secret");
    expect(rendered).not.toContain("hunter2");
    expect(changesJSON(shown.changes)).toEqual([{ scope: "testflight/review", field: "demoAccountPassword", kind: "change", from: "••••", to: "••••", secret: true }]);
    expect(planBetaInfo(local, remoteInfo(), { resolvedPassword: "hunter2" }).changes).toEqual([]);

    const { demoAccountPassword: _, ...hiddenAttributes } = remoteInfo().review.attributes;
    const hidden: RemoteBetaInfo = { ...remoteInfo(), review: { id: APP, attributes: hiddenAttributes } };
    expect(planBetaInfo(local, hidden)).toMatchObject({ changes: [], passwordHidden: true });
    expect(planBetaInfo(local, hidden).password).toBeUndefined();
    const withNotes = planBetaInfo({ ...local, notes: "Changed" }, hidden);
    expect(withNotes.password).toBe("set");

    const unset = remoteInfo({ review: { demoAccountPassword: null } });
    expect(planBetaInfo(local, unset).changes[0]).toMatchObject({ field: "demoAccountPassword", kind: "add", secret: true });

    // null leaves it alone; "" clears it.
    expect(planBetaInfo({ ...emptyInfo(), review: { demoAccountPassword: null } }, remoteInfo()).changes).toEqual([]);
    const cleared = planBetaInfo({ ...emptyInfo(), review: { demoAccountPassword: "" } }, remoteInfo());
    expect(cleared.password).toBe("clear");
    expect(changesJSON(cleared.changes)).toEqual([{ scope: "testflight/review", field: "demoAccountPassword", kind: "remove", from: "••••", to: null, secret: true }]);
  });

  test("push sends the resolved password to Apple and nowhere else", async () => {
    const root = setup();
    process.env.SHIP_TEST_DEMO_PW = "s3cret-pw";
    try {
      const remote = remoteInfo({ review: { demoAccountPassword: "old-pw" } });
      mock = mockBetaInfo(remote, (call) => {
        if (call.method === "PATCH" || call.method === "POST" || call.method === "DELETE") return { status: call.method === "POST" ? 201 : 200, json: { data: {} } };
      });
      const dir = join(root, "appstore", "testflight");
      mkdirSync(join(dir, "en-US"), { recursive: true });
      mkdirSync(join(dir, "ja"), { recursive: true });
      writeFileSync(join(dir, "review.json"), JSON.stringify({ contactEmail: "new@example.com", demoAccountPassword: "env:SHIP_TEST_DEMO_PW" }));
      writeFileSync(join(dir, "en-US", "description.txt"), "Track every lift.\nAnd every set.\n");
      writeFileSync(join(dir, "en-US", "marketing-url.txt"), "");
      writeFileSync(join(dir, "ja", "description.txt"), "こんにちは\n");

      const dry = await json(() => testflight(ctx(["push"], { "dry-run": true })));
      expect(dry).toMatchObject({ dryRun: true, applied: false, created: { locales: ["ja"] }, deleted: { locales: [] } });
      expect(calls("PATCH")).toEqual([]);
      ui.json = false;

      const output = await json(() => testflight(ctx(["push"])));
      const text = JSON.stringify(output);
      expect(text).not.toContain("s3cret-pw");
      expect(text).not.toContain("old-pw");
      expect(output).toMatchObject({ applied: true, created: { locales: ["ja"] } });
      expect(calls("PATCH", `/v1/betaAppReviewDetails/${APP}`)[0]!.body).toEqual({
        data: { type: "betaAppReviewDetails", id: APP, attributes: { contactEmail: "new@example.com", demoAccountPassword: "s3cret-pw" } },
      });
      expect(calls("PATCH", "/v1/betaAppLocalizations/loc-en")[0]!.body).toEqual({
        data: { type: "betaAppLocalizations", id: "loc-en", attributes: { marketingUrl: null } },
      });
      expect(calls("POST", "/v1/betaAppLocalizations")[0]!.body).toEqual({
        data: { type: "betaAppLocalizations", attributes: { locale: "ja", description: "こんにちは" }, relationships: { app: { data: { type: "apps", id: APP } } } },
      });
      expect(calls("DELETE")).toEqual([]);
      expect(existsSync(join(dir, "review.json")) && readFileSync(join(dir, "review.json"), "utf8")).not.toContain("s3cret-pw");
    } finally {
      delete process.env.SHIP_TEST_DEMO_PW;
    }
  });

  test("push refuses a plaintext password before asking Apple anything", async () => {
    const root = setup();
    mock = mockAsc(() => undefined);
    const dir = join(root, "appstore", "testflight");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "review.json"), JSON.stringify({ demoAccountRequired: true, demoAccountName: "a@example.com", demoAccountPassword: "hunter2" }));
    const error = await rejects(() => testflight(ctx(["push"])));
    expect(error).toMatchObject({ code: "plaintext-secret" });
    expect(`${error.message} ${error.hint}`).not.toContain("hunter2");
    expect(error.hint).toContain("ship secret set keychain:ship/lift-beta-demo-password --stdin");
    expect(mock.calls).toEqual([]);
  });

  test("validate: lengths, URLs, emails, the demo account, plaintext passwords", async () => {
    const problems = validateBetaInfo({
      ...emptyInfo(),
      review: { contactEmail: "nope", demoAccountRequired: true, demoAccountName: "", demoAccountPassword: "hunter2" },
      unknownKeys: ["extra"],
      locales: {
        "en-US": { description: "x".repeat(4001), marketingUrl: "example.com", feedbackEmail: "beta@" },
        "xx-YY": {},
      },
    });
    const summary = problems.map((p) => `${p.severity} ${p.file}${p.field ? `#${p.field}` : ""}${p.code ? ` ${p.code}` : ""}`);
    expect(summary).toEqual([
      "warning testflight/review.json#extra",
      "error testflight/review.json#contactEmail",
      "error testflight/review.json#demoAccountPassword plaintext-secret",
      "error testflight/review.json#demoAccountName",
      "error testflight/en-US/description.txt",
      "error testflight/en-US/feedback-email.txt",
      "error testflight/en-US/marketing-url.txt",
      "warning testflight/xx-YY",
    ]);
    expect(JSON.stringify(problems)).not.toContain("hunter2");
    expect(validateBetaInfo({ ...emptyInfo(), review: { demoAccountRequired: true, demoAccountName: "a", demoAccountPassword: "keychain:ship/x" } })).toEqual([]);
    expect(validateBetaInfo({ ...emptyInfo(), review: { demoAccountRequired: "yes" as unknown as boolean } })[0]!.message).toContain("true or false");
  });

  test("validate through the command, and a broken review.json", async () => {
    const root = setup();
    const dir = join(root, "appstore", "testflight");
    mkdirSync(join(dir, "en-US"), { recursive: true });
    writeFileSync(join(dir, "en-US", "feedback-email.txt"), "beta@example.com\n");
    writeFileSync(join(dir, "en-US", "notes.txt"), "?");
    const output = await json(() => testflight(ctx(["validate"])));
    expect(output).toEqual({ ok: true, valid: true, problems: [expect.objectContaining({ file: "testflight/en-US/notes.txt", severity: "warning" })] });
    writeFileSync(join(dir, "review.json"), "{ nope");
    expect(await rejects(() => testflight(ctx(["validate"])))).toMatchObject({ code: "bad-store-file", details: { file: join(dir, "review.json") } });
    expect(await rejects(() => testflight(ctx(["pull"], { prune: true })))).toMatchObject({ code: "usage" });
    expect(await rejects(() => testflight(ctx(["sync"])))).toMatchObject({ code: "usage", details: { choices: ["pull", "diff", "push", "validate"] } });
  });

  test("diff --exit-code", async () => {
    const root = setup();
    mock = mockBetaInfo(remoteInfo());
    const dir = join(root, "appstore", "testflight", "en-US");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "feedback-email.txt"), "new@example.com\n");
    const output = await json(() => testflight(ctx(["diff"], { "exit-code": true })));
    expect(output).toMatchObject({ hasChanges: true, onlyRemote: [], changes: [{ scope: "testflight/en-US", field: "feedbackEmail", kind: "change", from: "beta@example.com", to: "new@example.com" }] });
    expect(process.exitCode).toBe(1);
  });
});

// MARK: Feedback

const submission = (type: string, id: string, createdDate: string, attributes: Record<string, unknown> = {}) =>
  resource(type, id, { createdDate, deviceModel: "iPhone17,1", osVersion: "26.1", devicePlatform: "IOS", deviceFamily: "IPHONE", locale: "en-US", ...attributes }, {
    build: { data: { type: "builds", id: "b1" } },
    tester: { data: { type: "betaTesters", id: "t1" } },
  });
const included = [resource("builds", "b1", { version: "42" }), resource("betaTesters", "t1", { email: "ann@example.com", firstName: "Ann", lastName: "Lee" })];

describe("feedback", () => {
  test("maps submissions, with or without what was included", () => {
    const shot = toFeedback(
      "screenshot",
      submission("betaFeedbackScreenshotSubmissions", "s1", "2026-10-20T10:00:00Z", {
        comment: "The button is cut off",
        appUptimeInMilliseconds: 5000,
        batteryPercentage: 80,
        screenshots: [{ url: "https://cdn.example.com/a.png", width: 1179, height: 2556, expirationDate: "2026-10-21T10:00:00Z" }],
      }) as any,
      included as any,
    );
    expect(shot).toEqual({
      id: "s1",
      kind: "screenshot",
      createdDate: "2026-10-20T10:00:00Z",
      comment: "The button is cut off",
      tester: { email: "ann@example.com", name: "Ann Lee" },
      build: { id: "b1", number: "42" },
      device: { model: "iPhone17,1", osVersion: "26.1", family: "IPHONE", platform: "IOS", architecture: null, connectionType: null },
      locale: "en-US",
      timeZone: null,
      appUptimeMs: 5000,
      batteryPercentage: 80,
      screenshots: [{ url: "https://cdn.example.com/a.png", width: 1179, height: 2556, expirationDate: "2026-10-21T10:00:00Z" }],
    });
    const crash = toFeedback("crash", resource("betaFeedbackCrashSubmissions", "c1", { createdDate: "2026-10-19T00:00:00Z", email: "bob@example.com" }) as any);
    expect(crash).toMatchObject({ kind: "crash", tester: { email: "bob@example.com", name: "" }, build: null, comment: null, screenshots: [] });
  });

  test("merges newest first, then limits", () => {
    const item = (id: string, createdDate: string) => ({ id, createdDate }) as Feedback;
    const merged = mergeFeedback([[item("a", "2026-10-03"), item("b", "2026-10-01")], [item("c", "2026-10-02"), item("d", "2026-10-03")]], 3);
    expect(merged.map((f) => f.id)).toEqual(["a", "d", "c"]);
    expect(feedbackPath("app1", "crash", { buildId: "b1", limit: 500 })).toBe(
      "/v1/apps/app1/betaFeedbackCrashSubmissions?include=build,tester&fields[betaTesters]=email,firstName,lastName&fields[builds]=version&sort=-createdDate&limit=200&filter[build]=b1",
    );
  });

  test("small parts: folders, extensions, expiry, kinds", () => {
    expect(feedbackFolder({ id: "AbC-1", createdDate: "2026-10-20T10:00:00Z" })).toBe("2026-10-20-AbC-1");
    expect(feedbackFolder({ id: "../../etc", createdDate: "" })).toBe("undated--..-etc");
    expect(imageExtension("image/jpeg; charset=binary", "https://x/y")).toBe("jpg");
    expect(imageExtension(null, "https://x/y/shot.JPEG?sig=1")).toBe("jpg");
    expect(imageExtension("application/octet-stream", "https://x/y")).toBe("png");
    const item = { screenshots: [{ url: "https://x", width: 1, height: 1, expirationDate: "2026-10-21T10:00:00Z" }] } as Feedback;
    expect(expiresSoon(item, Date.parse("2026-10-21T09:00:00Z"))).toBe(false);
    expect(expiresSoon(item, Date.parse("2026-10-21T09:58:00Z"))).toBe(true);
    expect(kindsFor({})).toEqual(["screenshot", "crash"]);
    expect(kindsFor({ crashes: true })).toEqual(["crash"]);
    expect(() => kindsFor({ crashes: true, screenshots: true })).toThrow();
  });

  test("lists both kinds for a build", async () => {
    await testCredentials();
    mock = mockAsc((call) => {
      if (call.path === "/v1/apps/app1/betaFeedbackScreenshotSubmissions") {
        return { json: jsonApi([submission("betaFeedbackScreenshotSubmissions", "s1", "2026-10-20T10:00:00Z")], { included }) };
      }
      if (call.path === "/v1/apps/app1/betaFeedbackCrashSubmissions") {
        return { json: jsonApi([submission("betaFeedbackCrashSubmissions", "c1", "2026-10-21T10:00:00Z")], { included }) };
      }
    });
    const items = await listFeedback("app1", { buildId: "b1", limit: 5 });
    expect(items.map((f) => `${f.kind} ${f.id}`)).toEqual(["crash c1", "screenshot s1"]);
    for (const call of mock.calls) {
      expect(call.query).toMatchObject({ include: "build,tester", sort: "-createdDate", limit: "5", "filter[build]": "b1", "fields[builds]": "version" });
    }
  });

  test("an id that isn't a screenshot is tried as a crash", async () => {
    mock = mockAsc((call) => {
      if (call.path === "/v1/betaFeedbackCrashSubmissions/c1") return { json: { data: submission("betaFeedbackCrashSubmissions", "c1", "2026-10-21T10:00:00Z"), included } };
    });
    expect((await getFeedback("c1"))?.kind).toBe("crash");
    expect(mock.calls.map((c) => c.path)).toEqual(["/v1/betaFeedbackScreenshotSubmissions/c1", "/v1/betaFeedbackCrashSubmissions/c1"]);
    expect(await getFeedback("nope")).toBeUndefined();
  });

  test("download saves screenshots (without the API key), comments, and crash logs", async () => {
    const root = setup();
    const out = join(root, "out");
    mock = mockAsc((call) => {
      if (call.url.host === "cdn.example.com") return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
      if (call.path === "/v1/betaFeedbackScreenshotSubmissions/s1") {
        return {
          json: {
            data: submission("betaFeedbackScreenshotSubmissions", "s1", "2026-10-20T10:00:00Z", {
              comment: "Cut off",
              screenshots: [{ url: "https://cdn.example.com/a", width: 10, height: 20, expirationDate: "2999-01-01T00:00:00Z" }],
            }),
            included,
          },
        };
      }
      if (call.path === "/v1/betaFeedbackCrashSubmissions/c1") return { json: { data: submission("betaFeedbackCrashSubmissions", "c1", "2026-10-21T10:00:00Z"), included } };
      if (call.path === "/v1/betaFeedbackCrashSubmissions/c1/crashLog") return { json: { data: resource("betaCrashLogs", "l1", { logText: "Thread 0 Crashed" }) } };
    });
    const output = await json(() => feedback(ctx(["download", "s1", "c1", "gone"], { out })));
    expect(output.dir).toBe(out);
    expect(output.files).toEqual([
      join(out, "2026-10-20-s1", "comment.txt"),
      join(out, "2026-10-20-s1", "screenshot-1.png"),
      join(out, "2026-10-20-s1", "feedback.json"),
      join(out, "2026-10-21-c1", "crash.log"),
      join(out, "2026-10-21-c1", "feedback.json"),
    ]);
    expect(output.notFound).toEqual(["gone"]);
    expect(process.exitCode).toBe(1);
    const image = mock.calls.find((c) => c.url.host === "cdn.example.com")!;
    expect(image.headers.get("authorization")).toBeNull();
    expect(readFileSync(join(out, "2026-10-21-c1", "crash.log"), "utf8")).toBe("Thread 0 Crashed\n");
    expect(readFileSync(join(out, "2026-10-20-s1", "feedback.json"), "utf8")).not.toContain("cdn.example.com");
  });

  test("show adds the crash log; delete reports what wasn't there", async () => {
    setup();
    mock = mockAsc((call) => {
      if (call.method === "GET" && call.path === "/v1/betaFeedbackCrashSubmissions/c1") {
        return { json: { data: submission("betaFeedbackCrashSubmissions", "c1", "2026-10-21T10:00:00Z"), included } };
      }
      if (call.path === "/v1/betaFeedbackCrashSubmissions/c1/crashLog") return { json: { data: resource("betaCrashLogs", "l1", { logText: "boom" }) } };
      if (call.method === "DELETE" && call.path === "/v1/betaFeedbackCrashSubmissions/c1") return { status: 204 };
    });
    const shown = await json(() => feedback(ctx(["show", "c1"])));
    expect(shown.feedback).toMatchObject({ id: "c1", kind: "crash", crashLog: "boom", build: { number: "42" } });
    const deleted = await json(() => feedback(ctx(["delete", "c1", "x9"])));
    expect(deleted).toEqual({ ok: true, deleted: ["c1"], notFound: ["x9"] });
    expect(await rejects(() => feedback(ctx(["show"])))).toMatchObject({ code: "usage" });
    expect(await rejects(() => feedback(ctx(["list"], { crashes: true, screenshots: true })))).toMatchObject({ code: "usage" });
    expect(await rejects(() => feedback(ctx(["download", "c1"], { build: "3" })))).toMatchObject({ code: "usage" });
  });
});
