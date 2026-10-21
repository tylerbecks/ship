# ship

Build, upload, and manage TestFlight and the App Store from the command line. One command per step, the same for people and for agents.

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

**Once per machine: the App Store Connect API key.** In App Store Connect, go to Users and Access → Integrations → App Store Connect API → Team Keys and make a key with the **App Manager** role. One key covers every app on the team. Download the `.p8` and note the Key ID and Issuer ID, then:

```
ship auth set --key-id ABC123DEFG \
              --issuer-id 69a6de7e-… \
              --private-key file:~/Downloads/AuthKey_ABC123DEFG.p8 --keychain
```

`--keychain` copies the key into the macOS login Keychain (item `ship` / `asc-private-key-<key id>`) and saves a reference to it, so the `.p8` can be deleted. Settings live in `~/.config/ship/config.json`, which holds only references, never the key. See [Secrets](#secrets) for the other places the key can live.

**Once per repo:** `ship init` at the repo root. It finds the `.xcodeproj`, `.xcworkspace`, or App Playground `.swiftpm` package, the scheme that builds the app, its bundle id, and its platform, and writes `ship.json`. Commit it: every clone and worktree is then set up. When there's more than one choice, it lists them and the flag to pass. `ship remove` undoes it; `ship apps` lists every app set up on this machine, and `--app <name>` targets one from anywhere. Running `ship init` in a git worktree registers the repo's main checkout, so an app is listed once however many worktrees it has.

`ship doctor` checks everything.

## Secrets

Every secret ship reads (the API key, and passwords in the store folder such as the App Review demo account) is either written out or, better, a reference to where it lives. All four sources work the same way; use whichever you already use:

| Reference | Where | Good for |
|---|---|---|
| `keychain:<service>/<account>` | the macOS login Keychain | a Mac, with nothing else to install |
| `op://<vault>/<item>/<field>` | 1Password, read with `op read` | teams that share secrets in 1Password |
| `env:NAME` | an environment variable | CI |
| `file:~/path` | a file | a `.p8` you keep on disk |

`ship secret set keychain:ship/lift-demo-password --stdin` saves a Keychain item (`--from-file` and `--from-env` work too), and `ship secret check <ref>` says whether a reference resolves, without printing it.

**1Password.** Point the key's values at `op://` references. ship keeps the key it read in the login Keychain for 7 days (`"cacheDays"` in config.json; 0 turns it off), so 1Password asks for Touch ID about once a week. To never see Touch ID, give a 1Password service account read access to the key's vault and run `ship auth service-account op://Private/<token item>/credential` once; ship keeps the token in the Keychain for its own `op` calls.

**CI.** Set `SHIP_ASC_KEY_ID`, `SHIP_ASC_ISSUER_ID`, and `SHIP_ASC_PRIVATE_KEY` (or `SHIP_ASC_PRIVATE_KEY_PATH`). They override config.json. A private key whose newlines were stored as `\n` works as is.

## Platforms

ship builds iOS, macOS, tvOS, and visionOS apps. `ship init` detects the platform (iOS first when a target supports several; `--platform macos` picks another) and writes it to `ship.json` as `"platform"`. macOS apps export and upload a `.pkg`; the others an `.ipa`. Mac Catalyst isn't supported yet.

## How `ship beta` works

1. Picks the build number: one above the highest in App Store Connect (or `--build`), and checks that there are no uncommitted changes.
2. Archives a Release build and exports an **App Store Connect** .ipa (a .pkg for macOS; never "TestFlight Internal Only", which can't go to external testers or the App Store).
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

So a build always matches a commit, `ship beta` stops when there are uncommitted changes (untracked files included, since Xcode builds files it finds in synced folders). `--allow-dirty` ships them anyway and skips the tag; it's also what ships a project that isn't in git, or has no commit yet. It also warns when the commit isn't on the default branch yet, like a PR branch that will be squashed.

The commit reaches the build as the `SHIP_COMMIT` build setting (with `-dirty` added for `--allow-dirty`). To show it in the app, add a key such as `ShipCommit` with the value `$(SHIP_COMMIT)` to the Info.plist.

To record a build ship didn't upload: `git tag testflight/<build> <commit> && git push origin testflight/<build>`.

## Build numbers and products

For App Playground packages, the build number is written to `Package.swift`'s `bundleVersion` during the archive; commit it before the next `ship beta`. The tagged commit has the previous number there, and the tag's name is the one that shipped. For Xcode projects, it's passed as `CURRENT_PROJECT_VERSION` at archive time, so no files change.

Build products and logs go in the repo's `.ship/` folder (git-ignored), so worktrees never collide. `SHIP_JOBS=4` limits parallel compile jobs.

## The App Store page as code

<!-- feature:metadata -->
(Coming: ship metadata.)
<!-- /feature:metadata -->

<!-- feature:media -->
### Screenshots and app previews

```
ship screenshots pull                 # download the version's screenshots into appstore/
ship screenshots validate             # check types, counts, and sizes offline
ship screenshots diff                 # what push would change
ship screenshots push --dry-run       # the same, as push sees it
ship screenshots push                 # upload, replace, and reorder
```

They live next to the page's text, one folder per display type:

```
appstore/
  media.lock.json
  en-US/
    screenshots/
      APP_IPHONE_67/          6.9" iPhone
        01-home.png
        02-workout.png
      APP_IPAD_PRO_3GEN_129/  13" iPad
        01-home.png
    previews/
      IPHONE_67/
        01-intro.mp4
```

Folder names are App Store Connect's display types (`APP_IPHONE_67`, `APP_IPHONE_65`, `APP_IPAD_PRO_3GEN_129`, `APP_DESKTOP`, `APP_APPLE_TV`, `APP_APPLE_VISION_PRO`, `APP_WATCH_ULTRA`, …) and, for previews, preview types, which drop the `APP_` (`IPHONE_67`). `ship screenshots validate` lists them all when a folder name is wrong. Screenshots are `.png` or `.jpg`; previews are `.mp4`, `.mov`, or `.m4v`. A set holds up to 10 screenshots and 3 previews.

**Order is file name order**, compared the way people number things (`2-…` before `10-…`), so number the files. push puts each set in that order.

**What push does.** A file whose contents match an uploaded screenshot is left alone; a new file is uploaded; a changed file is uploaded and replaces the old one. Screenshots in App Store Connect that aren't in the repo stay, after the repo's, unless you pass `--prune`, which deletes them (and whole sets whose folder is gone). Failed uploads are always cleaned up. Only languages and kinds with a folder are touched: without `en-US/previews/`, ship leaves en-US's previews alone, even with `--prune`. push waits for Apple to process each upload and stops with Apple's reason if one fails; `--no-wait` skips the wait.

Screenshots can change only while a version is being prepared; push works on that version (or `--version`), and says to `ship release prepare` when there isn't one. `--locale` and `--type` narrow any command to some languages or types.

**media.lock.json** (commit it). Apple re-encodes what you upload, so a pulled screenshot's bytes differ from the file that was uploaded. The lock records, for each pulled or pushed file, its MD5 and the checksum of the upload it stands for, so a pull followed by a push changes nothing. Edit or replace a file and push uploads it; delete the lock and push compares contents only (pulled files would upload again).

**validate** runs offline and checks folder names, file types, counts, each screenshot's pixel size against [Apple's sizes](https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications) for its type, and transparency (Apple rejects alpha channels). push runs it first and stops on errors. `diff --exit-code` exits 1 when there are changes, for CI.
<!-- /feature:media -->

## Releasing to the App Store

<!-- feature:release -->
(Coming: ship release and ship version.)
<!-- /feature:release -->

## TestFlight

<!-- feature:testflight -->
(Coming: ship groups, ship testflight, and ship feedback.)
<!-- /feature:testflight -->

## Builds

<!-- feature:builds -->
(Coming: ship builds.)
<!-- /feature:builds -->

## For agents

- Every command takes `--json`: stdout is one JSON object, `{ "ok": true, ... }` or `{ "ok": false, "error": { "code", "message", "hint", ... } }`; progress goes to stderr.
- Nothing prompts. When a choice is needed, the error lists `choices` and the flag to pass.
- Exit codes: 0 success, 1 failure, 2 usage error.
- App Store Connect errors keep Apple's code (`api-409`), with `status` and Apple's `errors` array in the JSON. ship retries when Apple is busy (429, 5xx) and on network failures for requests that are safe to repeat.
- `ship beta --dry-run` shows the plan without building.
