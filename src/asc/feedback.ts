// What testers send from TestFlight: screenshots with a comment, and crash
// reports (betaFeedbackScreenshotSubmissions and betaFeedbackCrashSubmissions).
// Screenshot URLs are signed and expire, so fetch a submission again right
// before downloading its screenshots.

import { ShipError } from "../ui";
import { AscError, type Document, type Resource, del, get, many, one, relatedOne, relationshipId } from "./client";

export type FeedbackKind = "screenshot" | "crash";

export const FEEDBACK_KINDS: FeedbackKind[] = ["screenshot", "crash"];

/** One screenshot a tester sent; `url` is signed and stops working at expirationDate. */
export interface FeedbackScreenshot {
  url: string;
  width: number | null;
  height: number | null;
  expirationDate: string | null;
}

export interface Feedback {
  id: string;
  kind: FeedbackKind;
  createdDate: string;
  comment: string | null;
  tester: { email: string; name: string } | null;
  build: { id: string; number: string | null } | null;
  device: {
    model: string | null;
    osVersion: string | null;
    family: string | null;
    platform: string | null;
    architecture: string | null;
    connectionType: string | null;
  };
  locale: string | null;
  timeZone: string | null;
  appUptimeMs: number | null;
  batteryPercentage: number | null;
  screenshots: FeedbackScreenshot[];
}

type FeedbackAttributes = {
  createdDate?: string;
  comment?: string | null;
  email?: string | null;
  deviceModel?: string | null;
  osVersion?: string | null;
  locale?: string | null;
  timeZone?: string | null;
  architecture?: string | null;
  connectionType?: string | null;
  appUptimeInMilliseconds?: number | null;
  batteryPercentage?: number | null;
  devicePlatform?: string | null;
  deviceFamily?: string | null;
  screenshots?: { url?: string; width?: number; height?: number; expirationDate?: string }[] | null;
};

/** The resource type and path for each kind. */
const RESOURCE: Record<FeedbackKind, string> = {
  screenshot: "betaFeedbackScreenshotSubmissions",
  crash: "betaFeedbackCrashSubmissions",
};

/** The include and fields parameters every feedback query uses. */
export const FEEDBACK_QUERY = "include=build,tester&fields[betaTesters]=email,firstName,lastName&fields[builds]=version";

// MARK: Mapping

const str = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** A submission and what was included with it, as Feedback. */
export function toFeedback(kind: FeedbackKind, resource: Resource<FeedbackAttributes>, included: Resource[] = []): Feedback {
  const a = resource.attributes ?? {};
  const testerResource = relatedOne(resource, "tester", included);
  const buildResource = relatedOne(resource, "build", included);
  const buildId = buildResource?.id ?? relationshipId(resource, "build");
  let tester: Feedback["tester"] = null;
  if (testerResource) {
    const t = testerResource.attributes as { email?: string; firstName?: string; lastName?: string };
    tester = { email: t.email ?? str(a.email) ?? "", name: [t.firstName, t.lastName].filter(Boolean).join(" ") };
  } else if (str(a.email)) {
    tester = { email: a.email!, name: "" };
  }
  return {
    id: resource.id,
    kind,
    createdDate: a.createdDate ?? "",
    comment: str(a.comment),
    tester,
    build: buildId ? { id: buildId, number: str(buildResource?.attributes.version) } : null,
    device: {
      model: str(a.deviceModel),
      osVersion: str(a.osVersion),
      family: str(a.deviceFamily),
      platform: str(a.devicePlatform),
      architecture: str(a.architecture),
      connectionType: str(a.connectionType),
    },
    locale: str(a.locale),
    timeZone: str(a.timeZone),
    appUptimeMs: num(a.appUptimeInMilliseconds),
    batteryPercentage: num(a.batteryPercentage),
    screenshots: (a.screenshots ?? [])
      .filter((s) => typeof s?.url === "string" && s.url)
      .map((s) => ({ url: s.url!, width: num(s.width), height: num(s.height), expirationDate: str(s.expirationDate) })),
  };
}

/** Newest first (ties by id, so the order is stable), at most `limit`. */
export function mergeFeedback(lists: Feedback[][], limit: number): Feedback[] {
  return lists
    .flat()
    .sort((x, y) => (x.createdDate === y.createdDate ? x.id.localeCompare(y.id) : x.createdDate < y.createdDate ? 1 : -1))
    .slice(0, Math.max(0, limit));
}

/** The list path for one kind. */
export function feedbackPath(appId: string, kind: FeedbackKind, options: { buildId?: string; limit?: number } = {}): string {
  const limit = Math.min(Math.max(1, options.limit ?? 20), 200);
  const build = options.buildId ? `&filter[build]=${encodeURIComponent(options.buildId)}` : "";
  return `/v1/apps/${appId}/${RESOURCE[kind]}?${FEEDBACK_QUERY}&sort=-createdDate&limit=${limit}${build}`;
}

// MARK: Requests

/** Reading feedback needs a key with a role that can see TestFlight. */
function explain(error: unknown): never {
  // Keep Apple's agreement hint: that 403 isn't about the role.
  if (error instanceof AscError && error.status === 403 && !/agreement/i.test(error.hint ?? "")) {
    throw new ShipError(
      error.message,
      error.code,
      "Reading TestFlight feedback needs an API key with the App Manager or Admin role (Users and Access → Integrations).",
      error.details,
    );
  }
  throw error;
}

/** The newest feedback of the given kinds, merged newest first. */
export async function listFeedback(
  appId: string,
  options: { kinds?: FeedbackKind[]; buildId?: string; limit?: number } = {},
): Promise<Feedback[]> {
  const limit = Math.max(1, options.limit ?? 20);
  const kinds = options.kinds?.length ? options.kinds : FEEDBACK_KINDS;
  const lists = await Promise.all(
    kinds.map(async (kind) => {
      const items: Feedback[] = [];
      let next: string | undefined = feedbackPath(appId, kind, { buildId: options.buildId, limit });
      while (next && items.length < limit) {
        const doc: Document<FeedbackAttributes> = await get<FeedbackAttributes>(next).catch(explain);
        items.push(...many(doc).map((resource) => toFeedback(kind, resource, doc.included ?? [])));
        next = doc.links?.next;
      }
      return items;
    }),
  );
  return mergeFeedback(lists, limit);
}

/** Calls `body` with each kind in turn until one isn't a 404. undefined when neither has the id. */
async function eitherKind<T>(body: (kind: FeedbackKind) => Promise<T>): Promise<{ kind: FeedbackKind; value: T } | undefined> {
  for (const kind of FEEDBACK_KINDS) {
    try {
      return { kind, value: await body(kind) };
    } catch (error) {
      if (error instanceof AscError && error.status === 404) continue;
      explain(error);
    }
  }
  return undefined;
}

/** One submission by id, whichever kind it is. undefined when there's none. */
export async function getFeedback(id: string): Promise<Feedback | undefined> {
  const found = await eitherKind(async (kind) => {
    const doc = await get<FeedbackAttributes>(`/v1/${RESOURCE[kind]}/${encodeURIComponent(id)}?${FEEDBACK_QUERY}`);
    const resource = one(doc);
    if (!resource) throw new AscError(404, []);
    return toFeedback(kind, resource, doc.included ?? []);
  });
  return found?.value;
}

/** A crash submission's log, or undefined when Apple has none. */
export async function crashLog(id: string): Promise<string | undefined> {
  try {
    const log = one(await get<{ logText?: string }>(`/v1/betaFeedbackCrashSubmissions/${encodeURIComponent(id)}/crashLog`));
    return log?.attributes.logText || undefined;
  } catch (error) {
    if (error instanceof AscError && error.status === 404) return undefined;
    explain(error);
  }
}

/** Deletes a submission, whichever kind it is. Returns false when there's none. */
export async function deleteFeedback(id: string): Promise<boolean> {
  const found = await eitherKind((kind) => del(`/v1/${RESOURCE[kind]}/${encodeURIComponent(id)}`));
  return Boolean(found);
}
