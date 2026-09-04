// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Meta write tools — the same money path, a different platform.
 *
 * Every guard here is the one the Google Ads tools use, called from the same place:
 * `onayAl` with the same risk tiers, so the CAMARA chain runs before the human prompt on
 * Meta exactly as it does on Google. Nothing about the gate is Google-shaped, and this
 * file is where that stops being an assertion.
 *
 * The three invariants, unchanged across platforms:
 *   - campaigns are created PAUSED, and the tool cannot be asked to do otherwise;
 *   - a budget INCREASE is `medium` risk, a go-live is `high`;
 *   - the account's daily ceiling applies before anything reaches the network.
 *
 * A decrease still needs no approval — it lowers spend, and making the safe direction
 * expensive teaches people to route around the gate.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextProvider } from "../adsClient.js";
import { onayAl, onaySonrasiKelepce } from "../approval.js";
import { budgetGuard as budgetGuardPure } from "../util.js";
import { metaKanali, hataTemizle, type MetaHedef } from "../meta/client.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function err(e: any, token?: string) {
  const ham = String(e?.message ?? e);
  return {
    content: [{ type: "text" as const, text: `Meta işlemi başarısız: ${hataTemizle(ham, token)}` }],
    isError: true,
  };
}

const HEDEFLER = [
  "OUTCOME_TRAFFIC",
  "OUTCOME_SALES",
  "OUTCOME_LEADS",
  "OUTCOME_AWARENESS",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_APP_PROMOTION",
] as const;

/**
 * With configuration missing the tool DOES NOT RUN — and it says so BEFORE any spending.
 *
 * Treating missing configuration as a quiet "there is nothing to do" at call time would give
 * the agent the impression that "the Meta side is fine" rather than "the Meta side is
 * switched off".
 */
function yapilandirmaEksik(ayar: { metaToken?: string; metaAdAccountId?: string }): string | null {
  if (!ayar.metaToken) {
    return (
      "Meta araçları yapılandırılmamış: AEGIS_META_TOKEN tanımlı değil. " +
      "Hesap sahibi tanımlamadan Meta tarafında hiçbir işlem yapılamaz."
    );
  }
  if (!ayar.metaAdAccountId) {
    return (
      "Meta yapılandırması eksik: AEGIS_META_TOKEN var ama AEGIS_META_AD_ACCOUNT_ID boş. " +
      "Hangi reklam hesabında çalışılacağı belirsizken işlem yapılmaz (kapalı arıza)."
    );
  }
  return null;
}

export function registerMetaTools(server: McpServer, getCtx: ContextProvider): void {
  server.registerTool(
    "create_meta_campaign",
    {
      title: "Meta kampanyası oluştur (DURAKLATILMIŞ)",
      description:
        "Meta (Facebook/Instagram) tarafında kampanya oluşturur. Kampanya HER ZAMAN " +
        "DURAKLATILMIŞ doğar; yayına almak ayrı bir araçtır ve insan onayı + ağ doğrulaması ister. " +
        "Günlük bütçe hesabın güvenlik tavanını aşamaz. " +
        "KULLAN: kullanıcı Meta/Facebook/Instagram tarafında YENİ bir kampanya kurmak istediğinde. " +
        "Google Ads için create_search_campaign kullan — bu araç yalnız Meta içindir.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        name: z.string().min(1).max(400).describe("Kampanya adı"),
        objective: z.enum(HEDEFLER).describe("Meta kampanya hedefi"),
        dailyBudget: z.number().positive().describe("Günlük bütçe (hesabın para biriminde)"),
      },
    },
    async ({ name, objective, dailyBudget }) => {
      const ctx = getCtx();
      if (!ctx.config.writeEnabled) {
        return text("Yazma araçları bu hesap için devre dışı. Yalnız hesap sahibi açabilir.");
      }
      const eksik = yapilandirmaEksik(ctx.config);
      if (eksik) return text(eksik);

      const tavanHatasi = budgetGuardPure(dailyBudget, ctx.config.maxDailyBudget);
      if (tavanHatasi) return text(tavanHatasi);

      try {
        const kanal = metaKanali(ctx.config);
        const k = await kanal.kampanyaOlustur({
          ad: name,
          hedef: objective as MetaHedef,
          gunlukButce: dailyBudget,
        });
        return text(
          `Meta kampanyası oluşturuldu: "${k.ad}" (id ${k.id}) — durum DURAKLATILMIŞ, ` +
            `günlük bütçe ${dailyBudget}. Yayına almak için set_meta_campaign_status kullan; ` +
            `o araç insan onayı ve ağ doğrulaması ister.`
        );
      } catch (e) {
        return err(e, ctx.config.metaToken);
      }
    }
  );

  server.registerTool(
    "update_meta_campaign_budget",
    {
      title: "Meta kampanya bütçesini değiştir",
      description:
        "Meta kampanyasının günlük bütçesini değiştirir. ARTIŞ insan onayı ve ağ doğrulaması " +
        "ister (orta risk); azaltma onay istemez. Tavan üstü değer reddedilir. " +
        "KULLAN: kullanıcı Meta kampanyasının günlük bütçesini yükseltmek ya da düşürmek " +
        "istediğinde. Google Ads bütçesi için update_campaign_budget kullan.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        campaignId: z.string().min(1).describe("Meta kampanya kimliği"),
        dailyBudget: z.number().positive().describe("Yeni günlük bütçe"),
        confirm: z.boolean().optional().describe("Elicitation desteklemeyen istemciler için"),
      },
    },
    async ({ campaignId, dailyBudget, confirm }) => {
      const ctx = getCtx();
      if (!ctx.config.writeEnabled) {
        return text("Yazma araçları bu hesap için devre dışı. Yalnız hesap sahibi açabilir.");
      }
      const eksik = yapilandirmaEksik(ctx.config);
      if (eksik) return text(eksik);

      const tavanHatasi = budgetGuardPure(dailyBudget, ctx.config.maxDailyBudget);
      if (tavanHatasi) return text(tavanHatasi);

      try {
        const kanal = metaKanali(ctx.config);
        const mevcut = await kanal.kampanyaOku(campaignId);
        const eski = mevcut.gunlukButce;

        /**
         * If the current budget CANNOT BE READ it counts as an increase.
         *
         * "Unknown" and "lower" are not the same thing: assuming we are below a value we
         * could not read would be declaring something safe that we failed to measure.
         */
        const eskiBilinmiyor = eski === undefined || !Number.isFinite(eski);
        if (eskiBilinmiyor || dailyBudget > eski!) {
          const onay = await onayAl(
            server,
            {
              eylem: `Meta: "${mevcut.ad}" kampanyasının GÜNLÜK BÜTÇESİ DEĞİŞTİRİLECEK.`,
              satirlar: [
                `Platform: Meta (Facebook/Instagram)`,
                eskiBilinmiyor
                  ? `Mevcut bütçe OKUNAMADI → Yeni: ${dailyBudget} (güvenlik gereği onay isteniyor)`
                  : `Mevcut: ${eski} → Yeni: ${dailyBudget} (günlük artış: +${(dailyBudget - eski!).toFixed(2)})`,
                `Hesap güvenlik tavanı: ${ctx.config.maxDailyBudget}`,
              ],
              /**
               * THE AD ACCOUNT ID IS SHOWN TO THE HUMAN ONLY.
               *
               * This value is not an argument the agent sent but SERVER-SIDE configuration
               * (META_AD_ACCOUNT_ID): the agent never knows it and has no need to. Yet
               * `satirlar` came back to the agent together with the refusal on a client
               * without elicitation — so every refused budget attempt wrote the account ID
               * into the model's context and from there into transcripts. The human making
               * the decision, on the other hand, must see which account the money comes
               * from; so the line was not deleted, it CHANGED CHANNEL.
               */
              insanSatirlari: [`Reklam hesabı: ${ctx.config.metaAdAccountId}`],
              soru: "Meta bütçe artışını onaylıyor musun?",
              risk: "medium",
              agAyar: ctx.config,
              hesapId: ctx.config.metaAdAccountId,
              /**
               * The amount at risk is the NEW budget: it is the ceiling daily spending
               * will rise to if the decision is made, and because it is the caller's own
               * input it is known even when the old budget could not be read — the same
               * rule as update_campaign_budget on the Google side.
               */
              tutar: dailyBudget,
            },
            confirm
          );
          if (!onay.onaylandi) return text(onay.mesaj!);
          // The clamp may have moved while the prompt was open (see onaySonrasiKelepce).
          const bayat = onaySonrasiKelepce(getCtx().config, dailyBudget);
          if (bayat) return text(bayat);
        }

        await kanal.butceGuncelle(campaignId, dailyBudget);
        return text(
          `Meta bütçesi güncellendi: "${mevcut.ad}" — ${eskiBilinmiyor ? "?" : eski} → ${dailyBudget} (günlük).`
        );
      } catch (e) {
        return err(e, ctx.config.metaToken);
      }
    }
  );

  server.registerTool(
    "set_meta_campaign_status",
    {
      title: "Meta kampanyasını yayına al / duraklat",
      description:
        "Meta kampanyasını ACTIVE ya da PAUSED yapar. YAYINA ALMA (ACTIVE) yüksek risklidir: " +
        "insan onayı ve ağ doğrulama zincirinin tamamını ister. Duraklatma onay istemez. " +
        "KULLAN: kullanıcı Meta kampanyasını yayına almak ya da durdurmak istediğinde. " +
        "Google Ads durumu için set_campaign_status kullan.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        campaignId: z.string().min(1).describe("Meta kampanya kimliği"),
        status: z.enum(["ACTIVE", "PAUSED"]).describe("Yeni durum"),
        confirm: z.boolean().optional().describe("Elicitation desteklemeyen istemciler için"),
      },
    },
    async ({ campaignId, status, confirm }) => {
      const ctx = getCtx();
      if (!ctx.config.writeEnabled) {
        return text("Yazma araçları bu hesap için devre dışı. Yalnız hesap sahibi açabilir.");
      }
      const eksik = yapilandirmaEksik(ctx.config);
      if (eksik) return text(eksik);

      try {
        const kanal = metaKanali(ctx.config);

        /**
         * PAUSING DEPENDS ON NO READ AT ALL — fail-closed runs the other way round here.
         *
         * The read sat IN FRONT of the gate and was unconditional. Meta returns 500s and #17
         * rate limits routinely, and a GET can exceed fifteen seconds; when `kampanyaOku`
         * threw at that moment the tool came back with isError and the pause POST was NEVER
         * attempted. So the user watching a campaign burn money and saying "stop it now" was
         * left with the campaign live because of an unrelated read failure — and an agent
         * that sees an error usually backs off.
         *
         * Fail-closed means "do not" for a spending INCREASE; for the operation that STOPS
         * spending the safe direction is "DO". The campaign name is only an observation
         * here: it decorates the message and decides nothing, so failing to read it cannot
         * prevent the pause. The Google twin already worked this way (tools/write.ts: every
         * read sits inside the ENABLED branch).
         */
        if (status === "PAUSED") {
          await kanal.durumDegistir(campaignId, "PAUSED");
          let ad = campaignId;
          try {
            ad = (await kanal.kampanyaOku(campaignId)).ad;
          } catch {
            /* the name is an observation, not a gate — the pause has already been applied */
          }
          return text(`Meta kampanyası "${ad}" durumu: PAUSED.`);
        }

        const mevcut = await kanal.kampanyaOku(campaignId);

        {
          /**
           * THE BUDGET CEILING APPLIES TO GOING LIVE TOO — and because this tool does not
           * set the budget, this is the easiest place to skip it.
           *
           * The campaign may have been created somewhere else, by hand in Meta Ads Manager,
           * and may carry a daily budget we have never seen. If the ceiling applies only to
           * budgets WE wrote, the clamp the account owner set becomes a clamp on "campaigns
           * created through Aegis" — while the promise was about the spending itself. The
           * Google twin already does this (tools/write.ts, the ENABLED branch of
           * set_campaign_status); it was missing here.
           *
           * AN UNREADABLE BUDGET IS REFUSED TOO: if we cannot verify the ceiling we cannot
           * assume we are under it. This is the same rule as "unknown is not the same as
           * lower", a few functions above.
           */
          const gunluk = mevcut.gunlukButce;
          if (gunluk === undefined || !Number.isFinite(gunluk)) {
            /**
             * THE REASON IS NOT GUESSED, IT COMES FROM THE CLIENT. The read is now
             * two-layered (campaign-level CBO, and failing that the sum of the ad sets), so
             * "could not be read" corresponds to several different situations: page
             * overflow, a lifetime budget, an ACTIVE set
             * not being present, a malformed response. A refusal that does not tell the
             * operator which one it was leaves them without knowing what to fix.
             */
            return text(
              `Reddedildi: "${mevcut.ad}" kampanyasının günlük bütçesi doğrulanamadı, ` +
                `dolayısıyla hesap güvenlik tavanına (${ctx.config.maxDailyBudget}) uyup uymadığı ` +
                `bilinmiyor. Güvenlik gereği doğrulanamayan bütçeyle yayına alınmaz.` +
                // The reason enters text the AGENT sees, so it is cleaned a second time at
                // the boundary (token masking plus a 300-character cap). The client side
                // cleans it too: that way missing a single exit does not breach the
                // boundary.
                (mevcut.butceNotu ? ` Sebep: ${hataTemizle(mevcut.butceNotu, ctx.config.metaToken)}.` : "")
            );
          }
          const tavanHatasiYayin = budgetGuardPure(gunluk, ctx.config.maxDailyBudget);
          if (tavanHatasiYayin) {
            return text(
              `Reddedildi: "${mevcut.ad}" kampanyasının günlük bütçesi ${gunluk} — ${tavanHatasiYayin}`
            );
          }

          const onay = await onayAl(
            server,
            {
              eylem: `Meta: "${mevcut.ad}" kampanyası YAYINA ALINACAK — gerçek harcama başlar.`,
              satirlar: [
                `Platform: Meta (Facebook/Instagram)`,
                `Kampanya: ${mevcut.ad} (id ${campaignId})`,
                gunluk === undefined
                  ? `Günlük bütçe OKUNAMADI — yayına alma yine de gerçek harcama başlatır`
                  : `Günlük bütçe: ${mevcut.gunlukButce}` +
                    (mevcut.butceKaynagi === "reklam-setleri"
                      ? " (reklam setlerinin toplamı — Ads Manager'da kampanyada tek bir sayı olarak görünmez)"
                      : ""),
              ],
              /**
               * THE AD ACCOUNT ID IS SHOWN TO THE HUMAN ONLY.
               *
               * This value is not an argument the agent sent but SERVER-SIDE configuration
               * (META_AD_ACCOUNT_ID): the agent never knows it and has no need to. Yet
               * `satirlar` came back to the agent together with the refusal on a client
               * without elicitation — so every refused budget attempt wrote the account ID
               * into the model's context and from there into transcripts. The human making
               * the decision, on the other hand, must see which account the money comes
               * from; so the line was not deleted, it CHANGED CHANNEL.
               */
              insanSatirlari: [`Reklam hesabı: ${ctx.config.metaAdAccountId}`],
              soru: "Meta kampanyasını yayına almayı onaylıyor musun?",
              risk: "high",
              agAyar: ctx.config,
              hesapId: ctx.config.metaAdAccountId,
              /**
               * The amount at risk is the campaign's daily budget — but ONLY when it could
               * be read. When the Meta read does not yield a budget (the "OKUNAMADI" line
               * above) the field is not written at all: seeing 0 in the record would look to
               * an auditor as though no money were involved.
               */
              // Reaching this point means the budget was read and is finite: the gate above
              // eliminates anything else.
              tutar: gunluk,
            },
            confirm
          );
          if (!onay.onaylandi) return text(onay.mesaj!);
          // The clamp may have moved while the prompt was open (see onaySonrasiKelepce).
          const bayat = onaySonrasiKelepce(getCtx().config, gunluk);
          if (bayat) return text(bayat);
        }

        await kanal.durumDegistir(campaignId, status);
        return text(`Meta kampanyası "${mevcut.ad}" durumu: ${status}.`);
      } catch (e) {
        return err(e, ctx.config.metaToken);
      }
    }
  );
}
