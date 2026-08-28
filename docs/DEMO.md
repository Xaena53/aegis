<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Aegis Demo Runbook — Network-Verified Trust for AI Agents That Spend Money

This is the jury-facing runbook for the AdsPilot demo of **Aegis**: a trust gate that
consults the mobile network (GSMA Open Gateway / CAMARA, via the Nokia Network-as-Code
platform) **before** an AI agent is allowed to increase real ad spend.

> **Language note.** The product's runtime messages (refusals, approval prompts, evidence
> lines) are intentionally in Turkish — the pilot market. Every quoted output below comes
> with an English translation, and a short glossary is at the end of this document.

---

## 1. The 75-Second Narration

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
> **[0:52–1:07]** "Act three raises the stakes: taking a campaign **live**. Same gate,
> higher tier — the lookback widens from 24 hours to 72, and a second link of the chain
> can run: Number Verification, asking whether the approval is even coming from the
> owner's own device. Clean, the go-live is approved and immediately reverted. Swapped
> SIM, and the same hard refusal lands on go-live too."
>
> **[1:07–1:15]** "And the gate fails closed: no answer from the network means no spend.
> Every one of those decisions is appended to a JSONL audit log — masked number, fixed
> refusal code, no secrets. That's Aegis — the network as the trust anchor for agentic
> spending."

---

## 2. What You Will See

One command plays **three acts** against the **real** server binary — a fresh server
process per act (four in total, because act 3 has two sub-scenes), each given its own
simulation value by the script, so you never flip `.env` between scenes.

Acts 1 and 2 attempt the same spend-increasing action: a small **budget raise** (current
daily budget **+1**). A budget increase is a **medium**-risk action, so the SIM-swap
lookback is capped at **24 h**. Act 3 attempts a **go-live** (`set_campaign_status` →
`ENABLED`), which is **high**-risk: the lookback is the configured window (**72 h** by
default) and the second chain link may run.

| # | Act | Gate behavior |
|---|-----|---------------|
| 1 | Budget raise with a **clean** network signal (`temiz`) | SIM-swap check passes → the human approval prompt appears **with the network evidence line inside it**. In the default **dry run** the script stops right before the write call and prints an explicitly labeled prediction of the prompt instead; with `--canli` the prompt is real and a human must type exactly `Evet` at the keyboard — any other answer is an honored decline, not an error. On approval the +1 is applied, then immediately reverted (decreases need no approval) |
| 2 | The same budget raise with a **swapped** SIM (`degisti`) | **HARD REFUSAL before any prompt** — the human is never asked, the agent's `confirm=true` is ignored, nothing is written. The script *verifies* this: it counts elicitations and aborts with an error if a prompt is ever shown. Safe even in dry mode, because the gate refuses before any write |
| 3/A | **Go-live** with a clean signal (`temiz`) — the **high** tier | Same gate, wider window: the evidence line now says **72 h** (or your configured window), not 24. With `ADSPILOT_NV_SIMULATE` set, the prompt carries a **second** evidence line from the Number Verification link, and the script highlights it as `zincir 2 ▶` ("chain 2"). In `--canli` the campaign really goes `ENABLED` and is put back to `PAUSED` the moment the scene ends — **verified by reading the status back from the account**, not by trusting the tool's reply |
| 3/B | The same go-live with a **swapped** SIM (`degisti`) | The identical hard refusal, this time on the high tier: zero elicitations, and the refusal text carries the 72 h window instead of 24. After the refusal the script **reads the campaign status back** and aborts with a security error if it is `ENABLED` |

Three things about act 3 that are worth saying out loud on stage:

- **It can honestly skip itself.** Two server-side gates answer *before* the network gate
  on a go-live: the campaign's daily budget must be under the account's safety ceiling
  (read from the read-only `adspilot://accounts/<id>/limits` resource), and the campaign
  must have a servable ad (an `ENABLED` ad inside an `ENABLED` ad group). The script
  checks both with read-only queries *first*; if no candidate qualifies it prints
  `PERDE 3 ATLANDI — uydurma kanıt üretilmez` ("Act 3 skipped — no fabricated evidence")
  and says why. It will not stage a scene whose evidence line it cannot honestly produce.
- **The live rehearsal only touches a PAUSED campaign.** If the candidate is already
  `ENABLED`, `--canli` is skipped for act 3 with an explanation: the revert step at the
  end of the scene would *pause someone's live campaign*.
- **The revert is a fail-closed invariant.** From the moment the go-live call is issued,
  the script assumes the campaign is live until a read-back proves otherwise — a failed
  read-back is treated as `ENABLED`, not as "probably fine". If the revert cannot be
  verified, act 3/B is skipped (no further writes while a campaign may be live), a red
  **`ACİL — ELLE MÜDAHALE GEREKİYOR`** ("URGENT — MANUAL INTERVENTION REQUIRED") box is
  printed at the very end of the run, and the process exits **1**.

> **What is still not on stage.** PAUSED-at-creation remains a server-side invariant of
> `create_search_campaign`, enforced in the test suite; the scripted demo does not create
> a campaign — it reads existing ones via read-only GAQL.

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
| `ADSPILOT_NV_SIMULATE` | **Simulation only in both modes** — `dogrulandi` / `uyusmadi`; see §3.3. Independent of the SIM-swap channel: it may be combined with a real token | Same |
| `ADSPILOT_DECISION_LOG` | Path to a JSONL audit file; unset = logging **off**. Same in both modes; see §3.5 | Same |
| On-screen honesty | SIM-swap evidence line cites "GSMA Open Gateway" | **Every** line of output — evidence, refusal, stderr — carries an explicit **"SİMÜLASYON"** ("SIMULATION") marker |

> **⚠ Honesty guarantee — please hold us to it.** Simulation mode exists so the demo
> runs without a NaC token. It **loudly labels itself**: every string it produces states
> "SİMÜLASYON" and says a real network query was **not** performed. We will never present
> simulated output as a real network verification, and the code makes that hard to do by
> accident — if both the real token and the simulation flag are set, the configuration is
> treated as contradictory and every spend increase is **refused** (a leftover demo env
> value can never silently turn real verification into theater). An unrecognized
> simulation value doesn't "default to something" either: it is refused at decision time
> (fail closed), exactly like every other misconfiguration. Unrecognized values are never
> echoed back into the refusal text — they might be a secret pasted into the wrong slot.

### 3.3 The trust chain, and where it honestly ends

The gate runs **six links, in a fixed order**:

1. **SIM Swap** (`ADSPILOT_NAC_SIMULATE`, or the real CAMARA API with a token) — "was the
   owner's line taken over recently?" Runs on **every** risk-tagged action.
2. **Number Verification** (`ADSPILOT_NV_SIMULATE`) — "is this approval coming from the
   owner's own device?" **Simulation only, permanently for now** — see the box below.
3. **Device Reachability** (`ADSPILOT_REACH_CHECK` for the live query, or
   `ADSPILOT_REACH_SIMULATE`) — "is the line reachable on the network right now?"
4. **Roaming / expected country** (`ADSPILOT_EXPECTED_COUNTRY`, or `ADSPILOT_LOC_SIMULATE`)
   — "is the line outside the country we expect?" Without an expected country the link does
   not run at all; no default is invented, because a default would answer "clean" forever.
5. **Device Swap** (`ADSPILOT_DEVICESWAP_CHECK`, or `ADSPILOT_DEVICESWAP_SIMULATE`) — "was
   the line moved to a *new device*?" The attack SIM Swap cannot see: the card never moves,
   the line does.
6. **Call Forwarding** (`ADSPILOT_CALLFWD_CHECK`, or `ADSPILOT_CALLFWD_SIMULATE`) — "is
   unconditional call forwarding active?" Invisible to all five links above: same SIM, same
   device, line reachable, expected country — and the verification call goes to the attacker.

**Links 2–6 run on the high tier only** (go-live, changes to a serving campaign), and each
runs **only when its own variable is set**. On the medium tier (budget raises) they do not
exist at all, and a `high`-tier run with nothing but a token exercises link 1 alone: holding
`ADSPILOT_NAC_TOKEN` switches on no other link, because each live link costs another CAMARA
round trip (10 s timeout each) on every approval, and another way to refuse a legitimate
spend. A link that is configured but switched off records `kapali` in the audit trail — "I
did not ask" is written down, never left to look like "asked and passed".

The scripted demo sets only the link-1 channel itself; links 2–6 appear on stage only if you
export their variables (§3.6).

The order is one-directional: a swapped SIM refuses immediately, so no later link gets a
chance to soften that verdict — a later link can only add another reason to refuse.

> **Number Verification is SIMULATION ONLY today, and there is no honest way around it.**
> Real CAMARA Number Verification is a **device-side OIDC flow**: the check is bound to
> the device's own mobile-data connection, so the operator authenticates *through the
> device*, not through a token a back-end holds. A stdio MCP server sitting next to the
> agent has no such connection and **cannot** call that API on its own, whatever
> credentials it is given. That is why the code has no "real" state for this link at all
> — its trace type is literally `"simulasyon" | "calismadi"` ("simulated" | "could not
> run"), with no `"gercek"` ("real") value to reach. Everything this link prints is
> labeled SİMÜLASYON and says no network query was made.
>
> **The roadmap for the real thing:** the approval request leaves the server and reaches
> an approver-side companion (a mobile app or a device-flow web page) over mobile data;
> *that* client runs the CAMARA Number Verification OIDC flow and returns a signed result,
> which this gate then verifies. Until that companion exists, only the simulated channel
> runs.

Values (fail closed, same contract as the SIM-swap link — approver phone required,
unrecognized value refused at decision time without echoing it):

- `dogrulandi` — the request is *deemed* to come from the line owner's device → a second
  evidence line is appended to the prompt.
- `uyusmadi` — **hard refusal**, even when the SIM-swap check was clean: the approval
  prompt is never shown.

### 3.4 Risk tiers

| Tier | Actions | SIM-swap lookback | Chain links 2–6 |
|---|---|---|---|
| **medium** | budget increases | **24 h** (the tighter of 24 h and the configured window) | never run |
| **high** | go-live, changes to an already-serving campaign | configured window, **72 h** by default (clamped to 1–2400) | each runs when its own variable is set: `ADSPILOT_NV_SIMULATE`, `ADSPILOT_REACH_CHECK`/`_SIMULATE`, `ADSPILOT_EXPECTED_COUNTRY`/`ADSPILOT_LOC_SIMULATE`, `ADSPILOT_DEVICESWAP_CHECK`/`_SIMULATE`, `ADSPILOT_CALLFWD_CHECK`/`_SIMULATE` |

The device-swap link reuses `ADSPILOT_SIMSWAP_WINDOW_HOURS` rather than introducing a second
window variable — but it is logged under its **own** field (`devSwapPencereSaat`), so an
auditor can always tell which question was asked with which window.

### 3.5 Auditability — the decision log

The gate tells the *agent* why it refused. It cannot, by itself, answer the account
owner's later question: "how many spend increases were refused last month, over which
window, through which channel?" `ADSPILOT_DECISION_LOG` answers that one.

```bash
ADSPILOT_DECISION_LOG=/var/log/adspilot/kararlar.jsonl
```

- **Off by default.** Unset → no file is created and nothing is written. The variable is
  read at decision time, so it can be turned on and off within one process.
- **One JSONL line per risk-tagged decision** — refusals **and** passes. Logging only
  refusals would make "never asked" indistinguishable from "asked and passed".
- **It is an observation, never a gate.** A broken path, a read-only directory or a full
  disk prints a single stderr line and the approval flow continues untouched. The target
  directory is *not* created for you.
- **No secrets.** The full approver number, the NaC token and raw upstream error text can
  never enter a record. The number appears only in the gate's masked form, and is
  re-validated structurally before it is written (it must contain a `*`; an unmasked
  E.164 number is dropped, with a stderr warning). The refusal reason is a **fixed code**
  from the gate's own vocabulary — free upstream text has no path into the file.
- **Written from the gate's structural trace, not from its text.** Each field comes from
  the decision itself, so **every chain link keeps its own field** — `simSwapKanali`,
  `nvKanali`, `reachKanali`, `locKanali`, `devSwapKanali`, `callFwdKanali` — and they are
  never flattened into one. "Real CAMARA query + simulated NV" and "both simulated" are
  different trust levels, and telling them apart is the entire point of the log. The same
  rule applies to the two windowed links: `pencereSaat` is SIM Swap's, `devSwapPencereSaat`
  is link 5's, even though both derive from one configuration value. **Adding a link means
  adding its field here too** — a link that reaches the gate but not the log turns a
  simulated refusal into something an auditor reads as a real CAMARA query.

Fields (absent fields are omitted rather than written as null, so "not measured" never
looks like "empty"):

| Field | Meaning |
|---|---|
| `zaman` | ISO-8601 timestamp |
| `eylem` | one-line summary of the action (truncated to 160 chars) |
| `hesapId` | the Google Ads customer ID whose money was at stake |
| `risk` | `medium` / `high` |
| `karar` | `gecti` (passed) / `ret` (refused) / `kapali` — `kapali` means **no link actually queried anything**; a gate that was off is never logged as "passed" |
| `simSwapKanali` | link 1 — `gercek` / `simulasyon` / `kapali` (deliberately disabled) / `calismadi` (config error, never queried) |
| `nvKanali` | link 2 (Number Verification) — `simulasyon` / `calismadi` only. There is no `gercek`: the type itself has no such value (§3.3). **Absent** when the link did not run |
| `reachKanali` | link 3 (device reachability) — same four values as `simSwapKanali`; `kapali` means `ADSPILOT_REACH_CHECK` is off. **Absent** when the link was never configured |
| `locKanali` | link 4 (roaming / expected country) — same four values; `kapali` means `ADSPILOT_EXPECTED_COUNTRY` is unset. **Absent** when never configured |
| `devSwapKanali` | link 5 (device swap) — same four values; `kapali` means `ADSPILOT_DEVICESWAP_CHECK` is off. **Absent** when never configured |
| `callFwdKanali` | link 6 (call forwarding) — same four values; `kapali` means `ADSPILOT_CALLFWD_CHECK` is off. **Absent** when never configured |
| `pencereSaat` | the SIM-swap lookback window actually queried |
| `devSwapPencereSaat` | link 5's **own** lookback window — never merged into `pencereSaat`, because link 5 can run while the SIM-swap layer is off, and writing its window into link 1's field would show an auditor a query that never happened |
| `maskeliNumara` | masked approver number, e.g. `+905*******22` |
| `retNedeniKisa` | fixed refusal code, from the gate's own closed vocabulary — never free or upstream text. The full set: `sim-degisti`, `nv-uyusmadi`, `cihaz-erisilemez`, `konum-beklenmedik`, `cihaz-degisti`, `cagri-yonlendirme-acik`, `beklenen-ulke-gecersiz`, `ag-yanitsiz`, `yapilandirma-celiskili`, `simulasyon-degeri-tanimsiz`, `onaylayici-numarasi-yok`, `ag-ayari-kapiya-ulasmadi` |

Note the distinction the channel fields draw three ways: a **missing** field means the link
never ran at all — either the decision was medium-tier, or the link was never configured;
`"kapali"` means it was configured and deliberately switched off ("I did not ask"); and
`"calismadi"` means a configuration error stopped it from asking. Only `"gercek"` is a query
that actually reached CAMARA — and a single `"simulasyon"` next to it is what reveals a run
that is part theatre.

Two real lines — act 2's refusal, and a high-tier pass with both links (contains no
secret; this is exactly what lands on disk):

```jsonl
{"zaman":"2026-08-28T09:14:02.517Z","eylem":"\"Demo Kampanya\" kampanyasının GÜNLÜK BÜTÇESİ DEĞİŞTİRİLECEK.","hesapId":"1234567890","risk":"medium","karar":"ret","simSwapKanali":"simulasyon","pencereSaat":24,"maskeliNumara":"+905*******22","retNedeniKisa":"sim-degisti"}
{"zaman":"2026-08-28T09:15:41.902Z","eylem":"\"Demo Kampanya\" kampanyası YAYINA ALINACAK — bu andan itibaren gerçek para harcanır.","hesapId":"1234567890","risk":"high","karar":"gecti","simSwapKanali":"simulasyon","nvKanali":"simulasyon","pencereSaat":72,"maskeliNumara":"+905*******22"}
```

In containers, put the file on the existing data volume so it survives restarts:

```bash
docker run -d --name adspilot -p 8787:8787 \
  --env-file .env -e PORT=8787 -e ADSPILOT_DB=/data/adspilot.db \
  -e ADSPILOT_DECISION_LOG=/data/kararlar.jsonl \
  -v adspilot-data:/data --restart unless-stopped adspilot
```

### 3.6 Demo environment

The scripted demo needs **no** `.env` additions for the gate: `scripts/demo-senaryo.mjs`
sets `ADSPILOT_NAC_SIMULATE` itself per act (`temiz` for acts 1 and 3/A, `degisti` for
acts 2 and 3/B — each act gets its own server process) and passes a fixed demo approver
number (`+905550001122`) through the spawn environment. You never flip values between
scenes.

Everything else is **forwarded, not decided**: the script copies every `ADSPILOT_*` and
`GOOGLE_ADS_*` variable from your shell into each server process untouched. So
`ADSPILOT_NV_SIMULATE` and `ADSPILOT_DECISION_LOG` work with the demo exactly as they do
in production — the script never invents a value for them:

```bash
# Add the second chain link to act 3, and record every decision:
ADSPILOT_NV_SIMULATE=dogrulandi \
ADSPILOT_DECISION_LOG=$PWD/kararlar.jsonl \
npm run demo -- --musteri <customer-id>
```

Even a **dry** run leaves audit lines behind: acts 2 and 3/B really do call the tool (the
gate refuses before any write), so each writes one `"karar":"ret"` record. Acts 1 and 3/A
skip the call in dry mode, so they produce none — the log is a record of decisions the
gate actually made, not of scenes that were narrated.

Set these only when driving the server *outside* the script (e.g. from a desktop MCP
client):

```bash
# Simulation without the demo script (no NaC token needed):
ADSPILOT_APPROVER_PHONE=+905551112233
ADSPILOT_NAC_SIMULATE=temiz        # or "degisti" for the attack scene
ADSPILOT_NV_SIMULATE=dogrulandi    # optional; second chain link, high tier only
ADSPILOT_SIMSWAP_WINDOW_HOURS=72   # optional; also forwarded to the demo script if set
ADSPILOT_DECISION_LOG=./kararlar.jsonl   # optional; audit trail, off when unset
```

### 3.7 Preflight — `npm run prova`

Stage day is one-shot: a stale `dist/`, an expired refresh token or a stopped Docker
daemon each end the demo in front of the jury. Run the preflight first. It exercises the
**same real paths** the demo will (stdio server binary, live read-only `list_accounts`, a
complete **dry** run of the demo script) and prints one `GEÇTİ` / `UYARI` / `KALDI`
(pass / warning / blocker) line per check:

```bash
npm run prova -- --musteri <customer-id> [--kampanya <campaign-id>]
```

| Check | Blocker (`KALDI`) when |
|---|---|
| Node version vs `engines.node` | older than required |
| `dist/` freshness vs `src/` | `dist/index.js` is missing — a merely *stale* build is a warning |
| `.env` credentials | any of the four Google Ads variables is empty |
| `ADSPILOT_MASTER_KEY` | never — hosted mode only, so absence is a warning |
| `.env` network gate | `ADSPILOT_NAC_TOKEN` and `ADSPILOT_NAC_SIMULATE` both set (contradictory config: every spend increase is refused, act 1 breaks), or a token with no approver phone |
| Live `list_accounts` | the refresh token is dead (`invalid_grant`) or no usable ad account is reachable; `--musteri` not in that list is a warning |
| Demo dry run | `scripts/demo-senaryo.mjs` exits non-zero, **or fewer than 3 acts actually played** — the act headings are counted in the output, because a silently dropped scene still exits 0. A missing `AĞ DOĞRULAMASI BAŞARISIZ` line is a warning |
| Docker CLI + daemon | never — a missing CLI or a stopped daemon is a warning |

Nothing is written: the live call is read-only and the scenario runs in dry mode.
Environment variables are reported as present/absent only — values are never printed, not
even an unrecognized `ADSPILOT_NAC_SIMULATE` (it may hold a secret by mistake). The run
ends with `SAHNEYE HAZIR` ("ready for the stage") or the list of blockers, and exits 1
when any blocker was found.

> The preflight does **not** inspect `ADSPILOT_NV_SIMULATE` or `ADSPILOT_DECISION_LOG`.
> Both are optional and neither can break the three acts: an unusable NV value refuses
> act 3/A (visibly, on stage) and a broken log path only prints a stderr line. If you
> intend to demo either, run the dry run once with them exported and look at the output.

---

## 4. Step-by-Step Scenario

The scripted demo driver is `scripts/demo-senaryo.mjs`:

```bash
npm run demo -- --musteri <customer-id> [--kampanya <campaign-id>] [--canli]
```

- `--musteri` is **required** — a bare `npm run demo` exits with a usage message.
- `--kampanya` is optional; without it the script auto-picks a campaign (it prefers a
  PAUSED one with the smallest budget — the least risky candidate). Act 3's live
  rehearsal is most predictable when you name a PAUSED **test** campaign here.
- The default mode is **DRY** (`kuru`): no write tool is ever called. `--canli`
  performs a real +1 budget raise and reverts it right after approval, and takes the act
  3 candidate live for a few seconds before putting it back.

It speaks real MCP over stdio to the real server binary — the same protocol path a
desktop assistant uses — and pauses at each beat so you can narrate. All three acts run
in that one command; you never touch `.env` between them. (For a fully AI-driven variant
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
"no" is a legitimate outcome, not a failure). A closed stdin is not an answer either: it
resolves as empty, which is not `Evet`, so a piped or disconnected session refuses rather
than hangs. On approval the +1 is applied and immediately reverted (decreases require no
approval).

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
the refusal doesn't arrive or if the approval prompt is shown even once.

*Point out to the jury — this is the heart of Aegis:*

1. **No prompt ever appeared.** The script counts elicitations and asserts the count is
   zero. The person who would answer the prompt may be the attacker who swapped the
   SIM, so asking is itself the vulnerability.
2. **`confirm=true` from the agent changes nothing.** The refusal fires on the strong
   (elicitation) path and the legacy (confirm-flag) path alike — a stolen session cannot
   fall back to the weak gate.
3. **Zero writes reached Google Ads.** The test suite pins all of this end to end
   (`test/networkTrust.test.ts`, `test/networkTrustNv.test.ts`, `test/kararGunlugu.test.ts`).

### Act 3 — The same gate on the high tier: go-live

`set_campaign_status` → `ENABLED` is **high**-risk, so the same gate runs with the
configured window (**72 h** by default) instead of 24, and the Number Verification link
runs if you exported `ADSPILOT_NV_SIMULATE`. The act header states the window it expects,
and whenever a prompt actually appears the script *verifies* that it carries that window,
declining on the spot if it does not — a high-tier scene showing a 24 h line would be a
bug, not a demo.

Before anything is attempted, the script picks a candidate with read-only queries: budget
under the account's safety ceiling, and a servable ad present (see §2). If nothing
qualifies, both sub-scenes are marked `atlandı` ("skipped") in the summary table with the
reason printed — no fabricated evidence.

**Act 3/A (`temiz`)** — dry run prints a labeled prediction of both evidence lines. In
`--canli`, on a PAUSED candidate, the real prompt appears and the script tags each
evidence line it finds:

```
  zincir 1 ▶ Ağ doğrulaması [SİMÜLASYON]: SIM değişimi yok (son 72 saat, +905*******22) — …
  zincir 2 ▶ Numara doğrulaması [SİMÜLASYON]: onay isteği hat sahibinin cihazından geliyor
             SAYILDI (+905*******22) — simüle kanal (ADSPILOT_NV_SIMULATE=dogrulandi),
             gerçek CAMARA Number Verification sorgusu YAPILMADI (cihaz-taraflı OIDC gerektirir)
```

*Translation:* "chain 1 ▶ Network verification [SIMULATION]: no SIM swap (last 72 h …)" /
"chain 2 ▶ Number verification [SIMULATION]: the approval request is *deemed* to come from
the line owner's device … no real CAMARA Number Verification query was performed (it
requires device-side OIDC)."

The operator types `Evet`, the campaign goes live, and the scene immediately reverts it to
`PAUSED` — then **reads the status back from the account** to prove it. Whatever happens
(refusal, dropped call, unreadable status), the run's final word is the safety lock
described in §2.

With `ADSPILOT_NV_SIMULATE=uyusmadi`, act 3/A becomes a *second* refusal scene, and a
sharper one: the SIM-swap check was clean and the action is still refused, with **zero**
prompts —

```
Reddedildi [SİMÜLASYON]: NUMARA DOĞRULAMASI BAŞARISIZ (SİMÜLE) — onay isteği sahibin
gerçek cihazından gelmiyor SAYILDI …
```

*Translation:* "Refused [SIMULATION]: NUMBER VERIFICATION FAILED (SIMULATED) — the approval
request is deemed not to come from the owner's real device …"

**Act 3/B (`degisti`)** — a fourth server process, the same candidate, the same tool call,
one difference: the network's answer. The refusal is the act 2 text with the 72 h window,
the elicitation count is asserted to be zero, and the campaign's status is read back to
prove nothing was written. (If act 3/A's revert could not be verified, 3/B is skipped
outright — no new write is attempted while a campaign may still be live.)

The run ends with a side-by-side summary table of all three acts — action, simulation
value, network decision, whether a prompt was shown, and what was written.

### Act 3's safety lock, proven on demand

The emergency path is not a claim in a doc; it is a code path you can fire:

```bash
node scripts/demo-senaryo.mjs --kendini-sina
```

It plays **no** scenario (it needs neither `--musteri` nor a built `dist/`) and calls the
very same lock function the live rehearsal uses — once with the revert verified (expects
no box, exit code 0) and once with it unverified (expects the red box, exit code 1). It
then **exits 1 on purpose**: that non-zero code *is* the proof the flag reaches the exit
status. An exit code of **2** means the self-test's own expectations failed — the lock is
broken, and it says so loudly rather than passing quietly.

### Fail-closed matrix (worth showing if asked "what if it breaks?")

| Condition | Behavior |
|---|---|
| Feature unconfigured (no token, no simulation) | Pass-through, but the evidence line honestly says the gate is off — and the audit log records `"karar":"kapali"`, never "passed" |
| Token set, approver phone missing | **Refuse** (config error) |
| `ADSPILOT_NV_SIMULATE` set without an approver phone | **Refuse** — the link cannot verify a number it does not have |
| CAMARA API unreachable / errors | **Refuse** — if the trust anchor cannot answer, the spend does not happen. Upstream error bodies are never echoed into the refusal (they can contain the phone number); details go to stderr, number redacted even there |
| Invalid `ADSPILOT_NAC_SIMULATE` or `ADSPILOT_NV_SIMULATE` value | **Refuse** at decision time (server does not crash at startup); the value itself is never printed |
| `ADSPILOT_NAC_TOKEN` and `ADSPILOT_NAC_SIMULATE` both set | **Refuse** — contradictory configuration; ambiguity never selects the weaker channel |
| SIM swap clean but Number Verification says `uyusmadi` | **Refuse** — the second link can only add reasons to refuse, never overturn a pass |
| Risk-tagged action reaches the gate without its config (programming error) | **Refuse** — never fail-open by omission (logged as `ag-ayari-kapiya-ulasmadi`) |
| Decision log path broken / disk full | **Approval flow continues untouched** — one stderr line. The log is an observation, not a gate; the opposite would turn an audit tool into a new failure point |

### Full pipeline: brain → gate

`scripts/demo-senaryo.mjs` drives the gate directly. The **Growth Brain** run does the
other half of the story: a real LLM researches the site, writes the plan and the ad copy,
creates the campaign, and *then* asks to take it live — so one command shows the whole
claim end to end: **the LLM plans, and every money movement goes through the network
gate.**

```bash
# One terminal: the network says the approver's SIM was swapped.
export ADSPILOT_NAC_SIMULATE=degisti
export ADSPILOT_APPROVER_PHONE=+905551112222

npm run brain -- \
  --hedef "yeni müşteri kaydı" \
  --url https://your-site.example \
  --butce 50 \
  --musteri 1234567890 \
  --uygula --yayinla
```

**Prerequisites:** `ANTHROPIC_API_KEY` (the brain is a real model run — no key, no run),
a built server (`npm run build`), and write tools enabled for the account. Without the key
the run stops with a Turkish error naming the environment variable; the key is never
accepted as a CLI argument, because that leaks it into shell history.

**What you will see, in order:**

1. **The planning steps** — research → strategy → creative, printed as `[1/5] … [3/5]`.
2. **Approval #1** — a plan summary box, then `Yalnız 'Evet' devam ettirir` ("only 'Evet'
   continues"). Typing anything else writes nothing. On `Evet` the campaign is created
   **PAUSED**, exactly as in the dry-run flow.
3. **Approval #2 — separate, explicit, and about money.** A second box states that the call
   is `set_campaign_status → ENABLED`, that it is **high**-risk, and that the network gate
   fires before any prompt. This is a distinct question, not a continuation of #1.
4. **The gate fires.** With `ADSPILOT_NAC_SIMULATE=degisti` the refusal from act 2 is
   printed **verbatim** under `── Sunucunun cevabı (aynen) ──` ("the server's answer,
   as-is") and copied into the report. The report labels it
   `✔ GÜVENLİK KAPISI ÇALIŞTI — BU BİR BAŞARISIZLIK DEĞİLDİR` ("the security gate worked —
   this is NOT a failure"): the campaign stayed paused and nothing was spent. The process
   exits **0**, because a refusal is the system working, not breaking.

Swap to `ADSPILOT_NAC_SIMULATE=temiz` and the second half of the design shows itself: the
network passes, its evidence line (`SIM değişimi yok…` — "no SIM swap") is carried into the
report, and the server **still** refuses — because Growth Brain structurally cannot produce
verified human consent. It advertises no elicitation capability and its `confirm` flag is
stripped unconditionally, so consent has to come from a human through a client that can be
asked. The report calls this `DOĞRULANMIŞ İNSAN ONAYI GEREKTİ` ("verified human approval
was required") and, again, not a failure. Both outcomes are honest: the CLI never claims a
campaign went live unless the server's own success line says so.

`--yayinla` cannot be used on its own — `--uygula` must have created the campaign in the
same run, so the tool can never take a *pre-existing* campaign live. That flag check runs
**before** the API-key check: a malformed command line is not something an API key fixes,
and reporting the missing key first would send you off to fix the wrong thing.

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
above — the network check on a spend increase, the hard refusal on a swapped SIM, and the
high-tier go-live chain — are demonstrated identically with zero LLM access.

### 5.4 "The refusal appeared but I expected the real network to be consulted"

Read the refusal text. If it says `çelişkili yapılandırma` ("contradictory
configuration"), both `ADSPILOT_NAC_TOKEN` and `ADSPILOT_NAC_SIMULATE` are set — the
gate refuses every spend increase rather than guess which channel you meant. Unset
`ADSPILOT_NAC_SIMULATE` to use the live CAMARA API (or unset the token to demo). Note
that `ADSPILOT_NV_SIMULATE` is *not* part of that rule: it is simulation-only by nature
(§3.3), so it combines with a real token without contradiction.

### 5.5 Real NaC mode stalls then refuses

The SIM Swap call is tightly bounded (10 s timeout, 1 retry) precisely so an unreachable
NaC endpoint fails closed *fast* instead of hanging an approval for minutes. A refusal
saying the check "could not be completed" (`tamamlanamadı`) means the network was
unreachable — the gate worked as designed. Retry later; operator details are on stderr,
and the audit log carries `"retNedeniKisa":"ag-yanitsiz"` with
`"simSwapKanali":"gercek"` — a real query was attempted, which is not the same as a gate
that never ran.

### 5.6 Act 3 says `PERDE 3 ATLANDI` (skipped)

The candidate failed a gate that answers *before* the network gate: either its daily
budget exceeds the account's safety ceiling, or it has no servable ad (an `ENABLED` ad in
an `ENABLED` ad group). The printed reason names which one. Pass a suitable PAUSED test
campaign with `--kampanya <campaign-id>`, or create one ad in the target campaign. The
script skips rather than stage a scene whose evidence it cannot honestly produce.

### 5.7 The run ended with the red `ACİL` box

Act 3/A took a campaign live and could not **prove** it was put back. Treat it as live
spend: pause it now from the Google Ads UI, or call
`set_campaign_status(customerId=…, campaignId=…, status="PAUSED")` — pausing never asks
for approval, because it reduces spend. The box prints the account and campaign IDs, and
the process exits 1.

---

## Glossary (Turkish runtime strings)

| Turkish | English |
|---|---|
| `SİMÜLASYON` | SIMULATION |
| `temiz` | clean (no SIM swap) |
| `degisti` | changed / swapped |
| `dogrulandi` | verified (Number Verification simulation: request deemed to come from the owner's device) |
| `uyusmadi` | did not match (Number Verification simulation: hard refusal) |
| `Reddedildi` | Refused |
| `AĞ DOĞRULAMASI BAŞARISIZ` | NETWORK VERIFICATION FAILED (used by every link with a live channel: 1, 3, 4, 5, 6) |
| `NUMARA DOĞRULAMASI BAŞARISIZ` | NUMBER VERIFICATION FAILED (chain link 2) |
| `erisilebilir` / `anormal` | reachable / unreachable (link 3 simulation values; `anormal` is a hard refusal) |
| `CİHAZ ERİŞİLEBİLİRLİĞİ ANORMAL` | DEVICE REACHABILITY ABNORMAL (chain link 3) |
| `beklenen` / `beklenmedik` | expected / unexpected country (link 4 simulation values) |
| `KONUM BEKLENMEDİK` | LOCATION UNEXPECTED (chain link 4) |
| `CİHAZ DEĞİŞİMİ SAPTANDI` | DEVICE SWAP DETECTED (chain link 5 — the line moved to a new device, SIM untouched) |
| `acik` / `kapali` (link 6 values) | forwarding on / off. **Careful:** here `kapali` means *forwarding is off* (clean); in the audit trail's channel fields the same word means *the link never asked* |
| `ÇAĞRI YÖNLENDİRME AÇIK` | UNCONDITIONAL CALL FORWARDING ACTIVE (chain link 6) |
| `Ağ doğrulaması: kapalı` | Network verification: off |
| `zincir 1 ▶` / `zincir 2 ▶` | chain link 1 / chain link 2 (evidence-line markers) |
| `çelişkili yapılandırma` | contradictory configuration (token + simulation set together) |
| `onay istemi hiç gösterilmedi` | the approval prompt was never shown |
| `harcama artışı uygulanmaz` | the spend increase will not be applied |
| `güncellendi` | updated (the budget write succeeded) |
| `[kuru] araç çağrısı atlandı` | [dry] tool call skipped |
| `Evet` | Yes (the only accepted approval answer at the operator keyboard) |
| `tamamlanamadı` | could not be completed |
| `PERDE 3 ATLANDI — uydurma kanıt üretilmez` | Act 3 skipped — no fabricated evidence |
| `ACİL — ELLE MÜDAHALE GEREKİYOR` | URGENT — MANUAL INTERVENTION REQUIRED |
| `gecti` / `ret` / `kapali` | passed / refused / gate never queried (decision-log `karar` values) |
| `gercek` / `simulasyon` / `kapali` / `calismadi` | real query / simulated / link deliberately switched off ("did not ask") / config error, never asked — the decision-log channel values |
