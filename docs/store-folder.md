# The store folder

Everything App Store Connect shows about your app lives in one folder next to `ship.json`: `appstore/`, or whatever `"store"` in `ship.json` names. A pull request shows exactly what changes on the page, and `git log` says when it did. Commit all of it.

- [How it works](#how-it-works)
- [Coming from fastlane](#coming-from-fastlane)
- [The App Store page](#the-app-store-page)
- [Screenshots and app previews](#screenshots-and-app-previews)
- [TestFlight test information](#testflight-test-information)
- [In-app purchases](#in-app-purchases)
- [Subscriptions](#subscriptions)

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
  purchases/
    com.example.lift.pro/purchase.json  review-notes.txt  en-US/name.txt  …
  subscriptions/
    Lift Pro/en-US/name.txt  app-name.txt
    Lift Pro/com.example.lift.monthly/subscription.json  review-notes.txt  en-US/name.txt  …
```

## How it works

Five commands share the folder, and each has the same four actions:

| | `pull` · `diff` · `push` · `validate` |
|---|---|
| The App Store page | `ship metadata …` |
| Screenshots and previews | `ship screenshots …` |
| TestFlight test information | `ship testflight …` |
| In-app purchases | `ship purchases …` |
| Subscriptions | `ship subscriptions …` |

The rules are the same for all five:

- **`pull`** writes the files from App Store Connect. Run it once to start. It won't overwrite a file you changed unless you pass `--force`.
- **`diff`** shows what `push` would change. `--exit-code` exits 1 when there are changes, for a CI check that the repo and App Store Connect agree.
- **`push`** validates first and stops on errors. `--dry-run` shows what it would do.
- **`validate`** runs offline.
- **A missing file is left alone; an empty file clears the field.**
- **`push` only adds and replaces.** `--prune` is the only way it deletes anything in App Store Connect that has no file or folder here.
- **Passwords are references** (see [Secrets](setup.md#secrets)), never the password itself, and they show as `••••`.

## Coming from fastlane

`ship metadata import` and `ship screenshots import` convert a fastlane deliver folder, offline. `--from` points at it; the default is `fastlane/` next to `ship.json`.

- Text files become their store-folder files. `release_notes.txt` becomes `whats-new.txt`, keywords go one per line, and `default/` fills in whatever a language doesn't have.
- `copyright.txt`, the category files, and `review_information/` go to `app.json` and `review-notes.txt`.
- Each screenshot goes in the display type its pixel size fits. When a size fits two, the file name or the app's platform decides. Screenshots are numbered in fastlane's order.
- A display-type folder the import fills ends up holding exactly fastlane's set. Another image already in it is a conflict; `--force` deletes it.
- What has no place in ship yet is listed: the Apple TV privacy policy, `app_rating_config.json`, and iMessage screenshots.
- `demo_password.txt` is listed too. ship stores a reference to the password, never the password, so it tells you how to save it with `ship secret set`.

Like `pull`, import won't overwrite a file that says something else without `--force`, and `--dry-run` shows what it would write.

## The App Store page

The page's text and App Information:

```
appstore/
  app.json                # categories, content rights, copyright, age rating, App Review contact, release defaults
  review-notes.txt        # notes for App Review
  en-US/
    name.txt  subtitle.txt  privacy-policy-url.txt  privacy-choices-url.txt
    description.txt  keywords.txt  promotional-text.txt  whats-new.txt  support-url.txt  marketing-url.txt
```

```bash
ship metadata pull        # write the files from App Store Connect (--force overwrites local edits)
ship metadata diff        # what push would change (--exit-code for CI)
ship metadata push        # apply it (--dry-run to preview, --prune to delete languages without a folder)
ship metadata validate    # lengths, keyword bytes, URLs, app.json values, and secrets, offline
```

`keywords.txt` holds one keyword per line. push joins them with commas, and the 100-byte limit counts the commas. A new language folder is added on push; it needs a `name.txt`.

### Pull shows what's left to fill in

A field that's empty in App Store Connect gets an empty file (What's New only once the app has been released), so a new app's folder lists every field. An empty file changes nothing on push.

Pull then lists what App Review still needs, from the same checks `ship release submit` runs, plus a primary category and the age rating questions:

```
App Review still needs:
  No description in en-US
  No support URL in en-US
  No 6.9" or 6.5" iPhone screenshots in en-US
  No copyright
  …
```

With `--json`, those are in `missing` (each with `name`, `detail`, `blocking`, and `fix`), and the empty files are in `placeholders`.

### When things can change

Apple takes most changes only while a version is being prepared:

| Field | Can change |
|---|---|
| Promotional text, content rights | any time |
| Name, subtitle, privacy URLs, categories, age rating | on the App Info being prepared |
| Everything else | on the version being prepared, or `--version <x.y>` |

When something can't change yet, push stops and lists it; `--partial` pushes the rest. What's New is skipped on an app's first version. The phased release and a scheduled release date are set by [`ship release`](releasing.md), not push.

### The demo account password

In `app.json`, the demo account password is a reference, never the password:

```json
"demoAccountPassword": "keychain:ship/lift-demo-password"
```

`op://…`, `env:…`, and `file:…` work too (see [Secrets](setup.md#secrets)). Save the password with:

```bash
ship secret set keychain:ship/lift-demo-password --stdin
```

- Pull never writes the password.
- `validate` and push refuse a password written out, and one that points at ship's own secrets (the API key or the 1Password token), since push would send it to App Store Connect.
- diff and push show it as `••••`.
- Left out, the password in App Store Connect stays as it is. `""` or `null` clears it.

## Screenshots and app previews

```bash
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

Folder names are App Store Connect's display types: `APP_IPHONE_67`, `APP_IPHONE_65`, `APP_IPAD_PRO_3GEN_129`, `APP_DESKTOP`, `APP_APPLE_TV`, `APP_APPLE_VISION_PRO`, `APP_WATCH_ULTRA`, and so on. Preview folders use preview types, which drop the `APP_` (`IPHONE_67`). `ship screenshots validate` lists them all when a folder name is wrong.

- Screenshots are `.png` or `.jpg`. Previews are `.mp4`, `.mov`, or `.m4v`.
- A set holds up to 10 screenshots and 3 previews.
- **Order is file-name order**, compared the way people number things (`2-…` before `10-…`). Number your files; push puts each set in that order.
- `--locale` and `--type` narrow any command to some languages or display types.

### What push does

- A file whose contents match an uploaded screenshot is left alone.
- A new file is uploaded. A changed file is uploaded and replaces the old one.
- Screenshots in App Store Connect that aren't in the repo stay, after the repo's, unless you pass `--prune`. `--prune` deletes them, and whole sets whose folder is gone.
- Only languages and kinds with a folder are touched. Without `en-US/previews/`, ship leaves en-US's previews alone, even with `--prune`.
- push waits for Apple to process each upload, and stops with Apple's reason if one fails. `--no-wait` skips the wait. Failed uploads are always cleaned up.

Screenshots can change only while a version is being prepared. push works on that version (or `--version`), and tells you to run `ship release prepare` when there isn't one.

### media.lock.json

Commit it. Apple re-encodes what you upload, so a pulled screenshot's bytes differ from the file that was uploaded. The lock records, for each pulled or pushed file, its MD5 and the checksum of the upload it stands for, so a pull followed by a push changes nothing.

Edit or replace a file and push uploads it. Delete the lock and push compares contents only, so pulled files would upload again.

### validate

Runs offline and checks folder names, file types, counts, transparency (Apple rejects alpha channels), and each screenshot's pixel size against [Apple's sizes](https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications) for its type. push runs it first and stops on errors.

## TestFlight test information

What testers see about the beta, and what Beta App Review needs, live in `appstore/testflight/`:

```
appstore/testflight/
  review.json            contact, and the demo account ("demoAccountPassword": "keychain:ship/lift-beta-demo-password")
  review-notes.txt       notes for Beta App Review
  en-US/
    description.txt      about the beta (up to 4,000 characters)
    feedback-email.txt  marketing-url.txt  privacy-policy-url.txt  tvos-privacy-policy.txt
```

```bash
ship testflight pull       # write the folder (--force overwrites files you changed)
ship testflight diff       # what would change
ship testflight push       # send it (--dry-run to preview, --prune to delete languages with no folder)
ship testflight validate   # lengths, URLs, emails, and the demo account, offline
```

Unlike the App Store page, all of it can change any time.

The demo account password in `review.json` works as it does in `app.json`: a [reference](setup.md#secrets) that ship reads only to send to Apple. `pull` leaves it out and tells you how to save it. Left out, the password in App Store Connect stays as it is; `""` or `null` clears it.

## In-app purchases

Consumable, non-consumable, and non-renewing subscription purchases live in `appstore/purchases/`, one folder per product id. `ship purchases` has the same `pull`, `diff`, `push`, and `validate`; `--product <id>` narrows pull, diff, and push.

```
appstore/purchases/
  com.example.lift.pro/
    purchase.json         type, reference name, Family Sharing, price, where it's sold
    review-notes.txt      notes for App Review
    en-US/
      name.txt            the display name (up to 35 characters)
      description.txt     up to 55 characters
```

```json
{
  "type": "NON_CONSUMABLE",
  "referenceName": "Pro",
  "familySharing": true,
  "price": { "territory": "USA", "amount": "4.99" },
  "availability": { "territories": "all", "newTerritories": true }
}
```

`availability.territories` takes `"all"` or a list of territories.

### Prices

The price is one territory's, and Apple sets the others to match, as App Store Connect does unless you set them by hand. push picks Apple's price point for that amount.

- When there's no price point for the amount, push names the nearest. For a purchase that exists, it stops before changing anything. For a new one, it stops right after creating it, before its languages and the rest; push again once the amount is fixed.
- A new price replaces Apple's whole price schedule. So when a purchase has other prices set by hand (another territory's, or a change scheduled for later), push stops and lists them. `--prune` replaces them.

### Creating and deleting

- push creates a purchase that has a folder but isn't in App Store Connect yet. It needs `type` and `referenceName`.
- push never deletes a purchase, since Apple only lets you delete one that was never submitted. `--prune` deletes languages without a folder, and the hand-set prices above.
- A purchase's product id and type can't change, and Family Sharing can't be turned off once it's on. push says so instead of trying.
- A purchase is submitted with the app's next version, after a review screenshot is added in App Store Connect.

Auto-renewable subscriptions aren't in-app purchases in the API. They have [their own command](#subscriptions).

## Subscriptions

Auto-renewable subscriptions live in `appstore/subscriptions/`, one folder per group, named for the group's reference name. `ship subscriptions` has `pull`, `diff`, `push`, and `validate`; `--product <id>` narrows pull, diff, and push.

```
appstore/subscriptions/
  Lift Pro/
    en-US/
      name.txt            the group's display name
      app-name.txt        the app's name shown with it, when it differs
    com.example.lift.monthly/
      subscription.json   period, level, reference name, Family Sharing, price, where it's sold
      review-notes.txt
      en-US/name.txt  description.txt
```

```json
{
  "period": "ONE_MONTH",
  "level": 1,
  "referenceName": "Monthly",
  "familySharing": true,
  "price": { "territory": "USA", "amount": "4.99" },
  "availability": { "territories": "all", "newTerritories": true }
}
```

In a group folder, a folder with `subscription.json` in it is a subscription, and any other folder is a language. So a product id that looks like a language code still works.

`level` is the subscription's place in the group. 1 is the highest, the one people upgrade to.

### Prices

A subscription has a price per territory. push sets the file's territory to that amount and every other territory to Apple's equivalent.

- People already subscribed keep what they pay, unless the price says `"existingSubscribers": "update"`.
- A price set by hand in another territory (one that isn't Apple's equivalent of today's price), or one scheduled for later, would be replaced. So push stops and lists them. `--prune` replaces them, deleting the scheduled ones.
- `availability` is the standard plan's (paid up front each period), not the monthly installment plan's.

### Creating and deleting

- push creates groups and subscriptions that have a folder but aren't in App Store Connect yet. A subscription needs `period` and `referenceName`.
- push never deletes a group or a subscription. `--prune` deletes languages without a folder.
- A subscription can't move to another group, and Family Sharing can't be turned off once it's on.
- To rename a group, rename it in App Store Connect and pull.

Introductory, promotional, and win-back offers aren't supported yet.
