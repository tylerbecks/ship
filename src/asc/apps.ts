// Apps in App Store Connect: finding one by bundle id.

import { get, many } from "./client";

export interface App {
  id: string;
  name: string;
  bundleId: string;
}

/** The App Store Connect app with this bundle id, if there is one. */
export async function lookupApp(bundleId: string): Promise<App | undefined> {
  const doc = await get<{ name: string; bundleId: string }>(
    `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=name,bundleId&limit=20`,
  );
  // The filter can match more than the one app (bundle ids that start the same), so pick the exact one.
  const app = many(doc).find((item) => item.attributes.bundleId?.toLowerCase() === bundleId.toLowerCase());
  return app && { id: app.id, name: app.attributes.name, bundleId: app.attributes.bundleId };
}
