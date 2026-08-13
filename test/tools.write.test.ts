import { test } from "node:test";
import assert from "node:assert/strict";
import { enums } from "google-ads-api";
import { sahteContext, baglanti, cagir } from "./helpers/harness.js";

/**
 * The spend-safety contract.
 *
 * Every test here corresponds to a guarantee made to the user in the README. If one
 * goes red, a path to unsupervised spending has opened.
 */

const MUSTERI = "1234567890";
const REKLAM_GRUBU = "200057393038";
const KAMPANYA = "24120539226";

/** The queried ad group belongs to a PAUSED campaign — the normal draft flow. */
const PAUSED_KAMPANYA: Array<[RegExp, any[]]> = [
  [/FROM ad_group\b/, [{ campaign: { id: 1, name: "Taslak", status: enums.CampaignStatus.PAUSED } }]],
];

/** The same query, except the campaign is live. */
const CANLI_KAMPANYA: Array<[RegExp, any[]]> = [
  [/FROM ad_group\b/, [{ campaign: { id: 1, name: "Canlı Kampanya", status: enums.CampaignStatus.ENABLED } }]],
];

test("yazma kilidi: writeEnabled=false iken ALTI yazma aracının hepsi reddeder", async () => {
  const { ctx, rec } = sahteContext({ writeEnabled: false });
  const c = await baglanti(ctx);

  const cagrilar: Array<[string, Record<string, unknown>]> = [
    ["create_search_campaign", { customerId: MUSTERI, name: "x", dailyBudget: 10, keywords: ["a"], countryCodes: ["TR"] }],
    ["create_responsive_search_ad", { customerId: MUSTERI, adGroupId: REKLAM_GRUBU, finalUrl: "https://x.com", headlines: ["a", "b", "c"], descriptions: ["d", "e"] }],
    ["update_campaign_budget", { customerId: MUSTERI, campaignId: KAMPANYA, newDailyBudget: 10 }],
    ["add_keywords", { customerId: MUSTERI, adGroupId: REKLAM_GRUBU, keywords: ["a"] }],
    ["add_campaign_negative_keywords", { customerId: MUSTERI, campaignId: KAMPANYA, keywords: ["a"] }],
    ["set_campaign_status", { customerId: MUSTERI, campaignId: KAMPANYA, status: "ENABLED", confirm: true }],
  ];

  for (const [ad, args] of cagrilar) {
    const out = await cagir(c, ad, args);
    assert.match(out, /devre dışı/i, `${ad} yazma kilidini delmiş`);
  }
  assert.equal(rec.mutations.length, 0, "kilitliyken HİÇBİR mutasyon gitmemeli");
});

/** An account that clears the pre-checks on the enable path: budget within the ceiling plus a servable ad. */
const YAYINA_HAZIR: Array<[RegExp, any[]]> = [
  [/campaign_budget\.amount_micros/, [{ campaign: { name: "Hazır" }, campaign_budget: { amount_micros: 50_000_000 } }]],
  [/FROM ad_group_ad/, [{ ad_group_ad: { ad: { id: 1 } } }]],
  [/FROM campaign_criterion/, [{ campaign_criterion: { location: { geo_target_constant: "geoTargetConstants/2792" } } }]],
];

test("onay kapısı: set_campaign_status(ENABLED) confirm olmadan yayına ALMAZ", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR });
  const c = await baglanti(ctx);
  const out = await cagir(c, "set_campaign_status", { customerId: MUSTERI, campaignId: KAMPANYA, status: "ENABLED" });
  assert.match(out, /Reddedildi/);
  assert.match(out, /onay/i);
  assert.equal(rec.mutations.length, 0, "onaysız yayına alma mutasyon üretmemeli");
});

test("onay kapısı: confirm=true ile (elicitation'sız istemcide) yayına alır", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR });
  const c = await baglanti(ctx);
  const out = await cagir(c, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true,
  });
  assert.match(out, /YAYINDA/);
  assert.equal(rec.mutations.filter((m) => m.kind === "campaigns").length, 1);
});

test("bütçe ARTIŞI onay ister, AZALTMA istemez", async () => {
  const butce: Array<[RegExp, any[]]> = [
    [
      /campaign_budget\.explicitly_shared/,
      [{ campaign: { name: "K" }, campaign_budget: { resource_name: "r", amount_micros: 50_000_000, explicitly_shared: false } }],
    ],
  ];

  const a = sahteContext({ queries: butce });
  const ca = await baglanti(a.ctx);
  const artis = await cagir(ca, "update_campaign_budget", { customerId: MUSTERI, campaignId: KAMPANYA, newDailyBudget: 90 });
  assert.match(artis, /Reddedildi/);
  assert.equal(a.rec.mutations.length, 0, "onaysız bütçe artışı uygulanmamalı");

  const b = sahteContext({ queries: butce });
  const cb = await baglanti(b.ctx);
  const azalt = await cagir(cb, "update_campaign_budget", { customerId: MUSTERI, campaignId: KAMPANYA, newDailyBudget: 20 });
  assert.match(azalt, /güncellendi/);
  assert.equal(b.rec.mutations.length, 1, "azaltma serbest olmalı (harcamayı düşürür)");
});

test("onay kapısı: PAUSED'a çekmek onay istemez (harcamayı azaltır)", async () => {
  const { ctx, rec } = sahteContext();
  const c = await baglanti(ctx);
  const out = await cagir(c, "set_campaign_status", { customerId: MUSTERI, campaignId: KAMPANYA, status: "PAUSED" });
  assert.match(out, /duraklatıldı/i);
  assert.equal(rec.mutations.filter((m) => m.kind === "campaigns").length, 1);
});

test("yayına almada BÜTÇE TAVANI uygulanır (arayüzde kurulmuş dev bütçe geçemez)", async () => {
  const { ctx, rec } = sahteContext({
    maxDailyBudget: 500,
    queries: [
      // A 10,000 TL campaign the user set up in the Google UI
      [/campaign_budget\.amount_micros/, [{ campaign: { name: "Pahalı" }, campaign_budget: { amount_micros: 10_000_000_000 } }]],
    ],
  });
  const c = await baglanti(ctx);
  const out = await cagir(c, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true,
  });
  assert.match(out, /Reddedildi/);
  assert.match(out, /10000/);
  assert.equal(rec.mutations.length, 0);
});

test("yayına almada YAYINLANABİLİR REKLAM şartı aranır", async () => {
  const { ctx, rec } = sahteContext({
    queries: [
      [/campaign_budget\.amount_micros/, [{ campaign: { name: "Uygun" }, campaign_budget: { amount_micros: 50_000_000 } }]],
      [/FROM ad_group_ad/, []], // no servable ad
    ],
  });
  const c = await baglanti(ctx);
  const out = await cagir(c, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true,
  });
  assert.match(out, /Reddedildi/);
  assert.match(out, /reklam/i);
  assert.equal(rec.mutations.length, 0);
});

test("kampanya PAUSED ve KAMPANYAYA ÖZEL bütçeyle kurulur, geo hedefi eklenir", async () => {
  const { ctx, rec } = sahteContext();
  const c = await baglanti(ctx);
  const out = await cagir(c, "create_search_campaign", {
    customerId: MUSTERI,
    name: "Test",
    dailyBudget: 50,
    keywords: ["anime izle", "ANIME IZLE"], // also verifies de-duplication
    countryCodes: ["TR"],
  });
  assert.match(out, /PAUSED/);

  const ops = rec.mutations.find((m) => m.kind === "mutateResources")!.payload as any[];
  const kampanya = ops.find((o) => o.entity === "campaign").resource;
  assert.equal(kampanya.status, enums.CampaignStatus.PAUSED, "kampanya ASLA ENABLED oluşturulmamalı");

  const butce = ops.find((o) => o.entity === "campaign_budget").resource;
  assert.equal(butce.explicitly_shared, false, "bütçe paylaşımlı olmamalı");
  assert.equal(butce.amount_micros, 50_000_000);

  const geo = ops.filter((o) => o.entity === "campaign_criterion");
  assert.equal(geo.length, 1);
  assert.match(geo[0].resource.location.geo_target_constant, /2792$/, "TR = 2000+792");

  const kelimeler = ops.filter((o) => o.entity === "ad_group_criterion");
  assert.equal(kelimeler.length, 1, "büyük/küçük harf tekrarı ayıklanmalı");
});

test("bütçe tavanı kampanya kurulumunda da uygulanır", async () => {
  const { ctx, rec } = sahteContext({ maxDailyBudget: 100 });
  const c = await baglanti(ctx);
  const out = await cagir(c, "create_search_campaign", {
    customerId: MUSTERI,
    name: "Test",
    dailyBudget: 101,
    keywords: ["a"],
    countryCodes: ["TR"],
  });
  assert.match(out, /Reddedildi/);
  assert.match(out, /tavan/i);
  assert.equal(rec.mutations.length, 0);
});

test("ülke hedefi ZORUNLU ve bilinmeyen kod reddedilir (dünya-geneli yayın koruması)", async () => {
  const { ctx, rec } = sahteContext();
  const c = await baglanti(ctx);

  const out = await cagir(c, "create_search_campaign", {
    customerId: MUSTERI,
    name: "Test",
    dailyBudget: 10,
    keywords: ["a"],
    countryCodes: ["XX"],
  });
  assert.match(out, /Reddedildi/);
  assert.equal(rec.mutations.length, 0);

  // Omitting countryCodes entirely is rejected at the schema level
  const eksik: any = await (await baglanti(ctx)).callTool({
    name: "create_search_campaign",
    arguments: { customerId: MUSTERI, name: "T", dailyBudget: 10, keywords: ["a"] },
  });
  assert.equal(eksik.isError, true, "countryCodes zorunlu olmalı");
  assert.equal(rec.mutations.length, 0);
});

test("CANLI kampanyaya onaysız REKLAM eklenemez, onayla eklenir", async () => {
  const { ctx, rec } = sahteContext({ queries: CANLI_KAMPANYA });
  const c = await baglanti(ctx);
  const args = {
    customerId: MUSTERI,
    adGroupId: REKLAM_GRUBU,
    finalUrl: "https://ornek.com",
    headlines: ["Bir", "Iki", "Uc"],
    descriptions: ["Aciklama bir", "Aciklama iki"],
  };

  const red = await cagir(c, "create_responsive_search_ad", args);
  assert.match(red, /YAYINDA/);
  assert.equal(rec.mutations.length, 0, "canlı kampanyaya onaysız reklam gitmemeli");

  const ok = await cagir(c, "create_responsive_search_ad", { ...args, confirm: true });
  assert.match(ok, /RSA oluşturuldu/);
  assert.equal(rec.mutations.filter((m) => m.kind === "adGroupAds").length, 1);
});

test("PAUSED kampanyaya reklam eklemek onay İSTEMEZ (taslak akışı bozulmamalı)", async () => {
  const { ctx, rec } = sahteContext({ queries: PAUSED_KAMPANYA });
  const c = await baglanti(ctx);
  const out = await cagir(c, "create_responsive_search_ad", {
    customerId: MUSTERI,
    adGroupId: REKLAM_GRUBU,
    finalUrl: "https://ornek.com",
    headlines: ["Bir", "Iki", "Uc"],
    descriptions: ["Aciklama bir", "Aciklama iki"],
  });
  assert.match(out, /RSA oluşturuldu/);
  assert.equal(rec.mutations.length, 1);
});

test("CANLI kampanyaya onaysız POZİTİF kelime eklenemez; NEGATİF kelime muaf", async () => {
  const { ctx, rec } = sahteContext({ queries: CANLI_KAMPANYA });
  const c = await baglanti(ctx);

  const red = await cagir(c, "add_keywords", { customerId: MUSTERI, adGroupId: REKLAM_GRUBU, keywords: ["sigorta"] });
  assert.match(red, /YAYINDA/);
  assert.equal(rec.mutations.length, 0);

  // A negative keyword reduces spend → no approval required
  const neg = await cagir(c, "add_keywords", {
    customerId: MUSTERI,
    adGroupId: REKLAM_GRUBU,
    keywords: ["ücretsiz"],
    negative: true,
  });
  assert.match(neg, /negatif anahtar kelime eklendi/);
  assert.equal(rec.mutations.length, 1);
});

test("paylaşımlı bütçe değiştirilemez (diğer kampanyaları etkilerdi)", async () => {
  const { ctx, rec } = sahteContext({
    queries: [
      [
        /campaign_budget\.explicitly_shared/,
        [{ campaign: { name: "Ortak" }, campaign_budget: { resource_name: "r", amount_micros: 50_000_000, explicitly_shared: true } }],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const out = await cagir(c, "update_campaign_budget", { customerId: MUSTERI, campaignId: KAMPANYA, newDailyBudget: 60 });
  assert.match(out, /PAYLAŞIMLI/);
  assert.equal(rec.mutations.length, 0);
});

test("RSA: tekrarlar ayıklandıktan sonra eşik altı kalırsa reddedilir", async () => {
  const { ctx, rec } = sahteContext({ queries: PAUSED_KAMPANYA });
  const c = await baglanti(ctx);
  const out = await cagir(c, "create_responsive_search_ad", {
    customerId: MUSTERI,
    adGroupId: REKLAM_GRUBU,
    finalUrl: "https://ornek.com",
    headlines: ["Aynı", "aynı", "AYNI"],
    descriptions: ["Bir", "Iki"],
  });
  assert.match(out, /Reddedildi/);
  assert.match(out, /başlık/i);
  assert.equal(rec.mutations.length, 0);
});

test("finalUrl yalnız http/https olabilir", async () => {
  const { ctx, rec } = sahteContext({ queries: PAUSED_KAMPANYA });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({
    name: "create_responsive_search_ad",
    arguments: {
      customerId: MUSTERI,
      adGroupId: REKLAM_GRUBU,
      finalUrl: "javascript:alert(1)",
      headlines: ["Bir", "Iki", "Uc"],
      descriptions: ["Aciklama bir", "Aciklama iki"],
    },
  });
  // Either Zod's url() or our own check rejects it — no write may happen either way
  const metin = String(res.content?.[0]?.text ?? "");
  assert.ok(res.isError === true || /Reddedildi/.test(metin), "javascript: şeması geçmemeli");
  assert.equal(rec.mutations.length, 0);
});

test("ID'ler rakam dışı olamaz (kaynak adı/GAQL enjeksiyon yüzeyi)", async () => {
  const { ctx, rec } = sahteContext();
  const c = await baglanti(ctx);
  const out = await cagir(c, "update_campaign_budget", {
    customerId: MUSTERI,
    campaignId: "1; DROP TABLE",
    newDailyBudget: 10,
  });
  assert.match(out, /Geçersiz kampanya ID/);
  assert.equal(rec.mutations.length, 0);
});
