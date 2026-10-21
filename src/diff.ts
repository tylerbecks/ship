// What would change in App Store Connect: the fields where the files in the
// repo (desired) differ from what's there now (remote), shown to people as a
// short diff and to agents as JSON. Every pull/diff/push command uses it, so
// they all read the same.

/** One field that differs. */
export interface Change {
  /** What the field belongs to: "app", "review", "en-US", "testflight/en-US", "en-US/screenshots/APP_IPHONE_67". */
  scope: string;
  /** The field, like "description" or "contactEmail" or a file name. */
  field: string;
  kind: "add" | "change" | "remove";
  /** The remote value (undefined when added). */
  from?: unknown;
  /** The desired value (undefined or null when removed). */
  to?: unknown;
  /** Masked as "••••" in every rendering. */
  secret?: boolean;
}

export const MASK = "••••";

// MARK: Comparing

/** Normalizes text for comparison: CRLF → LF, trailing whitespace trimmed. null, undefined, and "" are all empty. */
export function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const text = value.replace(/\r\n?/g, "\n").trimEnd();
    return text === "" ? undefined : text;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, normalize(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

/** Whether two values are the same once normalized; arrays and objects are compared structurally. */
export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

const isEmpty = (value: unknown) => normalize(value) === undefined;

/**
 * Field changes from remote to desired. A key missing from desired isn't
 * managed and never changes; a key that's there but empty ("" or null)
 * clears the field.
 */
export function diffRecord(
  scope: string,
  remote: Record<string, unknown> | undefined,
  desired: Record<string, unknown>,
  options: { secret?: string[] } = {},
): Change[] {
  const changes: Change[] = [];
  for (const [field, to] of Object.entries(desired)) {
    if (to === undefined) continue;
    const from = remote?.[field];
    if (same(from, to)) continue;
    const kind = isEmpty(from) ? "add" : isEmpty(to) ? "remove" : "change";
    const change: Change = { scope, field, kind };
    if (kind !== "add") change.from = from;
    change.to = kind === "remove" ? null : to;
    if (options.secret?.includes(field)) change.secret = true;
    changes.push(change);
  }
  return changes;
}

// MARK: Line diffs

/** A line diff by longest common subsequence: " " for kept lines, "-" for removed, "+" for added. */
export function lineDiff(a: string, b: string): { op: " " | "+" | "-"; line: string }[] {
  const x = a === "" ? [] : a.replace(/\r\n?/g, "\n").split("\n");
  const y = b === "" ? [] : b.replace(/\r\n?/g, "\n").split("\n");
  // Long texts would make the table huge; past this, show a plain replace.
  if (x.length * y.length > 250_000) {
    return [...x.map((line) => ({ op: "-" as const, line })), ...y.map((line) => ({ op: "+" as const, line }))];
  }
  const n = x.length;
  const m = y.length;
  // lcs[i][j]: the length of the longest common subsequence of x[i..] and y[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: { op: " " | "+" | "-"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: " ", line: x[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: "-", line: x[i++]! });
    } else {
      out.push({ op: "+", line: y[j++]! });
    }
  }
  while (i < n) out.push({ op: "-", line: x[i++]! });
  while (j < m) out.push({ op: "+", line: y[j++]! });
  return out;
}

/** The changed lines with `context` lines around them; gaps become "…". At most `max` lines. */
export function compactDiff(a: string, b: string, options: { context?: number; max?: number } = {}): string[] {
  const { context = 3, max = 20 } = options;
  const diff = lineDiff(a, b);
  const keep = diff.map(() => false);
  diff.forEach((entry, index) => {
    if (entry.op === " ") return;
    for (let k = Math.max(0, index - context); k <= Math.min(diff.length - 1, index + context); k++) keep[k] = true;
  });
  const lines: string[] = [];
  let skipped = false;
  diff.forEach((entry, index) => {
    if (!keep[index]) {
      skipped = true;
      return;
    }
    if (skipped && lines.length) lines.push("…");
    skipped = false;
    lines.push(`${entry.op} ${entry.line}`.trimEnd());
  });
  if (lines.length > max) {
    const rest = lines.length - max;
    return [...lines.slice(0, max), `… (${rest} more line${rest === 1 ? "" : "s"})`];
  }
  return lines;
}

// MARK: Rendering

const chars = (text: string) => [...text].length;
const isText = (value: unknown): value is string => typeof value === "string";
const multiline = (value: unknown) => isText(value) && value.replace(/\r\n?/g, "\n").trimEnd().includes("\n");

/** A value on one line: quoted text (shortened past 60 characters), or compact JSON. */
function show(value: unknown, secret?: boolean): string {
  if (secret) return MASK;
  if (isText(value)) {
    const text = value.replace(/\r\n?/g, "\n").trimEnd();
    const short = chars(text) > 60 ? `${[...text].slice(0, 59).join("")}…` : text;
    return JSON.stringify(short);
  }
  return JSON.stringify(value) ?? "nothing";
}

function renderChange(change: Change): string[] {
  const { field, kind, from, to, secret } = change;
  const sign = kind === "add" ? "+" : kind === "remove" ? "-" : "~";
  if (!secret && (multiline(from) || multiline(to))) {
    const before = isText(from) ? from.replace(/\r\n?/g, "\n").trimEnd() : "";
    const after = isText(to) ? to.replace(/\r\n?/g, "\n").trimEnd() : "";
    const size = kind === "add" ? `${chars(after)} chars` : kind === "remove" ? `${chars(before)} chars` : `${chars(before)} → ${chars(after)} chars`;
    return [`  ${sign} ${field} (${size})`, ...compactDiff(before, after).map((line) => `      ${line}`)];
  }
  if (kind === "add") return [`  + ${field}: ${show(to, secret)}`];
  if (kind === "remove") return [`  - ${field}: ${show(from, secret)}`];
  return [`  ~ ${field}: ${show(from, secret)} → ${show(to, secret)}`];
}

/** For people: one line per change, grouped by scope; multi-line text gets a compact +/- line diff (3 lines of context, capped). */
export function renderChanges(changes: Change[]): string {
  const scopes: string[] = [];
  const byScope = new Map<string, Change[]>();
  for (const change of changes) {
    if (!byScope.has(change.scope)) {
      scopes.push(change.scope);
      byScope.set(change.scope, []);
    }
    byScope.get(change.scope)!.push(change);
  }
  return scopes.flatMap((scope) => [scope, ...byScope.get(scope)!.flatMap(renderChange)]).join("\n");
}

/** For --json: the changes with secrets masked. Field names are an API. */
export function changesJSON(changes: Change[]): Change[] {
  return changes.map(({ scope, field, kind, from, to, secret }) => {
    const mask = (value: unknown) => (secret && value !== undefined && value !== null ? MASK : value);
    const change: Change = { scope, field, kind };
    if (from !== undefined) change.from = mask(from);
    if (to !== undefined) change.to = mask(to);
    if (secret) change.secret = true;
    return change;
  });
}
