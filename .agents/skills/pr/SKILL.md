---
name: pr
description: Prepare and create a GitHub PR
allowed-tools:
  - Bash(git:*)
  - Bash(gh:*)
argument-hint: '[draft]'
---

# Create Pull Request

Push the current branch and open a PR against `main` on the `origin` remote. Include `--draft` when
the user asks for a draft.

## Prepare

Fetch `origin/main`, then inspect the branch status, complete commit log, net diff, and issue
references. Write from the whole proposed change, including work from earlier commits or sessions;
the final diff is authoritative when commit history includes reverted work.

Stop when:

- there is no `origin` remote, or fetching `origin/main` fails: report it and ask the user to add
  the GitHub remote
- the branch is `main`: ask for a branch name and create it
- tracked or untracked changes are present: ask the user to commit them (use the commit skill)
- the branch has no commits ahead of `origin/main`: report that there is nothing to publish

Before opening the PR, run `bun run check`. When `ship --help` changed, make sure it was on purpose
(AGENTS.md: "`ship --help` is golden"). Then run only the `code-reviewer` agent on the completed
change and fix confirmed Critical findings. Use the `clean-code` skill instead when the user asks for
a full review.

## Title

Use `EMOJI TYPE: summary`, or `EMOJI TYPE!: summary` for a breaking change. Choose the predominant
type from the net diff. Types are a closed set: `🚀 feat`, `🐛 fix`, `📚 docs`, `🛠️ refactor`,
`⚡ perf`, `🧪 test`, `🧹 chore`. `--json` output is an API, so renaming or removing a JSON field,
a command, an action or a flag, changing an error `code` or which code exits with which status, or
moving a store-folder file is breaking; adding any of them is not.

The title becomes the subject of the squash commit on `main`, with ` (#NN)` appended. Name the
change in user terms (the command, flag, or file it touches), start the summary lowercase when
natural, and use no trailing period. Aim for about 65 characters so it still reads in
`git log --oneline`. A title that needs "and" to join two changes is a hint to split the PR.

## Description

The title and description become the squash commit on `main` (the babysit skill passes them to
GitHub at merge), so write the commit message a future agent reading `git log` or `git blame` will
need. Codex reviews from the same text. Open with unheaded prose that covers, as far as each
applies:

1. What was wrong or missing before, in the user's terms.
2. What changes now, named by the command, flag, `--json` field, error code, or store file it
   touches, never as a file list.
3. Why this behavior is right, and what was deliberately left unchanged or out of scope where a
   reader would assume otherwise.
4. What a user or script must change (a breaking change), and anything a reviewer must check.

Length follows what a reader must know: a sentence or two for a small fix, a short paragraph per
changed behavior for a feature. For each sentence, ask whether removing it could cause a reviewer to
approve the wrong behavior, miss a material risk, or upgrade without changing a script that breaks.
Delete it otherwise.

Take the reason from the user's words in this conversation and from the branch's commit bodies.
When you don't know why, say what changed and stop. Never invent a motive, and never describe a
change the diff doesn't contain.

Do not include test counts or test inventories, implementation inventories, commit sequencing,
investigation history, rejected hypotheses, review rounds, or details about behavior that did not
change. Include unchanged behavior only to prevent a likely reviewer misunderstanding. Convert
supporting investigation into its conclusion and omit even that conclusion when the tests or diff
already establish it.

Use only these sections, and only when they add distinct information:

- `## Evidence`: what a run against real App Store Connect showed (read-only, or with what it
  changed), or unusual behavioral results that change reviewer confidence. Terminal output goes in a
  fenced block, trimmed to the lines that matter
- `## Upgrading`: what a script, CI job, or `ship.json` / store folder needs to change
- `## Limitations`: known gaps, tradeoffs, follow-ups, or meaningful untested risks, like an Apple
  endpoint only exercised against mocks
- `## References`: multiple issue or PR links

Use those headings exactly. Do not use Setext headings.

Never add `Verification`, `Testing`, or equivalent sections. Treat tests, typechecks and builds as
implicit.

Do not hard-wrap prose. Each prose paragraph must be one physical line; GitHub provides soft
wrapping. Use physical line breaks only for blank lines, headings, lists, tables, code blocks, and
other Markdown structures that require them. Use fenced code blocks.

Include deduplicated issue and PR references. Use `Fixes #NN` only when the user's instructions say
the branch completes that issue; use `Refs #NN` for related issues the PR does not complete.
Preserve explicit `Fixes`, `Closes`, or other linkage. A single reference can follow the prose. Add
no attribution line ("Generated with …") or `Co-authored-by` trailer.

## Publish

1. Push with `git push -u origin <branch>`. If the result is non-zero or ambiguous, proceed only
   after confirming the remote branch SHA equals local `HEAD`; otherwise stop.
2. Create the PR against `main` with an explicit title and body; never use `--fill`. Pass generated
   multiline bodies with `--body-file <path>`, or use `--body-file -` with a single-quoted heredoc
   delimiter so Markdown backticks cannot execute in the shell. Never pass them with `--body`;
   escaped newlines otherwise reach GitHub as literal `\n` text. Use the same patterns with
   `gh pr edit`.
3. Resolve ambiguous output before retrying: check the remote branch and upstream after a push, or
   search all PR states for the same base and head after PR creation.
