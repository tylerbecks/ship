// The App Store Connect API key: from environment variables (CI), or from the
// references in ~/.config/ship/config.json, resolved through src/secrets.ts.

import { loadSettings } from "./config";
import { readCached, sourceHash, writeCached } from "./keychain";
import { normalizePrivateKey, readSecretFile, resolveSecret, serviceAccountToken, sourceOf } from "./secrets";
import { ShipError } from "./ui";

export { serviceAccountToken };

/** An App Store Connect API key, resolved and ready to sign with. */
export interface Credentials {
  keyId: string;
  issuerId: string;
  /** The .p8 file's contents (PEM). */
  privateKey: string;
}

/** The credentials once read, and the read in flight, so concurrent requests share one. */
let cached: Credentials | undefined;
let pending: Promise<Credentials> | undefined;

/** Whether any of the settings' references read 1Password (which is what the Keychain copy saves asking). */
export const usesOnePassword = (references: Record<string, unknown> | undefined) =>
  Object.values(references ?? {}).some((value) => typeof value === "string" && value.startsWith("op://"));

/**
 * The API key, from environment variables if set (SHIP_ASC_KEY_ID,
 * SHIP_ASC_ISSUER_ID, and SHIP_ASC_PRIVATE_KEY or SHIP_ASC_PRIVATE_KEY_PATH),
 * otherwise from ~/.config/ship/config.json, whose values can be references
 * to the Keychain, 1Password, the environment, or a file.
 */
export function credentials(): Promise<Credentials> {
  if (cached) return Promise.resolve(cached);
  // Requests start in parallel; without this each would ask 1Password (and Touch ID) on its own.
  if (!pending) {
    const loading = load();
    pending = loading;
    loading.catch(() => {
      if (pending === loading) pending = undefined;
    });
  }
  return pending;
}

async function load(): Promise<Credentials> {
  const env = process.env;
  const settings = await loadSettings();
  const fromEnv = Boolean(env.SHIP_ASC_KEY_ID || env.SHIP_ASC_PRIVATE_KEY || env.SHIP_ASC_PRIVATE_KEY_PATH);
  // A recent copy in the Keychain saves asking 1Password (and Touch ID) every run.
  // Other sources are already local, so they're read each time.
  const days = settings.cacheDays ?? 7;
  const useCache = !fromEnv && days > 0 && usesOnePassword(settings.credentials);
  const source = sourceHash(settings.credentials);
  if (useCache) {
    const hit = await readCached(source);
    if (hit) {
      cached = { keyId: hit.keyId, issuerId: hit.issuerId, privateKey: hit.privateKey };
      return cached;
    }
  }
  const context = { opAccount: settings.opAccount };
  const keyId = env.SHIP_ASC_KEY_ID || (await resolveSecret(settings.credentials?.keyId, context));
  const issuerId = env.SHIP_ASC_ISSUER_ID || (await resolveSecret(settings.credentials?.issuerId, context));
  const privateKey =
    env.SHIP_ASC_PRIVATE_KEY ||
    (env.SHIP_ASC_PRIVATE_KEY_PATH ? await readSecretFile(env.SHIP_ASC_PRIVATE_KEY_PATH) : undefined) ||
    (await resolveSecret(settings.credentials?.privateKey, context));
  if (!keyId || !issuerId || !privateKey) {
    throw new ShipError(
      "No App Store Connect API key is set up",
      "no-credentials",
      "Run `ship auth set --key-id <id> --issuer-id <id> --private-key file:~/Downloads/AuthKey_<id>.p8 --keychain` (see `ship auth --help`).",
    );
  }
  cached = { keyId: keyId.trim(), issuerId: issuerId.trim(), privateKey: normalizePrivateKey(privateKey) };
  if (useCache) await writeCached(cached, source, days);
  return cached;
}

/** Uses these credentials for the rest of the process instead of reading them (tests; undefined forgets them). */
export function useCredentials(creds: Credentials | undefined) {
  cached = creds;
  pending = undefined;
}

/** Whether a key is configured, without reading any secrets. */
export async function hasCredentials(): Promise<boolean> {
  if (cached) return true;
  const env = process.env;
  if (env.SHIP_ASC_KEY_ID && env.SHIP_ASC_ISSUER_ID && (env.SHIP_ASC_PRIVATE_KEY || env.SHIP_ASC_PRIVATE_KEY_PATH)) return true;
  const c = (await loadSettings()).credentials;
  return Boolean(c?.keyId && c.issuerId && c.privateKey);
}

/** Where each part of the key comes from ("environment", "Keychain", "1Password", "file", "literal"), without reading it. */
export async function credentialSources(): Promise<{ keyId: string | null; issuerId: string | null; privateKey: string | null }> {
  const env = process.env;
  const refs = (await loadSettings()).credentials ?? {};
  const of = (value: string | undefined) => (value ? sourceOf(value).name : null);
  return {
    keyId: env.SHIP_ASC_KEY_ID ? "environment" : of(refs.keyId),
    issuerId: env.SHIP_ASC_ISSUER_ID ? "environment" : of(refs.issuerId),
    privateKey: env.SHIP_ASC_PRIVATE_KEY ? "environment" : env.SHIP_ASC_PRIVATE_KEY_PATH ? "file" : of(refs.privateKey),
  };
}

/** Resolves a Keychain, 1Password, env:, file:, or literal value (see src/secrets.ts). */
export async function resolveValue(value: string | undefined, opAccount?: string): Promise<string | undefined> {
  return resolveSecret(value, { opAccount });
}
