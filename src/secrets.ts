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
import { basename, relative, resolve } from "node:path";
import { type Settings, loadSettings, settingsPath, shipHome } from "./config";
import { NOT_FOUND, type RunResult, run } from "./exec";
import { KEYCHAIN_NAME, isShipItem, readGenericPassword, readServiceAccountToken } from "./keychain";
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

/**
 * Runs `op` the one way ship does. With a service account token, `op` uses
 * it (no Touch ID) and the token picks its own account; without one, it runs
 * as you, with --account when you have more than one. A missing `op` is an
 * op-missing error; `what` ("read op://…") says what ship was doing.
 */
export async function runOp(args: string[], options: { what: string; token?: string; account?: string }): Promise<RunResult> {
  const [command = "", ...rest] = args;
  const account = options.account && !options.token ? ["--account", options.account] : [];
  // No token means none at all, not one left in the environment.
  const result = await tools.op([command, ...account, ...rest], { OP_SERVICE_ACCOUNT_TOKEN: options.token || undefined });
  if (result.code === NOT_FOUND) {
    throw new ShipError(
      `Couldn't ${options.what}: the 1Password CLI isn't installed`,
      "op-missing",
      "Install it (brew install 1password-cli) and turn on its desktop app integration, or keep the secret in the Keychain instead (see `ship secret --help`).",
    );
  }
  return result;
}

/** An op-failed error with what `op` said, then `hint`. */
export const opFailed = (message: string, result: RunResult, hint: string) =>
  new ShipError(message, "op-failed", [result.stderr.trim(), hint].filter(Boolean).join(" "));

const onePassword: SecretSource = {
  name: "1Password",
  matches: (value) => value.startsWith("op://"),
  async resolve(value, { opAccount }) {
    // A service account token (from the environment, or the one `ship auth
    // service-account` saved) reads without Touch ID.
    const token = await serviceAccountToken();
    const result = await runOp(["read", value], { what: `read ${value}`, token, account: opAccount });
    if (result.code !== 0) {
      throw opFailed(
        `Couldn't read ${value} from 1Password`,
        result,
        `${
          token
            ? "ship reads 1Password with a service account: check it can see this vault, or save a new token with `ship auth service-account <op://ref>` (or `ship auth service-account remove`)."
            : "Is the 1Password CLI signed in?"
        } Check the reference in ${settingsPath}.`,
      );
    }
    return result.stdout.trim();
  },
};

// MARK: Keychain

/**
 * keychain:<service>/<account>, or undefined when the value isn't a valid
 * one. The account is required: a service alone matches whichever item comes
 * first, and under "ship" that could be ship's own copy of the API key or the
 * 1Password token.
 */
export function parseKeychainRef(value: string): { service: string; account: string } | undefined {
  if (!value.startsWith("keychain:")) return undefined;
  const rest = value.slice("keychain:".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return undefined;
  const service = rest.slice(0, slash);
  const account = rest.slice(slash + 1);
  if (!KEYCHAIN_NAME.test(service) || !KEYCHAIN_NAME.test(account)) return undefined;
  return { service, account };
}

/** A usage error for a keychain: reference that doesn't parse. */
export function badKeychainRef(value: string): ShipError {
  const service = value.slice("keychain:".length);
  const noAccount = KEYCHAIN_NAME.test(service);
  return new ShipError(
    noAccount ? `${value} needs an account` : `"${value}" isn't a Keychain reference`,
    "usage",
    noAccount
      ? `Write it as keychain:${service}/<account>, like keychain:ship/lift-demo-password.`
      : "Write it as keychain:<service>/<account> (letters, digits, and . _ @ - only), like keychain:ship/lift-demo-password.",
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
        `Save it with \`ship secret set ${value} --stdin\` (or --from-file <path>), or check the name in Keychain Access.`,
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

// MARK: Store-folder passwords

/** An op:// reference's vault and item, so another field of the same item counts as the same secret. */
const opItem = (value: string) => value.split("/").slice(2, 4).join("/").toLowerCase();

const inside = (dir: string, path: string) => {
  const rel = relative(resolve(dir), path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
};

/**
 * Why a store-folder password reference names one of ship's own secrets, or
 * undefined when it doesn't: ship's Keychain items (the API key, its cached
 * copy, the 1Password token), the environment variables and files CI keeps
 * them in, an API key file (.p8), anything in ship's settings folder, and
 * the references in `settings`. Push sends the password to App Store
 * Connect, where anyone with App Review access can read it, so whoever can
 * commit to the repo could otherwise read the API key that way.
 */
export function ownSecretReason(value: string, settings: Settings = {}): string | undefined {
  const credentials = Object.values(settings.credentials ?? {}).filter((ref): ref is string => typeof ref === "string" && Boolean(ref));
  if (credentials.includes(value)) return "it's one of ship's App Store Connect credentials";
  if (value.startsWith("op://") && credentials.some((ref) => ref.startsWith("op://") && opItem(ref) === opItem(value))) {
    return "it's the 1Password item ship reads the API key from";
  }
  const keychain = parseKeychainRef(value);
  if (keychain && isShipItem(keychain.service, keychain.account)) return "it's ship's own Keychain item for the API key or the 1Password token";
  if (value.startsWith("env:")) {
    const name = value.slice("env:".length).toUpperCase();
    if (name.startsWith("SHIP_ASC_") || name === "OP_SERVICE_ACCOUNT_TOKEN") return `${name} holds ship's own credentials`;
  }
  if (value.startsWith("file:")) {
    const path = resolve(expandHome(value.slice("file:".length)));
    const keyPath = process.env.SHIP_ASC_PRIVATE_KEY_PATH;
    if (basename(path).toLowerCase().endsWith(".p8") || (keyPath && resolve(expandHome(keyPath)) === path)) return "it's an App Store Connect API key file";
    if (inside(shipHome, path)) return "it's in ship's settings folder";
  }
  return undefined;
}

/** The error for a store password that names one of ship's own secrets. */
export function ownSecretError(value: string, reason: string, field = "demoAccountPassword"): ShipError {
  return new ShipError(
    `${field} can't be ${value}: ${reason}, and push would send it to App Store Connect`,
    "own-secret",
    "Save the demo password under its own name with `ship secret set keychain:ship/<app>-demo-password --stdin`, and point at that instead.",
    { reference: value },
  );
}

/** A store folder's password: the secret its reference names, refusing ship's own secrets. Never logged. */
export async function resolveStorePassword(value: string): Promise<string> {
  const settings = await loadSettings();
  const reason = ownSecretReason(value, settings);
  if (reason) throw ownSecretError(value, reason);
  return (await resolveSecret(value, { opAccount: settings.opAccount })) ?? "";
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
