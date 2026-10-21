# ship

Build, upload, and manage TestFlight (and later the App Store) from the command line. One command per step, the same for people and for agents.

```
ship init          # once per repo: finds the project, scheme, and bundle id → ship.json
ship               # recent builds, their commits, TestFlight state, groups, public links
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

Values can be literal, `op://` (1Password), `env:NAME`, or `file:<path>`. Settings live in `~/.config/ship/config.json`, which holds only the references. To stop Touch ID prompts, give a 1Password service account read access to the key's vault and run `ship auth service-account op://Private/<token item>/credential` once; ship keeps the token in the Keychain for its own `op` calls. For CI, set `SHIP_ASC_KEY_ID`, `SHIP_ASC_ISSUER_ID`, and `SHIP_ASC_PRIVATE_KEY` (or `SHIP_ASC_PRIVATE_KEY_PATH`) instead.

**Once per repo:** `ship init` at the repo root. It finds the `.xcodeproj`, `.xcworkspace`, or App Playground `.swiftpm` package, the scheme that builds the app, and the bundle id, and writes `ship.json`. Commit it: every clone and worktree is then set up. When there's more than one choice, it lists them and the flag to pass. `ship remove` undoes it; `ship apps` lists every app set up on this machine, and `--app <name>` targets one from anywhere.

`ship doctor` checks everything.

## How `ship beta` works

1. Picks the build number: one above the highest in App Store Connect (or `--build`), and checks that there are no uncommitted changes.
2. Archives a Release build and exports an **App Store Connect** .ipa (never "TestFlight Internal Only", which can't go to external testers or the App Store).
3. Checks the bundle id, build number, and export compliance key in the built app.
4. Uploads with `altool` and tags the commit `testflight/<build>` (see below), then waits for processing and answers export compliance if the app doesn't declare it.
5. Sets "What to Test" and adds the build to the internal groups.
6. With `--external`, adds it to the external groups and submits it to Beta App Review.

It's safe to re-run: an uploaded build isn't uploaded again. `ship distribute <build>` redoes only steps 4–6.

## Which commit is in TestFlight

App Store Connect has no field for a commit, so the repo keeps the record. `ship beta` tags the commit it built `testflight/<build>` and pushes the tag to origin (which also pushes the commit, if it wasn't). `ship status` fetches those tags, shows each build's commit, and says how far origin's default branch has moved since the newest one:

```
origin/main has 7 commits since build 202610210930 (6cb9262): git log --oneline 6cb9262..origin/main
```

So a build always matches a commit, `ship beta` stops when there are uncommitted changes (untracked files included, since Xcode builds files it finds in synced folders). `--allow-dirty` ships them anyway and skips the tag. It also warns when the commit isn't on the default branch yet, like a PR branch that will be squashed.

The commit reaches the build as the `SHIP_COMMIT` build setting (with `-dirty` added for `--allow-dirty`). To show it in the app, add a key such as `ShipCommit` with the value `$(SHIP_COMMIT)` to the Info.plist.

To record a build ship didn't upload: `git tag testflight/<build> <commit> && git push origin testflight/<build>`.

## Build numbers and products

For App Playground packages, the build number is written to `Package.swift`'s `bundleVersion`; commit it. For Xcode projects, it's passed as `CURRENT_PROJECT_VERSION` at archive time, so no files change.

Build products and logs go in the repo's `.ship/` folder (git-ignored), so worktrees never collide. `SHIP_JOBS=4` limits parallel compile jobs.

## For agents

- Every command takes `--json`: stdout is one JSON object, `{ "ok": true, ... }` or `{ "ok": false, "error": { "code", "message", "hint", ... } }`; progress goes to stderr.
- Nothing prompts. When a choice is needed, the error lists `choices` and the flag to pass.
- Exit codes: 0 success, 1 failure, 2 usage error.
- `ship beta --dry-run` shows the plan without building.
