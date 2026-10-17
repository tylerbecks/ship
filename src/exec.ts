import { ShipError } from "./ui";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command without a shell and collects its output. */
export async function run(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; logFile?: string } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    // An undefined value removes the variable.
    env: Object.fromEntries(Object.entries({ ...process.env, ...options.env }).filter(([, value]) => value !== undefined)) as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
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
  if (result.code !== 0) {
    const what = options.what ?? command.slice(0, 2).join(" ");
    const errors = errorLines(result.stdout + "\n" + result.stderr);
    throw new ShipError(
      `${what} failed`,
      "command-failed",
      [errors.slice(0, 8).join("\n  "), options.logFile ? `Full log: ${options.logFile}` : undefined]
        .filter(Boolean)
        .join("\n  ") || undefined,
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
