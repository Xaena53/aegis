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
 * Yalnız GERÇEKTEN okunabilen alanları JSON'a taşır.
 *
 * Okunamayan alanı `undefined` ile bırakmak yetmez: JSON.stringify onu düşürse de şema
 * doğrulaması ve okuyan taraf için "alan var ama boş" ile "alan yok" farklıdır. Alanı
 * hiç yazmamak, bu deponun "bilinmiyor asla 0 diye kaydedilmez" kuralının okuma
 * yüzeyindeki karşılığıdır.
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
 * OKUNAMAYAN DEĞER ALANI DÜŞÜRÜR — bu yüzden para/metrik alanlarının hepsi optional.
 *
 * Eskiden `Number(x ?? 0)` yazıyordu: alan hiç gelmediğinde, null geldiğinde ya da boş
 * dizge geldiğinde rapor "0.00" diyordu. YAYINDAKİ bir kampanya için "günlük bütçe 0.00"
 * okuyan ajan "harcama yok, bütçeyi yükselt" teşhisine gidiyor; hiçbir hata da görünmüyor.
 * Bilinmiyor ile sıfır aynı şey değildir: değer okunamadıysa alan JSON'a hiç yazılmaz,
 * metinde "OKUNAMADI" basılır. Şema optional olmasaydı MCP çıktı doğrulaması tüm raporu
 * düşürürdü — yani tek bozuk satır 500 kampanyayı görünmez yapardı.
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
   * Ölçülemeyen satırlar AYRI KOVADA sayılır ve toplamlara girmez. Maliyeti ya da dönüşümü
   * okunamayan bir terimi 0/0 sayarak "israf adayı" işaretlemek iki yönde birden yanlıştı:
   * dönüşüm getiren bir terim negatif kelime olarak öneriliyor, gerçek israf ise listeden
   * düşüyordu. Sayı burada duyurulur ki ajan hangi taban üzerinden konuştuğunu bilsin.
   */
  olculemeyenSatir: z
    .number()
    .optional()
    .describe("Maliyeti/dönüşümü OKUNAMADIĞI için toplamlara ve israf değerlendirmesine alınmayan terim sayısı"),
  /**
   * Kırpma varken ya da ölçülemeyen satır varken oran ÜRETİLMEZ, 0 da yazılmaz. Kesik/eksik
   * listeden hesaplanan yüzde, hesabın gerçek israf oranıymış gibi okunuyordu: %44 israfı
   * olan bir hesapta araç %10 diyebiliyor ve ajan "ciddi israf yok" sonucuna varıyordu.
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
         * Aynı hesap birden çok yoldan gelebilir: hem listAccessibleCustomers listesinde
         * hem de bir MCC'nin torunu olarak. `customer_client.level = 1` filtresi
         * kaldırıldıktan sonra bu, alt-MCC'leri VE onların altındaki gerçek reklam
         * hesaplarını tabloya İKİ KEZ yazıyordu. İkincil zarar: tekrarlar ALT_TAVAN
         * kotasını yiyip, aslında sığan bir listeyi "GÖRÜNMEYEN alt hesaplar var" diye
         * yanlış alarma çevirebiliyordu. adsClient.hesaplariTopla aynı korumayı
         * `gorulen` Set'i ile yapıyor; burada satıra da erişmek gerektiği için Map.
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
            // Satıra referans TUTULUYOR: alt hesap kırpma bayrağı "listenin son elemanı"
            // varsayımıyla yazılırsa, araya bir push girdiği anda uyarı yanlış hesaba yapışır.
            // Hesap daha önce bir MCC'nin torunu olarak listelendiyse SATIR TEKRARLANMAZ;
            // var olan satır kullanılır, böylece kırpma bayrağı da doğru satıra yapışır.
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
               * `customer_client.level = 1` KALDIRILDI: o yan tümce yalnız DOĞRUDAN
               * çocukları getiriyordu ve iki katmanlı bir ajans MCC'sinde gerçek reklam
               * hesapları (alt-MCC'lerin çocukları) listede HİÇ görünmüyordu — araç
               * "tüm hesaplar" diyor, ajan da "erişilebilir hesabınız yok" diyordu.
               *
               * LIMIT tavan+2: tam tavan kadar satır dönerse kırpılıp kırpılmadığı
               * ANLAŞILAMAZ, o yüzden bir kırpma probu; bir de MCC'nin KENDİ satırı için
               * (customer_client sorgusu yöneticiyi de level 0 olarak döndürür).
               */
              const children: any[] = await ctx.queryWithRetry(
                id,
                `SELECT customer_client.id, customer_client.descriptive_name,
                        customer_client.currency_code, customer_client.manager,
                        customer_client.status, customer_client.test_account
                 FROM customer_client
                 LIMIT ${ALT_TAVAN + 2}`
              );
              // MCC'nin kendi satırı listeye iki kez girmemeli ve kırpma ölçümüne de
              // katılmamalı: yoksa tam tavan kadar alt hesabı olan MCC yanlış alarm verir.
              const altSatirlar = children.filter((ch: any) => String(ch.customer_client?.id ?? "") !== id);
              if (altSatirlar.length > ALT_TAVAN) {
                altHesabiKesilen.push(id);
                ustSatir.altHesapKesildi = true;
              }
              for (const ch of altSatirlar.slice(0, ALT_TAVAN)) {
                const cc = ch.customer_client ?? {};
                const cid = String(cc.id ?? "");
                // Torun hesaplar iki MCC'nin altında da görünebilir (ve alt-MCC hem üst
                // listede hem torun olarak gelir): kimliği görülmüş satır tekrarlanmaz.
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
               * Hesap zaten bir MCC'nin torunu olarak listede. Satırı TEKRARLAMAK yerine
               * işaretleriz: ebeveynden okunan ad/para birimi doğru olsa bile hesabın
               * KENDİ sorgusu patlıyorsa ajan onu seçtiğinde her çağrı
               * USER_PERMISSION_DENIED alır — yani seçilmemesi gereken hesap odur.
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
          // Erişilemedi rozeti HER İKİ satır biçiminde de basılır: torun olarak listelenen
          // bir hesabın kendi sorgusu da patlayabilir ve insan-okur tabloda susmak,
          // şemadaki uyarıyı görmeyen okura hesabı "kullanılabilir" gösteriyordu.
          const erisimNotu = h.erisilemedi ? "\t[ERİŞİLEMEDİ — kampanya için kullanma]" : "";
          const satir = h.ustHesap
            ? `  └ ${h.id}\t${h.ad}\t${h.paraBirimi ?? "?"}${h.durum ? `\t[${h.durum}]` : ""}${h.yonetici ? " [MCC]" : ""}${h.testHesabi ? " [TEST]" : ""}${erisimNotu}`
            : `${h.id}\t${h.ad}\t${h.paraBirimi ?? "?"}${h.yonetici ? "\t[MCC]" : ""}${erisimNotu}`;
          // Kırpma uyarısı KESİLEN MCC'nin hemen altına yazılır: alt hesap listesinin
          // eksik olduğu, listenin okunduğu yerde görünmeli.
          return h.altHesapKesildi
            ? [satir, `  ⚠ ${h.id}: alt hesap listesi ${ALT_TAVAN} satırda kesildi — bu MCC'de GÖRÜNMEYEN alt hesaplar var`]
            : [satir];
        });
        /**
         * Eksiklik hem insana hem şemaya yazılır. Sessiz kırpma somut arıza üretiyordu:
         * 90 müşterili bir MCC'de 40 hesap hiç anılmıyor, kullanıcının sorduğu hesap için
         * "erişiminiz yok" deniyordu.
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
        // LIMIT tavan+1: tam tavan kadar satır dönerse kırpılıp kırpılmadığı ANLAŞILAMAZ.
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
           * Her para/metrik alanı TEK TEK okunur ve okunamayan alan satırdan DÜŞER.
           * `?? 0` kalıbı burada duruyordu: bütçesi görünmeyen YAYINDAKİ bir kampanya
           * "günlük bütçe 0.00" diye raporlanıyor, ajan da "harcama yok, bütçeyi yükselt"
           * diyordu. Diğer alanlar okunabildiği için satır atılmaz — yalnız okunamayan
           * alan susturulur ve adı `okunamayanAlanlar` ile ilan edilir.
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
        // Duyurulan sayı SÜZÜLMÜŞ listeden gelir: `rows.length` kullanmak, tabloda
        // görünmeyen satırları da saymak demekti — başlık ile tablo birbirini tutmazdı.
        // Kırpma da duyurulur: sessiz kesme, listede olmayan kampanyayı "yok" sandırır.
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
        // LIMIT tavan+1: tam tavan kadar satır dönerse kırpılıp kırpılmadığı ANLAŞILAMAZ.
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
            // israfYuzde YAZILMAZ: hiç satır yokken oran 0/0'dır, yani BİLİNMİYOR.
            // "0" yazmak "israf yok" beyanıdır; oysa pencerede veri olmaması hesapta
            // israf olmadığını göstermez. Kırpma dalındaki kuralın aynısı (bkz. aşağı).
            terimler: [],
          });
        const kesildi = rows.length > TAVAN;

        let totalCost = 0;
        let wastedCost = 0;
        let olculemeyenSatir = 0;
        const terimler = rows.slice(0, TAVAN).filter((r: any) => r?.campaign && r?.ad_group && r?.search_term_view).map((r: any) => {
          const m = r.metrics ?? {};
          /**
           * İSRAF KARARI YALNIZ ÖLÇÜLEBİLEN SATIRDA VERİLİR. `?? 0` kalıbında dönüşümü
           * okunamayan bir terim conv=0 sayılıp 🔥 boşa-harcama-adayı işaretleniyordu ve
           * aracın SONRAKİ ADIM talimatı ajanı onu negatif kelime yapmaya götürüyordu —
           * yani DÖNÜŞÜM GETİREN terim dışlanıyordu. Maliyeti okunamayan gerçek israf ise
           * cost=0 olduğu için ters yönde listeden düşüyordu. Ölçülemeyen satır ne israf
           * sayılır ne temiz: ayrı kovaya alınır ve toplamlara hiç girmez.
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
         * Liste kesildiyse ORAN ÜRETİLMEZ. Toplamlar yalnız en pahalı ${TAVAN} satırındır;
         * bunlardan hesaplanan yüzde hesabın israf oranıymış gibi okunuyordu ve gerçek
         * oran %44 iken araç %10 diyebiliyordu. Bilinmiyor = alan yok (0 da yazılmaz).
         */
        // Oran yalnız ÖLÇÜLEBİLDİĞİNDE yazılır: liste kesikse toplamlar hesabın tamamı
        // değildir; toplam maliyet 0 ise oran 0/0'dır; ölçülemeyen satır varsa payda
        // eksiktir. Üçü de "bilinmiyor" — 0 yazmak "israf yok" beyanı olurdu.
        const israfYuzde =
          kesildi || totalCost <= 0 || olculemeyenSatir > 0
            ? undefined
            : Number(((wastedCost / totalCost) * 100).toFixed(0));
        const kapsam = kesildi
          ? `UYARI: liste en pahalı ${TAVAN} terimde KESİLDİ. Aşağıdaki toplamlar YALNIZ bu ${TAVAN} satırındır, ` +
            `hesabın tamamı DEĞİLDİR; bu yüzden israf ORANI hesaplanmadı. Daraltmak için campaignId ver ya da minClicks yükselt.\n`
          : "";
        // Oranın TABANI açıkça söylenir: hangi satırların sayıldığı belirsizken yüzde
        // okuyan ajan onu hesabın oranı sanıyordu.
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
        // LIMIT tavan+1: tam tavan kadar satır dönerse kırpılıp kırpılmadığı ANLAŞILAMAZ.
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
          // Aynı sözleşme kelime yüzeyinde de geçerli: okunamayan maliyet/dönüşüm 0'a
          // çevrilirse "bu kelime hiç kazandırmıyor, durdur" kararı bilinmeyen üzerine
          // kurulur. Okunamayan alan satırdan düşer, adı ilan edilir.
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
        // Kırpma duyurulur: sessiz kesme, listede olmayan kelimeyi "yok" sandırır.
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
