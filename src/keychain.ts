// Secrets ship keeps in the macOS login Keychain, which is encrypted and
// unlocked with your Mac login:
// - a short-lived copy of the API key, so ship asks 1Password once every few
//   days instead of on every run
// - a 1Password service account token, so `op read` never asks for Touch ID

import { createHash } from "node:crypto";
import type { Credentials } from "./credentials";
import { run } from "./exec";

const SERVICE = "ship";
const KEY_ACCOUNT = "app-store-connect-api-key";
const TOKEN_ACCOUNT = "op-service-account-token";

interface Cached extends Credentials {
  /** When the copy expires, in ms since 1970. */
  expires: number;
  /** A hash of the settings it came from, so changing them drops the copy. */
  source: string;
}

async function readItem(account: string): Promise<string | undefined> {
  const result = await run(["security", "find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function writeItem(account: string, label: string, value: string) {
  // Commands go to `security -i` on stdin, so the secret never shows up in the
  // process list the way a command-line argument would.
  const hex = Buffer.from(value).toString("hex");
  const proc = Bun.spawn(["security", "-i"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  proc.stdin.write(`add-generic-password -U -s ${SERVICE} -a ${account} -l "${label}" -X ${hex}\n`);
  proc.stdin.end();
  await proc.exited;
  // `security -i` exits 0 even when the command fails, so read it back.
  return (await readItem(account)) === value;
}

async function deleteItem(account: string) {
  await run(["security", "delete-generic-password", "-s", SERVICE, "-a", account]);
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

export const sourceHash = (references: unknown) => createHash("sha256").update(JSON.stringify(references)).digest("hex").slice(0, 16);

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
