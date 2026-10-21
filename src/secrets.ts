// Where secrets come from. A value in ship's settings (or a password in the
// store folder) is either the secret itself or a reference to where it
// lives. Each kind of reference is a source in the table below; the first
// that matches resolves it, and a plain value is a literal.
//
//   keychain:<service>/<account>   the macOS login Keychain
//   op://<vault>/<item>/<field>    1Password, with `op read`
//   env:NAME                       an environment variable
//   file:~/path                    a file

import { homedir } from "node:os";
import { settingsPath } from "./config";
import { NOT_FOUND, run } from "./exec";
import { KEYCHAIN_NAME, readGenericPassword, readServiceAccountToken } from "./keychain";
import { ShipError } from "./ui";

export interface SecretContext {
  /** The 1Password account for `op read`, when you have more than one. */
  opAccount?: string;
}

export interface SecretSource {
  /** "1Password", "Keychain", "environment", "file", "literal". */
  name: string;
  /** Whether a value uses this source. */
  matches(value: string): boolean;
  resolve(value: string, context: SecretContext): Promise<string>;
}

/** How ship runs the 1Password CLI. Tests replace it so `op` never runs. */
export const tools = {
  op: (args: string[], env: Record<string, string | undefined> = {}) => run(["op", ...args], { env }),
};

// MARK: 1Password

/** The service account token for `op`: OP_SERVICE_ACCOUNT_TOKEN, else the one `ship auth service-account` saved. */
export async function serviceAccountToken(): Promise<string | undefined> {
  return process.env.OP_SERVICE_ACCOUNT_TOKEN || (await readServiceAccountToken());
}

const onePassword: SecretSource = {
  name: "1Password",
  matches: (value) => value.startsWith("op://"),
  async resolve(value, { opAccount }) {
    // A service account token (from the environment, or the one `ship auth
    // service-account` saved) reads without Touch ID and picks its own account.
    const token = await serviceAccountToken();
    const account = opAccount && !token ? ["--account", opAccount] : [];
    const result = await tools.op(["read", ...account, value], token ? { OP_SERVICE_ACCOUNT_TOKEN: token } : {});
    if (result.code === NOT_FOUND) {
      throw new ShipError(
        `Couldn't read ${value}: the 1Password CLI isn't installed`,
        "op-missing",
        "Install it (brew install 1password-cli) and turn on its desktop app integration, or keep the secret in the Keychain instead (see `ship secret --help`).",
      );
    }
    if (result.code !== 0) {
      throw new ShipError(
        `Couldn't read ${value} from 1Password`,
        "op-failed",
        [
          result.stderr.trim(),
          token
            ? "ship reads 1Password with a service account: check it can see this vault, or save a new token with `ship auth service-account <op://ref>` (or `ship auth service-account remove`)."
            : "Is the 1Password CLI signed in?",
          `Check the reference in ${settingsPath}.`,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
    return result.stdout.trim();
  },
};

// MARK: Keychain

/** keychain:<service> or keychain:<service>/<account>, or undefined when the value isn't a valid one. */
export function parseKeychainRef(value: string): { service: string; account?: string } | undefined {
  if (!value.startsWith("keychain:")) return undefined;
  const rest = value.slice("keychain:".length);
  const slash = rest.indexOf("/");
  const service = slash < 0 ? rest : rest.slice(0, slash);
  const account = slash < 0 ? undefined : rest.slice(slash + 1);
  if (!KEYCHAIN_NAME.test(service)) return undefined;
  if (account !== undefined && !KEYCHAIN_NAME.test(account)) return undefined;
  return { service, account };
}

/** A usage error for a keychain: reference that doesn't parse. */
export function badKeychainRef(value: string): ShipError {
  return new ShipError(
    `"${value}" isn't a Keychain reference`,
    "usage",
    "Write it as keychain:<service>/<account> (letters, digits, and . _ @ - only), like keychain:ship/lift-demo-password.",
    undefined,
    2,
  );
}

const keychainSource: SecretSource = {
  name: "Keychain",
  matches: (value) => value.startsWith("keychain:"),
  async resolve(value) {
    const ref = parseKeychainRef(value);
    if (!ref) throw badKeychainRef(value);
    const secret = await readGenericPassword(ref.service, ref.account);
    if (secret === undefined) {
      throw new ShipError(
        `No Keychain item for ${value}`,
        "keychain-missing",
        `Save it with \`ship secret set ${ref.account ? value : `${value}/<account>`} --stdin\` (or --from-file <path>), or check the name in Keychain Access.`,
      );
    }
    return secret;
  },
};

// MARK: Environment, files, literals

const envSource: SecretSource = {
  name: "environment",
  matches: (value) => value.startsWith("env:"),
  async resolve(value) {
    const name = value.slice("env:".length);
    const secret = process.env[name];
    if (!secret) {
      throw new ShipError(`The environment variable ${name || "(none)"} isn't set`, "missing-env", `Set ${name || "it"} before running ship, or point at another source (see \`ship secret --help\`).`);
    }
    return secret;
  },
};

/** A path with a leading ~ meaning the home folder. */
export const expandHome = (path: string) => path.replace(/^~(?=$|\/)/, homedir());

/** A file's text, trimmed. A ShipError with a hint when it's missing. */
export async function readSecretFile(path: string): Promise<string> {
  const file = Bun.file(expandHome(path));
  if (!(await file.exists())) {
    throw new ShipError(`No file at ${path}`, "missing-key-file", "Check the path, or point at another source (see `ship secret --help`).");
  }
  return (await file.text()).trim();
}

const fileSource: SecretSource = {
  name: "file",
  matches: (value) => value.startsWith("file:"),
  resolve: (value) => readSecretFile(value.slice("file:".length)),
};

const literal: SecretSource = {
  name: "literal",
  matches: () => true,
  resolve: async (value) => value,
};

// MARK: Resolving

/** Every source, tried in order; literal matches anything, so it's last. */
export const sources: SecretSource[] = [onePassword, keychainSource, envSource, fileSource, literal];

/** The source a value uses. */
export function sourceOf(value: string): SecretSource {
  return sources.find((source) => source.matches(value)) ?? literal;
}

/** A reference rather than an inline secret: op://, keychain:, env:, or file:. Store files require this for passwords. */
export function isSecretReference(value: string): boolean {
  return sourceOf(value) !== literal;
}

/** The secret a value names (or the value itself, when it's literal). undefined stays undefined. */
export async function resolveSecret(value: string | undefined, context: SecretContext = {}): Promise<string | undefined> {
  if (!value) return undefined;
  return sourceOf(value).resolve(value, context);
}

/** A private key as PEM: CI secret stores often turn its newlines into literal "\n". */
export function normalizePrivateKey(pem: string): string {
  const trimmed = pem.trim();
  return trimmed.includes("\n") || !trimmed.includes("\\n") ? trimmed : trimmed.replace(/(?:\\r)?\\n/g, "\n").trim();
}
