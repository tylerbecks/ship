import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { credentialSources, credentials, useCredentials } from "../src/credentials";
import { checkKeychainName, decodePassword, readGenericPassword, writeGenericPassword } from "../src/keychain";
import { expandHome, isSecretReference, normalizePrivateKey, parseKeychainRef, resolveSecret, sourceOf, tools } from "../src/secrets";
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
  test("parseKeychainRef reads a service and an optional account", () => {
    expect(parseKeychainRef("keychain:ship/lift-demo-password")).toEqual({ service: "ship", account: "lift-demo-password" });
    expect(parseKeychainRef("keychain:com.example.app")).toEqual({ service: "com.example.app", account: undefined });
    expect(parseKeychainRef("keychain:ship/a@b.c_d-e")).toEqual({ service: "ship", account: "a@b.c_d-e" });
    for (const bad of ["keychain:", "keychain:/x", "keychain:a/", "keychain:a b/c", "keychain:a/b/c", 'keychain:a"/b', "keychain:a;rm/b", "op://x"]) {
      expect(parseKeychainRef(bad)).toBeUndefined();
    }
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
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_test";
    try {
      expect(await resolveSecret("op://Private/ASC/key-id", { opAccount: "me" })).toBe("value");
      expect(calls[0]).toEqual({ args: ["read", "op://Private/ASC/key-id"], env: { OP_SERVICE_ACCOUNT_TOKEN: "ops_test" } });
      tools.op = async () => ({ code: 1, stdout: "", stderr: "[ERROR] not found" });
      const failed = await error(resolveSecret("op://Private/ASC/nope"));
      expect(failed.code).toBe("op-failed");
      expect(failed.hint).toContain("[ERROR] not found");
    } finally {
      tools.op = original;
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
    expect(await resolveSecret("keychain:ship")).toBe("hunter2");
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
  });
});

describe("credentials", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (name.startsWith("SHIP_ASC_")) delete process.env[name];
    Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([name]) => name.startsWith("SHIP_ASC_"))));
    useCredentials(undefined);
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
