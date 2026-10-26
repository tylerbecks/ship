#!/usr/bin/env bun
/**
 * Papercuts: friction agents hit in this repo, filed the moment it happens and fixed in review.
 *   bun papercuts add "<what you hit, what would have prevented it>" [--tag <area>] [--severity minor|major|blocker]
 *                     [--evidence "<failing command, error line, run id>" | --evidence - (stdin)]
 *   bun papercuts again <id>                        you hit an open cut again (review fixes the most-hit first)
 *   bun papercuts resolve <id>... --note "<fix>"    the fix landed (or it was noise, or a duplicate)
 *   bun papercuts list [--all]                      open cuts, worst first, one line each; --all adds resolved ones
 *   bun papercuts show <id>...                      a cut with its evidence
 * The log is .papercuts.jsonl at the repo root: append-only, committed, `merge=union` in .gitattributes so
 * parallel branches merge cleanly. Ids accept any unique prefix. See AGENTS.md "Papercuts".
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const FILE = process.env.PAPERCUTS_FILE ?? resolve(import.meta.dir, "..", ".papercuts.jsonl");
const SEVERITIES = ["blocker", "major", "minor"] as const;
type Severity = (typeof SEVERITIES)[number];
// Enough for a command, its error and a run id; a whole log would bloat every reviewer's context.
const MAX_EVIDENCE_BYTES = 4096;

type Entry =
  | {
      kind: "cut";
      id: string;
      at: string;
      agent: string;
      severity: Severity;
      tags: string[];
      text: string;
      evidence?: string;
    }
  // `ev` makes each event line unique, so a line a union merge duplicated is told apart from a real repeat.
  | { kind: "again"; id: string; ev: string; at: string; agent: string }
  | { kind: "resolve"; id: string; ev: string; at: string; agent: string; note: string };

type Cut = Extract<Entry, { kind: "cut" }> & { hits: number; resolution?: string };

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const agent =
  process.env.PAPERCUTS_AGENT ??
  (process.env.CLAUDECODE
    ? "claude"
    : Object.keys(process.env).some((k) => k.startsWith("CODEX_"))
      ? "codex"
      : "human");

/** Every cut in the log with its later events folded in. A line a union merge duplicated counts once. */
function cuts(): Cut[] {
  const byId = new Map<string, Cut>();
  const seenEvents = new Set<string>();
  if (!existsSync(FILE)) return [];
  for (const [i, line] of readFileSync(FILE, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      console.error(`${FILE}:${i + 1}: not JSON, skipped`);
      continue;
    }
    if (e.kind === "cut" && !byId.has(e.id)) byId.set(e.id, { ...e, hits: 1 });
    if (e.kind !== "cut") {
      if (seenEvents.has(e.ev)) continue;
      seenEvents.add(e.ev);
    }
    const cut = byId.get(e.id);
    if (cut && e.kind === "again") cut.hits++;
    if (cut && e.kind === "resolve") cut.resolution = e.note;
  }
  return [...byId.values()];
}

function find(all: Cut[], prefix: string): Cut {
  const p = prefix.startsWith("pc_") ? prefix : `pc_${prefix}`;
  const matches = all.filter((c) => c.id.startsWith(p));
  if (matches.length === 1) return matches[0]!;
  return fail(
    matches.length
      ? `"${prefix}" matches ${matches.length} papercuts; use more of the id.`
      : `No papercut "${prefix}".`,
  );
}

/** Ids for `again`/`resolve`/`show`, all checked before anything is written so a typo can't half-apply. */
function named(all: Cut[]): Cut[] {
  if (!positionals.length) fail(`Name the papercut id(s): bun papercuts ${command} <id>...`);
  return positionals.map((p) => find(all, p));
}

function append(e: Entry) {
  // A hand edit can drop the final newline; appending onto it would corrupt both lines.
  const unterminated = existsSync(FILE) && !/(^|\n)$/.test(readFileSync(FILE, "utf8"));
  appendFileSync(FILE, `${unterminated ? "\n" : ""}${JSON.stringify(e)}\n`);
}

const event = () => ({ ev: randomBytes(4).toString("hex"), at: now(), agent });

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

function format(c: Cut): string {
  const hits = c.hits > 1 ? ` ×${c.hits}` : "";
  const tags = c.tags.length ? ` [${c.tags.join(", ")}]` : "";
  const more = c.evidence ? " +evidence" : "";
  const done = c.resolution ? `\n    resolved: ${c.resolution}` : "";
  return `${c.id}  ${c.severity}${hits}${tags}  ${c.text}  (${c.agent}, ${c.at.slice(0, 10)})${more}${done}`;
}

/** `--evidence -` reads stdin, so a multi-line error needs no shell quoting. */
async function evidence(): Promise<string | undefined> {
  const raw = values.evidence === "-" ? await Bun.stdin.text() : values.evidence;
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const bytes = Buffer.byteLength(trimmed);
  if (bytes > MAX_EVIDENCE_BYTES)
    fail(`Evidence is ${bytes} bytes (max ${MAX_EVIDENCE_BYTES}): quote the failing lines, not the whole output.`);
  return trimmed;
}

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = (() => {
  try {
    return parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        tag: { type: "string", multiple: true },
        severity: { type: "string" },
        note: { type: "string" },
        evidence: { type: "string" },
        all: { type: "boolean" },
      },
    });
  } catch (e) {
    // An unknown flag (`--tags`) or text starting with "-"; Node's message says to put the text after `--`.
    return fail((e as Error).message);
  }
})();

/** The flags each command reads. Any other one is an error, not silently dropped (`list --tag` doesn't filter). */
const FLAGS: Partial<Record<string, (keyof typeof values)[]>> = {
  add: ["tag", "severity", "evidence"],
  again: [],
  resolve: ["note"],
  list: ["all"],
  show: [],
};
const allowed = FLAGS[command ?? ""];
const ignored = (Object.keys(values) as (keyof typeof values)[]).find(
  (flag) => values[flag] !== undefined && allowed && !allowed.includes(flag),
);
if (allowed && ignored) {
  const takes = allowed.length ? `it takes ${allowed.map((f) => `--${f}`).join(", ")}` : "it takes no flags";
  fail(`--${ignored} isn't for \`bun papercuts ${command}\` (${takes}).`);
}

if (command === "add") {
  const text = positionals.join(" ").replace(/\s+/g, " ").trim();
  if (!text) fail('Say what you hit: bun papercuts add "<friction, and what would have prevented it>"');
  const severity = (values.severity ?? "minor") as Severity;
  if (!SEVERITIES.includes(severity)) fail(`--severity is one of ${SEVERITIES.join(", ")}.`);
  const at = now();
  const id = `pc_${createHash("sha256").update(`${at}\n${text}`).digest("hex").slice(0, 8)}`;
  const tags = (values.tag ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  append({ kind: "cut", id, at, agent, severity, tags, text, evidence: await evidence() });
  console.log(`Filed ${id}. Carry on with your task.`);
} else if (command === "again") {
  const hit = named(cuts());
  const done = hit.find((c) => c.resolution);
  if (done) fail(`${done.id} was resolved (${done.resolution}). If it's back, file a new cut that says so.`);
  for (const c of hit) append({ kind: "again", id: c.id, ...event() });
  console.log("Counted. Carry on with your task.");
} else if (command === "resolve") {
  const note = values.note?.trim();
  if (!note) fail('Say what fixed it: --note "<commit, PR, or why it was noise>"');
  const fixed = named(cuts());
  for (const c of fixed) append({ kind: "resolve", id: c.id, ...event(), note });
  console.log(`Resolved ${fixed.length}.`);
} else if (command === "list") {
  const rank = (c: Cut) => SEVERITIES.indexOf(c.severity);
  const shown = cuts()
    .filter((c) => values.all || !c.resolution)
    .toSorted((a, b) => rank(a) - rank(b) || b.hits - a.hits || b.at.localeCompare(a.at));
  console.log(shown.length ? shown.map(format).join("\n") : "No open papercuts.");
} else if (command === "show") {
  const indent = (s: string) => s.replace(/^/gm, "    ");
  for (const c of named(cuts())) {
    console.log(format(c) + (c.evidence ? `\n  evidence:\n${indent(c.evidence)}` : ""));
  }
} else {
  fail(`Usage: bun papercuts add|again|resolve|list|show (see bin/papercuts.ts)`);
}
