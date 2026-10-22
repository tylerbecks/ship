import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { saveSettings, shipHome } from "../src/config";
import { credentialSources, credentials, useCredentials } from "../src/credentials";
import { checkKeychainName, decodePassword, readGenericPassword, writeGenericPassword } from "../src/keychain";
import {
  expandHome,
  isSecretReference,
  normalizePrivateKey,
  opFailed,
  ownSecretReason,
  parseKeychainRef,
  resolveSecret,
  resolveStorePassword,
  runOp,
  sourceOf,
  tools,
} from "../src/secrets";
import { fakeKeychain, generateKey, temp } from "./helpers";

const error = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (e) {
    return e as { code?: string; hint?: string; exitCode?: number; message: string };
  }
  throw new Error("expected an error");
};

describe("references", () => {
  test("parseKeychainRef reads a service and an account, which it requires", () => {
    expect(parseKeychainRef("keychain:ship/lift-demo-password")).toEqual({ service: "ship", account: "lift-demo-password" });
    expect(parseKeychainRef("keychain:ship/a@b.c_d-e")).toEqual({ service: "ship", account: "a@b.c_d-e" });
    // A service alone would match whichever item comes first, like ship's own copy of the API key.
    expect(parseKeychainRef("keychain:ship")).toBeUndefined();
    expect(parseKeychainRef("keychain:com.example.app")).toBeUndefined();
    for (const bad of ["keychain:", "keychain:/x", "keychain:a/", "keychain:a b/c", "keychain:a/b/c", 'keychain:a"/b', "keychain:a;rm/b", "op://x"]) {
      expect(parseKeychainRef(bad)).toBeUndefined();
    }
  });

  test("a store password can't name ship's own secrets", async () => {
    const settings = { credentials: { keyId: "op://Dev/ASC/key id", privateKey: "op://Dev/ASC/private key" } };
    for (const own of [
      "keychain:ship/asc-private-key-ABC123",
      "keychain:ship/app-store-connect-api-key",
      "keychain:ship/op-service-account-token",
      "env:SHIP_ASC_PRIVATE_KEY",
      "env:SHIP_ASC_KEY_ID",
      "env:OP_SERVICE_ACCOUNT_TOKEN",
      "file:~/Downloads/AuthKey_ABC123.P8",
      `file:${join(shipHome, "config.json")}`,
      "op://Dev/ASC/private key",
      // Another field of the key's item.
      "op://Dev/ASC/password",
    ]) {
      expect(ownSecretReason(own, settings)).toBeString();
    }
    for (const fine of ["keychain:ship/lift-demo-password", "keychain:other/app-store-connect-api-key", "env:DEMO_PASSWORD", "file:~/demo.txt", "op://Dev/Lift/password"]) {
      expect(ownSecretReason(fine, settings)).toBeUndefined();
    }
    // Refused before anything is read (the Keychain and op throw in tests).
    await saveSettings({ credentials: { privateKey: "op://Dev/ASC/private key" } });
    try {
      for (const own of ["keychain:ship/app-store-connect-api-key", "op://Dev/ASC/private key"]) {
        expect(await error(resolveStorePassword(own))).toMatchObject({ code: "own-secret", hint: expect.stringContaining("ship secret set keychain:ship/<app>-demo-password --stdin") });
      }
    } finally {
      await saveSettings({});
    }
  });

  test("a link with an innocent name can't stand for the key file or ship's settings", async () => {
    await saveSettings({});
    const dir = temp();
    const key = join(dir, "AuthKey_ABC123.p8");
    const pem = "-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----\n";
    writeFileSync(key, pem);
    symlinkSync(key, join(dir, "demo.txt"));
    symlinkSync(join(shipHome, "config.json"), join(dir, "notes.txt"));
    const keyCopy = join(dir, "key-copy");
    writeFileSync(keyCopy, pem);
    symlinkSync(keyCopy, join(dir, "copy-link.txt"));
    expect(ownSecretReason(`file:${join(dir, "demo.txt")}`)).toBe("it's an App Store Connect API key file");
    expect(ownSecretReason(`file:${join(dir, "notes.txt")}`)).toBe("it's in ship's settings folder");
    // A key file configured under another name, reached through a link.
    expect(ownSecretReason(`file:${join(dir, "copy-link.txt")}`, { credentials: { privateKey: `file:${keyCopy}` } })).toBe("it's an App Store Connect API key file");
    // And whatever the path, a private key is never sent as a password.
    writeFileSync(join(dir, "plain.txt"), pem);
    expect(await error(resolveStorePassword(`file:${join(dir, "plain.txt")}`))).toMatchObject({ code: "own-secret", message: expect.stringContaining("it holds a private key") });
    writeFileSync(join(dir, "demo-password.txt"), "hunter2\n");
    expect(await resolveStorePassword(`file:${join(dir, "demo-password.txt")}`)).toBe("hunter2");
  });

  test("sourceOf and isSecretReference tell references from literals", () => {
    expect(sourceOf("op://Private/ASC/key").name).toBe("1Password");
    expect(sourceOf("keychain:ship/x").name).toBe("Keychain");
    expect(sourceOf("env:SHIP_X").name).toBe("environment");
    expect(sourceOf("file:~/x.p8").name).toBe("file");
    expect(sourceOf("hunter2").name).toBe("literal");
    expect(isSecretReference("keychain:ship/x")).toBe(true);
    expect(isSecretReference("env:X")).toBe(true);
    expect(isSecretReference("hunter2")).toBe(false);
    expect(isSecretReference("OP://upper")).toBe(false);
  });

  test("Keychain names that could break `security -i` are usage errors", () => {
    expect(() => checkKeychainName('a" -X 00', "service")).toThrow();
    expect(() => checkKeychainName("ship", "service")).not.toThrow();
  });
});

describe("resolving", () => {
  afterEach(() => {
    delete process.env.SHIP_TEST_SECRET;
  });

  test("literal, env:, and file: values", async () => {
    expect(await resolveSecret(undefined)).toBeUndefined();
    expect(await resolveSecret("plain")).toBe("plain");
    process.env.SHIP_TEST_SECRET = "from env";
    expect(await resolveSecret("env:SHIP_TEST_SECRET")).toBe("from env");
    const file = join(temp(), "key.p8");
    writeFileSync(file, "  secret\n\n");
    expect(await resolveSecret(`file:${file}`)).toBe("secret");
  });

  test("a missing variable or file is an error with a hint", async () => {
    expect(await error(resolveSecret("env:SHIP_TEST_SECRET"))).toMatchObject({ code: "missing-env" });
    const missing = await error(resolveSecret("file:/nope/AuthKey.p8"));
    expect(missing.code).toBe("missing-key-file");
    expect(missing.hint).toBeTruthy();
  });

  test("~ means the home folder", () => {
    expect(expandHome("~/x.p8")).toBe(join(homedir(), "x.p8"));
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("/a/~/b")).toBe("/a/~/b");
  });

  test("op:// asks `op read`, with --account only without a service account", async () => {
    const original = tools.op;
    const calls: { args: string[]; env: Record<string, string | undefined> }[] = [];
    tools.op = async (args, env = {}) => {
      calls.push({ args, env });
      return { code: 0, stdout: "value\n", stderr: "" };
    };
    // No token anywhere: `op` runs as you, in the account you named.
    const keychain = fakeKeychain();
    try {
      expect(await resolveSecret("op://Private/ASC/key-id", { opAccount: "me" })).toBe("value");
      expect(calls[0]!.args).toEqual(["read", "--account", "me", "op://Private/ASC/key-id"]);
      expect(calls[0]!.env.OP_SERVICE_ACCOUNT_TOKEN).toBeUndefined();

      process.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_test";
      expect(await resolveSecret("op://Private/ASC/key-id", { opAccount: "me" })).toBe("value");
      expect(calls[1]).toEqual({ args: ["read", "op://Private/ASC/key-id"], env: { OP_SERVICE_ACCOUNT_TOKEN: "ops_test" } });

      tools.op = async () => ({ code: 1, stdout: "", stderr: "[ERROR] not found" });
      const failed = await error(resolveSecret("op://Private/ASC/nope"));
      expect(failed.code).toBe("op-failed");
      expect(failed.hint).toContain("[ERROR] not found");

      tools.op = async () => ({ code: 127, stdout: "", stderr: "op: command not found" });
      const missing = await error(resolveSecret("op://Private/ASC/key-id"));
      expect(missing.code).toBe("op-missing");
      expect(missing.hint).toContain("brew install 1password-cli");

      // Failing with nothing on stderr still says what to do.
      tools.op = async () => ({ code: 1, stdout: "", stderr: "" });
      const quiet = await error(runOp(["read", "x"], { what: "read x" }).then((result) => {
        throw opFailed("Couldn't read x", result, "Is the 1Password CLI signed in?");
      }));
      expect(quiet.hint).toBe("Is the 1Password CLI signed in?");
    } finally {
      tools.op = original;
      keychain.restore();
      delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    }
  });

  test("normalizes a private key whose newlines became \\n", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nABC\nDEF\n-----END PRIVATE KEY-----";
    expect(normalizePrivateKey(pem.replaceAll("\n", "\\n"))).toBe(pem);
    expect(normalizePrivateKey(`${pem}\n`)).toBe(pem);
    expect(normalizePrivateKey(pem.replaceAll("\n", "\\r\\n"))).toBe(pem);
  });
});

describe("the Keychain", () => {
  let keychain: ReturnType<typeof fakeKeychain>;
  beforeEach(() => {
    keychain = fakeKeychain({ "ship/demo": "hunter2" });
  });
  afterEach(() => keychain.restore());

  test("keychain: references read the item, and say how to save a missing one", async () => {
    expect(await resolveSecret("keychain:ship/demo")).toBe("hunter2");
    // Without an account it's a usage error, never the first item under "ship".
    expect(await error(resolveSecret("keychain:ship"))).toMatchObject({ code: "usage", exitCode: 2, message: "keychain:ship needs an account" });
    const missing = await error(resolveSecret("keychain:ship/other"));
    expect(missing.code).toBe("keychain-missing");
    expect(missing.hint).toContain("ship secret set keychain:ship/other --stdin");
    expect((await error(resolveSecret("keychain:bad name/x"))).exitCode).toBe(2);
  });

  test("a multi-line value survives the round trip", async () => {
    const { pem } = await generateKey();
    expect(await writeGenericPassword("ship", "asc-private-key-ABC", pem, 'label "with" quotes')).toBe(true);
    expect(await readGenericPassword("ship", "asc-private-key-ABC")).toBe(pem);
  });

  test("decodePassword decodes only what `security` printed as hex", () => {
    expect(decodePassword("hunter2\n")).toBe("hunter2");
    expect(decodePassword(`${Buffer.from("a\nb").toString("hex")}\n`)).toBe("a\nb");
    // All hex digits, but printable when decoded, so `security` would have printed it as is.
    expect(decodePassword("41424344")).toBe("41424344");
    expect(decodePassword("deadbeef")).toBe("deadbeef");
    // All digits that decode to text with a tab: still the password itself.
    expect(decodePassword("2009\n")).toBe("2009");
    expect(decodePassword("4509\n")).toBe("4509");
    // A UTF-8 password and a key come back decoded.
    expect(decodePassword(`${Buffer.from("pässword").toString("hex")}\n`)).toBe("pässword");
    const pem = "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----";
    expect(decodePassword(`${Buffer.from(pem).toString("hex")}\n`)).toBe(pem);
  });
});

describe("credentials", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (name.startsWith("SHIP_ASC_")) delete process.env[name];
    Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([name]) => name.startsWith("SHIP_ASC_"))));
    useCredentials(undefined);
  });

  test("requests that start together read 1Password once", async () => {
    const original = tools.op;
    const reads: string[] = [];
    tools.op = async (args) => {
      reads.push(args.at(-1)!);
      await Bun.sleep(5);
      return { code: 0, stdout: args.at(-1)!.endsWith("key") ? pem : "id\n", stderr: "" };
    };
    const { pem } = await generateKey();
    const keychain = fakeKeychain();
    await saveSettings({ credentials: { keyId: "op://V/ASC/id", issuerId: "op://V/ASC/issuer", privateKey: "op://V/ASC/key" }, cacheDays: 0 });
    useCredentials(undefined);
    try {
      const all = await Promise.all([credentials(), credentials(), credentials()]);
      expect(reads).toEqual(["op://V/ASC/id", "op://V/ASC/issuer", "op://V/ASC/key"]);
      expect(all[0]).toBe(all[2]);
      // A failed read isn't kept: the next call tries again.
      useCredentials(undefined);
      tools.op = async () => ({ code: 1, stdout: "", stderr: "locked" });
      expect(await error(credentials())).toMatchObject({ code: "op-failed" });
      tools.op = async () => ({ code: 0, stdout: "again\n", stderr: "" });
      expect((await credentials()).keyId).toBe("again");
    } finally {
      tools.op = original;
      keychain.restore();
      await saveSettings({});
    }
  });

  test("CI variables work with a key whose newlines are \\n", async () => {
    const { pem } = await generateKey();
    process.env.SHIP_ASC_KEY_ID = "KEY";
    process.env.SHIP_ASC_ISSUER_ID = "ISSUER";
    process.env.SHIP_ASC_PRIVATE_KEY = pem.replaceAll("\n", "\\n");
    useCredentials(undefined);
    expect(await credentials()).toEqual({ keyId: "KEY", issuerId: "ISSUER", privateKey: pem });
    expect(await credentialSources()).toEqual({ keyId: "environment", issuerId: "environment", privateKey: "environment" });
  });
});
