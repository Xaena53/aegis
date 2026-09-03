import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { enums } from "google-ads-api";
import { sahteContext, baglanti, cagir } from "./helpers/harness.js";

/**
 * Documented guarantees, executed.
 *
 * The README, SECURITY.md, the limits resource and the tool descriptions all make
 * concrete promises to the user. Each one is mapped here to behaviour that must hold;
 * if a promise loses its implementation, a test goes red.
 *
 * Documentation drifting from behaviour is a silent failure — the user trusts what is
 * written, and nothing else reports the gap.
 */

const M = "1234567890";
const AG = "200057393038";
const K = "24120539226";

const PAUSED: Array<[RegExp, any[]]> = [
  [/FROM ad_group\b/, [{ campaign: { id: 1, name: "Taslak", status: enums.CampaignStatus.PAUSED } }]],
];

test("promise: 'Kampanyalar her zaman duraklatılmış oluşturulur; hiçbir araç kendiliğinden harcama başlatmaz'", async () => {
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
   * The second half of the promise: spending is governed by the campaign status.
   * Ad groups and keywords are created ENABLED, which is both correct and necessary —
   * an ENABLED ad group inside a paused campaign serves nothing, yet it has to be ready
   * to run the moment the campaign is approved. The one thing that matters is that the
   * setup flow never enables a campaign.
   */
  const kampanyaOps = ops.filter((o) => o.entity === "campaign");
  assert.equal(kampanyaOps.length, 1);
  assert.notEqual(kampanyaOps[0].resource.status, enums.CampaignStatus.ENABLED);
  // And the setup flow never touches a campaign status anywhere
  assert.equal(
    rec.mutations.filter((m) => m.kind === "campaigns").length,
    0,
    "kurulum, kampanya durumuna dokunmamalı — yayına alma ayrı ve onaylı bir adımdır"
  );
});

test("promise: 'Bütçe azaltma ve negatif kelime onay gerektirmez' (harcamayı düşürür)", async () => {
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

  /**
   * MUAFİYETİN DAYANAĞI PAYLOAD'DIR, YANIT METİNİ DEĞİL.
   *
   * Bu araçlar onay istemiyorsa bunun tek gerekçesi "eklenen ölçüt NEGATİF, yani
   * harcamayı azaltıyor"dur. Oysa iddiaların hepsi yanıt metnine bakıyordu ve o metin
   * ARGÜMANDAN üretiliyor: `negative` bayrağı payload'dan düşse araç yayındaki
   * kampanyaya POZİTİF kelime yazar, harcamayı ARTIRIR ve hâlâ "negatif eklendi" der.
   * Bayrağın Google'a giden gövdede olduğu doğrudan çivilenir.
   */
  const kampanyaNegatifi = b.rec.mutations[0].payload as any[];
  assert.equal(kampanyaNegatifi[0].negative, true, "kampanya ölçütü GERÇEKTEN negatif olarak yazılmalı");
  assert.ok(
    !("status" in kampanyaNegatifi[0]),
    "negatif ölçüt status taşımamalı (Google reddeder; status'lü bir ölçüt pozitif ölçüttür)"
  );

  const d = sahteContext({ queries: PAUSED });
  const cd = await baglanti(d.ctx);
  assert.match(
    await cagir(cd, "add_keywords", { customerId: M, adGroupId: AG, keywords: ["bedava"], negative: true }),
    /negatif anahtar kelime eklendi/
  );
  assert.equal(d.rec.mutations.length, 1, "reklam grubu negatifi onaysız geçmeli");
  const grupNegatifi = d.rec.mutations[0].payload as any[];
  assert.equal(grupNegatifi[0].negative, true, "reklam grubu ölçütü GERÇEKTEN negatif olarak yazılmalı");
  assert.ok(!("status" in grupNegatifi[0]), "negatif ölçüt status taşımamalı");
});

test("promise: POZİTİF kelime negatif bayrağını ASLA taşımaz (muafiyetin öteki yüzü)", async () => {
  /**
   * Üstteki testin ikizi. Negatif bayrağı payload'a KOŞULSUZ eklenirse (ör. bir
   * refactor'da `negative: true` koşulun dışına taşınırsa) kullanıcının istediği pozitif
   * kelime sessizce negatife döner: kampanya yayında kalır ama trafiği kesilir. Bu da
   * en az tersi kadar sessiz bir arızadır, o yüzden iki yön de çivilenir.
   */
  const { ctx, rec } = sahteContext({ queries: PAUSED });
  const c = await baglanti(ctx);
  assert.match(
    await cagir(c, "add_keywords", { customerId: M, adGroupId: AG, keywords: ["sigorta"] }),
    /anahtar kelime eklendi/
  );
  const pozitif = (rec.mutations[0].payload as any[])[0];
  assert.equal(pozitif.negative, undefined, "pozitif kelime negatif bayrağı taşımamalı");
  assert.equal(pozitif.status, enums.AdGroupCriterionStatus.ENABLED, "pozitif ölçüt ENABLED status ile yazılır");
});

test("promise: 'Ülke hedefleme zorunlu — dünya-geneli kazara yayın engellenir'", async () => {
  const { ctx, rec } = sahteContext();
  const c = await baglanti(ctx);
  const res: any = await c.callTool({
    name: "create_search_campaign",
    arguments: { customerId: M, name: "T", dailyBudget: 10, keywords: ["a"] },
  });
  assert.equal(res.isError, true, "countryCodes olmadan kampanya kurulamamalı");
  assert.equal(rec.mutations.length, 0);
});

test("promise: 'Paylaşımlı bütçeye dokunulmaz'", async () => {
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

test("promise: 'Yazma kapalıysa ajan yalnız rapor okuyabilir'", async () => {
  const { ctx, rec } = sahteContext({ writeEnabled: false, queries: [[/.*/, []]] });
  const c = await baglanti(ctx);
  // Reads go through
  assert.doesNotMatch(await cagir(c, "campaign_performance", { customerId: M }), /devre dışı/);
  assert.doesNotMatch(await cagir(c, "search_terms_report", { customerId: M }), /devre dışı/);
  // Writes are blocked
  assert.match(await cagir(c, "add_campaign_negative_keywords", { customerId: M, campaignId: K, keywords: ["x"] }), /devre dışı/);
  assert.equal(rec.mutations.length, 0);
});

test("promise: 'limits kaynağındaki her kural gerçekten uygulanıyor'", async () => {
  // Kelepçe raporu artık erişilebilirliği kanıtlanmış hesap ister (bkz. resources.ts).
  const { ctx } = sahteContext({
    maxDailyBudget: 77,
    writeEnabled: false,
    queries: [[/FROM customer\b/, [{ customer: { id: 1466231519 } }]]],
  });
  const c = await baglanti(ctx);
  const res: any = await c.readResource({ uri: "adspilot://accounts/1466231519/limits" });
  const veri = JSON.parse(res.contents[0].text);

  // The values the resource reports come from the live context, not from defaults
  assert.equal(veri.gunlukButceTavani, 77);
  assert.equal(veri.yazmaIzni, false);

  // Every rule sentence is backed by a test:
  const kurallar = veri.kurallar.join(" ");
  assert.match(kurallar, /duraklatılmış/); // → first test in this file
  assert.match(kurallar, /Yayına alma ve bütçe ARTIŞI/); // → failclosed.test.ts
  assert.match(kurallar, /YAYINDAKİ/); // → failclosed.test.ts
  assert.match(kurallar, /negatif anahtar kelime ekleme onay gerektirmez/); // → second test in this file
  assert.match(kurallar, /ajan kendi limitini değiştiremez/); // → http.test.ts
  assert.match(kurallar, /tek KAMPANYA başınadır/); // → the test below
});

test("honesty: bütçe tavanı KAMPANYA başınadır, hesap toplamı DEĞİL", async () => {
  // The limits resource states this boundary outright, so the behaviour must match it.
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

test("promise: 'analyze_site çıktısı güvenilmez blokta sunulur ve sahte etiket temizlenir'", async () => {
  // The promise is checked over the protocol and against the shipped source. A test that
  // re-implements the sanitization regex inline only measures its own copy of it.
  const { ctx } = sahteContext();
  const c = await baglanti(ctx);
  const kaynak = readFileSync("src/tools/site.ts", "utf8");

  // Does the tool description make the promise?
  const { tools }: any = await c.listTools();
  const site = tools.find((t: any) => t.name === "analyze_site");
  assert.match(site.description, /GÜVENİLMEZ/);

  // Does the code keep it? Checked without network access: sanitization plus block delimiters
  assert.match(kaynak, /<site-verisi>/, "güvenilmez veri bloğu açılmalı");
  assert.match(kaynak, /ayracTemizle\(/, "sayfadan gelen metin ayraç temizleyicisinden geçmeli");
  /**
   * UZUNLUK SINIRLI desen geri gelmemeli. Eski temizleyici `[^>]{0,200}` idi ve o sınırın
   * kendisi bir kapıydı: 201 karakterlik dolgu deseni ıskalatıyor, sayfa <site-verisi>
   * bloğunu sunucudan ÖNCE kapatabiliyordu. Bu kaynak taraması yalnız bir kelepçe;
   * davranışsal kanıt site.test.ts'teki dolgu tablosunda (0/199/200/201/5000).
   */
  const siteExtractKaynak = readFileSync("src/siteExtract.ts", "utf8");
  for (const [ad, k] of [["site.ts", kaynak], ["siteExtract.ts", siteExtractKaynak]] as const) {
    assert.doesNotMatch(k, /site-verisi\[\^>\]\{0,\d+\}/, `${ad}: uzunluk sınırlı desen geri gelmemeli`);
  }
  assert.match(kaynak, /talimat/i, "ajana 'talimatları uygulama' uyarısı verilmeli");
});

test("promise: 'mutasyonlar ağ hatasında retry EDİLMEZ; tek istisna CONCURRENT_MODIFICATION'", async () => {
  const { isConcurrentModificationError, isTransientAdsError } = await import("../src/util.js");
  // A network error is transient enough to retry a read, but never a mutation
  assert.equal(isTransientAdsError({ code: 14, message: "UNAVAILABLE" }), true);
  assert.equal(isConcurrentModificationError({ code: 14, message: "UNAVAILABLE" }), false);
  // CONCURRENT_MODIFICATION is the single class that is safe to replay on a mutation
  assert.equal(isConcurrentModificationError({ errors: [{ error_code: { database_error: 2 } }] }), true);
});

test("promise: MCP instructions'taki kurallar araç davranışıyla tutarlı", async () => {
  const { ctx } = sahteContext();
  const c = await baglanti(ctx);
  const instructions = (c.getInstructions?.() ?? "") as string;
  if (!instructions) return; // skip when the client version does not expose them

  assert.match(instructions, /DURAKLATILMIŞ/);
  assert.match(instructions, /onay/i);
  assert.match(instructions, /GÜVENİLMEZ/);
  // AGPL §13: the source link has to be offered on the MCP surface too
  assert.match(instructions, /https?:\/\//, "kaynak kod adresi bildirilmeli");
});
