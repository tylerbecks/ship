// Shared test helpers: temp folders, generated API keys, and a mocked App
// Store Connect. test/setup.ts already blocks real network calls.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Resource, clearTokens, retry } from "../src/asc/client";
import { type Credentials, useCredentials } from "../src/credentials";
import { run } from "../src/exec";
import { security } from "../src/keychain";

/** A fresh empty folder. */
export const temp = (prefix = "ship-test-") => mkdtempSync(join(tmpdir(), prefix));

/** A new P-256 key as a .p8 PEM, with its public key for checking signatures. */
export async function generateKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
  return { pem, publicKey: pair.publicKey };
}

/** Generates an API key and makes ship use it, so no settings, Keychain, or 1Password is read. */
export async function testCredentials(overrides: Partial<Credentials> = {}): Promise<Credentials & { publicKey: CryptoKey }> {
  const { pem, publicKey } = await generateKey();
  const creds: Credentials = { keyId: "TESTKEY123", issuerId: "00000000-0000-0000-0000-000000000000", privateKey: pem, ...overrides };
  useCredentials(creds);
  clearTokens();
  return { ...creds, publicKey };
}

/** Runs git in `cwd` with a fixed identity, and returns its trimmed stdout. Throws when git fails. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run(["git", "-c", "user.name=Ship", "-c", "user.email=ship@example.com", "-c", "init.defaultBranch=main", ...args], { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Captures what console.log prints while `body` runs (a command's result). */
export async function captureLog(body: () => Promise<unknown>): Promise<string> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await body();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

// MARK: Mocking App Store Connect

/** One request ship made. */
export interface AscCall {
  method: string;
  url: URL;
  /** Like /v1/builds. */
  path: string;
  /** Query parameters by name, like { "filter[app]": "123" }. */
  query: Record<string, string>;
  /** The parsed JSON body, if any. */
  body: unknown;
  headers: Headers;
}

/** What a handler returns: a Response, or a status and JSON body (200 and no body by default). */
export type AscReply = Response | { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

/**
 * Answers ship's App Store Connect requests with `handler` until `restore()`.
 * A handler that returns undefined answers 404 with an "unmocked" error, so a
 * test fails with the request's path in the message.
 */
export function mockAsc(handler: (call: AscCall) => AscReply | undefined | Promise<AscReply | undefined>) {
  const previous = globalThis.fetch;
  const calls: AscCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const text = typeof init?.body === "string" ? init.body : undefined;
    const call: AscCall = {
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: text ? JSON.parse(text) : undefined,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    const reply = await handler(call);
    if (reply instanceof Response) return reply;
    if (!reply) {
      return Response.json(
        { errors: [{ status: "404", code: "NOT_MOCKED", title: "Unmocked request", detail: `No mock for ${call.method} ${call.path}` }] },
        { status: 404 },
      );
    }
    const body = reply.text ?? (reply.json === undefined ? null : JSON.stringify(reply.json));
    const status = reply.status ?? (body === null ? 204 : 200);
    return new Response(body, { status, headers: { "Content-Type": "application/json", ...reply.headers } });
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}

/** A JSON:API document, the way App Store Connect sends one. */
export function jsonApi(data: unknown, options: { included?: unknown[]; next?: string; total?: number; limit?: number } = {}) {
  const count = Array.isArray(data) ? data.length : 1;
  return {
    data,
    ...(options.included ? { included: options.included } : {}),
    links: { self: "https://api.appstoreconnect.apple.com/v1/mock", ...(options.next ? { next: options.next } : {}) },
    ...(Array.isArray(data) ? { meta: { paging: { total: options.total ?? count, limit: options.limit ?? 50 } } } : {}),
  };
}

/** A resource for jsonApi(). */
export const resource = (type: string, id: string, attributes: Record<string, unknown> = {}, relationships?: Resource["relationships"]) => ({
  type,
  id,
  attributes,
  ...(relationships ? { relationships } : {}),
});

// MARK: A fake Keychain

/**
 * Replaces `security` with an in-memory Keychain until `restore()`. Items are
 * keyed "service/account"; reads print non-printable values as hex, like
 * the real `security -w` does.
 */
export function fakeKeychain(items: Record<string, string> = {}) {
  const original = { ...security };
  const store = new Map(Object.entries(items));
  const find = (args: string[]) => {
    const service = args[args.indexOf("-s") + 1];
    const account = args.includes("-a") ? args[args.indexOf("-a") + 1] : undefined;
    return [...store.keys()].find((key) => (account === undefined ? key.split("/")[0] === service : key === `${service}/${account}`));
  };
  security.run = async (args) => {
    const key = find(args);
    if (args[0] === "delete-generic-password") {
      if (key) store.delete(key);
      return { code: key ? 0 : 44, stdout: "", stderr: "" };
    }
    if (!key) return { code: 44, stdout: "", stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." };
    const value = store.get(key)!;
    const printable = /^[\x20-\x7e]*$/.test(value);
    return { code: 0, stdout: args.includes("-w") ? `${printable ? value : Buffer.from(value).toString("hex")}\n` : "attributes", stderr: "" };
  };
  security.interactive = async (commands) => {
    const match = commands.match(/-s (\S+) -a (\S+) -l "[^"]*" -X ([0-9a-f]+)/);
    if (match) store.set(`${match[1]}/${match[2]}`, Buffer.from(match[3]!, "hex").toString());
  };
  return {
    items: store,
    restore: () => Object.assign(security, original),
  };
}

/** Makes retries instant. Returns the waits ship asked for, and a restore function. */
export function noRetryDelay() {
  const original = retry.sleep;
  const waits: number[] = [];
  retry.sleep = async (ms: number) => {
    waits.push(ms);
  };
  return {
    waits,
    restore: () => {
      retry.sleep = original;
    },
  };
}
