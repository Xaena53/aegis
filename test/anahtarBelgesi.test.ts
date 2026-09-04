// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ANA ANAHTAR KURALI — belge ile kodun aynı şeyi söylemesi.
 *
 * NEDEN VAR: gerçek bir sürüklenmeden doğdu. Kod, "yalnız hex ama uzunluğu 64 değil"
 * bir AEGIS_MASTER_KEY'i açıkça REDDEDER hâle geldi (store.ts: sessizce parolaya
 * düşmek, operatörün hiç istemediği bir anahtar türetip depodaki her sırrı okunamaz
 * yapıyordu). Ama ARCHITECTURE.md hâlâ "64 hex doğrudan kullanılır; GERİ KALAN HER ŞEY
 * scrypt ile gerilir" diyordu ve docs/DOCKER.md yalnız "Min 32 chars" yazıyordu.
 *
 * Sonuç, bir belgenin yanlış olmasından daha kötüsüdür: operatör belgeye güvenip
 * `openssl rand -hex 16` (32 hex karakter) verir, cümleyi TAM OLARAK karşıladığını
 * bilir ve süreç açılışta ölür. Yani düzeltme bir kapıyı duvara çevirmiştir; belge de
 * operatörü hâlâ o duvara yönlendiriyordur.
 *
 * Bu test iki ucu birden çiviler: (1) kodun gerçekten reddettiğini, (2) anahtarı
 * ANLATAN her belgenin aynı kuralı yazdığını. Biri değişip diğeri unutulduğunda kızarır.
 * ayarAdlari.test.ts'in (belge KODLA tutarlı) ve belgeTutarliligi.test.ts'in (belge
 * KENDİSİYLE tutarlı) kardeşidir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const KOK = path.join(import.meta.dirname, "..");
const ANAHTAR_ADI = "AEGIS_MASTER_KEY";

/**
 * Anahtarın BİÇİMİNİ anlatan belgeler. Adı yalnız anıp geçen yerler (docs/DEMO.md'nin
 * prova tablosu, yedek notları) bilerek listede yok: onlar bir kural iddia etmiyor.
 */
const BELGELER = ["ARCHITECTURE.md", "docs/DOCKER.md", "deploy/README.md", ".env.example"];

function oku(ad: string): string {
  return readFileSync(path.join(KOK, ad), "utf8");
}

/**
 * Anahtarı anlatan METİN PARÇALARI. Tüm dosyaya bakmak yanıltıcı olurdu: DOCKER.md'de
 * "refuses to start" başka bir kapıyı (düz-metin URL) anlatan ayrı bir paragrafta da
 * geçiyor, yani dosya düzeyinde arama, hiç güncellenmemiş bir satırı bile yeşil
 * gösterebilirdi. O yüzden yalnız anahtarın geçtiği paragraf — tablo ise yalnız o
 * satır — okunur.
 */
function anahtarBloklari(metin: string): string {
  const parcalar: string[] = [];
  for (const paragraf of metin.split(/\r?\n\s*\r?\n/)) {
    if (!paragraf.includes(ANAHTAR_ADI)) continue;
    const satirlar = paragraf.split(/\r?\n/);
    const tabloMu = satirlar.filter((s) => s.trimStart().startsWith("|")).length >= 2;
    parcalar.push(
      tabloMu ? satirlar.filter((s) => s.includes(ANAHTAR_ADI)).join("\n") : paragraf
    );
  }
  return parcalar.join("\n---\n");
}

test("kod hex-ama-64-değil bir anahtarı reddediyor (belgelerin dayandığı gerçek)", async () => {
  const { deriveMasterKey } = await import("../src/store.js");
  /**
   * `openssl rand -hex 16` tam olarak budur: 32 hex karakter. Asgari uzunluk kapısını
   * geçer, yani reddin gerekçesi "kısa" değil, "hangi dal olduğu bilinmiyor"dur.
   */
  assert.throws(() => deriveMasterKey("a".repeat(32)), /uzunluğu 64 değil/);
  assert.equal(deriveMasterKey("f".repeat(64)).toString("hex"), "f".repeat(64));
});

test("anahtarı anlatan her belge, 64-hex kuralını VE reddi yazıyor", () => {
  const eksikler: string[] = [];
  for (const ad of BELGELER) {
    const blok = anahtarBloklari(oku(ad));
    assert.ok(blok.length > 0, `${ad}: ${ANAHTAR_ADI} geçen paragraf bulunamadı — desen bayatlamış`);

    // "64 hex" / "64 HEX": kabul edilen tek makine biçimi.
    if (!/64\s+hex/i.test(blok)) eksikler.push(`${ad}: "64 hex" kuralı yazmıyor`);
    // Reddin kendisi: operatör duvarı ÖNCEDEN bilmeli. Türkçe kökü kasten "redded":
    // "REDDEDİLİR"deki noktalı İ (U+0130), /i/ bayrağıyla bile "i" ile eşleşmez.
    if (!/refus|reject|redded/i.test(blok)) eksikler.push(`${ad}: hex-ama-64-değil reddi yazmıyor`);
    // Diğer meşru biçim; yazılmazsa okur "parola verilemez" sanır.
    if (!/passphrase|parola/i.test(blok)) eksikler.push(`${ad}: parola seçeneği yazmıyor`);
  }
  assert.deepEqual(
    eksikler,
    [],
    `Belge, kodun reddettiği bir yapılandırmaya yönlendiriyor:\n  - ${eksikler.join("\n  - ")}`
  );
});

test("hiçbir belge 'geri kalan her şey scrypt ile gerilir' demiyor", () => {
  /**
   * Bayat cümlenin kendisi. Bu iddia bugün YANLIŞ ve tam da operatörü duvara götüren
   * cümledir: 32 hex karakteri "geri kalan" sayıp scrypt'e düşeceğini sandırır.
   */
  const bayat = [/anything else is stretched/i, /geri kalan(ı| her şey)? .{0,40}scrypt/i];
  const suclular: string[] = [];
  for (const ad of BELGELER) {
    const metin = oku(ad);
    for (const d of bayat) if (d.test(metin)) suclular.push(`${ad}: /${d.source}/`);
  }
  assert.deepEqual(suclular, [], `Kodla çelişen bayat cümle: ${suclular.join(", ")}`);
});

test("yükseltme notu ÇEKMEDEN ÖNCE okunacak yerde ve bedeli açıkça yazıyor", () => {
  /**
   * Bu red YENİ bir duvar: bugün hex-ama-64-değil bir anahtarla sorunsuz çalışan bir
   * kurulum, yükseltmeden sonra açılmıyor. Üstelik geri dönüşü yok — o anahtar scrypt
   * ile türetildiği için depodaki her refresh_token_enc kalıcı olarak çözülemez hâle
   * geliyor. Notun var olması yetmez, DOĞRU YERDE olması gerekir: ilk kurulum adımının
   * ÜSTÜNDE, yani yükseltmeyi yapacak kişinin `git pull`dan önce gördüğü yerde.
   */
  const metin = oku("deploy/README.md");
  const satirlar = metin.split(/\r?\n/);
  const notIndeksi = satirlar.findIndex((s) => /^##\s+Upgrading/i.test(s));
  assert.ok(notIndeksi >= 0, "deploy/README.md'de yükseltme bölümü yok");

  const ilkAdim = satirlar.findIndex((s) => /^##\s+1\./.test(s));
  assert.ok(ilkAdim >= 0, "deploy/README.md'de numaralı kurulum adımı bulunamadı — desen bayat");
  assert.ok(
    notIndeksi < ilkAdim,
    `yükseltme notu kurulum adımlarının ALTINDA (satır ${notIndeksi + 1} > ${ilkAdim + 1}) — ` +
      `yükseltmeyi yapan kişi oraya kadar okumaz`
  );

  const sonrakiBaslik = satirlar.findIndex((s, i) => i > notIndeksi && /^##\s/.test(s));
  const govde = satirlar.slice(notIndeksi, sonrakiBaslik).join("\n");
  const beklenen: [RegExp, string][] = [
    [/git pull/i, "hangi anda okunacağını (çekmeden önce) söylemiyor"],
    [/64/, "64-hex kuralını anmıyor"],
    [/reconnect|re-?authoriz/i, "tek çıkışın yeniden yetkilendirme olduğunu yazmıyor"],
    [/no migration script|migration/i, "göç betiği olmadığını yazmıyor"],
    [/refresh_token_enc|undecryptable|recovers? nothing/i, "kalıcı sır kaybını yazmıyor"],
  ];
  const eksik = beklenen.filter(([d]) => !d.test(govde)).map(([, n]) => n);
  assert.deepEqual(eksik, [], `yükseltme notu eksik: ${eksik.join("; ")}`);
});

test("CHANGELOG kırıcı değişikliği duyuruyor ve yükseltme notuna yönlendiriyor", () => {
  /**
   * Sürüm notunu okuyup deploy kılavuzuna hiç bakmayan bir operatör de var; kırıcı
   * değişikliğin iki kapıdan da duyulması gerekiyor.
   */
  const metin = oku("CHANGELOG.md");
  const bloklar = metin.split(/\r?\n\s*\r?\n/).filter((p) => p.includes(ANAHTAR_ADI));
  assert.ok(bloklar.length > 0, `CHANGELOG'da ${ANAHTAR_ADI} geçmiyor`);
  const blok = bloklar.join("\n");
  assert.match(blok, /BREAKING/, "kırıcı değişiklik BREAKING olarak işaretlenmemiş");
  assert.match(blok, /64\s+hex/i, "kabul edilen biçim yazılmamış");
  assert.match(blok, /deploy\/README\.md/, "yükseltme notuna yönlendirmiyor");
});
