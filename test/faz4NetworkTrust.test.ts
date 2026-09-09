// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 4 — src/networkTrust.ts gözcüsü: yarım kalmış çeviri artığı.
 *
 * BULGU (alan denetimi, düşük): Türkçe→İngilizce çeviri turunun dört noktada cümlenin
 * ikinci yarısını çevirmeden bıraktığı iddia edildi — ZincirHalkasi.pencereIzAlani,
 * ZINCIR_HALKALARI kayıt gerekçesi, ZINCIR_ORTAK_AYARLARI/simSwapWindowHours ve
 * simDogrula başlığı.
 *
 * ÖLÇÜLDÜ: dördü de ZATEN KAPALI — cümlelerin tamamı bugün İngilizce ve tam. Ama kapalı
 * bir deliği kapalı tutan tek şey gözcüdür; bu dosya o gözcüyü tutar.
 *
 * NİÇİN faz 3'ün BULGU4 gözcüsü YETMİYOR (ölçüldü): oradaki tarama, alıntıları
 * `'[^'\n]*'` gibi GENEL bir kalıpla ayıklıyor. İngilizce kesme işaretleri kalıbı açıp
 * kapatıyor, yani iki apostrofun arasına konan YEPYENİ bir Türkçe kuyruk sessizce
 * siliniyor: `The link's verdict here dokunulmaz, hiçbir halkada YOKTUR: that's the rule.`
 * satırı eklendiğinde faz 3 gözcüsü YEŞİL kaldı. Bu dosyadaki ayıklama TAM İFADEYE
 * bağlıdır — meşru Türkçe alıntılar tek tek, birebir yazılıdır ve varlıkları da
 * doğrulanır; başka hiçbir şey ayıklanmaz.
 *
 * HER GÖZCÜ ÇİFT YÖNLÜ:
 *   (a) BELGE yönü — cümle bayatlarsa / yarım çeviri geri gelirse kırmızı.
 *   (b) KOD yönü — cümlenin anlattığı yapı (pencere alanları, kayıt defteri, simülasyon
 *       kanalının SDK'ya dokunmaması) değişirse kırmızı.
 *
 * Hiçbir test kapıyı gevşetmez, ağa çıkmaz, sır yazmaz.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RISK_HALKA_ESLEMESI,
  ZINCIR_HALKALARI,
  ZINCIR_ORTAK_AYARLARI,
} from "../src/networkTrust.js";

const KAYNAK = readFileSync(
  fileURLToPath(new URL("../src/networkTrust.ts", import.meta.url)),
  "utf8"
);

/** Yalnız yorum satırları; işaretçiler soyulur. */
function yorumMetni(): string {
  return KAYNAK.split("\n")
    .filter((s) => /^\s*(\/\*\*?|\*|\/\/)/.test(s))
    .map((s) => s.replace(/^\s*(\/\*\*?|\*\/|\*|\/\/)\s?/, ""))
    .join("\n");
}

/** Yorum metni tek boşluğa indirilmiş — satıra bölünmüş cümleleri aramak için. */
function yorumDuz(): string {
  return yorumMetni().replace(/\s+/g, " ");
}

/**
 * YORUMLARDA MEŞRU OLARAK GEÇEN TÜRKÇE — TAM ifadeler, ölçülerek çıkarıldı.
 *
 * Bunlar ürünün kullanıcıya dönük metninden yapılan alıntılardır: simülasyon etiketi,
 * onay isteminin başlığı ve rapor bloğunun adı. Liste birebir ve KAPALIDIR; genel bir
 * "tırnak içini sil" kalıbı bilerek kullanılmaz (yukarıdaki ölçüm).
 */
const MESRU_TURKCE: readonly string[] = [
  "⚠ AĞ SİNYALİ BOZUK — onaylayıcının SIM kartı yakın zamanda değişmiş.",
  "GÜVENLİK KAPISI ÇALIŞTI",
  "SİMÜLASYON",
];

/**
 * Meşru alıntıları ayıklar. Her ifadenin GERÇEKTEN geçtiği ayrıca doğrulanır: ayıklama
 * listesi bayatlarsa (alıntılanan ürün metni değişirse) gözcü kırmızı olur, yani liste
 * sessizce genişleyen bir muafiyete dönüşemez.
 */
function alintisizDuz(): string {
  let metin = yorumDuz();
  for (const ifade of MESRU_TURKCE) {
    assert.ok(
      metin.includes(ifade),
      `meşru Türkçe alıntı yorumlardan kaybolmuş, ayıklama listesi bayat: ${ifade}`
    );
    metin = metin.split(ifade).join(" ");
  }
  return metin;
}

test("FAZ4: networkTrust yorumlarında yarım çeviri artığı yok (ayıklama TAM İFADEYE bağlı)", () => {
  const metin = alintisizDuz();

  /**
   * ASCII Türkçe SÖZCÜKLER — özel harf taraması TEK BAŞINA yetmez: bulgunun dört
   * artığından üçü ("dokunulmaz", "edilmez", "kalamaz", "YOKTUR") tamamen ASCII'dir ve
   * harf taramasından sağ çıkardı. Liste yalnız İŞLEV sözcüklerini içerir; koddaki Türkçe
   * TANIMLAYICILAR (kefil, halka, kademe, gozlemsiz…) yorumlarda meşru olarak geçer ve
   * burada aranmaz.
   */
  const turkceSozcukler =
    /\b(için|icin|değil|degil|değildir|degildir|yoktur|vardır|vardir|kalamaz|dokunulmaz|edilmez|yapılmaz|yapilmaz|olmaz|hiçbir|hicbir|çünkü|cunku|ayrıca|ayrica|bkz|yalnız|yalniz|sadece|olduğu|oldugu|gerekir|okunur|halkada|kalır|kalir|girmez|etmez)\b/gi;
  const bulunanSozcukler = [...new Set(metin.match(turkceSozcukler) ?? [])];
  assert.deepEqual(
    bulunanSozcukler,
    [],
    `alıntı dışı yorumda Türkçe sözcük kaldı (yarım çeviri): ${bulunanSozcukler.join(", ")}`
  );

  const turkceHarfler = [...new Set(metin.match(/[ıİğĞşŞçÇöÖüÜ]/g) ?? [])];
  assert.deepEqual(
    turkceHarfler,
    [],
    `alıntı dışı yorumda Türkçe'ye özgü harf kaldı: ${turkceHarfler.join(", ")}`
  );
});

test("FAZ4: dört kesik cümlenin tamamlanmış hâli yerinde (BELGE yönü)", () => {
  const duz = yorumDuz();

  // 1) En kritiği: simülasyon kanalının gerçek SDK'ya hiç dokunmadığı vaadi.
  assert.ok(
    /The real SDK is NEVER TOUCHED here — it is not even imported/.test(duz),
    "simDogrula başlığındaki 'gerçek SDK'ya dokunulmaz' vaadi TAM CÜMLE olmalı"
  );
  // 2) Penceresiz halkaların hangileri olduğu.
  assert.ok(
    /for a link that HAS no window \(links 2, 3, 4 and 6\) it is ABSENT/.test(duz),
    "pencereIzAlani cümlesi hangi halkalarda pencere OLMADIĞINI söylemeli"
  );
  // 3) Kayıt defterinin ne vaat ettiği.
  assert.ok(
    /turns RED in the compiler or the tests rather than staying silent\./.test(duz),
    "ZINCIR_HALKALARI kayıt gerekçesi yarım kalmamalı"
  );
  // 4) 1. ve 5. halkanın pencereyi paylaşıp ize AYRI yazdığı.
  assert.ok(
    /each writes it to its OWN field in the trace — see AgIz\.devSwapPencereSaat\./.test(duz),
    "ZINCIR_ORTAK_AYARLARI/simSwapWindowHours cümlesi tam olmalı"
  );
});

test("FAZ4: cümlelerin anlattığı YAPI kodda da öyle (KOD yönü)", () => {
  // (2) ve (4) numaralı cümlelerin karşılığı: pencere alanı YALNIZ 1. ve 5. halkada var,
  // ve ikisi AYRI ize yazıyor. Bir halkaya pencere eklenirse ya da ikisi tek alana
  // toplanırsa bu gözcü kırmızı olur.
  const pencereliler = ZINCIR_HALKALARI.filter((h) => h.pencereIzAlani !== undefined);
  assert.deepEqual(
    pencereliler.map((h) => h.id),
    ["simSwap", "deviceSwap"],
    "penceresi olan halkalar YALNIZ 1. (simSwap) ve 5. (deviceSwap) olmalı"
  );
  assert.deepEqual(
    pencereliler.map((h) => h.pencereIzAlani),
    ["pencereSaat", "devSwapPencereSaat"],
    "iki pencere ASLA tek AgIz alanına toplanmaz"
  );
  assert.ok(
    ZINCIR_ORTAK_AYARLARI.includes("simSwapWindowHours"),
    "paylaşılan pencere ayarı zincirin ORTAK ayarı olarak durmalı"
  );

  // (3) numaralı cümlenin karşılığı: kayıt defteri, "high" katmanında koşan halkaların
  // TAM listesini AYNI sırayla taşır — bir halka eklenip kayıt defterine yazılmazsa
  // (ya da tersi) derleyici değil, bu gözcü kırmızı olur.
  assert.deepEqual(
    ZINCIR_HALKALARI.map((h) => h.izAlani),
    [...RISK_HALKA_ESLEMESI.high],
    "kayıt defteri ile risk eşlemesi aynı altı halkayı aynı sırada saymalı"
  );

  // (1) numaralı cümlenin karşılığı: simDogrula gövdesinde ne bir dinamik import ne de
  // gerçek kanal kurucusuna bir çağrı vardır. Vaat ÖLÇÜLÜR, okunmaz.
  const bas = KAYNAK.indexOf("\nfunction simDogrula(");
  assert.ok(bas > 0, "simDogrula bulunamadı");
  const son = KAYNAK.indexOf("\n}", bas);
  assert.ok(son > bas, "simDogrula gövdesinin sonu bulunamadı");
  const govde = KAYNAK.slice(bas, son);
  assert.ok(!/import\s*\(/.test(govde), "simülasyon kanalı hiçbir modülü import ETMEZ");
  assert.ok(
    !/\b(nacIstemci|kanalGetir|erisimKanaliGetir|konumKanaliGetir|cihazDegisimKanaliGetir|cagriYonlendirmeKanaliGetir)\s*\(/.test(
      govde
    ),
    "simülasyon kanalı hiçbir GERÇEK kanal kurucusunu çağırmaz"
  );
});
