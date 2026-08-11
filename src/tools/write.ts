import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { enums, ResourceNames } from "google-ads-api";
import { getCustomer, getConfig, formatAdsError, normalizeCustomerId, queryWithRetry } from "../adsClient.js";
import { dedupe, geoTargetId, invalidId, ISO_NUMERIC, toMicrosInt, budgetGuard as budgetGuardPure } from "../util.js";

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

// Yazma araçları: openWorld (dış API), idempotent değil.
// destructiveHint: para harcamasını/mevcut durumu değiştirenlerde true.
const WRITE_SAFE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const WRITE_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

/** Bütçe kelepçesi — tavan .env'den. */
function budgetGuard(amount: number): string | null {
  return budgetGuardPure(amount, getConfig().maxDailyBudget);
}

export function registerWriteTools(server: McpServer) {
  server.registerTool(
    "create_search_campaign",
    {
      description:
        "Yeni bir Arama kampanyası oluşturur (bütçe + kampanya + ülke hedefleme + reklam grubu + anahtar kelimeler). GÜVENLİK: kampanya her zaman PAUSED (duraklatılmış) oluşturulur; yayına almak için kullanıcı onayı sonrası set_campaign_status kullanılır.",
      annotations: WRITE_SAFE,
      inputSchema: {
        customerId: z.string().describe("Google Ads müşteri ID"),
        name: z.string().min(1).max(255).describe("Kampanya adı (maks 255)"),
        dailyBudget: z.number().positive().describe("Günlük bütçe (hesap para biriminde, örn. 50)"),
        keywords: z
          .array(z.string().min(1).max(80))
          .min(1)
          .max(50)
          .describe("Anahtar kelimeler (PHRASE eşleme ile eklenir; Google sınırı: 80 karakter)"),
        countryCodes: z
          .array(z.string().length(2))
          .min(1)
          .describe(
            "Hedef ülkeler, ISO alpha-2 (örn. ['TR']). ZORUNLU — verilmezse Google kampanyayı DÜNYA GENELİ yayınlar ve bütçe çöpe gider."
          ),
        adGroupName: z.string().max(255).optional().describe("Reklam grubu adı (varsayılan: 'Reklam Grubu 1')"),
      },
    },
    async ({ customerId, name, dailyBudget, keywords, countryCodes, adGroupName }) => {
      if (!getConfig().writeEnabled) return writesDisabled();
      const guardMsg = budgetGuard(dailyBudget);
      if (guardMsg) return text(guardMsg);
      const geoIds: number[] = [];
      for (const cc of countryCodes) {
        const id = geoTargetId(cc);
        if (!id)
          return text(
            `Reddedildi: '${cc}' ülke kodu dahili listede yok. Desteklenenler: ${Object.keys(ISO_NUMERIC).join(", ")}`
          );
        geoIds.push(id);
      }
      const uniqueKeywords = dedupe(keywords);
      if (!uniqueKeywords.length) return text("Reddedildi: geçerli anahtar kelime kalmadı (hepsi boş/tekrar).");
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
              amount_micros: toMicrosInt(dailyBudget),
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
              // eCPC API v17+'da kaldırıldı; sade Manual CPC ile başla
              manual_cpc: {},
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
          // Coğrafi hedefleme: verilen ülkelerle sınırla (yoksa Google dünya geneli yayınlar)
          ...geoIds.map((gid) => ({
            entity: "campaign_criterion",
            operation: "create" as const,
            resource: {
              campaign: campaignResourceName,
              location: { geo_target_constant: `geoTargetConstants/${gid}` },
            },
          })),
          ...uniqueKeywords.map((kw) => ({
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
          `Kampanya PAUSED olarak oluşturuldu (${uniqueKeywords.length} anahtar kelime, günlük bütçe ${dailyBudget}, hedef: ${countryCodes.join(", ").toUpperCase()}).\n` +
            `Oluşan kaynaklar:\n${created.join("\n")}\n\n` +
            `SONRAKİ ADIM: Reklam metni ekle (create_responsive_search_ad), kullanıcı onayını al, sonra set_campaign_status ile yayına al.`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "create_responsive_search_ad",
    {
      description:
        "Bir reklam grubuna Duyarlı Arama Ağı Reklamı (RSA) ekler. En az 3 başlık (30 karakter) ve 2 açıklama (90 karakter) gerekir; başlık/açıklamalar birbirinden farklı olmalı.",
      annotations: WRITE_SAFE,
      inputSchema: {
        customerId: z.string().describe("Google Ads müşteri ID"),
        adGroupId: z.string().describe("Reklam grubu ID"),
        finalUrl: z.string().url().max(2048).describe("Reklamın gideceği sayfa URL'i"),
        headlines: z.array(z.string().min(1).max(30)).min(3).max(15).describe("Başlıklar (maks 30 karakter)"),
        descriptions: z.array(z.string().min(1).max(90)).min(2).max(4).describe("Açıklamalar (maks 90 karakter)"),
      },
    },
    async ({ customerId, adGroupId, finalUrl, headlines, descriptions }) => {
      if (!getConfig().writeEnabled) return writesDisabled();
      const idErr = invalidId("reklam grubu ID", adGroupId);
      if (idErr) return text(idErr);
      // Google tekrar eden varlıkları reddeder — burada anlaşılır mesajla yakala
      const uh = dedupe(headlines);
      const ud = dedupe(descriptions);
      if (uh.length < 3)
        return text(
          `Reddedildi: tekrarlar ayıklanınca ${uh.length} benzersiz başlık kaldı — en az 3 FARKLI başlık gerekli.`
        );
      if (ud.length < 2)
        return text(
          `Reddedildi: tekrarlar ayıklanınca ${ud.length} benzersiz açıklama kaldı — en az 2 FARKLI açıklama gerekli.`
        );
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
                headlines: uh.map((t) => ({ text: t })),
                descriptions: ud.map((t) => ({ text: t })),
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

  server.registerTool(
    "update_campaign_budget",
    {
      description:
        "Bir kampanyanın günlük bütçesini günceller. Güvenlik tavanı (ADSPILOT_MAX_DAILY_BUDGET) üzerindeki istekler ve paylaşımlı bütçeler reddedilir.",
      annotations: WRITE_DESTRUCTIVE,
      inputSchema: {
        customerId: z.string().describe("Google Ads müşteri ID"),
        campaignId: z.string().describe("Kampanya ID"),
        newDailyBudget: z.number().positive().describe("Yeni günlük bütçe (hesap para biriminde)"),
      },
    },
    async ({ customerId, campaignId, newDailyBudget }) => {
      if (!getConfig().writeEnabled) return writesDisabled();
      const idErr = invalidId("kampanya ID", campaignId);
      if (idErr) return text(idErr);
      const guardMsg = budgetGuard(newDailyBudget);
      if (guardMsg) return text(guardMsg);
      try {
        const customer = getCustomer(customerId);
        const [row]: any[] = await queryWithRetry(
          customerId,
          `SELECT campaign.id, campaign.name, campaign_budget.resource_name,
                  campaign_budget.amount_micros, campaign_budget.explicitly_shared
           FROM campaign WHERE campaign.id = ${Number(campaignId)} AND campaign.status != 'REMOVED' LIMIT 1`
        );
        if (!row) return text(`Kampanya bulunamadı: ${campaignId}`);
        if (row.campaign_budget?.explicitly_shared) {
          return text(
            `Reddedildi: "${row.campaign.name}" PAYLAŞIMLI bir bütçe kullanıyor — değişiklik bu bütçeyi kullanan TÜM kampanyaları etkiler. Kullanıcıya durumu bildir; isterse Google Ads arayüzünden kampanyaya özel bütçe atansın.`
          );
        }
        const oldBudget = Number(row.campaign_budget.amount_micros) / 1e6;
        await customer.campaignBudgets.update([
          {
            resource_name: row.campaign_budget.resource_name,
            amount_micros: toMicrosInt(newDailyBudget),
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

  server.registerTool(
    "add_keywords",
    {
      description: "Mevcut bir reklam grubuna anahtar kelime ekler.",
      annotations: WRITE_SAFE,
      inputSchema: {
        customerId: z.string().describe("Google Ads müşteri ID"),
        adGroupId: z.string().describe("Reklam grubu ID"),
        keywords: z.array(z.string().min(1).max(80)).min(1).max(100).describe("Eklenecek anahtar kelimeler (maks 80 karakter)"),
        matchType: z
          .enum(["EXACT", "PHRASE", "BROAD"])
          .optional()
          .describe("Eşleme türü (varsayılan PHRASE)"),
        negative: z.boolean().optional().describe("true ise negatif anahtar kelime olarak eklenir"),
      },
    },
    async ({ customerId, adGroupId, keywords, matchType, negative }) => {
      if (!getConfig().writeEnabled) return writesDisabled();
      const idErr = invalidId("reklam grubu ID", adGroupId);
      if (idErr) return text(idErr);
      const unique = dedupe(keywords);
      if (!unique.length) return text("Reddedildi: geçerli anahtar kelime kalmadı (hepsi boş/tekrar).");
      try {
        const customer = getCustomer(customerId);
        const cid = normalizeCustomerId(customerId);
        const mt = enums.KeywordMatchType[matchType ?? "PHRASE"];
        await customer.adGroupCriteria.create(
          unique.map((kw) => ({
            ad_group: ResourceNames.adGroup(cid, adGroupId),
            // negatif kriterlerde status gönderilmez
            ...(negative ? { negative: true } : { status: enums.AdGroupCriterionStatus.ENABLED }),
            keyword: { text: kw, match_type: mt },
          }))
        );
        const skipped = keywords.length - unique.length;
        return text(
          `${unique.length} ${negative ? "negatif " : ""}anahtar kelime eklendi [${matchType ?? "PHRASE"}]` +
            (skipped ? ` (${skipped} tekrar/boş atlandı)` : "") +
            "."
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "add_campaign_negative_keywords",
    {
      description:
        "KAMPANYA seviyesinde negatif anahtar kelime ekler (kampanyadaki tüm reklam gruplarını kapsar). Boşa harcamayı kesmenin ana aracı — reklam-grubu seviyesi için add_keywords(negative=true).",
      annotations: WRITE_SAFE,
      inputSchema: {
        customerId: z.string().describe("Google Ads müşteri ID"),
        campaignId: z.string().describe("Kampanya ID"),
        keywords: z.array(z.string().min(1).max(80)).min(1).max(100).describe("Negatif anahtar kelimeler (maks 80 karakter)"),
        matchType: z
          .enum(["EXACT", "PHRASE", "BROAD"])
          .optional()
          .describe("Eşleme türü (varsayılan PHRASE)"),
      },
    },
    async ({ customerId, campaignId, keywords, matchType }) => {
      if (!getConfig().writeEnabled) return writesDisabled();
      const idErr = invalidId("kampanya ID", campaignId);
      if (idErr) return text(idErr);
      const unique = dedupe(keywords);
      if (!unique.length) return text("Reddedildi: geçerli anahtar kelime kalmadı (hepsi boş/tekrar).");
      try {
        const customer = getCustomer(customerId);
        const cid = normalizeCustomerId(customerId);
        const mt = enums.KeywordMatchType[matchType ?? "PHRASE"];
        await customer.campaignCriteria.create(
          unique.map((kw) => ({
            campaign: ResourceNames.campaign(cid, campaignId),
            negative: true,
            keyword: { text: kw, match_type: mt },
          }))
        );
        const skipped = keywords.length - unique.length;
        return text(
          `${unique.length} negatif anahtar kelime KAMPANYA seviyesinde eklendi [${matchType ?? "PHRASE"}]` +
            (skipped ? ` (${skipped} tekrar/boş atlandı)` : "") +
            "."
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "set_campaign_status",
    {
      description:
        "Kampanyayı yayına alır (ENABLED) veya duraklatır (PAUSED). GÜVENLİK: ENABLED yapmak gerçek para harcatır — yalnızca kullanıcı bu konuşmada açıkça onay verdiyse confirm=true gönder.",
      annotations: WRITE_DESTRUCTIVE,
      inputSchema: {
        customerId: z.string().describe("Google Ads müşteri ID"),
        campaignId: z.string().describe("Kampanya ID"),
        status: z.enum(["ENABLED", "PAUSED"]).describe("Hedef durum"),
        confirm: z
          .boolean()
          .optional()
          .describe("ENABLED için zorunlu: kullanıcının açık onayını aldıysan true"),
      },
    },
    async ({ customerId, campaignId, status, confirm }) => {
      if (!getConfig().writeEnabled) return writesDisabled();
      const idErr = invalidId("kampanya ID", campaignId);
      if (idErr) return text(idErr);
      if (status === "ENABLED" && !confirm) {
        return text(
          "Reddedildi: kampanyayı yayına almak gerçek harcama başlatır. Önce kullanıcıya kampanya özetini (bütçe, anahtar kelimeler, reklam metni) göster ve açık onayını al; onay geldiyse confirm=true ile tekrar çağır."
        );
      }
      try {
        const customer = getCustomer(customerId);
        const cid = normalizeCustomerId(customerId);
        if (status === "ENABLED") {
          // Reklamı olmayan kampanyayı yayına almak anlamsız — büyük ihtimalle akış hatası
          const ads = await queryWithRetry(
            customerId,
            `SELECT ad_group_ad.ad.id FROM ad_group_ad
             WHERE campaign.id = ${Number(campaignId)} AND ad_group_ad.status != 'REMOVED' LIMIT 1`
          );
          if (!ads.length) {
            return text(
              `Reddedildi: kampanya ${campaignId} içinde hiç reklam yok — yayına alınsa da gösterim yapamaz. Önce create_responsive_search_ad ile reklam ekle.`
            );
          }
        }
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
