<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Changelog

Notable changes to Aegis. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries state what changed and, where it matters, *why* — a spending guard whose reasoning
is undocumented is a guard nobody dares to touch later.

## [Unreleased]

### Added

- **Network-verified spending approvals (the Aegis trust gate).** Before any
  spend-increasing action reaches a human prompt, the server consults GSMA Open Gateway /
  CAMARA APIs through the Nokia Network-as-Code platform. A recently swapped approver SIM
  is refused outright and the prompt is never shown, on the reasoning that whoever would
  answer it may be the attacker. Risk is tiered: a budget increase uses a 24 h lookback, a
  go-live widens to the configured window (72 h by default) and admits the later links.
- **A six-link trust chain**, each behind its own switch so that holding a token never
  silently enables a query nobody asked for: SIM Swap, Number Verification, device
  reachability, roaming country, device swap and unconditional call forwarding.
- **Structural decision trace and JSONL audit trail** (`AEGIS_DECISION_LOG`). Every
  risk-tagged decision — refusals *and* passes — is recorded with a separate channel field
  per link, so a real network query can never be confused with a simulated one.
- **Meta (Facebook/Instagram) as a second spend domain**, behind the same approval gate
  with the same risk tiers. Campaigns are created paused there too, and the tool exposes no
  status parameter to argue with.
- **Growth Brain** (`npm run brain`): an LLM pipeline turning a plain business goal into
  market research, a channel budget split, a campaign plan and ad creatives, then executing
  it through the same MCP tools — so every money-moving step meets the same check.
- **Cross-channel budget allocation** with two rules: available channels are read from the
  environment rather than asked of the model, and the shares must total the operator's
  number — the server's ceiling is per campaign and would not catch a split that sums over
  it.
- **Simulation channels** for every link, so the demo runs without credentials. Every
  string such a run produces is stamped `SİMÜLASYON` and states that no network query was
  made.
- **`npm run demo`** — a three-act scripted demo against the real server binary, and
  **`npm run prova`** — a stage-day preflight that measures rather than assumes.
- **Docker deployment**: a three-stage `node:22-alpine` image running as a non-root user,
  with `.env` excluded from the image, plus a compose file with a persistent volume.

### Changed

- **BREAKING — `AEGIS_MASTER_KEY` must be exactly 64 hex characters or a non-hex
  passphrase.** A hex-only value of any other length (a machine key copied one character
  short, or the 32 hex characters of `openssl rand -hex 16`) used to be stretched with
  scrypt as if it were a passphrase; it is now refused at startup. The silent fallback
  derived a key the operator never intended, so a mistyped key produced a *healthy-looking*
  process in which no stored secret could be decrypted — "unknown" was being reported as
  "clean". The value is trimmed before every use, so a trailing newline from a secret file
  no longer changes which branch runs.
  **Upgrading an install that already runs such a key:** the process will not start, and
  padding the key to 64 characters recovers nothing — the stored `refresh_token_enc` values
  were encrypted under the scrypt-derived key. There is no migration script; set a fresh
  64-hex key and have every tenant reconnect. Read the upgrade note at the top of
  `deploy/README.md` **before** pulling.

### Verified

- **First live CAMARA calls (2026-08-28).** SIM Swap, device swap and call forwarding all
  answer through the gate against Nokia's platform, each writing a `gercek` trace. A line
  the platform fails on returns 500 and the gate refuses fail-closed with the upstream body
  redacted and the number masked. The account is in Simulator mode: request, auth, routing
  and response shape are real while the subscriber is simulated.

### Fixed

- The SDK does not send `X-RapidAPI-Host`, and without it every CAMARA call returns
  `404 "API doesn't exists"` — correct base URL, correct path, valid key. All channel
  factories now set it through one helper, pinned by a test, because no unit test would
  notice its loss while production would refuse every spend.
- The decision log inferred a link's channel from refusal text, which stopped being
  possible once the chain had more than one link. Records are now built from a structural
  trace.
- Approval prompts hung forever on EOF instead of refusing, letting a run exit 0 with no
  approval given.

### Security

- Raw values never reach the agent: evidence lines carry a masked number, refusal reasons
  come from a fixed vocabulary, and upstream error text goes to stderr only. Meta echoes
  the request URL in error bodies and `access_token` is a query parameter, so those bodies
  are sanitised before they leave.
- Uncertainty fails closed in every direction — missing token, missing approver number,
  unrecognised configuration value, contradictory configuration, or an endpoint that does
  not answer within its timeout all end in refusal, never in a quiet pass.

[Unreleased]: https://github.com/Xaena53/google-ads-mcp/commits/main
