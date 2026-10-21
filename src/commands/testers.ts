// ship testers: list, invite, and remove TestFlight testers.

import { AscError } from "../asc/client";
import {
  type BetaGroup,
  type Tester,
  addTester,
  betaGroups,
  findTester,
  groupNamed,
  groupTesters,
  removeTestersFromApp,
  removeTestersFromGroup,
  sameEmail,
} from "../asc/testflight";
import { type Command, boolFlag, stringFlag } from "../command";
import { type Project, loadProject } from "../config";
import { isEmail } from "../store/check";
import { ShipError, table, ui } from "../ui";
import { appId, friendly } from "./status";

export const testersHelp = `ship testers [list] [--group <name>]
ship testers add <email>... [--group <name>]
ship testers remove <email>... [--group <name> | --everywhere]

Lists, invites, or removes TestFlight testers. Without --group, uses the
first external group (from ship.json's groups.external, or App Store Connect).
remove takes people out of the group; with --everywhere, out of every group
and the app's TestFlight entirely.

  --group <name>  The group, by its name in App Store Connect
  --everywhere    remove: from every group and the app's TestFlight`;

const ACTIONS = ["list", "add", "remove"];

/** Apple's answer when someone who isn't on the team is added to an internal group. */
export const INTERNAL_TESTER_HINT =
  "Internal testers must be App Store Connect users: add them in Users and Access, or use an external group.";

// MARK: Pure parts

/** The addresses once each (ignoring case), in the order given. */
export function uniqueEmails(emails: string[]): string[] {
  const out: string[] = [];
  for (const email of emails.map((e) => e.trim()).filter(Boolean)) {
    if (!out.some((seen) => sameEmail(seen, email))) out.push(email);
  }
  return out;
}

/** A usage error when any address doesn't look like one. */
export function checkEmails(emails: string[], action: string) {
  if (!emails.length) {
    throw new ShipError("Pass one or more email addresses", "usage", `ship testers ${action} a@example.com`, undefined, 2);
  }
  const bad = emails.filter((email) => !isEmail(email));
  if (bad.length) {
    throw new ShipError(
      `${bad.length === 1 ? "That isn't an email address" : "These aren't email addresses"}: ${bad.join(", ")}`,
      "usage",
      `ship testers ${action} a@example.com b@example.com`,
      { invalid: bad },
      2,
    );
  }
}

/** Which of `emails` are among `testers` (ignoring case), and which aren't. */
export function matchTesters(testers: Tester[], emails: string[]): { found: { email: string; tester: Tester }[]; notFound: string[] } {
  const found: { email: string; tester: Tester }[] = [];
  const notFound: string[] = [];
  for (const email of emails) {
    const tester = testers.find((t) => sameEmail(t.email, email));
    if (tester) found.push({ email, tester });
    else notFound.push(email);
  }
  return { found, notFound };
}

/** Apple refused the tester itself (not the key, the rate, or a missing group). */
export const refusedTester = (error: unknown) => error instanceof AscError && [400, 409, 422].includes(error.status);

// MARK: Groups

/** The group `--group` names, else the first external one from ship.json or App Store Connect. */
function pickGroup(project: Project, groups: BetaGroup[], name: string | undefined): BetaGroup {
  const wanted = name ?? project.config.groups?.external?.[0];
  const group = wanted ? groupNamed(groups, wanted) : groups.find((g) => !g.isInternal);
  if (!group) {
    throw new ShipError(
      wanted ? `No TestFlight group called "${wanted}"` : "This app has no external TestFlight group",
      "no-group",
      groups.length ? `Groups: ${groups.map((g) => g.name).join(", ")}. Pass one with --group <name>.` : "Create one with `ship groups create <name>`.",
      { choices: groups.map((g) => g.name) },
    );
  }
  return group;
}

// MARK: Command

export async function testers(action: string, emails: string[], options: { app?: string; group?: string; everywhere?: boolean }) {
  if (!ACTIONS.includes(action)) {
    throw new ShipError(`Unknown testers action "${action}"`, "usage", "ship testers [list|add|remove] (see `ship testers --help`)", { choices: ACTIONS }, 2);
  }
  if (options.everywhere && action !== "remove") {
    throw new ShipError("--everywhere is for remove", "usage", "ship testers remove a@example.com --everywhere", undefined, 2);
  }
  if (options.everywhere && options.group !== undefined) {
    throw new ShipError("Pass --group or --everywhere, not both", "usage", "ship testers remove a@example.com --everywhere", { choices: ["--group", "--everywhere"] }, 2);
  }
  if (options.group !== undefined && !options.group.trim()) {
    throw new ShipError("--group needs a name", "usage", 'ship testers --group "Beta testers"', undefined, 2);
  }
  const wanted = uniqueEmails(emails);
  if (action !== "list") checkEmails(wanted, action);
  if (action === "list" && emails.length) {
    throw new ShipError("ship testers list takes no email addresses", "usage", "To invite them: ship testers add a@example.com", undefined, 2);
  }

  const project = await loadProject({ app: options.app });
  const id = await appId(project);
  const groups = await betaGroups(id);

  if (action === "remove") return remove(project, id, groups, wanted, options);

  const group = pickGroup(project, groups, options.group);
  const invited: string[] = [];
  const failed: { email: string; message: string; code: string; hint?: string }[] = [];
  if (action === "add") {
    for (const email of wanted) {
      try {
        await addTester(group.id, email);
        invited.push(email);
        ui.ok(`Invited ${email} to ${group.name}`);
      } catch (error) {
        // One bad address shouldn't stop the rest.
        if (!(error instanceof ShipError)) throw error;
        const hint = group.isInternal && refusedTester(error) ? INTERNAL_TESTER_HINT : error.hint;
        failed.push({ email, message: error.message, code: error.code, ...(hint ? { hint } : {}) });
        ui.warn(`Couldn't invite ${email}: ${error.message}`);
        if (hint) ui.note(hint);
      }
    }
  }
  const list = await groupTesters(group.id);
  const result = action === "add" ? { group: group.name, testers: list, invited, failed } : { group: group.name, testers: list };
  ui.result(result, () => printTesters(group.name, list));
  if (failed.length) process.exitCode = 1;
}

async function remove(project: Project, id: string, groups: BetaGroup[], emails: string[], options: { group?: string; everywhere?: boolean }) {
  let group: BetaGroup | undefined;
  let removed: string[];
  let notFound: string[];
  if (options.everywhere) {
    const found = await Promise.all(emails.map(async (email) => ({ email, tester: await findTester(id, email) })));
    const ids = [...new Set(found.flatMap((f) => (f.tester ? [f.tester.id] : [])))];
    await removeTestersFromApp(id, ids);
    removed = found.filter((f) => f.tester).map((f) => f.email);
    notFound = found.filter((f) => !f.tester).map((f) => f.email);
    if (removed.length) ui.ok(`Removed ${removed.join(", ")} from TestFlight`);
    for (const email of notFound) ui.warn(`${email} isn't a tester of this app`);
    // The usual group's list afterwards, when there is one.
    try {
      group = pickGroup(project, groups, undefined);
    } catch {
      group = undefined;
    }
  } else {
    group = pickGroup(project, groups, options.group);
    const match = matchTesters(await groupTesters(group.id), emails);
    await removeTestersFromGroup(group.id, [...new Set(match.found.map((f) => f.tester.id))]);
    removed = match.found.map((f) => f.email);
    notFound = match.notFound;
    if (removed.length) ui.ok(`Removed ${removed.join(", ")} from ${group.name}`);
    for (const email of notFound) ui.warn(`${email} isn't in ${group.name}`);
    if (notFound.length) ui.note(`To take someone out of every group: ship testers remove ${notFound[0]} --everywhere`);
  }
  const list = group ? await groupTesters(group.id) : [];
  ui.result({ group: group?.name ?? null, removed, notFound, everywhere: Boolean(options.everywhere), testers: list }, () => {
    if (group) printTesters(group.name, list);
    else console.log(removed.length ? `Removed ${removed.length} tester${removed.length === 1 ? "" : "s"}.` : "Nobody was removed.");
  });
}

function printTesters(group: string, list: Tester[]) {
  if (!list.length) return console.log(`${group} has no testers yet.`);
  console.log(table([["EMAIL", "NAME", "STATE"], ...list.map((t) => [t.email, t.name, friendly(t.state)])]));
}

export const commands: Command[] = [
  {
    name: "testers",
    index: [{ section: "daily", label: "testers", summary: "List, invite, or remove testers" }],
    help: testersHelp,
    flags: { group: { type: "string" }, everywhere: { type: "boolean" } },
    run: (ctx) =>
      testers(ctx.args[0] ?? "list", ctx.args.slice(1), { app: ctx.app, group: stringFlag(ctx, "group"), everywhere: boolFlag(ctx, "everywhere") }),
  },
];
