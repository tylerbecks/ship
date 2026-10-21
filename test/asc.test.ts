import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lookupApp } from "../src/asc/apps";
import { buildsPath, findBuild, listBuilds } from "../src/asc/builds";
import {
  AscError,
  all,
  api,
  ascHint,
  associatedErrors,
  bearerToken,
  clockSkew,
  del,
  get,
  many,
  one,
  parseErrors,
  related,
  relatedMany,
  relatedOne,
  retry,
  retryDelay,
  shouldRetry,
} from "../src/asc/client";
import {
  appInfos,
  appStoreVersions,
  editableAppInfo,
  findVersion,
  isEditableVersion,
  liveAppInfo,
  liveVersion,
  pickVersion,
  versionState,
} from "../src/asc/versions";
import { jsonApi, mockAsc, noRetryDelay, resource, testCredentials } from "./helpers";

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
});

async function caught(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as AscError;
  }
  throw new Error("expected an error");
}

describe("the network guard", () => {
  test("an unmocked request fails instead of reaching App Store Connect", async () => {
    const error = await caught(get("/v1/apps"));
    expect(error.message).toContain("Unmocked network call to https://api.appstoreconnect.apple.com/v1/apps");
  });
});

describe("retries", () => {
  test("a 429 waits for Retry-After, then succeeds", async () => {
    let tries = 0;
    mock = mockAsc(() => (++tries === 1 ? { status: 429, json: { errors: [] }, headers: { "Retry-After": "2" } } : { json: jsonApi([]) }));
    await get("/v1/apps");
    expect(mock.calls.length).toBe(2);
    expect(delay.waits).toEqual([2000]);
  });

  test("a 503 backs off, then succeeds", async () => {
    let tries = 0;
    mock = mockAsc(() => (++tries <= 2 ? { status: 503, text: "<html>busy</html>" } : { json: jsonApi([resource("apps", "1")]) }));
    const doc = await get("/v1/apps");
    expect(many(doc).map((app) => app.id)).toEqual(["1"]);
    expect(delay.waits.length).toBe(2);
    expect(delay.waits[0]).toBeGreaterThanOrEqual(1000);
    expect(delay.waits[1]).toBeGreaterThanOrEqual(2000);
  });

  test("gives up after four retries with a hint", async () => {
    mock = mockAsc(() => ({ status: 500, json: { errors: [{ status: "500", code: "UNEXPECTED_ERROR", title: "Internal error", detail: "Oops" }] } }));
    const error = await caught(get("/v1/apps"));
    expect(mock.calls.length).toBe(5);
    expect(error).toBeInstanceOf(AscError);
    expect(error.code).toBe("api-500");
    expect(error.hint).toContain("system-status");
  });

  test("a POST isn't retried on a server error, which might have created something", async () => {
    mock = mockAsc(() => ({ status: 500, json: { errors: [] } }));
    const error = await caught(api("POST", "/v1/betaTesters", { data: {} }));
    expect(mock.calls.length).toBe(1);
    expect(error.status).toBe(500);
  });

  test("a POST is retried on 429", async () => {
    let tries = 0;
    mock = mockAsc(() => (++tries === 1 ? { status: 429 } : { status: 201, json: jsonApi(resource("betaTesters", "t1")) }));
    const doc = await api("POST", "/v1/betaTesters", { data: {} });
    expect(one(doc)?.id).toBe("t1");
    expect(mock.calls.length).toBe(2);
  });

  test("network failures retry for GET but not POST", async () => {
    let tries = 0;
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => {
      if (++tries < 3) throw new TypeError("socket hang up");
      return Response.json(jsonApi([]));
    }) as unknown as typeof fetch;
    try {
      await get("/v1/apps");
      expect(tries).toBe(3);
      tries = 0;
      const error = await caught(api("POST", "/v1/betaTesters", {}));
      expect(tries).toBe(1);
      expect(error.code).toBe("network");
      expect(error.hint).toContain("may have gone through");
    } finally {
      globalThis.fetch = previous;
    }
  });

  test("a 401 retries once with a fresh token, then explains", async () => {
    mock = mockAsc(() => ({ status: 401, json: { errors: [{ status: "401", code: "NOT_AUTHORIZED", title: "Authentication credentials are missing or invalid.", detail: "Provide a properly configured and signed bearer token." }] } }));
    const error = await caught(get("/v1/apps"));
    expect(mock.calls.length).toBe(2);
    expect(error.code).toBe("api-401");
    expect(error.hint).toContain("ship auth status");
    expect(error.message).toBe(
      "App Store Connect: Authentication credentials are missing or invalid.: Provide a properly configured and signed bearer token.",
    );
  });

  test("a connection that drops while the body is read is retried like any network failure", async () => {
    let tries = 0;
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => {
      if (++tries === 1) {
        const body = new ReadableStream({
          pull(controller) {
            controller.error(new TypeError("Connection reset"));
          },
        });
        return new Response(body, { status: 200 });
      }
      return Response.json(jsonApi([resource("apps", "1")]));
    }) as unknown as typeof fetch;
    try {
      const doc = await get("/v1/apps");
      expect(tries).toBe(2);
      expect(many(doc).map((app) => app.id)).toEqual(["1"]);
    } finally {
      globalThis.fetch = previous;
    }
  });

  test("a DELETE whose retry finds the thing gone succeeded the first time", async () => {
    let tries = 0;
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => {
      // Apple deleted it, but the answer never arrived.
      if (++tries === 1) throw new TypeError("socket hang up");
      return Response.json({ errors: [{ status: "404", code: "NOT_FOUND" }] }, { status: 404 });
    }) as unknown as typeof fetch;
    try {
      await del("/v1/appScreenshots/s1");
      expect(tries).toBe(2);
    } finally {
      globalThis.fetch = previous;
    }
  });

  test("a DELETE that finds nothing on its first try is still a 404", async () => {
    mock = mockAsc(() => ({ status: 404, json: { errors: [{ status: "404", code: "NOT_FOUND" }] } }));
    const error = await caught(del("/v1/appScreenshots/s1"));
    expect(error.code).toBe("api-404");
  });

  test("a 401 with a skewed clock signs the retry in Apple's time, and the hint names the clock", async () => {
    const appleTime = Date.now() + 30 * 60_000;
    const issued: number[] = [];
    mock = mockAsc((call) => {
      const payload = call.headers.get("authorization")!.split(".")[1]!;
      issued.push(JSON.parse(Buffer.from(payload, "base64url").toString()).iat);
      return issued.length === 1
        ? { status: 401, json: { errors: [{ status: "401", code: "NOT_AUTHORIZED" }] }, headers: { Date: new Date(appleTime).toUTCString() } }
        : { json: jsonApi([]) };
    });
    await get("/v1/apps");
    expect(issued[1]! - issued[0]!).toBeGreaterThan(29 * 60);

    mock.restore();
    mock = mockAsc(() => ({ status: 401, json: { errors: [] }, headers: { Date: new Date(Date.now() - 20 * 60_000).toUTCString() } }));
    const error = await caught(get("/v1/apps"));
    expect(error.code).toBe("api-401");
    expect(error.hint).toContain("ahead of Apple's");
    expect(clockSkew("not a date")).toBe(0);
  });

  test("sends a signed bearer token", async () => {
    mock = mockAsc(() => ({ json: jsonApi([]) }));
    await get("/v1/apps");
    expect(mock.calls[0]!.headers.get("authorization")).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });
});

describe("retryDelay and shouldRetry", () => {
  test("backs off 1, 2, 4, 8 seconds with up to 25% jitter", () => {
    expect([0, 1, 2, 3].map((attempt) => retryDelay(attempt, null, 0, () => 0))).toEqual([1000, 2000, 4000, 8000]);
    expect(retryDelay(0, null, 0, () => 1)).toBe(1250);
  });

  test("honors Retry-After in seconds or as a date, capped", () => {
    expect(retryDelay(0, "3", 0)).toBe(3000);
    const now = Date.parse("2026-10-21T10:00:00Z");
    expect(retryDelay(0, "Wed, 21 Oct 2026 10:00:05 GMT", now)).toBe(5000);
    expect(retryDelay(0, "Wed, 21 Oct 2026 09:00:00 GMT", now)).toBe(0);
    expect(retryDelay(0, "86400", 0)).toBe(retry.maxWaitMs);
    expect(retryDelay(1, "soon", 0, () => 0)).toBe(2000);
  });

  test("retries what's safe to repeat", () => {
    expect(shouldRetry("POST", 429)).toBe(true);
    expect(shouldRetry("POST", 503)).toBe(false);
    expect(shouldRetry("POST", "network")).toBe(false);
    for (const method of ["GET", "PATCH", "DELETE", "PUT"] as const) {
      expect(shouldRetry(method, 502)).toBe(true);
      expect(shouldRetry(method, "network")).toBe(true);
      expect(shouldRetry(method, 409)).toBe(false);
    }
  });
});

describe("errors", () => {
  test("a 409 surfaces Apple's detail and associated errors", async () => {
    mock = mockAsc(() => ({
      status: 409,
      json: {
        errors: [
          {
            status: "409",
            code: "STATE_ERROR.ENTITY_STATE_INVALID",
            title: "appStoreVersions with id '123' is not in valid state.",
            detail: "This resource cannot be reviewed, please check associated errors to see why.",
            source: { pointer: "/data/relationships/appStoreVersion" },
            meta: {
              associatedErrors: {
                "/v1/appStoreVersions/123": [
                  { code: "ENTITY_ERROR.ATTRIBUTE.REQUIRED", title: "An attribute value is required.", detail: "You must provide a value for the attribute 'whatsNew'." },
                ],
                "/v1/appScreenshotSets/9": [{ code: "ENTITY_ERROR", detail: "At least one screenshot is required." }],
              },
            },
          },
          { status: "409", code: "X", title: "Second", detail: "Another problem." },
        ],
      },
    }));
    const error = await caught(api("POST", "/v1/reviewSubmissionItems", {}));
    expect(error.code).toBe("api-409");
    expect(error.message).toBe(
      "App Store Connect: appStoreVersions with id '123' is not in valid state.: This resource cannot be reviewed, please check associated errors to see why. (and 1 more)",
    );
    expect(error.hint).toContain("You must provide a value for the attribute 'whatsNew'.");
    expect(error.hint).toContain("At least one screenshot is required.");
    expect(error.hint).toContain("Another problem.");
    expect(error.errors[0]?.source?.pointer).toBe("/data/relationships/appStoreVersion");
    expect(error.details?.errors).toEqual(error.errors);
  });

  test("an HTML error page is a readable error, not a SyntaxError", async () => {
    mock = mockAsc(() => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, statusText: "Bad Gateway" }));
    const error = await caught(get("/v1/apps"));
    expect(error).toBeInstanceOf(AscError);
    expect(error.message).toBe("App Store Connect: 502 Bad Gateway");
    expect(error.errors).toEqual([]);
  });

  test("an unreadable success body is an error with a hint", async () => {
    mock = mockAsc(() => new Response("<html>", { status: 200 }));
    const error = await caught(get("/v1/apps"));
    expect(error.code).toBe("api-bad-response");
    expect(error.hint).toBeTruthy();
  });

  test("hints by status", () => {
    expect(ascHint(403, [{ detail: "The API key in use does not allow this request" }])).toContain("App Manager (or Admin)");
    expect(ascHint(403, [{ detail: "A required agreement is missing or has expired." }])).toContain("agreements");
    expect(ascHint(404, [])).toContain("deleted");
    expect(ascHint(429, [])).toContain("rate limiting");
    expect(ascHint(400, [{ source: { parameter: "filter[foo]" } }])).toContain("filter[foo]");
    expect(parseErrors("not json")).toEqual([]);
    expect(associatedErrors([{ meta: { associatedErrors: { whatsNew: [{ detail: "Required" }] } } }])).toEqual(["whatsNew: Required"]);
  });

  test("refuses to send the token anywhere but App Store Connect", async () => {
    const error = await caught(get("https://example.com/v1/apps"));
    expect(error.code).toBe("bad-url");
  });

  test("a 204 is undefined, and del sends a body", async () => {
    mock = mockAsc(() => ({ status: 204 }));
    await del("/v1/betaGroups/1/relationships/betaTesters", { data: [{ type: "betaTesters", id: "t" }] });
    expect(mock.calls[0]).toMatchObject({ method: "DELETE", body: { data: [{ type: "betaTesters", id: "t" }] } });
  });
});

describe("pagination and documents", () => {
  test("all() follows links.next", async () => {
    mock = mockAsc((call) =>
      call.query.cursor
        ? { json: jsonApi([resource("betaGroups", "2")], { included: [resource("apps", "a")] }) }
        : { json: jsonApi([resource("betaGroups", "1")], { next: "https://api.appstoreconnect.apple.com/v1/apps/a/betaGroups?cursor=x" }) },
    );
    const { data, included } = await all("/v1/apps/a/betaGroups");
    expect(data.map((item) => item.id)).toEqual(["1", "2"]);
    expect(included.map((item) => item.id)).toEqual(["a"]);
    expect(mock.calls.length).toBe(2);
  });

  test("all() stops when a page repeats", async () => {
    mock = mockAsc(() => ({ json: jsonApi([resource("x", "1")], { next: "https://api.appstoreconnect.apple.com/v1/same" }) }));
    const { data } = await all("/v1/same");
    expect(data.length).toBe(1);
  });

  test("related() finds included resources", () => {
    const item = resource("builds", "b", {}, {
      preReleaseVersion: { data: { type: "preReleaseVersions", id: "p" } },
      betaGroups: { data: [{ type: "betaGroups", id: "g1" }, { type: "betaGroups", id: "g2" }] },
      app: { data: null },
    });
    const included = [resource("preReleaseVersions", "p", { version: "1.0" }), resource("betaGroups", "g1")];
    expect((related(item, "preReleaseVersion", included) as { id: string }).id).toBe("p");
    expect(relatedMany(item, "betaGroups", included).map((group) => group.id)).toEqual(["g1"]);
    expect(relatedOne(item, "app", included)).toBeUndefined();
    expect(relatedOne(item, "missing", included)).toBeUndefined();
  });
});

describe("tokens", () => {
  test("are cached per key", async () => {
    const a = await testCredentials({ keyId: "AAAA" });
    const b = await testCredentials({ keyId: "BBBB" });
    const tokenA = await bearerToken(a);
    const tokenB = await bearerToken(b);
    const kid = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[0]!, "base64url").toString()).kid;
    expect(kid(tokenA)).toBe("AAAA");
    expect(kid(tokenB)).toBe("BBBB");
    expect(await bearerToken(a)).toBe(tokenA);
    expect(await bearerToken(a, { fresh: true })).not.toBe(tokenA);
  });

  test("a key that isn't a key is a clear error", async () => {
    const error = await caught(bearerToken({ keyId: "K", issuerId: "I", privateKey: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" }));
    expect(error.code).toBe("bad-key");
    expect(error.hint).toContain("ship auth");
  });
});

describe("apps and builds", () => {
  test("lookupApp picks the exact bundle id", async () => {
    mock = mockAsc(() => ({
      json: jsonApi([
        resource("apps", "2", { name: "Watch", bundleId: "com.example.app.watch" }),
        resource("apps", "1", { name: "App", bundleId: "com.example.app" }),
      ]),
    }));
    expect(await lookupApp("com.example.app")).toEqual({ id: "1", name: "App", bundleId: "com.example.app" });
    expect(mock.calls[0]!.query["filter[bundleId]"]).toBe("com.example.app");
  });

  test("builds filters map to Apple's query parameters", () => {
    const url = new URL(
      `https://x${buildsPath("123", { version: "1.2", platform: "MAC_OS", processingState: ["PROCESSING", "VALID"], expired: false, audience: "APP_STORE_ELIGIBLE", limit: 500 })}`,
    );
    const query = Object.fromEntries(url.searchParams);
    expect(query).toMatchObject({
      "filter[app]": "123",
      "filter[preReleaseVersion.version]": "1.2",
      "filter[preReleaseVersion.platform]": "MAC_OS",
      "filter[processingState]": "PROCESSING,VALID",
      "filter[expired]": "false",
      "filter[buildAudienceType]": "APP_STORE_ELIGIBLE",
      sort: "-uploadedDate",
      limit: "200",
      include: "preReleaseVersion,buildBetaDetail",
    });
    expect(query["fields[builds]"]).toContain("buildAudienceType");
  });

  test("listBuilds reads the platform, audience, and TestFlight states", async () => {
    mock = mockAsc(() => ({
      json: jsonApi(
        [
          resource(
            "builds",
            "b1",
            { version: "42", uploadedDate: "2026-10-01T00:00:00Z", processingState: "VALID", expired: false, buildAudienceType: "APP_STORE_ELIGIBLE", minOsVersion: "17.0" },
            {
              preReleaseVersion: { data: { type: "preReleaseVersions", id: "p" } },
              buildBetaDetail: { data: { type: "buildBetaDetails", id: "d" } },
            },
          ),
        ],
        {
          included: [
            resource("preReleaseVersions", "p", { version: "1.2", platform: "IOS" }),
            resource("buildBetaDetails", "d", { internalBuildState: "IN_BETA_TESTING", externalBuildState: "READY_FOR_BETA_SUBMISSION" }),
          ],
        },
      ),
    }));
    const [build] = await listBuilds("app", { limit: 5 });
    expect(build).toMatchObject({
      id: "b1",
      number: "42",
      version: "1.2",
      platform: "IOS",
      audience: "APP_STORE_ELIGIBLE",
      minOsVersion: "17.0",
      internalState: "IN_BETA_TESTING",
      externalState: "READY_FOR_BETA_SUBMISSION",
    });
    expect(await findBuild("app", "42", "IOS")).toMatchObject({ id: "b1" });
    expect(mock.calls[1]!.query).toMatchObject({ "filter[version]": "42", "filter[preReleaseVersion.platform]": "IOS", limit: "1" });
  });
});

describe("versions", () => {
  const version = (id: string, versionString: string, attributes: Record<string, unknown>, created: string) =>
    resource("appStoreVersions", id, { versionString, platform: "IOS", createdDate: created, ...attributes }, { build: { data: id === "v2" ? { type: "builds", id: "b9" } : null } });

  test("reads appVersionState, falling back to the deprecated appStoreState", () => {
    expect(versionState({ appVersionState: "PREPARE_FOR_SUBMISSION", appStoreState: "PREPARE_FOR_SUBMISSION" })).toBe("PREPARE_FOR_SUBMISSION");
    expect(versionState({ appStoreState: "READY_FOR_SALE" })).toBe("READY_FOR_DISTRIBUTION");
    expect(versionState({ appStoreState: "REJECTED" })).toBe("REJECTED");
  });

  test("finds the editable and live versions, newest first", async () => {
    mock = mockAsc((call) => {
      if (call.path === "/v1/apps/app/appStoreVersions") {
        expect(call.query["filter[platform]"]).toBe("IOS");
        expect(call.query.include).toBe("build");
        return {
          json: jsonApi(
            [
              version("v1", "1.0", { appStoreState: "READY_FOR_SALE" }, "2026-01-01T00:00:00Z"),
              version("v2", "1.1", { appVersionState: "PREPARE_FOR_SUBMISSION", releaseType: "MANUAL" }, "2026-09-01T00:00:00Z"),
            ],
            { included: [resource("builds", "b9", { version: "57" })] },
          ),
        };
      }
    });
    const versions = await appStoreVersions("app", "IOS");
    expect(versions.map((v) => v.id)).toEqual(["v2", "v1"]);
    expect(versions[0]).toMatchObject({ state: "PREPARE_FOR_SUBMISSION", releaseType: "MANUAL", buildId: "b9", buildNumber: "57" });
    expect(isEditableVersion(versions[0]!)).toBe(true);
    expect((await findVersion("app", "IOS"))?.id).toBe("v2");
    expect((await findVersion("app", "IOS", "1.0"))?.id).toBe("v1");
    expect((await liveVersion("app", "IOS"))?.id).toBe("v1");
    expect(pickVersion(versions, "9.9")).toBeUndefined();
  });

  test("finds the editable and live App Infos", async () => {
    mock = mockAsc(() => ({
      json: jsonApi([resource("appInfos", "live", { state: "READY_FOR_DISTRIBUTION" }), resource("appInfos", "next", { appStoreState: "PREPARE_FOR_SUBMISSION" })]),
    }));
    const infos = await appInfos("app");
    expect(editableAppInfo(infos)?.id).toBe("next");
    expect(liveAppInfo(infos)?.id).toBe("live");
  });
});
