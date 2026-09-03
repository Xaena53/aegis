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
  /**
   * add_keywords da yıkıcıdır ve bu işaret bir dönem eksikti. Araç, canlı kampanyaya
   * pozitif kelime eklerken ikizi create_responsive_search_ad ile AYNI liveCampaignGuard
   * yolunu "high" risk etiketiyle çağırıyor; işaret WRITE_SAFE kaldığı sürece hem
   * destructiveHint'e bakan istemci bu yazmayı sürtünmesiz geçiriyor hem de
   * kapiKapsami gözcüsü aracı hiç görmüyordu.
   */
  assert.equal(bul("add_keywords").annotations.destructiveHint, true);
  // Kampanya seviyesi negatif kelime YALNIZCA harcama azaltır: yıkıcı değildir.
  assert.equal(bul("add_campaign_negative_keywords").annotations.destructiveHint, false);
  // Creating a draft campaign is not destructive, because it is born paused
  assert.equal(bul("create_search_campaign").annotations.destructiveHint, false);
  // Meta araçları da AYNI kapıdan geçer: sayı sözleşmesi 12 → 15 (Google 12 + Meta 3).
  assert.equal(tools.length, 15, "araç sayısı sözleşmesi");
  assert.equal(bul("create_meta_campaign").annotations.destructiveHint, false,
    "Meta kampanyası da duraklatılmış doğar — yıkıcı değil");
  assert.equal(bul("set_meta_campaign_status").annotations.destructiveHint, true);
  assert.equal(bul("update_meta_campaign_budget").annotations.destructiveHint, true);
});

/**
 * AŞAĞIDAKİ DÖRT TEST MUTASYONLA BULUNAN BOŞLUKLARI KAPATIR.
 *
 * Dördü de sessiz arızalar: hiçbiri hata üretmez, hepsi ajana yanlış bir tablo verir ve
 * ajan o tabloya bakarak para harcatan bir öneri yapar.
 */

test("KRİTİK israf: HİÇ PARA HARCAMAMIŞ terim israf adayı sayılmaz", async () => {
  /**
   * `israfAdayi = conv === 0 && cost > 0` içindeki maliyet koşulu düşürüldüğünde takım
   * yeşil kalıyordu. Koşulsuz hâlde gösterim almış ama tıklanmamış her terim "boşa
   * harcama" diye işaretlenir — oysa hiçbir şey harcanmamıştır. Kullanıcı o terimi
   * negatife ekler ve henüz para harcamamış, ileride dönüşebilecek bir aramayı kapatır.
   *
   * İsraf, harcanmış paradır. Harcanmamış para israf değildir.
   */
  const { ctx } = sahteContext({
    queries: [
      [
        /FROM search_term_view/,
        [
          {
            campaign: { name: "K" },
            ad_group: { id: 1, name: "G" },
            search_term_view: { search_term: "harcamayan terim", status: enums.SearchTermTargetingStatus.ADDED },
            metrics: { cost_micros: 0, clicks: 0, impressions: 40, conversions: 0 },
          },
          {
            campaign: { name: "K" },
            ad_group: { id: 1, name: "G" },
            search_term_view: { search_term: "para yakan terim", status: enums.SearchTermTargetingStatus.ADDED },
            metrics: { cost_micros: 50_000_000, clicks: 20, impressions: 200, conversions: 0 },
          },
        ],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const out = await cagir(c, "search_terms_report", { customerId: MUSTERI, minClicks: 0 });

  const harcamayanSatiri = out.split("\n").find((s) => s.includes("harcamayan terim")) ?? "";
  assert.doesNotMatch(
    harcamayanSatiri,
    /boşa-harcama-adayı/,
    "maliyeti 0 olan terim israf değildir — negatife eklenmesi öneriliyor olurdu"
  );
  const yakanSatiri = out.split("\n").find((s) => s.includes("para yakan terim")) ?? "";
  assert.match(yakanSatiri, /boşa-harcama-adayı/, "gerçek israf yine işaretlenmeli");
});

test("KRİTİK: includePaused=false gerçekten YALNIZ yayındakileri sorar", async () => {
  /**
   * Bu bayrağın sorguya hiç yansımadığı fark edilmezdi: kullanıcı "sadece yayındakiler"
   * der, duraklatılmışları da içeren bir tablo alır ve durmuş bir kampanyanın verisine
   * bakarak karar verir. Sorgunun KENDİSİ ölçülüyor, çünkü çıktı iki durumda da makul
   * görünür.
   */
  const { ctx, rec } = sahteContext({ queries: [[/FROM campaign/, []]] });
  const c = await baglanti(ctx);

  await cagir(c, "campaign_performance", { customerId: MUSTERI, includePaused: false });
  assert.match(rec.queries.at(-1)!, /campaign\.status = 'ENABLED'/, "yalnız yayındakiler istenmeli");

  await cagir(c, "campaign_performance", { customerId: MUSTERI, includePaused: true });
  assert.match(rec.queries.at(-1)!, /campaign\.status != 'REMOVED'/);

  await cagir(c, "campaign_performance", { customerId: MUSTERI });
  assert.match(rec.queries.at(-1)!, /campaign\.status != 'REMOVED'/, "varsayılan: duraklatılmışlar dahil");
});

test("KRİTİK: bozuk satır rapora GİRMEZ, tabloyu da bozmaz", async () => {
  /**
   * API bir satırı eksik döndürebilir. Süzgeç olmadan o satır rapora `undefined` alanlarla
   * girer; ajan onu gerçek bir arama terimi sanır ve tablodaki toplamlar sessizce kayar.
   */
  const { ctx } = sahteContext({
    queries: [
      [
        /FROM search_term_view/,
        [
          { metrics: { cost_micros: 90_000_000, clicks: 10, conversions: 0 } }, // campaign/ad_group YOK
          {
            campaign: { id: 77, name: "K" },
            ad_group: { id: 1, name: "G" },
            search_term_view: { search_term: "sağlam terim", status: enums.SearchTermTargetingStatus.ADDED },
            metrics: { cost_micros: 10_000_000, clicks: 5, impressions: 50, conversions: 0 },
          },
        ],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const out = await cagir(c, "search_terms_report", { customerId: MUSTERI });

  assert.match(out, /sağlam terim/, "sağlam satır kalmalı");
  assert.doesNotMatch(out, /undefined/, "eksik alanlar rapora sızmamalı");
  /**
   * DUYURULAN SAYI TABLOYLA UYUŞMALI. Bu testi yazarken çıkan gerçek hata buydu: özet
   * `rows.length` sayıyordu, tablo ise süzülmüş listeyi basıyordu — "2 arama terimi"
   * yazıp tek satır gösteriyordu. Ajan için bu, "bir terim gösterilmemiş, belki
   * kırpıldı" anlamına gelir ve olmayan bir veriyi aramaya iter.
   */
  assert.match(out, /1 arama terimi/, "başlıktaki sayı tablodaki satır sayısıyla aynı olmalı");
  assert.doesNotMatch(out, /2 arama terimi/);
  // İsraf yüzdesi de yalnız sağlam satırdan hesaplanır: bozuk satırın 90'ı sayılmamalı.
  assert.match(out, /toplam maliyeti: 10\.00/);
});

test("list_accounts: hesap sayısı sınırlı — tek çağrı yüzlerce sorguya açılmaz", async () => {
  /**
   * Sınır kalktığında hiçbir test kızarmıyordu. Büyük bir MCC'de bu, tek bir
   * list_accounts çağrısını yüzlerce API turuna çevirir ve paylaşılan kotayı tüketir.
   */
  const cokHesap = Array.from({ length: 50 }, (_, i) => String(1000000000 + i));
  const { ctx, rec } = sahteContext({
    hesaplar: cokHesap,
    queries: [[/FROM customer/, [{ customer: { descriptive_name: "H", currency_code: "TRY", manager: false } }]]],
  });
  const c = await baglanti(ctx);
  await cagir(c, "list_accounts", {});
  assert.ok(
    rec.queries.length <= 30,
    `hesap sorguları 30 ile sınırlı olmalı, ${rec.queries.length} sorgu yapıldı`
  );
});

/* ── kırpma dürüstlüğü ─────────────────────────────────────────────────────────
 *
 * Kesilmiş bir liste "hesabın tamamı" gibi sunulduğunda hata sessizdir: ajan aradığı
 * satırı bulamayınca "yok" sonucuna varır, kesik toplamdan çıkarılan oranı da gerçek
 * sanır. Aşağıdaki testler tavan+1 doyma ölçümünü ve duyuruyu zorlar.
 */

/** N satırlık sahte arama-terimi cevabı üretir (ilk `donusenSayisi` tanesi dönüşüm getirir). */
function aramaTerimleri(n: number, donusenSayisi = 0) {
  return Array.from({ length: n }, (_, i) => ({
    campaign: { id: 77, name: "K" },
    ad_group: { id: 1, name: "G" },
    search_term_view: { search_term: `terim ${i}`, status: enums.SearchTermTargetingStatus.ADDED },
    metrics: { cost_micros: 1_000_000, clicks: 2, impressions: 20, conversions: i < donusenSayisi ? 1 : 0 },
  }));
}

test("KRİTİK: search_terms_report kırpıldığında israf ORANI üretmez", async () => {
  /**
   * 4.000 terimli bir hesapta rapor yalnız en pahalı 200 terimi görür. O 200 satırdan
   * hesaplanan yüzde, hesabın israf oranı diye sunuluyordu: gerçek oran %44 iken araç
   * %10 diyebiliyor, ajan "ciddi israf yok" sonucuna varıyordu. Bilinmiyorsa alan YOK.
   */
  const { ctx } = sahteContext({ queries: [[/FROM search_term_view/, aramaTerimleri(201, 150)]] });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: "search_terms_report", arguments: { customerId: MUSTERI } });
  const veri = res.structuredContent;
  const metin = String(res.content?.[0]?.text ?? "");

  assert.equal(veri.kesildi, true, "doyma ölçülmeli (tavan+1 satır döndü)");
  assert.equal(veri.satirTavani, 200);
  assert.equal(veri.terimler.length, 200, "tavan kadar satır gösterilmeli");
  assert.equal("israfYuzde" in veri, false, "kesik listeden oran ÜRETİLMEZ, 0 da yazılmaz");
  assert.match(metin, /KESİLDİ/, "kırpma insan-okur özette de duyurulmalı");
  assert.match(metin, /hesabın tamamı DEĞİLDİR/);
});

test("search_terms_report kırpılmadığında oran hâlâ verilir (yanlış alarm yok)", async () => {
  const { ctx } = sahteContext({ queries: [[/FROM search_term_view/, aramaTerimleri(200, 100)]] });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: "search_terms_report", arguments: { customerId: MUSTERI } });
  assert.equal(res.structuredContent.kesildi, false, "tam tavan kadar satır kırpma DEĞİLDİR");
  assert.equal(res.structuredContent.israfYuzde, 50, "tam listede oran hesaplanmalı");
  assert.doesNotMatch(String(res.content?.[0]?.text ?? ""), /KESİLDİ/);
});

test("KRİTİK: campaign_performance ve keyword_performance kırpmayı duyurur", async () => {
  const kampanyalar = Array.from({ length: 501 }, (_, i) => ({
    campaign: {
      id: i,
      name: `K${i}`,
      status: enums.CampaignStatus.ENABLED,
      advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
    },
    campaign_budget: { amount_micros: 1_000_000 },
    metrics: { cost_micros: 1_000_000, clicks: 1, impressions: 1, conversions: 0, ctr: 0.1, average_cpc: 1_000_000 },
  }));
  const kelimeler = Array.from({ length: 201 }, (_, i) => ({
    campaign: { name: "K" },
    ad_group: { name: "G" },
    ad_group_criterion: { keyword: { text: `kelime ${i}`, match_type: enums.KeywordMatchType.EXACT } },
    metrics: { cost_micros: 1_000_000, clicks: 1, impressions: 1, conversions: 0 },
  }));
  const { ctx } = sahteContext({
    queries: [
      [/FROM campaign\b/, kampanyalar],
      [/FROM keyword_view/, kelimeler],
    ],
  });
  const c = await baglanti(ctx);

  const kmp: any = await c.callTool({ name: "campaign_performance", arguments: { customerId: MUSTERI } });
  assert.equal(kmp.structuredContent.kesildi, true);
  assert.equal(kmp.structuredContent.kampanyalar.length, 500);
  assert.match(String(kmp.content?.[0]?.text ?? ""), /KESİLDİ/);

  const kw: any = await c.callTool({ name: "keyword_performance", arguments: { customerId: MUSTERI } });
  assert.equal(kw.structuredContent.kesildi, true);
  assert.equal(kw.structuredContent.kelimeler.length, 200);
  assert.match(String(kw.content?.[0]?.text ?? ""), /KESİLDİ/);
});

test("KRİTİK: list_accounts iki katmanlı MCC'de TORUN hesapları da gösterir", async () => {
  /**
   * `customer_client.level = 1` yalnız doğrudan çocukları getiriyordu; ajans
   * kurulumunda gerçek reklam hesapları alt-MCC'nin altındadır ve listede HİÇ
   * görünmüyordu. Araç açıklaması "tüm hesaplar" derken ajan "erişilebilir hesabınız
   * yok" diyor ya da MCC seçip USER_PERMISSION_DENIED alıyordu.
   */
  const { ctx, rec } = sahteContext({
    queries: [
      [/FROM customer\b/, [{ customer: { descriptive_name: "Ajans MCC", currency_code: "TRY", manager: true } }]],
      [
        /FROM customer_client/,
        [
          // Gerçek API yöneticinin KENDİSİNİ de döndürür; listeye iki kez girmemeli.
          { customer_client: { id: 1234567890, descriptive_name: "Ajans MCC", manager: true } },
          { customer_client: { id: 2222222222, descriptive_name: "Alt MCC", manager: true } },
          { customer_client: { id: 3333333333, descriptive_name: "Torun reklam hesabı", manager: false } },
        ],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: "list_accounts", arguments: {} });
  const idler = res.structuredContent.hesaplar.map((h: any) => h.id);

  assert.ok(idler.includes("3333333333"), "torun reklam hesabı listede olmalı");
  assert.equal(idler.filter((i: string) => i === "1234567890").length, 1, "MCC iki kez görünmemeli");
  assert.doesNotMatch(rec.queries.join(" "), /customer_client\.level/, "level filtresi torunları gizliyordu");
});

test("KRİTİK: list_accounts alt hesap kırpmasını SESSİZ geçmez", async () => {
  /**
   * 90 müşterili bir MCC'de 40 hesap hiç anılmıyordu; kullanıcının sorduğu hesap için
   * "erişiminiz yok" deniyordu. Üst hesap kırpması duyurulurken alt hesabınki değildi.
   */
  const cocuklar = Array.from({ length: 52 }, (_, i) => ({
    customer_client: { id: 2000000000 + i, descriptive_name: `Alt ${i}`, currency_code: "TRY", manager: false },
  }));
  const { ctx } = sahteContext({
    queries: [
      [/FROM customer\b/, [{ customer: { descriptive_name: "Büyük MCC", currency_code: "TRY", manager: true } }]],
      [/FROM customer_client/, cocuklar],
    ],
  });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: "list_accounts", arguments: {} });
  const metin = String(res.content?.[0]?.text ?? "");
  const mcc = res.structuredContent.hesaplar.find((h: any) => h.id === "1234567890");

  assert.equal(mcc.altHesapKesildi, true, "kırpılan MCC şemada işaretli olmalı");
  assert.equal(res.structuredContent.tamListeMi, false);
  assert.match(res.structuredContent.eksikNot, /kesildi/);
  assert.match(metin, /GÖRÜNMEYEN alt hesaplar var/, "uyarı insan-okur tabloda da olmalı");
  assert.equal(res.structuredContent.hesaplar.filter((h: any) => h.ustHesap).length, 50, "tavan kadar alt hesap");
});

test("list_accounts tam liste TAM ilan edilir (yanlış alarm yok)", async () => {
  const { ctx } = sahteContext({
    queries: [[/FROM customer\b/, [{ customer: { descriptive_name: "H", currency_code: "TRY", manager: false } }]]],
  });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: "list_accounts", arguments: {} });
  assert.equal(res.structuredContent.tamListeMi, true);
  assert.equal("eksikNot" in res.structuredContent, false, "eksiklik yokken not yazılmaz");
});

test("KRİTİK: okunamayan hesap listeyi EKSİK yapar (tam sayılmaz)", async () => {
  const { ctx } = sahteContext({
    hesaplar: ["5346956094", "1466231519"],
    okunamayanHesaplar: ["5346956094"],
    queries: [
      [/FROM customer\b/, [{ customer: { descriptive_name: "Reklam Hesabı", currency_code: "TRY", manager: false } }]],
    ],
  });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: "list_accounts", arguments: {} });
  assert.equal(res.structuredContent.tamListeMi, false, "bir hesap okunamadıysa liste TAM değildir");
  assert.match(res.structuredContent.eksikNot, /okunamadı/);
});

/* ── kırpma PROBU: türeyen boolean değil, onu besleyen SORGU ──────────────────── */

test("KRİTİK: rapor sorguları tavan+1 DOYMA PROBU ister (kırpma ölçülebilir olsun)", async () => {
  /**
   * Kırpma tespitinin tek mekanizması budur: Google `LIMIT 200` için EN FAZLA 200 satır
   * döndürür, dolayısıyla `rows.length > 200` ancak sorgu 201 istediyse true olabilir.
   * Prob `LIMIT tavan`a düşerse `kesildi` üretimde KALICI olarak false olur; kesik
   * listeden yine israf oranı yazılır ve "en pahalı N'de kesildi" uyarısı hiç basılmaz.
   * Bu test sorgu METNİNİ pinler; harness ayrıca LIMIT'e uyarak sonucu da ölçülebilir kılar.
   */
  const { ctx, rec } = sahteContext({ queries: [[/.*/, []]] });
  const c = await baglanti(ctx);
  await c.callTool({ name: "campaign_performance", arguments: { customerId: MUSTERI } });
  await c.callTool({ name: "search_terms_report", arguments: { customerId: MUSTERI } });
  await c.callTool({ name: "keyword_performance", arguments: { customerId: MUSTERI } });
  await c.callTool({ name: "list_accounts", arguments: {} });

  const bul = (parca: RegExp) => rec.queries.find((q) => parca.test(q)) ?? "";
  assert.match(bul(/FROM campaign\b/), /LIMIT 501\b/, "campaign_performance tavanı 500 + 1 prob");
  assert.match(bul(/FROM search_term_view/), /LIMIT 201\b/, "search_terms_report tavanı 200 + 1 prob");
  assert.match(bul(/FROM keyword_view/), /LIMIT 201\b/, "keyword_performance tavanı 200 + 1 prob");
});

test("KRİTİK: alt hesap sorgusu tavan+2 ister (prob + MCC'nin KENDİ satırı)", async () => {
  /**
   * customer_client sorgusu yöneticinin kendisini de (level 0) döndürür ve o satır
   * kırpma ölçümünden düşülür. Tavan+1 yeterli DEĞİLDİR: MCC satırı elendikten sonra
   * elde tam tavan kadar alt hesap kalır ve doyma bir daha asla ölçülemez.
   */
  const { ctx, rec } = sahteContext({
    queries: [[/FROM customer\b/, [{ customer: { descriptive_name: "MCC", currency_code: "TRY", manager: true } }]]],
  });
  const c = await baglanti(ctx);
  await c.callTool({ name: "list_accounts", arguments: {} });
  const sorgu = rec.queries.find((q) => /FROM customer_client/.test(q)) ?? "";
  assert.match(sorgu, /LIMIT 52\b/, "alt hesap tavanı 50 + 1 prob + 1 MCC satırı");
});

test("KRİTİK: sahte API LIMIT'e uyar — prob olmadan kırpma ÖLÇÜLEMEZ", async () => {
  /**
   * Harness'ın kendisine bekçi. Konserve satırlar LIMIT'i yok sayarsa, üretimde
   * ölçülemeyen bir şey testte ölçülebilir görünür ve `LIMIT tavan+1` probunu silen
   * mutasyon suiti YEŞİL bırakır (bir kez gerçekten öyle oldu).
   */
  const { ctx } = sahteContext({ queries: [[/FROM search_term_view/, aramaTerimleri(201, 0)]] });
  const satirlar = await (ctx as any).queryWithRetry(MUSTERI, "SELECT x FROM search_term_view LIMIT 200");
  assert.equal(satirlar.length, 200, "LIMIT 200 sorgusuna 201 satır dönemez — gerçek API de dönmez");
  const probla = await (ctx as any).queryWithRetry(MUSTERI, "SELECT x FROM search_term_view LIMIT 201");
  assert.equal(probla.length, 201, "prob istendiğinde doyma satırı GELMELİ, yoksa test bir şey ölçmez");
});

test("search_terms_report: hiç satır yokken israf ORANI yazılmaz (0/0 = bilinmiyor)", async () => {
  /**
   * Veri yokken 0 yazmak "israf yok" beyanıdır; oysa pencerede satır olmaması hesapta
   * israf olmadığını göstermez. Kırpma dalındaki kuralın aynısı: bilinmiyor = alan yok.
   */
  const { ctx } = sahteContext({ queries: [[/FROM search_term_view/, []]] });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: "search_terms_report", arguments: { customerId: MUSTERI } });
  assert.equal("israfYuzde" in res.structuredContent, false, "veri yokken oran BİLİNMİYOR, 0 yazılmaz");
  assert.equal(res.structuredContent.toplamMaliyet, 0);
});

test("search_terms_report: tüm terimler 0 maliyetliyken de oran yazılmaz", async () => {
  const bedava = [
    {
      campaign: { id: 1, name: "K" },
      ad_group: { id: 2, name: "G" },
      search_term_view: { search_term: "t", status: enums.SearchTermTargetingStatus.ADDED },
      metrics: { cost_micros: 0, clicks: 3, impressions: 9, conversions: 0 },
    },
  ];
  const { ctx } = sahteContext({ queries: [[/FROM search_term_view/, bedava]] });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: "search_terms_report", arguments: { customerId: MUSTERI } });
  assert.equal("israfYuzde" in res.structuredContent, false, "0/0 oran değildir");
  assert.doesNotMatch(String(res.content?.[0]?.text ?? ""), /%undefined/, "özet 'undefined' basmamalı");
});

test("KRİTİK: list_accounts hem MCC hem alt-MCC erişilebilirken torunu TEKRARLAMAZ", async () => {
  /**
   * `customer_client.level = 1` kalktıktan sonra ortaya çıkan gerçek kusur: 1111111111
   * bir MCC ve torunları 2222222222 (alt-MCC) + 3333333333. 2222222222 üst listede DE
   * yer alıyor, dolayısıyla hem kendisi hem torunu tabloya İKİ KEZ giriyordu. İkincil
   * zarar: tekrarlar ALT_TAVAN kotasını yiyip yanlış kırpma alarmı üretebiliyordu.
   */
  const { ctx } = sahteContext({
    hesaplar: ["1111111111", "2222222222"],
    queries: [
      [/FROM customer\b/, [{ customer: { descriptive_name: "MCC", currency_code: "TRY", manager: true } }]],
      [
        /FROM customer_client/,
        [
          { customer_client: { id: 2222222222, descriptive_name: "Alt MCC", manager: true } },
          { customer_client: { id: 3333333333, descriptive_name: "Reklam hesabı", manager: false } },
        ],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: "list_accounts", arguments: {} });
  const idler: string[] = res.structuredContent.hesaplar.map((h: any) => h.id);
  const metin = String(res.content?.[0]?.text ?? "");

  assert.deepEqual([...new Set(idler)].sort(), idler.slice().sort(), "hiçbir hesap iki kez listelenmemeli");
  assert.equal(idler.filter((i) => i === "2222222222").length, 1, "alt-MCC tek satır olmalı");
  assert.equal(idler.filter((i) => i === "3333333333").length, 1, "torun reklam hesabı tek satır olmalı");
  assert.equal((metin.match(/3333333333/g) ?? []).length, 1, "insan-okur tabloda da tek kez");
  assert.equal(res.structuredContent.tamListeMi, true, "tekrarlar kotayı yiyip yanlış alarm üretmemeli");
});

test("torun olarak listelenen hesabın KENDİ sorgusu patlarsa erişilemedi işaretlenir", async () => {
  /**
   * Ebeveynden okunan ad doğru olsa bile hesabın kendi sorgusu patlıyorsa ajan onu
   * seçtiğinde her çağrı USER_PERMISSION_DENIED alır: seçilmemesi gereken hesap odur.
   * Satırı tekrarlamak yerine var olan satır işaretlenir.
   */
  const { ctx } = sahteContext({
    hesaplar: ["1111111111", "2222222222"],
    okunamayanHesaplar: ["2222222222"],
    queries: [
      [/FROM customer\b/, [{ customer: { descriptive_name: "MCC", currency_code: "TRY", manager: true } }]],
      [/FROM customer_client/, [{ customer_client: { id: 2222222222, descriptive_name: "Alt hesap", manager: false } }]],
    ],
  });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: "list_accounts", arguments: {} });
  const alt = res.structuredContent.hesaplar.filter((h: any) => h.id === "2222222222");

  assert.equal(alt.length, 1, "okunamayan hesap ikinci kez eklenmemeli");
  assert.equal(alt[0].erisilemedi, true, "kendi sorgusu patlayan hesap işaretlenmeli");
  assert.match(String(res.content?.[0]?.text ?? ""), /ERİŞİLEMEDİ/, "rozet insan-okur tabloda da olmalı");
  assert.equal(res.structuredContent.tamListeMi, false, "okunamayan hesap listeyi EKSİK yapar");
});

/**
 * OKUMA YÜZEYİNDE "BİLİNMİYOR ≠ 0" — bekçi testleri.
 *
 * Bu üç araç okunamayan bir para/metrik alanını Number(x ?? 0) ile 0'a çeviriyordu.
 * Ölçülen sonuç: bütçesi görünmeyen YAYINDAKİ kampanya "günlük bütçe 0.00" diye
 * raporlanıyor, ajan "harcama yok, bütçeyi yükselt" teşhisine gidiyordu; hiçbir hata
 * görünmüyordu. Aşağıdaki vakalar tam olarak o girdileri besliyor.
 */
const TAM_METRIK = { cost_micros: 2_000_000, clicks: 1, impressions: 10, conversions: 0, ctr: 0.1, average_cpc: 2_000_000 };

async function kampanyaRaporu(butceSatiri: any, metrics: any = TAM_METRIK) {
  const { ctx } = sahteContext({
    queries: [
      [
        /FROM campaign/,
        [
          {
            campaign: {
              id: 7,
              name: "Yayındaki Kampanya",
              status: enums.CampaignStatus.ENABLED,
              advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
            },
            ...butceSatiri,
            metrics,
          },
        ],
      ],
    ],
  });
  const c = await baglanti(ctx);
  return (await c.callTool({ name: "campaign_performance", arguments: { customerId: MUSTERI } })) as any;
}

test("campaign_performance: okunamayan günlük bütçe 0.00 diye RAPORLANMAZ", async () => {
  const vakalar: Array<[string, any]> = [
    ["alan yok", {}],
    ["null", { campaign_budget: { amount_micros: null } }],
    ["boş dizge", { campaign_budget: { amount_micros: "" } }],
    ["metin", { campaign_budget: { amount_micros: "abc" } }],
  ];
  for (const [ad, satir] of vakalar) {
    const res = await kampanyaRaporu(satir);
    const k = res.structuredContent.kampanyalar[0];
    assert.notEqual(res.isError, true, ad + ": tek okunamayan alan tüm raporu düşürmemeli");
    assert.equal(k.gunlukButce, undefined, ad + ": okunamayan bütçe alanı JSON'a yazılmamalı");
    assert.deepEqual(k.okunamayanAlanlar, ["gunlukButce"], ad + ": okunamayan alan adı ilan edilmeli");
    const metin = String(res.content[0].text);
    assert.match(metin, /günlük bütçe: OKUNAMADI/, ad + ": metinde 0.00 yazamaz");
    assert.doesNotMatch(metin, /günlük bütçe: 0\.00/, ad + ": bütçesiz kalmış teşhisine götüren satır");
    assert.match(metin, /OKUNAMAYAN ALAN: gunlukButce/, ad + ": okur uyarılmalı");
    assert.equal(k.maliyet, 2, ad + ": ölçülebilen alanlar yerinde kalmalı, satır tümden atılmamalı");
  }
});

test("campaign_performance: metrics hiç gelmediğinde metrik alanları DÜŞER (0 yazılmaz)", async () => {
  const res = await kampanyaRaporu({ campaign_budget: { amount_micros: 50_000_000 } }, null);
  const k = res.structuredContent.kampanyalar[0];
  assert.notEqual(res.isError, true);
  assert.equal(k.gunlukButce, 50, "bütçe okunabiliyorsa yazılır");
  for (const alan of ["maliyet", "tiklama", "gosterim", "donusum", "ctrYuzde", "ortTbm"]) {
    assert.equal(k[alan], undefined, alan + " bilinmiyorken 0 diye yazılamaz");
  }
  assert.deepEqual(k.okunamayanAlanlar, ["maliyet", "tiklama", "gosterim", "donusum", "ctrYuzde", "ortTbm"]);
  const metin = String(res.content[0].text);
  assert.match(metin, /maliyet: OKUNAMADI/);
  assert.match(metin, /CTR: OKUNAMADI/);
});

async function terimRaporu(satirlar: any[]) {
  const { ctx } = sahteContext({ queries: [[/FROM search_term_view/, satirlar]] });
  const c = await baglanti(ctx);
  return (await c.callTool({ name: "search_terms_report", arguments: { customerId: MUSTERI } })) as any;
}

function terimSatiri(terim: string, metrics: any) {
  return {
    campaign: { id: 77, name: "K" },
    ad_group: { id: 1, name: "G" },
    search_term_view: { search_term: terim, status: enums.SearchTermTargetingStatus.ADDED },
    metrics,
  };
}

test("search_terms_report: DÖNÜŞÜMÜ okunamayan terim israf adayı İŞARETLENMEZ", async () => {
  /**
   * Ters yönlü arıza: conversions ?? 0 yüzünden dönüşümü okunamayan terim "0 dönüşüm"
   * sayılıp boşa-harcama-adayı işaretleniyordu ve aracın SONRAKİ ADIM talimatı ajanı onu
   * negatif kelime yapmaya götürüyordu — yani DÖNÜŞÜM GETİREN terim dışlanıyordu.
   */
  const res = await terimRaporu([
    terimSatiri("gerçekte dönüşen terim", { cost_micros: 30_000_000, clicks: 10, conversions: null }),
    terimSatiri("temiz terim", { cost_micros: 10_000_000, clicks: 5, conversions: 0 }),
  ]);
  const olculemeyen = res.structuredContent.terimler.find((t: any) => t.terim === "gerçekte dönüşen terim");
  assert.equal(olculemeyen.israfAdayi, false, "ölçülemeyen terim israf adayı olamaz");
  assert.equal(olculemeyen.olculemedi, true, "ölçülemeyen satır ayrı kovada işaretlenmeli");
  assert.equal(olculemeyen.donusum, undefined, "okunamayan dönüşüm 0 diye yazılamaz");
  assert.equal(res.structuredContent.olculemeyenSatir, 1);
  assert.equal(res.structuredContent.toplamMaliyet, 10, "ölçülemeyen satırın maliyeti toplama girmez");
  assert.equal(res.structuredContent.israfYuzde, undefined, "payda eksikken oran üretilemez");

  const metin = String(res.content[0].text);
  const donusenSatiri = metin.split("\n").find((satir) => satir.includes("gerçekte dönüşen terim"))!;
  assert.doesNotMatch(donusenSatiri, /boşa-harcama-adayı/, "ölçülemeyen terim boşa-harcama-adayı diye sunulamaz");
  assert.match(metin, /ÖLÇÜLEMEDİ/);
  assert.match(metin, /1 terimin maliyeti\/dönüşümü OKUNAMADI/, "oranın tabanı açıkça söylenmeli");
});

test("search_terms_report: MALİYETİ okunamayan gerçek israf sessizce temize çıkmaz", async () => {
  const res = await terimRaporu([
    terimSatiri("pahalı ama ölçülemeyen", { cost_micros: undefined, clicks: 40, conversions: 0 }),
    terimSatiri("temiz terim", { cost_micros: 10_000_000, clicks: 5, conversions: 2 }),
  ]);
  const t = res.structuredContent.terimler.find((x: any) => x.terim === "pahalı ama ölçülemeyen");
  assert.equal(t.maliyet, undefined, "okunamayan maliyet 0 diye yazılamaz");
  assert.equal(t.olculemedi, true);
  assert.equal(t.israfAdayi, false, "maliyeti bilinmeyen terim hakkında israf kararı verilemez");
  assert.equal(res.structuredContent.israfYuzde, undefined);
  const metin = String(res.content[0].text);
  assert.match(metin, /pahalı ama ölçülemeyen/, "terim rapordan silinmemeli, ölçülemedi diye işaretlenmeli");
  assert.match(metin, /maliyet: OKUNAMADI/);
});

test("search_terms_report: her satır ölçülebiliyorsa oran ESKİSİ GİBİ yazılır", async () => {
  const res = await terimRaporu([
    terimSatiri("israf", { cost_micros: 75_000_000, clicks: 30, conversions: 0 }),
    terimSatiri("dönüşen", { cost_micros: 25_000_000, clicks: 10, conversions: 3 }),
  ]);
  assert.equal(res.structuredContent.israfYuzde, 75);
  assert.equal(res.structuredContent.olculemeyenSatir, undefined, "ölçülemeyen yoksa alan hiç yazılmaz");
});

test("keyword_performance: okunamayan maliyet/dönüşüm 0 diye raporlanmaz", async () => {
  const { ctx } = sahteContext({
    queries: [
      [
        /FROM keyword_view/,
        [
          {
            campaign: { name: "K" },
            ad_group: { name: "G" },
            ad_group_criterion: { keyword: { text: "anime izle", match_type: enums.KeywordMatchType.EXACT } },
            metrics: { cost_micros: null, clicks: 12, conversions: "" },
          },
        ],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: "keyword_performance", arguments: { customerId: MUSTERI } });
  const k = res.structuredContent.kelimeler[0];
  assert.notEqual(res.isError, true);
  assert.equal(k.maliyet, undefined, "okunamayan maliyet bedava kelime gibi görünemez");
  assert.equal(k.donusum, undefined);
  assert.equal(k.tiklama, 12, "okunabilen alan yerinde kalır");
  assert.deepEqual(k.okunamayanAlanlar, ["maliyet", "donusum"]);
  const metin = String(res.content[0].text);
  assert.match(metin, /maliyet: OKUNAMADI/);
  assert.doesNotMatch(metin, /maliyet: 0\.00/, "0.00 okuyan ajan kelimeyi ölü sanıp durdurur");
});
