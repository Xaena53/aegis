// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 5A — src/meta/client.ts: the two defects the independent audit measured.
 *
 * WHY THESE CANNOT BE MEASURED IN THE TOOL TESTS: those inject a fake channel, so the
 * client's own logic never runs. Everything here stubs `fetch` and drives the real channel,
 * which is the only place where "what the client concludes from a response" is observable.
 *
 *   1) A 200 whose body is not JSON. `graf` guarded the transport and the body read, but the
 *      parse sat outside both, so `JSON.parse` threw a bare SyntaxError. That class is not
 *      MetaBelirsizSonuc, so tools/meta.ts summarised it as "Meta işlemi başarısız" — the
 *      one sentence that asserts NOTHING HAPPENED, for a request Meta answered and may
 *      already have applied. On a write that invites the retry that raises a budget twice.
 *      The READ direction is a counter-check here, not an oversight: a GET whose body would
 *      not parse changed nothing, so it must stay a plain failure.
 *
 *   2) The delivery gate. The FALSE SENTENCE was taken out in an earlier round and is held
 *      out by test/faz3MetaClient.test.ts; what stays open is the GATE ITSELF, and it does
 *      not belong to this file — the Google twin sits in tools/write.ts (set_campaign_status)
 *      and the Meta one has to sit in tools/meta.ts. What this file can pin is the CLIENT's
 *      share of it: a CBO read observes no delivery, so it must not grow a field that a gate
 *      could mistake for one. The day this client really does observe delivery, the pin goes
 *      red — and the comment that says it does not has to be rewritten in the same commit.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { metaKanali, __setMetaKanalForTests, belirsizSonucMu } from "../src/meta/client.js";

const JETON = "TEST-ONLY-faz5-meta-jeton-1234567890";
const AYAR = { metaToken: JETON, metaAdAccountId: "act_1" };
const KAMPANYA = "120200000000005";
const HESAP = { currency: "USD", currency_offset: 100 };

const gercekFetch = globalThis.fetch;
/** Paths of every call that went out, so "the write really was attempted" is measured. */
let yollar: string[] = [];
/** Parsed POST bodies, same reason. */
let govdeler: URLSearchParams[] = [];

afterEach(() => {
  globalThis.fetch = gercekFetch;
  __setMetaKanalForTests(undefined);
  yollar = [];
  govdeler = [];
});

/**
 * The account (currency) and the ad sets always answer normally; only the node call — the
 * write, or the campaign read — is under the test's control. The currency has to succeed or
 * the write path never reaches the wire at all.
 */
function kur(dugumYaniti: () => Promise<string>, adsets: unknown = { data: [] }) {
  globalThis.fetch = (async (u: any, init: any) => {
    const yol = String(u).split("?")[0];
    yollar.push(yol);
    if (init?.body) govdeler.push(new URLSearchParams(String(init.body)));
    if (yol.endsWith("/act_1")) return { ok: true, text: async () => JSON.stringify(HESAP) } as any;
    if (yol.endsWith("/adsets")) return { ok: true, text: async () => JSON.stringify(adsets) } as any;
    return { ok: true, text: dugumYaniti } as any;
  }) as typeof fetch;
  __setMetaKanalForTests(undefined);
  return metaKanali(AYAR);
}

/**
 * What a proxy, a captive portal or a WAF really answers with: HTTP 200 and an HTML page.
 * It is long, and it carries the token in the shape Meta's own error bodies echo — both of
 * the things the boundary has to keep away from the agent.
 */
const VEKIL_SAYFASI =
  `<html><body>vekil hata sayfasi access_token=${JETON} ` + "Z".repeat(600) + `</body></html>`;
const jsonDegil = async (): Promise<string> => VEKIL_SAYFASI;

/* ── KUSUR 2: 200 + JSON olmayan gövde — YAZMADA "başarısız" DEĞİL ─────────────── */

for (const [ad, calistir] of [
  ["durum", (k: ReturnType<typeof kur>) => k.durumDegistir(KAMPANYA, "ACTIVE")],
  ["bütçe", (k: ReturnType<typeof kur>) => k.butceGuncelle(KAMPANYA, 200)],
] as Array<[string, (k: ReturnType<typeof kur>) => Promise<void>]>) {
  test(`KRİTİK: ${ad} yazmasında 200 + JSON olmayan gövde "başarısız" diye özetlenemez`, async () => {
    /**
     * Meta answered at all, so the request arrived; on a write it may already have been
     * applied. "başarısız" asserts the opposite, and the agent's next move after it is a
     * retry — a second budget rise, or a second campaign.
     */
    const k = kur(jsonDegil);

    await assert.rejects(
      () => calistir(k),
      (e: any) => {
        assert.ok(
          belirsizSonucMu(e),
          "belirsizlik SINIF olarak taşınmalı — cümlenin ezberiyle değil"
        );
        assert.match(e.message, /SONUCU BİLİNMİYOR/u, "sonucun bilinmediği açıkça söylenmeli");
        assert.match(e.message, /TEKRAR DENEME/u, "tekrar denemenin tehlikesi söylenmeli");
        assert.doesNotMatch(
          e.message,
          /başarısız/iu,
          "'başarısız' istek Meta'ya ULAŞMIŞKEN yanlış ve tehlikeli bir özettir"
        );
        assert.match(e.message, /ayrıştırılamadı/u, "sebep operatöre söylenmeli");
        // The boundary rules that apply to every upstream text apply to this one too.
        assert.ok(!e.message.includes(JETON), "jeton ajana geçmemeli");
        assert.ok(!e.message.includes("ZZZZZZZZZZ"), "upstream gövdesi olduğu gibi taşınmamalı");
        assert.ok(e.message.length <= 600, `mesaj tavanlı kalmalı (uzunluk: ${e.message.length})`);
        return true;
      }
    );

    /**
     * The refusal is about the CLAIM, not about the request: the POST must already have gone
     * out. A "fix" that quietly stopped sending the write would turn a labelling repair into
     * a silent loss of the operator's pause.
     */
    assert.ok(govdeler.length > 0, "yazma isteği yine de gönderilmiş olmalı");
  });
}

test("KARŞI KONTROL: geçerli JSON yanıt hâlâ geçer (kapı her yazmayı reddetmiyor)", async () => {
  /**
   * Without this the watchdog above is satisfied by a client that refuses every write. A
   * gate that never opens is not a gate; it takes the product down while the suite stays
   * green.
   */
  const k1 = kur(async () => JSON.stringify({ success: true }));
  await k1.durumDegistir(KAMPANYA, "PAUSED");

  const k2 = kur(async () => JSON.stringify({ id: KAMPANYA }));
  await k2.butceGuncelle(KAMPANYA, 200);

  assert.ok(
    govdeler.some((g) => g.get("daily_budget") === "20000"),
    "teyitli yolda yazma çalışmaya devam etmeli (minor-unit çevrimi dahil)"
  );
});

test("BOŞ gövde hâlâ 'kanıtsız' — parse onarımı yazma teyidini atlatmadı", async () => {
  /**
   * The repair added an early return for the empty body, which is the shape `yazmaTeyidi`
   * already refuses (`{}` carries neither success nor an id). Measured here so the early
   * return cannot become a way past that older gate.
   */
  const k = kur(async () => "");

  await assert.rejects(
    () => k.durumDegistir(KAMPANYA, "ACTIVE"),
    (e: any) => {
      assert.ok(belirsizSonucMu(e), "kanıtsız 200 belirsiz sonuç sınıfında kalmalı");
      assert.match(e.message, /SONUCU BİLİNMİYOR/u);
      return true;
    }
  );
});

test("YÖNTEM AYRIMI: OKUMADA ayrıştırılamayan gövde gerçekten başarısızdır", async () => {
  /**
   * The counter-check that keeps the repair from being widened into "every unparseable body
   * is uncertain". A GET whose body would not parse changed nothing, so calling it a
   * possibly-applied write would put a read fault on the same shelf as a money movement —
   * and would hand the operator a warning they cannot act on.
   */
  const k = kur(jsonDegil);

  await assert.rejects(
    () => k.kampanyaOku(KAMPANYA),
    (e: any) => {
      assert.ok(!belirsizSonucMu(e), "okuma arızası belirsiz sonuç sınıfına girmemeli");
      assert.doesNotMatch(e.message, /SONUCU BİLİNMİYOR/u, "okuma için yazma cümlesi kurulmaz");
      return true;
    }
  );
});

test("OKUMA yolu: reklam seti gövdesi JSON değilse sebep MASKELİ nota döner", async () => {
  /**
   * The other half of the method split, and the reason the GET path was deliberately left
   * alone: `reklamSetiButcesi` catches that SyntaxError and turns it into `butceNotu`, which
   * is a surface the agent sees. The refusal is the correct one — but the note is cleaned and
   * capped, because the SyntaxError message carries a prefix of the upstream body.
   */
  const k = kur(
    async () =>
      JSON.stringify({ id: KAMPANYA, name: "ABO", objective: "OUTCOME_TRAFFIC", status: "PAUSED" }),
    undefined
  );
  // The ad-set edge answers 200 with the proxy page.
  globalThis.fetch = (async (u: any) => {
    const yol = String(u).split("?")[0];
    yollar.push(yol);
    if (yol.endsWith("/act_1")) return { ok: true, text: async () => JSON.stringify(HESAP) } as any;
    if (yol.endsWith("/adsets")) return { ok: true, text: async () => VEKIL_SAYFASI } as any;
    return {
      ok: true,
      text: async () =>
        JSON.stringify({ id: KAMPANYA, name: "ABO", objective: "OUTCOME_TRAFFIC", status: "PAUSED" }),
    } as any;
  }) as typeof fetch;

  const c = await k.kampanyaOku(KAMPANYA);
  const not = String(c.butceNotu);

  assert.equal(c.gunlukButce, undefined, "okunamayan toplam RET tarafında kalmalı");
  assert.match(not, /reklam setleri okunamadı/u, "sebep operatöre söylenmeli");
  assert.ok(!not.includes(JETON), "jeton ajana geçmemeli");
  assert.ok(!not.includes("ZZZZZZZZZZ"), "upstream gövdesi olduğu gibi taşınmamalı");
  assert.ok(not.length <= 360, `not tavanlı kalmalı (uzunluk: ${not.length})`);
});

/* ── KUSUR 1: teslimat — istemcinin kefil OLMADIĞI şey ─────────────────────────── */

const KAYNAK = readFileSync(new URL("../src/meta/client.ts", import.meta.url), "utf8");

/** The DECLARED MEMBER NAMES of MetaKampanya — read positively, not by excluding prose. */
function metaKampanyaAlanlari(): string[] {
  const bas = KAYNAK.indexOf("export interface MetaKampanya {");
  assert.ok(bas >= 0, "MetaKampanya arayüzü bulunamadı — gözcünün dayanağı kayboldu");
  const son = KAYNAK.indexOf("\n}", bas);
  assert.ok(son > bas, "MetaKampanya arayüzünün sonu bulunamadı");
  const govde = KAYNAK.slice(bas, son)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  return [...govde.matchAll(/^\s+([A-Za-z_$][\w$]*)\s*\??\s*:/gm)].map((m) => m[1]);
}

test("KEFALET: CBO okuması bütçeye kefil olur, TESLİMATA olmaz (kapı tools/meta.ts'e ait)", async () => {
  /**
   * The live shape behind the audit's finding, measured rather than described: a CBO
   * campaign whose ad sets are ALL paused comes back with a VERIFIED budget, no note, and
   * the ad sets are never listed. Nothing in this object can make a go-live gate refuse — so
   * the missing gate in tools/meta.ts is a real, still-open gap, not a wording problem.
   *
   * What this test pins is the CLIENT's side of the contract: the object must not grow a
   * field a gate could read as a delivery observation while the code makes none. If you are
   * here because you added one: keep it, rewrite the "vouches for a budget and for nothing
   * else" comment in kampanyaOku, and update this test in the same commit.
   */
  const k = kur(
    async () =>
      JSON.stringify({
        id: KAMPANYA,
        name: "CBO",
        objective: "OUTCOME_TRAFFIC",
        status: "PAUSED",
        daily_budget: "50000",
      }),
    { data: [{ id: "1", name: "Set", status: "PAUSED", daily_budget: "20000" }] }
  );
  const c = await k.kampanyaOku(KAMPANYA);

  assert.equal(c.gunlukButce, 500, "CBO bütçesi kampanya düzeyinden doğrulanır");
  assert.equal(c.butceKaynagi, "kampanya");
  assert.equal(c.butceNotu, undefined, "bütçe okundu; ret sebebi yok");
  assert.ok(
    !yollar.some((y) => y.endsWith("/adsets")),
    "CBO yolunda reklam setleri sorulmuyor — teslimat gözlemi yapılmıyor"
  );

  const teslimatGibi = Object.keys(c).filter((ad) => /teslim|gösterim|gosterim|deliver/iu.test(ad));
  assert.deepEqual(
    teslimatGibi,
    [],
    "gözlem yapılmadan teslimat alanı üretilemez: kefil olunamayan sinyal taşınmaz"
  );
});

test("KEFALET: MetaKampanya'da teslimat alanı YOK (gözcü boş kümeye kefil olmuyor)", () => {
  /**
   * The type is what the go-live gate in tools/meta.ts consumes, so the absence has to hold
   * on the type as well as on one instance. The known members are asserted FIRST: an
   * extractor that silently returned nothing would make the absence claim vacuous — the
   * failure mode this phase exists to close.
   */
  const alanlar = metaKampanyaAlanlari();
  for (const beklenen of [
    "id",
    "ad",
    "durum",
    "durumNotu",
    "gunlukButce",
    "butceKaynagi",
    "butceNotu",
    "dugumTuru",
    "dugumNotu",
  ]) {
    assert.ok(
      alanlar.includes(beklenen),
      `ayıklayıcı '${beklenen}' alanını göremedi — yokluk iddiası boş küme üzerinden kurulamaz`
    );
  }

  const teslimatGibi = alanlar.filter((ad) => /teslim|gösterim|gosterim|deliver/iu.test(ad));
  assert.deepEqual(
    teslimatGibi,
    [],
    "istemci teslimat gözlemi yapmıyor; tip de bir teslimat alanı ilan etmemeli"
  );
});
