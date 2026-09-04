// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Video demosunun EKRANA BASTIĞI sabit metinler — yan etkisiz.
 *
 * Ayrı bir dosyada, çünkü scripts/video-demo.mts bir GİRİŞ NOKTASIDIR: içe aktarıldığı
 * anda demoyu koşturur ve gerçek CAMARA çağrıları yapar. Metni oradan import etmek,
 * test takımını her koşuda ağa çıkarırdı.
 */

/**
 * SIM değişimi retinin İNGİLİZCE karşılığı — videoda anlaşılırlığı bu taşır.
 *
 * Ürünün metinleri Türkçedir; bu bir eksiklik değil, bugünkü hedef pazarın dilidir ve
 * çok dilli ret metinleri yol haritasında durur. Ama jüri uluslararası, ve videonun en
 * kritik karesinde anlaşılmayan bir metin kanıt sayılmaz. Ham Türkçe çıktı ekrandan
 * SİLİNMEZ — "raw output" etiketiyle hemen altında durur.
 *
 * SADIK ÇEVİRİ: ham çıktının söylediğinden ne fazlasını söyler ne azını. Elle yazıldığı
 * için kayabilir; test/videoCevirisi.test.ts ikisinin de aynı ÖLÇÜLEBİLİR olguları
 * (pencere, sinyal adı, istemin gösterilmemesi, harcamanın durması) söylediğini çiviler.
 */
export const INGILIZCE_RET = [
  "REFUSED: NETWORK VERIFICATION FAILED — the approver's SIM card changed",
  "within the last 72 hours (GSMA Open Gateway SIM Swap). This is the classic",
  "sign of an account-takeover attack; the approval prompt was never shown.",
  "No spend increase is applied until the account owner confirms. The user",
  "MUST be told about this.",
];
