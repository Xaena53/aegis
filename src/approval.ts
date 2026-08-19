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
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { agDogrula, type AgAyar, type AgRisk } from "./networkTrust.js";

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
  /** The concrete lines the user needs to see in order to decide. */
  satirlar: string[];
  /** Label of the confirmation checkbox. */
  soru?: string;
  /** Spend-risk tier; with `agAyar` set, the network is consulted before any prompt. */
  risk?: AgRisk;
  /** Network-verification config slice, passed by the calling tool from ctx.config. */
  agAyar?: AgAyar;
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
      return {
        onaylandi: false,
        kanal: "ag",
        mesaj:
          "Reddedildi: bu işlem risk etiketli ama ağ doğrulama yapılandırması onay kapısına " +
          "ulaşmadı (agAyar eksik — sunucu tarafı hata). Güvenlik gereği harcama artışı uygulanmaz.",
      };
    }
    const ag = await agDogrula(ozet.agAyar, ozet.risk);
    if (ag.engel) return { onaylandi: false, kanal: "ag", mesaj: ag.engel };
    if (ag.kanit.length) ozet = { ...ozet, satirlar: [...ozet.satirlar, ...ag.kanit] };
  }

  if (!elicitationVar(server)) {
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
  const metin = `${ozet.eylem}\n\n${ozet.satirlar.map((s) => `• ${s}`).join("\n")}`;
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
