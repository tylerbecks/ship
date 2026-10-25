// ship reviews: what people write about the app on the App Store, and the
// developer's reply to each. Lists them, shows one, and replies.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type CustomerReview, REPLY_MAX, type ReviewSort, deleteReply, getReview, listReviews, replyToReview } from "../asc/reviews";
import { chars } from "../store/check";
import { type Command, type Context, boolFlag, checkActionFlags, intFlag, listFlag, stringFlag } from "../command";
import { loadProject } from "../config";
import { ShipError, table, ui } from "../ui";
import { appId } from "./status";

export const reviewsHelp = `ship reviews [list] [--rating <n>] [--territory <code>] [--unanswered] [--sort <order>] [--limit <n>]
ship reviews show <id>
ship reviews reply <id> (--text <text> | --text-file <path>) [--dry-run]
ship reviews unreply <id> [--dry-run]

Customer reviews from the App Store, newest first. reply answers one in
public (or replaces the answer it has); Apple checks it before it shows,
so it's PENDING_PUBLISH for a while. unreply deletes the answer.

Reading reviews needs a key with the Customer Support, App Manager, or
Admin role.

  --rating <n>        Only this many stars, 1 to 5; repeat for more
  --territory <code>  Only this App Store, like USA or GBR
  --unanswered        Only reviews without a published reply
  --sort <order>      newest (default), oldest, lowest, or highest
  --limit <n>         How many (default 20, up to 200)
  --text <text>       reply: the answer
  --text-file <path>  reply: the answer from a file (- reads stdin)
  --dry-run           reply, unreply: show what would change`;

const ACTIONS = ["list", "show", "reply", "unreply"];

const ACTION_FLAGS: Record<string, string[]> = {
  list: ["rating", "territory", "unanswered", "sort", "limit"],
  show: [],
  reply: ["text", "text-file", "dry-run"],
  unreply: ["dry-run"],
};

const SORTS: ReviewSort[] = ["newest", "oldest", "lowest", "highest"];

const usage = (message: string, hint: string, details?: Record<string, unknown>) => new ShipError(message, "usage", hint, details, 2);

// MARK: Pure parts

/** --rating values as whole stars, 1 to 5, without repeats. */
export function parseRatings(values: string[]): number[] {
  const ratings = values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  for (const value of ratings) {
    if (!/^[1-5]$/.test(value)) throw usage(`--rating takes 1 to 5 stars, not "${value}"`, "For example: --rating 1 --rating 2 (the one- and two-star reviews)");
  }
  return [...new Set(ratings.map(Number))].sort();
}

/** --territory as Apple's three-letter code. */
export function parseTerritory(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw usage(`--territory takes a three-letter App Store code, not "${value}"`, "For example: --territory USA, GBR, or DEU");
  return code;
}

/** A reply Apple would take: something, and not over its limit. */
export function checkReply(text: string): string {
  const trimmed = text.replace(/\r\n?/g, "\n").trim();
  if (!trimmed) throw usage("The reply is empty", 'Pass the answer with --text "…" or --text-file <path>. To delete a reply: ship reviews unreply <id>');
  if (chars(trimmed) > REPLY_MAX) {
    throw usage(`The reply is ${chars(trimmed)} characters; Apple takes up to ${REPLY_MAX}`, "Shorten it and try again.");
  }
  return trimmed;
}

export const stars = (rating: number) => "★".repeat(Math.max(0, Math.min(5, rating))) + "☆".repeat(Math.max(0, 5 - rating));

const day = (date: string) => (date ? new Date(date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

const oneLine = (text: string, max = 50) => {
  const line = text.replace(/\s+/g, " ").trim();
  return [...line].length > max ? `${[...line].slice(0, max - 1).join("")}…` : line;
};

const replyState = (review: CustomerReview) => (!review.reply ? "" : review.reply.state === "PUBLISHED" ? "replied" : "reply pending");

// MARK: Command

async function readText(ctx: Context): Promise<string> {
  const text = stringFlag(ctx, "text");
  const file = stringFlag(ctx, "text-file");
  if ((text === undefined) === (file === undefined)) {
    throw usage(text === undefined ? "What's the reply? Pass --text or --text-file" : "Pass --text or --text-file, not both", 'For example: ship reviews reply <id> --text "Thanks! Fixed in 1.5."');
  }
  if (text !== undefined) return checkReply(text);
  if (file === "-") {
    if (process.stdin.isTTY) throw usage("--text-file - reads the reply from a pipe, not the terminal", "For example: cat reply.txt | ship reviews reply <id> --text-file -");
    return checkReply(await Bun.stdin.text());
  }
  const full = resolve(file!);
  if (!existsSync(full) || !statSync(full).isFile()) throw usage(`No file at ${file}`, `Check the path (it's relative to ${process.cwd()}).`);
  return checkReply(await Bun.file(full).text());
}

async function reviewOrFail(id: string): Promise<CustomerReview> {
  const review = await getReview(id);
  if (!review) throw new ShipError(`No review with id ${id}`, "no-review", "`ship reviews` lists the ids (the first column).", { id });
  return review;
}

async function reviews(ctx: Context) {
  const action = ctx.args[0] ?? "list";
  if (!ACTIONS.includes(action)) {
    throw usage(`Unknown reviews action "${action}"`, `ship reviews [${ACTIONS.join("|")}] (see \`ship reviews --help\`)`, { choices: ACTIONS });
  }
  checkActionFlags(ctx, "reviews", action, ACTION_FLAGS);
  const ids = ctx.args.slice(1);
  if (action === "list" && ids.length) throw usage("ship reviews list takes no ids", "To see one: ship reviews show <id>");
  if (action !== "list" && ids.length !== 1) throw usage(`Pass one review id: ship reviews ${action} <id>`, "`ship reviews` lists the ids.");
  const dryRun = boolFlag(ctx, "dry-run");

  if (action === "list") {
    const ratings = parseRatings(listFlag(ctx, "rating"));
    const territory = parseTerritory(stringFlag(ctx, "territory"));
    const sort = stringFlag(ctx, "sort") ?? "newest";
    if (!SORTS.includes(sort as ReviewSort)) throw usage(`--sort takes ${SORTS.join(", ")}, not "${sort}"`, "For example: --sort lowest", { choices: SORTS });
    const limit = intFlag(ctx, "limit", { min: 1, max: 200 }) ?? 20;
    const id = await appId(await loadProject({ app: ctx.app }));
    const found = await listReviews(id, { ratings, territory, unanswered: boolFlag(ctx, "unanswered"), sort: sort as ReviewSort, limit });
    return ui.result({ reviews: found }, () => {
      if (!found.length) return console.log(ratings.length || territory || boolFlag(ctx, "unanswered") ? "No reviews match." : "No reviews yet.");
      console.log(
        table([
          ["ID", "DATE", "RATING", "STORE", "TITLE", "REPLY"],
          ...found.map((review) => [review.id, day(review.createdDate), stars(review.rating), review.territory, oneLine(review.title || review.body), replyState(review)]),
        ]),
      );
    });
  }

  // show, reply, and unreply take one review (its id is the whole App Store's, so no project is needed);
  // reading it first checks the id and the key's role.
  const text = action === "reply" ? await readText(ctx) : undefined;
  const review = await reviewOrFail(ids[0]!);

  if (action === "show") return ui.result({ review }, () => printReview(review));

  if (action === "reply") {
    if (dryRun) {
      return ui.result({ review, reply: { body: text }, dryRun, replaced: Boolean(review.reply) }, () =>
        console.log(`Would ${review.reply ? "replace the reply to" : "reply to"} ${review.reviewer || "this review"}:\n\n${text}`),
      );
    }
    const reply = await replyToReview(review.id, text!);
    ui.ok(review.reply ? "Replaced the reply" : "Replied");
    return ui.result({ review: { ...review, reply }, reply, dryRun, replaced: Boolean(review.reply) }, () =>
      console.log(reply.state === "PUBLISHED" ? "It's on the App Store." : "Apple checks replies before they show, usually within a day."),
    );
  }

  // unreply
  if (!review.reply) {
    throw new ShipError("That review has no reply", "no-reply", "`ship reviews show <id>` shows it; `ship reviews reply <id> --text …` answers it.", { id: review.id });
  }
  if (!dryRun) {
    await deleteReply(review.reply.id);
    ui.ok("Deleted the reply");
  }
  ui.result({ review: { ...review, reply: dryRun ? review.reply : null }, deleted: dryRun ? null : review.reply, dryRun }, () =>
    console.log(dryRun ? `Would delete the reply:\n\n${review.reply!.body}` : "The review has no reply now."),
  );
}

function printReview(review: CustomerReview) {
  console.log(`${stars(review.rating)}  ${review.title}`);
  console.log(`${review.reviewer || "Someone"}, ${review.territory} App Store, ${day(review.createdDate)}`);
  if (review.body) console.log(`\n${review.body}`);
  if (review.reply) {
    const state = review.reply.state === "PUBLISHED" ? "Your reply" : "Your reply (Apple is checking it)";
    console.log(`\n${state}:\n${review.reply.body}`);
  } else {
    console.log(`\nNo reply yet: ship reviews reply ${review.id} --text "…"`);
  }
}

export const commands: Command[] = [
  {
    name: "reviews",
    index: [{ section: "appstore", label: "reviews", summary: "Customer reviews, and replying to them" }],
    help: reviewsHelp,
    flags: {
      rating: { type: "string", multiple: true },
      territory: { type: "string" },
      unanswered: { type: "boolean" },
      sort: { type: "string" },
      limit: { type: "string" },
      text: { type: "string" },
      "text-file": { type: "string" },
      "dry-run": { type: "boolean" },
    },
    run: reviews,
  },
];
