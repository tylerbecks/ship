#!/usr/bin/env bun
/**
 * Agent hooks, shared by Claude Code (.claude/settings.json) and Codex (.codex/hooks.json).
 *   bin/agent-hook.ts stop   typecheck and test what changed before the agent ends its turn
 * Reads the hook event JSON on stdin. Exit 0 is silent; exit 2 hands stderr back to the agent.
 */
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const MAX_LINES = 40;

function run(cmd: string[]): { ok: boolean; out: string } {
  try {
    const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    return { ok: p.exitCode === 0, out: p.stdout.toString() + p.stderr.toString() };
  } catch {
    // spawnSync throws when the binary is missing (no `bun install` yet).
    return { ok: false, out: `${cmd[0]} not found; run bun install.` };
  }
}

function report(header: string, problems: string[], exitCode = 2): never {
  const lines = problems.join("\n").split("\n");
  const shown = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) shown.push(`… ${lines.length - MAX_LINES} more lines`);
  console.error(problems.length ? `${header}\n${shown.join("\n")}` : header);
  process.exit(exitCode);
}

/** Paths in `git status --porcelain -z` output. `-z` keeps the status column and leaves paths unquoted. */
export function porcelainPaths(output: string): string[] {
  const entries = output.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.length < 4) continue;
    paths.push(e.slice(3));
    // A rename or copy is followed by its source path as a separate entry.
    if (e[0] === "R" || e[0] === "C") i++;
  }
  return paths;
}

export const isTs = (f: string) => /\.(ts|tsx|js|mjs|cjs)$/.test(f) || f === "package.json" || f === "tsconfig.json";

/** bun test's timings ("[1.40ms]", "[3.52s]") differ every run; without them the same failure reads the same twice. */
const untimed = (line: string) => line.replace(/\s*\[\d+(\.\d+)?m?s\]/g, "");

/** Only the failing tests and their errors (bun test prints every passing test too), without timings. */
export function testFailures(out: string): string[] {
  const lines = out.split("\n").map(untimed);
  const keep = lines.filter((l) => /\(fail\)|error:|Expected|Received|^\s+at |\d+ fail/.test(l));
  return keep.length ? keep : lines.filter((l) => l.trim()).slice(-MAX_LINES);
}

/** Files with TypeScript changes to check: uncommitted ones, and ones committed since the last check that ran. */
function changedTs(lastChecked: string | undefined): boolean {
  const uncommitted = porcelainPaths(run(["git", "status", "--porcelain", "-z", "--untracked-files=all"]).out);
  if (uncommitted.some(isTs)) return true;
  // With no record yet, everything the branch has over main counts.
  const base = lastChecked || run(["git", "merge-base", "HEAD", "origin/main"]).out.trim();
  if (!base) return true;
  const committed = run(["git", "diff", "--name-only", `${base}..HEAD`]);
  return !committed.ok || committed.out.split("\n").some(isTs);
}

async function stop() {
  const gitPath = (name: string) => resolve(ROOT, run(["git", "rev-parse", "--git-path", name]).out.trim());
  const checked = Bun.file(gitPath("agent-hook-checked"));
  const head = run(["git", "rev-parse", "HEAD"]).out.trim();
  if (!changedTs((await checked.exists()) ? (await checked.text()).trim() : undefined)) return;

  const failures: string[] = [];
  const types = run(["bun", "run", "typecheck"]);
  if (!types.ok) failures.push(`## typecheck\n${types.out.split("\n").filter((l) => l.trim() && !l.startsWith("$ ")).slice(-MAX_LINES).join("\n")}`);
  const tests = run(["bun", "test"]);
  if (!tests.ok) failures.push(`## bun test\n${testFailures(tests.out).slice(-MAX_LINES).join("\n")}`);
  // Committed work is checked once; later stops look only at what changes after it.
  if (!failures.length && head) await Bun.write(checked, head);

  // Loop guard (Claude's `stop_hook_active` would also skip the re-check after a real fix, and Codex
  // may not send it): block again only while the failures change; the same ones twice end the turn.
  const last = Bun.file(gitPath("agent-hook-stop"));
  const now = failures.join("\n");
  const repeated = failures.length > 0 && (await last.exists()) && (await last.text()) === now;
  await (failures.length && !repeated ? Bun.write(last, now) : last.delete().catch(() => {}));
  if (repeated) console.log("Checks are still failing (the same failures as last time), so the turn ends anyway.");
  if (failures.length && !repeated) report("Checks failed on your changes; fix them before finishing:", failures);
}

if (import.meta.main) {
  const mode = process.argv[2];
  await Bun.stdin.text();
  if (mode === "stop") await stop();
  // A mistyped hook config shouldn't block every turn: exit 1 is shown, not enforced.
  else report(`Unknown mode "${mode}". Use stop.`, [], 1);
}
