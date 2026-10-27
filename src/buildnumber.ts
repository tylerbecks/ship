// Which build number `ship beta` uploads next.
//
// Build numbers are one short counter per app that never resets: 1.0.1 (10),
// 1.0.1 (11), then 1.1 (12). One number names one build across versions and
// platforms, and Apple's rules hold everywhere: on iOS a version's builds only
// have to increase, and on macOS every build has to.
//
// A number of 100,000 or more (a timestamp, or one typed by hand) is foreign:
// it never feeds the counter, or one such number would turn every later build
// into a fake timestamp. It only sets a floor for its own train (the version
// on iOS, tvOS and visionOS; every build on macOS), which ship has to stay
// above until the version changes.

import type { AscPlatform } from "./platform";

/** Build numbers at or above this aren't counters. */
export const COUNTER_LIMIT = 100_000;

/** Compares build numbers like 9, 10, and 1.2.3 numerically, part by part. */
export function compareBuildNumbers(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (Number.isNaN(difference)) return a.localeCompare(b);
    if (difference) return difference;
  }
  return 0;
}

/** A build number's first part, like 202610200516 for 202610200516.39. */
const head = (number: string) => Number.parseInt(number, 10);

/** Whether a build number is a counter (below 100,000), not a timestamp or a hand-typed one. */
export const isCounter = (number: string) => Number.isFinite(head(number)) && head(number) < COUNTER_LIMIT;

/**
 * Orders builds as they were shipped: foreign numbers came before the
 * counter took over, then counters by number.
 */
export function compareBuildOrder(a: string, b: string): number {
  if (isCounter(a) !== isCounter(b)) return isCounter(a) ? 1 : -1;
  return compareBuildNumbers(a, b);
}

/** A build App Store Connect has, as far as numbering needs to know. */
export interface NumberedBuild {
  number: string;
  version?: string;
  platform?: AscPlatform;
}

export interface NextBuild {
  build: string;
  /** "counter", or "legacy" when the train already has a foreign number to stay above. */
  numbering: "counter" | "legacy";
  /** The train's highest build, when it forced a legacy number. */
  floor?: string;
}

/**
 * The next build number: one above the app's highest counter (in App Store
 * Connect or claimed by a tag), unless the train already has a higher
 * number. With no counter yet, the count starts at the number of uploads
 * (or the project's own build number, before the first).
 *
 * `builds` are the app's recent uploads (every version and platform) and
 * `train` this version's on this platform (every version, on macOS).
 */
export function nextBuildNumber(input: { builds: NumberedBuild[]; train: NumberedBuild[]; tags?: string[]; local?: string }): NextBuild {
  const numbers = [...input.builds.map((build) => build.number), ...(input.tags ?? [])];
  const counters = numbers.filter(isCounter).map(head);
  let start: number;
  if (counters.length) start = Math.max(...counters);
  else if (input.builds.length) start = input.builds.length;
  else start = input.local && isCounter(input.local) ? head(input.local) : 0;
  const build = String(start + 1);

  const floor = input.train.map((b) => b.number).sort(compareBuildNumbers).at(-1);
  if (floor && compareBuildNumbers(build, floor) <= 0) {
    return isCounter(floor) ? { build: String(head(floor) + 1), numbering: "counter" } : { build: String(head(floor) + 1), numbering: "legacy", floor };
  }
  return { build, numbering: "counter" };
}
