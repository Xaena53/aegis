<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Aegis Demo Runbook — Network-Verified Trust for AI Agents That Spend Money

This is the jury-facing runbook for the AdsPilot demo of **Aegis**: a trust gate that
consults the mobile network (GSMA Open Gateway / CAMARA SIM Swap, via the Nokia
Network-as-Code platform) **before** an AI agent is allowed to increase real ad spend.

> **Language note.** The product's runtime messages (refusals, approval prompts, evidence
> lines) are intentionally in Turkish — the pilot market. Every quoted output below comes
> with an English translation, and a short glossary is at the end of this document.

---

## 1. The 60-Second Narration

Read as-is while the demo terminal is on screen. Timings are indicative.

> **[0:00–0:12]** "AI agents can now run ad campaigns end to end. That's the promise —
> and the problem. An agent that can *spend money* is a new attack surface: a stolen
> session can click 'approve' just as convincingly as the real owner."
>
> **[0:12–0:25]** "Approval prompts prove that *someone* clicked. They cannot prove it
> was the *account owner*. But the mobile network holds evidence no app layer can fake:
> the operator knows whether the owner's SIM card was swapped recently — the signature
> move of account-takeover fraud."
>
> **[0:25–0:40]** "Aegis puts that network signal in front of every spend-increasing
> action. Watch: the agent asks to raise a live campaign's daily budget. Before any
> human is prompted, the server asks the network: was the approver's SIM swapped
> recently? Today's run asks over a simulated network channel — every line on screen
> is labeled SİMÜLASYON — but with a real NaC token this very same gate queries the
> live CAMARA SIM Swap API. Clean signal? The human gets the prompt, with the network
> evidence printed inside it."
>
> **[0:40–0:52]** "Now the attack case: same agent, same budget raise — but the
> approver's SIM was swapped. The action is refused *outright* — the approval prompt is
> never even shown, because the person who would answer it may be the attacker. The
> agent's own `confirm=true` is ignored on every path."
>
> **[0:52–0:60]** "And the gate fails closed: no answer from the network means no spend.
> That's Aegis — the network as the trust anchor for agentic spending."

---

## 2. What You Will See

One command plays two acts against the **real** server binary — a fresh server process
per act, each given its own simulation value by the script, so you never flip `.env`
between scenes. Both acts attempt the same spend-increasing action: a small **budget
raise** (current daily budget **+1**). A budget increase is a **medium**-risk action,
so the SIM-swap lookback is capped at **24 h**.

| # | Act | Gate behavior |
|---|-----|---------------|
| 1 | Budget raise with a **clean** network signal (`temiz`) | SIM-swap check passes → the human approval prompt appears **with the network evidence line inside it**. In the default **dry run** the script stops right before the write call and prints an explicitly labeled prediction of the prompt instead; with `--canli` the prompt is real and a human must type exactly `Evet` at the keyboard — any other answer is an honored decline, not an error. On approval the +1 is applied, then immediately reverted (decreases need no approval) |
| 2 | The same budget raise with a **swapped** SIM (`degisti`) | **HARD REFUSAL before any prompt** — the human is never asked, the agent's `confirm=true` is ignored, nothing is written. The script *verifies* this: it counts elicitations and aborts with an error if a prompt is ever shown. Safe even in dry mode, because the gate refuses before any write |

> **Where did the go-live scene go?** The same gate guards go-live and edits to a
> serving campaign (**high** tier, 72 h window by default); today's script demonstrates
> the budget-raise path (**medium**, 24 h). The scripted demo does not create a campaign
> either — it reads an existing one via read-only GAQL and attempts the raise.
> PAUSED-at-creation remains a server-side invariant of `create_search_campaign`,
> enforced in the test suite; it is just not played on stage by this script.

---

## 3. Setup

### 3.1 Prerequisites

```bash
node --version    # >= 22.13.0
npm install
npm run build
```

Google Ads API credentials go into `.env` (copy from `.env.example`). The refresh token
is produced interactively:

```bash
npm run auth
```

Prefer containers? The image build, data volume, and healthcheck are documented in
[`docs/DOCKER.md`](DOCKER.md).

### 3.2 Two ways to run the network gate

| | **Real NaC mode** | **Simulation demo mode** |
|---|---|---|
| What talks to the network | Nokia Network-as-Code SDK → live CAMARA SIM Swap API | **Nothing.** The real SDK is never even imported |
| `ADSPILOT_NAC_TOKEN` | **Required** — register at https://networkascode.nokia.io (free tier) | Not needed |
| `ADSPILOT_NAC_SIMULATE` | Unset | `temiz` ("clean" — no swap) or `degisti` ("swapped") |
| `ADSPILOT_APPROVER_PHONE` | **Required** (E.164, e.g. `+9055…`) — missing = fail-closed refusal | **Still required** — the masking and refusal paths mirror the real flow exactly |
| `ADSPILOT_SIMSWAP_WINDOW_HOURS` | High-risk lookback window, default 72, clamped to CAMARA's 1–2400 | Same — window math is shared code with the real flow |
| On-screen honesty | Evidence line cites "GSMA Open Gateway" | **Every** line of output — evidence, refusal, stderr — carries an explicit **"SİMÜLASYON"** ("SIMULATION") marker |

> **⚠ Honesty guarantee — please hold us to it.** Simulation mode exists so the demo
> runs without a NaC token. It **loudly labels itself**: every string it produces states
> "SİMÜLASYON" and says a real network query was **not** performed. We will never present
> simulated output as a real network verification, and the code makes that hard to do by
> accident — if both the real token and the simulation flag are set, the configuration is
> treated as contradictory and every spend increase is **refused** (a leftover demo env
> value can never silently turn real verification into theater). An unrecognized
> simulation value doesn't "default to something" either: it is refused at decision time
> (fail closed), exactly like every other misconfiguration.

### 3.3 Risk tiers (both modes)

- **medium** (budget increases): lookback capped at **24 h** (the tighter of 24 h and the configured window)
- **high** (go-live, changes to an already-serving campaign): configured window, **72 h** by default

### 3.4 Demo environment

The scripted demo needs **no** `.env` additions for the gate: `scripts/demo-senaryo.mjs`
sets `ADSPILOT_NAC_SIMULATE` itself per act (`temiz` for Act 1, `degisti` for Act 2 —
each act gets its own server process) and passes a fixed demo approver number
(`+905550001122`) through the spawn environment. You never flip values between scenes.

Set these only when driving the server *outside* the script (e.g. from a desktop MCP
client):

```bash
# Simulation without the demo script (no NaC token needed):
ADSPILOT_APPROVER_PHONE=+905551112233
ADSPILOT_NAC_SIMULATE=temiz        # or "degisti" for the attack scene
ADSPILOT_SIMSWAP_WINDOW_HOURS=72   # optional; also forwarded to the demo script if set
```

---

## 4. Step-by-Step Scenario

The scripted demo driver is `scripts/demo-senaryo.mjs`:

```bash
npm run demo -- --musteri <customer-id> [--kampanya <campaign-id>] [--canli]
```

- `--musteri` is **required** — a bare `npm run demo` exits with a usage message.
- `--kampanya` is optional; without it the script auto-picks a campaign (it prefers a
  PAUSED one with the smallest budget — the least risky candidate).
- The default mode is **DRY** (`kuru`): no write tool is ever called. `--canli`
  performs a real +1 budget raise and reverts it right after approval.

It speaks real MCP over stdio to the real server binary — the same protocol path a
desktop assistant uses — and pauses at each beat so you can narrate. Both acts run in
that one command; you never touch `.env` between them. (For a fully AI-driven variant
where Claude decides the tool calls itself, see `npm run agent`, section 5.3.)

### Act 1 — Budget raise on a clean signal (`ADSPILOT_NAC_SIMULATE=temiz`, set by the script)

The script reads the campaign and its current daily budget via `run_gaql` (read-only),
then attempts `update_campaign_budget` to current **+1**. A budget increase is a
**medium**-risk action, so the network gate runs *first*, with the 24 h lookback.

**Dry run (default):** the script stops immediately before the write call and prints
`[kuru] araç çağrısı atlandı` ("dry — tool call skipped"), followed by an explicitly
labeled *prediction* of what the `--canli` prompt would contain. No approval prompt
appears, because the tool is never invoked.

**`--canli` rehearsal:** the real approval prompt appears with the network evidence
appended:

```
Ağ doğrulaması [SİMÜLASYON]: SIM değişimi yok (son 24 saat, +905*******22) —
simüle kanal (ADSPILOT_NAC_SIMULATE=temiz), gerçek ağ sorgusu YAPILMADI
```

*Translation:* "Network verification [SIMULATION]: no SIM swap (last 24 h, +905\*\*\*\*\*\*\*22) —
simulated channel, no real network query was performed."

The decision is then made by a **human at the keyboard**, not by the script. It asks:

```
Operatör kararı — bütçe artışını onaylıyor musun? (yalnız 'Evet' kabul edilir):
```

*Translation:* "Operator decision — do you approve the budget raise? (only 'Evet' is
accepted)". Only the exact answer `Evet` ("Yes") accepts; anything else declines the
prompt — the server then writes nothing and the demo continues without error (a human
"no" is a legitimate outcome, not a failure). On approval the +1 is applied and
immediately reverted (decreases require no approval).

Note two details:

- The approver number is **masked** everywhere — prompts never leak it in full.
- In real NaC mode this same line reads `… — GSMA Open Gateway` with no simulation marker.

### Act 2 — The attack scene: HARD REFUSAL (`ADSPILOT_NAC_SIMULATE=degisti`, set by the script)

No env flipping: the script starts a **second server process** with the swapped-SIM
simulation value and repeats the exact same +1 budget raise. Expected output:

```
Reddedildi [SİMÜLASYON]: AĞ DOĞRULAMASI BAŞARISIZ (SİMÜLE) — onaylayıcının
(+905*******22) SIM kartı son 24 saat içinde değişmiş SAYILDI …
onay istemi hiç gösterilmedi ve harcama artışı uygulanmaz.
```

*Translation:* "Refused [SIMULATION]: NETWORK VERIFICATION FAILED (SIMULATED) — the
approver's SIM card is deemed to have been swapped within the last 24 h … the approval
prompt was never shown and the spend increase will not be applied."

This act is safe even in dry mode: the gate refuses **before** any write. And the
script does not merely display the refusal — it *verifies* it, exiting with an error if
the refusal doesn't arrive or if the approval prompt is shown even once. The run ends
with a side-by-side summary table of the two acts: same agent, same request, same
server code — the only difference is the network's answer.

*Point out to the jury — this is the heart of Aegis:*

1. **No prompt ever appeared.** The script counts elicitations and asserts the count is
   zero. The person who would answer the prompt may be the attacker who swapped the
   SIM, so asking is itself the vulnerability.
2. **`confirm=true` from the agent changes nothing.** The refusal fires on the strong
   (elicitation) path and the legacy (confirm-flag) path alike — a stolen session cannot
   fall back to the weak gate.
3. **Zero writes reached Google Ads.** The test suite pins all of this end to end
   (`test/networkTrust.test.ts`, part of the 325-test suite).

### Fail-closed matrix (worth showing if asked "what if it breaks?")

| Condition | Behavior |
|---|---|
| Feature unconfigured (no token, no simulation) | Pass-through, but the evidence line honestly says the gate is off |
| Token set, approver phone missing | **Refuse** (config error) |
| CAMARA API unreachable / errors | **Refuse** — if the trust anchor cannot answer, the spend does not happen. Upstream error bodies are never echoed into the refusal (they can contain the phone number); details go to stderr, number redacted even there |
| Invalid `ADSPILOT_NAC_SIMULATE` value | **Refuse** at decision time (server does not crash at startup) |
| `ADSPILOT_NAC_TOKEN` and `ADSPILOT_NAC_SIMULATE` both set | **Refuse** — contradictory configuration; ambiguity never selects the weaker channel |
| Risk-tagged action reaches the gate without its config (programming error) | **Refuse** — never fail-open by omission |

---

## 5. Troubleshooting

### 5.1 Server won't start: "Google Ads kimlik bilgileri eksik" (credentials missing)

The four required variables are `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`,
`GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`. Copy `.env.example` → `.env`,
fill them in, and generate the refresh token with `npm run auth`. If you access accounts
through an MCC (manager) account, also set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (digits only,
no dashes).

### 5.2 Refresh token expired or revoked (`invalid_grant`)

Google invalidates refresh tokens when access is revoked or the OAuth consent screen is
in testing mode past its expiry. Fix: re-run `npm run auth` and paste the new token into
`.env`. A quick end-to-end health check that performs **no mutations**:

```bash
npm run smoke
```

### 5.3 No `ANTHROPIC_API_KEY` (running without the AI agent)

Only the AI-driven variant (`npm run agent`, `scripts/demo-agent.mjs`) needs an Anthropic
key — there Claude itself decides the tool calls. The jury demo does **not** depend on
it: `npm run demo -- --musteri <customer-id>` (`scripts/demo-senaryo.mjs`) drives the
same server through the same MCP protocol with a scripted sequence, so the gates you saw
above — the network check on a spend increase and the hard refusal on a swapped SIM —
are demonstrated identically with zero LLM access.

### 5.4 "The refusal appeared but I expected the real network to be consulted"

Read the refusal text. If it says `çelişkili yapılandırma` ("contradictory
configuration"), both `ADSPILOT_NAC_TOKEN` and `ADSPILOT_NAC_SIMULATE` are set — the
gate refuses every spend increase rather than guess which channel you meant. Unset
`ADSPILOT_NAC_SIMULATE` to use the live CAMARA API (or unset the token to demo).

### 5.5 Real NaC mode stalls then refuses

The SIM Swap call is tightly bounded (10 s timeout, 1 retry) precisely so an unreachable
NaC endpoint fails closed *fast* instead of hanging an approval for minutes. A refusal
saying the check "could not be completed" (`tamamlanamadı`) means the network was
unreachable — the gate worked as designed. Retry later; operator details are on stderr.

---

## Glossary (Turkish runtime strings)

| Turkish | English |
|---|---|
| `SİMÜLASYON` | SIMULATION |
| `temiz` | clean (no SIM swap) |
| `degisti` | changed / swapped |
| `Reddedildi` | Refused |
| `AĞ DOĞRULAMASI BAŞARISIZ` | NETWORK VERIFICATION FAILED |
| `Ağ doğrulaması: kapalı` | Network verification: off |
| `çelişkili yapılandırma` | contradictory configuration (token + simulation set together) |
| `onay istemi hiç gösterilmedi` | the approval prompt was never shown |
| `harcama artışı uygulanmaz` | the spend increase will not be applied |
| `güncellendi` | updated (the budget write succeeded) |
| `[kuru] araç çağrısı atlandı` | [dry] tool call skipped |
| `Evet` | Yes (the only accepted approval answer at the operator keyboard) |
| `tamamlanamadı` | could not be completed |
