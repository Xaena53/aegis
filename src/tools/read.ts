import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatAdsError, type ContextProvider } from "../adsClient.js";
import { enums } from "google-ads-api";
import { dateRange, ensureGaqlLimit } from "../util.js";

/**
 * Q5 — YAPISAL ÇIKTI.
 * outputSchema tanımlı araçlar HEM insan-okur metin HEM tipli veri döner.
 * Ajan artık metni ayrıştırmak zorunda değil; sayılar sayı olarak gelir.
 */
function ikili(ozet: string, veri: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: ozet }], structuredContent: veri };
}

/**
 * Hatalı GİRDİ yanıtı. `isError: true` şart: SDK, outputSchema tanımlı bir
 * araçta hata olmayan her yanıtta structuredContent bekler ve yoksa protokol
 * hatası fırlatır. Geçersiz girdi zaten semantik olarak hatadır.
 */
function girdiHatasi(mesaj: string) {
  return { content: [{ type: "text" as const, text: mesaj }], isError: true };
}

function err(e: unknown) {
  return { content: [{ type: "text" as const, text: formatAdsError(e) }], isError: true };
}

const READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true };

// ── Çıktı şemaları (ajan bunlara göre tip güvenli okur) ──────────────────
const HESAP_SEMASI = {
  hesaplar: z
    .array(
      z.object({
        id: z.string(),
        ad: z.string(),
        paraBirimi: z.string().optional(),
        yonetici: z.boolean(),
        testHesabi: z.boolean().optional(),
        durum: z.string().optional(),
        ustHesap: z.string().optional().describe("Alt hesapsa bağlı olduğu MCC"),
      })
    )
    .describe("Erişilebilir hesaplar (MCC alt hesapları dahil)"),
};

const KAMPANYA_SEMASI = {
  pencereGun: z.number(),
  kampanyalar: z.array(
    z.object({
      id: z.string(),
      ad: z.string(),
      durum: z.string(),
      kanal: z.string(),
      gunlukButce: z.number(),
      maliyet: z.number(),
      tiklama: z.number(),
      gosterim: z.number(),
      donusum: z.number(),
      ctrYuzde: z.number(),
      ortTbm: z.number(),
    })
  ),
};

const KELIME_SEMASI = {
  pencereGun: z.number(),
  kelimeler: z.array(
    z.object({
      kelime: z.string(),
      eslemeTuru: z.string(),
      kampanya: z.string(),
      reklamGrubu: z.string(),
      maliyet: z.number(),
      tiklama: z.number(),
      donusum: z.number(),
    })
  ),
};

const ARAMA_TERIMI_SEMASI = {
  pencereGun: z.number(),
  toplamMaliyet: z.number(),
  israfMaliyet: z.number().describe("Dönüşüm getirmeyen terimlerin toplam maliyeti"),
  israfYuzde: z.number(),
  terimler: z.array(
    z.object({
      terim: z.string(),
      kampanyaId: z.string().describe("add_campaign_negative_keywords için gereken kimlik"),
      kampanya: z.string(),
      reklamGrubu: z.string(),
      reklamGrubuId: z.string(),
      maliyet: z.number(),
      tiklama: z.number(),
      donusum: z.number(),
      israfAdayi: z.boolean().describe("Tıklama aldı ama dönüşüm getirmedi"),
      zatenDislanmis: z.boolean(),
    })
  ),
};

const GAQL_SEMASI = {
  satirSayisi: z.number().describe("API'den dönen toplam satır"),
  gosterilen: z.number(),
  kesildi: z.boolean().describe("true ise satırların bir kısmı atlandı"),
  satirlar: z.array(z.unknown()),
};

export function registerReadTools(server: McpServer, getCtx: ContextProvider) {
  server.registerTool(
    "list_accounts",
    {
      title: "Hesapları listele",
      description:
        "Erişilebilen tüm Google Ads hesaplarını (MCC alt hesapları dahil) listeler. " +
        "KULLAN: başka bir araca vereceğin customerId'yi bilmiyorsan İLK bunu çağır. " +
        "KULLANMA: kimliği zaten biliyorsan tekrar çağırma. " +
        "DİKKAT: MCC (yönetici) hesabında kampanya OLUŞTURULAMAZ — 'reklam hesabı' olanı seç.",
      annotations: READ_ANNOTATIONS,
      outputSchema: HESAP_SEMASI,
    },
    async () => {
      try {
        const ctx = getCtx();
        const ids = await ctx.listAccessibleCustomers();
        if (!ids.length) return ikili("Erişilebilir Google Ads hesabı bulunamadı.", { hesaplar: [] });

        type Hesap = {
          id: string;
          ad: string;
          paraBirimi?: string;
          yonetici: boolean;
          testHesabi?: boolean;
          durum?: string;
          ustHesap?: string;
        };
        const hesaplar: Hesap[] = [];

        for (const id of ids.slice(0, 30)) {
          try {
            const [row] = await ctx.queryWithRetry(
              id,
              `SELECT customer.descriptive_name, customer.currency_code, customer.manager FROM customer LIMIT 1`
            );
            const c: any = row?.customer ?? {};
            hesaplar.push({
              id,
              ad: String(c.descriptive_name ?? "(isimsiz)"),
              paraBirimi: c.currency_code ? String(c.currency_code) : undefined,
              yonetici: Boolean(c.manager),
            });
            // MCC ise alt hesapları da ekle — listAccessibleCustomers onları DÖNDÜRMEZ
            if (c.manager) {
              // Not: status filtresi bilerek yok — test hesapları ENABLED dışı status
              // dönebiliyor ve filtre onları gizliyordu (canlıda görüldü).
              const children: any[] = await ctx.queryWithRetry(
                id,
                `SELECT customer_client.id, customer_client.descriptive_name,
                        customer_client.currency_code, customer_client.manager,
                        customer_client.status, customer_client.test_account
                 FROM customer_client
                 WHERE customer_client.level = 1
                 LIMIT 50`
              );
              for (const ch of children) {
                const cc = ch.customer_client ?? {};
                hesaplar.push({
                  id: String(cc.id),
                  ad: String(cc.descriptive_name ?? "(isimsiz)"),
                  paraBirimi: cc.currency_code ? String(cc.currency_code) : undefined,
                  yonetici: Boolean(cc.manager),
                  testHesabi: Boolean(cc.test_account),
                  durum: String((enums.CustomerStatus as any)[cc.status] ?? cc.status ?? ""),
                  ustHesap: id,
                });
              }
            }
          } catch {
            hesaplar.push({ id, ad: "(detay okunamadı — login_customer_id gerekebilir)", yonetici: false });
          }
        }

        const satirlar = hesaplar.map((h) =>
          h.ustHesap
            ? `  └ ${h.id}\t${h.ad}\t${h.paraBirimi ?? "?"}${h.durum ? `\t[${h.durum}]` : ""}${h.yonetici ? " [MCC]" : ""}${h.testHesabi ? " [TEST]" : ""}`
            : `${h.id}\t${h.ad}\t${h.paraBirimi ?? "?"}${h.yonetici ? "\t[MCC]" : ""}`
        );
        const extra = ids.length > 30 ? `\n(… ve ${ids.length - 30} hesap daha — detayları atlandı)` : "";
        return ikili("customerId\tisim\tpara birimi\n" + satirlar.join("\n") + extra, { hesaplar });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "run_gaql",
    {
      title: "Ham GAQL sorgusu",
      description:
        "Serbest GAQL sorgusu çalıştırır (yalnız okuma). " +
        "KULLAN: hazır raporların kapsamadığı bir veri gerektiğinde (reklam metinleri, negatif kelimeler, coğrafi hedefler gibi). " +
        "KULLANMA: kampanya/kelime/arama terimi performansı için — bunların hazır ve daha ucuz araçları var " +
        "(campaign_performance, keyword_performance, search_terms_report). " +
        "İPUCU: alan adı uydurma; 'adspilot://gaql-sema' kaynağında doğru alan listesi ve örnekler var. Sorguyu TEK SATIR yaz.",
      annotations: READ_ANNOTATIONS,
      inputSchema: {
        customerId: z.string().describe("Google Ads müşteri ID (örn. 1234567890)"),
        query: z.string().describe("GAQL sorgusu, örn: SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_30_DAYS"),
        limit: z.number().int().min(1).max(1000).optional().describe("Maks satır (varsayılan 100)"),
      },
      outputSchema: GAQL_SEMASI,
    },
    async ({ customerId, query, limit }) => {
      try {
        // LIMIT'siz sorgu Opteo'da TÜM sayfaları belleğe çeker — yoksa ekle
        const rows = await getCtx().queryWithRetry(customerId, ensureGaqlLimit(query, limit ?? 100));
        let capped = rows.slice(0, limit ?? 100);

        /**
         * Bağlam koruması artık SATIR bazlı. Eskiden JSON metni 20.000 karakterde
         * KESİLİYORDU ve ajana GEÇERSİZ JSON gidiyordu; yapısal çıktıda bu mümkün
         * değil — fazla satırı atmak tek doğru yol.
         */
        const CHAR_CAP = 20_000;
        let kesildi = capped.length < rows.length;
        while (capped.length > 1 && JSON.stringify(capped).length > CHAR_CAP) {
          capped = capped.slice(0, Math.floor(capped.length / 2));
          kesildi = true;
        }

        const ozet =
          `${rows.length} satır (${capped.length} gösteriliyor)` +
          (kesildi ? " — çıktı büyüktü, satır sayısı azaltıldı: daha az alan seç ya da limit düşür" : "") +
          `:\n${JSON.stringify(capped)}`;
        return ikili(ozet, { satirSayisi: rows.length, gosterilen: capped.length, kesildi, satirlar: capped });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "campaign_performance",
    {
      title: "Kampanya performansı",
      description:
        "Kampanyaların son N günkü maliyet, tıklama, gösterim, dönüşüm, CTR ve ortalama TBM değerlerini verir. " +
        "KULLAN: 'nasıl gidiyor', 'ne kadar harcadım', 'hangi kampanya çalışıyor' türü her soruda İLK bunu çağır. " +
        "KULLANMA: hangi ARAMALARIN para yaktığını bulmak için (search_terms_report), kelime bazlı analiz için (keyword_performance). " +
        "DİKKAT: bugün dahil DEĞİLDİR (kısmi veri yanıltmasın); yeni yayına alınan kampanya ilk gün burada görünmez.",
      annotations: READ_ANNOTATIONS,
      inputSchema: {
        customerId: z.string().describe("Google Ads müşteri ID"),
        days: z.number().int().min(1).max(365).optional().describe("Kaç günlük pencere (varsayılan 30)"),
        includePaused: z.boolean().optional().describe("Duraklatılmış kampanyalar da dahil edilsin mi (varsayılan true)"),
      },
      outputSchema: KAMPANYA_SEMASI,
    },
    async ({ customerId, days, includePaused }) => {
      try {
        const d = days ?? 30;
        const statusFilter =
          includePaused === false ? `AND campaign.status = 'ENABLED'` : `AND campaign.status != 'REMOVED'`;
        const rows = await getCtx().queryWithRetry(customerId, `
          SELECT
            campaign.id, campaign.name, campaign.status,
            campaign.advertising_channel_type,
            campaign_budget.amount_micros,
            metrics.cost_micros, metrics.clicks, metrics.impressions,
            metrics.conversions, metrics.ctr, metrics.average_cpc
          FROM campaign
          WHERE ${dateRange(d)}
          ${statusFilter}
          ORDER BY metrics.cost_micros DESC
          LIMIT 500
        `);
        if (!rows.length) return ikili(`Son ${d} günde veri bulunan kampanya yok.`, { pencereGun: d, kampanyalar: [] });

        const kampanyalar = rows.filter((r: any) => r?.campaign).map((r: any) => {
          const m = r.metrics ?? {};
          return {
            id: String(r.campaign.id),
            ad: String(r.campaign.name),
            durum: String((enums.CampaignStatus as any)[r.campaign.status] ?? r.campaign.status),
            kanal: String(
              (enums.AdvertisingChannelType as any)[r.campaign.advertising_channel_type] ?? r.campaign.advertising_channel_type
            ),
            gunlukButce: Number(r.campaign_budget?.amount_micros ?? 0) / 1e6,
            maliyet: Number(m.cost_micros ?? 0) / 1e6,
            tiklama: Number(m.clicks ?? 0),
            gosterim: Number(m.impressions ?? 0),
            donusum: Number(m.conversions ?? 0),
            ctrYuzde: Number(((Number(m.ctr ?? 0) * 100).toFixed(2))),
            ortTbm: Number(m.average_cpc ?? 0) / 1e6,
          };
        });

        const lines = kampanyalar.map(
          (k) =>
            `#${k.id} ${k.ad} [${k.durum}] (${k.kanal})\n` +
            `  günlük bütçe: ${k.gunlukButce.toFixed(2)} | maliyet: ${k.maliyet.toFixed(2)} | tıklama: ${k.tiklama} | gösterim: ${k.gosterim} | dönüşüm: ${k.donusum} | CTR: %${k.ctrYuzde.toFixed(2)} | ort.TBM: ${k.ortTbm.toFixed(2)}`
        );
        return ikili(`Son ${d} gün, ${rows.length} kampanya:\n\n` + lines.join("\n"), { pencereGun: d, kampanyalar });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "search_terms_report",
    {
      title: "Arama terimleri (boşa harcama avı)",
      description:
        "Reklamları GERÇEKTE tetikleyen arama sorgularını listeler ve dönüşüm getirmeyenleri 'boşa harcama adayı' işaretler. " +
        "KULLAN: 'para nereye gidiyor', 'israfı bul', 'negatif kelime öner' türü isteklerde. " +
        "KULLANMA: kendi anahtar kelimelerinin performansı için (keyword_performance) — arama terimi ile anahtar kelime AYNI ŞEY DEĞİLDİR. " +
        "DÖNGÜ: bu rapor → alakasızları seç → kullanıcıya onaylat → add_campaign_negative_keywords. " +
        "DİKKAT: dönüşümsüz olmak tek başına 'alakasız' demek değildir; düşük hacimli terimleri aceleyle dışlama.",
      annotations: READ_ANNOTATIONS,
      inputSchema: {
        customerId: z.string().describe("Google Ads müşteri ID"),
        campaignId: z.string().optional().describe("Tek kampanyaya filtrelemek için kampanya ID"),
        days: z.number().int().min(1).max(365).optional().describe("Kaç günlük pencere (varsayılan 30)"),
        minClicks: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("En az bu kadar tıklama almış terimler (varsayılan 1 — gösterim-salt gürültüyü eler)"),
      },
      outputSchema: ARAMA_TERIMI_SEMASI,
    },
    async ({ customerId, campaignId, days, minClicks }) => {
      try {
        const d = days ?? 30;
        const mc = minClicks ?? 1;
        if (campaignId && !/^\d+$/.test(campaignId.trim()))
          return girdiHatasi(`Geçersiz kampanya ID: '${campaignId}' — sadece rakam olmalı.`);
        const filter = campaignId ? `AND campaign.id = ${Number(campaignId.trim())}` : "";
        const rows = await getCtx().queryWithRetry(
          customerId,
          `SELECT
             campaign.id, campaign.name, ad_group.id, ad_group.name,
             search_term_view.search_term, search_term_view.status,
             metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
           FROM search_term_view
           WHERE ${dateRange(d)} AND metrics.clicks >= ${mc}
           ${filter}
           ORDER BY metrics.cost_micros DESC
           LIMIT 200`
        );
        if (!rows.length)
          return ikili(`Son ${d} günde (≥${mc} tıklama) arama terimi verisi yok. minClicks=0 ile genişletebilirsin.`, {
            pencereGun: d,
            toplamMaliyet: 0,
            israfMaliyet: 0,
            israfYuzde: 0,
            terimler: [],
          });

        let totalCost = 0;
        let wastedCost = 0;
        const terimler = rows.filter((r: any) => r?.campaign && r?.ad_group && r?.search_term_view).map((r: any) => {
          const m = r.metrics ?? {};
          const cost = Number(m.cost_micros ?? 0) / 1e6;
          const conv = Number(m.conversions ?? 0);
          totalCost += cost;
          const israfAdayi = conv === 0 && cost > 0;
          if (israfAdayi) wastedCost += cost;
          const stName = (enums.SearchTermTargetingStatus as any)[r.search_term_view?.status] ?? r.search_term_view?.status;
          // Gerçek enum adı ADDED_EXCLUDED'dır; 'EXCLUDED_AND_ADDED' diye bir
          // değer yok — o dal hiç çalışmıyordu ve zaten dışlanmış terimler
          // "boşa harcama adayı" olarak tekrar tekrar öneriliyordu.
          return {
            terim: String(r.search_term_view.search_term),
            kampanyaId: String(r.campaign.id),
            kampanya: String(r.campaign.name),
            reklamGrubu: String(r.ad_group.name),
            reklamGrubuId: String(r.ad_group.id),
            maliyet: cost,
            tiklama: Number(m.clicks ?? 0),
            donusum: conv,
            israfAdayi,
            zatenDislanmis: stName === "EXCLUDED" || stName === "ADDED_EXCLUDED",
          };
        });

        const lines = terimler.map(
          (t) =>
            `"${t.terim}" — maliyet: ${t.maliyet.toFixed(2)}, tıklama: ${t.tiklama}, ` +
            `dönüşüm: ${t.donusum} (${t.kampanya} [kmp:${t.kampanyaId}] / ${t.reklamGrubu}, ag:${t.reklamGrubuId})` +
            `${t.israfAdayi ? " 🔥 boşa-harcama-adayı" : ""}${t.zatenDislanmis ? " [zaten dışlanmış]" : ""}`
        );
        const israfYuzde = totalCost > 0 ? Number(((wastedCost / totalCost) * 100).toFixed(0)) : 0;
        return ikili(
          `Son ${d} gün, ${rows.length} arama terimi. Toplam maliyet: ${totalCost.toFixed(2)}, ` +
            `dönüşümsüz terim maliyeti: ${wastedCost.toFixed(2)} (%${israfYuzde}).\n\n` +
            lines.join("\n") +
            `\n\nSONRAKİ ADIM: 🔥 işaretli terimlerden alakasız olanları belirle, kullanıcıya negatif kelime ` +
            `listesi olarak öner (hangi eşleme türüyle ekleneceğini söyle), ONAY SONRASI add_campaign_negative_keywords ile uygula. ` +
            `Dikkat: dönüşümsüz ≠ mutlaka alakasız — düşük hacimli ya da satış hunisinin başındaki terimleri aceleyle dışlama.`,
          { pencereGun: d, toplamMaliyet: totalCost, israfMaliyet: wastedCost, israfYuzde, terimler }
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "keyword_performance",
    {
      title: "Anahtar kelime performansı",
      description:
        "SENİN EKLEDİĞİN anahtar kelimelerin performansını listeler (maliyet, tıklama, dönüşüm). " +
        "KULLAN: hangi kelimenin kazandırdığını/kaybettirdiğini, ölü kelimeleri ve teklif dağılımını incelerken. " +
        "KULLANMA: kullanıcıların yazdığı GERÇEK aramaları görmek için — o search_terms_report'tur. " +
        "İPUCU: kampanya bazında daraltmak için campaignId ver.",
      annotations: READ_ANNOTATIONS,
      inputSchema: {
        customerId: z.string().describe("Google Ads müşteri ID"),
        campaignId: z.string().optional().describe("Tek kampanyaya filtrelemek için kampanya ID"),
        days: z.number().int().min(1).max(365).optional().describe("Kaç günlük pencere (varsayılan 30)"),
      },
      outputSchema: KELIME_SEMASI,
    },
    async ({ customerId, campaignId, days }) => {
      try {
        const d = days ?? 30;
        if (campaignId && !/^\d+$/.test(campaignId.trim()))
          return girdiHatasi(`Geçersiz kampanya ID: '${campaignId}' — sadece rakam olmalı.`);
        const filter = campaignId ? `AND campaign.id = ${Number(campaignId.trim())}` : "";
        const rows = await getCtx().queryWithRetry(customerId, `
          SELECT
            campaign.name, ad_group.name,
            ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
            ad_group_criterion.status,
            metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
          FROM keyword_view
          WHERE ${dateRange(d)}
          ${filter}
          ORDER BY metrics.cost_micros DESC
          LIMIT 200
        `);
        if (!rows.length) return ikili("Anahtar kelime verisi bulunamadı.", { pencereGun: d, kelimeler: [] });

        const kelimeler = rows.filter((r: any) => r?.campaign && r?.ad_group).map((r: any) => {
          const kw = r.ad_group_criterion?.keyword ?? {};
          const m = r.metrics ?? {};
          return {
            kelime: String(kw.text ?? ""),
            eslemeTuru: String((enums.KeywordMatchType as any)[kw.match_type] ?? kw.match_type ?? ""),
            kampanya: String(r.campaign.name),
            reklamGrubu: String(r.ad_group.name),
            maliyet: Number(m.cost_micros ?? 0) / 1e6,
            tiklama: Number(m.clicks ?? 0),
            donusum: Number(m.conversions ?? 0),
          };
        });
        const lines = kelimeler.map(
          (k) =>
            `"${k.kelime}" [${k.eslemeTuru}] (${k.kampanya} / ${k.reklamGrubu}) — maliyet: ${k.maliyet.toFixed(2)}, tıklama: ${k.tiklama}, dönüşüm: ${k.donusum}`
        );
        return ikili(`Son ${d} gün, ${rows.length} anahtar kelime:\n` + lines.join("\n"), { pencereGun: d, kelimeler });
      } catch (e) {
        return err(e);
      }
    }
  );
}
