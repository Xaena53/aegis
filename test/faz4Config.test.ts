// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 4 — src/config.ts gerileme gözcüleri.
 *
 * İKİ KONU VAR, ikisi de aynı kuralın iki yarısı: "bilinmiyor" bir değer değildir.
 *
 * 1) ONAYLAYICININ NUMARASI (AEGIS_APPROVER_PHONE). Değer yalnızca trim ediliyordu, yani
 *    BOŞ OLMAYAN her dize "onaylayıcı" sayılıyordu. ÖLÇÜLDÜ (bu testler yazılmadan önce,
 *    agDogrula üzerinden): AEGIS_APPROVER_PHONE="9" + AEGIS_NAC_SIMULATE=temiz ile kapı
 *    GEÇTİ ve kanıt satırı olarak "SIM değişimi yok (son 24 saat, ***)" yazdı — insana
 *    onaylayıcının hattının denetlendiğini söyleyen bir satır, oysa yapılandırılan şey bir
 *    telefon numarası bile değil. "TEST" aynı şekilde geçti; yerel yazım "0555 111 22 33"
 *    ise "0555********33" olarak maskelendi. Ağ kapısının kendi kapalı-arıza kuralı
 *    (numara BOŞSA ret) böylece "bir karakter bırakan her yazım hatası" tarafından
 *    etkisizleştirilmiş oluyordu.
 *
 *    Bu yüzden bütçe tavanının deseni buraya da uygulandı: OKUNAMAYAN DEĞER FIRLATIR,
 *    sessizce düzeltilmez. Yokluk/boşluk ise ayrı bir hâldir ve belgelenmiş varsayılanı
 *    (undefined) korur — "yapılandırmayı seçmemiş operatör", "yanlış yazmış operatör"
 *    değildir.
 *
 * 2) nacSimulate YORUMU. Çeviri turundan yarım kalmış bir cümle vardı: "…is refused at
 *    decision time with a" satırından sonra Türkçe bir kuyruk geliyordu, yani yorumun TEK
 *    işlevsel bilgisi (doğrulamanın networkTrust.ts'te yapıldığı) okunamıyordu. Aşağıdaki
 *    gözcü ÇİFT YÖNLÜDÜR: cümle bayatlarsa da, cümlenin anlattığı davranış değişirse de
 *    kırmızı olur — hem config.ts'in doğrulamadığı, hem networkTrust.ts'in reddettiği
 *    DAVRANIŞSAL olarak sınanır.
 */
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, nacConfigFromEnv } from "../src/config.js";
import { agDogrula } from "../src/networkTrust.js";
import type { AgAyar } from "../src/networkTrust.js";

/** Testin dokunduğu değişkenleri eski hâline döndürür. */
const yedek = new Map<string, string | undefined>();
function ayarla(ad: string, deger: string | undefined): void {
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

/**
 * Kimlik bilgilerini testin kendisi kurar: loadConfig() dördü eksikse zaten fırlatır ve
 * buradaki her iddia geliştiricinin .env'ine bağlı hâle gelirdi (CI'da yeşil/yerelde
 * kırmızı, ya da tersi). Değerler sahtedir; bu dosyadaki hiçbir test ağa çıkmaz.
 *
 * AEGIS_APPROVER_PHONE de HER testte açıkça kurulur: geliştiricinin ortamında duran bir
 * değer, "yokluk varsayılanı" iddiasını sessizce yalan çıkarabilirdi.
 */
beforeEach(() => {
  ayarla("GOOGLE_ADS_DEVELOPER_TOKEN", "TEST-ONLY-developer-token");
  ayarla("GOOGLE_ADS_CLIENT_ID", "TEST-ONLY-client-id");
  ayarla("GOOGLE_ADS_CLIENT_SECRET", "TEST-ONLY-client-secret");
  ayarla("GOOGLE_ADS_REFRESH_TOKEN", "TEST-ONLY-refresh-token");
  ayarla("AEGIS_APPROVER_PHONE", undefined);
  ayarla("AEGIS_NAC_SIMULATE", undefined);
});

/* ── 1) onaylayıcı numarası: okunamayan değer REDDE gider ─────────────────────── */

/**
 * Ölçülmüş kaza kalıpları. Hepsi bugün SESSİZCE kabul ediliyordu ve hepsi "onaylayıcı"
 * diye ağ kapısına giriyordu:
 *   "9" / "TEST"          -> numara değil; simülasyon kanalında kapıyı GEÇİRİYORDU
 *   "0555 111 22 33"      -> ülke kodsuz yerel yazım; CAMARA'nın beklediği biçim değil
 *   "+90 555 111 22 33"   -> boşluklu E.164; sessizce "onarılmaz", reddedilir
 *   "905551112233"        -> "+" yok
 *   "+0905551112233"      -> ülke kodu 0 ile başlayamaz
 *   "+9055511122334455"   -> E.164 tavanı 15 rakam
 *   "+90555111223x"       -> rakam olmayan karakter
 */
const BOZUK_NUMARALAR = [
  "9",
  "TEST",
  "0555 111 22 33",
  "+90 555 111 22 33",
  "905551112233",
  "+0905551112233",
  "+9055511122334455",
  "+90-555-111-22-33",
  "+90555111223x",
  "+1",
];

test("KRİTİK: okunamayan AEGIS_APPROVER_PHONE loadConfig'i DÜŞÜRÜR (sessiz kabul yok)", () => {
  for (const bozuk of BOZUK_NUMARALAR) {
    ayarla("AEGIS_APPROVER_PHONE", bozuk);
    assert.throws(
      () => loadConfig(),
      /AEGIS_APPROVER_PHONE/,
      `'${bozuk}' sessizce onaylayıcı sayılamaz; hangi değişken olduğu söylenerek reddedilmeli`
    );
  }
});

/**
 * Aynı ret, ortamı okuyan DİĞER giriş noktasında da geçerli olmalı: barındırılan sunucu
 * loadConfig'i hiç çağırmaz, ayarları nacConfigFromEnv üzerinden okur (http.ts:contextFor).
 * Doğrulama yalnız loadConfig'e konsaydı, barındırılan yolda bozuk numara aynen geçerdi.
 */
test("KRİTİK: ret nacConfigFromEnv'de olur — barındırılan yol da kapalı arızaya düşer", () => {
  for (const bozuk of BOZUK_NUMARALAR) {
    ayarla("AEGIS_APPROVER_PHONE", bozuk);
    assert.throws(() => nacConfigFromEnv(), /AEGIS_APPROVER_PHONE/, `'${bozuk}' geçti`);
  }
});

/**
 * KAPI BİR DUVAR DEĞİL. Bu test aşırıya kaçmanın tek gözcüsü: geçerli E.164 numaralar
 * aynen geçmeli, YOKLUK ise bir yazım hatası değil bir tercih etmeme hâlidir ve belgelenmiş
 * varsayılanı (undefined) korumalıdır. Bu satır düşerse "AEGIS_APPROVER_PHONE yazmayan
 * herkes açılışta reddediliyor" demektir — ağ kapısı OPSİYONELdir, sunucu onsuz açılır.
 */
test("geçerli numara aynen geçer, yokluk/boşluk varsayılanı korur (aşırıya kaçma kelepçesi)", () => {
  for (const gecerli of ["+905551112233", "+12025550123", "+6831234", "+999999910011"]) {
    ayarla("AEGIS_APPROVER_PHONE", gecerli);
    assert.equal(loadConfig().approverPhone, gecerli, `'${gecerli}' geçerli E.164, geçmeli`);
  }
  // Baştaki/sondaki boşluk kırpılır — bu, dosyadaki her ortam değişkeninin kuralı.
  ayarla("AEGIS_APPROVER_PHONE", "  +905551112233  ");
  assert.equal(loadConfig().approverPhone, "+905551112233", "kırpma davranışı korunmalı");

  ayarla("AEGIS_APPROVER_PHONE", undefined);
  assert.equal(loadConfig().approverPhone, undefined, "tanımsız değişken varsayılanı korumalı");
  ayarla("AEGIS_APPROVER_PHONE", "");
  assert.equal(loadConfig().approverPhone, undefined, "boş değişken de varsayılanı korumalı");
  ayarla("AEGIS_APPROVER_PHONE", "   ");
  assert.equal(loadConfig().approverPhone, undefined, "yalnız boşluk da varsayılanı korumalı");
});

/**
 * YÖN: reddin ağ kapısında ne anlama geldiği. Numara YOKKEN kapı zaten reddediyor
 * (kapalı arıza, networkTrust.ts). Bu test o davranışın bu düzeltmeyle korunduğunu ve
 * "bilinmeyen numara"nın artık ortamdan kapıya HİÇ ulaşamadığını birlikte gösterir:
 * ölçülmüş kaçış değeri "9" ile kapı eskiden GEÇİYORDU.
 */
test("KRİTİK: stub numara artık ortamdan kapıya ULAŞAMAZ; numarasız kapı zaten reddeder", async () => {
  // (a) Ağ kapısının stub numarayla ne yaptığı — düzeltmeden ÖNCEKİ ölçüm buydu: GEÇİYOR.
  const stubKarar = await agDogrula(
    { approverPhone: "9", simSwapWindowHours: 72, nacSimulate: "temiz" } satisfies AgAyar,
    "medium"
  );
  assert.equal(stubKarar.engel, undefined, "ölçülmüş zemin: kapı stub numarayı ayırt EDEMİYOR");

  // (b) Bu yüzden kelepçe ortamda: böyle bir değer artık ayar okumasından geçemiyor.
  ayarla("AEGIS_APPROVER_PHONE", "9");
  assert.throws(() => nacConfigFromEnv(), /AEGIS_APPROVER_PHONE/);

  // (c) Numaranın YOKLUĞU ise kapıda ret üretir — ret kalkmadı, YERİ değişmedi.
  const numarasiz = await agDogrula(
    { simSwapWindowHours: 72, nacSimulate: "temiz" } satisfies AgAyar,
    "medium"
  );
  assert.match(numarasiz.engel ?? "", /AEGIS_APPROVER_PHONE/, "numarasız kapı reddetmeli");
});

/**
 * SIR SIZINTISI: yanlış yuvaya yapıştırılan bir jeton hata metniyle dışarı çıkamaz.
 * Bu, dosyanın her ret yolunda tekrarlanan kural (parseBool, parseNumEnv, parseBudgetCap)
 * ve ret metnini bir jeton taşıyıcısına çeviren bir "yardımcı olma" girişimine karşı tek
 * gözcü budur.
 */
test("ret HAM DEĞERİ sızdırmaz — ne hata metnine ne stderr'e", () => {
  const SIZINTI_SENTINELI = "EAAG-TEST-ONLY-jeton-905551112233";
  ayarla("AEGIS_APPROVER_PHONE", SIZINTI_SENTINELI);
  const gercek = console.error;
  let yazilanlar = "";
  console.error = (...p: unknown[]) => {
    yazilanlar += p.map(String).join(" ") + "\n";
  };
  try {
    assert.throws(() => loadConfig(), (e: unknown) => {
      const m = (e as Error).message;
      assert.equal(m.includes(SIZINTI_SENTINELI), false, "ham değer hata metnine yazılmamalı");
      assert.match(m, /AEGIS_APPROVER_PHONE/, "operatör hangi değişkeni düzelteceğini görmeli");
      assert.match(m, /E\.164/, "beklenen biçim adıyla söylenmeli");
      assert.match(m, /\+905551112233/, "somut bir örnek verilmeli");
      return true;
    });
  } finally {
    console.error = gercek;
  }
  assert.equal(yazilanlar.includes(SIZINTI_SENTINELI), false, "ham değer stderr'e de yazılmamalı");
});

/* ── 2) nacSimulate yorumu: çift yönlü belge gözcüsü ──────────────────────────── */

const CONFIG_KAYNAK = readFileSync(fileURLToPath(new URL("../src/config.ts", import.meta.url)), "utf8");

/** `alan` bildiriminin hemen ÜSTÜNDEKİ JSDoc bloğunu tek satıra indirger. */
function alanBelgesi(alan: string): string {
  const satirlar = CONFIG_KAYNAK.split("\n");
  const i = satirlar.findIndex((s) => s.trim().startsWith(alan));
  assert.notEqual(i, -1, `${alan} bildirimi bulunamadı — testin çapası kaymış`);
  const blok: string[] = [];
  for (let j = i - 1; j >= 0; j--) {
    const t = satirlar[j]!.trim();
    blok.unshift(t.replace(/^\/\*\*|^\*\/|^\*/, "").trim());
    if (t.startsWith("/**")) break;
    assert.ok(j > i - 60, `${alan} üstünde JSDoc bloğu yok`);
  }
  return blok.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * YÖN (a) — BELGE. Çeviri turu bu cümleyi "…is refused at decision time with a" diye
 * ortasından kesmişti; kalan yarı, doğrulamanın NEREDE yapıldığını artık söylemiyordu.
 * İddia, cümlenin İKİ yarısını birden ister: burada doğrulanmadığı VE karar anında
 * networkTrust.ts tarafından reddedildiği.
 */
test("BELGE: nacSimulate yorumu doğrulamanın YERİNİ tam cümleyle söyler", () => {
  const belge = alanBelgesi("nacSimulate?:");
  assert.match(belge, /The value is NOT validated here/, "yorum 'burada doğrulanmıyor' demeli");
  assert.match(
    belge,
    /refused at decision time by networkTrust\.ts \(fail-closed\)\./,
    "cümlenin ikinci yarısı — reddin NEREDE olduğu — eksik ya da yarım çevrilmiş"
  );
});

/**
 * YÖN (b) — KOD, birinci yarı. Yorum "burada doğrulanmıyor" diyor; bu bir DAVRANIŞTIR ve
 * ölçülebilir: config.ts'e bir doğrulama eklenirse bozuk bir ortam değeri sunucuyu
 * BAŞLANGIÇTA düşürür, yani yorumun engellemek istediği şey olur.
 */
test("KOD: config.ts nacSimulate'i doğrulamaz — bozuk değer ham geçer, fırlatmaz", () => {
  ayarla("AEGIS_NAC_SIMULATE", "bozuk-deger");
  const n = nacConfigFromEnv();
  assert.equal(n.nacSimulate, "bozuk-deger", "değer ham geçmeli (karar anına taşınıyor)");
});

/**
 * YÖN (c) — KOD, ikinci yarı. Yorumun asıl güvencesi: değer KARAR ANINDA reddediliyor.
 * networkTrust.ts bu reddi bırakırsa yorum sessizce yalan olur ve doğrulama hiçbir yerde
 * yapılmaz hâle gelir; o zaman bu satır kırmızıya döner.
 */
test("KOD: tanınmayan nacSimulate KARAR ANINDA reddedilir (kapalı arıza)", async () => {
  const karar = await agDogrula(
    { approverPhone: "+905551112233", simSwapWindowHours: 72, nacSimulate: "bozuk-deger" } satisfies AgAyar,
    "medium"
  );
  assert.match(karar.engel ?? "", /AEGIS_NAC_SIMULATE/, "tanınmayan değer reddedilmeli");
  assert.equal(karar.iz?.retNedeni, "simulasyon-degeri-tanimsiz");
});

/* ── 3) çeviri kalıntısı tarayıcısı (yalnız src/config.ts) ────────────────────── */

/** Türkçe'ye özgü harfler. ASCII'ye çevrilebilen bir kalıntıyı YAKALAMAZ — aşağıya bak. */
const TURKCE_HARF = /[çğıİöşüÇĞÖŞÜâîûÂÎÛ]/;

/**
 * Bir yorum satırında ALINTI DIŞINDA Türkçe harf var mı?
 *
 * Alıntılar ayıklanır çünkü bu dosyanın yorumları Türkçe ürün metinlerini MEŞRU olarak
 * alıntılar (ör. store.ts'in ret mesajı). Ayıklama BİLEREK dar tutuldu — trap: çok geniş
 * bir ayıklama gözcüyü deler. Yalnız çift tırnak ve ters tırnak ayıklanır; TEK TIRNAK
 * ayıklanmaz, çünkü İngilizce yorumlarda kesme işareti (operator's, 0'dan) her yerdedir ve
 * onu bir alıntı başlangıcı saymak satırın yarısını görünmez yapardı.
 *
 * Bunun sonucu bir yazım kuralıdır: config.ts'te Türkçe bir alıntı TEK SATIRDA kalmalı.
 * Satıra yayılan bir alıntının kapanış tırnağı bulunamaz ve tarayıcı onu kalıntı sanır.
 */
function alintiDisiTurkce(satir: string): boolean {
  const t = satir.trim();
  if (!(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"))) return false;
  const soyulmus = t.replace(/"[^"]*"/g, "").replace(/`[^`]*`/g, "");
  return TURKCE_HARF.test(soyulmus);
}

/**
 * TARAYICININ KENDİ SINAVI. Bu olmadan bir üstteki test bir vakum gözcüsü olabilirdi:
 * ayıklama fazla geniş olsaydı hiçbir şey yakalanmazdı ve test yine yeşil kalırdı.
 */
test("tarayıcı sınavı: kalıntıyı yakalar, meşru alıntıya ve İngilizceye dokunmaz", () => {
  // Bu fazda ölçülen gerçek kalıntı biçimi (http.ts / networkTrust.ts'teki ikizleri):
  assert.equal(alintiDisiTurkce(" * ters vekil atlanabilir hâle gelir."), true);
  assert.equal(alintiDisiTurkce(" // dokunulmaz (import bile edilmez)."), false, "ASCII kuyruk");
  // Meşru alıntı: ayıklanır, kalıntı sayılmaz.
  assert.equal(alintiDisiTurkce(' * (store.ts: "maxDailyBudget 0\'dan büyük bir sayı olmalı.")'), false);
  // Ama aynı satırda ALINTI DIŞINDA Türkçe varsa yine yakalanır — ayıklama satırı yutmuyor.
  assert.equal(alintiDisiTurkce(' * hâlâ bir sorun: "büyük bir sayı olmalı"'), true);
  // Kesme işareti bir alıntı başlangıcı sayılmıyor: aradaki metin görünmez olmuyor.
  assert.equal(alintiDisiTurkce(" * the operator's own note: değişmez, don't touch"), true);
  // Kod satırı yorum değildir: Türkçe ürün metni serbesttir.
  assert.equal(alintiDisiTurkce('      `Değer sır ihtimaline karşı gösterilmiyor.`'), false);
});

/**
 * Yarım kalmış çeviri kalıntılarının İKİNCİ biçimi: aksanlı/Türkçe'ye özgü harf taşıyan
 * kuyruklar. DÜRÜSTLÜK NOTU: bu fazda düzeltilen kalıntı ("reddedilmelidir (bkz. …)")
 * saf ASCII olduğu için bu tarayıcı onu YAKALAMAZDI — onun gözcüsü yukarıdaki BELGE
 * testidir. Bu tarama, aynı sınıfın kardeş biçimini kapatır.
 */
test("src/config.ts yorumlarında alıntı dışı Türkçe harf kalıntısı YOK", () => {
  const kalintilar = CONFIG_KAYNAK.split("\n")
    .map((s, i) => ({ no: i + 1, s }))
    .filter(({ s }) => alintiDisiTurkce(s));
  assert.deepEqual(
    kalintilar.map(({ no, s }) => `${no}: ${s.trim()}`),
    [],
    "İngilizce yorum bloğunda çevrilmemiş kalıntı var (ya da Türkçe alıntı iki satıra yayılmış)"
  );
});
