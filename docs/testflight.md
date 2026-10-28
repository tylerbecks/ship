# TestFlight

- [How `ship beta` works](#how-ship-beta-works)
- [Which commit is in TestFlight](#which-commit-is-in-testflight)
- [What to Test from git](#what-to-test-from-git)
- [Build numbers and build products](#build-numbers-and-build-products)
- [Swift macros and package plugins](#swift-macros-and-package-plugins)
- [Builds](#builds)
- [Testers, groups, and feedback](#testers-groups-and-feedback)

## How `ship beta` works

1. Picks the build number (see [Build numbers](#build-numbers-and-build-products)), or takes `--build <n>`. Stops if there are uncommitted changes. Claims the number by tagging the commit `testflight/<build>`.
2. Archives a Release build and exports an **App Store Connect** `.ipa` (a `.pkg` for macOS). Never "TestFlight Internal Only", which can't go to external testers or the App Store.
3. Checks the bundle id, build number, and export compliance key in the built app.
4. Uploads with `altool`. Waits for processing, and answers export compliance if the app doesn't declare it.
5. Sets What to Test and adds the build to the internal groups.
6. With `--external`, adds it to the external groups and submits it to Beta App Review.

It's safe to re-run. A commit whose build is already uploaded goes straight to distribution, and one whose archive or upload failed gets the same number again. `ship distribute <build>` redoes only steps 4–6. `ship archive` archives and exports without uploading, using the project's current build number (or `--build`), which is handy for checking signing.

`--dry-run` prints the plan without building.

## Which commit is in TestFlight

App Store Connect has no field for a commit, so the repo keeps the record. Before archiving, `ship beta` tags the commit `testflight/<build>` and pushes the tag to origin (which pushes the commit too, if it wasn't).

The tag is also a claim on the number. Origin refuses a tag it already has, so a second machine shipping at the same time moves on to the next number. A failed archive or upload deletes the tag, so the number is free again.

The tag is annotated with what was built:

```
$ git tag -n9 testflight/10
testflight/10   MyApp 1.0.1 (10), iOS

                Ship-Bundle-Id: com.example.myapp
                Ship-Platform: ios
                Ship-Version: 1.0.1
                Ship-Branch: main
```

`ship status` fetches those tags, shows each build's commit, and says how far origin's default branch has moved since the newest one:

```
origin/main has 7 commits since build 12 (6cb9262): git log --oneline 6cb9262..origin/main
```

`ship release submit` tags the submitted build's commit `appstore/<version>` the same way, so `git log appstore/1.0.1..main` lists what's changed since the last App Store release.

For a build to match a commit, `ship beta` stops when there are uncommitted changes, untracked files included (Xcode builds files it finds in synced folders). It also warns when the commit isn't on the default branch yet, like a PR branch that will be squashed.

`--allow-dirty` ships uncommitted changes anyway and skips the tag. It's also how you ship a project that isn't in git or has no commits yet.

The commit reaches the build as the `SHIP_COMMIT` build setting, with `-dirty` added under `--allow-dirty`. To show it in the app, add a key such as `ShipCommit` with the value `$(SHIP_COMMIT)` to the Info.plist.

To record a build ship didn't upload:

```bash
git tag testflight/<build> <commit> && git push origin testflight/<build>
```

## What to Test from git

`ship beta --notes-from-git` fills What to Test with the commit subjects since the previous TestFlight build: the closest `testflight/<build>` tag behind the commit, or the last 30 commits when there's none.

Subjects are cleaned up for testers. Emoji, `:gitmoji:` codes, `feat(scope)!:` prefixes, and `(#123)` are removed. Merges and chores (`chore`, `ci`, `test`, `docs`, `style`, `build`, `refactor`) are left out.

```
🚀 feat: tag each TestFlight upload with its commit (#1)     →  • Tag each TestFlight upload with its commit
🐛 fix: skip internal groups that get every build            →  • Skip internal groups that get every build
🧹 chore: bump dependencies                                  →  (left out)
```

Other sources of notes:

- `--notes "…"` for text on the command line
- `--notes-file notes.md` for a file, or `-` for stdin

They combine in that order (`--notes`, the file, then git's), separated by blank lines. What to Test holds 4,000 characters, so git's list is cut to fit with "…and N more". `ship distribute <build>` takes the same flags and lists the commits up to that build's tag.

To use git's notes whenever no other notes are given, add this to `ship.json`:

```json
"beta": { "notesFromGit": true }
```

`--dry-run` shows the notes. With `--json`, they're in `plan.notes`, with `plan.notesSource` (`flag`, `file`, `git`, or a mix like `flag+git`) and `plan.notesFrom` (the previous build).

## Build numbers and build products

Build numbers are one counter per app that never resets: `1.0.1 (10)`, `1.0.1 (11)`, then `1.1 (12)`. Each number names one build across every version and platform, so `ship distribute 12`, `ship feedback --build 12`, and `testflight/12` never need a version.

The next number is one above the highest counter in App Store Connect or in a `testflight/*` tag. Apple's rules hold either way: on iOS, tvOS, and visionOS a version's builds only have to increase, and on macOS every build does. A build that fails processing has used up its number, so the next upload takes a new one.

A number of 100,000 or more never feeds the counter. That covers a timestamp like `202610200522` and anything typed with `--build`. Otherwise one such number would make every later build a fake timestamp.

A version that already has such a number keeps going above it, with a warning. `ship version bump patch` starts short numbers in the next version, at the number of uploads so far plus one. On macOS, where build numbers have to keep rising across versions, an app with such a number stays above it.

For Xcode projects, the build number is passed as `CURRENT_PROJECT_VERSION` at archive time, so no files change.

For App Playground packages, the build number is written to `Package.swift`'s `bundleVersion` during the archive. Commit it before the next `ship beta`. The tagged commit still has the previous number in it; the tag's name is the one that shipped.

Build products and logs go in the repo's `.ship/` folder (git-ignored), so worktrees never collide. `SHIP_JOBS=4` limits parallel compile jobs.

## Swift macros and package plugins

Xcode won't build a package's Swift macros or run its build plugins until someone clicks **Trust & Enable**, and a command-line build can't ask. When an archive stops for that, ship says which ones and how to get past it:

```
✗ Xcode won't build 3 Swift macros until you trust them
  PerceptionMacros (swift-perception)
  StructuredQueriesMacros, StructuredQueriesSQLiteMacros (swift-structured-queries)
  A command-line build can't ask, so trust them once in Xcode:
    ship open        then build (⌘B) and click Trust & Enable
  Then run ship again. Or skip the check for this repo, in ship.json:
    "build": { "skipMacroValidation": true }
```

`ship open` opens the project in Xcode. Xcode remembers the trust on this Mac until the package changes.

With `--json`, the error code is `untrusted-package`, with `untrusted` (each macro or plugin and its package), `projectPath`, `openCommand`, and `settings`, so an agent can offer to open Xcode.

A repo that has decided to trust its packages, as CI must, can skip Xcode's check in `ship.json`. The file is committed, so the choice shows up in review:

```json
"build": {
  "skipMacroValidation": true,
  "skipPackagePluginValidation": true,
  "xcodebuildArgs": ["-quiet"]
}
```

`xcodebuildArgs` appends anything else to `xcodebuild archive`, after ship's own arguments.

## Builds

`ship builds` lists the app's builds, newest first: the commit each came from, processing state, internal and external TestFlight state, and when it expires (TestFlight builds last 90 days).

- Expired builds are hidden unless you pass `--expired` or `--all`.
- `--version 1.2`, `--processing`, `--failed`, and `--limit` narrow the list.
- `ship status` shows the same EXPIRES column, and warns when the newest build expires within a week.

`ship builds show 42` prints one build in detail: What to Test in each language, its groups, Beta App Review, and the App Store version it's attached to. Build numbers only have to be unique within a version, so when two versions share one, pass `--version`.

`--wait` first waits for App Store Connect to finish processing the build (after `ship beta --no-wait`, say), up to `--timeout` (default `1h`; `90s`, `30m`, `2h`, and `1d` work). It exits 7 if the build is still processing then.

### Expiring builds

`ship builds expire` takes builds out of TestFlight. Testers can't install them anymore, and it can't be undone.

```bash
ship builds expire 41 42                        # these builds
ship builds expire --older-than 30d --dry-run   # what would go (30d, 2w, 12h)
ship builds expire --older-than 30d --keep 3    # keep the newest 3 valid builds (default 1)
```

Builds still processing are skipped. A build attached to an App Store version that's in review, waiting for release, or live is never expired; naming one is an error (`build-in-use`). If Apple refuses partway through, the error lists the builds already expired.

## Testers, groups, and feedback

### Testers

```bash
ship testers                                  # the first external group, or --group <name>
ship testers add a@example.com b@example.com  # invite; keeps going when one fails
ship testers remove a@example.com             # out of the group
ship testers remove a@example.com --everywhere  # out of every group and the app's TestFlight
```

Internal groups only take App Store Connect users.

### Groups

`ship groups` lists groups with their tester counts and public links.

```bash
ship groups create "Beta" --public-link --limit 200   # an external group anyone can join, up to 200 testers
ship groups create "Team" --internal --all-builds     # App Store Connect users, every build automatically
ship groups link "Beta" off                           # or: on --limit 500, on --no-limit
ship groups rename "Beta" "Public beta"
ship groups delete "Public beta"
```

Names match without regard to case. If `ship.json`'s `groups` names a group you rename or delete, ship reminds you to update it.

### Feedback

```bash
ship feedback                 # screenshots and crash reports from testers, newest first
ship feedback show <id>       # one, with its crash log
ship feedback download        # to .ship/feedback/<date>-<id>/, or --out <dir>
ship feedback delete <id>     # clear what you've dealt with
```

`ship feedback` takes `--build <n>`, `--crashes`, `--screenshots`, and `--limit <n>`. Reading feedback needs a key with the App Manager or Admin role.
