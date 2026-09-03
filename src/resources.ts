// SPDX-License-Identifier: AGPL-3.0-only
/**
 * MCP resources: browsable data that costs no tool call.
 *
 * The limits resource is intentionally read-only. It reports the guardrails in force so
 * the agent can explain them, but changing them requires a human browser session.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { enums } from "google-ads-api";
import { formatAdsError, type ContextProvider } from "./adsClient.js";
import { mikrodanTutar } from "./util.js";

function json(uri: string, veri: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(veri, null, 2) }] };
}

function markdown(uri: string, metin: string) {
  return { contents: [{ uri, mimeType: "text/markdown", text: metin }] };
}

/**
 * Reports resource read failures in the SAME language the tools use.
 * Otherwise the tool path tells the user to reconnect their account while the
 * resource path shows a raw `invalid_grant`, leaving them with no idea what to do.
 */
async function kaynakGuvenli<T>(uri: string, isi: () => Promise<T>): Promise<T> {
  try {
    return await isi();
  } catch (e) {
    throw new Error(`${uri} okunamadı — ${formatAdsError(e)}`);
  }
}

/**
 * Returns the accounts campaigns can be created in (non-manager accounts).
 *
 * `erisilemedi` olan hesap ÖNERİLMEZ: detayı okunamadığı için yönetici olup olmadığı
 * bilinmiyor ve önerilse her çağrısı izin hatasıyla dönerdi. Tamamlama protokolü yalnız
 * aday KİMLİK dizisi taşıyabildiği için eksiklik burada duyurulamaz — o yük
 * `adspilot://accounts` kaynağının (tamListeMi/not) ve list_accounts aracının üstündedir.
 */
async function reklamHesaplari(getCtx: ContextProvider): Promise<string[]> {
  try {
    const { liste } = await getCtx().tumHesaplar();
    return liste.filter((h) => !h.yonetici && !h.erisilemedi).map((h) => h.id);
  } catch {
    return [];
  }
}

/** URI'den gelen serbest metni müşteri kimliğine indirger (rakam dışı her şey atılır). */
function musteriKimligi(deger: unknown): string {
  return String(deger ?? "").replace(/\D/g, "");
}

export function registerResources(server: McpServer, getCtx: ContextProvider): void {
  server.registerResource(
    "hesaplar",
    "adspilot://accounts",
    {
      title: "Google Ads hesapları",
      description: "Bu bağlantının eriştiği tüm hesaplar (MCC alt hesapları dahil).",
      mimeType: "application/json",
    },
    async (uri) =>
      kaynakGuvenli(uri.href, async () => {
      const { liste, eksik } = await getCtx().tumHesaplar();
      /**
       * "toplam" alanı KALDIRILDI. Kırpılmış ya da bir hesabı okunamamış bir listeye
       * toplam yazmak, sayıyı kesin bir gerçek gibi sunuyordu: ajan 130'u hesabın
       * tamamı sanıp kullanıcının aradığı hesap için "öyle bir hesabınız yok" diyordu.
       * Artık gösterilen satır sayısı ile listenin TAM olup olmadığı ayrı ayrı yazılır.
       */
      const nedenler: string[] = [];
      if (eksik.okunamayan.length)
        nedenler.push(`${eksik.okunamayan.length} hesabın detayı okunamadı (erisilemedi=true olarak listede)`);
      if (eksik.ustHesapKirpildi) nedenler.push("üst hesap listesi tavana takıldı: listede hiç görünmeyen hesaplar var");
      if (eksik.altHesabiKirpilan.length)
        nedenler.push(`şu MCC'lerin alt hesap listesi kırpıldı: ${eksik.altHesabiKirpilan.join(", ")}`);
      return json(uri.href, {
        gosterilen: liste.length,
        tamListeMi: !eksik.var,
        not: eksik.var
          ? `LİSTE EKSİK — ${nedenler.join("; ")}. Aradığın hesap burada yoksa "yok" SONUCUNA VARMA; ` +
            `list_accounts ile doğrula ya da kullanıcıdan kimliği iste.`
          : "Bu bağlantının eriştiği hesapların tamamı.",
        hesaplar: liste.map((h) => ({
          id: h.id,
          ad: h.ad,
          // Okunamayan hesap "reklam hesabı" diye sunulamaz: yöneticiliği BİLİNMİYOR.
          tur: h.erisilemedi
            ? "bilinmiyor (detay okunamadı — kampanya için kullanma)"
            : h.yonetici
              ? "yönetici (MCC — kampanya kurulamaz)"
              : "reklam hesabı",
          ...(h.erisilemedi ? { erisilemedi: true } : {}),
        })),
      });
      })
  );

  server.registerResource(
    "hesap-limitleri",
    new ResourceTemplate("adspilot://accounts/{customerId}/limits", {
      list: undefined,
      complete: { customerId: (deger) => reklamHesaplari(getCtx).then((l) => l.filter((id) => id.startsWith(deger.replace(/\D/g, "")))) },
    }),
    {
      title: "Güvenlik kelepçeleri",
      description:
        "Bu bağlantının güvenlik ayarları: günlük bütçe tavanı ve yazma izni. SALT OKUNUR — limitleri yalnız hesap sahibi değiştirebilir.",
      mimeType: "application/json",
    },
    async (uri, { customerId }) =>
      kaynakGuvenli(uri.href, async () => {
      /**
       * Kimlik ÖNCE doğrulanır, kelepçeler SONRA yazılır. Öncesinde bu şablon gelen
       * metni hiç sormadan geri yazıyordu: "0000000000" ya da "bu-hesap-yok" için de
       * "yazmaIzni: true, tavan: 500" diyen, yetkili görünüşlü bir rapor üretiyordu.
       * /guvenlik-durumu istemi ajana "tahmin etme, kaynağa bak" derken kaynak
       * erişimi hiç doğrulanmamış bir hesap için olumlu beyanda bulunuyordu.
       */
      const cid = musteriKimligi(customerId);
      if (cid.length !== 10)
        throw new Error(
          `Geçersiz müşteri ID: '${customerId}' — Google Ads müşteri ID'si 10 hanelidir. list_accounts ile doğru ID'yi bul.`
        );
      /**
       * Erişim KANITLANIR. Sorgu patlarsa kaynakGuvenli yerelleştirilmiş hatayı taşır;
       * boş satır dönerse hesabın okunabildiği BİLİNMİYOR demektir ve bilinmeyen =
       * RET: kelepçe alanlarının hiçbiri yazılmaz.
       */
      const satirlar = await getCtx().queryWithRetry(cid, `SELECT customer.id FROM customer LIMIT 1`);
      if (!satirlar.length)
        throw new Error(
          `${cid} hesabı doğrulanamadı — erişilebilir olduğu teyit edilemedi, kelepçe raporu üretilmedi. list_accounts ile hesabı doğrula.`
        );
      const cfg = getCtx().config;
      return json(uri.href, {
        customerId: cid,
        yazmaIzni: cfg.writeEnabled,
        gunlukButceTavani: cfg.maxDailyBudget,
        kurallar: [
          "Kampanyalar her zaman duraklatılmış (PAUSED) oluşturulur.",
          "Yayına alma ve bütçe ARTIŞI kullanıcının açık onayını gerektirir.",
          "YAYINDAKİ bir kampanyaya reklam ya da pozitif anahtar kelime eklemek de onay gerektirir.",
          "Bütçe azaltma ve negatif anahtar kelime ekleme onay gerektirmez (harcamayı düşürür).",
          "Tavanı yalnız hesap sahibi yükseltebilir; ajan kendi limitini değiştiremez.",
          "Tavan tek KAMPANYA başınadır, hesabın toplam harcaması için değildir.",
        ],
      });
      })
  );

  server.registerResource(
    "kampanyalar",
    new ResourceTemplate("adspilot://accounts/{customerId}/campaigns", {
      list: undefined,
      complete: { customerId: (deger) => reklamHesaplari(getCtx).then((l) => l.filter((id) => id.startsWith(deger.replace(/\D/g, "")))) },
    }),
    {
      title: "Kampanya listesi",
      description: "Bir hesaptaki TÜM kampanyalar (katalog): durum, kanal, günlük bütçe. Performans için campaign_performance aracını kullan.",
      mimeType: "application/json",
    },
    async (uri, { customerId }) =>
      kaynakGuvenli(uri.href, async () => {
      const cid = musteriKimligi(customerId);
      /**
       * NO segments.date filter — deliberate. With a date filter, campaigns without
       * stats in the window are not returned at all: a freshly created draft is
       * missing from the list, so the agent concludes it was never created and
       * builds a second campaign. This resource is a CATALOGUE; use the
       * campaign_performance tool for period performance.
       */
      const satirlar = await getCtx().queryWithRetry(
        cid,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                campaign_budget.amount_micros
         FROM campaign WHERE campaign.status != 'REMOVED'
         ORDER BY campaign.id DESC LIMIT 200`
      );
      return json(uri.href, {
        customerId: cid,
        not: "Tüm kampanyalar (performans verisi için campaign_performance aracını kullan).",
        kampanyalar: satirlar.filter((r: any) => r?.campaign).map((r: any) => {
          /**
           * `?? 0` BURADAN KALDIRILDI. Bütçesi okunamayan bir kampanya kataloğa
           * "gunlukButce: 0" diye giriyordu; /kampanya-denetle ajanı bunu "bütçesiz
           * kalmış" diye okuyor ve toplamları eksik hesaplıyordu. Kapı beslemiyor ama
           * yanlış bilgi de fail-closed kuralının ihlali: bilinmiyor ≠ 0. Değer
           * okunamazsa alan JSON'a HİÇ yazılmaz, yerine açık bir bayrak konur.
           */
          const gunlukButce = mikrodanTutar(r.campaign_budget?.amount_micros);
          return {
            id: String(r.campaign.id),
            ad: r.campaign.name,
            durum: (enums.CampaignStatus as any)[r.campaign.status] ?? r.campaign.status,
            kanal: (enums.AdvertisingChannelType as any)[r.campaign.advertising_channel_type] ?? r.campaign.advertising_channel_type,
            ...(gunlukButce === undefined ? { butceOkunamadi: true } : { gunlukButce }),
          };
        }),
      });
      })
  );

  server.registerResource(
    "gaql-sema",
    "adspilot://gaql-sema",
    {
      title: "GAQL alan rehberi",
      description:
        "run_gaql için sık kullanılan kaynaklar, alanlar ve çalışan örnek sorgular. Alan adı uydurmadan önce buraya bak.",
      mimeType: "text/markdown",
    },
    async (uri) =>
      markdown(
        uri.href,
        [
          "# GAQL hızlı rehber",
          "",
          "> Sorguyu TEK SATIR yaz. Çok satırlı sorgularda istemci ayrıştırıcısı",
          "> SELECT listesinin son alanını bozar (sunucu normalize eder ama alışkanlık edin).",
          "",
          "## Sık kullanılan kaynaklar",
          "| FROM | ne için |",
          "|---|---|",
          "| `campaign` | kampanya performansı |",
          "| `ad_group` | reklam grubu bilgisi |",
          "| `keyword_view` | anahtar kelime performansı |",
          "| `search_term_view` | kullanıcıların GERÇEKTE yazdığı aramalar |",
          "| `ad_group_ad` | reklam metinleri |",
          "| `campaign_criterion` | coğrafi hedefler, kampanya negatifleri |",
          "| `customer_client` | MCC alt hesapları |",
          "",
          "## Sık alanlar",
          "- Kimlik: `campaign.id`, `campaign.name`, `campaign.status`, `ad_group.id`",
          "- Para: `metrics.cost_micros` (1.000.000 = 1 birim), `campaign_budget.amount_micros`",
          "- Performans: `metrics.clicks`, `metrics.impressions`, `metrics.conversions`",
          "- DİKKAT birim: `metrics.average_cpc` **micros**tur (`_micros` son eki YOK ama micros!), `metrics.ctr` **kesir**tir (0.02 = %2)",
          "- Kelime: `ad_group_criterion.keyword.text`, `ad_group_criterion.keyword.match_type`",
          "- Arama terimi: `search_term_view.search_term`, `search_term_view.status`",
          "",
          "## Örnekler",
          "```",
          "SELECT campaign.name, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.cost_micros DESC",
          "```",
          "```",
          "SELECT search_term_view.search_term, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE segments.date DURING LAST_30_DAYS AND metrics.clicks >= 1",
          "```",
          "```",
          "SELECT campaign.id, campaign_criterion.keyword.text, campaign_criterion.type FROM campaign_criterion WHERE campaign_criterion.negative = true",
          "```",
          "",
          "## Tuzaklar",
          "- `metrics.*` alanları segmentlere göre değişir; `segments.date` olmadan toplam döner.",
          "- Para alanları **micros**: 1.500.000 → 1,50.",
          "- `LIMIT` verilmezse sunucu 100 ekler; çok büyük LIMIT tavana kırpılır.",
          "- Yazma yapılamaz — GAQL yalnız okumadır.",
        ].join("\n")
      )
  );
}
