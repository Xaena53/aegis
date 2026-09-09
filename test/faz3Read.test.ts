// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { enums } from "google-ads-api";
import { sahteContext, baglanti } from "./helpers/harness.js";

/**
 * FAZ 3 — src/tools/read.ts regression watchers.
 *
 * Every rule pinned here fails SILENTLY when it breaks: the report keeps returning a
 * well-formed, confident-looking answer, and only the number inside it turns into a claim
 * about something nobody measured. Each watcher was mutation-checked — the fix was
 * reverted, the test was seen RED, the fix was put back.
 */

const MUSTERI = "1234567890";

async function cagirYapisal(
  ctx: any,
  ad: string,
  args: Record<string, unknown> = {}
): Promise<{ veri: any; metin: string; hataMi: boolean }> {
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: ad, arguments: { customerId: MUSTERI, ...args } });
  return { veri: res.structuredContent, metin: String(res.content?.[0]?.text ?? ""), hataMi: res.isError === true };
}

/** A search-term row in the shape the tool can read end to end. */
function terim(ad: string, mikro: number, donusum: number, status: number = enums.SearchTermTargetingStatus.ADDED) {
  return {
    campaign: { id: 1, name: "K" },
    ad_group: { id: 1, name: "G" },
    search_term_view: { search_term: ad, status },
    metrics: { cost_micros: mikro, clicks: 5, impressions: 50, conversions: donusum },
  };
}

// ── FINDING 1: a row dropped for being malformed is spend that vanished from the base ──

test("BULGU-1: düşen bozuk satır SAYILIR ve israf ORANI artık üretilmez", async () => {
  /**
   * The filter has always dropped rows the tool cannot read. What it did not do was ACCOUNT
   * for them: their cost never reached `toplamMaliyet`, yet `israfYuzde` was still written —
   * a ratio over a base that is not even the data that came back. Measured before the fix:
   * rows worth 25 / 25 / 900 where the 900 one is malformed produced
   * `{toplamMaliyet:50, israfMaliyet:25, israfYuzde:50}` with no warning anywhere, while the
   * returned data says (25+900)/(50+900) ≈ 97%. The agent reads "waste is 50%, moderate"
   * and never sees the single most expensive wasteful term.
   */
  const { ctx } = sahteContext({
    queries: [
      [
        /FROM search_term_view/,
        [
          terim("a", 25_000_000, 3),
          terim("b", 25_000_000, 0),
          // search_term_view sub-object MISSING — unreadable row, but 900 units of REAL spend
          {
            campaign: { id: 1, name: "K" },
            ad_group: { id: 1, name: "G" },
            metrics: { cost_micros: 900_000_000, clicks: 50, conversions: 0 },
          },
        ],
      ],
    ],
  });
  const { veri, metin, hataMi } = await cagirYapisal(ctx, "search_terms_report");

  assert.equal(hataMi, false, "tek bozuk satır tüm raporu düşürmemeli");
  assert.equal(veri.sekliBozukSatir, 1, "düşen satır ayrı bir sayaçta ilan edilmeli");
  assert.equal(
    veri.israfYuzde,
    undefined,
    "eksik tabandan ORAN üretilemez — dönen veriye göre gerçek oran %97 iken araç %50 diyordu"
  );
  assert.ok(!("israfYuzde" in veri), "bilinmeyen oran boş değerle bile YAZILMAZ");
  assert.doesNotMatch(metin, /%\s*\d/, "insan-okur metne de oran sızmamalı");
  assert.match(metin, /DÜŞTÜ/, "düşen satır insana da söylenmeli");
});

test("BULGU-1 karşı-kontrol: her satır sağlamken israf ORANI HÂLÂ üretilir", async () => {
  /**
   * ANTI-VACUUM. Without this, the watcher above could be satisfied by never producing a
   * ratio at all — a silent loss of the tool's whole point dressed up as a fix. Here nothing
   * is malformed, so the ratio MUST still come out.
   */
  const { ctx } = sahteContext({
    queries: [[/FROM search_term_view/, [terim("a", 25_000_000, 3), terim("b", 25_000_000, 0)]]],
  });
  const { veri, metin } = await cagirYapisal(ctx, "search_terms_report");

  assert.equal(veri.sekliBozukSatir, undefined, "hiçbir satır düşmediyse sayaç yazılmaz");
  assert.equal(veri.israfYuzde, 50, "sağlam ve tam listede oran verilmeye devam etmeli");
  assert.match(metin, /%50/);
  assert.doesNotMatch(metin, /DÜŞTÜ/, "yanlış alarm basmamalı");
});

test("BULGU-1: campaign_performance ve keyword_performance de düşen satırı duyurur", async () => {
  /**
   * The same silent filter sits on both other report surfaces. Neither computes a ratio, but
   * both let a dropped row shrink the table without a word — and this file's own rule (see
   * the truncation warnings) is that a shortened list must never look complete, because
   * "not in the list" reads as "does not exist".
   */
  const { ctx } = sahteContext({
    queries: [
      [
        /FROM campaign\b/,
        [
          {
            campaign: {
              id: 7,
              name: "Sağlam",
              status: enums.CampaignStatus.ENABLED,
              advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
            },
            campaign_budget: { amount_micros: 1_000_000 },
            metrics: { cost_micros: 1_000_000, clicks: 1, impressions: 1, conversions: 0, ctr: 0.1, average_cpc: 1 },
          },
          { metrics: { cost_micros: 900_000_000, clicks: 50, conversions: 0 } }, // campaign YOK
        ],
      ],
      [
        /FROM keyword_view/,
        [
          {
            campaign: { name: "K" },
            ad_group: { name: "G" },
            ad_group_criterion: {
              keyword: { text: "sağlam", match_type: enums.KeywordMatchType.EXACT },
              status: enums.AdGroupCriterionStatus.ENABLED,
            },
            metrics: { cost_micros: 1_000_000, clicks: 1, conversions: 0 },
          },
          { ad_group: { name: "G" }, metrics: { cost_micros: 900_000_000 } }, // campaign YOK
        ],
      ],
    ],
  });

  const kmp = await cagirYapisal(ctx, "campaign_performance");
  assert.equal(kmp.veri.sekliBozukSatir, 1, "campaign_performance düşen satırı saymalı");
  assert.match(kmp.metin, /DÜŞTÜ/);
  assert.equal(kmp.veri.kampanyalar.length, 1, "bozuk satır tabloya girmemeli");

  const kw = await cagirYapisal(ctx, "keyword_performance");
  assert.equal(kw.veri.sekliBozukSatir, 1, "keyword_performance düşen satırı saymalı");
  assert.match(kw.metin, /DÜŞTÜ/);
  assert.equal(kw.veri.kelimeler.length, 1, "bozuk satır tabloya girmemeli");
});

// ── FINDING 2: the exclusion flag steers a WRITE, so it has to fail closed ──

test("BULGU-2: okunamayan dışlanma durumu 'dışlanmamış' diye YAZILMAZ", async () => {
  /**
   * `zatenDislanmis` is the flag the tool's own NEXT STEP instruction reads before sending
   * the agent to add_campaign_negative_keywords. Measured before the fix: a row whose
   * `search_term_view.status` never arrived came back as `zatenDislanmis:false` — a positive
   * claim ("this term is NOT excluded yet") manufactured out of an unknown, on a term
   * flagged 🔥 in the same breath. The cost is a human approval spent on excluding something
   * that may already be excluded.
   */
  const { ctx } = sahteContext({
    queries: [
      [
        /FROM search_term_view/,
        [
          {
            campaign: { id: 1, name: "K" },
            ad_group: { id: 1, name: "G" },
            search_term_view: { search_term: "durumsuz terim" }, // status YOK
            metrics: { cost_micros: 40_000_000, clicks: 9, conversions: 0 },
          },
        ],
      ],
    ],
  });
  const { veri, metin } = await cagirYapisal(ctx, "search_terms_report");
  const t = veri.terimler[0];

  assert.ok(!("zatenDislanmis" in t), "bilinmeyen bayrak HİÇ YAZILMAZ — 'false' bir iddiadır");
  assert.equal(t.dislanmaDurumuBilinmiyor, true, "bilinmezlik açıkça ilan edilmeli");
  assert.match(metin, /DIŞLANMA DURUMU OKUNAMADI/, "insana da söylenmeli");
  assert.doesNotMatch(metin, /\[zaten dışlanmış\]/, "bilinmeyen 'dışlanmış' diye de sunulamaz");
});

test("BULGU-2 karşı-kontrol: okunabilen dışlanma durumu HÂLÂ doğru raporlanır", async () => {
  /**
   * ANTI-VACUUM. A "fix" that simply withholds the flag forever would satisfy the watcher
   * above while blinding the report. Both readable answers must survive: ADDED_EXCLUDED is
   * still `true`, and plain ADDED is still an explicit `false` — a MEASURED "no", not a
   * missing field.
   */
  const { ctx } = sahteContext({
    queries: [
      [
        /FROM search_term_view/,
        [
          terim("dışlanmış", 10_000_000, 0, enums.SearchTermTargetingStatus.ADDED_EXCLUDED),
          terim("normal", 10_000_000, 0, enums.SearchTermTargetingStatus.ADDED),
        ],
      ],
    ],
  });
  const { veri, metin } = await cagirYapisal(ctx, "search_terms_report");

  assert.equal(veri.terimler[0].zatenDislanmis, true, "ADDED_EXCLUDED hâlâ 'zaten dışlanmış' olmalı");
  assert.equal(veri.terimler[0].dislanmaDurumuBilinmiyor, undefined);
  assert.equal(veri.terimler[1].zatenDislanmis, false, "okunabilen 'dışlanmamış' ÖLÇÜLMÜŞ bir false'tur");
  assert.match(metin, /\[zaten dışlanmış\]/);
  assert.doesNotMatch(metin, /DIŞLANMA DURUMU OKUNAMADI/, "okunabilen durumda yanlış alarm basmamalı");
});

// ── FINDING 3: the keyword status was fetched and thrown away ──

test("BULGU-3: keyword_performance kelimenin DURUMUNU raporlar", async () => {
  /**
   * The query has always SELECTed `ad_group_criterion.status`, and the row mapper never
   * touched it. Measured before the fix, a REMOVED keyword with 500 cost / 300 clicks came
   * back as `{kelime, eslemeTuru, kampanya, reklamGrubu, maliyet:500, tiklama:300,
   * donusum:0}` — indistinguishable from a live keyword burning money today, on the very
   * tool whose description sends the agent here to hunt "dead keywords".
   */
  const { ctx, rec } = sahteContext({
    queries: [
      [
        /FROM keyword_view/,
        [
          {
            campaign: { name: "K" },
            ad_group: { name: "G" },
            ad_group_criterion: {
              keyword: { text: "kaldırılmış kelime", match_type: enums.KeywordMatchType.EXACT },
              status: enums.AdGroupCriterionStatus.REMOVED,
            },
            metrics: { cost_micros: 500_000_000, clicks: 300, conversions: 0 },
          },
        ],
      ],
    ],
  });
  const { veri, metin } = await cagirYapisal(ctx, "keyword_performance");

  assert.equal(veri.kelimeler[0].durum, "REMOVED", "durum SAYI değil AD olarak yazılmalı");
  assert.match(metin, /durum: REMOVED/, "insan-okur satırda da görünmeli");
  // BIDIRECTIONAL: the comment's claim — "the field is already fetched, so report it" — only
  // holds while the query still asks for it. Drop it from the SELECT and this goes red too.
  assert.match(rec.queries.at(-1)!, /ad_group_criterion\.status/, "durum sorguda İSTENMEYE devam etmeli");
});

test("BULGU-3: okunamayan kelime durumu ETKİN varsayılmaz", async () => {
  /**
   * Fail closed on the status too: an absent `ad_group_criterion.status` is not written, and
   * must not read as ENABLED by omission.
   */
  const { ctx } = sahteContext({
    queries: [
      [
        /FROM keyword_view/,
        [
          {
            campaign: { name: "K" },
            ad_group: { name: "G" },
            ad_group_criterion: { keyword: { text: "durumsuz", match_type: enums.KeywordMatchType.PHRASE } },
            metrics: { cost_micros: 1_000_000, clicks: 1, conversions: 0 },
          },
        ],
      ],
    ],
  });
  const { veri, metin } = await cagirYapisal(ctx, "keyword_performance");

  assert.ok(!("durum" in veri.kelimeler[0]), "okunamayan durum HİÇ YAZILMAZ");
  assert.match(metin, /durum: OKUNAMADI/);
  assert.match(metin, /ETKİN varsayma/, "ajana 'yokluğu ENABLED demek değil' denmeli");
});

// ── The advertised schema and the behaviour have to move together ──

test("üç düzeltmenin alanları outputSchema'da İLAN EDİLİR (şema-davranış çifti)", async () => {
  /**
   * BIDIRECTIONAL. The tests above pin what the tools DO; this one pins what they SAY they
   * do. An undeclared field never reaches a strict client, so a behaviour fix missing from
   * the schema is a fix nobody can read — and a schema entry missing from the behaviour is a
   * promise nobody keeps. Delete either side and this goes red.
   */
  const { ctx } = sahteContext({ queries: [[/.*/, []]] });
  const c = await baglanti(ctx);
  const tools = (await c.listTools()).tools as any[];
  const semaOf = (ad: string): any => tools.find((t) => t.name === ad)?.outputSchema?.properties ?? {};

  const st = semaOf("search_terms_report");
  assert.ok(st.sekliBozukSatir, "search_terms_report düşen-satır sayacını bildirmeli");
  assert.ok(st.terimler.items.properties.dislanmaDurumuBilinmiyor, "bilinmezlik bayrağı bildirilmeli");
  assert.ok(
    !(st.terimler.items.required ?? []).includes("zatenDislanmis"),
    "zatenDislanmis ZORUNLU kalırsa 'bilinmiyor' hâli şemaya sığmaz ve tekrar false yazılır"
  );

  const kw = semaOf("keyword_performance");
  assert.ok(kw.kelimeler.items.properties.durum, "kelime durumu bildirilmeli");
  assert.ok(kw.sekliBozukSatir, "keyword_performance düşen-satır sayacını bildirmeli");
  assert.ok(semaOf("campaign_performance").sekliBozukSatir, "campaign_performance düşen-satır sayacını bildirmeli");
});
