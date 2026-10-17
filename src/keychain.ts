// A short-lived copy of the API key in the macOS login Keychain, so ship asks
// 1Password once every few days instead of on every run. The Keychain is
// encrypted and unlocked with your Mac login.

import { createHash } from "node:crypto";
import type { Credentials } from "./credentials";
import { run } from "./exec";

const SERVICE = "ship";
const ACCOUNT = "app-store-connect-api-key";

interface Cached extends Credentials {
  /** When the copy expires, in ms since 1970. */
  expires: number;
  /** A hash of the settings it came from, so changing them drops the copy. */
  source: string;
}

export const sourceHash = (references: unknown) => createHash("sha256").update(JSON.stringify(references)).digest("hex").slice(0, 16);

export async function readCached(source: string): Promise<(Credentials & { expires: number }) | undefined> {
  const result = await run(["security", "find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
  if (result.code !== 0) return undefined;
  try {
    const cached = JSON.parse(Buffer.from(result.stdout.trim(), "base64").toString()) as Cached;
    if (cached.source !== source || cached.expires < Date.now()) return undefined;
    return cached;
  } catch {
    return undefined;
  }
}

export async function writeCached(credentials: Credentials, source: string, days: number) {
  const cached: Cached = { ...credentials, source, expires: Date.now() + days * 86_400_000 };
  const value = Buffer.from(JSON.stringify(cached)).toString("base64");
  // Commands go to `security -i` on stdin, so the key never shows up in the
  // process list the way a command-line argument would.
  const hex = Buffer.from(value).toString("hex");
  const proc = Bun.spawn(["security", "-i"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  proc.stdin.write(`add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l "ship: App Store Connect API key" -X ${hex}\n`);
  proc.stdin.end();
  await proc.exited;
}

export async function cacheExpiry(): Promise<number | undefined> {
  const result = await run(["security", "find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
  if (result.code !== 0) return undefined;
  try {
    return (JSON.parse(Buffer.from(result.stdout.trim(), "base64").toString()) as Cached).expires;
  } catch {
    return undefined;
  }
}

export async function clearCached() {
  await run(["security", "delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
}
