import { describe, expect, test } from "bun:test";
import pkg from "../package.json";
import {
  type Command,
  type Context,
  boolFlag,
  checkActionFlags,
  checkArgs,
  findCommand,
  flagHint,
  indexLine,
  intFlag,
  listFlag,
  parseFlags,
  renderIndex,
  splitCommand,
  stringFlag,
} from "../src/command";
import { commands } from "../src/commands";

/** `ship --help` before the registry, minus its first line (which has the version). */
const GOLDEN = `Set up once per repo:
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
  ship testers            List, invite, or remove testers
  ship archive            Archive and export without uploading

Flags for every command:
  --json        One JSON object on stdout (progress goes to stderr)
  --app <name>  Use an app from \`ship apps\` instead of the current repo
  --quiet       Only the result
  --help        Help for a command, e.g. \`ship beta --help\``;

/** The commands that existed before the registry. A change to their help lines must update GOLDEN on purpose. */
const EXISTING = ["init", "remove", "apps", "auth", "doctor", "status", "beta", "distribute", "testers", "archive"];

const ctx = (flags: Context["flags"]): Context => ({ args: [], flags, implicit: false });
const usageError = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return { code: (error as { code?: string }).code, exitCode: (error as { exitCode?: number }).exitCode, hint: (error as { hint?: string }).hint };
  }
};

describe("ship --help", () => {
  test("lists the existing commands exactly as before", () => {
    const existing = commands.filter((command) => EXISTING.includes(command.name));
    expect(renderIndex(existing, pkg.version)).toBe(`ship ${pkg.version}: TestFlight and App Store Connect from the command line\n\n${GOLDEN}`);
  });

  test("keeps every existing line, in order, with every command registered", () => {
    const lines = renderIndex(commands, pkg.version).split("\n");
    const golden = GOLDEN.split("\n").filter(Boolean);
    let at = 0;
    for (const line of lines) if (line === golden[at]) at++;
    expect(golden.slice(at)).toEqual([]);
    expect(lines.slice(-5)[0]).toBe("Flags for every command:");
  });

  test("prints a section only when it has commands, in order", () => {
    const make = (name: string, section: Command["index"][number]["section"]): Command => ({
      name,
      index: [{ section, label: name, summary: `About ${name}` }],
      help: "",
      flags: {},
      run: async () => {},
    });
    const text = renderIndex([make("pull", "appstore"), make("groups", "testflight")], "1.0");
    expect(text).not.toContain("Set up once per repo:");
    expect(text.indexOf("TestFlight:")).toBeLessThan(text.indexOf("App Store:"));
    expect(text).toContain("  ship groups             About groups");
  });

  test("pads labels to 24 columns, with two spaces after a long one", () => {
    expect(indexLine("", "Same as ship status")).toBe("  ship                    Same as ship status");
    expect(indexLine("screenshots pull <dir>", "x")).toBe("  ship screenshots pull <dir>  x");
  });
});

describe("the registry", () => {
  test("has unique names, and every command has help and an index line", () => {
    const names = commands.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const command of commands) {
      expect(command.help.length).toBeGreaterThan(0);
      expect(command.index.length).toBeGreaterThan(0);
      expect(findCommand(commands, command.name)).toBe(command);
    }
  });

  test("no command redefines a global flag", () => {
    for (const command of commands) {
      for (const flag of ["json", "quiet", "app", "help"]) expect(command.flags[flag]).toBeUndefined();
    }
  });
});

describe("flags", () => {
  test("parses global and command flags together", () => {
    const { values, positionals } = parseFlags(["add", "a@example.com", "--group", "Friends", "--json"], { group: { type: "string" } });
    expect(positionals).toEqual(["add", "a@example.com"]);
    expect(values.group).toBe("Friends");
    expect(values.json).toBe(true);
  });

  test("an unknown flag is a usage error", () => {
    expect(usageError(() => parseFlags(["--nope"], {}))).toMatchObject({ code: "usage", exitCode: 2 });
  });

  test("reads strings, booleans, and lists", () => {
    const c = ctx({ notes: "Hi", external: true, locale: ["en-US", "de-DE"] });
    expect(stringFlag(c, "notes")).toBe("Hi");
    expect(stringFlag(c, "missing")).toBeUndefined();
    expect(boolFlag(c, "external")).toBe(true);
    expect(boolFlag(c, "missing")).toBe(false);
    expect(listFlag(c, "locale")).toEqual(["en-US", "de-DE"]);
    expect(listFlag(c, "notes")).toEqual(["Hi"]);
    expect(listFlag(c, "missing")).toEqual([]);
  });

  test("intFlag takes whole numbers in range and rejects the rest with a hint", () => {
    expect(intFlag(ctx({ limit: "12" }), "limit", { min: 1, max: 200 })).toBe(12);
    expect(intFlag(ctx({}), "limit")).toBeUndefined();
    for (const bad of ["abc", "1.5", "", "0", "201"]) {
      const error = usageError(() => intFlag(ctx({ limit: bad }), "limit", { min: 1, max: 200 }));
      expect(error).toMatchObject({ code: "usage", exitCode: 2 });
      expect(error?.hint).toBe("For example: --limit 10");
    }
  });
});

describe("checkActionFlags", () => {
  const takes = { pull: ["force"], push: ["dry-run", "prune"], diff: ["prune"], validate: [] };

  test("a flag for another action is a usage error naming where it works", () => {
    expect(usageError(() => checkActionFlags(ctx({ force: true }), "metadata", "push", takes))).toEqual({
      code: "usage",
      exitCode: 2,
      hint: "It works with ship metadata pull (see `ship metadata --help`).",
    });
    expect(usageError(() => checkActionFlags(ctx({ prune: true }), "metadata", "validate", takes))?.hint).toContain("ship metadata push and ship metadata diff");
  });

  test("the action's own flags, and flags no action lists, pass", () => {
    expect(() => checkActionFlags(ctx({ "dry-run": true, prune: true, json: true, locale: ["en-US"] }), "metadata", "push", takes)).not.toThrow();
  });
});

describe("the command name", () => {
  const names = commands.map((command) => command.name);

  test("global flags can come before it", () => {
    expect(splitCommand(["--app", "Lift", "beta", "--dry-run"], names)).toEqual({ name: "beta", rest: ["--app", "Lift", "--dry-run"] });
    expect(splitCommand(["--json", "groups", "delete", "Beta"], names)).toEqual({ name: "groups", rest: ["--json", "delete", "Beta"] });
    expect(splitCommand(["--app=Lift", "--quiet", "release", "submit"], names)).toEqual({ name: "release", rest: ["--app=Lift", "--quiet", "submit"] });
    expect(splitCommand(["--help", "beta"], names)).toEqual({ name: "beta", rest: ["--help"] });
  });

  test("an app called like a command is still the app", () => {
    expect(splitCommand(["--app", "status"], names)).toEqual({ rest: ["--app", "status"] });
  });

  test("no name means status; a name after a command's flag is a usage error", () => {
    expect(splitCommand(["--json"], names)).toEqual({ rest: ["--json"] });
    expect(splitCommand([], names)).toEqual({ rest: [] });
    expect(usageError(() => splitCommand(["--dry-run", "beta"], names))).toEqual({ code: "usage", exitCode: 2, hint: "Put the command first: ship beta --dry-run" });
  });
});

describe("arguments", () => {
  const run = async (name: string, args: string[], flags: Context["flags"] = {}) => findCommand(commands, name)!.run({ args, flags, implicit: false });
  const rejects = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as { code?: string; exitCode?: number; hint?: string; message: string };
    }
    throw new Error("expected an error");
  };

  test("checkArgs and flagHint", () => {
    expect(() => checkArgs([], 0, "x", "y")).not.toThrow();
    expect(usageError(() => checkArgs(["1.3"], 0, "ship release go takes no arguments", flagHint("1.3", ["version"], "See help.")))).toEqual({
      code: "usage",
      exitCode: 2,
      hint: "Pass it as --version 1.3",
    });
    expect(flagHint("de-DE", ["locale", "version"], "help")).toBe("Pass it as --locale de-DE");
    expect(flagHint("APP_IPHONE_67", ["locale", "type"], "help")).toBe("Pass it as --type APP_IPHONE_67");
    expect(flagHint("banana!", ["locale", "version"], "help")).toBe("help");
  });

  test("an argument in a flag's place fails before anything else, instead of widening what runs", async () => {
    // Outside a set-up repo these used to pass the usage checks and fail later with no-config.
    for (const [name, args, hint] of [
      ["release", ["go", "1.3"], "Pass it as --version 1.3"],
      ["release", ["cancel", "1.4"], "Pass it as --version 1.4"],
      ["release", ["status", "1.4"], "Pass it as --version 1.4"],
      ["release", ["phased", "pause", "1.4"], "Pass it as --version 1.4"],
      ["metadata", ["push", "de-DE"], "Pass it as --locale de-DE"],
      ["version", ["set", "1.5", "1.6"], "For example: ship version set 1.5"],
      ["distribute", ["41", "42"], "Distribute one build at a time: ship distribute 41"],
    ] as const) {
      expect(await rejects(run(name, [...args]))).toMatchObject({ code: "usage", exitCode: 2, hint });
    }
    expect((await rejects(run("release", ["go", "1.3"]))).message).toBe('ship release go takes no arguments, not "1.3"');
  });

  test("commands without actions say how many arguments they take", () => {
    for (const name of ["status", "beta", "archive", "init", "apps", "remove", "doctor"]) expect(findCommand(commands, name)!.maxArgs).toBe(0);
  });
});
