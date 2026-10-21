# Agent notes

`ship` is a TypeScript CLI on Bun, compiled to one binary. Read README.md first.

## Layout

- `src/cli.ts`: global flags and dispatch only
- `src/command.ts`: the `Command` type, flag helpers (`stringFlag`, `boolFlag`, `intFlag`, `listFlag`), and `ship --help` rendering
- `src/commands/`: one file per command group, each exporting `commands: Command[]`. `src/commands/index.ts` is the registry. **A new command is a new file in src/commands plus one line in commands/index.ts.**
- `src/asc/`: the App Store Connect API. `client.ts` signs requests (ES256 JWT, cached per key), retries 429/5xx and network failures, and turns Apple's errors into `AscError` (code `api-<status>`, with a hint). One file per area: `apps.ts`, `builds.ts`, `testflight.ts`, `versions.ts` (which App Store version and App Info are editable or live)
- `src/store/`: the store folder (`appstore/` next to ship.json): `files.ts` (paths, text files, locales, app.json types), `check.ts` (offline validators)
- `src/diff.ts`: desired-vs-remote field diffs, rendered for people and as JSON (secrets masked)
- `src/secrets.ts`: where secrets come from: `keychain:`, `op://`, `env:`, `file:`, or literal. `src/keychain.ts` reads and writes Keychain items through `security -i`
- `src/credentials.ts`: the API key, from SHIP_ASC_* or config.json's references
- `src/platform.ts`: ios/macos/tvos/visionos → xcodebuild destination, altool type, App Store Connect platform, package
- `src/build.ts`: archive, export, .ipa/.pkg checks, and upload
- `src/xcode.ts`: finding projects, schemes, and settings
- `src/config.ts`: ship.json, the machine's app list (worktrees map to their main checkout), and settings
- `src/git.ts`: the commit a build comes from, the `testflight/<build>` tags that record it, and worktrees
- `src/ui.ts`: output; every error is a `ShipError` with a code and a hint
- `test/setup.ts` (preloaded by bunfig.toml): points SHIP_HOME at a temp folder and makes network, Keychain, and 1Password calls throw. `test/helpers.ts`: `mockAsc`, `jsonApi`, `resource`, `testCredentials`, `noRetryDelay`, `fakeKeychain`, `temp`, `git`, `captureLog`

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
