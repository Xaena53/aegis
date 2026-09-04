// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Read-only reporting tools.
 *
 * Each tool returns both a human-readable summary and typed structured output, so the
 * agent never has to parse numbers out of prose.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatAdsError, type ContextProvider } from "../adsClient.js";
import { enums } from "google-ads-api";
import { dateRange, ensureGaqlLimit, mikrodanTutar, sayiOku, sayiMetni } from "../util.js";

/**
 * Carries only the fields that could GENUINELY be read into the JSON.
 *
 * Leaving an unreadable field as `undefined` is not enough: even though JSON.stringify drops
 * it, "the field exists but is empty" and "the field is absent" are different things to
 * schema validation and to whoever reads the output. Not writing the field at all is this
 * repository's rule — "unknown is never recorded as 0" — as it applies on the read
 * surfaces.
 */
function tanimliAlanlar<T extends Record<string, number | undefined>>(alanlar: T): Partial<T> {
  return Object.fromEntries(Object.entries(alanlar).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Dual output: a human-readable summary plus typed structured data.
 *
 * The agent never has to parse numbers out of prose — amounts arrive already divided
 * out of micros, enums as names, rates as numbers.
 */
function ikili(ozet: string, veri: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: ozet }], structuredContent: veri };
}

/**
 * Invalid-input response. `isError: true` is mandatory: for a tool that declares an
 * outputSchema, the SDK expects structuredContent on every non-error response and
 * throws a protocol error without it. Invalid input is semantically an error anyway.
 */
function girdiHatasi(mesaj: string) {
  return { content: [{ type: "text" as const, text: mesaj }], isError: true };
}

function err(e: unknown) {
  return { content: [{ type: "text" as const, text: formatAdsError(e) }], isError: true };
}

const READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true };

// ── Output schemas: what the agent reads type-safely ─────────────────────
const HESAP_SEMASI = {
  tamListeMi: z
    .boolean()
    .describe("false ise liste EKSİK: hesapların bir kısmı kırpıldı ya da okunamadı — 'yok' sonucuna varma"),
  eksikNot: z.string().optional().describe("Liste eksikse nedeni; tamsa hiç yazılmaz"),
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
        erisilemedi: z
          .boolean()
          .optional()
          .describe("Detayları okunamadı: yönetici mi değil mi BİLİNMİYOR, kampanya için kullanma"),
        altHesapKesildi: z
          .boolean()
          .optional()
          .describe("Bu MCC'nin alt hesap listesi tavana takıldı: burada GÖRÜNMEYEN alt hesaplar var"),
      })
    )
    .describe("Erişilebilir hesaplar (MCC alt hesapları dahil)"),
};

/**
 * AN UNREADABLE VALUE DROPS ITS FIELD — which is why every money and metric field is
 * optional.
 *
 * This used to be `Number(x ?? 0)`: when the field never arrived, arrived as null, or
 * arrived as an empty string, the report said "0.00". An agent reading "daily budget 0.00"
 * for a LIVE campaign goes to the diagnosis "nothing is being spent, raise the budget" — and
 * no error appears anywhere. Unknown and zero are not the same thing: when a value cannot be
 * read the field is not written to the JSON at all, and the text prints "OKUNAMADI"
 * (unreadable). If the schema were not optional, MCP's output validation would drop the
 * entire report — one broken row would make 500 campaigns invisible.
 */
const OLCUM_NOTU = "Değer okunamadıysa bu alan HİÇ YAZILMAZ — yokluğu 'bilinmiyor' demektir, 0 demek değildir";

const KAMPANYA_SEMASI = {
  pencereGun: z.number(),
  kesildi: z.boolean().describe("true ise liste satır tavanına takıldı: rapor edilmeyen kampanyalar var"),
  satirTavani: z.number().describe("Tek çağrıda dönebilecek en fazla satır"),
  kampanyalar: z.array(
    z.object({
      id: z.string(),
      ad: z.string(),
      durum: z.string(),
      kanal: z.string(),
      gunlukButce: z.number().optional().describe(OLCUM_NOTU),
      maliyet: z.number().optional().describe(OLCUM_NOTU),
      tiklama: z.number().optional().describe(OLCUM_NOTU),
      gosterim: z.number().optional().describe(OLCUM_NOTU),
      donusum: z.number().optional().describe(OLCUM_NOTU),
      ctrYuzde: z.number().optional().describe(OLCUM_NOTU),
      ortTbm: z.number().optional().describe(OLCUM_NOTU),
      okunamayanAlanlar: z
        .array(z.string())
        .optional()
        .describe("Bu satırda okunamayan alanların adları — varsa kampanya hakkında sayısal sonuç çıkarma"),
    })
  ),
};

const KELIME_SEMASI = {
  pencereGun: z.number(),
  kesildi: z.boolean().describe("true ise liste satır tavanına takıldı: rapor edilmeyen kelimeler var"),
  satirTavani: z.number().describe("Tek çağrıda dönebilecek en fazla satır"),
  kelimeler: z.array(
    z.object({
      kelime: z.string(),
      eslemeTuru: z.string(),
      kampanya: z.string(),
      reklamGrubu: z.string(),
      maliyet: z.number().optional().describe(OLCUM_NOTU),
      tiklama: z.number().optional().describe(OLCUM_NOTU),
      donusum: z.number().optional().describe(OLCUM_NOTU),
      okunamayanAlanlar: z
        .array(z.string())
        .optional()
        .describe("Bu satırda okunamayan alanların adları — varsa kelime hakkında sayısal sonuç çıkarma"),
    })
  ),
};

const ARAMA_TERIMI_SEMASI = {
  pencereGun: z.number(),
  kesildi: z.boolean().describe("true ise yalnız en pahalı N terim döndü: toplamlar hesabın tamamı DEĞİL"),
  satirTavani: z.number().describe("Tek çağrıda dönebilecek en fazla satır"),
  toplamMaliyet: z
    .number()
    .describe("ÖLÇÜLEBİLEN satırların maliyet toplamı — kesildi=true ise hesabın toplamı değildir"),
  israfMaliyet: z.number().describe("Dönüşüm getirmeyen ÖLÇÜLEBİLEN terimlerin toplam maliyeti"),
  /**
   * Rows that could not be measured are counted in a SEPARATE bucket and do not enter the
   * totals. Marking a term whose cost or conversions could not be read as a "waste
   * candidate" by treating it as 0/0 was wrong in both directions: a term that was
   * converting got suggested as a negative keyword, while genuine waste fell off the list.
   * The count is announced here so the agent knows which base it is talking about.
   */
  olculemeyenSatir: z
    .number()
    .optional()
    .describe("Maliyeti/dönüşümü OKUNAMADIĞI için toplamlara ve israf değerlendirmesine alınmayan terim sayısı"),
  /**
   * When the list is truncated, or when some rows could not be measured, no ratio is
   * PRODUCED — and 0 is not written either. A percentage computed from a cut or incomplete
   * list was being read as the account's real waste rate: on an account with 44% waste the
   * tool could say 10%, and the agent concluded "no serious waste here".
   */
  israfYuzde: z
    .number()
    .optional()
    .describe(
      "Yalnız liste TAM ve her satır ÖLÇÜLEBİLİR iken yazılır; yoksa oran bilinmiyor demektir ve hiç yazılmaz"
    ),
  terimler: z.array(
    z.object({
      terim: z.string(),
      kampanyaId: z.string().describe("add_campaign_negative_keywords için gereken kimlik"),
      kampanya: z.string(),
      reklamGrubu: z.string(),
      reklamGrubuId: z.string(),
      maliyet: z.number().optional().describe(OLCUM_NOTU),
      tiklama: z.number().optional().describe(OLCUM_NOTU),
      donusum: z.number().optional().describe(OLCUM_NOTU),
      israfAdayi: z
        .boolean()
        .describe("Tıklama aldı ama dönüşüm getirmedi — YALNIZ maliyet VE dönüşüm okunabildiyse true olabilir"),
      olculemedi: z
        .boolean()
        .optional()
        .describe("true ise maliyet/dönüşüm okunamadı: bu terim israf açısından DEĞERLENDİRİLMEDİ"),
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
        "DİKKAT: MCC (yönetici) hesabında kampanya OLUŞTURULAMAZ — 'reklam hesabı' olanı seç. " +
        "erisilemedi=true olan hesabı SEÇME: detayları okunamadı, yönetici olup olmadığı bilinmiyor.",
      annotations: READ_ANNOTATIONS,
      outputSchema: HESAP_SEMASI,
    },
    async () => {
      try {
        const ctx = getCtx();
        const UST_TAVAN = 30;
        const ALT_TAVAN = 50;
        const ids = await ctx.listAccessibleCustomers();
        if (!ids.length)
          return ikili("Erişilebilir Google Ads hesabı bulunamadı.", { hesaplar: [], tamListeMi: true });

        type Hesap = {
          id: string;
          ad: string;
          paraBirimi?: string;
          yonetici: boolean;
          testHesabi?: boolean;
          durum?: string;
          ustHesap?: string;
          erisilemedi?: boolean;
          altHesapKesildi?: boolean;
        };
        const hesaplar: Hesap[] = [];
        /**
         * The same account can arrive by more than one route: through the
         * listAccessibleCustomers list, and as a descendant of a manager account. Once the
         * `customer_client.level = 1` filter was removed, that wrote sub-managers AND the
         * real ad accounts beneath them into the table TWICE. The secondary damage: the
         * duplicates ate into the ALT_TAVAN quota and could turn a list that actually fitted
         * into a false alarm reading "there are child accounts you cannot see".
         * adsClient.hesaplariTopla applies the same protection with a `gorulen` Set; here a
         * Map is used because the row itself has to be reachable.
         */
        const gorulenler = new Map<string, Hesap>();
        const okunamayan: string[] = [];
        const altHesabiKesilen: string[] = [];
        const ustKesildi = ids.length > UST_TAVAN;

        for (const id of ids.slice(0, UST_TAVAN)) {
          try {
            const [row] = await ctx.queryWithRetry(
              id,
              `SELECT customer.descriptive_name, customer.currency_code, customer.manager FROM customer LIMIT 1`
            );
            const c: any = row?.customer ?? {};
            // A reference to the row is KEPT: if the child-truncation flag were written on
            // the assumption of "the last element of the list", the warning would attach to
            // the wrong account the moment another push slipped in between. If the account
            // was already listed as a manager's descendant the ROW IS NOT REPEATED; the
            // existing row is reused, so the truncation flag lands on the right one.
            let ustSatir = gorulenler.get(id);
            if (!ustSatir) {
              ustSatir = {
                id,
                ad: String(c.descriptive_name ?? "(isimsiz)"),
                paraBirimi: c.currency_code ? String(c.currency_code) : undefined,
                yonetici: Boolean(c.manager),
              };
              hesaplar.push(ustSatir);
              gorulenler.set(id, ustSatir);
            }
            // For an MCC, also list its child accounts — listAccessibleCustomers omits them
            if (c.manager) {
              // No status filter, deliberately: test accounts can report a status other
              // than ENABLED and such a filter would hide them.
              /**
               * `customer_client.level = 1` was REMOVED: that clause returned only DIRECT
               * children, and in a two-tier agency manager account the real ad accounts —
               * the children of the sub-managers — did NOT appear in the list at all. The
               * tool said "all accounts" while the agent said "you have no reachable
               * accounts".
               *
               * LIMIT is cap+2: if exactly cap rows come back it is IMPOSSIBLE to tell
               * whether the list was truncated, so one row is a truncation probe — and one
               * is for the manager's OWN row, since a customer_client query returns the
               * manager at level 0 as well.
               */
              const children: any[] = await ctx.queryWithRetry(
                id,
                `SELECT customer_client.id, customer_client.descriptive_name,
                        customer_client.currency_code, customer_client.manager,
                        customer_client.status, customer_client.test_account
                 FROM customer_client
                 LIMIT ${ALT_TAVAN + 2}`
              );
              // The manager's own row must not enter the list twice, and must not count
              // towards the truncation measurement either: otherwise a manager with exactly
              // cap child accounts raises a false alarm.
              const altSatirlar = children.filter((ch: any) => String(ch.customer_client?.id ?? "") !== id);
              if (altSatirlar.length > ALT_TAVAN) {
                altHesabiKesilen.push(id);
                ustSatir.altHesapKesildi = true;
              }
              for (const ch of altSatirlar.slice(0, ALT_TAVAN)) {
                const cc = ch.customer_client ?? {};
                const cid = String(cc.id ?? "");
                // A descendant account can appear under two managers (and a sub-manager
                // arrives both in the parent list and as a descendant): a row whose ID has
                // already been seen is not repeated.
                if (!cid || gorulenler.has(cid)) continue;
                const altSatir: Hesap = {
                  id: cid,
                  ad: String(cc.descriptive_name ?? "(isimsiz)"),
                  paraBirimi: cc.currency_code ? String(cc.currency_code) : undefined,
                  yonetici: Boolean(cc.manager),
                  testHesabi: Boolean(cc.test_account),
                  durum: String((enums.CustomerStatus as any)[cc.status] ?? cc.status ?? ""),
                  ustHesap: id,
                };
                hesaplar.push(altSatir);
                gorulenler.set(cid, altSatir);
              }
            }
          } catch {
            /**
             * The account is listed as accessible but its details cannot be read, so whether
             * it is a manager is UNKNOWN. Reporting `yonetici: false` here would state the
             * opposite of what is known: the agent reads that as an ordinary ad account,
             * picks it, and every call fails with USER_PERMISSION_DENIED. The unknown is
             * surfaced instead, in both the structured output and the human-readable table.
             */
            okunamayan.push(id);
            const mevcut = gorulenler.get(id);
            if (mevcut) {
              /**
               * The account is already in the list as a manager's descendant. Rather than
               * REPEATING the row we flag it: even when the name and currency read from the
               * parent are correct, if the account's OWN query throws then every call the
               * agent makes after selecting it comes back USER_PERMISSION_DENIED — which
               * makes it precisely the account that should not be selected.
               */
              mevcut.erisilemedi = true;
            } else {
              hesaplar.push({
                id,
                ad: "(detay okunamadı — login_customer_id gerekebilir)",
                yonetici: false,
                erisilemedi: true,
              });
              gorulenler.set(id, hesaplar[hesaplar.length - 1]!);
            }
          }
        }

        const satirlar = hesaplar.flatMap((h) => {
          // The unreachable badge is printed in BOTH row shapes: an account listed as a
          // descendant can fail its own query too, and staying silent in the human-readable
          // table showed the account as "usable" to a reader who never sees the warning in
          // the schema.
          const erisimNotu = h.erisilemedi ? "\t[ERİŞİLEMEDİ — kampanya için kullanma]" : "";
          const satir = h.ustHesap
            ? `  └ ${h.id}\t${h.ad}\t${h.paraBirimi ?? "?"}${h.durum ? `\t[${h.durum}]` : ""}${h.yonetici ? " [MCC]" : ""}${h.testHesabi ? " [TEST]" : ""}${erisimNotu}`
            : `${h.id}\t${h.ad}\t${h.paraBirimi ?? "?"}${h.yonetici ? "\t[MCC]" : ""}${erisimNotu}`;
          // The truncation warning is written directly under the manager that was CUT: the
          // fact that a child list is incomplete has to appear where the list is read.
          return h.altHesapKesildi
            ? [satir, `  ⚠ ${h.id}: alt hesap listesi ${ALT_TAVAN} satırda kesildi — bu MCC'de GÖRÜNMEYEN alt hesaplar var`]
            : [satir];
        });
        /**
         * The gap is written both for the human and into the schema. Silent truncation
         * produced a concrete failure: on a manager account with 90 customers, 40 were never
         * mentioned, and the account the user asked about came back as "you do not have
         * access".
         */
        const nedenler: string[] = [];
        if (ustKesildi) nedenler.push(`${ids.length - UST_TAVAN} üst hesabın detayı atlandı`);
        if (altHesabiKesilen.length)
          nedenler.push(`şu MCC'lerin alt hesap listesi ${ALT_TAVAN} satırda kesildi: ${altHesabiKesilen.join(", ")}`);
        if (okunamayan.length) nedenler.push(`${okunamayan.length} hesabın detayı okunamadı`);
        const tamListeMi = nedenler.length === 0;
        const eksikNot = tamListeMi
          ? undefined
          : `LİSTE EKSİK — ${nedenler.join("; ")}. Aradığın hesap burada yoksa "yok" SONUCUNA VARMA; kullanıcıdan kimliği iste.`;
        const extra = eksikNot ? `\n${eksikNot}` : "";
        return ikili("customerId\tisim\tpara birimi\n" + satirlar.join("\n") + extra, {
          hesaplar,
          tamListeMi,
          ...(eksikNot ? { eksikNot } : {}),
        });
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
        "İPUCU: alan adı uydurma; 'aegis://gaql-sema' kaynağında doğru alan listesi ve örnekler var. Sorguyu TEK SATIR yaz.",
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
        // A query without LIMIT pulls every page into memory — add one if it is missing
        const rows = await getCtx().queryWithRetry(customerId, ensureGaqlLimit(query, limit ?? 100));
        let capped = rows.slice(0, limit ?? 100);

        /**
         * Trim by row, never by character. Cutting the serialised text mid-value would
         * hand the agent malformed JSON; dropping whole rows keeps the payload valid.
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
        // LIMIT is cap+1: if exactly cap rows come back it is IMPOSSIBLE to tell whether the
        // list was truncated.
        const TAVAN = 500;
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
          LIMIT ${TAVAN + 1}
        `);
        if (!rows.length)
          return ikili(`Son ${d} günde veri bulunan kampanya yok.`, {
            pencereGun: d,
            kesildi: false,
            satirTavani: TAVAN,
            kampanyalar: [],
          });
        const kesildi = rows.length > TAVAN;

        const kampanyalar = rows.slice(0, TAVAN).filter((r: any) => r?.campaign).map((r: any) => {
          const m = r.metrics ?? {};
          /**
           * Every money and metric field is read INDIVIDUALLY, and a field that cannot be
           * read is DROPPED from the row. The `?? 0` idiom used to sit here: a LIVE campaign
           * whose budget was invisible was reported as "daily budget 0.00", and the agent
           * said "nothing is being spent, raise the budget". The row is not discarded, since
           * the other fields could be read — only the unreadable field falls silent, and its
           * name is announced through `okunamayanAlanlar`.
           */
          const ctrHam = sayiOku(m.ctr);
          const alanlar = {
            gunlukButce: mikrodanTutar(r.campaign_budget?.amount_micros),
            maliyet: mikrodanTutar(m.cost_micros),
            tiklama: sayiOku(m.clicks),
            gosterim: sayiOku(m.impressions),
            donusum: sayiOku(m.conversions),
            ctrYuzde: ctrHam === undefined ? undefined : Number((ctrHam * 100).toFixed(2)),
            ortTbm: mikrodanTutar(m.average_cpc),
          };
          const okunamayanAlanlar = Object.entries(alanlar)
            .filter(([, v]) => v === undefined)
            .map(([k]) => k);
          return {
            id: String(r.campaign.id),
            ad: String(r.campaign.name),
            durum: String((enums.CampaignStatus as any)[r.campaign.status] ?? r.campaign.status),
            kanal: String(
              (enums.AdvertisingChannelType as any)[r.campaign.advertising_channel_type] ?? r.campaign.advertising_channel_type
            ),
            ...tanimliAlanlar(alanlar),
            ...(okunamayanAlanlar.length ? { okunamayanAlanlar } : {}),
          };
        });

        const lines = kampanyalar.map(
          (k) =>
            `#${k.id} ${k.ad} [${k.durum}] (${k.kanal})\n` +
            `  günlük bütçe: ${sayiMetni(k.gunlukButce, 2)} | maliyet: ${sayiMetni(k.maliyet, 2)} | tıklama: ${sayiMetni(k.tiklama)} | gösterim: ${sayiMetni(k.gosterim)} | dönüşüm: ${sayiMetni(k.donusum)} | CTR: ${k.ctrYuzde === undefined ? "OKUNAMADI" : `%${k.ctrYuzde.toFixed(2)}`} | ort.TBM: ${sayiMetni(k.ortTbm, 2)}` +
            (k.okunamayanAlanlar
              ? `\n  ⚠ OKUNAMAYAN ALAN: ${k.okunamayanAlanlar.join(", ")} — bu kampanya için o sayılar BİLİNMİYOR, 0 varsayma`
              : "")
        );
        // The announced count comes from the FILTERED list: using `rows.length` would count
        // rows that are not in the table — the heading and the table would disagree.
        // Truncation is announced too: cutting silently makes a campaign that is missing
        // from the list look as though it does not exist.
        const uyari = kesildi
          ? `\n\nUYARI: liste en pahalı ${TAVAN} kampanyada KESİLDİ — daha fazlası var, görünmeyenler bu tabloda yok.`
          : "";
        return ikili(`Son ${d} gün, ${kampanyalar.length} kampanya:\n\n` + lines.join("\n") + uyari, {
          pencereGun: d,
          kesildi,
          satirTavani: TAVAN,
          kampanyalar,
        });
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
        // LIMIT is cap+1: if exactly cap rows come back it is IMPOSSIBLE to tell whether the
        // list was truncated.
        const TAVAN = 200;
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
           LIMIT ${TAVAN + 1}`
        );
        if (!rows.length)
          return ikili(`Son ${d} günde (≥${mc} tıklama) arama terimi verisi yok. minClicks=0 ile genişletebilirsin.`, {
            pencereGun: d,
            kesildi: false,
            satirTavani: TAVAN,
            toplamMaliyet: 0,
            israfMaliyet: 0,
            // israfYuzde is NOT written: with no rows at all the ratio is 0/0, that is,
            // UNKNOWN. Writing "0" is a declaration that there is no waste, whereas an
            // empty window says nothing about whether the account wastes money. The same
            // rule as in the truncation branch below.
            terimler: [],
          });
        const kesildi = rows.length > TAVAN;

        let totalCost = 0;
        let wastedCost = 0;
        let olculemeyenSatir = 0;
        const terimler = rows.slice(0, TAVAN).filter((r: any) => r?.campaign && r?.ad_group && r?.search_term_view).map((r: any) => {
          const m = r.metrics ?? {};
          /**
           * A WASTE VERDICT IS ONLY REACHED ON A ROW THAT COULD BE MEASURED. Under the
           * `?? 0` idiom, a term whose conversions could not be read counted as conv=0 and
           * was flagged 🔥 as a waste candidate — and the tool's NEXT STEP instruction led
           * the agent to turn it into a negative keyword, excluding a term that was
           * CONVERTING. Meanwhile genuine waste whose cost could not be read fell off the
           * list in the opposite direction, because cost=0. A row that cannot be measured
           * counts as neither wasteful nor clean: it goes into its own bucket and never
           * enters the totals.
           */
          const cost = mikrodanTutar(m.cost_micros);
          const conv = sayiOku(m.conversions);
          const olculemedi = cost === undefined || conv === undefined;
          if (olculemedi) olculemeyenSatir++;
          else totalCost += cost;
          const israfAdayi = !olculemedi && conv === 0 && cost > 0;
          if (israfAdayi) wastedCost += cost!;
          const stName = (enums.SearchTermTargetingStatus as any)[r.search_term_view?.status] ?? r.search_term_view?.status;
          // The real enum name is ADDED_EXCLUDED; there is no 'EXCLUDED_AND_ADDED' value.
          // Match the exact names, otherwise already-excluded terms keep coming back as
          // waste candidates.
          return {
            terim: String(r.search_term_view.search_term),
            kampanyaId: String(r.campaign.id),
            kampanya: String(r.campaign.name),
            reklamGrubu: String(r.ad_group.name),
            reklamGrubuId: String(r.ad_group.id),
            ...tanimliAlanlar({ maliyet: cost, tiklama: sayiOku(m.clicks), donusum: conv }),
            israfAdayi,
            ...(olculemedi ? { olculemedi: true } : {}),
            zatenDislanmis: stName === "EXCLUDED" || stName === "ADDED_EXCLUDED",
          };
        });

        const lines = terimler.map(
          (t) =>
            `"${t.terim}" — maliyet: ${sayiMetni(t.maliyet, 2)}, tıklama: ${sayiMetni(t.tiklama)}, ` +
            `dönüşüm: ${sayiMetni(t.donusum)} (${t.kampanya} [kmp:${t.kampanyaId}] / ${t.reklamGrubu}, ag:${t.reklamGrubuId})` +
            `${t.israfAdayi ? " 🔥 boşa-harcama-adayı" : ""}` +
            `${t.olculemedi ? " ⚠ ÖLÇÜLEMEDİ — maliyet/dönüşüm okunamadı, israf değerlendirmesi YAPILMADI, negatif kelime önerme" : ""}` +
            `${t.zatenDislanmis ? " [zaten dışlanmış]" : ""}`
        );
        /**
         * If the list was cut, NO RATIO IS PRODUCED. The totals cover only the most
         * expensive ${TAVAN} rows, and a percentage computed from those was being read as
         * the account's waste rate — the tool could say 10% while the real figure was 44%.
         * Unknown means the field is absent, and 0 is not written either.
         */
        // The ratio is written only when it can be MEASURED: if the list is cut the totals
        // are not the whole account; if total cost is 0 the ratio is 0/0; if some rows could
        // not be measured the denominator is incomplete. All three mean "unknown" — and
        // writing 0 would be a declaration that there is no waste.
        const israfYuzde =
          kesildi || totalCost <= 0 || olculemeyenSatir > 0
            ? undefined
            : Number(((wastedCost / totalCost) * 100).toFixed(0));
        const kapsam = kesildi
          ? `UYARI: liste en pahalı ${TAVAN} terimde KESİLDİ. Aşağıdaki toplamlar YALNIZ bu ${TAVAN} satırındır, ` +
            `hesabın tamamı DEĞİLDİR; bu yüzden israf ORANI hesaplanmadı. Daraltmak için campaignId ver ya da minClicks yükselt.\n`
          : "";
        // The ratio's BASE is stated explicitly: reading a percentage without knowing which
        // rows were counted, the agent took it for the account's rate.
        const olcumNotu = olculemeyenSatir
          ? `\nUYARI: ${olculemeyenSatir} terimin maliyeti/dönüşümü OKUNAMADI. Bu satırlar toplamlara ve ` +
            `israf değerlendirmesine ALINMADI; bu yüzden israf oranı hesaplanmadı. Ölçülemeyen terimler için ` +
            `"dönüşüm getirmedi" SONUCUNA VARMA.\n`
          : "";
        const olculen = terimler.length - olculemeyenSatir;
        return ikili(
          kapsam +
            olcumNotu +
            `Son ${d} gün, ${terimler.length} arama terimi (${olculen} tanesi ölçülebildi). ` +
            `${kesildi ? "Listelenen ölçülebilir terimlerin toplam maliyeti" : "Ölçülebilir terimlerin toplam maliyeti"}: ${totalCost.toFixed(2)}, ` +
            `dönüşümsüz terim maliyeti: ${wastedCost.toFixed(2)}${israfYuzde === undefined ? "" : ` (%${israfYuzde})`}.\n\n` +
            lines.join("\n") +
            `\n\nSONRAKİ ADIM: 🔥 işaretli terimlerden alakasız olanları belirle, kullanıcıya negatif kelime ` +
            `listesi olarak öner (hangi eşleme türüyle ekleneceğini söyle), ONAY SONRASI add_campaign_negative_keywords ile uygula. ` +
            `Dikkat: dönüşümsüz ≠ mutlaka alakasız — düşük hacimli ya da satış hunisinin başındaki terimleri aceleyle dışlama. ` +
            `⚠ ÖLÇÜLEMEDİ işaretli terimler bu listeye GİRMEZ: onlar hakkında hiçbir şey bilinmiyor.`,
          {
            pencereGun: d,
            kesildi,
            satirTavani: TAVAN,
            toplamMaliyet: totalCost,
            israfMaliyet: wastedCost,
            ...(olculemeyenSatir ? { olculemeyenSatir } : {}),
            ...(israfYuzde === undefined ? {} : { israfYuzde }),
            terimler,
          }
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
        // LIMIT is cap+1: if exactly cap rows come back it is IMPOSSIBLE to tell whether the
        // list was truncated.
        const TAVAN = 200;
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
          LIMIT ${TAVAN + 1}
        `);
        if (!rows.length)
          return ikili("Anahtar kelime verisi bulunamadı.", {
            pencereGun: d,
            kesildi: false,
            satirTavani: TAVAN,
            kelimeler: [],
          });
        const kesildi = rows.length > TAVAN;

        const kelimeler = rows.slice(0, TAVAN).filter((r: any) => r?.campaign && r?.ad_group).map((r: any) => {
          const kw = r.ad_group_criterion?.keyword ?? {};
          const m = r.metrics ?? {};
          // The same contract holds on the keyword surface: turning an unreadable cost or
          // conversion count into 0 builds the verdict "this keyword earns nothing, stop it"
          // on top of an unknown. An unreadable field is dropped from the row and its name is
          // announced.
          const alanlar = {
            maliyet: mikrodanTutar(m.cost_micros),
            tiklama: sayiOku(m.clicks),
            donusum: sayiOku(m.conversions),
          };
          const okunamayanAlanlar = Object.entries(alanlar)
            .filter(([, v]) => v === undefined)
            .map(([k]) => k);
          return {
            kelime: String(kw.text ?? ""),
            eslemeTuru: String((enums.KeywordMatchType as any)[kw.match_type] ?? kw.match_type ?? ""),
            kampanya: String(r.campaign.name),
            reklamGrubu: String(r.ad_group.name),
            ...tanimliAlanlar(alanlar),
            ...(okunamayanAlanlar.length ? { okunamayanAlanlar } : {}),
          };
        });
        const lines = kelimeler.map(
          (k) =>
            `"${k.kelime}" [${k.eslemeTuru}] (${k.kampanya} / ${k.reklamGrubu}) — maliyet: ${sayiMetni(k.maliyet, 2)}, tıklama: ${sayiMetni(k.tiklama)}, dönüşüm: ${sayiMetni(k.donusum)}` +
            (k.okunamayanAlanlar
              ? ` ⚠ OKUNAMAYAN ALAN: ${k.okunamayanAlanlar.join(", ")} — 0 varsayma`
              : "")
        );
        // Truncation is announced: cutting silently makes a keyword that is missing from the
        // list look as though it does not exist.
        const uyari = kesildi
          ? `\n\nUYARI: liste en pahalı ${TAVAN} kelimede KESİLDİ — daha fazlası var, görünmeyenler bu tabloda yok.`
          : "";
        return ikili(`Son ${d} gün, ${kelimeler.length} anahtar kelime:\n` + lines.join("\n") + uyari, {
          pencereGun: d,
          kesildi,
          satirTavani: TAVAN,
          kelimeler,
        });
      } catch (e) {
        return err(e);
      }
    }
  );
}
