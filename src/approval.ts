// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Human-in-the-loop approval gate, used by every path that can increase spend.
 *
 * A `confirm` flag on its own is only a claim: the agent decides whether a human was
 * ever consulted and nothing verifies it. MCP elicitation lets the server ask the
 * human through the protocol, which turns consent into something observable.
 *
 * When elicitation is available the agent's `confirm` value is deliberately ignored —
 * honouring both would make the strong gate meaningless next to the weak one. Clients
 * without elicitation fall back to `confirm` for compatibility.
 *
 * Every failure mode — declined, cancelled, timed out, transport error — resolves to
 * "do not execute".
 *
 * When a risk tier is attached to the summary, the mobile network is consulted BEFORE
 * any prompt is shown (see networkTrust.ts): a recently swapped approver SIM refuses
 * the action outright, because the person who would answer the prompt may be the
 * attacker who swapped it.
 *
 * Every network decision — refusals AND passes — is written to kararGunlugu.ts for the
 * audit trail. The log is an observation, not a gate: if it cannot be written, the flow
 * continues unchanged.
 *
 * TWO CHANNELS, TWO AUDIENCES. An approval summary has two distinct readers: the HUMAN who
 * decides, and the AGENT that made the request. `satirlar` goes to both (on a client
 * without elicitation it is written into the refusal text as well); `insanSatirlari` goes
 * to the human ONLY. The gate's own evidence — the masked number, the look-back window, the
 * expected country — and server-side secrets live in the second channel: an agent inside a
 * stolen session must not learn the gate's dimensions with every refused attempt.
 *
 * STEP-UP DOES NOT PASS ON THE WEAK CHANNEL. An escalation rests on being able to ask the
 * human a stronger question; on a client with no prompt to show there is no escalation, and
 * the agent's own `confirm=true` does not stand in for that prompt.
 *
 * THE FRAME OF THE PROMPT BELONGS TO THIS FILE. The summary is assembled by the calling tool
 * out of values read from the ad account — the campaign name above all — so the text is not
 * this server's. Every caller-supplied field is stripped of line breaks, control bytes and
 * invisible characters before anything is composed out of it (see istemMetniTemizle), so the
 * only line structure the human sees is the one written here.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  agDogrula,
  operatorMetniTemizle,
  type AgAyar,
  type AgRisk,
  type KademeKarari,
} from "./networkTrust.js";
import { agKararKaydiOlustur, kararYaz } from "./kararGunlugu.js";

export type OnayKanali = "insan" | "ajan" | "ag";

export interface OnaySonucu {
  onaylandi: boolean;
  kanal: OnayKanali;
  /** Reason shown to the agent when the request is refused. */
  mesaj?: string;
}

export interface OnayOzeti {
  /** The action as a single sentence, e.g. "the campaign will go live". */
  eylem: string;
  /**
   * The concrete lines the user needs to see in order to decide.
   *
   * CAREFUL: on a client without elicitation these lines GO BACK TO THE AGENT along with
   * the refusal text. Put here what the agent already knows because it sent it; everything
   * the agent has no need to know belongs in `insanSatirlari`.
   */
  satirlar: string[];
  /**
   * Lines shown to the HUMAN ONLY — these NEVER go back to the agent.
   *
   * `satirlar` was going to two places at once: the elicitation prompt AND the refusal text
   * on a client without elicitation. The second path wrote the gate's own evidence (the
   * masked approver number, the look-back window, the expected country) and server-side
   * secrets (the Meta ad account ID) into the agent's context — and from there into
   * transcripts. An agent inside a stolen session learned the SHAPE of the gate with every
   * refused attempt.
   *
   * The distinction is this: everything the human needs in order to DECIDE but the agent has
   * NO NEED TO KNOW belongs here. Values the agent sent itself (the customer ID, the
   * requested budget) can stay in `satirlar` — hiding those keeps nothing from anyone.
   */
  insanSatirlari?: string[];
  /** Label of the confirmation checkbox. */
  soru?: string;
  /** Spend-risk tier; with `agAyar` set, the network is consulted before any prompt. */
  risk?: AgRisk;
  /** Network-verification config slice, passed by the calling tool from ctx.config. */
  agAyar?: AgAyar;
  /**
   * The ad account this decision belongs to (the Google Ads customer ID). It is written to
   * the audit log only and does NOT affect the decision logic. In hosted multi-tenant mode
   * every tenant's decisions land in one file, so without this field the records could not
   * be told apart.
   */
  hesapId?: string;
  /**
   * THE AMOUNT AT RISK: the DAILY sum this decision is about, in the account's own currency
   * rather than micros. Like hesapId it is written only to the audit log and does NOT affect
   * the decision logic — the gate's threshold is the budget ceiling, not this field.
   *
   * AN UNREADABLE AMOUNT IS NOT PASSED THROUGH. The call site passes it when it genuinely
   * read the budget; when it could not, it omits the field and nothing is recorded. Passing
   * 0, or a guess, would record "I do not know" as "clean / zero".
   */
  tutar?: number;
}

/**
 * FORM mode is required: the SDK's `elicitInput` form call looks for the
 * `elicitation.form` capability. Testing only for the presence of an `elicitation`
 * object takes the strong branch on a url-mode-only client, where every approval
 * then errors out and the user can NEVER launch a campaign.
 */
function elicitationVar(server: McpServer): boolean {
  try {
    const e: any = server.server.getClientCapabilities()?.elicitation;
    if (!e) return false;
    // No sub-capabilities advertised (older clients): assume form support.
    if (typeof e !== "object") return true;
    const altlar = Object.keys(e);
    return altlar.length === 0 || "form" in e;
  } catch {
    return false;
  }
}

/**
 * Is this code point one that can move text off the line the server put it on, or hide it
 * there? The C0 controls (NUL, TAB, CR, LF and the ESC that starts every ANSI sequence),
 * DEL and the C1 controls, the Unicode line and paragraph separators, the bidi marks,
 * overrides and isolates, and the zero-width / word-joiner family.
 *
 * Written as a numeric predicate rather than a character class on purpose: a range like
 * this spelled out inside a regex literal puts the raw bytes it is meant to catch INTO
 * this source file, where a reviewer cannot see them and a careless editor can eat them.
 */
function gorunmezMi(kod: number): boolean {
  return (
    kod <= 0x1f ||
    (kod >= 0x7f && kod <= 0x9f) ||
    kod === 0x061c ||
    (kod >= 0x200b && kod <= 0x200f) ||
    kod === 0x2028 ||
    kod === 0x2029 ||
    (kod >= 0x202a && kod <= 0x202e) ||
    (kod >= 0x2060 && kod <= 0x2064) ||
    (kod >= 0x2066 && kod <= 0x2069) ||
    kod === 0xfeff
  );
}

/**
 * NEUTRALISES THE STRUCTURE OF TEXT THIS SERVER DID NOT WRITE, before it is rendered into
 * the human prompt or into a refusal.
 *
 * `eylem` and the summary lines are assembled by the calling tool out of values READ FROM
 * THE ACCOUNT — above all the campaign name, which is free-form text that an agent chose and
 * that a prompt-injected page can therefore dictate (analyze_site). The only server-side
 * check on that name is `z.string().min(1).max(255)`: no control characters, no ANSI, no
 * quoting.
 *
 * Measured before this existed: a campaign name carrying a newline and a "•" produced an
 * extra, entirely FORGED bullet in the elicitation prompt — a line the human reads as the
 * gate's own words ("the network check already passed cleanly, this prompt is a formality") —
 * and an ESC byte in the same name reached a terminal client's screen, where a sequence can
 * repaint or erase the "⚠ NO GEO TARGET" warning underneath it. The prompt is the ONE
 * surface on which the human's consent is formed; whoever controls its line structure
 * controls what that consent is given TO.
 *
 * So the frame stays the server's: every one of those characters becomes a single space and
 * runs of whitespace collapse, which leaves untrusted text able to occupy only the line the
 * server put it on.
 *
 * NOTHING IS TRUNCATED, and this is a RENDERING rule, not a silent correction of a value —
 * the stored campaign name is untouched, and no gate reads these strings. A length cap was
 * deliberately not added: it would drop part of what the human is deciding about (the
 * keyword list of add_keywords is one line and legitimately long), and a gate that hides its
 * own evidence from the person deciding is worse than one that prints a long line.
 */
function istemMetniTemizle(s: string): string {
  const duz = Array.from(String(s ?? ""), (ch) =>
    gorunmezMi(ch.codePointAt(0)!) ? " " : ch
  ).join("");
  return duz.replace(/\s+/g, " ").trim();
}

/**
 * Obtains approval for a dangerous (money-spending) operation.
 * @param agentConfirm The confirm flag sent by the agent — honoured ONLY on clients
 *   without elicitation support (backwards compatibility).
 */
export async function onayAl(
  server: McpServer,
  ozet: OnayOzeti,
  agentConfirm: boolean | undefined
): Promise<OnaySonucu> {
  /**
   * THE FRAME IS TAKEN BACK FIRST — before a single byte of this summary is composed into
   * anything (see istemMetniTemizle).
   *
   * It has to happen here rather than at the point of rendering, because there are three
   * renderings, not one: the elicitation prompt, the weak-channel refusal, and the
   * step-up header that is built OUT OF `eylem` further down. Cleaning at one of them
   * would leave the other two holding the caller's line breaks — and the step-up header is
   * precisely the text an injected campaign name would want to forge.
   */
  ozet = {
    ...ozet,
    eylem: istemMetniTemizle(ozet.eylem),
    satirlar: ozet.satirlar.map((s) => istemMetniTemizle(s)),
    insanSatirlari: ozet.insanSatirlari?.map((s) => istemMetniTemizle(s)),
    soru: ozet.soru === undefined ? undefined : istemMetniTemizle(ozet.soru),
  };

  /**
   * Did step-up verification engage? The weak (confirm) channel MUST see this: an
   * escalation means "we are asking you anyway", and with no prompt to ask there is no
   * escalation either (see the weak-channel block below).
   */
  let kademe: KademeKarari | undefined;

  /**
   * The step-up action text for the HUMAN PROMPT ONLY — it carries the extra sentence that
   * says the action was not refused but bound to the human's approval, which is only true
   * where a prompt is shown. Undefined when there is no escalation.
   */
  let kademeIstemEylemi: string | undefined;

  /**
   * Network check runs FIRST — before the weak (confirm) and strong (elicitation)
   * branches alike. A compromised approver must be refused on both paths; gating only
   * the elicitation branch would let a stolen session fall back to confirm=true.
   */
  if (ozet.risk) {
    /**
     * A risk tag without its config is a programming error at the call site, and the
     * safe reading of "the gate could not run" is refusal — silently skipping the
     * network check here would be fail-open by omission.
     */
    if (!ozet.agAyar) {
      const mesaj =
        "Reddedildi: bu işlem risk etiketli ama ağ doğrulama yapılandırması onay kapısına " +
        "ulaşmadı (agAyar eksik — sunucu tarafı hata). Güvenlik gereği harcama artışı uygulanmaz.";
      kararYaz(
        agKararKaydiOlustur(
          ozet.eylem,
          ozet.risk,
          {
            engel: mesaj,
            kanit: [],
            // The gate was never reached: no link ran a query, and there is no window.
            iz: { simSwap: "calismadi", retNedeni: "ag-ayari-kapiya-ulasmadi" },
          },
          ozet.hesapId,
          ozet.tutar
        )
      );
      return { onaylandi: false, kanal: "ag", mesaj };
    }
    const ag = await agDogrula(ozet.agAyar, ozet.risk);
    /**
     * The audit trail: REFUSALS and PASSES are recorded from one place, immediately after
     * the decision — writing only refusals would make "never asked" indistinguishable from
     * "asked and passed". kararYaz never throws; the log is an observation, not a gate.
     */
    kararYaz(agKararKaydiOlustur(ozet.eylem, ozet.risk, ag, ozet.hesapId, ozet.tutar));
    if (ag.engel) return { onaylandi: false, kanal: "ag", mesaj: ag.engel };
    /**
     * The gate's evidence lines go to the HUMAN ONLY (see OnayOzeti.insanSatirlari). They
     * used to be appended to `satirlar` and came back to the agent with the refusal on a
     * client without elicitation: the masked approver number, the look-back window and the
     * expected country handed anyone trying to get past the gate its dimensions.
     */
    if (ag.kanit.length) {
      /**
       * These lines are written by the gate itself, not by a caller — but they still carry
       * operator-supplied configuration (the expected country) and upstream-derived values,
       * and they arrive AFTER the sweep at the top of this function. Same rule, same call:
       * one bullet per line, and the line structure stays the server's.
       */
      ozet = {
        ...ozet,
        insanSatirlari: [...(ozet.insanSatirlari ?? []), ...ag.kanit.map((s) => istemMetniTemizle(s))],
      };
    }

    /**
     * STEP-UP IS WRITTEN AT THE TOP OF THE PROMPT — not among the evidence lines.
     *
     * An escalation means "the network said something, and we are asking you anyway"; what
     * the human is approving is no longer an ordinary spend but a spend made DESPITE A
     * DEGRADED SIGNAL. Sitting as the sixth bullet in a list, that fact goes unread — and a
     * warning nobody reads is the same as a warning never shown.
     *
     * The question changes too: instead of "Do you approve?" the human is asked a question
     * that names the degraded signal, so that consent is GIVEN TO that signal.
     */
    if (ag.kademe) {
      kademe = ag.kademe;
      /**
       * THE HEADER HAS TWO HALVES AND THEY GO TO DIFFERENT PLACES.
       *
       * Naming the degraded signal is true on BOTH channels, so it lives in `eylem`.
       * "…therefore the action was NOT refused, it was bound to your approval" is true
       * ONLY where a prompt actually gets shown. It used to sit in `eylem` too, and on a
       * client without elicitation the weak-channel block below prefixed that same text
       * with "Reddedildi:" — one message saying it was refused and, two lines later, that
       * it was not. The decision was right; the sentence was in the wrong channel. It now
       * belongs to the human prompt alone (`kademeIstemEylemi`).
       */
      const uyari =
        `⚠ AĞ SİNYALİ BOZUK — ${ag.kademe.aciklama}.\n` +
        `Bu, tek başına saldırı kanıtı değil; olağan bir durum da olabilir.`;
      kademeIstemEylemi =
        `${uyari} Bu yüzden işlem reddedilmedi, ONAYINA bağlandı.\n\n${ozet.eylem}`;
      ozet = {
        ...ozet,
        eylem: `${uyari}\n\n${ozet.eylem}`,
        soru: `Bozuk ağ sinyaline RAĞMEN onaylıyor musun?`,
      };
    }
  }

  if (!elicitationVar(server)) {
    /**
     * AN ESCALATION PRODUCES NO PASS ON THE WEAK CHANNEL.
     *
     * Step-up is not a LOOSENING but a TRADE: the gate stops meeting a degraded signal with
     * a flat refusal, and in return demands a STRONGER consent from the human — a prompt
     * that names the degraded signal, a changed question, and a REFUSAL wherever that prompt
     * cannot be shown. Being able to actually show the prompt is the precondition for the
     * escalation. NO SPENDING CEILING IS LOWERED: this sentence used to promise one as the
     * fourth half of the trade (three sibling comments in networkTrust.ts promised the same
     * and were corrected), but nothing in this codebase lowers a ceiling on an escalation —
     * KademeKarari carries no ceiling, OnaySonucu never carries the escalation back to the
     * caller, and onaySonrasiKelepce re-reads the tenant's UNCHANGED maxDailyBudget. Promising
     * an absent compensating control makes the gate read stronger than it is.
     *
     * On a client without elicitation there IS no prompt to show. All that remains is the
     * agent's claim of `confirm=true`, and that is the side of the trade we receive, not the
     * side we give: a single-shot consent the server cannot verify, produced BEFORE the
     * network gate ever ran, and stale — with no channel carrying the degraded signal's
     * name, the changed question or the evidence lines. Letting an escalation through on
     * such a client would loosen the gate at exactly the moment it is under pressure: a
     * stolen session could take a campaign live on a transferred SIM without a human ever
     * being asked.
     *
     * So this refuses. The refusal NAMES the degraded signal that triggered the escalation
     * (the warning header was written into ozet.eylem above) so the agent can pass it on to
     * the user; the gate's OWN evidence lines are deliberately withheld — they belong to the
     * human's channel (see OnayOzeti.insanSatirlari).
     */
    if (kademe) {
      return {
        onaylandi: false,
        kanal: "ag",
        mesaj:
          `Reddedildi: ${ozet.eylem}\n` +
          ozet.satirlar.map((s) => `  • ${s}`).join("\n") +
          `\n\nBU İSTEMCİDE YÜKSELTME YAPILAMAZ: kademeli doğrulama, bozuk sinyali adıyla ` +
          `söyleyen bir İNSAN istemi gerektirir; bu istemci MCP elicitation desteklemiyor. ` +
          `Ajanın confirm=true iddiası o istemin yerine GEÇMEZ. Elicitation destekleyen bir ` +
          `istemciyle tekrar dene ya da bozuk sinyal geçene kadar bekle. Kullanıcıya bozuk ` +
          `ağ sinyalini MUTLAKA bildir.`,
      };
    }

    // Old or limited client: fall back to the agent-mediated gate
    if (agentConfirm === true) return { onaylandi: true, kanal: "ajan" };
    return {
      onaylandi: false,
      kanal: "ajan",
      mesaj:
        `Reddedildi: ${ozet.eylem}\n` +
        ozet.satirlar.map((s) => `  • ${s}`).join("\n") +
        `\nKullanıcıya bu özeti göster ve açık onayını al; onay geldiyse confirm=true ile tekrar çağır.`,
    };
  }

  // Strong path: ask the human directly
  /**
   * The human prompt sees BOTH channels: `satirlar`, which also goes back to the agent, and
   * `insanSatirlari`, which is the human's alone. Nothing is withheld from the person
   * deciding; the party being withheld from is the agent.
   */
  const insanIcinSatirlar = [...ozet.satirlar, ...(ozet.insanSatirlari ?? [])];
  /**
   * This is the one channel where a prompt is really shown, so it is the one channel that
   * may say the escalation was bound to the human's approval (see the step-up block above).
   */
  const metin = `${kademeIstemEylemi ?? ozet.eylem}\n\n${insanIcinSatirlar
    .map((s) => `• ${s}`)
    .join("\n")}`;
  try {
    const cevap = await server.server.elicitInput(
      {
        message: metin,
        requestedSchema: {
        type: "object",
        properties: {
            onay: {
              type: "boolean",
              title: ozet.soru ?? "Onaylıyor musun?",
              description: "Evet dersen işlem hemen uygulanır ve gerçek harcamayı etkileyebilir.",
            },
          },
          required: ["onay"],
        },
      },
      /**
       * The SDK default of 60 seconds is far too short for a human. If the user
       * switches to Google Ads in another tab to check something, the server has
       * already given up by the time they return: they press "Approve" and nothing
       * happens.
       */
      { timeout: 10 * 60_000, resetTimeoutOnProgress: true }
    );

    if (cevap.action === "accept" && cevap.content?.onay === true) {
      return { onaylandi: true, kanal: "insan" };
    }
    const neden =
      cevap.action === "decline" ? "kullanıcı reddetti" : cevap.action === "cancel" ? "kullanıcı iptal etti" : "kullanıcı onaylamadı";
    return {
      onaylandi: false,
      kanal: "insan",
      mesaj: `İşlem yapılmadı: ${neden}. Kullanıcının kararına saygı göster; aynı işlemi tekrar denemeden önce ona danış.`,
    };
  } catch (e: any) {
    /**
     * Fail closed: if consent cannot be obtained, the operation does NOT run.
     *
     * THE UPSTREAM ERROR IS NEVER INLINED INTO THE REFUSAL — the same rule networkTrust.ts
     * applies to the CAMARA side and meta/client.ts applies with hataTemizle(). This message
     * used to interpolate `e.message` verbatim: an exception text the client (not this
     * server) produced, with no sanitising, no cap and no masking. ANSI escape sequences
     * reached the host terminal, anything token-shaped in the body reached the agent's
     * context and from there transcripts, and a multi-megabyte body was copied whole. The
     * agent now gets a fixed sentence; the operator gets a cleaned, bounded detail on
     * stderr, which is the same split used everywhere else in this repo.
     *
     * `agAyar` is handed over so the secrets THIS server holds — the approver number, the
     * NaC token — are redacted by value and not left to a shape rule to notice, exactly as
     * networkTrust.ts redacts the number in its own stderr line.
     */
    console.error(`[aegis] onay istemi başarısız: ${hataOzeti(e, ozet.agAyar)}`);
    return {
      onaylandi: false,
      kanal: "insan",
      mesaj:
        "İşlem yapılmadı: kullanıcı onayı alınamadı — istemciyle onay alışverişi " +
        "tamamlanamadı. Güvenlik gereği onaysız işlem uygulanmaz. Ayrıntı sunucu " +
        "günlüğüne yazıldı; sorun sürerse operatör oraya bakmalı.",
    };
  }
}

/**
 * Turns an exception into a line safe to put on the operator's terminal.
 *
 * THE WORK ITSELF IS SHARED WITH networkTrust.ts (operatorMetniTemizle) — one cleaner, two
 * callers. It used to live here in full while networkTrust.ts kept a second, narrower copy,
 * and the two drifted the way duplicated doctrine always does. Measured on this side: only
 * the byte-for-byte E.164 spelling of the approver's number was masked, so `905551112233`,
 * `%2B905551112233`, `+90 555 111 22 33`, `0090 555 111 22 33` and
 * `%2B90%20555%20111%2022%2033` — five of six spellings a CAMARA 4xx body really produces —
 * all reached stderr in full. Measured on the other side: the token, ANSI escapes and an
 * unbounded body reached stderr in full. Each file had half the rule; there is now one
 * function and both call it.
 *
 * THE ORDER IS THE DEFENCE, and it is kept in the shared cleaner: control bytes are
 * neutralised BEFORE the credential mask, never after. The mask keys off `Bearer `, `token=`
 * and friends, and JS does not count NUL, TAB or an ESC sequence as `\s`:
 * `Bearer<NUL>sk-live-...` matched no pattern at all, and the control-stripping pass that
 * used to come afterwards then turned that NUL into a space and rejoined the pieces into a
 * perfectly readable token on stderr. One byte, chosen by whoever wrote the upstream error
 * text, disarmed the mask — and the next line re-armed the leak.
 *
 * `agAyar` is handed over so the secrets THIS server holds — the approver number, the NaC
 * token — are redacted BY VALUE and not left to a shape rule to notice, exactly as
 * networkTrust.ts redacts them in its own stderr lines; one incident then reads the SAME in
 * both logs.
 *
 * NOTHING FROM HERE GOES TO THE AGENT. It goes to stderr, which on a stdio MCP server is the
 * operator's log and terminal — the contract's "never to the agent, the log OR the terminal"
 * covers this line exactly as it covers the agent's.
 */
function hataOzeti(e: unknown, ayar?: AgAyar): string {
  return operatorMetniTemizle(e instanceof Error ? e.message : String(e), ayar);
}

/**
 * DID THE CLAMP MOVE WHILE THE PROMPT WAS OPEN? — the last look before the mutation.
 *
 * WHY IT IS NEEDED: the write switch and the daily ceiling were read BEFORE the approval
 * prompt, and once that prompt is shown to a human over elicitation it can stay open for up
 * to ten minutes. In that window the account owner could switch writes off or lower the
 * ceiling from the settings page and the pending request would still write on the old
 * values — so the clamp's promise of "takes effect immediately" did not hold at precisely
 * the moment it would be used in anger. That is not what an operator turning writes off in
 * a panic expects.
 *
 * The check runs ONLY on the spend-increasing paths: going live and raising a budget.
 * Pausing and lowering a budget reduce spend; making them wait on a late clamp change would
 * stand in the way of the operator trying to shut things down.
 *
 * THE LIMIT, honestly: this is a RE-READ of the clamp inside the call, not a live
 * subscription. In hosted mode the context provider reads from the session's shared box on
 * every call, so a settings change shows up on the next read; in single-process local mode
 * the settings are fixed for the life of the process and this check changes nothing.
 */
export function onaySonrasiKelepce(
  taze: { writeEnabled: boolean; maxDailyBudget: number },
  gunlukTutar: number | undefined
): string | null {
  if (!taze.writeEnabled) {
    return (
      "Reddedildi: onay beklenirken bu hesapta YAZMA KAPATILDI. Onay alınmış olsa bile " +
      "işlem uygulanmadı — kelepçe, onaydan sonra da geçerlidir. Hesap sahibi yazmayı " +
      "tekrar açarsa işlem yeniden denenebilir."
    );
  }
  if (gunlukTutar !== undefined && Number.isFinite(gunlukTutar) && gunlukTutar > taze.maxDailyBudget) {
    return (
      `Reddedildi: onay beklenirken günlük güvenlik tavanı ${taze.maxDailyBudget} değerine ` +
      `indirildi ve bu işlemin günlük tutarı (${gunlukTutar}) artık tavanın üstünde. Onay ` +
      `alınmış olsa bile işlem uygulanmadı; onay, indirilmeden ÖNCEKİ tavana verilmişti.`
    );
  }
  return null;
}
