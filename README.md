<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# AdsPilot

**A Google Ads MCP server that lets an AI agent manage real campaigns — without letting it spend your money unsupervised.**

[![CI](https://github.com/Xaena53/google-ads-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Xaena53/google-ads-mcp/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-brightgreen.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-155-brightgreen.svg)](test/)
[![MCP](https://img.shields.io/badge/MCP-tools%20%C2%B7%20resources%20%C2%B7%20prompts%20%C2%B7%20elicitation-8A2BE2.svg)](https://modelcontextprotocol.io)

🇹🇷 [Türkçe README](README.tr.md)

---

Connecting an LLM to an advertising account is easy. Doing it without waking up to a
drained budget is the hard part. Most write-capable integrations solve this by asking
the agent to confirm — which means the *agent* decides whether a human was consulted.

AdsPilot moves that decision out of the agent's hands. When your MCP client supports
[elicitation](https://modelcontextprotocol.io), the server asks **you** directly through
the protocol, and the agent's own `confirm` flag is ignored entirely. Approval stops
being a story the agent tells and becomes a fact the server can verify.

## How it compares

| | Google official MCP | AdsPilot |
|---|---|---|
| **Campaign writes** | ❌ read-only by design | ✅ create, budget, keywords, ads, enable/pause |
| **Approval model** | n/a | Human asked via MCP elicitation; agent cannot fabricate consent |
| **Fail-closed guards** | n/a | Budget ceiling, paused-by-default, mandatory geo targeting, shared-budget protection |
| **Multi-tenant hosting** | ❌ self-host, single identity | ✅ per-user OAuth, encrypted tokens, session isolation |
| **Site → campaign** | ❌ | ✅ `analyze_site` turns any URL into campaign raw material |
| **License** | Apache-2.0 | AGPL-3.0 |

> This table compares Google's official server, which is deliberately read-only and
> therefore solves a different problem. Commercial alternatives (Markifact, Adzviser
> and others) do offer writes, but their internals aren't publicly auditable, so this
> table doesn't speculate about them. Verify current details yourself before choosing.

## The safety model

Every write follows the same decision path. The property worth noticing is the branch
in bold: when elicitation is available, the human's answer is binding and the agent's
`confirm` is never consulted.

```mermaid
flowchart TD
    A["Agent calls a write tool"] --> B{"Writes enabled<br/>for this account?"}
    B -- no --> R["🚫 Rejected"]
    B -- yes --> C{"Does this action<br/>increase spend?"}
    C -- "no — pause, budget cut,<br/>negative keywords" --> E["✅ Executed"]
    C -- yes --> D{"Client supports<br/>elicitation?"}
    D -- "YES" --> H["Server asks the human directly<br/>agent's confirm is ignored"]
    D -- no --> F{"confirm = true?"}
    H -- approved --> G
    H -- "declined · cancelled<br/>· timeout · error" --> R
    F -- no --> R
    F -- yes --> G{"Budget within ceiling?<br/>Campaign state verifiable?"}
    G -- no --> R
    G -- yes --> E
```

Three properties are worth calling out:

**Campaigns are born paused.** No tool in the system can create a campaign that is
already serving. Going live is always a separate, approved step.

**Uncertainty fails closed.** If the server cannot prove a campaign is paused — the
query returned nothing, the status field is missing, the type is unexpected — it asks
for approval rather than assuming safety.

**The agent cannot loosen its own limits.** Budget ceiling and write permission are
readable over MCP but writable only from a human browser session; the API key does not
open that door.

## Architecture

```mermaid
flowchart LR
    subgraph clients["MCP clients"]
        CC["Claude Code"]
        CD["Claude Desktop<br/>Cursor · others"]
    end

    subgraph server["AdsPilot server"]
        direction TB
        T["stdio · Streamable HTTP + Bearer"]
        M["MCP surface<br/>12 tools · 4 resources · 5 prompts"]
        SG["Safety gates<br/>approval · ceiling · fail-closed"]
        AC["AdsContext<br/>one per user, refreshed per request"]
    end

    DB[("SQLite<br/>refresh tokens<br/>AES-256-GCM")]
    GA["Google Ads API"]
    WEB["Any website<br/>SSRF-guarded fetch"]

    CC --> T
    CD --> T
    T --> M
    M --> SG
    SG --> AC
    AC --> GA
    AC -.credentials.-> DB
    M --> WEB
```

Two deployment shapes share the same core:

- **Local (stdio)** — one user, credentials from `.env`, zero infrastructure.
- **Hosted (HTTP)** — many users, each connecting their own Google account via OAuth.
  Refresh tokens are encrypted at rest, every MCP session is bound to exactly one user,
  and that user's settings are re-read on every request — so a limit change takes effect
  immediately, even mid-session.

## Capabilities

**Tools** — 12 total. "Approval" marks actions that can increase spend and therefore
pass through the gate above.

| Tool | Purpose | Approval |
|---|---|---|
| `list_accounts` | Accessible accounts, including MCC sub-accounts | — |
| `campaign_performance` | Cost, clicks, conversions, CTR, avg. CPC | — |
| `keyword_performance` | Performance of the keywords you added | — |
| `search_terms_report` | What people actually searched; flags wasted spend | — |
| `run_gaql` | Raw GAQL escape hatch (read-only, auto-limited) | — |
| `analyze_site` | Extracts campaign raw material from any URL | — |
| `create_search_campaign` | Budget + campaign + geo + ad group + keywords, atomically | born paused ⇒ no |
| `create_responsive_search_ad` | Adds a responsive search ad to an ad group | if campaign is live |
| `add_keywords` | Keywords or negatives at ad-group level | positives on live campaigns |
| `add_campaign_negative_keywords` | Negatives across a whole campaign | no — reduces spend |
| `update_campaign_budget` | Changes the daily budget | increases only |
| `set_campaign_status` | Enable or pause | enabling only |

**Resources** — browsable data that costs no tool call: `adspilot://accounts` ·
`adspilot://accounts/{id}/campaigns` · `adspilot://accounts/{id}/limits` (your active
guardrails) · `adspilot://gaql-sema` (field reference, so the agent stops inventing
GAQL fields).

**Prompts** — ready-made workflows that appear as slash commands: `/reklam-kur`
(site → draft campaign) · `/israf-bul` (find and cut wasted spend) · `/haftalik-rapor`
· `/kampanya-denetle` · `/guvenlik-durumu`.

> The agent-facing surface (tool descriptions, prompts, error messages) is written in
> Turkish, matching the product's initial market. The protocol, code and these docs are
> English.

## Quick start

Requires **Node ≥ 22.13** — the hosted mode uses the built-in `node:sqlite`.

```bash
git clone https://github.com/Xaena53/google-ads-mcp.git adspilot
cd adspilot
npm ci && npm run build && npm test
```

You need Google Ads API credentials: a developer token from an MCC account, a Google
Cloud project with the Ads API enabled, and an OAuth client. Copy `.env.example` to
`.env`, fill it in, then:

```bash
npm run auth                      # opens a browser, writes the refresh token to .env
claude mcp add adspilot -- node /absolute/path/to/adspilot/dist/index.js
```

Ask Claude *"list my Google Ads accounts"* to confirm the connection.

For the multi-user hosted deployment — systemd unit, nginx config, Docker image, and
the pitfalls that would otherwise cost you an afternoon — see
**[deploy/README.md](deploy/README.md)**.

## Docker

The hosted (HTTP) mode comes up with one command:

```bash
cp .env.example .env        # fill in the four required values
docker compose up --build
curl http://localhost:8787/health          # -> {"ok":true,...}
```

Image layout, the environment table, the jury demo mode (`ADSPILOT_NAC_SIMULATE`), and
troubleshooting live in **[docs/DOCKER.md](docs/DOCKER.md)**.

## From a URL to a campaign

The flagship workflow. The server extracts *facts*, the client-side model does the
creative work, and a human approves before anything serves.

```mermaid
sequenceDiagram
    participant U as You
    participant A as Agent
    participant S as AdsPilot
    participant G as Google Ads

    U->>A: /reklam-kur https://example.com
    A->>S: analyze_site(url)
    S-->>A: title, meta, headings, JSON-LD, nav<br/>(inside an untrusted-data block)
    Note over A: Agent drafts keywords and<br/>ad copy from those facts
    A->>U: Draft: budget, keywords, headlines
    U-->>A: looks good
    A->>S: create_search_campaign(...)
    S->>G: budget + campaign (PAUSED) + geo + keywords
    A->>S: create_responsive_search_ad(...)
    A->>S: set_campaign_status(ENABLED)
    S->>U: Approve going live?<br/>account · budget · geo targeting
    U-->>S: approve
    S->>G: campaign → ENABLED
```

`analyze_site` fetches arbitrary URLs, so it treats every response as hostile:
private-network and cloud-metadata addresses are blocked at both the hostname and the
resolved-IP level, every redirect hop is re-validated before the request is made,
parsing is linear-time (no catastrophic backtracking), and extracted text is returned
inside a delimited untrusted-data block with forged closing tags stripped.

## Security

The threat model, reporting process, and the five invariants this project holds itself
to live in **[SECURITY.md](SECURITY.md)**. Two of them in short:

- Uncertainty never resolves in favour of spending money.
- The agent cannot raise its own budget ceiling or re-enable writes.

Found a hole? Please report it privately through GitHub Security Advisories rather than
a public issue.

## Development

```bash
npm run build      # compile to dist/
npm run typecheck  # src + tests, with noUnusedLocals
npm test           # 155 offline tests
npm run smoke      # live checks against your real Google Ads account
```

Tests run a real MCP client/server pair over `InMemoryTransport` with an injected fake
Google Ads context, so every guard is exercised through the actual protocol without
touching a live account. The suite includes fail-closed regressions and adversarial
scenarios that try to reach a bad outcome by every known route.

### Live smoke test

An offline suite can only prove the server is correct against the API *as modelled*.
`npm run smoke` closes that gap: it launches the real stdio binary, speaks MCP exactly as
Claude Desktop does, and verifies each guarantee against Google's live servers.

| Verified | How |
|---|---|
| Server states its rules to the agent | `instructions` non-empty and carries the PAUSED rule |
| Accounts resolve | every ID is 10 digits; unreadable accounts are skipped, not guessed |
| Reports are typed | `structuredContent` matches the declared `outputSchema` |
| Multi-line GAQL loses no field | last `SELECT` field present in returned rows |
| LIMIT ceiling bites | unclamped count measured first, then proven to be cut |
| Guardrails are readable | `adspilot://accounts/{id}/limits` reports cap and write flag |
| Completion suggests real accounts | `completion/complete` returns the live account ID |
| Over-cap budget is refused | refusal **and** the live budget verified unchanged |
| Unapproved go-live is refused | refusal **and** the live status verified unchanged |

The default run performs **no mutation** — spend-related guards are verified through their
refusal path, and a refusal is only accepted as proof once the underlying value is re-read
and found unchanged. A check that cannot be proven by the account's data reports itself as
failed rather than passing quietly.

`npm run smoke -- --write` additionally creates a real campaign and asserts it comes up
`PAUSED`. It prints the new campaign ID for manual deletion: the server intentionally
exposes no delete tool, so the smoke test cannot clean up after itself.

Design decisions and internals: **[ARCHITECTURE.md](ARCHITECTURE.md)**.
Contributing: **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## License

AGPL-3.0-only. Copyright © 2026 [Xaena53](https://github.com/Xaena53).

You may use, modify and redistribute this software. **If you run a modified version as
a network service, AGPL §13 requires you to offer its source to that service's users.**
This project honours that itself: every page footer and the `/source` endpoint link to
the source, and the MCP `instructions` field carries it too. If you fork and deploy,
point `ADSPILOT_SOURCE_URL` at *your* repository — the upstream default will not
satisfy your obligation.
