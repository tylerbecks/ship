# Agent notes

`ship` is a TypeScript CLI on Bun, compiled to one binary. Read README.md first.

## Layout

- `src/cli.ts`: global flags and dispatch only
- `src/command.ts`: the `Command` type, flag helpers (`stringFlag`, `boolFlag`, `intFlag`, `listFlag`, and `checkActionFlags`, which makes a flag passed to the wrong action a usage error), and `ship --help` rendering
- `src/commands/`: one file per command group, each exporting `commands: Command[]`. `src/commands/index.ts` is the registry. **A new command is a new file in src/commands plus one line in commands/index.ts.**
- `src/asc/`: the App Store Connect API. `client.ts` signs requests (ES256 JWT, cached per key), retries 429/5xx and network failures, turns Apple's errors into `AscError` (code `api-<status>`, with a hint), and enforces read-only mode (`policy`, `assertWritable`: every non-GET and every upload goes through it). One file per area: `apps.ts`, `builds.ts` (builds, their expiry, and what they're attached to), `testflight.ts` (groups, testers, beta localizations and review details), `feedback.ts` (tester screenshots and crashes), `versions.ts` (which App Store version and App Info are editable or live), `metadata.ts` (the page's text, categories, age rating, App Review details), `media.ts` (screenshot and preview sets: reserve, upload parts, commit, reorder), `release.ts` (versions, builds, review submissions, phased release, and the pre-submission checks), `reviews.ts` (customer reviews and replies), `users.ts` (the team and invitations), `devices.ts`, `sandbox.ts` (sandbox testers, under /v2)
- `src/store/`: the store folder (`appstore/` next to ship.json), which `metadata`, `screenshots`, and `testflight` each pull, diff, push, and validate the same way:
  - `files.ts` (paths, text files, locales, app.json types and key order) and `check.ts` (offline validators every `validate` shares)
  - `limits.ts` (which locale file is which field, and Apple's limits) and `metadata.ts` (the App Store page: plan, push, pull)
  - `images.ts` (display types, pixel sizes, PNG/JPEG headers) and `media.ts` (screenshots and previews, and `media.lock.json`)
  - `testflight.ts` (`appstore/testflight/`: test information and Beta App Review details)
  - `fastlane.ts` (`metadata import` and `screenshots import`: a fastlane deliver folder as store files)
  - A missing file or key is left alone and an empty one clears; `--prune` is the only way push deletes; passwords are references
- `src/diff.ts`: desired-vs-remote field diffs, rendered for people and as JSON (secrets masked)
- `src/secrets.ts`: where secrets come from: `keychain:`, `op://`, `env:`, `file:`, or literal. `src/keychain.ts` reads and writes Keychain items through `security -i`
- `src/credentials.ts`: the API key, from SHIP_ASC_* or config.json's references
- `src/platform.ts`: ios/macos/tvos/visionos → xcodebuild destination, altool type, App Store Connect platform, package
- `src/build.ts`: archive, export, .ipa/.pkg checks, and upload
- `src/trust.ts`: Xcode's trust prompt for package macros and plugins, and ship.json's `build` settings
- `src/xcode.ts`: finding projects, schemes, and settings
- `src/config.ts`: ship.json, the machine's app list (worktrees map to their main checkout), and settings
- `src/git.ts`: the commit a build comes from, the `testflight/<build>` tags that record it, and worktrees
- `src/notes.ts`: "What to Test" from --notes, a file, and the commit subjects since the previous build
- `src/version.ts`: the app's version (MARKETING_VERSION or Package.swift's displayVersion): read, bump, and write
- `src/ui.ts`: output; every error is a `ShipError` with a code and a hint. Its exit code comes from the code's kind (`EXIT`: 3 auth, 4 not found, 5 conflict, 6 read-only, 7 still pending); a new code that's one of those kinds goes in `EXIT_BY_CODE`
- `src/wait.ts`: `--timeout` durations and `waitFor`, the polling loop behind `--wait` (tests swap `polling.sleep` and `polling.now`)
- `src/junit.ts`: `--junit` reports from checks and validate problems
- `bin/`: repo tools for agents, not part of ship: `agent-hook.ts` (the stop hook: typecheck and test when TypeScript changed) and `papercuts.ts` (`bun papercuts`)
- `.agents/`: agent skills and subagents (canonical; `.claude/skills` and `.claude/agents` symlink here, CLAUDE.md → AGENTS.md). Hooks are wired in `.claude/settings.json` and `.codex/hooks.json`
- `test/setup.ts` (preloaded by bunfig.toml): points SHIP_HOME at a temp folder, runs git without the machine's global config, and makes network, Keychain, and 1Password calls throw. `test/helpers.ts`: `mockAsc`, `jsonApi`, `resource`, `testCredentials`, `noRetryDelay`, `fakeKeychain`, `temp`, `git`, `captureLog`

## Rules

- **No dependencies** unless there's no reasonable alternative. Bun and Node built-ins cover this.
- **Never prompt.** Fail with a `ShipError` that names the choices and the flag to pass.
- **Every error needs a hint** saying what to do, ideally a command.
- **`--json` output is an API.** Don't rename fields; add new ones.
- **Secrets never touch disk** except the API key, written to a private temp folder for the length of one `xcodebuild` or `altool` run (`withKeyFile`).
- **No App Store Connect calls in tests.** Test the pure parts, and mock the rest with `mockAsc` (`bun test`).
- **`ship --help` is golden.** test/cli.test.ts holds the existing index lines; change it only on purpose.

## Checking

`bun run check` (typecheck, then `bun test`), then `bun run install-local` to update `~/.local/bin/ship`. The stop hook typechecks and tests for you when TypeScript changed since the last passing check (uncommitted or committed), and sends the failures back before the turn ends. It does that once per new set of failures: the same failures twice in a row end the turn, with a note.

## Commits

Emoji conventional commits (🚀 feat, 🐛 fix, 📚 docs, 🛠️ refactor, ⚡ perf, 🧪 test, 🧹 chore), with the `commit` skill. Commit only when asked. Every PR is squash-merged, so `main` gets the PR's title and description (the `pr` skill), not the branch's commits. No AI attribution in commits or PRs.

## Papercuts

When the repo itself costs you time (a misleading doc, a command that fails on a clean checkout, a missing script, a hook that misfires, an error hint that sent you the wrong way), file it in one line and keep working:

```bash
bun papercuts add "<what you hit, and what would have prevented it>" --tag <area> [--severity major] \
  [--evidence "<the command, the error line, what got you past it>"]
```

- **Only repo-fixable friction:** a contributor on a fresh checkout would hit it too, and a change to code, scripts or docs would prevent it. Not your sandbox or network, your own typo, a flake that passed on retry, an Apple outage, or a product bug (fix or report that as usual).
- **Severity:** `minor` (default) an annoyance, `major` cost real time, `blocker` you couldn't proceed.
- **Evidence** lets someone who wasn't there fix it: give it for anything past an obvious one-liner. Quote the failing lines, not the whole output (4 KB max; `--evidence -` reads stdin).
- **Already filed?** `bun papercuts list` first; if it's there, `bun papercuts again <id>` instead. Repeat hits are what review fixes first.
- **Tags** name the area: `cli`, `asc`, `store`, `build`, `secrets`, `tests`, `hooks`, `docs`.
- No secrets, API keys, issuer ids, or App Store Connect data in the text or evidence: the log is committed. Don't fix the cut mid-task unless it blocks you; `.papercuts.jsonl` is committed with your branch.

Fixing them is the `papercuts` skill, run when asked.

## Agent skills

| Skill | Use |
|---|---|
| `commit` | Conventional commit with emoji, no scope |
| `pr` | Push and open a GitHub PR whose description becomes the squash commit |
| `babysit` | Watch a PR through Codex review, fix findings, and squash-merge it |
| `clean-code` | Review a change with the `code-reviewer` + `comment-reviewer` agents |
| `papercuts` | Triage the papercut log and fix the most-hit repo friction |

## Code Review Rules

Codex reviews every PR through its GitHub integration and follows this section. Comment `@codex review` to rerun it.

- Hold changes to the Rules above. In particular: a renamed or removed `--json` field, error code, or exit code is a breaking change and needs `!` in the title; a write to App Store Connect must go through `api()` so read-only mode can stop it; a new error of a known kind goes in `EXIT_BY_CODE`.
- Flag any secret written to a file, printed, or sent anywhere but Apple, and any test that could reach the network, the Keychain, or 1Password.
- A flag must narrow every request it claims to (a `--version` that a wait or lookup ignores is a bug), and a flag an action ignores must be a usage error.
- On a re-review (new commits on an already-reviewed PR), report only P0/P1 issues in the lines changed since your last review. Don't raise new P2s on code you already reviewed.
- Skip `bun.lock` and `.papercuts.jsonl`. Don't comment on formatting.
