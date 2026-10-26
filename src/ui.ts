// Output for people and for agents.
//
// People get short progress lines on stderr and a readable result. With
// `--json`, stdout carries exactly one JSON object (the result, or the
// error), and progress still goes to stderr, so scripts and Claude can parse
// stdout without filtering.

/**
 * Exit codes by kind of failure, so a script can tell "Apple said no" from
 * "it isn't there" without parsing the error. Everything else exits 1.
 */
export const EXIT = {
  failure: 1,
  usage: 2,
  /** The API key is missing, wrong, or not allowed to do this. */
  auth: 3,
  /** The app, build, version, or other thing isn't there. */
  notFound: 4,
  /** App Store Connect refused it in the state things are in (it exists, it's in use, it's in review). */
  conflict: 5,
  /** --read-only (or SHIP_READ_ONLY) stopped a change before it was sent. */
  readOnly: 6,
  /** A wait ran out of time while things were still in progress. */
  pending: 7,
} as const;

const EXIT_BY_CODE: Record<string, number> = {
  usage: EXIT.usage,
  ...Object.fromEntries(["api-401", "api-403", "no-credentials", "bad-key", "missing-key-file"].map((code) => [code, EXIT.auth])),
  ...Object.fromEntries(
    [
      "api-404",
      "unknown-app",
      "no-asc-app",
      "no-build",
      "no-feedback",
      "no-group",
      "no-version",
      "no-live-version",
      "no-localization",
      "no-media-set",
      "no-phased-release",
      "no-review",
      "no-reply",
      "no-user",
      "no-device",
      "no-sandbox-tester",
      "no-price-point",
      "no-purchase",
      "no-subscription",
      "no-certificate",
      "no-bundle-id-record",
      "no-profile",
    ].map((code) => [code, EXIT.notFound]),
  ),
  ...Object.fromEntries(
    ["api-409", "build-in-use", "group-exists", "user-exists", "device-exists", "account-holder", "purchase-type-fixed", "family-sharing-fixed", "manual-prices", "subscription-group-fixed", "xcode-managed", "submission-in-progress", "version-in-flight", "version-in-progress"].map((code) => [code, EXIT.conflict]),
  ),
  "read-only": EXIT.readOnly,
  ...Object.fromEntries(["processing-timeout", "still-pending"].map((code) => [code, EXIT.pending])),
};

/** The exit code for an error code: its kind's (see EXIT), else 1. */
export const exitCodeFor = (code: string): number => EXIT_BY_CODE[code] ?? EXIT.failure;

export class ShipError extends Error {
  constructor(
    message: string,
    /** A stable, machine-readable reason, like `no-config` or `ambiguous-scheme`. */
    readonly code: string,
    /** What to do about it, ideally a command to run. */
    readonly hint?: string,
    /** Extra data for `--json`, like the choices to pick from. */
    readonly details?: Record<string, unknown>,
    /** 2 for a usage mistake; otherwise the code's kind (see EXIT), else 1. */
    readonly exitCode = exitCodeFor(code),
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

  /** `text` as a clickable terminal link to `url` when people see it on a terminal; plain text otherwise. */
  link(text: string, url: string): string {
    return !this.json && process.stderr.isTTY ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text;
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
              exitCode: shipError.exitCode,
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
