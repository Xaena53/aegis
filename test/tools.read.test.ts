import { test } from "node:test";
import assert from "node:assert/strict";
import { enums } from "google-ads-api";
import { sahteContext, baglanti, cagir } from "./helpers/harness.js";

/**
 * Q2 — okuma araçları. Buradaki testlerin çoğu, denetimde bulunan SESSİZ
 * hataların regresyon kilitleridir: yanlış veri döndüren bir rapor, ajanı
 * yanlış karara (ör. "harcama yok, bütçeyi artır") sürükler.
 */

const MUSTERI = "1234567890";

test("run_gaql: çok satırlı sorgu TEK SATIRA indirilir (sessiz veri kaybı fix'i)", async () => {
  const { ctx, rec } = sahteContext({ queries: [[/.*/, []]] });
  const c = await baglanti(ctx);
  await cagir(c, "run_gaql", {
    customerId: MUSTERI,
    query: "SELECT campaign.name,\n  metrics.cost_micros\nFROM campaign\nWHERE segments.date DURING LAST_7_DAYS",
  });
  const gonderilen = rec.queries.at(-1)!;
  assert.doesNotMatch(gonderilen, /\n/, "satır sonu kalırsa istemci ayrıştırıcısı SON alanı bozar");
  assert.match(gonderilen, /metrics\.cost_micros FROM campaign/);
});

test("run_gaql: LIMIT dayatılır, devasa LIMIT tavana kırpılır (OOM koruması)", async () => {
  const { ctx, rec } = sahteContext({ queries: [[/.*/, []]] });
  const c = await baglanti(ctx);

  await cagir(c, "run_gaql", { customerId: MUSTERI, query: "SELECT campaign.id FROM campaign" });
  assert.match(rec.queries.at(-1)!, /LIMIT 100$/, "LIMIT'siz sorguya tavan eklenmeli");

  await cagir(c, "run_gaql", { customerId: MUSTERI, query: "SELECT campaign.id FROM campaign LIMIT 500000", limit: 50 });
  assert.match(rec.queries.at(-1)!, /LIMIT 50$/, "kullanıcının devasa LIMIT'i kırpılmalı");
});

test("campaign_performance: enum'lar SAYI değil AD olarak gösterilir", async () => {
  const { ctx } = sahteContext({
    queries: [
      [
        /FROM campaign/,
        [
          {
            campaign: {
              id: 7,
              name: "Kampanyam",
              status: enums.CampaignStatus.PAUSED,
              advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
            },
            campaign_budget: { amount_micros: 50_000_000 },
            metrics: { cost_micros: 12_500_000, clicks: 10, impressions: 100, conversions: 2, ctr: 0.1, average_cpc: 1_250_000 },
          },
        ],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const out = await cagir(c, "campaign_performance", { customerId: MUSTERI });
  assert.match(out, /\[PAUSED\]/, "durum adı görünmeli (eskiden [3] yazıyordu)");
  assert.match(out, /\(SEARCH\)/);
  assert.match(out, /günlük bütçe: 50\.00/);
  assert.match(out, /maliyet: 12\.50/, "micros doğru çevrilmeli");
});

test("campaign_performance: tarih aralığı sorguya girer ve bugünü dışlar", async () => {
  const { ctx, rec } = sahteContext({ queries: [[/FROM campaign/, []]] });
  const c = await baglanti(ctx);
  await cagir(c, "campaign_performance", { customerId: MUSTERI, days: 7 });
  const q = rec.queries.at(-1)!;
  assert.match(q, /segments\.date BETWEEN '\d{4}-\d{2}-\d{2}' AND '\d{4}-\d{2}-\d{2}'/);
  const bugun = new Date();
  const bugunStr = `${bugun.getFullYear()}-${String(bugun.getMonth() + 1).padStart(2, "0")}-${String(bugun.getDate()).padStart(2, "0")}`;
  assert.doesNotMatch(q, new RegExp(`AND '${bugunStr}'`), "bugün (kısmi veri) dahil edilmemeli");
});

test("search_terms_report: dönüşümsüz terim israf olarak işaretlenir, israf oranı hesaplanır", async () => {
  const { ctx } = sahteContext({
    queries: [
      [
        /FROM search_term_view/,
        [
          {
            campaign: { name: "K" },
            ad_group: { id: 1, name: "G" },
            search_term_view: { search_term: "bedava anime", status: enums.SearchTermTargetingStatus.ADDED },
            metrics: { cost_micros: 75_000_000, clicks: 30, impressions: 300, conversions: 0 },
          },
          {
            campaign: { name: "K" },
            ad_group: { id: 1, name: "G" },
            search_term_view: { search_term: "anime izle", status: enums.SearchTermTargetingStatus.ADDED },
            metrics: { cost_micros: 25_000_000, clicks: 10, impressions: 100, conversions: 5 },
          },
        ],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const out = await cagir(c, "search_terms_report", { customerId: MUSTERI });
  assert.match(out, /bedava anime.*boşa-harcama-adayı/s, "dönüşümsüz terim işaretlenmeli");
  assert.doesNotMatch(out.split("anime izle")[1] ?? "", /boşa-harcama-adayı/, "dönüşen terim işaretlenmemeli");
  assert.match(out, /%75/, "israf oranı 75/100 = %75 olmalı");
});

test("search_terms_report: ADDED_EXCLUDED terimi 'zaten dışlanmış' sayılır", async () => {
  const { ctx } = sahteContext({
    queries: [
      [
        /FROM search_term_view/,
        [
          {
            campaign: { name: "K" },
            ad_group: { id: 1, name: "G" },
            // Denetimde bulunan hata: kod 'EXCLUDED_AND_ADDED' arıyordu, gerçek ad bu
            search_term_view: { search_term: "iş ilanı", status: enums.SearchTermTargetingStatus.ADDED_EXCLUDED },
            metrics: { cost_micros: 1_000_000, clicks: 1, impressions: 10, conversions: 0 },
          },
        ],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const out = await cagir(c, "search_terms_report", { customerId: MUSTERI });
  assert.match(out, /zaten dışlanmış/, "ajan zaten dışlanmış kelimeyi tekrar önermemeli");
});

test("keyword_performance: bozuk kampanya ID'si sorguya gitmeden reddedilir", async () => {
  const { ctx, rec } = sahteContext();
  const c = await baglanti(ctx);
  const out = await cagir(c, "keyword_performance", { customerId: MUSTERI, campaignId: "1 OR 1=1" });
  assert.match(out, /Geçersiz kampanya ID/);
  assert.equal(rec.queries.length, 0, "doğrulama başarısızsa sorgu hiç çalışmamalı");
});

test("list_accounts: MCC altındaki alt hesaplar da listelenir", async () => {
  const { ctx } = sahteContext({
    queries: [
      [/FROM customer\b/, [{ customer: { descriptive_name: "Yönetici", currency_code: "TRY", manager: true } }]],
      [
        /FROM customer_client/,
        [{ customer_client: { id: 1466231519, descriptive_name: "Alt Hesap", currency_code: "TRY", manager: false, test_account: true } }],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const out = await cagir(c, "list_accounts", {});
  assert.match(out, /Yönetici/);
  assert.match(out, /\[MCC\]/);
  assert.match(out, /└ 1466231519\tAlt Hesap/, "alt hesap görünmeli (listAccessibleCustomers döndürmez)");
  assert.match(out, /\[TEST\]/);
});

test("okuma araçlarının hiçbiri yazma yapmaz", async () => {
  const { ctx, rec } = sahteContext({ queries: [[/.*/, []]] });
  const c = await baglanti(ctx);
  for (const [ad, args] of [
    ["list_accounts", {}],
    ["campaign_performance", { customerId: MUSTERI }],
    ["keyword_performance", { customerId: MUSTERI }],
    ["search_terms_report", { customerId: MUSTERI }],
    ["run_gaql", { customerId: MUSTERI, query: "SELECT campaign.id FROM campaign" }],
  ] as Array<[string, Record<string, unknown>]>) {
    await cagir(c, ad, args);
  }
  assert.equal(rec.mutations.length, 0);
});

test("okuma araçları readOnlyHint, yazma araçları destructiveHint bildirir", async () => {
  const { ctx } = sahteContext();
  const c = await baglanti(ctx);
  const { tools }: any = await c.listTools();
  const bul = (n: string) => tools.find((t: any) => t.name === n);

  assert.equal(bul("campaign_performance").annotations.readOnlyHint, true);
  assert.equal(bul("search_terms_report").annotations.readOnlyHint, true);
  assert.equal(bul("analyze_site").annotations.readOnlyHint, true);
  assert.equal(bul("set_campaign_status").annotations.destructiveHint, true);
  assert.equal(bul("update_campaign_budget").annotations.destructiveHint, true);
  assert.equal(bul("create_search_campaign").annotations.readOnlyHint, false);
  assert.equal(tools.length, 12, "araç sayısı sözleşmesi");
});
