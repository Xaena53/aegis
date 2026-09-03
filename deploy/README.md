<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Deploying the hosted service

This guide covers running AdsPilot as a multi-user service on a Linux VPS. The order of
steps matters — several of them fail in confusing ways if you skip ahead.

The files in this directory (`adspilot.service`, `nginx.conf.example`, and the
`Dockerfile` at the repository root) carry the same warnings inline, so you'll see them
even if you don't read this page.

## Upgrading an existing install — read this before `git pull`

> **Breaking change: a hex-only `ADSPILOT_MASTER_KEY` whose length is not exactly 64 no
> longer starts.** Earlier versions silently stretched such a value with scrypt, exactly as
> if it were a passphrase. It is now refused at startup, because "a machine key copied one
> character short" and "a passphrase" are indistinguishable to the code and guessing wrong
> means every stored secret is encrypted under a key the operator never intended.

This matters *only* if the key you run today is all hex digits and is not 64 characters long
(a 32-character `openssl rand -hex 16` is the common case). Check on the running host,
before you upgrade:

```bash
sudo -u adspilot node -e '
const line = require("fs").readFileSync("/opt/adspilot/.env", "utf8")
  .split(/\r?\n/).map((l) => l.trim())
  .find((l) => l.startsWith("ADSPILOT_MASTER_KEY="));
const k = (line ? line.slice("ADSPILOT_MASTER_KEY=".length) : "").trim();
const hex = /^[0-9a-f]+$/i.test(k);
console.log(!hex ? (k.length >= 32 ? "passphrase — upgrade is safe" : "TOO SHORT — fix before upgrading")
  : k.length === 64 ? "64-hex — upgrade is safe"
  : "HEX BUT NOT 64 (" + k.length + ") — this upgrade will refuse to start");'
```

If it prints **HEX BUT NOT 64**, understand what the upgrade costs before you take it. The
process will exit at startup (`şifreleme anahtarı kullanılamıyor`), and *padding the key back
to 64 characters does not recover anything*: the stored `refresh_token_enc` values were
encrypted under the scrypt-derived key, and no length-64 value reproduces it. There is no
migration script; the supported path is:

1. Note the current key value — losing it removes even the theoretical recovery route.
2. Upgrade, then put a fresh `ADSPILOT_MASTER_KEY=<64 hex characters>` in `.env`.
3. Have every tenant reconnect through `/connect`, which overwrites their row with a token
   encrypted under the new key. Until they do, their first request fails.

Tell your tenants before the restart, not after. Nothing else in this guide changes for an
upgrade — steps 1 and 4 are one-time setup, and `npm ci && npm run build && systemctl restart
adspilot` is the rest of it.

## Prerequisites

| Requirement | Why it's non-negotiable |
|---|---|
| **Node ≥ 22.13** | Hosted mode uses the built-in `node:sqlite`, which arrived in 22.5 and lost its flag in 22.13. Ubuntu/Debian's apt package is 18 or 20, and the server dies on first import. |
| **Domain + TLS** | Bearer API keys and OAuth codes cannot travel over plain HTTP. |
| **Google Ads Basic Access** | With Test Access, real user accounts do not work at all — only test accounts. A hosted beta cannot open before this is approved. |
| **Verified OAuth consent screen** | See the seven-day trap in step 4. |

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs && node -v      # must print v22.13 or newer
```

## 1. User and directory

```bash
sudo useradd --system --home /opt/adspilot --shell /usr/sbin/nologin adspilot
sudo mkdir -p /opt/adspilot && sudo chown adspilot:adspilot /opt/adspilot
```

The `data` directory is created *after* the clone — `git clone` refuses a non-empty
target.

## 2. Code

```bash
sudo -u adspilot -H git clone <repo-url> /opt/adspilot
cd /opt/adspilot
sudo -u adspilot -H mkdir -p data
sudo -u adspilot -H npm ci
sudo -u adspilot -H npm run build
```

`-H` matters: without it `sudo` keeps the caller's `HOME` and npm tries to write to
`/root/.npm`.

## 3. Configuration

```bash
sudo -u adspilot cp .env.example .env
sudo -u adspilot node -e "console.log('ADSPILOT_MASTER_KEY='+require('crypto').randomBytes(32).toString('hex'))"
sudo nano /opt/adspilot/.env
sudo chmod 600 /opt/adspilot/.env
```

Required values:

```ini
GOOGLE_ADS_DEVELOPER_TOKEN=...
GOOGLE_ADS_CLIENT_ID=...
GOOGLE_ADS_CLIENT_SECRET=...
ADSPILOT_MASTER_KEY=<64 hex characters>
ADSPILOT_DB=/opt/adspilot/data/adspilot.db
ADSPILOT_PUBLIC_URL=https://adspilot.example.com
ADSPILOT_ALLOWED_HOSTS=adspilot.example.com
ADSPILOT_SOURCE_URL=https://github.com/YOUR-ACCOUNT/YOUR-FORK
PORT=8787
```

> **Never put a comment on the same line as a value.** This file is also read by systemd
> (`EnvironmentFile`) and Docker (`--env-file`), and both treat `#` as a comment only at
> the start of a line. `ADSPILOT_ALLOWED_HOSTS=example.com   # required` becomes a host
> named `example.com   # required`, nothing matches, and **all MCP traffic returns 403**
> — a failure that is genuinely hard to diagnose.
> Verify with: `systemctl show adspilot -p Environment`

> **`ADSPILOT_MASTER_KEY` is either exactly 64 hex characters or a non-hex passphrase.**
> The value is trimmed before use (a trailing newline from a secret file is harmless), and
> a hex-only value whose length is not 64 is **refused at startup** rather than silently
> treated as a passphrase — that silent fallback derived a different key, so nothing in the
> database could be decrypted while the process still reported itself healthy. Passphrases
> are stretched with scrypt; the minimum length (32 characters) is enforced on the trimmed
> value, so padding with spaces does not get past it.

> **`ADSPILOT_MASTER_KEY` is unrecoverable.** Lose it and every stored refresh token
> becomes undecryptable. Back it up separately from the database — if both are stolen
> together, the encryption bought you nothing.

> **`ADSPILOT_DB` must be an absolute path.** Left empty, the file is looked up relative
> to the working directory, which `ProtectSystem=strict` makes read-only; the service
> then crash-loops every five seconds.

> **`ADSPILOT_DECISION_LOG` only works under a writable path.** The unit runs with
> `ProtectSystem=strict`, so the filesystem is read-only apart from `ReadWritePaths=`
> (`/opt/adspilot/data`) and `LogsDirectory=` (`/var/log/adspilot`, which systemd creates
> and chowns for you). Point the log anywhere else and every risk-tagged decision hits the
> sandbox — and *nothing breaks*: the decision log is deliberately an observation, never a
> gate, so a write failure prints one stderr line and the approval flow continues. The file
> simply stays empty, and you find out the month someone asks how many spend increases were
> refused. The value below is inside the writable set:
>
> ```ini
> ADSPILOT_DECISION_LOG=/var/log/adspilot/kararlar.jsonl
> ```
>
> Verify after the first refusal with: `sudo -u adspilot tail /var/log/adspilot/kararlar.jsonl`

> **`ADSPILOT_SOURCE_URL` must point at your own repository** if you modified the code.
> AGPL §13 requires offering *your* version's source to your users; the upstream default
> does not satisfy that.

The server refuses to start on missing or invalid configuration, so a broken deployment
fails loudly instead of reporting itself healthy.

## 4. Google Cloud OAuth

> **Create a "Web application" client, not a "Desktop app" client.** Desktop clients
> cannot have their redirect URIs edited — they only accept loopback — so the hosted
> flow can never complete and `/connect` ends in `redirect_uri_mismatch`. Desktop is the
> right type for local stdio use (`npm run auth`); these should be **two separate
> clients**.

Add this exact authorised redirect URI:

```
https://adspilot.example.com/oauth/callback
```

> **The seven-day trap.** `adwords` is one of Google's *sensitive* scopes. While your
> consent screen is in "Testing" mode, Google **expires refresh tokens after seven
> days** and caps you at 100 test users — hosted users would silently lose their
> connection every week with `invalid_grant`. Move the consent screen to production and
> complete verification before onboarding anyone. Treat this as a prerequisite of the
> same weight as Basic Access.

## 5. Service

```bash
sudo cp deploy/adspilot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now adspilot
sudo systemctl status adspilot
journalctl -u adspilot -f
```

> **Run exactly one instance.** Sessions and rate-limit counters live in process memory.
> With pm2 cluster mode or multiple replicas, requests land on a worker that doesn't know
> the session (`404 session_not_found` loops) and the rate limit is effectively
> multiplied by the worker count. Scaling horizontally requires moving both to shared
> storage first.

## 6. nginx and TLS

Obtain the certificate **before** installing the site config — the example references
`/etc/letsencrypt/...` paths, and `nginx -t` fails if they don't exist yet, which also
blocks certbot.

```bash
# 1. Certificate first, without touching nginx's site config
sudo apt-get install -y certbot
sudo certbot certonly --webroot -w /var/www/html -d adspilot.example.com

# 2. Now the config can load
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/adspilot
sudo nano /etc/nginx/sites-available/adspilot        # set your domain
sudo ln -s /etc/nginx/sites-available/adspilot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> **Do not remove `proxy_set_header Host $host;`.** Without it the upstream sees
> `Host: 127.0.0.1`, the DNS-rebinding protection finds no match, and **every MCP
> request returns 403**. It presents as "nothing works at all" with no useful error.

## 7. Verify

```bash
curl -s https://adspilot.example.com/health                    # {"ok":true,...}
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST https://adspilot.example.com/mcp                     # expect 401
```

Then open `https://adspilot.example.com/connect` in a browser, connect with Google, copy
the API key you're shown once, and register it:

```bash
claude mcp add --transport http adspilot https://adspilot.example.com/mcp \
  --header "Authorization: Bearer ap_..."
```

## 8. Backups

In WAL mode, copying the `.db` file while the service runs produces a corrupt backup —
recent writes may still live in `.db-wal`. Use SQLite's `.backup`, which writes one
consistent file:

```bash
sudo apt-get install -y sqlite3
sudo mkdir -p /backup && sudo chown adspilot:adspilot /backup
sudo -u adspilot -H sqlite3 /opt/adspilot/data/adspilot.db \
  ".backup '/backup/adspilot-$(date +%F).db'"
```

Store `ADSPILOT_MASTER_KEY` somewhere other than the backups.

## 9. Docker alternative

```bash
docker build -t adspilot .
grep -v '^ADSPILOT_DB=' .env > .env.docker      # let the image own the DB path
docker run -d --name adspilot -p 127.0.0.1:8787:8787 \
  --env-file .env.docker -v adspilot-data:/data --restart unless-stopped adspilot
```

> **Don't reuse the VPS `.env` as-is.** It sets `ADSPILOT_DB=/opt/adspilot/data/...`,
> which overrides the image's `/data/adspilot.db`. That path doesn't exist in the
> container, the process dies at startup, and `--restart` turns it into a loop.

> With a bind mount (`-v /host/dir:/data`) ownership is not copied from the image; run
> `sudo chown -R 1000:1000 /host/dir` first, since the container runs as `node`.
