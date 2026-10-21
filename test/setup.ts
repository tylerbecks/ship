// Runs before every test file (bunfig.toml). Keeps tests away from this
// machine's ship settings, credentials, and the network.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before anything imports src/config.ts, which reads SHIP_HOME once.
process.env.SHIP_HOME = mkdtempSync(join(tmpdir(), "ship-home-"));

// Git without this machine's settings: a global fsmonitor, pager, signing, or
// external diff tool changes what git prints and how long it takes.
const gitHome = mkdtempSync(join(tmpdir(), "ship-git-"));
writeFileSync(join(gitHome, "gitconfig"), "");
process.env.GIT_CONFIG_GLOBAL = join(gitHome, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Ship";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "ship@example.com";

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

// Nor the Keychain or 1Password: a test that needs them replaces these with fakes.
const { security } = await import("../src/keychain");
const { tools } = await import("../src/secrets");
security.run = async (args) => {
  throw new Error(`Unmocked Keychain call: security ${args[0]}`);
};
security.interactive = async () => {
  throw new Error("Unmocked Keychain call: security -i");
};
tools.op = async (args) => {
  throw new Error(`Unmocked 1Password call: op ${args[0]}`);
};
