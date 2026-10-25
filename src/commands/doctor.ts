// ship doctor: check that everything ship needs is ready.

import { existsSync } from "node:fs";
import { relative } from "node:path";
import { lookupApp } from "../asc/apps";
import { type Command, stringFlag } from "../command";
import { CONFIG_FILE, type Project, findConfigRoot, loadProject, loadSettings } from "../config";
import { hasCredentials, serviceAccountToken } from "../credentials";
import { run } from "../exec";
import { hasGenericPassword } from "../keychain";
import { parseKeychainRef, runOp } from "../secrets";
import { validateMedia } from "../store/media";
import { validateStore } from "../store/metadata";
import { readBetaInfo, testflightDir, validateBetaInfo } from "../store/testflight";
import { checksSuite, writeJUnit } from "../junit";
import { ShipError, ui } from "../ui";

export const doctorHelp = `ship doctor [--app <name>] [--junit <path>]

Checks everything ship needs: Xcode, altool, the API key and the Keychain
items or 1Password it reads from, this repo's ship.json (or --app's), and
(offline) the store folder, as the three validate commands would.

  --junit <path>  Also write the checks as a JUnit report, for CI`;

/** The store folder's offline checks (all three validates), when there is one. */
export async function checkStore(project: Project): Promise<{ name: string; ok: boolean; detail: string; fix: string } | undefined> {
  if (!existsSync(project.storeDir)) return undefined;
  const name = `${relative(project.root, project.storeDir) || "."}/`;
  const beta = testflightDir(project);
  let results: { command: string; problems: { severity: string }[] }[];
  try {
    results = [
      { command: "metadata", problems: await validateStore(project.storeDir) },
      { command: "screenshots", problems: (await validateMedia(project.storeDir, { platform: project.platform })).problems },
      { command: "testflight", problems: existsSync(beta) ? validateBetaInfo(await readBetaInfo(beta)) : [] },
    ];
  } catch (error) {
    // A file too broken to read (like review.json that isn't JSON).
    const hint = error instanceof ShipError ? error.hint : undefined;
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error), fix: hint ?? "Fix the file, then run `ship doctor` again." };
  }
  const failing = results.filter(({ problems }) => problems.some((problem) => problem.severity === "error"));
  const errors = results.flatMap(({ problems }) => problems).filter((problem) => problem.severity === "error").length;
  return {
    name,
    ok: errors === 0,
    detail: errors ? `${errors} error${errors === 1 ? "" : "s"}` : "valid",
    fix: `See them with ${failing.map(({ command }) => `\`ship ${command} validate\``).join(", ")}.`,
  };
}

export async function doctor(app?: string, options: { junit?: string } = {}) {
  const checks: { name: string; ok: boolean; detail: string; fix?: string }[] = [];
  const add = (name: string, ok: boolean, detail: string, fix?: string) => checks.push({ name, ok, detail, fix });

  const xcode = await run(["xcodebuild", "-version"]);
  add("Xcode", xcode.code === 0, xcode.stdout.split("\n")[0] ?? "", "Install Xcode and run `sudo xcode-select -s /Applications/Xcode.app`.");
  const altool = await run(["xcrun", "--find", "altool"]);
  add("altool (uploads)", altool.code === 0, altool.stdout.trim(), "Comes with Xcode.");

  const settings = await loadSettings();
  const references = Object.values(settings.credentials ?? {}).filter((v): v is string => typeof v === "string");
  for (const ref of [...new Set(references.filter((v) => v.startsWith("keychain:")))]) {
    const parsed = parseKeychainRef(ref);
    const found = parsed ? await hasGenericPassword(parsed.service, parsed.account) : false;
    add(`Keychain item ${ref}`, found, found ? "found" : parsed ? "missing" : "not a valid reference", `Save it with \`ship secret set ${ref} --from-file <path>\`, or run \`ship auth set\` again.`);
  }
  const usesOp = references.some((v) => v.startsWith("op://"));
  if (usesOp) {
    const token = await serviceAccountToken();
    try {
      const op = await runOp(["whoami"], { what: "check 1Password", token, account: settings.opAccount });
      add(
        "1Password CLI",
        op.code === 0,
        op.code === 0 ? (token ? "service account" : "signed in (Touch ID)") : op.stderr.trim() || `op whoami exited ${op.code}`,
        token ? "The token may be revoked. Run `ship auth service-account <op://ref>` again." : "Sign in with `op signin`.",
      );
    } catch (error) {
      add("1Password CLI", false, error instanceof Error ? error.message : String(error), error instanceof ShipError ? error.hint : undefined);
    }
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

  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  if (app || findConfigRoot(process.cwd())) {
    let project: Project | undefined;
    try {
      project = await loadProject({ app });
      add(CONFIG_FILE, true, `${project.config.name} (${project.config.bundleId}), scheme ${project.config.scheme}`);
    } catch (error) {
      // --app naming an unknown app has its own hint; a broken ship.json is fixed by init.
      const hint = app && error instanceof ShipError && error.hint ? error.hint : "Run `ship init --force`.";
      add(CONFIG_FILE, false, message(error), hint);
    }
    if (project) {
      const store = await checkStore(project);
      if (store) add(store.name, store.ok, store.detail, store.fix);
      if (await hasCredentials()) {
        try {
          const found = await lookupApp(project.config.bundleId);
          add("App Store Connect app", Boolean(found), found ? `${found.name} (${found.id})` : "not found", "Create it in App Store Connect → Apps → +.");
        } catch (error) {
          add("App Store Connect app", false, message(error), error instanceof ShipError && error.hint ? error.hint : "Check the API key with `ship auth status`, and your connection.");
        }
      }
    }
  } else {
    add(CONFIG_FILE, false, "this folder isn't set up", "Run `ship init` in the app's repo, or pass --app <name> (see `ship apps`).");
  }

  const healthy = checks.every((c) => c.ok);
  if (options.junit) await writeJUnit(options.junit, checksSuite("ship doctor", checks));
  ui.result({ healthy, checks }, () => {
    for (const c of checks) {
      console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
      if (!c.ok && c.fix) console.log(`    ${c.fix}`);
    }
  });
  if (!healthy) process.exitCode = 1;
}

export const commands: Command[] = [
  {
    name: "doctor",
    index: [{ section: "setup", label: "doctor", summary: "Check that everything's ready" }],
    help: doctorHelp,
    flags: { junit: { type: "string" } },
    maxArgs: 0,
    run: (ctx) => doctor(ctx.app, { junit: stringFlag(ctx, "junit") }),
  },
];
