// Apps in App Store Connect: finding one by bundle id, and its details.

import { get, many, one } from "./client";

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

export interface AppDetails extends App {
  sku: string;
  /** The locale App Store Connect falls back to, like en-US. */
  primaryLocale: string;
}

/** An app's name, bundle id, SKU, and primary locale. */
export async function appDetails(appId: string): Promise<AppDetails> {
  const doc = await get<{ name: string; bundleId: string; sku: string; primaryLocale: string }>(
    `/v1/apps/${encodeURIComponent(appId)}?fields[apps]=name,bundleId,sku,primaryLocale`,
  );
  const app = one(doc);
  return {
    id: app?.id ?? appId,
    name: app?.attributes.name ?? "",
    bundleId: app?.attributes.bundleId ?? "",
    sku: app?.attributes.sku ?? "",
    primaryLocale: app?.attributes.primaryLocale ?? "en-US",
  };
}
