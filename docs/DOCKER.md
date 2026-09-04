<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Running Aegis with Docker

One command brings up the **hosted (HTTP) mode** — the multi-user MCP server from
`src/http.ts`. The stdio mode (`dist/index.js`) needs no container: it runs wherever
your MCP client runs.

## Quick start (compose)

```bash
cp .env.example .env        # fill in the four required values below
docker compose up --build
curl http://localhost:8787/health          # -> {"ok":true,"sessions":0}
```

Then open <http://localhost:8787/connect> to link a Google Ads account.

## Plain Docker

```bash
docker build -t aegis .
docker run -d --name aegis -p 127.0.0.1:8787:8787 \
  --env-file .env -e PORT=8787 -e AEGIS_DB=/data/aegis.db \
  -v aegis-data:/data --restart unless-stopped aegis
```

The two `-e` flags mirror what `docker-compose.yml` does: they pin the in-container
port to the mapped one and keep the database on the volume even if `.env` sets
`PORT`/`AEGIS_DB` to something else (or to an empty string).

The `127.0.0.1:` prefix on the published port is not decoration. This server speaks
plain HTTP; TLS belongs to the nginx/Caddy in front of it. Without the prefix Docker
binds `0.0.0.0`, so an unencrypted `:8787` sits next to your `:443` and the reverse
proxy becomes optional *for an attacker*: `/connect` and `/settings` answer over plain
HTTP, and `/mcp` only asks for a matching `Host` header. API keys and OAuth codes would
then travel in the clear. Keep the publish on loopback and expose the service through
the TLS terminator — see `deploy/README.md`. If you deliberately need a non-loopback
bind (a private network with no proxy in front), the server refuses to start on a
plaintext public URL unless you acknowledge that with `AEGIS_ALLOW_PLAINTEXT=1`.

## Environment variables

Set these in `.env` (never baked into the image — `.dockerignore` excludes it).

| Variable | Required | Notes |
|---|---|---|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | yes | From the Google Ads MCC API Center. |
| `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` | yes | OAuth **Web application** client for hosted mode. |
| `AEGIS_MASTER_KEY` | yes | Encrypts stored refresh tokens. Either **exactly 64 hex characters** (what the generator below prints) or a **non-hex passphrase of 32+ characters** — a hex-only value of any *other* length (e.g. the 32 hex characters of `openssl rand -hex 16`) is refused at startup rather than silently stretched into a different key. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Unrecoverable if lost. Upgrading an install that already runs a hex-but-not-64 key: read the upgrade note in `deploy/README.md` **before** pulling. |
| `AEGIS_PUBLIC_URL` | recommended | Externally visible URL; Host/Origin validation and OAuth redirects derive from it. Compose defaults it to `http://localhost:8787`. |
| `PORT` | no | Image default **8787**. Compose pins it — change the *left* side of the port mapping instead. |
| `AEGIS_DB` | no | Image default `/data/aegis.db` (persistent volume). Don't point it elsewhere. |
| `AEGIS_ALLOWED_HOSTS` | behind a proxy | Comma-separated extra Host names (DNS-rebinding protection). |
| `AEGIS_SOURCE_URL` | if you forked | AGPL §13: must point at the source of the version you actually run. |
| `AEGIS_NAC_TOKEN` / `AEGIS_APPROVER_PHONE` | optional | Real network-verified approvals (Nokia Network-as-Code / CAMARA SIM Swap). |
| `AEGIS_NAC_SIMULATE` | demo only | `temiz` or `degisti`; simulates SIM-swap without a NaC token. Every output is explicitly labeled "SİMÜLASYON". `AEGIS_APPROVER_PHONE` is still required. |

The server **fails fast**: missing required values stop the container at startup with
a message listing exactly what's missing — check `docker compose logs aegis`.

## Demo mode for judges (no Google/NaC credentials needed to boot)

Uncomment the two `AEGIS_NAC_SIMULATE` lines in `docker-compose.yml` (or export the
variables) to demo the SIM-swap trust gate without a Network-as-Code token. Google Ads
credentials are still validated at startup; placeholder values boot the server, but
real API calls of course require real credentials.

## Health check

- `GET /health` returns `{"ok":true,"sessions":N}`.
- The image ships a `HEALTHCHECK`; `docker ps` shows `(healthy)` after ~10 s, and
  `docker inspect --format '{{json .State.Health}}' <container>` has the history.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Container exits immediately, restart loop | Required env missing/invalid — the startup log lists the keys. |
| Every `/mcp` request returns 403 | `AEGIS_PUBLIC_URL` (or `AEGIS_ALLOWED_HOSTS`) doesn't match the Host the client uses — e.g. URL says `:8787` but you mapped `:9000`. Behind nginx, keep `proxy_set_header Host $host;`. |
| `404 session_not_found` loops | More than one replica running. Sessions live in process memory — run exactly one. |
| Database resets on restart | `AEGIS_DB` was overridden off the `/data` volume, or the volume was removed. Keep the default. |
| Env value silently wrong | Never put a `#` comment on the same line as a value in `.env` — it becomes part of the value. |

Users' encrypted refresh tokens live in the `/data` volume (`.db` + `.db-wal` +
`.db-shm` — back up all three together, and store `AEGIS_MASTER_KEY` separately).
For a full VPS deployment (TLS, nginx, systemd) see [`deploy/README.md`](../deploy/README.md).
