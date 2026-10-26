// ship devices: the devices registered for development and ad hoc builds.

import { type Device, type DevicePlatform, listDevices, registerDevice, updateDevice } from "../asc/devices";
import { type Command, type Context, boolFlag, checkActionFlags, stringFlag } from "../command";
import { ShipError, table, ui } from "../ui";

export const devicesHelp = `ship devices [list] [--platform ios|macos]
ship devices add <udid> --name <name> [--platform ios|macos] [--dry-run]
ship devices rename <device> <new name> [--dry-run]
ship devices disable <device> [--dry-run]
ship devices enable <device> [--dry-run]

The devices registered for development and ad hoc builds. A device is its
UDID or its name. Apple counts every device added in the membership year
against the limit (100 of each kind), so a disabled one still counts until
the year renews; the API can't delete one.

Find an iPhone's UDID in Finder (click the serial number under its name) or
with \`xcrun devicectl list devices\`; a Mac's with
\`system_profiler SPHardwareDataType | grep UDID\` (Provisioning UDID).

  --name <name>      add: what to call it
  --platform <p>     ios (iPhone, iPad, Apple TV, Vision Pro, Watch; the default) or macos
  --dry-run          add, rename, disable, enable: show what would change`;

const ACTIONS = ["list", "add", "rename", "disable", "enable"];

const ACTION_FLAGS: Record<string, string[]> = {
  list: ["platform"],
  add: ["name", "platform", "dry-run"],
  rename: ["dry-run"],
  disable: ["dry-run"],
  enable: ["dry-run"],
};

const usage = (message: string, hint: string, details?: Record<string, unknown>) => new ShipError(message, "usage", hint, details, 2);

/** --platform as Apple's BundleIdPlatform. */
export function parseDevicePlatform(value: string | undefined): DevicePlatform | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["ios", "ipados", "tvos", "visionos", "watchos"].includes(normalized)) return "IOS";
  if (normalized === "macos") return "MAC_OS";
  throw usage(`--platform takes ios or macos, not "${value}"`, "Every iPhone, iPad, Apple TV, Vision Pro, and Watch is ios.", { choices: ["ios", "macos"] });
}

/** A UDID as Apple takes it: 40 hex digits, or the 8-and-16 form newer iPhones and Macs use (or a Mac's UUID). */
export function checkUdid(value: string): string {
  const udid = value.trim();
  if (/^[0-9a-fA-F]{40}$/.test(udid) || /^[0-9a-fA-F]{8}-[0-9a-fA-F]{16}$/.test(udid) || /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(udid)) return udid;
  throw usage(`"${value}" isn't a UDID`, "It's 40 hex digits, or like 00008030-001A2D2E0C38802E (see `ship devices --help` for where to find it).");
}

/** The device named by UDID or name (ignoring case), or an error listing them. */
export function findDevice(devices: Device[], query: string): Device {
  const q = query.trim().toLowerCase();
  const byUdid = devices.find((d) => d.udid.toLowerCase() === q);
  if (byUdid) return byUdid;
  const named = devices.filter((d) => d.name.toLowerCase() === q);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    throw usage(`${named.length} devices are called "${query}"`, `Pick one by UDID: ship devices … ${named[0]!.udid}`, { choices: named.map((d) => d.udid) });
  }
  throw new ShipError(`No device "${query}"`, "no-device", "`ship devices` lists them by name and UDID.", { choices: devices.map((d) => d.name) });
}

const kind = (device: Device) => (device.deviceClass ? device.deviceClass.toLowerCase().replaceAll("_", " ") : device.platform === "MAC_OS" ? "mac" : "ios");

async function devices(ctx: Context) {
  const action = ctx.args[0] ?? "list";
  if (!ACTIONS.includes(action)) throw usage(`Unknown devices action "${action}"`, `ship devices [${ACTIONS.join("|")}] (see \`ship devices --help\`)`, { choices: ACTIONS });
  checkActionFlags(ctx, "devices", action, ACTION_FLAGS);
  const given = ctx.args.slice(1);
  const wants: Record<string, number> = { list: 0, add: 1, rename: 2, disable: 1, enable: 1 };
  if (given.length !== wants[action]) {
    const lines: Record<string, string> = { list: "ship devices", add: "ship devices add <udid> --name <name>", rename: "ship devices rename <device> <new name>", disable: "ship devices disable <device>", enable: "ship devices enable <device>" };
    throw usage(`${lines[action]} takes ${wants[action] === 0 ? "no arguments" : `${wants[action]} argument${wants[action] === 1 ? "" : "s"}`}`, `Quote a name with spaces: ${lines[action]!.replace("<device>", '"Ada\'s iPhone"')}`);
  }
  const platform = parseDevicePlatform(stringFlag(ctx, "platform"));
  const dryRun = boolFlag(ctx, "dry-run");

  if (action === "list") {
    const found = await listDevices({ platform });
    return ui.result({ devices: found }, () => {
      if (!found.length) return console.log("No devices registered yet: ship devices add <udid> --name <name>");
      console.log(table([["NAME", "KIND", "MODEL", "UDID", "STATUS"], ...found.map((d) => [d.name, kind(d), d.model ?? "", d.udid, d.status.toLowerCase()])]));
    });
  }

  if (action === "add") {
    const udid = checkUdid(given[0]!);
    const name = stringFlag(ctx, "name")?.trim();
    if (!name) throw usage("What's it called? Pass --name", `ship devices add ${udid} --name "Ada's iPhone"`);
    const existing = (await listDevices()).find((d) => d.udid.toLowerCase() === udid.toLowerCase());
    if (existing) {
      throw new ShipError(`${udid} is already registered as "${existing.name}"`, "device-exists", existing.status === "DISABLED" ? `Turn it back on: ship devices enable ${udid}` : `Rename it: ship devices rename ${udid} "${name}"`, { device: existing });
    }
    const device = { name, udid, platform: platform ?? "IOS" };
    if (dryRun) return ui.result({ device, dryRun }, () => console.log(`Would register ${name} (${udid}).`));
    const added = await registerDevice(device);
    ui.ok(`Registered ${name}`);
    return ui.result({ device: added, dryRun }, () => console.log("Xcode adds it to development profiles the next time it signs (or run a build with automatic signing)."));
  }

  const device = findDevice(await listDevices(), given[0]!);
  const changes = action === "rename" ? { name: given[1]!.trim() } : { status: action === "disable" ? ("DISABLED" as const) : ("ENABLED" as const) };
  if (action === "rename" && !changes.name) throw usage("The new name can't be empty", `ship devices rename "${device.name}" "Ada's iPhone"`);
  const what = action === "rename" ? `rename ${device.name} to ${changes.name}` : `${action} ${device.name}`;
  if (dryRun) return ui.result({ device: { ...device, ...changes }, dryRun }, () => console.log(`Would ${what}.`));
  const updated = (await updateDevice(device.id, changes)) ?? { ...device, ...changes };
  ui.ok(action === "rename" ? `Renamed it ${updated.name}` : `${action === "disable" ? "Disabled" : "Enabled"} ${updated.name}`);
  ui.result({ device: updated, dryRun });
}

export const commands: Command[] = [
  {
    name: "devices",
    index: [{ section: "other", label: "devices", summary: "Devices registered for development builds" }],
    help: devicesHelp,
    flags: {
      name: { type: "string" },
      platform: { type: "string" },
      "dry-run": { type: "boolean" },
    },
    run: devices,
  },
];
