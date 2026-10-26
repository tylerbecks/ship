// ship users: who's on the App Store Connect team, inviting people, and
// taking them off it.

import { type TeamMember, USER_ROLES, inviteUser, removeMember, teamMembers } from "../asc/users";
import { type Command, type Context, boolFlag, checkActionFlags, listFlag, stringFlag } from "../command";
import { loadProject } from "../config";
import { ShipError, table, ui } from "../ui";
import { isEmail } from "../store/check";
import { appId } from "./status";

export const usersHelp = `ship users [list]
ship users invite <email> --first <name> --last <name> --role <role>... [--apps <app>... | --all-apps] [--provisioning] [--dry-run]
ship users remove <email> [--dry-run]

The people on the App Store Connect team, and the invitations they haven't
accepted yet. invite emails someone an invitation; remove takes them off the
team, or cancels their invitation.

Roles: admin, app-manager, developer, marketing, sales, finance,
access-to-reports, customer-support, create-apps, and the cloud signing
ones (cloud-managed-developer-id, cloud-managed-app-distribution,
generate-individual-keys). Changing the team needs an Admin key.

  --first <name>   invite: their first name
  --last <name>    invite: their last name
  --role <role>    invite: a role; repeat for more
  --apps <app>     invite: only this app (a name from \`ship apps\`, a bundle id,
                   or an App Store Connect id); repeat for more
  --all-apps       invite: every app, now and later (the default without --apps)
  --provisioning   invite: let them manage certificates, devices, and profiles
  --dry-run        invite, remove: show what would change`;

const ACTIONS = ["list", "invite", "remove"];

const ACTION_FLAGS: Record<string, string[]> = {
  list: [],
  invite: ["first", "last", "role", "apps", "all-apps", "provisioning", "dry-run"],
  remove: ["dry-run"],
};

const usage = (message: string, hint: string, details?: Record<string, unknown>) => new ShipError(message, "usage", hint, details, 2);

/** A role as Apple spells it, from "app-manager", "app_manager", or "APP_MANAGER". */
export function parseRole(value: string): string {
  const role = value.trim().toUpperCase().replaceAll("-", "_");
  if ((USER_ROLES as readonly string[]).includes(role)) return role;
  if (role === "ACCOUNT_HOLDER") throw usage("There's one Account Holder, and invitations can't make another", "Pick another role, like --role admin.");
  const choices = USER_ROLES.map((r) => r.toLowerCase().replaceAll("_", "-"));
  throw usage(`"${value}" isn't a role`, `Pick from: ${choices.join(", ")}`, { choices });
}

const roleText = (roles: string[]) => roles.map((role) => role.toLowerCase().replaceAll("_", " ")).join(", ");

/** The member with this email, ignoring case, or an error listing the team. */
export function findMember(members: TeamMember[], email: string): TeamMember {
  const member = members.find((m) => m.email.toLowerCase() === email.trim().toLowerCase());
  if (!member) {
    throw new ShipError(`Nobody on the team is ${email}`, "no-user", "`ship users` lists the team and the open invitations.", {
      choices: members.map((m) => m.email),
    });
  }
  return member;
}

async function users(ctx: Context) {
  const action = ctx.args[0] ?? "list";
  if (!ACTIONS.includes(action)) throw usage(`Unknown users action "${action}"`, "ship users [list|invite|remove] (see `ship users --help`)", { choices: ACTIONS });
  checkActionFlags(ctx, "users", action, ACTION_FLAGS);
  const emails = ctx.args.slice(1);
  if (action === "list" && emails.length) throw usage("ship users list takes no email addresses", "To invite someone: ship users invite <email> --first … --last … --role …");
  if (action !== "list" && emails.length !== 1) throw usage(`Pass one email: ship users ${action} <email>`, "`ship users` lists the team.");
  const dryRun = boolFlag(ctx, "dry-run");

  if (action === "list") {
    const members = await teamMembers();
    return ui.result({ users: members }, () => {
      console.log(
        table([
          ["EMAIL", "NAME", "ROLES", "APPS", "STATUS"],
          ...members.map((m) => [
            m.email,
            `${m.firstName} ${m.lastName}`.trim(),
            roleText(m.roles),
            m.allAppsVisible ? "all" : `${m.visibleApps.length}`,
            m.invited ? `invited${m.expirationDate ? `, until ${m.expirationDate.slice(0, 10)}` : ""}` : "active",
          ]),
        ]),
      );
    });
  }

  if (action === "invite") {
    const email = emails[0]!.trim();
    if (!isEmail(email)) throw usage(`That isn't an email address: ${email}`, "ship users invite ada@example.com --first Ada --last Lovelace --role developer");
    const firstName = stringFlag(ctx, "first")?.trim();
    const lastName = stringFlag(ctx, "last")?.trim();
    if (!firstName || !lastName) throw usage("An invitation needs a first and last name", `ship users invite ${email} --first Ada --last Lovelace --role developer`);
    const roles = [...new Set(listFlag(ctx, "role").map(parseRole))];
    if (!roles.length) throw usage("Which role? Pass --role", `For example: ship users invite ${email} --first ${firstName} --last ${lastName} --role developer`);
    const appNames = listFlag(ctx, "apps");
    if (appNames.length && boolFlag(ctx, "all-apps")) throw usage("Pass --apps or --all-apps, not both", "--apps limits them to those apps; --all-apps gives them every app.");
    // Each --apps value is anything --app takes; its App Store Connect id is what Apple wants.
    const visibleApps = await Promise.all(appNames.map(async (name) => appId(await loadProject({ app: name }))));
    const invite = { email, firstName, lastName, roles, allAppsVisible: !visibleApps.length, visibleApps, provisioningAllowed: boolFlag(ctx, "provisioning") };
    const members = await teamMembers();
    const existing = members.find((m) => m.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      throw new ShipError(
        `${email} is ${existing.invited ? "already invited" : "already on the team"}`,
        "user-exists",
        existing.invited ? `To send a new invitation, cancel this one first: ship users remove ${email}` : "Change their roles in App Store Connect → Users and Access.",
        { user: existing },
      );
    }
    if (dryRun) return ui.result({ invitation: invite, dryRun }, () => console.log(`Would invite ${email} as ${roleText(roles)} to ${visibleApps.length ? `${visibleApps.length} app${visibleApps.length === 1 ? "" : "s"}` : "every app"}.`));
    const invited = await inviteUser(invite);
    ui.ok(`Invited ${email}`);
    return ui.result({ invitation: invited, dryRun }, () => console.log("Apple emails them the invitation; it lasts a few weeks."));
  }

  // remove
  const member = findMember(await teamMembers(), emails[0]!);
  if (member.roles.includes("ACCOUNT_HOLDER")) throw new ShipError(`${member.email} is the Account Holder`, "account-holder", "The Account Holder can't be removed; transfer the role in App Store Connect first.");
  if (!dryRun) {
    await removeMember(member);
    ui.ok(member.invited ? `Canceled ${member.email}'s invitation` : `Removed ${member.email} from the team`);
  }
  ui.result({ removed: member, dryRun }, () => {
    if (dryRun) console.log(member.invited ? `Would cancel ${member.email}'s invitation.` : `Would remove ${member.email} from the team.`);
  });
}

export const commands: Command[] = [
  {
    name: "users",
    index: [{ section: "other", label: "users", summary: "The App Store Connect team: invite and remove people" }],
    help: usersHelp,
    flags: {
      first: { type: "string" },
      last: { type: "string" },
      role: { type: "string", multiple: true },
      apps: { type: "string", multiple: true },
      "all-apps": { type: "boolean" },
      provisioning: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    run: users,
  },
];
