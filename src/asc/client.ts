// A small client for the App Store Connect API
// (https://developer.apple.com/documentation/appstoreconnectapi).
// Requests are signed with a short-lived ES256 JWT made from the API key,
// retried when Apple is busy or the network blips, and turned into an
// AscError with a hint when Apple says no.
//
// The endpoints themselves live next to this file, one per area: apps.ts,
// builds.ts, testflight.ts, versions.ts.

import { createHash } from "node:crypto";
import { type Credentials, credentials } from "../credentials";
import { ShipError } from "../ui";

const BASE = "https://api.appstoreconnect.apple.com";
const HOST = new URL(BASE).host;

/** How long one request may take before it's abandoned (and retried, when that's safe). */
export const TIMEOUT_MS = 60_000;

/** Retry settings. Tests set `sleep` to skip the waiting. */
export const retry = {
  /** Retries after the first try. */
  retries: 4,
  /** The first backoff; each retry doubles it (1 s, 2 s, 4 s, 8 s). */
  baseMs: 1000,
  /** The longest ship waits for one Retry-After. */
  maxWaitMs: 60_000,
  sleep: (ms: number): Promise<void> => Bun.sleep(ms),
};

// MARK: Tokens

/** Tokens by key, so asking for another key's token never returns this one's. */
const tokens = new Map<string, { value: string; expires: number }>();

const tokenKey = (creds: Credentials) =>
  `${creds.keyId}:${creds.issuerId}:${createHash("sha256").update(creds.privateKey).digest("hex").slice(0, 16)}`;

/** A JWT for the API, reused until a minute before it expires. `fresh` signs a new one. */
export async function bearerToken(creds?: Credentials, options: { fresh?: boolean } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const resolved = creds ?? (await credentials());
  const key = tokenKey(resolved);
  const cached = tokens.get(key);
  if (cached && !options.fresh && cached.expires - 60 > now) return cached.value;
  const { keyId, issuerId, privateKey } = resolved;
  const expires = now + 15 * 60; // Apple allows up to 20 minutes.
  const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64url");
  const unsigned = `${encode({ alg: "ES256", kid: keyId, typ: "JWT" })}.${encode({
    iss: issuerId,
    iat: now,
    exp: expires,
    aud: "appstoreconnect-v1",
  })}`;
  let signingKey: CryptoKey;
  try {
    signingKey = await crypto.subtle.importKey("pkcs8", pemToDer(privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch (error) {
    if (error instanceof ShipError) throw error;
    throw new ShipError(
      "The API private key isn't a valid .p8 key",
      "bad-key",
      "Point --private-key at the AuthKey_<id>.p8 file App Store Connect gave you, including its BEGIN and END lines (see `ship auth --help`).",
    );
  }
  // WebCrypto returns the raw r‖s signature JWTs use.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, new TextEncoder().encode(unsigned));
  const value = `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
  tokens.set(key, { value, expires });
  return value;
}

/** Forgets every signed token (tests use it). */
export const clearTokens = () => tokens.clear();

function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  if (!base64) throw new ShipError("The API private key is empty", "bad-key", "Check --private-key with `ship auth status` (see `ship auth --help`).");
  const bytes = Buffer.from(base64, "base64");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// MARK: Documents

/** A reference to another resource. */
export interface Linkage {
  type: string;
  id: string;
}

/** A JSON:API resource. */
export interface Resource<A = Record<string, unknown>> {
  type: string;
  id: string;
  attributes: A;
  relationships?: Record<string, { data?: Linkage | Linkage[] | null }>;
}

export interface Document<A = Record<string, unknown>> {
  data: Resource<A> | Resource<A>[];
  included?: Resource[];
  links?: { self?: string; next?: string };
  meta?: { paging?: { total?: number; limit: number; nextCursor?: string } };
}

/** The document's one resource (or its first, for a list). */
export function one<A>(doc: Document<A> | undefined): Resource<A> | undefined {
  if (!doc) return undefined;
  return Array.isArray(doc.data) ? doc.data[0] : (doc.data ?? undefined);
}

/** The document's resources (a single one as a list of one). */
export function many<A>(doc: Document<A> | undefined): Resource<A>[] {
  if (!doc?.data) return [];
  return Array.isArray(doc.data) ? doc.data : [doc.data];
}

/**
 * The included resource (to-one) or resources (to-many) a relationship
 * points at. Resources the response didn't include are left out.
 */
export function related(resource: Resource<any>, name: string, included: Resource[] = []): Resource | Resource[] | undefined {
  const data = resource.relationships?.[name]?.data;
  const find = (link: Linkage) => included.find((item) => item.type === link.type && item.id === link.id);
  if (Array.isArray(data)) return data.map(find).filter((item): item is Resource => Boolean(item));
  return data ? find(data) : undefined;
}

/** The included resource a to-one relationship points at. */
export function relatedOne(resource: Resource<any>, name: string, included: Resource[] = []): Resource | undefined {
  const found = related(resource, name, included);
  return Array.isArray(found) ? found[0] : found;
}

/** The included resources a to-many relationship points at. */
export function relatedMany(resource: Resource<any>, name: string, included: Resource[] = []): Resource[] {
  const found = related(resource, name, included);
  return Array.isArray(found) ? found : found ? [found] : [];
}

/** The id a to-one relationship points at, whether or not it was included. */
export function relationshipId(resource: Resource<any>, name: string): string | undefined {
  const data = resource.relationships?.[name]?.data;
  return data && !Array.isArray(data) ? data.id : undefined;
}

// MARK: Errors

/** One entry of Apple's `errors` array. */
export interface AscErrorItem {
  id?: string;
  status?: string;
  code?: string;
  title?: string;
  detail?: string;
  source?: { pointer?: string; parameter?: string };
  meta?: { associatedErrors?: Record<string, AscErrorItem[]>; [key: string]: unknown };
}

/** App Store Connect said no. `code` is `api-<status>`, like `api-409`. */
export class AscError extends ShipError {
  constructor(
    readonly status: number,
    readonly errors: AscErrorItem[],
    statusText = "",
  ) {
    super(ascMessage(status, errors, statusText), `api-${status}`, ascHint(status, errors), { status, errors }, 1);
  }
}

const describeError = (error: AscErrorItem) => [error.title, error.detail].filter(Boolean).join(": ") || error.code || "Unknown error";

export function ascMessage(status: number, errors: AscErrorItem[], statusText = ""): string {
  const first = errors[0];
  if (!first) return `App Store Connect: ${status}${statusText ? ` ${statusText}` : ""}`;
  const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : "";
  return `App Store Connect: ${describeError(first)}${more}`;
}

/** Apple's associated errors (what blocks a submission, say), flattened to one line each. */
export function associatedErrors(errors: AscErrorItem[]): string[] {
  const lines: string[] = [];
  for (const error of errors) {
    for (const [where, list] of Object.entries(error.meta?.associatedErrors ?? {})) {
      for (const item of Array.isArray(list) ? list : []) {
        const what = item.detail || item.title || item.code;
        if (what) lines.push(where && !where.startsWith("/v") ? `${where}: ${what}` : what);
      }
    }
  }
  return [...new Set(lines)];
}

export function ascHint(status: number, errors: AscErrorItem[]): string {
  const details = errors.map((error) => error.detail).filter((detail): detail is string => Boolean(detail));
  if (status === 401) return "The API key was rejected. Check the key id, issuer id, and .p8 with `ship auth status`.";
  if (status === 403) {
    if (details.some((detail) => /agreement/i.test(detail))) {
      return "Accept the latest agreements in App Store Connect (Business, or the banner on the home page), then try again.";
    }
    return "The API key's role can't do this. Give it the App Manager (or Admin) role in Users and Access → Integrations.";
  }
  if (status === 404) return "App Store Connect has no such thing: the id may be wrong, or it was deleted. `ship status` shows what's there.";
  if (status === 409) {
    const lines = [...details.slice(1), ...associatedErrors(errors)];
    return lines.length
      ? `App Store Connect needs these first:\n  ${lines.join("\n  ")}`
      : "App Store Connect refused it in the state things are in now. Check the app in App Store Connect.";
  }
  if (status === 429) return "App Store Connect is rate limiting this API key (about 3,600 requests an hour). Wait a few minutes and try again.";
  if (status >= 500) return "App Store Connect is having trouble. Try again shortly; developer.apple.com/system-status shows outages.";
  const pointer = errors.find((error) => error.source?.pointer || error.source?.parameter)?.source;
  if (pointer) return `Apple's error points at ${pointer.pointer ?? pointer.parameter}. Run with --json for every error.`;
  return "Run with --json to see Apple's full error.";
}

/** Apple's errors from a response body, or none when it isn't JSON:API (an HTML 502 page, say). */
export function parseErrors(text: string): AscErrorItem[] {
  try {
    const json = JSON.parse(text);
    return Array.isArray(json?.errors) ? json.errors : [];
  } catch {
    return [];
  }
}

// MARK: Retries

export type Method = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

/**
 * Whether to try again after a status (or a network failure). Busy (429) is
 * always safe to retry, since Apple didn't do anything. A server error or a
 * dropped connection is retried only for requests that are safe to repeat:
 * a POST might have created something.
 */
export function shouldRetry(method: Method, status: number | "network"): boolean {
  if (status === 429) return true;
  if (status === "network" || status >= 500) return method !== "POST";
  return false;
}

/**
 * Milliseconds to wait before retry number `attempt` (0 for the first):
 * Retry-After when Apple sends one (seconds or an HTTP date), else 1 s, 2 s,
 * 4 s, 8 s with up to 25% jitter.
 */
export function retryDelay(attempt: number, retryAfter?: string | null, now = Date.now(), random = Math.random): number {
  if (retryAfter) {
    const seconds = Number(retryAfter.trim());
    const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(wait)) return Math.min(Math.max(0, wait), retry.maxWaitMs);
  }
  const backoff = retry.baseMs * 2 ** attempt;
  return Math.round(backoff + random() * backoff * 0.25);
}

function networkError(error: unknown, method: Method, path: string): ShipError {
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  const reason = timedOut ? `no answer in ${TIMEOUT_MS / 1000} s` : error instanceof Error ? error.message : String(error);
  const route = path.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  return new ShipError(
    `Couldn't reach App Store Connect (${reason})`,
    timedOut ? "network-timeout" : "network",
    method === "POST"
      ? `Check your connection. The request (POST ${route}) may have gone through; check App Store Connect before running it again.`
      : "Check your connection and try again; developer.apple.com/system-status shows outages.",
    { method, path: route },
  );
}

// MARK: Requests

/** Sends one request, retrying as `shouldRetry` allows. Returns undefined for an empty response (204). */
export async function api<A = Record<string, unknown>>(method: Method, path: string, body?: unknown): Promise<Document<A> | undefined> {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  // Never send the token anywhere but App Store Connect, even when a `next` link says to.
  if (new URL(url).host !== HOST) {
    throw new ShipError(`Refusing to send the API key to ${new URL(url).host}`, "bad-url", "ship only talks to api.appstoreconnect.apple.com.");
  }
  let attempt = 0;
  let freshToken = false;
  while (true) {
    let response: Response;
    try {
      // Read fetch at call time, so tests can swap it.
      response = await globalThis.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${await bearerToken(undefined, { fresh: freshToken })}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof ShipError) throw error;
      if (shouldRetry(method, "network") && attempt < retry.retries) {
        await retry.sleep(retryDelay(attempt++));
        continue;
      }
      throw networkError(error, method, url);
    }
    // A token can be rejected when the clock moved or the key was just made; sign a new one once.
    if (response.status === 401 && !freshToken) {
      freshToken = true;
      await response.body?.cancel();
      continue;
    }
    if (shouldRetry(method, response.status) && attempt < retry.retries) {
      await response.body?.cancel();
      await retry.sleep(retryDelay(attempt++, response.headers.get("retry-after")));
      continue;
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (!response.ok) throw new AscError(response.status, parseErrors(text), response.statusText);
    if (!text) return undefined;
    try {
      return JSON.parse(text) as Document<A>;
    } catch {
      throw new ShipError(
        `App Store Connect sent a response ship couldn't read (${method} ${url.replace(BASE, "").split("?")[0]})`,
        "api-bad-response",
        "Try again shortly; developer.apple.com/system-status shows outages.",
      );
    }
  }
}

/** GET a document. */
export async function get<A = Record<string, unknown>>(path: string): Promise<Document<A>> {
  return (await api<A>("GET", path)) ?? { data: [] };
}

/** POST a body; returns what Apple created (undefined when it sends nothing back). */
export const post = <A = Record<string, unknown>>(path: string, body: unknown) => api<A>("POST", path, body);

/** PATCH a body; returns the updated resource. */
export const patch = <A = Record<string, unknown>>(path: string, body: unknown) => api<A>("PATCH", path, body);

/** DELETE a resource, or relationship members when `body` lists them. */
export async function del(path: string, body?: unknown): Promise<void> {
  await api("DELETE", path, body);
}

/** Every item from a list endpoint, following pagination. */
export async function all<A = Record<string, unknown>>(path: string): Promise<{ data: Resource<A>[]; included: Resource[] }> {
  const data: Resource<A>[] = [];
  const included: Resource[] = [];
  const seen = new Set<string>();
  let next: string | undefined = path;
  while (next) {
    // A server that repeats a page would otherwise loop forever.
    const key = next.startsWith("http") ? next : `${BASE}${next}`;
    if (seen.has(key)) break;
    seen.add(key);
    const page: Document<A> | undefined = await api<A>("GET", next);
    if (!page) break;
    data.push(...many(page));
    included.push(...(page.included ?? []));
    next = page.links?.next;
  }
  return { data, included };
}
