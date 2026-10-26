// JUnit XML for checks (--junit <path>), so CI shows what ship found as test
// results: each check or problem is a test case, and only the ones that
// should stop a release fail. Warnings pass, with the warning as output.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Problem } from "./store/check";
import { ShipError } from "./ui";

export interface JUnitCase {
  name: string;
  /** Fails the suite. */
  failure?: { message: string; detail?: string };
  /** Passes, with this as its output (a warning). */
  output?: string;
}

export interface JUnitSuite {
  /** Like "ship release submit". */
  name: string;
  cases: JUnitCase[];
}

const escape = (text: string) =>
  text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** The suite as a JUnit XML document. */
export function junitXML(suite: JUnitSuite): string {
  const failures = suite.cases.filter((item) => item.failure).length;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${escape(suite.name)}" tests="${suite.cases.length}" failures="${failures}">`,
    `  <testsuite name="${escape(suite.name)}" tests="${suite.cases.length}" failures="${failures}" errors="0" skipped="0">`,
  ];
  for (const item of suite.cases) {
    const open = `    <testcase classname="${escape(suite.name)}" name="${escape(item.name)}"`;
    if (!item.failure && !item.output) {
      lines.push(`${open}/>`);
      continue;
    }
    lines.push(`${open}>`);
    if (item.failure) {
      const detail = item.failure.detail ? escape(item.failure.detail) : "";
      lines.push(`      <failure message="${escape(item.failure.message)}">${detail}</failure>`);
    }
    if (item.output) lines.push(`      <system-out>${escape(item.output)}</system-out>`);
    lines.push("    </testcase>");
  }
  lines.push("  </testsuite>", "</testsuites>", "");
  return lines.join("\n");
}

/** Checks like release submit's and doctor's: a failed blocking check fails; a failed warning passes with its detail. */
export function checksSuite(name: string, checks: { name: string; ok: boolean; detail: string; blocking?: boolean; fix?: string }[]): JUnitSuite {
  return {
    name,
    cases: checks.map((check) => {
      if (check.ok) return { name: check.name };
      if (check.blocking === false) return { name: check.name, output: `${check.detail}${check.fix ? `\n${check.fix}` : ""}` };
      return { name: check.name, failure: { message: check.detail, detail: check.fix } };
    }),
  };
}

/** A validate's problems: each error fails, each warning passes with its message, and none at all is one passing case. */
export function problemsSuite(name: string, problems: Problem[]): JUnitSuite {
  if (!problems.length) return { name, cases: [{ name: "valid" }] };
  return {
    name,
    cases: problems.map((problem) => {
      const where = `${problem.file}${problem.field ? ` (${problem.field})` : ""}`;
      return problem.severity === "error" ? { name: where, failure: { message: problem.message } } : { name: where, output: problem.message };
    }),
  };
}

/** Writes the report to `path`, making its folder. */
export async function writeJUnit(path: string, suite: JUnitSuite): Promise<string> {
  const full = resolve(path);
  try {
    mkdirSync(dirname(full), { recursive: true });
    await Bun.write(full, junitXML(suite));
  } catch (error) {
    throw new ShipError(`Couldn't write the JUnit report to ${path} (${error instanceof Error ? error.message : String(error)})`, "junit-failed", "Pass a path you can write to, like --junit .ship/junit.xml.");
  }
  return full;
}
