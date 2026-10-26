// What ship purchases and ship subscriptions share: their actions, --product,
// and how validate reports.

import { type Context, listFlag, stringFlag } from "../command";
import { problemsSuite, writeJUnit } from "../junit";
import type { Problem } from "../store/check";
import { PRODUCT_ID } from "../store/purchases";
import { ShipError, ui } from "../ui";

export const CATALOG_ACTIONS = ["pull", "diff", "push", "validate"];

export const CATALOG_ACTION_FLAGS: Record<string, string[]> = {
  pull: ["product", "force"],
  diff: ["product", "prune", "exit-code"],
  push: ["product", "prune", "dry-run"],
  validate: ["junit"],
};

export const usage = (message: string, hint: string, details?: Record<string, unknown>) => new ShipError(message, "usage", hint, details, 2);

/** --product's values, each checked as a product id. */
export function productFlag(ctx: Context): string[] {
  const products = [...new Set(listFlag(ctx, "product").map((id) => id.trim()))];
  for (const id of products) if (!PRODUCT_ID.test(id)) throw usage(`"${id}" isn't a product id`, "Product ids are letters, digits, periods, and underscores, like com.example.app.pro.");
  return products;
}

/** validate's result: JSON or a line per problem, the --junit report, and exit 1 on errors. `what` is like "purchase". */
export async function reportValidate(ctx: Context, command: string, shown: string, count: number, what: string, problems: Problem[]) {
  const valid = !problems.some((p) => p.severity === "error");
  const junit = stringFlag(ctx, "junit");
  if (junit) await writeJUnit(junit, problemsSuite(`ship ${command} validate`, problems));
  ui.result({ valid, problems }, () => {
    if (!problems.length) return console.log(`${shown}: ${count} ${what}${count === 1 ? "" : "s"}, ready to push.`);
    for (const p of problems) console.log(`${p.severity === "error" ? "✗" : "!"} ${p.file}${p.field ? ` (${p.field})` : ""}: ${p.message}`);
  });
  if (!valid) process.exitCode = 1;
}
