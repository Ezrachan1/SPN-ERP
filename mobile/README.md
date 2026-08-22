# SPN OS · mobile app (Android, Capacitor)

SPN OS is the SPN ERP web app shipped inside a native shell. The whole UI
(`app/public/index.html`, its libraries and fonts) is bundled in the APK, so the
app opens instantly and keeps working with no network; the Cloudflare Worker is
only used as the JSON API (login, per-collection sync, photos, app releases).
All the heavy lifting (reports, PDF/Excel generation, irrigation maths, charts,
image downscaling) runs on the phone, which keeps the Worker well inside its CPU
budget.

Why Capacitor and not React Native: the product already exists as a complete web
app. Capacitor wraps it as-is (one codebase for web + Android + iOS); React Native
would mean rewriting ~9,000 lines of UI for no functional gain.

## How it works

```
mobile/
  capacitor.config.json     appId com.spn.os · appName "SPN OS" · webDir www
  spn-mobile.config.json    apiBase = the Worker URL the app talks to
  scripts/build-www.mjs     app/public/index.html -> www/index.html
                            + window.SPN_CONFIG (apiBase, appVersion, mobile:true)
                            + vendors Chart.js / SheetJS / jsPDF / fonts into www/
                            + appends src/mobile-shim.js
  src/mobile-shim.js        hardware Back, share-sheet downloads, external links
  scripts/patch-android.mjs camera + location permissions, app label
  scripts/make-assets.mjs   icon/splash sources from the embedded SPN logo
  android/                  generated native project (cap add android)
```

Offline-first behaviour lives in the web app itself (so it also benefits the
browser version):

- every save lands in the device store first; the Worker is synced per collection
- when the API is unreachable the app switches to **Offline** (topbar chip), keeps
  working, remembers the last synced state as a merge base, and probes every 15 s
- on reconnect it **3-way merges** each changed collection (records you
  added/edited/deleted win for those records only; colleagues' changes survive),
  uploads photos taken offline, pushes, then pulls the latest workspace
- offline changes survive closing the app (sync state is persisted); a device
  that still holds unsynced work pushes it on the next sign-in before pulling
- the last forecast for the area of interest is cached for the Weather module
- sign-in itself needs a connection (passwords are verified by the Worker); a
  device that signed in before opens straight into its last synced workspace
- if the session expires while offline, the app keeps working; the topbar chip
  says "Session expired · N to sync - sign in" and signing in again pushes the
  pending work before pulling
- device storage: the workspace, its last-synced snapshot (the merge base) and
  photos taken offline live in the WebView's local storage (~5-10 MB budget).
  That is ample for the nursery's data; very large photo backlogs should be
  synced before taking many more

## Build the APK

Prerequisites: Node 18+, Android Studio (for its JDK 21 and the Android SDK).
Windows paths below; adapt for macOS/Linux.

```bash
cd mobile
npm install
npm run build:www          # builds www/ from ../app/public/index.html
npm run android:add        # first time only: generates android/, patches it and
                           # writes the SPN launcher icons, splash and tones
```

`npm run sync` (and therefore `npm run apk`) re-runs the icon/splash/tone
generation every time, so a freshly generated `android/` never ships with the
Capacitor placeholder icon. If a phone still shows the old icon after
installing a new build, uninstall and reinstall once (launchers cache icons).

Set the SDK/JDK for Gradle once (or open the project in Android Studio, which
does this for you):

```bash
export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
```

Debug APK (installable straight away, for testing):

```bash
npm run apk
```

Output: `android/app/build/outputs/apk/debug/SPN-OS-<version>-debug.apk` (the
version and the file name come from `mobile/package.json`; `patch-android.mjs`
writes them into `build.gradle` on every sync).

Release APK (what you upload for the team):

1. Create a keystore once and keep it safe (losing it means users must uninstall
   before installing a newer build):
   ```bash
   keytool -genkeypair -v -keystore spn-os.keystore -alias spnos -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Add signing to `android/app/build.gradle` (`signingConfigs.release` with the
   keystore path/passwords, referenced from `buildTypes.release`), or sign in
   Android Studio via Build → Generate Signed Bundle/APK.
3. `npm run apk:release` → `android/app/build/outputs/apk/release/SPN-OS-<version>-release.apk`.

Bump the version in `mobile/package.json` (`version`) for every release; the
sync step copies it into `build.gradle` (`versionName`, and `versionCode` =
major·10000 + minor·100 + patch). Uploaded builds are served to users as
`SPN-OS-v<version>.apk` regardless of the local file name.

## Pointing the app at your Worker

`spn-mobile.config.json` → `apiBase` (or `SPN_API_BASE=https://... npm run build:www`).
The Worker allows the app's WebView origin (`https://localhost`,
`capacitor://localhost`) through CORS; add any custom origin to `ALLOWED_ORIGINS`
in `app/wrangler.jsonc`.

## Distributing builds

Users & Access → **SPN OS mobile app · Android builds**: the Super User uploads
the APK with a version and notes. It is stored in R2; the newest 5 builds are
kept and older ones are deleted automatically. The login page then shows
"SPN OS for Android vX · Download APK" to everyone, and the profile page has the
same link. Android asks once to allow installs from the browser; updates are
installed over the existing app (same signing key).

## Notifications

- In the app (web and phone): a pop-up card appears top-right whenever the
  bell gains a new item, with a tone (synthesised in the app, works offline)
  and vibration. Tapping the card opens the record.
- On the phone: the same new items also land in the Android notification bar,
  and dated items are scheduled as reminders that fire even when the app is
  closed: visits due today (07:30), harvests due, seed lots expiring (7 days
  before and on the day). Tapping a notification opens the module.
- Everyone picks their own tone (Phone default sound, SPN chime, Bell, Drip,
  Soft, Alert, Silent), vibration, pop-ups and phone notifications under My
  Profile → Notifications; the choice is saved in their profile (all devices)
  and the phone asks once for notification permission (Android 13+).
  "Phone default sound" is the sound the phone already uses for notifications.
  Any other system sound or ringtone can be assigned to a tone channel via
  "Choose any phone sound…", which opens Settings → Apps → SPN OS →
  Notifications (Android only allows that choice from its own settings screen;
  the plugin `capacitor-native-settings` opens it, no Google services).
- Implementation: `@capacitor/local-notifications` (plain Android API, one
  notification channel per tone with a bundled `res/raw/spn_*.wav` tone
  generated by `scripts/make-notif-assets.mjs`, which also writes the
  monochrome status-bar icon). No Firebase / Google Play Services and no
  Huawei Push Kit are involved, so this works identically on GMS and HMS.
  What it cannot do: wake the app for *server-side* events while it is fully
  closed (a colleague's new access request): those appear on the next open or
  via the 2-minute pull while the app is open. If that is ever needed, add a
  push provider (FCM for GMS, HMS Push Kit for Huawei) behind the same
  `SPN_MOBILE.notify` bridge.

## Huawei and other non-GMS phones (HMS, AOSP)

The app does not depend on Google Mobile Services: no Firebase, no Google Maps
SDK, no Play Services location. It runs on Huawei (HMS/EMUI/HarmonyOS with
Android WebView), AOSP-based tablets and Play-less Android:

- install the APK directly (no Play Store needed); AppGallery submission is
  optional and accepts the same APK/AAB;
- the only runtime requirement is Android System WebView 60+ (present on
  Huawei devices; on very old AOSP builds update it from AppGallery/APKMirror);
- location for farm plots, acreage and leads uses the Android location
  service through the WebView (works with HMS Location);
- map links use `geo:` URIs, so Petal Maps, Google Maps or OsmAnd opens them;
  the embedded map previews are Google Maps iframes and simply need internet;
- notifications are local (above), so no push service is required;
- downloads/exports use the Android share sheet (Filesystem + Share plugins).

## iOS

The same project builds for iOS: `npx cap add ios` creates `ios/`, and the
Worker already allows the `capacitor://localhost` origin. What you need:

- a Mac with Xcode (or a cloud Mac: GitHub Actions `macos` runners, Codemagic,
  Ionic Appflow, MacStadium/MacinCloud) to build and sign
- an Apple Developer Program membership (USD 99/year)
- distribution: **TestFlight** (up to 10,000 internal/external testers, no App
  Store review for internal testers) is the practical route for a company app;
  the App Store needs review; Apple Business Manager/custom apps is another
  private-distribution route; "Enterprise" certificates are restricted to large
  organisations. There is no APK-style sideloading on iOS.
- App Store review expects a working demo account; the existing login flow
  is fine for that.
- zero-cost alternative today: iPhone users can open the web app in Safari and
  use "Add to Home Screen"; it runs full-screen with the same offline-first
  behaviour once a service worker is added (not included yet).

## Updating the app

The UI ships inside the APK, so UI changes need a new build + upload (the login
page link and the in-app releases card make that a two-minute process for
users). API changes deploy to the Worker independently (`cd app && npx wrangler
deploy`). If you later want over-the-air UI updates without reinstalling, look
at Capgo or Ionic Appflow Live Updates; the web app already reads its API base
from `window.SPN_CONFIG`, so nothing else needs to change.
