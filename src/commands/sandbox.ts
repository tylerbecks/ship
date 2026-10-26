// ship sandbox: the sandbox Apple Accounts that test in-app purchases.

import { RENEWAL_RATES, type RenewalRate, type SandboxChanges, type SandboxTester, clearPurchaseHistory, sandboxTesters, updateSandboxTester } from "../asc/sandbox";
import { type Command, type Context, boolFlag, checkActionFlags, stringFlag } from "../command";
import { ShipError, table, ui } from "../ui";
import { parseTerritory } from "./reviews";

export const sandboxHelp = `ship sandbox [list]
ship sandbox clear <email>... [--dry-run]
ship sandbox clear --all [--dry-run]
ship sandbox set <email> [--territory <code>] [--interrupt | --no-interrupt] [--renewal <rate>] [--dry-run]

The sandbox Apple Accounts that buy in-app purchases and subscriptions in
development and TestFlight builds without paying. clear erases what they've
bought, so they can buy it all again. set changes the App Store they're in,
whether purchases stop to ask for something (like accepting terms), and
how fast a monthly subscription renews.

The API can't make a sandbox account: add them in App Store Connect →
Users and Access → Sandbox.

  --all              clear: every sandbox tester
  --territory <code> set: their App Store, like USA or GBR
  --interrupt        set: interrupt purchases, to test that flow
  --no-interrupt     set: don't
  --renewal <rate>   set: a month lasts 1h, 30m, 15m, 5m, or 3m
  --dry-run          clear, set: show what would change`;

const ACTIONS = ["list", "clear", "set"];

const ACTION_FLAGS: Record<string, string[]> = {
  list: [],
  clear: ["all", "dry-run"],
  set: ["territory", "interrupt", "no-interrupt", "renewal", "dry-run"],
};

const usage = (message: string, hint: string, details?: Record<string, unknown>) => new ShipError(message, "usage", hint, details, 2);

/** --renewal as Apple's subscriptionRenewalRate. */
export function parseRenewal(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const rate = RENEWAL_RATES[value.trim().toLowerCase() as RenewalRate];
  if (!rate) throw usage(`--renewal takes ${Object.keys(RENEWAL_RATES).join(", ")}, not "${value}"`, "That's how long a month lasts: --renewal 5m renews monthly subscriptions every five minutes.", { choices: Object.keys(RENEWAL_RATES) });
  return rate;
}

/** A renewal rate for people: "5m", from Apple's value. */
const renewalText = (rate: string | null) => (Object.entries(RENEWAL_RATES).find(([, value]) => value === rate)?.[0] ?? rate ?? "");

/** The testers with these emails, ignoring case, or an error naming the ones there are. */
export function findTesters(testers: SandboxTester[], emails: string[]): SandboxTester[] {
  const missing = emails.filter((email) => !testers.some((t) => t.email.toLowerCase() === email.trim().toLowerCase()));
  if (missing.length) {
    throw new ShipError(
      `No sandbox tester ${missing.join(", ")}`,
      "no-sandbox-tester",
      testers.length ? "`ship sandbox` lists them." : "There are none yet: add them in App Store Connect → Users and Access → Sandbox.",
      { choices: testers.map((t) => t.email) },
    );
  }
  return emails.map((email) => testers.find((t) => t.email.toLowerCase() === email.trim().toLowerCase())!);
}

async function sandbox(ctx: Context) {
  const action = ctx.args[0] ?? "list";
  if (!ACTIONS.includes(action)) throw usage(`Unknown sandbox action "${action}"`, "ship sandbox [list|clear|set] (see `ship sandbox --help`)", { choices: ACTIONS });
  checkActionFlags(ctx, "sandbox", action, ACTION_FLAGS);
  const emails = [...new Set(ctx.args.slice(1).map((email) => email.trim()).filter(Boolean))];
  const dryRun = boolFlag(ctx, "dry-run");
  if (action === "list" && emails.length) throw usage("ship sandbox list takes no email addresses", "To clear one's purchases: ship sandbox clear <email>");
  if (action === "clear" && boolFlag(ctx, "all") === Boolean(emails.length)) {
    throw usage(emails.length ? "Pass emails or --all, not both" : "Whose purchases? Pass emails or --all", "ship sandbox clear a@example.com, or ship sandbox clear --all");
  }
  if (action === "set" && emails.length !== 1) throw usage("Pass one email: ship sandbox set <email> …", "`ship sandbox` lists them.");

  let changes: SandboxChanges = {};
  if (action === "set") {
    if (boolFlag(ctx, "interrupt") && boolFlag(ctx, "no-interrupt")) throw usage("Pass --interrupt or --no-interrupt, not both", "--interrupt makes purchases stop to ask for something.");
    const territory = parseTerritory(stringFlag(ctx, "territory"));
    const renewal = parseRenewal(stringFlag(ctx, "renewal"));
    changes = {
      ...(territory ? { territory } : {}),
      ...(boolFlag(ctx, "interrupt") ? { interruptPurchases: true } : boolFlag(ctx, "no-interrupt") ? { interruptPurchases: false } : {}),
      ...(renewal ? { subscriptionRenewalRate: renewal } : {}),
    };
    if (!Object.keys(changes).length) throw usage("Nothing to set", `For example: ship sandbox set ${emails[0]} --renewal 5m`);
  }

  const testers = await sandboxTesters();

  if (action === "list") {
    return ui.result({ testers }, () => {
      if (!testers.length) return console.log("No sandbox testers yet: add them in App Store Connect → Users and Access → Sandbox.");
      console.log(
        table([
          ["EMAIL", "NAME", "STORE", "INTERRUPTS", "RENEWS"],
          ...testers.map((t) => [t.email, `${t.firstName} ${t.lastName}`.trim(), t.territory ?? "", t.interruptPurchases ? "yes" : "no", renewalText(t.subscriptionRenewalRate)]),
        ]),
      );
    });
  }

  if (action === "clear") {
    const picked = boolFlag(ctx, "all") ? testers : findTesters(testers, emails);
    if (!picked.length) throw new ShipError("There are no sandbox testers to clear", "no-sandbox-tester", "Add them in App Store Connect → Users and Access → Sandbox.");
    if (!dryRun) {
      await clearPurchaseHistory(picked.map((t) => t.id));
      ui.ok(`Cleared the purchases of ${picked.length === 1 ? picked[0]!.email : `${picked.length} testers`}`);
    }
    return ui.result({ cleared: picked.map((t) => t.email), dryRun }, () => {
      if (dryRun) console.log(`Would clear the purchases of ${picked.map((t) => t.email).join(", ")}.`);
      else console.log("Apple takes a few minutes to finish; sign out of the sandbox account on the device and back in after.");
    });
  }

  // set
  const [tester] = findTesters(testers, emails);
  if (dryRun) return ui.result({ tester: { ...tester!, ...changes }, changes, dryRun }, () => console.log(`Would change ${tester!.email}: ${JSON.stringify(changes)}`));
  const updated = (await updateSandboxTester(tester!.id, changes)) ?? { ...tester!, ...changes };
  ui.ok(`Updated ${updated.email}`);
  ui.result({ tester: updated, changes, dryRun });
}

export const commands: Command[] = [
  {
    name: "sandbox",
    index: [{ section: "other", label: "sandbox", summary: "Sandbox accounts for testing purchases" }],
    help: sandboxHelp,
    flags: {
      all: { type: "boolean" },
      territory: { type: "string" },
      interrupt: { type: "boolean" },
      "no-interrupt": { type: "boolean" },
      renewal: { type: "string" },
      "dry-run": { type: "boolean" },
    },
    run: sandbox,
  },
];
