// The repo's agent tools in bin/: the stop hook's parsing, and the papercut log.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTs, porcelainPaths, testFailures } from "../bin/agent-hook";
import { temp } from "./helpers";

describe("the stop hook", () => {
  test("reads git status -z, skipping a rename's source", () => {
    const output = [" M src/cli.ts", "R  src/new.ts", "src/old.ts", "?? test/x.test.ts", ""].join("\0");
    expect(porcelainPaths(output)).toEqual(["src/cli.ts", "src/new.ts", "test/x.test.ts"]);
    expect(["README.md", "src/cli.ts", "package.json"].map(isTs)).toEqual([false, true, true]);
  });

  test("the same failing tests read the same on every run, whatever bun's timings", () => {
    const run = (ms: string, total: string) =>
      [
        "test/a.test.ts:",
        "✓ passes [0.10ms]",
        "error: expect(received).toBe(expected)",
        "Expected: 2",
        "Received: 1",
        "      at <anonymous> (test/a.test.ts:2:38)",
        `(fail) adds [${ms}]`,
        " 1 fail",
        `Ran 2 tests across 1 file. [${total}]`,
      ].join("\n");
    const first = testFailures(run("1.40ms", "3.52s"));
    expect(testFailures(run("0.13ms", "41.00ms"))).toEqual(first);
    expect(first).toContain("(fail) adds");
    expect(first.some((line) => line.includes("passes"))).toBe(false);
    // Output with no recognizable failure falls back to its last lines, still untimed.
    expect(testFailures("Ran 0 tests. [12.00ms]")).toEqual(["Ran 0 tests."]);
  });
});

describe("bun papercuts", () => {
  const papercuts = (file: string, ...args: string[]) => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "bin", "papercuts.ts"), ...args], {
      env: { ...process.env, PAPERCUTS_FILE: file, PAPERCUTS_AGENT: "test" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
  };

  test("files, counts, and resolves a cut; a line a union merge doubled counts once", () => {
    const file = join(temp(), ".papercuts.jsonl");
    const filed = papercuts(file, "add", "the hook blocked forever", "--tag", "hooks", "--severity", "major");
    const id = filed.out.match(/pc_[0-9a-f]{8}/)![0];
    expect(papercuts(file, "again", id.slice(3, 7)).code).toBe(0);
    // A union merge of two branches that both carry the same `again` line.
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    writeFileSync(file, `${[...lines, lines.at(-1)].join("\n")}\n`);
    expect(papercuts(file, "list").out).toBe(`${id}  major ×2 [hooks]  the hook blocked forever  (test, ${new Date().toISOString().slice(0, 10)})`);

    expect(papercuts(file, "resolve", id).code).toBe(2);
    expect(papercuts(file, "resolve", id, "--note", "fixed in the hook").out).toBe("Resolved 1.");
    expect(papercuts(file, "list").out).toBe("No open papercuts.");
    expect(papercuts(file, "again", id)).toMatchObject({ code: 2, err: expect.stringContaining("was resolved") });
  });

  test("a flag the command doesn't read is an error, and writes nothing", () => {
    const file = join(temp(), ".papercuts.jsonl");
    const id = papercuts(file, "add", "a cut", "--tag", "docs").out.match(/pc_[0-9a-f]{8}/)![0];
    const before = readFileSync(file, "utf8");
    expect(papercuts(file, "list", "--tag", "hooks")).toMatchObject({ code: 2, err: "--tag isn't for `bun papercuts list` (it takes --all)." });
    expect(papercuts(file, "again", id, "--evidence", "more")).toMatchObject({ code: 2, err: "--evidence isn't for `bun papercuts again` (it takes no flags)." });
    expect(papercuts(file, "resolve", id, "--note", "x", "--severity", "major").code).toBe(2);
    expect(readFileSync(file, "utf8")).toBe(before);
    // Each command still takes its own.
    expect(papercuts(file, "list", "--all").code).toBe(0);
    expect(papercuts(file, "add", "another", "--severity", "blocker", "--evidence", "line").code).toBe(0);
  });
});
