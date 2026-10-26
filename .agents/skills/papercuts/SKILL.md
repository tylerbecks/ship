---
name: papercuts
description:
  Triage the papercut log (.papercuts.jsonl) and fix the repo friction agents keep hitting. Use when
  asked to review, triage, clean up or fix papercuts. Filing one mid-task needs no skill: see AGENTS.md
  "Papercuts".
argument-hint: '[tag | papercut ids]'
---

# Fix papercuts

Argument: **$ARGUMENTS** (empty: the whole open log; a tag or ids: only those)

## Open papercuts

!`bun papercuts list`

## Triage, before fixing anything

Read each cut in scope with `bun papercuts show <id>...` first: its evidence is what the filer saw.

1. **Re-test each cut against the filter** in AGENTS.md "Papercuts": would a contributor on a fresh
   checkout hit it, and can a change in this repo prevent it? Noise gets
   `bun papercuts resolve <id> --note "noise: <why>"`.
2. **Merge duplicates** into the clearest one: `--note "dup of pc_…"`, and carry its hits over
   with `bun papercuts again <kept id>` once per hit on the duplicate (repeat the id: `again <kept> <kept>`).
3. **Reproduce** what's left. A cut that no longer happens: `--note "gone: <what fixed it, if known>"`.
4. **Route real product bugs** out of the log: fix them as normal work or tell the user, then
   resolve with a note saying where they went.

## Fix

- Most-hit and `blocker`/`major` first, then the cheapest `minor`s. Prefer the fix that stops the
  whole class (a clearer `ShipError` hint, a check in `bin/agent-hook.ts`, a doc line where agents
  look first) over a one-off.
- One logical fix per commit, and resolve the cuts in the same commit:
  `bun papercuts resolve <id>... --note "<what changed>"`. The PR number goes in later notes if useful.
- Docs fixes go where the agent would have looked when it hit the cut: `AGENTS.md`, `README.md`, a
  skill, or the command's own `--help` or error hint.
- Stop and ask before a fix that changes product behavior, the `--json` output, secrets handling, or
  `ship --help`.

## Report

Per cut: fixed (and how), resolved as noise or duplicate, routed elsewhere, or left open (and why).
