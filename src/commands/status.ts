import { type BetaGroup, type Build, betaGroups, lookupApp, recentBuilds } from "../asc/api";
import { type Project, loadApps, loadProject } from "../config";
import { hasCredentials } from "../credentials";
import { ShipError, table, ui } from "../ui";

export const statusHelp = `ship status [--app <name>] [--all] [--limit <n>]

Shows the app's recent builds (processing, internal and external TestFlight
state, expiry) and its TestFlight groups with their public links. This is
also what plain \`ship\` runs.

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
  const projects = options.all
    ? await Promise.all((await loadApps()).map((app) => loadProject({ app: app.name })))
    : [await loadProject({ app: options.app })];

  const results: { name: string; bundleId: string; appId: string; builds: Build[]; groups: BetaGroup[] }[] = [];
  for (const project of projects) {
    const id = await appId(project);
    const [builds, groups] = await Promise.all([recentBuilds(id, options.limit ?? 5), betaGroups(id)]);
    results.push({ name: project.config.name, bundleId: project.config.bundleId, appId: id, builds, groups });
  }

  ui.result({ apps: results }, () => {
    for (const app of results) {
      if (results.length > 1) console.log(`\n${app.name} (${app.bundleId})`);
      printBuilds(app.builds);
      printGroups(app.groups);
    }
  });
}

export function printBuilds(builds: Build[]) {
  if (!builds.length) {
    console.log("No builds yet. Upload one with `ship beta`.");
    return;
  }
  console.log(
    table([
      ["BUILD", "VERSION", "UPLOADED", "PROCESSING", "INTERNAL", "EXTERNAL"],
      ...builds.map((b) => [
        b.number,
        b.version ?? "",
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
