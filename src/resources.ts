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
 * An `erisilemedi` (unreadable) account is NOT suggested: its details could not be read,
 * so whether it is a manager account is unknown, and suggesting it would mean every call
 * against it comes back as a permissions error. The completion protocol can only carry an
 * array of candidate IDs, so the omission cannot be announced here — that burden sits on
 * the `aegis://accounts` resource (tamListeMi/not) and on the list_accounts tool.
 */
async function reklamHesaplari(getCtx: ContextProvider): Promise<string[]> {
  try {
    const { liste } = await getCtx().tumHesaplar();
    return liste.filter((h) => !h.yonetici && !h.erisilemedi).map((h) => h.id);
  } catch {
    return [];
  }
}

/** Reduces free text from the URI to a customer ID (everything but digits is dropped). */
function musteriKimligi(deger: unknown): string {
  return String(deger ?? "").replace(/\D/g, "");
}

export function registerResources(server: McpServer, getCtx: ContextProvider): void {
  server.registerResource(
    "hesaplar",
    "aegis://accounts",
    {
      title: "Google Ads hesapları",
      description: "Bu bağlantının eriştiği tüm hesaplar (MCC alt hesapları dahil).",
      mimeType: "application/json",
    },
    async (uri) =>
      kaynakGuvenli(uri.href, async () => {
      const { liste, eksik } = await getCtx().tumHesaplar();
      /**
       * The "total" field was REMOVED. Putting a total on a list that was truncated, or
       * that had an account it could not read, presented the number as settled fact: the
       * agent took 130 for the whole account set and told the user "you have no such
       * account". The number of rows shown and whether the list is COMPLETE are now stated
       * separately.
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
          // An unreadable account cannot be presented as an "ad account": whether it is a
          // manager account is UNKNOWN.
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
    new ResourceTemplate("aegis://accounts/{customerId}/limits", {
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
       * Identity is verified FIRST, the clamps are reported SECOND. Before this, the
       * template echoed whatever text arrived without asking anything: for "0000000000" or
       * "no-such-account" it still produced an authoritative-looking report saying
       * "writes: true, ceiling: 500". The /guvenlik-durumu prompt tells the agent "do not
       * guess, read the resource" — while the resource was making a positive statement
       * about an account whose access had never been checked.
       */
      const cid = musteriKimligi(customerId);
      if (cid.length !== 10)
        throw new Error(
          `Geçersiz müşteri ID: '${customerId}' — Google Ads müşteri ID'si 10 hanelidir. list_accounts ile doğru ID'yi bul.`
        );
      /**
       * Access is PROVEN. If the query throws, kaynakGuvenli carries the localised error;
       * if it returns no rows, whether the account can be read is UNKNOWN — and unknown
       * means REFUSE: none of the clamp fields are written.
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
    new ResourceTemplate("aegis://accounts/{customerId}/campaigns", {
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
           * `?? 0` was REMOVED here. A campaign whose budget could not be read entered
           * the catalogue as "gunlukButce: 0"; the /kampanya-denetle agent read that as
           * "left without a budget" and computed totals that were short. This does not
           * feed a gate, but wrong information is still a breach of the fail-closed rule:
           * unknown is not 0. When the value cannot be read the field is left out of the
           * JSON entirely and an explicit flag takes its place.
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
    "aegis://gaql-sema",
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
