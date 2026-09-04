// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The network gate's DECISION LOG — the audit trail.
 *
 * When the network gate (networkTrust.ts) refuses a spending increase it tells only the
 * agent; the account owner has no way to answer "how many times was I refused last month,
 * under which window, over which channel" afterwards. This module accumulates every
 * risk-tagged network decision as a single line of JSONL, and never touches the gate itself.
 *
 * FIVE INVARIANTS:
 *
 * 1) THE LOG IS AN OBSERVATION, NOT A GATE. A write failure — a bad path, a read-only
 *    directory, a full disk — NEVER brings the approval flow down: the error is written to
 *    stderr as one line and the flow continues unchanged. The opposite would turn an audit
 *    tool into a new point of failure: legitimate spending approvals would break because of
 *    a mistyped path.
 *
 * 2) NO SECRETS ARE WRITTEN. A full approver number, a NaC token or raw upstream error text
 *    NEVER enters a record. The number field is the gate's own maskele() output and is
 *    additionally validated structurally before it is written here (at least one '*' — an
 *    unmasked E.164 number cannot get through that gate). The refusal reason is not free
 *    text but a code from networkTrust's FIXED RetNedeni vocabulary, so no upstream text can
 *    leak into the log.
 *
 * 3) THE RECORD IS DERIVED FROM THE TRACE, NOT FROM TEXT. Channel, window, number and
 *    refusal reason used to be guessed by sniffing the refusal and evidence STRINGS; because
 *    two links' text merged into one string, the log could lie (SIM Swap off plus an NV
 *    simulation showed as "gecti/simulasyon", while a real CAMARA query plus an NV
 *    simulation was written as "simulasyon" instead of "gercek"). Every field now comes from
 *    AgKarar.iz, and EVERY link of the chain is written to its OWN field (simSwapKanali /
 *    nvKanali / reachKanali / locKanali / devSwapKanali / callFwdKanali) — NEVER collapsed
 *    into one boolean. The windowed links are separate too: pencereSaat belongs to SIM Swap,
 *    devSwapPencereSaat to link 5.
 *
 *    This rule has to be won again with every link added: when links 3 and 4 were first
 *    written they were in the trace but did not reach the record, so a refusal produced by a
 *    SIMULATED link appeared in the log with only "simSwapKanali":"gercek" and was taken for
 *    the product of a real CAMARA query. Adding a link means adding its field here.
 *
 * 4) THE AMOUNT IS MEASURED, NOT GUESSED. "How many times was it refused" is half an answer;
 *    an auditor also asks "spending of WHAT SIZE". So the daily amount the decision concerns
 *    is written to the `tutar` field — but ONLY when the call site genuinely managed to read
 *    it. For an unreadable budget the field is not written at all; writing 0 would record "I
 *    do not know" as "zero spending", against the very reason this file exists.
 *
 * 5) THE LOG HAS A CEILING. An audit file that grows without bound can be used to fill the
 *    disk with a flood of requests that do not even require approval; and on a full disk the
 *    trail stops SILENTLY, because a write failure does not bring the flow down. A file that
 *    reaches the ceiling is rolled over to `<path>.1` (see GUNLUK_AZAMI_BAYT).
 *
 * The log is OFF by default: with AEGIS_DECISION_LOG unset no file is created and nothing is
 * written (the demo and compose environments switch it on).
 */
import { appendFileSync, renameSync, statSync } from "node:fs";
import type { AgKarar, AgRisk, HalkaIzi, NvIzi, RetNedeni, SimSwapIzi } from "./networkTrust.js";

/**
 * The VOCABULARY of the gate's verdict — four values, and that is all of them.
 *
 * "kademeli" is a SEPARATE outcome and is not folded into "gecti". For an auditor that
 * distinction is the whole job: "no signal was degraded" and "one signal was degraded, and
 * because the others came back clean it passed by asking a human" are not the same level of
 * confidence. Collected under a single "gecti" label, the moments the gate loosened become
 * indistinguishable from the moments it was never under pressure — and the question "how
 * many times did we escalate" becomes unanswerable after the fact.
 */
export const KARAR_SONUCLARI = ["gecti", "kademeli", "ret", "kapali"] as const;

/**
 * The type is derived FROM THE ARRAY, not the other way round: the guard that checks the
 * documentation (docs/DEMO.md and .env.example) counts these values needs a list it can read
 * at runtime. A hand-written union allowed a fourth value to be added to the vocabulary
 * silently: the code wrote "kademeli" while the documentation listed three values, and for
 * an operator building counters from that documentation the rows where the gate softened
 * fell into no bucket at all.
 */
export type KararSonucu = (typeof KARAR_SONUCLARI)[number];

export interface KararKaydi {
  /** ISO-8601 timestamp. */
  zaman: string;
  /** A one-sentence summary of the action (abbreviated; contains the campaign name, never a
   * secret). */
  eylem: string;
  /**
   * The ad account this decision belongs to (the Google Ads customer ID). In hosted
   * multi-tenant mode every tenant's decisions land in ONE file, so without this field the
   * question "what happened in whose account" could not be answered. If the call site does
   * not pass it, it is not written.
   */
  hesapId?: string;
  risk: AgRisk;
  karar: KararSonucu;
  /**
   * When step-up verification engaged, the ids of the links that CARRIED the escalation.
   * With no escalation the field is not written at all — so that "there was no escalation"
   * and "there was one but its vouchers went unrecorded" cannot be confused.
   */
  kademeDogrulayan?: string[];
  /** Link 1: was it a real CAMARA query, a simulation, disabled, or unable to run at
   * all. */
  simSwapKanali: SimSwapIzi;
  /** Link 2 (Number Verification); if the link never ran, the field is ABSENT. */
  nvKanali?: NvIzi;
  /** Link 3 (Device Reachability); if the link never ran, the field is ABSENT. */
  reachKanali?: HalkaIzi;
  /** Link 4 (location / expected country); if the link never ran, the field is ABSENT. */
  locKanali?: HalkaIzi;
  /** Link 5 (Device Swap — the number moving to a new handset); if the link never ran, the
   * field is ABSENT. */
  devSwapKanali?: HalkaIzi;
  /** Link 6 (Call Forwarding); if the link never ran, the field is ABSENT. */
  callFwdKanali?: HalkaIzi;
  /** The SIM-swap look-back window that was queried, in hours; absent when no query ran. */
  pencereSaat?: number;
  /**
   * Link 5's OWN look-back window, in hours. It is not merged with pencereSaat: the device
   * swap link can run even while the SIM Swap layer is disabled, and recording that window
   * as if it were SIM Swap's would mislead an auditor.
   */
  devSwapPencereSaat?: number;
  /**
   * THE AMOUNT AT RISK: the DAILY sum the decision concerns, in the account's OWN currency.
   * Alongside "how many times was I refused last month" sits the question "of what size",
   * and without this field it could not be answered.
   *
   * THREE RULES:
   *
   * a) THERE IS NO CURRENCY FIELD. The unit is already the account's context (hesapId plus
   *    that account's Google Ads or Meta currency); inventing a `paraBirimi` here would
   *    record as measured something the gate never measured.
   *
   * b) THE CURRENCY AMOUNT, NOT MICROS. 50 TRY is written as "50", not "50000000": that is
   *    the number an auditor reads, and digit strings of micros magnitude also looked like
   *    identifiers or phone numbers to the secret scanners run over these records.
   *
   * c) AN UNREADABLE AMOUNT IS NOT WRITTEN. If the call site could not read the budget it
   *    does not pass the field AT ALL; writing 0 or a guess would record "I do not know" as
   *    "zero spending". Its meaning varies by operation, deliberately: for a budget change it
   *    is the NEW budget; when adding an ad or keyword to a live campaign it is that
   *    campaign's current daily budget, the ceiling being put at risk; and for a go-live it
   *    is the campaign's daily budget.
   */
  tutar?: number;
  /** The approver's number in MASKED form (for example "+905*******33"); never the full
   * number. */
  maskeliNumara?: string;
  /** A refusal code from networkTrust's fixed vocabulary; NOT free or upstream text. */
  retNedeniKisa?: RetNedeni;
  /**
   * EVERY refusal reason produced along the chain (see AgIz.retNedenleri) — whereas
   * `retNedeniKisa` is only the reason that MADE the decision, and is overwritten as the
   * chain proceeds. Without this field, "the SIM changed and call forwarding is active"
   * produced a line byte-for-byte identical to "call forwarding is active": the detected SIM
   * change was erased from the trail, and the line gave the impression of a clean query. If
   * no refusal reason was produced at all, the field is NOT written.
   */
  retNedenleri?: RetNedeni[];
}

/** Campaign names can be long; this keeps the log line bounded. */
const EYLEM_AZAMI = 160;

/** The account ID is length-bounded too: whatever the call site sends, the line does not
 * bloat. */
const HESAP_ID_AZAMI = 32;

/**
 * The masked-number pattern: it MUST contain at least one '*'. An unmasked E.164 number
 * (only '+' and digits) cannot structurally match it.
 *
 * The trace already carries maskele() output; this check does not replace that, it VERIFIES
 * it — a last line of defence in case some future layer fills the trace with a raw number,
 * so the secret does not reach the log (fail closed: a suspicious value is dropped, not
 * written).
 */
const MASKELI_NUMARA_DESENI = /\*/;

function kisalt(metin: string, azami: number): string {
  const tek = metin.replace(/\s+/g, " ").trim();
  return tek.length <= azami ? tek : tek.slice(0, azami - 1) + "…";
}

/** A number that looks unmasked is NOT recorded; it is not swallowed silently either — it
 * is reported on stderr. */
function maskeliDogrula(numara: string | undefined): string | undefined {
  if (numara === undefined) return undefined;
  if (MASKELI_NUMARA_DESENI.test(numara)) return numara;
  console.error(
    "[aegis] karar günlüğü: maskesiz görünen numara alanı kayda YAZILMADI (sır sızıntısı önlendi)"
  );
  return undefined;
}

/**
 * Validates the amount at risk as a number BEFORE it is recorded.
 *
 * NaN, Infinity, a negative value or anything that is not a number is a fault at the call
 * site leaking into the log — an unreadable `amount_micros` quietly becoming NaN, for
 * instance. Writing such a value would show an auditor a fabricated magnitude, so the field
 * is DROPPED — but not silently: the operator sees it on stderr.
 *
 * 0 is valid and is not dropped: "the budget read as 0" is a real measurement, whereas
 * "could not be read" is expressed by the call site not passing the field at all.
 */
function tutarDogrula(tutar: number | undefined): number | undefined {
  if (tutar === undefined) return undefined;
  if (typeof tutar === "number" && Number.isFinite(tutar) && tutar >= 0) return tutar;
  console.error(
    "[aegis] karar günlüğü: geçersiz riskteki tutar kayda YAZILMADI (uydurma büyüklük önlendi)"
  );
  return undefined;
}

/**
 * Did NO link run a query at all? With no refusal present, that is "kapali" (disabled), not
 * "gecti" (passed) — presenting a check that was never asked as having been passed makes the
 * audit lie.
 *
 * The criterion is link 1 alone, and that is deliberate: the SIM Swap link produces a verdict
 * about a SIM change, either through a real CAMARA query or, in a demo, through the simulated
 * channel. Link 2 (Number Verification) STRUCTURALLY cannot run a query — real NV requires a
 * device-side OIDC flow that a server cannot call on its own (see the header of
 * networkTrust.ts). So NV can REFUSE a decision but can never turn "disabled" into "passed":
 * an NV simulation making an action look verified while SIM Swap was off was precisely the
 * lie this log exists to correct.
 */
function hicSorguYok(simSwap: SimSwapIzi): boolean {
  return simSwap !== "gercek" && simSwap !== "simulasyon";
}

/**
 * Turns the network gate's verdict into a log record. Every field comes from the gate's
 * STRUCTURED trace (AgKarar.iz); the refusal and evidence strings are no longer read at
 * all.
 */
export function agKararKaydiOlustur(
  eylem: string,
  risk: AgRisk,
  ag: AgKarar,
  hesapId?: string,
  /** The daily amount at risk; the call site passes it when it COULD read it, and not at
   * all when it could not. */
  tutar?: number
): KararKaydi {
  const iz = ag.iz;
  return {
    zaman: new Date().toISOString(),
    eylem: kisalt(eylem, EYLEM_AZAMI),
    hesapId: hesapId?.trim() ? kisalt(hesapId, HESAP_ID_AZAMI) : undefined,
    risk,
    karar: ag.engel ? "ret" : iz.kademe === "yukseltildi" ? "kademeli" : hicSorguYok(iz.simSwap) ? "kapali" : "gecti",
    simSwapKanali: iz.simSwap,
    nvKanali: iz.nv,
    reachKanali: iz.reach,
    locKanali: iz.loc,
    devSwapKanali: iz.devSwap,
    callFwdKanali: iz.callFwd,
    pencereSaat: iz.pencereSaat,
    devSwapPencereSaat: iz.devSwapPencereSaat,
    tutar: tutarDogrula(tutar),
    maskeliNumara: maskeliDogrula(iz.maskeliNumara),
    /**
     * Written on an escalated decision too. Here the refusal reason names not "why it was
     * refused" but "which signal was degraded"; without that name in an escalation record,
     * an auditor never learns WHY the step-up engaged.
     */
    retNedeniKisa: ag.engel || iz.kademe === "yukseltildi" ? iz.retNedeni : undefined,
    kademeDogrulayan: iz.kademe === "yukseltildi" ? iz.kademeDogrulayan : undefined,
    /**
     * An empty array does NOT open the field: the distinction between "we looked and no
     * signal was degraded" and "we never looked" is the same rule as everywhere else in this
     * file — an unknown field is not written.
     */
    retNedenleri: iz.retNedenleri?.length ? [...iz.retNedenleri] : undefined,
  };
}

/**
 * Appends the record as JSONL. With AEGIS_DECISION_LOG unset the LOG IS OFF: no file is
 * created and no side effect is produced.
 *
 * The environment is read at decision time rather than at module load: being able to switch
 * the log on and off within a single process is needed by both the operator and the tests.
 */
/**
 * THE LOG FILE'S BYTE CEILING, and its single generation of backup.
 *
 * Writing records had no upper bound: every risky decision appended a line and the file only
 * grew. A single malicious — or merely buggy — agent could fill the disk with a flood of
 * requests that do not even require approval, because the gate refuses them anyway. And a
 * full disk is this module's worst failure mode: since a write error does not bring the flow
 * down, nobody
 * etmez, denetim izi sessizce durur.
 *
 * On reaching the ceiling the file is rolled over to `<path>.1` and a new one is opened. A
 * single generation is deliberate: a fixed two-file ceiling is the only honest middle ground
 * between "unbounded growth" and "no trail at all". Long-term retention is the job of the
 * operator's log collector, not of this module.
 */
const GUNLUK_AZAMI_BAYT = 16 * 1024 * 1024;

/**
 * Rolls over a file that has reached the ceiling. The error is neither SWALLOWED nor
 * ESCALATED: if the rollover fails — the file is locked, the directory is read-only — the
 * line is still appended. Cutting off the audit trail because "I could not rotate" is a
 * bigger problem than the one the ceiling solves.
 */
function dosyayiDevret(hedef: string): void {
  try {
    if (statSync(hedef).size < GUNLUK_AZAMI_BAYT) return;
    renameSync(hedef, `${hedef}.1`);
  } catch (e: any) {
    // ENOENT means the file does not exist yet: there is nothing to roll over, so this
    // passes quietly.
    if (e?.code === "ENOENT") return;
    console.error(
      `[aegis] karar günlüğü devredilemedi (${hedef}): ${e?.message ?? e} — satır yine de eklenecek`
    );
  }
}

export function kararYaz(kayit: KararKaydi): void {
  const hedef = process.env.AEGIS_DECISION_LOG?.trim();
  if (!hedef) return;
  dosyayiDevret(hedef);
  try {
    /**
     * The field order is deliberate: JSON.stringify drops undefined fields, so "could not be
     * measured" is never confused with "empty".
     *
     * CAREFUL — this list is written BY HAND and its omissions are SILENT: forget a field
     * that exists on the record object and the line is still valid JSON, no type error
     * appears, and the field never reaches disk. `kademeDogrulayan` escaped in exactly this
     * way: the vouching links carrying an escalation were produced but not written, so "there
     * was no escalation" and "its vouchers went unrecorded" were permanently confused.
     * test/kararGunlugu.test.ts checks this list IN BOTH DIRECTIONS: every populated field on
     * the record must also appear in the line.
     */
    const satir = JSON.stringify({
      zaman: kayit.zaman,
      eylem: kayit.eylem,
      hesapId: kayit.hesapId,
      risk: kayit.risk,
      karar: kayit.karar,
      simSwapKanali: kayit.simSwapKanali,
      nvKanali: kayit.nvKanali,
      reachKanali: kayit.reachKanali,
      locKanali: kayit.locKanali,
      devSwapKanali: kayit.devSwapKanali,
      callFwdKanali: kayit.callFwdKanali,
      pencereSaat: kayit.pencereSaat,
      devSwapPencereSaat: kayit.devSwapPencereSaat,
      tutar: kayit.tutar,
      maskeliNumara: kayit.maskeliNumara,
      retNedeniKisa: kayit.retNedeniKisa,
      retNedenleri: kayit.retNedenleri,
      kademeDogrulayan: kayit.kademeDogrulayan,
    });
    appendFileSync(hedef, satir + "\n", "utf8");
  } catch (e: any) {
    /**
     * Swallowing this silently would be as bad as dropping it: the operator would have no
     * way to notice that the audit trail is not being kept. One line, and the flow continues
     * unaffected.
     */
    console.error(
      `[aegis] karar günlüğü yazılamadı (${hedef}): ${e?.message ?? e} — onay akışı etkilenmedi`
    );
  }
}
