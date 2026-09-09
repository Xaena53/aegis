// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PRIVACY.md BEKÇİSİ — yayımlanmış politikanın kodla aynı şeyi söylemesi.
 *
 * Bu test var olan bir sürüklenmeden doğdu: politika "Google ve kullanıcının kendi MCP
 * istemcisi dışında HİÇBİR tarafa veri iletilmez" diyordu; oysa kod, her risk etiketli
 * harcama eyleminde onaylayıcının TAM E.164 telefon numarasını Nokia Network-as-Code'a
 * (RapidAPI ağ geçidi üzerinden) gönderiyor, Meta araçları kampanya verisini
 * graph.facebook.com'a taşıyor, plancı ise istemi model sağlayıcısına yolluyor.
 * Beyan edilmemiş bir üçüncü-taraf PII aktarımı, politikaya güvenerek çalıştıran
 * operatörü KVKK/GDPR anlamında yanlış bilgilendirir.
 *
 * Bekçinin biçimi kasıtlı: her satır ÖNCE hedefin kodda GERÇEKTEN durduğunu doğrular,
 * SONRA politikada açıklandığını arar. Böylece özellik kaldırıldığında test bayatlayıp
 * sessizce yeşil kalmaz, yeni bir dış hedef eklendiğinde ise politikayı güncellemeyen
 * değişiklik burada kırmızıya düşer (belgeTutarliligi.test.ts ile aynı doktrin: belge,
 * kanıtı olmayan bir şey iddia etmesin — ve kanıtı olan bir şeyi de gizlemesin).
 *
 * 4. TUR — KAPSAM DARALTMASI. Bu iddialar DOSYA GENELİNDE aranıyordu ve açık ÖLÇÜLDÜ:
 * "full phone number" PRIVACY.md'de İKİ satırda geçiyor (CAMARA hedefi satırında bir kez,
 * karar günlüğü satırındaki "Never a full phone number" cümlesinde bir kez), "mask" ise ÜÇ
 * satırda. Yani CAMARA satırı hangi PII'yi gönderdiğini söylemeyi bıraksa bile dosya
 * genelindeki tarama, KOMŞU SATIRDAKİ olumsuz cümle sayesinde yeşil kalıyordu. Bir iddia,
 * ait olduğu satırda okunmuyorsa gözcülük edilmiş sayılmaz. Artık her iddia, çıpasını
 * taşıyan TEK satırın içinde aranıyor; aşağıdaki fikstür bu farkı ölçülebilir tutuyor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const KOK = path.join(import.meta.dirname, "..");

function oku(goreliYol: string): string {
  return readFileSync(path.join(KOK, goreliYol), "utf8");
}

const politika = oku("PRIVACY.md");

/**
 * `capa` çıpasını taşıyan TEK satır; çıpa yoksa ya da birden çok satıra dağılmışsa "".
 *
 * PRIVACY.md her hedefi TEK bir markdown tablo satırında anlatıyor; dolayısıyla "ilgili yer"
 * bir satırdır. Belirsizlik BİLEREK yokluk sayılır: bir çıpa iki satıra düşerse artık yetkili
 * satır kalmaz ve okuyucu aktarımı hangisinin anlattığını seçemez — bu elle çözülmesi gereken
 * bir durumdur, dosya geneli taramayla üstü örtülecek bir durum değil.
 */
function kapsamSatiri(metin: string, capa: RegExp): string {
  const eslesenler = metin.split(/\r?\n/).filter((satir) => capa.test(satir));
  return eslesenler.length === 1 ? (eslesenler[0] ?? "") : "";
}

/** Yalnız ÇIPALI SATIRIN KENDİSİ iddiayı taşıyorsa doğru; başka yerdeki isabet sayılmaz. */
function satirdaGecer(metin: string, capa: RegExp, gerek: RegExp): boolean {
  const satir = kapsamSatiri(metin, capa);
  return satir !== "" && gerek.test(satir);
}

/** Aynı yüklemin assert'lı sarmalayıcısı; mesaj gerçekten okunan satırı gösterir. */
function satirIddiasi(capa: RegExp, gerek: RegExp, mesaj: string): void {
  const satir = kapsamSatiri(politika, capa);
  assert.notEqual(
    satir,
    "",
    `PRIVACY.md'de ${capa} çıpasını taşıyan TEK bir satır yok (hiç geçmiyor ya da birden çok ` +
      `satıra dağılmış). İddianın hangi satırda okunacağı belirsizse gözcü de yoktur.`
  );
  assert.ok(gerek.test(satir), `${mesaj}\n  okunan satır: ${satir.slice(0, 200)}…`);
}

/**
 * Kodda gerçekten var olan DIŞ hedefler ve politikada bulunması gereken karşılıkları.
 * `kaynak`/`kanit` çifti testin bayatlamasını engeller: kanıt kodda yoksa test, politika
 * ne derse desin, "artık geçersiz" diye bağırır. `capa` politikadaki satırı seçer,
 * `ayniSatirda` ise o satırın içinde aranan iddialardır — dosyanın başka bir yerinde değil.
 */
const DIS_HEDEFLER: ReadonlyArray<{
  ad: string;
  kaynak: string;
  kanit: string;
  capa: RegExp;
  ayniSatirda: readonly RegExp[];
}> = [
  {
    ad: "Nokia Network-as-Code / CAMARA (RapidAPI ağ geçidi)",
    kaynak: "src/networkTrust.ts",
    kanit: "network-as-code.nokia.rapidapi.com",
    capa: /network-as-code\.nokia\.rapidapi\.com/,
    ayniSatirda: [/AEGIS_APPROVER_PHONE/],
  },
  {
    ad: "Meta Marketing API",
    kaynak: "src/meta/client.ts",
    kanit: "https://graph.facebook.com/",
    capa: /graph\.facebook\.com/,
    ayniSatirda: [/AEGIS_META_TOKEN/],
  },
  {
    ad: "Model sağlayıcı (plancı)",
    kaynak: "scripts/brain/ortak.mjs",
    kanit: "https://generativelanguage.googleapis.com/",
    capa: /generativelanguage\.googleapis\.com/,
    ayniSatirda: [/npm run brain|planner/i],
  },
];

for (const hedef of DIS_HEDEFLER) {
  test(`PRIVACY.md ${hedef.ad} hedefini AYNI SATIRDA açıklıyor`, () => {
    assert.ok(
      oku(hedef.kaynak).includes(hedef.kanit),
      `Bulgu bayatladı: ${hedef.kaynak} artık ${hedef.kanit} içermiyor — bu testi güncelle.`
    );
    for (const gerek of hedef.ayniSatirda) {
      satirIddiasi(
        hedef.capa,
        gerek,
        `PRIVACY.md, ${hedef.ad} hedefinin SATIRINDA ${gerek} iddiasını taşımıyor. Aynı ifadenin ` +
          `dosyanın başka bir yerinde geçmesi bu hedefi açıklamaz.`
      );
    }
  });
}

/**
 * KRİTİK: onaylayıcının TAM numarası ağa çıkıyor. Politika bunu adıyla söylemeli —
 * "telefon numarası gönderiliyor" cümlesi olmadan tablo, hangi PII'nin sınır dışına
 * çıktığını okuyucuya bırakır. Ve bu cümle CAMARA satırının KENDİSİNDE durmalı: karar
 * günlüğü satırındaki "Never a full phone number" olumsuzu, dosya genelinde arayan bir
 * gözcüyü ölçülen biçimde yeşile düşürüyordu.
 */
const CAMARA_CAPA = /network-as-code\.nokia\.rapidapi\.com/;

test("PRIVACY.md tam telefon numarasının CAMARA sağlayıcısına gittiğini SATIRINDA söylüyor", () => {
  const kaynak = oku("src/networkTrust.ts");
  assert.ok(
    /client\.simSwap\.check\(\s*\{\s*phoneNumber/.test(kaynak),
    "Bulgu bayatladı: SIM Swap halkası artık phoneNumber göndermiyor — bu testi güncelle."
  );
  satirIddiasi(
    CAMARA_CAPA,
    /full phone number/i,
    "PRIVACY.md'nin CAMARA satırı, onaylayıcının TAM telefon numarasının gönderildiğini söylemiyor."
  );
  satirIddiasi(
    CAMARA_CAPA,
    /E\.164/,
    "PRIVACY.md'nin CAMARA satırı, gönderilen numaranın biçimini (E.164) adlandırmıyor."
  );
  /*
   * Cümle OLUMLU olmalı. Aksi halde satır kapsamı bile, kodun yaptığının tersini söyleyen bir
   * satırı ("never a full phone number") kabul ederdi — dosya geneli taramayı işe yaramaz kılan
   * ifadenin tam olarak kendisi bu.
   */
  assert.equal(
    /\b(never|not|no)\s+(a\s+)?full phone number/i.test(kapsamSatiri(politika, CAMARA_CAPA)),
    false,
    "PRIVACY.md'nin CAMARA satırı tam numarayı OLUMSUZLAYARAK anıyor; oysa kod onu gönderiyor."
  );
});

/**
 * Karar günlüğü DİSKE kalıcı bir dosya yazıyor; "yazılımın sakladıkları" tablosunda yer
 * almazsa politika, var olan bir kalıcı kaydı gizlemiş olur. Maskeleme iddiası da o satırda
 * okunur: "mask" kelimesi dosyada üç ayrı satırda geçiyor, dolayısıyla dosya geneli tarama
 * günlük satırından silinen maskelemeyi göremezdi.
 */
const GUNLUK_CAPA = /AEGIS_DECISION_LOG/;

test("PRIVACY.md diske yazılan karar günlüğünü sakladıkları arasında sayıyor", () => {
  assert.ok(
    oku("src/kararGunlugu.ts").includes("AEGIS_DECISION_LOG"),
    "Bulgu bayatladı: karar günlüğü artık AEGIS_DECISION_LOG okumuyor — bu testi güncelle."
  );
  satirIddiasi(
    GUNLUK_CAPA,
    /JSONL|one .* line per|satır/i,
    "PRIVACY.md, AEGIS_DECISION_LOG satırında diske yazılan denetim izinin ne olduğunu anmıyor."
  );
  // Kayıttaki numara MASKELİ; politika bunu SATIRINDA söylemezse okuyucu tam numara sanabilir.
  satirIddiasi(
    GUNLUK_CAPA,
    /mask(ed)?/i,
    "PRIVACY.md'nin karar günlüğü satırı, günlükteki numaranın maskeli olduğunu söylemiyor."
  );
});

/**
 * Asıl yanlış cümlenin geri gelmesine karşı kilit: "Google dışında hiçbir tarafa" gibi
 * MUTLAK bir dışlama, yukarıdaki üç hedefle aynı dosyada duramaz. Burada kapsam BİLEREK
 * dosya geneli: yasaklanan şey bir satırın eksikliği değil, cümlenin dosyada HERHANGİ bir
 * yerde bulunması.
 */
test("PRIVACY.md 'Google dışında hiçbir yere' mutlak iddiasını taşımıyor", () => {
  assert.doesNotMatch(
    politika,
    /other than Google/i,
    "PRIVACY.md hâlâ 'Google dışında hiçbir tarafa iletilmez' diyor; Nokia/Meta/model sağlayıcı bu iddiayı yanlışlıyor."
  );
  assert.doesNotMatch(
    politika,
    /No data is sold or shared/i,
    "'sold or shared' ifadesi geri gelmiş: veri PAYLAŞILIYOR (üçüncü taraf uç noktalar), yalnızca satılmıyor."
  );
});

/**
 * "Last updated" tarihi, CAMARA ve Meta entegrasyonlarından ÖNCEYE (13 Ağustos 2026)
 * işaret edemez: o tarihli bir politika, bu entegrasyonları görmüş olamaz.
 */
test("PRIVACY.md tarihi entegrasyonlardan sonraki bir tarih", () => {
  const eslesme = /^\*Last updated: (.+)\*$/m.exec(politika);
  assert.ok(eslesme, "PRIVACY.md'de 'Last updated' satırı bulunamadı.");
  const tarih = new Date(eslesme![1]!);
  assert.ok(!Number.isNaN(tarih.getTime()), `'Last updated' tarihi okunamadı: ${eslesme![1]}`);
  assert.ok(
    tarih.getTime() >= Date.UTC(2026, 8, 1),
    `PRIVACY.md tarihi (${eslesme![1]}) CAMARA/Meta entegrasyonlarından önceye işaret ediyor.`
  );
});

/**
 * MUTASYON FİKSTÜRÜ — ölçülen sahte-yeşilin kendisi.
 *
 * Sentetik politika üzerinde çalışır: PRIVACY.md'yi geçici olarak bozmak, aynı dosyada uçuşan
 * başka bir değişikliği ezme riski taşır (kardeş gözcüler onarim2NetworkTrust.test.ts ve
 * onarim2Uygulama.test.ts aynı gerekçeyle sentetik fikstür kullanıyor). Fikstür, CAMARA
 * satırından PII cümlesini kaldırıp komşu satırdaki olumsuz cümleyi yerinde bırakır: dosya
 * geneli tarama YEŞİL kalır, satır kapsamı KIRMIZI olur. Kapsam bir gün yeniden dosya geneline
 * genişletilirse bu test onu söyler.
 */
test("gözcü gerçekten kırmızıya düşebiliyor: satır kapsamı, dosya kapsamının kaçırdığını yakalıyor", () => {
  const CAMARA_SATIRI =
    "| Nokia Network-as-Code (GSMA Open Gateway / CAMARA), reached through the RapidAPI gateway " +
    "`network-as-code.nokia.rapidapi.com` | **The approver's full phone number in E.164 form** " +
    "(`AEGIS_APPROVER_PHONE`), plus a look-back window in hours | Off by default |";
  const GUNLUK_SATIRI =
    "| Decision log — one JSONL line per risk-tagged network decision | A file at the path in " +
    "`AEGIS_DECISION_LOG` | ... the approver's number **masked** (for example `+905*******33`). " +
    "Never a full phone number, never a token |";
  const AJAN_SATIRI =
    "| Anthropic (`api.anthropic.com`) | ... the network gate's refusal text, in which the " +
    "approver's number appears only masked | Off by default |";

  const saglam = [CAMARA_SATIRI, GUNLUK_SATIRI, AJAN_SATIRI].join("\n");
  /** PII cümlesi CAMARA satırından düşürüldü; komşu satırdaki olumsuzu duruyor. */
  const bayat = saglam.replace(
    "**The approver's full phone number in E.164 form**",
    "**An identifier for the approver**"
  );
  /** Maskeleme günlük satırından düşürüldü; "masked" kelimesi ajan satırında kalıyor. */
  const maskesiz = saglam.replace("the approver's number **masked**", "the approver's number");

  assert.ok(satirdaGecer(saglam, CAMARA_CAPA, /full phone number/i), "sağlam fikstür yeşil olmalı");
  assert.ok(satirdaGecer(saglam, CAMARA_CAPA, /E\.164/), "sağlam fikstür E.164'ü satırında taşır");
  assert.ok(satirdaGecer(saglam, GUNLUK_CAPA, /mask(ed)?/i), "sağlam fikstürde maskeleme yazılı");

  assert.equal(
    satirdaGecer(bayat, CAMARA_CAPA, /full phone number/i),
    false,
    "CAMARA satırı PII cümlesini kaybettiğinde satır kapsamı kırmızıya düşmüyor — daraltma boşa gitmiş"
  );
  assert.equal(
    satirdaGecer(bayat, CAMARA_CAPA, /E\.164/),
    false,
    "CAMARA satırı E.164 biçimini kaybettiğinde satır kapsamı kırmızıya düşmüyor"
  );
  assert.equal(
    satirdaGecer(maskesiz, GUNLUK_CAPA, /mask(ed)?/i),
    false,
    "günlük satırı maskelemeyi kaybettiğinde satır kapsamı kırmızıya düşmüyor"
  );

  /*
   * Ve daraltmayı zorunlu kılan ölçüm: ESKİ dosya geneli tarama, komşu satırlar kelimeleri
   * hâlâ taşıdığı için HER İKİ mutasyonu da yeşil geçiyor. Bulgunun bildirdiği sahte-yeşil
   * burada koşulabilir hâlde duruyor, böylece fark edilmeden geri gelemez.
   */
  assert.match(
    bayat,
    /full phone number/i,
    "dosya geneli tarama bayat politikayı YEŞİL geçerdi — daraltmanın ölçülen sebebi bu"
  );
  assert.match(
    maskesiz,
    /mask(ed)?/i,
    "dosya geneli tarama maskesiz günlük satırını YEŞİL geçerdi — daraltmanın ölçülen sebebi bu"
  );

  /** Çıpa birden çok satıra dağılırsa "tek yetkili satır" kalmaz: bu da kırmızıdır. */
  const ikizli = `${saglam}\n${CAMARA_SATIRI}`;
  assert.equal(
    satirdaGecer(ikizli, CAMARA_CAPA, /full phone number/i),
    false,
    "çıpa iki satırda geçerken gözcü yine de bir satırı yetkili sayıyor — belirsizlik sessizce geçiyor"
  );
});
