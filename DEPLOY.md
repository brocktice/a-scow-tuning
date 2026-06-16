# Deploying to Cloudflare Pages

The app runs entirely on Cloudflare's free tier: **Pages** serves the static
files and auto-deploys on every push, a **Pages Function** (`functions/api/store.js`)
provides the storage API, **Workers KV** persists the data, and **Cloudflare
Access** gates who can use it (invite-only by email).

## 1. Push to GitHub
```bash
git remote add origin git@github.com:<you>/a-scow-tuning.git
git push -u origin main
```

## 2. Create the Pages project
Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** →
pick the repo. Build settings:
- **Framework preset:** None
- **Build command:** *(leave empty)*
- **Build output directory:** `/`

Deploy. You'll get `https://<project>.pages.dev`.

## 3. Create + bind the KV namespace
- **Storage & Databases → KV → Create namespace**, name it e.g. `ascow-tuning`.
- Pages project → **Settings → Functions → KV namespace bindings → Add**:
  - **Variable name:** `STORE`
  - **KV namespace:** the one you just created.
- **Redeploy** (Deployments → Retry/redeploy) so the binding takes effect.

> The Function returns HTTP 500 `KV binding STORE is missing` until this is bound.

## 4. Turn on Access (invite-only)
This is what prevents spam/abuse — without it, anyone with the URL can use the app
(and everyone shares one data bucket).

- **Zero Trust → Access → Applications → Add an application → Self-hosted.**
- **Application domain:** your `<project>.pages.dev` (or a custom domain).
- **Policy:** Action **Allow**, with a rule like **Emails** → list your crew's
  addresses (or **Emails ending in** for a club domain).
- Save. Login method defaults to one-time PIN by email — no passwords to manage.

**Add a new crew later** = add their email to that policy. Remove access = remove
the email. Each email gets its own isolated set of boats/logs automatically.

## 5. Use it
Visit the URL → enter your email → type the PIN → you're in. The header shows the
signed-in address and a **log out** link.

---

## Notes
- **First login seeds your data:** a new email starts empty, so your current
  device's local data is pushed up on first load. Open the device that already has
  your data *first*.
- **KV is eventually consistent** — cross-device updates usually appear within
  seconds; rarely up to ~60s. Fine for one person across phone/laptop.
- **Backups:** use the in-app per-profile **Export** button. (KV isn't a file you
  can `cat`.)
- **Custom domain (optional):** Pages project → Custom domains. Update the Access
  application domain to match.

## Local development
Static-only preview (no KV/Access): open `index.html`, or run the dev server
`python3 serve_https.py`.

Full preview with the Function + a local KV:
```bash
npx wrangler pages dev . --kv STORE
```
(`cert.pem`, `key.pem`, `store.json` are local-dev only and git-ignored.)
