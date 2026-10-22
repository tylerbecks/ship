import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Build } from "../src/asc/builds";
import {
  type PreflightData,
  type ReviewSubmission,
  blockingFailures,
  checkBuild,
  phasedPercent,
  phasedTransition,
  pickSubmission,
  planVersion,
  preflightChecks,
} from "../src/asc/release";
import type { AppStoreVersion } from "../src/asc/versions";
import {
  ago,
  cancelReview,
  cancelTarget,
  desiredTiming,
  dryRunVerdict,
  parseRelease,
  pendingVersion,
  phasedCommand,
  prepare,
  releaseNow,
  releaseStatus,
  statusLines,
  commands as releaseCommands,
  submit,
} from "../src/commands/release";
import { commands as versionCommands } from "../src/commands/version";
import type { Project } from "../src/config";
import { ShipError, ui } from "../src/ui";
import {
  bumpVersion,
  checkVersion,
  compareVersions,
  marketingVersions,
  parseVersion,
  pickVersionFiles,
  setDisplayVersion,
  setMarketingVersion,
  versionSource,
  workspaceProjects,
  writeProjectVersion,
} from "../src/version";
import { type AscCall, jsonApi, mockAsc, noRetryDelay, resource, temp, testCredentials } from "./helpers";

function caught(body: () => unknown): ShipError {
  try {
    body();
  } catch (error) {
    if (error instanceof ShipError) return error;
    throw error;
  }
  throw new Error("expected a ShipError");
}

async function rejected(promise: Promise<unknown>): Promise<ShipError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ShipError) return error;
    throw error;
  }
  throw new Error("expected a ShipError");
}

// MARK: Version strings

describe("version strings", () => {
  test("parseVersion accepts one to three whole numbers", () => {
    expect(parseVersion("1")).toEqual([1]);
    expect(parseVersion(" 1.4 ")).toEqual([1, 4]);
    expect(parseVersion("1.4.2")).toEqual([1, 4, 2]);
    expect(parseVersion("1.4.2.1")).toBeUndefined();
    expect(parseVersion("1.4-beta")).toBeUndefined();
    expect(parseVersion("v1.4")).toBeUndefined();
    expect(parseVersion("")).toBeUndefined();
  });

  test("compareVersions compares numerically, missing parts as 0", () => {
    expect(compareVersions("1.10", "1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.4", "1.4.0")).toBe(0);
    expect(compareVersions("1.4", "1.4.1")).toBeLessThan(0);
    expect(compareVersions("2", "1.99.99")).toBeGreaterThan(0);
  });

  test("bumpVersion keeps the number of parts sensibly", () => {
    expect(bumpVersion("1.4", "minor")).toBe("1.5");
    expect(bumpVersion("1.4", "patch")).toBe("1.4.1");
    expect(bumpVersion("1.4.2", "major")).toBe("2.0.0");
    expect(bumpVersion("1.4", "major")).toBe("2.0");
    expect(bumpVersion("1.4.2", "minor")).toBe("1.5.0");
    expect(bumpVersion("1.4.2", "patch")).toBe("1.4.3");
    expect(bumpVersion("1", "major")).toBe("2.0");
    expect(bumpVersion("1", "minor")).toBe("1.1");
    expect(bumpVersion("1", "patch")).toBe("1.0.1");
    expect(bumpVersion("1.9", "minor")).toBe("1.10");
  });

  test("checkVersion is a usage error with an example", () => {
    const error = caught(() => checkVersion("1.4b"));
    expect(error.code).toBe("bad-version");
    expect(error.exitCode).toBe(2);
    expect(error.hint).toContain("--version 1.4");
    expect(checkVersion(" 2.0 ")).toBe("2.0");
  });
});

// MARK: Project files

const PBXPROJ = `
		A1 /* Debug */ = {
			buildSettings = {
				MARKETING_VERSION = 1.4;
				PRODUCT_BUNDLE_IDENTIFIER = com.example.lift;
			};
		};
		A2 /* Release */ = {
			buildSettings = {
				MARKETING_VERSION = "1.4";
			};
		};
		B1 /* Widget Release */ = {
			buildSettings = {
				MARKETING_VERSION = 1.3;
			};
		};
`;

describe("MARKETING_VERSION in project.pbxproj", () => {
  test("replaces every configuration, keeping quotes", () => {
    const edit = setMarketingVersion(PBXPROJ, "1.5");
    expect(edit.count).toBe(3);
    expect(edit.text).toContain("MARKETING_VERSION = 1.5;");
    expect(edit.text).toContain('MARKETING_VERSION = "1.5";');
    expect(edit.text).not.toContain("1.4");
    expect(edit.text).toContain("PRODUCT_BUNDLE_IDENTIFIER = com.example.lift;");
  });

  test("lists the distinct old values, so out-of-sync extensions are noticed", () => {
    expect(setMarketingVersion(PBXPROJ, "1.5").previous).toEqual(["1.4", "1.3"]);
    expect(marketingVersions(PBXPROJ)).toEqual(["1.4", "1.4", "1.3"]);
  });

  test("none present", () => {
    const edit = setMarketingVersion("buildSettings = { PRODUCT_NAME = Lift; };", "1.5");
    expect(edit.count).toBe(0);
    expect(edit.previous).toEqual([]);
  });

  test("leaves references to other settings alone", () => {
    const edit = setMarketingVersion("MARKETING_VERSION = $(APP_VERSION);\nMARKETING_VERSION = 2.0;", "2.1");
    expect(edit.count).toBe(1);
    expect(edit.references).toEqual(["$(APP_VERSION)"]);
    expect(edit.text).toBe("MARKETING_VERSION = $(APP_VERSION);\nMARKETING_VERSION = 2.1;");
    expect(marketingVersions("MARKETING_VERSION = $(APP_VERSION);")).toEqual([]);
  });

  test("doesn't touch similar settings", () => {
    const edit = setMarketingVersion("OLD_MARKETING_VERSION = 1.0;\nMARKETING_VERSION = 1.0;", "1.1");
    expect(edit.text).toBe("OLD_MARKETING_VERSION = 1.0;\nMARKETING_VERSION = 1.1;");
  });
});

describe("displayVersion in Package.swift", () => {
  test("replaces it", () => {
    const text = `.iOSApplication(\n  name: "Lift",\n  displayVersion: "1.0",\n  bundleVersion: "3"\n)`;
    const edit = setDisplayVersion(text, "1.1");
    expect(edit.count).toBe(1);
    expect(edit.previous).toEqual(["1.0"]);
    expect(edit.text).toContain('displayVersion: "1.1"');
    expect(edit.text).toContain('bundleVersion: "3"');
  });

  test("none present", () => {
    expect(setDisplayVersion('bundleVersion: "3"', "1.1").count).toBe(0);
  });
});

describe("workspaces", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version = "1.0">
   <FileRef location = "group:Lift.xcodeproj"></FileRef>
   <FileRef location = "group:Pods/Pods.xcodeproj"></FileRef>
   <Group location = "group:Modules" name = "Modules">
      <FileRef location = "group:Widgets/Widgets.xcodeproj"></FileRef>
      <FileRef location = "group:README.md"></FileRef>
   </Group>
   <FileRef location = "container:Shared/Shared.xcodeproj"></FileRef>
   <FileRef location = "self:"></FileRef>
</Workspace>`;

  test("lists the projects, with group paths nested and Pods left out", () => {
    expect(workspaceProjects(xml)).toEqual(["Lift.xcodeproj", "Modules/Widgets/Widgets.xcodeproj", "Shared/Shared.xcodeproj"]);
  });

  test("pickVersionFiles: the scheme's project plus any that match its version", () => {
    expect(
      pickVersionFiles([
        { path: "a", values: ["1.4", "1.4"], hasScheme: true },
        { path: "b", values: ["1.4"], hasScheme: false },
        { path: "c", values: ["9.0"], hasScheme: false },
        { path: "d", values: [], hasScheme: false },
      ]),
    ).toEqual(["a", "b"]);
    expect(pickVersionFiles([{ path: "only", values: ["2.0"], hasScheme: false }])).toEqual(["only"]);
    expect(pickVersionFiles([{ path: "none", values: [], hasScheme: true }])).toEqual([]);
  });
});

function fakeProject(kind: Project["config"]["kind"] = "xcodeproj", path = "Lift.xcodeproj"): Project {
  const root = temp();
  return {
    root,
    config: { name: "Lift", kind, path, scheme: "Lift", bundleId: "com.example.lift", ascAppId: "app1" },
    projectPath: join(root, path),
    workDir: join(root, ".ship"),
    storeDir: join(root, "appstore"),
    platform: "ios",
  };
}

describe("writing the project's version", () => {
  test("an .xcodeproj: every target changes, with a warning when they differed", async () => {
    const project = fakeProject();
    mkdirSync(project.projectPath, { recursive: true });
    const file = join(project.projectPath, "project.pbxproj");
    writeFileSync(file, PBXPROJ);
    const dry = await writeProjectVersion(project, "1.5", { dryRun: true });
    expect(dry.files).toEqual(["Lift.xcodeproj/project.pbxproj"]);
    expect(await Bun.file(file).text()).toBe(PBXPROJ);
    const change = await writeProjectVersion(project, "1.5", { from: "1.4" });
    expect(change).toMatchObject({ from: "1.4", to: "1.5", dryRun: false });
    expect(change.warnings[0]).toContain("1.4, 1.3");
    expect(marketingVersions(await Bun.file(file).text())).toEqual(["1.5", "1.5", "1.5"]);
    expect((await writeProjectVersion(project, "1.5")).files).toEqual([]);
  });

  test("no MARKETING_VERSION is an error that says how to add it", async () => {
    const project = fakeProject();
    mkdirSync(project.projectPath, { recursive: true });
    writeFileSync(join(project.projectPath, "project.pbxproj"), "buildSettings = { INFOPLIST_FILE = Info.plist; };");
    const error = await rejected(writeProjectVersion(project, "1.5"));
    expect(error.code).toBe("no-marketing-version");
    expect(error.hint).toContain("General tab");
  });

  test("an App Playground's Package.swift", async () => {
    const project = fakeProject("swiftpm", "Lift.swiftpm");
    mkdirSync(project.projectPath, { recursive: true });
    const file = join(project.projectPath, "Package.swift");
    writeFileSync(file, 'displayVersion: "1.0",\nbundleVersion: "3",');
    const change = await writeProjectVersion(project, "1.1");
    expect(change.files).toEqual(["Lift.swiftpm/Package.swift"]);
    expect(await Bun.file(file).text()).toContain('displayVersion: "1.1"');
  });

  test("a workspace: the project with the app's scheme, not Pods", async () => {
    const project = fakeProject("xcworkspace", "Lift.xcworkspace");
    mkdirSync(project.projectPath, { recursive: true });
    writeFileSync(
      join(project.projectPath, "contents.xcworkspacedata"),
      '<Workspace version = "1.0"><FileRef location = "group:Lift.xcodeproj"></FileRef><FileRef location = "group:Pods/Pods.xcodeproj"></FileRef><FileRef location = "group:Other.xcodeproj"></FileRef></Workspace>',
    );
    for (const [name, version] of [
      ["Lift.xcodeproj", "1.4"],
      ["Pods/Pods.xcodeproj", "1.0"],
      ["Other.xcodeproj", "3.0"],
    ] as const) {
      mkdirSync(join(project.root, name), { recursive: true });
      writeFileSync(join(project.root, name, "project.pbxproj"), `MARKETING_VERSION = ${version};`);
    }
    mkdirSync(join(project.root, "Lift.xcodeproj", "xcshareddata", "xcschemes"), { recursive: true });
    writeFileSync(join(project.root, "Lift.xcodeproj", "xcshareddata", "xcschemes", "Lift.xcscheme"), "<Scheme/>");
    const source = await versionSource(project);
    expect(source.files).toEqual([join(project.root, "Lift.xcodeproj", "project.pbxproj")]);
  });
});

// MARK: Release timing

describe("--release", () => {
  const now = new Date("2026-10-21T12:00:00Z");

  test("manual and auto", () => {
    expect(parseRelease("manual", now).timing).toEqual({ releaseType: "MANUAL", earliestReleaseDate: null });
    expect(parseRelease("auto", now).timing).toEqual({ releaseType: "AFTER_APPROVAL", earliestReleaseDate: null });
    expect(parseRelease("AFTER-APPROVAL", now).timing.releaseType).toBe("AFTER_APPROVAL");
  });

  test("a date is local midnight; a date and time is local", () => {
    const day = parseRelease("2026-11-03", now);
    expect(day.timing.releaseType).toBe("SCHEDULED");
    expect(day.timing.earliestReleaseDate).toBe(new Date("2026-11-03T00:00:00").toISOString().replace(".000Z", "Z"));
    expect(day.rounded).toBe(false);
    expect(parseRelease("2026-11-03T09:00", now).timing.earliestReleaseDate).toBe(new Date("2026-11-03T09:00:00").toISOString().replace(".000Z", "Z"));
    expect(parseRelease("2026-11-03T09:00Z", now).timing.earliestReleaseDate).toBe("2026-11-03T09:00:00Z");
  });

  test("rounds up to the hour, and says so", () => {
    const result = parseRelease("2026-11-03T09:30:00Z", now);
    expect(result.timing.earliestReleaseDate).toBe("2026-11-03T10:00:00Z");
    expect(result.rounded).toBe(true);
    expect(desiredTiming("2026-11-03T09:30:00Z", undefined, now).notes[0]).toContain("on the hour");
  });

  test("a past date is a usage error", () => {
    const error = caught(() => parseRelease("2026-10-01", now));
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain("passed");
    // Rounding up to the hour can't make a past time count: 11:30 rounds to 12:00, which is now.
    expect(caught(() => parseRelease("2026-10-21T11:30:00Z", now)).exitCode).toBe(2);
  });

  test("anything else names the choices", () => {
    const error = caught(() => parseRelease("tomorrow", now));
    expect(error.code).toBe("usage");
    expect(error.details?.choices).toContain("manual");
    expect(caught(() => parseRelease("2026-13-45", now)).code).toBe("usage");
    expect(caught(() => parseRelease("2027-02-30", now)).message).toContain("isn't a real date");
    expect(caught(() => parseRelease("2026-11-03T25:00", now)).message).toContain("isn't a real date");
  });

  test("zones with or without a colon", () => {
    expect(parseRelease("2026-11-03T09:00+0530", now).timing.earliestReleaseDate).toBe("2026-11-03T04:00:00Z");
    expect(parseRelease("2026-11-03T09:00-07:00", now).timing.earliestReleaseDate).toBe("2026-11-03T16:00:00Z");
    expect(parseRelease("2026-11-03 09:00Z", now).timing.earliestReleaseDate).toBe("2026-11-03T09:00:00Z");
  });

  test("app.json's release type is the default; SCHEDULED needs a date", () => {
    expect(desiredTiming(undefined, { release: { type: "MANUAL" } }, now).timing).toEqual({ releaseType: "MANUAL", earliestReleaseDate: null });
    const scheduled = desiredTiming(undefined, { release: { type: "SCHEDULED" } }, now);
    expect(scheduled.timing).toBeUndefined();
    expect(scheduled.notes[0]).toContain("--release <date>");
    expect(desiredTiming(undefined, undefined, now).timing).toBeUndefined();
    expect(desiredTiming("manual", { release: { type: "AFTER_APPROVAL" } }, now).timing?.releaseType).toBe("MANUAL");
  });

  test("ago", () => {
    expect(ago("2026-10-21T10:00:00Z", now)).toBe("2 hours ago");
    expect(ago("2026-10-21T11:59:00Z", now)).toBe("1 minute ago");
    expect(ago("2026-10-18T12:00:00Z", now)).toBe("3 days ago");
    expect(ago("2026-10-21T12:00:00Z", now)).toBe("just now");
  });
});

// MARK: Phased release

describe("phased release", () => {
  test("percent by day", () => {
    const percent = (day: number | null, state: "ACTIVE" | "COMPLETE" | "INACTIVE" = "ACTIVE") => phasedPercent({ state, currentDayNumber: day });
    expect([1, 2, 3, 4, 5, 6, 7].map((day) => percent(day))).toEqual([1, 2, 5, 10, 20, 50, 100]);
    expect(percent(null, "INACTIVE")).toBe(0);
    expect(percent(9)).toBe(100);
    expect(percent(3, "COMPLETE")).toBe(100);
  });

  test("allowed moves", () => {
    expect(phasedTransition("ACTIVE", "pause")).toBe("PAUSED");
    expect(phasedTransition("PAUSED", "resume")).toBe("ACTIVE");
    expect(phasedTransition("ACTIVE", "complete")).toBe("COMPLETE");
    expect(phasedTransition("PAUSED", "complete")).toBe("COMPLETE");
  });

  test("moves that aren't allowed say why", () => {
    const notStarted = caught(() => phasedTransition("INACTIVE", "pause"));
    expect(notStarted.code).toBe("bad-phased-state");
    expect(notStarted.message).toContain("hasn't started");
    expect(caught(() => phasedTransition("ACTIVE", "resume")).message).toContain("already running");
    expect(caught(() => phasedTransition("PAUSED", "pause")).message).toContain("paused");
    expect(caught(() => phasedTransition("COMPLETE", "complete")).message).toContain("complete");
    expect(caught(() => phasedTransition("INACTIVE", "complete")).hint).toContain("--no-phased");
  });
});

// MARK: Which version

const version = (id: string, versionString: string, state: string, extra: Partial<AppStoreVersion> = {}): AppStoreVersion => ({
  id,
  versionString,
  platform: "IOS",
  state,
  releaseType: "AFTER_APPROVAL",
  earliestReleaseDate: null,
  copyright: "2026 Example",
  createdDate: extra.createdDate,
  buildId: null,
  buildNumber: null,
  ...extra,
});

describe("planVersion", () => {
  const live = version("v13", "1.3", "READY_FOR_DISTRIBUTION");

  test("creates when nothing's being prepared", () => {
    expect(planVersion([live], "1.4")).toEqual({ action: "create" });
    expect(planVersion([], "1.0")).toEqual({ action: "create" });
  });

  test("reuses the version with that number", () => {
    const editable = version("v14", "1.4", "PREPARE_FOR_SUBMISSION");
    expect(planVersion([editable, live], "1.4")).toEqual({ action: "reuse", version: editable });
    const rejected = version("v14", "1.4", "REJECTED");
    expect(planVersion([rejected, live], "1.4").action).toBe("reuse");
  });

  test("another number being prepared: rename with --rename, else an error naming both ways", () => {
    const editable = version("v14", "1.4", "PREPARE_FOR_SUBMISSION");
    expect(planVersion([editable, live], "1.5", { rename: true })).toEqual({ action: "rename", version: editable });
    const error = caught(() => planVersion([editable, live], "1.5"));
    expect(error.code).toBe("version-in-progress");
    expect(error.hint).toContain("--rename");
    expect(error.hint).toContain("--version 1.4");
  });

  test("a version past changing is locked", () => {
    const waiting = version("v14", "1.4", "WAITING_FOR_REVIEW");
    expect(planVersion([waiting, live], "1.4")).toEqual({ action: "locked", version: waiting });
    expect(planVersion([live], "1.3")).toEqual({ action: "locked", version: live });
  });

  test("lower than what's live is an error with a bump hint", () => {
    const error = caught(() => planVersion([live], "1.2.9"));
    expect(error.code).toBe("version-too-low");
    expect(error.hint).toContain("ship version bump minor");
    expect(caught(() => planVersion([live], "1.3.0")).code).toBe("version-too-low");
  });

  test("another version with Apple is an error", () => {
    const pending = version("v14", "1.4", "PENDING_DEVELOPER_RELEASE");
    const error = caught(() => planVersion([pending, live], "1.5"));
    expect(error.code).toBe("version-in-flight");
    expect(error.hint).toContain("ship release go --version 1.4");
    expect(caught(() => planVersion([version("v14", "1.4", "IN_REVIEW"), live], "1.5")).hint).toContain("ship release cancel");
  });

  test("pendingVersion: the newest one that isn't live, only if newer than live", () => {
    expect(pendingVersion([version("v14", "1.4", "WAITING_FOR_REVIEW"), live])?.id).toBe("v14");
    expect(pendingVersion([live, version("v12", "1.2", "REPLACED_WITH_NEW_VERSION")])).toBeUndefined();
  });
});

// MARK: Which build

const build = (extra: Partial<Build> = {}): Build => ({
  id: "b37",
  number: "37",
  version: "1.4",
  platform: "IOS",
  uploadedDate: "2026-10-20T10:00:00Z",
  processingState: "VALID",
  expired: false,
  usesNonExemptEncryption: false,
  audience: "APP_STORE_ELIGIBLE",
  ...extra,
});

describe("checkBuild", () => {
  test("a good build", () => {
    expect(checkBuild(build(), "1.4")).toEqual({ needsCompliance: false });
  });

  test("compliance not answered yet", () => {
    expect(checkBuild(build({ usesNonExemptEncryption: null }), "1.4")).toEqual({ needsCompliance: true });
    expect(checkBuild(build({ usesNonExemptEncryption: undefined }), "1.4")).toEqual({ needsCompliance: true });
  });

  test("the wrong version", () => {
    const error = caught(() => checkBuild(build({ version: "1.3" }), "1.4"));
    expect(error.code).toBe("wrong-build-version");
    expect(error.hint).toContain("ship beta");
    expect(error.hint).toContain("must be 1.4");
  });

  test("TestFlight Internal Only", () => {
    const error = caught(() => checkBuild(build({ audience: "INTERNAL_ONLY" }), "1.4"));
    expect(error.code).toBe("build-internal-only");
    expect(error.hint).toContain("ship beta");
  });

  test("expired, and still processing", () => {
    expect(caught(() => checkBuild(build({ expired: true }), "1.4")).code).toBe("build-expired");
    const processing = caught(() => checkBuild(build({ processingState: "PROCESSING" }), "1.4"));
    expect(processing.code).toBe("build-not-ready");
    expect(processing.message).toContain("still processing");
  });
});

// MARK: Which submission

const submission = (id: string, state: string, items: { versionId: string; state?: string }[] = [], extra: Partial<ReviewSubmission> = {}): ReviewSubmission => ({
  id,
  state,
  platform: "IOS",
  submittedDate: null,
  versionForReviewId: null,
  items: items.map((item, i) => ({ id: `${id}-item${i}`, state: item.state ?? "READY_FOR_REVIEW", versionId: item.versionId })),
  ...extra,
});

describe("pickSubmission", () => {
  test("nothing open: create one", () => {
    expect(pickSubmission([], "v14", "1.4")).toEqual({ kind: "create" });
  });

  test("already in review", () => {
    const sub = submission("s1", "WAITING_FOR_REVIEW", [{ versionId: "v14" }]);
    expect(pickSubmission([sub], "v14", "1.4")).toEqual({ kind: "in-review", submission: sub });
  });

  test("reuses a draft, or one with unresolved issues", () => {
    const draft = submission("s1", "READY_FOR_REVIEW");
    expect(pickSubmission([draft], "v14", "1.4")).toEqual({ kind: "reuse", submission: draft });
    const rejected = submission("s2", "UNRESOLVED_ISSUES", [{ versionId: "v14", state: "REJECTED" }]);
    expect(pickSubmission([rejected], "v14", "1.4")).toEqual({ kind: "reuse", submission: rejected });
    expect(pickSubmission([draft], undefined, "1.4")).toEqual({ kind: "reuse", submission: draft });
  });

  test("another version with Apple is an error pointing at cancel", () => {
    const other = submission("s1", "IN_REVIEW", [{ versionId: "v13" }]);
    const error = caught(() => pickSubmission([other], "v14", "1.4"));
    expect(error.code).toBe("submission-in-progress");
    expect(error.hint).toContain("ship release cancel");
  });

  test("a draft holding another version is an error pointing at submitting it, not cancel", () => {
    const other = submission("s1", "READY_FOR_REVIEW", [{ versionId: "v13" }]);
    const versions = [version("v14", "1.4", "PREPARE_FOR_SUBMISSION"), version("v13", "1.3", "PREPARE_FOR_SUBMISSION")];
    const error = caught(() => pickSubmission([other], "v14", "1.4", versions));
    expect(error).toMatchObject({ code: "submission-has-other-version", message: "A draft submission holds version 1.3", details: { version: "1.3" } });
    expect(error.hint).toBe("Submit that version first with `ship release submit --version 1.3`, or remove it from the draft in App Store Connect (App Review).");
    // ship release cancel refuses a draft, so the hint can't send you there.
    expect(error.hint).not.toContain("cancel");
    // A rejected one can be canceled.
    const rejected = caught(() => pickSubmission([submission("s2", "UNRESOLVED_ISSUES", [{ versionId: "v13" }])], "v14", "1.4", versions));
    expect(rejected.hint).toContain("ship release cancel --version 1.3");
    expect(cancelTarget([submission("s2", "UNRESOLVED_ISSUES", [{ versionId: "v13" }])], versions, versions[1]).id).toBe("s2");
    // A removed item doesn't count.
    const removed = submission("s1", "READY_FOR_REVIEW", [{ versionId: "v13", state: "REMOVED" }]);
    expect(pickSubmission([removed], "v14", "1.4").kind).toBe("reuse");
  });
});

describe("cancelTarget", () => {
  const versions = [version("v15", "1.5", "PREPARE_FOR_SUBMISSION"), version("v14", "1.4", "WAITING_FOR_REVIEW")];

  test("the one with App Review over a draft that comes first", () => {
    const draft = submission("draft", "READY_FOR_REVIEW", [{ versionId: "v15" }]);
    const waiting = submission("s14", "WAITING_FOR_REVIEW", [{ versionId: "v14" }]);
    expect(cancelTarget([draft, waiting], versions).id).toBe("s14");
  });

  test("a rejected one when nothing's in review", () => {
    expect(cancelTarget([submission("r", "UNRESOLVED_ISSUES", [{ versionId: "v14" }])], versions).id).toBe("r");
  });

  test("only a draft: nothing to cancel, and the hint says so", () => {
    expect(() => cancelTarget([submission("draft", "READY_FOR_REVIEW", [{ versionId: "v15" }])], versions)).toThrow(
      expect.objectContaining({ code: "nothing-in-review", hint: expect.stringContaining("never sent to App Review") }),
    );
  });

  test("--version picks its own; two candidates name their versions", () => {
    const a = submission("a", "UNRESOLVED_ISSUES", [{ versionId: "v15" }]);
    const b = submission("b", "UNRESOLVED_ISSUES", [{ versionId: "v14" }]);
    expect(cancelTarget([a, b], versions, versions[1]).id).toBe("b");
    expect(() => cancelTarget([a, b], versions)).toThrow(
      expect.objectContaining({ code: "ambiguous-submission", exitCode: 2, details: { choices: ["1.5", "1.4"] }, hint: "Pick one: ship release cancel --version 1.5" }),
    );
  });
});

// MARK: Pre-submission checks

const ready: PreflightData = {
  platform: "IOS",
  update: true,
  primaryLocale: "en-US",
  copyright: "2026 Example",
  build: { number: "37", processingState: "VALID", usesNonExemptEncryption: false },
  versionLocalizations: [{ id: "l1", locale: "en-US", description: "Lifts.", keywords: "gym", supportUrl: "https://example.com", whatsNew: "Fixes" }],
  infoLocalizations: [{ locale: "en-US", name: "Lift", privacyPolicyUrl: "https://example.com/privacy" }],
  screenshots: ["APP_IPHONE_67", "APP_IPAD_PRO_3GEN_129"],
  review: { contactFirstName: "T", contactLastName: "B", contactEmail: "t@example.com", contactPhone: "+1 555" },
  contentRights: "DOES_NOT_USE_THIRD_PARTY_CONTENT",
};

describe("preflightChecks", () => {
  test("everything there: all pass", () => {
    const checks = preflightChecks(ready);
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(blockingFailures(checks)).toEqual([]);
    expect(checks.every((check) => check.fix === undefined)).toBe(true);
  });

  test("missing things block, with fixes", () => {
    const checks = preflightChecks({
      ...ready,
      copyright: null,
      versionLocalizations: [{ ...ready.versionLocalizations[0]!, keywords: "  " }, { id: "l2", locale: "de-DE", description: null, keywords: "x", supportUrl: "https://x", whatsNew: null }],
      screenshots: ["APP_IPHONE_61"],
      review: { ...ready.review!, contactPhone: null },
      contentRights: null,
    });
    const blocking = blockingFailures(checks).map((check) => check.name);
    expect(blocking).toEqual(["description", "keywords", "screenshots", "copyright", "reviewContact", "contentRights"]);
    expect(checks.find((check) => check.name === "description")?.detail).toContain("de-DE");
    expect(checks.find((check) => check.name === "screenshots")?.fix).toContain("ship screenshots push");
    expect(checks.find((check) => check.name === "keywords")?.fix).toContain("ship metadata push");
    // iPad screenshots and What's New only warn.
    expect(checks.find((check) => check.name === "ipadScreenshots")).toMatchObject({ ok: false, blocking: false });
    expect(checks.find((check) => check.name === "whatsNew")).toMatchObject({ ok: false, blocking: false });
  });

  test("the build: none, unprocessed, or compliance unanswered", () => {
    expect(blockingFailures(preflightChecks({ ...ready, build: null })).map((c) => c.name)).toEqual(["build"]);
    expect(blockingFailures(preflightChecks({ ...ready, build: { ...ready.build!, usesNonExemptEncryption: null } })).map((c) => c.name)).toEqual(["build"]);
    expect(blockingFailures(preflightChecks({ ...ready, build: { ...ready.build!, usesNonExemptEncryption: null }, answersCompliance: true }))).toEqual([]);
  });

  test("no localizations at all, and no name or privacy policy", () => {
    const names = blockingFailures(preflightChecks({ ...ready, versionLocalizations: [], infoLocalizations: [] })).map((c) => c.name);
    expect(names).toEqual(["localizations", "name", "privacyPolicyUrl"]);
  });

  test("an iPad-only app passes with 13-inch iPad screenshots alone", () => {
    const checks = preflightChecks({ ...ready, screenshots: ["APP_IPAD_PRO_3GEN_129"] });
    expect(blockingFailures(checks)).toEqual([]);
    expect(checks.find((c) => c.name === "screenshots")?.detail).toContain("fine for an iPad-only app");
    // Neither iPhone nor 13-inch iPad screenshots still stops it.
    const none = preflightChecks({ ...ready, screenshots: ["APP_IPAD_PRO_129_LEGACY_NOT_A_TYPE"] }).find((c) => c.name === "screenshots");
    expect(none).toMatchObject({ ok: false, blocking: true, detail: 'No 6.9" or 6.5" iPhone or 13" iPad screenshots in en-US' });
  });

  test("macOS needs Mac screenshots, and no iPad check", () => {
    const checks = preflightChecks({ ...ready, platform: "MAC_OS", screenshots: ["APP_IPHONE_67"] });
    expect(blockingFailures(checks).map((c) => c.name)).toEqual(["screenshots"]);
    expect(checks.some((c) => c.name === "ipadScreenshots")).toBe(false);
    expect(blockingFailures(preflightChecks({ ...ready, platform: "MAC_OS", screenshots: ["APP_DESKTOP"] }))).toEqual([]);
  });

  test("the first version doesn't need What's New", () => {
    expect(preflightChecks({ ...ready, update: false }).some((c) => c.name === "whatsNew")).toBe(false);
  });
});

// MARK: Talking to App Store Connect

const NOW = new Date("2026-10-21T12:00:00Z");

interface World {
  versions: ReturnType<typeof resource>[];
  builds: { id: string; number: string; version: string; attributes?: Record<string, unknown> }[];
  submissions: { id: string; state: string; versionIds: string[]; submittedDate?: string }[];
  phased?: Record<string, { id: string; state: string; currentDayNumber?: number | null }>;
  screenshots?: string[];
}

const versionResource = (id: string, versionString: string, state: string, attributes: Record<string, unknown> = {}, buildId?: string) =>
  resource(
    "appStoreVersions",
    id,
    { versionString, platform: "IOS", appVersionState: state, releaseType: "AFTER_APPROVAL", copyright: "2026 Example", createdDate: "2026-10-01T00:00:00Z", ...attributes },
    { build: { data: buildId ? { type: "builds", id: buildId } : null } },
  );

/** Answers like App Store Connect for an app called app1, from `world`. */
function asc(world: World) {
  return (call: AscCall) => {
    const { method, path } = call;
    if (method === "GET" && path === "/v1/apps/app1/appStoreVersions") return { json: jsonApi(world.versions) };
    if (method === "GET" && path === "/v1/builds") {
      const wantedVersion = call.query["filter[preReleaseVersion.version]"];
      const wantedNumber = call.query["filter[version]"];
      const found = world.builds.filter((b) => (!wantedVersion || b.version === wantedVersion) && (!wantedNumber || b.number === wantedNumber));
      return {
        json: jsonApi(
          found.map((b) =>
            resource(
              "builds",
              b.id,
              { version: b.number, uploadedDate: "2026-10-20T10:00:00Z", processingState: "VALID", expired: false, usesNonExemptEncryption: false, buildAudienceType: "APP_STORE_ELIGIBLE", ...b.attributes },
              { preReleaseVersion: { data: { type: "preReleaseVersions", id: `pre-${b.version}` } } },
            ),
          ),
          { included: [...new Set(found.map((b) => b.version))].map((v) => resource("preReleaseVersions", `pre-${v}`, { version: v, platform: "IOS" })) },
        ),
      };
    }
    if (method === "GET" && path === "/v1/reviewSubmissions") {
      const items = world.submissions.flatMap((s) => s.versionIds.map((v, i) => resource("reviewSubmissionItems", `${s.id}-i${i}`, { state: "READY_FOR_REVIEW" }, { appStoreVersion: { data: { type: "appStoreVersions", id: v } } })));
      return {
        json: jsonApi(
          world.submissions.map((s) =>
            resource(
              "reviewSubmissions",
              s.id,
              { state: s.state, platform: "IOS", submittedDate: s.submittedDate ?? null },
              { items: { data: s.versionIds.map((_, i) => ({ type: "reviewSubmissionItems", id: `${s.id}-i${i}` })) } },
            ),
          ),
          { included: items },
        ),
      };
    }
    const phased = path.match(/^\/v1\/appStoreVersions\/([^/]+)\/appStoreVersionPhasedRelease$/);
    if (method === "GET" && phased) {
      const found = world.phased?.[phased[1]!];
      return { json: { data: found ? resource("appStoreVersionPhasedReleases", found.id, { phasedReleaseState: found.state, currentDayNumber: found.currentDayNumber ?? null }) : null } };
    }
    // Pre-submission reads.
    if (method === "GET" && /^\/v1\/appStoreVersions\/[^/]+\/appStoreVersionLocalizations$/.test(path)) {
      return { json: jsonApi([resource("appStoreVersionLocalizations", "loc1", { locale: "en-US", description: "Lifts.", keywords: "gym", supportUrl: "https://example.com", whatsNew: "Fixes" })]) };
    }
    if (method === "GET" && path === "/v1/apps/app1/appInfos") return { json: jsonApi([resource("appInfos", "info1", { state: "PREPARE_FOR_SUBMISSION" })]) };
    if (method === "GET" && path === "/v1/apps/app1") return { json: jsonApi(resource("apps", "app1", { contentRightsDeclaration: "DOES_NOT_USE_THIRD_PARTY_CONTENT", primaryLocale: "en-US" })) };
    if (method === "GET" && /^\/v1\/appStoreVersions\/[^/]+\/appStoreReviewDetail$/.test(path)) {
      return { json: jsonApi(resource("appStoreReviewDetails", "rd1", { contactFirstName: "T", contactLastName: "B", contactEmail: "t@example.com", contactPhone: "+1 555" })) };
    }
    if (method === "GET" && /^\/v1\/appStoreVersions\/[^/]+$/.test(path)) return { json: jsonApi(resource("appStoreVersions", path.split("/").pop()!, { copyright: "2026 Example" })) };
    if (method === "GET" && path === "/v1/appInfos/info1/appInfoLocalizations") {
      return { json: jsonApi([resource("appInfoLocalizations", "il1", { locale: "en-US", name: "Lift", privacyPolicyUrl: "https://example.com/privacy" })]) };
    }
    if (method === "GET" && path === "/v1/appStoreVersionLocalizations/loc1/appScreenshotSets") {
      return {
        json: jsonApi(
          (world.screenshots ?? ["APP_IPHONE_67"]).map((type, i) =>
            resource("appScreenshotSets", `set${i}`, { screenshotDisplayType: type }, { appScreenshots: { data: [{ type: "appScreenshots", id: `shot${i}` }] } }),
          ),
        ),
      };
    }
    // Writes.
    if (method === "POST" && path === "/v1/appStoreVersions") {
      const attributes = (call.body as any).data.attributes;
      return { status: 201, json: jsonApi(versionResource("vnew", attributes.versionString, "PREPARE_FOR_SUBMISSION", attributes)) };
    }
    if (method === "PATCH" && /^\/v1\/appStoreVersions\/[^/]+(\/relationships\/build)?$/.test(path)) return { status: 204 };
    if (method === "PATCH" && path.startsWith("/v1/builds/")) return { json: jsonApi(resource("builds", path.split("/").pop()!, {})) };
    if (method === "POST" && path === "/v1/appStoreVersionPhasedReleases") return { status: 201, json: jsonApi(resource("appStoreVersionPhasedReleases", "pr-new", { phasedReleaseState: "INACTIVE" })) };
    if (method === "DELETE" && path.startsWith("/v1/appStoreVersionPhasedReleases/")) return { status: 204 };
    if (method === "PATCH" && path.startsWith("/v1/appStoreVersionPhasedReleases/")) {
      const body = call.body as any;
      return { json: jsonApi(resource("appStoreVersionPhasedReleases", body.data.id, { phasedReleaseState: body.data.attributes.phasedReleaseState, currentDayNumber: 4 })) };
    }
    if (method === "POST" && path === "/v1/reviewSubmissions") return { status: 201, json: jsonApi(resource("reviewSubmissions", "s-new", { state: "READY_FOR_REVIEW", platform: "IOS" })) };
    if (method === "POST" && path === "/v1/reviewSubmissionItems") return { status: 201, json: jsonApi(resource("reviewSubmissionItems", "i-new", { state: "READY_FOR_REVIEW" })) };
    if (method === "PATCH" && path.startsWith("/v1/reviewSubmissions/")) {
      const body = call.body as any;
      const state = body.data.attributes.canceled ? "CANCELING" : "WAITING_FOR_REVIEW";
      return { json: jsonApi(resource("reviewSubmissions", body.data.id, { state, platform: "IOS", submittedDate: "2026-10-21T12:00:00Z" })) };
    }
    if (method === "POST" && path === "/v1/appStoreVersionReleaseRequests") return { status: 201, json: jsonApi(resource("appStoreVersionReleaseRequests", "rr1", {})) };
    return undefined;
  };
}

const writes = (calls: AscCall[]) => calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`);

describe("release flows", () => {
  let mock: ReturnType<typeof mockAsc> | undefined;
  let delay: ReturnType<typeof noRetryDelay>;
  let project: Project;

  beforeEach(async () => {
    await testCredentials();
    delay = noRetryDelay();
    ui.quiet = true;
    project = fakeProject();
  });

  afterEach(() => {
    mock?.restore();
    mock = undefined;
    delay.restore();
    ui.quiet = false;
    ui.json = false;
  });

  const live = versionResource("v13", "1.3", "READY_FOR_DISTRIBUTION", { createdDate: "2026-09-01T00:00:00Z" }, "b30");

  test("submit: attach the build, create a submission, add the version, submit", async () => {
    mock = mockAsc(
      asc({
        versions: [versionResource("v14", "1.4", "PREPARE_FOR_SUBMISSION"), live],
        builds: [{ id: "b37", number: "37", version: "1.4" }],
        submissions: [],
      }),
    );
    const result = await submit(project, { version: "1.4", now: NOW });
    expect(writes(mock.calls)).toEqual([
      "PATCH /v1/appStoreVersions/v14/relationships/build",
      "POST /v1/reviewSubmissions",
      "POST /v1/reviewSubmissionItems",
      "PATCH /v1/reviewSubmissions/s-new",
    ]);
    const posts = mock.calls.filter((call) => call.method !== "GET");
    expect(posts[0]!.body).toEqual({ data: { type: "builds", id: "b37" } });
    expect(posts[1]!.body).toEqual({ data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: "app1" } } } } });
    expect(posts[2]!.body).toEqual({
      data: {
        type: "reviewSubmissionItems",
        relationships: { reviewSubmission: { data: { type: "reviewSubmissions", id: "s-new" } }, appStoreVersion: { data: { type: "appStoreVersions", id: "v14" } } },
      },
    });
    expect(posts[3]!.body).toEqual({ data: { type: "reviewSubmissions", id: "s-new", attributes: { submitted: true } } });
    expect(result).toMatchObject({ version: "1.4", created: false, renamed: false, build: { id: "b37", number: "37" }, submitted: true, alreadyInReview: false });
    expect(result.submission).toEqual({ id: "s-new", state: "WAITING_FOR_REVIEW", submittedDate: "2026-10-21T12:00:00Z" });
    expect(blockingFailures(result.checks)).toEqual([]);
    // The newest valid App Store build of the version was asked for.
    const lookup = mock.calls.find((call) => call.path === "/v1/builds")!;
    expect(lookup.query).toMatchObject({
      "filter[preReleaseVersion.version]": "1.4",
      "filter[processingState]": "VALID",
      "filter[expired]": "false",
      "filter[buildAudienceType]": "APP_STORE_ELIGIBLE",
      sort: "-uploadedDate",
      limit: "1",
    });
  });

  test("submit reuses a draft that already has the version", async () => {
    mock = mockAsc(
      asc({
        versions: [versionResource("v14", "1.4", "PREPARE_FOR_SUBMISSION", {}, "b37"), live],
        builds: [{ id: "b37", number: "37", version: "1.4" }],
        submissions: [{ id: "draft", state: "READY_FOR_REVIEW", versionIds: ["v14"] }],
      }),
    );
    const result = await submit(project, { version: "1.4", now: NOW });
    expect(writes(mock.calls)).toEqual(["PATCH /v1/reviewSubmissions/draft"]);
    expect(result.submitted).toBe(true);
  });

  test("submit resubmits after a rejection (UNRESOLVED_ISSUES)", async () => {
    mock = mockAsc(
      asc({
        versions: [versionResource("v14", "1.4", "REJECTED", {}, "b37"), live],
        builds: [{ id: "b38", number: "38", version: "1.4" }],
        submissions: [{ id: "rejected", state: "UNRESOLVED_ISSUES", versionIds: ["v14"] }],
      }),
    );
    const result = await submit(project, { version: "1.4", now: NOW });
    // The newer build replaces the rejected one, and the same submission goes back.
    expect(writes(mock.calls)).toEqual(["PATCH /v1/appStoreVersions/v14/relationships/build", "PATCH /v1/reviewSubmissions/rejected"]);
    expect(result.build).toEqual({ id: "b38", number: "38" });
  });

  test("submit with another version in review is an error, before changing anything", async () => {
    mock = mockAsc(
      asc({
        versions: [versionResource("v14", "1.4", "PREPARE_FOR_SUBMISSION"), live],
        builds: [{ id: "b37", number: "37", version: "1.4" }],
        submissions: [{ id: "other", state: "IN_REVIEW", versionIds: ["v-other"] }],
      }),
    );
    const error = await rejected(submit(project, { version: "1.4", now: NOW }));
    expect(error.code).toBe("submission-in-progress");
    expect(error.hint).toContain("ship release cancel");
    expect(writes(mock.calls)).toEqual([]);
  });

  test("submit when the version is already in review reports it and changes nothing", async () => {
    mock = mockAsc(
      asc({
        versions: [versionResource("v14", "1.4", "WAITING_FOR_REVIEW", {}, "b37"), live],
        builds: [],
        submissions: [{ id: "s1", state: "WAITING_FOR_REVIEW", versionIds: ["v14"], submittedDate: "2026-10-21T10:00:00Z" }],
      }),
    );
    const result = await submit(project, { version: "1.4", now: NOW });
    expect(result.alreadyInReview).toBe(true);
    expect(result.submission?.id).toBe("s1");
    expect(writes(mock.calls)).toEqual([]);
  });

  test("submit --dry-run sends nothing that changes App Store Connect", async () => {
    mock = mockAsc(
      asc({
        versions: [live],
        builds: [{ id: "b37", number: "37", version: "1.4", attributes: { usesNonExemptEncryption: null } }],
        submissions: [],
      }),
    );
    const result = await submit(project, { version: "1.4", release: "manual", phased: true, dryRun: true, now: NOW });
    expect(writes(mock.calls)).toEqual([]);
    expect(result).toMatchObject({ dryRun: true, created: true, submitted: false, releaseType: "MANUAL", phased: true, checks: [], checksRun: false });
    // Without the version there's nothing to check, so it doesn't say it would submit.
    expect(dryRunVerdict(result)).toBe("Would create 1.4; the checks run once it exists, so run this again after `ship release prepare`.");
    expect(result.steps).toEqual([
      "Create version 1.4",
      "Answer export compliance (exempt: only Apple's encryption)",
      "Attach build 37",
      "Set the release to manual (`ship release go` once it's approved)",
      "Turn on phased release (7 days)",
      "Create a submission and submit 1.4",
    ]);
  });

  test("submit --dry-run on an existing version runs the checks without changes", async () => {
    mock = mockAsc(
      asc({
        versions: [versionResource("v14", "1.4", "PREPARE_FOR_SUBMISSION"), live],
        builds: [{ id: "b37", number: "37", version: "1.4" }],
        submissions: [],
        screenshots: [],
      }),
    );
    const result = await submit(project, { version: "1.4", dryRun: true, now: NOW });
    expect(writes(mock.calls)).toEqual([]);
    expect(blockingFailures(result.checks).map((c) => c.name)).toEqual(["screenshots"]);
    expect(result).toMatchObject({ checksRun: true, checksBeforePush: false });
    expect(dryRunVerdict(result)).toBe("Would stop: screenshots must be fixed first.");
    expect(dryRunVerdict({ ...result, checksBeforePush: true })).toBe("Would stop: screenshots must be fixed first (checked before the push, which may fix some).");
  });

  test("submit stops when a blocking check fails, before any submission", async () => {
    mock = mockAsc(
      asc({
        versions: [versionResource("v14", "1.4", "PREPARE_FOR_SUBMISSION", {}, "b37"), live],
        builds: [{ id: "b37", number: "37", version: "1.4" }],
        submissions: [],
        screenshots: ["APP_IPHONE_61"],
      }),
    );
    const error = await rejected(submit(project, { version: "1.4", now: NOW }));
    expect(error.code).toBe("not-ready");
    expect(error.hint).toContain("ship screenshots push");
    expect((error.details?.checks as { name: string; ok: boolean }[]).find((c) => c.name === "screenshots")?.ok).toBe(false);
    expect(writes(mock.calls)).toEqual([]);
  });

  test("prepare creates the version with the release type, answers compliance, and turns on phasing", async () => {
    mkdirSync(project.storeDir, { recursive: true });
    writeFileSync(join(project.storeDir, "app.json"), JSON.stringify({ release: { type: "MANUAL", phased: true } }));
    mock = mockAsc(
      asc({
        versions: [live],
        builds: [{ id: "b37", number: "37", version: "1.4", attributes: { usesNonExemptEncryption: null } }],
        submissions: [],
      }),
    );
    const result = await prepare(project, { version: "1.4", now: NOW });
    expect(writes(mock.calls)).toEqual([
      "POST /v1/appStoreVersions",
      "PATCH /v1/builds/b37",
      "PATCH /v1/appStoreVersions/vnew/relationships/build",
      "POST /v1/appStoreVersionPhasedReleases",
    ]);
    const create = mock.calls.find((call) => call.method === "POST" && call.path === "/v1/appStoreVersions")!;
    expect(create.body).toEqual({
      data: {
        type: "appStoreVersions",
        attributes: { platform: "IOS", versionString: "1.4", releaseType: "MANUAL", earliestReleaseDate: null },
        relationships: { app: { data: { type: "apps", id: "app1" } } },
      },
    });
    const phase = mock.calls.find((call) => call.path === "/v1/appStoreVersionPhasedReleases")!;
    expect(phase.body).toEqual({
      data: {
        type: "appStoreVersionPhasedReleases",
        attributes: { phasedReleaseState: "INACTIVE" },
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "vnew" } } },
      },
    });
    expect(result).toMatchObject({ version: "1.4", versionId: "vnew", created: true, releaseType: "MANUAL", phased: true, pushed: { metadata: null, media: null } });
  });

  test("prepare --rename renames the version being prepared; a schedule and --no-phased update it", async () => {
    mock = mockAsc(
      asc({
        versions: [versionResource("v14", "1.4", "PREPARE_FOR_SUBMISSION", {}, "b40"), live],
        builds: [{ id: "b40", number: "40", version: "1.5" }],
        submissions: [],
        phased: { v14: { id: "pr14", state: "INACTIVE" } },
      }),
    );
    const result = await prepare(project, { version: "1.5", rename: true, release: "2026-11-03T09:30:00Z", phased: false, now: NOW });
    expect(writes(mock.calls)).toEqual(["PATCH /v1/appStoreVersions/v14", "PATCH /v1/appStoreVersions/v14", "DELETE /v1/appStoreVersionPhasedReleases/pr14"]);
    const [rename, schedule] = mock.calls.filter((call) => call.method === "PATCH");
    expect(rename!.body).toEqual({ data: { type: "appStoreVersions", id: "v14", attributes: { versionString: "1.5" } } });
    expect(schedule!.body).toEqual({
      data: { type: "appStoreVersions", id: "v14", attributes: { releaseType: "SCHEDULED", earliestReleaseDate: "2026-11-03T10:00:00Z" } },
    });
    expect(result).toMatchObject({ renamed: true, releaseType: "SCHEDULED", earliestReleaseDate: "2026-11-03T10:00:00Z", phased: false });
  });

  test("prepare --push --release keeps the release type --release asked for, not app.json's", async () => {
    mkdirSync(project.storeDir, { recursive: true });
    writeFileSync(join(project.storeDir, "app.json"), JSON.stringify({ release: { type: "AFTER_APPROVAL" } }));
    const world = asc({
      versions: [versionResource("v14", "1.4", "PREPARE_FOR_SUBMISSION", { releaseType: "MANUAL" }, "b37"), live],
      builds: [{ id: "b37", number: "37", version: "1.4" }],
      submissions: [],
    });
    // The rest of what the metadata push reads.
    mock = mockAsc((call: AscCall) => {
      if (call.method === "GET" && call.path === "/v1/appInfos/info1") return { json: jsonApi(resource("appInfos", "info1", {})) };
      if (call.method === "GET" && call.path === "/v1/appInfos/info1/ageRatingDeclaration") return { status: 404, json: { errors: [{ status: "404" }] } };
      return world(call);
    });
    const result = await prepare(project, { version: "1.4", push: true, release: "manual", now: NOW });
    const releaseTypes = mock.calls.filter((call) => call.method === "PATCH" && call.path === "/v1/appStoreVersions/v14").map((call) => (call.body as any).data.attributes.releaseType);
    expect(releaseTypes.filter((type) => type !== undefined && type !== "MANUAL")).toEqual([]);
    expect(result).toMatchObject({ releaseType: "MANUAL" });
    expect(result.pushed.metadata?.skipped).toContainEqual(expect.objectContaining({ field: "release.type", reason: "--release sets the release type" }));
  });

  test("prepare --push --dry-run for a version that doesn't exist yet asks nothing of the store folder", async () => {
    mkdirSync(join(project.storeDir, "en-US"), { recursive: true });
    writeFileSync(join(project.storeDir, "en-US", "description.txt"), "An app.\n");
    mock = mockAsc(asc({ versions: [live], builds: [{ id: "b37", number: "37", version: "1.4" }], submissions: [] }));
    const result = await prepare(project, { version: "1.4", push: true, dryRun: true, now: NOW });
    expect(result).toMatchObject({ created: true, pushed: { metadata: null, media: null } });
    expect(writes(mock.calls)).toEqual([]);
  });

  test("prepare with no build of the version fails before changing anything", async () => {
    mock = mockAsc(asc({ versions: [live], builds: [{ id: "b30", number: "30", version: "1.3" }], submissions: [] }));
    const error = await rejected(prepare(project, { version: "1.4", now: NOW }));
    expect(error.code).toBe("no-build");
    expect(error.hint).toContain("ship beta");
    expect(writes(mock.calls)).toEqual([]);
  });

  test("prepare --build looks for the number within the version", async () => {
    mock = mockAsc(
      asc({
        versions: [live],
        builds: [
          { id: "b-old", number: "5", version: "1.3" },
          { id: "b-new", number: "5", version: "1.4" },
        ],
        submissions: [],
      }),
    );
    const result = await prepare(project, { version: "1.4", build: "5", dryRun: true, now: NOW });
    expect(result.build).toEqual({ id: "b-new", number: "5" });
    expect(writes(mock.calls)).toEqual([]);
  });

  test("prepare --build with a build of another version", async () => {
    mock = mockAsc(asc({ versions: [live], builds: [{ id: "b30", number: "30", version: "1.3" }], submissions: [] }));
    const error = await rejected(prepare(project, { version: "1.4", build: "30", now: NOW }));
    expect(error.code).toBe("wrong-build-version");
    expect(writes(mock.calls)).toEqual([]);
  });

  test("prepare a version that's in review is an error", async () => {
    mock = mockAsc(asc({ versions: [versionResource("v14", "1.4", "WAITING_FOR_REVIEW"), live], builds: [], submissions: [] }));
    const error = await rejected(prepare(project, { version: "1.4", now: NOW }));
    expect(error.code).toBe("version-not-editable");
    expect(error.hint).toContain("ship release cancel");
  });

  test("go releases only a version waiting for the developer", async () => {
    mock = mockAsc(asc({ versions: [versionResource("v14", "1.4", "PENDING_DEVELOPER_RELEASE"), live], builds: [], submissions: [] }));
    expect(await releaseNow(project, { now: NOW })).toEqual({ version: "1.4", released: true, dryRun: false });
    const request = mock.calls.find((call) => call.method === "POST")!;
    expect(request.path).toBe("/v1/appStoreVersionReleaseRequests");
    expect(request.body).toEqual({
      data: { type: "appStoreVersionReleaseRequests", relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "v14" } } } },
    });
    mock.restore();

    mock = mockAsc(asc({ versions: [versionResource("v14", "1.4", "WAITING_FOR_REVIEW"), live], builds: [], submissions: [] }));
    const error = await rejected(releaseNow(project, { now: NOW }));
    expect(error.code).toBe("not-pending-release");
    expect(error.message).toContain("waiting for review");
    expect(writes(mock.calls)).toEqual([]);
  });

  test("cancel takes the open submission out of review", async () => {
    mock = mockAsc(asc({ versions: [live], builds: [], submissions: [{ id: "s1", state: "WAITING_FOR_REVIEW", versionIds: ["v14"] }] }));
    expect(await cancelReview(project, { now: NOW })).toEqual({
      submission: { id: "s1", state: "CANCELING" },
      canceled: true,
      dryRun: false,
      version: null,
      from: "WAITING_FOR_REVIEW",
    });
    expect(mock.calls.find((call) => call.method === "PATCH")!.body).toEqual({ data: { type: "reviewSubmissions", id: "s1", attributes: { canceled: true } } });
    mock.restore();

    mock = mockAsc(asc({ versions: [live], builds: [], submissions: [{ id: "s2", state: "COMPLETING", versionIds: [] }] }));
    const error = await rejected(cancelReview(project, { now: NOW }));
    expect(error.code).toBe("nothing-in-review");
  });

  test("phased pause on the live version, and a move that isn't allowed", async () => {
    mock = mockAsc(asc({ versions: [live], builds: [], submissions: [], phased: { v13: { id: "pr13", state: "ACTIVE", currentDayNumber: 4 } } }));
    const result = await phasedCommand(project, "pause", { now: NOW });
    expect(result).toMatchObject({ version: "1.3", to: "PAUSED", phasedRelease: { id: "pr13", state: "PAUSED", currentDayNumber: 4, percent: 10 } });
    expect(mock.calls.find((call) => call.method === "PATCH")!.body).toEqual({
      data: { type: "appStoreVersionPhasedReleases", id: "pr13", attributes: { phasedReleaseState: "PAUSED" } },
    });
    const error = await rejected(phasedCommand(project, "resume", { now: NOW }));
    expect(error.code).toBe("bad-phased-state");
    expect((await rejected(phasedCommand(project, "stop", { now: NOW }))).details?.choices).toEqual(["pause", "resume", "complete"]);
  });

  test("status: the version in review, the live one's rollout, and the submission", async () => {
    mock = mockAsc(
      asc({
        versions: [versionResource("v14", "1.4", "WAITING_FOR_REVIEW", {}, "b37"), live],
        builds: [],
        submissions: [{ id: "s1", state: "WAITING_FOR_REVIEW", versionIds: ["v14"], submittedDate: "2026-10-21T10:00:00Z" }],
        phased: { v14: { id: "pr14", state: "INACTIVE" }, v13: { id: "pr13", state: "ACTIVE", currentDayNumber: 4 } },
      }),
    );
    const status = await releaseStatus(project, { now: NOW });
    expect(status).toMatchObject({
      app: "Lift",
      platform: "IOS",
      version: { id: "v14", versionString: "1.4", state: "WAITING_FOR_REVIEW", releaseType: "AFTER_APPROVAL", build: { id: "b37" } },
      live: { id: "v13", versionString: "1.3", state: "READY_FOR_DISTRIBUTION", phasedRelease: { state: "ACTIVE", percent: 10 } },
      submission: { id: "s1", state: "WAITING_FOR_REVIEW", submittedDate: "2026-10-21T10:00:00Z" },
      phasedRelease: { id: "pr14", state: "INACTIVE", versionString: "1.4" },
    });
    expect(writes(mock.calls)).toEqual([]);
    const lines = statusLines({ ...status, version: { ...status.version!, build: { id: "b37", number: "37" } } }, NOW);
    expect(lines).toEqual([
      "1.4 (build 37): waiting for review, submitted 2 hours ago. Releases automatically after approval, phased over 7 days.",
      "1.3 is live; phased release day 4 of 7 (10%).",
    ]);
    // Asking about the live version shows its rollout.
    const liveOnly = await releaseStatus(project, { version: "1.3", now: NOW });
    expect(liveOnly.phasedRelease).toMatchObject({ id: "pr13", versionString: "1.3" });
    expect(statusLines({ ...liveOnly, submission: null }, NOW)).toEqual(["1.3 is live; phased release day 4 of 7 (10%)."]);
  });

  test("Apple's 409 on submit comes through with what blocks it", async () => {
    const world = asc({
      versions: [versionResource("v14", "1.4", "PREPARE_FOR_SUBMISSION", {}, "b37"), live],
      builds: [{ id: "b37", number: "37", version: "1.4" }],
      submissions: [{ id: "draft", state: "READY_FOR_REVIEW", versionIds: ["v14"] }],
    });
    mock = mockAsc((call) => {
      if (call.method === "PATCH" && call.path === "/v1/reviewSubmissions/draft") {
        return {
          status: 409,
          json: {
            errors: [
              {
                status: "409",
                code: "STATE_ERROR.ENTITY_STATE_INVALID",
                title: "The submission can't be submitted",
                detail: "Fix these first.",
                meta: { associatedErrors: { "/v1/appStoreVersions/v14": [{ detail: "You must choose an age rating." }] } },
              },
            ],
          },
        };
      }
      return world(call);
    });
    const error = await rejected(submit(project, { version: "1.4", now: NOW }));
    expect(error.code).toBe("api-409");
    expect(error.hint).toContain("You must choose an age rating.");
  });
});

// MARK: The commands

describe("ship release and ship version arguments", () => {
  const run = (name: string, args: string[], flags: Record<string, string | boolean> = {}) =>
    rejected([...releaseCommands, ...versionCommands].find((command) => command.name === name)!.run({ args, flags, implicit: false }));

  test("mistakes are usage errors before anything is loaded or sent", async () => {
    expect((await run("release", ["prepare"], { release: "yesterday" })).exitCode).toBe(2);
    expect((await run("release", ["prepare"], { phased: true, "no-phased": true })).details?.choices).toEqual(["--phased", "--no-phased"]);
    expect((await run("release", ["prepare"], { version: "1.x" })).code).toBe("bad-version");
    expect((await run("release", ["prepare"], { build: "abc" })).exitCode).toBe(2);
    expect((await run("release", ["prepare"], { platform: "android" })).details?.choices).toContain("macos");
    const unknown = await run("release", ["ship-it"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.details?.choices).toEqual(["status", "prepare", "submit", "go", "cancel", "phased"]);
    expect((await run("version", ["grow"])).details?.choices).toEqual(["bump", "set"]);
    expect((await run("version", ["bump", "huge"])).details?.choices).toEqual(["major", "minor", "patch"]);
    expect((await run("version", ["set"])).exitCode).toBe(2);
  });

  test("a flag for another action is a usage error", async () => {
    const error = await run("release", ["go"], { build: "3" });
    expect(error).toMatchObject({ code: "usage", exitCode: 2 });
    expect(error.hint).toContain("ship release prepare and ship release submit");
    expect((await run("release", ["status"], { push: true })).code).toBe("usage");
  });
});
