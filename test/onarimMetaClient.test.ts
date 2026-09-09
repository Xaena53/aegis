// SPDX-License-Identifier: AGPL-3.0-only
/**
 * REPAIR REGRESSION — the Meta access token must never travel in a URL.
 *
 * WHY THIS FILE EXISTS: `graf`'s doc comment promised "the token only in the POST body",
 * while the GET branch built `...?fields=...&access_token=<live token>`. Every GET on this
 * client (kampanyaOku, the currency lookup, the ad-set listing) put a live Marketing API
 * token into a URL, where proxies, CDNs and crash dumps write it down and error pages echo
 * it back. The comment told a reviewer the opposite, so a source read would confirm a
 * property the code did not have.
 *
 * The repo's other Meta tests stub `fetch` but only ever inspect the request BODY (the
 * PAUSED promise) or `hataTemizle`'s output; none of them looked at the URL, which is why
 * the leak survived a green suite. This file looks at the URL, and at the header that has
 * to replace it.
 *
 * BOTH HALVES ARE LOCKED ON PURPOSE. "The token is not in the URL" alone would also be
 * satisfied by sending no credential at all — which passes offline and fails on the wire.
 * So the same run asserts the token IS present as `Authorization: Bearer`.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { metaKanali, __setMetaKanalForTests } from "../src/meta/client.js";

const JETON = "TEST-ONLY-gizli-jeton-1234567890";
const AYAR = { metaToken: JETON, metaAdAccountId: "act_1" };
const KAMPANYA = "120200000000009";

const gercekFetch = globalThis.fetch;
let urller: string[] = [];
let baslikSetleri: Array<Record<string, string> | undefined> = [];
let govdeler: URLSearchParams[] = [];

afterEach(() => {
  globalThis.fetch = gercekFetch;
  __setMetaKanalForTests(undefined);
  urller = [];
  baslikSetleri = [];
  govdeler = [];
});

const PARA = { currency: "USD", currency_offset: 100 };

/**
 * Routes by PATH only (everything before "?"), so the stub keeps working whether or not the
 * query string carries a token — the test must not accidentally depend on the bug.
 */
function kanalKur(kampanya: unknown, setler?: unknown) {
  globalThis.fetch = (async (u: any, init: any) => {
    const s = String(u);
    urller.push(s);
    baslikSetleri.push(init?.headers);
    if (init?.body) govdeler.push(new URLSearchParams(String(init.body)));
    const yol = s.split("?")[0];
    const govde = yol.endsWith("/act_1")
      ? PARA
      : yol.endsWith("/adsets")
        ? setler
        : yol.endsWith("/campaigns")
          ? { id: KAMPANYA }
          : kampanya;
    if (govde === undefined) throw new Error("test: beklenmeyen çağrı " + yol);
    return { ok: true, text: async () => JSON.stringify(govde) } as any;
  }) as typeof fetch;
  __setMetaKanalForTests(undefined);
  return metaKanali(AYAR);
}

/** Header lookup that does not care about the casing a call site happened to use. */
function baslik(h: Record<string, string> | undefined, ad: string): string | undefined {
  if (!h) return undefined;
  const anahtar = Object.keys(h).find((k) => k.toLowerCase() === ad.toLowerCase());
  return anahtar === undefined ? undefined : h[anahtar];
}

test("KRİTİK SIZINTI: hiçbir Meta isteğinin URL'i access_token taşımaz", async () => {
  /**
   * Three GETs in one read: the currency lookup on /act_1, the campaign itself, and the ad
   * set listing (reached because the campaign carries no campaign-level budget). All three
   * used to append the token.
   */
  const k = kanalKur(
    { id: KAMPANYA, name: "Yaz", status: "PAUSED" },
    { data: [{ id: "1", name: "Set", status: "ACTIVE", daily_budget: "10000" }] }
  );
  const c = await k.kampanyaOku(KAMPANYA);

  assert.equal(c.gunlukButce, 100, "okuma yolu çalışmaya devam etmeli (jeton başlıkta kabul ediliyor)");
  assert.ok(urller.length >= 3, `üç GET beklenir, görülen: ${urller.length}`);
  for (const u of urller) {
    assert.ok(
      !u.includes(JETON),
      `KRİTİK: canlı jeton URL'e girdi — vekil/CDN günlükleri ve URL'i yankılayan hata ` +
        `sayfaları onu yazar: ${u.replace(JETON, "<<JETON>>")}`
    );
    assert.ok(!/access_token=/i.test(u), `URL'de access_token sorgu parametresi var: ${u}`);
  }
});

test("KRİTİK: GET jetonu Authorization başlığında GÖNDERİR (kimlik düşürülmedi)", async () => {
  /**
   * The other half of the same fix. Without this assertion, deleting the credential
   * outright would make the test above pass while every live GET returned 401.
   */
  const k = kanalKur({ id: KAMPANYA, name: "Yaz", status: "PAUSED", daily_budget: "50000" });
  await k.kampanyaOku(KAMPANYA);

  assert.ok(urller.length >= 2, "para birimi + kampanya çağrıları beklenir");
  for (const h of baslikSetleri) {
    assert.equal(
      baslik(h, "authorization"),
      `Bearer ${JETON}`,
      "GET isteği jetonu başlıkta taşımalı; aksi halde URL'den çıkarmak yetkiyi düşürmek olur"
    );
  }
});

test("POST: jeton URL'de değil gövdede kalır (yazma yolu da URL'e sızdırmaz)", async () => {
  const k = kanalKur({ id: KAMPANYA });
  await k.kampanyaOlustur({ ad: "Yaz", hedef: "OUTCOME_TRAFFIC", gunlukButce: 100 });

  for (const u of urller) {
    assert.ok(!u.includes(JETON), `POST yolunda da jeton URL'e girmemeli: ${u.replace(JETON, "<<JETON>>")}`);
  }
  const olusturma = govdeler.filter((g) => g.get("name") !== null);
  assert.equal(olusturma.length, 1, "tek bir oluşturma POST'u beklenir");
  assert.equal(olusturma[0].get("access_token"), JETON, "POST gövdesi jetonu taşımaya devam etmeli");
  assert.equal(olusturma[0].get("status"), "PAUSED", "kampanya duraklatılmış doğmaya devam etmeli");
});

test("bütçe yazma (POST) URL'i de temiz kalır", async () => {
  const k = kanalKur({ id: KAMPANYA });
  await k.butceGuncelle(KAMPANYA, 250);

  for (const u of urller) {
    assert.ok(!u.includes(JETON), `bütçe yazma URL'i jeton taşımamalı: ${u.replace(JETON, "<<JETON>>")}`);
  }
  const yazma = govdeler.filter((g) => g.get("daily_budget") !== null);
  assert.equal(yazma.length, 1, "tek bir bütçe POST'u beklenir");
  assert.equal(yazma[0].get("daily_budget"), "25000", "minor unit çevrimi bozulmamalı");
});
