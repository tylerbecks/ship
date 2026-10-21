// Runs before every test file (bunfig.toml). Keeps tests away from this
// machine's ship settings, credentials, and the network.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before anything imports src/config.ts, which reads SHIP_HOME once.
process.env.SHIP_HOME = mkdtempSync(join(tmpdir(), "ship-home-"));

for (const name of Object.keys(process.env)) {
  if (name.startsWith("SHIP_ASC_")) delete process.env[name];
}
delete process.env.OP_SERVICE_ACCOUNT_TOKEN;

/** Any request a test didn't mock fails loudly instead of reaching App Store Connect. */
export const networkGuard = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`Unmocked network call to ${url}`);
}) as unknown as typeof fetch;

globalThis.fetch = networkGuard;
