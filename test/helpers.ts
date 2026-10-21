// Shared test helpers: temp folders, generated API keys, and a mocked App
// Store Connect. test/setup.ts already blocks real network calls.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Resource, clearTokens, retry } from "../src/asc/client";
import { type Credentials, useCredentials } from "../src/credentials";

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
