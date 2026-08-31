// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BELGE TUTARLILIĞI — aynı gerçeği iki kez yazmanın bedeli.
 *
 * Bu test var olan bir sürüklenmeden doğdu: rozet "554 test" derken hemen altındaki
 * özet tablosu "487 otomatik test" diyordu ve İngilizce/Türkçe README'ler birbirinden
 * ayrı ayrı kaymıştı. İkisi de doğru olamaz, ve okuyan hangisine güveneceğini bilemez.
 *
 * Bu, ayar adları için yazılan bekçinin (ayarAdlari.test.ts) kardeşi: orada belgenin
 * KODLA, burada belgenin KENDİSİYLE tutarlı kalması sınanır. İkisi de "belge, kanıtı
 * olmayan bir şey iddia etmesin" kuralının parçası.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const KOK = path.join(import.meta.dirname, "..");
const BELGELER = ["README.md", "README.tr.md"];

function oku(ad: string): string {
  return readFileSync(path.join(KOK, ad), "utf8");
}

test("test sayısı her iki README'de ve her geçtiği yerde AYNI", () => {
  /**
   * Sayı üç ayrı yerde geçiyor: rozet, özet tablosundaki durum satırı ve geliştirme
   * bölümündeki komut yorumu. Üçü elle güncellendiği için biri unutulduğunda depo,
   * kendi hakkında iki farklı şey söyleyen bir belgeyle kalıyor.
   */
  const desenler = [
    /badge\/tests?-(\d{3,4})-/i,
    /badge\/test-(\d{3,4})-/i,
    /(\d{3,4}) automated tests/,
    /(\d{3,4}) otomatik test/,
    /(\d{3,4}) offline tests/,
    /(\d{3,4}) çevrimdışı test/,
  ];

  const bulunan = new Map<string, number[]>();
  for (const ad of BELGELER) {
    const metin = oku(ad);
    for (const d of desenler) {
      for (const m of metin.matchAll(new RegExp(d, "g"))) {
        const liste = bulunan.get(ad) ?? [];
        liste.push(Number(m[1]));
        bulunan.set(ad, liste);
      }
    }
  }

  const hepsi = [...bulunan.values()].flat();
  assert.ok(hepsi.length >= 4, `test sayısı yeterince yerde bulunamadı (${hepsi.length}) — desenler bayatlamış olabilir`);

  const benzersiz = [...new Set(hepsi)];
  assert.equal(
    benzersiz.length,
    1,
    `README'ler farklı test sayıları duyuruyor: ${benzersiz.join(", ")} — ` +
      `hepsi tek bir gerçeği göstermeli (${JSON.stringify([...bulunan])})`
  );
});

test("kapsam yüzdesi iki README arasında tutarlı", () => {
  /**
   * Aynı sürüklenme kapsam rakamı için de mümkün, üstelik daha sinsi: yüzde, testten
   * farklı olarak koşarken kimsenin gözüne çarpmaz.
   */
  const yakala = (metin: string) => {
    const cikti = new Set<string>();
    for (const m of metin.matchAll(/(\d{2}\.\d{2})%|%(\d{2}\.\d{2})/g)) {
      cikti.add(m[1] ?? m[2]);
    }
    return cikti;
  };

  const [en, tr] = BELGELER.map((a) => yakala(oku(a)));
  assert.ok(en.size > 0 && tr.size > 0, "kapsam yüzdesi hiçbir README'de bulunamadı");
  assert.deepEqual(
    [...en].sort(),
    [...tr].sort(),
    "İngilizce ve Türkçe README farklı kapsam rakamları duyuruyor"
  );
});

test("iki README aynı bölümleri taşır — biri güncellenip diğeri unutulmasın", () => {
  /**
   * Çeviri her zaman birebir olmak zorunda değil, ama BÖLÜM sayısı ayrışmaya başladıysa
   * bu, birine eklenip diğerine eklenmemiş bir içeriğin işaretidir.
   */
  const basliklar = (metin: string) => metin.split("\n").filter((s) => /^##\s/.test(s)).length;
  const en = basliklar(oku("README.md"));
  const tr = basliklar(oku("README.tr.md"));
  assert.ok(
    Math.abs(en - tr) <= 1,
    `README bölüm sayıları ayrışmış (EN ${en}, TR ${tr}) — biri güncellenip diğeri unutulmuş olabilir`
  );
});

test("sunucu yönergesi, sunduğu prompt'ların HEPSİNİ sayar", () => {
  /**
   * Bu test gerçek bir sürüklenmeden doğdu: sunucu beş prompt kaydediyordu ama
   * `instructions` metni yalnız dördünü sayıyordu — `guvenlik-durumu` eklenmiş,
   * yönergeye yazılmamıştı.
   *
   * Sonucu sessizdir ve tam olarak ters yöndedir: ajan yönergeyi okur, o prompt'un
   * var olduğunu hiç öğrenmez ve kullanıcı "güvenlik durumunu göster" dediğinde onu
   * elle yapmaya çalışır. Yani en çok işe yarayacak hazır akış, tam da ihtiyaç
   * anında görünmez kalır.
   */
  /**
   * Adlar KAYITLARIN KENDİSİNDEN okunuyor, ayrı bir listeden değil. Ayrı bir liste
   * tutmak, sürüklenmeyi çözmek yerine ikinci bir sürüklenme yeri açardı: prompt
   * kaydedilir, listeye eklenmez, test yine hiçbir şey görmez.
   */
  const kaynak = readFileSync(path.join(KOK, "src", "prompts.ts"), "utf8");
  const adlar = [...kaynak.matchAll(/registerPrompt\(\s*\n\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(adlar.length >= 5, `prompt kaydı bulunamadı (${adlar.length}) — desen bayatlamış olabilir`);

  const yonerge = readFileSync(path.join(KOK, "src", "server.ts"), "utf8");
  const eksik = adlar.filter((ad) => !yonerge.includes(`/${ad}`));
  assert.deepEqual(
    eksik,
    [],
    `sunucu yönergesinde anılmayan prompt'lar: ${eksik.join(", ")} — ajan bunların ` +
      `varlığını hiç öğrenemez`
  );
});
