// ship profiles: the app's provisioning profiles: listing, making one with
// the right certificates and devices, installing them for Xcode, and
// deleting one.

import { listDevices } from "../asc/devices";
import { type Profile, bundleIdProfiles, createProfile, deleteProfile, findBundleId, listCertificates } from "../asc/signing";
import { type Command, type Context, boolFlag, checkActionFlags, stringFlag } from "../command";
import { type Project, loadProject } from "../config";
import { PROFILE_KINDS, type ProfileKind, certificateTypesFor, deviceFits, installProfile, installedProfiles, needsDevices, profileType, signingIdentities, signingPaths } from "../signing";
import { ShipError, table, ui } from "../ui";

export const profilesHelp = `ship profiles [list]
ship profiles create [--type <kind>] [--name <name>] [--certificate <serial>] [--dry-run]
ship profiles install [<name>]
ship profiles delete <name> [--dry-run]

The provisioning profiles for this app's bundle id: what each is for,
whether it's still valid, and whether Xcode has it.

create makes one and installs it. A development profile holds every
current development certificate; the others hold one certificate, this
Mac's when it has one (or --certificate's). Development and ad hoc ones
hold every enabled device that runs the app's platform. install puts the app's valid profiles (or the one named)
where Xcode finds them. Xcode's automatic signing makes and installs
profiles itself; these are for manual signing, like a CI machine.

  --type <kind>   create: app-store (the default), development, ad-hoc, or
                  direct (a Mac app signed with Developer ID)
  --name <name>   create: what to call it (default: the app and the kind)
  --certificate <serial>  create: the certificate a distribution profile holds
  --dry-run       create, delete: show what would happen`;

const ACTIONS = ["list", "create", "install", "delete"];

const ACTION_FLAGS: Record<string, string[]> = {
  list: [],
  create: ["type", "name", "certificate", "dry-run"],
  install: [],
  delete: ["dry-run"],
};

const usage = (message: string, hint: string, details?: Record<string, unknown>) => new ShipError(message, "usage", hint, details, 2);

export function parseProfileKind(value: string | undefined): ProfileKind {
  const kind = (value ?? "app-store").trim().toLowerCase();
  if (!(PROFILE_KINDS as readonly string[]).includes(kind)) throw usage(`--type takes ${PROFILE_KINDS.join(", ")}, not "${value}"`, "app-store signs App Store and TestFlight builds.", { choices: PROFILE_KINDS });
  return kind as ProfileKind;
}

const kindOf = (type: string) => (type.endsWith("_STORE") ? "app-store" : type.endsWith("_DEVELOPMENT") ? "development" : type.endsWith("_ADHOC") ? "ad-hoc" : type.endsWith("_DIRECT") ? "direct" : type.toLowerCase());

/** The app's bundle id record, or an error saying how to make it. */
async function bundleIdOf(project: Project) {
  const found = await findBundleId(project.config.bundleId);
  if (!found) {
    throw new ShipError(`The developer account has no bundle id ${project.config.bundleId}`, "no-bundle-id-record", "Register it in the developer account (Certificates, Identifiers & Profiles → Identifiers), or build once in Xcode with automatic signing.", { bundleId: project.config.bundleId });
  }
  return found;
}

/** The profile called `name` (ignoring case) or with that id. */
export function findProfile(profiles: Profile[], name: string): Profile {
  const q = name.trim().toLowerCase();
  const found = profiles.find((p) => p.name.toLowerCase() === q || p.id.toLowerCase() === q || p.uuid.toLowerCase() === q);
  if (!found) throw new ShipError(`No profile "${name}" for this app`, "no-profile", "`ship profiles` lists them.", { choices: profiles.map((p) => p.name) });
  return found;
}

async function profiles(ctx: Context) {
  const action = ctx.args[0] ?? "list";
  if (!ACTIONS.includes(action)) throw usage(`Unknown profiles action "${action}"`, `ship profiles [${ACTIONS.join("|")}] (see \`ship profiles --help\`)`, { choices: ACTIONS });
  checkActionFlags(ctx, "profiles", action, ACTION_FLAGS);
  const given = ctx.args.slice(1);
  const takes = action === "delete" ? 1 : action === "install" ? 1 : 0;
  if (given.length > takes || (action === "delete" && !given.length)) throw usage(`ship profiles ${action} takes ${action === "delete" ? "one name" : action === "install" ? "at most one name" : "no arguments"}`, 'Quote a name with spaces: ship profiles delete "Lift App Store"');
  const dryRun = boolFlag(ctx, "dry-run");
  const kind = action === "create" ? parseProfileKind(stringFlag(ctx, "type")) : undefined;
  const project = await loadProject({ app: ctx.app });
  const bundle = await bundleIdOf(project);

  if (action === "list") {
    const found = await bundleIdProfiles(bundle.id);
    const installed = installedProfiles();
    const rows = found.map((p) => ({ ...p, installed: installed.has(p.uuid) }));
    return ui.result({ bundleId: bundle.identifier, profiles: rows }, () => {
      if (!rows.length) return console.log(`${bundle.identifier} has no profiles yet: ship profiles create`);
      console.log(table([["NAME", "KIND", "STATE", "EXPIRES", "INSTALLED", "MADE BY"], ...rows.map((p) => [p.name, kindOf(p.type), p.state.toLowerCase(), p.expirationDate?.slice(0, 10) ?? "", p.installed ? "yes" : "no", p.xcodeManaged ? "Xcode" : ""])]));
    });
  }

  if (action === "create") {
    const type = profileType(project.platform, kind!);
    const name = stringFlag(ctx, "name")?.trim() || `${project.config.name} ${kind} (ship)`;
    // Apple refuses a second profile with a name: say so before asking it.
    if ((await bundleIdProfiles(bundle.id)).some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new ShipError(`${bundle.identifier} already has a profile called "${name}"`, "profile-exists", `Pass another --name, or delete it first: ship profiles delete "${name}"`, { name });
    }
    const now = new Date().toISOString();
    const current = (await listCertificates(certificateTypesFor(project.platform, kind!))).filter((c) => !c.expirationDate || c.expirationDate > now);
    const wanted = stringFlag(ctx, "certificate");
    if (wanted && kind === "development") throw usage("A development profile holds every development certificate", "Drop --certificate, or pick a distribution kind: --type app-store.");
    if (!current.length) {
      throw new ShipError(`The team has no current certificate a ${kind} profile can hold`, "no-certificate", `Make one: ship certificates create --type ${kind === "development" ? "development" : kind === "direct" ? "developer-id" : "distribution"} --csr <file>`);
    }
    let certificates = current;
    if (kind !== "development") {
      // A distribution profile holds one certificate: the named one, else one this Mac can sign with, else the newest.
      const identities = await signingIdentities();
      const named = wanted ? current.find((c) => c.serialNumber.toLowerCase() === wanted.trim().toLowerCase()) : undefined;
      if (wanted && !named) throw new ShipError(`No current ${kind} certificate has serial ${wanted}`, "no-certificate", "`ship certificates` lists them.", { choices: current.map((c) => c.serialNumber) });
      certificates = [named ?? current.find((c) => c.sha1 && identities.has(c.sha1)) ?? current[0]!];
    }
    const devices = needsDevices(kind!) ? (await listDevices({ platform: project.platform === "macos" ? "MAC_OS" : "IOS" })).filter((d) => d.status === "ENABLED" && deviceFits(project.platform, d.deviceClass)) : [];
    if (needsDevices(kind!) && !devices.length) throw new ShipError(`A ${kind} profile needs a device, and none is registered`, "no-device", "Register one: ship devices add <udid> --name <name>");
    const plan = { name, type, bundleId: bundle.identifier, certificates: certificates.map((c) => c.name), devices: devices.length };
    if (dryRun) return ui.result({ dryRun, profile: plan }, () => console.log(`Would make "${name}" (${type}) with ${certificates.length} certificate${certificates.length === 1 ? "" : "s"}${devices.length ? ` and ${devices.length} device${devices.length === 1 ? "" : "s"}` : ""}, and install it.`));
    ui.step(`Making ${name}`);
    const made = await createProfile({ name, type, bundleId: bundle.id, certificates: certificates.map((c) => c.id), devices: devices.map((d) => d.id) });
    const path = made.content ? await installProfile(made.uuid, made.content) : null;
    ui.ok(path ? `Made and installed ${name}` : `Made ${name}`);
    const { content: _content, ...profile } = made;
    return ui.result({ dryRun, profile: { ...profile, installed: Boolean(path) }, path }, () => console.log(path ? `Xcode finds it in ${signingPaths.profiles}.` : "Install it with: ship profiles install"));
  }

  if (action === "install") {
    const all = await bundleIdProfiles(bundle.id, { withContent: true });
    const wanted = given.length ? [findProfile(all, given[0]!)] : all.filter((p) => p.state === "ACTIVE");
    if (given.length && !wanted[0]!.content) throw new ShipError(`App Store Connect didn't send ${wanted[0]!.name}'s profile file`, "no-profile", "Download it in the developer account, then double-click it.", { profile: wanted[0]!.name });
    if (!wanted.length) throw new ShipError(`${bundle.identifier} has no valid profiles to install`, "no-profile", "Make one: ship profiles create");
    const installed: { name: string; path: string }[] = [];
    for (const profile of wanted) {
      if (profile.state !== "ACTIVE") ui.warn(`${profile.name} is ${profile.state.toLowerCase()}; Xcode won't sign with it`);
      if (!profile.content) continue;
      installed.push({ name: profile.name, path: await installProfile(profile.uuid, profile.content) });
    }
    return ui.result({ installed }, () => {
      for (const p of installed) console.log(`Installed ${p.name}`);
      console.log(`Xcode finds them in ${signingPaths.profiles}.`);
    });
  }

  // delete
  const profile = findProfile(await bundleIdProfiles(bundle.id), given[0]!);
  if (profile.xcodeManaged) {
    throw new ShipError(`${profile.name} is one Xcode's automatic signing manages`, "xcode-managed", "Xcode makes it again as it needs it; to stop that, turn off automatic signing for the target. Delete profiles ship or you made.", { profile: profile.name });
  }
  if (!dryRun) {
    await deleteProfile(profile.id);
    ui.ok(`Deleted ${profile.name}`);
  }
  ui.result({ deleted: profile, dryRun }, () => {
    if (dryRun) console.log(`Would delete ${profile.name}.`);
  });
}

export const commands: Command[] = [
  {
    name: "profiles",
    index: [{ section: "other", label: "profiles", summary: "Provisioning profiles: make, install, delete" }],
    help: profilesHelp,
    flags: { type: { type: "string" }, name: { type: "string" }, certificate: { type: "string" }, "dry-run": { type: "boolean" } },
    run: profiles,
  },
];
