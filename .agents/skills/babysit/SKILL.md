---
name: babysit
description: >-
  Babysit a GitHub pull request until it merges. Use when asked to watch, shepherd, or babysit a PR:
  monitor Codex review and checks, fix findings and conflicts, push follow-up commits, resolve review
  threads, and squash-merge when ready.
---

# Babysit

Own the PR until GitHub reports `MERGED`. This authorizes fixes, commits, pushes, resolving review
threads, and the final squash merge. Ask only when the PR is unknown or a product decision,
permission, or external blocker requires the user.

Never force-push, dismiss reviews, close the PR, or change another PR. Preserve unrelated work,
follow `AGENTS.md`, and use the commit skill.

## Loop

1. Resolve the PR, make sure the worktree is clean, and fetch head and `main`. If `main` moved, check
   `git diff origin/main...HEAD --stat` still matches the intended change.
2. Watch it. The script prints the current state, then blocks until something changes (head,
   checks, mergeability, threads, reviews, comments) and prints it again, or prints
   `{"type":"QUIET"}` after 10 minutes. Handle what it prints, then run the same command again:

   ```bash
   .agents/skills/babysit/scripts/watch.sh OWNER/REPO NUMBER
   ```

3. Handle changes in order: review feedback, then conflicts and checks, then merging. Re-read remote
   state before every write, and fold in any push you didn't make.

## Review

Codex (`chatgpt-codex-connector[bot]`) reviews when the PR opens or leaves draft, and sometimes again
on new commits. It reacts 👀, then posts a review with inline findings tagged P0–P2, or a 👍 when it
finds nothing. Its "Codex Review Summary" comment shows each review's commit, status and trigger.
Allow 10 minutes for a review to land before treating it as missing.

If a push starts a review, wait for it. If not, comment `@codex review` at most once per PR, and only
when the fixes materially change the implementation, behavior, or risk; not for local corrections.
If Codex never reviewed the PR at all, comment `@codex review` once and wait for it.

Converge instead of chasing every round. On the first Codex review, fix every accurate finding. On
later reviews, fix only P0/P1 findings and human requests; resolve P2s without a change unless the
fix is a one-liner you can batch with a P0/P1 fix, and name them in your report. Never push only for
a P2.

Read every review body and top-level comment too, not just inline threads, with
`gh pr view NUMBER --comments`; the watcher only shows recent ones, without bodies. A human's
comments outrank Codex's.

## Repair

- Check each unresolved thread against the current code. Fix accurate findings with the smallest
  complete change, with a test that would have caught it. Leave inaccurate findings unfixed, but say
  why when you report.
- Batch fixes, run `bun run check`, commit, and push. Then resolve the threads you fixed or ruled out
  with the `resolveReviewThread` GraphQL mutation and confirm `isResolved: true`. Don't reply in the
  threads. An outdated thread is not resolved.
- ship has no CI today. If checks appear and fail on the current head, read them with
  `gh pr checks` and `gh run view`, fix deterministic failures, and rerun a verified flake once.
- For conflicts, merge `origin/main` into the branch, validate, commit, and push.

## Merge

Merge when the PR is not a draft, the head is current, `mergeable` is `MERGEABLE`, checks (if any)
pass, no Codex review is running, and no actionable feedback or unresolved thread is left. The
latest Codex review's `commit` must be the head, or every commit after it must be a local fix to its
findings; otherwise comment `@codex review` and wait.

The title and body become the commit on `main`, so read `gh pr diff NUMBER` against them first.
Review fixes change code: when the body claims something the diff no longer does, misses a behavior
a fix added, or mentions review rounds, rewrite it by the pr skill's Description rules with
`gh pr edit NUMBER --body-file -` and a single-quoted heredoc.

Then merge with an explicit message. GitHub's own squash body re-wraps the description at 72
columns, splitting inline code, and appends a `---------` co-author block. `squash-body.sh` prints
the description without "Generated with" lines or `Co-authored-by` trailers. Run the steps as one
chain, so a failed read stops the merge instead of shipping an empty body or subject:

```bash
body=$(mktemp) &&
  title=$(gh pr view NUMBER -R OWNER/REPO --json title -q .title) && [ -n "$title" ] &&
  .agents/skills/babysit/scripts/squash-body.sh OWNER/REPO NUMBER > "$body" &&
  gh pr merge NUMBER -R OWNER/REPO --squash --match-head-commit <reviewed-head-sha> \
    --subject "$title (#NUMBER)" --body-file "$body"
```

Pin the head you checked, so a push that lands in between fails the merge instead of shipping
unreviewed code; on that failure, go back to the loop. Always squash: the repo also allows merge
commits and rebases, but `main` keeps one commit per PR. It doesn't delete branches on merge, and a
worktree may still have the branch checked out, so leave it. After merging, fetch `main` and read
`git log -1 --format=%B origin/main` once: each paragraph should be one line, with no attribution
lines. `main` can't be rewritten, so report a mangled message rather than trying to fix it.

Stop when the PR is merged, closed, or blocked. A draft counts as blocked: report it instead of
marking it ready. Report the URL, outcome or blocker, pushed commits, and resolved threads.
