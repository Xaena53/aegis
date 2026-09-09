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
  CAMARA APIs through the Nokia Network-as-Code platform. While step-up verification is off
  (`AEGIS_STEPUP=0`, the default) a recently swapped approver SIM is refused outright and the
  prompt is never shown, on the reasoning that whoever would answer it may be the attacker;
  with step-up on that refusal is no longer final — but it turns into an escalation only
  where a link that could have contradicted the signal came back clean, and with no such
  voucher the same refusal still stands (measured; see the entries below).
  Risk is tiered: a budget increase caps the lookback at 24 h, a go-live uses the configured
  window in full (72 h by default) and admits the later links.
- **A six-link trust chain**, each behind its own switch so that holding a token never
  silently enables a query nobody asked for: SIM Swap, Number Verification, device
  reachability, roaming country, device swap and unconditional call forwarding.
- **Step-up verification (`AEGIS_STEPUP`), off by default — the switch that changes what a
  refusal *means*.** It exists because of mentor feedback: legitimate SIM and handset changes
  happen every day, and a gate that answers all of them with a flat refusal leaves those
  users no way forward. With it on, a refusal reason describing an ordinary human situation
  is no longer final — it is held pending, the remaining links are asked anyway, and a chain
  that comes back clean binds the action to a prompt that leads with the degraded signal by
  name. Exactly five reasons qualify: `sim-degisti`, `cihaz-degisti`, `cihaz-erisilemez`,
  `konum-beklenmedik`, `ag-yanitsiz`. It ships off because an escalation is a *loosening*,
  and a loosening has to be chosen by the operator rather than inherited from a token.
- **Call forwarding never escalates — active or silent — and neither does a configuration
  fault.** Every reason outside those five still refuses flatly, and three of the exclusions
  are reasoned rather than accidental. Active unconditional forwarding is the
  counter-intuitive one: an escalation reaches a person over a call or a message, which is
  the exact channel the attacker has taken, so escalating there would hand them the stronger
  check. A number-verification mismatch is not an "unreadable" but a direct statement that
  the line is not the expected number. And a contradictory or incomplete configuration is the
  *operator's* situation, not the user's — stronger identity verification does not repair it.
- **The vouching rule: a link may only vouch for a signal it could have contradicted.** An
  escalation used to require merely that "some real link came back clean", a condition that
  never asked what the link had measured — so reachability alone could carry a genuine SIM
  change through the gate. Reachability is a liveness signal, not an identity one: the
  attacker's handset answers the network just as well. It therefore vouches for nothing, and
  neither does the simulation-only Number Verification link. Which links can corroborate
  which signal is now one visible table, and `ag-yanitsiz` — the single reason that does not
  name the link that produced it — is read from a per-link table *derived* from that one, so
  a silent call-forwarding check has an empty voucher set and refuses. The unknown is never
  treated more leniently than the known.
- **A voucher must also have observed something.** The location link comes back clean when
  the network reports no country at all; such a link has verified nothing it could hold
  against the degraded signal, so it is excluded from the voucher set. Measured before the
  rule existed: a real `swapped:true` passed the gate vouched for by a location link that had
  never established which country the line was in. Simulation channels are excluded for the
  same reason — in demo mode a single environment value must not paper over a real SIM
  change.
- **An escalation is a stronger consent, not a quieter pass.** The prompt's header names the
  degraded signal and the question itself changes — consent is given *to that signal*, not to
  an ordinary spend. On a client that cannot show a prompt at all the escalation refuses
  outright, because the agent's `confirm=true` is the side of the trade the server receives,
  not the side it gives. No spending ceiling is lowered in return; the compensating control
  is the prompt. The audit trail records the escalation as its own outcome
  (`"karar":"kademeli"`, never folded into `gecti`) along with the links that vouched.
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
  the platform fails on returns 500 and, at the default `AEGIS_STEPUP=0`, the gate refuses
  fail-closed with the upstream body redacted and the number masked; with step-up on that
  same silence becomes *eligible* for escalation rather than final — measured against a
  chain where no other link answered it still ends in a refusal, because eligibility is not
  a voucher. The account is in Simulator mode: request, auth, routing and response shape
  are real while the subscriber is simulated.

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
- Uncertainty fails closed in every direction — a missing approver number, an unrecognised
  configuration value, contradictory configuration, or an endpoint that does not answer
  within its timeout all end in refusal, never in a quiet pass. Two precisions the sentence
  used to blur. An *unconfigured* gate is not uncertainty: with no `AEGIS_NAC_TOKEN` the link
  is deliberately off and says so on its own evidence line rather than refusing. And with
  step-up on (`AEGIS_STEPUP=1`) a silent endpoint is escalated rather than refused — but only
  where a link that can actually answer the silent link's question came back clean over a
  real channel, which is why a silent call-forwarding check still refuses.

[Unreleased]: https://github.com/Xaena53/aegis/commits/main
