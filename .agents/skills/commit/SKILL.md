---
name: commit
description:
  Generate conventional commit messages with emojis. Use when creating git
  commits.
allowed-tools:
  - Bash(git add:*)
  - Bash(git status:*)
  - Bash(git commit:*)
  - Bash(git diff:*)
  - Bash(git log:*)
argument-hint: '[optional message hint]'
---

# Create Commit

Branch commits are working notes. ship squash-merges every PR, and `main` gets the PR title and
description, never these messages. They are read by the pr and babysit skills, Codex, and the next
agent on the branch, so keep them accurate and short.

If the user provided a hint, use it: **$ARGUMENTS**

## Context (gathered automatically)

If a line below is empty or still shows its command, run that command yourself.

- Working tree status: !`git status --porcelain`
- Staged files: !`git diff --cached --stat`
- Staged diff: !`git diff --cached`
- Recent commits: !`git log --oneline -5`

## Stage

If nothing is staged, stage the files that belong to this change by name, never with `git add -A`;
ask when unrelated work is mixed in. Describe everything staged, including work from earlier
sessions, not just your own edits.

## Message

Title: `EMOJI TYPE: summary`, from this closed set. Do not substitute other emojis or types.

- 🚀 feat: New feature
- 🐛 fix: Bug fix
- 📚 docs: Documentation
- 🛠️ refactor: Code change (no new feature/fix)
- ⚡ perf: Performance improvement
- 🧪 test: Tests
- 🧹 chore: Build/clean up

Use `TYPE!:` when the change breaks something scripts or agents rely on: renaming or removing a
`--json` field, a command, an action or a flag, changing an error `code` or what exits with which
code, or moving a store-folder file. Adding any of those is not breaking. Start the summary
lowercase when natural, with no trailing period, short enough to read in `git log --oneline`.

Add a body only when the title can't carry the reason: what was wrong or missing, and why this
approach, in a sentence or two. Take the reason from the user's words or the hint; if you don't have
one, leave the body out rather than invent it. No test results, file lists, or session story. Do not
hard-wrap: each paragraph is one physical line.

## Commit

Run `git commit -F -` with a single-quoted heredoc so the message reaches git exactly. Add no
`Co-authored-by` trailer or other AI attribution.

There's no pre-commit hook; the agent stop hook (`bin/agent-hook.ts`) typechecks and tests when
TypeScript changed, committed or not. Never `--amend` a commit to fix it up; make another.

## Examples

```text
🐛 fix: wait for the --version's build in ship builds show --wait
```

```text
🚀 feat: ship reviews: list, show, and reply to customer reviews

Replying replaces the reply a review has, since that's what Apple's create endpoint does; unreply deletes it.
```
