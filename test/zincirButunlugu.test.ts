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
import { KARAR_SONUCLARI, agKararKaydiOlustur, kararYaz } from "../src/kararGunlugu.js";
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
const BELGE_README_TR = oku("../README.tr.md");
const BELGE_CAMARA = oku("../docs/CAMARA.md");
const BELGE_DEMO = oku("../docs/DEMO.md");
const BIRIM_SYSTEMD = oku("../deploy/aegis.service");
const BELGE_DEPLOY = oku("../deploy/README.md");

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
  const dizin = mkdtempSync(join(tmpdir(), "aegis-zincir-"));
  const dosya = join(dizin, "kararlar.jsonl");
  const onceki = process.env.AEGIS_DECISION_LOG;
  process.env.AEGIS_DECISION_LOG = dosya;
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
    if (onceki === undefined) delete process.env.AEGIS_DECISION_LOG;
    else process.env.AEGIS_DECISION_LOG = onceki;
    rmSync(dizin, { recursive: true, force: true });
  }
});

test("günlük: PENCERELİ halkanın penceresi de hem kayda hem JSONL satırına düşer", () => {
  /**
   * Halka kanalları bekçiliydi, PENCERELER değildi. Alan-alan mutasyonla ölçüldü:
   * `pencereSaat` silindiğinde 2-7 test kızarıyor, `devSwapPencereSaat` ise HEM
   * üretim (agKararKaydiOlustur) HEM yazım (kararYaz) katmanında silindiğinde takım
   * yeşil kalıyordu. Oysa SIM-Swap katmanı kapalıyken 5. halkanın penceresi satırdaki
   * TEK penceredir; düşerse "hangi soru hangi pencereyle soruldu" bilgisi kaybolur ve
   * bunu hiçbir test görmez. Bu döngü, penceresi olan her halka için o boşluğu kapatır.
   */
  const dizin = mkdtempSync(join(tmpdir(), "aegis-pencere-"));
  const dosya = join(dizin, "kararlar.jsonl");
  const onceki = process.env.AEGIS_DECISION_LOG;
  process.env.AEGIS_DECISION_LOG = dosya;
  try {
    const pencereliler = ZINCIR_HALKALARI.filter((h) => h.pencereIzAlani);
    assert.ok(
      pencereliler.length >= 2,
      "kayıtta en az iki pencereli halka (1. ve 5.) beklenir — daha azı, kaydın bayatladığını gösterir"
    );
    for (const halka of pencereliler) {
      /**
       * Nöbetçi değer halka başına FARKLI: iki pencere alanı yanlışlıkla aynı ize
       * bağlansa bile test bunu görebilsin (aynı sayı olsaydı çapraz bağlama sessiz
       * kalırdı — halka kanallarında bu tuzağa bir kez düşülmüştü).
       */
      const nobetci = 100 + ZINCIR_HALKALARI.indexOf(halka);
      const izHam: Record<string, unknown> = { simSwap: "kapali" };
      izHam[halka.izAlani] = "simulasyon";
      izHam[halka.pencereIzAlani as string] = nobetci;
      const ag: AgKarar = { kanit: [], iz: izHam as unknown as AgIz };

      const kayit = agKararKaydiOlustur(`pencere denemesi (${halka.id})`, "high", ag);
      const alan = halka.pencereGunlukAlani as string;
      assert.equal(
        (kayit as unknown as Record<string, unknown>)[alan],
        nobetci,
        `halka '${halka.id}' penceresi KararKaydi'na geçmiyor: agKararKaydiOlustur içinde ` +
          `iz.${String(halka.pencereIzAlani)} → ${alan} ataması eksik. Pencere kaybolursa ` +
          `denetçi sorunun HANGİ geriye bakış aralığıyla sorulduğunu hiç öğrenemez.`
      );

      kararYaz(kayit);
      const satirlar = readFileSync(dosya, "utf8").trim().split("\n");
      const sonSatir = JSON.parse(satirlar[satirlar.length - 1]) as Record<string, unknown>;
      assert.equal(
        sonSatir[alan],
        nobetci,
        `halka '${halka.id}' penceresi KararKaydi'nde var ama JSONL satırına yazılmıyor: ` +
          `kararGunlugu.ts · kararYaz() içindeki JSON.stringify alan listesine '${alan}' eklenmeli.`
      );
    }
  } finally {
    if (onceki === undefined) delete process.env.AEGIS_DECISION_LOG;
    else process.env.AEGIS_DECISION_LOG = onceki;
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
          `/AEGIS_(…)_[A-Z_]+/ desenine halkanın önekini ekle.`
      );
    }
  }
});

/* ── 3b) Growth Brain · BASARI_IZLERI gerçek başarı metinlerine dayanıyor mu? ── */

test("beyin sınıflandırıcısı: her BAŞARI imzası araçların GERÇEK çıktı metninde geçiyor", () => {
  /**
   * uygulama.mjs artık başarıyı yalnız POZİTİF imzayla ilan eder (tanınmayan yanıt
   * 'belirsiz'dir, kalan adımlar iptal). Bu kapalı-arıza kuralının bedeli, imza
   * listesinin bayatlayabilmesidir: sunucunun başarı cümlesi değişirse Growth Brain
   * her adımı doğrulanamamış sayar ve mutlu yol sessizce durur. Uydurma ya da bayat
   * bir imza da aynı kapıdan girer. Bu yüzden her imzanın DÜZ METİN parçaları,
   * araçların kendi kaynaklarında GERÇEKTEN aranır.
   */
  const bas = KAYNAK_BEYIN.indexOf("const BASARI_IZLERI = [");
  assert.notEqual(bas, -1, "BASARI_IZLERI bulunamadı — yeniden adlandırıldıysa bu test de güncellenmeli");
  const son = KAYNAK_BEYIN.indexOf("];", bas);
  assert.notEqual(son, -1, "BASARI_IZLERI dizisi kapanmıyor — kaynak ayrıştırılamadı");

  const ARAC_KAYNAKLARI = oku("../src/tools/write.ts") + "\n" + oku("../src/tools/read.ts");
  let sinanan = 0;
  for (const satir of KAYNAK_BEYIN.slice(bas, son).split(/\r?\n/)) {
    const m = /^\s*\/(.+)\/([a-z]*),\s*(\/\/.*)?$/.exec(satir);
    if (!m) continue;
    // Regex sözdizimini at, geriye kalan düz metin parçalarını kaynakta ara.
    const parcalar = m[1]
      .split(/\\d|\\s|\\w|[\^$+*?|()[\]{}\\]/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 5);
    assert.ok(parcalar.length > 0, `Başarı imzası '/${m[1]}/' hiç düz metin taşımıyor — sınanamaz`);
    for (const parca of parcalar) {
      sinanan++;
      assert.ok(
        ARAC_KAYNAKLARI.includes(parca),
        `Başarı imzası parçası "${parca}" src/tools/{write,read}.ts'te GEÇMİYOR — imza uydurma ` +
          `ya da bayat. Sonucu: Growth Brain gerçek bir başarıyı tanıyamaz, adımı 'belirsiz' ` +
          `damgalar ve kalan adımları iptal eder (kapalı arıza doğru tarafa düşer ama mutlu ` +
          `yol sessizce durur). Aracın bugünkü başarı cümlesiyle güncelle.`
      );
    }
  }
  assert.ok(sinanan >= 5, `yalnız ${sinanan} imza parçası ayrıştırılabildi — ayrıştırma bozulmuş olabilir`);
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
test("README (TR): Türkçe sinyal tablosu da hiçbir halkayı atlamıyor", () => {
  /**
   * İki dilli bir depoda çeviri, sessizce bayatlamanın en kolay yeridir: İngilizce README
   * güncellenir, Türkçesi olduğu gibi kalır. Tam da bu oldu — zincir altı halkaya
   * çıkarken README.tr.md ağ kapısından TEK KELİME etmiyordu ve test rozeti 155'te
   * kalmıştı. Türkçe okuyan (jüri üyesi, hoca, katkıcı) o dosyaya bakar; onun için orada
   * anlatılmayan halka yoktur.
   */
  for (const halka of ZINCIR_HALKALARI) {
    assert.ok(
      halka.envler.some((env) => BELGE_README_TR.includes(env)),
      `README.tr.md halka '${halka.id}' hakkında TEK KELİME etmiyor: env adlarının ` +
        `(${halka.envler.join(", ")}) hiçbiri geçmiyor. İngilizce README güncellenirken ` +
        `Türkçesi geride kalmış — iki sinyal tablosu birlikte güncellenir.`
    );
  }
});

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

/* ── 7) Karar sözlüğü: kodun yazdığı her değer belgelerde var mı? ────────────── */

test("karar sözlüğü: KararSonucu'nun HER değeri .env.example ve DEMO.md'de geçiyor", () => {
  /**
   * Kod dört değer yazıyordu, belgeler üç değer sayıyordu: 'kademeli' hiçbirinde
   * yoktu. Belgedeki sözlüğe bakarak sayaç/uyarı kuran operatörde, kapının YUMUŞADIĞI
   * satırlar hiçbir kovaya girmiyordu — yani izin en çok anlam taşıyan satırları
   * görünmez oluyordu. Sözlük artık çalışma anında okunabilen bir diziden gelir
   * (KARAR_SONUCLARI) ve bu döngü onu belgelere bağlar.
   *
   * Arama TIRNAK/backtick içinde yapılır: düz alt dize araması "ret" için her yerde
   * eşleşirdi (retNedeniKisa, retIsaretleri…) ve sınama sessizce boşa düşerdi.
   */
  assert.ok(KARAR_SONUCLARI.length >= 4, "sözlük daralmış görünüyor — kayıt bayat olabilir");

  /**
   * Arama BELGENİN TAMAMINDA değil, sözlüğü SAYAN satırda yapılır. Fark mutasyonla
   * ölçüldü: değeri sözlük satırından silmek, başka bir cümlede geçtiği için testi
   * yeşil bırakıyordu — oysa operatör kovalarını o sayımdan kurar, serbest metinden
   * değil. Çapa bulunamazsa test SESSİZCE devre dışı kalmaz, orada durur.
   */
  const sozlukSatiri = (ad: string, metin: string, capa: RegExp): string => {
    const satir = metin.split(/\r?\n/).find((s) => capa.test(s));
    assert.ok(satir, `${ad}: karar sözlüğünü sayan satır (${capa}) bulunamadı — test yolu bayatlamış`);
    return satir!;
  };

  const sayimlar: Array<[string, string]> = [
    [".env.example · karar satırı", sozlukSatiri(".env.example", ENV_ORNEK, /^#\s+karar \(/)],
    ["docs/DEMO.md · alan tablosu", sozlukSatiri("docs/DEMO.md", BELGE_DEMO, /^\| `karar` \|/)],
    [
      "docs/DEMO.md · terim sözlüğü",
      sozlukSatiri("docs/DEMO.md", BELGE_DEMO, /decision-log `karar` values/),
    ],
  ];

  for (const [ad, satir] of sayimlar) {
    for (const deger of KARAR_SONUCLARI) {
      assert.match(
        satir,
        new RegExp("[`\"]" + deger + "[`\"]"),
        `Karar değeri '${deger}' ${ad} içinde SAYILMIYOR. Belgedeki sözlüğe göre sayaç ` +
          `ya da uyarı kuran operatörde, o değeri taşıyan satırlar hiçbir kovaya girmez — ` +
          `'kademeli' tam olarak böyle kaçmıştı: kod dördüncü değeri yazıyor, belgeler üç ` +
          `değer sayıyordu, yani kapının yumuşadığı anlar görünmez oluyordu.`
      );
    }
  }
});

/* ── 8) Denetim izi GERÇEKTEN yazılabilir bir yola mı gösteriliyor? ──────────── */

/** systemd biriminin YAZILABİLİR bıraktığı kökler (ProtectSystem=strict altında). */
function yazilabilirKokler(birim: string): string[] {
  const kokler: string[] = [];
  const topla = (anahtar: string, onek: string) => {
    for (const m of birim.matchAll(new RegExp(`^${anahtar}=(.+)$`, "gm"))) {
      for (const yol of m[1].trim().split(/\s+/)) if (yol) kokler.push(onek + yol);
    }
  };
  topla("ReadWritePaths", "");
  // LogsDirectory=X → /var/log/X (systemd dizini oluşturur, sahiplendirir, muaf tutar).
  topla("LogsDirectory", "/var/log/");
  topla("StateDirectory", "/var/lib/");
  return kokler;
}

test("denetim izi: belgelenen AEGIS_DECISION_LOG yolu systemd'de YAZILABİLİR", () => {
  /**
   * Sessiz arızanın tam tarifi: birim ProtectSystem=strict ile koşuyor, yazılabilir
   * tek yol /opt/aegis/data iken .env.example ve DEMO.md /var/log/aegis/… örneği
   * veriyordu. Operatör günlüğü açtığını sanır; her riskli karar kum havuzuna çarpar;
   * günlük KAPI OLMADIĞI için (yazma hatası akışı düşürmez, stderr'e tek satır yazılır)
   * hiçbir şey bozulmaz ve JSONL boş kalır. Eksiklik ancak "geçen ay kaç ret vardı"
   * sorulduğunda — cevabın artık üretilemeyeceği anda — fark edilir.
   */
  const kokler = yazilabilirKokler(BIRIM_SYSTEMD);
  assert.ok(kokler.length > 0, "birimde hiç yazılabilir yol yok — dosya bayatlamış olabilir");

  const yollar: Array<{ kaynak: string; yol: string }> = [];
  for (const [ad, metin] of [
    [".env.example", ENV_ORNEK],
    ["docs/DEMO.md", BELGE_DEMO],
    ["deploy/README.md", BELGE_DEPLOY],
  ] as const) {
    for (const satir of metin.split(/\r?\n/)) {
      /**
       * KAPSAM: yalnız systemd biriminin yönettiği yollar. Konteyner örnekleri
       * (`docker run … -e AEGIS_DECISION_LOG=/data/…`) bilerek dışarıda: orada
       * dosya sistemini bu birim değil, imajın kendi /data bağlaması belirler ve
       * onları buraya katmak, kapsamı dışında bir kural yüzünden yanlış alarm üretirdi.
       */
      if (/docker|^\s*-e\s/i.test(satir)) continue;
      const m = /AEGIS_DECISION_LOG=(\/[^\s`"']+)/.exec(satir);
      if (m) yollar.push({ kaynak: ad, yol: m[1] });
    }
  }
  assert.ok(
    yollar.length >= 2,
    `Belgelerde mutlak yollu AEGIS_DECISION_LOG örneği bulunamadı (${yollar.length}) — ` +
      "örnek kaldırıldıysa bu gözcü sessizce boşa düşer; testi de birlikte güncelle."
  );

  for (const { kaynak, yol } of yollar) {
    assert.ok(
      kokler.some((kok) => yol === kok || yol.startsWith(kok.endsWith("/") ? kok : kok + "/")),
      `${kaynak} '${yol}' yolunu örnek veriyor ama deploy/aegis.service bu yolu ` +
        `YAZILABİLİR bırakmıyor (yazılabilir kökler: ${kokler.join(", ")}). ` +
        `Ya birime LogsDirectory=/ReadWritePaths= satırı ekle, ya da örneği yazılabilir ` +
        `kümenin altına taşı. Aksi hâlde denetim izi ÜRETİMDE sessizce hiç oluşmaz.`
    );
  }
});

test("deploy runbook'u karar günlüğünün kum havuzu tuzağını ANIYOR", () => {
  /**
   * AEGIS_DB için bu uyarı zaten yazılmıştı ("must be an absolute path… which
   * ProtectSystem=strict makes read-only"); denetim izi için hiç yazılmamıştı ve
   * runbook DECISION_LOG'dan tek kelime etmiyordu. Aradaki fark keyfi: ikisi de aynı
   * kum havuzuna çarpar, ama biri servisi çökertip kendini duyurur, diğeri sessizce
   * hiçbir iz bırakmaz — yani sessiz olan, uyarıyı DAHA ÇOK hak eder.
   */
  assert.match(
    BELGE_DEPLOY,
    /AEGIS_DECISION_LOG/,
    "deploy/README.md karar günlüğünden hiç söz etmiyor — operatör onu ancak burada öğrenir"
  );
  assert.match(
    BELGE_DEPLOY,
    /ProtectSystem=strict|LogsDirectory/,
    "runbook, günlüğün yazılabilir yol koşulunu (kum havuzu) açıkça anlatmalı"
  );
});
