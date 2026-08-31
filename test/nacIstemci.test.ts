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

test("SDK'nın kendi rapidapiHost seçeneği de verilir (Nokia'nın resmî yolu)", () => {
  /**
   * Nokia'dan gelen cevap (Aleksi Puranen, 31.08.2026): SDK host'u kendiliğinden
   * göndermiyor, bu bir eksiklik ve iletildi; doğru kullanım `rapidapiHost` seçeneği.
   *
   * Elle konan başlık kaldırılmadı — canlıda ölçülerek doğrulanan yol oydu ve fazlalığın
   * maliyeti yok. Bu test ikisinin AYNI değeri taşıdığını sabitler: biri güncellenip
   * diğeri unutulursa, iki host arasında sessiz bir çelişki doğardı.
   */
  const s = nacIstemciSecenekleri("sahte-token");
  assert.equal(s.rapidapiHost, "network-as-code.nokia.rapidapi.com");
  assert.equal(
    s.rapidapiHost,
    s.headers["X-RapidAPI-Host"],
    "seçenek ile başlık aynı host'u göstermeli"
  );
});
