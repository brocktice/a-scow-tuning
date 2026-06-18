# Deploying A Scow Tuner to web2 (atuner.anfani.com)

Self-hosted replacement for the Cloudflare Pages site. Stack: Node (Express +
better-sqlite3, magic-link auth, shared boats) behind Caddy (auto Let's Encrypt),
fronted by the web2 haproxy ingress. Mirrors the `../monitoring` deploy pattern.

```
internet ─▶ haproxy (ingress)
              :80  atuner.anfani.com ─▶ web2:8884  (Caddy http: ACME HTTP-01 + redirect)
              :443 atuner.anfani.com ─▶ web2:8445  (SNI passthrough; Caddy terminates TLS)
                                           └─▶ atuner:8790 (Node app, /data/atuner.db)
```

Ports `8884`/`8445` are assumed free on web2 (`10.3.0.140`). weather uses 8880/8443,
jhmail 8882/8444. Verify with `ss -ltnp` and adjust `compose.yaml` + the haproxy
routes together if they clash.

---

## 1. Stalwart SMTP account (outbound mail)

Magic-link logins and invites are sent via the anfani Stalwart submission relay.
Create a dedicated submission account `atuner@anfani.com` (see
`fleet-commander/roles/linux_baseline_system_mail`). In the Stalwart admin UI (or
CLI), add an account/login with a strong password, allowed to submit on
`mail.anfani.com:587` (STARTTLS). No mailbox/IMAP needed — submission only.

Put the password into web2's `.env` as `SMTP_PASS` (step 4).

## 2. DNS — atuner.anfani.com CNAME

CNAME to `ash1.anfani.com` (mirrors `weather.anfani.com`; handles split-horizon/NAT).
Run from `fleet-commander`:

```bash
cd ~/src/fleet-commander
ansible-playbook playbooks/powerdns_record_baseline.yml \
  -e powerdns_record_zone=anfani.com \
  -e powerdns_record_name=atuner.anfani.com \
  -e powerdns_record_type=CNAME \
  -e '{"powerdns_record_values":["ash1.anfani.com"]}'
```

Verify: `dig +short atuner.anfani.com` resolves to the ash1 chain.

## 3. haproxy ingress routes

Add to `fleet-commander/inventory/service_lxc.yml`. **fleet-commander has
uncommitted local changes — apply these by hand, don't let an automated edit clobber
them.**

Under `reverse_proxy_haproxy_http_routes:` (ACME HTTP-01 + http→https redirect):

```yaml
    - name: atuner
      hosts: [atuner.anfani.com]
      backend: 10.3.0.140:8884
```

Under `reverse_proxy_haproxy_stream_ports:` → the `port: 443` entry's routes
(SNI passthrough; Caddy terminates TLS at the origin):

```yaml
        - hosts: [atuner.anfani.com]
          backend: 10.3.0.140:8445
```

Then apply:

```bash
cd ~/src/fleet-commander
ansible-playbook playbooks/reverse_proxy_haproxy_baseline.yml
```

DNS + haproxy must be live **before** the first deploy so Caddy can complete the
ACME HTTP-01 challenge for the cert.

## 4. Runtime secrets (.env on web2)

`.env` is gitignored and must never be committed. Create it on web2 once:

```bash
ssh web2
mkdir -p ~/src/a-scow-tuning && cd ~/src/a-scow-tuning
# first deploy will drop .env.example here; or scp it over now
cp .env.example .env
$EDITOR .env   # set SMTP_PASS, confirm ADMIN_EMAILS + ACME_EMAIL + APP_BASE_URL
```

`ADMIN_EMAILS` is the bootstrap allowlist — those addresses can always request a
login link; everyone else is invite-only. Keep `brock.tice@gmail.com` to get the
first owner in.

## 5. Deploy

From this repo (builds a tar artifact → copies to web2 → `docker compose up -d
--build` → health-checks the node container directly, so it works pre-TLS):

```bash
cd ~/src/a-scow-tuning
ansible-playbook -i deploy/inventory.yml deploy/deploy-web2.yml
```

The playbook **refuses to run** if `~/src/a-scow-tuning/.env` is missing on web2.

## 6. Verify

```bash
# on web2: containers up, cert obtained
ssh web2 'cd ~/src/a-scow-tuning && docker compose ps && docker compose logs --tail=40 caddy'
# from anywhere, once DNS + haproxy + cert are live:
curl -sS https://atuner.anfani.com/api/health        # -> {"ok":true}
```

Then open https://atuner.anfani.com, request a login link as an `ADMIN_EMAILS`
address, click it, create a boat, and test sharing/invite.

## 7. Cut over from Cloudflare Pages

Only after the web2 site is verified working with real data:

1. Merge `web2-selfhost` → `main` (or repoint deployment) — note `main` currently
   auto-deploys to Cloudflare Pages; the new `app.js` calls `/api/*` which only the
   self-hosted backend serves, so don't push to `main` until you're ready to cut over.
2. Migrate any existing boat configs (export/import JSON via the app UI).
3. Disable the Cloudflare Pages project / Access policy.
4. Revoke the old Cloudflare API token (still outstanding from the prior setup).

## Operations

```bash
ssh web2 'cd ~/src/a-scow-tuning && docker compose logs -f atuner'   # app logs
ssh web2 'cd ~/src/a-scow-tuning && docker compose restart atuner'   # restart
# SQLite DB lives in the atuner_data volume at /data/atuner.db
ssh web2 'docker run --rm -v a-scow-tuning_atuner_data:/d -v /tmp:/b alpine \
  cp /d/atuner.db /b/atuner-backup.db'                               # backup
```

Redeploy after code changes: just rerun the step 5 playbook.
