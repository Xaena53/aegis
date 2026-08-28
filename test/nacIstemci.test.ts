// SPDX-License-Identifier: AGPL-3.0-only
/**
 * NaC SDK istemcisinin X-RapidAPI-Host başlığı.
 *
 * NEDEN AYRI BİR TEST: bu başlık olmadan platform HER çağrıya
 * `404 {"message":"API doesn't exists"}` cevabı veriyor — taban URL ve uç nokta yolu
 * doğru olsa bile. SDK başlığı kendiliğinden GÖNDERMİYOR; ölçülerek bulundu: aynı
 * gövde, aynı anahtar, yalnız bu başlık eklendiğinde yanıt `200 {"swapped":true}` oldu.
 *
 * Başlık sessizce düşerse hiçbir birim testi kızarmaz (hepsi sahte kanal enjekte eder)
 * ve kapı üretimde her seferinde "ağ yanıtsız" diyerek kapalı arızaya gider: harcama
 * hiç onaylanmaz, sebebi de aylarca anlaşılmaz. Bu yüzden bağ burada kurulur.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { nacIstemciSecenekleri } from "../src/networkTrust.js";

test("NaC istemcisi X-RapidAPI-Host başlığını gönderir (onsuz her çağrı 404)", () => {
  const secenekler = nacIstemciSecenekleri("sahte-token");
  assert.equal(
    secenekler.headers["X-RapidAPI-Host"],
    "network-as-code.nokia.rapidapi.com",
    "X-RapidAPI-Host başlığı düştü — platform bu başlık olmadan her çağrıya " +
      "404 'API doesn't exists' döner ve kapı sürekli kapalı arızaya gider."
  );
});

test("NaC istemcisi anahtarı apiKey olarak taşır ve başlığa SIZDIRMAZ", () => {
  const secenekler = nacIstemciSecenekleri("gizli-anahtar-123");
  assert.equal(secenekler.apiKey, "gizli-anahtar-123");
  for (const [ad, deger] of Object.entries(secenekler.headers)) {
    assert.doesNotMatch(
      deger,
      /gizli-anahtar-123/,
      `'${ad}' başlığı API anahtarını taşıyor — anahtar yalnız apiKey alanından gitmeli`
    );
  }
});
