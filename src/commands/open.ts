// ship open: the app's project in Xcode.

import type { Command } from "../command";
import { loadProject, relativeTo } from "../config";
import { run, runOrThrow } from "../exec";
import { ui } from "../ui";

export const openHelp = `ship open

Opens the app's project, workspace, or package in Xcode: the Xcode that
xcode-select points at, like \`xed\`. Handy when Xcode needs you to click
something a command-line build can't, like trusting a package's macros.`;

export async function open(options: { app?: string }) {
  const project = await loadProject({ app: options.app });
  const path = project.projectPath;
  // xed opens the selected Xcode; when it's missing or fails, fall back to the app named Xcode.
  const xed = await run(["xed", path]);
  if (xed.code !== 0) await runOrThrow(["open", "-a", "Xcode", path], { what: "Opening Xcode" });
  ui.result({ opened: path }, () => console.log(`Opened ${relativeTo(project.root, path)} in Xcode.`));
}

export const commands: Command[] = [
  {
    name: "open",
    index: [{ section: "daily", label: "open", summary: "Open the project in Xcode" }],
    help: openHelp,
    flags: {},
    maxArgs: 0,
    run: (ctx) => open({ app: ctx.app }),
  },
];
