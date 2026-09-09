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
 * expensive teaches people to route around the gate. But a decrease is only a decrease when
 * the number being compared and the number being written describe THE SAME OBJECT: on a
 * non-CBO campaign the figure that comes back is the SUM OF THE AD SETS while the write goes
 * to the campaign, so that shortcut does not apply there (see `kiyaslanamaz` below) — nor
 * where the object was never IDENTIFIED, because on a node the read could not confirm to be
 * a campaign "400 → 300" is not known to lower the spending the caller meant (see
 * `kampanyaDegilseRet`).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextProvider } from "../adsClient.js";
import { onayAl, onaySonrasiKelepce } from "../approval.js";
import { budgetGuard as budgetGuardPure, cleanId, invalidId } from "../util.js";
import {
  metaKanali,
  hataTemizle,
  belirsizSonucMu,
  type MetaHedef,
  type MetaKampanya,
} from "../meta/client.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/**
 * THE SECOND line of defence, not the first.
 *
 * The first is `belirsizSonucMu`: `metaKanali` now raises `MetaBelirsizSonuc` for a write it
 * could not read back — an aborted POST, a POST lost in transport, a create response with no
 * id — so the classification travels as a TYPE. This pattern used to be the ONLY test, which
 * chained a money-path doctrine to the exact WORDING of sentences in a neighbouring module:
 * rewriting "doğrulanamıyor" as "teyit edilemiyor" over there would have silently turned an
 * unobserved write back into "Meta işlemi başarısız" with the whole suite still green.
 *
 * It is kept anyway, for a channel injected through the test seam and for any future thrower
 * that says the words without carrying the marker. Deliberately a little broad: mistaking a
 * refusal for an uncertainty only costs a summary line, while mistaking an uncertainty for a
 * refusal is what tells the agent to retry. Both phrases sit near the START of those
 * sentences, well inside the 300-character cap `hataTemizle` applies, so the cleaning cannot
 * hide them.
 */
const BELIRSIZ_SONUC = /SONUCU BİLİNMİYOR|doğrulanam/u;

/**
 * A REFUSED call and a call whose OUTCOME IS UNKNOWN are not the same thing — and the
 * layer the agent actually reads must not flatten them into one.
 *
 * Prefixing every exception with "Meta işlemi başarısız" re-asserted precisely what the
 * client refused to assert: it told the agent nothing had happened, and the usual next move
 * is a retry — which on these paths means raising the budget a SECOND time or giving birth
 * to a second campaign. metaClient.test.ts locks this rule one layer down (an aborted write
 * may not contain the word "başarısız"); wrapping the message here undid it at the surface
 * where it matters.
 *
 * So an uncertain message is passed through UNPREFIXED — it already names itself and says
 * TEKRAR DENEME. Only a call that genuinely came back refused keeps the "başarısız"
 * summary. `isError` stays true in both cases: neither is a completed operation, and
 * lowering it would be the opposite mistake — claiming success we did not see.
 */
function err(e: any, token?: string) {
  const ham = String(e?.message ?? e);
  const temiz = hataTemizle(ham, token);
  const belirsiz = belirsizSonucMu(e) || BELIRSIZ_SONUC.test(temiz);
  return {
    content: [
      {
        type: "text" as const,
        text: belirsiz ? temiz : `Meta işlemi başarısız: ${temiz}`,
      },
    ],
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

/**
 * THE CAMPAIGN ID IS A GRAPH PATH SEGMENT, so it is clamped before it is used as one.
 *
 * `graf` interpolates this value straight into `https://graph.facebook.com/<sürüm>/<yol>`,
 * and the schema only asked for a non-empty string. So "act_.../campaigns", "me/adaccounts"
 * or a value carrying "../" was never an identifier at all: it re-aimed the read AND the
 * following write at a node the operator never named, while the approval prompt kept saying
 * "kampanya". Google's twin has clamped ids to digits from the start (util.invalidId, used
 * by every write in tools/write.ts); the Meta side simply never grew the same clamp.
 *
 * Surrounding whitespace is NORMALISED rather than refused, and the two steps may not be
 * separated: `invalidId` judges the TRIMMED value, so `cleanId` must put that same trimmed
 * value in the path. Validating " 123" and then sending it verbatim is how a value passes
 * the check and still builds a malformed path — the lesson `cleanId` exists for.
 *
 * NOT what this proves: that the node is a CAMPAIGN. Ad set ids are digits too, and the
 * fields `kampanyaOku` requests all exist on an ad set — so the ceiling would be compared
 * against that ONE set's budget. That is a separate question, answered by the read itself
 * and enforced by `kampanyaDegilseRet` below.
 */
function kampanyaKimligiHatasi(v: string): string | null {
  return invalidId("Meta kampanya kimliği", v);
}

/**
 * THE CEILING IS AN ACCOUNT-WIDE PROMISE, SO THE NODE IT IS MEASURED AGAINST MUST BE A
 * CAMPAIGN — and being made of digits does not make it one.
 *
 * The clamp above only proves the value is a path segment. An ad set id is digits as well,
 * and `id,name,status,daily_budget` all exist on an ad set, so the read used to succeed
 * against one: the account's 500 ceiling was then compared with that ONE set's 400, the POST
 * went to the ad set, and the tool answered "Meta bütçesi güncellendi". Nine sets at 400
 * each clear a 500 ceiling one at a time, and the same read feeds the go-live prompt, which
 * says "kampanyası YAYINA ALINACAK" about an object that is not a campaign. Measured, not
 * argued: before this gate, `update_meta_campaign_budget({campaignId: <ad set id>})` sent a
 * real POST.
 *
 * THIS IS AN ALLOW LIST, AND IT USED TO BE A DENY LIST — the difference is one value.
 * The condition read `if (k.dugumTuru !== "dogrulanmadi") return null`, so the only shape
 * that was refused was the channel SAYING it had failed to confirm a campaign. A channel
 * that said nothing at all — `dugumTuru` absent — was read as "campaign" and the write went
 * out. Measured: with a channel whose `kampanyaOku` omits the field,
 * `update_meta_campaign_budget({campaignId: "9998887776", dailyBudget: 400})` reached
 * `butceGuncelle` and answered "Meta bütçesi güncellendi".
 *
 * Silence is not an observation. The gate now opens only on the channel VOUCHING for what
 * it saw — `dugumTuru === "kampanya"`, which meta/client.ts sets only after `objective`, a
 * campaign-only field, actually came back on the read. Everything else, "I looked and could
 * not confirm" and "I never said", lands on the same refusal, because unknown is not
 * "campaign". This is the rule the network rings live under (a ring that observed nothing
 * cannot vouch for anything), applied to the money path.
 *
 * The absent shape is not hypothetical and not test-only: `kampanyaOlustur` in
 * meta/client.ts returns a `MetaKampanya` with no `dugumTuru` today, and the field is
 * optional on the type, so any future path that reaches this gate with a campaign object
 * built somewhere else arrives unvouched-for. That is exactly the case this now refuses.
 *
 * Nothing has been written when this fires, and it stands in front of both SPENDING paths:
 * the budget raise and the go-live. It deliberately does NOT stand in front of the PAUSE
 * branch of set_meta_campaign_status — that write is issued before any read at all, because
 * a pause STOPS spending and making it wait on a read Meta routinely fails would aim
 * fail-closed the wrong way. This gate guards the direction in which money leaves.
 *
 * IT STANDS IN FRONT OF A DECREASE TOO, AND THAT IS NOT THE CONTRADICTION IT LOOKS LIKE.
 * Measured: with `dugumTuru: "dogrulanmadi"` and a campaign-level read of 400,
 * `update_meta_campaign_budget({dailyBudget: 100})` is refused, no write leaves and no prompt
 * is shown. The refusal below names only the CEILING, and a decrease is never compared
 * against the ceiling — so read on its own that refusal looks arbitrary, and the obvious
 * "repair" is to exempt the decrease from the identity question. That would be a loosening.
 * The reason it is not exempt was the half of the sentence that had gone missing, and it is
 * written down here and in the refusal text now.
 *
 * A BUDGET WRITE ASSERTS A NUMBER ABOUT AN OBJECT; A PAUSE ASSERTS NOTHING. "Unknown is not
 * lower" is applied one function down to the NUMBER (`eskiBilinmiyor`) and to its SCALE
 * (`kiyaslanamaz`); this gate applies it to the OBJECT. On a node nobody identified, "400 →
 * 300" is not known to lower the spending the caller meant: `reklamSetiButcesi` in
 * meta/client.ts exists precisely because a campaign's real daily total can sit in several
 * sibling ad sets, so lowering ONE node's own budget leaves the siblings unread and
 * untouched while the tool reports that spending fell. That is an unknown dressed as a
 * value. So the decrease shortcut is exempt from the CEILING question it never needed, and
 * not from the IDENTITY question, which it needs exactly as much as an increase does.
 *
 * AND THE PAUSE EXCEPTION DOES NOT REACH IT. A pause writes no number, its effect is
 * complete whatever the node turns out to be, its report claims nothing beyond "durumu:
 * PAUSED", and it is issued before the read because the read is the very thing that may be
 * unavailable in the emergency a pause exists for. Here the read has already come back, and
 * refusing costs the caller one corrected id.
 */
function kampanyaDegilseRet(k: MetaKampanya, kimlik: string, token?: string): string | null {
  if (k.dugumTuru === "kampanya") return null;
  /**
   * The two refused shapes get different reasons: the channel's own note when it reported
   * one, and otherwise a sentence saying the channel never reported at all. Printing no
   * reason for the silent case would leave the operator unable to tell "the read came back
   * without `objective`" apart from "this object never went through a read".
   */
  // The note comes from upstream text, so it is cleaned again at the agent boundary.
  const sebep = k.dugumNotu
    ? hataTemizle(k.dugumNotu, token)
    : `kanal okunan düğümün türünü hiç bildirmedi — sessizlik gözlem sayılmaz`;
  return (
    `Reddedildi: ${kimlik} kimliğinin bir Meta KAMPANYASI olduğu okuma sırasında ` +
    `gözlenemedi; reklam seti ya da reklam kimliği de bu alanların hepsini döndürür ve ` +
    `hesap güvenlik tavanı kampanyanın değil tek bir setin bütçesiyle karşılaştırılırdı. ` +
    `Bu, bütçeyi DÜŞÜREN istek için de geçerlidir: tanınmayan bir düğüme yazılan sayı ` +
    `"harcama düştü" anlamına gelmez — düğüm bir reklam setiyse kampanyanın diğer setleri ` +
    `okunmadan, dokunulmadan harcamaya devam eder. ` +
    `Güvenlik gereği doğrulanmamış düğüme yazılmaz. Sebep: ${sebep}.`
  );
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
        "ister (orta risk); azaltma, okuma düğümü KAMPANYA olarak doğrularsa onay istemez. " +
        "Kampanya düzeyinde bütçesi olmayan (bütçe reklam setlerinde olan) kampanyalarda " +
        "karşılaştırılacak bir kampanya bütçesi yoktur: orada azaltma kısayolu YOKTUR, her " +
        "istek onay + ağ doğrulamasından geçer. Tavan üstü değer reddedilir. Okuma, verilen " +
        "kimliğin bir KAMPANYA olduğunu gözlemezse (reklam seti/reklam kimliği, ya da düğüm " +
        "türünü hiç bildirmeyen kanal) istek AZALTMA olsa bile reddedilir: hiçbir şey " +
        "yazılmaz, insana sorulmaz. " +
        "KULLAN: kullanıcı Meta kampanyasının günlük bütçesini yükseltmek ya da düşürmek " +
        "istediğinde. Google Ads bütçesi için update_campaign_budget kullan.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        campaignId: z.string().min(1).describe("Meta kampanya kimliği — yalnız rakam"),
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

      const kimlikHatasi = kampanyaKimligiHatasi(campaignId);
      if (kimlikHatasi) return text(kimlikHatasi);
      const kimlik = cleanId(campaignId);

      const tavanHatasi = budgetGuardPure(dailyBudget, ctx.config.maxDailyBudget);
      if (tavanHatasi) return text(tavanHatasi);

      try {
        const kanal = metaKanali(ctx.config);
        const mevcut = await kanal.kampanyaOku(kimlik);
        // Before the ceiling, before the prompt, before the write: is this even a campaign?
        const dugumHatasi = kampanyaDegilseRet(mevcut, kimlik, ctx.config.metaToken);
        if (dugumHatasi) return text(dugumHatasi);
        const eski = mevcut.gunlukButce;

        /**
         * If the current budget CANNOT BE READ it counts as an increase.
         *
         * "Unknown" and "lower" are not the same thing: assuming we are below a value we
         * could not read would be declaring something safe that we failed to measure.
         */
        const eskiBilinmiyor = eski === undefined || !Number.isFinite(eski);
        /**
         * A DECREASE IS ONLY A DECREASE WHEN BOTH NUMBERS DESCRIBE THE SAME OBJECT.
         *
         * `kampanyaOku` produces the budget from one of two places and says which one in
         * `butceKaynagi`: on a CBO campaign it is the campaign's OWN daily budget, and on a
         * non-CBO one there is no campaign-level budget at all — the figure is the SUM of the
         * ACTIVE ad sets (meta/client.ts, `reklamSetiButcesi`). The write, however, always
         * goes to the CAMPAIGN node (`butceGuncelle` → `graf(kampanyaId, {daily_budget})`).
         *
         * So "400 is below the 600 we read" was a comparison between an ad-set total and a
         * campaign-level value that had never existed — and on the strength of it the request
         * took the cheap path: no human prompt, no CAMARA chain, no decision-log line, and
         * then a campaign-level budget was written where there had been none, while the ad-set
         * budgets that made up the 600 were never what this write aimed at — and what became of
         * them was never read back. Measured before this gate: with `butceKaynagi: "reklam-setleri"`
         * and a read of 600, `update_meta_campaign_budget({dailyBudget: 400})` reached
         * `butceGuncelle` with the prompt count at zero and answered "600 → 400".
         *
         * Nothing was measured, so nothing may be assumed: this is the same rule as
         * "unknown is not lower" one line up, applied to the SCALE of the number rather than
         * to its presence. The campaign-level shortcut is deliberately left intact — a real
         * decrease stays free, because making the safe direction expensive teaches people to
         * route around the gate.
         */
        const kiyaslanamaz = mevcut.butceKaynagi === "reklam-setleri";
        if (eskiBilinmiyor || kiyaslanamaz || dailyBudget > eski!) {
          const onay = await onayAl(
            server,
            {
              eylem: `Meta: "${mevcut.ad}" kampanyasının GÜNLÜK BÜTÇESİ DEĞİŞTİRİLECEK.`,
              satirlar: [
                `Platform: Meta (Facebook/Instagram)`,
                eskiBilinmiyor
                  ? `Mevcut bütçe OKUNAMADI → Yeni: ${dailyBudget} (güvenlik gereği onay isteniyor)`
                  : kiyaslanamaz
                    ? `Okunan ${eski} rakamı REKLAM SETLERİNİN TOPLAMI; kampanya düzeyinde ` +
                      `bütçe yok. Yazma KAMPANYA düzeyine gider → Yeni: ${dailyBudget}. İki ` +
                      `farklı nesne kıyaslanamaz: bu istek azaltma sayılmıyor, güvenlik gereği ` +
                      `onay isteniyor.`
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

        await kanal.butceGuncelle(kimlik, dailyBudget);
        /**
         * "eski → yeni" IS A CLAIM ABOUT ONE OBJECT, so it is only written when both numbers
         * belong to that object. Printing "600 → 400" for a campaign whose 600 was an ad-set
         * total told the user spending had fallen — a fall nothing measured: the write aimed at
         * the campaign node, and what happened to the ad-set budgets was never read back.
         */
        if (kiyaslanamaz) {
          return text(
            `Meta bütçesi güncellendi: "${mevcut.ad}" — KAMPANYA düzeyine günlük ${dailyBudget} ` +
              `yazıldı. Önceki ${eskiBilinmiyor ? "okunamayan" : eski} rakamı REKLAM SETLERİNİN ` +
              `toplamıydı, kampanya düzeyinde bir bütçe değildi; bu yüzden bir düşüş ya da artış ` +
              `olarak bildirilemez. Reklam setlerinin bütçelerine ne olduğu bu araçtan gözlenmedi ` +
              `— Ads Manager'dan doğrula.`
          );
        }
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
        campaignId: z.string().min(1).describe("Meta kampanya kimliği — yalnız rakam"),
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

      /**
       * The clamp sits IN FRONT of the PAUSED branch too, and that does not weaken the
       * "a pause is never blocked by a read" rule below: what is refused here is not a
       * pause, it is a POST aimed at something that was never a campaign id. A malformed
       * id could not have paused the campaign in any case.
       */
      const kimlikHatasi = kampanyaKimligiHatasi(campaignId);
      if (kimlikHatasi) return text(kimlikHatasi);
      const kimlik = cleanId(campaignId);

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
          await kanal.durumDegistir(kimlik, "PAUSED");
          let ad = kimlik;
          try {
            ad = (await kanal.kampanyaOku(kimlik)).ad;
          } catch {
            /* the name is an observation, not a gate — the pause has already been applied */
          }
          return text(`Meta kampanyası "${ad}" durumu: PAUSED.`);
        }

        const mevcut = await kanal.kampanyaOku(kimlik);
        /**
         * The go-live prompt says "kampanyası YAYINA ALINACAK". That sentence is only true
         * if the node really is a campaign, and until this gate existed it was not checked:
         * the human was asked to approve a campaign go-live for an ad set id. The gate runs
         * before the ceiling AND before the prompt — an approval shown for the wrong object
         * type is worse than no approval, because it is on the record as consent.
         */
        const dugumHatasi = kampanyaDegilseRet(mevcut, kimlik, ctx.config.metaToken);
        if (dugumHatasi) return text(dugumHatasi);

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
                `Kampanya: ${mevcut.ad} (id ${kimlik})`,
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

        await kanal.durumDegistir(kimlik, status);
        return text(`Meta kampanyası "${mevcut.ad}" durumu: ${status}.`);
      } catch (e) {
        return err(e, ctx.config.metaToken);
      }
    }
  );
}
