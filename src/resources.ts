// SPDX-License-Identifier: AGPL-3.0-only
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { enums } from "google-ads-api";
import { formatAdsError, type ContextProvider } from "./adsClient.js";


/**
 * RESOURCES — Faz Q / Q4
 *
 * Resources, istemcinin veriyi ARAÇ ÇAĞIRMADAN okumasını sağlar: keşif
 * kolaylaşır, tekrar eden sorgular için token harcanmaz ve kullanıcı neyin
 * mevcut olduğunu görebilir.
 *
 * Buradaki en önemli kaynak `.../limits`: denetimde çıkan boşluktu — kullanıcı
 * hangi kelepçelerle çalıştığını (bütçe tavanı, yazma izni) hiçbir yerden
 * göremiyordu. Not: bu kaynak SALT OKUMADIR; ajan buradan limit değiştiremez.
 */

function json(uri: string, veri: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(veri, null, 2) }] };
}

function markdown(uri: string, metin: string) {
  return { contents: [{ uri, mimeType: "text/markdown", text: metin }] };
}

/**
 * Kaynak okuma hatalarını ARAÇLARLA AYNI dille sunar.
 * Aksi halde kullanıcı araç yolundan "hesabını yeniden bağla" ipucunu alırken
 * kaynak yolundan ham `invalid_grant` görüyor ve ne yapacağını bilemiyordu.
 */
async function kaynakGuvenli<T>(uri: string, isi: () => Promise<T>): Promise<T> {
  try {
    return await isi();
  } catch (e) {
    throw new Error(`${uri} okunamadı — ${formatAdsError(e)}`);
  }
}

/** Kampanya kurulabilen (yönetici olmayan) hesapları döner. */
async function reklamHesaplari(getCtx: ContextProvider): Promise<string[]> {
  try {
    return (await getCtx().tumHesaplar()).filter((h) => !h.yonetici).map((h) => h.id);
  } catch {
    return [];
  }
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
      const hesaplar = await getCtx().tumHesaplar();
      return json(uri.href, {
        toplam: hesaplar.length,
        hesaplar: hesaplar.map((h) => ({
          id: h.id,
          ad: h.ad,
          tur: h.yonetici ? "yönetici (MCC — kampanya kurulamaz)" : "reklam hesabı",
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
    async (uri, { customerId }) => {
      const cfg = getCtx().config;
      return json(uri.href, {
        customerId,
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
    }
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
      const cid = String(customerId).replace(/\D/g, "");
      /**
       * segments.date FİLTRESİ YOK — bilinçli. Tarih filtresi eklendiğinde
       * son 30 günde istatistiği olmayan kampanyalar HİÇ dönmüyordu; yeni
       * kurulan bir taslak listede görünmüyor ve ajan "oluşmadı" sanıp
       * ikinci kampanya kurabiliyordu. Bu kaynak KATALOGDUR; dönemsel
       * performans için campaign_performance aracı var.
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
        kampanyalar: satirlar.filter((r: any) => r?.campaign).map((r: any) => ({
          id: String(r.campaign.id),
          ad: r.campaign.name,
          durum: (enums.CampaignStatus as any)[r.campaign.status] ?? r.campaign.status,
          kanal: (enums.AdvertisingChannelType as any)[r.campaign.advertising_channel_type] ?? r.campaign.advertising_channel_type,
          gunlukButce: Number(r.campaign_budget?.amount_micros ?? 0) / 1e6,
        })),
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
