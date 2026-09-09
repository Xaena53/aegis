// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 4 — src/tools/read.ts: an unreadable enum is not a value.
 *
 * campaign_performance built its `durum` and `kanal` fields with
 * `String(tablo[x] ?? x)`. Measured on the production path before the fix, the row
 * `{campaign:{id:7,name:"Gizemli"}, campaign_budget:{}, metrics:{}}` came back as
 * `{id:"7", ad:"Gizemli", durum:"undefined", kanal:"undefined", okunamayanAlanlar:[...]}`
 * and printed `#7 Gizemli [undefined] (undefined)`. Two separate breaches of this
 * repository's rule that an unknown is never dressed as a value:
 *
 *   1. "undefined" is written into the one field an agent reads to answer "is this
 *      campaign running" — and it is a STRING, so every strict consumer accepts it.
 *   2. Neither field lives in `alanlar`, so neither reached `okunamayanAlanlar`: the same
 *      row admitted its unreadable MONEY fields honestly while staying silent about the
 *      unknown status. The list of unreadable fields was incomplete.
 *
 * The reverse-lookup pitfall runs the other way too: `CampaignStatus["ENABLED"]` is `2`,
 * so a status arriving as its NAME was reported as `durum:"2"` — a number invented out of
 * a perfectly readable value.
 *
 * These tests pin BOTH directions. Dropping the field is only right when the value really
 * cannot be read: a guard that swallowed readable statuses would empty the table, which is
 * the same lie with the opposite sign, so the readable cases are pinned just as hard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { enums } from "google-ads-api";
import { sahteContext, baglanti } from "./helpers/harness.js";

const MUSTERI = "1234567890";

/** Full metrics, so only the enum fields under test can ever be the unreadable ones. */
const TAM_METRIK = {
  cost_micros: 12_500_000,
  clicks: 10,
  impressions: 100,
  conversions: 2,
  ctr: 0.1,
  average_cpc: 1_250_000,
};

/** Runs campaign_performance over the given rows and returns what the agent sees. */
async function rapor(satirlar: any[]) {
  const { ctx } = sahteContext({ queries: [[/FROM campaign\b/, satirlar]] });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: "campaign_performance", arguments: { customerId: MUSTERI } });
  return { res, k: res.structuredContent?.kampanyalar?.[0], metin: String(res.content?.[0]?.text ?? "") };
}

function satir(campaign: any) {
  return { campaign, campaign_budget: { amount_micros: 50_000_000 }, metrics: TAM_METRIK };
}

/* ── The unreadable direction: the field is not written and the unknown is announced ── */

const okunamazVakalar: Array<[string, any]> = [
  ["alan hiç gelmedi", { id: 7, name: "Gizemli" }],
  ["null geldi", { id: 7, name: "Gizemli", status: null, advertising_channel_type: null }],
  ["enum dışı sayı", { id: 7, name: "Gizemli", status: 999, advertising_channel_type: 998 }],
  ["sayısal dize", { id: 7, name: "Gizemli", status: "2", advertising_channel_type: "2" }],
  ["tanınmayan ad", { id: 7, name: "Gizemli", status: "YAYINDA", advertising_channel_type: "ARAMA" }],
  ["nesne geldi", { id: 7, name: "Gizemli", status: {}, advertising_channel_type: [] }],
];

for (const [ad, campaign] of okunamazVakalar) {
  test(`KRİTİK: durum/kanal okunamıyorsa (${ad}) "undefined" YAZILMAZ`, async () => {
    const { res, k, metin } = await rapor([satir(campaign)]);

    assert.notEqual(res.isError, true, `${ad}: tek okunamayan enum tüm raporu düşürmemeli`);
    assert.equal(k.durum, undefined, `${ad}: okunamayan durum JSON'a yazılamaz`);
    assert.equal(k.kanal, undefined, `${ad}: okunamayan kanal JSON'a yazılamaz`);
    assert.ok(
      !("durum" in k) && !("kanal" in k),
      `${ad}: alan "boş" değil YOK olmalı — 'var ama boş' ile 'yok' şemada aynı şey değildir`
    );
    // The literal text is the finding's own scenario: an unknown wearing a value's clothes.
    assert.notEqual(k.durum, "undefined", `${ad}: 'undefined' METNİ geçerli bir durum kılığındadır`);
    assert.notEqual(k.kanal, "undefined", `${ad}: 'undefined' METNİ geçerli bir kanal kılığındadır`);

    assert.ok(
      k.okunamayanAlanlar?.includes("durum") && k.okunamayanAlanlar?.includes("kanal"),
      `${ad}: okunamayan alan listesi durum ve kanalı SAYMALI — ` +
        `eksik liste, satırın para alanları için dürüst olup durum için susması demektir ` +
        `(gelen: ${JSON.stringify(k.okunamayanAlanlar)})`
    );

    assert.doesNotMatch(metin, /\[undefined\]|\(undefined\)/, `${ad}: insan-okur satırda da 'undefined' yazamaz`);
    assert.match(metin, /\[OKUNAMADI — ETKİN varsayma\]/, `${ad}: metin durumu bilmediğini SÖYLEMELİ`);
    assert.match(metin, /\(OKUNAMADI\)/, `${ad}: metin kanalı bilmediğini SÖYLEMELİ`);
    // The row is not thrown away: its readable fields are still worth reporting.
    assert.equal(k.gunlukButce, 50, `${ad}: okunabilen alanlar satırda kalmalı`);
    assert.equal(k.maliyet, 12.5, `${ad}: satır tümden atılmamalı`);
  });
}

/* ── The readable direction: a valid value must SURVIVE, in both wire shapes ── */

test("okunabilen durum/kanal yazılır ve okunamayan alan sayılmaz (bekçi geçerli satırı yutmuyor)", async () => {
  /**
   * The opposite failure: a guard that refused everything would empty the table and every
   * campaign would read as "state unknown" — the same lie with the opposite sign. `durum`
   * must still be reported and must NOT be counted as unreadable.
   */
  const { res, k, metin } = await rapor([
    satir({
      id: 7,
      name: "Kampanyam",
      status: enums.CampaignStatus.PAUSED,
      advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
    }),
  ]);
  assert.notEqual(res.isError, true);
  assert.equal(k.durum, "PAUSED", "sayısal enum ADA çevrilmeli");
  assert.equal(k.kanal, "SEARCH");
  assert.equal(k.okunamayanAlanlar, undefined, "her alan okunduysa okunamayan-alan listesi hiç yazılmaz");
  assert.match(metin, /\[PAUSED\] \(SEARCH\)/, "insan-okur satır enum ADINI göstermeli");
  assert.doesNotMatch(metin, /OKUNAMADI/, "okunabilen satırda yanlış alarm basılamaz");
});

test("KRİTİK: durum ADI olarak gelirse ters arama devreye girmez ('2' UYDURULMAZ)", async () => {
  /**
   * `enums.CampaignStatus["ENABLED"] === 2`, so the old `tablo[x] ?? x` expression turned a
   * perfectly readable name into the number 2 and reported `durum:"2"`. Measured before the
   * fix: `{status:"ENABLED", advertising_channel_type:"SEARCH"}` printed `[2] (2)`.
   */
  assert.equal((enums.CampaignStatus as any)["ENABLED"], 2, "ters eşleme varsayımı bayatlarsa bu test de bayatlar");

  const { k, metin } = await rapor([satir({ id: 8, name: "AdIle", status: "ENABLED", advertising_channel_type: "SEARCH" })]);
  assert.equal(k.durum, "ENABLED", "enum'un TANIDIĞI ad olduğu gibi raporlanmalı");
  assert.equal(k.kanal, "SEARCH");
  assert.notEqual(k.durum, "2", "okunabilir bir durumdan sayı UYDURULAMAZ");
  assert.match(metin, /\[ENABLED\] \(SEARCH\)/);
});

test("bozuk enum komşu satıra bulaşmaz", async () => {
  const { res } = await rapor([
    satir({ id: 7, name: "Bilinmeyen", status: 999, advertising_channel_type: 998 }),
    satir({
      id: 8,
      name: "Sağlam",
      status: enums.CampaignStatus.ENABLED,
      advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
    }),
  ]);
  const [ilk, ikinci] = res.structuredContent.kampanyalar;
  assert.equal(ilk.durum, undefined, "okunamayan satırın durumu yazılamaz");
  assert.equal(ikinci.durum, "ENABLED", "sağlam komşu satır etkilenmemeli");
  assert.equal(ikinci.kanal, "SEARCH");
  assert.equal(ikinci.okunamayanAlanlar, undefined);
  assert.equal(res.structuredContent.sekliBozukSatir, undefined, "enum okunamaması satırı DÜŞÜRMEZ, sayaç artmamalı");
});

/* ── Schema side: the drop only fits through the schema if the fields are optional ── */

test("outputSchema durum/kanal alanlarını ZORUNLU bildirmez (şema-davranış çifti)", async () => {
  /**
   * BIDIRECTIONAL, like faz3Read's schema watcher. If these two go back to being required,
   * the "do not write the field" behaviour above stops fitting through MCP's own output
   * validation and the tool starts failing — or worse, someone re-adds `String(...)` to
   * satisfy the schema and the finding comes straight back.
   */
  const { ctx } = sahteContext({ queries: [[/.*/, []]] });
  const c = await baglanti(ctx);
  const tools = (await c.listTools()).tools as any[];
  const kmp = tools.find((t) => t.name === "campaign_performance")?.outputSchema?.properties?.kampanyalar?.items;
  assert.ok(kmp?.properties?.durum, "kampanya durumu şemada bildirilmeli");
  assert.ok(kmp?.properties?.kanal, "kampanya kanalı şemada bildirilmeli");
  const zorunlu: string[] = kmp?.required ?? [];
  assert.ok(!zorunlu.includes("durum"), "durum ZORUNLU kalırsa 'okunamadı' hâli şemaya sığmaz");
  assert.ok(!zorunlu.includes("kanal"), "kanal ZORUNLU kalırsa 'okunamadı' hâli şemaya sığmaz");
  assert.ok(zorunlu.includes("id") && zorunlu.includes("ad"), "id/ad hâlâ zorunlu olmalı — şema tümden gevşetilmiş olamaz");
});
