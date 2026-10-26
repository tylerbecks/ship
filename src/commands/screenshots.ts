// ship screenshots: the App Store screenshots and app previews as files in
// the store folder, pulled from, compared with, and pushed to App Store
// Connect.

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { type Command, type Context, boolFlag, checkActionFlags, checkArgs, flagHint, listFlag, stringFlag } from "../command";
import { loadProject } from "../config";
import { changesJSON } from "../diff";
import { parsePlatform } from "../platform";
import { importScreenshots } from "../store/fastlane";
import { LOCALE_PATTERN } from "../store/files";
import { PREVIEW_TYPES, SCREENSHOT_TYPES, isPreviewType, isScreenshotType } from "../store/images";
import { type MediaOptions, diffMedia, pullMedia, renderMediaChanges, syncMedia, validateMedia } from "../store/media";
import { problemsSuite, writeJUnit } from "../junit";
import { ShipError, ui } from "../ui";
import { printImport } from "./metadata";
import { appId } from "./status";

export const screenshotsHelp = `ship screenshots pull [--version <x.y>] [--locale <code>] [--force]
ship screenshots diff [--version <x.y>] [--locale <code>] [--type <TYPE>] [--prune] [--exit-code]
ship screenshots push [--version <x.y>] [--locale <code>] [--type <TYPE>] [--prune] [--dry-run] [--no-wait]
ship screenshots validate [--junit <path>]
ship screenshots import [--from <fastlane dir>] [--force] [--dry-run]

Keeps the App Store screenshots and app previews in the repo, next to the
page's text:
  appstore/<locale>/screenshots/<display type>/01-home.png
  appstore/<locale>/previews/<preview type>/01-intro.mp4
They show in file name order, so number them. Display types are App Store
Connect's, like APP_IPHONE_67 (6.9" iPhone) or APP_IPAD_PRO_3GEN_129 (13"
iPad); preview types drop the APP_ prefix, like IPHONE_67.

push uploads new and changed files and puts them in order. It deletes
screenshots that aren't in the repo only with --prune. validate checks
file types, counts, and image sizes offline. media.lock.json records which
file matches which upload; commit it.

  --version <x.y>    The App Store version (default: the one being prepared)
  --platform <p>     ios, macos, tvos, or visionos (default: ship.json's)
  --locale <code>    Only this language; repeat for more
  --type <TYPE>      Only this display or preview type; repeat for more
  --prune            push: delete screenshots and previews that aren't in the repo (diff shows it)
  --dry-run          push: show the changes without making them
  --no-wait          push: don't wait for App Store Connect to process uploads
  --force            pull: overwrite local files that differ
  --exit-code        diff: exit 1 when there are changes (for CI)
  --junit <path>     validate: also write the problems as a JUnit report, for CI
  --from <dir>       import: the fastlane folder (default: fastlane/ next to ship.json)

import copies a fastlane screenshots folder (fastlane/screenshots/<locale>/)
into appstore/, each image in the display type its pixel size fits (or the
one its file name says), numbered in fastlane's order.`;

const ACTIONS = ["pull", "diff", "push", "validate", "import"];

/** Flags only some actions take; --locale, --type, and --platform work with all of them. */
const ACTION_FLAGS: Record<string, string[]> = {
  pull: ["version", "force"],
  diff: ["version", "prune", "exit-code"],
  push: ["version", "prune", "dry-run", "no-wait"],
  validate: ["junit"],
  import: ["from", "force", "dry-run"],
};

const usage = (message: string, hint: string, details?: Record<string, unknown>) => new ShipError(message, "usage", hint, details, 2);

/** --locale and --type, checked. */
function filters(ctx: Context): { locales: string[]; types: string[] } {
  const locales = listFlag(ctx, "locale");
  for (const locale of locales) {
    if (!LOCALE_PATTERN.test(locale)) throw usage(`"${locale}" isn't a locale`, "Use App Store Connect's codes, like --locale en-US or --locale ja.");
  }
  const types = listFlag(ctx, "type");
  for (const type of types) {
    if (!isScreenshotType(type) && !isPreviewType(type)) {
      const choices = [...Object.keys(SCREENSHOT_TYPES), ...PREVIEW_TYPES];
      throw usage(`"${type}" isn't a display or preview type`, "For example: --type APP_IPHONE_67 (screenshots) or --type IPHONE_67 (previews).", { choices });
    }
  }
  return { locales, types };
}

async function options(ctx: Context, project: Awaited<ReturnType<typeof loadProject>>): Promise<MediaOptions> {
  const platform = stringFlag(ctx, "platform");
  return {
    appId: await appId(project),
    version: stringFlag(ctx, "version"),
    platform: platform ? parsePlatform(platform) : undefined,
    ...filters(ctx),
    prune: boolFlag(ctx, "prune"),
    dryRun: boolFlag(ctx, "dry-run"),
    wait: !boolFlag(ctx, "no-wait"),
  };
}

const where = (project: { root: string }, dir: string) => relative(project.root, dir) || ".";

// MARK: Actions

async function pull(ctx: Context) {
  filters(ctx);
  const project = await loadProject({ app: ctx.app });
  const result = await pullMedia(project, { ...(await options(ctx, project)), force: boolFlag(ctx, "force") });
  ui.result(result, () => {
    const dir = where(project, result.dir);
    const { written, unchanged, renamed, skipped } = result;
    if (!written.length && !renamed.length && !skipped.length) {
      console.log(unchanged.length ? `${dir}/ already matches version ${result.version.versionString}.` : `Version ${result.version.versionString} has no screenshots or previews.`);
    } else {
      console.log(`Wrote ${written.length} file${written.length === 1 ? "" : "s"} to ${dir}/ from version ${result.version.versionString}${unchanged.length ? ` (${unchanged.length} already matched)` : ""}.`);
    }
    for (const item of renamed) console.log(`  renamed ${item.from} → ${item.to} (App Store Connect's order)`);
    for (const item of skipped) console.log(`  skipped ${item.path}: ${item.reason}`);
  });
}

async function diff(ctx: Context) {
  filters(ctx);
  const project = await loadProject({ app: ctx.app });
  const result = await diffMedia(project, await options(ctx, project));
  const dir = where(project, project.storeDir);
  if (!result) {
    ui.result({ version: null, changes: [], sets: [], hasChanges: false }, () =>
      console.log(`No screenshots in ${dir}/ yet. Run \`ship screenshots pull\`, or add <locale>/screenshots/<display type>/ folders.`),
    );
    return;
  }
  ui.result({ ...result, changes: changesJSON(result.changes) }, () => {
    if (!result.hasChanges) {
      console.log(`No changes: ${dir}/ matches version ${result.version.versionString}.`);
      return;
    }
    console.log(renderMediaChanges(result.changes));
    console.log(`\n\`ship screenshots push\` makes these changes to version ${result.version.versionString}.`);
  });
  if (result.hasChanges && boolFlag(ctx, "exit-code")) process.exitCode = 1;
}

async function push(ctx: Context) {
  filters(ctx);
  const project = await loadProject({ app: ctx.app });
  const result = await syncMedia(project, await options(ctx, project));
  ui.result({ ...result, changes: changesJSON(result.changes) }, () => {
    const dir = where(project, project.storeDir);
    if (!result.version) {
      console.log(`No screenshots in ${dir}/ yet. Run \`ship screenshots pull\`, or add <locale>/screenshots/<display type>/ folders.`);
      return;
    }
    const version = result.version.versionString;
    if (!result.changes.length) {
      console.log(`Nothing to push: version ${version} already has these screenshots.`);
      return;
    }
    if (result.dryRun) {
      console.log(renderMediaChanges(result.changes));
      console.log(`\nDry run: nothing changed. Push without --dry-run to change version ${version}.`);
      return;
    }
    const parts = [
      `${result.uploaded.length} uploaded`,
      `${result.deleted.length} deleted`,
      ...(result.reordered.length ? [`${result.reordered.length} set${result.reordered.length === 1 ? "" : "s"} reordered`] : []),
    ];
    console.log(`Pushed to version ${version}: ${parts.join(", ")}.`);
  });
}

async function validate(ctx: Context) {
  const project = await loadProject({ app: ctx.app });
  // Like metadata and testflight validate: nothing to check isn't "valid", so CI notices a missing or misplaced folder.
  if (!existsSync(project.storeDir)) {
    throw new ShipError(`There's no ${where(project, project.storeDir)}/ folder yet`, "no-store", "Start it with `ship screenshots pull`.");
  }
  const platform = stringFlag(ctx, "platform");
  const { problems, files } = await validateMedia(project.storeDir, { ...filters(ctx), platform: platform ? parsePlatform(platform) : project.platform });
  const valid = !problems.some((problem) => problem.severity === "error");
  const junit = stringFlag(ctx, "junit");
  if (junit) await writeJUnit(junit, problemsSuite("ship screenshots validate", problems));
  ui.result({ valid, problems }, () => {
    for (const problem of problems) console.log(`${problem.severity === "error" ? "✗" : "!"} ${problem.file}: ${problem.message}`);
    if (valid) console.log(`✓ ${files} file${files === 1 ? "" : "s"} in ${where(project, project.storeDir)}/ look ready${problems.length ? " (see the warnings)" : ""}.`);
  });
  if (!valid) process.exitCode = 1;
}

async function importFastlane(ctx: Context) {
  // import takes the whole folder; --locale and --type would be ignored, so they're a usage error.
  if (listFlag(ctx, "locale").length || listFlag(ctx, "type").length || stringFlag(ctx, "platform")) {
    throw usage("import brings over every language and type", "Drop --locale, --type, and --platform; delete what you don't want afterwards.");
  }
  const project = await loadProject({ app: ctx.app });
  const result = await importScreenshots(project, { from: stringFlag(ctx, "from") ?? join(project.root, "fastlane"), force: boolFlag(ctx, "force"), dryRun: boolFlag(ctx, "dry-run") });
  for (const warning of result.warnings) ui.warn(warning);
  printImport(result, where(project, project.storeDir), "screenshots");
}

export const commands: Command[] = [
  {
    name: "screenshots",
    index: [{ section: "appstore", label: "screenshots push", summary: "Screenshots and previews as files in appstore/" }],
    help: screenshotsHelp,
    flags: {
      version: { type: "string" },
      platform: { type: "string" },
      locale: { type: "string", multiple: true },
      type: { type: "string", multiple: true },
      prune: { type: "boolean" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
      "no-wait": { type: "boolean" },
      "exit-code": { type: "boolean" },
      junit: { type: "string" },
      from: { type: "string" },
    },
    run: async (ctx) => {
      const action = ctx.args[0];
      if (ACTIONS.includes(action ?? "")) {
        checkActionFlags(ctx, "screenshots", action!, ACTION_FLAGS);
        const given = ctx.args.slice(1);
        checkArgs(given, 0, `ship screenshots ${action} takes no arguments`, flagHint(given[0], ["locale", "type", "version"], "See `ship screenshots --help`."));
      }
      if (action === "pull") return pull(ctx);
      if (action === "diff") return diff(ctx);
      if (action === "push") return push(ctx);
      if (action === "validate") return validate(ctx);
      if (action === "import") return importFastlane(ctx);
      throw usage(
        action ? `Unknown screenshots action "${action}"` : "Pass pull, diff, push, validate, or import",
        "For example: ship screenshots diff (see `ship screenshots --help`)",
        { choices: ACTIONS },
      );
    },
  },
];
