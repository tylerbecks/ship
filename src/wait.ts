// Waiting for App Store Connect: a build to process, App Review to decide.
// Commands poll with `waitFor`; --timeout takes a duration like 30m or 2h.

import { ShipError } from "./ui";

/** Polling settings. Tests set `sleep` (and `now`) to skip the waiting. */
export const polling = {
  sleep: (ms: number): Promise<void> => Bun.sleep(ms),
  now: () => Date.now(),
};

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };

/** A duration like 90s, 30m, 2h, or 1d, in milliseconds. `flag` names it in the error. */
export function parseDuration(value: string, flag = "--timeout"): number {
  const match = value.trim().match(/^(\d+)\s*([smhd])$/i);
  const amount = match ? Number(match[1]) : 0;
  if (!match || amount <= 0) {
    throw new ShipError(`${flag} takes a duration like 30m, not "${value}"`, "usage", `For example: ${flag} 90s, 30m, 2h, or 1d.`, undefined, 2);
  }
  return amount * UNITS[match[2]!.toLowerCase()]!;
}

/** "45 minutes", "2 hours", "1 day": a duration for people. */
export function describeDuration(ms: number): string {
  const [unit, size] = ms % UNITS.d! === 0 ? ["day", UNITS.d!] : ms % UNITS.h! === 0 ? ["hour", UNITS.h!] : ms % UNITS.m! === 0 ? ["minute", UNITS.m!] : ["second", UNITS.s!];
  const amount = Math.round(ms / size);
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

/** What one look at App Store Connect found: finished with a value, or still going (in `state`, for the progress line). */
export type Poll<T> = { done: true; value: T } | { done: false; state: string };

/**
 * Calls `check` every `everyMs` until it's done, printing `state` through
 * `progress` each time it changes. After `timeoutMs`, throws what `timedOut`
 * returns (a ShipError with code still-pending or processing-timeout, so it
 * exits 7).
 */
export async function waitFor<T>(options: {
  check: () => Promise<Poll<T>>;
  everyMs: number;
  timeoutMs: number;
  progress?: (state: string) => void;
  timedOut: (last: string) => ShipError;
}): Promise<T> {
  const deadline = polling.now() + options.timeoutMs;
  let last = "";
  while (true) {
    const result = await options.check();
    if (result.done) return result.value;
    if (result.state !== last) {
      options.progress?.(result.state);
      last = result.state;
    }
    const left = deadline - polling.now();
    if (left <= 0) throw options.timedOut(last);
    await polling.sleep(Math.min(options.everyMs, left));
  }
}
