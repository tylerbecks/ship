// The macOS login Keychain, which is encrypted and unlocked with your Mac
// login. ship reads and writes generic passwords there:
// - secrets you point it at with keychain:<service>/<account> references
//   (`ship secret set` saves them; `ship auth set --keychain` saves the API key)
// - a short-lived copy of an API key read from 1Password, so ship asks
//   1Password once every few days instead of on every run
// - a 1Password service account token, so `op read` never asks for Touch ID

import { createHash } from "node:crypto";
import type { Credentials } from "./credentials";
import { run } from "./exec";
import { ShipError } from "./ui";

const SERVICE = "ship";
const KEY_ACCOUNT = "app-store-connect-api-key";
const TOKEN_ACCOUNT = "op-service-account-token";

/** How ship runs `security`. Tests replace these so the real Keychain is never touched. */
export const security = {
  run: (args: string[]) => run(["security", ...args]),
  /** Runs commands with `security -i`, on stdin, so secrets never show up in the process list. */
  interactive: async (commands: string): Promise<void> => {
    const proc = Bun.spawn(["security", "-i"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    proc.stdin.write(commands);
    proc.stdin.end();
    await proc.exited;
  },
};

// MARK: Generic passwords

/** What a Keychain service or account may contain: they go into a `security -i` command line. */
export const KEYCHAIN_NAME = /^[A-Za-z0-9._@-]+$/;

/** Throws a usage error when a service or account name could break the `security -i` line. */
export function checkKeychainName(value: string, what: "service" | "account") {
  if (!KEYCHAIN_NAME.test(value)) {
    throw new ShipError(
      `"${value}" can't be a Keychain ${what}`,
      "usage",
      `Use letters, digits, and . _ @ - only, like keychain:ship/lift-demo-password.`,
      undefined,
      2,
    );
  }
}

/**
 * `security find-generic-password -w` prints a password with non-printable
 * characters (a .p8 key's newlines, say) as hex. Decodes that, and leaves a
 * password that's only printable characters alone, since `security` would
 * have printed that one as is.
 */
export function decodePassword(stdout: string): string {
  const value = stdout.replace(/\r?\n$/, "");
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(value)) return value;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "hex"));
  } catch {
    return value;
  }
  const printable = /^[\x20-\x7e]*$/.test(decoded);
  const text = /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/.test(decoded);
  return !printable && text ? decoded : value;
}

/** A generic password's value, or undefined when there's no such item. */
export async function readGenericPassword(service: string, account?: string): Promise<string | undefined> {
  checkKeychainName(service, "service");
  if (account !== undefined) checkKeychainName(account, "account");
  const result = await security.run(["find-generic-password", "-s", service, ...(account !== undefined ? ["-a", account] : []), "-w"]);
  return result.code === 0 ? decodePassword(result.stdout) : undefined;
}

/** Whether an item exists, without reading its value (so no Keychain prompt). */
export async function hasGenericPassword(service: string, account?: string): Promise<boolean> {
  checkKeychainName(service, "service");
  if (account !== undefined) checkKeychainName(account, "account");
  const result = await security.run(["find-generic-password", "-s", service, ...(account !== undefined ? ["-a", account] : [])]);
  return result.code === 0;
}

/** Saves (or replaces) a generic password. Returns whether reading it back gives the same value. */
export async function writeGenericPassword(service: string, account: string, value: string, label: string): Promise<boolean> {
  checkKeychainName(service, "service");
  checkKeychainName(account, "account");
  // The value goes as hex and the label is quoted, so neither can break the command line.
  const hex = Buffer.from(value).toString("hex");
  const safeLabel = label.replace(/["\\\n\r]/g, "");
  await security.interactive(`add-generic-password -U -s ${service} -a ${account} -l "${safeLabel}" -X ${hex}\n`);
  // `security -i` exits 0 even when the command fails, so read it back.
  return (await readGenericPassword(service, account)) === value;
}

export async function deleteGenericPassword(service: string, account: string) {
  checkKeychainName(service, "service");
  checkKeychainName(account, "account");
  await security.run(["delete-generic-password", "-s", service, "-a", account]);
}

// MARK: ship's own items

const readItem = (account: string) => readGenericPassword(SERVICE, account);
const writeItem = (account: string, label: string, value: string) => writeGenericPassword(SERVICE, account, value, label);
const deleteItem = (account: string) => deleteGenericPassword(SERVICE, account);

interface Cached extends Credentials {
  /** When the copy expires, in ms since 1970. */
  expires: number;
  /** A hash of the settings it came from, so changing them drops the copy. */
  source: string;
}

function decode(stored: string | undefined): Cached | undefined {
  if (!stored) return undefined;
  try {
    return JSON.parse(Buffer.from(stored, "base64").toString()) as Cached;
  } catch {
    return undefined;
  }
}

// MARK: The API key

/** A hash of the settings' references (none counts too: JSON.stringify(undefined) would throw in update). */
export const sourceHash = (references: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(references ?? null))
    .digest("hex")
    .slice(0, 16);

export async function readCached(source: string): Promise<(Credentials & { expires: number }) | undefined> {
  const cached = decode(await readItem(KEY_ACCOUNT));
  if (!cached || cached.source !== source || cached.expires < Date.now()) return undefined;
  return cached;
}

export async function writeCached(credentials: Credentials, source: string, days: number) {
  const cached: Cached = { ...credentials, source, expires: Date.now() + days * 86_400_000 };
  await writeItem(KEY_ACCOUNT, "ship: App Store Connect API key", Buffer.from(JSON.stringify(cached)).toString("base64"));
}

export const cacheExpiry = async () => decode(await readItem(KEY_ACCOUNT))?.expires;
export const clearCached = () => deleteItem(KEY_ACCOUNT);

// MARK: The 1Password service account token

export const readServiceAccountToken = () => readItem(TOKEN_ACCOUNT);
export const writeServiceAccountToken = (token: string) => writeItem(TOKEN_ACCOUNT, "ship: 1Password service account token", token);
export const clearServiceAccountToken = () => deleteItem(TOKEN_ACCOUNT);
