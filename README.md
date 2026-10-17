# ship

Build, upload, and manage TestFlight (and later the App Store) from the command line. One command per step, the same for people and for agents.

```
ship init          # once per repo: finds the project, scheme, and bundle id → ship.json
ship               # recent builds, TestFlight state, groups, public links
ship beta --notes "Fixes search"            # next build → archive → upload → TestFlight
ship beta --external --notes "…"            # …and Beta App Review for the public link
ship testers add friend@example.com
```

## Install

```
bun install
bun run install-local     # compiles to one binary at ~/.local/bin/ship
```

## Set up

**Once per machine: the App Store Connect API key.** In App Store Connect, go to Users and Access → Integrations → App Store Connect API → Team Keys and make a key with the **App Manager** role. One key covers every app on the team. Save the `.p8`, Key ID, and Issuer ID in 1Password, then:

```
ship auth set --key-id op://Private/ASC/key-id \
              --issuer-id op://Private/ASC/issuer-id \
              --private-key op://Private/ASC/AuthKey.p8
```

Values can be literal, `op://` (1Password), `env:NAME`, or `file:<path>`. Settings live in `~/.config/ship/config.json`, which holds only the references. For CI, set `SHIP_ASC_KEY_ID`, `SHIP_ASC_ISSUER_ID`, and `SHIP_ASC_PRIVATE_KEY` (or `SHIP_ASC_PRIVATE_KEY_PATH`) instead.

**Once per repo:** `ship init` at the repo root. It finds the `.xcodeproj`, `.xcworkspace`, or App Playground `.swiftpm` package, the scheme that builds the app, and the bundle id, and writes `ship.json`. Commit it: every clone and worktree is then set up. When there's more than one choice, it lists them and the flag to pass. `ship remove` undoes it; `ship apps` lists every app set up on this machine, and `--app <name>` targets one from anywhere.

`ship doctor` checks everything.

## How `ship beta` works

1. Picks the build number: one above the highest in App Store Connect (or `--build`).
2. Archives a Release build and exports an **App Store Connect** .ipa (never "TestFlight Internal Only", which can't go to external testers or the App Store).
3. Checks the bundle id, build number, and export compliance key in the built app.
4. Uploads with `altool`, waits for processing, and answers export compliance if the app doesn't declare it.
5. Sets "What to Test" and adds the build to the internal groups.
6. With `--external`, adds it to the external groups and submits it to Beta App Review.

It's safe to re-run: an uploaded build isn't uploaded again. `ship distribute <build>` redoes only steps 4–6.

For App Playground packages, the build number is written to `Package.swift`'s `bundleVersion`; commit it. For Xcode projects, it's passed as `CURRENT_PROJECT_VERSION` at archive time, so no files change.

Build products and logs go in the repo's `.ship/` folder (git-ignored), so worktrees never collide. `SHIP_JOBS=4` limits parallel compile jobs.

## For agents

- Every command takes `--json`: stdout is one JSON object, `{ "ok": true, ... }` or `{ "ok": false, "error": { "code", "message", "hint", ... } }`; progress goes to stderr.
- Nothing prompts. When a choice is needed, the error lists `choices` and the flag to pass.
- Exit codes: 0 success, 1 failure, 2 usage error.
- `ship beta --dry-run` shows the plan without building.
