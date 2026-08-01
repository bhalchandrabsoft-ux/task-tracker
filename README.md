# Rotation — Branch Task Duty Tracker

A single-page offline PWA for tracking recurring bank-branch tasks
and auto-computing fair rotation based on actual recorded history.

## Files

- `index.html` — the app (structure + all CSS)
- `app.js` — all application logic (storage, scheduler, UI)
- `manifest.json` — PWA manifest (Home Screen name/icon/colors)
- `sw.js` — service worker (offline caching)
- `icon-192.png`, `icon-512.png` — app icons

All six files must stay together in the same folder — the manifest,
service worker, and icons are referenced by relative path.

## Hosting it (required before it can install on an iPhone)

iOS only allows installing a Home Screen web app, and only registers
a service worker, over **HTTPS** (or `localhost` during testing) —
never over `file://`. Pick any static host:

- Drop the folder into **GitHub Pages**, **Netlify**, **Vercel**, or
  **Cloudflare Pages** (all have free tiers, just drag-and-drop the
  folder in).
- Or run it from any simple static server you already have.

You do **not** need a backend or database — it's a static file set.

## Installing on iPhone

1. Open the hosted URL in **Safari** (must be Safari, not Chrome).
2. Tap the **Share** icon → **Add to Home Screen** → **Add**.
3. Launch it from the Home Screen icon from then on.

After the first successful load, the service worker caches the whole
app, so it keeps working with **no signal or Wi-Fi at all** —
including a fresh launch from Home Screen in airplane mode.

## Using it

1. **More → Appearance** section is where Dark Mode lives; the rest
   of setup starts from **People**.
2. Add your **Employees** first, then add a **Task** (e.g. "Vault
   Inspection") and assign the employees who can perform it.
3. On the **Calendar**, tap any working day and record who actually
   performed the task. The very first recorded day is what the
   rotation engine starts predicting from — days before that are
   left blank.
4. From then on, every future working day is predicted automatically
   using the rotation rules (plain alternation by default; if you
   record the same person on consecutive days, the next person
   automatically gets the same number of consecutive days next,
   and that becomes the new standard block size going forward).
5. Sundays, the 2nd & 4th Saturdays, and anything added under
   **More → Holidays** are skipped automatically and never break a
   rotation streak.
6. **Reports** gives per-employee counts, block/sequence history, and
   CSV export, per task, per month or year.
7. **More → Backup** lets you export/import a full JSON backup, or
   wipe the device's data.

## Notes on the scheduling engine

The rotation logic lives in the `Scheduler` module inside `app.js`,
heavily commented. It was checked against every worked example in
the spec (1/2/3/4-day blocks, sequence coloring, holiday skipping)
before shipping.
