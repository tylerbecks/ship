import { addTester, betaGroups, groupTesters, lookupApp } from "../asc/api";
import { bearerToken } from "../asc/client";
import { archive, buildPaths, checkInfo, exportIPA, ipaInfo, withKeyFile } from "../build";
import { CONFIG_FILE, findConfigRoot, loadProject, loadSettings, saveSettings, settingsPath } from "../config";
import { type Credentials, credentials, hasCredentials, resolveValue, serviceAccountToken } from "../credentials";
import { run } from "../exec";
import { commitSetting, headCommit } from "../git";
import { cacheExpiry, clearCached, clearServiceAccountToken, writeServiceAccountToken } from "../keychain";
import { ShipError, table, ui } from "../ui";
import { appSettings, packageSettings } from "../xcode";
import { appId, friendly } from "./status";

// MARK: archive

export const archiveHelp = `ship archive [--build <n>]

Archives a Release build and exports the App Store Connect .ipa, without
uploading. Handy for checking signing. Uses the project's current build
number unless you pass --build. Products land in .ship/builds/<n>/.`;

export async function archiveCommand(options: { app?: string; build?: string }) {
  const project = await loadProject({ app: options.app });
  const build =
    options.build ??
    (project.config.kind === "swiftpm"
      ? (await packageSettings(project.projectPath)).build
      : (await appSettings({ kind: project.config.kind, path: project.projectPath }, project.config.scheme)).build) ??
    "1";
  const creds = (await hasCredentials()) ? await credentials() : undefined;
  const commit = await headCommit(project.root);
  const ipa = await withKeyFile(creds, async (key) => {
    ui.step(`Archiving ${project.config.scheme} (Release, build ${build})`);
    await archive(project, build, creds, key, commit && commitSetting(commit));
    ui.ok("Archived");
    ui.step("Exporting the App Store Connect .ipa");
    return exportIPA(project, build, creds, key);
  });
  const checks = checkInfo(await ipaInfo(ipa), { bundleId: project.config.bundleId, build });
  for (const check of checks) (check.ok ? ui.ok : ui.warn).call(ui, check.message);
  ui.result({ build, ipa, checks, logs: buildPaths(project, build) }, () => console.log(`Exported ${ipa}`));
}

// MARK: testers

export const testersHelp = `ship testers [list] [--group <name>]
ship testers add <email>... [--group <name>]

Lists or invites TestFlight testers. Without --group, uses the first
external group (from ship.json's groups.external, or App Store Connect).`;

export async function testers(action: string, emails: string[], options: { app?: string; group?: string }) {
  const project = await loadProject({ app: options.app });
  const id = await appId(project);
  const groups = await betaGroups(id);
  const name = options.group ?? project.config.groups?.external?.[0];
  const group = name ? groups.find((g) => g.name === name) : groups.find((g) => !g.isInternal);
  if (!group) {
    throw new ShipError(
      name ? `No TestFlight group called "${name}"` : "This app has no external TestFlight group",
      "no-group",
      groups.length ? `Groups: ${groups.map((g) => g.name).join(", ")}` : "Create one in App Store Connect → TestFlight.",
    );
  }
  if (action === "add") {
    if (!emails.length) throw new ShipError("Pass one or more email addresses", "usage", "ship testers add a@example.com", undefined, 2);
    for (const email of emails) {
      await addTester(group.id, email);
      ui.ok(`Invited ${email} to ${group.name}`);
    }
  }
  const list = await groupTesters(group.id);
  ui.result({ group: group.name, testers: list }, () => {
    if (!list.length) return console.log(`${group.name} has no testers yet.`);
    console.log(table([["EMAIL", "NAME", "STATE"], ...list.map((t) => [t.email, t.name, friendly(t.state)])]));
  });
}

// MARK: auth

export const authHelp = `ship auth set --key-id <id> --issuer-id <id> --private-key <ref> [--op-account <account>]
ship auth status
ship auth refresh     Read the key from its source again (after rotating it)
ship auth forget      Delete the cached copy from the Keychain
ship auth service-account <op://ref>
                      Read 1Password with a service account (no Touch ID)
ship auth service-account remove

Sets up the App Store Connect API key ship signs requests with. Make a Team
key with the App Manager role in App Store Connect → Users and Access →
Integrations → App Store Connect API. One key works for every app on the team.

Each value can be literal, or point at a secret, which is better:
  op://<vault>/<item>/<field>   read from 1Password with \`op read\`
  env:NAME                       read from an environment variable
  file:~/path/AuthKey_ABC.p8     read from a file (--private-key)

Settings are saved in ~/.config/ship/config.json. Environment variables
SHIP_ASC_KEY_ID, SHIP_ASC_ISSUER_ID, and SHIP_ASC_PRIVATE_KEY (or
SHIP_ASC_PRIVATE_KEY_PATH) override them, for CI.

After reading the key, ship keeps a copy in the macOS login Keychain for 7
days, so 1Password (and Touch ID) is asked about once a week, not every run.
Change that with "cacheDays" in config.json (0 turns it off).

To skip Touch ID entirely, make a 1Password service account with read access
to the vault holding the key, save its token in 1Password, and point ship at
it once: \`ship auth service-account op://Private/<item>/credential\`. ship
reads the token (one last Touch ID), checks it, and keeps it in the Keychain.
Only ship's own \`op\` calls use it, so your shell's \`op\` is unaffected.`;

export async function auth(
  action: string,
  options: { keyId?: string; issuerId?: string; privateKey?: string; opAccount?: string; ref?: string },
) {
  if (action === "service-account") return serviceAccount(options.ref);
  if (action === "forget") {
    await clearCached();
    ui.result({ cleared: true }, () => console.log("Deleted the cached key from the Keychain. The next command reads it again."));
    return;
  }
  if (action === "refresh") await clearCached();
  if (!["set", "status", "refresh"].includes(action)) {
    throw new ShipError(`Unknown auth action "${action}"`, "usage", "Use set, status, refresh, forget, or service-account.", undefined, 2);
  }
  if (action === "set") {
    if (!options.keyId || !options.issuerId || !options.privateKey) {
      throw new ShipError("Pass --key-id, --issuer-id, and --private-key", "usage", "See `ship auth --help`.", undefined, 2);
    }
    const settings = await loadSettings();
    settings.credentials = { keyId: options.keyId, issuerId: options.issuerId, privateKey: options.privateKey };
    if (options.opAccount) settings.opAccount = options.opAccount;
    // Check the key works before saving it.
    const creds: Credentials = {
      keyId: (await resolveValue(options.keyId, settings.opAccount))!,
      issuerId: (await resolveValue(options.issuerId, settings.opAccount))!,
      privateKey: (await resolveValue(options.privateKey, settings.opAccount))!,
    };
    await bearerToken(creds);
    await saveSettings(settings);
    await clearCached();
    ui.ok(`Saved to ${settingsPath}`);
  }
  // status, refresh, and the end of set: prove the key works with a real request.
  ui.step("Checking the key with App Store Connect");
  await lookupApp("com.example.ship-auth-check");
  const settings = await loadSettings();
  const expires = await cacheExpiry();
  ui.result(
    {
      valid: true,
      source: process.env.SHIP_ASC_KEY_ID ? "environment" : settingsPath,
      keyId: settings.credentials?.keyId,
      cachedUntil: expires ? new Date(expires).toISOString() : null,
      serviceAccount: Boolean(await serviceAccountToken()),
    },
    () => {
      console.log("The App Store Connect API key works.");
      if (expires) console.log(`Cached in the Keychain until ${new Date(expires).toLocaleString()}.`);
    },
  );
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
  const read = await run(["op", "read", ...(settings.opAccount ? ["--account", settings.opAccount] : []), ref], {
    env: { OP_SERVICE_ACCOUNT_TOKEN: undefined },
  });
  if (read.code !== 0) throw new ShipError(`Couldn't read ${ref} from 1Password`, "op-failed", read.stderr.trim());
  const token = read.stdout.trim();
  const whoami = await run(["op", "whoami", "--format", "json"], { env: { OP_SERVICE_ACCOUNT_TOKEN: token } });
  if (whoami.code !== 0) {
    throw new ShipError("1Password didn't accept that token", "bad-token", whoami.stderr.trim() || "Is it a service account token (starts with ops_)?");
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

// MARK: doctor

export const doctorHelp = `ship doctor

Checks everything ship needs: Xcode, altool, the API key, 1Password (when
the key lives there), and this repo's ship.json.`;

export async function doctor() {
  const checks: { name: string; ok: boolean; detail: string; fix?: string }[] = [];
  const add = (name: string, ok: boolean, detail: string, fix?: string) => checks.push({ name, ok, detail, fix });

  const xcode = await run(["xcodebuild", "-version"]);
  add("Xcode", xcode.code === 0, xcode.stdout.split("\n")[0] ?? "", "Install Xcode and run `sudo xcode-select -s /Applications/Xcode.app`.");
  const altool = await run(["xcrun", "--find", "altool"]);
  add("altool (uploads)", altool.code === 0, altool.stdout.trim(), "Comes with Xcode.");

  const settings = await loadSettings();
  const usesOp = Object.values(settings.credentials ?? {}).some((v) => String(v).startsWith("op://"));
  if (usesOp) {
    const token = await serviceAccountToken();
    const op = await run(["op", "whoami", ...(settings.opAccount && !token ? ["--account", settings.opAccount] : [])], {
      env: token ? { OP_SERVICE_ACCOUNT_TOKEN: token } : {},
    });
    add(
      "1Password CLI",
      op.code === 0,
      op.code === 0 ? (token ? "service account" : "signed in (Touch ID)") : op.stderr.trim(),
      token ? "The token may be revoked. Run `ship auth service-account <op://ref>` again." : "Sign in with `op signin`.",
    );
  }
  if (await hasCredentials()) {
    try {
      await lookupApp("com.example.ship-auth-check");
      add("API key", true, "works");
    } catch (error) {
      add("API key", false, error instanceof Error ? error.message : String(error), "Run `ship auth status` for details.");
    }
  } else {
    add("API key", false, "not set up", "Run `ship auth set` (see `ship auth --help`).");
  }

  const root = findConfigRoot(process.cwd());
  if (root) {
    try {
      const project = await loadProject();
      add(CONFIG_FILE, true, `${project.config.name} (${project.config.bundleId}), scheme ${project.config.scheme}`);
      if (await hasCredentials()) {
        const app = await lookupApp(project.config.bundleId);
        add("App Store Connect app", Boolean(app), app ? `${app.name} (${app.id})` : "not found", "Create it in App Store Connect → Apps → +.");
      }
    } catch (error) {
      add(CONFIG_FILE, false, error instanceof Error ? error.message : String(error), "Run `ship init --force`.");
    }
  } else {
    add(CONFIG_FILE, false, "this folder isn't set up", "Run `ship init` in the app's repo.");
  }

  const healthy = checks.every((c) => c.ok);
  ui.result({ healthy, checks }, () => {
    for (const c of checks) {
      console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
      if (!c.ok && c.fix) console.log(`    ${c.fix}`);
    }
  });
  if (!healthy) process.exitCode = 1;
}
