// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 3 — src/meta/client.ts: three round-one findings, each locked by a watchdog that is
 * shown to be able to go red.
 *
 * WHAT IS MEASURED HERE, AND WHY IT CANNOT BE MEASURED ELSEWHERE: the tool tests inject a
 * fake channel, so they never run this client's own logic. These tests stub `fetch` and
 * drive the real channel, which is the only place where "what the client concludes from a
 * response" is observable.
 *
 *   1) A cancellation that lands WHILE THE BODY IS BEING READ is the strongest form of
 *      "we could not observe the outcome" — the request certainly reached Meta. It must not
 *      be summarised as a failure. (Found already closed in a later round; the watchdog
 *      keeps it closed, and the ROAD NOT TAKEN — a read — must stay a plain failure.)
 *   2) The "no ACTIVE ad set" refusal used to call itself the Meta equivalent of the Google
 *      side's "no deliverable ad" rule. It is not: a CBO campaign never reaches it. The
 *      sentence was brought down to the truth, and this file guards BOTH directions — the
 *      claim must not come back, and if the code ever starts observing delivery on the CBO
 *      path the note has to be rewritten with it.
 *   3) `butceGuncelle` and `durumDegistir` threw the response body away, so a 200 that
 *      carried no evidence at all was reported to the operator as "durumu: ACTIVE".
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { metaKanali, __setMetaKanalForTests, belirsizSonucMu } from "../src/meta/client.js";

const JETON = "TEST-ONLY-faz3-meta-jeton-123456";
const AYAR = { metaToken: JETON, metaAdAccountId: "act_1" };
const KAMPANYA = "120200000000009";
const HESAP = { currency: "USD", currency_offset: 100 };

const gercekFetch = globalThis.fetch;
/** Paths of every call that went out — "the ad sets were never asked for" must be
 * measurable, not assumed. */
let yollar: string[] = [];
/** Parsed POST bodies, so "the write really was attempted" can be asserted. */
let govdeler: URLSearchParams[] = [];

afterEach(() => {
  globalThis.fetch = gercekFetch;
  __setMetaKanalForTests(undefined);
  yollar = [];
  govdeler = [];
});

/**
 * A stub in which the ACCOUNT (currency) and the AD SETS always answer normally, and only
 * the node call — the write, or the campaign read — is under the test's control. The
 * currency has to succeed or the write path never reaches the wire at all.
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

/** A body read that dies mid-stream — the headers had already arrived. */
const govdedeIptal = async (): Promise<string> => {
  const e: any = new Error("The operation was aborted");
  e.name = "AbortError";
  throw e;
};

/* ── BULGU 1: gövde okunurken gelen iptal de "sonucu bilinmiyor"dur ─────────── */

test("KRİTİK: YAZMA yanıtının GÖVDESİ okunurken iptal gelirse 'başarısız' denmez", async () => {
  /**
   * This is the more certain of the two cancellations: a response object exists, so the
   * POST reached Meta and was processed. Reporting it as a failure tells the agent nothing
   * happened, and its usual next move is a retry — a second budget rise, a second campaign.
   */
  const k = kur(govdedeIptal);

  await assert.rejects(
    () => k.durumDegistir(KAMPANYA, "ACTIVE"),
    (e: any) => {
      assert.ok(belirsizSonucMu(e), "belirsizlik SINIF olarak taşınmalı, cümlenin ezberiyle değil");
      assert.match(e.message, /SONUCU BİLİNMİYOR/u, "sonucun bilinmediği açıkça söylenmeli");
      assert.match(e.message, /TEKRAR DENEME/u, "tekrar denemenin tehlikesi söylenmeli");
      assert.doesNotMatch(e.message, /başarısız/iu, "'başarısız' yanlış ve tehlikeli bir özettir");
      return true;
    }
  );
});

test("OKUMA gövdesindeki iptal gerçekten başarısızdır (yöntem ayrımı korunuyor)", async () => {
  /**
   * The counter-check that keeps the fix above from being widened into "every cancellation
   * is uncertain": a GET that lost its body changed nothing, and calling that an unresolved
   * uncertainty would put a read fault on the same shelf as a possibly-applied write.
   */
  const k = kur(govdedeIptal);

  await assert.rejects(
    () => k.kampanyaOku(KAMPANYA),
    (e: any) => {
      assert.ok(!belirsizSonucMu(e), "okuma arızası belirsiz sonuç sınıfına girmemeli");
      return true;
    }
  );
});

/* ── BULGU 3: gövdesinde kanıt olmayan yazma "yapıldı" sayılmaz ─────────────── */

for (const [ad, govde] of [
  ["boş gövde (200 ama hiçbir kanıt yok)", ""],
  ["success:false", JSON.stringify({ success: false })],
  ["JSON ama alakasız gövde", JSON.stringify({ mesaj: "ok" })],
] as Array<[string, string]>) {
  test(`KRİTİK: durum yazması ${ad} ile 'uygulandı' sayılmaz`, async () => {
    /**
     * `kampanyaOlustur` has always refused a response without an id. The same rule was
     * missing here, so a 200 with an empty body — which `graf` turns into `{}` — produced
     * the sentence "durumu: ACTIVE" for a change nobody ever observed. In the opposite
     * direction it is worse: an emergency pause reported as PAUSED while the campaign
     * keeps spending.
     */
    const k = kur(async () => govde);

    await assert.rejects(
      () => k.durumDegistir(KAMPANYA, "ACTIVE"),
      (e: any) => {
        assert.ok(belirsizSonucMu(e), "kanıtsız yanıt belirsiz sonuç sınıfına düşmeli");
        assert.match(e.message, /SONUCU BİLİNMİYOR/u);
        assert.match(e.message, /TEKRAR DENEME/u);
        assert.doesNotMatch(e.message, /başarısız/iu, "istek Meta'ya ULAŞTI; 'başarısız' yanlış özet");
        return true;
      }
    );

    /**
     * The refusal is about the CLAIM, not about the request: the POST must already have
     * gone out. A guard that quietly stopped sending the write would turn a reporting fix
     * into a silent loss of the operator's pause.
     */
    assert.ok(
      govdeler.some((g) => g.get("status") === "ACTIVE"),
      "yazma isteği yine de gönderilmiş olmalı — reddedilen, sonucun 'uygulandı' diye sunulması"
    );
  });
}

test("KRİTİK: bütçe yazması kanıtsız gövdede 'uygulandı' sayılmaz", async () => {
  const k = kur(async () => JSON.stringify({ success: false }));

  await assert.rejects(
    () => k.butceGuncelle(KAMPANYA, 200),
    (e: any) => {
      assert.ok(belirsizSonucMu(e), "bütçe yazması da aynı disipline tabi");
      assert.match(e.message, /SONUCU BİLİNMİYOR/u);
      return true;
    }
  );
  assert.ok(
    govdeler.some((g) => g.get("daily_budget") === "20000"),
    "bütçe POST'u gönderilmiş olmalı (minor unit çevrimi de bozulmamalı)"
  );
});

test("KARŞI KONTROL: teyitli yanıtlar (success:true / id) hâlâ geçer", async () => {
  /**
   * Without this the watchdog above could be satisfied by a client that refuses every
   * write — a gate that never opens is not a gate, and it would take the product down
   * while the suite stayed green.
   */
  const k1 = kur(async () => JSON.stringify({ success: true }));
  await k1.durumDegistir(KAMPANYA, "PAUSED");

  const k2 = kur(async () => JSON.stringify({ id: KAMPANYA }));
  await k2.butceGuncelle(KAMPANYA, 200);

  assert.ok(
    govdeler.some((g) => g.get("daily_budget") === "20000"),
    "teyitli yolda yazma çalışmaya devam etmeli"
  );
});

/* ── BULGU 2: "Google karşılığı" iddiası — çift yönlü belge gözcüsü ─────────── */

const KAYNAK = readFileSync(new URL("../src/meta/client.ts", import.meta.url), "utf8");
const GOOGLE_IKIZI = readFileSync(new URL("../src/tools/write.ts", import.meta.url), "utf8");

test("BELGE: 'yayınlanabilir reklam yok kuralının Meta karşılığı' iddiası geri gelmemeli", () => {
  /**
   * Direction one: the sentence must not come back. It described a guard reachable only
   * through ONE branch of a budget read as though it were the Google side's unconditional
   * go-live gate — a promise of coverage that does not exist.
   */
  assert.ok(
    !/kuralının Meta karşılığı/u.test(KAYNAK),
    "reklam seti kontrolü Google'ın teslimat kapısının karşılığı DEĞİL; iddia geri konmamalı"
  );
  assert.match(KAYNAK, /NOT A DELIVERY GATE/u, "boşluğun neden boşluk olduğu kaynakta yazılı kalmalı");
  assert.match(
    KAYNAK,
    /tools\/meta\.ts/u,
    "gerçek teslimat kapısının nereye ait olduğu (tools/meta.ts) yazılı kalmalı"
  );
});

test("BELGE+KOD: CBO okuması reklam setlerini HÂLÂ hiç sormuyor (yorum bayatlamadı)", async () => {
  /**
   * Direction two: the note is only true while the CBO path really makes no delivery
   * observation. The day someone lists the ad sets there as well, this goes red and the
   * comment has to be rewritten with the code — which is the whole point of a two-way
   * watchdog. If that is you: keep the gate, fix the sentence, then update this test.
   */
  const k = kur(async () =>
    JSON.stringify({
      id: KAMPANYA,
      name: "CBO",
      objective: "OUTCOME_TRAFFIC",
      status: "PAUSED",
      daily_budget: "20000",
    })
  );
  const c = await k.kampanyaOku(KAMPANYA);

  assert.equal(c.butceKaynagi, "kampanya", "CBO kampanyada bütçe kampanya düzeyinden okunur");
  assert.equal(c.gunlukButce, 200, "okuma çalışmaya devam etmeli");
  assert.ok(
    !yollar.some((y) => y.endsWith("/adsets")),
    "CBO yolunda teslimat gözlemi YOK; yorum bunu söylüyorsa kod da böyle kalmalı"
  );
});

test("KOD: reklam setleri yolundaki RET duruyor (belge düzeltmesi gözcüyü söküp atmadı)", async () => {
  /**
   * The comment fix must not have quietly removed the refusal it describes: on the non-CBO
   * path a campaign with no ACTIVE ad set still yields no budget figure, and the go-live
   * gate in tools/meta.ts refuses on exactly that.
   */
  const k = kur(
    async () =>
      JSON.stringify({ id: KAMPANYA, name: "ABO", objective: "OUTCOME_TRAFFIC", status: "PAUSED" }),
    { data: [{ id: "1", name: "Set", status: "PAUSED", daily_budget: "10000" }] }
  );
  const c = await k.kampanyaOku(KAMPANYA);

  assert.equal(c.gunlukButce, undefined, "ACTIVE set yoksa doğrulanmış bütçe de yok");
  assert.match(String(c.butceNotu), /ACTIVE reklam seti yok/u, "sebep operatöre söylenmeli");
});

test("BELGE: Google ikizinin koşulsuz teslimat kapısı gerçekten orada", () => {
  /**
   * The comment in client.ts asserts what the Google twin does. An assertion about another
   * file is exactly the kind of sentence that rots silently, so it is measured: if
   * set_campaign_status ever stops asking for an ENABLED ad, the Meta-side comment is
   * describing a twin that no longer exists.
   */
  assert.match(
    GOOGLE_IKIZI,
    /ad_group_ad\.status = 'ENABLED'/u,
    "Google tarafındaki 'yayınlanabilir reklam' sorgusu yorumun dayandığı gerçek"
  );
});
