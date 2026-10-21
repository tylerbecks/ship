// ship secret: save secrets in the Keychain, and check that references
// resolve, without ever printing a secret.

import { type Command, stringFlag } from "../command";
import { loadSettings } from "../config";
import { writeGenericPassword } from "../keychain";
import { badKeychainRef, parseKeychainRef, readSecretFile, resolveSecret, sourceOf } from "../secrets";
import { ShipError, ui } from "../ui";

export const secretHelp = `ship secret set <keychain:service/account> (--stdin | --from-file <path> | --from-env <NAME>)
ship secret check <ref>

Saves and checks the secrets ship reads: the API key, and passwords in the
store folder like the App Review demo account. A reference can be:
  keychain:<service>/<account>   the macOS login Keychain
  op://<vault>/<item>/<field>    1Password, read with \`op read\`
  env:NAME                       an environment variable
  file:~/path                    a file

set writes keychain: references only; keep 1Password items in 1Password.
check resolves a reference and says whether it worked, without printing it.

  --stdin             Read the secret from a pipe: pbpaste | ship secret set …
  --from-file <path>  Read it from a file (the file can go afterwards)
  --from-env <NAME>   Read it from an environment variable`;

const INPUTS = ["--stdin", "--from-file", "--from-env"];

/** The secret to save, from exactly one of --stdin, --from-file, or --from-env. */
async function readInput(options: { stdin?: boolean; fromFile?: string; fromEnv?: string }, ref: string): Promise<string> {
  const given = [options.stdin, options.fromFile !== undefined, options.fromEnv !== undefined].filter(Boolean).length;
  if (given !== 1) {
    throw new ShipError(
      given ? "Pass only one of --stdin, --from-file, and --from-env" : "Where's the secret? Pass --stdin, --from-file, or --from-env",
      "usage",
      `For example: pbpaste | ship secret set ${ref} --stdin`,
      { choices: INPUTS },
      2,
    );
  }
  let value: string;
  if (options.stdin) {
    // Waiting on a terminal would be a prompt; ship never prompts.
    if (process.stdin.isTTY) {
      throw new ShipError("--stdin reads from a pipe, not the terminal", "usage", `For example: pbpaste | ship secret set ${ref} --stdin`, undefined, 2);
    }
    value = (await Bun.stdin.text()).replace(/\r?\n$/, "");
  } else if (options.fromFile !== undefined) {
    value = await readSecretFile(options.fromFile);
  } else {
    const name = options.fromEnv!;
    value = process.env[name] ?? "";
    if (!value) throw new ShipError(`The environment variable ${name} isn't set`, "missing-env", `Set it first, or use --stdin or --from-file.`);
  }
  if (!value) throw new ShipError("The secret is empty", "empty-secret", "Check what you piped in or pointed at.");
  return value;
}

export async function secretSet(ref: string | undefined, options: { stdin?: boolean; fromFile?: string; fromEnv?: string }) {
  if (!ref) {
    throw new ShipError("Which Keychain item? ship secret set keychain:<service>/<account> --stdin", "usage", "See `ship secret --help`.", undefined, 2);
  }
  if (!ref.startsWith("keychain:")) {
    throw new ShipError(
      `ship secret set writes Keychain items, not ${sourceOf(ref).name} references`,
      "usage",
      "Use a keychain:<service>/<account> reference. Keep 1Password items in 1Password; ship reads op:// references as they are.",
      undefined,
      2,
    );
  }
  const parsed = parseKeychainRef(ref);
  if (!parsed) throw badKeychainRef(ref);
  if (!parsed.account) {
    throw new ShipError(`${ref} needs an account`, "usage", `Write it as keychain:${parsed.service}/<account>, like keychain:ship/lift-demo-password.`, undefined, 2);
  }
  const value = await readInput(options, ref);
  if (!(await writeGenericPassword(parsed.service, parsed.account, value, `ship: ${parsed.account}`))) {
    throw new ShipError(`Couldn't save ${ref} to the Keychain`, "keychain-failed", "Is the login Keychain unlocked? Try again.");
  }
  ui.result({ ref, saved: true }, () => console.log(`Saved ${ref} in the login Keychain.`));
}

export async function secretCheck(ref: string | undefined) {
  if (!ref) throw new ShipError("Which reference? ship secret check <ref>", "usage", "For example: ship secret check keychain:ship/lift-demo-password", undefined, 2);
  const source = sourceOf(ref).name;
  try {
    const value = await resolveSecret(ref, { opAccount: (await loadSettings()).opAccount });
    const length = value?.length ?? 0;
    ui.result({ ref, source, resolved: Boolean(value), length }, () => {
      console.log(`✓ ${ref} resolves (${source}, ${length} character${length === 1 ? "" : "s"}).`);
      if (source === "literal") console.log("  That's a literal value, not a reference. Store secrets in the Keychain, 1Password, or the environment.");
    });
    if (!value) process.exitCode = 1;
  } catch (error) {
    if (!(error instanceof ShipError) || error.exitCode === 2) throw error;
    ui.result({ ref, source, resolved: false, length: 0, error: { code: error.code, message: error.message, hint: error.hint } }, () => {
      console.log(`✗ ${ref}: ${error.message}`);
      if (error.hint) console.log(`  ${error.hint}`);
    });
    process.exitCode = 1;
  }
}

export const commands: Command[] = [
  {
    name: "secret",
    index: [{ section: "setup", label: "secret set", summary: "Save a secret in the Keychain for ship to read" }],
    help: secretHelp,
    flags: { stdin: { type: "boolean" }, "from-file": { type: "string" }, "from-env": { type: "string" } },
    run: (ctx) => {
      const [action, ref] = ctx.args;
      if (action === "set") {
        return secretSet(ref, { stdin: ctx.flags.stdin === true, fromFile: stringFlag(ctx, "from-file"), fromEnv: stringFlag(ctx, "from-env") });
      }
      if (action === "check") return secretCheck(ref);
      throw new ShipError(
        action ? `Unknown secret action "${action}"` : "Pass set or check",
        "usage",
        "ship secret set keychain:<service>/<account> --stdin, or ship secret check <ref>",
        { choices: ["set", "check"] },
        2,
      );
    },
  },
];
