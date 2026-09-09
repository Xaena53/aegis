// SPDX-License-Identifier: AGPL-3.0-only
/**
 * REGRESSION: run_gaql must be able to MEASURE truncation.
 *
 * The tool used to send `LIMIT ${goster}` and then slice to the very same `goster`.
 * Google returns at most LIMIT rows, so `rows.length` could never exceed `goster` and
 * `kesildi` was STRUCTURALLY false — not "false because nothing was cut", but false
 * because the question could never be answered. An account with 5000 negative keywords
 * answered "100 satır (100 gösteriliyor), kesildi:false", and the agent concluded the
 * account HAS 100 negative keywords and re-proposed a term that was already excluded.
 *
 * "Unknown is not 0" applies to row counts too: the only mechanism that can tell
 * "exactly 100 rows exist" from "at least 100 rows exist" is the saturation probe the
 * report tools already use (LIMIT cap+1, cap+2 for customer_client). These tests pin the
 * probe on the SENT QUERY, not only on the derived boolean: a fix that leaves the query
 * at `LIMIT cap` cannot be detected downstream at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sahteContext, baglanti } from "./helpers/harness.js";

const MUSTERI = "1234567890";

/** Cheap rows: small enough that the 20k CHAR_CAP never fires, so these tests measure the PROBE. */
const satirlar = (n: number) => Array.from({ length: n }, (_, i) => ({ campaign: { id: i } }));

test("KRİTİK: run_gaql tavan+1 DOYMA PROBU ister (kırpma ölçülebilir olsun)", async () => {
  /**
   * Guard on the QUERY. If the probe is dropped the sent query becomes `LIMIT 100`, the
   * API can never return 101 rows, and every later assertion about `kesildi` silently
   * measures nothing.
   */
  const { ctx, rec } = sahteContext({ queries: [[/.*/, []]] });
  const c = await baglanti(ctx);

  await c.callTool({ name: "run_gaql", arguments: { customerId: MUSTERI, query: "SELECT campaign.id FROM campaign" } });
  assert.match(rec.queries.at(-1)!, /LIMIT 101$/, "varsayılan 100 satır + 1 doyma probu istenmeli");

  await c.callTool({
    name: "run_gaql",
    arguments: { customerId: MUSTERI, query: "SELECT campaign.id FROM campaign", limit: 50 },
  });
  assert.match(rec.queries.at(-1)!, /LIMIT 51$/, "limit=50 için 50 satır + 1 doyma probu istenmeli");

  // The user's own oversized LIMIT is still clamped (OOM protection), probe included.
  await c.callTool({
    name: "run_gaql",
    arguments: { customerId: MUSTERI, query: "SELECT campaign.id FROM campaign LIMIT 5000", limit: 50 },
  });
  assert.match(rec.queries.at(-1)!, /LIMIT 51$/, "kullanıcının devasa LIMIT'i tavan+prob'a kırpılmalı");
});

test("KRİTİK: 100'den fazla satır varken kesildi=true ve metin uyarır (sessiz kırpma yok)", async () => {
  const { ctx } = sahteContext({ queries: [[/.*/, satirlar(5000)]] });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({
    name: "run_gaql",
    arguments: { customerId: MUSTERI, query: "SELECT campaign_criterion.keyword.text FROM campaign_criterion" },
  });
  const s = res.structuredContent;
  const metin = String(res.content?.[0]?.text ?? "");

  assert.equal(s.kesildi, true, "5000 satırlık hesapta kırpma ÖLÇÜLMELİ — 'kesildi:false' bir yalandır");
  assert.equal(s.gosterilen, 100, "gösterilen satır tavanı aşmamalı");
  assert.equal(s.satirlar.length, 100, "doyma PROBU satırı ajana sızmamalı");
  assert.equal(s.satirSayisi, 100, "duyurulan sayı prob satırını SAYMAMALI (tablo ile başlık uyuşmalı)");
  assert.match(metin, /KESİLDİ/, "kırpma insan-okur özette de duyurulmalı");
});

test("run_gaql: tavanın ALTINDA satır varken yanlış alarm yok (kesildi=false)", async () => {
  /**
   * The fix must not turn "saturated" into "always cut": a probe that never fires has to
   * report a complete list, otherwise the warning becomes noise and stops being read.
   */
  const { ctx } = sahteContext({ queries: [[/.*/, satirlar(40)]] });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({
    name: "run_gaql",
    arguments: { customerId: MUSTERI, query: "SELECT campaign.id FROM campaign" },
  });
  assert.equal(res.structuredContent.kesildi, false, "40 satır tavana değmez — kesilme YOKTUR");
  assert.equal(res.structuredContent.satirSayisi, 40);
  assert.doesNotMatch(String(res.content?.[0]?.text ?? ""), /KESİLDİ/);
});

test("run_gaql: TAM tavan kadar satır dönerse kırpma yoktur (prob boş döner)", async () => {
  /**
   * The probe's whole point: exactly 100 rows is a COMPLETE list, and only asking for a
   * 101st can tell it apart from a cut one. A "saturation = cut" shortcut would fail here.
   */
  const { ctx } = sahteContext({ queries: [[/.*/, satirlar(100)]] });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({
    name: "run_gaql",
    arguments: { customerId: MUSTERI, query: "SELECT campaign.id FROM campaign" },
  });
  assert.equal(res.structuredContent.kesildi, false, "tam 100 satır = TAM liste, yanlış alarm verilmemeli");
  assert.equal(res.structuredContent.satirSayisi, 100);
});

test("KRİTİK: sahte API LIMIT'e uyar — prob olmadan bu dosya hiçbir şey ölçmez", async () => {
  /** Watchdog on the harness itself, same discipline as test/tools.read.test.ts. */
  const { ctx } = sahteContext({ queries: [[/FROM campaign/, satirlar(5000)]] });
  const yuz = await (ctx as any).queryWithRetry(MUSTERI, "SELECT x FROM campaign LIMIT 100");
  assert.equal(yuz.length, 100, "LIMIT 100 sorgusuna 101 satır dönemez — gerçek API de dönmez");
  const probla = await (ctx as any).queryWithRetry(MUSTERI, "SELECT x FROM campaign LIMIT 101");
  assert.equal(probla.length, 101, "prob istendiğinde doyma satırı GELMELİ");
});

test("run_gaql: kesilme YOKKEN özet biçimi bit bit aynı kalır (brain betikleri onu ayrıştırıyor)", async () => {
  /**
   * scripts/brain/uygulama.mjs reads this summary with `^(\d+)\s+satır` to decide whether a
   * campaign of the same name already exists, and test/brain/*.test.mjs feed the exact
   * string "0 satır (0 gösteriliyor):\n[]" as a canned answer. The probe must stay invisible
   * on the untruncated path: counting the probe row here would shift that number and make a
   * duplicate-name check answer about rows nobody was shown.
   */
  const { ctx } = sahteContext({ queries: [[/.*/, []]] });
  const c = await baglanti(ctx);
  const res: any = await c.callTool({
    name: "run_gaql",
    arguments: { customerId: MUSTERI, query: "SELECT campaign.id FROM campaign" },
  });
  assert.equal(String(res.content?.[0]?.text ?? ""), "0 satır (0 gösteriliyor):\n[]");
});
