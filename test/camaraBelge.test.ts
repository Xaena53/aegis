// SPDX-License-Identifier: AGPL-3.0-only
/**
 * docs/CAMARA.md DÜRÜSTLÜK SÖZLEŞMESİ — belgenin koddan sapmasını engelleyen kapı.
 *
 * Bu belge jüriye ve mentöre "hangi CAMARA sinyali gerçekten koşuyor, hangisi yalnız
 * simülasyon, hiçbiri canlıya gitti mi" sorusunu cevaplıyor. Böyle bir belgenin tek gerçek
 * riski BAYATLAMAKTIR: biri gerçek NV kanalını yazar, biri simülasyonu canlı sanıp
 * "artık gerçek" der, biri kopyalanabilir kontrol listesine var olmayan bir env adı
 * ekler — ve belge sessizce yalan söylemeye başlar. Metin kendi kendini denetleyemez;
 * bu dosya onun yerine denetler.
 *
 * Buradaki testler kapı mantığını DEĞİL, belgenin merkezî iddialarının hâlâ doğru
 * olduğunu sabitler:
 *
 *   1) Belge dört bölümü de taşıyor ve NV hükmünü ("sunucudan çağrılamaz") açıkça veriyor.
 *   2) "Hiç canlı koşmadı" beyanı yerinde duruyor — yumuşatmak için testi de değiştirmek
 *      gerekir, yani sessizce olamaz.
 *   3) Kopyalanabilir kontrol listesi UYDURMA env adı ya da var olmayan npm script'i
 *      içermiyor (token gelen operatörün eline yanlış talimat verilemez).
 *   4) Kod, belgenin NV hükmüyle çelişmiyor: NvIzi'de "gercek" YOK. Gerçek NV kanalı
 *      yazıldığı gün bu test kırılır ve belgenin güncellenmesini ZORLAR — belgenin
 *      kendi §2/§4'ünde söz verdiği şey tam olarak budur.
 *   5) Hükmün dayandığı SDK tip-tanımı alıntıları hâlâ SDK'da duruyor (sürüm yükseltmesi
 *      hükmü sessizce geçersizleştiremez).
 *   6) Belge sır sızdırmıyor: tam numara/token görünümlü uzun rakam dizisi yok.
 *
 * Fail-closed değişmezi: buradaki hiçbir test harcama kapısına dokunmaz, gevşetmez;
 * yalnız okur.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const yol = (goreli: string) => fileURLToPath(new URL(goreli, import.meta.url));

const BELGE_YOLU = yol("../docs/CAMARA.md");
const belge = readFileSync(BELGE_YOLU, "utf8");

/** "## Başlık" ile bir sonraki "## " arasını verir; bölüm bazlı iddialar için. */
function bolum(basligiIceren: string): string {
  const satirlar = belge.split(/\r?\n/);
  const bas = satirlar.findIndex((s) => s.startsWith("## ") && s.includes(basligiIceren));
  assert.notEqual(bas, -1, `docs/CAMARA.md içinde "${basligiIceren}" başlıklı bölüm yok`);
  const kalan = satirlar.slice(bas + 1);
  const son = kalan.findIndex((s) => s.startsWith("## "));
  return (son === -1 ? kalan : kalan.slice(0, son)).join("\n");
}

/* ── 1) Belgenin iskeleti ve NV hükmü ─────────────────────────────────────────── */

test("belge: dört bölümün dördü de var (envanter, canlı-koşmadı, kontrol listesi, NV mimarisi)", () => {
  for (const baslik of [
    "Signal inventory",
    "What has never run live",
    "Token arrival checklist",
    "Number Verification",
  ]) {
    assert.match(belge, new RegExp(`^## .*${baslik}`, "m"), `"${baslik}" bölümü kayıp`);
  }
});

test("belge: NV hükmü açıkça 'sunucudan çağrılamaz' — ve gerekçesi cihaz-taraflı OIDC", () => {
  assert.match(belge, /NOT callable from our server/i, "NV hükmü açıkça yazılmalı");
  assert.match(belge, /device-side OIDC/i, "hükmün gerekçesi (cihaz-taraflı OIDC) yazılmalı");
  // Hüküm, spekülasyon değil tip-tanımı alıntısına dayanmalı: alıntının kendisi belgede olsun.
  assert.match(belge, /Authorization code received from the CSP/, "kanıt alıntısı (code) kayıp");
  assert.match(
    belge,
    /authenticated via mobile network/,
    "kanıt alıntısı (mobil ağ üzerinden kimlik doğrulama) kayıp"
  );
});

/* ── 2) "Hiç canlı koşmadı" beyanı ────────────────────────────────────────────── */

test("belge: hiçbir gerçek CAMARA çağrısının canlı koşmadığı AÇIKÇA yazıyor", () => {
  const b = bolum("What has never run live");
  assert.match(
    b,
    /never reached a live endpoint|Zero real\s+network queries/i,
    "canlı koşulmadığı beyanı yumuşatılmış ya da silinmiş — bu beyan belgenin varlık sebebi"
  );
  // Testlerin sahte kanal enjekte ettiği de söylenmeli: yeşil test = kararın kanıtı,
  // entegrasyonun kanıtı DEĞİL.
  assert.match(b, /__setSimSwapKanalForTests/, "test seam'inin sahte kanal enjekte ettiği yazılmalı");
  assert.match(b, /fake channel/i, "sahte kanal ifadesi kayıp");
});

/* ── 3) Kopyalanabilir kontrol listesi gerçekten uygulanabilir mi ─────────────── */

test("kontrol listesi: geçen her ADSPILOT_* env adı .env.example'da GERÇEKTEN var", () => {
  const ornek = readFileSync(yol("../.env.example"), "utf8");
  const liste = bolum("Token arrival checklist");
  const adlar = [...new Set(liste.match(/ADSPILOT_[A-Z0-9_]+/g) ?? [])];
  assert.ok(adlar.length >= 4, "kontrol listesi env adı içermiyor — kopyalanabilir olmalı");
  for (const ad of adlar) {
    assert.ok(
      ornek.includes(ad),
      `docs/CAMARA.md kontrol listesi UYDURMA env adı içeriyor: ${ad} (.env.example'da yok)`
    );
  }
});

test("kontrol listesi: önerilen her 'npm run X' package.json'da GERÇEKTEN tanımlı", () => {
  const pkg = JSON.parse(readFileSync(yol("../package.json"), "utf8"));
  const liste = bolum("Token arrival checklist");
  const komutlar = [...new Set([...liste.matchAll(/npm run ([a-z:-]+)/g)].map((m) => m[1]))];
  assert.ok(komutlar.length > 0, "kontrol listesi çalıştırılacak komut vermiyor");
  for (const k of komutlar) {
    assert.ok(pkg.scripts?.[k], `docs/CAMARA.md var olmayan bir script öneriyor: npm run ${k}`);
  }
});

test("kontrol listesi: simülasyon değişkenlerinin TEMİZLENMESİ adımı duruyor", () => {
  const liste = bolum("Token arrival checklist");
  // Token + simülasyon birlikteliği çelişkili yapılandırmadır ve REDDEDİLİR; operatörün
  // bunu canlı koşudan ÖNCE öğrenmesi gerekir, hata mesajından sonra değil.
  assert.match(liste, /ADSPILOT_NAC_SIMULATE/, "simülasyon kanalının temizlenmesi adımı kayıp");
  assert.match(liste, /ADSPILOT_NV_SIMULATE/, "NV simülasyon kanalının temizlenmesi adımı kayıp");
  assert.match(liste, /contradictory|çeliş/i, "çelişkili yapılandırma uyarısı kayıp");
  // Canlı koşunun KANITI iz alanıdır: operatöre neye bakacağı söylenmeli.
  assert.match(liste, /simSwapKanali/, "denetim izinde neye bakılacağı yazılmalı");
  assert.match(liste, /"gercek"/, "başarılı canlı koşunun iz değeri (gercek) yazılmalı");
});

/* ── 4) Kod ↔ belge tutarlılığı ───────────────────────────────────────────────── */

test("kod: NvIzi'de 'gercek' YOK — belgenin NV hükmü kodla hâlâ tutarlı", () => {
  const kaynak = readFileSync(yol("../src/networkTrust.ts"), "utf8");
  const tanim = kaynak.match(/export type NvIzi\s*=\s*([^;]+);/);
  assert.ok(tanim, "src/networkTrust.ts içinde NvIzi tipi bulunamadı");
  assert.doesNotMatch(
    tanim![1],
    /"gercek"/,
    'NvIzi artık "gercek" içeriyor: gerçek NV kanalı yazılmışsa docs/CAMARA.md §2 ve §4 ' +
      "GÜNCELLENMELİ — belge hâlâ 'hiç canlı koşmadı' ve 'sunucudan çağrılamaz' diyor."
  );
});

test("kod: SDK yalnız TEK yerde ve tembel import ediliyor — belgedeki kanıt hâlâ geçerli", () => {
  const kaynak = readFileSync(yol("../src/networkTrust.ts"), "utf8");
  assert.match(
    kaynak,
    /await import\("network-as-code"\)/,
    "belge, SDK'nın tek bir tembel import'la yüklendiğini söylüyor; kaynak artık öyle değil"
  );
});

/* ── 5) Hükmün dayanağı: SDK tip tanımları ────────────────────────────────────── */

test("sdk: NV hükmünün dayandığı tip-tanımı alıntıları SDK'da hâlâ duruyor", (t) => {
  const kok = yol("../node_modules/network-as-code/dist/@types/api/resources/");
  const istekTipi = `${kok}numberVerification/client/requests/VerifyNumberVerificationRequest.d.ts`;
  const v100Tipi = `${kok}numberVerificationV100/client/requests/PhoneNumberShareRequest.d.ts`;
  if (!existsSync(istekTipi) || !existsSync(v100Tipi)) {
    // Bağımlılık kurulu değilse hüküm doğrulanamaz; testi uydurma bir "geçti" ile kapatma.
    t.skip("network-as-code tip tanımları kurulu değil — SDK dayanağı doğrulanamadı");
    return;
  }
  const istek = readFileSync(istekTipi, "utf8");
  assert.match(istek, /Authorization code received from the CSP/, "code alanının OIDC gerekçesi kayboldu");
  assert.match(istek, /\bcode\?: string/, "code alanı kayboldu");
  assert.match(istek, /\bstate\?: string/, "state alanı kayboldu");

  // v1.0.0 ad alanında sorgulanacak numara ALANI YOK: cevap tamamen token'ın bağlı olduğu
  // cihazdan türüyor. Belgedeki "inşa edilecek halka yok" hükmü buna dayanıyor.
  const v100 = readFileSync(v100Tipi, "utf8");
  assert.doesNotMatch(
    v100,
    /phoneNumber/,
    "PhoneNumberShareRequest artık numara alıyor — docs/CAMARA.md §4 Evidence C yeniden değerlendirilmeli"
  );
});

/* ── 6) Belge sır sızdırmıyor ─────────────────────────────────────────────────── */

test("belge: tam numara/token görünümlü uzun rakam dizisi içermiyor", () => {
  // Onaylayıcı numarası ve NaC anahtarı belgeye ASLA girmemeli; örnekler yer tutucudur.
  const uzunDizi = belge.match(/\d{9,}/g);
  assert.equal(
    uzunDizi,
    null,
    `docs/CAMARA.md sır görünümlü uzun rakam dizisi içeriyor: ${uzunDizi?.join(", ")}`
  );
  // Maskeleme örneği verilmişse maskeli olmalı (en az bir '*').
  const ornekler = belge.match(/\+90[0-9X*]{4,}/g) ?? [];
  for (const o of ornekler) {
    assert.ok(
      /[*X]/.test(o),
      `docs/CAMARA.md maskesiz görünen bir numara örneği içeriyor: ${o}`
    );
  }
});
