// ship beta and ship distribute: archive, upload, and send a build to TestFlight.

import { join, relative } from "node:path";
import { type Build, findBuild, highestBuildNumber, setExemptEncryption } from "../asc/builds";
import { addBuildToGroup, betaGroups, setWhatToTest, submitForBetaReview } from "../asc/testflight";
import { archive, buildPaths, checkBuildNumber, checkInfo, exportIPA, packageInfo, upload, withKeyFile } from "../build";
import { type Project, loadProject, repoRoot } from "../config";
import { credentials } from "../credentials";
import { type Commit, type Tagging, commitSetting, drift, headCommit, tagBuild, tagFor } from "../git";
import { type Command, boolFlag, stringFlag } from "../command";
import { type AscPlatform, platformInfo } from "../platform";
import { ShipError, ui } from "../ui";
import { appSettings, packageSettings } from "../xcode";
import { appId, friendly } from "./status";

export const betaHelp = `ship beta [--notes <text>] [--external] [--build <n>] [--no-wait] [--dry-run] [--allow-dirty]

Ships a TestFlight build in one go:
  1. picks the next build number (one above the highest in App Store Connect)
  2. archives a Release build and exports an App Store Connect .ipa
  3. checks the bundle id, build number, and export compliance key
  4. uploads it, waits for processing, and answers export compliance
  5. sets "What to Test" and adds it to the internal groups
  6. with --external, adds it to the external groups and submits it to
     Beta App Review (needed before the public link works)

It ships only committed code: it tags the commit testflight/<build> and
pushes the tag, so \`ship status\` and git know what each build contains.

Safe to re-run: a build that's already uploaded isn't uploaded again; use
\`ship distribute <build>\` to redo only steps 4 to 6.

  --notes <text>   "What to Test" for testers
  --external       Also send it to external testers
  --build <n>      Use this build number instead of the next one
  --no-wait        Stop after the upload; finish later with \`ship distribute\`
  --dry-run        Show the plan without building or uploading
  --allow-dirty    Ship uncommitted changes, or a folder with no commit, untagged`;

export interface BetaOptions {
  app?: string;
  notes?: string;
  external?: boolean;
  build?: string;
  wait?: boolean;
  dryRun?: boolean;
  allowDirty?: boolean;
}

export async function beta(options: BetaOptions) {
  const project = await loadProject({ app: options.app });
  const creds = await credentials();
  const id = await appId(project);

  ui.step("Picking the build number");
  // App Store Connect is the source of truth; the project's own number only
  // matters before the first upload. (A failed run may have already bumped it.)
  const highest = await highestBuildNumber(id);
  const build = options.build ?? String(highest > 0 ? highest + 1 : ((await localBuild(project)) ?? 0) + 1);
  const platform = platformInfo(project.platform);
  const existing = await findBuild(id, build, platform.asc);
  const commit = await headCommit(project.root);
  // A build that's already uploaded may not be HEAD, so only a new upload is tagged. An App
  // Playground's archive still rewrites Package.swift's bundleVersion after this snapshot; that line
  // is the build number the tag is named for, like CURRENT_PROJECT_VERSION for Xcode projects.
  const tagged = !existing && commit && !commit.changes.length;
  if (!existing) checkCommit(commit, Boolean(options.allowDirty));
  const plan = {
    app: project.config.name,
    bundleId: project.config.bundleId,
    build,
    upload: !existing,
    external: Boolean(options.external),
    notes: options.notes ?? null,
    commit: commit?.sha ?? null,
    branch: commit?.branch ?? null,
    tag: tagged ? tagFor(build) : null,
    platform: project.platform,
  };
  ui.ok(`Build ${build}${existing ? " (already uploaded; skipping to distribution)" : ""}`);

  if (options.dryRun) {
    ui.result({ dryRun: true, plan }, () => {
      console.log(`Would ${existing ? "distribute" : "archive, upload, and distribute"} ${project.config.name} build ${build}.`);
      console.log(`Internal groups: yes. External groups and Beta App Review: ${options.external ? "yes" : "no"}.`);
      if (plan.tag) console.log(`Would tag ${commit!.short} as ${plan.tag}.`);
    });
    return;
  }

  let tag: Tagging | null = null;
  if (!existing) {
    await withKeyFile(creds, async (key) => {
      ui.step(`Archiving ${project.config.scheme} (Release, build ${build})`);
      await archive(project, build, creds, key, commit && commitSetting(commit));
      ui.ok("Archived");
      ui.step(`Exporting the App Store Connect ${platform.package}`);
      const ipa = await exportIPA(project, build, creds, key);
      ui.ok(`Exported ${ipa}`);

      const checks = checkInfo(await packageInfo(ipa, buildPaths(project, build).archive), { bundleId: project.config.bundleId, build });
      for (const check of checks) (check.ok ? ui.ok : ui.warn).call(ui, check.message);
      const blocking = checks.slice(0, 2).filter((c) => !c.ok);
      if (blocking.length) {
        throw new ShipError("The built app doesn't match what ship expected", "bad-build", blocking.map((c) => c.message).join("\n  "));
      }
      // The archive read the checkout over several minutes; another session committing or editing in
      // it meanwhile would make the tag name a commit the build doesn't match.
      if (tagged) {
        const changed = drift(commit, await headCommit(project.root), await rewrittenPaths(project));
        if (changed) {
          throw new ShipError(
            `The checkout changed while archiving (${changed})`,
            "checkout-changed",
            "Nothing was uploaded. Once those changes are committed or gone, run ship beta again.",
          );
        }
      }

      ui.step("Uploading to App Store Connect");
      await upload(project, build, ipa, creds, key!);
      ui.ok("Uploaded");
    });
    if (tagged) tag = await tagCommit(project, build, commit);
  }

  if (options.wait === false) {
    ui.result({ plan, tag, uploaded: true, distributed: false }, () => {
      console.log(`Uploaded build ${build}. When it's processed, run: ship distribute ${build}${options.external ? " --external" : ""}`);
    });
    return;
  }

  const result = await distribute(project, id, build, options);
  ui.result({ plan, tag, ...result }, () => printDistribution(project, build, result));
}

/** Files the archive itself rewrites: an App Playground's Package.swift gets the build number. */
async function rewrittenPaths(project: Project): Promise<string[]> {
  if (project.config.kind !== "swiftpm") return [];
  return [relative(await repoRoot(project.root), join(project.projectPath, "Package.swift"))];
}

/** Stops an upload that no commit could describe (uncommitted changes, or no commit at all) unless --allow-dirty. */
export function checkCommit(commit: Commit | undefined, allowDirty: boolean) {
  if (!commit) {
    if (!allowDirty) {
      throw new ShipError(
        "There's no commit to tag the build with",
        "no-commit",
        "Ship from a git repo with at least one commit (git init, then commit), or pass --allow-dirty to ship it untagged.",
      );
    }
    ui.warn("Not in a git repo with a commit; the build won't be tagged");
    return;
  }
  if (commit.changes.length) {
    if (!allowDirty) {
      throw new ShipError(
        `There ${commit.changes.length === 1 ? "is 1 uncommitted change" : `are ${commit.changes.length} uncommitted changes`}`,
        "uncommitted-changes",
        `Commit or stash them, so the build matches a commit it can be tagged with. To ship them anyway, untagged, pass --allow-dirty.\n  ${commit.changes.slice(0, 8).join("\n  ")}`,
        { changes: commit.changes },
      );
    }
    ui.warn(`Shipping uncommitted changes on top of ${commit.short}; the build won't be tagged`);
  }
  if (commit.defaultBranch && !commit.onDefaultBranch) {
    ui.warn(`${commit.short} (${commit.branch ?? "detached HEAD"}) isn't on ${commit.defaultBranch} yet`);
  }
}

async function tagCommit(project: Project, build: string, commit: Commit): Promise<Tagging> {
  const tag = await tagBuild(project.root, build, commit.sha);
  for (const warning of tag.warnings) ui.warn(warning);
  if (!tag.warnings.length) ui.ok(`Tagged ${commit.short} as ${tag.tag}${tag.pushed ? " and pushed it" : ""}`);
  return tag;
}

export const distributeHelp = `ship distribute <build> [--notes <text>] [--external]

Finishes a build that's already uploaded: waits for processing, answers
export compliance, sets "What to Test", adds it to the internal groups, and
with --external, the external groups plus Beta App Review.`;

export async function distributeCommand(build: string, options: Omit<BetaOptions, "build" | "dryRun">) {
  const project = await loadProject({ app: options.app });
  const id = await appId(project);
  const result = await distribute(project, id, build, options);
  ui.result({ buildNumber: build, ...result }, () => printDistribution(project, build, result));
}

interface Distribution {
  build: Build;
  groups: string[];
  submittedForReview: boolean;
  publicLinks: string[];
  notes: string[];
}

async function distribute(project: Project, id: string, number: string, options: { notes?: string; external?: boolean }): Promise<Distribution> {
  const platform = platformInfo(project.platform).asc;
  const build = await waitForProcessing(id, number, platform);
  const notes: string[] = [];

  if (build.usesNonExemptEncryption == null) {
    ui.step("Answering export compliance (exempt: only Apple's encryption)");
    await setExemptEncryption(build.id);
    ui.ok("Export compliance answered");
  }
  if (options.notes) {
    await setWhatToTest(build.id, options.notes);
    ui.ok("Set What to Test");
  }

  const groups = await betaGroups(id);
  const wanted = (internal: boolean) => {
    const names = internal ? project.config.groups?.internal : project.config.groups?.external;
    return groups.filter((g) => g.isInternal === internal && (!names || names.includes(g.name)));
  };
  const targets = [...wanted(true), ...(options.external ? wanted(false) : [])];
  if (!targets.length) notes.push(options.external ? "No TestFlight groups to add it to. Create them in App Store Connect." : "No internal TestFlight groups yet.");
  const added: string[] = [];
  for (const group of targets) {
    if (group.automatic) {
      added.push(group.name);
      ui.ok(`${group.name} gets every build automatically`);
      continue;
    }
    try {
      await addBuildToGroup(group.id, build.id);
      added.push(group.name);
      ui.ok(`Added to ${group.name}`);
    } catch (error) {
      // Groups with automatic distribution may already have it.
      if (error instanceof ShipError && error.code === "api-409") added.push(group.name);
      else throw error;
    }
  }

  let submittedForReview = false;
  if (options.external && targets.some((g) => !g.isInternal)) {
    try {
      ui.step("Submitting to Beta App Review");
      await submitForBetaReview(build.id);
      submittedForReview = true;
      ui.ok("Submitted to Beta App Review (usually under a day)");
    } catch (error) {
      if (error instanceof ShipError && error.code === "api-409") {
        notes.push("Already submitted to Beta App Review.");
      } else throw error;
    }
  }

  const publicLinks = groups.filter((g) => !g.isInternal && g.publicLinkEnabled && g.publicLink).map((g) => g.publicLink!);
  return { build: (await findBuild(id, number, platform)) ?? build, groups: added, submittedForReview, publicLinks, notes };
}

/** Waits for App Store Connect to receive and process a build (usually 5 to 30 minutes). */
async function waitForProcessing(id: string, number: string, platform: AscPlatform): Promise<Build> {
  ui.step(`Waiting for App Store Connect to process build ${number}`);
  const deadline = Date.now() + 60 * 60 * 1000;
  let last = "";
  while (Date.now() < deadline) {
    const build = await findBuild(id, number, platform);
    const state = build?.processingState ?? "not received yet";
    if (state !== last) {
      ui.note(friendly(state) || state);
      last = state;
    }
    if (build?.processingState === "VALID") {
      ui.ok("Processed");
      return build;
    }
    if (build && (build.processingState === "FAILED" || build.processingState === "INVALID")) {
      throw new ShipError(`App Store Connect couldn't process build ${number}`, "processing-failed", "Check the email from App Store Connect for the reason.");
    }
    await Bun.sleep(20_000);
  }
  throw new ShipError(`Build ${number} is still processing after an hour`, "processing-timeout", `Finish later with: ship distribute ${number}`);
}

function printDistribution(project: Project, build: string, result: Distribution) {
  console.log(`${project.config.name} build ${build}: ${friendly(result.build.internalState) || "processed"}.`);
  if (result.groups.length) console.log(`Groups: ${result.groups.join(", ")}`);
  if (result.submittedForReview) console.log("Waiting for Beta App Review; external testers get it once approved.");
  for (const link of result.publicLinks) console.log(`Public link: ${link}`);
  for (const note of result.notes) console.log(note);
}

/** The build number the project itself says, if it says one. */
async function localBuild(project: Project): Promise<number | undefined> {
  try {
    const value =
      project.config.kind === "swiftpm"
        ? (await packageSettings(project.projectPath)).build
        : (await appSettings({ kind: project.config.kind, path: project.projectPath }, project.config.scheme, project.platform)).build;
    const number = Number.parseInt(value ?? "", 10);
    return Number.isFinite(number) ? number : undefined;
  } catch {
    return undefined;
  }
}


const optionalBuild = (value: string | undefined) => (value === undefined ? undefined : checkBuildNumber(value));

export const commands: Command[] = [
  {
    name: "beta",
    index: [{ section: "daily", label: "beta", summary: "Next build number → archive → upload → TestFlight" }],
    help: betaHelp,
    flags: {
      notes: { type: "string" },
      external: { type: "boolean" },
      build: { type: "string" },
      "no-wait": { type: "boolean" },
      "dry-run": { type: "boolean" },
      "allow-dirty": { type: "boolean" },
    },
    run: (ctx) =>
      beta({
        app: ctx.app,
        notes: stringFlag(ctx, "notes"),
        external: boolFlag(ctx, "external"),
        build: optionalBuild(stringFlag(ctx, "build")),
        wait: !boolFlag(ctx, "no-wait"),
        dryRun: boolFlag(ctx, "dry-run"),
        allowDirty: boolFlag(ctx, "allow-dirty"),
      }),
  },
  {
    name: "distribute",
    index: [{ section: "daily", label: "distribute <n>", summary: "Finish an uploaded build (groups, review)" }],
    help: distributeHelp,
    flags: { notes: { type: "string" }, external: { type: "boolean" } },
    run: (ctx) => {
      const build = ctx.args[0];
      if (!build) {
        throw new ShipError("Which build? ship distribute <build>", "usage", "`ship status` lists the build numbers.", undefined, 2);
      }
      return distributeCommand(checkBuildNumber(build), { app: ctx.app, notes: stringFlag(ctx, "notes"), external: boolFlag(ctx, "external") });
    },
  },
];
