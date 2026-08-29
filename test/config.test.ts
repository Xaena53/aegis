// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AYAR AYRIŞTIRMA — her kapının dayandığı zemin.
 *
 * Buradaki hatalar başka hiçbir yerde görünmez ve tek yönlü tehlikelidir: bir kapıyı
 * kapatmazlar, AÇIK BIRAKIRLAR. Yazma iznini kapattığını sanan operatör açık bir
 * sunucuyla çalışır; bütçe tavanı NaN'a düşerse her karşılaştırma false olur ve tavan
 * hiç yokmuş gibi davranır. İkisi de sessizdir — ne bir hata ne bir ret.
 *
 * Fonksiyon kapsamı bu dosyadan önce %25 idi: ayrıştırıcıların hiçbirinin davranışsal
 * kanıtı yoktu.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseBool,
  parseNumEnv,
  loadConfig,
  missingCredentials,
  nacConfigFromEnv,
  nacAnahtarDilimi,
} from "../src/config.js";

/** Testin dokunduğu değişkenleri eski hâline döndürür. */
const yedek = new Map<string, string | undefined>();
function ayarla(ad: string, deger: string | undefined) {
  if (!yedek.has(ad)) yedek.set(ad, process.env[ad]);
  if (deger === undefined) delete process.env[ad];
  else process.env[ad] = deger;
}
afterEach(() => {
  for (const [ad, eski] of yedek) {
    if (eski === undefined) delete process.env[ad];
    else process.env[ad] = eski;
  }
  yedek.clear();
});

/* ── parseBool: tanınmayan değer AÇIK değil KAPALI demektir ───────────────────── */

test("parseBool: tanımsız ve boş değer VARSAYILANA düşer", () => {
  assert.equal(parseBool(undefined, true), true);
  assert.equal(parseBool("", true), true);
  assert.equal(parseBool("   ", true), true);
  assert.equal(parseBool(undefined, false), false);
});

test("parseBool: açık/kapalı sözcükleri Türkçe ve İngilizce tanınır", () => {
  for (const a of ["1", "true", "yes", "on", "evet", "acik", "açık", "TRUE", "  Evet  "]) {
    assert.equal(parseBool(a, false), true, `'${a}' açık sayılmalı`);
  }
  for (const k of ["0", "false", "no", "off", "hayir", "hayır", "kapali", "kapalı", "OFF"]) {
    assert.equal(parseBool(k, true), false, `'${k}' kapalı sayılmalı`);
  }
});

test("KRİTİK: ANLAŞILAMAYAN bayrak değeri varsayılana değil KAPALIYA düşer", () => {
  /**
   * Sıradan görünen ama en tehlikeli kural bu. Varsayılan `true` olan bir bayrakta
   * (yazma izni) yazım hatası yapan operatör — `falsee`, `hayır!`, `kapalı ` yerine
   * `kapallı` — kapattığına inanır. Değer varsayılana düşseydi sunucu AÇIK kalırdı ve
   * operatörün inancıyla gerçek birbirinden ayrılırdı. Belirsizlik, güvenli tarafa gider.
   */
  for (const bozuk of ["falsee", "kapallı", "belki", "2", "yok", "hayır!", "-1"]) {
    assert.equal(parseBool(bozuk, true), false, `'${bozuk}' varsayılana DÜŞMEMELİ, kapanmalı`);
  }
});

/* ── parseNumEnv: boş dize sıfır değildir ─────────────────────────────────────── */

test("KRİTİK: boş sayısal değişken 0 OLMAZ, varsayılana döner", () => {
  /**
   * `Number("") === 0` bu kod tabanında somut bir arızadır: hız sınırlayıcıda 0, "her
   * istek 429" demektir. Yani boş bir değişken sunucuyu tümden kilitlerdi.
   */
  assert.equal(parseNumEnv("X", "", 72), 72);
  assert.equal(parseNumEnv("X", "   ", 72), 72);
  assert.equal(parseNumEnv("X", undefined, 72), 72);
});

test("parseNumEnv: geçersiz, negatif ve sıfır değerler varsayılana döner", () => {
  for (const bozuk of ["abc", "NaN", "-5", "0", "Infinity", "-Infinity"]) {
    assert.equal(parseNumEnv("X", bozuk, 72), 72, `'${bozuk}' kabul edilmemeli`);
  }
});

test("boş değişken UYARI basmaz, bozuk değişken basar", () => {
  /**
   * Bu ayrımı mutasyon testi ortaya çıkardı. Boş dize kontrolü kaldırıldığında dönüş
   * değeri değişmiyor — `Number("")` 0 üretiyor ve bir alttaki `n <= 0` kontrolü onu
   * zaten varsayılana çeviriyor. Yani o satır dönüş değeri için gereksiz; TEK etkisi
   * uyarı basılıp basılmaması.
   *
   * Ve bu, önemsiz bir ayrıntı değil: tanımlanmamış bir değişken OLAĞANDIR ve her
   * açılışta uyarı üretirse, uyarılar okunmaz hâle gelir. Uyarının değeri, nadir
   * olmasından gelir — bozuk bir değer gerçekten operatörün görmesi gereken şeydir.
   */
  const gercek = console.error;
  const satirlar: string[] = [];
  console.error = (...a: unknown[]) => void satirlar.push(a.join(" "));
  try {
    parseNumEnv("X", "", 72);
    parseNumEnv("X", "   ", 72);
    parseNumEnv("X", undefined, 72);
    assert.deepEqual(satirlar, [], "tanımsız/boş değişken olağandır, gürültü üretmemeli");

    parseNumEnv("ADSPILOT_TEST", "abc", 72);
    assert.equal(satirlar.length, 1, "bozuk değer operatöre bildirilmeli");
    assert.match(satirlar[0], /ADSPILOT_TEST/, "hangi değişken olduğu söylenmeli");
    assert.match(satirlar[0], /72/, "hangi değerin kullanıldığı söylenmeli");
  } finally {
    console.error = gercek;
  }
});

test("parseNumEnv: geçerli değer aynen geçer (kapı bir duvar değil)", () => {
  assert.equal(parseNumEnv("X", "24", 72), 24);
  assert.equal(parseNumEnv("X", " 1.5 ", 72), 1.5);
});

/* ── bütçe tavanı: paranın son savunması ──────────────────────────────────────── */

test("KRİTİK: geçersiz bütçe tavanı SESSİZCE devre dışı kalamaz, 500'e zorlanır", () => {
  /**
   * Tavanın NaN'a düşmesi en kötü hâldir: NaN ile yapılan HER karşılaştırma false döner,
   * yani "tavanı aşıyor mu?" sorusu daima "hayır" olur. Kapı yerinde durur, kodda
   * görünür, hiçbir şeyi engellemez. Bu yüzden geçersiz değer varsayılana ZORLANIR.
   */
  for (const bozuk of ["abc", "0", "-100", "", "   ", "NaN"]) {
    ayarla("ADSPILOT_MAX_DAILY_BUDGET", bozuk === "" ? "" : bozuk);
    const c = loadConfig();
    assert.equal(c.maxDailyBudget, 500, `'${bozuk}' tavanı devre dışı bırakmamalı`);
    assert.ok(Number.isFinite(c.maxDailyBudget), "tavan her zaman sonlu bir sayı olmalı");
  }
});

test("geçerli bütçe tavanı aynen kullanılır", () => {
  ayarla("ADSPILOT_MAX_DAILY_BUDGET", "250");
  assert.equal(loadConfig().maxDailyBudget, 250);
});

/* ── yazma izni ───────────────────────────────────────────────────────────────── */

test("yazma izni varsayılan AÇIK, ama açıkça kapatılabilir", () => {
  ayarla("ADSPILOT_WRITE_ENABLED", undefined);
  assert.equal(loadConfig().writeEnabled, true, "varsayılan davranış korunmalı");
  ayarla("ADSPILOT_WRITE_ENABLED", "0");
  assert.equal(loadConfig().writeEnabled, false);
  ayarla("ADSPILOT_WRITE_ENABLED", "hayır");
  assert.equal(loadConfig().writeEnabled, false, "Türkçe kapatma da geçmeli");
});

test("KRİTİK: yazma izninde yazım hatası sunucuyu AÇIK bırakmaz", () => {
  ayarla("ADSPILOT_WRITE_ENABLED", "hayirr");
  assert.equal(
    loadConfig().writeEnabled,
    false,
    "kapatmaya çalışan operatörün yazım hatası, yazmayı açık bırakamaz"
  );
});

/* ── kimlik bilgileri ─────────────────────────────────────────────────────────── */

test("eksik kimlik bilgisi loadConfig'i düşürür ve HANGİSİ olduğunu söyler", () => {
  ayarla("GOOGLE_ADS_DEVELOPER_TOKEN", undefined);
  const eksik = missingCredentials();
  assert.ok(eksik.includes("GOOGLE_ADS_DEVELOPER_TOKEN"), "eksik alan adıyla bildirilmeli");
  assert.throws(() => loadConfig(), /GOOGLE_ADS_DEVELOPER_TOKEN/);
  assert.throws(() => loadConfig(), /npm run auth/, "kullanıcıya çıkış yolu gösterilmeli");
});

test("yalnız BOŞLUKTAN ibaret kimlik bilgisi 'var' sayılmaz", () => {
  /**
   * `?.trim()` olmadan " " dolu bir değer gibi geçerdi ve arıza, anlaşılmaz bir Google
   * API hatası olarak çok daha sonra ortaya çıkardı.
   */
  ayarla("GOOGLE_ADS_CLIENT_ID", "   ");
  assert.ok(missingCredentials().includes("GOOGLE_ADS_CLIENT_ID"));
});

/* ── ağ doğrulama ayarları ────────────────────────────────────────────────────── */

test("simülasyon kanalları HAM geçirilir — doğrulama karar anına bırakılır", () => {
  /**
   * Bilinçli bir tasarım: bozuk bir env değeri sunucuyu BAŞLANGIÇTA düşürmemeli.
   * Düşseydi, tek bir yazım hatası tüm sunucuyu (okuma araçları dahil) kullanılmaz
   * hâle getirirdi. Değer karar anında Türkçe bir retle reddedilir — kapalı arıza.
   */
  ayarla("ADSPILOT_NAC_SIMULATE", "saçmalık");
  const n = nacConfigFromEnv();
  assert.equal(n.nacSimulate, "saçmalık", "değer başlangıçta doğrulanmamalı");
});

test("halka anahtarları varsayılan KAPALI — token varlığı halka açmaz", () => {
  /**
   * Her açık halka, HIGH katmandaki onaya bir CAMARA gidiş-dönüşü daha ekler. SIM-Swap
   * için token tanımlamış bir operatöre, istemediği halkaların yanlış-pozitif retlerini
   * dayatmamak için hiçbir halka token'ın varlığıyla kendiliğinden açılmaz.
   */
  for (const k of ["ADSPILOT_REACH_CHECK", "ADSPILOT_DEVICESWAP_CHECK", "ADSPILOT_CALLFWD_CHECK"]) {
    ayarla(k, undefined);
  }
  ayarla("ADSPILOT_NAC_TOKEN", "sahte-token");
  const n = nacConfigFromEnv();
  assert.equal(n.reachCheck, false);
  assert.equal(n.devSwapCheck, false);
  assert.equal(n.callFwdCheck, false);
});

test("SIM-swap penceresi varsayılanı 72 saat; geçersiz değer onu bozamaz", () => {
  ayarla("ADSPILOT_SIMSWAP_WINDOW_HOURS", undefined);
  assert.equal(nacConfigFromEnv().simSwapWindowHours, 72);
  ayarla("ADSPILOT_SIMSWAP_WINDOW_HOURS", "sıfır");
  assert.equal(nacConfigFromEnv().simSwapWindowHours, 72, "geçersiz pencere varsayılana döner");
  ayarla("ADSPILOT_SIMSWAP_WINDOW_HOURS", "0");
  assert.equal(
    nacConfigFromEnv().simSwapWindowHours,
    72,
    "KRİTİK: 0 saatlik pencere hiçbir SIM değişimini göremezdi"
  );
  ayarla("ADSPILOT_SIMSWAP_WINDOW_HOURS", "24");
  assert.equal(nacConfigFromEnv().simSwapWindowHours, 24);
});

test("KRİTİK: her halka ayarı önbellek anahtarını GERÇEKTEN değiştirir", () => {
  /**
   * Anahtar eksikse arıza sessiz ve tek yönlüdür: halkayı AÇAN operatör, halka KAPALIYKEN
   * üretilmiş bağlamı önbellekten almaya devam eder ve hiç koşmayan bir korumanın
   * koştuğuna inanır. Burada her alan tek tek değiştirilip anahtarın kıpırdadığı ölçülür.
   */
  const temel = nacConfigFromEnv();
  const anahtar = (n: typeof temel) => nacAnahtarDilimi(n).join("|");
  const taban = anahtar(temel);

  const degisimler: Array<[string, unknown]> = [
    ["nacToken", "baska-token"],
    ["approverPhone", "+905550000000"],
    ["simSwapWindowHours", 999],
    ["nacSimulate", "degisti"],
    ["nvSimulate", "uyusmadi"],
    ["reachCheck", !temel.reachCheck],
    ["reachSimulate", "anormal"],
    ["locSimulate", "beklenmedik"],
    ["expectedCountry", "DE"],
    ["devSwapCheck", !temel.devSwapCheck],
    ["devSwapSimulate", "degisti"],
    ["callFwdCheck", !temel.callFwdCheck],
    ["callFwdSimulate", "acik"],
  ];

  for (const [alan, deger] of degisimler) {
    const degisik = { ...temel, [alan]: deger } as typeof temel;
    assert.notEqual(
      anahtar(degisik),
      taban,
      `'${alan}' değişti ama önbellek anahtarı aynı kaldı — bayat bağlam servis edilir`
    );
  }
});
