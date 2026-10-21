// ship groups: TestFlight groups, their public links, and how many testers
// each has.

import {
  type BetaGroup,
  type GroupUpdate,
  type NewGroup,
  betaGroups,
  createGroup,
  deleteGroup,
  groupNamed,
  groupTesterCount,
  updateGroup,
} from "../asc/testflight";
import { type Command, type Context, boolFlag, intFlag } from "../command";
import { type Project, loadProject } from "../config";
import { ShipError, table, ui } from "../ui";
import { appId } from "./status";

export const groupsHelp = `ship groups
ship groups create <name> [--internal] [--all-builds] [--public-link] [--limit <n>] [--no-feedback]
ship groups rename <name> <new name>
ship groups link <name> on|off [--limit <n> | --no-limit]
ship groups delete <name>

Lists and manages TestFlight groups. External groups can have a public
link anyone can join, optionally capped at --limit testers. Internal
groups are for App Store Connect users and get builds without review;
with --all-builds they get every build automatically.

Names match without case; quote a name with spaces ("Beta testers").

  --internal      create: an internal group
  --all-builds    create: the internal group gets every build automatically
  --public-link   create: turn on the public link
  --limit <n>     The most testers the public link takes (1 to 10000)
  --no-limit      link on: no cap on the public link
  --no-feedback   create: testers can't send feedback from TestFlight`;

const ACTIONS = ["list", "create", "rename", "link", "delete"];

/** The flags each action takes; any other is a usage error rather than silently ignored. */
const ACTION_FLAGS: Record<string, string[]> = {
  list: [],
  create: ["internal", "all-builds", "public-link", "limit", "no-feedback"],
  rename: [],
  link: ["limit", "no-limit"],
  delete: [],
};

const LIMIT = { min: 1, max: 10_000 };

const usage = (message: string, hint: string, details?: Record<string, unknown>) => new ShipError(message, "usage", hint, details, 2);

// MARK: Pure parts

/** A group as `ship groups --json` shows it. Missing values are null, so every field is always there. */
export function groupJSON(group: BetaGroup, testers: number | null) {
  return {
    id: group.id,
    name: group.name,
    isInternal: group.isInternal,
    automatic: Boolean(group.automatic),
    publicLink: group.publicLink ?? null,
    publicLinkEnabled: Boolean(group.publicLinkEnabled),
    publicLinkLimit: group.publicLinkLimit ?? null,
    publicLinkLimitEnabled: Boolean(group.publicLinkLimitEnabled),
    feedbackEnabled: group.feedbackEnabled ?? null,
    testers,
    createdDate: group.createdDate ?? null,
  };
}

/** What `ship groups create` sends, from its flags. Usage errors for combinations Apple doesn't have. */
export function newGroup(
  name: string,
  options: { internal?: boolean; allBuilds?: boolean; publicLink?: boolean; limit?: number; noFeedback?: boolean },
): NewGroup {
  if (options.allBuilds && !options.internal) {
    throw usage("--all-builds is for internal groups", `ship groups create "${name}" --internal --all-builds`);
  }
  if (options.internal && (options.publicLink || options.limit !== undefined)) {
    throw usage("Internal groups have no public link", `Make an external group for a public link: ship groups create "${name}" --public-link`);
  }
  const group: NewGroup = { name, isInternalGroup: Boolean(options.internal) };
  if (options.internal) group.hasAccessToAllBuilds = Boolean(options.allBuilds);
  // A cap only means something with the link on, so --limit turns it on.
  if (options.publicLink || options.limit !== undefined) group.publicLinkEnabled = true;
  if (options.limit !== undefined) {
    group.publicLinkLimitEnabled = true;
    group.publicLinkLimit = options.limit;
  }
  if (options.noFeedback) group.feedbackEnabled = false;
  return group;
}

/** What `ship groups link <name> on|off` changes. */
export function linkUpdate(group: BetaGroup, state: string | undefined, options: { limit?: number; noLimit?: boolean }): GroupUpdate {
  if (state !== "on" && state !== "off") {
    throw usage(
      state ? `Pass on or off, not "${state}"` : "Pass on or off",
      `ship groups link "${group.name}" on (or off)`,
      { choices: ["on", "off"] },
    );
  }
  if (group.isInternal) {
    throw usage(`${group.name} is an internal group, and internal groups have no public link`, "Public links are for external groups. `ship groups` lists them.");
  }
  if (options.limit !== undefined && options.noLimit) {
    throw usage("Pass --limit or --no-limit, not both", `ship groups link "${group.name}" on --limit 100`, { choices: ["--limit", "--no-limit"] });
  }
  if (state === "off") {
    if (options.limit !== undefined || options.noLimit) {
      throw usage("--limit and --no-limit are for turning the link on", `ship groups link "${group.name}" on --limit 100`);
    }
    return { publicLinkEnabled: false };
  }
  const update: GroupUpdate = { publicLinkEnabled: true };
  if (options.limit !== undefined) Object.assign(update, { publicLinkLimitEnabled: true, publicLinkLimit: options.limit });
  if (options.noLimit) update.publicLinkLimitEnabled = false;
  return update;
}

/** The group called `name`, or an error naming the groups there are. */
export function findGroup(groups: BetaGroup[], name: string): BetaGroup {
  const group = groupNamed(groups, name);
  if (!group) {
    throw new ShipError(
      `No TestFlight group called "${name}"`,
      "no-group",
      groups.length ? `Groups: ${groups.map((g) => g.name).join(", ")}. \`ship groups\` lists them.` : "This app has no groups yet: ship groups create <name>",
      { choices: groups.map((g) => g.name) },
    );
  }
  return group;
}

/** Whether ship.json's groups (which `ship beta` adds builds to) name this group. */
export const inShipJSON = (project: Project, name: string) =>
  [...(project.config.groups?.internal ?? []), ...(project.config.groups?.external ?? [])].some((g) => g.toLowerCase() === name.toLowerCase());

/** The public link column: the link with its cap, "off", or nothing for an internal group. */
function linkCell(group: BetaGroup): string {
  if (group.isInternal) return "";
  if (!group.publicLinkEnabled) return "off";
  const cap = group.publicLinkLimitEnabled && group.publicLinkLimit ? ` (up to ${group.publicLinkLimit})` : "";
  return `${group.publicLink ?? "on"}${cap}`;
}

const kind = (group: BetaGroup) => (group.automatic ? "internal, every build" : group.isInternal ? "internal" : "external");

// MARK: Command

/** Usage errors for flags the action doesn't take, and for a name that's missing or split by spaces. */
function checkArgs(ctx: Context, action: string, names: number, usageLine: string) {
  const extra = Object.keys(ACTION_FLAGS).flatMap((a) => ACTION_FLAGS[a]!).filter((flag) => ctx.flags[flag] !== undefined && !ACTION_FLAGS[action]!.includes(flag));
  if (extra.length) throw usage(`--${extra[0]} isn't for ${action}`, `ship groups ${usageLine}`);
  const given = ctx.args.slice(1);
  if (given.length < names) throw usage(`Missing a group name: ship groups ${usageLine}`, `For example: ship groups ${usageLine.replace("<name>", '"Beta"')}`);
  if (given.length > names + (action === "link" ? 1 : 0)) {
    throw usage("Too many names", `Quote a name with spaces: ship groups ${usageLine.replace("<name>", '"Beta testers"')}`);
  }
  for (const name of given.slice(0, names)) if (!name.trim()) throw usage("A group name can't be empty", `ship groups ${usageLine}`);
}

export async function groups(ctx: Context) {
  const action = ctx.args[0] ?? "list";
  if (!ACTIONS.includes(action)) {
    throw usage(`Unknown groups action "${action}"`, "ship groups [create|rename|link|delete] (see `ship groups --help`)", { choices: ACTIONS });
  }
  const lines: Record<string, string> = {
    list: "",
    create: "create <name>",
    rename: "rename <name> <new name>",
    link: "link <name> on|off",
    delete: "delete <name>",
  };
  checkArgs(ctx, action, { list: 0, create: 1, rename: 2, link: 1, delete: 1 }[action]!, lines[action]!);
  const limit = intFlag(ctx, "limit", LIMIT);
  const [, name = "", second] = ctx.args;

  // Check what's checkable before talking to App Store Connect.
  const create =
    action === "create"
      ? newGroup(name.trim(), {
          internal: boolFlag(ctx, "internal"),
          allBuilds: boolFlag(ctx, "all-builds"),
          publicLink: boolFlag(ctx, "public-link"),
          limit,
          noFeedback: boolFlag(ctx, "no-feedback"),
        })
      : undefined;

  const project = await loadProject({ app: ctx.app });
  const id = await appId(project);
  const all = await betaGroups(id);

  if (action === "list") {
    const counts = await Promise.all(all.map((group) => groupTesterCount(group.id)));
    const list = all.map((group, i) => groupJSON(group, counts[i]!));
    return ui.result({ groups: list }, () => {
      if (!all.length) return console.log("No TestFlight groups yet. Make one with `ship groups create <name>`.");
      console.log(
        table([
          ["GROUP", "KIND", "TESTERS", "FEEDBACK", "PUBLIC LINK"],
          ...all.map((group, i) => [group.name, kind(group), String(counts[i]), group.feedbackEnabled === false ? "off" : "on", linkCell(group)]),
        ]),
      );
    });
  }

  if (create) {
    const taken = groupNamed(all, create.name);
    if (taken) {
      throw new ShipError(`There's already a group called "${taken.name}"`, "group-exists", "Pick another name, or change that one with `ship groups rename`.", {
        group: taken.name,
      });
    }
    ui.step(`Creating ${create.isInternalGroup ? "internal" : "external"} group ${create.name}`);
    const group = await createGroup(id, create);
    ui.ok(`Created ${group.name}`);
    return ui.result({ group: groupJSON(group, 0) }, () => printGroup(group));
  }

  const group = findGroup(all, name);
  const configured = inShipJSON(project, group.name);

  if (action === "rename") {
    const to = second!.trim();
    const taken = groupNamed(all, to);
    if (taken && taken.id !== group.id) {
      throw new ShipError(`There's already a group called "${taken.name}"`, "group-exists", "Pick another name.", { group: taken.name });
    }
    const updated = await updateGroup(group, { name: to });
    ui.ok(`Renamed ${group.name} to ${updated.name}`);
    if (configured) ui.warn(`ship.json's groups name "${group.name}": change it to "${updated.name}" so \`ship beta\` still finds it`);
    return ui.result({ group: groupJSON(updated, await groupTesterCount(group.id)) }, () => printGroup(updated));
  }

  if (action === "link") {
    const update = linkUpdate(group, second, { limit, noLimit: boolFlag(ctx, "no-limit") });
    const updated = await updateGroup(group, update);
    ui.ok(update.publicLinkEnabled ? `Turned on ${updated.name}'s public link` : `Turned off ${updated.name}'s public link`);
    return ui.result({ group: groupJSON(updated, await groupTesterCount(group.id)) }, () => printGroup(updated));
  }

  // delete
  await deleteGroup(group.id);
  ui.ok(`Deleted ${group.name}`);
  if (configured) ui.warn(`ship.json's groups still name "${group.name}": take it out so \`ship beta\` doesn't look for it`);
  ui.result({ deleted: group.name }, () => console.log(`Deleted ${group.name}.`));
}

function printGroup(group: BetaGroup) {
  console.log(`${group.name} (${kind(group)})`);
  if (!group.isInternal) console.log(`Public link: ${linkCell(group)}`);
  if (group.feedbackEnabled === false) console.log("Feedback: off");
}

export const commands: Command[] = [
  {
    name: "groups",
    index: [{ section: "testflight", label: "groups", summary: "TestFlight groups and public links" }],
    help: groupsHelp,
    flags: {
      internal: { type: "boolean" },
      "all-builds": { type: "boolean" },
      "public-link": { type: "boolean" },
      limit: { type: "string" },
      "no-limit": { type: "boolean" },
      "no-feedback": { type: "boolean" },
    },
    run: groups,
  },
];
