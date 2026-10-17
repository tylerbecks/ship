// A small client for the App Store Connect API
// (https://developer.apple.com/documentation/appstoreconnectapi).
// Requests are signed with a short-lived ES256 JWT made from the API key.

import { type Credentials, credentials } from "../credentials";
import { ShipError } from "../ui";

const BASE = "https://api.appstoreconnect.apple.com";

let token: { value: string; expires: number } | undefined;

/** A JWT for the API, reused until a minute before it expires. */
export async function bearerToken(creds?: Credentials): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (token && token.expires - 60 > now) return token.value;
  const { keyId, issuerId, privateKey } = creds ?? (await credentials());
  const expires = now + 15 * 60; // Apple allows up to 20 minutes.
  const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64url");
  const unsigned = `${encode({ alg: "ES256", kid: keyId, typ: "JWT" })}.${encode({
    iss: issuerId,
    iat: now,
    exp: expires,
    aud: "appstoreconnect-v1",
  })}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // WebCrypto returns the raw r‖s signature JWTs use.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
  token = { value: `${unsigned}.${Buffer.from(signature).toString("base64url")}`, expires };
  return token.value;
}

function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  if (!base64) throw new ShipError("The API private key is empty", "bad-key");
  const bytes = Buffer.from(base64, "base64");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** A JSON:API resource. */
export interface Resource<A = Record<string, unknown>> {
  type: string;
  id: string;
  attributes: A;
  relationships?: Record<string, { data?: { type: string; id: string } | { type: string; id: string }[] | null }>;
}

export interface Document<A = Record<string, unknown>> {
  data: Resource<A> | Resource<A>[];
  included?: Resource[];
  links?: { next?: string };
}

export async function api<A = Record<string, unknown>>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Document<A> | undefined> {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await bearerToken()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return undefined;
  const text = await response.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const first = json?.errors?.[0];
    const message = first ? `${first.title}: ${first.detail}` : `${response.status} ${response.statusText}`;
    const hint =
      response.status === 401
        ? "The API key was rejected. Check the key id, issuer id, and .p8 with `ship auth status`."
        : response.status === 403
          ? "The API key's role can't do this. Give it the App Manager role in Users and Access → Integrations."
          : undefined;
    throw new ShipError(`App Store Connect: ${message}`, `api-${response.status}`, hint, { errors: json?.errors });
  }
  return json as Document<A>;
}

/** Every item from a list endpoint, following pagination. */
export async function all<A = Record<string, unknown>>(path: string): Promise<{ data: Resource<A>[]; included: Resource[] }> {
  const data: Resource<A>[] = [];
  const included: Resource[] = [];
  let next: string | undefined = path;
  while (next) {
    const page: Document<A> | undefined = await api<A>("GET", next);
    if (!page) break;
    data.push(...(Array.isArray(page.data) ? page.data : [page.data]));
    included.push(...(page.included ?? []));
    next = page.links?.next;
  }
  return { data, included };
}
