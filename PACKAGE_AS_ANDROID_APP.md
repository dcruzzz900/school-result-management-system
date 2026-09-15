# Getting This on Android Phones as an App

The app is now a **PWA (Progressive Web App)** — I added an app icon,
manifest, and offline shell to it. This unlocks two ways to get it onto
Android phones, from easiest to most "app-store-like." Both use the app
exactly as already deployed on PythonAnywhere — no extra deployment needed.

---

## Option A — "Add to Home Screen" (works right now, zero setup)

This is the fastest option and needs nothing beyond what you already have
deployed. Any teacher can do this themselves in 10 seconds:

1. Open the site in **Chrome** on the Android phone (e.g.
   `yourschool.pythonanywhere.com`).
2. Log in as usual.
3. Tap the **⋮** (three-dot menu) in Chrome, top right.
4. Tap **"Add to Home screen"** (Chrome may also show an automatic
   **"Install app"** banner/prompt — either works).
5. Confirm. An app icon appears on the home screen with the book-and-checkmark
   icon.

Tapping that icon opens the app **full-screen, with no browser address bar**
— visually indistinguishable from a "real" installed app, works offline for
the app shell, and updates automatically whenever you update the deployed
site. No app store, no APK, no waiting for approval.

**This is what I'd recommend for a school rollout** — send teachers a one-line
instruction ("open [link], log in, tap ⋮ → Add to Home screen") and everyone's
done.

---

## Option B — A real installable `.apk` file (for sideloading, or Play Store)

If you specifically want a `.apk` file you can send around, install without
Chrome, or eventually publish to the Google Play Store, use
**PWABuilder** — a free Microsoft-run tool that converts a PWA into a real
Android app package. No coding required.

### Steps

1. Make sure your app is live at its PythonAnywhere address (it must be
   reachable over `https://`, which PythonAnywhere gives you by default).
2. Go to **https://www.pwabuilder.com** in a browser.
3. Enter your site's URL (e.g. `https://yourschool.pythonanywhere.com`) and
   click **Start**.
4. PWABuilder scans the site and checks the manifest, icons, and service
   worker I already added — it should score well/green across the board.
5. Click **"Package for Stores"**, then choose **Android**.
6. Leave the default settings (package ID, app name, etc. are pre-filled
   from your manifest) unless you want to customize them, then click
   **Generate**.
7. Download the generated package — you'll get a `.apk` (installable
   directly) and/or `.aab` (the format required for the Play Store).

### Installing the `.apk` on a phone

1. Transfer the `.apk` file to the Android phone (email, Google Drive, USB, etc.).
2. Open it on the phone. Android will ask to allow installs from that source
   — approve it once.
3. It installs like any app, with your icon and name, and launches full-screen.

### Publishing to the Google Play Store (optional, not required)

If you eventually want it listed in the Play Store instead of manually
distributing the `.apk`:
- You need a one-time **$25 Google Play Developer account**
  (https://play.google.com/console/signup).
- Upload the `.aab` file PWABuilder generated, fill in your store listing
  (description, screenshots, privacy policy), and submit for review.
- This is entirely optional — sideloading the `.apk` works fine for
  internal school use and costs nothing.

---

## Which should you pick?

- **Just want teachers using it from their phones ASAP, free, no waiting:**
  Option A.
- **Want a `.apk` file to distribute directly, or plan to eventually put it
  on the Play Store:** Option B.

Both point at the same live app and database — nothing about your data or
setup changes based on which one you choose, and you can do both (A costs
nothing extra either way).
