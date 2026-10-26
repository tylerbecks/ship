// ship certificates: the team's signing certificates, which of them this Mac
// can sign with, making one from a signing request, and revoking one.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Certificate, createCertificate, listCertificates, revokeCertificate } from "../asc/signing";
import { type Command, type Context, boolFlag, checkActionFlags, stringFlag } from "../command";
import { CERTIFICATE_KINDS, certificateKind, importCertificate, signingIdentities } from "../signing";
import { ShipError, table, ui } from "../ui";

export const certificatesHelp = `ship certificates [list] [--type <kind>]
ship certificates create --type <kind> --csr <file> [--dry-run]
ship certificates revoke <serial> [--dry-run]

The team's signing certificates: what each is for, when it expires, and
whether this Mac can sign with it (its private key is in the Keychain).

create makes a certificate from a signing request, so the private key
never leaves the Keychain: in Keychain Access, choose Certificate Assistant
→ Request a Certificate From a Certificate Authority, save it to disk, and
pass that file. ship adds the certificate to the login Keychain, where it
pairs with the key.

revoke stops a certificate for good: nothing can be signed with it again,
and profiles that hold it stop working (\`ship profiles create\` makes new
ones). Apps already on the App Store aren't affected.

  --type <kind>    distribution, development, developer-id, or mac-installer
  --csr <file>     create: the signing request (a .certSigningRequest file)
  --dry-run        create, revoke: show what would happen`;

const ACTIONS = ["list", "create", "revoke"];

const ACTION_FLAGS: Record<string, string[]> = {
  list: ["type"],
  create: ["type", "csr", "dry-run"],
  revoke: ["dry-run"],
};

const usage = (message: string, hint: string, details?: Record<string, unknown>) => new ShipError(message, "usage", hint, details, 2);

/** --type as Apple's CertificateType. */
export function parseCertificateKind(value: string): string {
  const type = CERTIFICATE_KINDS[value.trim().toLowerCase()];
  if (!type) throw usage(`--type takes ${Object.keys(CERTIFICATE_KINDS).join(", ")}, not "${value}"`, "distribution signs App Store and TestFlight builds; development, builds you run from Xcode.", { choices: Object.keys(CERTIFICATE_KINDS) });
  return type;
}

/** Days until an expiry date, rounded down. */
export const daysUntil = (date: string | null, now = Date.now()) => (date ? Math.floor((Date.parse(date) - now) / 86_400_000) : null);

/** The certificate named by serial number or id. */
export function findCertificate(certificates: Certificate[], query: string): Certificate {
  const q = query.trim().toLowerCase();
  const found = certificates.find((c) => c.serialNumber.toLowerCase() === q || c.id.toLowerCase() === q);
  if (!found) throw new ShipError(`No certificate with serial ${query}`, "no-certificate", "`ship certificates` lists them with their serial numbers.", { choices: certificates.map((c) => c.serialNumber) });
  return found;
}

async function certificates(ctx: Context) {
  const action = ctx.args[0] ?? "list";
  if (!ACTIONS.includes(action)) throw usage(`Unknown certificates action "${action}"`, "ship certificates [list|create|revoke] (see `ship certificates --help`)", { choices: ACTIONS });
  checkActionFlags(ctx, "certificates", action, ACTION_FLAGS);
  const given = ctx.args.slice(1);
  if (given.length > (action === "revoke" ? 1 : 0)) throw usage(`ship certificates ${action} takes ${action === "revoke" ? "one serial number" : "no arguments"}`, "See `ship certificates --help`.");
  const dryRun = boolFlag(ctx, "dry-run");
  const type = stringFlag(ctx, "type");

  if (action === "list") {
    const [found, identities] = await Promise.all([listCertificates(type ? [parseCertificateKind(type)] : []), signingIdentities()]);
    const rows = found.map(({ content: _content, ...c }) => ({ ...c, onThisMac: Boolean(c.sha1 && identities.has(c.sha1)), expiresInDays: daysUntil(c.expirationDate) }));
    for (const c of rows) if (c.expiresInDays !== null && c.expiresInDays < 30) ui.warn(`${c.name} expires in ${Math.max(0, c.expiresInDays)} days: make a new one with \`ship certificates create\``);
    return ui.result({ certificates: rows }, () => {
      if (!rows.length) return console.log("The team has no certificates yet: ship certificates create --type distribution --csr <file>");
      console.log(table([["NAME", "KIND", "SERIAL", "EXPIRES", "ON THIS MAC"], ...rows.map((c) => [c.name, certificateKind(c.type), c.serialNumber, c.expirationDate?.slice(0, 10) ?? "", c.onThisMac ? "yes" : "no"])]));
    });
  }

  if (action === "create") {
    if (!type) throw usage("Which kind? Pass --type", "For example: ship certificates create --type distribution --csr CertificateSigningRequest.certSigningRequest");
    const certificateType = parseCertificateKind(type);
    const csrPath = stringFlag(ctx, "csr");
    if (!csrPath) throw usage("Pass the signing request with --csr <file>", "Make one in Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority (saved to disk). See `ship certificates --help`.");
    const file = Bun.file(resolve(csrPath));
    if (!(await file.exists())) throw usage(`No file at ${csrPath}`, `Check the path (it's relative to ${process.cwd()}).`);
    const csr = (await file.text()).trim();
    if (!csr.includes("BEGIN CERTIFICATE REQUEST")) throw usage(`${csrPath} isn't a signing request`, "It starts with -----BEGIN CERTIFICATE REQUEST-----; Keychain Access saves one as a .certSigningRequest file. A private key never goes here.");
    if (dryRun) return ui.result({ dryRun, certificateType }, () => console.log(`Would make a ${certificateKind(certificateType)} certificate from ${csrPath} and add it to the login Keychain.`));
    ui.step(`Making a ${certificateKind(certificateType)} certificate`);
    const made = await createCertificate(certificateType, csr);
    // The certificate is public; it's on disk only long enough for security to read it.
    const dir = mkdtempSync(join(tmpdir(), "ship-cert-"));
    try {
      const path = join(dir, `${made.serialNumber || made.id}.cer`);
      writeFileSync(path, Buffer.from(made.content ?? "", "base64"));
      await importCertificate(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const paired = Boolean(made.sha1 && (await signingIdentities()).has(made.sha1));
    ui.ok(`Made ${made.name}`);
    if (!paired) ui.warn("The certificate is in the Keychain, but this Mac doesn't have the private key for it: was the signing request made on another Mac?");
    const { content: _content, ...certificate } = made;
    return ui.result({ certificate: { ...certificate, onThisMac: paired }, dryRun }, () => console.log(paired ? "This Mac can sign with it now." : "Sign on the Mac that made the signing request, or make a new request here."));
  }

  // revoke
  if (!given.length) throw usage("Which certificate? ship certificates revoke <serial>", "`ship certificates` lists the serial numbers.");
  const certificate = findCertificate(await listCertificates(), given[0]!);
  if (!dryRun) {
    await revokeCertificate(certificate.id);
    ui.ok(`Revoked ${certificate.name}`);
  }
  const { content: _content, ...revoked } = certificate;
  ui.result({ revoked, dryRun }, () => {
    if (dryRun) console.log(`Would revoke ${certificate.name} (${certificate.serialNumber}). Profiles that hold it stop working.`);
  });
}

export const commands: Command[] = [
  {
    name: "certificates",
    index: [{ section: "other", label: "certificates", summary: "Signing certificates, and which this Mac can use" }],
    help: certificatesHelp,
    flags: { type: { type: "string" }, csr: { type: "string" }, "dry-run": { type: "boolean" } },
    run: certificates,
  },
];
