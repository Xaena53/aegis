// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Write tools — the money path.
 *
 * Campaigns are always created paused. Anything that increases spend passes through the
 * approval gate, and any state that cannot be verified is treated as unsafe.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { enums, ResourceNames } from "google-ads-api";
import { formatAdsError, normalizeCustomerId, type ContextProvider } from "../adsClient.js";
import { onayAl } from "../approval.js";
import {
  dedupe,
  geoTargetId,
  invalidId,
  cleanId,
  ISO_NUMERIC,
  toMicrosInt,
  budgetGuard as budgetGuardPure,
} from "../util.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function err(e: unknown) {
  return { content: [{ type: "text" as const, text: formatAdsError(e) }], isError: true };
}

function writesDisabled() {
  return text(
    "Yazma araçları bu hesap için devre dışı. Yalnız hesap sahibi açabilir — kullanıcıya bildir, kendi başına aşmaya çalışma."
  );
}

/** Budget clamp — the ceiling comes from the calling user's own context. */
function budgetGuardFor(ctx: { config: { maxDailyBudget: number } }, amount: number): string | null {
  return budgetGuardPure(amount, ctx.config.maxDailyBudget);
}

/**
 * Live-campaign guard. Adding an ad or a keyword to a serving campaign starts
 * spending real money immediately, which carries the same weight as enabling the
 * campaign and therefore demands the same explicit approval. A PAUSED campaign is
 * the ordinary draft flow and needs no approval.
 * Returns a blocking message, or null when the caller may proceed.
 */
async function liveCampaignGuard(
  server: McpServer,
  ctx: any,
  customerId: string,
  where: { adGroupId?: string; campaignId?: string },
  confirm: boolean | undefined,
  eylem: string,
  ayrinti: string[]
): Promise<string | null> {
  const filter = where.adGroupId
    ? `ad_group.id = ${Number(cleanId(where.adGroupId))}`
    : `campaign.id = ${Number(cleanId(where.campaignId!))}`;
  const rows = await ctx.queryWithRetry(
    customerId,
    `SELECT campaign.id, campaign.name, campaign.status, ad_group.status
     FROM ad_group WHERE ${filter} LIMIT 1`
  );
  /**
   * Fail closed. Approval is skipped only when the campaign is provably paused.
   * An empty result, a missing status field or an unexpected type all count as
   * "unknown", and unknown means ask — a spend gate must not open on ambiguity.
   */
  const ham = rows.length ? rows[0]?.campaign?.status : undefined;
  const durumAdi =
    typeof ham === "number" ? String((enums.CampaignStatus as any)[ham] ?? "") : typeof ham === "string" ? ham : "";
  const kesinTaslak = durumAdi !== "" && durumAdi !== "ENABLED" && durumAdi !== "UNKNOWN" && durumAdi !== "UNSPECIFIED";
  if (kesinTaslak) return null; // draft flow: no approval needed

  const kampanyaAdi = rows.length ? String(rows[0]?.campaign?.name ?? "(adsız)") : "(bulunamadı)";
  const belirsiz = durumAdi === "" ? " (kampanya durumu doğrulanamadı — güvenli tarafa geçildi)" : "";

  const onay = await onayAl(
    server,
    {
      eylem: `"${kampanyaAdi}" kampanyası ŞU AN YAYINDA${belirsiz} — ${eylem} anında gerçek harcamayı etkiler.`,
      satirlar: [`Hesap: ${normalizeCustomerId(customerId)}`, ...ayrinti],
      soru: `${eylem} onaylıyor musun?`,
      risk: "high",
      agAyar: ctx.config,
      // Denetim günlüğü çok-kiracılı modda hangi hesabın kararı olduğunu bilmeli.
      hesapId: normalizeCustomerId(customerId),
    },
    confirm
  );
  return onay.onaylandi ? null : onay.mesaj!;
}

// Write tools hit an external API, so they are openWorld and never idempotent.
// destructiveHint is true for anything that changes spend or existing state.
const WRITE_SAFE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const WRITE_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export function registerWriteTools(server: McpServer, getCtx: ContextProvider) {
  server.registerTool(
    "create_search_campaign",
    {
      title: "Arama kampanyası kur (taslak)",
      description:
        "Yeni Arama kampanyası oluşturur: bütçe + kampanya + ülke hedefi + reklam grubu + anahtar kelimeler, tek atomik işlemde. " +
        "KULLAN: sıfırdan yeni kampanya kurarken. " +
        "KULLANMA: var olan kampanyaya kelime/reklam eklemek için (add_keywords, create_responsive_search_ad). " +
        "GÜVENLİK: kampanya HER ZAMAN duraklatılmış (PAUSED) doğar — bu araç asla harcama başlatmaz. " +
        "SONRAKİ ADIM: create_responsive_search_ad ile reklam metni ekle, sonra kullanıcıya sor; yayına alma ayrı ve onaylıdır.",
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
      const ctx = getCtx();
      if (!ctx.config.writeEnabled) return writesDisabled();
      const guardMsg = budgetGuardFor(ctx, dailyBudget);
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
        const customer = ctx.getCustomer(customerId);
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
              status: enums.CampaignStatus.PAUSED, // safety: never create as ENABLED
              // The EU DSA declaration is required by the API. This tool only builds
              // commercial campaigns; political advertising is out of scope here.
              contains_eu_political_advertising:
                enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
              campaign_budget: budgetResourceName,
              // eCPC was removed in API v17+, so start with plain Manual CPC
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
          // Geo targeting: restrict to the given countries — without it Google serves worldwide
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

        const res: any = await ctx.mutateWithRetry(() => customer.mutateResources(operations));
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
      title: "Reklam metni ekle (RSA)",
      description:
        "Reklam grubuna Duyarlı Arama Ağı Reklamı ekler. En az 3 FARKLI başlık (≤30 karakter) ve 2 FARKLI açıklama (≤90 karakter) gerekir. " +
        "KULLAN: kampanya taslağı kurulduktan hemen sonra — reklamsız kampanya yayına alınamaz. " +
        "GÜVENLİK: kampanya PAUSED ise serbesttir; kampanya ZATEN YAYINDAYSA kullanıcı onayı istenir (reklam anında gösterime girer). " +
        "İPUCU: karakter sınırlarını yazmadan önce SAYARAK doğrula; Google kırpmaz, reddeder.",
      annotations: WRITE_DESTRUCTIVE,
      inputSchema: {
        customerId: z.string().describe("Google Ads müşteri ID"),
        adGroupId: z.string().describe("Reklam grubu ID"),
        finalUrl: z.string().url().max(2048).describe("Reklamın gideceği sayfa URL'i"),
        headlines: z.array(z.string().min(1).max(30)).min(3).max(15).describe("Başlıklar (maks 30 karakter)"),
        descriptions: z.array(z.string().min(1).max(90)).min(2).max(4).describe("Açıklamalar (maks 90 karakter)"),
        confirm: z
          .boolean()
          .optional()
          .describe("Kampanya ZATEN YAYINDAYSA zorunlu: kullanıcının açık onayını aldıysan true"),
      },
    },
    async ({ customerId, adGroupId, finalUrl, headlines, descriptions, confirm }) => {
      const ctx = getCtx();
      if (!ctx.config.writeEnabled) return writesDisabled();
      const idErr = invalidId("reklam grubu ID", adGroupId);
      if (idErr) return text(idErr);
      if (!/^https?:\/\//i.test(finalUrl)) return text("Reddedildi: finalUrl yalnız http/https olabilir.");
      // Google rejects duplicate assets — catch it here with a readable message
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
        const live = await liveCampaignGuard(server, ctx, customerId, { adGroupId }, confirm, "reklam eklemek", [
          `Hedef sayfa: ${finalUrl}`,
          `Başlıklar: ${uh.join(" | ")}`,
          `Açıklamalar: ${ud.join(" | ")}`,
        ]);
        if (live) return text(live);
        const customer = ctx.getCustomer(customerId);
        const cid = normalizeCustomerId(customerId);
        const res: any = await ctx.mutateWithRetry(() => customer.adGroupAds.create([
          {
            ad_group: ResourceNames.adGroup(cid, cleanId(adGroupId)),
            status: enums.AdGroupAdStatus.ENABLED,
            ad: {
              final_urls: [finalUrl],
              responsive_search_ad: {
                headlines: uh.map((t) => ({ text: t })),
                descriptions: ud.map((t) => ({ text: t })),
              },
            },
          },
        ]));
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
      title: "Günlük bütçeyi değiştir",
      description:
        "Kampanyanın günlük bütçesini günceller. " +
        "KULLAN: harcamayı kısmak ya da kullanıcının istediği artışı uygulamak için. " +
        "GÜVENLİK: AZALTMA serbesttir; ARTIŞ kullanıcı onayı ister. Hesabın güvenlik tavanı üzerindeki istekler ve " +
        "birden çok kampanyanın paylaştığı bütçeler reddedilir. " +
        "DİKKAT: tavanı kendi başına aşmaya çalışma — reddedilirse kullanıcıya bildir, tekrar denemeyi bırak.",
      annotations: WRITE_DESTRUCTIVE,
      inputSchema: {
        customerId: z.string().describe("Google Ads müşteri ID"),
        campaignId: z.string().describe("Kampanya ID"),
        newDailyBudget: z.number().positive().describe("Yeni günlük bütçe (hesap para biriminde)"),
        confirm: z
          .boolean()
          .optional()
          .describe("Bütçeyi ARTIRIYORSAN zorunlu: kullanıcının açık onayını aldıysan true"),
      },
    },
    async ({ customerId, campaignId, newDailyBudget, confirm }) => {
      const ctx = getCtx();
      if (!ctx.config.writeEnabled) return writesDisabled();
      const idErr = invalidId("kampanya ID", campaignId);
      if (idErr) return text(idErr);
      const guardMsg = budgetGuardFor(ctx, newDailyBudget);
      if (guardMsg) return text(guardMsg);
      try {
        const customer = ctx.getCustomer(customerId);
        const [row]: any[] = await ctx.queryWithRetry(
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
        const oldBudget = Number(row.campaign_budget?.amount_micros) / 1e6;
        /**
         * Fail closed. A missing `amount_micros` makes oldBudget NaN, and
         * `new > NaN` is always false, which would silently skip the increase
         * approval entirely. If the current budget is unknown we cannot tell
         * whether this is an increase, so we ask.
         */
        const eskiBilinmiyor = !Number.isFinite(oldBudget);
        if (eskiBilinmiyor || newDailyBudget > oldBudget) {
          const onay = await onayAl(
            server,
            {
              eylem: `"${row.campaign.name}" kampanyasının GÜNLÜK BÜTÇESİ DEĞİŞTİRİLECEK.`,
              satirlar: [
                `Hesap: ${normalizeCustomerId(customerId)}`,
                eskiBilinmiyor
                  ? `Mevcut bütçe OKUNAMADI → Yeni: ${newDailyBudget} (güvenlik gereği onay isteniyor)`
                  : `Mevcut: ${oldBudget} → Yeni: ${newDailyBudget} (günlük artış: +${(newDailyBudget - oldBudget).toFixed(2)})`,
                `Hesap güvenlik tavanı: ${ctx.config.maxDailyBudget}`,
                `Tutarlar hesabın kendi para birimindedir.`,
              ],
              soru: "Bütçe artışını onaylıyor musun?",
              risk: "medium",
              agAyar: ctx.config,
              hesapId: normalizeCustomerId(customerId),
            },
            confirm
          );
          if (!onay.onaylandi) return text(onay.mesaj!);
        }
        await ctx.mutateWithRetry(() => customer.campaignBudgets.update([
          {
            resource_name: row.campaign_budget.resource_name,
            amount_micros: toMicrosInt(newDailyBudget),
          },
        ]));
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
      title: "Reklam grubuna kelime ekle",
      description:
        "Mevcut bir reklam grubuna anahtar kelime (ya da negative=true ile negatif kelime) ekler. " +
        "KULLAN: tek reklam grubunu kapsayan eklemeler için. " +
        "KULLANMA: negatif kelimeyi TÜM kampanyaya uygulamak istiyorsan — o add_campaign_negative_keywords'tür ve genelde doğrusu odur. " +
        "GÜVENLİK: negatif kelime harcamayı AZALTTIĞI için onay istemez; pozitif kelime canlı kampanyada onay ister.",
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
        confirm: z
          .boolean()
          .optional()
          .describe("Kampanya ZATEN YAYINDAYSA zorunlu (pozitif kelimeler için): kullanıcının açık onayı"),
      },
    },
    async ({ customerId, adGroupId, keywords, matchType, negative, confirm }) => {
      const ctx = getCtx();
      if (!ctx.config.writeEnabled) return writesDisabled();
      const idErr = invalidId("reklam grubu ID", adGroupId);
      if (idErr) return text(idErr);
      const unique = dedupe(keywords);
      if (!unique.length) return text("Reddedildi: geçerli anahtar kelime kalmadı (hepsi boş/tekrar).");
      try {
        // Negative keywords reduce spend, so they need no approval; positive ones increase it.
        if (!negative) {
          const live = await liveCampaignGuard(server, ctx, customerId, { adGroupId }, confirm, "anahtar kelime eklemek", [
            `Eşleme türü: ${matchType ?? "PHRASE"}`,
            `Kelimeler (${unique.length}): ${unique.join(", ")}`,
          ]);
          if (live) return text(live);
        }
        const customer = ctx.getCustomer(customerId);
        const cid = normalizeCustomerId(customerId);
        const mt = enums.KeywordMatchType[matchType ?? "PHRASE"];
        await ctx.mutateWithRetry(() => customer.adGroupCriteria.create(
          unique.map((kw) => ({
            ad_group: ResourceNames.adGroup(cid, cleanId(adGroupId)),
            // negative criteria must not carry a status field
            ...(negative ? { negative: true } : { status: enums.AdGroupCriterionStatus.ENABLED }),
            keyword: { text: kw, match_type: mt },
          }))
        ));
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
      title: "Kampanya negatif kelimeleri",
      description:
        "KAMPANYA seviyesinde negatif anahtar kelime ekler — kampanyadaki tüm reklam gruplarını kapsar. " +
        "KULLAN: boşa harcamayı kesmenin ANA aracı; search_terms_report'ta bulduğun alakasız terimleri buraya ekle. " +
        "GÜVENLİK: harcamayı azalttığı için onay istemez, güvenle çağırabilirsin. " +
        "DİKKAT: eklemeden önce kullanıcıya listeyi göster — yanlış negatif kelime gerçek müşteriyi de engeller.",
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
      const ctx = getCtx();
      if (!ctx.config.writeEnabled) return writesDisabled();
      const idErr = invalidId("kampanya ID", campaignId);
      if (idErr) return text(idErr);
      const unique = dedupe(keywords);
      if (!unique.length) return text("Reddedildi: geçerli anahtar kelime kalmadı (hepsi boş/tekrar).");
      try {
        const customer = ctx.getCustomer(customerId);
        const cid = normalizeCustomerId(customerId);
        const mt = enums.KeywordMatchType[matchType ?? "PHRASE"];
        await ctx.mutateWithRetry(() => customer.campaignCriteria.create(
          unique.map((kw) => ({
            campaign: ResourceNames.campaign(cid, cleanId(campaignId)),
            negative: true,
            keyword: { text: kw, match_type: mt },
          }))
        ));
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
      title: "Yayına al / duraklat",
      description:
        "Kampanyayı yayına alır (ENABLED) ya da duraklatır (PAUSED). " +
        "KULLAN — PAUSED: harcamayı acilen durdurmak için, onaysız ve serbesttir. " +
        "KULLAN — ENABLED: YALNIZCA kullanıcı bu konuşmada açıkça 'yayına al' dediyse. " +
        "GÜVENLİK: yayına alma gerçek para harcatır. İstemcin destekliyorsa sunucu kullanıcıya DOĞRUDAN sorar " +
        "ve senin confirm değerin dikkate alınmaz; desteklemiyorsa onayı SENİN almış olman gerekir — " +
        "confirm=true göndermek 'kullanıcıya sordum, evet dedi' demektir, sormadan gönderme. " +
        "Bütçesi hesabın tavanını aşan ya da yayınlanabilir reklamı olmayan kampanya yayına alınamaz.",
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
      const ctx = getCtx();
      if (!ctx.config.writeEnabled) return writesDisabled();
      const idErr = invalidId("kampanya ID", campaignId);
      if (idErr) return text(idErr);
      try {
        const customer = ctx.getCustomer(customerId);
        const cid = normalizeCustomerId(customerId);
        if (status === "ENABLED") {
          // 1) The safety ceiling also applies to the budget of a campaign being enabled.
          //    Without this gate, a campaign built elsewhere (e.g. in the Google Ads UI)
          //    could go live at many times the configured cap.
          const [row]: any[] = await ctx.queryWithRetry(
            customerId,
            `SELECT campaign.name, campaign_budget.amount_micros
             FROM campaign WHERE campaign.id = ${Number(cleanId(campaignId))}
             AND campaign.status != 'REMOVED' LIMIT 1`
          );
          if (!row) return text(`Kampanya bulunamadı: ${campaignId}`);
          const daily = Number(row.campaign_budget?.amount_micros ?? 0) / 1e6;
          const capMsg = budgetGuardFor(ctx, daily);
          if (capMsg) {
            return text(
              `Reddedildi: "${row.campaign.name}" kampanyasının günlük bütçesi ${daily} — ${capMsg}`
            );
          }
          // 2) Can it actually serve? Do not enable a campaign with no eligible ad.
          const ads = await ctx.queryWithRetry(
            customerId,
            `SELECT ad_group_ad.ad.id FROM ad_group_ad
             WHERE campaign.id = ${Number(cleanId(campaignId))}
             AND ad_group_ad.status = 'ENABLED' AND ad_group.status = 'ENABLED' LIMIT 1`
          );
          if (!ads.length) {
            return text(
              `Reddedildi: kampanya ${campaignId} içinde yayınlanabilir (ENABLED reklam grubunda ENABLED) reklam yok — yayına alınsa da gösterim yapamaz. Önce create_responsive_search_ad ile reklam ekle.`
            );
          }

          // 3) Approval. When elicitation is available the human is asked directly and the
          //    agent's own confirm flag is ignored, so consent cannot be fabricated.
          const hedefler = await ctx.queryWithRetry(
            customerId,
            `SELECT campaign_criterion.location.geo_target_constant
             FROM campaign_criterion WHERE campaign.id = ${Number(cleanId(campaignId))}
             AND campaign_criterion.type = 'LOCATION' LIMIT 20`
          );
          const onay = await onayAl(
            server,
            {
              eylem: `"${row.campaign.name}" kampanyası YAYINA ALINACAK — bu andan itibaren gerçek para harcanır.`,
              satirlar: [
                // The summary must name the account whose money is at stake: a user with
                // dozens of accounts under an MCC cannot judge the request without it.
                `Hesap: ${normalizeCustomerId(customerId)} · Kampanya: ${cleanId(campaignId)}`,
                `Günlük bütçe: ${daily} (hesabın para biriminde; Google günlük bütçenin katlarını harcayabilir)`,
                hedefler.length
                  ? `Coğrafi hedef: ${hedefler.length} konum`
                  : `⚠ COĞRAFİ HEDEF YOK — kampanya DÜNYA GENELİ yayınlanır ve bütçe alakasız trafiğe gider`,
              ],
              soru: "Kampanyayı yayına al?",
              risk: "high",
              agAyar: ctx.config,
              hesapId: normalizeCustomerId(customerId),
            },
            confirm
          );
          if (!onay.onaylandi) return text(onay.mesaj!);
        }
        await ctx.mutateWithRetry(() => customer.campaigns.update([
          {
            resource_name: ResourceNames.campaign(cid, cleanId(campaignId)),
            status: enums.CampaignStatus[status],
          },
        ]));
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
