// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AYAR ADI SÜRÜKLENMESİ — kullanıcıya var olmayan bir düğmeyi göstermeye karşı.
 *
 * Bu test bir denetimde bulunan gerçek bir hatadan doğdu: yazma araçları kapalıyken
 * Growth Brain operatöre "ADSPILOT_ENABLE_WRITE" ayarını gösteriyordu, oysa kodun
 * okuduğu değişken ADSPILOT_WRITE_ENABLED'dı. Operatör mesajın dediğini yapar, hiçbir
 * şey değişmez ve elinde ne bir hata ne bir ipucu kalır — sessizce tıkanır.
 *
 * Kural: kaynakta geçen her ADSPILOT_* adı ya gerçekten okunmalı ya da bilinen bir
 * istisna olmalı. İstisnalar tek tek gerekçelendirilir; liste kısa kalmalıdır.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const KOK = path.join(import.meta.dirname, "..");
const KOD_DIZINLERI = ["src", "scripts"];
/**
 * Belgeler de taranır ve bu bilinçli: operatörü yanlış bir ayar adına yönlendirmek,
 * bunu bir hata mesajı yapıyorsa da README yapıyorsa da aynı sonucu verir. Kaynak
 * kodda geçen adlar kadar belgelerde geçenler de gerçek olmalıdır.
 */
const BELGE_YOLLARI = ["README.md", "README.tr.md", ".env.example"];

/**
 * Kodun HİÇ okumadığı ama metinde geçmesi meşru olan adlar. Her biri gerekçeli:
 * yol haritası notları ve belge örnekleri, var olmayan bir ayarı anlatırken adını
 * anmak zorundadır — yeter ki var olduğunu iddia etmesin.
 */
const ISTISNALAR = new Set<string>([
  // docs/CAMARA.md'de yalnız gelecekteki numberRecycling halkasının kuralını
  // adlandırmak için geçer; orada da bugün var olmadığı açıkça yazılıdır.
  "ADSPILOT_APPROVER_SINCE",
]);

function dosyalar(dizin: string): string[] {
  const cikti: string[] = [];
  for (const ad of readdirSync(dizin)) {
    const tam = path.join(dizin, ad);
    if (statSync(tam).isDirectory()) cikti.push(...dosyalar(tam));
    else if (/\.(ts|mjs|js)$/.test(ad)) cikti.push(tam);
  }
  return cikti;
}

function belgeDosyalari(): string[] {
  const cikti = [...BELGE_YOLLARI.map((f) => path.join(KOK, f))];
  const d = path.join(KOK, "docs");
  for (const ad of readdirSync(d)) if (ad.endsWith(".md")) cikti.push(path.join(d, ad));
  return cikti;
}

test("kaynakta VE belgelerde geçen her ADSPILOT_* adı gerçekten okunuyor", () => {
  const hepsi = [...KOD_DIZINLERI.flatMap((d) => dosyalar(path.join(KOK, d))), ...belgeDosyalari()];
  const metinler = new Map<string, string>();
  for (const f of hepsi) metinler.set(f, readFileSync(f, "utf8"));

  const gecen = new Set<string>();
  const okunan = new Set<string>();
  for (const [, icerik] of metinler) {
    for (const m of icerik.matchAll(/ADSPILOT_[A-Z0-9_]+/g)) gecen.add(m[0]);
    // Gerçekten okunma: process.env.X ya da process.env["X"] biçimleri.
    for (const m of icerik.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[\s*["']([A-Z0-9_]+)["']\s*\])/g)) {
      okunan.add(m[1] ?? m[2]);
    }
  }

  const hayalet = [...gecen].filter((a) => !okunan.has(a) && !ISTISNALAR.has(a)).sort();
  assert.deepEqual(
    hayalet,
    [],
    `Bu ADSPILOT_* adları kaynakta geçiyor ama hiçbir yerde OKUNMUYOR. ` +
      `Kullanıcıya böyle bir ad göstermek onu çalışmayan bir düğmeye yönlendirir. ` +
      `Ya adı düzeltin ya da gerekçesiyle ISTISNALAR'a ekleyin: ${hayalet.join(", ")}`
  );
});

test("okunan her ADSPILOT_* ayarı .env.example'da belgeli", () => {
  /**
   * Ters yön: kodun okuduğu ama hiçbir yerde anlatılmayan bir ayar, yalnız kaynağı
   * okuyanın bulabileceği gizli bir düğmedir.
   */
  const ornek = readFileSync(path.join(KOK, ".env.example"), "utf8");
  const hepsi = KOD_DIZINLERI.flatMap((d) => dosyalar(path.join(KOK, d)));
  const okunan = new Set<string>();
  for (const f of hepsi) {
    for (const m of readFileSync(f, "utf8").matchAll(
      /process\.env(?:\.(ADSPILOT_[A-Z0-9_]+)|\[\s*["'](ADSPILOT_[A-Z0-9_]+)["']\s*\])/g
    )) {
      okunan.add(m[1] ?? m[2]);
    }
  }
  const belgesiz = [...okunan].filter((a) => !ornek.includes(a)).sort();
  assert.deepEqual(belgesiz, [], `.env.example'da anlatılmayan ayarlar: ${belgesiz.join(", ")}`);
});
