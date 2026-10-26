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

function report(header: string, problems: string[]): never {
  const lines = problems.join("\n").split("\n");
  const shown = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) shown.push(`… ${lines.length - MAX_LINES} more lines`);
  console.error(`${header}\n${shown.join("\n")}`);
  process.exit(2);
}

/** Paths with uncommitted changes. `-z` keeps the leading status column and leaves paths unquoted. */
function changedFiles(): string[] {
  const entries = run(["git", "status", "--porcelain", "-z", "--untracked-files=all"]).out.split("\0");
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

const isTs = (f: string) => /\.(ts|tsx|js|mjs|cjs)$/.test(f) || f === "package.json" || f === "tsconfig.json";

/** Only the failing tests and their errors: bun test prints every passing test too. */
function testFailures(out: string): string[] {
  const lines = out.split("\n");
  const keep = lines.filter((l) => /\(fail\)|error:|Expected|Received|^\s+at |\d+ fail/.test(l));
  return keep.length ? keep : lines.filter((l) => l.trim()).slice(-MAX_LINES);
}

async function stop() {
  if (!changedFiles().some(isTs)) return;
  const failures: string[] = [];
  const types = run(["bun", "run", "typecheck"]);
  if (!types.ok) failures.push(`## typecheck\n${types.out.split("\n").filter((l) => l.trim() && !l.startsWith("$ ")).slice(-MAX_LINES).join("\n")}`);
  const tests = run(["bun", "test"]);
  if (!tests.ok) failures.push(`## bun test\n${testFailures(tests.out).slice(-MAX_LINES).join("\n")}`);

  // Loop guard (Claude's `stop_hook_active` would also skip the re-check after a real fix, and Codex
  // may not send it): block again only while the failures change; the same ones twice end the turn.
  const last = Bun.file(resolve(ROOT, run(["git", "rev-parse", "--git-path", "agent-hook-stop"]).out.trim()));
  const now = failures.join("\n");
  const repeated = failures.length > 0 && (await last.exists()) && (await last.text()) === now;
  await (failures.length && !repeated ? Bun.write(last, now) : last.delete().catch(() => {}));
  if (failures.length && !repeated) report("Checks failed on your changes; fix them before finishing:", failures);
}

const mode = process.argv[2];
await Bun.stdin.text();
if (mode === "stop") await stop();
else report(`Unknown mode "${mode}". Use stop.`, []);
