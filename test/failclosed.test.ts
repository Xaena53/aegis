import { test } from "node:test";
import assert from "node:assert/strict";
import { enums } from "google-ads-api";
import { sahteContext, baglanti, cagir } from "./helpers/harness.js";
import { normalizeGaql, ensureGaqlLimit, formatAdsError } from "../src/util.js";

/**
 * Fail-closed regressions.
 *
 * A spend gate must not open when the situation is unclear. These tests pin that
 * behaviour for every "unknown" shape the API can produce: an empty result, a missing
 * status field, an unexpected type, an unreadable budget. Each one must lead to an
 * approval prompt rather than a silent pass.
 */

const M = "1234567890";
const AG = "200057393038";
const K = "24120539226";

const RSA = {
  customerId: M,
  adGroupId: AG,
  finalUrl: "https://ornek.com",
  headlines: ["Bir", "Iki", "Uc"],
  descriptions: ["Aciklama bir", "Aciklama iki"],
};

test("canlı-kampanya kapısı: sorgu BOŞ dönerse onay ister (fail-open değil)", async () => {
  // An empty result must not be read as "not live"; the gate has to stay closed when
  // the state is unknown.
  const { ctx, rec } = sahteContext({ queries: [[/FROM ad_group\b/, []]] });
  const c = await baglanti(ctx);
  const out = await cagir(c, "create_responsive_search_ad", RSA);
  assert.match(out, /Reddedildi|İşlem yapılmadı/);
  assert.equal(rec.mutations.length, 0, "durum doğrulanamadan yazma gitmemeli");
});

test("canlı-kampanya kapısı: durum alanı EKSİKSE onay ister", async () => {
  const { ctx, rec } = sahteContext({
    queries: [[/FROM ad_group\b/, [{ campaign: { id: 1, name: "Belirsiz" } }]]],
  });
  const c = await baglanti(ctx);
  const out = await cagir(c, "create_responsive_search_ad", RSA);
  assert.match(out, /doğrulanamadı/, "belirsizlik kullanıcıya bildirilmeli");
  assert.equal(rec.mutations.length, 0);
});

test("canlı-kampanya kapısı: durum METİN gelirse doğru yorumlanır", async () => {
  // enums.CampaignStatus["ENABLED"] is numeric, so a numeric-only comparison never
  // matches a textual status and would leave the gate open.
  const canli = sahteContext({ queries: [[/FROM ad_group\b/, [{ campaign: { id: 1, name: "K", status: "ENABLED" } }]]] });
  const c1 = await baglanti(canli.ctx);
  assert.match(await cagir(c1, "create_responsive_search_ad", RSA), /Reddedildi|İşlem yapılmadı/);
  assert.equal(canli.rec.mutations.length, 0, "metin 'ENABLED' de yayında sayılmalı");

  const taslak = sahteContext({ queries: [[/FROM ad_group\b/, [{ campaign: { id: 1, name: "K", status: "PAUSED" } }]]] });
  const c2 = await baglanti(taslak.ctx);
  assert.match(await cagir(c2, "create_responsive_search_ad", RSA), /RSA oluşturuldu/);
  assert.equal(taslak.rec.mutations.length, 1, "metin 'PAUSED' akışı engellememeli");
});

test("canlı-kampanya kapısı: PAUSED (sayı) hâlâ onaysız akar", async () => {
  const { ctx, rec } = sahteContext({
    queries: [[/FROM ad_group\b/, [{ campaign: { id: 1, name: "Taslak", status: enums.CampaignStatus.PAUSED } }]]],
  });
  const c = await baglanti(ctx);
  assert.match(await cagir(c, "create_responsive_search_ad", RSA), /RSA oluşturuldu/);
  assert.equal(rec.mutations.length, 1);
});

test("bütçe: mevcut tutar OKUNAMAZSA artış onayı atlanmaz", async () => {
  // An unreadable current amount becomes NaN, and every comparison against NaN is
  // false — an unknown budget must trigger approval, not skip it.
  const { ctx, rec } = sahteContext({
    queries: [
      [
        /campaign_budget\.explicitly_shared/,
        [{ campaign: { name: "K" }, campaign_budget: { resource_name: "r", explicitly_shared: false } }],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const out = await cagir(c, "update_campaign_budget", { customerId: M, campaignId: K, newDailyBudget: 400 });
  assert.match(out, /Reddedildi|İşlem yapılmadı/);
  assert.doesNotMatch(out, /NaN/, "kullanıcıya NaN gösterilmemeli");
  assert.equal(rec.mutations.length, 0);
});

test("onay özetleri HANGİ HESAP olduğunu içerir", async () => {
  const { ctx } = sahteContext({
    queries: [
      [/campaign_budget\.amount_micros/, [{ campaign: { name: "K" }, campaign_budget: { amount_micros: 50_000_000 } }]],
      [/FROM ad_group_ad/, [{ ad_group_ad: { ad: { id: 1 } } }]],
      [/FROM campaign_criterion/, []],
    ],
  });
  const c = await baglanti(ctx);
  const out = await cagir(c, "set_campaign_status", { customerId: M, campaignId: K, status: "ENABLED" });
  assert.match(out, new RegExp(`Hesap: ${M}`), "kimin parası harcanacak, özette olmalı");
  // A campaign with no geo target serves worldwide, and the summary has to say so
  // in plain words rather than neutral phrasing
  assert.match(out, /DÜNYA GENELİ/);
});

test("campaign_performance sorgusu LIMIT taşır (sınırsız bellek koruması)", async () => {
  const { ctx, rec } = sahteContext({ queries: [[/FROM campaign/, []]] });
  const c = await baglanti(ctx);
  await cagir(c, "campaign_performance", { customerId: M });
  assert.match(rec.queries.at(-1)!, /LIMIT \d+/, "LIMIT'siz sorgu tüm sayfaları belleğe çeker");
});

test("tek bozuk satır TÜM raporu düşürmez", async () => {
  const { ctx } = sahteContext({
    queries: [
      [
        /FROM campaign/,
        [
          { metrics: { cost_micros: 1 } }, // campaign nesnesi YOK
          {
            campaign: { id: 7, name: "Sağlam", status: enums.CampaignStatus.ENABLED, advertising_channel_type: enums.AdvertisingChannelType.SEARCH },
            campaign_budget: { amount_micros: 50_000_000 },
            metrics: { cost_micros: 2_000_000, clicks: 1, impressions: 10, conversions: 0, ctr: 0.1, average_cpc: 2_000_000 },
          },
        ],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: "campaign_performance", arguments: { customerId: M } });
  assert.notEqual(res.isError, true, "bozuk satır yerel hatayı Google hatası gibi göstermemeli");
  assert.equal(res.structuredContent.kampanyalar.length, 1);
  assert.equal(res.structuredContent.kampanyalar[0].ad, "Sağlam");
});

test("normalizeGaql metin sabitlerinin İÇİNDEKİ boşluğu korur", async () => {
  // Collapsing whitespace blindly would rewrite the campaign name and make the query
  // match nothing
  const q = "SELECT campaign.name FROM campaign\n  WHERE campaign.name = 'Yaz  İndirimi'";
  const n = normalizeGaql(q);
  assert.match(n, /'Yaz  İndirimi'/, "sabitin içi bozulmamalı");
  assert.doesNotMatch(n, /\n/, "sabit dışı boşluklar sıkışmalı");
});

test("ensureGaqlLimit ÇİFT tırnaklı sabiti de maskeler (OOM kelepçesi atlatılamaz)", () => {
  const q = 'SELECT campaign.name FROM campaign WHERE campaign.name = "PARAMETERS x" LIMIT 500000';
  const sonuc = ensureGaqlLimit(q, 100);
  assert.match(sonuc, /"PARAMETERS x"/, "LIMIT metin sabitinin içine enjekte edilmemeli");
  assert.doesNotMatch(sonuc, /LIMIT 500000/, "devasa LIMIT tavana kırpılmalı");
  assert.match(sonuc, /LIMIT 100/);
});

test("formatAdsError enum değeri 0 olan kodu düşürmez", () => {
  const s = formatAdsError({ errors: [{ error_code: { authorization_error: 0 }, message: "x" }] });
  assert.match(s, /authorization_error/, "kod adı kaybolmamalı");
});

/**
 * YAYINA ALMA BÜTÇE KAPISI (Google) — bu dosyanın başlığı "okunamayan bütçe"yi zaten
 * vaat ediyordu, ama yalnız bütçe DEĞİŞTİRME yolu için. Yayına alma yolunda kapı
 * `?? 0` ile yazılmıştı: okunamayan bütçe 0 sayılıyor, 0 her tavanın altında kaldığı
 * için kapı hep yeşil yanıyordu. Mutasyonla ölçüldü — kapı tamamen kaldırıldığında
 * takım 556/556 yeşil kalıyordu, yani kapının bekçisi yoktu.
 */
test("yayına alma: bütçe OKUNAMAZSA reddedilir (0 varsayılıp tavan geçilmez)", async () => {
  const { ctx, rec } = sahteContext({
    queries: [
      // Kampanya var, adı okunuyor — ama campaign_budget alanı hiç dönmedi.
      [/campaign_budget\.amount_micros/, [{ campaign: { name: "Bütçesi görünmeyen" } }]],
      [/FROM ad_group_ad/, [{ ad_group_ad: { ad: { id: 1 } } }]],
      [/FROM campaign_criterion/, []],
    ],
  });
  const c = await baglanti(ctx);
  const out = await cagir(c, "set_campaign_status", { customerId: M, campaignId: K, status: "ENABLED" });
  assert.match(out, /Reddedildi/, "bilinmeyen bütçe 'tavanın altında' demek değildir");
  assert.doesNotMatch(out, /\b0\b günlük|bütçesi 0/, "okunamayan bütçe 0 diye raporlanamaz");
  assert.equal(rec.mutations.length, 0, "KRİTİK: doğrulanamayan bütçeyle yayına alma yazması gitmemeli");
});

test("yayına alma: bütçe TAVANI aşıyorsa reddedilir — insana sorulmadan", async () => {
  const { ctx, rec } = sahteContext({
    // Tavan 500; kampanya 900 ile yayına alınmak isteniyor.
    queries: [
      [/campaign_budget\.amount_micros/, [{ campaign: { name: "Pahalı" }, campaign_budget: { amount_micros: 900_000_000 } }]],
      [/FROM ad_group_ad/, [{ ad_group_ad: { ad: { id: 1 } } }]],
      [/FROM campaign_criterion/, []],
    ],
  });
  const c = await baglanti(ctx);
  const out = await cagir(c, "set_campaign_status", { customerId: M, campaignId: K, status: "ENABLED" });
  assert.match(out, /Reddedildi/);
  assert.match(out, /900/, "ret, reddedilen büyüklüğü adıyla söylemeli");
  assert.equal(rec.mutations.length, 0);
});

/**
 * DURUM ÇÖZÜMLEMESİ BEYAZ LİSTEYLE ÇALIŞIR — VE BUNUN BEKÇİSİ BURASIDIR.
 *
 * Kapı bir dönem kara listeydi: "ENABLED/UNKNOWN/UNSPECIFIED dışındaki her ad kesin
 * taslaktır". Üstteki testler yalnız BOŞ yanıtı, EKSİK alanı ve tam yazılmış
 * "ENABLED"/"PAUSED" adlarını çiviliyordu; aradaki tüm yazımlar bekçisizdi. Google
 * `campaign.status` alanını enum numarası, enum adı ya da sayısal METİN ("2") olarak
 * verebiliyor — kara listede adı geçmeyen her değer yayındaki kampanyayı "taslak"
 * saydırıp onayı da, CAMARA zincirini de, denetim satırını da atlatıyordu.
 *
 * Aşağıdaki matris "bilinmiyor ile temiz aynı şey değildir" kuralını durum alanının
 * üretebileceği her şekil için ayrı ayrı çiviler. Her satır için iki şey birden
 * doğrulanır: onay istendi (yani kapı kapalı taraftaydı) VE hiçbir yazma gitmedi.
 */
const KAPIYI_ACMAYAN_DURUMLAR: Array<[string, unknown]> = [
  // enums.CampaignStatus[2] === "ENABLED": sayısal metin de gerçek adına çözülmeli
  ["sayısal metin '2' (= ENABLED)", "2"],
  ["küçük harfli 'enabled'", "enabled"],
  // Kara listede olmayan, uydurulmamış bir ad: Google'ın yarın ekleyeceği her ad böyledir
  ["tanınmayan ad 'SERVING'", "SERVING"],
  ["enum 0 (UNSPECIFIED)", 0],
  ["enum 1 (UNKNOWN)", 1],
  ["metin 'UNSPECIFIED'", "UNSPECIFIED"],
  ["metin 'UNKNOWN'", "UNKNOWN"],
  ["beklenmedik tip (boolean)", true],
  ["enum'da karşılığı olmayan sayı (99)", 99],
];

for (const [ad, durum] of KAPIYI_ACMAYAN_DURUMLAR) {
  test(`canlı-kampanya kapısı: durum ${ad} → onay İSTENİR (beyaz liste)`, async () => {
    const { ctx, rec } = sahteContext({
      queries: [[/FROM ad_group\b/, [{ campaign: { id: 1, name: "K", status: durum } }]]],
    });
    const c = await baglanti(ctx);
    const out = await cagir(c, "create_responsive_search_ad", RSA);
    assert.match(out, /Reddedildi|İşlem yapılmadı/, `'${ad}' kapıyı açmamalı`);
    assert.equal(rec.mutations.length, 0, `KRİTİK: '${ad}' ile onaysız yazma gitti`);
  });
}

/**
 * Beyaz listenin ÖTEKİ yüzü: taslak akışı bozulmamalı. Kapalı arıza, "her şeyi reddet"
 * demek değildir — harcamadığı kanıtlanmış durumlar onaysız akmaya devam eder,
 * yoksa kullanıcı taslak kurmayı bırakır ve kapı ilk fırsatta kapatılır.
 */
const KAPIYI_ACAN_DURUMLAR: Array<[string, unknown]> = [
  ["sayısal metin '3' (= PAUSED)", "3"],
  ["küçük harfli 'paused'", "paused"],
  ["metin 'REMOVED'", "REMOVED"],
  ["enum 4 (REMOVED)", 4],
];

for (const [ad, durum] of KAPIYI_ACAN_DURUMLAR) {
  test(`canlı-kampanya kapısı: durum ${ad} → taslak akışı onaysız sürer`, async () => {
    const { ctx, rec } = sahteContext({
      queries: [[/FROM ad_group\b/, [{ campaign: { id: 1, name: "K", status: durum } }]]],
    });
    const c = await baglanti(ctx);
    assert.match(await cagir(c, "create_responsive_search_ad", RSA), /RSA oluşturuldu/, `'${ad}' taslak sayılmalı`);
    assert.equal(rec.mutations.length, 1);
  });
}

test("canlı-kampanya kapısı: TANINMAYAN durum, insana 'yayında' diye SUNULMAZ", async () => {
  /**
   * İki ayrı iddia: kapı kapalı kalmalı (üstteki matris) ve insana gösterilen özet
   * durumun OKUNAMADIĞINI söylemeli. Kapalı ama yanlış gerekçeli bir istem, onayı
   * bilgisiz bir tıklamaya çevirir: kullanıcı "yayındaymış, doğru" diye onaylar.
   */
  const { ctx, rec } = sahteContext({
    queries: [[/FROM ad_group\b/, [{ campaign: { id: 1, name: "Garip", status: "SERVING" } }]]],
  });
  const c = await baglanti(ctx);
  const out = await cagir(c, "create_responsive_search_ad", RSA);
  assert.match(out, /doğrulanamadı/, "tanınmayan durum belirsiz olarak bildirilmeli");
  assert.equal(rec.mutations.length, 0);
});

test("paylaşımlı bütçe: explicitly_shared alanı HİÇ YOKSA bütçeye dokunulmaz", async () => {
  /**
   * `explicitly_shared` proto'da optional — yanıtta hiç bulunmayabilir. Düz truthiness
   * kontrolünde bu "paylaşımlı değil" demekti: paylaşımlılığı OKUNAMAYAN bir bütçe,
   * azaltma yolu onay bile istemediği için sessizce düşürülebiliyordu — ve onu
   * paylaşan diğer kampanyaların tavanı da onunla düşerdi.
   */
  const { ctx, rec } = sahteContext({
    queries: [
      [
        /campaign_budget\.explicitly_shared/,
        [{ campaign: { name: "Paylaşımlılığı bilinmeyen" }, campaign_budget: { resource_name: "r", amount_micros: 50_000_000 } }],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const out = await cagir(c, "update_campaign_budget", { customerId: M, campaignId: K, newDailyBudget: 20 });
  assert.match(out, /Reddedildi/);
  assert.match(out, /OKUNAMADI/, "ret, paylaşımlılığın bilinmediğini açıkça söylemeli");
  assert.equal(rec.mutations.length, 0, "KRİTİK: paylaşımlılık doğrulanmadan bütçe yazması gitmemeli");
});

test("paylaşımlı bütçe: explicitly_shared null gelirse de reddedilir", async () => {
  // null, "alan yok"un diğer telden hali: ikisi de boolean DEĞİLdır, ikisi de bilinmiyordur.
  const { ctx, rec } = sahteContext({
    queries: [
      [
        /campaign_budget\.explicitly_shared/,
        [{ campaign: { name: "K" }, campaign_budget: { resource_name: "r", amount_micros: 50_000_000, explicitly_shared: null } }],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const out = await cagir(c, "update_campaign_budget", { customerId: M, campaignId: K, newDailyBudget: 20 });
  assert.match(out, /Reddedildi/);
  assert.equal(rec.mutations.length, 0);
});
