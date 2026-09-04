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
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { agDogrula, type AgAyar, type AgRisk, type KademeKarari } from "./networkTrust.js";
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
   * Did step-up verification engage? The weak (confirm) channel MUST see this: an
   * escalation means "we are asking you anyway", and with no prompt to ask there is no
   * escalation either (see the weak-channel block below).
   */
  let kademe: KademeKarari | undefined;

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
      ozet = { ...ozet, insanSatirlari: [...(ozet.insanSatirlari ?? []), ...ag.kanit] };
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
      ozet = {
        ...ozet,
        eylem:
          `⚠ AĞ SİNYALİ BOZUK — ${ag.kademe.aciklama}.\n` +
          `Bu, tek başına saldırı kanıtı değil; olağan bir durum da olabilir. Bu yüzden ` +
          `işlem reddedilmedi, ONAYINA bağlandı.\n\n${ozet.eylem}`,
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
     * that names the degraded signal, a changed question, a lowered ceiling. Being able to
     * actually show that prompt is the precondition for the escalation.
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
  const metin = `${ozet.eylem}\n\n${insanIcinSatirlar.map((s) => `• ${s}`).join("\n")}`;
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
    // Fail closed: if consent cannot be obtained, the operation does NOT run
    return {
      onaylandi: false,
      kanal: "insan",
      mesaj: `İşlem yapılmadı: kullanıcı onayı alınamadı (${e?.message ?? e}). Güvenlik gereği onaysız işlem uygulanmaz.`,
    };
  }
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
