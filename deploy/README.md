<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Deploying the hosted service

This guide covers running Aegis as a multi-user service on a Linux VPS. The order of
steps matters — several of them fail in confusing ways if you skip ahead.

The files in this directory (`aegis.service`, `nginx.conf.example`, and the
`Dockerfile` at the repository root) carry the same warnings inline, so you'll see them
even if you don't read this page.

## Upgrading an existing install — read this before `git pull`

> **Breaking change: a hex-only `AEGIS_MASTER_KEY` whose length is not exactly 64 no
> longer starts.** Earlier versions silently stretched such a value with scrypt, exactly as
> if it were a passphrase. It is now refused at startup, because "a machine key copied one
> character short" and "a passphrase" are indistinguishable to the code and guessing wrong
> means every stored secret is encrypted under a key the operator never intended.

This matters *only* if the key you run today is all hex digits and is not 64 characters long
(a 32-character `openssl rand -hex 16` is the common case). Check on the running host,
before you upgrade:

```bash
sudo -u aegis node -e '
const line = require("fs").readFileSync("/opt/aegis/.env", "utf8")
  .split(/\r?\n/).map((l) => l.trim())
  .find((l) => l.startsWith("AEGIS_MASTER_KEY="));
const k = (line ? line.slice("AEGIS_MASTER_KEY=".length) : "").trim();
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
2. Upgrade, then put a fresh `AEGIS_MASTER_KEY=<64 hex characters>` in `.env`.
3. Expect the service **not to start yet**. The startup gate reads *every* row in `users`
   and refuses while any one of them is undecryptable, so the rows written under the old key
   hold the whole process down — and `Restart=on-failure` in `aegis.service` makes that a
   five-second crash loop, not a stop. There is no `/connect` to reconnect through until
   those rows are gone, and the code has no in-process way to delete a user.
4. **Stop the service, then** repair **offline**. Step 3 left a crash loop, not a stopped
   service, so without an explicit stop nothing about this repair is offline: a fresh process
   opens this same database every five seconds, reads every row in `users`, and exits. That
   process is not always a passive reader either — on an install whose schema predates the
   `google_sub` column, its constructor runs `ALTER TABLE users ADD COLUMN google_sub`
   *before* it ever reaches the key check. SQLite's `.backup` stays internally consistent
   even under that load — section 8 relies on exactly that — but which moment it captures is
   then the restart loop's choice rather than yours, and the `DELETE` lands in a database the
   next process reopens five seconds later. `systemctl stop` also ends the loop for good
   (`Restart=on-failure` does not fire after an explicit stop), which is what makes step 5 a
   real start instead of an order aimed at a unit systemd is already restarting on its own.

   The refusal prints the `sqlite3` commands themselves, with your real path and the exact
   row ids, plus the whole census (`Açılamayan kayıt: 2/4 — #2, #4`) so that one pass clears
   every broken row instead of one restart per row. It cannot print the stop: nothing inside
   the process knows how it is supervised.

   ```bash
   sudo systemctl stop aegis                # Docker: docker stop aegis
   sudo apt-get install -y sqlite3
   journalctl -u aegis -n 40 --no-pager     # read the census and the "Kurtarma" lines
   DB=/opt/aegis/data/aegis.db
   sudo -u aegis -H sqlite3 "$DB" ".backup '$DB.kurtarma-yedegi'"
   sudo -u aegis -H sqlite3 "$DB" "DELETE FROM users WHERE id IN (<only the ids the refusal listed>);"
   ```

   Back up first, and delete **only** the ids the refusal named — a row that still decrypts
   must be left alone.
5. Start the service again (`sudo systemctl start aegis`, or `docker start aegis`), then have
   every deleted tenant reconnect through `/connect`, which writes their row again under the
   new key. Their old API key stops working.

Tell your tenants before the restart, not after. Nothing else in this guide changes for an
upgrade — sections 1 and 4 below are one-time setup, and `npm ci && npm run build &&
systemctl restart aegis` is the rest of it.

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
sudo useradd --system --home /opt/aegis --shell /usr/sbin/nologin aegis
sudo mkdir -p /opt/aegis && sudo chown aegis:aegis /opt/aegis
```

The `data` directory is created *after* the clone — `git clone` refuses a non-empty
target.

## 2. Code

```bash
sudo -u aegis -H git clone <repo-url> /opt/aegis
cd /opt/aegis
sudo -u aegis -H mkdir -p data
sudo -u aegis -H npm ci
sudo -u aegis -H npm run build
```

`-H` matters: without it `sudo` keeps the caller's `HOME` and npm tries to write to
`/root/.npm`.

## 3. Configuration

```bash
sudo -u aegis cp .env.example .env
sudo -u aegis node -e "console.log('AEGIS_MASTER_KEY='+require('crypto').randomBytes(32).toString('hex'))"
sudo nano /opt/aegis/.env
sudo chmod 600 /opt/aegis/.env
```

Required values:

```ini
GOOGLE_ADS_DEVELOPER_TOKEN=...
GOOGLE_ADS_CLIENT_ID=...
GOOGLE_ADS_CLIENT_SECRET=...
AEGIS_MASTER_KEY=<64 hex characters>
AEGIS_DB=/opt/aegis/data/aegis.db
AEGIS_PUBLIC_URL=https://aegis.example.com
AEGIS_ALLOWED_HOSTS=aegis.example.com
AEGIS_SOURCE_URL=https://github.com/YOUR-ACCOUNT/YOUR-FORK
PORT=8787
```

The network gate — the CAMARA/GSMA Open Gateway check that runs **before** any human
approval prompt for a spending action — is configured by two more values:

```ini
AEGIS_NAC_TOKEN=<Nokia Network-as-Code API key>
AEGIS_APPROVER_PHONE=+90XXXXXXXXXX
```

> **Without `AEGIS_NAC_TOKEN` the network gate is not degraded — it is OFF.** No CAMARA
> query is made, no warning is printed, `/health` still answers `{"ok":true}`, and every
> spend approval goes straight to the human prompt carrying the evidence line
> `Ağ doğrulaması: kapalı (AEGIS_NAC_TOKEN tanımlı değil)` and the audit trace
> `simSwap: "kapali"`. A deployment that follows every other step on this page and skips
> this one runs the product's headline control **zero times**, and nothing about the running
> service says so. Register at <https://networkascode.nokia.io> (free tier) — or leave it
> out deliberately, knowing exactly what is switched off.

> **Set both, or neither.** A token with an empty `AEGIS_APPROVER_PHONE` fails closed the
> other way: spend increases are refused at decision time (`Reddedildi: ağ doğrulaması
> yapılandırması eksik`) while the server still starts, so you find out at the first
> approval rather than at boot. A token switches on the SIM-Swap link **only** — the other
> links (`AEGIS_REACH_CHECK`, `AEGIS_DEVICESWAP_CHECK`, `AEGIS_CALLFWD_CHECK`) and step-up
> (`AEGIS_STEPUP`) are opt-in and documented in `.env.example` and `docs/CAMARA.md`.

> **Never put a comment on the same line as a value.** This file is also read by systemd
> (`EnvironmentFile`) and Docker (`--env-file`), and both treat `#` as a comment only at
> the start of a line. `AEGIS_ALLOWED_HOSTS=example.com   # required` becomes a host
> named `example.com   # required`, nothing matches, and **all MCP traffic returns 403**
> — a failure that is genuinely hard to diagnose.
> Verify with: `systemctl show aegis -p Environment`

> **`AEGIS_MASTER_KEY` is either exactly 64 hex characters or a non-hex passphrase.**
> The value is trimmed before use (a trailing newline from a secret file is harmless), and
> a hex-only value whose length is not 64 is **refused at startup** rather than silently
> treated as a passphrase — that silent fallback derived a different key, so nothing in the
> database could be decrypted while the process still reported itself healthy. Passphrases
> are stretched with scrypt; the minimum length (32 characters) is enforced on the trimmed
> value, so padding with spaces does not get past it.

> **`AEGIS_MASTER_KEY` is unrecoverable.** Lose it and every stored refresh token
> becomes undecryptable. Back it up separately from the database — if both are stolen
> together, the encryption bought you nothing.

> **`AEGIS_DB` must be an absolute path.** Left empty, the file is looked up relative
> to the working directory, which `ProtectSystem=strict` makes read-only; the service
> then crash-loops every five seconds.

> **`AEGIS_DECISION_LOG` only works under a writable path.** The unit runs with
> `ProtectSystem=strict`, so the filesystem is read-only apart from `ReadWritePaths=`
> (`/opt/aegis/data`) and `LogsDirectory=` (`/var/log/aegis`, which systemd creates
> and chowns for you). Point the log anywhere else and every risk-tagged decision hits the
> sandbox — and *nothing breaks*: the decision log is deliberately an observation, never a
> gate, so a write failure prints one stderr line and the approval flow continues. The file
> simply stays empty, and you find out the month someone asks how many spend increases were
> refused. The value below is inside the writable set:
>
> ```ini
> AEGIS_DECISION_LOG=/var/log/aegis/kararlar.jsonl
> ```
>
> Verify after the first refusal with: `sudo -u aegis tail /var/log/aegis/kararlar.jsonl`

> **`AEGIS_SOURCE_URL` must point at your own repository** if you modified the code.
> AGPL §13 requires offering *your* version's source to your users; the upstream default
> does not satisfy that.

The server refuses to start on missing or invalid configuration, so a broken deployment
fails loudly instead of reporting itself healthy — **with one exception: the network gate.**
Leave `AEGIS_NAC_TOKEN` out and the process starts, `/health` reports `{"ok":true}`, and no
CAMARA query is ever made. Absence is a legitimate choice there, so it is not treated as a
fault; that is exactly why it has to be a decision you took on purpose.

## 4. Google Cloud OAuth

> **Create a "Web application" client, not a "Desktop app" client.** Desktop clients
> cannot have their redirect URIs edited — they only accept loopback — so the hosted
> flow can never complete and `/connect` ends in `redirect_uri_mismatch`. Desktop is the
> right type for local stdio use (`npm run auth`); these should be **two separate
> clients**.

Add this exact authorised redirect URI:

```
https://aegis.example.com/oauth/callback
```

> **The seven-day trap.** `adwords` is one of Google's *sensitive* scopes. While your
> consent screen is in "Testing" mode, Google **expires refresh tokens after seven
> days** and caps you at 100 test users — hosted users would silently lose their
> connection every week with `invalid_grant`. Move the consent screen to production and
> complete verification before onboarding anyone. Treat this as a prerequisite of the
> same weight as Basic Access.

## 5. Service

```bash
sudo cp deploy/aegis.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now aegis
sudo systemctl status aegis
journalctl -u aegis -f
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
sudo certbot certonly --webroot -w /var/www/html -d aegis.example.com

# 2. Now the config can load
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/aegis
sudo nano /etc/nginx/sites-available/aegis        # set your domain
sudo ln -s /etc/nginx/sites-available/aegis /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> **Do not remove `proxy_set_header Host $host;`.** Without it the upstream sees
> `Host: 127.0.0.1`, the DNS-rebinding protection finds no match, and **every MCP
> request returns 403**. It presents as "nothing works at all" with no useful error.

## 7. Verify

```bash
curl -s https://aegis.example.com/health                    # {"ok":true,...}
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST https://aegis.example.com/mcp                     # expect 401
```

Then open `https://aegis.example.com/connect` in a browser, connect with Google, copy
the API key you're shown once, and register it:

```bash
claude mcp add --transport http aegis https://aegis.example.com/mcp \
  --header "Authorization: Bearer ap_..."
```

## 8. Backups

In WAL mode, copying the `.db` file while the service runs produces a corrupt backup —
recent writes may still live in `.db-wal`. Use SQLite's `.backup`, which writes one
consistent file:

```bash
sudo apt-get install -y sqlite3
sudo mkdir -p /backup && sudo chown aegis:aegis /backup
sudo -u aegis -H sqlite3 /opt/aegis/data/aegis.db \
  ".backup '/backup/aegis-$(date +%F).db'"
```

Store `AEGIS_MASTER_KEY` somewhere other than the backups.

## 9. Docker alternative

```bash
docker build -t aegis .
grep -v '^AEGIS_DB=' .env > .env.docker      # let the image own the DB path
docker run -d --name aegis -p 127.0.0.1:8787:8787 \
  --env-file .env.docker -v aegis-data:/data --restart unless-stopped aegis
```

> **Don't reuse the VPS `.env` as-is.** It sets `AEGIS_DB=/opt/aegis/data/...`,
> which overrides the image's `/data/aegis.db`. That path doesn't exist in the
> container, the process dies at startup, and `--restart` turns it into a loop.

> With a bind mount (`-v /host/dir:/data`) ownership is not copied from the image; run
> `sudo chown -R 1000:1000 /host/dir` first, since the container runs as `node`.
