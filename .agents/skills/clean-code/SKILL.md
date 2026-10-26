---
name: clean-code
description:
  Review the current change set for correctness, structure, naming, and comments. Use before opening
  a PR, or when asked to review a branch, PR, or files.
argument-hint: '[git ref | file paths | PR number]'
---

# Clean Code Review

Spawn `code-reviewer` and `comment-reviewer` in one turn, each with the argument and scope below.
Merge their findings into one severity-grouped report.

Argument: **$ARGUMENTS**

## Context

- Branch: !`git branch --show-current`
- Diff stat vs origin/main: !`git fetch -q origin main 2>/dev/null; git diff --stat origin/main...HEAD 2>/dev/null | tail -8`
- Working tree: !`git status --porcelain | head -30`

## Scope

| Argument                 | Review                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| empty                    | `BASE=$(git merge-base origin/main HEAD)`; `git diff $BASE` plus untracked source (`git ls-files --others --exclude-standard`). On `main`: `git diff HEAD` + untracked. |
| PR number or URL         | `gh pr diff "$ARGUMENTS"`                                                                                                                                        |
| `A..B` / `A...B` / a rev | that range, or `git show <rev>`                                                                                                                                  |
| paths                    | those files, whole                                                                                                                                               |

Drop `bun.lock`, `dist/`, `.ship/`, binaries, `.env*`, and `.papercuts.jsonl`. The store-folder
fixtures in tests are data; review them only when the argument names them.

## Report

Report confirmed findings only; zero is fine. Deduplicate the same root cause; keep file, lines, and
worker tag. Do not demand refactors of untouched code.
