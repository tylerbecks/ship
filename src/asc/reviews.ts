// Customer reviews on the App Store, and the developer's reply to each.

import { type Resource, del, get, many, one, post, relatedOne } from "./client";

export interface ReviewReply {
  id: string;
  body: string;
  /** PUBLISHED, or PENDING_PUBLISH while Apple reviews it. */
  state: string | null;
  lastModifiedDate: string | null;
}

export interface CustomerReview {
  id: string;
  rating: number;
  title: string;
  body: string;
  reviewer: string;
  /** Apple's three-letter territory code, like USA. */
  territory: string;
  createdDate: string;
  reply: ReviewReply | null;
}

/** Apple's longest reply. */
export const REPLY_MAX = 5970;

export type ReviewSort = "newest" | "oldest" | "lowest" | "highest";

const SORTS: Record<ReviewSort, string> = { newest: "-createdDate", oldest: "createdDate", lowest: "rating", highest: "-rating" };

export interface ReviewFilter {
  /** Only these star ratings, 1 to 5. */
  ratings?: number[];
  territory?: string;
  /** Only reviews without a published reply. */
  unanswered?: boolean;
  limit?: number;
  sort?: ReviewSort;
}

interface ReviewAttributes {
  rating: number;
  title?: string | null;
  body?: string | null;
  reviewerNickname?: string | null;
  territory?: string | null;
  createdDate?: string | null;
}

interface ReplyAttributes {
  responseBody?: string | null;
  state?: string | null;
  lastModifiedDate?: string | null;
}

const toReply = (resource: Resource<ReplyAttributes>): ReviewReply => ({
  id: resource.id,
  body: resource.attributes.responseBody ?? "",
  state: resource.attributes.state ?? null,
  lastModifiedDate: resource.attributes.lastModifiedDate ?? null,
});

export function toReview(resource: Resource<ReviewAttributes>, included: Resource[] = []): CustomerReview {
  const reply = relatedOne(resource, "response", included) as Resource<ReplyAttributes> | undefined;
  const { attributes } = resource;
  return {
    id: resource.id,
    rating: attributes.rating,
    title: attributes.title ?? "",
    body: attributes.body ?? "",
    reviewer: attributes.reviewerNickname ?? "",
    territory: attributes.territory ?? "",
    createdDate: attributes.createdDate ?? "",
    reply: reply ? toReply(reply) : null,
  };
}

/** The path for an app's reviews, filtered and sorted. */
export function reviewsPath(appId: string, filter: ReviewFilter = {}): string {
  const params = [`include=response`, `sort=${SORTS[filter.sort ?? "newest"]}`, `limit=${Math.min(filter.limit ?? 20, 200)}`];
  if (filter.ratings?.length) params.push(`filter[rating]=${filter.ratings.join(",")}`);
  if (filter.territory) params.push(`filter[territory]=${encodeURIComponent(filter.territory)}`);
  if (filter.unanswered) params.push("exists[publishedResponse]=false");
  return `/v1/apps/${encodeURIComponent(appId)}/customerReviews?${params.join("&")}`;
}

/** The app's reviews, newest first unless `sort` says otherwise. */
export async function listReviews(appId: string, filter: ReviewFilter = {}): Promise<CustomerReview[]> {
  const doc = await get<ReviewAttributes>(reviewsPath(appId, filter));
  return many(doc).map((resource) => toReview(resource, doc.included));
}

/** One review with its reply, or undefined when there's no such review. */
export async function getReview(id: string): Promise<CustomerReview | undefined> {
  try {
    const doc = await get<ReviewAttributes>(`/v1/customerReviews/${encodeURIComponent(id)}?include=response`);
    const resource = one(doc);
    return resource && toReview(resource, doc.included);
  } catch (error) {
    if ((error as { code?: string }).code === "api-404") return undefined;
    throw error;
  }
}

/** Replies to a review, replacing the reply it has. Apple publishes it after a check (PENDING_PUBLISH until then). */
export async function replyToReview(reviewId: string, text: string): Promise<ReviewReply> {
  const doc = await post<ReplyAttributes>("/v1/customerReviewResponses", {
    data: {
      type: "customerReviewResponses",
      attributes: { responseBody: text },
      relationships: { review: { data: { type: "customerReviews", id: reviewId } } },
    },
  });
  const created = one(doc);
  return created ? toReply(created) : { id: "", body: text, state: "PENDING_PUBLISH", lastModifiedDate: null };
}

/** Deletes a reply. */
export const deleteReply = (replyId: string) => del(`/v1/customerReviewResponses/${encodeURIComponent(replyId)}`);
