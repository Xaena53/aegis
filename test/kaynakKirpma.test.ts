// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CAMPAIGN CATALOGUE TRUNCATION — a capped list may never be announced as the whole list.
 *
 * WHY THIS EXISTS: `aegis://accounts/{id}/campaigns` reads at most a fixed number of rows
 * (ORDER BY campaign.id DESC), yet its `not` field declared the result "Tüm kampanyalar"
 * unconditionally and carried no completeness flag. On an account with more campaigns than
 * the cap, the oldest ones are simply absent; the agent read the note as fact, failed to
 * find the campaign it was looking for, concluded "no such campaign exists" and built a
 * SECOND one for the same job. This is the exact failure the sibling `aegis://accounts`
 * resource already documents (its "total" field was removed for it) — the sibling's
 * gosterilen/tamListeMi/not contract had never been carried over here.
 *
 * The rows a query drops because they cannot be read are the same hazard in miniature:
 * `.filter(r => r?.campaign)` shrank the catalogue with no counter, so a shorter list
 * looked like a smaller account.
 *
 * That counter's FIRST version tested only for the `campaign` OBJECT. A row that arrived
 * carrying a `campaign` object but no `campaign.id` therefore passed the filter and was
 * served as `id: "undefined"` — a record with an invented identity, its `durum`/`kanal`
 * missing from the JSON — inside a list whose `okunamayanSatir` read 0 and whose note said
 * "the whole account". That is worse than a silent drop: an unreadable row is presented as
 * settled fact, and an agent can act on that id. The guards below pin the readability test
 * at the ID level, in both directions.
 *
 * WHAT IS PINNED, PRECISELY. Mostly behaviour: the guards drive the resource with row sets
 * that do and do not reach the cap and assert the machine-readable completeness fields
 * (gosterilen / okunamayanSatir / tamListeMi / satirTavani). Those survive a change of cap
 * or a LIMIT+1 saturation probe replacing the "row count reached the query's own LIMIT"
 * test, because the expected verdict is derived from the query the resource actually issued.
 *
 * But SOME WORDING IS PINNED TOO, deliberately: `not` is the sentence the agent reads, so an
 * incomplete list must also SAY it is incomplete. Three asserts therefore match on that text
 * (EKSİK/kırpıl, okunama, and the banned "Tüm kampanyalar" opener). Measured cost: renaming
 * the prefix to "LİSTE TAM DEĞİL" with behaviour unchanged turns the cap guard red. That is
 * the intended trade — reword the note and update this file with it — and NOT a reason to
 * change the resource.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { enums } from "google-ads-api";
import { sahteContext, baglanti } from "./helpers/harness.js";

function kampanyaSatiri(id: number) {
  return {
    campaign: {
      id,
      name: `Kampanya ${id}`,
      status: enums.CampaignStatus.PAUSED,
      advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
    },
    campaign_budget: { amount_micros: 10_000_000 },
  };
}

async function katalog(satirlar: any[]) {
  const { ctx, rec } = sahteContext({ queries: [[/FROM campaign\b/, satirlar]] });
  const c = await baglanti(ctx);
  const res: any = await c.readResource({ uri: "aegis://accounts/1466231519/campaigns" });
  return { veri: JSON.parse(res.contents[0].text), sorgu: rec.queries.at(-1)! };
}

test("KRİTİK: satır tavanına dayanan katalog 'tüm kampanyalar' diye sunulamaz", async () => {
  // 240 campaigns, a cap far below that: the fake API honours the query's own LIMIT, so
  // the resource sees exactly what production would see.
  const { veri, sorgu } = await katalog(Array.from({ length: 240 }, (_, i) => kampanyaSatiri(9000 + i)));

  const limit = Number(/LIMIT\s+(\d+)/i.exec(sorgu)?.[1] ?? 0);
  assert.ok(limit > 0, "katalog sorgusu LIMIT'siz olmamalı");
  assert.ok(veri.kampanyalar.length < 240, "bu senaryo kırpılmış bir liste üretmeli");

  assert.equal(veri.tamListeMi, false, "kırpılmış liste TAM ilan edilemez");
  assert.equal(
    veri.gosterilen,
    veri.kampanyalar.length,
    "kaç kampanyanın GÖSTERİLDİĞİ, listenin uzunluğuyla aynı olmalı"
  );
  assert.match(
    String(veri.not),
    /EKSİK|KIRPIL|kırpıl/i,
    "not alanı listenin eksik olabileceğini SÖYLEMELİ"
  );
  assert.doesNotMatch(
    String(veri.not),
    /^Tüm kampanyalar/,
    "kırpılmış liste 'Tüm kampanyalar' cümlesiyle açılamaz"
  );
  assert.match(
    String(veri.not),
    /SONUCUNA VARMA|yok olduğu anlamına gelmez/i,
    "eksik listede 'burada yoksa yoktur' çıkarımı açıkça yasaklanmalı"
  );
});

test("okunabilen kısa liste TAM ilan edilir (bekçi her şeye 'eksik' demiyor)", async () => {
  const { veri } = await katalog([kampanyaSatiri(1), kampanyaSatiri(2), kampanyaSatiri(3)]);
  assert.equal(veri.kampanyalar.length, 3);
  assert.equal(veri.tamListeMi, true, "tavana değmeyen, tamamı okunan liste TAM'dır");
  assert.equal(veri.gosterilen, 3);
  assert.equal(veri.okunamayanSatir, 0, "hiçbir satır düşmediyse sayaç 0 olmalı");
  assert.doesNotMatch(String(veri.not), /EKSİK/i, "tam listede eksiklik uyarısı olmamalı");
});

test("KRİTİK: okunamayan satır sessizce düşmez — sayılır ve liste EKSİK olur", async () => {
  /**
   * A row whose `campaign` object never arrived (partial failure, field-level permission)
   * cannot enter the catalogue, but dropping it without a counter turns a partial read
   * into a smaller-looking account. Unknown is not "absent".
   */
  const { veri } = await katalog([kampanyaSatiri(1), { campaign_budget: { amount_micros: 5_000_000 } }, kampanyaSatiri(3)]);

  assert.equal(veri.kampanyalar.length, 2, "okunamayan satır kataloğa uydurma id ile girmemeli");
  assert.equal(veri.okunamayanSatir, 1, "düşen satır SAYILMALI");
  assert.equal(veri.tamListeMi, false, "satır düştüyse liste TAM değildir");
  assert.match(String(veri.not), /okunama/i, "not alanı okunamayan satırı duyurmalı");
});

test("bildirilen satır tavanı, sorgunun GERÇEK LIMIT'iyle tutarlıdır", async () => {
  /**
   * Bidirectional: a hard-coded `satirTavani` that no longer matches the query would let
   * the resource under-report truncation, so the announced cap is checked against the
   * LIMIT the resource actually sent (the saturation probe may ask for cap+1).
   */
  const { veri, sorgu } = await katalog([kampanyaSatiri(1)]);
  const limit = Number(/LIMIT\s+(\d+)/i.exec(sorgu)?.[1] ?? 0);
  assert.equal(typeof veri.satirTavani, "number", "kaynak satır tavanını bildirmeli");
  assert.ok(
    veri.satirTavani === limit || veri.satirTavani === limit - 1,
    `bildirilen tavan (${veri.satirTavani}) sorgunun LIMIT'iyle (${limit}) uyuşmuyor`
  );
});

/**
 * A partial read that DID return a `campaign` object but not its `id`. Field-level
 * permissions and truncated API pages both produce exactly this shape, which is why the
 * `campaign`-object-only readability test was not enough.
 */
function kimliksizSatiri(id: null | undefined) {
  return {
    campaign: {
      ...(id === undefined ? {} : { id }),
      name: "kimliksiz",
      status: enums.CampaignStatus.ENABLED,
      advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
    },
    campaign_budget: { amount_micros: 20_000_000 },
  };
}

test("KRİTİK: `campaign.id` okunamayan satır uydurma kimlikle kataloğa giremez", async () => {
  const { veri } = await katalog([kimliksizSatiri(undefined), kampanyaSatiri(77), kimliksizSatiri(null)]);

  const kimlikler = (veri.kampanyalar as any[]).map((k: any) => k.id);
  assert.deepEqual(kimlikler, ["77"], "yalnız kimliği okunabilen satır kataloğa girmeli");
  assert.equal(
    kimlikler.some((id: unknown) => id === "undefined" || id === "null" || id == null),
    false,
    "uydurma kimlik ('undefined'/'null') hiçbir kayıtta bulunamaz"
  );
  assert.equal(veri.gosterilen, 1, "gösterilen sayısı kataloğa GİREN kayıt sayısıdır");
  assert.equal(veri.okunamayanSatir, 2, "kimliği okunamayan iki satır SAYILMALI");
  assert.equal(veri.tamListeMi, false, "kimliksiz satır düştüyse liste TAM değildir");
  assert.match(String(veri.not), /okunama/i, "not alanı okunamayan satırı duyurmalı");
  assert.doesNotMatch(
    String(veri.not),
    /kampanyalarının tamamı/i,
    "eksik liste 'bu hesabın kampanyalarının tamamı' diye sunulamaz"
  );
});

test("kimliği okunan satır eksiksiz kalır (bekçi geçerli kaydı düşürmüyor)", async () => {
  /**
   * The other direction: an id-level readability test that is too strict would silently
   * empty the catalogue, which is the same lie with the opposite sign. The whole record is
   * pinned — `durum` and `kanal` included, because those were the fields that disappeared
   * from the JSON on the id-less rows.
   */
  const { veri } = await katalog([kampanyaSatiri(42)]);
  assert.equal(veri.okunamayanSatir, 0, "okunabilen satır 'okunamadı' sayılamaz");
  assert.equal(veri.tamListeMi, true);
  assert.deepEqual(veri.kampanyalar, [
    { id: "42", ad: "Kampanya 42", durum: "PAUSED", kanal: "SEARCH", gunlukButce: 10 },
  ]);
});
