#!/usr/bin/env bun
// ship: build, upload, and manage TestFlight (and later the App Store) from
// the command line, for people and agents alike.

import { parseArgs } from "node:util";
import pkg from "../package.json";
import { apps, appsHelp, remove, removeHelp } from "./commands/apps";
import { beta, betaHelp, distributeCommand, distributeHelp } from "./commands/beta";
import { init, initHelp } from "./commands/init";
import { archiveCommand, archiveHelp, auth, authHelp, doctor, doctorHelp, testers, testersHelp } from "./commands/misc";
import { status, statusHelp } from "./commands/status";
import { ShipError, ui } from "./ui";

const help = `ship ${pkg.version}: TestFlight and App Store Connect from the command line

Set up once per repo:
  ship init               Find the app's project and scheme; write ship.json
  ship remove             Undo init
  ship apps               Apps set up on this machine
  ship auth set           Set up the App Store Connect API key (once per machine)
  ship doctor             Check that everything's ready

Every day:
  ship                    Same as ship status
  ship status             Recent builds, TestFlight state, groups, public links
  ship beta               Next build number → archive → upload → TestFlight
  ship distribute <n>     Finish an uploaded build (groups, review)
  ship testers [add]      List or invite testers
  ship archive            Archive and export without uploading

Flags for every command:
  --json        One JSON object on stdout (progress goes to stderr)
  --app <name>  Use an app from \`ship apps\` instead of the current repo
  --quiet       Only the result
  --help        Help for a command, e.g. \`ship beta --help\``;

const helps: Record<string, string> = {
  init: initHelp,
  remove: removeHelp,
  apps: appsHelp,
  status: statusHelp,
  beta: betaHelp,
  distribute: distributeHelp,
  testers: testersHelp,
  archive: archiveHelp,
  auth: authHelp,
  doctor: doctorHelp,
};

const global = {
  json: { type: "boolean" },
  quiet: { type: "boolean" },
  app: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/** Parses a command's flags along with the global ones; unknown flags are errors. */
function parse<T extends Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }>>(argv: string[], options: T) {
  try {
    return parseArgs({ args: argv, options: { ...global, ...options }, allowPositionals: true, strict: true });
  } catch (error) {
    // Node's message runs on about placing positionals after "--"; the first sentence is enough.
    const message = (error instanceof Error ? error.message : String(error)).split(". ")[0] ?? "Bad arguments";
    throw new ShipError(message, "usage", "See `ship --help`.", undefined, 2);
  }
}

async function main(argv: string[]) {
  // Set before parsing, so even a usage error comes back as JSON.
  ui.json = argv.includes("--json");
  if (argv[0] === "--version" || argv[0] === "-v") return console.log(pkg.version);
  const first = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;
  if (!first && (argv.includes("--help") || argv.includes("-h"))) return console.log(help);
  const command = first ?? "status";
  const rest = first ? argv.slice(1) : argv;
  if (command === "help") {
    console.log(argv[1] && helps[argv[1]] ? helps[argv[1]] : help);
    return;
  }
  if (!helps[command]) {
    throw new ShipError(`Unknown command "${command}"`, "usage", "See `ship --help`.", undefined, 2);
  }

  const spec = {
    init: { project: { type: "string" }, scheme: { type: "string" }, force: { type: "boolean" } },
    remove: { "keep-file": { type: "boolean" } },
    apps: {},
    status: { all: { type: "boolean" }, limit: { type: "string" } },
    beta: {
      notes: { type: "string" },
      external: { type: "boolean" },
      build: { type: "string" },
      "no-wait": { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    distribute: { notes: { type: "string" }, external: { type: "boolean" } },
    testers: { group: { type: "string" } },
    archive: { build: { type: "string" } },
    auth: {
      "key-id": { type: "string" },
      "issuer-id": { type: "string" },
      "private-key": { type: "string" },
      "op-account": { type: "string" },
    },
    doctor: {},
  } as const;

  const { values, positionals } = parse(rest, spec[command as keyof typeof spec]);
  const v = values as Record<string, string | boolean | undefined>;
  ui.json = Boolean(v.json);
  ui.quiet = Boolean(v.quiet);
  if (v.help) return console.log(helps[command]);
  // Plain `ship` outside a set-up repo is a first run: show help, not an error.
  const app = v.app as string | undefined;

  switch (command) {
    case "init":
      return init({ project: v.project as string, scheme: v.scheme as string, force: Boolean(v.force) });
    case "remove":
      return remove({ app, keepFile: Boolean(v["keep-file"]) });
    case "apps":
      return apps();
    case "status":
      if (!first && !app) {
        try {
          return await status({ limit: 5 });
        } catch (error) {
          if (error instanceof ShipError && (error.code === "no-config" || error.code === "no-credentials") && !ui.json) {
            console.log(help);
            console.log(`\n${error.message}. ${error.hint ?? ""}`);
            return;
          }
          throw error;
        }
      }
      return status({ app, all: Boolean(v.all), limit: v.limit ? Number(v.limit) : 5 });
    case "beta":
      return beta({
        app,
        notes: v.notes as string,
        external: Boolean(v.external),
        build: v.build as string,
        wait: !v["no-wait"],
        dryRun: Boolean(v["dry-run"]),
      });
    case "distribute": {
      const build = positionals[0];
      if (!build) throw new ShipError("Which build? ship distribute <build>", "usage", undefined, undefined, 2);
      return distributeCommand(build, { app, notes: v.notes as string, external: Boolean(v.external) });
    }
    case "testers":
      return testers(positionals[0] ?? "list", positionals.slice(1), { app, group: v.group as string });
    case "archive":
      return archiveCommand({ app, build: v.build as string });
    case "auth":
      return auth(positionals[0] ?? "status", {
        keyId: v["key-id"] as string,
        issuerId: v["issuer-id"] as string,
        privateKey: v["private-key"] as string,
        opAccount: v["op-account"] as string,
        ref: positionals[1],
      });
    case "doctor":
      return doctor();
  }
}

main(process.argv.slice(2)).catch((error) => ui.fail(error));
