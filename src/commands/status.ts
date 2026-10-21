// ship status: recent builds, their commits, TestFlight state, and groups.

import { lookupApp } from "../asc/apps";
import { type Build, recentBuilds } from "../asc/builds";
import { type BetaGroup, betaGroups } from "../asc/testflight";
import { type Project, loadApps, loadProject, projectFor } from "../config";
import { hasCredentials } from "../credentials";
import { type Since, buildCommits, describeSince, fetchBuildTags, sinceBuild } from "../git";
import { type Command, boolFlag, intFlag } from "../command";
import { ShipError, table, ui } from "../ui";

export const statusHelp = `ship status [--app <name>] [--all] [--limit <n>]

Shows the app's recent builds (the commit each came from, processing,
internal and external TestFlight state) and its TestFlight groups with their
public links. This is also what plain \`ship\` runs.

Commits come from the testflight/<build> tags \`ship beta\` pushes; status
fetches them from origin first. It also says how far the default branch has
moved since the newest tagged build.

  --all        Every app on this machine (see \`ship apps\`)
  --limit <n>  How many builds to show (default 5)`;

/** The app's App Store Connect id, from ship.json or by bundle id. */
export async function appId(project: Project): Promise<string> {
  if (project.config.ascAppId) return project.config.ascAppId;
  const app = await lookupApp(project.config.bundleId);
  if (!app) {
    throw new ShipError(
      `No App Store Connect app uses ${project.config.bundleId}`,
      "no-asc-app",
      "Create the app in App Store Connect (Apps → +), then run `ship init --force`.",
    );
  }
  return app.id;
}

export async function status(options: { app?: string; all?: boolean; limit?: number }) {
  if (!(await hasCredentials())) {
    throw new ShipError(
      "Status needs an App Store Connect API key",
      "no-credentials",
      "Set one up with `ship auth set` (see `ship auth --help`).",
    );
  }
  // With --all, an app whose ship.json is gone is skipped with a warning instead of failing the rest.
  const skipped: { name: string; root: string; reason: string }[] = [];
  const projects: Project[] = [];
  if (options.all) {
    for (const app of await loadApps()) {
      try {
        projects.push(await projectFor(app));
      } catch (error) {
        if (!(error instanceof ShipError)) throw error;
        skipped.push({ name: app.name, root: app.root, reason: error.message });
        ui.warn(`Skipping ${app.name}: ${error.message}`);
      }
    }
  } else {
    projects.push(await loadProject({ app: options.app }));
  }

  const results: { name: string; bundleId: string; appId: string; builds: TaggedBuild[]; groups: BetaGroup[]; since: Since | null }[] = [];
  for (const project of projects) {
    const id = await appId(project);
    const [builds, groups] = await Promise.all([recentBuilds(id, options.limit ?? 5), betaGroups(id), fetchBuildTags(project.root)]);
    const commits = await buildCommits(project.root);
    const tagged = builds.map((b) => ({ ...b, commit: commits.get(b.number) ?? null }));
    const newest = tagged.find((b) => b.commit);
    const since = newest ? ((await sinceBuild(project.root, newest.number, newest.commit!)) ?? null) : null;
    results.push({ name: project.config.name, bundleId: project.config.bundleId, appId: id, builds: tagged, groups, since });
  }

  ui.result({ apps: results, skipped }, () => {
    if (options.all && !results.length && !skipped.length) console.log("No apps yet. Run `ship init` in an app's repo.");
    for (const app of results) {
      if (results.length > 1) console.log(`\n${app.name} (${app.bundleId})`);
      printBuilds(app.builds);
      if (app.since) console.log(`\n${describeSince(app.since)}`);
      else if (app.builds.length && !app.builds.some((b) => b.commit)) {
        console.log("\nNo build is tagged with its commit yet. `ship beta` tags each upload testflight/<build>.");
      }
      printGroups(app.groups);
    }
  });
}

/** A build and the commit it was uploaded from, when it's tagged. */
type TaggedBuild = Build & { commit: string | null };

export function printBuilds(builds: TaggedBuild[]) {
  if (!builds.length) {
    console.log("No builds yet. Upload one with `ship beta`.");
    return;
  }
  console.log(
    table([
      ["BUILD", "VERSION", "COMMIT", "UPLOADED", "PROCESSING", "INTERNAL", "EXTERNAL"],
      ...builds.map((b) => [
        b.number,
        b.version ?? "",
        b.commit?.slice(0, 7) ?? "",
        new Date(b.uploadedDate).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
        b.expired ? "expired" : friendly(b.processingState),
        friendly(b.internalState),
        friendly(b.externalState),
      ]),
    ]),
  );
}

function printGroups(groups: BetaGroup[]) {
  if (!groups.length) return;
  console.log("");
  console.log(
    table([
      ["GROUP", "KIND", "PUBLIC LINK"],
      ...groups.map((g) => [g.name, g.isInternal ? "internal" : "external", g.publicLinkEnabled && g.publicLink ? g.publicLink : ""]),
    ]),
  );
}

/** READY_FOR_BETA_TESTING → "ready for beta testing". */
export const friendly = (state?: string) => (state ? state.toLowerCase().replaceAll("_", " ") : "");

export const commands: Command[] = [
  {
    name: "status",
    index: [
      { section: "daily", label: "", summary: "Same as ship status" },
      { section: "daily", label: "status", summary: "Recent builds, TestFlight state, groups, public links" },
    ],
    help: statusHelp,
    flags: { all: { type: "boolean" }, limit: { type: "string" } },
    run: (ctx) => status({ app: ctx.app, all: boolFlag(ctx, "all"), limit: intFlag(ctx, "limit", { min: 1, max: 200 }) ?? 5 }),
  },
];
