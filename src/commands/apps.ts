// ship apps and ship remove: the apps set up on this machine.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, findApp, findConfigRoot, forgetApp, loadApps, loadProject, locateConfig, removeProjectConfig } from "../config";
import { type Command, boolFlag, stringFlag } from "../command";
import { ShipError, table, ui } from "../ui";

export const appsHelp = `ship apps

Lists the apps set up on this machine and where their repos are. Any
command can target one of them from anywhere with --app <name>.`;

export async function apps() {
  const list = await loadApps();
  // found: ship.json is in the repo (or, until it's merged, in one of its worktrees).
  const rows = await Promise.all(list.map(async (app) => ({ ...app, found: Boolean(await locateConfig(app)) })));
  ui.result({ apps: rows }, () => {
    if (!rows.length) {
      console.log("No apps yet. Run `ship init` in an app's repo.");
      return;
    }
    console.log(
      table([
        ["NAME", "BUNDLE ID", "REPO"],
        ...rows.map((app) => [app.name, app.bundleId, app.found ? app.root : `${app.root} (missing)`]),
      ]),
    );
  });
}

export const removeHelp = `ship remove [--app <name>] [--keep-file]

Undoes \`ship init\`: deletes the repo's ship.json and forgets the app on
this machine. Nothing in App Store Connect changes.

  --app <name>   Remove an app from anywhere (see \`ship apps\`)
  --keep-file    Only forget the app on this machine; leave ship.json`;

export async function remove(options: { app?: string; keepFile?: boolean }) {
  let root: string | undefined;
  let name: string | undefined;
  if (options.app) {
    const match = await findApp(options.app);
    root = match.root;
    name = match.name;
  } else {
    root = findConfigRoot(process.cwd());
    if (!root) throw new ShipError("This folder isn't set up for ship", "no-config", "Nothing to remove here. `ship apps` lists the apps set up on this machine.");
    name = (await loadProject()).config.name;
  }
  const forgotten = await forgetApp(root);
  const hadFile = existsSync(join(root, CONFIG_FILE));
  if (!options.keepFile) removeProjectConfig(root);
  ui.result({ name, root, forgotten, deletedFile: hadFile && !options.keepFile }, () => {
    console.log(`Removed ${name}.`);
    if (hadFile && !options.keepFile) console.log(`Deleted ${join(root!, CONFIG_FILE)}. Commit the deletion if it was checked in.`);
  });
}

export const commands: Command[] = [
  {
    name: "remove",
    index: [{ section: "setup", label: "remove", summary: "Undo init" }],
    help: removeHelp,
    flags: { "keep-file": { type: "boolean" } },
    maxArgs: 0,
    // Only an --app typed here: SHIP_APP shouldn't make `ship remove` in one repo remove another app.
    run: (ctx) => remove({ app: stringFlag(ctx, "app"), keepFile: boolFlag(ctx, "keep-file") }),
  },
  {
    name: "apps",
    index: [{ section: "setup", label: "apps", summary: "Apps set up on this machine" }],
    help: appsHelp,
    flags: {},
    maxArgs: 0,
    run: () => apps(),
  },
];
