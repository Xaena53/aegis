// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ZİNCİR BÜTÜNLÜĞÜ — halka kaydı ile AŞAĞI AKIŞTAKİ tüketiciler arasındaki bağ.
 *
 * NEDEN VAR: bu depoda dört tur üst üste aynı hata sınıfı tekrarladı. Ağ kapısına yeni
 * bir halka eklendi, kapı doğru çalıştı, halkanın kendi testleri yeşil kaldı — ama halka
 * AŞAĞI AKIŞTA hiçbir yere bağlanmadı:
 *
 *   • karar günlüğü halkanın kanalını hiç yazmadı (denetim izi, SİMÜLE bir halkanın
 *     ürettiği reti gerçek bir CAMARA sorgusunun ürünü gibi gösterdi),
 *   • http.ts'in contextFor önbellek anahtarı halkanın ayarını taşımadı (operatör halkayı
 *     AÇTI, açık oturumlar KAPALI hâliyle önbellekten servis edilmeye devam etti —
 *     eksiklik SESSİZ ve TEK YÖNLÜ: hep gevşek tarafa düşer),
 *   • Growth Brain'in ret sınıflandırıcısı halkanın ret metnini tanımadı (ağ kapısının
 *     yaptığı iş raporda sıradan bir sunucu reddi gibi göründü, "GÜVENLİK KAPISI
 *     ÇALIŞTI" bloğu hiç basılmadı),
 *   • env belgeleri halkanın anahtarlarını hiç anmadı (token gelen operatörün elinde
 *     eksik talimat kaldı).
 *
 * Ortak payda: testi olan bağlantılar tuttu, testsiz olanlar kaçtı. Bu dosya o boşluğu
 * kapatır — ZINCIR_HALKALARI kaydı üzerinde döner ve HER halka için HER tüketiciyi
 * ayrı ayrı doğrular. Yeni halka eklendiğinde eksik bağlantı burada KIRMIZI olur.
 *
 * SÖZLEŞME: buradaki hiçbir test kapı mantığına dokunmaz, gevşetmez ve ağa çıkmaz;
 * yalnız kaydı ve kaynak dosyaları okur. Bir başarısızlık mesajı NE YAPILACAĞINI söyler.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ZINCIR_HALKALARI,
  ZINCIR_ORTAK_AYARLARI,
  ZINCIR_ORTAK_ENVLERI,
} from "../src/networkTrust.js";
import type { AgIz, AgKarar } from "../src/networkTrust.js";
import { agKararKaydiOlustur, kararYaz } from "../src/kararGunlugu.js";
import { nacAnahtarDilimi, type NacDilimi } from "../src/config.js";

/** Yol çözümlemesi cwd'ye DEĞİL dosyanın kendi konumuna bağlı (import.meta.url). */
const yol = (goreli: string) => fileURLToPath(new URL(goreli, import.meta.url));
const oku = (goreli: string) => readFileSync(yol(goreli), "utf8");

const KAYNAK_AG = oku("../src/networkTrust.ts");
const KAYNAK_HTTP = oku("../src/http.ts");
const KAYNAK_CONFIG = oku("../src/config.ts");
const KAYNAK_BEYIN = oku("../scripts/brain/uygulama.mjs");
const ENV_ORNEK = oku("../.env.example");
const BELGE_README = oku("../README.md");
const BELGE_CAMARA = oku("../docs/CAMARA.md");
const BELGE_DEMO = oku("../docs/DEMO.md");

/** Kayıttaki tüm env adları (halkaların kendi env'leri + zincir geneli ortak ayarlar). */
const TUM_ENVLER = [...ZINCIR_HALKALARI.flatMap((h) => [...h.envler]), ...ZINCIR_ORTAK_ENVLERI];

/* ── 0) Kaydın kendi sağlığı ─────────────────────────────────────────────────── */

test("kayıt: bugünkü zincir ALTI halka ve her alan dolu", () => {
  assert.equal(
    ZINCIR_HALKALARI.length,
    6,
    "ZINCIR_HALKALARI halka sayısı değişti — halka eklendiyse bu sayı ve aşağıdaki " +
      "tüm tüketiciler (kararGunlugu.ts + http.ts contextFor + uygulama.mjs " +
      "AG_KAPISI_IZLERI + .env.example) birlikte güncellenmeli."
  );
  for (const halka of ZINCIR_HALKALARI) {
    assert.ok(halka.id.trim(), "halka id boş olamaz");
    assert.ok(halka.izAlani.trim(), `halka ${halka.id}: izAlani boş`);
    assert.ok(halka.gunlukAlani.trim(), `halka ${halka.id}: gunlukAlani boş`);
    assert.ok(halka.retIsaretleri.length > 0, `halka ${halka.id}: retIsaretleri boş`);
    assert.ok(halka.envler.length > 0, `halka ${halka.id}: envler boş`);
    assert.ok(halka.ayarAlanlari.length > 0, `halka ${halka.id}: ayarAlanlari boş`);
  }
});

test("kayıt: id / izAlani / gunlukAlani BENZERSİZ — iki halka tek alana ezilemez", () => {
  for (const alan of ["id", "izAlani", "gunlukAlani"] as const) {
    const degerler = ZINCIR_HALKALARI.map((h) => h[alan]);
    assert.equal(
      new Set(degerler).size,
      degerler.length,
      `İki halka aynı '${alan}' değerini paylaşıyor (${degerler.join(", ")}). Halkalar ASLA ` +
        `tek alana ezilmez: her halka KENDİ iz/günlük alanını ister, yoksa denetim izi ` +
        `hangi halkanın karar verdiğini söyleyemez.`
    );
  }
});

/* ── 1) Karar günlüğü: halkanın kanalı kayda VE JSONL satırına düşüyor mu? ───── */

test("günlük: her halkanın kanalı hem KararKaydi'nde hem JSONL çıktısında görünür", () => {
  const dizin = mkdtempSync(join(tmpdir(), "adspilot-zincir-"));
  const dosya = join(dizin, "kararlar.jsonl");
  const onceki = process.env.ADSPILOT_DECISION_LOG;
  process.env.ADSPILOT_DECISION_LOG = dosya;
  try {
    for (const halka of ZINCIR_HALKALARI) {
      /**
       * Nöbetçi değer ("simulasyon") YALNIZ sınanan halkanın alanında bulunur; simSwap
       * zorunlu alan olduğu için gürültü değeri AYRI seçilir ("kapali", geçerli bir
       * SimSwapIzi). İkisi aynı olsaydı çapraz bağlama görünmezdi: bir halkanın günlük
       * alanı yanlışlıkla iz.simSwap'a bağlansa test yine beklediği değeri okur ve yeşil
       * kalırdı (mutasyonla kanıtlandı). Ayrı değerlerle, kayda düşen "simulasyon" ancak
       * bu halkanın izinden gelebilir.
       */
      const izHam: Record<string, unknown> = { simSwap: "kapali" };
      izHam[halka.izAlani] = "simulasyon";
      const ag: AgKarar = { kanit: [], iz: izHam as unknown as AgIz };

      const kayit = agKararKaydiOlustur(`bütünlük denemesi (${halka.id})`, "high", ag);
      const kayitHam = kayit as unknown as Record<string, unknown>;
      assert.equal(
        kayitHam[halka.gunlukAlani],
        "simulasyon",
        `halka '${halka.id}' eklendi ama kararGunlugu'na alan eklenmemiş: KararKaydi ` +
          `arayüzüne '${halka.gunlukAlani}' alanı + agKararKaydiOlustur içinde ` +
          `iz.${halka.izAlani}'den okuma + kararYaz'daki JSONL yazımı gerekiyor. ` +
          `Alan olmadan denetim izi, bu halkanın SİMÜLE mi GERÇEK mi karar verdiğini söyleyemez.`
      );

      kararYaz(kayit);
      const satirlar = readFileSync(dosya, "utf8").trim().split("\n");
      const sonSatir = JSON.parse(satirlar[satirlar.length - 1]) as Record<string, unknown>;
      assert.equal(
        sonSatir[halka.gunlukAlani],
        "simulasyon",
        `halka '${halka.id}' KararKaydi'nde var ama JSONL satırına yazılmıyor: ` +
          `kararGunlugu.ts · kararYaz() içindeki JSON.stringify alan listesine ` +
          `'${halka.gunlukAlani}' eklenmeli. (Alan listesi bilinçli olarak ELLE yazılır; ` +
          `bu yüzden yeni halka orada sessizce düşer.)`
      );
    }
  } finally {
    if (onceki === undefined) delete process.env.ADSPILOT_DECISION_LOG;
    else process.env.ADSPILOT_DECISION_LOG = onceki;
    rmSync(dizin, { recursive: true, force: true });
  }
});

/* ── 2) http.ts · contextFor önbellek anahtarı ───────────────────────────────── */

/**
 * Anahtar sınaması DAVRANIŞSAL: metin taraması değil, fonksiyonun kendisi çağrılır.
 *
 * Önceki hâli `const key = [ … ]` bloğunu kaynaktan kesip alan adını regex ile arıyordu.
 * Mutasyonla kanıtlandı ki bu koruma değildi: satırı `//` ile yorum yapmak ya da yerine
 * "ileride eklenecek" notu koymak, alanı gerçek anahtardan tamamen düşürdüğü hâlde testi
 * yeşil bırakıyordu — çünkü ad hâlâ blok aralığında bir yorumda geçiyordu. Şimdi tek
 * alanda farklılaşan iki yapılandırmanın FARKLI anahtar ürettiği sınanıyor; bir alan
 * anahtardan düşerse iki çıktı eşitlenir ve test kızarır.
 */
const TEMEL_NAC = {
  nacToken: "t", approverPhone: "+905551112233", simSwapWindowHours: 72,
  nacSimulate: undefined, nvSimulate: undefined,
  reachCheck: false, reachSimulate: undefined,
  locSimulate: undefined, expectedCountry: undefined,
  devSwapCheck: false, devSwapSimulate: undefined,
  callFwdCheck: false, callFwdSimulate: undefined,
} as unknown as NacDilimi;

/** Alanın tipine uygun, TEMEL_NAC'takinden farklı bir değer. */
function farkliDeger(alan: string): unknown {
  const mevcut = (TEMEL_NAC as unknown as Record<string, unknown>)[alan];
  if (typeof mevcut === "boolean") return !mevcut;
  if (typeof mevcut === "number") return mevcut + 1;
  return "FARKLI-DEGER";
}

function anahtarDegisiyorMu(alan: string): boolean {
  const degistirilmis = { ...(TEMEL_NAC as unknown as Record<string, unknown>) };
  degistirilmis[alan] = farkliDeger(alan);
  return (
    nacAnahtarDilimi(TEMEL_NAC).join("|") !==
    nacAnahtarDilimi(degistirilmis as unknown as NacDilimi).join("|")
  );
}

test("önbellek anahtarı: her halkanın AgAyar alanı anahtarı GERÇEKTEN değiştiriyor", () => {
  for (const halka of ZINCIR_HALKALARI) {
    for (const alan of halka.ayarAlanlari) {
      assert.ok(
        anahtarDegisiyorMu(alan),
        `halka '${halka.id}' eklendi ama '${alan}' alanı config.ts · nacAnahtarDilimi'ne ` +
          `eklenmemiş: yalnız bu alanı değiştirdim, anahtar AYNI kaldı. Eksiklik SESSİZ ve ` +
          `TEK YÖNLÜ — halkayı AÇAN operatör, halka KAPALIYKEN üretilmiş bağlamı önbellekten ` +
          `almaya devam eder ve hiç koşmayan bir korumanın koştuğuna inanır.`
      );
    }
  }
});

test("önbellek anahtarı: zincir geneli ortak ayarlar da anahtarı değiştiriyor", () => {
  for (const alan of ZINCIR_ORTAK_AYARLARI) {
    assert.ok(
      anahtarDegisiyorMu(alan),
      `Zincir geneli ayar '${alan}' anahtarı değiştirmiyor — onaylayıcı numarası/pencere ` +
        `değişince açık oturumlar eski değerle koşmaya devam eder.`
    );
  }
});

test("önbellek anahtarı: http.ts anahtarı gerçekten nacAnahtarDilimi'nden kuruyor", () => {
  /**
   * Davranışsal sınama config.ts'i kanıtlar; bu tek satır da http.ts'in o fonksiyonu
   * BAŞKA bir elle yazılmış listeyle değiştirmediğini kanıtlar. İkisi birlikte zinciri
   * uçtan uca bağlar.
   */
  assert.match(
    KAYNAK_HTTP,
    /const key = \[[^\]]*\.\.\.nacAnahtarDilimi\(nac\)/s,
    "src/http.ts · contextFor artık nacAnahtarDilimi(nac) kullanmıyor — anahtar elle " +
      "yazılmış bir listeye dönmüşse davranışsal sınama onu görmez."
  );
});

/* ── 3) Growth Brain · AG_KAPISI_IZLERI ret sınıflandırıcısı ─────────────────── */

/**
 * uygulama.mjs'teki AG_KAPISI_IZLERI dizisini KAYNAKTAN okur ve gerçek RegExp'lere
 * çevirir. Kaynak okunur (import edilmez) çünkü .mjs'in tip tanımı yoktur ve typecheck
 * test/**'i de kapsar; ayrıca sınanan şey tam olarak SEVK EDİLEN dosyanın içeriğidir.
 */
function agKapisiDesenleri(): RegExp[] {
  const bas = KAYNAK_BEYIN.indexOf("const AG_KAPISI_IZLERI = [");
  assert.notEqual(
    bas,
    -1,
    "scripts/brain/uygulama.mjs içinde AG_KAPISI_IZLERI bulunamadı — sınıflandırıcı " +
      "yeniden adlandırıldıysa bu test de güncellenmeli (sessizce devre dışı kalmasın)"
  );
  const son = KAYNAK_BEYIN.indexOf("];", bas);
  assert.notEqual(son, -1, "AG_KAPISI_IZLERI dizisi kapanmıyor — kaynak ayrıştırılamadı");

  const desenler: RegExp[] = [];
  for (const satir of KAYNAK_BEYIN.slice(bas, son).split(/\r?\n/)) {
    const m = /^\s*\/(.+)\/([a-z]*),?\s*$/.exec(satir);
    if (m) desenler.push(new RegExp(m[1], m[2]));
  }
  assert.ok(
    desenler.length >= 10,
    `AG_KAPISI_IZLERI'nden yalnız ${desenler.length} desen ayrıştırılabildi — ` +
      "ayrıştırma bozulmuş olabilir; test yanlışlıkla yeşil kalmasın diye burada durur"
  );
  return desenler;
}

test("beyin sınıflandırıcısı: her halkanın ret imzası AG_KAPISI_IZLERI'nce tanınıyor", () => {
  const desenler = agKapisiDesenleri();
  for (const halka of ZINCIR_HALKALARI) {
    const eslesen = halka.retIsaretleri.some((isaret) => desenler.some((d) => d.test(isaret)));
    assert.ok(
      eslesen,
      `halka '${halka.id}' eklendi ama scripts/brain/uygulama.mjs · AG_KAPISI_IZLERI ` +
        `bu halkanın ret metnini TANIMIYOR. Listeye halkanın ayırt edici ifadelerinden ` +
        `biri eklenmeli (ör. "${halka.retIsaretleri[0]}"). Tanınmazsa halkanın reti ` +
        `'ag-retti' yerine 'reddedildi' sınıflanır: rapor "GÜVENLİK KAPISI ÇALIŞTI" ` +
        `bloğunu basmaz ve ağ kapısının yaptığı iş sıradan bir sunucu reddi gibi görünür.`
    );
  }
});

test("beyin sınıflandırıcısı: her halkanın env adı da desenlerce yakalanıyor", () => {
  const desenler = agKapisiDesenleri();
  for (const halka of ZINCIR_HALKALARI) {
    for (const env of halka.envler) {
      assert.ok(
        desenler.some((d) => d.test(env)),
        `halka '${halka.id}' env'i '${env}' AG_KAPISI_IZLERI desenlerinin hiçbirine uymuyor. ` +
          `Halkanın yapılandırma/çelişki retleri (metinleri env adından başka ağ izi taşımaz) ` +
          `bu yüzden 'reddedildi' sınıflanır. uygulama.mjs'teki ` +
          `/ADSPILOT_(…)_[A-Z_]+/ desenine halkanın önekini ekle.`
      );
    }
  }
});

/* ── 4) Kayıt UYDURMUYOR: ret imzaları kapının kendi metninde geçiyor ────────── */

/**
 * Kaynağın KAYIT BLOĞU DIŞI kısmı — ret imzalarının aranacağı yer.
 *
 * ZINCIR_HALKALARI kaydı da src/networkTrust.ts'in içinde yaşadığı için, imzayı tüm
 * dosyada aramak kendi kendini doğrulayan bir sınamaydı: kayda yazmak, aranan metni
 * dosyaya yazmak demekti. Mutasyonla kanıtlandı — kapının hiçbir ret cümlesinde geçmeyen
 * uydurma bir imza tüm süiti geçiyordu. Kayıt bloğu kesilince imza ancak GERÇEK bir ret
 * metninde bulunabilir.
 */
const KAYNAK_AG_KAYITSIZ = (() => {
  const bas = KAYNAK_AG.indexOf("export const ZINCIR_HALKALARI");
  assert.notEqual(bas, -1, "ZINCIR_HALKALARI kaydı bulunamadı — test yolu bayatlamış");
  const son = KAYNAK_AG.indexOf("] as const;", bas);
  assert.notEqual(son, -1, "ZINCIR_HALKALARI kaydının sonu bulunamadı — test yolu bayatlamış");
  return KAYNAK_AG.slice(0, bas) + KAYNAK_AG.slice(son);
})();

test("kayıt dürüstlüğü: her retIsareti GERÇEK bir ret metninde geçiyor (kayıt bloğu hariç)", () => {
  for (const halka of ZINCIR_HALKALARI) {
    for (const isaret of halka.retIsaretleri) {
      assert.ok(
        KAYNAK_AG_KAYITSIZ.includes(isaret),
        `halka '${halka.id}' kaydındaki ret imzası "${isaret}" src/networkTrust.ts'in ` +
          `KAYIT DIŞI kısmında GEÇMİYOR — yani hiçbir gerçek ret cümlesi bu metni üretmiyor. ` +
          `Uydurma ya da bayat bir imza, sınıflandırıcı testini var olmayan bir metne karşı ` +
          `"doğrular"; gerçek ret geldiğinde Growth Brain onu 'ag-retti' yerine 'reddedildi' ` +
          `sınıflar ve "GÜVENLİK KAPISI ÇALIŞTI" bloğu hiç basılmaz.`
      );
    }
  }
});

/* ── 5) Env adları GERÇEKTEN okunuyor mu? (config.ts) ────────────────────────── */

test("kayıt dürüstlüğü: her env adı config.ts'te process.env ile okunuyor", () => {
  for (const env of TUM_ENVLER) {
    assert.ok(
      new RegExp(`process\\.env\\.${env}\\b`).test(KAYNAK_CONFIG),
      `Kayıttaki '${env}' src/config.ts'te process.env ile HİÇ okunmuyor — ya env adı ` +
        `uydurma/yanlış yazılmış, ya da halka yapılandırmadan besleniyor sanılıp aslında ` +
        `hiç okunmuyor. İkisi de sessiz yalan; kayıt kodu takip etmeli.`
    );
  }
});

test("kayıt dürüstlüğü: her AgAyar alanı config.ts'te GERÇEKTEN üretiliyor", () => {
  for (const alan of [...ZINCIR_HALKALARI.flatMap((h) => [...h.ayarAlanlari]), ...ZINCIR_ORTAK_AYARLARI]) {
    assert.ok(
      new RegExp(`\\b${alan}\\s*:`).test(KAYNAK_CONFIG),
      `Kayıttaki AgAyar alanı '${alan}' src/config.ts'te üretilmiyor — halka ayarı kapıya ` +
        `hiç ulaşmıyor olabilir (nacConfigFromEnv çıktısına ekle).`
    );
  }
});

/* ── 6) Env belgeleri ────────────────────────────────────────────────────────── */

test(".env.example: her halkanın her env adı belgeli", () => {
  for (const env of TUM_ENVLER) {
    assert.ok(
      ENV_ORNEK.includes(env),
      `'${env}' .env.example'da YOK. .env.example bu deponun env sözleşmesidir: eksik ` +
        `anahtar, halkayı açmak isteyen operatörün onu hiç öğrenememesi demektir. ` +
        `Halkayı açıklayan bir blokla birlikte ekle (varsayılan değeri ve opt-in olduğunu yaz).`
    );
  }
});

test("docs/DEMO.md: her halkanın simülasyon env'i demo runbook'unda anılıyor", () => {
  /**
   * DEMO.md gözcünün dışında kalmıştı ve bu bilinçli bir kapsam kararı değil, unutulmuş
   * bir tüketiciydi — dört turdur tekrarlayan "testli bağlantı tuttu, testsiz olan kaçtı"
   * örüntüsünün aynısı. Runbook'u sahnede takip eden operatör, ancak burada anılan
   * halkaları tanır; anılmayan halka onun için yoktur.
   *
   * Şart halka BAŞINA konur (env başına değil): bir halkanın en az bir env'i geçmeli.
   * Runbook her anahtarı tek tek saymak zorunda değil, ama hiçbirini anmadığı bir halka
   * demoda görünmez demektir.
   */
  for (const halka of ZINCIR_HALKALARI) {
    assert.ok(
      halka.envler.some((env) => BELGE_DEMO.includes(env)),
      `halka '${halka.id}' docs/DEMO.md'de hiç anılmıyor (aranan: ${halka.envler.join(", ")}). ` +
        `Demo runbook'u sahnede izlenen belgedir; anmadığı halkayı operatör hiç öğrenmez.`
    );
  }
});

test("docs/CAMARA.md: her halkanın her env adı sinyal envanterinde belgeli", () => {
  for (const env of TUM_ENVLER) {
    assert.ok(
      BELGE_CAMARA.includes(env),
      `'${env}' docs/CAMARA.md'de YOK. Bu belge, "hangi CAMARA sinyali gerçekten koşuyor, ` +
        `hangisi yalnız simülasyon" sorusunun tek cevabıdır; bir halkanın anahtarını ` +
        `anmıyorsa belge çalışan bir korumadan hiç söz etmiyor demektir. ` +
        `Halkayı sinyal envanterine ve token gelince izlenecek kontrol listesine ekle.`
    );
  }
});

/**
 * README bir ÖZET: her env'i oraya taşımak ön sayfayı yapılandırma gürültüsüne çevirirdi.
 * Buradaki sözleşme bu yüzden env başına değil HALKA başınadır — sinyal tablosu bir
 * halkayı SESSİZCE atlayamaz. (Tam da bu kaçmıştı: zincir altı halkaya çıktığında tablo
 * dörtte kalmış ve metin "Four links are designed" demeye devam etmişti.)
 */
test("README.md: sinyal tablosu hiçbir halkayı atlamıyor (halka başına en az bir env)", () => {
  for (const halka of ZINCIR_HALKALARI) {
    assert.ok(
      halka.envler.some((env) => BELGE_README.includes(env)),
      `README.md halka '${halka.id}' hakkında TEK KELİME etmiyor: env adlarının ` +
        `(${halka.envler.join(", ")}) hiçbiri geçmiyor. Sinyal tablosuna bu halkanın ` +
        `satırını ekle — ve tablo satır sayısını anan cümleyi de birlikte güncelle; ` +
        `okuyucu zincirin kaç halkalı olduğunu README'den öğrenir.`
    );
  }
});
