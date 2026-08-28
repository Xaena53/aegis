import { test } from "node:test";
import assert from "node:assert/strict";
import { enums } from "google-ads-api";
import { sahteContext, baglanti, cagir } from "./helpers/harness.js";

/**
 * Read tools.
 *
 * Most of these pin behaviour that fails silently when broken: a report that returns
 * subtly wrong data leads the agent to a wrong decision ("no spend, raise the budget")
 * with no error anywhere.
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
            // ADDED_EXCLUDED is the real enum name; a near-miss spelling silently disables this branch
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

/**
 * Regression: an account whose details cannot be read has an UNKNOWN manager status.
 * Reporting it as `yonetici: false` claims the opposite of what is known — the agent reads
 * that as an ordinary ad account and every subsequent call fails with permission errors.
 * Found by the live smoke test, which auto-selected exactly such an account.
 */
test("list_accounts: detayı okunamayan hesap kullanılabilir gibi sunulmaz", async () => {
  const { ctx } = sahteContext({
    hesaplar: ["5346956094", "1466231519"],
    okunamayanHesaplar: ["5346956094"],
    queries: [[/FROM customer\b/, [{ customer: { descriptive_name: "Reklam Hesabı", currency_code: "TRY", manager: false } }]]],
  });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: "list_accounts", arguments: {} });
  const metin = String(res.content?.[0]?.text ?? "");
  const okunamayan = res.structuredContent.hesaplar.find((h: any) => h.id === "5346956094");
  const saglam = res.structuredContent.hesaplar.find((h: any) => h.id === "1466231519");

  assert.equal(okunamayan?.erisilemedi, true, "okunamayan hesap işaretlenmeli");
  assert.match(metin, /ERİŞİLEMEDİ/, "insan-okur tabloda da uyarı olmalı");
  assert.ok(!saglam?.erisilemedi, "okunabilen hesap yanlışlıkla işaretlenmemeli");
  assert.equal(saglam?.yonetici, false, "okunabilen reklam hesabı normal görünmeli");
});

/** Structured output: the agent should never have to parse numbers out of prose. */
async function yapisal(c: any, name: string, args: Record<string, unknown>) {
  const res: any = await c.callTool({ name, arguments: args });
  return res;
}

test("beş okuma aracı outputSchema bildirir", async () => {
  const { ctx } = sahteContext();
  const c = await baglanti(ctx);
  const { tools }: any = await c.listTools();
  const semali = tools.filter((t: any) => t.outputSchema).map((t: any) => t.name).sort();
  assert.deepEqual(semali, [
    "campaign_performance",
    "keyword_performance",
    "list_accounts",
    "run_gaql",
    "search_terms_report",
  ]);
});

test("campaign_performance tipli veri döner (sayılar SAYI, enum'lar AD)", async () => {
  const { ctx } = sahteContext({
    queries: [
      [
        /FROM campaign/,
        [
          {
            campaign: {
              id: 7,
              name: "K",
              status: enums.CampaignStatus.ENABLED,
              advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
            },
            campaign_budget: { amount_micros: 60_000_000 },
            metrics: { cost_micros: 12_500_000, clicks: 10, impressions: 100, conversions: 2, ctr: 0.1, average_cpc: 1_250_000 },
          },
        ],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const res = await yapisal(c, "campaign_performance", { customerId: MUSTERI, days: 7 });

  assert.ok(res.structuredContent, "structuredContent bulunmalı");
  assert.ok(res.content?.[0]?.text, "insan-okur metin de korunmalı");
  const s = res.structuredContent;
  assert.equal(s.pencereGun, 7);
  assert.equal(s.kampanyalar[0].id, "7");
  assert.equal(s.kampanyalar[0].durum, "ENABLED");
  assert.equal(s.kampanyalar[0].gunlukButce, 60, "micros bölünmüş SAYI olmalı");
  assert.equal(s.kampanyalar[0].maliyet, 12.5);
  assert.equal(s.kampanyalar[0].ctrYuzde, 10);
  assert.equal(typeof s.kampanyalar[0].tiklama, "number");
});

test("search_terms_report israf hesabını tipli döner", async () => {
  const { ctx } = sahteContext({
    queries: [
      [
        /FROM search_term_view/,
        [
          {
            campaign: { name: "K" },
            ad_group: { id: 11, name: "G" },
            search_term_view: { search_term: "bedava", status: enums.SearchTermTargetingStatus.ADDED },
            metrics: { cost_micros: 75_000_000, clicks: 30, impressions: 300, conversions: 0 },
          },
          {
            campaign: { name: "K" },
            ad_group: { id: 11, name: "G" },
            search_term_view: { search_term: "satın al", status: enums.SearchTermTargetingStatus.ADDED_EXCLUDED },
            metrics: { cost_micros: 25_000_000, clicks: 10, impressions: 100, conversions: 5 },
          },
        ],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const s = (await yapisal(c, "search_terms_report", { customerId: MUSTERI })).structuredContent;
  assert.equal(s.toplamMaliyet, 100);
  assert.equal(s.israfMaliyet, 75);
  assert.equal(s.israfYuzde, 75);
  assert.equal(s.terimler[0].israfAdayi, true);
  assert.equal(s.terimler[0].reklamGrubuId, "11", "negatif eklemek için gereken ID yapısal veride olmalı");
  assert.equal(s.terimler[1].israfAdayi, false);
  assert.equal(s.terimler[1].zatenDislanmis, true);
});

test("run_gaql çıktıyı SATIR atarak sınırlar (geçersiz JSON üretmez)", async () => {
  const kocaman = Array.from({ length: 400 }, (_, i) => ({
    campaign: { id: i, name: "K".repeat(200) },
  }));
  const { ctx } = sahteContext({ queries: [[/.*/, kocaman]] });
  const c = await baglanti(ctx);
  const res = await yapisal(c, "run_gaql", { customerId: MUSTERI, query: "SELECT campaign.id FROM campaign", limit: 400 });
  const s = res.structuredContent;

  assert.equal(s.satirSayisi, 400);
  assert.ok(s.gosterilen < 400, "büyük çıktı kısılmalı");
  assert.equal(s.kesildi, true);
  // Cutting the JSON text mid-string would emit unparseable output, so rows stay whole objects
  assert.equal(s.satirlar.length, s.gosterilen);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(s.satirlar)));
});

test("boş sonuçlar da tipli döner (şema ihlali olmaz)", async () => {
  const { ctx } = sahteContext({ queries: [[/.*/, []]] });
  const c = await baglanti(ctx);
  for (const [ad, beklenenAlan] of [
    ["campaign_performance", "kampanyalar"],
    ["keyword_performance", "kelimeler"],
    ["search_terms_report", "terimler"],
  ] as Array<[string, string]>) {
    const res = await yapisal(c, ad, { customerId: MUSTERI });
    assert.ok(res.structuredContent, `${ad} boş sonuçta structuredContent vermeli`);
    assert.deepEqual(res.structuredContent[beklenenAlan], [], `${ad}.${beklenenAlan} boş dizi olmalı`);
  }
});

test("geçersiz girdi isError döner (şema doğrulaması patlamasın)", async () => {
  const { ctx } = sahteContext();
  const c = await baglanti(ctx);
  const res: any = await c.callTool({
    name: "keyword_performance",
    arguments: { customerId: MUSTERI, campaignId: "1 OR 1=1" },
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Geçersiz kampanya ID/);
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

/**
 * Tool-description contract.
 *
 * An MCP server quality is largely how reliably a model picks the right tool, so the
 * descriptions are treated as an interface: these tests stop them from silently
 * degrading.
 */
test("her aracın başlığı ve yeterince açıklayıcı bir tarifi var", async () => {
  const { ctx } = sahteContext();
  const c = await baglanti(ctx);
  const { tools }: any = await c.listTools();
  for (const t of tools) {
    assert.ok(t.title, `${t.name}: başlık yok`);
    assert.ok(t.description.length >= 120, `${t.name}: açıklama çok kısa (${t.description.length})`);
    assert.match(t.description, /KULLAN:|KULLAN —/, `${t.name}: 'ne zaman kullan' yönlendirmesi yok`);
  }
});

test("karıştırılması kolay araç çiftleri birbirine YÖNLENDİRİR", async () => {
  const { ctx } = sahteContext();
  const c = await baglanti(ctx);
  const { tools }: any = await c.listTools();
  const bul = (n: string) => tools.find((t: any) => t.name === n).description;

  // Search term ≠ keyword: the most common conceptual mix-up
  assert.match(bul("keyword_performance"), /search_terms_report/);
  assert.match(bul("search_terms_report"), /keyword_performance/);
  // A campaign-level negative is usually the right choice over an ad-group one
  assert.match(bul("add_keywords"), /add_campaign_negative_keywords/);
  // A raw query should not be written when a ready-made report exists
  assert.match(bul("run_gaql"), /campaign_performance/);
  // Creating a campaign must not be confused with adding to an existing one
  assert.match(bul("create_search_campaign"), /add_keywords|create_responsive_search_ad/);
});

test("para harcatan araçlar açıklamalarında güvenlik kuralını taşır", async () => {
  const { ctx } = sahteContext();
  const c = await baglanti(ctx);
  const { tools }: any = await c.listTools();
  const bul = (n: string) => tools.find((t: any) => t.name === n).description;

  assert.match(bul("set_campaign_status"), /onay/i);
  assert.match(bul("update_campaign_budget"), /AZALTMA serbest|ARTIŞ kullanıcı onayı/);
  assert.match(bul("create_search_campaign"), /PAUSED|duraklatılmış/);
  // The agent is told plainly that negative keywords need no approval
  assert.match(bul("add_campaign_negative_keywords"), /onay istemez/);
  // The untrusted-page-content warning appears in the tool description as well
  assert.match(bul("analyze_site"), /GÜVENİLMEZ/);
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
  // Tools that write into a live campaign count as destructive: the code's own risk model
  // weighs them the same as enabling a campaign, and the annotation must agree.
  assert.equal(bul("create_responsive_search_ad").annotations.destructiveHint, true);
  // Creating a draft campaign is not destructive, because it is born paused
  assert.equal(bul("create_search_campaign").annotations.destructiveHint, false);
  // Meta araçları da AYNI kapıdan geçer: sayı sözleşmesi 12 → 15 (Google 12 + Meta 3).
  assert.equal(tools.length, 15, "araç sayısı sözleşmesi");
  assert.equal(bul("create_meta_campaign").annotations.destructiveHint, false,
    "Meta kampanyası da duraklatılmış doğar — yıkıcı değil");
  assert.equal(bul("set_meta_campaign_status").annotations.destructiveHint, true);
  assert.equal(bul("update_meta_campaign_budget").annotations.destructiveHint, true);
});
