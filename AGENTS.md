# Agent notes

`ship` is a TypeScript CLI on Bun, compiled to one binary. Read README.md first.

## Layout

- `src/cli.ts`: global flags and dispatch only
- `src/command.ts`: the `Command` type, flag helpers (`stringFlag`, `boolFlag`, `intFlag`, `listFlag`, and `checkActionFlags`, which makes a flag passed to the wrong action a usage error), and `ship --help` rendering
- `src/commands/`: one file per command group, each exporting `commands: Command[]`. `src/commands/index.ts` is the registry. **A new command is a new file in src/commands plus one line in commands/index.ts.**
- `src/asc/`: the App Store Connect API. `client.ts` signs requests (ES256 JWT, cached per key), retries 429/5xx and network failures, and turns Apple's errors into `AscError` (code `api-<status>`, with a hint). One file per area: `apps.ts`, `builds.ts` (builds, their expiry, and what they're attached to), `testflight.ts` (groups, testers, beta localizations and review details), `feedback.ts` (tester screenshots and crashes), `versions.ts` (which App Store version and App Info are editable or live), `metadata.ts` (the page's text, categories, age rating, App Review details), `media.ts` (screenshot and preview sets: reserve, upload parts, commit, reorder), `release.ts` (versions, builds, review submissions, phased release, and the pre-submission checks)
- `src/store/`: the store folder (`appstore/` next to ship.json), which `metadata`, `screenshots`, and `testflight` each pull, diff, push, and validate the same way:
  - `files.ts` (paths, text files, locales, app.json types and key order) and `check.ts` (offline validators every `validate` shares)
  - `limits.ts` (which locale file is which field, and Apple's limits) and `metadata.ts` (the App Store page: plan, push, pull)
  - `images.ts` (display types, pixel sizes, PNG/JPEG headers) and `media.ts` (screenshots and previews, and `media.lock.json`)
  - `testflight.ts` (`appstore/testflight/`: test information and Beta App Review details)
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
- `src/ui.ts`: output; every error is a `ShipError` with a code and a hint
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

`bun test`, `bun run typecheck`, then `bun run install-local` to update `~/.local/bin/ship`.

## Commits

Emoji conventional commits (🚀 feat, 🐛 fix, 📚 docs, 🛠️ refactor, ⚡ perf, 🧪 test, 🧹 chore). Commit only when asked.
