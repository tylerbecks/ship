// ship beta and ship distribute: archive, upload, and send a build to TestFlight.

import { join, relative } from "node:path";
import { type Build, findBuild, listBuilds, numberingBuilds, setExemptEncryption } from "../asc/builds";
import { assertWritable } from "../asc/client";
import { addBuildToGroup, betaGroups, setWhatToTest, submitForBetaReview } from "../asc/testflight";
import { archive, buildPaths, checkBuildNumber, checkInfo, exportIPA, packageInfo, upload, withKeyFile } from "../build";
import { type NextBuild, aboveTrain, compareBuildOrder, isCounter, nextBuildNumber } from "../buildnumber";
import { type Project, loadProject, repoRoot } from "../config";
import { credentials } from "../credentials";
import {
  type Commit,
  type Tagging,
  buildCommits,
  buildTagMessage,
  claimBuild,
  commitSetting,
  drift,
  fetchBuildTags,
  hasOrigin,
  headCommit,
  releaseClaim,
  tagBuild,
  tagFor,
} from "../git";
import { type Command, boolFlag, checkArgs, stringFlag } from "../command";
import { checkNotesStdin, whatToTest } from "../notes";
import { type AscPlatform, platformInfo } from "../platform";
import { ShipError, ui } from "../ui";
import { describeDuration, waitFor } from "../wait";
import { projectVersion } from "../version";
import { appId, friendly } from "./status";

export const betaHelp = `ship beta [--notes <text>] [--notes-file <path>] [--notes-from-git] [--external] [--build <n>] [--no-wait] [--dry-run] [--allow-dirty]

Ships a TestFlight build in one go:
  1. picks the next build number: one counter per app that never resets,
     like 1.0.1 (10), then 1.1 (11)
  2. archives a Release build and exports an App Store Connect .ipa
  3. checks the bundle id, build number, and export compliance key
  4. uploads it, waits for processing, and answers export compliance
  5. sets "What to Test" and adds it to the internal groups
  6. with --external, adds it to the external groups and submits it to
     Beta App Review (needed before the public link works)

It ships only committed code: before archiving, it tags the commit
testflight/<build> and pushes the tag, which claims the number (another
machine picks the next one) and tells \`ship status\` and git what each
build contains. A failed archive or upload gives the number back.

A number of 100,000 or more (like a timestamp) never feeds the counter. A
version that already has one keeps counting above it, with a warning;
\`ship version bump patch\` starts the short numbers.

Safe to re-run: a build that's already uploaded isn't uploaded again; use
\`ship distribute <build>\` to redo only steps 4 to 6.

"What to Test" is --notes, then the file, then the commit subjects since the
previous TestFlight build (--notes-from-git, or "beta": {"notesFromGit": true}
in ship.json when there's no --notes or --notes-file).

  --notes <text>       "What to Test" for testers
  --notes-file <path>  "What to Test" from a file (- reads stdin)
  --notes-from-git     Add the commit subjects since the previous build
  --external           Also send it to external testers
  --build <n>          Use this build number instead of the next one
  --no-wait            Stop after the upload; finish later with \`ship distribute\`
  --dry-run            Show the plan without building or uploading
  --allow-dirty        Ship uncommitted changes, or a folder with no commit, untagged`;

export interface BetaOptions {
  app?: string;
  notes?: string;
  notesFile?: string;
  notesFromGit?: boolean;
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
  const platform = platformInfo(project.platform);
  const local = await localVersion(project);
  const commit = await headCommit(project.root);
  // Claims from other machines and worktrees count, so fetch them first.
  if (commit) await fetchBuildTags(project.root);
  const picked = await pickBuild(project, id, { requested: options.build, version: local.version, local: local.build, head: commit && !commit.changes.length ? commit.sha : undefined });
  let build = picked.build;
  const existing = picked.existing;
  // A build that's already uploaded may not be HEAD, so only a new upload is tagged. An App
  // Playground's archive still rewrites Package.swift's bundleVersion after this snapshot; that line
  // is the build number the tag is named for, like CURRENT_PROJECT_VERSION for Xcode projects.
  const tagged = !existing && commit && !commit.changes.length;
  if (!existing) checkCommit(commit, Boolean(options.allowDirty));
  const notes = await whatToTest(project, { ...options, build, at: existing ? "tag" : "head" });
  const plan = {
    app: project.config.name,
    bundleId: project.config.bundleId,
    build,
    version: existing?.version ?? local.version ?? null,
    numbering: picked.numbering,
    upload: !existing,
    external: Boolean(options.external),
    notes: notes.text,
    notesSource: notes.source,
    notesFrom: notes.from,
    commit: commit?.sha ?? null,
    branch: commit?.branch ?? null,
    tag: tagged ? tagFor(build) : null,
    platform: project.platform,
  };
  const label = (number: string) => (plan.version ? `${plan.version} (${number})` : `build ${number}`);
  ui.ok(`Build ${plan.version ? label(build) : build}${existing ? " (already uploaded; skipping to distribution)" : picked.reclaimed ? " (claimed by an earlier run of this commit)" : ""}`);
  if (picked.floor) ui.warn(legacyWarning(project, picked.floor, build, plan.version));

  if (options.dryRun) {
    ui.result({ dryRun: true, plan }, () => {
      console.log(`Would ${existing ? "distribute" : "archive, upload, and distribute"} ${project.config.name} ${label(build)}.`);
      console.log(`Internal groups: yes. External groups and Beta App Review: ${options.external ? "yes" : "no"}.`);
      if (plan.tag) console.log(`Would tag ${commit!.short} as ${plan.tag}.`);
      if (plan.notes) console.log(`What to Test:\n${indent(plan.notes)}`);
    });
    return;
  }
  // Before archiving for minutes, not at the upload.
  assertWritable(existing ? `distribute build ${build}` : `upload build ${build}`);

  let tag: Tagging | null = null;
  if (!existing) {
    let claim: (Tagging & { created: boolean }) | null = null;
    if (tagged) {
      const message = (number: string) =>
        buildTagMessage({
          app: project.config.name,
          bundleId: project.config.bundleId,
          version: plan.version ?? undefined,
          build: number,
          platform: project.platform,
          platformTitle: platform.title,
          branch: commit.branch,
        });
      ({ build, claim } = await claimNumber(project, build, commit, message, Boolean(options.build)));
      plan.build = build;
      plan.tag = claim.tag;
    }
    try {
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
    } catch (error) {
      if (claim) await releaseClaim(project.root, claim);
      throw error;
    }
    // A claim that couldn't be pushed gets another try now the build is uploaded.
    if (claim && tagged) {
      const { created: _, ...tagging } = claim;
      tag = claim.pushed || !(await hasOrigin(project.root)) ? tagging : await tagCommit(project, build, commit);
    }
  }

  if (options.wait === false) {
    ui.result({ plan, tag, uploaded: true, distributed: false }, () => {
      console.log(`Uploaded ${label(build)}. When it's processed, run: ship distribute ${build}${options.external ? " --external" : ""}`);
    });
    return;
  }

  const result = await distribute(project, id, build, { ...options, notes: notes.text ?? undefined });
  ui.result({ plan, tag, ...result }, () => printDistribution(project, build, result));
}

const indent = (text: string) => text.replace(/^/gm, "  ");

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

/** How the next build number was picked. */
interface Picked extends NextBuild {
  /** The build App Store Connect already has under that number (from --build, or HEAD's tag). */
  existing?: Build;
  /** Whether the number is HEAD's claim from a run that didn't upload. */
  reclaimed?: boolean;
}

/**
 * The build number to ship: --build as given; HEAD's own claim from a run
 * that didn't finish (or its upload, when App Store Connect has it and it
 * didn't fail); otherwise the next number (see buildnumber.ts).
 */
async function pickBuild(
  project: Project,
  id: string,
  options: { requested?: string; version?: string; local?: string; head?: string },
): Promise<Picked> {
  const platform = platformInfo(project.platform).asc;
  const numbering = (build: string) => (isCounter(build) ? "counter" : "legacy");
  if (options.requested) {
    const existing = await findBuild(id, options.requested, platform, options.version);
    return { build: options.requested, numbering: numbering(options.requested), existing };
  }
  const tags = await buildCommits(project.root);
  const atHead = options.head
    ? [...tags]
        .filter(([, sha]) => sha === options.head)
        .map(([build]) => build)
        .sort(compareBuildOrder)
        .at(-1)
    : undefined;
  const found = atHead ? await findBuild(id, atHead, platform, options.version) : undefined;
  // A build that failed processing used up its number.
  if (atHead && found && found.processingState !== "FAILED" && found.processingState !== "INVALID") {
    return { build: atHead, numbering: numbering(atHead), existing: found };
  }
  const { builds, train } = await numberingBuilds(id, platform, options.version);
  // HEAD's number from another platform's build, or a run that didn't upload, only if this platform can take it.
  if (atHead && !found && aboveTrain(atHead, train)) return { build: atHead, numbering: numbering(atHead), reclaimed: true };
  return nextBuildNumber({ builds, train, tags: [...tags.keys()], local: options.local });
}

/** Why the number is still a big one, and how to get short ones. */
function legacyWarning(project: Project, floor: string, build: string, version: string | null): string {
  if (project.platform === "macos") {
    return `macOS build numbers have to keep rising, and this app already has build ${floor}, so this one is ${build}`;
  }
  return `${version ?? "This version"} already has build ${floor}, so this one is ${build}. \`ship version bump patch\` starts short build numbers in the next version`;
}

/**
 * Claims `build` with HEAD's testflight/<build> tag, moving to the next
 * number while another commit has it (up to 3 tries). A --build number that's
 * taken fails instead.
 */
async function claimNumber(
  project: Project,
  build: string,
  commit: Commit,
  message: (build: string) => string,
  requested: boolean,
): Promise<{ build: string; claim: Tagging & { created: boolean } }> {
  for (let attempt = 1; ; attempt++) {
    const claim = await claimBuild(project.root, build, commit.sha, message(build));
    if (!claim.taken) {
      for (const warning of claim.warnings) ui.warn(warning);
      if (!claim.warnings.length) ui.ok(`Tagged ${commit.short} as ${claim.tag} and pushed it`);
      const { taken: _, ...owned } = claim;
      return { build, claim: owned };
    }
    if (requested || attempt === 3) {
      throw new ShipError(
        `Build ${build} is already claimed: ${claim.tag} points at ${claim.by.slice(0, 7)}`,
        "build-taken",
        requested ? "Pass another --build, or leave it out and ship picks the next free number." : "Other uploads keep taking the next numbers. Run ship beta again.",
        { build, tag: claim.tag, commit: claim.by },
      );
    }
    const next = String(Number.parseInt(build, 10) + 1);
    ui.note(`${claim.tag} is taken by ${claim.by.slice(0, 7)}; trying ${next}`);
    build = next;
  }
}

async function tagCommit(project: Project, build: string, commit: Commit): Promise<Tagging> {
  const tag = await tagBuild(project.root, build, commit.sha);
  for (const warning of tag.warnings) ui.warn(warning);
  if (!tag.warnings.length) ui.ok(`Tagged ${commit.short} as ${tag.tag}${tag.pushed ? " and pushed it" : ""}`);
  return tag;
}

export const distributeHelp = `ship distribute <build> [--notes <text>] [--notes-file <path>] [--notes-from-git] [--external]

Finishes a build that's already uploaded: waits for processing, answers
export compliance, sets "What to Test", adds it to the internal groups, and
with --external, the external groups plus Beta App Review.

  --notes <text>       "What to Test" for testers
  --notes-file <path>  "What to Test" from a file (- reads stdin)
  --notes-from-git     Add the commit subjects since the previous build, up to
                       the build's testflight/<build> tag
  --external           Also send it to external testers`;

export async function distributeCommand(build: string, options: Omit<BetaOptions, "build" | "dryRun">) {
  const project = await loadProject({ app: options.app });
  const id = await appId(project);
  const notes = await whatToTest(project, { ...options, build, at: "tag" });
  const result = await distribute(project, id, build, { ...options, notes: notes.text ?? undefined });
  ui.result({ buildNumber: build, ...result, whatToTest: notes.text, notesSource: notes.source, notesFrom: notes.from }, () =>
    printDistribution(project, build, result),
  );
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

/** How long ship waits for a build to process unless --timeout says otherwise. */
export const PROCESSING_TIMEOUT_MS = 60 * 60_000;

/**
 * Waits for App Store Connect to receive and process a build (usually 5 to
 * 30 minutes). `version` narrows it to that version's build, since two
 * versions can share a build number. Times out with processing-timeout
 * (exit 7); `later` is the command that picks up from there.
 */
export async function waitForProcessing(
  id: string,
  number: string,
  platform: AscPlatform,
  options: { timeoutMs?: number; later?: string; version?: string } = {},
): Promise<Build> {
  ui.step(`Waiting for App Store Connect to process build ${number}`);
  const timeoutMs = options.timeoutMs ?? PROCESSING_TIMEOUT_MS;
  const build = await waitFor<Build>({
    everyMs: 20_000,
    timeoutMs,
    progress: (state) => ui.note(friendly(state) || state),
    check: async () => {
      const [found] = await listBuilds(id, { number, version: options.version, platform, limit: 1 });
      if (found?.processingState === "VALID") return { done: true, value: found };
      if (found && (found.processingState === "FAILED" || found.processingState === "INVALID")) {
        throw new ShipError(`App Store Connect couldn't process build ${number}`, "processing-failed", "Check the email from App Store Connect for the reason.");
      }
      return { done: false, state: found?.processingState ?? "not received yet" };
    },
    timedOut: (state) =>
      new ShipError(
        `Build ${number} is still processing after ${describeDuration(timeoutMs)}`,
        "processing-timeout",
        `Finish later with: ${options.later ?? `ship distribute ${number}`}`,
        { build: number, processingState: state || null },
      ),
  });
  ui.ok("Processed");
  return build;
}

function printDistribution(project: Project, build: string, result: Distribution) {
  const name = result.build.version ? `${result.build.version} (${build})` : `build ${build}`;
  console.log(`${project.config.name} ${name}: ${friendly(result.build.internalState) || "processed"}.`);
  if (result.groups.length) console.log(`Groups: ${result.groups.join(", ")}`);
  if (result.submittedForReview) console.log("Waiting for Beta App Review; external testers get it once approved.");
  for (const link of result.publicLinks) console.log(`Public link: ${link}`);
  for (const note of result.notes) console.log(note);
}

/** The version and build number the project itself says, if it says them. */
async function localVersion(project: Project): Promise<{ version?: string; build?: string }> {
  try {
    const { version, build } = await projectVersion(project);
    return { version, build };
  } catch {
    return {};
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
      "notes-file": { type: "string" },
      "notes-from-git": { type: "boolean" },
      external: { type: "boolean" },
      build: { type: "string" },
      "no-wait": { type: "boolean" },
      "dry-run": { type: "boolean" },
      "allow-dirty": { type: "boolean" },
    },
    maxArgs: 0,
    run: (ctx) => {
      checkNotesStdin(stringFlag(ctx, "notes-file"));
      return beta({
        app: ctx.app,
        notes: stringFlag(ctx, "notes"),
        notesFile: stringFlag(ctx, "notes-file"),
        notesFromGit: boolFlag(ctx, "notes-from-git"),
        external: boolFlag(ctx, "external"),
        build: optionalBuild(stringFlag(ctx, "build")),
        wait: !boolFlag(ctx, "no-wait"),
        dryRun: boolFlag(ctx, "dry-run"),
        allowDirty: boolFlag(ctx, "allow-dirty"),
      });
    },
  },
  {
    name: "distribute",
    index: [{ section: "daily", label: "distribute <n>", summary: "Finish an uploaded build (groups, review)" }],
    help: distributeHelp,
    flags: { notes: { type: "string" }, "notes-file": { type: "string" }, "notes-from-git": { type: "boolean" }, external: { type: "boolean" } },
    run: (ctx) => {
      const build = ctx.args[0];
      if (!build) {
        throw new ShipError("Which build? ship distribute <build>", "usage", "`ship status` lists the build numbers.", undefined, 2);
      }
      checkArgs(ctx.args, 1, "ship distribute takes one build number", `Distribute one build at a time: ship distribute ${build}`);
      checkNotesStdin(stringFlag(ctx, "notes-file"));
      return distributeCommand(checkBuildNumber(build), {
        app: ctx.app,
        notes: stringFlag(ctx, "notes"),
        notesFile: stringFlag(ctx, "notes-file"),
        notesFromGit: boolFlag(ctx, "notes-from-git"),
        external: boolFlag(ctx, "external"),
      });
    },
  },
];
