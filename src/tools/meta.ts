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
 * Yapılandırma eksikse araç ÇALIŞMAZ — ve bunu harcamadan ÖNCE söyler.
 *
 * Eksik yapılandırmayı çağrı anında sessizce "yapacak bir şey yok" saymak, ajana
 * "Meta tarafı kapalı" yerine "Meta tarafı sorunsuz" izlenimi verirdi.
 */
function yapilandirmaEksik(ayar: { metaToken?: string; metaAdAccountId?: string }): string | null {
  if (!ayar.metaToken) {
    return (
      "Meta araçları yapılandırılmamış: ADSPILOT_META_TOKEN tanımlı değil. " +
      "Hesap sahibi tanımlamadan Meta tarafında hiçbir işlem yapılamaz."
    );
  }
  if (!ayar.metaAdAccountId) {
    return (
      "Meta yapılandırması eksik: ADSPILOT_META_TOKEN var ama ADSPILOT_META_AD_ACCOUNT_ID boş. " +
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
         * Mevcut bütçe OKUNAMADIYSA artış sayılır.
         *
         * "Bilinmiyor" ile "düşük" aynı şey değildir: okunamayan bir değerin altında
         * kaldığımızı varsaymak, ölçemediğimiz bir şeyi güvenli ilan etmek olurdu.
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
               * REKLAM HESABI KİMLİĞİ YALNIZ İNSANA GÖSTERİLİR.
               *
               * Bu değer ajanın gönderdiği bir argüman değil, SUNUCU TARAFI
               * yapılandırmadır (META_AD_ACCOUNT_ID): ajan onu hiç bilmez ve bilmesi de
               * gerekmez. Oysa `satirlar` elicitation'sız istemcide ret metniyle birlikte
               * ajana dönüyordu — yani her reddedilen bütçe denemesi hesap kimliğini model
               * bağlamına ve transkriptlere yazıyordu. Karar veren insanın parasını hangi
               * hesaptan harcayacağını görmesi ise şarttır; bu yüzden satır silinmedi,
               * KANAL DEĞİŞTİRDİ.
               */
              insanSatirlari: [`Reklam hesabı: ${ctx.config.metaAdAccountId}`],
              soru: "Meta bütçe artışını onaylıyor musun?",
              risk: "medium",
              agAyar: ctx.config,
              hesapId: ctx.config.metaAdAccountId,
              /**
               * Riskteki tutar YENİ bütçedir: karar verilirse günlük harcamanın çıkacağı
               * tavan budur ve çağıranın kendi girdisi olduğu için eski bütçe okunamamış
               * olsa bile bilinir (Google tarafındaki update_campaign_budget ile aynı kural).
               */
              tutar: dailyBudget,
            },
            confirm
          );
          if (!onay.onaylandi) return text(onay.mesaj!);
          // Onay penceresi boyunca kelepçe değişmiş olabilir (bkz. onaySonrasiKelepce).
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
        const mevcut = await kanal.kampanyaOku(campaignId);

        // Duraklatma harcamayı DÜŞÜRÜR: onay istenmez (Google tarafıyla aynı kural).
        if (status === "ACTIVE") {
          /**
           * BÜTÇE TAVANI YAYINA ALMADA DA GEÇERLİ — ve bu, bütçeyi bu araç
           * belirlemediği için atlanması en kolay yerdir.
           *
           * Kampanya başka bir yerde (Meta Ads Manager'da elle) kurulmuş olabilir ve
           * bizim hiç görmediğimiz bir günlük bütçe taşıyabilir. Tavan yalnız BİZİM
           * yazdığımız bütçelere uygulanırsa, hesap sahibinin koyduğu kelepçe "AdsPilot
           * üzerinden kurulan kampanyalar" kelepçesine dönüşür — oysa vaat harcamanın
           * kendisi üzerine. Google tarafındaki ikizi bunu zaten yapıyor
           * (tools/write.ts, set_campaign_status ENABLED dalı); burada eksikti.
           *
           * OKUNAMAYAN BÜTÇE DE RET: tavanı doğrulayamıyorsak tavanın altında
           * olduğunu varsayamayız. Bu, dosyanın birkaç fonksiyon yukarıdaki
           * "bilinmiyor ile düşük aynı şey değildir" kuralının aynısıdır.
           */
          const gunluk = mevcut.gunlukButce;
          if (gunluk === undefined || !Number.isFinite(gunluk)) {
            /**
             * SEBEP TAHMİN EDİLMEZ, İSTEMCİDEN GELİR. Okuma artık iki katmanlı (kampanya
             * düzeyi CBO, yoksa reklam setleri toplamı), dolayısıyla "okunamadı" birden
             * çok farklı duruma karşılık gelir: sayfa taşması, ömürlük bütçe, ACTIVE set
             * bulunmaması, biçimsiz yanıt. Operatöre hangisi olduğunu söylemeyen bir ret,
             * onu neyi düzelteceğini bilmeden bırakır.
             */
            return text(
              `Reddedildi: "${mevcut.ad}" kampanyasının günlük bütçesi doğrulanamadı, ` +
                `dolayısıyla hesap güvenlik tavanına (${ctx.config.maxDailyBudget}) uyup uymadığı ` +
                `bilinmiyor. Güvenlik gereği doğrulanamayan bütçeyle yayına alınmaz.` +
                // Sebep AJANIN gördüğü metne giriyor; sınırda ikinci kez temizlenir
                // (jeton maskesi + 300 karakter tavanı). İstemci tarafı da temizliyor:
                // bu, tek bir çıkışın atlanmasıyla sınırın delinmemesi içindir.
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
               * REKLAM HESABI KİMLİĞİ YALNIZ İNSANA GÖSTERİLİR.
               *
               * Bu değer ajanın gönderdiği bir argüman değil, SUNUCU TARAFI
               * yapılandırmadır (META_AD_ACCOUNT_ID): ajan onu hiç bilmez ve bilmesi de
               * gerekmez. Oysa `satirlar` elicitation'sız istemcide ret metniyle birlikte
               * ajana dönüyordu — yani her reddedilen bütçe denemesi hesap kimliğini model
               * bağlamına ve transkriptlere yazıyordu. Karar veren insanın parasını hangi
               * hesaptan harcayacağını görmesi ise şarttır; bu yüzden satır silinmedi,
               * KANAL DEĞİŞTİRDİ.
               */
              insanSatirlari: [`Reklam hesabı: ${ctx.config.metaAdAccountId}`],
              soru: "Meta kampanyasını yayına almayı onaylıyor musun?",
              risk: "high",
              agAyar: ctx.config,
              hesapId: ctx.config.metaAdAccountId,
              /**
               * Riskteki tutar kampanyanın günlük bütçesidir — ama YALNIZ okunabildiyse.
               * Meta okuması bütçeyi vermediğinde (yukarıdaki "OKUNAMADI" satırı) alan
               * hiç yazılmaz: kayıtta 0 görmek, denetçiye ortada para yokmuş gibi görünürdü.
               */
              // Buraya gelindiyse bütçe okunmuş ve sonludur: yukarıdaki kapı aksini eler.
              tutar: gunluk,
            },
            confirm
          );
          if (!onay.onaylandi) return text(onay.mesaj!);
          // Onay penceresi boyunca kelepçe değişmiş olabilir (bkz. onaySonrasiKelepce).
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
