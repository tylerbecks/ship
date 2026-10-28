# Releasing to the App Store

Once a build of the version is in TestFlight, a few commands take it to the App Store:

```bash
ship version bump minor             # 1.4 → 1.5 in the Xcode project; commit it, then ship beta
ship release submit --push          # push appstore/, create 1.5, attach the newest build, check, submit
ship release                        # where it is: "1.5 (build 41): waiting for review, submitted 2 hours ago."
ship release go                     # release it, if it waits for you after approval
```

- [The version number](#the-version-number)
- [Preparing a version](#preparing-a-version)
- [Submitting for review](#submitting-for-review)
- [Release types](#release-types)
- [Phased release](#phased-release)
- [Waiting for App Review](#waiting-for-app-review)
- [JSON output](#json-output)

## The version number

`ship version` shows the app's version. To change it:

```bash
ship version bump major|minor|patch
ship version set 1.5
```

For Xcode projects, that's `MARKETING_VERSION` in every target. Extensions must match the app, so they're brought in line. For App Playgrounds, it's `displayVersion` in `Package.swift`.

ship doesn't commit the change. Commit it before `ship beta`.

## Preparing a version

`ship release prepare` gets the version ready without submitting it:

1. Creates the App Store version, or reuses the one App Store Connect is preparing.
2. Attaches the newest processed build of that version, or `--build <n>`.
3. Answers export compliance, if the build hasn't.
4. Sets how it's released (see [Release types](#release-types)).

`--push` first pushes the [store folder](store-folder.md)'s text and screenshots, as `ship metadata push` and `ship screenshots push` would.

The version comes from the project (`ship version`) unless you pass `--version`. When App Store Connect is preparing a different number, ship stops and says so; `--rename` renames it instead.

## Submitting for review

`ship release submit` does everything `prepare` does, then checks what App Review needs:

- a processed build, with export compliance answered
- a description, keywords, and support URL in every language
- the app's name and privacy policy URL
- iPhone screenshots (or Mac, Apple TV, or Vision Pro, by platform)
- copyright
- the App Review contact
- the content rights declaration

Anything missing stops it, with the command that fixes it. Missing iPad screenshots and What's New only warn.

Then it submits, reusing a draft submission or the one App Review rejected. Whatever ship can't check, App Store Connect's own response lists. Once submitted, it tags the build's commit `appstore/<version>` and pushes the tag, using the build's `testflight/<build>` tag to find the commit. A version that's already tagged keeps its tag.

`--dry-run` shows every step and check without changing anything. `--junit <path>` writes the checks as a JUnit report for CI.

`ship release cancel` takes a submission out of review, so you can change it and submit again.

## Release types

| Flag | What happens after approval |
|---|---|
| `--release manual` | waits for `ship release go` |
| `--release auto` | releases right away |
| `--release 2026-11-03T09:00` | releases at that time |

A scheduled date is local time unless it has a zone. Apple schedules on the hour, so ship rounds up.

Defaults can live in `appstore/app.json`:

```json
{ "release": { "type": "AFTER_APPROVAL", "phased": true } }
```

## Phased release

`--phased` releases the update over 7 days (1%, 2%, 5%, 10%, 20%, 50%, 100%) to people with automatic updates on. Anyone can still download it from the App Store. `--no-phased` releases to everyone at once; it works until the release starts.

Once it's rolling out:

```bash
ship release phased pause
ship release phased resume
ship release phased complete    # everyone, now
```

## Waiting for App Review

`ship release --wait` (or `ship release submit --wait`) checks once a minute until App Review decides. It exits:

- **0** once the version is approved
- **1** when it's rejected (`review-rejected`), or nothing is in review (`not-in-review`)
- **7** when it's still in review at `--timeout` (default `24h`)

With `--json`, the status includes `outcome` and `waitedSeconds`. `ship release submit --wait --json` puts it under `review`.

## JSON output

- `ship release --json` returns `{ version, live, submission, phasedRelease }`.
- `ship release submit --json` adds `checks` (each `{ name, ok, detail, blocking, fix }`), `submission`, `submitted`, and `alreadyInReview`.
