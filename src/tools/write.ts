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

/** Bütçe kelepçesi — tavan çağıran kullanıcının context'inden. */
function budgetGuardFor(ctx: { config: { maxDailyBudget: number } }, amount: number): string | null {
  return budgetGuardPure(amount, ctx.config.maxDailyBudget);
}

/**
 * CANLI KAMPANYA KORUMASI. Yayındaki bir kampanyaya reklam/anahtar kelime
 * eklemek anında gerçek para harcatır — bu, kampanyayı yayına almakla aynı
 * ağırlıkta bir eylemdir ve aynı açık onayı gerektirir. Kampanya PAUSED ise
 * (normal taslak akışı) onay istenmez.
 * Dönen değer: engelleme mesajı ya da null (devam edilebilir).
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
  if (!rows.length) return null; // bulunamadıysa API kendi hatasını versin
  const campaignLive = String(enums.CampaignStatus[rows[0].campaign.status] ?? "") === "ENABLED";
  if (!campaignLive) return null; // taslak akışı: onay istenmez

  const onay = await onayAl(
    server,
    {
      eylem: `"${rows[0].campaign.name}" kampanyası ŞU AN YAYINDA — ${eylem} anında gerçek harcamayı etkiler.`,
      satirlar: ayrinti,
      soru: `${eylem} onaylıyor musun?`,
    },
    confirm
  );
  return onay.onaylandi ? null : onay.mesaj!;
}

// Yazma araçları: openWorld (dış API), idempotent değil.
// destructiveHint: para harcamasını/mevcut durumu değiştirenlerde true.
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
              status: enums.CampaignStatus.PAUSED, // güvenlik: asla ENABLED oluşturma
              // AB DSA gereği zorunlu beyan (canlı testte REQUIRED döndü). Bu araç
              // ticari kampanya kurar; siyasi reklam bu araçla OLUŞTURULMAZ.
              contains_eu_political_advertising:
                enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
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
      annotations: WRITE_SAFE,
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
        const oldBudget = Number(row.campaign_budget.amount_micros) / 1e6;
        // Bütçe ARTIŞI harcamayı doğrudan yükseltir → insan onayı iste.
        // Azaltma (ya da eşit) harcamayı düşürdüğü için serbesttir.
        if (newDailyBudget > oldBudget) {
          const onay = await onayAl(
            server,
            {
              eylem: `"${row.campaign.name}" kampanyasının GÜNLÜK BÜTÇESİ ARTIRILACAK.`,
              satirlar: [
                `Mevcut: ${oldBudget} → Yeni: ${newDailyBudget}`,
                `Günlük artış: +${(newDailyBudget - oldBudget).toFixed(2)}`,
                `Hesap güvenlik tavanı: ${ctx.config.maxDailyBudget}`,
              ],
              soru: "Bütçe artışını onaylıyor musun?",
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
        // Negatif kelime harcamayı AZALTIR — onay gerektirmez; pozitif kelime artırır.
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
            // negatif kriterlerde status gönderilmez
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
        "GÜVENLİK: yayına alma gerçek para harcatır; sunucu kullanıcıya doğrudan sorar ve onay alınmadan uygulamaz. " +
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
          // 1) Yayına alınacak kampanyanın bütçesi de güvenlik tavanına tabidir.
          //    (Kullanıcının arayüzde kurduğu 10.000 TL'lik kampanya bu kapı
          //    olmadan tavanın kat kat üstünde yayına girebiliyordu.)
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
          // 2) Gösterim yapabilecek durumda mı? (yayınlanamayan reklam kapıyı geçmesin)
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

          // 3) ONAY — elicitation varsa doğrudan İNSANA sorulur; ajanın
          //    confirm'ü o durumda dikkate alınmaz (sahte onay üretilemesin).
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
                `Günlük bütçe: ${daily}`,
                `Coğrafi hedef sayısı: ${hedefler.length || "belirtilmemiş"}`,
                `Kampanya ID: ${cleanId(campaignId)}`,
              ],
              soru: "Kampanyayı yayına al?",
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
