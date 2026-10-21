// Running other tools (git, xcodebuild, altool, op, security) without a shell.

import { ShipError } from "./ui";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The exit code `run` reports for a tool that isn't installed, as a shell would. */
export const NOT_FOUND = 127;

/** Runs a command without a shell and collects its output. A tool that isn't installed exits 127. */
export async function run(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; logFile?: string } = {},
): Promise<RunResult> {
  const spawn = () =>
    Bun.spawn(command, {
      cwd: options.cwd,
      // An undefined value removes the variable.
      env: Object.fromEntries(Object.entries({ ...process.env, ...options.env }).filter(([, value]) => value !== undefined)) as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn();
  } catch (error) {
    // Bun throws when the executable (or the working folder) doesn't exist.
    const reason = error instanceof Error ? error.message : String(error);
    return { code: NOT_FOUND, stdout: "", stderr: `${command[0]}: ${/ENOENT|not found|No such file/i.test(reason) ? "command not found" : reason}` };
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (options.logFile) {
    await Bun.write(options.logFile, `$ ${command.join(" ")}\n\n${stdout}\n${stderr}`);
  }
  return { code, stdout, stderr };
}

/** Like `run`, but throws when the command fails. */
export async function runOrThrow(
  command: string[],
  options: Parameters<typeof run>[1] & { what?: string } = {},
): Promise<RunResult> {
  const result = await run(command, options);
  const what = options.what ?? command.slice(0, 2).join(" ");
  if (result.code === NOT_FOUND && result.stderr.endsWith("command not found")) {
    throw new ShipError(
      `${what} failed: ${command[0]} isn't installed`,
      "command-missing",
      "Install Xcode (it brings xcodebuild and altool) and run `sudo xcode-select -s /Applications/Xcode.app`; `ship doctor` checks the rest.",
      { command: command.join(" ") },
    );
  }
  if (result.code !== 0) {
    const errors = errorLines(result.stdout + "\n" + result.stderr);
    // Without an error: line, the last lines of output usually say what went wrong.
    const shown = errors.length ? errors.slice(0, 8) : (result.stderr.trim() || result.stdout.trim()).split("\n").filter(Boolean).slice(-4);
    throw new ShipError(
      `${what} failed`,
      "command-failed",
      [shown.join("\n  "), options.logFile ? `Full log: ${options.logFile}` : undefined].filter(Boolean).join("\n  ") ||
        `\`${command.join(" ")}\` exited with code ${result.code}.`,
      { command: command.join(" "), errors },
    );
  }
  return result;
}

/** The lines worth showing from a noisy xcodebuild log. */
export function errorLines(output: string): string[] {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /error:|BUILD FAILED|ARCHIVE FAILED|EXPORT FAILED|\*\* .* FAILED \*\*/.test(line));
  return [...new Set(lines)];
}
