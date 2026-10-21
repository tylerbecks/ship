import { describe, expect, test } from "bun:test";
import pkg from "../package.json";
import { type Command, type Context, boolFlag, findCommand, indexLine, intFlag, listFlag, parseFlags, renderIndex, stringFlag } from "../src/command";
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
