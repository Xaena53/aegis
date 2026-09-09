// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 5A — src/tools/read.ts: the two holes the independent auditors measured.
 *
 * KUSUR 1 (search_terms_report). FAZ 3 closed "an unread status must not become
 * `zatenDislanmis: false`" with a SHAPE check — `typeof stName !== "string"` over
 * `enums[status] ?? status`. Measured on the production path before this fix,
 * `search_term_view.status = 0` and `= 1` still came back as
 * `{...,"israfAdayi":true,"zatenDislanmis":false}` with no warning in the text. The reason
 * is in the SDK itself: `SearchTermTargetingStatus` maps 0 and 1 back to the STRINGS
 * "UNSPECIFIED" and "UNKNOWN", so both passed the shape check and fell into the name
 * comparison, which answers "no". Those two members are exactly how the Google Ads API
 * says "I cannot express this value in this version" — the status was NOT read, and
 * `zatenDislanmis: false` is a positive claim on the one flag the NEXT STEP instruction
 * reads before proposing a negative keyword. Writing this file surfaced a THIRD door in
 * the same class: the `?? status` fallback passed any UNRECOGNISED string straight through
 * as if it were an enum name, so a status arriving as "YAYINDA" was also answered "not
 * excluded".
 *
 * KUSUR 2 (campaign_performance). Three lines above the FAZ 4 enum fix, the same class
 * stood untouched: `id: String(r.campaign.id)` / `ad: String(r.campaign.name)`. Measured:
 * `{campaign:{}}` produced `{"id":"undefined","ad":"undefined",...,"okunamayanAlanlar":
 * ["durum","kanal"]}` and printed `#undefined undefined [OKUNAMADI — ETKİN varsayma]`.
 * One object, two standards: honest about the status, dressing an unknown as an identity —
 * and `okunamayanAlanlar` did not count it, so nothing announced the gap. The identity is
 * a PRECONDITION rather than a field, so the two halves part ways: a row whose id cannot
 * be read identifies no campaign and is refused into `sekliBozukSatir` (which already
 * shouts "Liste EKSİKTİR"), while a row whose NAME cannot be read is still addressable by
 * id and keeps its place with a self-declaring "(AD OKUNAMADI)" plus an entry in
 * `okunamayanAlanlar`.
 *
 * BOTH DIRECTIONS ARE PINNED. Refusing a value is only right when it really could not be
 * read; a guard that swallowed the READABLE statuses (or emptied every id) would be the
 * same lie with the opposite sign, and would leave these tests green while the tool
 * stopped saying anything. So every readable case is asserted just as hard as every
 * unreadable one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { enums } from "google-ads-api";
import { sahteContext, baglanti } from "./helpers/harness.js";

const MUSTERI = "1234567890";

/* ──────────────────────────────────────────────────────────────────────────
   KUSUR 1 — search_terms_report: the enum's OWN unknowns are unknowns
   ────────────────────────────────────────────────────────────────────────── */

/** Cost present, conversions zero: the row is a waste candidate, so the flag matters. */
const TERIM_METRIK = { cost_micros: 5_000_000, clicks: 10, conversions: 0 };

async function terimRaporu(status: unknown) {
  const { ctx } = sahteContext({
    queries: [
      [
        /FROM search_term_view/,
        [
          {
            campaign: { id: 1, name: "Kampanya" },
            ad_group: { id: 2, name: "Grup" },
            search_term_view: { search_term: "bedava indir", status },
            metrics: TERIM_METRIK,
          },
        ],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: "search_terms_report", arguments: { customerId: MUSTERI } });
  return { res, t: res.structuredContent?.terimler?.[0], metin: String(res.content?.[0]?.text ?? "") };
}

/**
 * The fact the shape check missed, pinned as a fact. If a future SDK stopped mapping 0/1
 * back to these names the guard below would silently stop covering anything, and this
 * assertion is what would say so instead of a green suite.
 */
test("KUSUR-1 dayanağı: SDK 0/1 için 'UNSPECIFIED'/'UNKNOWN' DİZGELERİNİ döndürür", () => {
  const tablo = enums.SearchTermTargetingStatus as any;
  assert.equal(tablo[0], "UNSPECIFIED", "ters arama 0 için dizge dönmüyorsa şekil kontrolü zaten yeterdi");
  assert.equal(tablo[1], "UNKNOWN", "ters arama 1 için dizge dönmüyorsa şekil kontrolü zaten yeterdi");
});

const bilinmeyenDurumlar: Array<[string, unknown]> = [
  ["UNSPECIFIED (0)", enums.SearchTermTargetingStatus.UNSPECIFIED],
  ["UNKNOWN (1)", enums.SearchTermTargetingStatus.UNKNOWN],
];

for (const [ad, status] of bilinmeyenDurumlar) {
  test(`KRİTİK: ${ad} bir CEVAP DEĞİL — zatenDislanmis YAZILMAZ, bilinmiyor DUYURULUR`, async () => {
    const { res, t, metin } = await terimRaporu(status);

    assert.notEqual(res.isError, true, `${ad}: okunamayan tek durum tüm raporu düşürmemeli`);
    assert.equal(t.zatenDislanmis, undefined, `${ad}: okunamayan durumdan "dışlanmamış" iddiası üretilemez`);
    assert.ok(
      !("zatenDislanmis" in t),
      `${ad}: alan "false" değil YOK olmalı — 'var ama false' ile 'yok' aynı şey değildir`
    );
    assert.equal(t.dislanmaDurumuBilinmiyor, true, `${ad}: bilinmezlik ilan edilmeli`);
    assert.match(
      metin,
      /DIŞLANMA DURUMU OKUNAMADI/,
      `${ad}: insan-okur satır da uyarmalı, yoksa yalnız JSON okuyan uyarılır`
    );
  });
}

/**
 * THE OPPOSITE SIGN. A "fix" that withheld the flag for every status would pass every
 * assertion above and quietly turn the tool mute — every already-excluded term would come
 * back as a fresh negative-keyword proposal. These four are genuine readings and must
 * survive untouched.
 */
const okunanDurumlar: Array<[string, unknown, boolean]> = [
  ["EXCLUDED", enums.SearchTermTargetingStatus.EXCLUDED, true],
  ["ADDED_EXCLUDED", enums.SearchTermTargetingStatus.ADDED_EXCLUDED, true],
  ["ADDED", enums.SearchTermTargetingStatus.ADDED, false],
  ["NONE", enums.SearchTermTargetingStatus.NONE, false],
];

for (const [ad, status, beklenen] of okunanDurumlar) {
  test(`${ad} OKUNABİLİR bir durumdur: bilinmiyor damgası vurulmaz`, async () => {
    const { t, metin } = await terimRaporu(status);

    assert.equal(t.zatenDislanmis, beklenen, `${ad}: okunan durum aynen raporlanmalı`);
    assert.equal(t.dislanmaDurumuBilinmiyor, undefined, `${ad}: okunan durum "bilinmiyor" diye damgalanamaz`);
    assert.doesNotMatch(metin, /DIŞLANMA DURUMU OKUNAMADI/, `${ad}: okunan durum için uyarı basılamaz`);
  });
}

/**
 * The unreadable-by-shape cases FAZ 3 already covered stay covered — no regression — and
 * the leak this file's own suite surfaced is pinned with them: the old `enums[x] ?? x`
 * fallback handed an UNRECOGNISED string ("YAYINDA") straight through as if it were a
 * status name, so it too was answered "not excluded". A numeric STRING is refused for the
 * mirror-image reason `enumAdi` documents: "3" resolves through the reverse map to
 * "EXCLUDED", a reading invented out of a value nobody sent as a number.
 */
test("şekli tanınmayan durum (enum dışı sayı, tanınmayan ad, sayısal dize, alan yok) bilinmiyor sayılır", async () => {
  for (const status of [999, undefined, null, {}, [], "YAYINDA", "3", "0", true]) {
    const { t } = await terimRaporu(status);
    assert.equal(t.dislanmaDurumuBilinmiyor, true, `${JSON.stringify(status)}: bilinmezlik ilan edilmeli`);
    assert.ok(!("zatenDislanmis" in t), `${JSON.stringify(status)}: bayrak yazılamaz`);
  }
});

/** A status arriving as its NAME is a genuine reading: this SDK maps it back to a number. */
test("durum ADIYLA geldiğinde okunur — bilinmiyor damgası vurulmaz", async () => {
  const dislanmis = await terimRaporu("ADDED_EXCLUDED");
  assert.equal(dislanmis.t.zatenDislanmis, true, "adıyla gelen ADDED_EXCLUDED okunmalı");
  assert.equal(dislanmis.t.dislanmaDurumuBilinmiyor, undefined, "okunan durum bilinmiyor sayılamaz");

  const eklenmis = await terimRaporu("ADDED");
  assert.equal(eklenmis.t.zatenDislanmis, false, "adıyla gelen ADDED de okunmalı");
  assert.equal(eklenmis.t.dislanmaDurumuBilinmiyor, undefined, "okunan durum bilinmiyor sayılamaz");
});

/* ──────────────────────────────────────────────────────────────────────────
   KUSUR 2 — campaign_performance: "undefined" is not an identity
   ────────────────────────────────────────────────────────────────────────── */

/** Full metrics and a readable budget, so only the identity can be the unreadable part. */
const TAM_METRIK = {
  cost_micros: 12_500_000,
  clicks: 10,
  impressions: 100,
  conversions: 2,
  ctr: 0.1,
  average_cpc: 1_250_000,
};

async function kampanyaRaporu(campaigns: any[]) {
  const satirlar = campaigns.map((campaign) => ({
    campaign,
    campaign_budget: { amount_micros: 50_000_000 },
    metrics: TAM_METRIK,
  }));
  const { ctx } = sahteContext({ queries: [[/FROM campaign\b/, satirlar]] });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: "campaign_performance", arguments: { customerId: MUSTERI } });
  return {
    res,
    veri: res.structuredContent,
    k: res.structuredContent?.kampanyalar?.[0],
    metin: String(res.content?.[0]?.text ?? ""),
  };
}

/** Status and channel are readable everywhere below, so only the identity is ever at issue. */
const OKUNUR_ENUM = {
  status: enums.CampaignStatus.ENABLED,
  advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
};

/**
 * A row whose ID cannot be read identifies NO campaign. It is refused into the list's own
 * fail-closed bucket rather than published as `#undefined`, and the refusal is COUNTED —
 * the alternative (a silently shorter table) is the very error `sekliBozukSatir` exists
 * to prevent.
 */
const kimliksizVakalar: Array<[string, any]> = [
  ["campaign tamamen boş", { ...OKUNUR_ENUM }],
  ["id yok", { ...OKUNUR_ENUM, name: "Yayındaki Kampanya" }],
  ["id null", { ...OKUNUR_ENUM, id: null, name: "Yayındaki Kampanya" }],
  ["id boş dizge", { ...OKUNUR_ENUM, id: "", name: "Yayındaki Kampanya" }],
  ["id NaN", { ...OKUNUR_ENUM, id: Number.NaN, name: "Yayındaki Kampanya" }],
  ["id nesne", { ...OKUNUR_ENUM, id: {}, name: "Yayındaki Kampanya" }],
  ["id dizi", { ...OKUNUR_ENUM, id: [], name: "Yayındaki Kampanya" }],
];

for (const [ad, campaign] of kimliksizVakalar) {
  test(`KRİTİK: kimliği okunamayan satır (${ad}) "#undefined" diye YAYIMLANMAZ, DÜŞER ve SAYILIR`, async () => {
    const { res, veri, metin } = await kampanyaRaporu([campaign]);

    assert.notEqual(res.isError, true, `${ad}: bozuk tek satır tüm raporu düşürmemeli`);
    assert.equal(veri.kampanyalar.length, 0, `${ad}: kimliksiz satır tabloya giremez`);
    assert.equal(veri.sekliBozukSatir, 1, `${ad}: düşen satır SAYILMALI — sessiz kısalma yasak`);
    assert.match(metin, /DÜŞTÜ/, `${ad}: liste kısaldıysa okur uyarılmalı`);
    assert.match(metin, /EKSİKTİR/, `${ad}: "listede yok = yok" sonucuna karşı uyarı durmalı`);
    // The finding's own scenario: the literal text passing itself off as a value.
    assert.doesNotMatch(metin, /#undefined/, `${ad}: "#undefined" bir kampanya numarası gibi okunur`);
    assert.doesNotMatch(metin, /\bundefined\b/, `${ad}: metinde hiçbir yerde "undefined" geçemez`);
    assert.doesNotMatch(
      JSON.stringify(veri),
      /"undefined"/,
      `${ad}: 'undefined' METNİ JSON'da bir değer kılığına giremez`
    );
  });
}

/**
 * A NAME IS NOT AN IDENTITY. A campaign whose name could not be read is still addressable
 * by its id, so refusing the whole row would throw away a readable campaign — the same
 * mistake with the opposite sign. It stays, its name says what it is, and the gap is
 * counted where the money fields' gaps are counted.
 */
const adsizVakalar: Array<[string, any]> = [
  ["ad yok", { ...OKUNUR_ENUM, id: 7 }],
  ["ad null", { ...OKUNUR_ENUM, id: 7, name: null }],
  ["ad boş dizge", { ...OKUNUR_ENUM, id: 7, name: "" }],
  ["ad dizi", { ...OKUNUR_ENUM, id: 7, name: [] }],
  ["ad nesne", { ...OKUNUR_ENUM, id: 7, name: {} }],
];

for (const [ad, campaign] of adsizVakalar) {
  test(`KRİTİK: adı okunamayan satır (${ad}) kalır ama "undefined" AD TAKMAZ`, async () => {
    const { res, veri, k, metin } = await kampanyaRaporu([campaign]);

    assert.notEqual(res.isError, true, `${ad}: okunamayan ad tüm raporu düşürmemeli`);
    assert.equal(veri.kampanyalar.length, 1, `${ad}: kimliği okunan kampanya listede kalmalı`);
    assert.equal(k.id, "7", `${ad}: kimlik olduğu gibi durmalı`);
    assert.notEqual(k.ad, "undefined", `${ad}: 'undefined' METNİ bir kampanya adı kılığındadır`);
    assert.equal(k.ad, "(AD OKUNAMADI)", `${ad}: yazılan metin kendini ad DEĞİL diye ilan etmeli`);
    assert.ok(
      k.okunamayanAlanlar?.includes("ad"),
      `${ad}: "ad" okunamayanAlanlar'da SAYILMALI (gelen: ${JSON.stringify(k.okunamayanAlanlar)})`
    );
    assert.doesNotMatch(metin, /\bundefined\b/, `${ad}: metinde hiçbir yerde "undefined" geçemez`);
    // The row is not thrown away: what could be read is still reported.
    assert.equal(k.gunlukButce, 50, `${ad}: okunabilen alanlar yerinde kalmalı`);
    assert.equal(veri.sekliBozukSatir, undefined, `${ad}: adsız satır DÜŞEN satır değildir, sayılmamalı`);
  });
}

/**
 * THE OPPOSITE SIGN AGAIN. A guard that dropped every id would satisfy every assertion
 * above and leave the table without a single addressable campaign. These readings must
 * come through exactly as they arrived.
 */
const okunurKimlikler: Array<[string, any, string, string]> = [
  ["sayı id", { ...OKUNUR_ENUM, id: 7, name: "Yayındaki Kampanya" }, "7", "Yayındaki Kampanya"],
  ["dizge id", { ...OKUNUR_ENUM, id: "1234567890", name: "Marka" }, "1234567890", "Marka"],
  // int64 ids reach this SDK as bigint; String() must not round them through a double.
  ["bigint id", { ...OKUNUR_ENUM, id: 9007199254740993n, name: "Marka" }, "9007199254740993", "Marka"],
  ["id 0", { ...OKUNUR_ENUM, id: 0, name: "Marka" }, "0", "Marka"],
];

for (const [ad, campaign, beklenenId, beklenenAd] of okunurKimlikler) {
  test(`okunabilen kimlik (${ad}) aynen raporlanır ve satır DÜŞMEZ`, async () => {
    const { veri, k, metin } = await kampanyaRaporu([campaign]);

    assert.equal(veri.kampanyalar.length, 1, `${ad}: okunan kimlik düşürülemez`);
    assert.equal(veri.sekliBozukSatir, undefined, `${ad}: okunan satır bozuk sayılamaz`);
    assert.equal(k.id, beklenenId, `${ad}: okunan kimlik olduğu gibi yazılmalı`);
    assert.equal(k.ad, beklenenAd, `${ad}: okunan ad olduğu gibi yazılmalı`);
    assert.equal(k.okunamayanAlanlar, undefined, `${ad}: her alan okunduysa okunamayan-alan listesi hiç yazılmaz`);
    assert.ok(metin.includes(`#${beklenenId} `), `${ad}: kimlik insan-okur satırda görünmeli`);
    assert.doesNotMatch(metin, /AD OKUNAMADI/, `${ad}: okunan ad için uyarı basılamaz`);
  });
}

test("kimliksiz satır komşusunu bozmaz: sağlam kampanya olduğu gibi kalır", async () => {
  const { veri, metin } = await kampanyaRaporu([{ ...OKUNUR_ENUM }, { ...OKUNUR_ENUM, id: 42, name: "Sağlam" }]);

  assert.equal(veri.kampanyalar.length, 1, "yalnız kimliksiz satır düşmeli");
  assert.equal(veri.sekliBozukSatir, 1, "düşen satır sayılmalı");
  const saglam = veri.kampanyalar[0];
  assert.equal(saglam.id, "42", "komşu satırın kimliği etkilenmemeli");
  assert.equal(saglam.ad, "Sağlam", "komşu satırın adı etkilenmemeli");
  assert.equal(saglam.okunamayanAlanlar, undefined, "komşu satır okunamayan alan bildirmemeli");
  assert.doesNotMatch(metin, /\bundefined\b/, "tabloda hiçbir yerde 'undefined' geçemez");
});

/**
 * ŞEMA–DAVRANIŞ ÇİFTİ. `id` and `ad` stay REQUIRED, and that is load-bearing: making them
 * optional would let a row with no identity satisfy the contract, which is precisely the
 * hole this file closes. The code keeps the promise instead — an unreadable id drops the
 * row, an unreadable name arrives as "(AD OKUNAMADI)" — so the schema never has to bend.
 * (test/faz4Read.test.ts pins the same pair from the enum side; this is the identity side.)
 */
test("şema kimlik alanlarını ZORUNLU tutar — gevşetmek kimliksiz satıra kapı açardı", async () => {
  const { ctx } = sahteContext({ queries: [[/FROM campaign\b/, []]] });
  const c = await baglanti(ctx);
  const kmp: any = (await c.listTools()).tools.find((t: any) => t.name === "campaign_performance");
  const alanlar = kmp?.outputSchema?.properties?.kampanyalar?.items;
  const zorunlu: string[] = alanlar?.required ?? [];

  assert.ok(alanlar, "campaign_performance kampanya şemasını ilan etmeli");
  assert.ok(zorunlu.includes("id"), "id ZORUNLU kalmalı: kimliksiz satır şemadan da geçememeli");
  assert.ok(zorunlu.includes("ad"), "ad ZORUNLU kalmalı");
  assert.match(
    String(alanlar.properties?.id?.description ?? ""),
    /sekliBozukSatir/,
    "id açıklaması kimliksiz satırın nereye gittiğini söylemeli"
  );
  assert.match(
    String(alanlar.properties?.ad?.description ?? ""),
    /AD OKUNAMADI/,
    "ad açıklaması okunamayan adın nasıl göründüğünü söylemeli"
  );
});
