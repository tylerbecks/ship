import { describe, expect, test } from "bun:test";
import { type Change, MASK, changesJSON, compactDiff, diffRecord, lineDiff, normalize, renderChanges, same } from "../src/diff";

describe("normalize and same", () => {
  test("treat empty values alike and ignore CRLF and trailing whitespace", () => {
    for (const empty of [null, undefined, "", "  \n"]) expect(normalize(empty)).toBeUndefined();
    expect(normalize("a\r\nb  \r\n")).toBe("a\nb");
    expect(same("a\r\nb\n", "a\nb")).toBe(true);
    expect(same(null, "")).toBe(true);
    expect(same(undefined, null)).toBe(true);
    expect(same("a", "b")).toBe(false);
    expect(same(1, "1")).toBe(false);
    expect(same(false, undefined)).toBe(false);
  });

  test("compare arrays in order and objects by key", () => {
    expect(same(["a", "b"], ["a", "b"])).toBe(true);
    expect(same(["a", "b"], ["b", "a"])).toBe(false);
    expect(same({ a: 1, b: "x" }, { b: "x\n", a: 1 })).toBe(true);
    expect(same({ a: 1, b: null }, { a: 1 })).toBe(true);
    expect(same({ a: { c: [1] } }, { a: { c: [2] } })).toBe(false);
  });
});

describe("diffRecord", () => {
  test("adds, changes, and removes only the fields desired names", () => {
    const remote = { description: "Old", keywords: "gym", promotionalText: null, supportUrl: "https://x.example", marketingUrl: "https://m.example" };
    const desired = { description: "New", keywords: "gym\n", promotionalText: "Hi", supportUrl: "", whatsNew: undefined };
    expect(diffRecord("en-US", remote, desired)).toEqual([
      { scope: "en-US", field: "description", kind: "change", from: "Old", to: "New" },
      { scope: "en-US", field: "promotionalText", kind: "add", to: "Hi" },
      { scope: "en-US", field: "supportUrl", kind: "remove", from: "https://x.example", to: null },
    ]);
  });

  test("everything is an add when there's nothing remote", () => {
    expect(diffRecord("app", undefined, { copyright: "2026 Me", empty: "" })).toEqual([{ scope: "app", field: "copyright", kind: "add", to: "2026 Me" }]);
  });

  test("marks secret fields", () => {
    const [change] = diffRecord("review", { demoAccountPassword: "a" }, { demoAccountPassword: "b" }, { secret: ["demoAccountPassword"] });
    expect(change).toMatchObject({ kind: "change", secret: true });
  });
});

describe("lineDiff", () => {
  test("finds the longest common subsequence of lines", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { op: " ", line: "a" },
      { op: "-", line: "b" },
      { op: "+", line: "x" },
      { op: " ", line: "c" },
    ]);
    expect(lineDiff("", "a")).toEqual([{ op: "+", line: "a" }]);
    expect(lineDiff("a", "")).toEqual([{ op: "-", line: "a" }]);
    expect(lineDiff("a\nb", "a\nb")).toEqual([
      { op: " ", line: "a" },
      { op: " ", line: "b" },
    ]);
  });

  test("keeps 3 lines of context, marks gaps, and caps long diffs", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 10", "LINE 10");
    expect(compactDiff(before, after)).toEqual(["  line 7", "  line 8", "  line 9", "- line 10", "+ LINE 10", "  line 11", "  line 12", "  line 13"]);
    const two = after.replace("line 1\n", "LINE 1\n");
    expect(compactDiff(before, two)).toContain("…");
    const long = compactDiff("", Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
    expect(long.length).toBe(21);
    expect(long.at(-1)).toBe("… (30 more lines)");
  });
});

describe("rendering", () => {
  const changes: Change[] = [
    { scope: "en-US", field: "description", kind: "change", from: "Track every lift.\nSecond line.", to: "Track every lift, set, and rest.\nSecond line." },
    { scope: "en-US", field: "keywords", kind: "change", from: "gym,lifting", to: "gym,lifting,workout" },
    { scope: "en-US", field: "promotionalText", kind: "add", to: "New: Apple Watch app" },
    { scope: "review", field: "demoAccountPassword", kind: "change", from: "old", to: "keychain:ship/new", secret: true },
    { scope: "en-US", field: "marketingUrl", kind: "remove", from: "https://example.com", to: null },
  ];

  test("groups by scope with a line diff for multi-line text and masked secrets", () => {
    expect(renderChanges(changes)).toBe(
      [
        "en-US",
        "  ~ description (30 → 45 chars)",
        "      - Track every lift.",
        "      + Track every lift, set, and rest.",
        "        Second line.",
        '  ~ keywords: "gym,lifting" → "gym,lifting,workout"',
        '  + promotionalText: "New: Apple Watch app"',
        '  - marketingUrl: "https://example.com"',
        "review",
        "  ~ demoAccountPassword: •••• → ••••",
      ].join("\n"),
    );
  });

  test("shortens long single-line values", () => {
    const text = renderChanges([{ scope: "x", field: "f", kind: "add", to: "a".repeat(80) }]);
    expect(text).toContain(`"${"a".repeat(59)}…"`);
  });

  test("JSON masks secrets and keeps field names", () => {
    const json = changesJSON(changes);
    expect(json[3]).toEqual({ scope: "review", field: "demoAccountPassword", kind: "change", from: MASK, to: MASK, secret: true });
    expect(json[4]).toEqual({ scope: "en-US", field: "marketingUrl", kind: "remove", from: "https://example.com", to: null });
    expect(JSON.stringify(json)).not.toContain("keychain:ship/new");
  });
});
