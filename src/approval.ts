// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Human-in-the-loop approval gate.
 *
 * Used by every path that can increase spend. When the client supports MCP
 * elicitation the server asks the human directly and the agent-supplied confirm flag
 * is ignored; otherwise it falls back to that flag for compatibility. Every failure
 * mode — declined, cancelled, timed out, transport error — resolves to "do not
 * execute".
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Rule: approval must be verifiable by the server, not asserted by the agent.
 *
 * A confirm flag alone is a claim — the agent decides whether a human was ever
 * consulted, and nothing checks it. MCP elicitation lets the server ask the human
 * through the protocol, so consent becomes a fact rather than a claim.
 *
 * When elicitation is available the agent confirm value is deliberately ignored;
 * honouring both would make the strong gate meaningless next to the weak one.
 */

export type OnayKanali = "insan" | "ajan";

export interface OnaySonucu {
  onaylandi: boolean;
  kanal: OnayKanali;
  /** Reddedildiyse ajana gösterilecek gerekçe. */
  mesaj?: string;
}

export interface OnayOzeti {
  /** "Kampanya yayına alınacak" gibi tek cümlelik eylem. */
  eylem: string;
  /** Kullanıcının karar vermek için görmesi gereken somut satırlar. */
  satirlar: string[];
  /** Onay kutusunun etiketi. */
  soru?: string;
}

/**
 * FORM modu şart: SDK `elicitInput`'un form çağrısı `elicitation.form`
 * yeteneğini arar. Yalnız `elicitation` nesnesinin varlığına bakmak, url-modu
 * destekleyen bir istemcide güçlü dalı seçip her onayın hata vermesine ve
 * kullanıcının HİÇBİR ZAMAN kampanya yayına alamamasına yol açıyordu.
 */
function elicitationVar(server: McpServer): boolean {
  try {
    const e: any = server.server.getClientCapabilities()?.elicitation;
    if (!e) return false;
    // Alt-yetenek bildirilmemişse (eski istemciler) form varsayılır.
    if (typeof e !== "object") return true;
    const altlar = Object.keys(e);
    return altlar.length === 0 || "form" in e;
  } catch {
    return false;
  }
}

/**
 * Tehlikeli (para harcatan) bir işlem için onay alır.
 * @param agentConfirm Ajanın gönderdiği confirm — YALNIZCA elicitation
 *   desteklenmeyen istemcilerde geçerlidir (geri uyumluluk).
 */
export async function onayAl(
  server: McpServer,
  ozet: OnayOzeti,
  agentConfirm: boolean | undefined
): Promise<OnaySonucu> {
  if (!elicitationVar(server)) {
    // Eski/kısıtlı istemci: ajan-aracılı kapıya düş (bugünkü davranış korunur)
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

  // Güçlü yol: insana doğrudan sor
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
       * SDK varsayılanı 60 saniye — insan için çok kısa. Kullanıcı Google Ads'i
       * başka sekmede kontrol etmeye gidip döndüğünde sunucu çoktan vazgeçmiş
       * oluyor; kullanıcı "Onayla"ya basıyor ama hiçbir şey olmuyor.
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
    // KAPALI ARIZA: onay alınamadıysa işlem YAPILMAZ
    return {
      onaylandi: false,
      kanal: "insan",
      mesaj: `İşlem yapılmadı: kullanıcı onayı alınamadı (${e?.message ?? e}). Güvenlik gereği onaysız işlem uygulanmaz.`,
    };
  }
}
