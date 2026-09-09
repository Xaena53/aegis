// SPDX-License-Identifier: AGPL-3.0-only
/**
 * REGRESSION (round 2): the saturation probe must survive the CALLER'S OWN LIMIT.
 *
 * Round 1 made run_gaql ask for `goster + 1` rows so truncation could be measured. It
 * asked for that through `ensureGaqlLimit`, which is a CLAMP: an existing LIMIT at or
 * below the ceiling is left exactly as written. So the probe was switched off by the one
 * thing an agent types most often — its own `... LIMIT 100`. Measured on the production
 * path: query `SELECT ... FROM campaign_criterion LIMIT 100` against an account holding
 * 5000 rows was sent unchanged as `LIMIT 100`, and the tool answered
 * `satirSayisi=100 gosterilen=100 kesildi=false` — the finding's own scenario, verbatim:
 * the agent reads "this account has 100 negative keywords" and proposes an already
 * excluded term again.
 *
 * "Unknown is not a count" is the contract being defended here. `kesildi=false` must mean
 * MEASURED complete, never "the question could not be asked". These tests therefore pin
 * the SENT QUERY as well as the derived boolean: a regression that quietly drops the +1
 * cannot be seen downstream at all, because the fake API — like Google — never returns
 * more rows than the LIMIT it was given.
 *
 * They also pin the other direction, which is just as easy to get wrong: the caller's own
 * LIMIT is never RAISED to make room for the probe. A query saying `LIMIT 5` must still
 * show 5 rows, not 100.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sahteContext, baglanti } from "./helpers/harness.js";
import { gaqlDoymaProbu } from "../src/util.js";

const MUSTERI = "1234567890";

/** Cheap rows: small enough that the 20k CHAR_CAP never fires, so these tests measure the PROBE. */
const satirlar = (n: number) => Array.from({ length: n }, (_, i) => ({ campaign: { id: i } }));

/** Runs run_gaql on a fake account of `hesapSatiri` rows and reports what the agent sees. */
async function kos(query: string, hesapSatiri: number, limit?: number) {
  const { ctx, rec } = sahteContext({ queries: [[/.*/, satirlar(hesapSatiri)]] });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({
    name: "run_gaql",
    arguments: { customerId: MUSTERI, query, ...(limit === undefined ? {} : { limit }) },
  });
  return { gonderilen: rec.queries.at(-1)!, s: res.structuredContent, metin: String(res.content?.[0]?.text ?? "") };
}

test("KRİTİK: ajanın KENDİ LIMIT'i doyma probunu devre dışı BIRAKAMAZ", async () => {
  /**
   * The exact scenario from the finding: 5000 negative keywords, a hand-written LIMIT 100.
   * Before the fix the query went out as `LIMIT 100` and `kesildi` was structurally false.
   */
  const { gonderilen, s, metin } = await kos(
    "SELECT campaign_criterion.keyword.text FROM campaign_criterion LIMIT 100",
    5000
  );
  assert.match(gonderilen, /LIMIT 101$/, "sorgudaki LIMIT 100 aynen gönderilirse kırpma ÖLÇÜLEMEZ");
  assert.equal(s.kesildi, true, "5000 satırlık hesapta 'kesildi:false' bir yalandır");
  assert.equal(s.gosterilen, 100, "prob satırı ajana sızmamalı");
  assert.equal(s.satirSayisi, 100, "duyurulan sayı prob satırını saymamalı");
  assert.match(metin, /KESİLDİ/, "kırpma insan-okur özette de duyurulmalı");
});

test("KRİTİK: sorgunun LIMIT'i tavandan küçükse ÖLÇÜLEN tavan odur (kesilme görünür)", async () => {
  const { gonderilen, s, metin } = await kos("SELECT campaign.id FROM campaign LIMIT 50", 5000);
  assert.match(gonderilen, /LIMIT 51$/, "geçerli tavan 50 ise prob 51 istemeli");
  assert.equal(s.gosterilen, 50);
  assert.equal(s.satirSayisi, 50);
  assert.equal(s.kesildi, true, "50 satırda kesilen liste 'tam' diye sunulamaz");
  assert.match(metin, /liste 50 satırda KESİLDİ/, "kesen tavan hangi sayıysa metin ONU söylemeli");
});

test("Sorgunun LIMIT'i YÜKSELTİLMEZ: LIMIT 5 sorgusu 5 satır gösterir", async () => {
  /**
   * The opposite failure: making room for the probe by ignoring the caller's LIMIT would
   * be a silent correction — the agent asks for 5 rows and is handed 100, and every cost
   * estimate built on "I asked for 5" is wrong.
   */
  const { gonderilen, s } = await kos("SELECT campaign.id FROM campaign LIMIT 5", 5000, 100);
  assert.match(gonderilen, /LIMIT 6$/, "prob yalnız BİR fazladan satırdır");
  assert.equal(s.gosterilen, 5, "ajanın yazdığı LIMIT ondan habersiz büyütülemez");
  assert.equal(s.satirSayisi, 5);
  assert.equal(s.kesildi, true);
});

test("Yanlış alarm yok: kendi LIMIT'ini yazan sorgu TAM listede kesildi=false der", async () => {
  /**
   * A probe that always fires is as useless as one that never fires: the warning becomes
   * noise and stops being read. Exactly-at-cap is the case only a probe can decide.
   */
  const tam = await kos("SELECT campaign.id FROM campaign LIMIT 50", 50);
  assert.match(tam.gonderilen, /LIMIT 51$/);
  assert.equal(tam.s.kesildi, false, "tam 50 satır = TAM liste");
  assert.equal(tam.s.satirSayisi, 50);
  assert.doesNotMatch(tam.metin, /KESİLDİ/);

  const az = await kos("SELECT campaign.id FROM campaign LIMIT 100", 40);
  assert.equal(az.s.kesildi, false, "40 satır tavana değmez");
  assert.equal(az.s.satirSayisi, 40);
});

test("Prob, sorgunun biçimsel tuzaklarında da uygulanır (noktalı virgül, PARAMETERS, küçük harf)", async () => {
  /**
   * Every one of these forms reaches the same clamp path in util.ts. If any of them slips
   * through with the caller's own LIMIT intact, the probe is off again on that shape only
   * — the hardest kind of gap to notice.
   */
  const noktali = await kos("SELECT campaign.id FROM campaign LIMIT 100;", 5000);
  assert.match(noktali.gonderilen, /LIMIT 101$/, "sondaki ';' probu atlatamaz");
  assert.equal(noktali.s.kesildi, true);

  const parametreli = await kos(
    "SELECT campaign.id FROM campaign limit 100 PARAMETERS include_drafts=true",
    5000
  );
  assert.equal(
    parametreli.gonderilen,
    "SELECT campaign.id FROM campaign LIMIT 101 PARAMETERS include_drafts=true",
    "PARAMETERS yan tümcesi LIMIT'ten SONRA kalmalı ve prob yine uygulanmalı"
  );
  assert.equal(parametreli.s.kesildi, true);
});

test("OOM kelepçesi hâlâ ısırıyor: devasa LIMIT tavan+prob'a kırpılır", async () => {
  const varsayilan = await kos("SELECT campaign.id FROM campaign LIMIT 999999", 5000);
  assert.match(varsayilan.gonderilen, /LIMIT 101$/, "devasa LIMIT varsayılan tavana kırpılmalı");
  const istenen = await kos("SELECT campaign.id FROM campaign LIMIT 999999", 5000, 50);
  assert.match(istenen.gonderilen, /LIMIT 51$/, "devasa LIMIT istenen tavana kırpılmalı");
});

test("Metin sabitindeki 'LIMIT' sorgunun tavanı sanılmaz", async () => {
  /**
   * The cap is read from the MASKED body for the same reason the clamp is: a campaign
   * named "LIMIT 3" must not decide how many rows the account is reported to have.
   */
  const q = "SELECT campaign.id FROM campaign WHERE campaign.name = 'LIMIT 3'";
  const { gonderilen } = await kos(q, 5000);
  assert.equal(gonderilen, `${q} LIMIT 101`, "sabit içindeki LIMIT tavan sayılmamalı");

  /**
   * Only the SENT QUERY is asserted here, on purpose. The fake API reads the FIRST
   * `LIMIT n` in the text (test/helpers/harness.ts), so for this one shape it answers with
   * 3 rows where Google would obey the trailing LIMIT 101. Asserting a row count here
   * would pin the fake's parser rather than the tool's behaviour — and the guarantee that
   * matters is exactly the one above: the cap is read from the MASKED body, so a campaign
   * named "LIMIT 3" never becomes the account's reported row cap.
   */
});

test("brain idempotenlik sözleşmesi korunur: 'LIMIT 1' + limit=1 hâlâ '1 satır' der", async () => {
  /**
   * scripts/brain/uygulama.mjs asks `... campaign.name = '...' LIMIT 1` with limit: 1 and
   * reads the summary with /^(\d+)\s+satır/ to decide whether a campaign of that name
   * already exists. The probe must not shift that number: counting the probe row would
   * make a duplicate-name check answer about a row nobody was shown, and the run would be
   * cancelled (or, worse, duplicated) on a miscount.
   */
  const { gonderilen, metin } = await kos(
    "SELECT campaign.id, campaign.name FROM campaign WHERE campaign.name = 'X' AND campaign.status != 'REMOVED' LIMIT 1",
    1,
    1
  );
  assert.match(gonderilen, /LIMIT 2$/, "tavan 1 için prob 2 istemeli");
  assert.match(metin, /^1\s+satır/, "brain'in okuduğu sayı DEĞİŞMEMELİ");

  const yok = await kos("SELECT campaign.id FROM campaign WHERE campaign.name = 'X' LIMIT 1", 0, 1);
  assert.equal(yok.metin, "0 satır (0 gösteriliyor):\n[]", "kesilmesiz özet biçimi bit bit aynı kalmalı");
});

test("gaqlDoymaProbu: geçersiz tavan SESSİZCE düzeltilmez, HATA fırlatır", () => {
  /**
   * No silent clamping: a broken ceiling that quietly becomes 100 hands back a row count
   * measured against a cap nobody asked for.
   */
  for (const kotu of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(
      () => gaqlDoymaProbu("SELECT campaign.id FROM campaign", kotu),
      /Geçersiz satır tavanı/,
      `tavan ${kotu} kabul edilmemeli`
    );
  }
  assert.deepEqual(gaqlDoymaProbu("SELECT campaign.id FROM campaign", 100), {
    sorgu: "SELECT campaign.id FROM campaign LIMIT 101",
    tavan: 100,
  });
  assert.deepEqual(gaqlDoymaProbu("SELECT campaign.id FROM campaign LIMIT 7", 100), {
    sorgu: "SELECT campaign.id FROM campaign LIMIT 8",
    tavan: 7,
  });
  // Degenerate but well defined: LIMIT 0 shows nothing, and the one row fetched is the
  // probe — a probe row is counted, never displayed.
  assert.deepEqual(gaqlDoymaProbu("SELECT campaign.id FROM campaign LIMIT 0", 100), {
    sorgu: "SELECT campaign.id FROM campaign LIMIT 1",
    tavan: 0,
  });
});

test("KRİTİK: sahte API LIMIT'e uyar — prob olmadan bu dosya hiçbir şey ölçmez", async () => {
  /** Watchdog on the harness: if the fake API ignored LIMIT, every assertion above would
   * pass with the probe deleted from the source. */
  const { ctx } = sahteContext({ queries: [[/FROM campaign/, satirlar(5000)]] });
  const yuz = await (ctx as any).queryWithRetry(MUSTERI, "SELECT x FROM campaign LIMIT 100");
  assert.equal(yuz.length, 100, "LIMIT 100 sorgusuna 101 satır dönemez — gerçek API de dönmez");
  const probla = await (ctx as any).queryWithRetry(MUSTERI, "SELECT x FROM campaign LIMIT 101");
  assert.equal(probla.length, 101, "prob istendiğinde doyma satırı GELMELİ");
});
