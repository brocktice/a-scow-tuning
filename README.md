# A Scow Rig Tuning — log & config editor

A web app for tracking Melges A Scow rig tuning over time. Plain HTML/CSS/JS
front-end, with an optional Cloudflare-hosted backend for multi-device, multi-crew
sync. No build step.

## Run

- **Quickest:** open `index.html` in a browser. Data persists per-browser in
  `localStorage`.
- **Local dev server:** `python3 serve_https.py` (self-signed HTTPS on `:8443`,
  with a single shared `store.json`).
- **Production (recommended):** Cloudflare Pages — see **[DEPLOY.md](DEPLOY.md)**.
  Auto-deploys from GitHub, syncs all your devices, and lets you invite a few
  crews by email (invite-only, abuse-proof). Each crew's data is isolated.

## Features
- **Boat profiles** — multiple boats, each seeded from the reference grid.
  New profiles can start from the reference or copy the current boat's config.
- **Tuning Grid** — editable settings per setup (Andy / Buddy / C4 + your own)
  across wind ranges, including a **Diamond** (pre-bend) row with bend / loos / lbs.
  Inline-editable; flags `lowers ≈ ½ uppers` rule-of-thumb violations without
  auto-correcting. Header row and wire column stay pinned while scrolling.
- **Tuning Log** — record actual wind, settings sailed, observed performance,
  adjustments, and notes per race/day. Pre-fill settings from any reference setup ×
  wind range, including per-side (port/stbd) turnbuckle counts for the asymmetric hull.
- **Analysis** — log entries grouped by wind range with the reference row inline,
  to spot drift over time.
- **Reference & terminology** — collapsible panel on the grid page (incl. the North
  Sails label-swap warning, hull asymmetry, pre-bend confirmation status).
- **Export / Import** — back up or move a profile as JSON.
- **Adaptive layout** — works on phone and desktop.

## Storage model
- **Browser `localStorage`** is always used as an offline cache.
- When served from a host with the storage API, the app also syncs to the server
  (`GET`/`PUT /api/store`). A badge in the header shows Synced / Saving… / Offline.
- In production the API is a **Cloudflare Pages Function** backed by **Workers KV**,
  with data namespaced per **Cloudflare Access** email — so each crew sees only
  their own boats. Sync is last-write-wins.

## Files
- `index.html` / `styles.css` / `app.js` — the front-end
- `data.js` — seeded reference tuning data
- `functions/api/store.js` — Cloudflare Pages Function (storage API, per-user KV)
- `serve_https.py` — local-only dev server (static + shared `store.json`)
- `DEPLOY.md` — Cloudflare Pages setup
