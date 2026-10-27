# Reviews, the team, devices, and signing

- [Customer reviews](#customer-reviews)
- [The team](#the-team)
- [Devices](#devices)
- [Sandbox accounts](#sandbox-accounts)
- [Certificates and provisioning profiles](#certificates-and-provisioning-profiles)
- [Anything else: `ship api`](#anything-else-ship-api)

Every command here that changes something, except `ship api`, takes `--dry-run`.

## Customer reviews

```bash
ship reviews                                   # newest first: stars, store, title, whether you've replied
ship reviews --rating 1 --rating 2 --unanswered
ship reviews show <id>                         # the whole review and your reply
ship reviews reply <id> --text "Thanks! Fixed in 1.5."
ship reviews unreply <id>
```

- `--territory USA` narrows to one App Store.
- `--sort` takes `newest`, `oldest`, `lowest`, or `highest`.
- `--limit` goes up to 200.

`reply` replaces the review's existing reply, if any. Replies can be up to 5,970 characters, and Apple checks them before they show (`PENDING_PUBLISH`). `--text-file <path>` reads the reply from a file (`-` for stdin).

Reading reviews needs a key with the Customer Support, App Manager, or Admin role.

## The team

```bash
ship users                                         # the team and open invitations, with roles and apps
ship users invite ada@example.com --first Ada --last Lovelace --role developer --apps Lift
ship users remove ada@example.com                  # or cancel their invitation
```

- `--role` takes Apple's roles in lowercase with dashes (`app-manager`, `customer-support`, …), and repeats.
- `--apps` takes an App Store Connect id, an app from `ship apps`, or the bundle id of any of the team's apps, and repeats. Without it, the invitation is for every app; `--all-apps` says so explicitly.
- The global `--app` doesn't limit an invitation, so passing it without `--apps` or `--all-apps` is an error.

Changing the team needs an Admin key.

## Devices

```bash
ship devices                                       # registered devices: name, kind, model, UDID, status
ship devices add 00008030-001A2D2E0C38802E --name "Ada's iPhone"
ship devices rename "Ada's iPhone" "Test iPhone"
ship devices disable "Test iPhone"
```

A device is named by its UDID or its name. The API can't delete a device, and a disabled one still counts against your limit until the membership year renews.

## Sandbox accounts

Sandbox Apple Accounts are for testing purchases.

```bash
ship sandbox                                       # list them
ship sandbox clear --all                           # erase what they've bought
ship sandbox set a@sandbox.test --renewal 5m --territory GBR --interrupt
```

The API can't create a sandbox account. Add them in App Store Connect → Users and Access → Sandbox.

## Certificates and provisioning profiles

Xcode's automatic signing creates and installs what a build needs, and `ship beta` uses it. These commands are for when you sign by hand, like on a fresh CI machine, or want to see what's there.

```bash
ship certificates                                  # the team's certificates: kind, serial, expiry, and whether this Mac can sign with it
ship certificates create --type distribution --csr CertificateSigningRequest.certSigningRequest
ship certificates revoke <serial>

ship profiles                                      # this app's provisioning profiles, which Xcode manages, and which are installed
ship profiles create --type app-store              # or development, ad-hoc, direct (a Mac app with Developer ID)
ship profiles install                              # the app's valid profiles, where Xcode finds them
ship profiles delete "Lift ad-hoc (ship)"
```

### Certificates

ship never handles a private key.

- **"On this Mac"** means the certificate's fingerprint is one of the Keychain's valid identities (`security find-identity -v`, installer-signing ones included), so its private key is there.
- **`create`** takes a signing request you make in Keychain Access (Certificate Assistant → Request a Certificate From a Certificate Authority, saved to disk), so the key stays in the Keychain. ship sends only the request, and refuses a file with a private key in it.
- ship adds the new certificate, which is public, to the login Keychain, or to `--keychain <path>` (such as a CI build keychain). It pairs with the private key when the key is in that same keychain.
- The `.cer` is also saved next to the request. If the Keychain won't take it (a locked keychain, say), the error names the certificate Apple made and the file to double-click.
- `--type` takes `distribution`, `development`, `developer-id`, or `mac-installer`.
- A certificate that expires within 30 days gets a warning.
- **Revoking can't be undone.** Nothing can be signed with the certificate again, and profiles that hold it stop working.

### Profiles

`ship profiles create` makes a profile for the app's bundle id and platform, then installs it.

- A development profile holds every current development certificate. The others hold one: this Mac's when it has one, or `--certificate <serial>`.
- Development and ad hoc profiles hold every enabled device that runs the platform (an Apple TV for tvOS, not an iPhone).
- A name that's already taken is refused before Apple sees it.
- Profiles are installed in Xcode's profiles folder, `~/Library/Developer/Xcode/UserData/Provisioning Profiles`.
- Profiles Xcode's automatic signing made ("iOS Team Provisioning Profile: …") are listed as made by Xcode, and `delete` leaves them to Xcode.

## Anything else: `ship api`

For what ship has no command for yet, `ship api` sends one request to the [App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi). It's signed with ship's key, retried like every other request, and prints Apple's JSON as it came back. `{app}` in the path is the app's App Store Connect id.

```bash
ship api /v1/apps/{app}/appStoreVersions
ship api /v1/apps/{app}/builds --all                      # every page
ship api PATCH /v1/builds/<id> --body-file build.json     # or --body '{"data": …}', or --body-file - for stdin
ship api DELETE /v1/betaTesters/<id>
```
