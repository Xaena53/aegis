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
 * Her ağ kararı (ret VE geçiş) denetim izi için kararGunlugu.ts'e yazılır. Günlük
 * gözlemdir, kapı değildir: yazılamazsa akış aynen sürer.
 *
 * İKİ KANAL, İKİ İZLEYİCİ. Onay özetinin gördüğü iki ayrı okur vardır: karar veren
 * İNSAN ve isteği yapan AJAN. `satirlar` ikisine birden gider (elicitation'sız
 * istemcide ret metnine de yazılır); `insanSatirlari` YALNIZ insana gider. Kapının
 * kendi kanıtı — maskeli numara, geriye bakış penceresi, beklenen ülke — ve sunucu
 * tarafı sırlar ikinci kanaldadır: çalınmış bir oturumdaki ajan, reddedildiği her
 * denemede kapının ölçülerini öğrenmemelidir.
 *
 * KADEMELİ DOĞRULAMA ZAYIF KANALDA GEÇMEZ. Yükseltme, insana daha güçlü bir soru
 * sorabilmeye dayanır; soracak istemi olmayan bir istemcide yükseltme de yoktur ve
 * ajanın `confirm=true`su o istemin yerine geçmez.
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
   * DİKKAT: bu satırlar elicitation'sız istemcide RET METNİYLE BİRLİKTE AJANA DÖNER.
   * Ajanın zaten bildiği (kendi gönderdiği) bilgiler buraya; ajanın bilmesi
   * gerekmeyen her şey `insanSatirlari`na.
   */
  satirlar: string[];
  /**
   * YALNIZ İNSANA gösterilen satırlar — ajana ASLA dönmez.
   *
   * `satirlar` iki ayrı yere birden gidiyordu: elicitation istemine VE elicitation'sız
   * istemcideki ret metnine. İkinci yol, kapının kendi kanıtını (maskeli onaylayıcı
   * numarası, geriye bakış penceresi, beklenen ülke) ve sunucu tarafı sırları (Meta
   * reklam hesabı kimliği) ajanın bağlamına — oradan da transkriptlere — yazıyordu.
   * Çalınmış bir oturumdaki ajan, reddedildiği her denemede kapının ŞEKLİNİ öğreniyordu.
   *
   * Ayrım şudur: insanın KARAR VERMEK için görmesi gereken ama ajanın BİLMESİ
   * GEREKMEYEN her şey buraya. Ajanın kendi gönderdiği değerler (müşteri kimliği,
   * istenen bütçe) `satirlar`da kalabilir — onları gizlemek kimseden bir şey saklamaz.
   */
  insanSatirlari?: string[];
  /** Label of the confirmation checkbox. */
  soru?: string;
  /** Spend-risk tier; with `agAyar` set, the network is consulted before any prompt. */
  risk?: AgRisk;
  /** Network-verification config slice, passed by the calling tool from ctx.config. */
  agAyar?: AgAyar;
  /**
   * Kararın ait olduğu reklam hesabı (Google Ads müşteri ID). Yalnız denetim günlüğüne
   * yazılır, karar mantığını ETKİLEMEZ. Hosted çok-kiracılı modda tüm kiracıların
   * kararları tek dosyaya düştüğü için bu alan olmadan kayıtlar ayırt edilemiyordu.
   */
  hesapId?: string;
  /**
   * RİSKTEKİ TUTAR: bu kararın konusu olan GÜNLÜK para büyüklüğü (hesabın kendi para
   * biriminde, micros değil). hesapId gibi yalnız denetim günlüğüne yazılır, karar
   * mantığını ETKİLEMEZ — kapının eşiği bütçe tavanıdır, bu alan değil.
   *
   * OKUNAMAYAN TUTAR GEÇİLMEZ. Çağrı yeri bütçeyi gerçekten okuyabildiyse geçer;
   * okuyamadıysa alanı hiç vermez ve kayda da düşmez. 0 ya da tahmin geçmek
   * "bilmiyorum"u "temiz/sıfır" diye kaydetmek olurdu.
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
   * Kademeli doğrulama devreye girdi mi? Zayıf (confirm) kanalın bunu GÖRMESİ şart:
   * yükseltme "yine de sana soruyoruz" demektir ve soracak bir istem yoksa yükseltme
   * de yoktur (aşağıdaki zayıf kanal bloğuna bak).
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
            // Kapı hiç çağrılamadı: hiçbir halka sorgu yapmadı, pencere de yok.
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
     * Denetim izi: RET ve GEÇİŞ tek noktadan, karardan hemen sonra kaydedilir —
     * yalnız retleri yazmak "hiç sorulmadı" ile "sorulup geçti"yi ayırt edilemez
     * kılardı. kararYaz asla fırlatmaz; günlük gözlemdir, kapı değildir.
     */
    kararYaz(agKararKaydiOlustur(ozet.eylem, ozet.risk, ag, ozet.hesapId, ozet.tutar));
    if (ag.engel) return { onaylandi: false, kanal: "ag", mesaj: ag.engel };
    /**
     * Kapının kanıt satırları YALNIZ İNSANA gider (bkz. OnayOzeti.insanSatirlari).
     * Eskiden `satirlar`a ekleniyorlardı ve elicitation'sız istemcide ret metniyle
     * birlikte ajana dönüyorlardı: maskeli onaylayıcı numarası, geriye bakış penceresi
     * ve beklenen ülke, kapıyı aşmak isteyene kapının ölçülerini veriyordu.
     */
    if (ag.kanit.length) {
      ozet = { ...ozet, insanSatirlari: [...(ozet.insanSatirlari ?? []), ...ag.kanit] };
    }

    /**
     * KADEMELİ DOĞRULAMA İSTEMİN BAŞINA YAZILIR — kanıt satırlarının arasına DEĞİL.
     *
     * Yükseltme, "ağ bir şey söyledi ama yine de sana soruyoruz" demektir; insanın
     * onaylayacağı şey artık sıradan bir harcama değil, BOZUK BİR SİNYALE RAĞMEN
     * yapılan bir harcamadır. Bu bilgi madde işaretlerinin arasında altıncı satır
     * olarak dururken kimse onu okumaz — okunmayan bir uyarı, hiç gösterilmemiş bir
     * uyarıyla aynıdır.
     *
     * Soru metni de değişir: "Onaylıyor musun?" yerine bozuk sinyalin adını taşıyan
     * bir soru sorulur, böylece onay o sinyale VERİLMİŞ olur.
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
     * YÜKSELTME ZAYIF KANALDA GEÇİŞ ÜRETMEZ.
     *
     * Kademeli doğrulama bir GEVŞEME değil, bir TAKAStır: kapı bozuk bir sinyali düz
     * retle karşılamayı bırakır, karşılığında insandan DAHA GÜÇLÜ bir onay ister —
     * bozuk sinyali adıyla söyleyen bir istem, değişmiş bir soru, düşürülmüş bir tavan.
     * Yükseltmenin ön koşulu, o istemi gerçekten gösterebilmektir.
     *
     * Elicitation'sız istemcide gösterilecek istem YOKTUR. Geriye yalnız ajanın
     * `confirm=true` iddiası kalır ve o, takasın verdiği taraf değil aldığı taraftır:
     * tek atışlık, sunucunun doğrulayamadığı, üstelik ağ kapısı hiç koşmadan ÖNCE
     * üretilmiş bayat bir rızadır — bozuk sinyalin adını, değişen soruyu ve kanıt
     * satırlarını taşıyan hiçbir kanalı yoktur. Böyle bir istemcide yükseltmeyi
     * geçirmek, kapıyı tam da zorlandığı anda gevşetmek olurdu: çalınmış bir oturum,
     * taşınmış bir SIM ile kampanyayı insana hiç sorulmadan yayına alabilirdi.
     *
     * Bu yüzden burada RET. Ret metni, yükseltmeyi tetikleyen bozuk sinyali ADIYLA
     * söyler (uyarı başlığı yukarıda ozet.eylem'e yazıldı) ki ajan kullanıcıya
     * aktarabilsin; kapının KENDİ kanıt satırları bilerek yazılmaz — onlar insanın
     * kanalına aittir (bkz. OnayOzeti.insanSatirlari).
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
   * İnsan istemi HER İKİ kanalı da görür: ajana da dönen `satirlar` ve yalnız insana
   * ait `insanSatirlari`. Karar veren kişiden bilgi saklanmıyor; saklanan taraf ajandır.
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
 * ONAY PENCERESİ BOYUNCA KELEPÇE DEĞİŞTİ Mİ? — mutasyondan hemen önceki son bakış.
 *
 * NEDEN GEREKLİ: yazma kelepçesi ve günlük tavan, onay isteminden ÖNCE okunuyordu ve
 * o istem elicitation ile insana gösterildiğinde 10 dakikaya kadar açık kalabiliyor.
 * O pencerede hesap sahibi ayarlar sayfasından yazmayı kapatsa ya da tavanı indirse
 * bile, bekleyen istek eski değerlerle yazmaya devam ediyordu — yani kelepçenin
 * "anında geçerli" sözü, tam da acilen kullanılacağı anda tutmuyordu. Panik hâlinde
 * yazmayı kapatan bir operatörün beklediği şey bu değildir.
 *
 * Kapı YALNIZ HARCAMAYI ARTIRAN yollarda çağrılır: yayına alma ve bütçe artışı.
 * Duraklatma ve bütçe indirme harcamayı düşürür; onları geç gelen bir kelepçeye
 * takmak, kapatmaya çalışan operatörün önünü kesmek olurdu.
 *
 * SINIR — dürüstçe: bu, kelepçenin çağrı içinde YENİDEN OKUNMASIDIR, canlı bir abonelik
 * değil. Barındırılan kipte bağlam sağlayıcı her çağrıda oturumun paylaşılan kutusundan
 * okur, dolayısıyla ayar değişikliği bir sonraki okumada görünür; tek süreçli yerel
 * kipte ayarlar zaten süreç ömrü boyunca sabittir ve kapı orada hiçbir şeyi değiştirmez.
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
