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

/** The environment names behind ZINCIR_ORTAK_AYARLARI, as read in config.ts. */
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
 * The NaC SDK client — the X-RapidAPI-Host header is added BY HAND.
 *
 * The SDK does not SEND that header itself, and without it the platform answers every call
 * with `404 {"message":"API doesn't exists"}`: even with the right endpoint path and base
 * URL, the request maps to no API at all. This was found by measurement — with the same body
 * and the same key, adding only this header turns the response into
 * `200 {"swapped":true}`.
 *
 * The value is the constant from the platform's own documentation (Nokia API Hub, the curl
 * examples under "Getting client credentials"). If the SDK ever starts sending the header
 * itself, this line harmlessly writes the same value again.
 */
const RAPIDAPI_HOST = "network-as-code.nokia.rapidapi.com";

export function nacIstemciSecenekleri(token: string): {
  apiKey: string;
  rapidapiHost: string;
  headers: Record<string, string>;
} {
  /**
   * THE HOST IS SUPPLIED BOTH WAYS, and the redundancy is deliberate.
   *
   * `rapidapiHost` is the SDK's own supported option; the official answer from Nokia
   * (Aleksi Puranen, 31 August 2026) told us to use it, and confirmed that the SDK not
   * sending the host by itself is a shortcoming which has been reported.
   *
   * The hand-placed header stays all the same: it is the path this codebase verified live BY
   * MEASUREMENT, and it costs nothing. The SDK has already come up short here once; the
   * price of a second surprise in the same place would be the gate saying "the network did
   * not answer" on every call in production and failing closed — no spend would ever be
   * approved and the reason would stay unclear for months. Since both carry the same value,
   * they cannot contradict each other.
   */
  return {
    apiKey: token,
    rapidapiHost: RAPIDAPI_HOST,
    headers: { "X-RapidAPI-Host": RAPIDAPI_HOST },
  };
}

/** Exactly the same type as the production client: the test seam below does not loosen
 * it. */
type NacIstemci = import("network-as-code").NetworkAsCodeApiClient;

/**
 * A TEST SEAM FOR THE SDK CLIENT — it exists because `__set*KanalForTests` is not enough.
 *
 * Those seams replace the ADAPTED channel (SimSwapKanali and friends), which means they SKIP
 * the code that turns a CAMARA body into a boolean. The chain's only live fail-open lived
 * exactly there: the SIM Swap adapter said `res.swapped === true`, so a malformed body — {},
 * "true", null, 1 — was quietly turned into "the SIM did not change" and no unit test went
 * red, because every one of them injected a fake CHANNEL rather than a fake BODY.
 *
 * With this factory the tests run the real adapter closures through a fake SDK client: the
 * malformed-body matrix is exercised against the actual production code without going near
 * the network.
 */
let nacIstemciFabrikasi: ((token: string) => Promise<NacIstemci>) | undefined;
export function __setNacIstemciFabrikasiForTests(
  fabrika: ((token: string) => Promise<NacIstemci>) | undefined
): void {
  nacIstemciFabrikasi = fabrika;
  // Cached channels carry the OLD client's closure; unless all of them are dropped, the
  // seam leaks.
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
       * `swapped` is a required boolean in the SDK's type, but a type guarantee is NOT a
       * RUNTIME guarantee: a body such as {"swapped":"true"} (a string), {} (field absent),
       * {"swapped":null} or {"swapped":1} came out of the old `=== true` shortcut as a quiet
       * false — counted as "the SIM did not change", and the spend WENT THROUGH. undefined
       * means "the answer could not be read", and the caller turns it into a fail-closed
       * refusal (the same contract as links 3, 4, 5 and 6).
       */
      return typeof res.swapped === "boolean" ? res.swapped : undefined;
    },
  };
  gercekKanalAnahtari = anahtar;
  return gercekKanal;
}

/* ── Link 3: the real channel (Device Reachability) ───────────────────────────── */

let erisimOverride: ErisilebilirlikKanali | "reset" | undefined;
export function __setErisimKanalForTests(k: ErisilebilirlikKanali | undefined): void {
  erisimOverride = k ?? "reset";
  gercekErisimKanal = undefined;
  gercekErisimAnahtari = undefined;
}

let gercekErisimKanal: ErisilebilirlikKanali | undefined;
let gercekErisimAnahtari: string | undefined;

/**
 * Exactly the same skeleton as the SIM Swap channel: a lazy import, so installations
 * without a token never load the SDK; a cache keyed on token plus phone number, because an
 * unkeyed singleton bakes the FIRST caller's number into the closure and quietly keeps
 * querying the old line after the number is rotated; and a 10-second timeout with 1 retry,
 * where the SDK's default of 60 seconds times 3 attempts would leave an approval hanging for
 * about three minutes — failing closed has to be FAST.
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
       * `reachable` is a required boolean in the SDK's type, but a type guarantee is not a
       * RUNTIME guarantee: if the body arrives in an unexpected shape, assuming
       * "unreachable" is as wrong as assuming "reachable". undefined means "the answer could
       * not be read".
       */
      return typeof res.reachable === "boolean" ? res.reachable : undefined;
    },
  };
  gercekErisimAnahtari = anahtar;
  return gercekErisimKanal;
}

/* ── Link 4: the real channel (Location — the roaming country) ────────────────── */

let konumOverride: KonumKanali | "reset" | undefined;
export function __setKonumKanalForTests(k: KonumKanali | undefined): void {
  konumOverride = k ?? "reset";
  gercekKonumKanal = undefined;
  gercekKonumAnahtari = undefined;
}

let gercekKonumKanal: KonumKanali | undefined;
let gercekKonumAnahtari: string | undefined;

/** The same contract as link 3's channel; only the endpoint asked is different. */
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
        // The raw list GOES NO FURTHER THAN HERE: the decision logic uses it only for the
        // comparison and writes it into no text and no trace (see the file header, Link 4).
        ulkeler: Array.isArray(res.countryName) ? res.countryName : undefined,
      };
    },
  };
  gercekKonumAnahtari = anahtar;
  return gercekKonumKanal;
}

/* ── Link 5: the real channel (Device Swap) ───────────────────────────────────── */

let cihazDegisimOverride: CihazDegisimKanali | "reset" | undefined;
export function __setCihazDegisimKanalForTests(k: CihazDegisimKanali | undefined): void {
  cihazDegisimOverride = k ?? "reset";
  gercekCihazDegisimKanal = undefined;
  gercekCihazDegisimAnahtari = undefined;
}

let gercekCihazDegisimKanal: CihazDegisimKanali | undefined;
let gercekCihazDegisimAnahtari: string | undefined;

/**
 * Exactly the same skeleton and the same reasoning as the SIM Swap channel: a lazy import, a
 * cache keyed on token plus phone number, and a 10-second timeout with 1 retry, where the
 * SDK's default of 60 seconds times 3 attempts would leave an approval hanging for about
 * three minutes.
 *
 * The endpoint really is a twin: `deviceSwap.check({ phoneNumber, maxAge })` gives
 * `{ swapped }`.
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
       * `swapped` is a required boolean in the SDK's type, but a type guarantee is not a
       * RUNTIME guarantee; an unreadable field means "unknown", NOT "did not change", and so
       * fails closed.
       *
       * HISTORY: this once said "the `=== true` shortcut used in SIM Swap is deliberately
       * avoided here". The difference had been spotted correctly but resolved wrongly — the
       * older link was not fixed, the divergence was DOCUMENTED, which left the chain's most
       * critical and only live-running link quietly treating an unreadable body as clean. The
       * shortcut is now gone from there too: all six links share this one contract, and the
       * divergence is a closed hole rather than an exception to be explained.
       */
      return typeof res.swapped === "boolean" ? res.swapped : undefined;
    },
  };
  gercekCihazDegisimAnahtari = anahtar;
  return gercekCihazDegisimKanal;
}

/* ── Link 6: the real channel (Call Forwarding) ───────────────────────────────── */

let cagriYonlendirmeOverride: CagriYonlendirmeKanali | "reset" | undefined;
export function __setCagriYonlendirmeKanalForTests(k: CagriYonlendirmeKanali | undefined): void {
  cagriYonlendirmeOverride = k ?? "reset";
  gercekCagriYonlendirmeKanal = undefined;
  gercekCagriYonlendirmeAnahtari = undefined;
}

let gercekCagriYonlendirmeKanal: CagriYonlendirmeKanali | undefined;
let gercekCagriYonlendirmeAnahtari: string | undefined;

/**
 * The same contract as the other links; only the endpoint asked is different.
 *
 * `retrieveUnconditionalCallForwarding` is called DELIBERATELY, and not its sibling
 * `retrieveCallForwarding`: the sibling returns an array, the SDK documentation says of it
 * that it "goes beyond the main scope and may return 501", and an unrecognised member of that
 * array would open a new fail-closed path. The question we are asking is a single boolean
 * anyway — is unconditional forwarding active? WHICH number the forwarding points to is
 * neither asked for nor received, so there is no PII.
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
      // `active` is OPTIONAL in the type: its absence means "unknown", not "forwarding is
      // off".
      return typeof res.active === "boolean" ? res.active : undefined;
    },
  };
  gercekCagriYonlendirmeAnahtari = anahtar;
  return gercekCagriYonlendirmeKanal;
}

/**
 * Normalises the expected country: only ISO 3166-1 alpha-2, two letters, is accepted.
 * `undefined` means the value is unusable, and the caller turns that into a fail-closed
 * refusal. The raw value is written nowhere; only the normalised code can leave here.
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
 * IT IS EXPORTED FOR ONE REASON ONLY — TESTING. This clamp had no guard, because every
 * `approverPhone` fixture in the repository uses a single 13-character shape, and if the
 * clamp is removed it only breaks on SHORT numbers: at length 6 the whole input is exposed,
 * and at 5 `"*".repeat(-1)` throws a RangeError. This output goes into the prompt's evidence
 * lines, into the decision log, and into the refusal text returned to the agent, and there is
 * no second masking layer on the agent path: a silent regression here leaks the raw number
 * directly.
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
 * The SIMULATION channel, so a jury or demo environment runs without a NaC token. The real
 * SDK is NEVER
 * dokunulmaz (import bile edilmez).
 *
 * EVERY text it produces — an evidence line, a refusal message, a stderr warning — carries
 * the word "SİMÜLASYON" explicitly and states that no real network query was made; the output
 * can never be presented as real network verification.
 *
 * The fail-closed contract holds unchanged: the approver's number is required in simulation
 * too, so the masking paths match the real flow exactly, and an unrecognised simulation value
 * is REFUSED at decision time. The window calculation — 24h on medium, the configured value
 * on high — goes through the same code as the real flow, so the demo texts show the real
 * layer's behaviour.
 */
function simDogrula(ayar: AgAyar, risk: AgRisk, sim: string): AgKarar {
  if (ayar.nacToken) {
    /**
     * Contradictory configuration: a real token AND a simulation together. Under the
     * fail-closed principle the looser channel is NOT CHOSEN under ambiguity — it is refused.
     * The warn-and-continue model let an environment leftover from a demo quietly turn real
     * network verification into theatre.
     */
    return {
      engel:
        "Reddedildi [SİMÜLASYON]: AEGIS_NAC_TOKEN ve AEGIS_NAC_SIMULATE birlikte tanımlı — " +
        "çelişkili yapılandırma. Gerçek ağ doğrulaması isteniyorsa AEGIS_NAC_SIMULATE kaldırılmalı, " +
        "demo isteniyorsa token kaldırılmalı. Güvenlik gereği belirsiz yapılandırmada harcama artışı uygulanmaz.",
      kanit: [],
      // No channel was queried: the configuration contradicted itself, so no decision could
      // be reached at all.
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
 * Link 2 of the chain: Number Verification — SIMULATION ONLY.
 *
 * When it runs: ONLY on the "high" tier, and ONLY when AEGIS_NV_SIMULATE is set. When it does
 * not run it returns `undefined` and produces not even an evidence line — on the medium tier
 * the link does not exist at all, so its value is not validated either. That is not a
 * loosening, because on that tier there is no decision the link could make in the first
 * place.
 *
 * The fail-closed contract is the same as the SIM Swap link's: the approver's number is
 * required, and an unrecognised value is REFUSED at decision time, with the raw value NOT
 * echoed into the text in case it is a secret. Every text it produces carries the word
 * "SİMÜLASYON" and states plainly that no real query was made.
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
 * Link 3 of the chain: Device Reachability.
 *
 * When it runs: ONLY on the "high" tier, and ONLY when a channel is configured — either
 * AEGIS_REACH_SIMULATE or a NaC token. With nothing configured it returns `undefined` and not
 * even the trace field is written, because "kapali" is a deliberate declaration that the link
 * was switched off, not the silence of a link nobody asked for.
 *
 * The fail-closed contract is the same as the other links': the approver's number is
 * required, an unrecognised simulation value is REFUSED with the raw value NOT echoed, a
 * silent or unreadable CAMARA response is REFUSED, and "unreachable" is REFUSED.
 */
async function erisilebilirlikKatmani(ayar: AgAyar, risk: AgRisk): Promise<HalkaSonuc | undefined> {
  if (!halkaKosarMi(risk, "reach")) return undefined;
  const sim = ayar.reachSimulate?.trim();
  const gercekAcik = Boolean(ayar.nacToken && ayar.reachCheck);
  if (!sim && !ayar.nacToken) return undefined;

  if (sim) {
    /**
     * The contradiction test is deliberately not "is there a token" but "is the real
     * channel ENABLED": because the link is opt-in, with AEGIS_REACH_CHECK off there is no
     * real channel to query, so a simulation turns no real verification into theatre. When
     * the real channel is on and both are set, the looser channel is NOT CHOSEN under
     * ambiguity.
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
   * A token exists but the link is not enabled: no query is made, DELIBERATELY. No refusal
   * is produced and no evidence line is written — putting a line about "something I did not
   * check" into a human prompt would be noise. The declaration lands only in the structured
   * trace (see HalkaIzi, "kapali").
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
     * A response arrived but could not be read. Saying "unreachable" would be a false
     * accusation and saying "reachable" would be a silent loosening; it is neither — the
     * check could not be answered.
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
    // Upstream text NEVER enters the refusal message; the detail goes to stderr with the
    // number masked.
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
 * Link 4 of the chain: Location — "is the line outside the expected country?".
 *
 * The expectation is never INVENTED: without AEGIS_EXPECTED_COUNTRY the link does not run and
 * records "kapali". Deriving a default country would be a silent loss of security that always
 * makes the answer come out clean.
 *
 * The order is deliberate: with no expectation the link cannot decide anything, so the
 * contradiction and simulation-value checks are not run at all in that case — refusing a
 * spend on the configuration of a link that does not run would produce a refusal with no
 * security gain whatsoever. NV does not validate its value on the medium tier for the same
 * reason.
 */
async function konumKatmani(ayar: AgAyar, risk: AgRisk): Promise<HalkaSonuc | undefined> {
  if (!halkaKosarMi(risk, "loc")) return undefined;
  const sim = ayar.locSimulate?.trim();
  if (!sim && !ayar.nacToken) return undefined;

  const hamUlke = ayar.expectedCountry?.trim();
  if (!hamUlke) {
    if (sim) {
      // The operator explicitly asked for the link but supplied no expectation: staying
      // silent would leave the demo quietly not working. The decision flow is UNAFFECTED;
      // this only goes to stderr.
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
     * THE COUNTRY COMPARISON HAPPENS BEFORE THE ROAMING FLAG, AND INDEPENDENTLY OF IT.
     *
     * Previously the flag split the gate in two and only one half was protected: the
     * `yurtDisinda === false` branch returned clean without looking at `durum.ulkeler` AT
     * ALL, and its evidence line went on to declare "no geography contradicting the expected
     * country" — something the code had never verified. Measured:
     * {yurtDisinda:false, ulkeler:["NL"]} PASSED. If the network says "on the home network"
     * while also reporting a foreign country, that is precisely the contradiction the gate
     * exists to look at; which field gives it away does not matter.
     *
     * AN EMPTY OR UNREADABLE ENTRY IS NOT DROPPED EITHER. The old
     * `.filter(u => u.length > 0)` smuggled the "unreadable field equals clean" pattern back
     * in here: [""] on its own was REFUSED while ["TR",""] passed — the same meaning of
     * "unknown" producing a refusal or a pass depending on how it happened to be represented
     * in the body. Now an unreadable entry simply is not equal to the expected country and
     * falls to REFUSE naturally.
     */
    const ulkeler = (durum.ulkeler ?? []).map((u) => String(u ?? "").trim().toUpperCase());

    if (durum.yurtDisinda === false && !ulkeler.length) {
      /**
       * The line is on its home network and the network reported no country at all: there
       * is no contradiction to compare against. The link's scope deliberately ends here —
       * sub-country geography, a city or a radius, is not what this gate promises today
       * (see the file header, Link 4).
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
      // Abroad, but which country is unclear: it cannot be compared against the
      // expectation, so this fails closed.
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
     * THE CRITERION IS NOT "is the expected country PRESENT in the set" but "was the line
     * seen ONLY in the expected country": if not ALL the reported countries equal the
     * expected one, it is REFUSED. Searching the set for the expected country was fail-open —
     * when the network reports {NL, TR} the verdict comes out clean, even though the line has
     * also been seen in an unexpected geography; and the evidence line then gives the auditor
     * a one-sided declaration ("in the expected country") from which the second country
     * cannot be read at all. It would also contradict the link's own behaviour a few lines
     * above: refusing with "cannot be compared" when the country is UNREADABLE, while passing
     * when it is read and CONTRADICTORY.
     *
     * AN HONEST TRADE, written down deliberately: because of border regions, MVNOs and
     * satellite coverage the network can LEGITIMATELY report two countries, and in that case
     * a LEGITIMATE user is REFUSED. We accept that, because (1) the link runs ONLY on the
     * "high" tier and ONLY when an expected country is configured, and (2) "a line appearing
     * in two countries at once" is exactly what this gate exists to look at. Under the
     * fail-closed principle a contradiction produces a refusal just as ambiguity does; the
     * refusal reason is not a new code but the same "konum-beklenmedik".
     */
    if (!ulkeler.every((u) => u === beklenen)) {
      /**
       * The OBSERVED country is NEVER written — not into the refusal text, not into the
       * trace. All that leaves is the derived decision and the expected-country code that
       * came FROM CONFIGURATION; no upstream detail leaks, not even how many countries the
       * network reported.
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
 * Link 5 of the chain: Device Swap — "did the line move to a NEW HANDSET in the last N
 * hours?".
 *
 * SIM Swap's structural twin (see the file header, Link 5), and its fail-closed contract is
 * the same as the other links': the approver's number is required, an unrecognised simulation
 * value is REFUSED with the raw value NOT echoed, contradictory configuration is REFUSED, an
 * unreadable or silent CAMARA response is REFUSED, and "changed" is REFUSED.
 *
 * When it runs: ONLY on the "high" tier, and ONLY when a channel is configured. The real
 * channel is additionally OPT-IN (AEGIS_DEVICESWAP_CHECK): the presence of a token does not
 * ENABLE the query on its own — an unwanted CAMARA round trip would add latency to every
 * approval.
 */
async function cihazDegisimKatmani(ayar: AgAyar, risk: AgRisk): Promise<HalkaSonuc | undefined> {
  if (!halkaKosarMi(risk, "devSwap")) return undefined;
  const sim = ayar.devSwapSimulate?.trim();
  const gercekAcik = Boolean(ayar.nacToken && ayar.devSwapCheck);
  if (!sim && !ayar.nacToken) return undefined;

  if (sim) {
    // The contradiction test is not "is there a token" but "is the real channel ENABLED"
    // (the reasoning from link 3).
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

  // A token exists but the link is not enabled: DELIBERATELY no query, no refusal and no
  // evidence line — the declaration lands only in the structured trace (the same reasoning as
  // link 3).
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
     * A response arrived but could not be read. Saying "did not change" would be a silent
     * loosening and saying "changed" would be a false accusation; it is neither — the check
     * could not be answered.
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
    // Upstream text NEVER enters the refusal message; the detail goes to stderr with the
    // number masked.
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
 * Link 6 of the chain: Call Forwarding — "is UNCONDITIONAL call forwarding active on the
 * line?".
 *
 * Active forwarding is the classic way to intercept an OTP or a voice verification, and none
 * of the previous five links can see it: the SIM is the same, the device is the same, the
 * line is reachable, the country is the expected one.
 *
 * Failing closed covers two further traps (see the file header, Link 6): the `active` field is
 * OPTIONAL in the type — failing to read it means "unknown", not "no forwarding", and
 * produces a REFUSAL; and every throw from the endpoint, 501 included, is a REFUSAL too.
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
     * `active` is OPTIONAL in the CAMARA response: its absence means "unknown", NOT
     * "forwarding is off". Treating the unknown as clean would swallow the reason this link
     * exists.
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
     * EVERY throw lands here and produces a REFUSAL, 501 (NotImplementedError) included: if
     * the operator's network does not offer this signal the link should be SWITCHED OFF
     * (AEGIS_CALLFWD_CHECK) rather than passed over quietly — "I got no answer" and "there is
     * no forwarding" are not the same thing.
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
 * The chain runs in a FIXED, ONE-DIRECTIONAL order:
 *   SIM Swap → Number Verification → Device Reachability → Location
 *   → Device Swap → Call Forwarding
 * The last five run ONLY on the "high" tier. A link's refusal is FINAL: the chain returns
 * at that point, and the later links neither run nor can soften the verdict — a later link
 * can only add another reason to refuse.
 */
export async function agDogrula(ayar: AgAyar, risk: AgRisk): Promise<AgKarar> {
  /**
   * ASSEMBLING THE CHAIN, AND STEP-UP VERIFICATION.
   *
   * Every link that runs writes to its OWN trace field; they are NEVER collapsed into one.
   * "A real CAMARA SIM Swap query plus an NV simulation plus a disabled location link" and
   * "all of it simulated" are different levels of confidence, and proving that distinction is
   * the audit trace's whole job. The rule has to be won again with each new link: a new link
   * requires both its OWN AgIz field and its own record field in kararGunlugu.ts.
   *
   * WHAT HAPPENS ON A DEGRADED SIGNAL. The gate used to return at the first obstacle. Now the
   * KIND of obstacle is what matters:
   *
   *   - A reason that cannot be escalated — active call forwarding, a number mismatch, a
   *     configuration fault — refuses IMMEDIATELY, as before. The remaining links are never
   *     called; there is no point going to the network for an action that is already refused.
   *   - A reason that can be escalated — a changed SIM or device, travel, a phone that is off,
   *     a silent network — with step-up ON does NOT stop the chain. The remaining links are
   *     run to look for evidence that corroborates the degraded signal.
   *
   * One of three things follows, and all three are distinguishable in the trace:
   *   refused             — a vouching link was degraded too, or there was no real voucher
   *   passed by escalation — ALL the remaining links came back clean over a real channel
   *   passed clean        — there was no degraded signal at all
   */
  const kademeAcik = ayar.stepUp === true;

  /** When an escalation is held pending: the record of the first degraded signal. */
  let bekleyen: { engel: string; neden: RetNedeni; aciklama: string } | undefined;
  /**
   * EVERY link that came back clean over a REAL channel — regardless of its position.
   *
   * The first version counted only the links that ran AFTER the degraded signal, which tied
   * corroboration to the order of the chain: because the reachability link runs before the
   * location link, it did not count as a voucher despite being clean and real. But
   * whether a signal came back clean has nothing to do with whether the degraded signal
   * arrived before or after it.
   */
  const temizGercek: string[] = [];

  /**
   * EVERY SIGNAL THAT CAME BACK DEGRADED — whichever one makes the decision.
   *
   * `iz.retNedeni` is a single slot and a later link overwrites it; this array drops no
   * degraded signal at all (see AgIz.retNedenleri). The same reason is never added twice: an
   * auditor should be able to answer "how many distinct signals were degraded" by counting.
   */
  const bozuklar: RetNedeni[] = [];
  const bozukKaydet = (neden: RetNedeni | undefined): void => {
    if (neden !== undefined && !bozuklar.includes(neden)) bozuklar.push(neden);
  };
  /** Attaches the degraded-signal list to the returned trace; with none, the field is not
   * opened AT ALL. */
  const izle = (ham: AgIz): AgIz => (bozuklar.length ? { ...ham, retNedenleri: [...bozuklar] } : ham);

  let kanit: string[] = [];
  let iz: AgIz = { simSwap: "kapali" };

  /**
   * Folds a single link's result into the chain and says whether the flow continues.
   *
   * `gercekMi` is a separate parameter on purpose: a SIMULATED link cannot corroborate a
   * degraded REAL signal. Otherwise, in demo mode a single environment value would make a
   * genuine SIM change look "verified" — which would be the easiest way past the gate.
   */
  const kat = (
    id: string,
    sonuc: { engel?: string; kanit: string[]; retNedeni?: RetNedeni },
    gercekMi: boolean,
    aciklama: string
  ): "devam" | "dur" => {
    if (sonuc.engel) {
      const neden = sonuc.retNedeni;
      // The signal degraded: it ENTERS the trace whether or not this link makes the
      // decision.
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
    // If a degraded signal arrives LATER, this link counts among its vouchers.
    temizGercek.push("simSwap");
  }

  const nv = nvKatmani(ayar, risk);
  if (nv) {
    iz = { ...iz, nv: nv.nv, maskeliNumara: iz.maskeliNumara ?? nv.maskeliNumara, retNedeni: nv.retNedeni ?? iz.retNedeni };
    // NV is simulation-only, so it does not count as a voucher (gercekMi = false).
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
       * It writes to its OWN field, NOT to `pencereSaat`: that field belongs to the SIM
       * Swap link, and if two links' windows are collapsed into one an auditor cannot tell
       * which question was asked with which window (see AgIz.devSwapPencereSaat).
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
   * THE ESCALATION DECISION. This point is reached only with an escalatable degraded
   * signal, and with none of the remaining links having refused — a refusal would have
   * returned above.
   *
   * AT LEAST ONE REAL VOUCHER IS REQUIRED TO PASS. An escalation without one means "the
   * signal was degraded but there was nobody else to ask, so let it through" — opening the
   * gate at exactly the moment it closes. Simulation channels deliberately do not count, so
   * that in demo mode a single environment value cannot paper over a genuine SIM change.
   */
  /**
   * THE VOUCHER FILTER. Coming back clean is not enough; the link also has to be CAPABLE OF
   * DISPROVING the degraded signal (see KEFIL_ESLEMESI). Before this filter the condition was
   * "at least one real link came back clean", which allowed the reachability link to vouch on
   * its own for a genuine SIM change.
   */
  // Narrowing is not preserved inside the closure, so the degraded signal is captured in a
  // constant.
  const kefilKumesi = KEFIL_ESLEMESI[bekleyen.neden] ?? [];
  const kefiller = temizGercek.filter((id) => kefilKumesi.includes(id));

  if (!kefiller.length) {
    /**
     * The two situations are reported DISTINCTLY: no real link having run at all is not the
     * same as links having run with none of them having anything to say about this signal.
     * Reporting the second as if it were the first would show the operator a configuration
     * problem that is not there.
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
 * Link 1 of the chain: SIM Swap, through either a real CAMARA query or the SIMULATION
 * channel. The decision logic is unchanged from before the links were separated.
 */
async function simSwapKatmani(ayar: AgAyar, risk: AgRisk): Promise<AgKarar> {
  // When a simulation is set it takes effect BEFORE the real channel, regardless of any
  // token: a jury demo runs without the SDK or a token, and the decision logic and
  // fail-closed paths are identical.
  const sim = ayar.nacSimulate?.trim();
  if (sim) return simDogrula(ayar, risk, sim);

  if (!ayar.nacToken) {
    // The layer is DELIBERATELY disabled: not a configuration fault, and no query.
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
     * A response arrived but COULD NOT BE READ (see kanalGetir). Saying "did not change"
     * would be a silent loosening and saying "changed" would be a false accusation; it is
     * neither — the check could not be answered. The trace says "gercek": the configuration
     * was sound and the query really WAS attempted with this window.
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
       * The channel is "gercek": the configuration was sound and a real query WAS attempted
       * with this window — no answer came back. Calling it "calismadi" would put it in the
       * same class as a decision that was never asked because of a configuration fault, and
       * in an audit those are distinct situations.
       */
      iz: { simSwap: "gercek", pencereSaat: pencere, maskeliNumara: maskeli, retNedeni: "ag-yanitsiz" },
    };
  }
}
