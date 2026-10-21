// ship metadata: the App Store page (name, subtitle, description, keywords,
// What's New, URLs, categories, age rating, App Review details) as files in
// the store folder, pulled from and pushed to App Store Connect.

import { existsSync } from "node:fs";
import { type Command, type Context, boolFlag, checkActionFlags, checkArgs, flagHint, listFlag, stringFlag } from "../command";
import { type Project, loadProject, relativeTo } from "../config";
import { changesJSON, renderChanges } from "../diff";
import { type Platform, parsePlatform } from "../platform";
import { LOCALE_PATTERN } from "../store/files";
import { type Skip, appInfoSummary, prepare, pullMetadata, pushMetadata, validateStore, versionSummary } from "../store/metadata";
import { ShipError, ui } from "../ui";
import { appId } from "./status";

export const metadataHelp = `ship metadata pull [--version <x.y>] [--locale <code>] [--force]
ship metadata diff [--version <x.y>] [--locale <code>] [--prune] [--exit-code]
ship metadata push [--version <x.y>] [--locale <code>] [--dry-run] [--partial] [--prune]
ship metadata validate

Keeps the App Store page in the repo: the name, subtitle, description,
keywords, What's New, URLs, categories, age rating, and App Review details
live as files in appstore/ (set "store" in ship.json to move it). Commit
them, review changes in pull requests, and push them with ship.

pull writes the files from App Store Connect; run it once to start.
diff shows what push would change. push applies it to the version being
prepared, adding languages that have a folder. validate checks lengths,
URLs, and secrets offline.

Apple only allows most changes while a version is being prepared;
promotional text can change any time. push says what can't change yet.
It doesn't set the phased release in app.json; \`ship release\` does.

Each language is a folder (en-US/) of text files: name.txt, subtitle.txt,
description.txt, keywords.txt (one per line), promotional-text.txt,
whats-new.txt, support-url.txt, marketing-url.txt, privacy-policy-url.txt,
privacy-choices-url.txt. A missing file is left alone; an empty one clears
the field. The demo account password in app.json is a reference, like
keychain:ship/lift-demo-password (see \`ship secret --help\`).

  --version <x.y>   The App Store version (default: the one being prepared)
  --locale <code>   Only this language; repeat for more
  --platform <p>    ios, macos, tvos, or visionos (default: ship.json's)
  --force           pull: overwrite local files that differ
  --dry-run         push: show the changes without making them
  --partial         push: apply what can change now, skip the rest
  --prune           push: delete languages that have no folder (diff shows it)
  --exit-code       diff: exit 1 when there are changes (for CI)`;

const ACTIONS = ["pull", "diff", "push", "validate"];

/** Flags only some actions take (validate reads the whole folder, offline). */
const ACTION_FLAGS: Record<string, string[]> = {
  pull: ["version", "locale", "platform", "force"],
  diff: ["version", "locale", "platform", "prune", "exit-code"],
  push: ["version", "locale", "platform", "dry-run", "partial", "prune"],
  validate: [],
};

interface Options {
  app?: string;
  version?: string;
  locales: string[];
  platform?: Platform;
  force: boolean;
  dryRun: boolean;
  partial: boolean;
  prune: boolean;
  exitCode: boolean;
}

/** --locale values, checked: "en-US", not "en_US". */
export function parseLocales(values: string[]): string[] {
  for (const value of values) {
    if (!LOCALE_PATTERN.test(value)) {
      throw new ShipError(`"${value}" isn't a language code`, "usage", "Write it like App Store Connect does: --locale en-US (or de-DE, ja, zh-Hans).", undefined, 2);
    }
  }
  return [...new Set(values)];
}

const where = (project: Project) => relativeTo(project.root, project.storeDir);

function skippedLines(items: Skip[]) {
  for (const item of items) ui.note(`${item.scope} ${item.field}: ${item.reason}`);
}

// MARK: pull

async function pull(project: Project, options: Options) {
  const id = await appId(project);
  ui.step(`Reading the App Store page from App Store Connect`);
  const result = await pullMetadata(project, { appId: id, version: options.version, locales: options.locales, force: options.force });
  for (const warning of result.warnings) ui.warn(warning);
  ui.result(result, () => {
    const version = result.version ? `version ${result.version.versionString} (${result.version.state.toLowerCase().replaceAll("_", " ")})` : "no version";
    if (!result.written.length) {
      console.log(`${where(project)}/ already matches App Store Connect (${version}).`);
      return;
    }
    console.log(`Wrote ${result.written.length} file${result.written.length === 1 ? "" : "s"} to ${where(project)}/ from ${version}:`);
    for (const path of result.written) console.log(`  ${path}`);
    console.log(`\nCommit them; change them and run \`ship metadata diff\`, then \`ship metadata push\`.`);
  });
}

// MARK: diff

function requireStore(project: Project) {
  if (!existsSync(project.storeDir)) {
    throw new ShipError(`There's no ${where(project)}/ folder yet`, "no-store", "Start it from App Store Connect with `ship metadata pull`.");
  }
}

/** What push would change. Returns whether there are changes, for --exit-code. */
async function diff(project: Project, options: Options): Promise<boolean> {
  requireStore(project);
  const id = await appId(project);
  const { remote, plan } = await prepare(project, { appId: id, version: options.version, locales: options.locales, prune: options.prune, strict: false });
  const hasChanges = plan.all.length > 0;
  ui.result(
    {
      version: versionSummary(remote.version),
      appInfo: appInfoSummary(remote.appInfo),
      changes: changesJSON(plan.all),
      blocked: plan.blocked,
      skipped: plan.skipped,
      notes: plan.notes,
      hasChanges,
    },
    () => {
      for (const note of plan.notes) ui.note(note);
      if (!hasChanges) console.log(`No changes: App Store Connect matches ${where(project)}/.`);
      else console.log(renderChanges(plan.all));
      if (plan.blocked.length) {
        console.log(`\nCan't change now (push stops; --partial skips them):`);
        for (const item of plan.blocked) console.log(`  ${item.scope} ${item.field}: ${item.reason}`);
      }
      if (plan.skipped.length) {
        console.log(`\nLeft alone:`);
        for (const item of plan.skipped) console.log(`  ${item.scope} ${item.field}: ${item.reason}`);
      }
    },
  );
  return hasChanges;
}

// MARK: push

async function push(project: Project, options: Options) {
  requireStore(project);
  const id = await appId(project);
  const result = await pushMetadata(project, {
    appId: id,
    version: options.version,
    dryRun: options.dryRun,
    partial: options.partial,
    prune: options.prune,
    locales: options.locales,
  });
  for (const note of result.notes) ui.note(note);
  if (result.skipped.length) {
    ui.warn(`Left ${result.skipped.length} change${result.skipped.length === 1 ? "" : "s"} alone:`);
    skippedLines(result.skipped);
  }
  if (result.applied) ui.ok(`Pushed ${result.changes.length} change${result.changes.length === 1 ? "" : "s"} to App Store Connect`);
  ui.result({ ...result, changes: changesJSON(result.changes) }, () => {
    if (!result.changes.length) return console.log(`No changes: App Store Connect matches ${where(project)}/.`);
    if (result.dryRun) console.log("Would change (--dry-run):");
    console.log(renderChanges(result.changes));
  });
}

// MARK: validate

/** Checks the store folder offline. Returns whether it's valid. */
async function validate(project: Project): Promise<boolean> {
  requireStore(project);
  const problems = await validateStore(project.storeDir);
  const errors = problems.filter((item) => item.severity === "error");
  const valid = errors.length === 0;
  ui.result({ valid, problems }, () => {
    for (const item of problems) {
      const line = `${item.file}${item.field ? ` (${item.field})` : ""}: ${item.message}`;
      if (item.severity === "error") console.log(`✗ ${line}`);
      else console.log(`! ${line}`);
    }
    const warnings = problems.length - errors.length;
    const counts = [errors.length && `${errors.length} error${errors.length === 1 ? "" : "s"}`, warnings && `${warnings} warning${warnings === 1 ? "" : "s"}`].filter(Boolean).join(", ");
    console.log(valid ? `✓ ${where(project)}/ is ready to push${counts ? ` (${counts})` : ""}` : `${where(project)}/ has ${counts}`);
  });
  return valid;
}

// MARK: Command

export async function metadata(action: string | undefined, options: Options): Promise<{ failed: boolean }> {
  if (!action || !ACTIONS.includes(action)) {
    throw new ShipError(
      action ? `Unknown metadata action "${action}"` : "Pick an action: pull, diff, push, or validate",
      "usage",
      `ship metadata ${ACTIONS.join(" | ")} (see \`ship metadata --help\`)`,
      { choices: ACTIONS },
      2,
    );
  }
  const project = await loadProject({ app: options.app });
  if (options.platform) project.platform = options.platform;
  if (action === "pull") await pull(project, options);
  if (action === "push") await push(project, options);
  if (action === "diff") return { failed: (await diff(project, options)) && options.exitCode };
  if (action === "validate") return { failed: !(await validate(project)) };
  return { failed: false };
}

function options(ctx: Context): Options {
  const platform = stringFlag(ctx, "platform");
  return {
    app: ctx.app,
    version: stringFlag(ctx, "version"),
    locales: parseLocales(listFlag(ctx, "locale")),
    platform: platform ? parsePlatform(platform) : undefined,
    force: boolFlag(ctx, "force"),
    dryRun: boolFlag(ctx, "dry-run"),
    partial: boolFlag(ctx, "partial"),
    prune: boolFlag(ctx, "prune"),
    exitCode: boolFlag(ctx, "exit-code"),
  };
}

export const commands: Command[] = [
  {
    name: "metadata",
    index: [{ section: "appstore", label: "metadata push", summary: "The App Store page as files in appstore/" }],
    help: metadataHelp,
    flags: {
      version: { type: "string" },
      locale: { type: "string", multiple: true },
      platform: { type: "string" },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
      prune: { type: "boolean" },
      partial: { type: "boolean" },
      "exit-code": { type: "boolean" },
    },
    run: async (ctx) => {
      if (ACTIONS.includes(ctx.args[0] ?? "")) {
        checkActionFlags(ctx, "metadata", ctx.args[0]!, ACTION_FLAGS);
        const given = ctx.args.slice(1);
        checkArgs(given, 0, `ship metadata ${ctx.args[0]} takes no arguments`, flagHint(given[0], ["locale", "version"], "See `ship metadata --help`."));
      }
      const { failed } = await metadata(ctx.args[0], options(ctx));
      if (failed) process.exitCode = 1;
    },
  },
];
