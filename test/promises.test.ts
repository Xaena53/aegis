import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { enums } from "google-ads-api";
import { sahteContext, baglanti, cagir } from "./helpers/harness.js";

/**
 * VERİLEN SÖZLERİN DOĞRULANMASI
 *
 * README, SECURITY.md, araç açıklamaları ve `limits` kaynağı kullanıcıya somut
 * sözler veriyor. Bu dosya her sözü ÇALIŞAN DAVRANIŞLA eşleştirir: bir söz
 * kodda karşılıksız kalırsa test kırmızıya döner.
 *
 * Belge ile davranışın ayrışması sessiz bir hatadır — kullanıcı yazana güvenir.
 */

const M = "1234567890";
const AG = "200057393038";
const K = "24120539226";

const PAUSED: Array<[RegExp, any[]]> = [
  [/FROM ad_group\b/, [{ campaign: { id: 1, name: "Taslak", status: enums.CampaignStatus.PAUSED } }]],
];

test("SÖZ: 'Kampanyalar her zaman duraklatılmış oluşturulur; hiçbir araç kendiliğinden harcama başlatmaz'", async () => {
  const { ctx, rec } = sahteContext();
  const c = await baglanti(ctx);
  await cagir(c, "create_search_campaign", {
    customerId: M,
    name: "T",
    dailyBudget: 10,
    keywords: ["a"],
    countryCodes: ["TR"],
  });
  const ops = rec.mutations.find((m) => m.kind === "mutateResources")!.payload as any[];
  const kampanya = ops.find((o) => o.entity === "campaign").resource;
  assert.equal(kampanya.status, enums.CampaignStatus.PAUSED);

  /**
   * Sözün ikinci yarısı: harcamayı KAMPANYA durumu belirler. Reklam grubu ve
   * kelimeler ENABLED doğar — bu doğrudur ve gereklidir: duraklatılmış bir
   * kampanya içindeki ENABLED reklam grubu yayın YAPMAZ, ama kampanya onayla
   * açıldığı anda çalışır hâlde olmalıdır. Kritik olan tek şey, kurulum
   * akışının hiçbir KAMPANYA'yı yayına almamasıdır.
   */
  const kampanyaOps = ops.filter((o) => o.entity === "campaign");
  assert.equal(kampanyaOps.length, 1);
  assert.notEqual(kampanyaOps[0].resource.status, enums.CampaignStatus.ENABLED);
  // Ve kurulum akışı hiçbir yerde kampanya durumu GÜNCELLEMEZ
  assert.equal(
    rec.mutations.filter((m) => m.kind === "campaigns").length,
    0,
    "kurulum, kampanya durumuna dokunmamalı — yayına alma ayrı ve onaylı bir adımdır"
  );
});

test("SÖZ: 'Bütçe azaltma ve negatif kelime onay gerektirmez' (harcamayı düşürür)", async () => {
  const butce: Array<[RegExp, any[]]> = [
    [
      /campaign_budget\.explicitly_shared/,
      [{ campaign: { name: "K" }, campaign_budget: { resource_name: "r", amount_micros: 100_000_000, explicitly_shared: false } }],
    ],
  ];
  const a = sahteContext({ queries: butce });
  const ca = await baglanti(a.ctx);
  assert.match(await cagir(ca, "update_campaign_budget", { customerId: M, campaignId: K, newDailyBudget: 40 }), /güncellendi/);
  assert.equal(a.rec.mutations.length, 1, "azaltma onaysız geçmeli");

  const b = sahteContext();
  const cb = await baglanti(b.ctx);
  assert.match(
    await cagir(cb, "add_campaign_negative_keywords", { customerId: M, campaignId: K, keywords: ["ücretsiz"] }),
    /eklendi/
  );
  assert.equal(b.rec.mutations.length, 1, "kampanya negatifi onaysız geçmeli");

  const d = sahteContext({ queries: PAUSED });
  const cd = await baglanti(d.ctx);
  assert.match(
    await cagir(cd, "add_keywords", { customerId: M, adGroupId: AG, keywords: ["bedava"], negative: true }),
    /negatif anahtar kelime eklendi/
  );
  assert.equal(d.rec.mutations.length, 1, "reklam grubu negatifi onaysız geçmeli");
});

test("SÖZ: 'Ülke hedefleme zorunlu — dünya-geneli kazara yayın engellenir'", async () => {
  const { ctx, rec } = sahteContext();
  const c = await baglanti(ctx);
  const res: any = await c.callTool({
    name: "create_search_campaign",
    arguments: { customerId: M, name: "T", dailyBudget: 10, keywords: ["a"] },
  });
  assert.equal(res.isError, true, "countryCodes olmadan kampanya kurulamamalı");
  assert.equal(rec.mutations.length, 0);
});

test("SÖZ: 'Paylaşımlı bütçeye dokunulmaz'", async () => {
  const { ctx, rec } = sahteContext({
    queries: [
      [
        /campaign_budget\.explicitly_shared/,
        [{ campaign: { name: "Ortak" }, campaign_budget: { resource_name: "r", amount_micros: 50_000_000, explicitly_shared: true } }],
      ],
    ],
  });
  const c = await baglanti(ctx);
  assert.match(await cagir(c, "update_campaign_budget", { customerId: M, campaignId: K, newDailyBudget: 40 }), /PAYLAŞIMLI/);
  assert.equal(rec.mutations.length, 0);
});

test("SÖZ: 'Yazma kapalıysa ajan yalnız rapor okuyabilir'", async () => {
  const { ctx, rec } = sahteContext({ writeEnabled: false, queries: [[/.*/, []]] });
  const c = await baglanti(ctx);
  // Okuma çalışmalı
  assert.doesNotMatch(await cagir(c, "campaign_performance", { customerId: M }), /devre dışı/);
  assert.doesNotMatch(await cagir(c, "search_terms_report", { customerId: M }), /devre dışı/);
  // Yazma engellenmeli
  assert.match(await cagir(c, "add_campaign_negative_keywords", { customerId: M, campaignId: K, keywords: ["x"] }), /devre dışı/);
  assert.equal(rec.mutations.length, 0);
});

test("SÖZ: 'limits kaynağındaki her kural gerçekten uygulanıyor'", async () => {
  const { ctx } = sahteContext({ maxDailyBudget: 77, writeEnabled: false });
  const c = await baglanti(ctx);
  const res: any = await c.readResource({ uri: "adspilot://accounts/1466231519/limits" });
  const veri = JSON.parse(res.contents[0].text);

  // Kaynağın bildirdiği değerler gerçek context'ten gelmeli
  assert.equal(veri.gunlukButceTavani, 77);
  assert.equal(veri.yazmaIzni, false);

  // Her kural cümlesinin bu dosyada karşılığı olan bir testi var:
  const kurallar = veri.kurallar.join(" ");
  assert.match(kurallar, /duraklatılmış/); // → 1. test
  assert.match(kurallar, /Yayına alma ve bütçe ARTIŞI/); // → failclosed.test.ts
  assert.match(kurallar, /YAYINDAKİ/); // → failclosed.test.ts
  assert.match(kurallar, /negatif anahtar kelime ekleme onay gerektirmez/); // → 2. test
  assert.match(kurallar, /ajan kendi limitini değiştiremez/); // → http.test.ts
  assert.match(kurallar, /tek KAMPANYA başınadır/); // → aşağıdaki test
});

test("SÖZ dürüstlüğü: bütçe tavanı KAMPANYA başınadır, hesap toplamı DEĞİL", async () => {
  // Bu sınırı kaynakta açıkça yazıyoruz; davranışın da öyle olduğunu kanıtla.
  const { ctx, rec } = sahteContext({ maxDailyBudget: 100 });
  const c = await baglanti(ctx);
  for (let i = 0; i < 3; i++) {
    await cagir(c, "create_search_campaign", {
      customerId: M,
      name: `K${i}`,
      dailyBudget: 100,
      keywords: ["a"],
      countryCodes: ["TR"],
    });
  }
  assert.equal(rec.mutations.length, 3, "her biri tavanda 3 kampanya kurulabiliyor (bilinen ve BELGELENEN sınır)");
});

test("SÖZ: 'analyze_site çıktısı güvenilmez blokta sunulur ve sahte etiket temizlenir'", async () => {
  // Bu sözü PROTOKOL üzerinden doğrula: eval'deki eski test sanitizasyon
  // regex'ini kendi içinde yeniden yazdığı için gerçek kodu ölçmüyordu.
  const { ctx } = sahteContext();
  const c = await baglanti(ctx);
  const kaynak = readFileSync("src/tools/site.ts", "utf8");

  // Araç açıklaması sözü veriyor mu?
  const { tools }: any = await c.listTools();
  const site = tools.find((t: any) => t.name === "analyze_site");
  assert.match(site.description, /GÜVENİLMEZ/);

  // Kod bu sözü uyguluyor mu? (ağa çıkmadan: sanitizasyonun varlığı + blok sınırları)
  assert.match(kaynak, /<site-verisi>/, "güvenilmez veri bloğu açılmalı");
  assert.match(kaynak, /<\\s\*\\\/\?\\s\*site-verisi\[\^>\]\{0,200\}>/, "sahte kapanış etiketi gevşek desenle temizlenmeli");
  assert.match(kaynak, /talimat/i, "ajana 'talimatları uygulama' uyarısı verilmeli");
});

test("SÖZ: 'mutasyonlar ağ hatasında retry EDİLMEZ; tek istisna CONCURRENT_MODIFICATION'", async () => {
  const { isConcurrentModificationError, isTransientAdsError } = await import("../src/util.js");
  // Ağ hatası: okuma retry'ı için geçici, mutasyon retry'ı için DEĞİL
  assert.equal(isTransientAdsError({ code: 14, message: "UNAVAILABLE" }), true);
  assert.equal(isConcurrentModificationError({ code: 14, message: "UNAVAILABLE" }), false);
  // CONCURRENT_MODIFICATION: mutasyonda güvenle tekrarlanabilir
  assert.equal(isConcurrentModificationError({ errors: [{ error_code: { database_error: 2 } }] }), true);
});

test("SÖZ: MCP instructions'taki kurallar araç davranışıyla tutarlı", async () => {
  const { ctx } = sahteContext();
  const c = await baglanti(ctx);
  const instructions = (c.getInstructions?.() ?? "") as string;
  if (!instructions) return; // istemci sürümü desteklemiyorsa atla

  assert.match(instructions, /DURAKLATILMIŞ/);
  assert.match(instructions, /onay/i);
  assert.match(instructions, /GÜVENİLMEZ/);
  // AGPL §13: kaynak bağlantısı MCP yüzeyinde de sunulmalı
  assert.match(instructions, /https?:\/\//, "kaynak kod adresi bildirilmeli");
});
