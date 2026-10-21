# ship

Build, upload, and manage TestFlight and the App Store from the command line. One command per step, the same for people and for agents.

```
ship init                          # once per repo: finds the project, scheme, and bundle id → ship.json
ship                               # recent builds, their commits, TestFlight state, groups, public links
ship beta --notes-from-git         # next build → archive → upload → TestFlight, What to Test from the commits
ship beta --external --notes "…"   # …and Beta App Review for the public link
ship testers add friend@example.com

ship metadata pull                 # the App Store page as files in appstore/ (screenshots pull, testflight pull too)
ship metadata push                 # edit them in a pull request, then push
ship release submit --push         # push appstore/, attach the build, check, and submit for review
```

Everything you'd otherwise click through in App Store Connect lives in the repo or behind a command: builds, testers, groups, feedback, the App Store page, screenshots, and releases.

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

## What to Test from git

`ship beta --notes-from-git` fills What to Test with the commit subjects since the previous TestFlight build: the newest `testflight/<build>` tag in the commit's history, or the last 30 commits when there's none. Subjects are cleaned for testers: emoji and `:gitmoji:` codes, `feat(scope)!:` prefixes, and `(#123)` go, and chores (chore, ci, test, docs, style, build, refactor) and merges are left out.

```
🚀 feat: tag each TestFlight upload with its commit (#1)     →  • Tag each TestFlight upload with its commit
🐛 fix: skip internal groups that get every build            →  • Skip internal groups that get every build
🧹 chore: bump dependencies                                  →  (left out)
```

`--notes-file notes.md` reads notes from a file (`-` for stdin). They combine in order: `--notes`, then the file, then git's, with a blank line between; What to Test holds 4,000 characters, so git's list is cut to fit with "…and N more". `ship distribute <build>` takes the same flags and lists the commits up to that build's tag. To use git's notes whenever no notes are given, add to `ship.json`:

```json
"beta": { "notesFromGit": true }
```

`--dry-run` shows the notes, and `--json` reports them as `plan.notes`, with `plan.notesSource` (`flag`, `file`, `git`, or a mix like `flag+git`) and `plan.notesFrom` (the previous build).

## Builds

`ship builds` lists the app's builds, newest first: the commit each came from, processing, internal and external TestFlight state, and when it expires (TestFlight builds last 90 days). Expired builds are hidden unless you pass `--expired` or `--all`; `--version 1.2`, `--processing`, `--failed`, and `--limit` narrow the list. `ship status` shows the same EXPIRES column and says when the newest build expires within a week.

`ship builds show 42` prints one build in detail: What to Test for each language, the groups it's in, Beta App Review, and the App Store version it's attached to. Build numbers only have to be unique within a version, so when two versions share one, pass `--version`.

`ship builds expire` takes builds out of TestFlight. Testers can't install them anymore, and it can't be undone:

```
ship builds expire 41 42                        # these builds
ship builds expire --older-than 30d --dry-run   # what would go (30d, 2w, 12h)
ship builds expire --older-than 30d --keep 3    # keep the newest 3 valid builds (default 1)
```

Builds still processing are skipped, and a build attached to an App Store version that's in review, waiting to release, or live is never expired (naming one is an error, `build-in-use`). If Apple refuses partway, the error lists the builds already expired.

## Testers, groups, and feedback

**Testers.** `ship testers` lists the first external group (or `--group <name>`); `ship testers add a@example.com b@example.com` invites people and keeps going when one fails; `ship testers remove a@example.com` takes them out of the group, and `--everywhere` out of every group and the app's TestFlight. Internal groups only take App Store Connect users.

**Groups.** `ship groups` lists them with their tester counts and public links.

```
ship groups create "Beta" --public-link --limit 200   # an external group anyone can join, up to 200 testers
ship groups create "Team" --internal --all-builds      # App Store Connect users, every build automatically
ship groups link "Beta" off                            # or: on --limit 500, on --no-limit
ship groups rename "Beta" "Public beta"
ship groups delete "Public beta"
```

Names match without case. If ship.json's `groups` names a group you rename or delete, ship reminds you to update it.

**Feedback.** `ship feedback` lists the screenshots and crash reports testers sent, newest first (`--build <n>`, `--crashes`, `--screenshots`, `--limit <n>`). `ship feedback show <id>` shows one, with the crash log; `ship feedback download` saves screenshots, comments, and crash logs to `.ship/feedback/<date>-<id>/` (or `--out <dir>`); `ship feedback delete <id>` clears what you've dealt with. Reading feedback needs a key with the App Manager or Admin role.

## The store folder

Everything App Store Connect shows about the app lives in one folder next to `ship.json` (`appstore/`, or set `"store"` in ship.json), so a pull request shows exactly what changes on the page, and `git log` says when it did. Commit all of it.

```
appstore/
  app.json                      categories, content rights, copyright, age rating, App Review contact, release defaults
  review-notes.txt              notes for App Review
  media.lock.json               which screenshot file matches which upload
  en-US/
    name.txt  subtitle.txt  description.txt  keywords.txt  whats-new.txt  …
    screenshots/APP_IPHONE_67/01-home.png
    previews/IPHONE_67/01-intro.mp4
  testflight/
    review.json  review-notes.txt
    en-US/description.txt  feedback-email.txt  …
```

Three commands share it, and each has the same four actions:

| | The App Store page | Screenshots and previews | TestFlight test information |
|---|---|---|---|
| `pull` | `ship metadata pull` | `ship screenshots pull` | `ship testflight pull` |
| `diff` | `ship metadata diff` | `ship screenshots diff` | `ship testflight diff` |
| `push` | `ship metadata push` | `ship screenshots push` | `ship testflight push` |
| `validate` | `ship metadata validate` | `ship screenshots validate` | `ship testflight validate` |

The rules are the same everywhere: `pull` once to start, and it refuses to overwrite files you changed (`--force` does). `diff --exit-code` exits 1 when there are changes, for CI. `push --dry-run` shows what it would do; `push` validates first and stops on errors. `--prune` deletes in App Store Connect what has no file or folder here; without it, push only adds and replaces. A missing file is left alone; an empty file clears the field. Passwords are references (see [Secrets](#secrets)), never the password, and they show as `••••`. `validate` runs offline.

### The App Store page

The page's text and App Information:

```
appstore/
  app.json                # categories, content rights, copyright, age rating, App Review contact, release defaults
  review-notes.txt        # notes for App Review
  en-US/
    name.txt  subtitle.txt  privacy-policy-url.txt  privacy-choices-url.txt
    description.txt  keywords.txt  promotional-text.txt  whats-new.txt  support-url.txt  marketing-url.txt
```

```
ship metadata pull        # once: write the files from App Store Connect (--force overwrites local edits)
ship metadata diff        # what push would change (--exit-code for CI)
ship metadata push        # apply it (--dry-run to preview, --prune to delete languages without a folder)
ship metadata validate    # lengths, keyword bytes, URLs, app.json values, and secrets, offline
```

`keywords.txt` holds one keyword per line (push joins them with commas; the 100-byte limit counts the commas). A new language folder is added on push; it needs a `name.txt`.

**When things can change.** Apple takes most changes only while a version is being prepared. Promotional text and content rights change any time; name, subtitle, privacy URLs, categories, and age rating change on the App Info being prepared; everything else on the version being prepared (or `--version <x.y>`). When something can't change yet, push stops and lists it; `--partial` pushes the rest. What's New is skipped on an app's first version, and the phased release and a scheduled release date are set by `ship release`, not push.

**The demo account password** in `app.json` is a reference, never the password: `"demoAccountPassword": "keychain:ship/lift-demo-password"` (or `op://…`, `env:…`, `file:…`; see [Secrets](#secrets)). `ship secret set keychain:ship/lift-demo-password --stdin` saves it. Pull never writes the password, `validate` and push refuse one written out, and diff and push show it as `••••`. Left out, App Store Connect's password stays as it is; `""` or `null` clears it.

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

**validate** runs offline and checks folder names, file types, counts, each screenshot's pixel size against [Apple's sizes](https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications) for its type, and transparency (Apple rejects alpha channels). push runs it first and stops on errors.

### TestFlight test information

What testers see about the beta and what Beta App Review needs live in `appstore/testflight/`, so changes go through pull requests like code:

```
appstore/testflight/
  review.json            contact, and the demo account ("demoAccountPassword": "keychain:ship/lift-beta-demo-password")
  review-notes.txt       notes for Beta App Review
  en-US/
    description.txt      about the beta (up to 4000 characters)
    feedback-email.txt  marketing-url.txt  privacy-policy-url.txt  tvos-privacy-policy.txt
```

`ship testflight pull` writes the folder from App Store Connect (it stops rather than overwrite files you changed; `--force` overwrites). `ship testflight diff` shows what would change, `ship testflight push` sends it (`--dry-run` first if you like; `--prune` deletes languages that have no folder), and `ship testflight validate` checks lengths, URLs, emails, and the demo account offline. Unlike the App Store page, all of it can change any time.

The demo account password is never written to the repo: `review.json` holds a reference (see [Secrets](#secrets)), and ship reads it only to send it to Apple. As in `app.json`, `pull` leaves it out and tells you how to save it; left out, App Store Connect's password stays as it is, and `""` or `null` clears it.

## Releasing to the App Store

Once a build of the version is in TestFlight, three commands take it to the App Store:

```
ship version bump minor             # 1.4 → 1.5 in the Xcode project; commit it, then ship beta
ship release submit --push          # push appstore/, create 1.5, attach the newest build, check, submit
ship release                        # where it is: "1.5 (build 41): waiting for review, submitted 2 hours ago."
ship release go                     # release it, if it waits for you after approval
```

**`ship release prepare`** gets the version ready without submitting it: it creates the App Store version (or reuses the one App Store Connect is preparing), attaches the newest processed build of that version (or `--build <n>`), answers export compliance if the build hasn't, and sets how it's released. `--push` first pushes the store folder's text and screenshots (`ship metadata push`, `ship screenshots push`). The version comes from the project (`ship version`) unless you pass `--version`. When App Store Connect is preparing a different number, ship stops and says so; `--rename` renames it instead.

**`ship release submit`** does all of that, then checks what App Review needs: a processed build with export compliance answered, a description, keywords, and support URL in every locale, the app's name and privacy policy URL, iPhone (or Mac, Apple TV, Vision Pro) screenshots, copyright, the App Review contact, and the content rights declaration. Anything missing stops it with the command that fixes it; iPad screenshots and "What's New" only warn. Then it submits, reusing a draft submission or the one App Review rejected. Whatever ship can't see, App Store Connect's own answer lists. `--dry-run` shows every step and check without changing anything.

**Release types.** `--release manual` waits for `ship release go` after approval, `--release auto` releases as soon as it's approved, and `--release 2026-11-03T09:00` schedules it (local time unless the date has a zone; Apple schedules on the hour, so ship rounds up). Defaults can live in `appstore/app.json`:

```json
{ "release": { "type": "AFTER_APPROVAL", "phased": true } }
```

**Phased release.** `--phased` releases the update over 7 days to people with automatic updates on (1%, 2%, 5%, 10%, 20%, 50%, 100%); anyone can still download it from the App Store. `--no-phased` releases to everyone at once (until the release starts). Once it's rolling out, `ship release phased pause`, `resume`, and `complete` (everyone, now) control it.

**`ship release cancel`** takes a submission out of review, so you can change it and submit again.

**`ship version`** shows the app's version, and `ship version bump major|minor|patch` or `ship version set 1.5` changes it: `MARKETING_VERSION` in every target of the Xcode project (extensions must match the app, so they're brought in line), or `displayVersion` in an App Playground's `Package.swift`. ship doesn't commit; commit the change before `ship beta`.

Everything has `--json`. `ship release --json` returns `{ version, live, submission, phasedRelease }`; `ship release submit --json` adds `checks` (`{ name, ok, detail, blocking, fix }`), `submission`, `submitted`, and `alreadyInReview`.

## For agents

- Every command takes `--json`: stdout is one JSON object, `{ "ok": true, ... }` or `{ "ok": false, "error": { "code", "message", "hint", ... } }`; progress goes to stderr.
- Nothing prompts. When a choice is needed, the error lists `choices` and the flag to pass.
- Exit codes: 0 success, 1 failure, 2 usage error.
- App Store Connect errors keep Apple's code (`api-409`), with `status` and Apple's `errors` array in the JSON. ship retries when Apple is busy (429, 5xx) and on network failures for requests that are safe to repeat.
- `--dry-run` shows what `ship beta`, `ship builds expire`, the three `push`es, `ship release`, and `ship version` would do, without changing anything (`ship beta --dry-run` doesn't build).
- `ship metadata diff`, `ship screenshots diff`, and `ship testflight diff` take `--exit-code` (exit 1 when there are changes), for a CI check that the store folder and App Store Connect agree.
- A flag an action doesn't take is a usage error, never ignored.
