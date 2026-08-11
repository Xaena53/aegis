import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { enums, resources, toMicros, ResourceNames } from "google-ads-api";
import { getCustomer, getConfig, formatAdsError, normalizeCustomerId } from "../adsClient.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function err(e: unknown) {
  return { content: [{ type: "text" as const, text: formatAdsError(e) }], isError: true };
}

function writesDisabled() {
  return text(
    "Yazma araçları devre dışı (ADSPILOT_WRITE_ENABLED=0). .env üzerinden açılması gerekiyor — kullanıcıya danış."
  );
}

/** Bütçe kelepçesi: tavanı aşan istekleri reddeder. */
function budgetGuard(amount: number): string | null {
  const cap = getConfig().maxDailyBudget;
  if (amount > cap) {
    return (
      `Reddedildi: istenen günlük bütçe (${amount}) güvenlik tavanının (${cap}) üzerinde. ` +
      `Tavan .env'de ADSPILOT_MAX_DAILY_BUDGET ile yönetilir; kullanıcı onayı olmadan yükseltme.`
    );
  }
  if (amount <= 0) return "Reddedildi: bütçe 0'dan büyük olmalı.";
  return null;
}

export function registerWriteTools(server: McpServer) {
  server.tool(
    "create_search_campaign",
    "Yeni bir Arama kampanyası oluşturur (bütçe + kampanya + reklam grubu + anahtar kelimeler). GÜVENLİK: kampanya her zaman PAUSED (duraklatılmış) oluşturulur; yayına almak için kullanıcı onayı sonrası set_campaign_status kullanılır.",
    {
      customerId: z.string().describe("Google Ads müşteri ID"),
      name: z.string().min(1).describe("Kampanya adı"),
      dailyBudget: z.number().positive().describe("Günlük bütçe (hesap para biriminde, örn. 50)"),
      keywords: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .describe("Anahtar kelimeler (PHRASE eşleme ile eklenir)"),
      adGroupName: z.string().optional().describe("Reklam grubu adı (varsayılan: 'Reklam Grubu 1')"),
    },
    async ({ customerId, name, dailyBudget, keywords, adGroupName }) => {
      if (!getConfig().writeEnabled) return writesDisabled();
      const guardMsg = budgetGuard(dailyBudget);
      if (guardMsg) return text(guardMsg);
      try {
        const customer = getCustomer(customerId);
        const cid = normalizeCustomerId(customerId);
        const budgetResourceName = ResourceNames.campaignBudget(cid, "-1");
        const campaignResourceName = ResourceNames.campaign(cid, "-2");
        const adGroupResourceName = ResourceNames.adGroup(cid, "-3");

        const operations: any[] = [
          {
            entity: "campaign_budget",
            operation: "create",
            resource: {
              resource_name: budgetResourceName,
              name: `${name} — bütçe`,
              amount_micros: toMicros(dailyBudget),
              delivery_method: enums.BudgetDeliveryMethod.STANDARD,
              explicitly_shared: false,
            },
          },
          {
            entity: "campaign",
            operation: "create",
            resource: {
              resource_name: campaignResourceName,
              name,
              advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
              status: enums.CampaignStatus.PAUSED, // güvenlik: asla ENABLED oluşturma
              campaign_budget: budgetResourceName,
              manual_cpc: { enhanced_cpc_enabled: false },
              network_settings: {
                target_google_search: true,
                target_search_network: true,
                target_content_network: false,
              },
            },
          },
          {
            entity: "ad_group",
            operation: "create",
            resource: {
              resource_name: adGroupResourceName,
              name: adGroupName || "Reklam Grubu 1",
              campaign: campaignResourceName,
              type: enums.AdGroupType.SEARCH_STANDARD,
              status: enums.AdGroupStatus.ENABLED,
            },
          },
          ...keywords.map((kw) => ({
            entity: "ad_group_criterion",
            operation: "create" as const,
            resource: {
              ad_group: adGroupResourceName,
              status: enums.AdGroupCriterionStatus.ENABLED,
              keyword: { text: kw, match_type: enums.KeywordMatchType.PHRASE },
            },
          })),
        ];

        const res: any = await customer.mutateResources(operations);
        const created =
          res?.mutate_operation_responses
            ?.map((r: any) => Object.values(r)[0])
            ?.map((v: any) => v?.resource_name)
            ?.filter(Boolean) ?? [];
        return text(
          `Kampanya PAUSED olarak oluşturuldu (${keywords.length} anahtar kelime, günlük bütçe ${dailyBudget}).\n` +
            `Oluşan kaynaklar:\n${created.join("\n")}\n\n` +
            `SONRAKİ ADIM: Reklam metni ekle (create_responsive_search_ad), kullanıcı onayını al, sonra set_campaign_status ile yayına al.`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "create_responsive_search_ad",
    "Bir reklam grubuna Duyarlı Arama Ağı Reklamı (RSA) ekler. En az 3 başlık (30 karakter) ve 2 açıklama (90 karakter) gerekir.",
    {
      customerId: z.string().describe("Google Ads müşteri ID"),
      adGroupId: z.string().describe("Reklam grubu ID"),
      finalUrl: z.string().url().describe("Reklamın gideceği sayfa URL'i"),
      headlines: z.array(z.string().min(1).max(30)).min(3).max(15).describe("Başlıklar (maks 30 karakter)"),
      descriptions: z.array(z.string().min(1).max(90)).min(2).max(4).describe("Açıklamalar (maks 90 karakter)"),
    },
    async ({ customerId, adGroupId, finalUrl, headlines, descriptions }) => {
      if (!getConfig().writeEnabled) return writesDisabled();
      try {
        const customer = getCustomer(customerId);
        const cid = normalizeCustomerId(customerId);
        const res: any = await customer.adGroupAds.create([
          {
            ad_group: ResourceNames.adGroup(cid, adGroupId),
            status: enums.AdGroupAdStatus.ENABLED,
            ad: {
              final_urls: [finalUrl],
              responsive_search_ad: {
                headlines: headlines.map((t) => ({ text: t })),
                descriptions: descriptions.map((t) => ({ text: t })),
              },
            },
          },
        ]);
        const rn = res?.results?.[0]?.resource_name ?? "(resource_name okunamadı)";
        return text(
          `RSA oluşturuldu: ${rn}\nNot: Kampanya PAUSED ise reklam yayınlanmaz; onay sonrası set_campaign_status ile açılır.`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "update_campaign_budget",
    "Bir kampanyanın günlük bütçesini günceller. Güvenlik tavanı (ADSPILOT_MAX_DAILY_BUDGET) üzerindeki istekler reddedilir.",
    {
      customerId: z.string().describe("Google Ads müşteri ID"),
      campaignId: z.string().describe("Kampanya ID"),
      newDailyBudget: z.number().positive().describe("Yeni günlük bütçe (hesap para biriminde)"),
    },
    async ({ customerId, campaignId, newDailyBudget }) => {
      if (!getConfig().writeEnabled) return writesDisabled();
      const guardMsg = budgetGuard(newDailyBudget);
      if (guardMsg) return text(guardMsg);
      try {
        const customer = getCustomer(customerId);
        const [row]: any[] = await customer.query(
          `SELECT campaign.id, campaign.name, campaign_budget.resource_name, campaign_budget.amount_micros
           FROM campaign WHERE campaign.id = ${Number(campaignId)} LIMIT 1`
        );
        if (!row) return text(`Kampanya bulunamadı: ${campaignId}`);
        const oldBudget = Number(row.campaign_budget.amount_micros) / 1e6;
        await customer.campaignBudgets.update([
          {
            resource_name: row.campaign_budget.resource_name,
            amount_micros: toMicros(newDailyBudget),
          },
        ]);
        return text(
          `"${row.campaign.name}" bütçesi güncellendi: ${oldBudget} → ${newDailyBudget} (günlük).`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "add_keywords",
    "Mevcut bir reklam grubuna anahtar kelime ekler.",
    {
      customerId: z.string().describe("Google Ads müşteri ID"),
      adGroupId: z.string().describe("Reklam grubu ID"),
      keywords: z.array(z.string().min(1)).min(1).max(100).describe("Eklenecek anahtar kelimeler"),
      matchType: z
        .enum(["EXACT", "PHRASE", "BROAD"])
        .optional()
        .describe("Eşleme türü (varsayılan PHRASE)"),
      negative: z.boolean().optional().describe("true ise negatif anahtar kelime olarak eklenir"),
    },
    async ({ customerId, adGroupId, keywords, matchType, negative }) => {
      if (!getConfig().writeEnabled) return writesDisabled();
      try {
        const customer = getCustomer(customerId);
        const cid = normalizeCustomerId(customerId);
        const mt = enums.KeywordMatchType[matchType ?? "PHRASE"];
        await customer.adGroupCriteria.create(
          keywords.map((kw) => ({
            ad_group: ResourceNames.adGroup(cid, adGroupId),
            status: enums.AdGroupCriterionStatus.ENABLED,
            negative: negative ?? false,
            keyword: { text: kw, match_type: mt },
          }))
        );
        return text(
          `${keywords.length} ${negative ? "negatif " : ""}anahtar kelime eklendi [${matchType ?? "PHRASE"}].`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "set_campaign_status",
    "Kampanyayı yayına alır (ENABLED) veya duraklatır (PAUSED). GÜVENLİK: ENABLED yapmak gerçek para harcatır — yalnızca kullanıcı bu konuşmada açıkça onay verdiyse confirm=true gönder.",
    {
      customerId: z.string().describe("Google Ads müşteri ID"),
      campaignId: z.string().describe("Kampanya ID"),
      status: z.enum(["ENABLED", "PAUSED"]).describe("Hedef durum"),
      confirm: z
        .boolean()
        .optional()
        .describe("ENABLED için zorunlu: kullanıcının açık onayını aldıysan true"),
    },
    async ({ customerId, campaignId, status, confirm }) => {
      if (!getConfig().writeEnabled) return writesDisabled();
      if (status === "ENABLED" && !confirm) {
        return text(
          "Reddedildi: kampanyayı yayına almak gerçek harcama başlatır. Önce kullanıcıya kampanya özetini (bütçe, anahtar kelimeler, reklam metni) göster ve açık onayını al; onay geldiyse confirm=true ile tekrar çağır."
        );
      }
      try {
        const customer = getCustomer(customerId);
        const cid = normalizeCustomerId(customerId);
        await customer.campaigns.update([
          {
            resource_name: ResourceNames.campaign(cid, campaignId),
            status: enums.CampaignStatus[status],
          },
        ]);
        return text(
          status === "ENABLED"
            ? `Kampanya ${campaignId} YAYINDA (ENABLED). Harcama başladı — performansı campaign_performance ile izle.`
            : `Kampanya ${campaignId} duraklatıldı (PAUSED).`
        );
      } catch (e) {
        return err(e);
      }
    }
  );
}
