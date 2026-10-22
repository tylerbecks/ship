// ship auth: the App Store Connect API key ship signs requests with.

import { lookupApp } from "../asc/apps";
import { bearerToken } from "../asc/client";
import { type Command, boolFlag, stringFlag } from "../command";
import { loadSettings, saveSettings, settingsPath } from "../config";
import { type Credentials, credentialSources, credentials, resolveValue, serviceAccountToken, useCredentials } from "../credentials";
import { ASC_KEY_ACCOUNT_PREFIX, cacheExpiry, checkKeychainName, clearCached, clearServiceAccountToken, writeGenericPassword, writeServiceAccountToken } from "../keychain";
import { normalizePrivateKey, opFailed, runOp } from "../secrets";
import { ShipError, ui } from "../ui";

export const authHelp = `ship auth set --key-id <id> --issuer-id <id> --private-key <ref> [--keychain] [--op-account <account>]
ship auth status
ship auth refresh     Read the key from its source again (after rotating it)
ship auth forget      Delete the cached copy from the Keychain
ship auth service-account <op://ref>
                      Read 1Password with a service account (no Touch ID)
ship auth service-account remove

Sets up the App Store Connect API key ship signs requests with. Make a Team
key with the App Manager role in App Store Connect → Users and Access →
Integrations → App Store Connect API. One key works for every app on the team.

Each value can be literal, or point at where the secret lives:
  keychain:<service>/<account>   the macOS login Keychain
  op://<vault>/<item>/<field>    1Password, read with \`op read\`
  env:NAME                       an environment variable
  file:~/path/AuthKey_ABC.p8     a file

On a Mac, the simplest is to hand ship the .p8 once and keep it in the
Keychain: \`--private-key file:~/Downloads/AuthKey_ABC.p8 --keychain\` saves
the key as the Keychain item ship / asc-private-key-<key id> and points at
it, so the .p8 can be deleted. \`ship secret\` saves and checks other items.

Settings are saved in ~/.config/ship/config.json, which holds only the
references. Environment variables SHIP_ASC_KEY_ID, SHIP_ASC_ISSUER_ID, and
SHIP_ASC_PRIVATE_KEY (or SHIP_ASC_PRIVATE_KEY_PATH) override them, for CI.

  --keychain              Save the private key in the Keychain and use that
  --op-account <account>  The 1Password account, when you have more than one

With 1Password, ship keeps a copy of the key in the login Keychain for 7
days, so 1Password (and Touch ID) is asked about once a week, not every run.
Change that with "cacheDays" in config.json (0 turns it off).

To skip Touch ID entirely, make a 1Password service account with read access
to the vault holding the key, save its token in 1Password, and point ship at
it once: \`ship auth service-account op://Private/<item>/credential\`. ship
reads the token (one last Touch ID), checks it, and keeps it in the Keychain.
Only ship's own \`op\` calls use it, so your shell's \`op\` is unaffected.`;

/** The Keychain item `ship auth set --keychain` keeps a key's .p8 in. */
export const keychainKeyRef = (keyId: string) => ({
  service: "ship",
  account: `${ASC_KEY_ACCOUNT_PREFIX}${keyId}`,
  ref: `keychain:ship/${ASC_KEY_ACCOUNT_PREFIX}${keyId}`,
});

export async function auth(
  action: string,
  options: { keyId?: string; issuerId?: string; privateKey?: string; opAccount?: string; keychain?: boolean; ref?: string },
) {
  if (action === "service-account") return serviceAccount(options.ref);
  if (action === "forget") {
    await clearCached();
    ui.result({ cleared: true }, () => console.log("Deleted the cached key from the Keychain. The next command reads it again."));
    return;
  }
  if (!["set", "status", "refresh"].includes(action)) {
    throw new ShipError(`Unknown auth action "${action}"`, "usage", "Use set, status, refresh, forget, or service-account.", undefined, 2);
  }
  if (options.keychain && action !== "set") {
    throw new ShipError("--keychain goes with `ship auth set`", "usage", "ship auth set --key-id <id> --issuer-id <id> --private-key file:<path> --keychain", undefined, 2);
  }
  if (action === "refresh") await clearCached();
  if (action === "set") {
    if (!options.keyId || !options.issuerId || !options.privateKey) {
      throw new ShipError("Pass --key-id, --issuer-id, and --private-key", "usage", "See `ship auth --help`.", undefined, 2);
    }
    const settings = await loadSettings();
    settings.credentials = { keyId: options.keyId, issuerId: options.issuerId, privateKey: options.privateKey };
    if (options.opAccount) settings.opAccount = options.opAccount;
    // Check the key works before saving it.
    const creds: Credentials = {
      keyId: (await resolveValue(options.keyId, settings.opAccount))!.trim(),
      issuerId: (await resolveValue(options.issuerId, settings.opAccount))!.trim(),
      privateKey: normalizePrivateKey((await resolveValue(options.privateKey, settings.opAccount))!),
    };
    await bearerToken(creds);
    if (options.keychain) settings.credentials.privateKey = await keepInKeychain(creds, options.privateKey);
    await saveSettings(settings);
    await clearCached();
    // The check below uses the key just read, instead of reading it again.
    useCredentials(creds);
    ui.ok(`Saved to ${settingsPath}`);
  }
  // status, refresh, and the end of set: prove the key works with a real request.
  ui.step("Checking the key with App Store Connect");
  await lookupApp("com.example.ship-auth-check");
  const settings = await loadSettings();
  const expires = await cacheExpiry();
  const sources = await credentialSources();
  ui.result(
    {
      valid: true,
      source: process.env.SHIP_ASC_KEY_ID ? "environment" : settingsPath,
      keyId: settings.credentials?.keyId,
      cachedUntil: expires ? new Date(expires).toISOString() : null,
      serviceAccount: Boolean(await serviceAccountToken()),
      sources,
    },
    () => {
      console.log("The App Store Connect API key works.");
      console.log(`Key id: ${sources.keyId ?? "?"}. Issuer id: ${sources.issuerId ?? "?"}. Private key: ${sources.privateKey ?? "?"}.`);
      if (expires) console.log(`Cached in the Keychain until ${new Date(expires).toLocaleString()}.`);
    },
  );
}

/** Saves the resolved private key as a Keychain item and returns the reference to it. */
async function keepInKeychain(creds: Credentials, reference: string): Promise<string> {
  const { service, account, ref } = keychainKeyRef(creds.keyId);
  checkKeychainName(account, "account");
  if (reference === ref) return ref;
  if (!(await writeGenericPassword(service, account, creds.privateKey, `ship: App Store Connect API key ${creds.keyId}`))) {
    throw new ShipError("Couldn't save the key to the Keychain", "keychain-failed", "Is the login Keychain unlocked? Try again, or leave out --keychain.");
  }
  ui.ok(`Saved the private key in the Keychain as ${ref}`);
  if (reference.startsWith("file:")) ui.note(`ship reads it from the Keychain now, so you can delete ${reference.slice("file:".length)}.`);
  return ref;
}

async function serviceAccount(ref: string | undefined) {
  if (ref === "remove") {
    await clearServiceAccountToken();
    ui.result({ removed: true }, () => console.log("Removed the service account token. ship's `op` calls use your own sign-in again."));
    return;
  }
  if (!ref) {
    throw new ShipError(
      "Pass the token's 1Password reference",
      "usage",
      "ship auth service-account op://Private/<item>/credential (use the item's ID if its title has symbols like : or ').",
      undefined,
      2,
    );
  }
  const settings = await loadSettings();
  // Read the token as yourself, not with whatever token is already saved.
  ui.step("Reading the token from 1Password");
  const read = await runOp(["read", ref], { what: `read ${ref}`, account: settings.opAccount });
  if (read.code !== 0) throw opFailed(`Couldn't read ${ref} from 1Password`, read, "Is the 1Password CLI signed in (`op signin`)? Check the reference, or use the item's ID.");
  const token = read.stdout.trim();
  const whoami = await runOp(["whoami", "--format", "json"], { what: "check the token", token });
  if (whoami.code !== 0) {
    throw new ShipError("1Password didn't accept that token", "bad-token", [whoami.stderr.trim(), "Is it a service account token (starts with ops_)?"].filter(Boolean).join(" "));
  }
  if (!(await writeServiceAccountToken(token))) {
    throw new ShipError("Couldn't save the token to the Keychain", "keychain-failed", "Is the login Keychain unlocked? Try again.");
  }
  // The cached key may have come from references the token can't read; prove they work.
  await clearCached();
  ui.ok("Saved the service account token to the Keychain");
  const creds = await credentials();
  await bearerToken(creds);
  ui.result({ serviceAccount: true, keyId: creds.keyId }, () =>
    console.log("ship now reads 1Password with the service account. No more Touch ID prompts."),
  );
}

export const commands: Command[] = [
  {
    name: "auth",
    index: [{ section: "setup", label: "auth set", summary: "Set up the App Store Connect API key (once per machine)" }],
    help: authHelp,
    flags: {
      "key-id": { type: "string" },
      "issuer-id": { type: "string" },
      "private-key": { type: "string" },
      "op-account": { type: "string" },
      keychain: { type: "boolean" },
    },
    run: (ctx) =>
      auth(ctx.args[0] ?? "status", {
        keyId: stringFlag(ctx, "key-id"),
        issuerId: stringFlag(ctx, "issuer-id"),
        privateKey: stringFlag(ctx, "private-key"),
        opAccount: stringFlag(ctx, "op-account"),
        keychain: boolFlag(ctx, "keychain"),
        ref: ctx.args[1],
      }),
  },
];
