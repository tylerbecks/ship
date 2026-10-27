# ship

TestFlight and App Store Connect from the command line.

`ship` archives your app, uploads it, and gets it to testers in one command. It keeps your App Store page (text, screenshots, in-app purchases, and subscriptions) as files in your repo, so changes go through pull requests like code. Every command has JSON output and none of them prompt, so it works the same in a terminal, in CI, and for coding agents.

```bash
ship init                         # find the project, scheme, and bundle id; write ship.json
ship beta --notes-from-git        # next build number → archive → upload → TestFlight
ship testers add ada@example.com
ship                              # recent builds, the commit each came from, TestFlight state

ship metadata pull                # the App Store page → appstore/
ship release submit --push        # push appstore/, attach the build, check, submit for review
```

**[Install](#install)** · **[Quick start](#quick-start)** · **[Docs](#docs)** · **[Scripting and CI](#scripting-ci-and-agents)**

## Why ship

- **One command from commit to TestFlight.** `ship beta` picks the next build number, archives, uploads, waits for processing, answers export compliance, writes What to Test from your commits, and adds the build to your groups. It's safe to re-run.
- **Every build maps to a commit.** ship won't build with uncommitted changes, and tags each upload `testflight/<build>`. `ship status` shows which commit each build came from and what's landed since.
- **Your App Store page lives in git.** Descriptions, keywords, screenshots, previews, TestFlight info, in-app purchases, and subscriptions are plain files in `appstore/`. Review changes in a PR, then `push`. `diff --exit-code` catches drift in CI.
- **Built to be scripted.** `--json` everywhere, exit codes that mean something, `--dry-run` on everything that changes something, and a `--read-only` mode. Every error comes with a hint, usually the command that fixes it.
- **Secrets stay out of the repo.** The API key and demo-account passwords are references to the Keychain, 1Password, an environment variable, or a file.
- **One binary, no Ruby.** No runtime dependencies; ship drives Xcode's own `xcodebuild` and `altool`. Coming from fastlane? `ship metadata import` and `ship screenshots import` read your deliver folder.

## Requirements

- macOS with Xcode
- [Bun](https://bun.sh), to build ship
- An App Store Connect API key with the App Manager role
- An iOS, macOS, tvOS, or visionOS app in an Xcode project, a workspace, or an App Playground (`.swiftpm`). Mac Catalyst isn't supported yet.

## Install

```bash
git clone https://github.com/tylerbecks/ship.git
cd ship
bun install
bun run install-local
```

This compiles one binary to `~/.local/bin/ship`. Make sure `~/.local/bin` is on your `PATH`.

## Quick start

**1. Add an API key** (once per machine). In App Store Connect, go to **Users and Access → Integrations → App Store Connect API → Team Keys** and create a key with the **App Manager** role. Download the `.p8`, note the Key ID and Issuer ID, and run:

```bash
ship auth set --key-id ABC123DEFG --issuer-id 69a6de7e-… \
  --private-key file:~/Downloads/AuthKey_ABC123DEFG.p8 --keychain
```

`--keychain` copies the key into your login Keychain, so you can delete the `.p8`. One key covers every app on the team.

**2. Set up the repo** (once per repo). From the repo root:

```bash
ship init      # writes ship.json; commit it
ship doctor    # checks Xcode, the key, ship.json, and the store folder
```

**3. Send a build to TestFlight.** Commit your changes first, then:

```bash
ship beta --notes-from-git
```

Add `--dry-run` to see the plan without building, or `--external` to also submit to Beta App Review for external testers and your public link.

## Docs

`ship --help` lists every command, and `ship <command> --help` explains one. The guides go deeper:

| Guide | Covers |
|---|---|
| [Setup](docs/setup.md) | The API key, `ship init`, more than one app, secrets (Keychain, 1Password, CI), platforms |
| [TestFlight](docs/testflight.md) | `ship beta` step by step, commit tags, What to Test, Swift macro trust, builds, testers, groups, feedback |
| [The store folder](docs/store-folder.md) | `appstore/`: the App Store page, screenshots and previews, TestFlight info, in-app purchases, subscriptions, importing from fastlane |
| [Releasing](docs/releasing.md) | Version numbers, `ship release prepare` and `submit`, release types, phased release, waiting for review |
| [Reviews, team, and signing](docs/account.md) | Customer reviews, users, devices, sandbox accounts, certificates, provisioning profiles, `ship api` |

### The store folder at a glance

```
appstore/
  app.json            categories, age rating, copyright, App Review contact
  en-US/
    name.txt  subtitle.txt  description.txt  keywords.txt  whats-new.txt  …
    screenshots/APP_IPHONE_67/01-home.png
  testflight/         what testers and Beta App Review see
  purchases/          in-app purchases, one folder per product id
  subscriptions/      subscription groups and their subscriptions
```

`ship metadata`, `screenshots`, `testflight`, `purchases`, and `subscriptions` each have the same four actions: `pull`, `diff`, `push`, and `validate`. A missing file is left alone, an empty file clears the field, and `push` never deletes anything without `--prune`.

## Scripting, CI, and agents

- **`--json`** on any command prints one object to stdout: `{ "ok": true, … }` or `{ "ok": false, "error": { "code", "message", "hint", … } }`. Progress goes to stderr. Field names are stable.
- **Nothing prompts.** When ship needs a choice, the error lists the `choices` and the flag to pass.
- **`--dry-run`** shows what a command would change without changing it. `ship beta --dry-run` doesn't build.
- **`--read-only`** (or `SHIP_READ_ONLY=1`) lets reads through and stops any change to App Store Connect before it's sent. Local writes (files, git tags, the Keychain) still happen.
- **`--junit <path>`** writes the checks from `ship release submit`, `ship doctor`, and every `validate` as a JUnit report.
- **`diff --exit-code`** exits 1 when the store folder and App Store Connect disagree.
- **`ship help --json`** describes every command, flag, and exit code; `ship <command> --help --json` describes one.
- **Apple's errors keep Apple's status** in the code (`api-409`), with `status` and Apple's `errors` array in the JSON. ship retries when Apple is busy (429, 5xx), and on network failures for requests that are safe to repeat.
- **CI credentials** come from `SHIP_ASC_KEY_ID`, `SHIP_ASC_ISSUER_ID`, and `SHIP_ASC_PRIVATE_KEY` (or `SHIP_ASC_PRIVATE_KEY_PATH`).

Exit codes tell you what kind of failure it was, so a script doesn't have to parse the error. The JSON error includes it as `exitCode`.

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Anything else: a build failed, a check failed, App Review rejected it |
| 2 | Usage: a bad flag or argument, or a flag the action doesn't take |
| 3 | Auth: the API key is missing, wrong, or its role can't do this (`api-401`, `api-403`, `no-credentials`) |
| 4 | Not found: the app, build, version, group, or review (`api-404`, `no-build`, `unknown-app`, …) |
| 5 | Conflict: App Store Connect refused it in its current state (`api-409`, `build-in-use`, …) |
| 6 | Read-only mode refused a change |
| 7 | Still pending when `--wait` timed out (`still-pending`, `processing-timeout`) |

## Contributing

ship is TypeScript on Bun, with no runtime dependencies. [AGENTS.md](AGENTS.md) covers the layout and the rules (no prompts, every error has a hint, `--json` is an API).

```bash
bun run dev -- status    # run from source
bun run check            # typecheck and test; tests never call App Store Connect
```
