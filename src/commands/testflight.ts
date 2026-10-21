// ship testflight: TestFlight's test information as files in the repo
// (appstore/testflight/), pulled from and pushed to App Store Connect.

import { existsSync } from "node:fs";
import { relative } from "node:path";
import { type Command, type Context, boolFlag, checkActionFlags, listFlag } from "../command";
import { loadProject } from "../config";
import { changesJSON, renderChanges } from "../diff";
import { diffBetaInfo, pullBetaInfo, pushBetaInfo, readBetaInfo, testflightDir, validateBetaInfo } from "../store/testflight";
import { ShipError, ui } from "../ui";
import { appId } from "./status";

export const testflightHelp = `ship testflight pull [--force]
ship testflight diff [--exit-code]
ship testflight push [--dry-run] [--locale <code>] [--prune]
ship testflight validate

Keeps TestFlight's test information in the repo, in appstore/testflight/:
what testers see about the beta (description, feedback email, marketing
and privacy policy URLs, per language), and the contact and sign-in
details for Beta App Review. Passwords are references (keychain:, op://,
env:), never the password itself.

  review.json                 contact and demo account
  review-notes.txt            notes for Beta App Review
  <locale>/description.txt    about the beta, up to 4000 characters
  <locale>/feedback-email.txt, marketing-url.txt, privacy-policy-url.txt,
           tvos-privacy-policy.txt

A missing file isn't managed; an empty one clears the field. All of it can
change any time.

  --force          pull: overwrite files that differ from App Store Connect
  --exit-code      diff: exit 1 when there are changes
  --dry-run        push: show what would change, change nothing
  --locale <code>  push: only this language (repeatable)
  --prune          push: delete languages that have no folder here`;

const ACTIONS = ["pull", "diff", "push", "validate"];

const ACTION_FLAGS: Record<string, string[]> = {
  pull: ["force"],
  diff: ["exit-code"],
  push: ["dry-run", "locale", "prune"],
  validate: [],
};

export async function testflight(ctx: Context) {
  const action = ctx.args[0];
  if (!action || !ACTIONS.includes(action)) {
    throw new ShipError(
      action ? `Unknown testflight action "${action}"` : "Pass pull, diff, push, or validate",
      "usage",
      "ship testflight pull, then edit appstore/testflight/ and run ship testflight push",
      { choices: ACTIONS },
      2,
    );
  }
  if (ctx.args.length > 1) throw new ShipError(`ship testflight ${action} takes no other arguments`, "usage", "See `ship testflight --help`.", undefined, 2);
  checkActionFlags(ctx, "testflight", action, ACTION_FLAGS);
  const project = await loadProject({ app: ctx.app });
  const dir = testflightDir(project);
  const shown = relative(process.cwd(), dir) || ".";

  if (action === "validate") {
    if (!existsSync(dir)) throw new ShipError(`There's no ${shown} yet`, "no-store", "Make it from App Store Connect with `ship testflight pull`.");
    const problems = validateBetaInfo(await readBetaInfo(dir));
    const valid = !problems.some((p) => p.severity === "error");
    ui.result({ valid, problems }, () => {
      if (!problems.length) return console.log(`${shown} looks good.`);
      for (const p of problems) console.log(`${p.severity === "error" ? "✗" : "!"} ${p.file}${p.field ? ` (${p.field})` : ""}: ${p.message}`);
    });
    if (!valid) process.exitCode = 1;
    return;
  }

  const id = await appId(project);

  if (action === "pull") {
    ui.step("Reading TestFlight's test information");
    const result = await pullBetaInfo(project, { appId: id, force: boolFlag(ctx, "force") });
    for (const warning of result.warnings) ui.warn(warning);
    return ui.result(result, () => {
      if (!result.written.length) return console.log(`${shown} already matches App Store Connect.`);
      console.log(`Wrote ${result.written.length} file${result.written.length === 1 ? "" : "s"} to ${shown}:`);
      for (const path of result.written) console.log(`  ${path}`);
    });
  }

  if (action === "diff") {
    const { plan } = await diffBetaInfo(project, { appId: id });
    const hasChanges = plan.changes.length > 0;
    const onlyRemote = plan.onlyRemote.map((l) => l.locale);
    ui.result({ changes: changesJSON(plan.changes), hasChanges, onlyRemote, passwordHidden: plan.passwordHidden }, () => {
      console.log(hasChanges ? renderChanges(plan.changes) : `No changes: App Store Connect matches ${shown}.`);
      if (onlyRemote.length) console.log(`\nOnly in App Store Connect: ${onlyRemote.join(", ")} (\`ship testflight push --prune\` deletes them)`);
      if (plan.password && plan.passwordHidden) console.log("\nThe demo account password goes with the other review changes (App Store Connect doesn't show it).");
    });
    if (hasChanges && boolFlag(ctx, "exit-code")) process.exitCode = 1;
    return;
  }

  // push
  const dryRun = boolFlag(ctx, "dry-run");
  const result = await pushBetaInfo(project, { appId: id, dryRun, locales: listFlag(ctx, "locale"), prune: boolFlag(ctx, "prune") });
  if (result.applied) ui.ok("TestFlight's test information is up to date");
  ui.result({ ...result, dryRun, changes: changesJSON(result.changes) }, () => {
    if (!result.changes.length) console.log(`Nothing to push: App Store Connect matches ${shown}.`);
    else console.log(`${dryRun ? "Would change" : "Changed"}:\n${renderChanges(result.changes)}`);
    if (result.onlyRemote.length) console.log(`\nOnly in App Store Connect: ${result.onlyRemote.join(", ")} (--prune deletes them)`);
  });
}

export const commands: Command[] = [
  {
    name: "testflight",
    index: [{ section: "testflight", label: "testflight push", summary: "Test information as files in appstore/testflight" }],
    help: testflightHelp,
    flags: {
      locale: { type: "string", multiple: true },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
      prune: { type: "boolean" },
      "exit-code": { type: "boolean" },
    },
    run: testflight,
  },
];
