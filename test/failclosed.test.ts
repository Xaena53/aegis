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
  // Eskiden `if (!rows.length) return null` ile kapı sessizce açılıyordu
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
  // enums.CampaignStatus["ENABLED"] sayı döndürdüğü için eski karşılaştırma
  // metin durumda hep false oluyordu → kapı açık kalıyordu
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
  // Eskiden Number(undefined)=NaN → `yeni > NaN` hep false → onay TAMAMEN atlanıyordu
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
  // Coğrafi hedefi olmayan kampanya dünya geneli yayınlanır — nötr dille geçiştirilmemeli
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
  // Ham sıkıştırma kampanya adını sessizce değiştirip sorguyu eşleşmez yapıyordu
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
