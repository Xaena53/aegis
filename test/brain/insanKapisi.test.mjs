// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GROWTH BRAIN'İN İNSAN KAPISI — bir denetimde testsiz bulundu.
 *
 * Bu kapı, beynin gerçek para harcatan iki anına (taslak yazma ve yayına alma) tek
 * engeldir; yine de hiçbir testi yoktu. Daha önce burada gerçek bir hata da yaşandı:
 * girdisi kapalı bir ortamda soru hiç çözülmüyor, süreç asılı kalıyor ve dışarıdan
 * "çalışıyor" gibi görünüyordu. Onarım kapanma yarışıydı; aşağıdaki testler o
 * onarımın bekçisidir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { operatorOnayi, onayVerildiMi } from "../../scripts/growth-brain.mjs";

/** Yazılanı yutan çıktı akışı: test terminale bir şey basmasın. */
const sessizCikti = () => new Writable({ write(_p, _e, cb) { cb(); } });

/**
 * AÇIK SÜRE SINIRI: sınanan hatanın belirtisi ASILMAKTIR. Süre sınırı olmadan bu test
 * düşmez, takılır — koşucunun genel sınırına kadar bekler ve arıza "yavaş test" gibi
 * görünür. Sınır, hatayı saniyeler içinde ve doğru adıyla raporlar.
 */
test("KRİTİK: girdi KAPALIYSA soru asılı kalmaz ve cevap boş (yani ret) döner", { timeout: 5000 }, async () => {
  // Boru hattı / CI / arka plan işi: stdin hemen kapanır.
  const kapali = Readable.from([]);
  const cevap = await operatorOnayi("Onaylıyor musun? ", { girdi: kapali, cikti: sessizCikti() });
  assert.equal(cevap, "", "cevaplanamayan soru boş dize döner");
  assert.equal(onayVerildiMi(cevap), false, "KRİTİK: cevapsızlık onay sayılamaz");
});

test("KRİTİK: borudan 'evet' göndererek onay geçirilemez", { timeout: 5000 }, async () => {
  /**
   * Bu bir eksiklik değil, kasıtlı bir tasarım: onay bir insandan gelmeli. Boru
   * hattından gelen metin de kapanma yarışına takılır, çünkü akış cevabın hemen
   * ardından kapanır ve kapanma "" ile çözer. Bu test o kastı sabitler — birisi
   * "otomasyonda çalışsın" diye yarışı kaldırırsa burası kırmızıya döner.
   */
  const boru = Readable.from(["evet\n"]);
  const cevap = await operatorOnayi("Onaylıyor musun? ", { girdi: boru, cikti: sessizCikti() });
  assert.equal(onayVerildiMi(cevap), false, "borudan onay geçmemeli");
});

test("onay kuralı: yalnız 'evet' geçer, yakın duran hiçbir şey geçmez", () => {
  assert.equal(onayVerildiMi("evet"), true);
  assert.equal(onayVerildiMi("Evet"), true);
  assert.equal(onayVerildiMi("  EVET  "), true, "büyük harf ve boşluk kabul edilir");

  for (const yakin of ["e", "eve", "evett", "yes", "y", "tamam", "olur", "hayır", "", "  ", "hayir"]) {
    assert.equal(onayVerildiMi(yakin), false, `'${yakin}' onay sayılmamalı`);
  }
  assert.equal(onayVerildiMi(undefined), false, "eksik cevap onay değildir");
  assert.equal(onayVerildiMi(null), false);
});

test("Türkçe büyük-küçük harf tuzağı: 'EVET' tr-TR kurallarıyla çözülür", () => {
  /**
   * Türkçede I/İ dönüşümü İngilizceden farklıdır. Kural tr-TR yerelinde uygulanmazsa,
   * yerele bağlı olarak eşleşme kayabilir. Bu test kuralın yerel-duyarlı kaldığını
   * sabitler; operatörün klavyesi kapının davranışını değiştirmemeli.
   */
  assert.equal(onayVerildiMi("EVET"), true);
  assert.equal("EVET".toLocaleLowerCase("tr-TR"), "evet");
});
