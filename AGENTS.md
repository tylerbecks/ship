# Agent notes

`ship` is a TypeScript CLI on Bun, compiled to one binary. Read README.md first.

## Layout

- `src/cli.ts`: commands, flags, and help text
- `src/commands/`: one file per command group
- `src/asc/`: the App Store Connect API (`client.ts` signs requests with an ES256 JWT; `api.ts` has the endpoints)
- `src/build.ts`: archive, export, .ipa checks, and upload
- `src/xcode.ts`: finding projects, schemes, and settings
- `src/config.ts`: ship.json, the machine's app list, and settings
- `src/git.ts`: the commit a build comes from, and the `testflight/<build>` tags that record it
- `src/ui.ts`: output; every error is a `ShipError` with a code and a hint

## Rules

- **No dependencies** unless there's no reasonable alternative. Bun and Node built-ins cover this.
- **Never prompt.** Fail with a `ShipError` that names the choices and the flag to pass.
- **Every error needs a hint** saying what to do, ideally a command.
- **`--json` output is an API.** Don't rename fields; add new ones.
- **Secrets never touch disk** except the API key, written to a private temp folder for the length of one `xcodebuild` or `altool` run (`withKeyFile`).
- **No App Store Connect calls in tests.** Test the pure parts (`bun test`).

## Checking

`bun test`, `bun run typecheck`, then `bun run install-local` to update `~/.local/bin/ship`.

## Commits

Emoji conventional commits (🚀 feat, 🐛 fix, 📚 docs, 🛠️ refactor, ⚡ perf, 🧪 test, 🧹 chore). Commit only when asked.
