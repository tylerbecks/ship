// Owned by the metadata feature: push the store folder's text and app.json
// to App Store Connect.

import type { Project } from "../config";
import { ShipError } from "../ui";
import type { PushResult } from "./files";

export type { PushResult };

export async function pushMetadata(
  project: Project,
  options: { appId: string; version?: string; dryRun?: boolean; partial?: boolean },
): Promise<PushResult> {
  void project;
  void options;
  throw new ShipError("Pushing the App Store page isn't available in this build", "not-implemented", "Update ship (`ship --version`), or edit the page in App Store Connect.");
}
