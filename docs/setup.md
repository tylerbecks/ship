# Setup

- [The API key](#the-api-key)
- [A repo](#a-repo)
- [More than one app](#more-than-one-app)
- [Secrets](#secrets)
- [Platforms](#platforms)

## The API key

You set up the key once per machine. One key covers every app on the team.

1. In App Store Connect, go to **Users and Access → Integrations → App Store Connect API → Team Keys**.
2. Create a key with the **App Manager** role.
3. Download the `.p8`, and note the Key ID and the Issuer ID.
4. Run:

```bash
ship auth set --key-id ABC123DEFG \
              --issuer-id 69a6de7e-… \
              --private-key file:~/Downloads/AuthKey_ABC123DEFG.p8 --keychain
```

`--keychain` copies the key into the macOS login Keychain (service `ship`, account `asc-private-key-<key id>`) and saves a reference to it. You can delete the `.p8` afterwards.

Settings live in `~/.config/ship/config.json`. That file holds only references, never the key. To keep the key somewhere other than the Keychain, see [Secrets](#secrets).

Some commands need more than App Manager: reading feedback needs App Manager or Admin, reading customer reviews needs Customer Support, App Manager, or Admin, and changing the team needs Admin.

## A repo

Run `ship init` at the repo root. It finds:

- the `.xcodeproj`, `.xcworkspace`, or App Playground `.swiftpm` package
- the scheme that builds the app
- the bundle id
- the platform

and writes them to `ship.json`. Commit it, and every clone and worktree is set up.

When there's more than one project, scheme, or platform to pick from, `init` lists them and names the flag to pass. It never prompts.

`ship doctor` checks the whole setup, including (offline) the [store folder](store-folder.md). `ship remove` undoes `init`.

## More than one app

`ship apps` lists every app set up on this machine. `--app <name>` runs any command against one of them from anywhere; it takes the app's name, bundle id, or App Store Connect id.

`SHIP_APP` sets a default `--app` for a shell or a CI job that works on one app. `ship remove` is the exception: it only takes `--app` itself.

Running `ship init` in a git worktree registers the repo's main checkout, so an app is listed once however many worktrees it has.

## Secrets

Every secret ship reads is either written out or, better, a reference to where it lives. That covers the API key and passwords in the store folder, such as the App Review demo account. Four kinds of reference work the same way everywhere:

| Reference | Where it reads from | Good for |
|---|---|---|
| `keychain:<service>/<account>` | the macOS login Keychain | a Mac, with nothing else to install |
| `op://<vault>/<item>/<field>` | 1Password, through `op read` | teams that share secrets in 1Password |
| `env:NAME` | an environment variable | CI |
| `file:~/path` | a file | a `.p8` you keep on disk |

```bash
ship secret set keychain:ship/lift-demo-password --stdin   # or --from-file, --from-env
ship secret check keychain:ship/lift-demo-password         # does it resolve? (never prints it)
```

### 1Password

Point the key's values at `op://` references. ship caches the key it read in the login Keychain for 7 days, so 1Password asks for Touch ID about once a week. Set `"cacheDays"` in config.json to change that; `0` turns the cache off.

To never see Touch ID, give a 1Password service account read access to the key's vault and run this once:

```bash
ship auth service-account op://Private/<token item>/credential
```

ship keeps the token in the Keychain and uses it for its own `op` calls.

### CI

Set these environment variables. They override config.json.

- `SHIP_ASC_KEY_ID`
- `SHIP_ASC_ISSUER_ID`
- `SHIP_ASC_PRIVATE_KEY`, or `SHIP_ASC_PRIVATE_KEY_PATH`

A private key whose newlines were stored as `\n` works as is.

## Platforms

ship builds iOS, macOS, tvOS, and visionOS apps. `ship init` detects the platform and writes it to `ship.json` as `"platform"`. When a target supports several, it picks iOS; pass `--platform macos` (or another) to choose.

macOS apps export and upload a `.pkg`; the others an `.ipa`. Mac Catalyst isn't supported yet.
