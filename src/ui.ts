// Output for people and for agents.
//
// People get short progress lines on stderr and a readable result. With
// `--json`, stdout carries exactly one JSON object (the result, or the
// error), and progress still goes to stderr, so scripts and Claude can parse
// stdout without filtering.

export class ShipError extends Error {
  constructor(
    message: string,
    /** A stable, machine-readable reason, like `no-config` or `ambiguous-scheme`. */
    readonly code: string,
    /** What to do about it, ideally a command to run. */
    readonly hint?: string,
    /** Extra data for `--json`, like the choices to pick from. */
    readonly details?: Record<string, unknown>,
    /** 2 for a usage mistake, 1 for everything else. */
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export const ui = {
  json: false,
  quiet: false,

  /** A step that's starting, like "Archiving build 3". */
  step(message: string) {
    if (!this.quiet) console.error(`› ${message}`);
  },

  /** A step that finished. */
  ok(message: string) {
    if (!this.quiet) console.error(`✓ ${message}`);
  },

  warn(message: string) {
    console.error(`! ${message}`);
  },

  /** Supporting detail under a step. */
  note(message: string) {
    if (!this.quiet) console.error(`  ${message}`);
  },

  /** Prints the command's result: JSON on stdout, or the human version. */
  result(data: unknown, human?: () => void) {
    if (this.json) {
      console.log(JSON.stringify({ ok: true, ...(data as object) }, null, 2));
    } else if (human) {
      human();
    }
  },

  fail(error: unknown): never {
    const shipError =
      error instanceof ShipError
        ? error
        : new ShipError(
            error instanceof Error ? error.message : String(error),
            "unexpected",
            "That's a bug in ship. Run the command again with --json and report the error.",
          );
    if (this.json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: {
              code: shipError.code,
              message: shipError.message,
              hint: shipError.hint,
              ...shipError.details,
            },
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`✗ ${shipError.message}`);
      if (shipError.hint) console.error(`  ${shipError.hint}`);
    }
    process.exit(shipError.exitCode);
  },
};

/** Lines of a table, padded to the widest cell in each column. */
export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  "))
    .join("\n");
}
