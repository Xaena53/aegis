// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 3 — scripts/brain/uygulama.mjs gerileme gözcüleri.
 *
 * Üç bulgu, üç gözcü. Hepsi ölçülmüş bir kırmızıya dayanıyor; hiçbiri "her koşulda yeşil"
 * değil:
 *
 *  1) İDEMPOTENLİK DAMGASI. run_gaql yanıtı `^\d+ satır` kalıbına uymadığında adım
 *     'tamam' damgalanıyordu — modül aynı satırda "sonucu çözümlenemedi" uyarısını
 *     basarken. Ölçülen kırmızı: fix geri alındığında damga yine 'tamam' olur ve
 *     rapor tabloya TAMAM yazar.
 *
 *  2) KIRPMA İŞARETİ TEK KAYNAK. İşaret ortak.mjs'te ÜRETİLİYOR, uygulama.mjs'te elle
 *     KOPYALANMIŞTI. Gözcü sürüklenmeyi gerçekten kurar: modülün BİREBİR kopyası, işareti
 *     DEĞİŞTİRİLMİŞ bir üretici ile aynı geçici dizine konur ve oradan içe aktarılır.
 *     Kopya-literal geri gelirse bu koşum kırmızı olur — ki fix'ten önce ölçülen tam
 *     olarak buydu: kirpik=false, adım 'tamam', kalan adımlar İPTAL EDİLMEDİ.
 *
 *  3) AĞ KANITI BELGESİ. Yorumlar "ağ kapısı temiz geçtiğinde kanıt satırları onay
 *     kapısının ret metnine eklenir" diyordu; approval.ts bunu artık yapmıyor. Gözcü ÇİFT
 *     YÖNLÜ: yorum bayatlarsa (düzeltme geri alınırsa) kırmızı, kod değişirse — biri
 *     `ag.kanit`'i ajanın gördüğü kanala geri bağlarsa — yine kırmızı.
 *
 * AĞSIZ ve YAZMASIZ: `cagir` sahtedir, gerçek MCP/Google/CAMARA bağlantısı yoktur. Geçici
 * dosyalar sistem geçici dizinine açılır, depoya değil, ve koşum sonunda silinir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { uygula, kanitSatirlariniAyikla } from "../scripts/brain/uygulama.mjs";
import { KIRPMA_ISARETI } from "../scripts/brain/ortak.mjs";
import { raporOlustur } from "../scripts/brain/rapor.mjs";

const KOK = join(dirname(fileURLToPath(import.meta.url)), "..");
const UYGULAMA_YOLU = join(KOK, "scripts", "brain", "uygulama.mjs");
const APPROVAL_YOLU = join(KOK, "src", "approval.ts");

/* ── Ortak tezgâh ────────────────────────────────────────────────────────────── */

/** write.ts'in create_search_campaign için BUGÜNKÜ gerçek başarı metni. */
const CREATE_OK = [
  "Kampanya PAUSED olarak oluşturuldu (2 anahtar kelime, günlük bütçe 40, hedef: TR).",
  "Oluşan kaynaklar:",
  "customers/1234567890/campaignBudgets/9001",
  "customers/1234567890/campaigns/9002",
  "customers/1234567890/adGroups/9003",
].join("\n");

function ornekGirdi() {
  return {
    plan: {
      kampanyaAdi: "Deneme",
      butceGunlukTL: 40,
      hedefUlke: "TR",
      adGruplari: [{ ad: "Grup", anahtarKelimeler: ["kırmızı ayakkabı", "spor ayakkabı"] }],
    },
    kreatif: { basliklar: ["Başlık bir", "Başlık iki", "Başlık üç"], aciklamalar: ["Açıklama bir", "Açıklama iki"] },
    musteriId: "1234567890",
    finalUrl: "https://ornek.example/",
  };
}

/** Sahte `cagir`: run_gaql yanıtı vakaya göre verilir, yazma araçları gerçek metinleri döner. */
function sahteCagir(gaqlYaniti, ekstra = {}) {
  const cagrilar = [];
  const fn = async (arac) => {
    cagrilar.push(arac);
    if (arac === "run_gaql") return gaqlYaniti;
    if (ekstra[arac] !== undefined) return ekstra[arac];
    if (arac === "create_search_campaign") return CREATE_OK;
    if (arac === "add_keywords") return "2 anahtar kelime eklendi [EXACT].";
    if (arac === "add_campaign_negative_keywords") return "2 negatif anahtar kelime KAMPANYA seviyesinde eklendi [PHRASE].";
    return "RSA oluşturuldu: customers/1234567890/adGroupAds/9003~7001";
  };
  fn.cagrilar = cagrilar;
  return fn;
}

const idempotenlikAdimi = (sonuc) => sonuc.adimlar.find((a) => a.arac === "run_gaql");

/* ── BULGU 1 · idempotenlik damgası ──────────────────────────────────────────── */

/**
 * ÜÇ ÇÖZÜLEMEYEN ŞEKİL, TEK KURAL. "(boş yanıt)" cagirSarmala'nın boş metin bloğu için
 * ürettiği gerçek dizedir; diğer ikisi read.ts'in çıktı biçiminin kayması hâlidir. Üçünde
 * de satır sayısı OKUNAMAZ, yani aynı adlı kampanya olup olmadığı BİLİNMEZ.
 */
for (const cozulemeyen of ["(boş yanıt)", "Sonuç yok.", "İşlem tamamlandı"]) {
  test(`idempotenlik: çözümlenemeyen run_gaql yanıtı '${cozulemeyen}' TAMAM damgalanmaz`, async () => {
    const cagir = sahteCagir(cozulemeyen);
    const sonuc = await uygula(ornekGirdi(), { cagir });
    const adim = idempotenlikAdimi(sonuc);

    assert.equal(adim.durum, "belirsiz", "okunamayan kontrol 'tamam' damgalanamaz — bilinmeyen 0 değildir");
    assert.notEqual(adim.durum, "tamam");
    assert.ok(
      sonuc.uyarilar.some((u) => u.includes("çözümlenemedi")),
      "damga ile uyarı aynı gerçeği söylemeli"
    );
    // Devam kararı DEĞİŞMEDİ: damgalı ad zaten benzersize yakın, kurulum sürer.
    assert.equal(sonuc.basari, true);
    assert.ok(cagir.cagrilar.includes("create_search_campaign"));
  });
}

test("idempotenlik: okunabilen '0 satır' yanıtı TAMAM kalır (gözcü her şeyi belirsiz saymıyor)", async () => {
  const sonuc = await uygula(ornekGirdi(), { cagir: sahteCagir("0 satır (0 gösteriliyor):\n[]") });
  const adim = idempotenlikAdimi(sonuc);
  assert.equal(adim.durum, "tamam");
  assert.equal(adim.sonucOzeti, "aynı adlı kampanya yok");
  assert.equal(sonuc.uyarilar.some((u) => u.includes("çözümlenemedi")), false);
});

test("idempotenlik: aynı adlı kampanya bulunduğunda damga TAMAM, kurulum iptal", async () => {
  const sonuc = await uygula(ornekGirdi(), { cagir: sahteCagir("1 satır (1 gösteriliyor):\n[{}]") });
  assert.equal(idempotenlikAdimi(sonuc).durum, "tamam");
  assert.equal(sonuc.basari, false);
  assert.ok(sonuc.uyarilar.some((u) => u.includes("zaten var")));
});

/**
 * DAMGANIN OPERATÖRE ULAŞTIĞI YER. Bulgunun asıl zararı tabloda: rapor.mjs damgayı
 * OTORİTE sayar (adimBasarisizMi, durum !== 'tamam'), yani 'tamam' damgası çözümlenememiş
 * bir kontrolü operatöre TAMAM diye gösterirdi. Burada raporun kendisi ölçülüyor.
 */
test("rapor: çözümlenemeyen idempotenlik kontrolü tabloda BELİRSİZ görünür", async () => {
  const sonuc = await uygula(ornekGirdi(), { cagir: sahteCagir("(boş yanıt)") });
  const rapor = raporOlustur({ uygulamaSonucu: sonuc, kuruMod: false });

  const satir = rapor.split("\n").find((s) => s.includes("run_gaql"));
  assert.ok(satir, "rapor tablosunda run_gaql satırı olmalı");
  assert.ok(satir.includes("BELİRSİZ"), `tabloda BELİRSİZ bekleniyordu, satır: ${satir}`);
  assert.equal(satir.includes("| TAMAM |"), false, "çözümlenemeyen kontrol TAMAM basılamaz");
});

/* ── BULGU 2 · kırpma işareti tek kaynaktan ──────────────────────────────────── */

test("kırpma işareti: uygulama.mjs üreticiden içe aktarır, elle kopyalamaz", () => {
  const kaynak = readFileSync(UYGULAMA_YOLU, "utf8");
  assert.match(
    kaynak,
    /import\s*\{[^}]*\bKIRPMA_ISARETI\b[^}]*\}\s*from\s*["']\.\/ortak\.mjs["']/u,
    "KIRPMA_ISARETI ortak.mjs'ten içe aktarılmalı"
  );
  assert.equal(
    new RegExp(`(const|let|var)\\s+KIRPMA_ISARETI\\s*=`, "u").test(kaynak),
    false,
    "yerel kopya sabit bırakılmamalı — üretici ile tüketici arasındaki tek bağ import'tur"
  );
});

/**
 * SÜRÜKLENME DENEYİ — gözcünün kırmızı olabildiğinin kanıtı.
 *
 * Üreticinin işareti DEĞİŞTİRİLİR ve modülün BİREBİR kopyası o üreticiyle çalıştırılır.
 * Modül işareti içe aktarıyorsa yeni işareti tanır; elle kopyalıyorsa TANIMAZ. Fix'ten
 * önce burada ölçülen: kirpik=false, create adımı 'tamam', kalan adımlar koşmaya devam
 * etti — yani kırpık bir metinden kimlik ayıklanmasını engelleyen değişmez sessizce ölüydü.
 *
 * Sahte ortak.mjs yalnız bu sabiti dışa verir; ağır SDK bağımlılıkları yüklenmez. Bu aynı
 * zamanda "uygulama.mjs ortak.mjs'ten YALNIZ bu sabiti alır" iddiasını da ölçer: başka bir
 * şey içe aktarılsaydı içe aktarma çözülemez ve test kırmızı olurdu.
 */
test("kırpma işareti: üreticide değişirse tüketici SÜRÜKLENMEZ (temiz odada ölçülür)", async () => {
  const SURUKLENMIS = "[... sonuç kırpıldı (30000 karakter tavanı) ...]";
  assert.notEqual(SURUKLENMIS, KIRPMA_ISARETI, "deney için işaret gerçekten farklı olmalı");

  const dizin = mkdtempSync(join(tmpdir(), "aegis-faz3-kirpma-"));
  try {
    writeFileSync(
      join(dizin, "ortak.mjs"),
      `export const KIRPMA_ISARETI = ${JSON.stringify(SURUKLENMIS)};\n`,
      "utf8"
    );
    writeFileSync(join(dizin, "uygulama.mjs"), readFileSync(UYGULAMA_YOLU, "utf8"), "utf8");

    const { uygula: kopyaUygula } = await import(pathToFileURL(join(dizin, "uygulama.mjs")).href);
    const sonuc = await kopyaUygula(ornekGirdi(), {
      cagir: sahteCagir("0 satır (0 gösteriliyor):\n[]", {
        create_search_campaign: `${CREATE_OK}\n${SURUKLENMIS}`,
      }),
    });

    assert.equal(sonuc.kirpik, true, "sürüklenmiş işaret de kırpma olarak görülmeli");
    const create = sonuc.adimlar.find((a) => a.arac === "create_search_campaign");
    assert.equal(create.durum, "belirsiz", "kırpık yanıt asla 'tamam' değildir");
    assert.ok(
      sonuc.adimlar.filter((a) => a.arac !== "run_gaql" && a.arac !== "create_search_campaign").every((a) => a.durum === "atlandi"),
      "kırpık yanıttan sonra kalan adımlar İPTAL edilmeli"
    );
    assert.equal(sonuc.kampanyaId, undefined, "kırpık metinden kimlik ayıklanmamalı");
  } finally {
    rmSync(dizin, { recursive: true, force: true });
  }
});

test("kırpma işareti: bugünkü gerçek işaret de kırpma olarak görülür", async () => {
  const sonuc = await uygula(ornekGirdi(), {
    cagir: sahteCagir("0 satır (0 gösteriliyor):\n[]", {
      create_search_campaign: `${CREATE_OK}\n${KIRPMA_ISARETI}`,
    }),
  });
  assert.equal(sonuc.kirpik, true);
  assert.equal(sonuc.adimlar.find((a) => a.arac === "create_search_campaign").durum, "belirsiz");
});

/* ── BULGU 3 · ağ kanıtı belgesi (çift yönlü) ────────────────────────────────── */

/**
 * Bir bildirimin HEMEN ÖNÜNDEKİ JSDoc bloğunu döndürür. Cümleyi doğru yorumda aramak
 * gerekiyor: dosyanın herhangi bir yerinde geçen bir ifade, o bildirimin belgesi değildir.
 */
function oncekiYorumBlogu(kaynak, bildirim) {
  const yer = kaynak.indexOf(bildirim);
  assert.notEqual(yer, -1, `kaynakta bulunamadı: ${bildirim}`);
  const oncesi = kaynak.slice(0, yer);
  const kapanis = oncesi.lastIndexOf("*/");
  assert.notEqual(kapanis, -1, `${bildirim} için yorum bloğu yok`);
  const acilis = oncesi.lastIndexOf("/**", kapanis);
  assert.notEqual(acilis, -1, `${bildirim} için yorum bloğu yok`);
  return oncesi.slice(acilis, kapanis + 2);
}

/**
 * BELGE YÖNÜ. Düzeltme geri alınırsa — yorumlar yine "kanıt satırları ret metnine
 * eklenir" derse — bu üç iddia da kaybolur ve test kırmızı olur.
 */
test("belge: uygulama.mjs ağ kanıtının ajana ULAŞMADIĞINI söyler", () => {
  const kaynak = readFileSync(UYGULAMA_YOLU, "utf8");

  const kanitBlogu = oncekiYorumBlogu(kaynak, "export function kanitSatirlariniAyikla");
  assert.match(kanitBlogu, /IT DOES NOT RETURN NETWORK EVIDENCE/u);
  assert.match(kanitBlogu, /insanSatirlari/u);

  const insanBlogu = oncekiYorumBlogu(kaynak, "const INSAN_KAPISI_IZLERI");
  assert.match(insanBlogu, /NO LONGER HOLDS/u);
  assert.match(insanBlogu, /insanSatirlari/u);

  const maddeBlogu = oncekiYorumBlogu(kaynak, "function maddeSatirlari");
  assert.match(maddeBlogu, /NOT AMONG THEM/u);
});

/**
 * KOD YÖNÜ. approval.ts METİN olarak okunur, içe AKTARILMAZ: bu gözcü ağ kanıtının hangi
 * kanala aktığını ölçer, o dosyanın o anki derlenebilirliğini değil.
 *
 * Kırmızı olduğu hâl: biri `ag.kanit`'i ajanın gördüğü `satirlar` alanına geri bağlarsa —
 * ya da yönlendirmeyi tümden kaldırırsa — yukarıdaki belge cümleleri bayatlar ve bu test
 * düşer. Mutasyonla ölçüldü: satır `satirlar: [...ozet.satirlar, ...ag.kanit]` hâline
 * getirildiğinde test kırmızı oluyor.
 */
test("kod: approval.ts ağ kanıtını YALNIZ insanSatirlari kanalına yazar", () => {
  const kaynak = readFileSync(APPROVAL_YOLU, "utf8");
  const satirlar = kaynak.split("\n");
  const kanitSatirlari = satirlar.filter((s) => s.includes("ag.kanit"));

  assert.ok(kanitSatirlari.length > 0, "ag.kanit yönlendirmesi kayboldu — belge cümleleri yeniden okunmalı");

  for (const s of kanitSatirlari) {
    // `ag.kanit.length` yalnız bir muhafız; taşıyıcı satır insanSatirlari olmalı.
    if (/ag\.kanit\.length/u.test(s) && !/insanSatirlari/u.test(s)) continue;
    assert.match(s, /insanSatirlari/u, `ağ kanıtı insan kanalı dışına akıyor: ${s.trim()}`);
    assert.doesNotMatch(s, /\bsatirlar\s*:/u, `ağ kanıtı ajanın gördüğü satirlar alanına yazılıyor: ${s.trim()}`);
  }
});

/**
 * SUÇUN YERİ DOĞRU İŞARETLENSİN. kanitSatirlariniAyikla bir OKUYUCUDUR: madde satırlarını
 * OLDUĞU GİBİ geçirir, hiçbirini elemez. Yani ağ kanıtının rapora girmemesinin sebebi bu
 * fonksiyon DEĞİL, sunucunun kanalı seçmesidir — düzeltilen yorumların söylediği de budur.
 *
 * İki yönlü: (a) bugünkü zayıf-kanal reddinde geri dönen şey yalnız onay özetidir;
 * (b) sunucu bir gün kanıt maddesini bu kanala koyarsa fonksiyon onu SAKLAMAZ, geçirir.
 */
test("kanitSatirlariniAyikla: madde satırlarını eksiksiz geçirir, gövdeyi almaz", () => {
  const ozetMaddeleri = [
    "Hesap: 1234567890 · Kampanya: 9002",
    "Günlük bütçe: 40 (hesabın para biriminde)",
    "Coğrafi hedef: 1 konum",
  ];
  const zayifKanalRet = [
    'Reddedildi: "GB-20260909-1200 — Deneme" kampanyası YAYINA ALINACAK — bu andan itibaren gerçek para harcanır.',
    ...ozetMaddeleri.map((s) => `  • ${s}`),
    "Kullanıcıya bu özeti göster ve açık onayını al; onay geldiyse confirm=true ile tekrar çağır.",
  ].join("\n");

  assert.deepEqual(kanitSatirlariniAyikla(zayifKanalRet), ozetMaddeleri);

  // (b) Kanıt maddesi gelirse elenmez — eleyen bu fonksiyon değil, sunucudur.
  const kanitli = `${zayifKanalRet}\n  • Ağ doğrulaması: SIM değişimi yok (son 72 saat, +905*******22)`;
  assert.equal(kanitSatirlariniAyikla(kanitli).length, ozetMaddeleri.length + 1);
  assert.ok(kanitSatirlariniAyikla(kanitli).some((s) => s.startsWith("Ağ doğrulaması:")));

  // Gövde (maddesiz satır) asla dönmez.
  assert.equal(kanitSatirlariniAyikla(zayifKanalRet).some((s) => s.startsWith("Reddedildi")), false);
});
