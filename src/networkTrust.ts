// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Network-verified approval: CAMARA signals as a trust anchor for spending consent.
 *
 * MCP elicitation proves a human clicked "approve"; it cannot prove the human is the
 * account owner. A stolen session answers the prompt just as convincingly. The mobile
 * network holds evidence no application layer can fake: the operator knows whether the
 * owner's SIM was swapped recently — the signature move of account-takeover fraud.
 *
 * Before a spend-increasing action reaches the human prompt, this module consults the
 * GSMA Open Gateway SIM Swap API (CAMARA, via the Nokia Network-as-Code platform) for
 * the configured approver number. A recent swap refuses the action outright — the
 * prompt is never shown, because the person who would answer it may be the attacker.
 *
 * Fail-closed contract, same as every money gate in this codebase:
 *   - Feature unconfigured (no AEGIS_NAC_TOKEN): pass-through, evidence line says so.
 *   - Configured but incomplete (token without approver phone): refuse with a config error.
 *   - Network API unreachable or throws: refuse. If the trust anchor cannot answer,
 *     the spend does not happen.
 *
 * Risk tiers widen the lookback window rather than change the decision logic:
 * "medium" (budget increases) checks the last 24h; "high" (go-live, changes to a
 * serving campaign) checks the configured window, 72h by default.
 *
 * ── Link 2 of the trust chain: Number Verification (SIMULATION ONLY) ──────────
 *
 * SIM Swap answers "was the owner's line taken over recently?". It cannot answer the
 * next question: "is this approval request coming from the owner's own device?".
 * CAMARA Number Verification answers that one — the operator matches the number
 * against the very mobile data connection the request travels over.
 *
 * HONEST LIMITATION, stated up front: this module can only SIMULATE that link.
 * Number Verification is a device-side OIDC flow — the check is bound to the
 * device's own mobile-data connection, so the operator authenticates through the
 * device (authorization-code flow in the device's context), not through a token a
 * back-end server holds. A stdio MCP server sitting next to the agent has no such
 * connection and CANNOT call the API on its own, no matter which credentials it
 * holds. Anything this file emits for that link is therefore explicitly labelled
 * SİMÜLASYON and says that no network query was made.
 *
 * Roadmap for the real integration: the approval leaves the server and reaches an
 * approver-side companion (mobile app or device-flow web page) over mobile data;
 * THAT client runs the CAMARA Number Verification OIDC flow and returns a signed
 * result, which this gate then verifies. Until that companion exists, only the
 * simulated channel below runs — and only where the code says so.
 *
 * Chain order is fixed and one-directional: SIM Swap first, Number Verification
 * second. A swapped SIM already refuses the action, so the second link never gets
 * the chance to soften that verdict; it can only add another reason to refuse.
 * The second link runs ONLY on the "high" tier (go-live and changes to a serving
 * campaign) — the demo narrative is "go-live gets the full chain".
 *
 * ── Link 3: Device Reachability (a REAL query is possible) ────────────────────
 *
 * The question it asks: "is the approver's line reachable on the network right now?".
 * The CAMARA Device Status / Reachability endpoint can answer that from a server — a
 * phone number is enough as the sole identifier, and no device-side flow is REQUIRED.
 * So unlike NV there IS a real SDK channel here; the simulation channel
 * (AEGIS_REACH_SIMULATE) exists only for a demo without a token.
 *
 * AN HONEST TRADE, written down deliberately: reachability fluctuates LEGITIMATELY —
 * flight mode, a coverage gap, a phone that is switched off. Under the fail-closed
 * principle an "unreachable" answer produces a REFUSAL; that is what the idea
 * submission's "step-up verification" amounts to at this gate, because a stdio MCP
 * server has no second verification channel and spending does NOT happen under
 * uncertainty. The false-positive risk is bounded in two ways: (1) the link runs ONLY
 * on the "high" tier, and (2) the real channel is OPT-IN — unless AEGIS_REACH_CHECK is
 * switched on explicitly, no query runs even with a NaC token present and the trace
 * records "kapali". An operator who configured a token for SIM Swap alone therefore
 * never meets a reachability refusal they did not ask for.
 *
 * ── Link 4: Location Verification (the expected country) ──────────────────────
 *
 * The question it asks: "is the approver's line in a country OUTSIDE the expected one?".
 * The criterion is not "is the expected country PRESENT in the set the network reports"
 * but "was the line seen ONLY in the expected country": a CONTRADICTORY set such as
 * {NL, TR} produces a REFUSAL even though it contains TR (the reasoning and the honest
 * trade are in the comparison comment inside konumKatmani).
 * The expectation is never INVENTED: with AEGIS_EXPECTED_COUNTRY (ISO 3166-1 alpha-2)
 * unset, the link does not run and records "kapali" in its trace. Producing a default of
 * the "today's value" kind would be a silent loss of security that always makes the
 * answer come out clean.
 *
 * WHY THE ROAMING COUNTRY AND NOT CAMARA Location Verification: the `Area` type the SDK
 * generates carries only `{ areaType: "CIRCLE" }` — there are NO centre-coordinate or
 * radius fields in the type definitions at all. Because the area to query cannot be built
 * type-safely, that endpoint was deliberately DEFERRED (inventing a schema with `as any`
 * would mean a 400 on a wrong body, turning the link into a permanent refusal). The
 * endpoint that answers the country question type-safely is Device Status / Roaming: a
 * `roaming` boolean plus the ISO-2 country list mapped from the MCC. The link's scope is
 * therefore "country level"; city or radius geography is not what this gate promises
 * TODAY.
 *
 * THE RAW VALUE IS NEVER ECHOED: the country list the operator reports — upstream data —
 * enters neither the evidence lines, nor the refusal text, nor the trace. The only things
 * that leave are the DERIVED decision ("in the expected country" / "outside the expected
 * country") and the validated, normalised expected-country code that came from
 * configuration.
 *
 * ── Link 5: Device Swap (SIM Swap's STRUCTURAL TWIN) ─────────────────────────
 *
 * The question it asks: "did the line move to a NEW HANDSET in the last N hours?". SIM
 * Swap sees the card change, this link sees the DEVICE change: if the attacker took the
 * line onto their own phone without moving the card, link 1 answers clean and this one
 * does not.
 *
 * `deviceSwap.check` is SIM Swap's twin: the same auth, the same body shape
 * ({ phoneNumber, maxAge }), an hour-based window, one boolean out ({ swapped }). So the
 * window calculation goes through the same code (pencereSec) and is clamped to the same
 * CAMARA range of 1-2400 hours; no separate window variable is INVENTED, and the link
 * shares AEGIS_SIMSWAP_WINDOW_HOURS.
 *
 * The one HONEST DIFFERENCE: an unreadable answer is not assumed to mean "did not
 * change". `swapped` is a required boolean in the type, but a type guarantee is not a
 * runtime guarantee; an unreadable field is not a quiet loosening but a fail-closed (the
 * same reasoning as link 3).
 *
 * ── Link 6: Call Forwarding (unconditional call forwarding) ──────────────────
 *
 * The question it asks: "is UNCONDITIONAL call forwarding active on the approver's
 * line?". Active forwarding is the classic way to intercept an OTP or a voice
 * verification: the line stays with its owner, the SIM does not change, the device does
 * not change — but the verification call goes to the attacker. None of the previous five
 * links can see that scenario.
 *
 * THERE IS NO PII IN THE ANSWER: the endpoint returns only an `active` boolean — WHICH
 * number the forwarding points to is never asked for, never received, and never written
 * into any text.
 *
 * TWO FAIL-CLOSED TRAPS, closed up front by reading the type definitions:
 *   (1) `active` is OPTIONAL in the type (`active?: boolean`). An unreadable field means
 *       "unknown", NOT "no forwarding", and produces a REFUSAL.
 *   (2) The SDK documentation says the sibling endpoint "may return 501"; every throw,
 *       NotImplementedError included, goes to the fail-closed side, that is, to a refusal.
 *
 * ── The number of links and LATENCY (each link asks for its own switch) ───────
 *
 * As the chain grows, every approval on the HIGH tier waits for one more CAMARA round
 * trip per real link that runs (a 10-second timeout each). That is why NO link is enabled
 * by default: the real channels of links 3, 5 and 6 each require their own opt-in switch
 * (AEGIS_REACH_CHECK / AEGIS_DEVICESWAP_CHECK / AEGIS_CALLFWD_CHECK), and link 4 requires
 * an expected country to be configured. An operator who configured a token for SIM Swap
 * alone takes on neither the latency nor the false-positive refusals they did not ask
 * for; a disabled link runs no query and records "kapali" in its trace.
 *
 * ── The structured audit trace (AgIz) ─────────────────────────────────────────
 *
 * Alongside its text, every decision carries a MACHINE-READABLE trace: which link ran,
 * whether it was real or simulated, which window it queried, and which fixed code the
 * refusal reason was. The audit log downstream does not GUESS these by sniffing the
 * refusal and evidence text — it writes down the gate's own declaration. Sniffing text
 * merged two links' words into a single string and so lost the distinction between "SIM
 * Swap disabled plus an NV simulation" and "a real query plus an NV simulation"; the trace
 * is the only structure that carries it.
 */

/**
 * The single network capability this gate needs; the SDK client is adapted to it.
 *
 * The return type is DELIBERATELY `boolean | undefined` — the SAME contract as the chain's
 * other five links (see ErisilebilirlikKanali, CihazDegisimKanali): `undefined` means "the
 * answer could not be read" and is NEVER the same thing as "the SIM did not change". The
 * caller turns it into a fail-closed REFUSAL; a type guarantee is not a RUNTIME guarantee.
 */
export interface SimSwapKanali {
  /**
   * True when the SIM changed within the last `maxAgeHours` hours; false when the
   * operator says it demonstrably did not; `undefined` when the answer could not be
   * read — an unreadable body, a missing field, a field of the wrong type. That is "I do
   * not know", NOT "clean".
   */
  verifySimSwap(maxAgeHours: number): Promise<boolean | undefined>;
}

/**
 * What link 3 needs: is the approver's device reachable on the network right now?
 *
 * `undefined` is there on purpose and is NOT the same as "no": if the CAMARA response
 * arrives but the field cannot be read — empty, or of another type despite the type
 * guarantee — the verdict is "the answer could not be read" rather than "unreachable". The
 * two go to different refusal codes, and both fail closed.
 */
export interface ErisilebilirlikKanali {
  cihazErisilebilirMi(): Promise<boolean | undefined>;
}

/**
 * What link 4 needs: which country the line is in right now.
 *
 * `yurtDisinda` is CAMARA's roaming boolean and `ulkeler` is the ISO-2 list mapped from the
 * MCC. Both fields are optional because they are optional in the SDK's own type; a field
 * that cannot be read fails closed (the same reasoning as in ErisilebilirlikKanali).
 */
export interface KonumKanali {
  ulkeDurumu(): Promise<{ yurtDisinda?: boolean; ulkeler?: string[] }>;
}

/**
 * What link 5 needs: did the line move to a new handset in the last `maxAgeHours` hours?
 *
 * The twin of SimSwapKanali, but its return type is DELIBERATELY `boolean | undefined`:
 * even though `swapped` is a required boolean in the SDK's type, treating an unreadable
 * field as "did not change" would be a silent loosening (the same reasoning as in
 * ErisilebilirlikKanali).
 */
export interface CihazDegisimKanali {
  cihazDegistiMi(maxAgeHours: number): Promise<boolean | undefined>;
}

/**
 * What link 6 needs: is unconditional call forwarding active on the line?
 *
 * Here `undefined` comes from the TYPE ITSELF — `active` is optional in the CAMARA response
 * and means "unknown". It is NEVER the same as "off", and the two go to different refusal
 * codes.
 */
export interface CagriYonlendirmeKanali {
  kosulsuzYonlendirmeAcikMi(): Promise<boolean | undefined>;
}

export type AgRisk = "medium" | "high";

/**
 * The SIM Swap link's TRACE — what happened is stated by the DECISION POINT, not by text.
 *
 * "gercek"     : a CAMARA query really was made (or attempted and left unanswered).
 * "simulasyon" : the simulated channel decided; no network query was made at all.
 * "kapali"     : the layer is DELIBERATELY disabled (no token) — not a configuration fault.
 * "calismadi"  : a configuration fault meant no query could be made AT ALL.
 */
export type SimSwapIzi = "gercek" | "simulasyon" | "kapali" | "calismadi";

/**
 * The Number Verification link's trace. Real CAMARA NV requires a device-side OIDC flow
 * (see the file header), so there is DELIBERATELY no "gercek" value: the link either decides
 * through simulation, or cannot run at all because of a configuration fault.
 */
export type NvIzi = "simulasyon" | "calismadi";

/**
 * The trace for links 3 (Reachability), 4 (Location), 5 (Device Swap) and 6 (Call
 * Forwarding). The value set is the same as SIM Swap's because all four DO have a real SDK
 * channel — unlike NV (see the file header):
 *
 * "gercek"     : a CAMARA query really was made (or attempted and left unanswered).
 * "simulasyon" : the simulated channel decided; no network query was made at all.
 * "kapali"     : the link DELIBERATELY did not run — AEGIS_REACH_CHECK for reach,
 *                AEGIS_DEVICESWAP_CHECK for devSwap and AEGIS_CALLFWD_CHECK for callFwd were
 *                not switched on; for loc, AEGIS_EXPECTED_COUNTRY is unset. This is NOT a
 *                configuration fault (that is "calismadi") and produces no refusal; it is
 *                the gate declaring "I did not ask" — staying silent would be confused in an
 *                audit with "I asked and it passed".
 * "calismadi"  : a configuration fault meant no query could be made AT ALL, and a refusal
 *                accompanies it.
 *
 * If the link is not CONFIGURED at all — neither simulation nor token — the field is NOT
 * WRITTEN: "kapali" is a deliberate declaration that it was switched off, not the silence of
 * a link nobody ever asked for.
 */
export type HalkaIzi = "gercek" | "simulasyon" | "kapali" | "calismadi";

/**
 * The refusal reasons are a FIXED vocabulary. Upstream text — an SDK error body, an
 * environment value, a CAMARA response — can NEVER enter this set: the audit trace carries
 * codes, not free text.
 */
export type RetNedeni =
  | "sim-degisti"
  | "nv-uyusmadi"
  | "cihaz-erisilemez"
  | "konum-beklenmedik"
  /** Link 5: the line moved to a NEW HANDSET within the window. Not to be confused with
   * "sim-degisti". */
  | "cihaz-degisti"
  /** Link 6: unconditional call forwarding is ACTIVE on the line — the route for
   * intercepting an OTP or a voice verification. */
  | "cagri-yonlendirme-acik"
  | "beklenen-ulke-gecersiz"
  | "ag-yanitsiz"
  | "yapilandirma-celiskili"
  | "simulasyon-degeri-tanimsiz"
  | "onaylayici-numarasi-yok"
  | "ag-ayari-kapiya-ulasmadi";

/**
 * THE STRUCTURED AUDIT TRACE. How the decision came about is declared by the gate ITSELF;
 * nothing downstream — the decision log least of all — guesses it by sniffing the refusal or
 * evidence text.
 *
 * Two links are NEVER collapsed into one field: `simSwap` and `nv` are written separately,
 * because "a real SIM Swap query plus an NV simulation" and "both simulated" are different
 * levels of confidence, and proving that distinction is the audit trace's whole job.
 */
export interface AgIz {
  simSwap: SimSwapIzi;
  /** If the link never ran — the medium tier, or no AEGIS_NV_SIMULATE — the field is
   * ABSENT. */
  nv?: NvIzi;
  /**
   * Link 3 (Device Reachability). On the medium tier, or when the link is not configured at
   * all, the field is ABSENT; with a token present but AEGIS_REACH_CHECK off, it records
   * "kapali".
   */
  reach?: HalkaIzi;
  /**
   * Link 4 (Location / expected country). On the medium tier, or when the link is not
   * configured at all, the field is ABSENT; with AEGIS_EXPECTED_COUNTRY unset, it records
   * "kapali".
   */
  loc?: HalkaIzi;
  /**
   * Link 5 (Device Swap). On the medium tier, or when the link is not configured at all,
   * the field is ABSENT; with a token present but AEGIS_DEVICESWAP_CHECK off, it records
   * "kapali".
   */
  devSwap?: HalkaIzi;
  /**
   * Link 6 (Call Forwarding). On the medium tier, or when the link is not configured at
   * all, the field is ABSENT; with a token present but AEGIS_CALLFWD_CHECK off, it records
   * "kapali".
   */
  callFwd?: HalkaIzi;
  /** The look-back window of the SIM Swap link ONLY, in hours; absent when no query
   * ran. */
  pencereSaat?: number;
  /**
   * Link 5's OWN look-back window, in hours.
   *
   * It is NOT written into `pencereSaat`, because two links are never collapsed into one
   * field: when the SIM Swap layer is disabled — no token, no simulation — `pencereSaat` is
   * empty, and putting the device-swap window there would read to an auditor as the window
   * of a SIM Swap query that never happened. Even though the value derives from the same
   * setting (AEGIS_SIMSWAP_WINDOW_HOURS), which link's question it belongs to stays
   * separate.
   */
  devSwapPencereSaat?: number;
  /** maskele() output; present when a link that actually evaluated the number ran. */
  maskeliNumara?: string;
  retNedeni?: RetNedeni;
  /**
   * EVERY REFUSAL REASON PRODUCED ALONG THE CHAIN — not only the one that MADE the
   * decision, ordered with the first degraded signal first.
   *
   * `retNedeni` is a SINGLE slot and is overwritten as the chain proceeds. With step-up on,
   * a SIM change is detected and held pending; if another link then degrades too, only the
   * SECOND reaches the trace: the detected SIM CHANGE is erased entirely, and the record —
   * carrying "simSwapKanali":"gercek" and "pencereSaat":72 — reads like a clean query where
   * nothing went wrong. An auditor counting "sim-degisti" never sees the event.
   *
   * This array carries that distinction: a refusal with two degraded signals MUST be
   * distinguishable from one with a single degraded signal. With no degraded signal at all
   * the field is NOT written — an empty array would confuse "we looked and found nothing"
   * with "we never looked".
   *
   * It is populated on an escalated decision too: there the reason names not "why it was
   * refused" but "which signal was degraded" — the same rule as the retNedeni field's own.
   */
  retNedenleri?: RetNedeni[];
  /**
   * THE STEP-UP TRACE — it appears here whenever the verdict is not a plain "passed".
   *
   * "yukseltildi": a link produced a degraded signal, and instead of refusing it the chain
   * ESCALATED — because the remaining links came back clean over a real channel, the action
   * was bound to a stronger human verification that names the degraded signal explicitly,
   * and to a lowered ceiling.
   *
   * For an auditor the distinction is critical: "passed clean" and "passed by escalation
   * despite a degraded signal" are not the same thing, and a single 'gecti' label would
   * confuse them. The signal that caused the escalation sits in `retNedeni`, and the links
   * that vouched for it in `kademeDogrulayan`.
   */
  kademe?: "yukseltildi";
  /** The ids of the links carrying the escalation — which signals came back clean. */
  kademeDogrulayan?: string[];
}

/**
 * THE REFUSAL REASONS ELIGIBLE FOR STEP-UP VERIFICATION.
 *
 * Mentor feedback (Aleksi Puranen, Nokia, 31 August 2026): "Legitimate SIM and device
 * changes happen every day. With a hard fail-closed gate, every one of those users is
 * refused with no way forward."
 *
 * The reasons here are the ordinary things that happen to people: they replaced their
 * phone, renewed their SIM, they are travelling, their phone is switched off, or the
 * network did not answer. None of them is PROOF of an attack on its own; each of them means
 * "this signal can no longer serve as evidence of identity". The right answer is not to
 * close the gate but to ask for stronger evidence.
 */
/**
 * RISK -> WHICH LINKS RUN. One table, one place.
 *
 * Mentor suggestion (Aleksi Puranen, Nokia, 31 August 2026): "Let the first go-live take
 * all three rounds, and a budget increase on a pattern the gate has already cleared take
 * one. Keep the mapping simple and explicit."
 *
 * The mapping worked this way before, but it was INVISIBLE: it consisted of
 * `if (risk !== "high") return undefined` lines scattered through five separate layers. In
 * that state, answering "which links run for this operation?" required reading five
 * functions, and changing one layer's condition was a policy change nobody could see.
 *
 * Every enabled link adds a CAMARA round trip to an approval on the HIGH tier, and one more
 * way to refuse a legitimate spend. So a budget increase (medium) settles for the single
 * strongest signal: a SIM change is the question that stops whoever took the account over
 * from answering the approval prompt. Going live (high) — the moment real spending starts —
 * asks for the whole chain.
 */
export const RISK_HALKA_ESLEMESI: Readonly<Record<AgRisk, readonly string[]>> = Object.freeze({
  medium: Object.freeze(["simSwap"]),
  high: Object.freeze(["simSwap", "nv", "reach", "loc", "devSwap", "callFwd"]),
});

/** Does this link run on this risk tier? The layers' SINGLE source of that decision. */
export function halkaKosarMi(risk: AgRisk, halkaId: string): boolean {
  return RISK_HALKA_ESLEMESI[risk].includes(halkaId);
}

/**
 * THE REFUSAL REASONS ELIGIBLE FOR STEP-UP — and at the same time the documentation's
 * single source.
 *
 * The `export` is not a convenience but the closing of a measured gap: this set turns the
 * gate's "refuses unconditionally" behaviour into a CONDITIONAL one — with AEGIS_STEPUP on,
 * every reason here is bound to a human prompt instead of a flat refusal. But the README and
 * the runbook did not know that, and stated as a RULE that "a SIM change refuses
 * immediately, and no later link can soften it": the documentation was declaring an
 * invariant that ran the other way.
 *
 * Exporting the set lets the documentation guards (test/zincirBelgeKademe.test.ts) derive
 * the list FROM THE CODE rather than from prose: add a new reason here and the test goes RED
 * if the runbook does not mention it.
 */
export const KADEME_UYGUN: ReadonlySet<RetNedeni> = new Set<RetNedeni>([
  "sim-degisti",
  "cihaz-degisti",
  "cihaz-erisilemez",
  "konum-beklenmedik",
  "ag-yanitsiz",
]);

/**
 * WHICH CLEAN LINK CAN VOUCH FOR WHICH DEGRADED SIGNAL — one visible table.
 *
 * WHY IT IS NEEDED: an escalation was granted on the condition that "at least one real link
 * came back clean", and that condition never asked WHAT the link had measured. The measured
 * result: a genuine, detected SIM change could be vouched for by the reachability link
 * alone, and that link carried the escalation.
 *
 * But reachability is not an IDENTITY signal, it is a LIVENESS one: the phone of the
 * attacker holding the swapped SIM answers the network too, and so does the phone of
 * whoever changed the device, or diverted the calls. "The device is on" CONTRADICTS none of
 * those signals — and a link that cannot disprove a signal cannot vouch for it either. It is
 * valuable as a gate, since an unreachable device is suspicious, and worthless as a voucher;
 * so it appears in none of the rows below. `nv` is absent for the same reason: it is
 * simulation-only anyway.
 *
 * For any reason NOT in the table the set is empty (fail closed: no link can vouch for an
 * unrecognised degraded signal, so no escalation is granted). Every reason in KADEME_UYGUN
 * must have a row here; test/kademeliDogrulama.test.ts checks the two lists against each
 * other, so a new reason cannot be added without its vouchers.
 */
export const KEFIL_ESLEMESI: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // The SIM changed: is the device the same, is the line in the expected country, is
  // there call forwarding?
  "sim-degisti": Object.freeze(["devSwap", "loc", "callFwd"]),
  // The device changed: is the SIM the same, is the line in the expected country, is there
  // forwarding?
  "cihaz-degisti": Object.freeze(["simSwap", "loc", "callFwd"]),
  // The device is unreachable: every identity link has something to say.
  "cihaz-erisilemez": Object.freeze(["simSwap", "devSwap", "loc", "callFwd"]),
  // The location is unexpected: with the SIM and device unchanged, travel is a plausible
  // explanation — provided there is no forwarding.
  "konum-beklenmedik": Object.freeze(["simSwap", "devSwap", "callFwd"]),
  // A check could not give a readable answer: a clean response from the identity links is
  // meaningful.
  "ag-yanitsiz": Object.freeze(["simSwap", "devSwap", "loc", "callFwd"]),
});

/**
 * THE REASONS NEVER ELIGIBLE FOR STEP-UP — and any reason absent from the table is already
 * ineligible, since that is the default REFUSE side. Only the REASONING is recorded here:
 *
 * `cagri-yonlendirme-acik` — the most important one, and the counter-intuitive one.
 *   Escalating while call forwarding is active means sending the stronger verification TO
 *   THE ATTACKER: the escalation's carrier, a call or an SMS, is exactly the channel that
 *   has been taken over. Escalating here does not add security, it does the attacker's work.
 *
 * `nv-uyusmadi` — number verification is not an "unreadable", it is a direct statement of
 *   MISMATCH: the network is saying the line is not the expected number.
 *
 * `yapilandirma-celiskili`, `beklenen-ulke-gecersiz`, `onaylayici-numarasi-yok`,
 * `simulasyon-degeri-tanimsiz` — these are the OPERATOR's situation, not the user's.
 *   Stronger identity verification does not fix a misconfiguration; escalating them would
 *   paper over a configuration fault with a user check.
 */

export interface AgKarar {
  /** Refusal text for the agent; undefined when the action may proceed. */
  engel?: string;
  /** Evidence lines appended to the human approval prompt. */
  kanit: string[];
  /** The decision's structured trace — EVERY return point fills it in (see AgIz). */
  iz: AgIz;
  /**
   * Filled in when the decision survived through step-up verification; it is NEVER present
   * TOGETHER with `engel`. Seeing it, the approval layer shows a different prompt and lowers
   * the ceiling — so an escalation is not a silent "passed".
   */
  kademe?: KademeKarari;
}

/** What step-up verification carries up to the approval layer. */
export interface KademeKarari {
  /** The degraded signal that caused the escalation. */
  neden: RetNedeni;
  /** The degraded signal in human language — shown verbatim in the approval prompt. */
  aciklama: string;
  /** The ids of the links carrying the escalation: those that came back clean over a REAL
   * channel. */
  dogrulayan: string[];
}

/** The NV link's own result; it joins AgIz when the chain is assembled. */
interface NvSonuc {
  engel?: string;
  kanit: string[];
  nv: NvIzi;
  maskeliNumara?: string;
  retNedeni?: RetNedeni;
}

/**
 * The shared result shape of links 3 and 4. It carries the link's OWN trace value; which
 * AgIz field it is written to is known by the chain assembly — so two links can never be
 * collapsed into one field.
 *
 * When a link does not run at all, its layer function returns `undefined` and this type is
 * never produced.
 */
interface HalkaSonuc {
  engel?: string;
  kanit: string[];
  halka: HalkaIzi;
  maskeliNumara?: string;
  retNedeni?: RetNedeni;
  /** Only the windowed link (5) fills this in; the chain assembly writes it to
   * devSwapPencereSaat. */
  pencereSaat?: number;
}

/** The subset of AegisConfig this module reads (kept narrow for testability). */
export interface AgAyar {
  nacToken?: string;
  approverPhone?: string;
  simSwapWindowHours: number;
  /**
   * STEP-UP VERIFICATION (AEGIS_STEPUP). OFF by default, and deliberately so.
   *
   * When it is on, a degraded signal arising from an ordinary human situation — a changed
   * SIM or device, travel, a phone that is off, a silent network — does not end in a flat
   * refusal: if all the remaining links come back clean over a real channel, the action is
   * bound to a stronger human verification that names the degraded signal, and to a lowered
   * ceiling.
   *
   * The off default exists so the gate's current behaviour does not change underneath
   * anyone: an escalation is a LOOSENING, and a loosening has to be chosen explicitly by the
   * operator.
   */
  stepUp?: boolean;
  /**
   * The SIMULATION channel (AEGIS_NAC_SIMULATE): "temiz" | "degisti". When it is set the
   * real SDK is never used, so a jury demo runs without a NaC token. The value is not
   * narrowed at the type level here: validation happens AT DECISION TIME, so that a
   * malformed environment value does not bring the server down at startup and only takes the
   * spending gate to its fail-closed side.
   */
  nacSimulate?: string;
  /**
   * The Number Verification SIMULATION channel (AEGIS_NV_SIMULATE):
   * "dogrulandi" | "uyusmadi". Link 2 of the chain, and SIMULATION ONLY — real CAMARA NV
   * requires a device-side OIDC flow and cannot be called from a server alone (see the file
   * header).
   *
   * It is INDEPENDENT of nacSimulate: it can combine with a real SIM Swap token or with a
   * disabled SIM Swap layer. The value is not narrowed at the type level here; validation
   * happens at decision time, for the same fail-closed reason.
   */
  nvSimulate?: string;
  /**
   * The Device Reachability SIMULATION channel (AEGIS_REACH_SIMULATE):
   * "erisilebilir" | "anormal". Link 3 of the chain; when it is set the real SDK is NEVER
   * touched. The value is not narrowed at the type level here — validation happens at
   * decision time.
   */
  reachSimulate?: string;
  /**
   * The on/off switch for link 3's REAL channel (AEGIS_REACH_CHECK).
   *
   * Deliberately OPT-IN: reachability fluctuates legitimately — flight mode, coverage — so
   * enabling the query merely because a NaC token exists would impose false-positive
   * refusals on an operator who configured that token for SIM Swap. While it is off the link
   * runs no query and records "kapali" in its trace (see the file header, Link 3).
   */
  reachCheck?: boolean;
  /**
   * The Location SIMULATION channel (AEGIS_LOC_SIMULATE): "beklenen" | "beklenmedik".
   * Link 4 of the chain; for the same fail-closed reason the value is validated at decision
   * time.
   */
  locSimulate?: string;
  /**
   * Link 4's expectation (AEGIS_EXPECTED_COUNTRY, ISO 3166-1 alpha-2).
   *
   * IF IT IS UNSET THE LINK DOES NOT RUN, recording "kapali": an expected country is never
   * INVENTED. If it is set but is not a two-letter code, that is a configuration fault and
   * goes to the fail-closed side as a REFUSAL — the operator asked for the link and supplied
   * a value that cannot be understood.
   */
  expectedCountry?: string;
  /**
   * The Device Swap SIMULATION channel (AEGIS_DEVICESWAP_SIMULATE):
   * "temiz" | "degisti". Link 5 of the chain; when it is set the real SDK is NEVER touched.
   * The value is not narrowed at the type level here — validation happens at decision
   * time.
   */
  devSwapSimulate?: string;
  /**
   * The on/off switch for link 5's REAL channel (AEGIS_DEVICESWAP_CHECK).
   *
   * OPT-IN for the same reason as link 3, plus a LATENCY reason: every approval on the HIGH
   * tier waits for one more CAMARA round trip per real link that runs. Enabling the query
   * merely because a token exists would impose latency the operator never asked for — and a
   * false-positive refusal on any user who replaced their phone. While it is off the link
   * runs no query and records "kapali" in its trace.
   */
  devSwapCheck?: boolean;
  /**
   * The Call Forwarding SIMULATION channel (AEGIS_CALLFWD_SIMULATE):
   * "kapali" | "acik". Link 6 of the chain; for the same fail-closed reason the value is
   * validated at decision time.
   *
   * NOTE: "kapali" here says the FORWARDING is off, that is, clean. It is the same word as
   * the "kapali" in a trace field, which means the link did not run — same word, different
   * vocabulary.
   */
  callFwdSimulate?: string;
  /**
   * The on/off switch for link 6's REAL channel (AEGIS_CALLFWD_CHECK).
   * The same reason as link 5: no link is enabled by default — the latency and the risk of a
   * refusal both require the operator's EXPLICIT intent.
   */
  callFwdCheck?: boolean;
}

/**
 * All of a chain link's DOWNSTREAM connection points — on one line.
 *
 * `izAlani` and `ayarAlanlari` are bound by the COMPILER (`keyof AgIz` / `keyof AgAyar`):
 * rename a field on AgIz and the record NO LONGER COMPILES. `gunlukAlani`, `retIsaretleri`
 * and `envler` point at other files — kararGunlugu.ts, this file's refusal texts, config.ts
 * — and so cannot be bound by the type; test/zincirButunlugu.test.ts verifies those at
 * runtime.
 */
export interface ZincirHalkasi {
  /** The link's short id, close to the CAMARA signal name; for records and reports only. */
  readonly id: string;
  /** The link's OWN field on AgIz — two links are NEVER collapsed into one. */
  readonly izAlani: keyof AgIz;
  /** The link's OWN field on KararKaydi (kararGunlugu.ts). */
  readonly gunlukAlani: string;
  /**
   * The AgIz field carrying the link's OWN look-back window — for a link without
   * halkada (2., 3., 4., 6.) YOKTUR.
   *
   * Windows, like link fields, are NEVER collapsed into one: even though links 1 and 5 are
   * fed by the same setting (AEGIS_SIMSWAP_WINDOW_HOURS), the distinction of "which question
   * was asked with which window" must not be lost. It is in the registry because of a
   * measured gap: under field-by-field mutation `pencereSaat` was guarded — deleting it
   * turned 2 to 7 tests red — while deleting `devSwapPencereSaat` from BOTH the production
   * and the writing layer left the suite green. So with SIM Swap disabled, the ONLY window
   * on the record had no guard at all.
   */
  readonly pencereIzAlani?: keyof AgIz;
  /** The window's field on KararKaydi; ABSENT for a link that has no window. */
  readonly pencereGunlukAlani?: string;
  /**
   * The distinctive phrases that GENUINELY appear in this link's refusal text. The
   * classifier downstream (scripts/brain/uygulama.mjs, AG_KAPISI_IZLERI) MUST recognise at
   * least one of them; if it does not, a refusal from the network gate looks like an ordinary
   * server refusal and the report never prints its "GÜVENLİK KAPISI ÇALIŞTI" block.
   */
  readonly retIsaretleri: readonly string[];
  /** The link's OWN environment names — the ones config.ts GENUINELY reads from
   * process.env. */
  readonly envler: readonly string[];
  /** The link's AgAyar fields — these MUST enter the contextFor cache key in http.ts. */
  readonly ayarAlanlari: readonly (keyof AgAyar)[];
  /**
   * If the link has been verified against the LIVE endpoint, the DATE of that verification
   * (ISO, YYYY-MM-DD); if it has not, the field is ABSENT.
   *
   * WHY IT IS IN THE REGISTRY: "which link genuinely ran live" is the most expensive claim
   * made to a jury, a mentor and a reader, and until now it lived ONLY in prose. The result
   * was measured: in the same repository, docs/CAMARA.md §1 said "Live since 31 Aug" while
   * §2 said "links 2, 3 and 4 have not run live", and the README diagram labelled CAMARA
   * "never yet called live". All three cannot be true at once.
   *
   * The field is NOT a behaviour switch — the gate does not read it. It only binds the
   * documentation to the code: test/zincirBelgeKademe.test.ts derives the liveness claims
   * from here rather than from the prose.
   */
  readonly canliDogrulandi?: string;
}

/**
 * THE CHAIN'S SINGLE SOURCE (six links, one registry).
 *
 * WHY IT EXISTS: the same class of mistake repeated four rounds running in this repository —
 * a new link was added to the gate while the DOWNSTREAM consumers went un-updated: the
 * decision log's fields, the contextFor cache key in http.ts, Growth Brain's refusal
 * classifier, the environment documentation. The result was SILENT every time: the log lied,
 * an enabled link was served from the cache as disabled, and a refusal from the network gate
 * looked like "an ordinary server refusal". The connections that had tests held; the ones
 * without tests escaped.
 *
 * So a link's identity is no longer implicit knowledge spread across six files but one
 * record: a new link is added HERE, and test/zincirButunlugu.test.ts verifies every consumer
 * against this registry — a missing connection turns RED in the compiler or the tests rather
 * than staying silent
 * kalamaz.
 *
 * CAREFUL: the registry is NOT a behaviour switch. The gate logic — agDogrula and the link
 * layers — does not read this array; the order, the opt-in rules and the fail-closed paths
 * live in the code itself as before. Adding a row here does not make a link RUN; it only
 * declares an existing link's downstream obligations.
 */
export const ZINCIR_HALKALARI: readonly ZincirHalkasi[] = [
  {
    id: "simSwap",
    izAlani: "simSwap",
    gunlukAlani: "simSwapKanali",
    pencereIzAlani: "pencereSaat",
    pencereGunlukAlani: "pencereSaat",
    retIsaretleri: ["AĞ DOĞRULAMASI BAŞARISIZ", "GSMA Open Gateway SIM Swap"],
    envler: ["AEGIS_NAC_TOKEN", "AEGIS_NAC_SIMULATE"],
    ayarAlanlari: ["nacToken", "nacSimulate"],
    canliDogrulandi: "2026-08-28",
  },
  {
    id: "numberVerification",
    izAlani: "nv",
    gunlukAlani: "nvKanali",
    retIsaretleri: ["NUMARA DOĞRULAMASI BAŞARISIZ", "numara doğrulaması aktif"],
    // SIMULATION ONLY: real CAMARA NV requires a device-side OIDC flow (see the file
    // header), so this link has NO token or opt-in environment variable.
    envler: ["AEGIS_NV_SIMULATE"],
    ayarAlanlari: ["nvSimulate"],
    // There is no canliDogrulandi and there cannot be: real NV is a device-side OIDC flow
    // and cannot be called from a server (see docs/CAMARA.md §4). For this link "has not run
    // yet" is not a stale claim but an architectural verdict.
  },
  {
    id: "deviceStatusReachability",
    izAlani: "reach",
    gunlukAlani: "reachKanali",
    retIsaretleri: [
      "CİHAZ ERİŞİLEBİLİRLİĞİ ANORMAL",
      "GSMA Open Gateway Device Reachability Status",
      "cihaz erişilebilirlik kontrolünden",
    ],
    envler: ["AEGIS_REACH_SIMULATE", "AEGIS_REACH_CHECK"],
    ayarAlanlari: ["reachSimulate", "reachCheck"],
    canliDogrulandi: "2026-08-31",
  },
  {
    id: "deviceStatusRoaming",
    izAlani: "loc",
    gunlukAlani: "locKanali",
    retIsaretleri: [
      "KONUM BEKLENMEDİK",
      "GSMA Open Gateway Device Roaming Status",
      "konum kontrolünden",
    ],
    envler: ["AEGIS_LOC_SIMULATE", "AEGIS_EXPECTED_COUNTRY"],
    ayarAlanlari: ["locSimulate", "expectedCountry"],
    canliDogrulandi: "2026-08-31",
  },
  {
    id: "deviceSwap",
    izAlani: "devSwap",
    gunlukAlani: "devSwapKanali",
    // Link 5's window derives from the SAME value as link 1's but is a SEPARATE field.
    pencereIzAlani: "devSwapPencereSaat",
    pencereGunlukAlani: "devSwapPencereSaat",
    retIsaretleri: [
      "CİHAZ DEĞİŞİMİ SAPTANDI",
      "GSMA Open Gateway Device Swap",
      "cihaz değişimi kontrolünden",
    ],
    envler: ["AEGIS_DEVICESWAP_SIMULATE", "AEGIS_DEVICESWAP_CHECK"],
    ayarAlanlari: ["devSwapSimulate", "devSwapCheck"],
    canliDogrulandi: "2026-08-28",
  },
  {
    id: "callForwardingSignal",
    izAlani: "callFwd",
    gunlukAlani: "callFwdKanali",
    retIsaretleri: [
      "ÇAĞRI YÖNLENDİRME AÇIK",
      "GSMA Open Gateway Call Forwarding Signal",
      "çağrı yönlendirme kontrolünden",
    ],
    envler: ["AEGIS_CALLFWD_SIMULATE", "AEGIS_CALLFWD_CHECK"],
    ayarAlanlari: ["callFwdSimulate", "callFwdCheck"],
    canliDogrulandi: "2026-08-28",
  },
] as const;

/**
 * Settings that belong to the whole chain rather than to a link. They stand apart for
 * registry hygiene: writing them under any one link would make them read as that link's
 * "own" environment, and removing the link would delete a chain-wide setting along with it.
 *
 * `simSwapWindowHours` is here deliberately: links 1 AND 5 share the window, though they are
 * separate in the trace
 * alanlara yazar — bkz. AgIz.devSwapPencereSaat).
 */
export const ZINCIR_ORTAK_AYARLARI: readonly (keyof AgAyar)[] = [
  "approverPhone",
  "simSwapWindowHours",
  /**
   * `stepUp` belongs to the WHOLE chain too: it changes the meaning not of one link but of
   * the chain's ENTIRE output — with it on, every refusal in KADEME_UYGUN is bound to a human
   * prompt instead of being flat. Its absence from the registry was a measurable gap: because
   * the guards did not look for it, `AEGIS_STEPUP` appeared nowhere under docs/, and the
   * runbook's fail-closed matrix promised an outcome that no longer held once it was on.
   */
  "stepUp",
] as const;

/** ZINCIR_ORTAK_AYARLARI'nın env karşılıkları (config.ts'te okunan adlar). */
export const ZINCIR_ORTAK_ENVLERI: readonly string[] = [
  "AEGIS_APPROVER_PHONE",
  "AEGIS_SIMSWAP_WINDOW_HOURS",
  "AEGIS_STEPUP",
] as const;

const MEDIUM_WINDOW_HOURS = 24;

/**
 * Test seam. Production builds the channel from the Nokia SDK; tests inject a fake so
 * the refusal paths can be exercised (and mutation-tested) without network access.
 */
let kanalOverride: SimSwapKanali | "reset" | undefined;
export function __setSimSwapKanalForTests(k: SimSwapKanali | undefined): void {
  kanalOverride = k ?? "reset";
  gercekKanal = undefined;
  gercekKanalAnahtari = undefined;
}

let gercekKanal: SimSwapKanali | undefined;
let gercekKanalAnahtari: string | undefined;

/**
 * NaC SDK istemcisi — X-RapidAPI-Host başlığı ELLE eklenir.
 *
 * SDK'nın kendisi bu başlığı GÖNDERMİYOR ve platform onsuz her çağrıya
 * `404 {"message":"API doesn't exists"}` cevabı veriyor: uç nokta yolu ve taban URL
 * doğru olsa bile istek hiçbir API'ye eşlenmiyor. Ölçülerek bulundu — aynı gövde ve
 * aynı anahtarla, yalnız bu başlık eklendiğinde yanıt `200 {"swapped":true}` oluyor.
 *
 * Değer platformun kendi belgesindeki sabittir (Nokia API Hub · "Getting client
 * credentials" bölümündeki curl örnekleri). SDK ileride başlığı kendisi göndermeye
 * başlarsa bu satır zararsız biçimde aynı değeri tekrar yazar.
 */
const RAPIDAPI_HOST = "network-as-code.nokia.rapidapi.com";

export function nacIstemciSecenekleri(token: string): {
  apiKey: string;
  rapidapiHost: string;
  headers: Record<string, string>;
} {
  /**
   * HOST İKİ YOLDAN DA VERİLİR ve bu bilinçli bir fazlalıktır.
   *
   * `rapidapiHost` SDK'nın kendi desteklediği seçenektir; Nokia'dan (Aleksi Puranen,
   * 31.08.2026) gelen resmî cevap bunu kullanmamızı söyledi ve SDK'nın host'u
   * kendiliğinden göndermemesinin bir eksiklik olduğunu, iletildiğini doğruladı.
   *
   * Elle konan başlık yine de kalıyor: bu kod tabanının canlıda ÖLÇEREK doğruladığı
   * yol oydu ve hiçbir maliyeti yok. SDK bu konuda bir kez zaten eksik çıktı; aynı
   * yerde ikinci bir sürprizin bedeli, kapının üretimde her çağrıda "ağ yanıtsız"
   * diyerek kapalı arızaya gitmesi olurdu — harcama hiç onaylanmaz ve sebebi aylarca
   * anlaşılmaz. İkisi de aynı değeri taşıdığı için çelişme ihtimali yok.
   */
  return {
    apiKey: token,
    rapidapiHost: RAPIDAPI_HOST,
    headers: { "X-RapidAPI-Host": RAPIDAPI_HOST },
  };
}

/** Üretim istemcisiyle BİREBİR aynı tip: aşağıdaki test dikişi tipi gevşetmez. */
type NacIstemci = import("network-as-code").NetworkAsCodeApiClient;

/**
 * SDK İSTEMCİSİ İÇİN TEST DİKİŞİ — `__set*KanalForTests` yetmediği için var.
 *
 * O dikişler UYARLANMIŞ kanalı (SimSwapKanali vb.) değiştirir, yani CAMARA gövdesini
 * boolean'a çeviren asıl kodu ATLAR. Zincirin tek canlı fail-open'ı tam orada yaşadı:
 * SIM-Swap uyarlayıcısı `res.swapped === true` diyordu, bozuk bir gövde ({} / "true" /
 * null / 1) sessizce "SIM DEĞİŞMEMİŞ"e çevriliyordu ve hiçbir birim testi kızarmıyordu —
 * çünkü hepsi sahte KANAL enjekte ediyor, sahte GÖVDE değil.
 *
 * Bu fabrika ile testler gerçek uyarlayıcı kapanışlarını sahte bir SDK istemcisi üzerinden
 * koşturur: bozuk gövde matrisi ağa çıkmadan, üretimdeki asıl kodla sınanır.
 */
let nacIstemciFabrikasi: ((token: string) => Promise<NacIstemci>) | undefined;
export function __setNacIstemciFabrikasiForTests(
  fabrika: ((token: string) => Promise<NacIstemci>) | undefined
): void {
  nacIstemciFabrikasi = fabrika;
  // Önbellekli kanallar ESKİ istemcinin kapanışını taşır; hepsi düşürülmezse dikiş sızar.
  gercekKanal = undefined;
  gercekKanalAnahtari = undefined;
  gercekErisimKanal = undefined;
  gercekErisimAnahtari = undefined;
  gercekKonumKanal = undefined;
  gercekKonumAnahtari = undefined;
  gercekCihazDegisimKanal = undefined;
  gercekCihazDegisimAnahtari = undefined;
  gercekCagriYonlendirmeKanal = undefined;
  gercekCagriYonlendirmeAnahtari = undefined;
}

async function nacIstemci(token: string): Promise<NacIstemci> {
  if (nacIstemciFabrikasi) return nacIstemciFabrikasi(token);
  const { NetworkAsCodeApiClient } = await import("network-as-code");
  return new NetworkAsCodeApiClient(nacIstemciSecenekleri(token));
}

/**
 * The SDK is imported lazily: deployments without a NaC token never load it, and a
 * broken optional dependency cannot take down the stdio server at startup.
 *
 * The cached channel is keyed on token + phone. An unkeyed singleton would bake the
 * FIRST caller's phone number into the closure forever, so rotating the approver
 * number (or any future per-tenant config) would silently keep verifying the old SIM.
 */
async function kanalGetir(ayar: AgAyar): Promise<SimSwapKanali> {
  if (kanalOverride && kanalOverride !== "reset") return kanalOverride;
  const anahtar = `${ayar.nacToken}\u0000${ayar.approverPhone}`;
  if (gercekKanal && gercekKanalAnahtari === anahtar) return gercekKanal;
  const client = await nacIstemci(ayar.nacToken!);
  const phoneNumber = ayar.approverPhone!;
  gercekKanal = {
    verifySimSwap: async (maxAgeHours: number) => {
      // CAMARA sim-swap check: maxAge is in hours (1–2400). Bounded tightly: the SDK's
      // defaults (60s timeout × 3 attempts) would stall an approval for ~3 minutes when
      // the NaC endpoint is unreachable — fail closed FAST instead.
      const res = await client.simSwap.check(
        { phoneNumber, maxAge: maxAgeHours },
        { timeoutInSeconds: 10, maxRetries: 1 }
      );
      /**
       * `swapped` SDK tipinde zorunlu boolean, ama tip garantisi ÇALIŞMA ZAMANI garantisi
       * DEĞİLDİR: {"swapped":"true"} (string), {} (alan yok), {"swapped":null}, {"swapped":1}
       * gibi bir gövde eski `=== true` kısayolundan sessizce false çıkıyordu — yani
       * "SIM DEĞİŞMEMİŞ" sayılıyor ve harcama GEÇİYORDU. undefined = "yanıt okunamadı",
       * çağıran onu kapalı arızaya çevirir (halka 3/4/5/6 ile aynı sözleşme).
       */
      return typeof res.swapped === "boolean" ? res.swapped : undefined;
    },
  };
  gercekKanalAnahtari = anahtar;
  return gercekKanal;
}

/* ── Halka 3: gerçek kanal (Device Reachability) ──────────────────────────────── */

let erisimOverride: ErisilebilirlikKanali | "reset" | undefined;
export function __setErisimKanalForTests(k: ErisilebilirlikKanali | undefined): void {
  erisimOverride = k ?? "reset";
  gercekErisimKanal = undefined;
  gercekErisimAnahtari = undefined;
}

let gercekErisimKanal: ErisilebilirlikKanali | undefined;
let gercekErisimAnahtari: string | undefined;

/**
 * SIM-Swap kanalıyla BİREBİR aynı iskelet: tembel import (token'sız kurulumlar SDK'yı hiç
 * yüklemez), token+telefon ile anahtarlanmış önbellek (anahtarsız tekil, İLK çağıranın
 * numarasını kapanışa gömer ve numara döndürüldüğünde sessizce eski hattı sorgular),
 * 10 sn timeout / 1 retry (SDK varsayılanı 60 sn × 3 deneme; bir onayı ~3 dakika
 * askıda bırakır — kapalı arızaya HIZLI gitmek gerekir).
 */
async function erisimKanaliGetir(ayar: AgAyar): Promise<ErisilebilirlikKanali> {
  if (erisimOverride && erisimOverride !== "reset") return erisimOverride;
  const anahtar = `${ayar.nacToken}\u0000${ayar.approverPhone}`;
  if (gercekErisimKanal && gercekErisimAnahtari === anahtar) return gercekErisimKanal;
  const client = await nacIstemci(ayar.nacToken!);
  const phoneNumber = ayar.approverPhone!;
  gercekErisimKanal = {
    cihazErisilebilirMi: async () => {
      const res = await client.deviceStatus.retrieveReachabilityStatus(
        { device: { phoneNumber } },
        { timeoutInSeconds: 10, maxRetries: 1 }
      );
      /**
       * `reachable` SDK tipinde zorunlu boolean, ama tip garantisi bir ÇALIŞMA ZAMANI
       * garantisi değildir: gövde beklenenden başka gelirse "erişilemez" varsaymak da
       * "erişilebilir" varsaymak da yanlış olur. undefined = "yanıt okunamadı".
       */
      return typeof res.reachable === "boolean" ? res.reachable : undefined;
    },
  };
  gercekErisimAnahtari = anahtar;
  return gercekErisimKanal;
}

/* ── Halka 4: gerçek kanal (Location — roaming ülkesi) ────────────────────────── */

let konumOverride: KonumKanali | "reset" | undefined;
export function __setKonumKanalForTests(k: KonumKanali | undefined): void {
  konumOverride = k ?? "reset";
  gercekKonumKanal = undefined;
  gercekKonumAnahtari = undefined;
}

let gercekKonumKanal: KonumKanali | undefined;
let gercekKonumAnahtari: string | undefined;

/** Halka 3'ün kanalıyla aynı sözleşme; yalnız sorulan uç nokta farklı. */
async function konumKanaliGetir(ayar: AgAyar): Promise<KonumKanali> {
  if (konumOverride && konumOverride !== "reset") return konumOverride;
  const anahtar = `${ayar.nacToken}\u0000${ayar.approverPhone}`;
  if (gercekKonumKanal && gercekKonumAnahtari === anahtar) return gercekKonumKanal;
  const client = await nacIstemci(ayar.nacToken!);
  const phoneNumber = ayar.approverPhone!;
  gercekKonumKanal = {
    ulkeDurumu: async () => {
      const res = await client.deviceStatus.checkRoaming(
        { device: { phoneNumber } },
        { timeoutInSeconds: 10, maxRetries: 1 }
      );
      return {
        yurtDisinda: typeof res.roaming === "boolean" ? res.roaming : undefined,
        // Ham liste BURADAN ÖTEYE GEÇMEZ: karar mantığı onu yalnız karşılaştırmada
        // kullanır, hiçbir metne ve ize yazmaz (bkz. dosya başı, Halka 4).
        ulkeler: Array.isArray(res.countryName) ? res.countryName : undefined,
      };
    },
  };
  gercekKonumAnahtari = anahtar;
  return gercekKonumKanal;
}

/* ── Halka 5: gerçek kanal (Device Swap) ──────────────────────────────────────── */

let cihazDegisimOverride: CihazDegisimKanali | "reset" | undefined;
export function __setCihazDegisimKanalForTests(k: CihazDegisimKanali | undefined): void {
  cihazDegisimOverride = k ?? "reset";
  gercekCihazDegisimKanal = undefined;
  gercekCihazDegisimAnahtari = undefined;
}

let gercekCihazDegisimKanal: CihazDegisimKanali | undefined;
let gercekCihazDegisimAnahtari: string | undefined;

/**
 * SIM-Swap kanalıyla BİREBİR aynı iskelet ve aynı gerekçeler: tembel import,
 * token+telefon ile anahtarlanmış önbellek, 10 sn timeout / 1 retry (SDK varsayılanı
 * 60 sn × 3 deneme bir onayı ~3 dakika askıda bırakır).
 *
 * Uç nokta gerçekten ikiz: `deviceSwap.check({ phoneNumber, maxAge })` → `{ swapped }`.
 */
async function cihazDegisimKanaliGetir(ayar: AgAyar): Promise<CihazDegisimKanali> {
  if (cihazDegisimOverride && cihazDegisimOverride !== "reset") return cihazDegisimOverride;
  const anahtar = `${ayar.nacToken}\u0000${ayar.approverPhone}`;
  if (gercekCihazDegisimKanal && gercekCihazDegisimAnahtari === anahtar) return gercekCihazDegisimKanal;
  const client = await nacIstemci(ayar.nacToken!);
  const phoneNumber = ayar.approverPhone!;
  gercekCihazDegisimKanal = {
    cihazDegistiMi: async (maxAgeHours: number) => {
      const res = await client.deviceSwap.check(
        { phoneNumber, maxAge: maxAgeHours },
        { timeoutInSeconds: 10, maxRetries: 1 }
      );
      /**
       * `swapped` SDK tipinde zorunlu boolean, ama tip garantisi ÇALIŞMA ZAMANI garantisi
       * değildir; okunamayan alan "değişmedi" DEĞİL "bilinmiyor"dur → kapalı arıza.
       *
       * TARİHÇE: burada bir zamanlar "SIM-Swap'taki `=== true` kısayolu bilerek
       * kullanılmaz" yazıyordu. Fark doğru saptanmıştı ama yanlış çözülmüştü — eski halka
       * düzeltilmek yerine sapma BELGELENMİŞTİ, yani zincirin en kritik ve tek canlı
       * koşan halkası okunamayan gövdeyi sessizce "temiz" sayıyordu. Kısayol artık orada
       * da yok: altı halkanın hepsi bu tek sözleşmeyi paylaşır, sapma anlatılacak bir
       * istisna değil kapatılmış bir açıktır.
       */
      return typeof res.swapped === "boolean" ? res.swapped : undefined;
    },
  };
  gercekCihazDegisimAnahtari = anahtar;
  return gercekCihazDegisimKanal;
}

/* ── Halka 6: gerçek kanal (Call Forwarding) ──────────────────────────────────── */

let cagriYonlendirmeOverride: CagriYonlendirmeKanali | "reset" | undefined;
export function __setCagriYonlendirmeKanalForTests(k: CagriYonlendirmeKanali | undefined): void {
  cagriYonlendirmeOverride = k ?? "reset";
  gercekCagriYonlendirmeKanal = undefined;
  gercekCagriYonlendirmeAnahtari = undefined;
}

let gercekCagriYonlendirmeKanal: CagriYonlendirmeKanali | undefined;
let gercekCagriYonlendirmeAnahtari: string | undefined;

/**
 * Diğer halkalarla aynı sözleşme; yalnız sorulan uç nokta farklı.
 *
 * BİLEREK `retrieveUnconditionalCallForwarding` çağrılır, kardeşi
 * `retrieveCallForwarding` DEĞİL: kardeş uç nokta bir dizi döner, SDK belgesi onun için
 * "ana kapsamı aşar, 501 dönebilir" diyor ve dizinin tanınmayan bir üyesi yeni bir
 * kapalı-arıza yolu açardı. Sorduğumuz soru zaten tek boolean'lık: koşulsuz yönlendirme
 * açık mı? Yönlendirmenin HANGİ numaraya yapıldığı ne sorulur ne alınır (PII yok).
 */
async function cagriYonlendirmeKanaliGetir(ayar: AgAyar): Promise<CagriYonlendirmeKanali> {
  if (cagriYonlendirmeOverride && cagriYonlendirmeOverride !== "reset") return cagriYonlendirmeOverride;
  const anahtar = `${ayar.nacToken}\u0000${ayar.approverPhone}`;
  if (gercekCagriYonlendirmeKanal && gercekCagriYonlendirmeAnahtari === anahtar) {
    return gercekCagriYonlendirmeKanal;
  }
  const client = await nacIstemci(ayar.nacToken!);
  const phoneNumber = ayar.approverPhone!;
  gercekCagriYonlendirmeKanal = {
    kosulsuzYonlendirmeAcikMi: async () => {
      const res = await client.callForwardingSignal.retrieveUnconditionalCallForwarding(
        { phoneNumber },
        { timeoutInSeconds: 10, maxRetries: 1 }
      );
      // `active` tipte OPSİYONEL: yokluğu "yönlendirme kapalı" değil "bilinmiyor"dur.
      return typeof res.active === "boolean" ? res.active : undefined;
    },
  };
  gercekCagriYonlendirmeAnahtari = anahtar;
  return gercekCagriYonlendirmeKanal;
}

/**
 * Beklenen ülkeyi normalize eder: yalnız ISO 3166-1 alpha-2 (iki harf) kabul edilir.
 * `undefined` = değer kullanılamaz; çağıran bunu kapalı arızaya çevirir. Ham değer
 * hiçbir yere yazılmaz, yalnız normalize edilmiş kod dışarı çıkabilir.
 */
function ulkeNormalize(ham: string | undefined): string | undefined {
  const t = ham?.trim();
  return t && /^[A-Za-z]{2}$/.test(t) ? t.toUpperCase() : undefined;
}

/**
 * Masks all but the edges of the approver number, so prompts never leak it in full.
 * The guard covers up to 6 characters: at 5–6 the head and tail slices would overlap
 * and reveal every digit.
 *
 * DIŞA AÇIK OLMASININ TEK SEBEBİ TESTTİR: bu kelepçenin bekçisi yoktu, çünkü depodaki
 * her `approverPhone` fikstürü 13 karakterlik tek bir biçim kullanıyor ve kelepçe
 * düşerse yalnız KISA numaralarda kırılıyor — uzunluk 6'da girdinin tamamı açığa çıkar,
 * 5'te `"*".repeat(-1)` RangeError fırlatır. Bu çıktı hem istem kanıt satırına, hem
 * karar günlüğüne, hem de ajana dönen ret metnine giriyor ve ajan yolunda ikinci bir
 * maskeleme katmanı yok: buradaki sessiz bir gerileme ham numarayı doğrudan sızdırır.
 */
export function maskele(phone: string): string {
  return phone.length <= 6 ? "***" : phone.slice(0, 4) + "*".repeat(phone.length - 6) + phone.slice(-2);
}

/**
 * CAMARA accepts maxAge of 1–2400 hours. Out-of-range or malformed configuration must
 * not become a permanent opaque refusal (a 5000h window would 400 on every approval),
 * nor a silent near-zero window (0.01h would wave a 2-hour-old swap through) — clamp
 * to the API's own range and fall back to the 72h default when the value is unusable.
 */
function pencereNormalize(ham: number | undefined): number {
  if (!Number.isFinite(ham as number) || (ham as number) < 1) return 72;
  return Math.min(2400, Math.round(ham as number));
}

/** Risk tier → lookback window: "medium" tightens to 24h, "high" uses the configured window. */
function pencereSec(ayar: AgAyar, risk: AgRisk): number {
  const yapilandirilan = pencereNormalize(ayar.simSwapWindowHours);
  return risk === "medium" ? Math.min(MEDIUM_WINDOW_HOURS, yapilandirilan) : yapilandirilan;
}

/**
 * SİMÜLASYON kanalı: jüri/demo ortamı NaC token'sız çalışsın diye. Gerçek SDK'ya HİÇ
 * dokunulmaz (import bile edilmez).
 *
 * Ürettiği HER metin — kanıt satırı, ret mesajı, stderr uyarısı — açıkça "SİMÜLASYON"
 * ibaresi taşır ve gerçek ağ sorgusu yapılmadığını söyler; çıktı hiçbir zaman gerçek
 * ağ doğrulaması gibi sunulamaz.
 *
 * Fail-closed sözleşmesi aynen geçerlidir: onaylayıcı numarası simülasyonda da zorunlu
 * (maskeleme yolları gerçek akışla birebir), tanınmayan simülasyon değeri karar anında
 * Türkçe hatayla RET. Pencere hesabı (medium 24s / high yapılandırılan) gerçek akışla
 * aynı koddan geçer, böylece demo metinleri gerçek katman davranışını gösterir.
 */
function simDogrula(ayar: AgAyar, risk: AgRisk, sim: string): AgKarar {
  if (ayar.nacToken) {
    /**
     * Çelişkili yapılandırma: gerçek token VE simülasyon birlikte. Fail-closed ilkesi
     * gereği belirsizlikte gevşek kanal SEÇİLMEZ — reddedilir. (Uyarı-verip-devam
     * modeli, demodan kalan bir env kalıntısının gerçek ağ doğrulamasını sessizce
     * tiyatroya çevirmesine izin veriyordu.)
     */
    return {
      engel:
        "Reddedildi [SİMÜLASYON]: AEGIS_NAC_TOKEN ve AEGIS_NAC_SIMULATE birlikte tanımlı — " +
        "çelişkili yapılandırma. Gerçek ağ doğrulaması isteniyorsa AEGIS_NAC_SIMULATE kaldırılmalı, " +
        "demo isteniyorsa token kaldırılmalı. Güvenlik gereği belirsiz yapılandırmada harcama artışı uygulanmaz.",
      kanit: [],
      // Hiçbir kanal sorgulanmadı: yapılandırma çeliştiği için karar hiç verilemedi.
      iz: { simSwap: "calismadi", retNedeni: "yapilandirma-celiskili" },
    };
  }
  if (sim !== "temiz" && sim !== "degisti") {
    return {
      engel:
        `Reddedildi [SİMÜLASYON]: AEGIS_NAC_SIMULATE değeri tanınmadı (değer, sır ihtimaline karşı burada gösterilmez) — geçerli değerler ` +
        `"temiz" | "degisti". Güvenlik gereği anlaşılamayan yapılandırmada harcama artışı uygulanmaz ` +
        `(kapalı arıza).`,
      kanit: [],
      iz: { simSwap: "calismadi", retNedeni: "simulasyon-degeri-tanimsiz" },
    };
  }
  if (!ayar.approverPhone) {
    return {
      engel:
        "Reddedildi [SİMÜLASYON]: simülasyon kanalı aktif ama AEGIS_APPROVER_PHONE boş. " +
        "Onaylayıcının numarası simülasyonda da zorunludur; güvenlik gereği harcama artışı uygulanmaz.",
      kanit: [],
      iz: { simSwap: "calismadi", retNedeni: "onaylayici-numarasi-yok" },
    };
  }
  const pencere = pencereSec(ayar, risk);
  const maskeli = maskele(ayar.approverPhone);
  if (sim === "degisti") {
    return {
      engel:
        `Reddedildi [SİMÜLASYON]: AĞ DOĞRULAMASI BAŞARISIZ (SİMÜLE) — onaylayıcının ` +
        `(${maskeli}) SIM kartı son ${pencere} saat içinde değişmiş SAYILDI ` +
        `(AEGIS_NAC_SIMULATE=degisti; gerçek ağ sorgusu YAPILMADI). Gerçek akışta bu, hesap ele ` +
        `geçirme saldırılarının tipik işaretidir; onay istemi hiç gösterilmedi ve harcama artışı ` +
        `uygulanmaz. Kullanıcıya bunun bir SİMÜLASYON olduğunu MUTLAKA bildir.`,
      kanit: [],
      iz: { simSwap: "simulasyon", pencereSaat: pencere, maskeliNumara: maskeli, retNedeni: "sim-degisti" },
    };
  }
  return {
    kanit: [
      `Ağ doğrulaması [SİMÜLASYON]: SIM değişimi yok (son ${pencere} saat, ` +
        `${maskeli}) — simüle kanal (AEGIS_NAC_SIMULATE=temiz), ` +
        `gerçek ağ sorgusu YAPILMADI`,
    ],
    iz: { simSwap: "simulasyon", pencereSaat: pencere, maskeliNumara: maskeli },
  };
}

/**
 * Zincirin 2. halkası: Number Verification — YALNIZ SİMÜLASYON.
 *
 * Ne zaman koşar: SADECE "high" katmanda ve SADECE AEGIS_NV_SIMULATE tanımlıysa.
 * Koşmadığında `undefined` döner (kanıt satırı bile üretmez) — medium katmanda halka
 * hiç yoktur, dolayısıyla değeri de doğrulanmaz; bu bir gevşeme değildir, çünkü o
 * katmanda halkanın verebileceği tek karar zaten yoktur.
 *
 * Kapalı arıza sözleşmesi SIM-Swap halkasıyla aynıdır: onaylayıcı numarası zorunlu,
 * tanınmayan değer karar anında RET (ham değer, sır olabileceği için metne
 * YANKILANMAZ). Ürettiği her metin "SİMÜLASYON" ibaresi taşır ve gerçek sorgu
 * yapılmadığını açıkça söyler.
 */
function nvKatmani(ayar: AgAyar, risk: AgRisk): NvSonuc | undefined {
  const nv = ayar.nvSimulate?.trim();
  if (!nv || !halkaKosarMi(risk, "nv")) return undefined;

  if (nv !== "dogrulandi" && nv !== "uyusmadi") {
    return {
      engel:
        `Reddedildi [SİMÜLASYON]: AEGIS_NV_SIMULATE değeri tanınmadı (değer, sır ihtimaline karşı ` +
        `burada gösterilmez) — geçerli değerler "dogrulandi" | "uyusmadi". Güvenlik gereği ` +
        `anlaşılamayan yapılandırmada harcama artışı uygulanmaz (kapalı arıza).`,
      kanit: [],
      nv: "calismadi",
      retNedeni: "simulasyon-degeri-tanimsiz",
    };
  }
  if (!ayar.approverPhone) {
    return {
      engel:
        "Reddedildi [SİMÜLASYON]: numara doğrulaması aktif ama AEGIS_APPROVER_PHONE boş. " +
        "Doğrulanacak numara olmadan bu halka çalışamaz; güvenlik gereği harcama artışı uygulanmaz.",
      kanit: [],
      nv: "calismadi",
      retNedeni: "onaylayici-numarasi-yok",
    };
  }
  const maskeli = maskele(ayar.approverPhone);
  if (nv === "uyusmadi") {
    return {
      engel:
        `Reddedildi [SİMÜLASYON]: NUMARA DOĞRULAMASI BAŞARISIZ (SİMÜLE) — onay isteği sahibin ` +
        `gerçek cihazından gelmiyor SAYILDI (${maskeli}; ` +
        `AEGIS_NV_SIMULATE=uyusmadi, gerçek ağ sorgusu YAPILMADI). Gerçek akışta bu, onayı ` +
        `cevaplayanın hattın sahibi olmadığı anlamına gelir — SIM Swap kontrolü temiz olsa bile ` +
        `onay istemi gösterilmez ve harcama artışı uygulanmaz. Kullanıcıya bunun bir SİMÜLASYON ` +
        `olduğunu MUTLAKA bildir.`,
      kanit: [],
      nv: "simulasyon",
      maskeliNumara: maskeli,
      retNedeni: "nv-uyusmadi",
    };
  }
  return {
    kanit: [
      `Numara doğrulaması [SİMÜLASYON]: onay isteği hat sahibinin cihazından geliyor SAYILDI ` +
        `(${maskeli}) — simüle kanal (AEGIS_NV_SIMULATE=dogrulandi), ` +
        `gerçek CAMARA Number Verification sorgusu YAPILMADI (cihaz-taraflı OIDC gerektirir)`,
    ],
    nv: "simulasyon",
    maskeliNumara: maskeli,
  };
}

/**
 * Zincirin 3. halkası: Device Reachability.
 *
 * Ne zaman koşar: SADECE "high" katmanda ve SADECE bir kanal yapılandırılmışsa
 * (AEGIS_REACH_SIMULATE ya da NaC token'ı). Hiç yapılandırılmamışsa `undefined`
 * döner — iz alanı bile yazılmaz, çünkü "kapali" bilinçli bir kapatma beyanıdır,
 * hiç istenmemiş bir halkanın sessizliği değil.
 *
 * Fail-closed sözleşmesi diğer halkalarla aynıdır: onaylayıcı numarası zorunlu,
 * tanınmayan simülasyon değeri RET (ham değer YANKILANMAZ), yanıtsız/okunamayan
 * CAMARA cevabı RET, "erişilemez" RET.
 */
async function erisilebilirlikKatmani(ayar: AgAyar, risk: AgRisk): Promise<HalkaSonuc | undefined> {
  if (!halkaKosarMi(risk, "reach")) return undefined;
  const sim = ayar.reachSimulate?.trim();
  const gercekAcik = Boolean(ayar.nacToken && ayar.reachCheck);
  if (!sim && !ayar.nacToken) return undefined;

  if (sim) {
    /**
     * Çelişki ölçütü bilerek "token var mı" DEĞİL, "gerçek kanal AÇIK mı"dır: halka
     * opt-in olduğu için AEGIS_REACH_CHECK kapalıyken sorgulanacak gerçek bir kanal
     * yoktur, dolayısıyla simülasyon hiçbir gerçek doğrulamayı tiyatroya çevirmez.
     * Gerçek kanal açıkken ikisi birden tanımlıysa belirsizlikte gevşek kanal SEÇİLMEZ.
     */
    if (gercekAcik) {
      return {
        engel:
          "Reddedildi [SİMÜLASYON]: AEGIS_REACH_CHECK açık (gerçek erişilebilirlik sorgusu) ve " +
          "AEGIS_REACH_SIMULATE birlikte tanımlı — çelişkili yapılandırma. Gerçek sorgu isteniyorsa " +
          "simülasyon kaldırılmalı, demo isteniyorsa AEGIS_REACH_CHECK kapatılmalı. Güvenlik gereği " +
          "belirsiz yapılandırmada harcama artışı uygulanmaz.",
        kanit: [],
        halka: "calismadi",
        retNedeni: "yapilandirma-celiskili",
      };
    }
    if (sim !== "erisilebilir" && sim !== "anormal") {
      return {
        engel:
          `Reddedildi [SİMÜLASYON]: AEGIS_REACH_SIMULATE değeri tanınmadı (değer, sır ihtimaline ` +
          `karşı burada gösterilmez) — geçerli değerler "erisilebilir" | "anormal". Güvenlik gereği ` +
          `anlaşılamayan yapılandırmada harcama artışı uygulanmaz (kapalı arıza).`,
        kanit: [],
        halka: "calismadi",
        retNedeni: "simulasyon-degeri-tanimsiz",
      };
    }
    if (!ayar.approverPhone) {
      return {
        engel:
          "Reddedildi [SİMÜLASYON]: cihaz erişilebilirliği kontrolü aktif ama AEGIS_APPROVER_PHONE boş. " +
          "Sorgulanacak numara olmadan bu halka çalışamaz; güvenlik gereği harcama artışı uygulanmaz.",
        kanit: [],
        halka: "calismadi",
        retNedeni: "onaylayici-numarasi-yok",
      };
    }
    const maskeli = maskele(ayar.approverPhone);
    if (sim === "anormal") {
      return {
        engel:
          `Reddedildi [SİMÜLASYON]: CİHAZ ERİŞİLEBİLİRLİĞİ ANORMAL (SİMÜLE) — onaylayıcının ` +
          `(${maskeli}) cihazı ağdan erişilemez SAYILDI (AEGIS_REACH_SIMULATE=anormal; gerçek ağ ` +
          `sorgusu YAPILMADI). Gerçek akışta bu, onayı cevaplayan tarafın hattıyla ulaşılamadığı ` +
          `anlamına gelir; kademeli doğrulama mümkün olmadığı için onay istemi gösterilmez ve harcama ` +
          `artışı uygulanmaz. Kullanıcıya bunun bir SİMÜLASYON olduğunu MUTLAKA bildir.`,
        kanit: [],
        halka: "simulasyon",
        maskeliNumara: maskeli,
        retNedeni: "cihaz-erisilemez",
      };
    }
    return {
      kanit: [
        `Cihaz erişilebilirliği [SİMÜLASYON]: onaylayıcının hattı ağdan erişilebilir SAYILDI ` +
          `(${maskeli}) — simüle kanal (AEGIS_REACH_SIMULATE=erisilebilir), gerçek ağ sorgusu YAPILMADI`,
      ],
      halka: "simulasyon",
      maskeliNumara: maskeli,
    };
  }

  /**
   * Token var ama halka açılmamış: BİLEREK sorgu yapılmaz. Ret de üretilmez, kanıt
   * satırı da yazılmaz — insan istemine "kontrol etmediğim şey" satırı koymak gürültü
   * olurdu. Beyan yalnız yapısal ize düşer (bkz. HalkaIzi, "kapali").
   */
  if (!gercekAcik) return { kanit: [], halka: "kapali" };

  if (!ayar.approverPhone) {
    return {
      engel:
        "Reddedildi: cihaz erişilebilirliği kontrolü açık (AEGIS_REACH_CHECK) ama " +
        "AEGIS_APPROVER_PHONE boş. Onaylayıcının numarası olmadan ağ kontrolü yapılamaz; " +
        "güvenlik gereği harcama artışı uygulanmaz.",
      kanit: [],
      halka: "calismadi",
      retNedeni: "onaylayici-numarasi-yok",
    };
  }
  const maskeli = maskele(ayar.approverPhone);
  try {
    const kanal = await erisimKanaliGetir(ayar);
    const erisilebilir = await kanal.cihazErisilebilirMi();
    if (erisilebilir === true) {
      return {
        kanit: [
          `Cihaz erişilebilirliği: onaylayıcının hattı ağdan erişilebilir durumda (${maskeli}) — ` +
            `GSMA Open Gateway Device Reachability Status`,
        ],
        halka: "gercek",
        maskeliNumara: maskeli,
      };
    }
    if (erisilebilir === false) {
      return {
        engel:
          `Reddedildi: AĞ DOĞRULAMASI BAŞARISIZ — onaylayıcının (${maskeli}) cihazı şu an ağdan ` +
          `ERİŞİLEMİYOR (GSMA Open Gateway Device Reachability Status). Onayı cevaplayan tarafa hattı ` +
          `üzerinden ulaşılamadığı için kademeli doğrulama yapılamaz; onay istemi hiç gösterilmedi ve ` +
          `harcama artışı uygulanmaz. Cihaz ağa döndüğünde tekrar dene.`,
        kanit: [],
        halka: "gercek",
        maskeliNumara: maskeli,
        retNedeni: "cihaz-erisilemez",
      };
    }
    /**
     * Yanıt geldi ama okunamadı. "Erişilemez" demek yanlış suçlama, "erişilebilir"
     * demek sessiz gevşeme olurdu; ikisi de değil — kontrol cevaplanamadı.
     */
    return {
      engel:
        "Reddedildi: ağ doğrulaması tamamlanamadı — cihaz erişilebilirlik kontrolünden okunabilir " +
        "yanıt alınamadı. Güvenlik gereği cevaplanamayan kontrolde harcama artışı uygulanmaz; " +
        "daha sonra tekrar dene.",
      kanit: [],
      halka: "gercek",
      maskeliNumara: maskeli,
      retNedeni: "ag-yanitsiz",
    };
  } catch (e: any) {
    // Upstream metin ASLA ret mesajına girmez; ayrıntı numara maskelenerek stderr'e.
    const detay = String(e?.message ?? e).split(ayar.approverPhone).join(maskeli);
    console.error(`[aegis] cihaz erişilebilirlik hatası (${maskeli}): ${detay}`);
    return {
      engel:
        "Reddedildi: ağ doğrulaması tamamlanamadı — cihaz erişilebilirlik kontrolünden yanıt " +
        "alınamadı. Güvenlik gereği yanıtsız kontrolde harcama artışı uygulanmaz; daha sonra tekrar " +
        "dene. Sorun sürerse operatör sunucu günlüklerine bakmalı (ayrıntı oraya yazıldı).",
      kanit: [],
      halka: "gercek",
      maskeliNumara: maskeli,
      retNedeni: "ag-yanitsiz",
    };
  }
}

/**
 * Zincirin 4. halkası: Location — "hat beklenen ülkenin dışında mı?".
 *
 * Beklenti UYDURULMAZ: AEGIS_EXPECTED_COUNTRY yoksa halka koşmaz ve "kapali" yazar.
 * Bugünün tarihi/varsayılan bir ülke türetmek, cevabı her zaman "temiz" çıkaran sessiz
 * bir güvenlik kaybı olurdu.
 *
 * Sıra bilinçlidir: beklenti YOKSA halka zaten karar veremez, bu yüzden çelişki ve
 * simülasyon-değeri doğrulamaları o durumda hiç çalıştırılmaz — koşmayan bir halkanın
 * yapılandırmasına bakıp harcamayı reddetmek, hiçbir güvenlik kazancı olmayan bir ret
 * üretirdi (aynı gerekçeyle NV de medium katmanda değerini doğrulamaz).
 */
async function konumKatmani(ayar: AgAyar, risk: AgRisk): Promise<HalkaSonuc | undefined> {
  if (!halkaKosarMi(risk, "loc")) return undefined;
  const sim = ayar.locSimulate?.trim();
  if (!sim && !ayar.nacToken) return undefined;

  const hamUlke = ayar.expectedCountry?.trim();
  if (!hamUlke) {
    if (sim) {
      // Operatör halkayı açıkça istemiş ama beklentiyi vermemiş: sessiz kalmak, demoyu
      // sessizce çalışmaz hâle getirirdi. Karar akışı ETKİLENMEZ, yalnız stderr'e yazılır.
      console.error(
        "[aegis] AEGIS_LOC_SIMULATE tanımlı ama AEGIS_EXPECTED_COUNTRY yok — " +
          "konum halkası KOŞMADI (beklenen ülke uydurulmaz)."
      );
    }
    return { kanit: [], halka: "kapali" };
  }

  if (sim && ayar.nacToken) {
    return {
      engel:
        "Reddedildi [SİMÜLASYON]: AEGIS_NAC_TOKEN ve AEGIS_LOC_SIMULATE birlikte tanımlı — " +
        "çelişkili yapılandırma. Gerçek konum doğrulaması isteniyorsa AEGIS_LOC_SIMULATE " +
        "kaldırılmalı, demo isteniyorsa token kaldırılmalı. Güvenlik gereği belirsiz yapılandırmada " +
        "harcama artışı uygulanmaz.",
      kanit: [],
      halka: "calismadi",
      retNedeni: "yapilandirma-celiskili",
    };
  }

  const beklenen = ulkeNormalize(hamUlke);
  if (!beklenen) {
    return {
      engel:
        "Reddedildi: AEGIS_EXPECTED_COUNTRY değeri ISO 3166-1 alpha-2 (iki harf, ör. TR) " +
        "biçiminde değil (değer, sır ihtimaline karşı burada gösterilmez). Beklenen ülke " +
        "anlaşılamadığı için konum halkası çalışamaz; güvenlik gereği harcama artışı uygulanmaz " +
        "(kapalı arıza).",
      kanit: [],
      halka: "calismadi",
      retNedeni: "beklenen-ulke-gecersiz",
    };
  }

  if (sim) {
    if (sim !== "beklenen" && sim !== "beklenmedik") {
      return {
        engel:
          `Reddedildi [SİMÜLASYON]: AEGIS_LOC_SIMULATE değeri tanınmadı (değer, sır ihtimaline ` +
          `karşı burada gösterilmez) — geçerli değerler "beklenen" | "beklenmedik". Güvenlik gereği ` +
          `anlaşılamayan yapılandırmada harcama artışı uygulanmaz (kapalı arıza).`,
        kanit: [],
        halka: "calismadi",
        retNedeni: "simulasyon-degeri-tanimsiz",
      };
    }
    if (!ayar.approverPhone) {
      return {
        engel:
          "Reddedildi [SİMÜLASYON]: konum doğrulaması aktif ama AEGIS_APPROVER_PHONE boş. " +
          "Sorgulanacak numara olmadan bu halka çalışamaz; güvenlik gereği harcama artışı uygulanmaz.",
        kanit: [],
        halka: "calismadi",
        retNedeni: "onaylayici-numarasi-yok",
      };
    }
    const maskeliSim = maskele(ayar.approverPhone);
    if (sim === "beklenmedik") {
      return {
        engel:
          `Reddedildi [SİMÜLASYON]: KONUM BEKLENMEDİK (SİMÜLE) — onaylayıcının (${maskeliSim}) hattı ` +
          `beklenen ülkenin (${beklenen}) DIŞINDA SAYILDI (AEGIS_LOC_SIMULATE=beklenmedik; gerçek ağ ` +
          `sorgusu YAPILMADI). Gerçek akışta bu, harcamayı onaylayan hattın beklenmedik bir coğrafyada ` +
          `olduğu anlamına gelir; onay istemi gösterilmez ve harcama artışı uygulanmaz. Kullanıcıya ` +
          `bunun bir SİMÜLASYON olduğunu MUTLAKA bildir.`,
        kanit: [],
        halka: "simulasyon",
        maskeliNumara: maskeliSim,
        retNedeni: "konum-beklenmedik",
      };
    }
    return {
      kanit: [
        `Konum doğrulaması [SİMÜLASYON]: onaylayıcının hattı beklenen ülkede (${beklenen}) SAYILDI ` +
          `(${maskeliSim}) — simüle kanal (AEGIS_LOC_SIMULATE=beklenen), gerçek ağ sorgusu YAPILMADI`,
      ],
      halka: "simulasyon",
      maskeliNumara: maskeliSim,
    };
  }

  if (!ayar.approverPhone) {
    return {
      engel:
        "Reddedildi: konum doğrulaması yapılandırılmış (AEGIS_EXPECTED_COUNTRY) ama " +
        "AEGIS_APPROVER_PHONE boş. Onaylayıcının numarası olmadan ağ kontrolü yapılamaz; " +
        "güvenlik gereği harcama artışı uygulanmaz.",
      kanit: [],
      halka: "calismadi",
      retNedeni: "onaylayici-numarasi-yok",
    };
  }
  const maskeli = maskele(ayar.approverPhone);
  try {
    const kanal = await konumKanaliGetir(ayar);
    const durum = await kanal.ulkeDurumu();
    if (typeof durum.yurtDisinda !== "boolean") {
      return {
        engel:
          "Reddedildi: ağ doğrulaması tamamlanamadı — konum kontrolünden okunabilir yanıt alınamadı. " +
          "Güvenlik gereği cevaplanamayan kontrolde harcama artışı uygulanmaz; daha sonra tekrar dene.",
        kanit: [],
        halka: "gercek",
        maskeliNumara: maskeli,
        retNedeni: "ag-yanitsiz",
      };
    }
    /**
     * ÜLKE KARŞILAŞTIRMASI ROAMING BAYRAĞINDAN ÖNCE VE ONDAN BAĞIMSIZ YAPILIR.
     *
     * Önceki hâlde bayrak dalı kapıyı ikiye bölüyordu ve yalnız biri korunuyordu:
     * `yurtDisinda === false` dalı `durum.ulkeler`e HİÇ bakmadan temiz dönüyor, üstelik
     * kanıt satırı "beklenen ülkeyle çelişen bir coğrafya yok" diye kodun hiç
     * doğrulamadığı bir şeyi beyan ediyordu. Ölçülerek gösterildi:
     * {yurtDisinda:false, ulkeler:["NL"]} GEÇİYORDU. Ağ "ana şebekede" derken bir yandan
     * yabancı ülke bildiriyorsa bu, kapının tam da bakması gereken çelişkidir; hangi
     * alanın onu ele verdiği önemli değildir.
     *
     * BOŞ/OKUNAMAYAN GİRDİ DE DÜŞÜRÜLMEZ. Eski `.filter(u => u.length > 0)`,
     * "okunamayan alan = temiz" kalıbını buraya geri sokuyordu: [""] tek başına RET
     * alırken ["TR",""] geçiyordu — aynı "bilinmiyor" anlamı, gövdedeki temsiline göre
     * bazen ret bazen temiz üretiyordu. Artık okunamayan girdi beklenene eşit olmadığı
     * için doğal olarak RET'e düşer.
     */
    const ulkeler = (durum.ulkeler ?? []).map((u) => String(u ?? "").trim().toUpperCase());

    if (durum.yurtDisinda === false && !ulkeler.length) {
      /**
       * Hat kendi ana şebekesinde ve ağ hiç ülke bildirmedi: karşılaştırılacak bir
       * çelişki yok. Halkanın kapsamı bilerek burada biter — ülke-altı (şehir/yarıçap)
       * doğrulama bu kapının bugünkü vaadi değildir (bkz. dosya başı, Halka 4).
       */
      return {
        kanit: [
          `Konum doğrulaması: onaylayıcının hattı yurt dışında değil ve ağ beklenen ülkeyle ` +
            `(${beklenen}) çelişen bir ülke bildirmedi (${maskeli}) — GSMA Open Gateway Device Roaming Status`,
        ],
        halka: "gercek",
        maskeliNumara: maskeli,
      };
    }
    if (durum.yurtDisinda === true && !ulkeler.length) {
      // Yurt dışında ama hangi ülkede belli değil: beklentiyle karşılaştırılamaz → kapalı arıza.
      return {
        engel:
          "Reddedildi: ağ doğrulaması tamamlanamadı — onaylayıcının hattı yurt dışında görünüyor ama " +
          "bulunduğu ülke ağdan okunamadı, dolayısıyla beklenen ülkeyle karşılaştırılamadı. Güvenlik " +
          "gereği cevaplanamayan kontrolde harcama artışı uygulanmaz.",
        kanit: [],
        halka: "gercek",
        maskeliNumara: maskeli,
        retNedeni: "ag-yanitsiz",
      };
    }
    /**
     * ÖLÇÜT "beklenen ülke kümede VAR MI" DEĞİL, "hat YALNIZCA beklenen ülkede mi
     * görüldü": bildirilen ülkelerin HEPSİ beklenene eşit değilse RET. Kümede
     * beklenen ülkeyi aramak fail-open'dı — ağ {NL, TR} bildirdiğinde karar "temiz"
     * çıkar, oysa hat aynı anda beklenmedik bir coğrafyada da görülmüştür; üstelik
     * kanıt satırı denetçiye tek yanlı ("beklenen ülkede") beyan verir ve ikinci
     * ülkenin varlığı kayıttan hiç okunamaz. Bu, halkanın birkaç satır yukarıdaki
     * davranışıyla da çelişirdi: ülke HİÇ okunamadığında "karşılaştırılamaz" deyip
     * reddederken, ÇELİŞKİLİ okunduğunda geçirmek olurdu.
     *
     * DÜRÜST TAKAS — bilerek yazıyoruz: sınır bölgesi, MVNO ve uydu kapsaması
     * yüzünden ağ MEŞRU olarak iki ülke bildirebilir ve o durumda MEŞRU kullanıcı
     * REDDEDİLİR. Bunu kabul ediyoruz, çünkü (1) halka YALNIZ "high" katmanda ve
     * YALNIZ beklenen ülke yapılandırılmışsa koşar, (2) "aynı anda iki ülkede
     * görünen hat" tam olarak bu kapının bakması gereken şeydir. Kapalı arıza
     * ilkesi gereği çelişki de belirsizlik gibi RET üretir; ret nedeni yeni bir kod
     * değil, aynı "konum-beklenmedik" kodudur.
     */
    if (!ulkeler.every((u) => u === beklenen)) {
      /**
       * GÖZLENEN ülke ASLA yazılmaz — ne ret metnine, ne ize. Dışarı çıkan tek şey
       * türetilmiş karar ve YAPILANDIRMADAN gelen beklenen ülke kodudur; ağın kaç
       * ülke bildirdiği de dahil hiçbir upstream ayrıntı sızmaz.
       */
      return {
        engel:
          `Reddedildi: AĞ DOĞRULAMASI BAŞARISIZ — onaylayıcının (${maskeli}) hattı beklenen ülkenin ` +
          `(${beklenen}) DIŞINDA bir ülkede de görüldü (GSMA Open Gateway Device Roaming Status; ` +
          `gözlenen ülkeler güvenlik gereği burada gösterilmez). Ağ hattı aynı anda birden çok ülkede ` +
          `bildirdiyse, küme beklenen ülkeyi İÇERSE BİLE bu çelişki reddedilir. Harcama onayının ` +
          `beklenmedik bir coğrafyadan gelmesi hesap ele geçirmenin tipik işaretidir; onay istemi hiç ` +
          `gösterilmedi ve harcama artışı uygulanmaz. Hesap sahibi durumu doğrulayana kadar tekrar ` +
          `deneme.`,
        kanit: [],
        halka: "gercek",
        maskeliNumara: maskeli,
        retNedeni: "konum-beklenmedik",
      };
    }
    return {
      kanit: [
        `Konum doğrulaması: onaylayıcının hattı YALNIZCA beklenen ülkede (${beklenen}) — ağın ` +
          `bildirdiği ülkelerin tamamı beklenenle aynı, çelişkili ikinci ülke yok — ` +
          `GSMA Open Gateway Device Roaming Status (${maskeli})`,
      ],
      halka: "gercek",
      maskeliNumara: maskeli,
    };
  } catch (e: any) {
    const detay = String(e?.message ?? e).split(ayar.approverPhone).join(maskeli);
    console.error(`[aegis] konum doğrulaması hatası (${maskeli}): ${detay}`);
    return {
      engel:
        "Reddedildi: ağ doğrulaması tamamlanamadı — konum kontrolünden yanıt alınamadı. Güvenlik " +
        "gereği yanıtsız kontrolde harcama artışı uygulanmaz; daha sonra tekrar dene. Sorun sürerse " +
        "operatör sunucu günlüklerine bakmalı (ayrıntı oraya yazıldı).",
      kanit: [],
      halka: "gercek",
      maskeliNumara: maskeli,
      retNedeni: "ag-yanitsiz",
    };
  }
}

/**
 * Zincirin 5. halkası: Device Swap — "hat son N saatte YENİ BİR CİHAZA mı taşındı?".
 *
 * SIM Swap'ın yapısal ikizi (bkz. dosya başı, Halka 5) ve fail-closed sözleşmesi
 * diğer halkalarla aynıdır: onaylayıcı numarası zorunlu, tanınmayan simülasyon değeri
 * RET (ham değer YANKILANMAZ), çelişkili yapılandırma RET, okunamayan/yanıtsız CAMARA
 * cevabı RET, "değişmiş" RET.
 *
 * Ne zaman koşar: SADECE "high" katmanda ve SADECE bir kanal yapılandırılmışsa. Gerçek
 * kanal ayrıca OPT-IN'dir (AEGIS_DEVICESWAP_CHECK): token'ın varlığı tek başına
 * sorguyu AÇMAZ — istenmemiş bir CAMARA gidiş-dönüşü her onaya gecikme eklerdi.
 */
async function cihazDegisimKatmani(ayar: AgAyar, risk: AgRisk): Promise<HalkaSonuc | undefined> {
  if (!halkaKosarMi(risk, "devSwap")) return undefined;
  const sim = ayar.devSwapSimulate?.trim();
  const gercekAcik = Boolean(ayar.nacToken && ayar.devSwapCheck);
  if (!sim && !ayar.nacToken) return undefined;

  if (sim) {
    // Çelişki ölçütü "token var mı" değil "gerçek kanal AÇIK mı" (halka 3'teki gerekçe).
    if (gercekAcik) {
      return {
        engel:
          "Reddedildi [SİMÜLASYON]: AEGIS_DEVICESWAP_CHECK açık (gerçek cihaz değişimi sorgusu) ve " +
          "AEGIS_DEVICESWAP_SIMULATE birlikte tanımlı — çelişkili yapılandırma. Gerçek sorgu " +
          "isteniyorsa simülasyon kaldırılmalı, demo isteniyorsa AEGIS_DEVICESWAP_CHECK kapatılmalı. " +
          "Güvenlik gereği belirsiz yapılandırmada harcama artışı uygulanmaz.",
        kanit: [],
        halka: "calismadi",
        retNedeni: "yapilandirma-celiskili",
      };
    }
    if (sim !== "temiz" && sim !== "degisti") {
      return {
        engel:
          `Reddedildi [SİMÜLASYON]: AEGIS_DEVICESWAP_SIMULATE değeri tanınmadı (değer, sır ` +
          `ihtimaline karşı burada gösterilmez) — geçerli değerler "temiz" | "degisti". Güvenlik ` +
          `gereği anlaşılamayan yapılandırmada harcama artışı uygulanmaz (kapalı arıza).`,
        kanit: [],
        halka: "calismadi",
        retNedeni: "simulasyon-degeri-tanimsiz",
      };
    }
    if (!ayar.approverPhone) {
      return {
        engel:
          "Reddedildi [SİMÜLASYON]: cihaz değişimi kontrolü aktif ama AEGIS_APPROVER_PHONE boş. " +
          "Sorgulanacak numara olmadan bu halka çalışamaz; güvenlik gereği harcama artışı uygulanmaz.",
        kanit: [],
        halka: "calismadi",
        retNedeni: "onaylayici-numarasi-yok",
      };
    }
    const pencereSim = pencereSec(ayar, risk);
    const maskeliSim = maskele(ayar.approverPhone);
    if (sim === "degisti") {
      return {
        engel:
          `Reddedildi [SİMÜLASYON]: CİHAZ DEĞİŞİMİ SAPTANDI (SİMÜLE) — onaylayıcının (${maskeliSim}) ` +
          `hattı son ${pencereSim} saat içinde YENİ BİR CİHAZA taşınmış SAYILDI ` +
          `(AEGIS_DEVICESWAP_SIMULATE=degisti; gerçek ağ sorgusu YAPILMADI). Gerçek akışta bu, SIM ` +
          `kartı hiç değişmeden hattın başka bir telefona alınması anlamına gelir — hesap ele ` +
          `geçirmenin SIM Swap kontrolüne yakalanmayan biçimidir; onay istemi gösterilmez ve harcama ` +
          `artışı uygulanmaz. Kullanıcıya bunun bir SİMÜLASYON olduğunu MUTLAKA bildir.`,
        kanit: [],
        halka: "simulasyon",
        maskeliNumara: maskeliSim,
        retNedeni: "cihaz-degisti",
        pencereSaat: pencereSim,
      };
    }
    return {
      kanit: [
        `Cihaz değişimi [SİMÜLASYON]: yeni cihaza taşınma yok (son ${pencereSim} saat, ` +
          `${maskeliSim}) — simüle kanal (AEGIS_DEVICESWAP_SIMULATE=temiz), gerçek ağ sorgusu YAPILMADI`,
      ],
      halka: "simulasyon",
      maskeliNumara: maskeliSim,
      pencereSaat: pencereSim,
    };
  }

  // Token var ama halka açılmamış: BİLEREK sorgu yok, ret yok, kanıt satırı yok —
  // beyan yalnız yapısal ize düşer (halka 3'teki aynı gerekçe).
  if (!gercekAcik) return { kanit: [], halka: "kapali" };

  if (!ayar.approverPhone) {
    return {
      engel:
        "Reddedildi: cihaz değişimi kontrolü açık (AEGIS_DEVICESWAP_CHECK) ama " +
        "AEGIS_APPROVER_PHONE boş. Onaylayıcının numarası olmadan ağ kontrolü yapılamaz; " +
        "güvenlik gereği harcama artışı uygulanmaz.",
      kanit: [],
      halka: "calismadi",
      retNedeni: "onaylayici-numarasi-yok",
    };
  }
  const pencere = pencereSec(ayar, risk);
  const maskeli = maskele(ayar.approverPhone);
  try {
    const kanal = await cihazDegisimKanaliGetir(ayar);
    const degisti = await kanal.cihazDegistiMi(pencere);
    if (degisti === true) {
      return {
        engel:
          `Reddedildi: AĞ DOĞRULAMASI BAŞARISIZ — onaylayıcının (${maskeli}) hattı son ${pencere} ` +
          `saat içinde YENİ BİR CİHAZA taşınmış (GSMA Open Gateway Device Swap). Bu, SIM kartı hiç ` +
          `değişmeden hattın başka bir telefona alınması demektir ve hesap ele geçirmenin SIM Swap ` +
          `kontrolüne yakalanmayan biçimidir; onay istemi hiç gösterilmedi ve harcama artışı ` +
          `uygulanmaz. Hesap sahibi durumu doğrulayana kadar tekrar deneme.`,
        kanit: [],
        halka: "gercek",
        maskeliNumara: maskeli,
        retNedeni: "cihaz-degisti",
        pencereSaat: pencere,
      };
    }
    if (degisti === false) {
      return {
        kanit: [
          `Cihaz değişimi: yeni cihaza taşınma yok (son ${pencere} saat, ${maskeli}) — ` +
            `GSMA Open Gateway Device Swap`,
        ],
        halka: "gercek",
        maskeliNumara: maskeli,
        pencereSaat: pencere,
      };
    }
    /**
     * Yanıt geldi ama okunamadı. "Değişmedi" demek sessiz gevşeme, "değişti" demek
     * yanlış suçlama olurdu; ikisi de değil — kontrol cevaplanamadı.
     */
    return {
      engel:
        "Reddedildi: ağ doğrulaması tamamlanamadı — cihaz değişimi kontrolünden okunabilir yanıt " +
        "alınamadı. Güvenlik gereği cevaplanamayan kontrolde harcama artışı uygulanmaz; daha sonra " +
        "tekrar dene.",
      kanit: [],
      halka: "gercek",
      maskeliNumara: maskeli,
      retNedeni: "ag-yanitsiz",
      pencereSaat: pencere,
    };
  } catch (e: any) {
    // Upstream metin ASLA ret mesajına girmez; ayrıntı numara maskelenerek stderr'e.
    const detay = String(e?.message ?? e).split(ayar.approverPhone).join(maskeli);
    console.error(`[aegis] cihaz değişimi hatası (${maskeli}): ${detay}`);
    return {
      engel:
        "Reddedildi: ağ doğrulaması tamamlanamadı — cihaz değişimi kontrolünden yanıt alınamadı. " +
        "Güvenlik gereği yanıtsız kontrolde harcama artışı uygulanmaz; daha sonra tekrar dene. " +
        "Sorun sürerse operatör sunucu günlüklerine bakmalı (ayrıntı oraya yazıldı).",
      kanit: [],
      halka: "gercek",
      maskeliNumara: maskeli,
      retNedeni: "ag-yanitsiz",
      pencereSaat: pencere,
    };
  }
}

/**
 * Zincirin 6. halkası: Call Forwarding — "hatta KOŞULSUZ çağrı yönlendirme açık mı?".
 *
 * Açık yönlendirme, OTP/sesli doğrulamayı ele geçirmenin klasik yoludur ve önceki beş
 * halkanın hiçbiri onu göremez (SIM aynı, cihaz aynı, hat erişilebilir, ülke beklenen).
 *
 * Kapalı arıza iki ek tuzağı da kapsar (bkz. dosya başı, Halka 6): `active` alanı
 * tipte OPSİYONELDİR — okunamaması "yönlendirme yok" değil "bilinmiyor"dur ve RET
 * üretir; uç noktanın 501 dahil her fırlatması da RET'tir.
 */
async function cagriYonlendirmeKatmani(ayar: AgAyar, risk: AgRisk): Promise<HalkaSonuc | undefined> {
  if (!halkaKosarMi(risk, "callFwd")) return undefined;
  const sim = ayar.callFwdSimulate?.trim();
  const gercekAcik = Boolean(ayar.nacToken && ayar.callFwdCheck);
  if (!sim && !ayar.nacToken) return undefined;

  if (sim) {
    if (gercekAcik) {
      return {
        engel:
          "Reddedildi [SİMÜLASYON]: AEGIS_CALLFWD_CHECK açık (gerçek çağrı yönlendirme sorgusu) ve " +
          "AEGIS_CALLFWD_SIMULATE birlikte tanımlı — çelişkili yapılandırma. Gerçek sorgu " +
          "isteniyorsa simülasyon kaldırılmalı, demo isteniyorsa AEGIS_CALLFWD_CHECK kapatılmalı. " +
          "Güvenlik gereği belirsiz yapılandırmada harcama artışı uygulanmaz.",
        kanit: [],
        halka: "calismadi",
        retNedeni: "yapilandirma-celiskili",
      };
    }
    if (sim !== "kapali" && sim !== "acik") {
      return {
        engel:
          `Reddedildi [SİMÜLASYON]: AEGIS_CALLFWD_SIMULATE değeri tanınmadı (değer, sır ihtimaline ` +
          `karşı burada gösterilmez) — geçerli değerler "kapali" | "acik". Güvenlik gereği ` +
          `anlaşılamayan yapılandırmada harcama artışı uygulanmaz (kapalı arıza).`,
        kanit: [],
        halka: "calismadi",
        retNedeni: "simulasyon-degeri-tanimsiz",
      };
    }
    if (!ayar.approverPhone) {
      return {
        engel:
          "Reddedildi [SİMÜLASYON]: çağrı yönlendirme kontrolü aktif ama AEGIS_APPROVER_PHONE boş. " +
          "Sorgulanacak numara olmadan bu halka çalışamaz; güvenlik gereği harcama artışı uygulanmaz.",
        kanit: [],
        halka: "calismadi",
        retNedeni: "onaylayici-numarasi-yok",
      };
    }
    const maskeliSim = maskele(ayar.approverPhone);
    if (sim === "acik") {
      return {
        engel:
          `Reddedildi [SİMÜLASYON]: ÇAĞRI YÖNLENDİRME AÇIK (SİMÜLE) — onaylayıcının (${maskeliSim}) ` +
          `hattında koşulsuz çağrı yönlendirme etkin SAYILDI (AEGIS_CALLFWD_SIMULATE=acik; gerçek ` +
          `ağ sorgusu YAPILMADI). Gerçek akışta bu, hattın doğrulama çağrılarının başka bir numaraya ` +
          `aktarıldığı anlamına gelir — OTP/sesli doğrulama ele geçirmenin klasik yolu; onay istemi ` +
          `gösterilmez ve harcama artışı uygulanmaz. Kullanıcıya bunun bir SİMÜLASYON olduğunu ` +
          `MUTLAKA bildir.`,
        kanit: [],
        halka: "simulasyon",
        maskeliNumara: maskeliSim,
        retNedeni: "cagri-yonlendirme-acik",
      };
    }
    return {
      kanit: [
        `Çağrı yönlendirme [SİMÜLASYON]: onaylayıcının hattında koşulsuz yönlendirme YOK SAYILDI ` +
          `(${maskeliSim}) — simüle kanal (AEGIS_CALLFWD_SIMULATE=kapali), gerçek ağ sorgusu YAPILMADI`,
      ],
      halka: "simulasyon",
      maskeliNumara: maskeliSim,
    };
  }

  if (!gercekAcik) return { kanit: [], halka: "kapali" };

  if (!ayar.approverPhone) {
    return {
      engel:
        "Reddedildi: çağrı yönlendirme kontrolü açık (AEGIS_CALLFWD_CHECK) ama " +
        "AEGIS_APPROVER_PHONE boş. Onaylayıcının numarası olmadan ağ kontrolü yapılamaz; " +
        "güvenlik gereği harcama artışı uygulanmaz.",
      kanit: [],
      halka: "calismadi",
      retNedeni: "onaylayici-numarasi-yok",
    };
  }
  const maskeli = maskele(ayar.approverPhone);
  try {
    const kanal = await cagriYonlendirmeKanaliGetir(ayar);
    const acik = await kanal.kosulsuzYonlendirmeAcikMi();
    if (acik === true) {
      return {
        engel:
          `Reddedildi: AĞ DOĞRULAMASI BAŞARISIZ — onaylayıcının (${maskeli}) hattında KOŞULSUZ ÇAĞRI ` +
          `YÖNLENDİRME açık (GSMA Open Gateway Call Forwarding Signal). Hattın doğrulama çağrıları ` +
          `başka bir numaraya aktarılıyor olabilir; bu, OTP/sesli doğrulama ele geçirmenin klasik ` +
          `yoludur. Onay istemi hiç gösterilmedi ve harcama artışı uygulanmaz. Hesap sahibi ` +
          `yönlendirmeyi kaldırıp durumu doğrulayana kadar tekrar deneme.`,
        kanit: [],
        halka: "gercek",
        maskeliNumara: maskeli,
        retNedeni: "cagri-yonlendirme-acik",
      };
    }
    if (acik === false) {
      return {
        kanit: [
          `Çağrı yönlendirme: onaylayıcının hattında koşulsuz yönlendirme yok (${maskeli}) — ` +
            `GSMA Open Gateway Call Forwarding Signal`,
        ],
        halka: "gercek",
        maskeliNumara: maskeli,
      };
    }
    /**
     * `active` CAMARA yanıtında OPSİYONEL: yokluğu "yönlendirme kapalı" DEĞİL "bilinmiyor"dur.
     * Bilinmeyeni temiz saymak, halkanın var olma sebebini yutardı.
     */
    return {
      engel:
        "Reddedildi: ağ doğrulaması tamamlanamadı — çağrı yönlendirme kontrolünden okunabilir yanıt " +
        "alınamadı. Güvenlik gereği cevaplanamayan kontrolde harcama artışı uygulanmaz; daha sonra " +
        "tekrar dene.",
      kanit: [],
      halka: "gercek",
      maskeliNumara: maskeli,
      retNedeni: "ag-yanitsiz",
    };
  } catch (e: any) {
    /**
     * 501 (NotImplementedError) dahil HER fırlatma buraya düşer ve RET üretir: operatörün
     * şebekesi bu sinyali sunmuyorsa halka KAPATILMALIDIR (AEGIS_CALLFWD_CHECK), sessizce
     * geçilmemelidir — "cevap alamadım" ile "yönlendirme yok" aynı şey değildir.
     */
    const detay = String(e?.message ?? e).split(ayar.approverPhone).join(maskeli);
    console.error(`[aegis] çağrı yönlendirme hatası (${maskeli}): ${detay}`);
    return {
      engel:
        "Reddedildi: ağ doğrulaması tamamlanamadı — çağrı yönlendirme kontrolünden yanıt alınamadı " +
        "(şebeke bu sinyali sunmuyor olabilir). Güvenlik gereği yanıtsız kontrolde harcama artışı " +
        "uygulanmaz; daha sonra tekrar dene. Sorun sürerse operatör sunucu günlüklerine bakmalı " +
        "(ayrıntı oraya yazıldı).",
      kanit: [],
      halka: "gercek",
      maskeliNumara: maskeli,
      retNedeni: "ag-yanitsiz",
    };
  }
}

/**
 * Consults the network before a spend-increasing approval. Called by the approval gate
 * for every risk-tagged action; the caller treats `engel` as a hard refusal.
 *
 * Zincir SABİT ve TEK YÖNLÜ sırayla koşar:
 *   SIM Swap → Number Verification → Device Reachability → Location
 *   → Device Swap → Call Forwarding
 * Son beşi YALNIZ "high" katmanda çalışır. Bir halkanın reti KESİNDİR: o noktada hemen
 * dönülür, sonraki halkalar ne koşar ne de kararı yumuşatabilir — sonraki bir halka
 * yalnızca reddetmek için yeni bir sebep ekleyebilir.
 */
export async function agDogrula(ayar: AgAyar, risk: AgRisk): Promise<AgKarar> {
  /**
   * ZİNCİR BİRLEŞİMİ + KADEMELİ DOĞRULAMA.
   *
   * Koşan her halka KENDİ iz alanına yazar; tek bir alana ASLA ezilmez. "Gerçek CAMARA
   * SIM-Swap sorgusu + NV simülasyonu + kapalı konum halkası" ile "hepsi simülasyon"
   * farklı güven seviyeleridir ve denetim izinin tek işi bu ayrımı kanıtlamaktır.
   * Halka eklendikçe bu kural yeniden kazanılır: yeni halka hem KENDİ AgIz alanını hem
   * de kararGunlugu.ts'teki kendi kayıt alanını ister.
   *
   * BOZUK SİNYALDE NE OLUR. Kapı eskiden ilk engelde dönüyordu. Artık engelin CİNSİNE
   * bakılıyor:
   *
   *   - Yükseltilemez bir neden (çağrı yönlendirme açık, numara uyuşmazlığı,
   *     yapılandırma hataları) → eskisi gibi ANINDA ret. Kalan halkalar hiç çağrılmaz;
   *     reddedilmiş bir işlem için ağa gitmenin anlamı yok.
   *   - Yükseltilebilir bir neden (SIM/cihaz değişimi, seyahat, kapalı telefon, cevapsız
   *     ağ) ve kademe AÇIK → zincir DURMAZ. Kalan halkalar, bozulan sinyali
   *     doğrulayacak kanıt için koşturulur.
   *
   * Sonuçta üç şeyden biri olur ve üçü de izde ayırt edilebilir:
   *   ret            — doğrulayan halka da bozuk çıktı, ya da hiç gerçek doğrulayan yok
   *   yükseltilerek geçti — kalan halkaların HEPSİ gerçek kanaldan temiz döndü
   *   temiz geçti    — hiç bozuk sinyal olmadı
   */
  const kademeAcik = ayar.stepUp === true;

  /** Yükseltme beklemeye alındıysa: ilk bozuk sinyalin kaydı. */
  let bekleyen: { engel: string; neden: RetNedeni; aciklama: string } | undefined;
  /**
   * GERÇEK kanaldan temiz dönen HER halka — sırasından bağımsız.
   *
   * İlk hâli yalnız bozuk sinyalden SONRA koşanları sayıyordu ve bu, doğrulamayı
   * zincirdeki sıraya bağlıyordu: erişilebilirlik halkası konum halkasından önce
   * koştuğu için, temiz ve gerçek olmasına rağmen doğrulayan sayılmıyordu. Oysa
   * "bu sinyal temiz geldi" ifadesinin, bozuk sinyalin ondan önce mi sonra mı
   * geldiğiyle ilgisi yoktur.
   */
  const temizGercek: string[] = [];

  /**
   * BOZUK ÇIKAN HER SİNYAL — kararı hangisi verirse versin.
   *
   * `iz.retNedeni` tek yuvadır ve sonraki halka onu üzerine yazar; bu dizi ise hiçbir
   * bozuk sinyali düşürmez (bkz. AgIz.retNedenleri). Aynı neden iki kez eklenmez:
   * denetçi "kaç ayrı sinyal bozuktu" sorusunu sayarak cevaplayabilmeli.
   */
  const bozuklar: RetNedeni[] = [];
  const bozukKaydet = (neden: RetNedeni | undefined): void => {
    if (neden !== undefined && !bozuklar.includes(neden)) bozuklar.push(neden);
  };
  /** Dönüş izine bozuk sinyal listesini iliştirir; hiç yoksa alanı HİÇ açmaz. */
  const izle = (ham: AgIz): AgIz => (bozuklar.length ? { ...ham, retNedenleri: [...bozuklar] } : ham);

  let kanit: string[] = [];
  let iz: AgIz = { simSwap: "kapali" };

  /**
   * Tek bir halkanın sonucunu zincire katar ve akışın devam edip etmeyeceğini söyler.
   *
   * `gercekMi` bilerek ayrı bir parametre: SİMÜLE bir halka, bozulmuş GERÇEK bir
   * sinyali doğrulayamaz. Aksi hâlde demo kipinde tek bir env değeri, gerçek bir SIM
   * değişimini "doğrulanmış" hâle getirirdi — kapının en kolay atlatılma yolu bu olurdu.
   */
  const kat = (
    id: string,
    sonuc: { engel?: string; kanit: string[]; retNedeni?: RetNedeni },
    gercekMi: boolean,
    aciklama: string
  ): "devam" | "dur" => {
    if (sonuc.engel) {
      const neden = sonuc.retNedeni;
      // Sinyal bozuldu: kararı bu halka verse de vermese de ize GİRER.
      bozukKaydet(neden);
      const yukseltilebilir = kademeAcik && !bekleyen && neden !== undefined && KADEME_UYGUN.has(neden);
      if (!yukseltilebilir) return "dur";
      bekleyen = { engel: sonuc.engel, neden: neden!, aciklama };
      return "devam";
    }
    kanit = [...kanit, ...sonuc.kanit];
    if (gercekMi) temizGercek.push(id);
    return "devam";
  };

  const simSwap = await simSwapKatmani(ayar, risk);
  kanit = [...simSwap.kanit];
  iz = simSwap.iz;
  if (simSwap.engel) {
    const neden = simSwap.iz.retNedeni;
    bozukKaydet(neden);
    if (!kademeAcik || neden === undefined || !KADEME_UYGUN.has(neden)) {
      return { ...simSwap, iz: izle(simSwap.iz) };
    }
    bekleyen = {
      engel: simSwap.engel,
      neden,
      aciklama: "onaylayıcının SIM kartı yakın zamanda değişmiş",
    };
    kanit = [];
  } else if (simSwap.iz.simSwap === "gercek") {
    // Bozuk sinyal SONRADAN gelirse bu halka onu doğrulayanlar arasında sayılır.
    temizGercek.push("simSwap");
  }

  const nv = nvKatmani(ayar, risk);
  if (nv) {
    iz = { ...iz, nv: nv.nv, maskeliNumara: iz.maskeliNumara ?? nv.maskeliNumara, retNedeni: nv.retNedeni ?? iz.retNedeni };
    // NV yalnız simülasyondur: doğrulayan sayılmaz (gercekMi = false).
    if (kat("nv", nv, false, "numara doğrulaması") === "dur") return { engel: nv.engel, kanit: [], iz: izle(iz) };
  }

  const reach = await erisilebilirlikKatmani(ayar, risk);
  if (reach) {
    iz = { ...iz, reach: reach.halka, maskeliNumara: iz.maskeliNumara ?? reach.maskeliNumara, retNedeni: reach.retNedeni ?? iz.retNedeni };
    if (kat("reach", reach, reach.halka === "gercek", "onaylayıcının cihazı şebekeden erişilemez durumda") === "dur") {
      return { engel: reach.engel, kanit: [], iz: izle(iz) };
    }
  }

  const loc = await konumKatmani(ayar, risk);
  if (loc) {
    iz = { ...iz, loc: loc.halka, maskeliNumara: iz.maskeliNumara ?? loc.maskeliNumara, retNedeni: loc.retNedeni ?? iz.retNedeni };
    if (kat("loc", loc, loc.halka === "gercek", "onaylayıcının hattı beklenen ülke dışında görülüyor") === "dur") {
      return { engel: loc.engel, kanit: [], iz: izle(iz) };
    }
  }

  const devSwap = await cihazDegisimKatmani(ayar, risk);
  if (devSwap) {
    iz = {
      ...iz,
      devSwap: devSwap.halka,
      maskeliNumara: iz.maskeliNumara ?? devSwap.maskeliNumara,
      retNedeni: devSwap.retNedeni ?? iz.retNedeni,
      /**
       * KENDİ alanına yazar, `pencereSaat`e DEĞİL: o alan SIM-Swap halkasınındır ve iki
       * halkanın penceresi tek alana ezilirse denetçi hangi sorunun hangi pencereyle
       * sorulduğunu ayırt edemez (bkz. AgIz.devSwapPencereSaat).
       */
      devSwapPencereSaat: devSwap.pencereSaat,
    };
    if (kat("devSwap", devSwap, devSwap.halka === "gercek", "onaylayıcının cihazı yakın zamanda değişmiş") === "dur") {
      return { engel: devSwap.engel, kanit: [], iz: izle(iz) };
    }
  }

  const callFwd = await cagriYonlendirmeKatmani(ayar, risk);
  if (callFwd) {
    iz = { ...iz, callFwd: callFwd.halka, maskeliNumara: iz.maskeliNumara ?? callFwd.maskeliNumara, retNedeni: callFwd.retNedeni ?? iz.retNedeni };
    if (kat("callFwd", callFwd, callFwd.halka === "gercek", "çağrı yönlendirme") === "dur") {
      return { engel: callFwd.engel, kanit: [], iz: izle(iz) };
    }
  }

  if (!bekleyen) return { kanit, iz: izle(iz) };

  /**
   * YÜKSELTME KARARI. Buraya yalnız yükseltilebilir bir bozuk sinyalle gelinir ve
   * kalan halkaların hiçbiri reddetmemiştir (reddeden olsaydı yukarıda dönülürdü).
   *
   * GEÇMEK İÇİN EN AZ BİR GERÇEK DOĞRULAYAN ŞART. Doğrulayansız bir yükseltme,
   * "sinyal bozuktu ama sorabileceğimiz başka kimse yoktu, o hâlde geçsin" demektir —
   * yani kapının kapandığı tek durumda kapıyı açmak. Simülasyon kanalları bilerek
   * sayılmaz: demo kipinde tek bir env değeri gerçek bir SIM değişimini örtemesin.
   */
  /**
   * KEFİL SÜZGECİ. Temiz dönmüş olmak yetmez; halkanın bozuk sinyali ÇÜRÜTEBİLİYOR
   * olması da gerekir (bkz. KEFIL_ESLEMESI). Süzgeçten önce "en az bir gerçek halka
   * temiz" koşulu sağlanıyordu ve bu, erişilebilirlik halkasının tek başına gerçek bir
   * SIM değişimine kefil olmasına izin veriyordu.
   */
  // Kapanışın içinde daraltma korunmaz: bozuk sinyali sabite alıyoruz.
  const kefilKumesi = KEFIL_ESLEMESI[bekleyen.neden] ?? [];
  const kefiller = temizGercek.filter((id) => kefilKumesi.includes(id));

  if (!kefiller.length) {
    /**
     * İki ayrı durumu AYIRT EDEREK söylüyoruz: hiç gerçek halka koşmamış olmakla,
     * koşmuş ama hiçbirinin bu sinyal hakkında söyleyecek sözü olmaması aynı şey
     * değildir. İkincisini birincisiymiş gibi raporlamak, operatöre yapılandırma
     * sorunu varmış gibi gösterirdi.
     */
    const aciklayici = temizGercek.length
      ? " (kademeli doğrulama açık, ama temiz dönen ağ halkalarının hiçbiri bu sinyale kefil " +
        "olabilecek türden değil — canlılık sinyali kimlik sinyalini doğrulayamaz)"
      : " (kademeli doğrulama açık, ama sinyali doğrulayacak GERÇEK bir ağ halkası koşmadı)";
    return {
      engel: bekleyen.engel + aciklayici,
      kanit: [],
      iz: izle({ ...iz, retNedeni: bekleyen.neden }),
    };
  }

  return {
    kanit: [
      ...kanit,
      `KADEMELİ DOĞRULAMA: ${bekleyen.aciklama} — işlem reddedilmedi, daha güçlü ` +
        `doğrulamaya bağlandı (${kefiller.length} bağımsız ağ sinyali bu sinyale kefil).`,
    ],
    iz: izle({ ...iz, kademe: "yukseltildi", retNedeni: bekleyen.neden, kademeDogrulayan: kefiller }),
    kademe: { neden: bekleyen.neden, aciklama: bekleyen.aciklama, dogrulayan: kefiller },
  };
}

/**
 * Zincirin 1. halkası: SIM Swap (gerçek CAMARA sorgusu ya da SİMÜLASYON kanalı).
 * Karar mantığı halka ayrımından önceki hâliyle aynıdır.
 */
async function simSwapKatmani(ayar: AgAyar, risk: AgRisk): Promise<AgKarar> {
  // Simülasyon tanımlıysa gerçek kanaldan ÖNCE devreye girer (token'a bakılmaksızın):
  // jüri demosu SDK'sız/token'sız çalışır, karar mantığı ve fail-closed yolları aynıdır.
  const sim = ayar.nacSimulate?.trim();
  if (sim) return simDogrula(ayar, risk, sim);

  if (!ayar.nacToken) {
    // Katman BİLEREK kapalı: yapılandırma hatası değil, sorgu da yok.
    return { kanit: ["Ağ doğrulaması: kapalı (AEGIS_NAC_TOKEN tanımlı değil)"], iz: { simSwap: "kapali" } };
  }
  if (!ayar.approverPhone) {
    return {
      engel:
        "Reddedildi: ağ doğrulaması yapılandırması eksik — AEGIS_NAC_TOKEN tanımlı ama " +
        "AEGIS_APPROVER_PHONE boş. Onaylayıcının numarası olmadan ağ kontrolü yapılamaz; " +
        "güvenlik gereği harcama artışı uygulanmaz.",
      kanit: [],
      iz: { simSwap: "calismadi", retNedeni: "onaylayici-numarasi-yok" },
    };
  }

  const pencere = pencereSec(ayar, risk);
  const maskeli = maskele(ayar.approverPhone);

  try {
    const kanal = await kanalGetir(ayar);
    const degisti = await kanal.verifySimSwap(pencere);
    if (degisti === true) {
      return {
        engel:
          `Reddedildi: AĞ DOĞRULAMASI BAŞARISIZ — onaylayıcının (${maskeli}) SIM kartı ` +
          `son ${pencere} saat içinde değişmiş (GSMA Open Gateway SIM Swap). Bu, hesap ele geçirme ` +
          `saldırılarının tipik işaretidir; onay istemi hiç gösterilmedi. Hesap sahibi durumu doğrulayana ` +
          `kadar harcama artışı uygulanmaz. Kullanıcıya bu durumu MUTLAKA bildir.`,
        kanit: [],
        iz: { simSwap: "gercek", pencereSaat: pencere, maskeliNumara: maskeli, retNedeni: "sim-degisti" },
      };
    }
    if (degisti === false) {
      return {
        kanit: [`Ağ doğrulaması: SIM değişimi yok (son ${pencere} saat, ${maskeli}) — GSMA Open Gateway`],
        iz: { simSwap: "gercek", pencereSaat: pencere, maskeliNumara: maskeli },
      };
    }
    /**
     * Yanıt geldi ama OKUNAMADI (bkz. kanalGetir). "Değişmedi" demek sessiz gevşeme,
     * "değişti" demek yanlış suçlama olurdu; ikisi de değil — kontrol cevaplanamadı.
     * İz "gercek": yapılandırma sağlamdı ve sorgu bu pencereyle gerçekten DENENDİ.
     */
    return {
      engel:
        "Reddedildi: ağ doğrulaması tamamlanamadı — SIM Swap kontrolünden okunabilir yanıt " +
        "alınamadı. Güvenlik gereği cevaplanamayan kontrolde harcama artışı uygulanmaz; " +
        "daha sonra tekrar dene.",
      kanit: [],
      iz: { simSwap: "gercek", pencereSaat: pencere, maskeliNumara: maskeli, retNedeni: "ag-yanitsiz" },
    };
  } catch (e: any) {
    /**
     * The trust anchor is unreachable: refusing is the entire point of having one.
     *
     * The upstream error is NEVER inlined into the refusal. The NaC SDK builds
     * error.message from the full server response body, and CAMARA 4xx bodies echo
     * the offending phoneNumber verbatim — inlining it would hand the agent (and an
     * attacker holding a stolen session) the exact secret maskele() protects, plus an
     * unsanitized channel for upstream text. Details go to stderr for the operator,
     * with the approver number redacted even there.
     */
    const detay = String(e?.message ?? e).split(ayar.approverPhone).join(maskeli);
    console.error(`[aegis] ağ doğrulaması hatası (${maskeli}): ${detay}`);
    return {
      engel:
        "Reddedildi: ağ doğrulaması tamamlanamadı — SIM Swap kontrolünden yanıt alınamadı. " +
        "Güvenlik gereği yanıtsız kontrolde harcama artışı uygulanmaz; daha sonra tekrar dene. " +
        "Sorun sürerse operatör sunucu günlüklerine bakmalı (ayrıntı oraya yazıldı).",
      kanit: [],
      /**
       * Kanal "gercek": yapılandırma sağlamdı ve gerçek sorgu bu pencereyle DENENDİ —
       * yanıt gelmedi. "calismadi" demek, yapılandırma hatasıyla hiç sorulmamış bir
       * kararla aynı kefeye koymak olurdu; denetimde bu ikisi ayrı durumlardır.
       */
      iz: { simSwap: "gercek", pencereSaat: pencere, maskeliNumara: maskeli, retNedeni: "ag-yanitsiz" },
    };
  }
}
