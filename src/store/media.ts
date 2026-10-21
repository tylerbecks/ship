// Owned by the media feature: push the store folder's screenshots and app
// previews to App Store Connect.

import type { Project } from "../config";
import { ShipError } from "../ui";
import type { PushResult } from "./files";

export async function pushMedia(
  project: Project,
  options: { appId: string; version?: string; dryRun?: boolean; prune?: boolean },
): Promise<PushResult> {
  void project;
  void options;
  throw new ShipError("Pushing screenshots isn't available in this build", "not-implemented", "Update ship (`ship --version`), or upload them in App Store Connect.");
}
