#!/usr/bin/env bun
// ship: build, upload, and manage TestFlight and the App Store from
// the command line, for people and agents alike.
//
// This file only parses the global flags and dispatches; the commands live in
// src/commands (listed in src/commands/index.ts).

import pkg from "../package.json";
import { checkArgs, findCommand, parseFlags, renderIndex, splitCommand } from "./command";
import { commands } from "./commands";
import { ShipError, ui } from "./ui";

const help = () => renderIndex(commands, pkg.version);

async function main(argv: string[]) {
  // Set before parsing, so even a usage error comes back as JSON.
  ui.json = argv.includes("--json");
  if (argv[0] === "--version" || argv[0] === "-v") return console.log(pkg.version);
  const { name: first, rest } = splitCommand(argv, [...commands.map((command) => command.name), "help"]);
  if (!first && (rest.includes("--help") || rest.includes("-h"))) return console.log(help());
  if (first === "help") {
    console.log(findCommand(commands, rest.find((arg) => !arg.startsWith("-")))?.help ?? help());
    return;
  }
  const name = first ?? "status";
  const command = findCommand(commands, name);
  if (!command) {
    throw new ShipError(`Unknown command "${name}"`, "usage", "See `ship --help`.", undefined, 2);
  }

  const { values, positionals } = parseFlags(rest, command.flags);
  ui.json = values.json === true;
  ui.quiet = values.quiet === true;
  if (values.help) return console.log(command.help);
  if (command.maxArgs !== undefined) {
    const takes = command.maxArgs === 0 ? "no arguments" : `at most ${command.maxArgs}`;
    checkArgs(positionals, command.maxArgs, `ship ${name} takes ${takes}`, `See \`ship ${name} --help\`.`);
  }
  const app = typeof values.app === "string" ? values.app : undefined;
  const implicit = !first;
  try {
    await command.run({ args: positionals, flags: values, app, implicit });
  } catch (error) {
    // Plain `ship` outside a set-up repo is a first run: show help, not an error.
    const firstRun = error instanceof ShipError && (error.code === "no-config" || error.code === "no-credentials");
    if (implicit && !app && firstRun && !ui.json) {
      console.log(help());
      console.log(`\n${error.message}. ${error.hint ?? ""}`);
      return;
    }
    throw error;
  }
}

main(process.argv.slice(2)).catch((error) => ui.fail(error));
