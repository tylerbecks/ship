// ship purchases: in-app purchases as files in the store folder
// (appstore/purchases/), pulled from and pushed to App Store Connect.

import { existsSync } from "node:fs";
import { relative } from "node:path";
import { type Command, type Context, boolFlag, checkActionFlags, listFlag, stringFlag } from "../command";
import { loadProject } from "../config";
import { changesJSON, renderChanges } from "../diff";
import { problemsSuite, writeJUnit } from "../junit";
import { PRODUCT_ID, diffPurchases, pullPurchases, purchasesDir, pushPurchases, readPurchases, validatePurchases } from "../store/purchases";
import { ShipError, ui } from "../ui";
import { appId } from "./status";

export const purchasesHelp = `ship purchases pull [--product <id>] [--force]
ship purchases diff [--product <id>] [--prune] [--exit-code]
ship purchases push [--product <id>] [--prune] [--dry-run]
ship purchases validate [--junit <path>]

Keeps the app's in-app purchases (consumable, non-consumable, and
non-renewing subscriptions) in the repo, one folder per product id:

  appstore/purchases/<product id>/purchase.json
  appstore/purchases/<product id>/review-notes.txt
  appstore/purchases/<product id>/<locale>/name.txt  description.txt

purchase.json holds the type (CONSUMABLE, NON_CONSUMABLE, or
NON_RENEWING_SUBSCRIPTION), the reference name only you see, Family Sharing,
the price in one territory (Apple sets the others to match), and where it's
sold:

  {
    "type": "NON_CONSUMABLE",
    "referenceName": "Pro",
    "familySharing": true,
    "price": { "territory": "USA", "amount": "4.99" },
    "availability": { "territories": "all", "newTerritories": true }
  }

push makes a purchase that has a folder but isn't in App Store Connect yet,
and changes the rest. It never deletes a purchase (Apple only lets one that
was never submitted go); --prune deletes languages without a folder,
and lets a new price replace prices set by hand in App Store Connect. A
purchase's product id and type can't change, and Family Sharing can't go
off again once it's on. A missing file or key is left alone. validate runs
offline: lengths (display name 35, description 55), types, and prices.

Submitting a purchase for review needs a review screenshot, which App Store
Connect takes for now.

  --product <id>   Only this product id; repeat for more
  --force          pull: overwrite files that differ from App Store Connect
  --prune          diff, push: delete languages that have no folder here, and
                   prices set by hand that a new price replaces
  --dry-run        push: show what would change, change nothing
  --exit-code      diff: exit 1 when there are changes (for CI)
  --junit <path>   validate: also write the problems as a JUnit report, for CI`;

const ACTIONS = ["pull", "diff", "push", "validate"];

const ACTION_FLAGS: Record<string, string[]> = {
  pull: ["product", "force"],
  diff: ["product", "prune", "exit-code"],
  push: ["product", "prune", "dry-run"],
  validate: ["junit"],
};

const usage = (message: string, hint: string, details?: Record<string, unknown>) => new ShipError(message, "usage", hint, details, 2);

async function purchases(ctx: Context) {
  const action = ctx.args[0];
  if (!action || !ACTIONS.includes(action)) {
    throw usage(action ? `Unknown purchases action "${action}"` : "Pass pull, diff, push, or validate", "ship purchases pull, then edit appstore/purchases/ and run ship purchases push", { choices: ACTIONS });
  }
  if (ctx.args.length > 1) throw usage(`ship purchases ${action} takes no other arguments`, "Pick purchases with --product <id>.");
  checkActionFlags(ctx, "purchases", action, ACTION_FLAGS);
  const products = [...new Set(listFlag(ctx, "product").map((id) => id.trim()))];
  for (const id of products) if (!PRODUCT_ID.test(id)) throw usage(`"${id}" isn't a product id`, "Product ids are letters, digits, periods, and underscores, like com.example.app.pro.");
  const project = await loadProject({ app: ctx.app });
  const dir = purchasesDir(project);
  const shown = relative(process.cwd(), dir) || ".";

  if (action === "validate") {
    if (!existsSync(dir)) throw new ShipError(`There's no ${shown} yet`, "no-store", "Start it with `ship purchases pull`, or make purchases/<product id>/purchase.json.");
    const found = await readPurchases(dir);
    const problems = validatePurchases(found);
    const valid = !problems.some((p) => p.severity === "error");
    const junit = stringFlag(ctx, "junit");
    if (junit) await writeJUnit(junit, problemsSuite("ship purchases validate", problems));
    ui.result({ valid, problems }, () => {
      if (!problems.length) return console.log(`${shown}: ${found.length} purchase${found.length === 1 ? "" : "s"}, ready to push.`);
      for (const p of problems) console.log(`${p.severity === "error" ? "✗" : "!"} ${p.file}${p.field ? ` (${p.field})` : ""}: ${p.message}`);
    });
    if (!valid) process.exitCode = 1;
    return;
  }

  const id = await appId(project);

  if (action === "pull") {
    ui.step("Reading the in-app purchases");
    const result = await pullPurchases(project, { appId: id, products, force: boolFlag(ctx, "force") });
    return ui.result(result, () => {
      if (!result.written.length) return console.log(result.unchanged.length ? `${shown} already matches App Store Connect.` : "The app has no in-app purchases yet. Make purchases/<product id>/purchase.json and push it.");
      console.log(`Wrote ${result.written.length} file${result.written.length === 1 ? "" : "s"} to ${shown}:`);
      for (const path of result.written) console.log(`  ${path}`);
    });
  }

  if (action === "diff") {
    const { plan } = await diffPurchases(project, { appId: id, products, prune: boolFlag(ctx, "prune") });
    const hasChanges = plan.changes.length > 0;
    ui.result({ changes: changesJSON(plan.changes), hasChanges, onlyRemote: plan.onlyRemote, onlyRemoteLocales: plan.onlyRemoteLocales }, () => {
      console.log(hasChanges ? renderChanges(plan.changes) : `No changes: App Store Connect matches ${shown}.`);
      if (plan.onlyRemote.length) console.log(`\nOnly in App Store Connect: ${plan.onlyRemote.join(", ")} (\`ship purchases pull\` writes them; push never deletes a purchase)`);
      if (plan.onlyRemoteLocales.length) console.log(`\nLanguages only in App Store Connect: ${plan.onlyRemoteLocales.join(", ")} (--prune deletes them)`);
    });
    if (hasChanges && boolFlag(ctx, "exit-code")) process.exitCode = 1;
    return;
  }

  // push
  const dryRun = boolFlag(ctx, "dry-run");
  const result = await pushPurchases(project, { appId: id, products, prune: boolFlag(ctx, "prune"), dryRun });
  if (result.applied) ui.ok("The in-app purchases are up to date");
  ui.result({ ...result, dryRun, changes: changesJSON(result.changes) }, () => {
    if (!result.changes.length) console.log(`Nothing to push: App Store Connect matches ${shown}.`);
    else console.log(`${dryRun ? "Would change" : "Changed"}:\n${renderChanges(result.changes)}`);
    if (result.created.length && !dryRun) console.log(`\nMade ${result.created.join(", ")}. Submit ${result.created.length === 1 ? "it" : "them"} with the app's next version, after adding a review screenshot in App Store Connect.`);
    if (result.onlyRemote.length) console.log(`\nOnly in App Store Connect: ${result.onlyRemote.join(", ")} (left alone)`);
  });
}

export const commands: Command[] = [
  {
    name: "purchases",
    index: [{ section: "appstore", label: "purchases push", summary: "In-app purchases as files in appstore/purchases" }],
    help: purchasesHelp,
    flags: {
      product: { type: "string", multiple: true },
      force: { type: "boolean" },
      prune: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "exit-code": { type: "boolean" },
      junit: { type: "string" },
    },
    run: purchases,
  },
];
