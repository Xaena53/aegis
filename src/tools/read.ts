import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatAdsError, type ContextProvider } from "../adsClient.js";
import { enums } from "google-ads-api";
import { dateRange, ensureGaqlLimit } from "../util.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function err(e: unknown) {
  return { content: [{ type: "text" as const, text: formatAdsError(e) }], isError: true };
}

const READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true };

export function registerReadTools(server: McpServer, getCtx: ContextProvider) {
  server.registerTool(
    "list_accounts",
    {
      description:
        "Bağlı Google hesabının erişebildiği tüm Google Ads müşteri hesaplarını (customer ID) listeler; MCC (yönetici) hesapların alt hesapları da gösterilir. Diğer araçlara vereceğin customerId'yi buradan seç.",
      annotations: READ_ANNOTATIONS,
    },
    async () => {
      try {
        const ctx = getCtx();
        const ids = await ctx.listAccessibleCustomers();
        if (!ids.length) return text("Erişilebilir Google Ads hesabı bulunamadı.");
        const rows = await Promise.all(
          ids.slice(0, 30).map(async (id) => {
            try {
              const [row] = await ctx.queryWithRetry(
                id,
                `SELECT customer.descriptive_name, customer.currency_code, customer.manager FROM customer LIMIT 1`
              );
              const c: any = row?.customer ?? {};
              let line = `${id}\t${c.descriptive_name ?? "(isimsiz)"}\t${c.currency_code ?? "?"}${c.manager ? "\t[MCC]" : ""}`;
              // MCC ise alt hesapları da göster — listAccessibleCustomers alt hesapları DÖNDÜRMEZ
              if (c.manager) {
                // Not: status filtresi bilerek yok — test hesapları ENABLED dışı status
                // dönebiliyor ve filtre onları gizliyordu (canlıda görüldü). Status gösterilir.
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
                  const st = (enums.CustomerStatus as any)[cc.status] ?? cc.status;
                  line += `\n  └ ${cc.id}\t${cc.descriptive_name ?? "(isimsiz)"}\t${cc.currency_code ?? "?"}\t[${st}]${cc.manager ? " [MCC]" : ""}${cc.test_account ? " [TEST]" : ""}`;
                }
              }
              return line;
            } catch {
              return `${id}\t(detay okunamadı — login_customer_id gerekebilir)`;
            }
          })
        );
        const extra = ids.length > 30 ? `\n(… ve ${ids.length - 30} hesap daha — detayları atlandı)` : "";
        return text("customerId\tisim\tpara birimi\n" + rows.join("\n") + extra);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "run_gaql",
    {
      description:
        "Bir hesapta ham GAQL (Google Ads Query Language) sorgusu çalıştırır ve JSON satırları döner. Esnek raporlama için kullan; hazır özet için campaign_performance aracını tercih et.",
      annotations: READ_ANNOTATIONS,
      inputSchema: {
        customerId: z.string().describe("Google Ads müşteri ID (örn. 1234567890)"),
        query: z.string().describe("GAQL sorgusu, örn: SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_30_DAYS"),
        limit: z.number().int().min(1).max(1000).optional().describe("Maks satır (varsayılan 100)"),
      },
    },
    async ({ customerId, query, limit }) => {
      try {
        // LIMIT'siz sorgu Opteo'da TÜM sayfaları belleğe çeker — yoksa ekle
        const rows = await getCtx().queryWithRetry(customerId, ensureGaqlLimit(query, limit ?? 100));
        const capped = rows.slice(0, limit ?? 100);
        // Kompakt JSON + karakter tavanı: dev hesaplarda bağlamı şişirmesin
        let body = JSON.stringify(capped);
        const CHAR_CAP = 20_000;
        if (body.length > CHAR_CAP) {
          body =
            body.slice(0, CHAR_CAP) +
            `\n… [çıktı ${body.length} karakterdi, ${CHAR_CAP}'de kesildi — daha az alan seç veya limit düşür]`;
        }
        return text(`${rows.length} satır (${capped.length} gösteriliyor):\n${body}`);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "campaign_performance",
    {
      description:
        "Hesaptaki kampanyaların son N gündeki performans özetini verir: maliyet, tıklama, gösterim, dönüşüm, CTR, ort. TBM. Hızlı durum fotoğrafı için ilk başvurulacak araç.",
      annotations: READ_ANNOTATIONS,
      inputSchema: {
        customerId: z.string().describe("Google Ads müşteri ID"),
        days: z.number().int().min(1).max(365).optional().describe("Kaç günlük pencere (varsayılan 30)"),
        includePaused: z.boolean().optional().describe("Duraklatılmış kampanyalar da dahil edilsin mi (varsayılan true)"),
      },
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
        `);
        if (!rows.length) return text(`Son ${d} günde veri bulunan kampanya yok.`);
        const lines = rows.map((r: any) => {
          const m = r.metrics ?? {};
          const cost = (Number(m.cost_micros ?? 0) / 1e6).toFixed(2);
          const budget = (Number(r.campaign_budget?.amount_micros ?? 0) / 1e6).toFixed(2);
          const cpc = (Number(m.average_cpc ?? 0) / 1e6).toFixed(2);
          const ctr = (Number(m.ctr ?? 0) * 100).toFixed(2);
          const st = (enums.CampaignStatus as any)[r.campaign.status] ?? r.campaign.status;
          const ch = (enums.AdvertisingChannelType as any)[r.campaign.advertising_channel_type] ?? r.campaign.advertising_channel_type;
          return (
            `#${r.campaign.id} ${r.campaign.name} [${st}] (${ch})\n` +
            `  günlük bütçe: ${budget} | maliyet: ${cost} | tıklama: ${m.clicks ?? 0} | gösterim: ${m.impressions ?? 0} | dönüşüm: ${m.conversions ?? 0} | CTR: %${ctr} | ort.TBM: ${cpc}`
          );
        });
        return text(`Son ${d} gün, ${rows.length} kampanya:\n\n` + lines.join("\n"));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "search_terms_report",
    {
      description:
        "Reklamları GERÇEKTE tetikleyen arama terimlerini listeler (kullanıcıların yazdığı sorgular — anahtar kelimelerden farklıdır). Tıklama alıp dönüşüm getirmeyen terimleri 'boşa harcama adayı' olarak işaretler. Optimizasyon döngüsü: bu raporu incele → kullanıcıya negatif kelime önerilerini onaylat → add_campaign_negative_keywords ile uygula.",
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
    },
    async ({ customerId, campaignId, days, minClicks }) => {
      try {
        const d = days ?? 30;
        const mc = minClicks ?? 1;
        if (campaignId && !/^\d+$/.test(campaignId.trim()))
          return text(`Geçersiz kampanya ID: '${campaignId}' — sadece rakam olmalı.`);
        const filter = campaignId ? `AND campaign.id = ${Number(campaignId.trim())}` : "";
        const rows = await getCtx().queryWithRetry(
          customerId,
          `SELECT
             campaign.name, ad_group.id, ad_group.name,
             search_term_view.search_term, search_term_view.status,
             metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
           FROM search_term_view
           WHERE ${dateRange(d)} AND metrics.clicks >= ${mc}
           ${filter}
           ORDER BY metrics.cost_micros DESC
           LIMIT 200`
        );
        if (!rows.length)
          return text(`Son ${d} günde (≥${mc} tıklama) arama terimi verisi yok. minClicks=0 ile genişletebilirsin.`);

        let totalCost = 0;
        let wastedCost = 0;
        const lines = rows.map((r: any) => {
          const m = r.metrics ?? {};
          const cost = Number(m.cost_micros ?? 0) / 1e6;
          const conv = Number(m.conversions ?? 0);
          totalCost += cost;
          const wasteful = conv === 0 && cost > 0;
          if (wasteful) wastedCost += cost;
          const flag = wasteful ? " 🔥 boşa-harcama-adayı" : "";
          const stName = (enums.SearchTermTargetingStatus as any)[r.search_term_view?.status] ?? r.search_term_view?.status;
          const excluded = stName === "EXCLUDED" || stName === "EXCLUDED_AND_ADDED" ? " [zaten dışlanmış]" : "";
          return (
            `"${r.search_term_view.search_term}" — maliyet: ${cost.toFixed(2)}, tıklama: ${m.clicks ?? 0}, ` +
            `dönüşüm: ${conv} (${r.campaign.name} / ${r.ad_group.name}, ag:${r.ad_group.id})${flag}${excluded}`
          );
        });
        const pct = totalCost > 0 ? ((wastedCost / totalCost) * 100).toFixed(0) : "0";
        return text(
          `Son ${d} gün, ${rows.length} arama terimi. Toplam maliyet: ${totalCost.toFixed(2)}, ` +
            `dönüşümsüz terim maliyeti: ${wastedCost.toFixed(2)} (%${pct}).\n\n` +
            lines.join("\n") +
            `\n\nSONRAKİ ADIM: 🔥 işaretli terimlerden alakasız olanları belirle, kullanıcıya negatif kelime ` +
            `listesi olarak öner (hangi eşleme türüyle ekleneceğini söyle), ONAY SONRASI add_campaign_negative_keywords ile uygula. ` +
            `Dikkat: dönüşümsüz ≠ mutlaka alakasız — düşük hacimli ya da satış hunisinin başındaki terimleri aceleyle dışlama.`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "keyword_performance",
    {
      description:
        "Bir kampanyanın (veya tüm hesabın) anahtar kelime bazlı performansını listeler. Boşa harcanan kelimeleri ve kazananları tespit etmek için kullan.",
      annotations: READ_ANNOTATIONS,
      inputSchema: {
        customerId: z.string().describe("Google Ads müşteri ID"),
        campaignId: z.string().optional().describe("Tek kampanyaya filtrelemek için kampanya ID"),
        days: z.number().int().min(1).max(365).optional().describe("Kaç günlük pencere (varsayılan 30)"),
      },
    },
    async ({ customerId, campaignId, days }) => {
      try {
        const d = days ?? 30;
        if (campaignId && !/^\d+$/.test(campaignId.trim()))
          return text(`Geçersiz kampanya ID: '${campaignId}' — sadece rakam olmalı.`);
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
        if (!rows.length) return text("Anahtar kelime verisi bulunamadı.");
        const lines = rows.map((r: any) => {
          const kw = r.ad_group_criterion?.keyword ?? {};
          const m = r.metrics ?? {};
          const cost = (Number(m.cost_micros ?? 0) / 1e6).toFixed(2);
          const mt = (enums.KeywordMatchType as any)[kw.match_type] ?? kw.match_type;
          return `"${kw.text}" [${mt}] (${r.campaign.name} / ${r.ad_group.name}) — maliyet: ${cost}, tıklama: ${m.clicks ?? 0}, dönüşüm: ${m.conversions ?? 0}`;
        });
        return text(`Son ${d} gün, ${rows.length} anahtar kelime:\n` + lines.join("\n"));
      } catch (e) {
        return err(e);
      }
    }
  );
}
