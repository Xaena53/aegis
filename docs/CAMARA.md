<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# CAMARA / GSMA Open Gateway in AdsPilot

**What this document is for.** AdsPilot uses mobile-network signals (GSMA Open Gateway,
CAMARA APIs, reached through the Nokia Network-as-Code platform) as a trust anchor in front
of every money-spending approval. This page states, without softening, which of those
signals we actually query, which we only simulate, which we have merely designed, and — most
importantly — **which of them have ever run against a live endpoint**.

The short answer, as of 2026-08-31: **five of the six links have, against live endpoints
backed by the platform's simulated network; the sixth — Number Verification — never will
from a server.** Section 2 gives the exact requests, responses and gate decisions, plus the
undocumented header the SDK omits.

**Headline verdict on Number Verification: it is NOT callable from our server.** It is a
device-side OIDC flow, and section 4 proves that from the SDK's own type definitions rather
than from an assumption. That is why `ADSPILOT_NV_SIMULATE` exists and why every line it
produces is stamped `SİMÜLASYON`.

---

## 1. Signal inventory

Every CAMARA namespace exposed by `network-as-code@10.0.0` was read from its `.d.ts` type
definitions and judged on three questions: what fraud question does it answer, can our
server call it at all, and what is its status in this codebase today.

| CAMARA signal | Question it answers | Status in AdsPilot | Server-callable? |
|---|---|---|---|
| **SIM Swap** (`simSwap.check`) | "Was the approver's line taken over recently?" | **Real path written.** Live channel + `ADSPILOT_NAC_SIMULATE` simulation channel + test seam. **Verified against the live endpoint on 2026-08-28** (§2). | **Yes** — API key + phone number, nothing else. |
| **Number Verification** (`numberVerification.*`, `numberVerificationV100.*`) | "Is this approval coming from the line owner's own device?" | **Simulation only** (`ADSPILOT_NV_SIMULATE`). Runs on the `high` tier only. Every string it emits says `SİMÜLASYON` and `gerçek ağ sorgusu YAPILMADI`. | **No.** Device-side OIDC authorization-code flow — see §4. |
| **Device Swap** (`deviceSwap.check`) | "Was the line moved to a NEW DEVICE in the last N hours?" | **Link 5 — real path written, opt-in.** Structural twin of SIM Swap: same auth, same body shape, same hour-based `maxAge` (it *shares* `ADSPILOT_SIMSWAP_WINDOW_HOURS` rather than inventing a second window variable), same single-boolean output. The live query stays **off unless `ADSPILOT_DEVICESWAP_CHECK` is set**, runs on the `high` tier only, and the audit trail records `kapali` while it is off. `ADSPILOT_DEVICESWAP_SIMULATE` is the demo channel. One deliberate divergence from link 1: an unreadable `swapped` is **not** taken as "no swap" — `undefined` is `RET`. **Verified against the live endpoint on 2026-08-28** (§2). | **Yes** — phone number only. |
| **Call Forwarding Signal** (`callForwardingSignal.retrieveUnconditionalCallForwarding`) | "Is *unconditional* call forwarding active on the approver's line?" (the standard way to intercept OTP/voice verification, and invisible to all five earlier links: same SIM, same device, line reachable, expected country) | **Link 6 — real path written, opt-in.** Off unless `ADSPILOT_CALLFWD_CHECK` is set, `high` tier only, trail records `kapali` while off; `ADSPILOT_CALLFWD_SIMULATE` is the demo channel. Only the unconditional variant is called — one boolean, no PII: *which* number the line forwards to is never asked for, never received, never written anywhere. **Verified against the live endpoint on 2026-08-28** (§2). | **Yes** — phone number only. |
| **KYC Tenure** (`kyc.checkTenure`) | "Has this number been with the same subscriber since date X, and is it prepaid (PAYG) or contract/business?" | **Roadmap, blocked on data we do not have.** Requires a `tenureDate` we would have to invent — see the trap note below. | **Yes**, but needs a date input we cannot honestly supply yet. |
| **Number Recycling** (`numberRecycling.check`) | "Has the configured approver number changed hands since date X?" | **Roadmap.** Needs a new config field (e.g. `ADSPILOT_APPROVER_SINCE`). Window semantics differ from every other link: absolute date, not an hour window. | **Yes**, but needs that new config field. |
| **Device Status — roaming** (`deviceStatus.checkRoaming`) | "Is the approver's line abroad right now, and in which country?" | **Link 4 — real path written.** Serves the expected-country check: `ADSPILOT_EXPECTED_COUNTRY` (ISO 3166-1 alpha-2) with `ADSPILOT_LOC_SIMULATE` as the demo channel. `high` tier only, and **only when an expected country is configured** — no default is invented, since a default would answer "clean" forever. Raw `countryName[]` is never echoed; only the derived expected/unexpected verdict. **Verified against the live endpoint on 2026-08-31** (§2) — the 404s came from hand-built passthrough-prefixed URLs; the SDK calls `device-status/device-roaming-status/v1/retrieve` directly and answers `200` (roaming true, country HU), confirmed by Nokia mentor Aleksi Puranen and reproduced through the gate with a `gercek` trace. | **Yes** — `device.phoneNumber`. Direct endpoint, not passthrough. |
| **Device Status — connectivity / reachability** (`deviceStatus.retrieveReachabilityStatus`) | "Can the line receive data/SMS right now?" | **Link 3 — real path written, opt-in.** The false-positive objection is real: reachability legitimately fluctuates (airplane mode, coverage, dead battery) and under fail-closed an "unreachable" answer refuses the spend. So the live query stays **off unless `ADSPILOT_REACH_CHECK` is set**, runs on the `high` tier only, and the audit trail records `kapali` while it is off. `ADSPILOT_REACH_SIMULATE` is the demo channel. **Verified against the live endpoint on 2026-08-31** (§2) — same correction as link 4: the endpoint was never gated, our hand-built URLs carried a passthrough prefix the SDK does not use. Answers `200` (reachable, SMS). | **Yes** — phone number only. |
| **Location Verification / Retrieval** (`location.*`) | "Is the approver inside the expected geography?" | **Deferred — the country question is served by roaming instead (above).** The SDK's `Area` type is `{ areaType: 'CIRCLE' }` only: center coordinates and radius are absent from the `.d.ts`, so a query area cannot be expressed type-safely, and forcing it with `as any` would be inventing a schema. It is also the highest-privacy data in the set (needs `consentInfo`), and `retrieve` returns raw coordinates. Country-level roaming answers most of the fraud question at a fraction of the privacy cost. | Structurally yes; **not type-safe today.** |
| **Geofencing** (`geofencing.*`) | "Tell me when the approver enters/leaves an area." | **Out of scope.** Not a synchronous question-and-answer: the answer arrives later on a webhook, which a fail-closed approval gate cannot wait for. Also needs a public sink URL and subscription lifecycle state. | Technically yes; architecturally unusable here. |
| **KYC Match / Fill-In** (`kyc.match`, `kyc.fillIn`) | "Do the user's identity details match the operator's records?" / "Give me the subscriber's identity record." | **Rejected on principle.** `match` demands identity PII as *input* (we hold none). `fillIn` returns ID document number, address, birthdate as *output* — a direct collision with our invariant that raw values are never echoed to the agent. | Yes — and that is precisely why the refusal is deliberate, not incidental. |
| **KYC Age Verification** (`kyc.verifyAge`) | "Is the user above an age threshold?" | **Not applicable.** An age gate, not a spend-fraud signal. | Yes, irrelevant. |

**Trap note on `kyc.checkTenure`.** The API needs a `tenureDate`. We do not store "when was
this number registered as the approver". Passing today's date would make the answer always
come back clean — a silent loss of security dressed up as a passing check. Until a real
registration date exists in config, this link must fail closed (`RET`), never default.

**Trap note on `numberRecycling.check`.** Same shape of trap, same rule. This link is not
built, and `ADSPILOT_APPROVER_SINCE` does not exist in the configuration today — the name
appears here only to fix the rule that will bind whoever writes it: without a real date the
link must refuse rather than invent one.

**Trap note on `callForwardingSignal`.** Two fail-closed hazards were read out of the type
definitions before the link was written, and both are honoured by the implementation:
(1) `active` is *optional* in
`RetrieveUnconditionalCallForwardingCallForwardingSignalResponse`, so `undefined` means
"unknown", which is `RET` — never "clean"; the code narrows with
`typeof res.active === "boolean"` and refuses otherwise. (2) The endpoint documentation
states that `retrieveCallForwarding` "exceeds the main scope of the CFS API, for this reason
an error code 501 can be returned", so every throw — `NotImplementedError` included — is
`RET`. The array-returning sibling `retrieveCallForwarding` is therefore **never called**:
an unrecognised array member would be one more fail-closed path for a question that is
already answerable with a single boolean. If an operator's network does not serve this
signal, the honest move is to turn the link off (`ADSPILOT_CALLFWD_CHECK`), not to read the
silence as "no forwarding".

---

## 2. What has run live, and what has not

This section used to be maintained in prose, and prose let it contradict itself: while §1
said links 3 and 4 were live, the text below still listed them as blocked by a 404. One
dated table now carries the whole answer, and the live/not-live column is mirrored in the
code (`ZINCIR_HALKALARI[].canliDogrulandi`) so a test refuses to let the two drift again.

| Link | Live-verified | What proved it |
|---|---|---|
| 1 · `simSwap.check` | **2026-08-28** | Three MSISDNs, three outcomes — table below |
| 2 · `numberVerification.*` | **never, and never will be** | Device-side OIDC; not callable from any back end (§4). This is an architectural verdict, not a pending task |
| 3 · `deviceStatus.retrieveReachabilityStatus` | **2026-08-31** | `200` (reachable, SMS) through the gate, trace `"reach":"gercek"` |
| 4 · `deviceStatus.checkRoaming` | **2026-08-31** | `200` (roaming, country HU) through the gate, trace `"loc":"gercek"`; a wrong `ADSPILOT_EXPECTED_COUNTRY` produces a real refusal with the observed country kept out of the text |
| 5 · `deviceSwap.check` | **2026-08-28** | `200 {"swapped":…}` through the gate, trace `"devSwap":"gercek"` |
| 6 · `callForwardingSignal` | **2026-08-28** | `200 {"active":…}` through the gate, trace `"callFwd":"gercek"` |

All of it is reproducible in one command — `npm run agtest` drives the production path
(`nacIstemciSecenekleri()` + `agDogrula()`), never a hand-built URL. That distinction is
not pedantry: the 404s that convinced us Device Status was switched off on our account
came from exactly such hand-built URLs, which carried a `/passthrough/camara/v1/` prefix
the SDK does not use for Device Status. Nokia mentor Aleksi Puranen supplied the correct
paths on 31 Aug 2026 and both links answered `200` on the first run through the gate. The
wrong diagnosis survived for weeks because nothing but prose was holding it.

What ran on link 1, and what came back:

| Simulator MSISDN | Request | Real response | Gate decision |
|---|---|---|---|
| `+99999991001` | `simSwap.check`, `maxAge: 240` | `200 {"swapped":false}` | **passed**, evidence line cites GSMA Open Gateway |
| `+99999991000` | same | `200 {"swapped":true}` | **hard refusal**, `retNedeni: "sim-degisti"` |
| `+99999990500` | same | `500 Internal Server Error` | **fail-closed refusal**, `retNedeni: "ag-yanitsiz"`, upstream body redacted to stderr with the number masked |

All three were written to the decision log with `"simSwapKanali":"gercek"` — the field
exists precisely so this claim can be checked rather than believed.

**Links 5 and 6 followed, through the gate rather than a raw request:**

| Link | Live response | Trace written |
|---|---|---|
| 5 · `deviceSwap.check` | `200 {"swapped":false}` on the clean MSISDN, `{"swapped":true}` on `…1000` | `"devSwap":"gercek"` |
| 6 · `callForwardingSignal` | `200 {"active":false}` on the clean MSISDN, `{"active":true}` on `…1000` | `"callFwd":"gercek"` |

The simulator is consistent across signals: `+99999991000` answers "compromised" to every
question and `+99999991001` answers "clean" to every one, so a full-chain demo needs no
staging beyond choosing a number.

**The important caveat: live endpoint, simulated network.** The account is in the
platform's *Simulator mode*, so the HTTP request, the authentication, the routing and the
response shape are all real, but the subscriber behind the number is Nokia's simulation,
not a person on an operator's network. Reaching real subscribers requires completing
onboarding with a billing account. So the wire is proven; the operator integration is not.

**What still has not run live: link 2, Number Verification — and it never will.** It cannot
run from a server at all (§4), so no account tier and no mentor session changes it. It is
the one entry in the table above that is a verdict rather than a to-do.

A green test suite remains evidence about **decision logic**, not about the wire: the unit
suite injects a fake channel on purpose, so it can say nothing at all about whether the
endpoint answers.

### The header that made it work

The SDK does **not** send the `X-RapidAPI-Host` header, and without it the platform answers
every request — correct base URL, correct endpoint path, valid key — with:

```
404 {"message": "API doesn't exists"}
```

That error text points at the wrong thing: it reads as a missing subscription or a wrong
version, and the first hours went into checking exactly that. The fix is one header:

```ts
new NetworkAsCodeApiClient({
  apiKey: token,
  headers: { "X-RapidAPI-Host": "network-as-code.nokia.rapidapi.com" },
});
```

Measured, not guessed: same body, same key, header absent → 404; header present →
`200 {"swapped":true}`. The value is the constant from the platform's own curl examples.
`test/nacIstemci.test.ts` pins it, because if it is ever dropped no unit test would notice
(they all inject a fake channel) and the gate would simply refuse every spend in
production, for a reason nobody would find quickly.

### Simulator MSISDNs worth knowing

`+99999991000` reports a swapped SIM and `+99999991001` a clean one, which is what makes a
two-outcome demo possible without staging anything. The rest encode the HTTP status they
return — `…0400` → 400, `…0404` → 404, `…0422` → 422, `…0500` → 500 — so the fail-closed
paths can be exercised against genuine error responses instead of thrown fakes.

The evidence for everything above, all of it checkable in the tree:

1. **The token lives only in `.env`**, which is git-ignored; it is never printed by any
   script, and the decision log records a masked number and a fixed reason code, never the
   raw upstream body.

2. **The SDK is imported only inside `src/networkTrust.ts`, and there exactly `once`** —
   in the single `nacIstemci()` helper that every live link's channel factory goes
   through:

   ```ts
   const { NetworkAsCodeApiClient } = await import("network-as-code");
   ```

   One import point, not one per link, and that is the security property: the
   `X-RapidAPI-Host` header cannot be added to some clients and forgotten on others,
   because there is only one place that builds a client. Grep for the line above and you
   should find a single hit; `test/camaraBelge.test.ts` counts it and fails if this
   sentence and the source ever disagree.

   It is a lazy dynamic import, reached only when a token is present *and* that link's
   simulation channel is absent — and, for reachability, device swap and call forwarding,
   only when that link's own opt-in switch (`ADSPILOT_REACH_CHECK`,
   `ADSPILOT_DEVICESWAP_CHECK`, `ADSPILOT_CALLFWD_CHECK`) is on.

3. **Tests never touch the network — they inject a fake channel.** The seam is
   `__setSimSwapKanalForTests(...)`, used by `test/helpers/harness.ts`:

   ```ts
   __setSimSwapKanalForTests({
     verifySimSwap: async (saat) => {
       opts.agPencereKaydi?.push(saat);
       if (durum === "hata") throw new Error("NaC sandbox unreachable");
       return durum === "degisti";
     },
   });
   ```

   The fake is what makes the refusal paths testable — including the unreachable-API path,
   which is asserted rather than hoped for. But it also means: **a green test suite is
   evidence about our decision logic, not evidence that the CAMARA integration works.**

4. **Number Verification could not have run live even with a token.** See §4 — it is
   structurally uncallable from a server. Its trace type in `src/networkTrust.ts` has no
   `"gercek"` member at all:

   ```ts
   export type NvIzi = "simulasyon" | "calismadi";
   ```

   The absence of a "real" value is deliberate: the type system refuses to let anyone claim
   a live NV query happened.

### What *has* been proven

To be equally precise about the other direction, the following are genuinely verified and
not aspirational:

- The **decision logic** of the gate: refusal on swapped SIM, refusal on unreachable API,
  refusal on incomplete configuration, refusal on unrecognised simulation values, and the
  one-directional chain order (a SIM-Swap refusal can never be softened by the second link).
- The **fail-closed invariants**: the approval prompt is never shown when the network layer
  refuses; the raw approver number and raw upstream error text never reach the agent.
- The **audit trail**: every risk-tagged decision (refusal *and* pass) is written from the
  gate's own structural trace (`AgKarar.iz`), not sniffed from message text, and **each of
  the six links gets its own field** (`simSwapKanali`, `nvKanali`, `reachKanali`,
  `locKanali`, `devSwapKanali`, `callFwdKanali`) so "real query + simulated second link" can
  never be flattened into "everything simulated" — or, worse, read as "everything real".
  The two windowed links are kept apart the same way: `pencereSaat` belongs to SIM Swap and
  `devSwapPencereSaat` to device swap, even though both derive from one configuration value.

What is unproven is the wire: request shape, auth, latency, error bodies, and operator
coverage against a real endpoint. Section 3 is how that gets closed.

---

## 3. Token arrival checklist

Run this end to end the day a Network-as-Code key is issued. Copy-pasteable, in order.

### Step 1 — Register and obtain the key

Sign up at <https://networkascode.nokia.io> (a free sandbox tier exists) and create an
application key. The SDK sends it as the `x-rapidapi-key` header; it authenticates *AdsPilot
to the Nokia platform*, and is not a per-user token.

### Step 2 — Add the environment variables

Edit `.env` (see `.env.example` for the full commentary on each one):

```bash
# The Network-as-Code application key. Its presence is what switches the layer on.
ADSPILOT_NAC_TOKEN=<key from step 1>

# E.164, '+' prefixed. REQUIRED once the token is set: token without number = refusal.
ADSPILOT_APPROVER_PHONE=+90XXXXXXXXXX

# SIM-swap lookback for high-risk actions, in hours. Clamped to CAMARA's 1-2400 range.
# Medium-risk actions (budget increases) always use the tighter of 24h and this value.
ADSPILOT_SIMSWAP_WINDOW_HOURS=72

# Turn the audit trail on so the live run leaves evidence you can read afterwards.
ADSPILOT_DECISION_LOG=./kararlar.jsonl
```

The token switches on link 1 and **nothing else**. Links 3–6 each need their own opt-in,
because every live link adds one more CAMARA round trip (10 s timeout each) to every
`high`-tier approval, and an operator who wanted a SIM-swap check should not inherit
latency — or false-positive refusals — they never asked for:

```bash
ADSPILOT_REACH_CHECK=1          # link 3 — reachability (fluctuates legitimately)
ADSPILOT_EXPECTED_COUNTRY=TR    # link 4 — roaming; no default is ever invented
ADSPILOT_DEVICESWAP_CHECK=1     # link 5 — device swap (shares the SIM-swap window)
ADSPILOT_CALLFWD_CHECK=1        # link 6 — unconditional call forwarding
```

Turn them on one at a time for a first live run: each one is a new way for the endpoint to
refuse a spend, and you want to know which link produced the first refusal you see.

One more variable belongs to the chain as a whole rather than to any single link, and it
changes what a refusal *means*:

```bash
ADSPILOT_STEPUP=0               # default. 1 = escalate instead of refusing (see below)
```

Leave it at `0` for a first live run. With it on, a broken signal that describes an
ordinary human situation — SIM changed, device changed, line abroad, phone unreachable,
network silent — no longer ends the request: the remaining links are asked anyway, and if
every one answers clean **over a real channel**, the action reaches a human prompt that
names the broken signal instead of a flat refusal. That is a loosening, so it ships off,
and the audit trail records it as its own outcome (`"karar":"kademeli"`) rather than
folding it into `gecti`. Three limits are worth knowing before you turn it on: an active
call-forwarding signal **never** escalates (the escalation would travel over the very
channel the attacker holds), neither do configuration faults, and a clean link only counts
as corroboration for a signal it could actually have contradicted. That last one is why
device reachability vouches for nothing: a swapped SIM sits in a phone that is perfectly
reachable, so the two never disagree. The pairing lives in `KEFIL_ESLEMESI`. The full list,
and the refusal reasons it covers, is in [docs/DEMO.md](DEMO.md) — kept in step with the
code by a test that reads the reason set out of `KADEME_UYGUN`.

### Step 3 — Remove the simulation channels

This is the step that is easy to forget and expensive to get wrong.

```bash
# ALL SIX must be empty/absent for a real run — one per chain link.
ADSPILOT_NAC_SIMULATE=
ADSPILOT_NV_SIMULATE=
ADSPILOT_REACH_SIMULATE=
ADSPILOT_LOC_SIMULATE=
ADSPILOT_DEVICESWAP_SIMULATE=
ADSPILOT_CALLFWD_SIMULATE=
```

`ADSPILOT_NAC_TOKEN` and `ADSPILOT_NAC_SIMULATE` set together is **contradictory
configuration and is refused outright** (`yapilandirma-celiskili`). The gate does not warn
and continue: under ambiguity it will not pick the looser channel, because a leftover demo
variable silently turning real verification back into theatre is exactly the failure this
rule exists to prevent.

`ADSPILOT_NV_SIMULATE` is independent of the SIM-Swap layer and may legitimately coexist with
a real token — but for a first live run, clear it, so nothing in the output is simulated.

#### The trap: for links 3, 5 and 6 the contradiction rule does *not* fire by default

Read this before assuming a cleared `.env`. The contradiction refusal on the reachability,
device-swap and call-forwarding links is not triggered by "token + simulation". It is
triggered by **"that link's live channel is *on*" + simulation**, and the live channel is on
only when its own opt-in switch is set:

| Link | Leftover variable | Refuses on a token alone? |
|---|---|---|
| 3 — reachability | `ADSPILOT_REACH_SIMULATE` | **No** — only when `ADSPILOT_REACH_CHECK` is also on |
| 4 — roaming / country | `ADSPILOT_LOC_SIMULATE` | Yes, when `ADSPILOT_EXPECTED_COUNTRY` is set |
| 5 — device swap | `ADSPILOT_DEVICESWAP_SIMULATE` | **No** — only when `ADSPILOT_DEVICESWAP_CHECK` is also on |
| 6 — call forwarding | `ADSPILOT_CALLFWD_SIMULATE` | **No** — only when `ADSPILOT_CALLFWD_CHECK` is also on |

The reasoning inside the gate is sound on its own terms: with the switch off there is no
live channel to contradict, so the simulation cannot be overriding a real query. But those
switches are **off by default**, which means the composite outcome is precisely the failure
this document warns about elsewhere — *a leftover demo variable turning real verification
into theatre*. Concretely: you set a real token, you forget
`ADSPILOT_DEVICESWAP_SIMULATE=temiz` from demo day, and link 5 answers **from the
simulation** without a single word of protest. Nothing refuses, nothing warns on stderr,
and the approval prompt carries a `SİMÜLASYON`-stamped evidence line among the real ones.

Two things make it hide longer than any other misconfiguration:

- **Links 2–6 run on the `high` tier only.** A first live check done with a budget raise
  (medium) exercises link 1 and nothing else, so it looks completely clean.
- **A half-simulated pass still reads `"gercek"` in `simSwapKanali`.** Only that link's own
  field (`reachKanali` / `devSwapKanali` / `callFwdKanali`) says `"simulasyon"`.

So: clear all six variables, then verify with a **high-tier** action (a go-live), not just a
budget change, and read every channel field in the log line rather than the first one
(Step 6). The audit trail is the only place this trap is visible.

### Step 4 — Build and verify the code is sound before spending a call

```bash
npm run typecheck      # must be 0 errors
npm test               # must be all green
npm run build
```

### Step 5 — Confirm the layer actually switched on

Restart the MCP server, then trigger any medium-risk action (a budget increase). Inspect the
evidence line attached to the approval prompt:

| What you see | What it means |
|---|---|
| `Ağ doğrulaması: SIM değişimi yok (son 24 saat, +90XX****XX) — GSMA Open Gateway` | **Live query succeeded.** No `SİMÜLASYON`, no `kapalı`. First produced on 2026-08-28 (§2); on a real subscriber line it will be produced for the first time. |
| `Ağ doğrulaması: kapalı (ADSPILOT_NAC_TOKEN tanımlı değil)` | The token did not reach the process. Check `.env` location — config is loaded from the project root, never from the CWD. |
| Any line containing `SİMÜLASYON` | A simulation variable is still set. Go back to step 3. |
| `Reddedildi: ağ doğrulaması tamamlanamadı` | The endpoint was reached but did not answer within 10s / 1 retry. Details are on stderr with the number redacted. Fail-closed worked. |

### Step 6 — Verify the audit trail records a *real* query

```bash
tail -n 1 ./kararlar.jsonl
```

The critical field is `simSwapKanali`. It must read `"gercek"`:

```json
{"zaman":"...","eylem":"...","risk":"medium","karar":"gecti",
 "simSwapKanali":"gercek","pencereSaat":24,"maskeliNumara":"+90XX****XX"}
```

- `"gercek"` — a real CAMARA query was attempted and answered. **This is the goal.**
- `"simulasyon"` — still on the simulated channel; step 3 is incomplete.
- `"kapali"` — the layer is off; the token never arrived.
- `"calismadi"` — a configuration error prevented any query at all.

Read the other links' fields with the same eye — `nvKanali`, `reachKanali`, `locKanali`,
`devSwapKanali` and `callFwdKanali` carry the same vocabulary, and a line is only fully live
when no link still says `"simulasyon"`. Checking `simSwapKanali` alone is how a
half-simulated run gets mistaken for a real one: on a `high`-tier decision, links 3–6 each
have their own channel, and any of them can still be answering from a leftover demo variable
while link 1 reads `"gercek"` — see the trap in step 3, which for links 3, 5 and 6 produces
no refusal at all.

A `high`-tier line with the whole chain live looks like this — six channel fields, two
separate windows, and `nvKanali` absent because that link cannot run at all:

```json
{"zaman":"...","eylem":"...","risk":"high","karar":"gecti",
 "simSwapKanali":"gercek","reachKanali":"gercek","locKanali":"gercek",
 "devSwapKanali":"gercek","callFwdKanali":"gercek",
 "pencereSaat":72,"devSwapPencereSaat":72,"maskeliNumara":"+90XX****XX"}
```

`"kapali"` in any of `reachKanali` / `devSwapKanali` / `callFwdKanali` means that link's
opt-in switch is off — a deliberate "I did not ask", which is a different statement from
`"gercek"` and must never be read as a passed check. A link that was never configured at
all writes **no field**, which is again different from `"kapali"`.

Also confirm what is **absent**: no full phone number, no token, no raw upstream error text.
The number appears only masked, and `retNedeniKisa` is a code from a fixed dictionary, never
free text.

### Step 7 — Exercise the refusal path against the live endpoint

A passing check proves half the integration. Deliberately provoke the refusals too:

1. **Unreachable API** — block egress to the NaC host, attempt a high-risk action, confirm
   the refusal `ağ doğrulaması tamamlanamadı` and a log line with `retNedeniKisa`
   `"ag-yanitsiz"` and `simSwapKanali":"gercek"` (configuration was sound; the query was
   attempted and unanswered — this is a different state from `calismadi` and the audit must
   keep them apart).
2. **Missing approver number** — clear `ADSPILOT_APPROVER_PHONE` with the token still set,
   confirm refusal with `"onaylayici-numarasi-yok"`.
3. **Swapped SIM** — if the sandbox offers a test MSISDN that reports `swapped: true`, run it
   and confirm the approval prompt is **never shown**.

### Step 8 — Record the result honestly

Update §2 of this document. If a live query succeeded, replace "none, not once" with what
actually ran, on which date, against which endpoint, and for which signals. If it failed,
write that down too. The value of this section is that it has never been optimistic.

---

## 4. Number Verification: why the server cannot call it, and what the real flow requires

### 4.1 The verdict, from the SDK's own type definitions

The judgement below is read out of `network-as-code@10.0.0`'s `.d.ts` files, not inferred.

**Evidence A — the request carries an OIDC authorization code.**
From `dist/@types/api/resources/numberVerification/client/requests/VerifyNumberVerificationRequest.d.ts`:

```ts
export interface VerifyNumberVerificationRequest {
    /** Authorization code received from the CSP */
    code?: string;
    /** Application state */
    state?: string;
    /** Correlation id for the different services */
    "x-correlator"?: string;
    /** authorization header for token */
    authorization?: string;
    /** A public identifier addressing a telephone subscription... E.164 standard, prefixed with '+'. */
    phoneNumber?: string;
    /** Hashed phone number. SHA-256 ... */
    hashedPhoneNumber?: string;
}
```

`code` is *"Authorization code received from the CSP"* — the redemption half of an OAuth /
OIDC authorization-code flow. A code is issued to a redirect target after an authorization
step; a back-end holding a platform API key cannot mint one for a user's line.

**Evidence B — the answer is bound to the device that authenticated over the mobile network.**
From `dist/@types/api/resources/numberVerification/client/Client.d.ts`, the doc comment on
`verify`:

> *"- The number verification will be done for the user that has authenticated via mobile network*
> *- It returns true/false depending on if the hashed phone number received as input matches the authenticated user's `device phone number` associated to the access token"*

And on `getDevicePhoneNumberV2`:

> *"Returns the phone number so the API clients can verify the number themselves:*
> *- It will be done for the user that has authenticated via mobile network*
> *- It returns the authenticated user's `device phone number` associated to the access token"*

The subject of the check is *"the authenticated user"*, and the binding is *"associated to the
access token"* — a token that must be acquired **through the device's own mobile data
bearer**, because that bearer is how the operator identifies the line. A stdio MCP server
running next to the agent has no such bearer. This is not a credentials problem that a better
key would solve; it is the mechanism of the API.

**Evidence C — the v1.0.0 namespace has no number input at all.**
From `dist/@types/api/resources/numberVerificationV100/client/requests/PhoneNumberShareRequest.d.ts`:

```ts
export interface PhoneNumberShareRequest {
    /** Application state */
    state?: string;
    /** Authorization code received from the CSP */
    code?: string;
    /** Correlation id for the different services */
    "x-correlator"?: string;
    /** authorization header for token */
    authorization?: string;
}
```

There is no `phoneNumber` field. There is nothing to ask *about* — the answer derives
entirely from the device the access token is bound to. And the response is raw PII:

```ts
export interface PhoneNumberShareResponse {
    /** A public identifier addressing a telephone subscription... */
    devicePhoneNumber: string;
}
```

That is "share the number", not "verify a number": the output is not a boolean but an MSISDN,
so it could never be placed in a fail-closed evidence line under our no-raw-values invariant.
**There is no link to build in this namespace.**

**Evidence D — our API key is the wrong kind of credential.**
From `dist/esm/auth/HeaderAuthProvider.js`:

```js
const PARAM_KEY = "apiKey";
const HEADER_NAME = "x-rapidapi-key";
```

The key we hold becomes an `x-rapidapi-key` header. It authenticates AdsPilot to the Nokia
platform (two-legged). The NV endpoints underneath additionally require the `authorization`
bearer described in Evidence A — the three-legged, device-derived token. The platform key
gets you to the passthrough door; it does not answer the question behind it.

**Evidence E — `code` and `state` travel as query parameters, exactly as an OIDC redirect
delivers them.** From the compiled `dist/esm/api/resources/numberVerification/client/Client.js`:

```js
const { code, state, "x-correlator": correlator, authorization } = request, _body = __rest(...);
const _queryParams = { code, state };
// url: passthrough/camara/v1/number-verification/number-verification/v0/verify
```

**Conclusion: Number Verification is not callable from AdsPilot's server, and no credential
we could obtain would change that.** This is the verified reason `ADSPILOT_NV_SIMULATE` is a
simulation-only channel, and why `NvIzi` has no `"gercek"` member.

Relevant endpoints, for whoever builds the companion:

| Method | Endpoint | Returns |
|---|---|---|
| `numberVerification.verify` | `POST passthrough/camara/v1/number-verification/number-verification/v0/verify` (`code`, `state` as query) | `{ devicePhoneNumberVerified: boolean }` |
| `numberVerification.verifyV2` | `POST .../number-verification/v2/verify` | `{ devicePhoneNumberVerified: boolean }` |
| `numberVerification.getDevicePhoneNumberV2` | `GET .../number-verification/v2/device-phone-number` | `{ devicePhoneNumber: string }` — **raw PII, do not use** |
| `numberVerificationV100.phoneNumberShare` | `GET .../number-verification/v0/device-phone-number` | `{ devicePhoneNumber: string }` — **raw PII, do not use** |

Only the two `verify` variants return a boolean, and only a boolean can enter a fail-closed
evidence line.

### 4.2 Minimum architecture for the real integration

The missing piece is not code inside the gate. It is a component that possesses something the
server cannot have: **the approver's mobile data connection.**

```
  ┌──────────────┐   1. high-risk action
  │  MCP client  │──────────────────────────────┐
  │  (agent)     │                              ▼
  └──────────────┘                   ┌─────────────────────────┐
                                     │  AdsPilot approval gate │
                                     │  src/approval.ts        │
                                     │  src/networkTrust.ts    │
                                     └───────────┬─────────────┘
                                                 │ 2. create challenge
                                                 │    (nonce + state + TTL),
                                                 │    park the approval
                                                 ▼
                                     ┌─────────────────────────┐
                                     │  Approver companion     │
                                     │  (mobile app / device-  │
                                     │   flow web page)        │
                                     └───────────┬─────────────┘
                                                 │ 3. MUST run over MOBILE DATA
                                                 │    (Wi-Fi off — the data bearer
                                                 │     is how the operator IDs the line)
                                                 ▼
                                     ┌─────────────────────────┐
                                     │  Operator / aggregator  │
                                     │  CAMARA NV authorize    │
                                     └───────────┬─────────────┘
                                                 │ 4. redirect back with
                                                 │    ?code=...&state=...
                                                 ▼
                                     ┌─────────────────────────┐
                                     │  AdsPilot callback      │
                                     │  (hosted mode only)     │
                                     └───────────┬─────────────┘
                                                 │ 5. server-side exchange:
                                                 │    verify({ code, state, phoneNumber })
                                                 ▼
                                          { devicePhoneNumberVerified: boolean }
                                                 │ 6. boolean ONLY crosses back
                                                 ▼
                                       gate resumes → prompt, or refusal
```

**Step-by-step responsibilities.**

1. **Gate** reaches a `high`-tier action, needs the second link, and mints a challenge:
   a random `state`, a correlation id, and a short TTL. The approval is parked, not shown.
2. **Companion** — a mobile app or a device-flow page on the approver's handset — receives
   the challenge out of band (push, deep link, QR).
3. **Companion runs the OIDC authorization step over the cellular bearer.** Wi-Fi must be off:
   the operator identifies the subscription from the mobile data connection itself. This is
   the step no server can perform on the user's behalf, and the entire reason this link is
   not written today.
4. **Redirect** returns `code` + `state` to a public HTTPS callback we control.
5. **Server exchanges the code**, and only here does the SDK get used:
   `client.numberVerification.verify({ code, state, phoneNumber }, { timeoutInSeconds: 10, maxRetries: 1 })`
   → `{ devicePhoneNumberVerified: boolean }`.
   The `getDevicePhoneNumber*` variants are never called: they return a raw MSISDN, which our
   invariant forbids carrying anywhere near the agent.
6. **Only the boolean re-enters the gate.** It becomes an evidence line or a refusal, and the
   trace field gains a genuine `"gercek"` value — at which point `NvIzi` gains its third
   member and §2 of this document must be rewritten.

**Where the callback would live.** The stdio server (`npm start`) has no HTTP surface and
cannot host step 4 — this is the architectural fact behind the whole limitation. Hosted mode
(`npm run serve`, `src/http.ts`) already runs a public server with `ADSPILOT_PUBLIC_URL` and
an existing `/oauth/callback` route for Google OAuth; a sibling NV callback belongs there.
**Therefore the real NV link is a hosted-mode capability, not a stdio one**, and any claim
otherwise should be treated as a design error.

**Fail-closed rules the future implementation must honour** (identical in spirit to every
existing link — these are stated now so they are not "discovered" later as optional):

- Challenge missing, expired, or already consumed → `RET`. No retry loosening.
- Returned `state` not matching the parked challenge → `RET`. This is CSRF defence, not a
  formality.
- Companion returns a phone number instead of a `code` → `RET`. The device must never be the
  authority on its own identity; only the operator's exchange is.
- `devicePhoneNumberVerified` anything other than strictly `true` (including `undefined`) →
  `RET`. Unknown is not clean.
- Endpoint unreachable, timing out, or throwing (`BadRequestError`, `UnauthorizedError`,
  `ForbiddenError`, `NotImplementedError`, …) → `RET`, with the upstream message written only
  to stderr, number redacted, never echoed to the agent.
- Chain order stays one-directional: a SIM-Swap refusal returns before this link runs. A
  successful NV result can add a reason to proceed but can never overturn a refusal.

**Interim honesty requirement.** Until that companion exists, the NV link remains
simulation-only, every string it produces keeps its `SİMÜLASYON` marking and its explicit
statement that no network query was made, and this document keeps saying so.
