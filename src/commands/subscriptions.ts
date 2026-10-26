// ship subscriptions: auto-renewable subscriptions as files in the store
// folder (appstore/subscriptions/), pulled from and pushed to App Store Connect.

import { existsSync } from "node:fs";
import { relative } from "node:path";
import { type Command, type Context, boolFlag, checkActionFlags } from "../command";
import { loadProject } from "../config";
import { changesJSON, renderChanges } from "../diff";
import { diffSubscriptions, pullSubscriptions, pushSubscriptions, readSubscriptions, subscriptionsDir, validateSubscriptions } from "../store/subscriptions";
import { ShipError, ui } from "../ui";
import { CATALOG_ACTIONS, CATALOG_ACTION_FLAGS, productFlag, reportValidate, usage } from "./catalog";
import { appId } from "./status";

export const subscriptionsHelp = `ship subscriptions pull [--product <id>] [--force]
ship subscriptions diff [--product <id>] [--prune] [--exit-code]
ship subscriptions push [--product <id>] [--prune] [--dry-run]
ship subscriptions validate [--junit <path>]

Keeps the app's auto-renewable subscriptions in the repo: a folder per
group, named for its reference name, with its languages and a folder per
subscription:

  appstore/subscriptions/<group>/<locale>/name.txt  app-name.txt
  appstore/subscriptions/<group>/<product id>/subscription.json
  appstore/subscriptions/<group>/<product id>/review-notes.txt
  appstore/subscriptions/<group>/<product id>/<locale>/name.txt  description.txt

A folder with subscription.json in it is a subscription; any other is a
language. subscription.json holds the period, the level in the group (1 is
the highest), the reference name only you see, Family Sharing, the price in
one territory, and where it's sold:

  {
    "period": "ONE_MONTH",
    "level": 1,
    "referenceName": "Monthly",
    "familySharing": true,
    "price": { "territory": "USA", "amount": "4.99" },
    "availability": { "territories": "all", "newTerritories": true }
  }

A new price goes in every other territory at Apple's equivalent. Current
subscribers keep what they pay unless "existingSubscribers": "update" is in
price. A price set by hand in another territory, or one scheduled for
later, stops the push; --prune replaces them.

push makes groups and subscriptions that have a folder but aren't in App
Store Connect yet, and changes the rest. It never deletes either; --prune
deletes languages without a folder. A subscription's product id and group
can't change, and Family Sharing can't go off again once it's on. Rename a
group in App Store Connect, then pull. validate runs offline.

  --product <id>   Only this product id; repeat for more
  --force          pull: overwrite files that differ from App Store Connect
  --prune          diff, push: delete languages that have no folder here, and
                   prices set by hand that a new price replaces
  --dry-run        push: show what would change, change nothing
  --exit-code      diff: exit 1 when there are changes (for CI)
  --junit <path>   validate: also write the problems as a JUnit report, for CI`;



async function subscriptions(ctx: Context) {
  const action = ctx.args[0];
  if (!action || !CATALOG_ACTIONS.includes(action)) {
    throw usage(action ? `Unknown subscriptions action "${action}"` : "Pass pull, diff, push, or validate", "ship subscriptions pull, then edit appstore/subscriptions/ and run ship subscriptions push", { choices: CATALOG_ACTIONS });
  }
  if (ctx.args.length > 1) throw usage(`ship subscriptions ${action} takes no other arguments`, "Pick subscriptions with --product <id>.");
  checkActionFlags(ctx, "subscriptions", action, CATALOG_ACTION_FLAGS);
  const products = productFlag(ctx);
  const project = await loadProject({ app: ctx.app });
  const dir = subscriptionsDir(project);
  const shown = relative(process.cwd(), dir) || ".";

  if (action === "validate") {
    if (!existsSync(dir)) throw new ShipError(`There's no ${shown} yet`, "no-store", "Start it with `ship subscriptions pull`, or make subscriptions/<group>/<product id>/subscription.json.");
    const groups = await readSubscriptions(dir);
    const found = groups.flatMap((g) => g.subscriptions);
    const problems = validateSubscriptions(groups);
    await reportValidate(ctx, "subscriptions", shown, found.length, "subscription", problems);
    return;
  }

  const id = await appId(project);

  if (action === "pull") {
    ui.step("Reading the subscriptions");
    const result = await pullSubscriptions(project, { appId: id, products, force: boolFlag(ctx, "force") });
    return ui.result(result, () => {
      if (!result.written.length) return console.log(result.unchanged.length ? `${shown} already matches App Store Connect.` : "The app has no subscriptions yet. Make subscriptions/<group>/<product id>/subscription.json and push it.");
      console.log(`Wrote ${result.written.length} file${result.written.length === 1 ? "" : "s"} to ${shown}:`);
      for (const path of result.written) console.log(`  ${path}`);
    });
  }

  if (action === "diff") {
    const { plan } = await diffSubscriptions(project, { appId: id, products, prune: boolFlag(ctx, "prune") });
    const hasChanges = plan.changes.length > 0;
    ui.result({ changes: changesJSON(plan.changes), hasChanges, onlyRemote: plan.onlyRemote, onlyRemoteLocales: plan.onlyRemoteLocales }, () => {
      console.log(hasChanges ? renderChanges(plan.changes) : `No changes: App Store Connect matches ${shown}.`);
      if (plan.onlyRemote.length) console.log(`\nOnly in App Store Connect: ${plan.onlyRemote.join(", ")} (\`ship subscriptions pull\` writes them; push never deletes one)`);
      if (plan.onlyRemoteLocales.length) console.log(`\nLanguages only in App Store Connect: ${plan.onlyRemoteLocales.join(", ")} (--prune deletes them)`);
    });
    if (hasChanges && boolFlag(ctx, "exit-code")) process.exitCode = 1;
    return;
  }

  // push
  const dryRun = boolFlag(ctx, "dry-run");
  const result = await pushSubscriptions(project, { appId: id, products, prune: boolFlag(ctx, "prune"), dryRun });
  if (result.applied) ui.ok("The subscriptions are up to date");
  ui.result({ ...result, dryRun, changes: changesJSON(result.changes) }, () => {
    if (!result.changes.length) console.log(`Nothing to push: App Store Connect matches ${shown}.`);
    else console.log(`${dryRun ? "Would change" : "Changed"}:\n${renderChanges(result.changes)}`);
    if (result.created.length && !dryRun) console.log(`\nMade ${result.created.join(", ")}. Submit ${result.created.length === 1 ? "it" : "them"} with the app's next version, after adding a review screenshot in App Store Connect.`);
    if (result.onlyRemote.length) console.log(`\nOnly in App Store Connect: ${result.onlyRemote.join(", ")} (left alone)`);
  });
}

export const commands: Command[] = [
  {
    name: "subscriptions",
    index: [{ section: "appstore", label: "subscriptions", summary: "Subscriptions as files in appstore/subscriptions" }],
    help: subscriptionsHelp,
    flags: {
      product: { type: "string", multiple: true },
      force: { type: "boolean" },
      prune: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "exit-code": { type: "boolean" },
      junit: { type: "string" },
    },
    run: subscriptions,
  },
];
