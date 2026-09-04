// SPDX-License-Identifier: AGPL-3.0-only
/**
 * VİDEO ÇEVİRİSİ ↔ ÜRÜN METNİ.
 *
 * scripts/video-demo.mts, SIM değişimi retini jüri anlasın diye İNGİLİZCE gösterir ve
 * ürünün kendi Türkçe çıktısını hemen altına "raw output" olarak koyar. O İngilizce metin
 * ELLE yazılmıştır: koddan türemez, dolayısıyla ürün metni değişince SESSİZCE eskir.
 *
 * Eskimiş bir çeviri burada sıradan bir belge bayatlığı değil: teslim edilen videoda
 * jürinin okuduğu tek anlaşılır metin odur. Ürün "72 saat" derken video "24 saat" diyorsa,
 * jüri yanlış bilgilendirilmiş olur ve bunu fark eden biri bütün iddiaları sorgular.
 *
 * Bu gözcü çeviriyi kelime kelime doğrulamaz — öyle bir test çeviriyi dondurup her üslup
 * düzeltmesinde kızarırdı. Bunun yerine İKİSİNİN DE söylemek zorunda olduğu ÖLÇÜLEBİLİR
 * OLGULARI çiviler: pencere uzunluğu, sinyalin adı, istemin hiç gösterilmediği, ve
 * harcamanın uygulanmadığı.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { agDogrula, __setSimSwapKanalForTests } from "../src/networkTrust.js";
import { INGILIZCE_RET } from "../scripts/video-metin.mjs";

const CEVIRI = INGILIZCE_RET.join(" ");

/** Videonun gösterdiği vakanın ta kendisi: 72 saatlik pencere, SIM değişmiş. */
async function retMetni(): Promise<string> {
  __setSimSwapKanalForTests({ verifySimSwap: async () => true });
  try {
    const karar = await agDogrula(
      {
        nacToken: "TEST-ONLY-token",
        approverPhone: "+905551112233",
        simSwapWindowHours: 72,
      } as any,
      "high"
    );
    assert.ok(karar.engel, "bu vakada kapı reddetmeliydi — gözcünün dayanağı kalmaz");
    return karar.engel!;
  } finally {
    __setSimSwapKanalForTests(undefined);
  }
}

test("çeviri ile ürün metni AYNI pencereyi söylüyor", async () => {
  const ret = await retMetni();
  assert.match(ret, /72 saat/u, "ürün metni 72 saatlik pencereyi söylemeli");
  assert.match(CEVIRI, /72 hours/u, "çeviri de 72 saati söylemeli — video yanlış sayı gösteremez");
});

test("çeviri ile ürün metni AYNI sinyali adlandırıyor", async () => {
  const ret = await retMetni();
  assert.match(ret, /SIM Swap|SIM kart/u, "ürün metni SIM değişimini adıyla anmalı");
  assert.match(CEVIRI, /SIM Swap/u, "çeviri sinyalin CAMARA adını taşımalı");
  assert.match(CEVIRI, /GSMA Open Gateway/u, "kaynağın adı videoda görünmeli");
});

test("KRİTİK: iki metin de 'istem hiç gösterilmedi' diyor", async () => {
  /**
   * Videonun tek cümlelik iddiası bu. Ürün metninden düşerse video söylenmeyen bir şeyi
   * söylüyor olur; çeviriden düşerse jüri asıl noktayı hiç okumaz.
   */
  const ret = await retMetni();
  assert.match(ret, /onay istemi hiç gösterilmedi/u, "ürün metni istemin gösterilmediğini söylemeli");
  assert.match(CEVIRI, /approval prompt was never shown/u, "çeviri de bunu söylemeli");
});

test("iki metin de harcamanın UYGULANMADIĞINI söylüyor", async () => {
  const ret = await retMetni();
  assert.match(ret, /harcama artışı uygulanmaz/u, "ürün metni harcamanın durduğunu söylemeli");
  assert.match(CEVIRI, /No spend increase is applied/u, "çeviri de bunu söylemeli");
});

test("çeviri ürünün SÖYLEMEDİĞİ bir şeyi iddia etmiyor", async () => {
  /**
   * Ters yön: çeviri, ham çıktının vermediği bir güvence eklemesin. Videoda "engellendi,
   * hesap kilitlendi, saldırgan tespit edildi" gibi bir cümle görünmesi, kapının
   * yapmadığı bir şeyi vaat etmek olurdu.
   */
  for (const asiri of [/blocked the attacker/iu, /account (is )?locked/iu, /reported to/iu, /guarantee/iu]) {
    assert.doesNotMatch(CEVIRI, asiri, `çeviri kapının yapmadığı bir şeyi iddia ediyor: ${asiri}`);
  }
});
