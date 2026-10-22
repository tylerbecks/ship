// Offline checks for store files, shared by every `validate`: lengths the
// way Apple counts them, URLs, emails, and passwords that must be references.

import { badKeychainRef, isSecretReference, ownSecretError, ownSecretReason, parseKeychainRef } from "../secrets";

/** Something wrong (error) or worth a look (warning) in a store file. */
export interface Problem {
  /** The file, relative to the store folder, like "en-US/keywords.txt". */
  file: string;
  /** The field inside a JSON file, like "review.contactEmail". */
  field?: string;
  message: string;
  severity: "error" | "warning";
}

/** Characters as App Store Connect counts them (code points, so an emoji is one). */
export const chars = (text: string) => [...text].length;

/** UTF-8 bytes (keywords are limited to 100 bytes). */
export const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** An http or https URL with a host. */
export function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.hostname) && !/\s/.test(text.trim());
  } catch {
    return false;
  }
}

/** A plausible email address: one @, no spaces, a dot in the domain. */
export const isEmail = (text: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());

/** A problem when a password is written out instead of pointing at a secret (keychain:, op://, env:, file:). */
export function passwordProblem(file: string, field: string, value: string | null | undefined): Problem | undefined {
  if (!value || isSecretReference(value)) return undefined;
  return {
    file,
    field,
    severity: "error",
    message: `${field} is a password in plain text. Save it with \`ship secret set keychain:ship/<name> --stdin\` and write "keychain:ship/<name>" here instead.`,
  };
}

/**
 * A problem when a password's reference can't be sent: a keychain: one that
 * doesn't parse (keychain:<service> alone would send whichever item comes
 * first), or one naming ship's own secrets, like the API key. The resolve
 * sites check again with the machine's settings.
 */
export function referenceProblem(file: string, field: string, value: string | null | undefined): Problem | undefined {
  if (!value) return undefined;
  if (value.startsWith("keychain:") && !parseKeychainRef(value)) {
    const bad = badKeychainRef(value);
    return { file, field, severity: "error", message: `${field}: ${bad.message}. ${bad.hint}` };
  }
  const reason = ownSecretReason(value);
  if (!reason) return undefined;
  const own = ownSecretError(value, reason, field);
  return { file, field, severity: "error", message: `${own.message}. ${own.hint}` };
}
