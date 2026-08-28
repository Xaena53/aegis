// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Kanallar arası bütçe dağıtımı.
 *
 * İki kuralı sınar ve ikisi de "uydurmama" ilkesinin uygulamasıdır:
 *   1) Yapılandırılmamış kanala pay verilmez — yoksa çalışmayacak bir planı öneri diye
 *      sunmuş oluruz.
 *   2) Toplam, operatörün verdiği sayıyı aşamaz. Bu, sunucudaki tavan KAMPANYA BAŞINA
 *      olduğu için kendiliğinden korunmaz: 50 TL tavanlı bir hesapta 40+40 dağıtımının
 *      her parçası tavanın altındadır ama toplam 80 TL eder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  butceDagit,
  dagitimDogrula,
  dagitimOzeti,
  kullanilabilirKanallar,
} from "../../scripts/brain/dagitim.mjs";

/* ── Kanal keşfi ─────────────────────────────────────────────────────────── */

test("kullanilabilirKanallar: Google her zaman var, Meta yalnız TAM yapılandırmayla", () => {
  assert.deepEqual(kullanilabilirKanallar({}), ["google"]);
  assert.deepEqual(
    kullanilabilirKanallar({ ADSPILOT_META_TOKEN: "t", ADSPILOT_META_AD_ACCOUNT_ID: "act_1" }),
    ["google", "meta"]
  );
});

test("kullanilabilirKanallar: Meta YARIM yapılandırmada sayılmaz (kapalı arıza)", () => {
  // Jeton var hesap yok: araç zaten kapalı arızaya gider, ona pay ayırmak boş vaat olur.
  assert.deepEqual(kullanilabilirKanallar({ ADSPILOT_META_TOKEN: "t" }), ["google"]);
  assert.deepEqual(kullanilabilirKanallar({ ADSPILOT_META_AD_ACCOUNT_ID: "act_1" }), ["google"]);
  assert.deepEqual(
    kullanilabilirKanallar({ ADSPILOT_META_TOKEN: "  ", ADSPILOT_META_AD_ACCOUNT_ID: "act_1" }),
    ["google"]
  );
});

/* ── Doğrulama: iki sert kural ───────────────────────────────────────────── */

test("KRİTİK: toplam bütçeyi AŞAN dağıtım reddedilir (tavan kampanya başınadır)", () => {
  assert.throws(
    () =>
      dagitimDogrula(
        [
          { kanal: "google", gunlukButce: 40, gerekce: "arama niyeti" },
          { kanal: "meta", gunlukButce: 40, gerekce: "keşif" },
        ],
        50,
        ["google", "meta"]
      ),
    /toplamı verilen bütçeyle uyuşmuyor|KAMPANYA BAŞINADIR/
  );
});

test("KRİTİK: yapılandırılmamış kanala pay verilemez", () => {
  assert.throws(
    () => dagitimDogrula([{ kanal: "meta", gunlukButce: 50, gerekce: "x" }], 50, ["google"]),
    /yapılandırılmamış kanal/
  );
  assert.throws(
    () => dagitimDogrula([{ kanal: "tiktok", gunlukButce: 50, gerekce: "x" }], 50, ["google"]),
    /yapılandırılmamış kanal/
  );
});

test("gerekçesiz pay reddedilir — denetlenemeyen dağıtım kabul edilmez", () => {
  assert.throws(
    () => dagitimDogrula([{ kanal: "google", gunlukButce: 50, gerekce: "  " }], 50, ["google"]),
    /GEREKÇE yok/
  );
});

test("aynı kanal iki kez pay alamaz", () => {
  assert.throws(
    () =>
      dagitimDogrula(
        [
          { kanal: "google", gunlukButce: 25, gerekce: "a" },
          { kanal: "google", gunlukButce: 25, gerekce: "b" },
        ],
        50,
        ["google", "meta"]
      ),
    /birden çok kez/
  );
});

test("geçersiz/negatif/sıfır tutar reddedilir", () => {
  for (const kotu of [0, -5, "abc", undefined, NaN]) {
    assert.throws(
      () => dagitimDogrula([{ kanal: "google", gunlukButce: kotu, gerekce: "x" }], 50, ["google"]),
      /geçersiz/
    );
  }
});

test("kuruş sapması tolere edilir ama DAR: 0.01 geçer, 0.5 geçmez", () => {
  const az = dagitimDogrula(
    [
      { kanal: "google", gunlukButce: 33.33, gerekce: "a" },
      { kanal: "meta", gunlukButce: 66.67, gerekce: "b" },
    ],
    100,
    ["google", "meta"]
  );
  assert.equal(az.length, 2);

  assert.throws(
    () =>
      dagitimDogrula(
        [
          { kanal: "google", gunlukButce: 33, gerekce: "a" },
          { kanal: "meta", gunlukButce: 66.5, gerekce: "b" },
        ],
        100,
        ["google", "meta"]
      ),
    /uyuşmuyor/,
    "yarım liralık sapma gerçek bir hatayı gizleyebilir — tolere edilmemeli"
  );
});

test("doğrulama normalize eder: kanal adı küçük harfe iner, boşluk kırpılır", () => {
  const d = dagitimDogrula([{ kanal: " GOOGLE ", gunlukButce: 50, gerekce: " sebep " }], 50, ["google"]);
  assert.deepEqual(d, [{ kanal: "google", gunlukButce: 50, gerekce: "sebep" }]);
});

/* ── Dağıtım akışı ───────────────────────────────────────────────────────── */

test("tek kanal varsa MODEL HİÇ ÇAĞRILMAZ — cevabı belli soruya LLM harcanmaz", async () => {
  let cagrildi = false;
  const d = await butceDagit(
    { hedef: "x", toplamButce: 50, kanallar: ["google"], arastirma: {} },
    {
      jsonUret2: async () => {
        cagrildi = true;
        return { dagitim: [] };
      },
    }
  );
  assert.equal(cagrildi, false, "tek kanalda model çağrılmamalı");
  assert.deepEqual(d, [
    { kanal: "google", gunlukButce: 50, gerekce: "Tek yapılandırılmış kanal (google) — bölünecek başka kanal yok." },
  ]);
});

test("çok kanalda model çağrılır ve çıktısı DOĞRULAMADAN geçirilir", async () => {
  const d = await butceDagit(
    { hedef: "ayakkabı sat", toplamButce: 100, kanallar: ["google", "meta"], arastirma: {} },
    {
      jsonUret2: async () => ({
        dagitim: [
          { kanal: "google", gunlukButce: 70, gerekce: "yüksek arama niyeti" },
          { kanal: "meta", gunlukButce: 30, gerekce: "görsel keşif" },
        ],
      }),
    }
  );
  assert.equal(d.length, 2);
  assert.equal(d[0].gunlukButce + d[1].gunlukButce, 100);
});

test("KRİTİK: modelin bozuk dağıtımı SESSİZCE DÜZELTİLMEZ, hata verir", async () => {
  await assert.rejects(
    butceDagit(
      { hedef: "x", toplamButce: 100, kanallar: ["google", "meta"], arastirma: {} },
      {
        jsonUret2: async () => ({
          dagitim: [
            { kanal: "google", gunlukButce: 90, gerekce: "a" },
            { kanal: "meta", gunlukButce: 90, gerekce: "b" },
          ],
        }),
      }
    ),
    /uyuşmuyor/,
    "payları normalize edip devam etmek, modelin planına bizim sayımızı karıştırmak olurdu"
  );
});

test("dagitimOzeti okunur tek satır üretir", () => {
  assert.equal(
    dagitimOzeti([
      { kanal: "google", gunlukButce: 70, gerekce: "a" },
      { kanal: "meta", gunlukButce: 30, gerekce: "b" },
    ]),
    "google: 70 · meta: 30"
  );
});
