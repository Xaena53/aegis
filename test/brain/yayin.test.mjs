// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Yayına alma (--yayinla) testleri — AĞSIZ: cagir sahtedir, gerçek MCP/Anthropic
 * bağlantısı yoktur; sunucu yanıtları write.ts/approval.ts/networkTrust.ts'in
 * BUGÜNKÜ gerçek metinlerinden alınmış fixture'lardır.
 *
 * Kanıtlanan değişmezler:
 *  - yayinaAl başarı yolunu doğru sınıflar ve set_campaign_status'u ENABLED ile,
 *    confirm ANAHTARI OLMADAN çağırır,
 *  - ağ kapısı reddi 'ag-retti' olarak sınıflanır ve ret metni rapora AYNEN geçer;
 *    rapor bunu BAŞARISIZLIK değil, "güvenlik kapısı çalıştı" olarak sunar,
 *  - ağ TEMİZ geçip sunucu doğrulanmış insan onayı istediğinde bu 'ag-retti' diye
 *    YANLIŞ sunulmaz (kanıt satırındaki ADSPILOT_NAC_SIMULATE ipucu yanıltmaz),
 *  - --yayinla yolu DIŞINDA hiçbir yerden ENABLED çağrılmaz (kurulum yolunun kara
 *    listesi aynen durur; growth-brain.mjs'te yayinaAl tek ve korumalı çağrıdır),
 *  - --yayinla, --uygula olmadan Türkçe hatayla reddedilir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  uygula,
  yayinaAl,
  yayinCagirici,
  yayinSonucuSinifla,
  kanitSatirlariniAyikla,
  guvenliCagirici,
  YAYIN_ARACI,
  KARA_LISTE,
} from "../../scripts/brain/uygulama.mjs";
import { raporOlustur } from "../../scripts/brain/rapor.mjs";
import { girdileriDogrula, argumanlariAyristir } from "../../scripts/growth-brain.mjs";

const KOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/* ── Sunucunun gerçek metinleri (fixture) ────────────────────────────────────── */

/** write.ts başarı metni. */
const YAYIN_OK =
  "Kampanya 9002 YAYINDA (ENABLED). Harcama başladı — performansı campaign_performance ile izle.";

/** networkTrust.ts — simüle SIM değişimi reddi (demo act 2/3B'nin vitrin metni). */
const AG_RETTI =
  "Reddedildi [SİMÜLASYON]: AĞ DOĞRULAMASI BAŞARISIZ (SİMÜLE) — onaylayıcının " +
  "(+905*******22) SIM kartı son 72 saat içinde değişmiş SAYILDI " +
  "(ADSPILOT_NAC_SIMULATE=degisti; gerçek ağ sorgusu YAPILMADI). Gerçek akışta bu, hesap ele " +
  "geçirme saldırılarının tipik işaretidir; onay istemi hiç gösterilmedi ve harcama artışı " +
  "uygulanmaz. Kullanıcıya bunun bir SİMÜLASYON olduğunu MUTLAKA bildir.";

/**
 * networkTrust.ts — 5. halka (Device Swap) ve 6. halka (Call Forwarding) retleri.
 *
 * NEDEN AYRI FIXTURE: bu iki halkanın SİMÜLE reti KENDİ başlığını taşır
 * ("CİHAZ DEĞİŞİMİ SAPTANDI" / "ÇAĞRI YÖNLENDİRME AÇIK"), 1. halkanınkini
 * ("AĞ DOĞRULAMASI BAŞARISIZ") değil. Sınıflandırıcı yalnız 1. halkanın metnini
 * tanıdığı sürece bu retler 'ag-retti' yerine 'reddedildi' sayılıyordu: rapor
 * "GÜVENLİK KAPISI ÇALIŞTI" bloğunu basmıyor, ağ kapısının yakaladığı bir ele geçirme
 * girişimi sıradan bir sunucu reddi gibi görünüyordu. Aşağıdaki vakalar tam olarak
 * bunu sabitler.
 */
const DEVSWAP_RETTI_SIM =
  "Reddedildi [SİMÜLASYON]: CİHAZ DEĞİŞİMİ SAPTANDI (SİMÜLE) — onaylayıcının (+905*******22) " +
  "hattı son 72 saat içinde YENİ BİR CİHAZA taşınmış SAYILDI " +
  "(ADSPILOT_DEVICESWAP_SIMULATE=degisti; gerçek ağ sorgusu YAPILMADI). Gerçek akışta bu, SIM " +
  "kartı hiç değişmeden hattın başka bir telefona alınması anlamına gelir — hesap ele " +
  "geçirmenin SIM Swap kontrolüne yakalanmayan biçimidir; onay istemi gösterilmez ve harcama " +
  "artışı uygulanmaz. Kullanıcıya bunun bir SİMÜLASYON olduğunu MUTLAKA bildir.";

const CALLFWD_RETTI_SIM =
  "Reddedildi [SİMÜLASYON]: ÇAĞRI YÖNLENDİRME AÇIK (SİMÜLE) — onaylayıcının (+905*******22) " +
  "hattında koşulsuz çağrı yönlendirme etkin SAYILDI (ADSPILOT_CALLFWD_SIMULATE=acik; gerçek " +
  "ağ sorgusu YAPILMADI). Gerçek akışta bu, hattın doğrulama çağrılarının başka bir numaraya " +
  "aktarıldığı anlamına gelir — OTP/sesli doğrulama ele geçirmenin klasik yolu; onay istemi " +
  "gösterilmez ve harcama artışı uygulanmaz. Kullanıcıya bunun bir SİMÜLASYON olduğunu " +
  "MUTLAKA bildir.";

/** 5. halkanın GERÇEK kanal reti — başlığı 1. halkayla ortaktır. */
const DEVSWAP_RETTI_GERCEK =
  "Reddedildi: AĞ DOĞRULAMASI BAŞARISIZ — onaylayıcının (+905*******22) hattı son 72 " +
  "saat içinde YENİ BİR CİHAZA taşınmış (GSMA Open Gateway Device Swap). Bu, SIM kartı hiç " +
  "değişmeden hattın başka bir telefona alınması demektir ve hesap ele geçirmenin SIM Swap " +
  "kontrolüne yakalanmayan biçimidir; onay istemi hiç gösterilmedi ve harcama artışı " +
  "uygulanmaz. Hesap sahibi durumu doğrulayana kadar tekrar deneme.";

/** 6. halkanın GERÇEK kanal reti. */
const CALLFWD_RETTI_GERCEK =
  "Reddedildi: AĞ DOĞRULAMASI BAŞARISIZ — onaylayıcının (+905*******22) hattında KOŞULSUZ ÇAĞRI " +
  "YÖNLENDİRME açık (GSMA Open Gateway Call Forwarding Signal). Hattın doğrulama çağrıları " +
  "başka bir numaraya aktarılıyor olabilir; bu, OTP/sesli doğrulama ele geçirmenin klasik " +
  "yoludur. Onay istemi hiç gösterilmedi ve harcama artışı uygulanmaz. Hesap sahibi " +
  "yönlendirmeyi kaldırıp durumu doğrulayana kadar tekrar deneme.";

/**
 * 5. ve 6. halkanın YAPILANDIRMA retleri: metinleri env adından başka hiçbir ağ izi
 * taşımaz, dolayısıyla yalnız env deseni yakalayabilir (DEVICESWAP|CALLFWD önekleri
 * desende yokken bu retler de sınıflandırıcının dışında kalıyordu).
 */
const DEVSWAP_CELISKI =
  "Reddedildi [SİMÜLASYON]: ADSPILOT_DEVICESWAP_CHECK açık (gerçek cihaz değişimi sorgusu) ve " +
  "ADSPILOT_DEVICESWAP_SIMULATE birlikte tanımlı — çelişkili yapılandırma. Gerçek sorgu " +
  "isteniyorsa simülasyon kaldırılmalı, demo isteniyorsa ADSPILOT_DEVICESWAP_CHECK kapatılmalı. " +
  "Güvenlik gereği belirsiz yapılandırmada harcama artışı uygulanmaz.";

const CALLFWD_DEGER_TANIMSIZ =
  "Reddedildi [SİMÜLASYON]: ADSPILOT_CALLFWD_SIMULATE değeri tanınmadı (değer, sır ihtimaline " +
  'karşı burada gösterilmez) — geçerli değerler "kapali" | "acik". Güvenlik gereği ' +
  "anlaşılamayan yapılandırmada harcama artışı uygulanmaz (kapalı arıza).";

/** approval.ts — ağ TEMİZ geçti, elicitation yok, confirm yok: onay kapısı reddi. */
const INSAN_ONAYI = [
  'Reddedildi: "GB-20260828-1200 — Deneme" kampanyası YAYINA ALINACAK — bu andan itibaren gerçek para harcanır.',
  "  • Hesap: 1234567890 · Kampanya: 9002",
  "  • Günlük bütçe: 40 (hesabın para biriminde; Google günlük bütçenin katlarını harcayabilir)",
  "  • Coğrafi hedef: 1 konum",
  "  • Ağ doğrulaması [SİMÜLASYON]: SIM değişimi yok (son 72 saat, +905*******22) — simüle kanal " +
    "(ADSPILOT_NAC_SIMULATE=temiz), gerçek ağ sorgusu YAPILMADI",
  "Kullanıcıya bu özeti göster ve açık onayını al; onay geldiyse confirm=true ile tekrar çağır.",
].join("\n");

/** write.ts — bütçe tavanı reddi (ağ kapısına hiç ulaşmaz). */
const BUTCE_RETTI =
  'Reddedildi: "Deneme" kampanyasının günlük bütçesi 900 — hesabın günlük bütçe tavanı 500.';

/* write.ts create_search_campaign gerçek çıktısı (kurulum yolu testi için). */
const CREATE_OK = [
  "Kampanya PAUSED olarak oluşturuldu (2 anahtar kelime, günlük bütçe 40, hedef: TR).",
  "Oluşan kaynaklar:",
  "customers/1234567890/campaignBudgets/9001",
  "customers/1234567890/campaigns/9002",
  "customers/1234567890/adGroups/9003",
].join("\n");

/** Sahte cagir: her çağrının araç adını ve argümanlarını kaydeder. */
function sahteCagir(cevaplar = {}) {
  const cagrilar = [];
  const fn = async (arac, args) => {
    cagrilar.push({ arac, args });
    const ozel = cevaplar[arac];
    if (typeof ozel === "function") return ozel(args);
    if (ozel !== undefined) return ozel;
    if (arac === "run_gaql") return "0 satır (0 gösteriliyor):\n[]";
    if (arac === "create_search_campaign") return CREATE_OK;
    if (arac === "add_campaign_negative_keywords") return "2 negatif anahtar kelime eklendi [PHRASE].";
    if (arac === "create_responsive_search_ad")
      return "RSA oluşturuldu: customers/1234567890/adGroupAds/9003~7001";
    if (arac === "set_campaign_status") return YAYIN_OK;
    return "(boş yanıt)";
  };
  fn.cagrilar = cagrilar;
  return fn;
}

function kurulumGirdisi() {
  return {
    plan: {
      kampanyaAdi: "Deneme Kampanyası",
      hedefUlke: "TR",
      dil: "tr",
      butceGunlukTL: 40,
      adGruplari: [{ ad: "Grup 1", anahtarKelimeler: ["koşu ayakkabısı"], eslesmeTipi: "PHRASE" }],
      negatifKelimeler: ["ücretsiz"],
    },
    kreatif: {
      basliklar: ["Koşu Ayakkabısı", "Hızlı Kargo", "Uygun Fiyat"],
      aciklamalar: ["Yeni sezon koşu ayakkabıları burada.", "Bugün sipariş ver, yarın kapında."],
    },
    musteriId: "1234567890",
    finalUrl: "https://ornek-magaza.example/kosu",
  };
}

/* ── 1) Başarı yolu ──────────────────────────────────────────────────────────── */

test("yayinaAl başarı yolu: ENABLED çağrılır, sonuç 'basarili' sınıflanır", async () => {
  const cagir = sahteCagir();
  const sonuc = await yayinaAl({ kampanyaId: "9002", musteriId: "1234567890" }, { cagir });

  assert.equal(sonuc.denendi, true);
  assert.equal(sonuc.durum, "basarili");
  assert.equal(sonuc.kampanyaId, "9002");
  assert.ok(sonuc.sonucMetni.includes("YAYINDA (ENABLED)"));

  assert.deepEqual(cagir.cagrilar.map((c) => c.arac), [YAYIN_ARACI]);
  assert.deepEqual(cagir.cagrilar[0].args, {
    customerId: "1234567890",
    campaignId: "9002",
    status: "ENABLED",
  });
  assert.ok(!("confirm" in cagir.cagrilar[0].args), "yayın çağrısında confirm olmamalı");
});

test("yayinaAl kampanyaId'yi doğrular: harf/boş/uydurma ID reddedilir", async () => {
  const cagir = sahteCagir();
  for (const kotu of ["9002abc", "", "  ", "en-yeni-kampanya"]) {
    await assert.rejects(
      () => yayinaAl({ kampanyaId: kotu, musteriId: "1234567890" }, { cagir }),
      /kampanyaId/
    );
  }
  await assert.rejects(
    () => yayinaAl({ kampanyaId: "9002", musteriId: "hesap" }, { cagir }),
    /musteriId yalnız rakam/
  );
  assert.equal(cagir.cagrilar.length, 0, "doğrulama düşerken sunucuya hiç çağrı gitmemeli");
});

/* ── 2) Ağ reti yolu — demonun vitrin anı ────────────────────────────────────── */

test("ağ kapısı reddi 'ag-retti' sınıflanır ve ret metni AYNEN taşınır", async () => {
  const cagir = sahteCagir({ set_campaign_status: AG_RETTI });
  const sonuc = await yayinaAl({ kampanyaId: "9002", musteriId: "1234567890" }, { cagir });

  assert.equal(sonuc.durum, "ag-retti");
  assert.equal(sonuc.sonucMetni, AG_RETTI, "ret metni özetlenmeden/yumuşatılmadan taşınmalı");
});

test("ağ reti rapora geçer ve BAŞARISIZLIK değil 'güvenlik kapısı çalıştı' olarak sunulur", async () => {
  const cagir = sahteCagir({ set_campaign_status: AG_RETTI });
  const yayinSonucu = await yayinaAl({ kampanyaId: "9002", musteriId: "1234567890" }, { cagir });
  const rapor = raporOlustur({ hedef: "test", kuruMod: false, yayinSonucu });

  assert.ok(rapor.includes("## Yayına Alma Denemesi"));
  assert.ok(rapor.includes("AĞ KAPISI REDDETTİ"));
  assert.ok(rapor.includes("GÜVENLİK KAPISI ÇALIŞTI"));
  assert.ok(rapor.includes("BU BİR BAŞARISIZLIK DEĞİLDİR"));
  // ret metninin özü rapora düşmüş olmalı (markdown kaçışı dışında birebir)
  assert.ok(rapor.includes("AĞ DOĞRULAMASI BAŞARISIZ"));
  assert.ok(rapor.includes("SIM kartı son 72 saat içinde değişmiş SAYILDI"));
  assert.ok(rapor.includes("Kullanıcıya bunun bir SİMÜLASYON olduğunu MUTLAKA bildir."));
  // ret hâlinde kampanya PAUSED kalır — güvenlik bölümü bunu söylemeli
  assert.ok(rapor.includes("Kampanya DURAKLATILMIŞ (PAUSED)"));
});

test("ağ TEMİZ geçip onay kapısı reddettiğinde 'ag-retti' diye YANLIŞ sunulmaz", async () => {
  const cagir = sahteCagir({ set_campaign_status: INSAN_ONAYI });
  const yayinSonucu = await yayinaAl({ kampanyaId: "9002", musteriId: "1234567890" }, { cagir });

  assert.equal(yayinSonucu.durum, "insan-onayi-gerekli");
  // ağ kanıtı kaybolmaz: onay özetinin madde satırları kanıt olarak taşınır
  assert.ok(yayinSonucu.kanitSatirlari.some((k) => k.includes("SIM değişimi yok")));

  const rapor = raporOlustur({ hedef: "test", kuruMod: false, yayinSonucu });
  assert.ok(rapor.includes("DOĞRULANMIŞ İNSAN ONAYI GEREKTİ"));
  assert.ok(!rapor.includes("AĞ KAPISI REDDETTİ"));
  assert.ok(rapor.includes("Kanıt satırları"));
});

test("başarı raporu gerçek harcamayı ilan eder, PAUSED yalanı söylemez", async () => {
  const cagir = sahteCagir();
  const yayinSonucu = await yayinaAl({ kampanyaId: "9002", musteriId: "1234567890" }, { cagir });
  const rapor = raporOlustur({ hedef: "test", kuruMod: false, yayinSonucu });
  assert.ok(rapor.includes("YAYINA ALINDI (ENABLED)"));
  assert.ok(rapor.includes("GERÇEK HARCAMA BAŞLADI"));
  assert.ok(!rapor.includes("Kampanya DURAKLATILMIŞ (PAUSED) durumda"));
});

test("yayinSonucu verilmezse 'Yayına Alma Denemesi' bölümü HİÇ oluşmaz", () => {
  assert.ok(!raporOlustur({ hedef: "x" }).includes("Yayına Alma Denemesi"));
});

test("sınıflandırıcı: bütçe reddi ve araç hatası ağ retine sayılmaz", async () => {
  assert.equal(yayinSonucuSinifla(BUTCE_RETTI), "reddedildi");
  assert.equal(yayinSonucuSinifla("Kampanya bulunamadı: 9002"), "reddedildi");
  assert.equal(yayinSonucuSinifla("Yazma araçları bu hesap için devre dışı."), "reddedildi");
  assert.equal(yayinSonucuSinifla(""), "hata");
  assert.equal(yayinSonucuSinifla("(boş yanıt)"), "hata");
  assert.equal(yayinSonucuSinifla(YAYIN_OK), "basarili");
  assert.equal(yayinSonucuSinifla(AG_RETTI), "ag-retti");
  assert.equal(yayinSonucuSinifla(INSAN_ONAYI), "insan-onayi-gerekli");
  // approval.ts'in ağ-ayarı-eksik reddi de ağ kapısı sayılır (fail-closed dalı)
  assert.equal(
    yayinSonucuSinifla(
      "Reddedildi: bu işlem risk etiketli ama ağ doğrulama yapılandırması onay kapısına ulaşmadı (agAyar eksik — sunucu tarafı hata)."
    ),
    "ag-retti"
  );
});

/* ── 2b) 5. ve 6. halka: kendi başlıklarıyla reddederler ─────────────────────── */

test("sınıflandırıcı: 5. halka (Device Swap) reti — SİMÜLE ve GERÇEK, ikisi de 'ag-retti'", () => {
  assert.equal(
    yayinSonucuSinifla(DEVSWAP_RETTI_SIM),
    "ag-retti",
    "'CİHAZ DEĞİŞİMİ SAPTANDI' başlığı AG_KAPISI_IZLERI'nde tanınmalı; tanınmazsa " +
      "ağ kapısının yakaladığı cihaz-devralma sıradan sunucu reddi gibi raporlanır"
  );
  assert.equal(yayinSonucuSinifla(DEVSWAP_RETTI_GERCEK), "ag-retti");
});

test("sınıflandırıcı: 6. halka (Call Forwarding) reti — SİMÜLE ve GERÇEK, ikisi de 'ag-retti'", () => {
  assert.equal(
    yayinSonucuSinifla(CALLFWD_RETTI_SIM),
    "ag-retti",
    "'ÇAĞRI YÖNLENDİRME AÇIK' başlığı AG_KAPISI_IZLERI'nde tanınmalı"
  );
  assert.equal(yayinSonucuSinifla(CALLFWD_RETTI_GERCEK), "ag-retti");
});

test("sınıflandırıcı: 5./6. halkanın YAPILANDIRMA retleri de ağ kapısı sayılır", () => {
  // Bu iki metnin taşıdığı tek ağ izi env adıdır: env deseni DEVICESWAP|CALLFWD
  // öneklerini kapsamazsa ikisi de 'reddedildi' olur.
  assert.equal(yayinSonucuSinifla(DEVSWAP_CELISKI), "ag-retti");
  assert.equal(yayinSonucuSinifla(CALLFWD_DEGER_TANIMSIZ), "ag-retti");
});

test("5. halka reti rapora 'GÜVENLİK KAPISI ÇALIŞTI' olarak geçer, metni AYNEN taşınır", async () => {
  const cagir = sahteCagir({ set_campaign_status: DEVSWAP_RETTI_SIM });
  const yayinSonucu = await yayinaAl({ kampanyaId: "9002", musteriId: "1234567890" }, { cagir });

  assert.equal(yayinSonucu.durum, "ag-retti");
  assert.equal(yayinSonucu.sonucMetni, DEVSWAP_RETTI_SIM);

  const rapor = raporOlustur({ hedef: "test", kuruMod: false, yayinSonucu });
  assert.ok(rapor.includes("AĞ KAPISI REDDETTİ"));
  assert.ok(rapor.includes("GÜVENLİK KAPISI ÇALIŞTI"));
  assert.ok(rapor.includes("BU BİR BAŞARISIZLIK DEĞİLDİR"));
  assert.ok(rapor.includes("CİHAZ DEĞİŞİMİ SAPTANDI"));
  // 5. halka SIM-Swap'tan AYRI bir şey söyler; rapor o ayrımı kaybetmemeli
  assert.ok(rapor.includes("YENİ BİR CİHAZA taşınmış SAYILDI"));
  assert.ok(rapor.includes("Kampanya DURAKLATILMIŞ (PAUSED)"));
});

test("6. halka reti rapora 'GÜVENLİK KAPISI ÇALIŞTI' olarak geçer, metni AYNEN taşınır", async () => {
  const cagir = sahteCagir({ set_campaign_status: CALLFWD_RETTI_SIM });
  const yayinSonucu = await yayinaAl({ kampanyaId: "9002", musteriId: "1234567890" }, { cagir });

  assert.equal(yayinSonucu.durum, "ag-retti");
  assert.equal(yayinSonucu.sonucMetni, CALLFWD_RETTI_SIM);

  const rapor = raporOlustur({ hedef: "test", kuruMod: false, yayinSonucu });
  assert.ok(rapor.includes("AĞ KAPISI REDDETTİ"));
  assert.ok(rapor.includes("GÜVENLİK KAPISI ÇALIŞTI"));
  assert.ok(rapor.includes("ÇAĞRI YÖNLENDİRME AÇIK"));
  assert.ok(rapor.includes("OTP/sesli doğrulama ele geçirmenin klasik yolu"));
  assert.ok(rapor.includes("Kampanya DURAKLATILMIŞ (PAUSED)"));
});

test("cagir fırlatırsa 'hata' sınıflanır, fonksiyon fırlatmaz", async () => {
  const cagir = sahteCagir({
    set_campaign_status: () => {
      throw new Error("bağlantı koptu");
    },
  });
  const sonuc = await yayinaAl({ kampanyaId: "9002", musteriId: "1234567890" }, { cagir });
  assert.equal(sonuc.durum, "hata");
  assert.match(sonuc.sonucMetni, /Araç hatası/);
  const rapor = raporOlustur({ hedef: "test", yayinSonucu: sonuc });
  assert.ok(rapor.includes("YAYIN DENEMESİ SONUÇSUZ"));
});

test("kanitSatirlariniAyikla: madde satırlarını alır, gövdeyi almaz", () => {
  assert.deepEqual(kanitSatirlariniAyikla(AG_RETTI), []);
  const kanitlar = kanitSatirlariniAyikla(INSAN_ONAYI);
  assert.equal(kanitlar.length, 4);
  assert.ok(kanitlar[0].startsWith("Hesap:"));
});

/* ── 3) --yayinla DIŞINDA hiçbir yerden ENABLED yok ──────────────────────────── */

test("GÜVENLİK: kurulum yolu (uygula) hiçbir koşulda set_campaign_status çağırmaz", async () => {
  const cagir = sahteCagir();
  await uygula(kurulumGirdisi(), { cagir });
  assert.ok(cagir.cagrilar.length >= 4);
  for (const { arac, args } of cagir.cagrilar) {
    assert.ok(!KARA_LISTE.includes(arac), `${arac} kurulum yolundan çağrılmamalıydı`);
    assert.notEqual(args?.status, "ENABLED", `${arac} çağrısı ENABLED taşımamalı`);
  }
});

test("GÜVENLİK: kurulum sarmalayıcısının kara listesi AYNEN duruyor", async () => {
  const cagir = sahteCagir();
  const guvenli = guvenliCagirici(cagir);
  await assert.rejects(
    () => guvenli("set_campaign_status", { status: "ENABLED" }),
    /kalıcı olarak yasak/
  );
  await assert.rejects(
    () => guvenli("update_campaign_budget", { newDailyBudget: 10000 }),
    /kalıcı olarak yasak/
  );
  assert.equal(cagir.cagrilar.length, 0);
});

test("GÜVENLİK: yayın sarmalayıcısı tek araç + tek statü taşır, confirm'i siler", async () => {
  const cagir = sahteCagir();
  const yayinCagir = yayinCagirici(cagir);

  await assert.rejects(
    () => yayinCagir("update_campaign_budget", { status: "ENABLED" }),
    /yalnız 'set_campaign_status' aracını taşır/
  );
  await assert.rejects(
    () => yayinCagir("create_search_campaign", { status: "ENABLED" }),
    /yalnız 'set_campaign_status' aracını taşır/
  );
  await assert.rejects(
    () => yayinCagir(YAYIN_ARACI, { status: "PAUSED" }),
    /yalnız status='ENABLED'/
  );
  await assert.rejects(() => yayinCagir(YAYIN_ARACI, {}), /yalnız status='ENABLED'/);
  assert.equal(cagir.cagrilar.length, 0, "reddedilen çağrılar sunucuya ulaşmamalı");

  await yayinCagir(YAYIN_ARACI, { customerId: "1", campaignId: "2", status: "ENABLED", confirm: true });
  assert.ok(!("confirm" in cagir.cagrilar[0].args));
  assert.equal(cagir.cagrilar[0].args.status, "ENABLED");

  assert.throws(() => yayinCagirici(undefined), /'cagir' fonksiyonu zorunlu/);
});

test("GÜVENLİK: growth-brain.mjs'te yayinaAl YALNIZ --yayinla dalının içinde çağrılır", () => {
  const kaynak = readFileSync(join(KOK, "scripts", "growth-brain.mjs"), "utf8");
  const dalIndeksi = kaynak.indexOf("if (girdi.yayinla) {");
  assert.ok(dalIndeksi > 0, "--yayinla dalı bulunmalı");

  // Tek çağrı noktası ve tek import — ikisi de dalın İÇİNDE (yorumlar eşleşmez).
  const cagrilar = [...kaynak.matchAll(/\bawait yayinaAl\s*\(/g)];
  assert.equal(cagrilar.length, 1, "yayinaAl kaynakta tam olarak bir kez çağrılmalı");
  assert.ok(cagrilar[0].index > dalIndeksi, "tek çağrı --yayinla dalının İÇİNDE olmalı");

  const importlar = [...kaynak.matchAll(/\{\s*yayinaAl\s*\}\s*=\s*await import\(/g)];
  assert.equal(importlar.length, 1, "yayinaAl yalnız bir kez import edilmeli");
  assert.ok(importlar[0].index > dalIndeksi, "import da --yayinla dalının İÇİNDE olmalı");

  // ENABLED sabiti CLI'de elle kurulmamalı — statü uygulama.mjs içinde belirlenir.
  assert.ok(!/["']ENABLED["']/.test(kaynak), "CLI ENABLED sabitini kendisi kurmamalı");
});

/* ── 4) Bayrak doğrulaması ───────────────────────────────────────────────────── */

test("--yayinla, --uygula olmadan Türkçe hatayla reddedilir", () => {
  const args = argumanlariAyristir([
    "--hedef", "x",
    "--url", "https://example.com",
    "--butce", "50",
    "--musteri", "1",
    "--yayinla",
  ]);
  assert.equal(args.yayinla, true);
  assert.equal(args.uygula, false);
  assert.throws(
    () => girdileriDogrula(args),
    /--yayinla yalnız --uygula ile birlikte kullanılabilir/
  );
});

test("--uygula --yayinla birlikte geçerli; --yayinla'sız koşuda bayrak false kalır", () => {
  const ikisi = girdileriDogrula(
    argumanlariAyristir([
      "--hedef", "x",
      "--url", "https://example.com",
      "--butce", "50",
      "--musteri", "1234567890",
      "--uygula",
      "--yayinla",
    ])
  );
  assert.equal(ikisi.uygula, true);
  assert.equal(ikisi.yayinla, true);

  const yalnizUygula = girdileriDogrula(
    argumanlariAyristir([
      "--hedef", "x",
      "--url", "https://example.com",
      "--butce", "50",
      "--musteri", "1234567890",
      "--uygula",
    ])
  );
  assert.equal(yalnizUygula.yayinla, false);
});

test("bayrak hatası, eksik argüman hatasından ÖNCE gelir (en spesifik hata kazanır)", () => {
  assert.throws(
    () => girdileriDogrula({ yayinla: true }),
    /--yayinla yalnız --uygula ile birlikte kullanılabilir/
  );
});

/**
 * SINIFLANDIRICI SIRASI — raporun doğruluğu buna bağlı.
 *
 * `yayinSonucuSinifla` yalnız bir etiket üretmiyor: üç-perde raporu bu etikete bakarak
 * ya "⚠ KAMPANYA YAYINDA — GERÇEK HARCAMA BAŞLADI" ya da "GÜVENLİK KAPISI ÇALIŞTI"
 * basıyor. Yanlış sıralama, kapının çalıştığı anı kapının çalışmadığı an gibi
 * gösterir — bir güvenlik ürününde bundan kötü bir hata yoktur.
 *
 * Mutasyonla ölçüldü: bu iki test yazılmadan önce sıra ikiye de çevrilebiliyor ve
 * takım 556/556 yeşil kalıyordu.
 */
test("KRİTİK SIRA: içinde başarı imzası GEÇEN bir ret, başarı sayılamaz", () => {
  /**
   * Bu metin uydurma değil: ret özetine kampanya ADI giriyor ve adı MODEL seçiyor.
   * "YAYINDA (ENABLED)" ifadesini adının içine koyan bir model, başarı imzası önce
   * sınandığında kendi reddini başarı diye raporlatabilirdi.
   */
  const ret =
    'Reddedildi: "Yaz Kampanyası YAYINDA (ENABLED)" kampanyasının günlük bütçesi 900 — hesap tavanı 500.';
  assert.equal(
    yayinSonucuSinifla(ret),
    "reddedildi",
    "ret her zaman başarıyı yener: aksi hâlde rapor gerçek harcama başladı der"
  );
});

test("KRİTİK SIRA: temiz ağ geçişinin kanıtları, insan kapısı retini 'ag-retti' yapmaz", () => {
  /**
   * Ret türlerinin birbirine göre sırası (insan → ağ) da korunmalı: ağ kapısı TEMİZ
   * geçtiğinde kanıt satırları onay kapısının ret metnine madde olarak ekleniyor.
   * Bu test o sırayı sabitler, böylece başarı imzası düzeltmesi onu bozamaz.
   */
  const insanReti = [
    "İşlem yapılmadı: kullanıcı onayı alınamadı.",
    "• AĞ DOĞRULAMASI BAŞARISIZ ifadesi bu satırda yalnızca KANIT olarak geçiyor",
  ].join("\n");
  assert.equal(
    yayinSonucuSinifla(insanReti),
    "insan-onayi-gerekli",
    "madde satırlarındaki kanıt metni ağ reddi gibi okunmamalı"
  );
});

test("gerçek başarı hâlâ başarı sayılır — sıra düzeltmesi kapıyı duvara çevirmedi", () => {
  assert.equal(
    yayinSonucuSinifla('Kampanya "Yaz" durumu: YAYINDA (ENABLED). Gerçek harcama başladı.'),
    "basarili"
  );
});


/* ── Model tarafından seçilen kampanya adı sınıflandırmayı YÖNLENDİREMEZ ───────
 *
 * Sunucu ret metinlerine kampanya adını koyar ve o adı MODEL üretir. Ad, sınıflandırma
 * desenlerine yem olduğunda rapor HİÇ ÇALIŞMAMIŞ bir CAMARA kapısı için "GÜVENLİK KAPISI
 * ÇALIŞTI" basar. Demoda bu, kapının çalıştığını kanıtlaması gereken anın uydurulabilir
 * olması demektir.
 */

test("KRİTİK: kampanya adı sıradan bir reddi 'ağ reddetti' gibi gösteremez", () => {
  const kotuAd = "Yaz Kampanyası AĞ DOĞRULAMASI BAŞARISIZ";
  const ret =
    `Reddedildi: "${kotuAd}" kampanyası içinde yayınlanabilir (ENABLED reklam grubunda ` +
    `ENABLED) reklam yok — yayına alınsa da gösterim yapamaz.`;

  assert.equal(
    yayinSonucuSinifla(ret, kotuAd),
    "reddedildi",
    "ad çıkarıldığında bu sıradan bir sunucu reddidir"
  );
  // Adı vermeyen çağrı hâlâ kanabilir; bu iddia düzeltmenin GEREKLİ olduğunu gösterir.
  assert.equal(
    yayinSonucuSinifla(ret),
    "ag-retti",
    "ad geçilmediğinde eski davranış sürer — bu yüzden geçilmesi şart"
  );
});

test("KRİTİK: kampanya adı env değişkeni taklit ederek ağ kapısı uyduramaz", () => {
  const kotuAd = "Kampanya ADSPILOT_NAC_SIMULATE=degisti";
  const ret = `Reddedildi: "${kotuAd}" kampanyasının günlük bütçesi 900 — hesap güvenlik tavanının (500) üstünde.`;
  assert.equal(yayinSonucuSinifla(ret, kotuAd), "reddedildi", "bu bir bütçe reddidir, ağ reddi değil");
});

test("KRİTİK: kampanya adı BAŞARI uyduramaz", () => {
  const kotuAd = "Kampanya YAYINDA (ENABLED)";
  const ret = `Reddedildi: "${kotuAd}" kampanyası bulunamadı.`;
  assert.equal(yayinSonucuSinifla(ret, kotuAd), "reddedildi", "ret her zaman başarıyı yener");
});

test("Ad çıkarma GERÇEK ağ reddini bozmaz", () => {
  /**
   * Düzeltmeyi "her şeyi reddedildi say" hâline getirerek testi yeşile boyamak mümkün
   * olmasın diye: adı masum olan gerçek bir ağ reddi hâlâ 'ag-retti' olmalı.
   */
  const ad = "Yaz Kampanyası";
  const ret =
    `Reddedildi: AĞ DOĞRULAMASI BAŞARISIZ — onaylayıcının (+9055*) SIM kartı son 72 saat ` +
    `içinde değişmiş. "${ad}" kampanyası yayına alınmadı.`;
  assert.equal(yayinSonucuSinifla(ret, ad), "ag-retti", "gerçek ağ reddi sınıfını korumalı");
});

test("Ad çıkarma GERÇEK başarıyı bozmaz", () => {
  const ad = "Yaz Kampanyası";
  assert.equal(
    yayinSonucuSinifla(`Kampanya 123 YAYINDA (ENABLED). Harcama başladı.`, ad),
    "basarili"
  );
});
