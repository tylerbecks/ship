// ship testers: list and invite TestFlight testers.

import { addTester, betaGroups, groupTesters } from "../asc/api";
import { type Command, stringFlag } from "../command";
import { loadProject } from "../config";
import { ShipError, table, ui } from "../ui";
import { appId, friendly } from "./status";

export const testersHelp = `ship testers [list] [--group <name>]
ship testers add <email>... [--group <name>]

Lists or invites TestFlight testers. Without --group, uses the first
external group (from ship.json's groups.external, or App Store Connect).`;

export async function testers(action: string, emails: string[], options: { app?: string; group?: string }) {
  const project = await loadProject({ app: options.app });
  const id = await appId(project);
  const groups = await betaGroups(id);
  const name = options.group ?? project.config.groups?.external?.[0];
  const group = name ? groups.find((g) => g.name === name) : groups.find((g) => !g.isInternal);
  if (!group) {
    throw new ShipError(
      name ? `No TestFlight group called "${name}"` : "This app has no external TestFlight group",
      "no-group",
      groups.length ? `Groups: ${groups.map((g) => g.name).join(", ")}` : "Create one in App Store Connect → TestFlight.",
    );
  }
  if (action === "add") {
    if (!emails.length) throw new ShipError("Pass one or more email addresses", "usage", "ship testers add a@example.com", undefined, 2);
    for (const email of emails) {
      await addTester(group.id, email);
      ui.ok(`Invited ${email} to ${group.name}`);
    }
  }
  const list = await groupTesters(group.id);
  ui.result({ group: group.name, testers: list }, () => {
    if (!list.length) return console.log(`${group.name} has no testers yet.`);
    console.log(table([["EMAIL", "NAME", "STATE"], ...list.map((t) => [t.email, t.name, friendly(t.state)])]));
  });
}

export const commands: Command[] = [
  {
    name: "testers",
    index: [{ section: "daily", label: "testers [add]", summary: "List or invite testers" }],
    help: testersHelp,
    flags: { group: { type: "string" } },
    run: (ctx) => testers(ctx.args[0] ?? "list", ctx.args.slice(1), { app: ctx.app, group: stringFlag(ctx, "group") }),
  },
];
