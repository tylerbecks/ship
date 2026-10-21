// ship version: show or change the app's version (CFBundleShortVersionString)
// in the project's files. It never commits; that's yours to do.

import { relative } from "node:path";
import { type Command, boolFlag } from "../command";
import { loadProject } from "../config";
import { ShipError, ui } from "../ui";
import { BUMPS, type Bump, bumpVersion, checkVersion, projectVersion, writeProjectVersion } from "../version";

export const versionHelp = `ship version
ship version bump major|minor|patch [--dry-run]
ship version set <x.y.z> [--dry-run]

Shows or changes the app's version (CFBundleShortVersionString): the
MARKETING_VERSION build setting in the Xcode project, or displayVersion in
an App Playground's Package.swift. Commit the change before \`ship beta\`.

bump keeps the number of parts: 1.4 becomes 1.5 (minor), 1.4.1 (patch), or
2.0 (major). Every target's version changes together, since App Store
Connect wants extensions to match the app.

  --dry-run   Show the change without editing any file`;

const ACTIONS = ["bump", "set"];

async function show(app: string | undefined) {
  const project = await loadProject({ app });
  ui.step("Reading the project's version");
  const { version, build, source } = await projectVersion(project);
  const file = source?.files[0] ? relative(project.root, source.files[0]) : null;
  ui.result(
    {
      version: version ?? null,
      build: build ?? null,
      source: source ? { kind: source.kind, file, files: source.files.map((path) => relative(project.root, path)) } : null,
    },
    () => {
      if (!version) {
        console.log("The project doesn't say its version. Set it with `ship version set 1.0`.");
        return;
      }
      console.log(`${version}${build ? ` (build ${build})` : ""}`);
      if (source && file) console.log(`From ${source.kind} in ${file}${source.files.length > 1 ? ` and ${source.files.length - 1} more` : ""}`);
    },
  );
}

async function change(app: string | undefined, action: string, value: string | undefined, dryRun: boolean) {
  let to: string;
  let from: string | undefined;
  const project = await loadProject({ app });
  if (action === "bump") {
    if (!value || !BUMPS.includes(value as Bump)) {
      throw new ShipError(
        value ? `Can't bump "${value}"` : "Bump which part?",
        "usage",
        `Pick one: ship version bump ${BUMPS.join(" | ")}`,
        { choices: BUMPS },
        2,
      );
    }
    ui.step("Reading the project's version");
    from = (await projectVersion(project)).version;
    if (!from) {
      throw new ShipError("The project doesn't say its version, so there's nothing to bump", "no-marketing-version", "Set one with `ship version set 1.0`.");
    }
    to = bumpVersion(from, value as Bump);
  } else {
    if (!value) throw new ShipError("Set it to what?", "usage", "For example: ship version set 1.5", undefined, 2);
    to = checkVersion(value, "ship version set");
  }
  const result = await writeProjectVersion(project, to, { from, dryRun });
  for (const warning of result.warnings) ui.warn(warning);
  ui.result({ from: result.from ?? null, to: result.to, files: result.files, dryRun: result.dryRun }, () => {
    if (!result.files.length) {
      console.log(`The version is already ${to}.`);
      return;
    }
    const arrow = result.from ? `${result.from} → ${to}` : `to ${to}`;
    console.log(`${dryRun ? "Would change" : "Changed"} the version ${arrow} in ${result.files.join(", ")}.`);
    if (!dryRun) console.log("Commit it before `ship beta`.");
  });
}

export const commands: Command[] = [
  {
    name: "version",
    index: [{ section: "appstore", label: "version bump", summary: "Show or bump the app's version" }],
    help: versionHelp,
    flags: { "dry-run": { type: "boolean" } },
    run: async (ctx) => {
      const action = ctx.args[0];
      if (action === undefined) return show(ctx.app);
      if (!ACTIONS.includes(action)) {
        throw new ShipError(`Unknown version action "${action}"`, "usage", "Pick one: ship version, ship version bump <part>, or ship version set <x.y.z>", { choices: ACTIONS }, 2);
      }
      return change(ctx.app, action, ctx.args[1], boolFlag(ctx, "dry-run"));
    },
  },
];
