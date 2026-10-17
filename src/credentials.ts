import { homedir } from "node:os";
import { loadSettings, settingsPath } from "./config";
import { run } from "./exec";
import { readCached, readServiceAccountToken, sourceHash, writeCached } from "./keychain";
import { ShipError } from "./ui";

/** An App Store Connect API key, resolved and ready to sign with. */
export interface Credentials {
  keyId: string;
  issuerId: string;
  /** The .p8 file's contents (PEM). */
  privateKey: string;
}

let cached: Credentials | undefined;

/**
 * The API key, from environment variables if set (SHIP_ASC_KEY_ID,
 * SHIP_ASC_ISSUER_ID, and SHIP_ASC_PRIVATE_KEY or SHIP_ASC_PRIVATE_KEY_PATH),
 * otherwise from ~/.config/ship/config.json, whose values can point into
 * 1Password with op:// references.
 */
export async function credentials(): Promise<Credentials> {
  if (cached) return cached;
  const env = process.env;
  const settings = await loadSettings();
  const fromEnv = Boolean(env.SHIP_ASC_KEY_ID || env.SHIP_ASC_PRIVATE_KEY || env.SHIP_ASC_PRIVATE_KEY_PATH);
  // A recent copy in the Keychain saves asking 1Password (and Touch ID) every run.
  const days = settings.cacheDays ?? 7;
  const source = sourceHash(settings.credentials);
  if (!fromEnv && days > 0 && settings.credentials) {
    const hit = await readCached(source);
    if (hit) {
      cached = { keyId: hit.keyId, issuerId: hit.issuerId, privateKey: hit.privateKey };
      return cached;
    }
  }
  const keyId = env.SHIP_ASC_KEY_ID ?? (await resolveValue(settings.credentials?.keyId, settings.opAccount));
  const issuerId = env.SHIP_ASC_ISSUER_ID ?? (await resolveValue(settings.credentials?.issuerId, settings.opAccount));
  const privateKey =
    env.SHIP_ASC_PRIVATE_KEY ??
    (env.SHIP_ASC_PRIVATE_KEY_PATH ? await readFile(env.SHIP_ASC_PRIVATE_KEY_PATH) : undefined) ??
    (await resolveValue(settings.credentials?.privateKey, settings.opAccount));
  if (!keyId || !issuerId || !privateKey) {
    throw new ShipError(
      "No App Store Connect API key is set up",
      "no-credentials",
      "Run `ship auth set --key-id <id> --issuer-id <id> --private-key op://<vault>/<item>/<file>` (see `ship auth --help`).",
    );
  }
  cached = { keyId, issuerId, privateKey };
  if (!fromEnv && days > 0) await writeCached(cached, source, days);
  return cached;
}

/** Whether a key is configured, without reading any secrets. */
export async function hasCredentials(): Promise<boolean> {
  const env = process.env;
  if (env.SHIP_ASC_KEY_ID && env.SHIP_ASC_ISSUER_ID && (env.SHIP_ASC_PRIVATE_KEY || env.SHIP_ASC_PRIVATE_KEY_PATH)) return true;
  const c = (await loadSettings()).credentials;
  return Boolean(c?.keyId && c.issuerId && c.privateKey);
}

/** Resolves `op://…` (1Password), `env:NAME`, `file:<path>`, or a literal value. */
export async function resolveValue(value: string | undefined, opAccount?: string): Promise<string | undefined> {
  if (!value) return undefined;
  if (value.startsWith("op://")) {
    // A service account token (from the environment, or the one `ship auth
    // service-account` saved) reads without Touch ID and picks its own account.
    const token = await serviceAccountToken();
    const account = opAccount && !token ? ["--account", opAccount] : [];
    const result = await run(["op", "read", ...account, value], { env: token ? { OP_SERVICE_ACCOUNT_TOKEN: token } : {} });
    if (result.code !== 0) {
      throw new ShipError(
        `Couldn't read ${value} from 1Password`,
        "op-failed",
        [
          result.stderr.trim(),
          token
            ? "ship reads 1Password with a service account: check it can see this vault, or save a new token with `ship auth service-account <op://ref>` (or `ship auth service-account remove`)."
            : "Is the 1Password CLI signed in?",
          `Check the reference in ${settingsPath}.`,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
    return result.stdout.trim();
  }
  if (value.startsWith("env:")) return process.env[value.slice(4)];
  if (value.startsWith("file:")) return readFile(value.slice(5));
  return value;
}

/** The service account token for `op`: OP_SERVICE_ACCOUNT_TOKEN, else the Keychain's. */
export async function serviceAccountToken(): Promise<string | undefined> {
  return process.env.OP_SERVICE_ACCOUNT_TOKEN || (await readServiceAccountToken());
}

async function readFile(path: string): Promise<string> {
  const file = Bun.file(path.replace(/^~(?=\/)/, homedir()));
  if (!(await file.exists())) throw new ShipError(`No file at ${path}`, "missing-key-file");
  return (await file.text()).trim();
}
