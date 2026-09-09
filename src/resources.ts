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
import { agKapisiOzeti } from "./prompts.js";
import { mikrodanTutar } from "./util.js";

/**
 * Row cap of the campaign catalogue. It is reported to the reader (satirTavani) and
 * interpolated into the query, so the announced cap and the LIMIT actually sent can
 * never drift apart.
 */
const KAMPANYA_TAVANI = 200;

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
      /**
       * THE NETWORK GATE BELONGS IN THE GUARDRAIL REPORT TOO.
       *
       * This resource calls itself "the security settings of this connection" and the
       * /guvenlik-durumu prompt orders the agent to READ IT instead of guessing — while
       * the gate, the product's headline control, appeared nowhere in it. An agent that
       * skips the prompt and reads this resource straight (which is exactly what the
       * prompt tells it to do) saw write permission and a budget ceiling and concluded
       * that was the whole picture: on a deployment with no NAC token every spend
       * increase reaches the human with no network check behind it, and nothing here
       * said so.
       *
       * The mapping is NOT re-derived here. It is imported from prompts.ts so the prompt
       * line and this field can never disagree about whether the gate is running; a
       * second copy would be a second place to go stale. The helper reports PRESENCE
       * only — no token and no approver number can reach this JSON.
       */
      const kapi = agKapisiOzeti(getCtx);
      return json(uri.href, {
        customerId: cid,
        yazmaIzni: cfg.writeEnabled,
        gunlukButceTavani: cfg.maxDailyBudget,
        agKapisi: { durum: kapi.durum, aciklama: kapi.aciklama },
        kurallar: [
          "Kampanyalar her zaman duraklatılmış (PAUSED) oluşturulur.",
          "Yayına alma ve bütçe ARTIŞI kullanıcının açık onayını gerektirir.",
          "YAYINDAKİ bir kampanyaya reklam ya da pozitif anahtar kelime eklemek de onay gerektirir.",
          "Bütçe azaltma ve negatif anahtar kelime ekleme onay gerektirmez (harcamayı düşürür).",
          "Tavanı yalnız hesap sahibi yükseltebilir; ajan kendi limitini değiştiremez.",
          "Tavan tek KAMPANYA başınadır, hesabın toplam harcaması için değildir.",
          "CAMARA ağ kapısının durumu bu listede DEĞİL, yukarıdaki `agKapisi` alanındadır; " +
            "kurallar listesi tek başına bu bağlantının tam güvenlik resmi değildir.",
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
      description:
        "Bir hesabın kampanya kataloğu (en yeni 200 kampanya): durum, kanal, günlük bütçe. " +
        "Liste kırpılmış olabilir — tamListeMi alanına bak. Performans için campaign_performance aracını kullan.",
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
         ORDER BY campaign.id DESC LIMIT ${KAMPANYA_TAVANI}`
      );
      /**
       * READABILITY IS TESTED ON THE ID ITSELF, not on the mere presence of a `campaign`
       * object. Testing only for the object let a row that arrived WITHOUT `campaign.id`
       * into the catalogue as `id: "undefined"` — an invented identity — while its `durum`
       * and `kanal` silently vanished from the JSON (the enum lookup on an undefined key
       * yields undefined, and JSON.stringify drops such fields). Worse, `okunamayanSatir`
       * stayed 0 and the list was announced as COMPLETE, so an unreadable row was served
       * as a settled record. Unknown is not a value: a row without an id cannot enter the
       * catalogue, and the drop is COUNTED. Shrinking the list in silence turns a partial
       * read into a smaller-looking account.
       */
      const okunabilir = satirlar.filter((r: any) => r?.campaign?.id != null);
      const okunamayanSatir = satirlar.length - okunabilir.length;
      /**
       * The query asks for exactly KAMPANYA_TAVANI rows, so a FULL page is
       * indistinguishable from "there were more": it is declared INCOMPLETE, not complete.
       * Unknown is not "nothing was cut" — the same rule the sibling aegis://accounts
       * resource follows, and the reason its "total" field was removed.
       */
      const tavanaDegdi = satirlar.length >= KAMPANYA_TAVANI;
      const nedenler: string[] = [];
      if (tavanaDegdi)
        nedenler.push(
          `liste ${KAMPANYA_TAVANI} satırlık tavana ulaştı: en yeni ${KAMPANYA_TAVANI} kampanya dışında kalanlar burada YOK`
        );
      if (okunamayanSatir) nedenler.push(`${okunamayanSatir} satır okunamadı ve kataloğa giremedi`);
      return json(uri.href, {
        customerId: cid,
        gosterilen: okunabilir.length,
        satirTavani: KAMPANYA_TAVANI,
        tamListeMi: nedenler.length === 0,
        okunamayanSatir,
        not: nedenler.length
          ? `LİSTE EKSİK — ${nedenler.join("; ")}. Aradığın kampanya burada yoksa "yok" SONUCUNA VARMA; ` +
            `run_gaql ya da campaign_performance ile doğrula. Performans verisi için campaign_performance aracını kullan.`
          : "Bu hesabın kampanyalarının tamamı (performans verisi için campaign_performance aracını kullan).",
        kampanyalar: okunabilir.map((r: any) => {
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
          // The agent's own LIMIT is the cap that bites most often, and until the saturation
          // probe existed a self-written `LIMIT 100` reported "kesildi:false" on an account
          // holding thousands of rows. Documented here because this resource is where the
          // agent is told to look before writing a query.
          "- Satır tavanı, sorgunun KENDİ `LIMIT`'i ile `limit` parametresinin KÜÇÜK olanıdır; sunucu " +
            "tavan+1 satır ister (doyma probu) ve fazlası varsa `kesildi=true` der. Kendi `LIMIT 100`'ünle " +
            "sorup 100 satır alman 'hesapta 100 tane var' DEMEK DEĞİLDİR — `kesildi`ye bak.",
          "- Yazma yapılamaz — GAQL yalnız okumadır.",
        ].join("\n")
      )
  );
}
