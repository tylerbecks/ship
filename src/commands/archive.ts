// ship archive: archive and export without uploading.

import { archive, buildPaths, checkBuildNumber, checkInfo, exportIPA, packageInfo, withKeyFile } from "../build";
import { type Command, stringFlag } from "../command";
import { loadProject } from "../config";
import { credentials, hasCredentials } from "../credentials";
import { commitSetting, headCommit } from "../git";
import { platformInfo } from "../platform";
import { ui } from "../ui";
import { appSettings, packageSettings } from "../xcode";

export const archiveHelp = `ship archive [--build <n>]

Archives a Release build and exports the App Store Connect .ipa, without
uploading. Handy for checking signing. Uses the project's current build
number unless you pass --build. Products land in .ship/builds/<n>/.`;

export async function archiveCommand(options: { app?: string; build?: string }) {
  const project = await loadProject({ app: options.app });
  const build =
    options.build ??
    (project.config.kind === "swiftpm"
      ? (await packageSettings(project.projectPath)).build
      : (await appSettings({ kind: project.config.kind, path: project.projectPath }, project.config.scheme, project.platform)).build) ??
    "1";
  const creds = (await hasCredentials()) ? await credentials() : undefined;
  const commit = await headCommit(project.root);
  const ipa = await withKeyFile(creds, async (key) => {
    ui.step(`Archiving ${project.config.scheme} (Release, build ${build})`);
    await archive(project, build, creds, key, commit && commitSetting(commit));
    ui.ok("Archived");
    ui.step(`Exporting the App Store Connect ${platformInfo(project.platform).package}`);
    return exportIPA(project, build, creds, key);
  });
  const checks = checkInfo(await packageInfo(ipa, buildPaths(project, build).archive), { bundleId: project.config.bundleId, build });
  for (const check of checks) (check.ok ? ui.ok : ui.warn).call(ui, check.message);
  ui.result({ build, ipa, checks, logs: buildPaths(project, build) }, () => console.log(`Exported ${ipa}`));
}

export const commands: Command[] = [
  {
    name: "archive",
    index: [{ section: "daily", label: "archive", summary: "Archive and export without uploading" }],
    help: archiveHelp,
    flags: { build: { type: "string" } },
    run: (ctx) => {
      const build = stringFlag(ctx, "build");
      return archiveCommand({ app: ctx.app, build: build === undefined ? undefined : checkBuildNumber(build) });
    },
  },
];
