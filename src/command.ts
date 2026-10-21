// What a command is, how its flags are read, and how `ship --help` lists them.
//
// Every command group is a file in src/commands that exports
// `commands: Command[]`; src/commands/index.ts lists the files. cli.ts parses
// the arguments, finds the command, and calls its `run`.

import { parseArgs } from "node:util";
import { ShipError } from "./ui";

/** A command's flags, in node:util parseArgs form. Global flags are added for you. */
export type FlagSpec = Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }>;

/** Where a command is listed in `ship --help`. */
export type Section = "setup" | "daily" | "testflight" | "appstore";

export interface Context {
  /** Positionals after the command name: ["add", "a@example.com"] for `ship testers add a@example.com`. */
  args: string[];
  /** The parsed flags (global ones included). */
  flags: Record<string, string | boolean | string[] | undefined>;
  /** --app */
  app?: string;
  /** True when the user typed plain `ship` (status's first-run behavior). */
  implicit: boolean;
}

export interface Command {
  name: string;
  /** Lines for `ship --help`, in registry order within each section. label is what follows "ship ". */
  index: { section: Section; label: string; summary: string }[];
  help: string;
  flags: FlagSpec;
  run(ctx: Context): Promise<void>;
}

// MARK: Parsing

/** The flags every command takes. */
export const globalFlags = {
  json: { type: "boolean" },
  quiet: { type: "boolean" },
  app: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const satisfies FlagSpec;

/** Parses a command's arguments along with the global flags; unknown flags are usage errors. */
export function parseFlags(argv: string[], flags: FlagSpec): { values: Context["flags"]; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: { ...globalFlags, ...flags }, allowPositionals: true, strict: true });
    return { values: values as Context["flags"], positionals };
  } catch (error) {
    // Node's message runs on about placing positionals after "--"; the first sentence is enough.
    const message = (error instanceof Error ? error.message : String(error)).split(". ")[0] ?? "Bad arguments";
    throw new ShipError(message, "usage", "See `ship --help`.", undefined, 2);
  }
}

// MARK: Reading flags

const usage = (message: string, hint: string) => new ShipError(message, "usage", hint, undefined, 2);

/** A string flag's value, or undefined when it wasn't passed. */
export function stringFlag(ctx: Context, name: string): string | undefined {
  const value = ctx.flags[name];
  if (Array.isArray(value)) return value.at(-1);
  return typeof value === "string" ? value : undefined;
}

/** Whether a boolean flag was passed. */
export function boolFlag(ctx: Context, name: string): boolean {
  return ctx.flags[name] === true;
}

/** A whole-number flag, checked against `min` and `max`. "abc" or "1.5" is a usage error. */
export function intFlag(ctx: Context, name: string, options: { min?: number; max?: number } = {}): number | undefined {
  const raw = stringFlag(ctx, name);
  if (raw === undefined) return undefined;
  const { min, max } = options;
  const range =
    min !== undefined && max !== undefined ? ` from ${min} to ${max}` : min !== undefined ? ` of at least ${min}` : max !== undefined ? ` up to ${max}` : "";
  const example = `--${name} ${Math.min(Math.max(10, min ?? 10), max ?? Number.POSITIVE_INFINITY)}`;
  if (!/^-?\d+$/.test(raw.trim())) {
    throw usage(`--${name} takes a whole number${range}, not "${raw}"`, `For example: ${example}`);
  }
  const value = Number.parseInt(raw.trim(), 10);
  if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
    throw usage(`--${name} must be a whole number${range}, not ${value}`, `For example: ${example}`);
  }
  return value;
}

/** Every value of a flag declared with `multiple: true` (or the one value of a plain string flag). */
export function listFlag(ctx: Context, name: string): string[] {
  const value = ctx.flags[name];
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}

// MARK: Help

const SECTIONS: { section: Section; title: string }[] = [
  { section: "setup", title: "Set up once per repo:" },
  { section: "daily", title: "Every day:" },
  { section: "testflight", title: "TestFlight:" },
  { section: "appstore", title: "App Store:" },
];

const GLOBAL_HELP = `Flags for every command:
  --json        One JSON object on stdout (progress goes to stderr)
  --app <name>  Use an app from \`ship apps\` instead of the current repo
  --quiet       Only the result
  --help        Help for a command, e.g. \`ship beta --help\``;

/** One `ship --help` line: the command padded to 24 columns (at least two spaces), then the summary. */
export function indexLine(label: string, summary: string): string {
  const left = `ship ${label}`.trimEnd();
  return `  ${left.length >= 23 ? `${left}  ` : left.padEnd(24)}${summary}`;
}

/** The top-level help: every command's index lines by section, then the global flags. */
export function renderIndex(commands: Command[], version: string): string {
  const parts = [`ship ${version}: TestFlight and App Store Connect from the command line`];
  for (const { section, title } of SECTIONS) {
    const lines = commands.flatMap((command) => command.index.filter((entry) => entry.section === section));
    if (lines.length) parts.push([title, ...lines.map((entry) => indexLine(entry.label, entry.summary))].join("\n"));
  }
  parts.push(GLOBAL_HELP);
  return parts.join("\n\n");
}

/** The command called `name`, if there is one. */
export function findCommand(commands: Command[], name: string | undefined): Command | undefined {
  return name ? commands.find((command) => command.name === name) : undefined;
}
