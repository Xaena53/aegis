// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KADEMELİ DOĞRULAMA (step-up) — mentör geri bildiriminden doğan yol.
 *
 * Aleksi Puranen (Nokia, 31.08.2026): "Meşru SIM ve cihaz değişimleri her gün oluyor.
 * Sert kapalı-arıza kapısıyla bu kullanıcıların her biri, ileri gidecek hiçbir yol
 * olmadan reddediliyor. Sonuçsuz ya da başarısız bir sinyalin düz retten çok daha güçlü
 * bir doğrulamayı tetiklediği bir kademeli yol düşünürdüm."
 *
 * Yükseltme bir GEVŞEMEDİR ve gevşemeler test edilmezse tek yönlü kayarlar: her yeni
 * "bunu da yükseltelim" kararı kapıyı biraz daha açar ve hiçbiri kimseye görünmez.
 * Aşağıdaki testler yükseltmenin NEREDE durduğunu sabitler.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agDogrula,
  __setSimSwapKanalForTests,
  __setErisimKanalForTests,
  __setKonumKanalForTests,
  KADEME_UYGUN,
  KEFIL_ESLEMESI,
  type AgAyar,
} from "../src/networkTrust.js";

const TEMEL: AgAyar = {
  nacToken: "TEST-ONLY-token",
  approverPhone: "+905550000000",
  simSwapWindowHours: 72,
  reachCheck: true,
  devSwapCheck: false,
  callFwdCheck: false,
  expectedCountry: "TR",
  stepUp: true,
};

function kanallar(opts: {
  simDegisti?: boolean | undefined;
  erisilebilir?: boolean | undefined;
  ulkeler?: string[];
  yurtDisinda?: boolean;
}) {
  __setSimSwapKanalForTests({ verifySimSwap: async () => opts.simDegisti ?? false });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => opts.erisilebilir ?? true });
  __setKonumKanalForTests({
    ulkeDurumu: async () => ({
      yurtDisinda: opts.yurtDisinda ?? false,
      ulkeler: opts.ulkeler ?? [],
    }),
  });
}

test("KRİTİK: SIM değişmişse RET yerine YÜKSELTME — ve karar bunu açıkça söyler", async () => {
  /**
   * Mentörün adlandırdığı asıl vaka. Telefonunu yenileyen kullanıcı, sert kapıda
   * hiçbir çıkış yolu olmadan reddediliyordu. Artık diğer sinyaller temizse işlem
   * reddedilmiyor; bozulan sinyali adıyla söyleyen bir insan doğrulamasına bağlanıyor.
   */
  kanallar({ simDegisti: true });
  const k = await agDogrula(TEMEL, "high");

  assert.equal(k.engel, undefined, "yükseltilebilir sinyal düz retle bitmemeli");
  assert.equal(k.kademe?.neden, "sim-degisti");
  assert.equal(k.iz.kademe, "yukseltildi", "iz, kararın yükseltilmiş olduğunu taşımalı");
  assert.ok(
    k.kademe!.dogrulayan.length > 0,
    "yükseltmeyi taşıyan en az bir gerçek sinyal adıyla kaydedilmeli"
  );
  assert.ok(
    k.kanit.some((s) => /KADEMELİ DOĞRULAMA/.test(s)),
    "insana gösterilecek kanıt satırı yükseltmeyi anmalı"
  );
});

test("KRİTİK: kademe KAPALIYKEN davranış değişmez — yükseltme opt-in bir gevşemedir", async () => {
  kanallar({ simDegisti: true });
  const k = await agDogrula({ ...TEMEL, stepUp: false }, "high");

  assert.match(String(k.engel), /Reddedildi/, "kapalı kademe eski davranışı korumalı");
  assert.equal(k.kademe, undefined);
  assert.equal(k.iz.kademe, undefined);
});

test("KRİTİK GÜVENLİK: ÇAĞRI YÖNLENDİRME açıkken yükseltme YAPILMAZ", async () => {
  /**
   * Tasarımın en önemli tek kuralı ve sezgiye aykırı olanı.
   *
   * Kademeli doğrulamanın taşıyıcısı insandır — ve o insana ulaşan kanal (çağrı, SMS)
   * tam da çağrı yönlendirme açıkken ele geçirilmiş olan kanaldır. Burada yükseltmek,
   * "daha güçlü doğrulama"yı doğrudan saldırgana göndermek olur: kapı, kendini
   * atlatmak isteyene bir kanal daha açar.
   *
   * Bu yüzden çağrı yönlendirme KADEME_UYGUN listesinde YOKTUR ve olmamalıdır.
   */
  kanallar({});
  const k = await agDogrula(
    { ...TEMEL, callFwdSimulate: "acik", expectedCountry: undefined },
    "high"
  );

  assert.match(String(k.engel), /Reddedildi/, "yönlendirme açıkken kademe açık olsa da RET");
  assert.equal(k.kademe, undefined, "KRİTİK: bu sinyal asla yükseltilemez");
  assert.equal(k.iz.retNedeni, "cagri-yonlendirme-acik");
});

test("KRİTİK: doğrulayan GERÇEK halka yoksa yükseltme yapılamaz", async () => {
  /**
   * Doğrulayansız yükseltme, "sinyal bozuktu ama soracak kimse yoktu, geçsin" demektir —
   * yani kapının kapanması gereken tam anda kapıyı açmak. Yükseltme bir ikinci kanıta
   * dayanır; ikinci kanıt yoksa yükseltme de yoktur.
   */
  kanallar({ simDegisti: true });
  const k = await agDogrula(
    { ...TEMEL, reachCheck: false, expectedCountry: undefined },
    "high"
  );

  assert.match(String(k.engel), /Reddedildi/);
  assert.match(String(k.engel), /GERÇEK bir ağ halkası koşmadı/, "sebep açıkça söylenmeli");
  assert.equal(k.kademe, undefined);
});

test("KRİTİK: SİMÜLE halka, bozuk GERÇEK sinyali doğrulayamaz", async () => {
  /**
   * Aksi hâlde demo kipi kapının en kolay atlatma yolu olurdu: tek bir env değeri
   * ("nv=dogrulandi") gerçek bir SIM değişimini örter ve harcama geçerdi.
   */
  kanallar({ simDegisti: true });
  const k = await agDogrula(
    { ...TEMEL, reachCheck: false, expectedCountry: undefined, nvSimulate: "dogrulandi" },
    "high"
  );

  assert.match(String(k.engel), /Reddedildi/, "simülasyon doğrulayan sayılamaz");
  assert.equal(k.kademe, undefined);
});

test("KRİTİK: ikinci bir sinyal de bozuksa yükseltme değil RET", async () => {
  /**
   * Tek bozuk sinyal olağan bir kullanıcı durumudur; İKİ bağımsız bozuk sinyal bir
   * örüntüdür. Yükseltme yalnız birinciyi karşılar.
   */
  kanallar({ simDegisti: true, erisilebilir: false });
  const k = await agDogrula(TEMEL, "high");

  assert.match(String(k.engel), /Reddedildi/, "ikinci bozuk sinyal yükseltmeyi geçersiz kılar");
  assert.equal(k.kademe, undefined);
});

test("temiz zincir yükseltme üretmez — kademe yalnız gerektiğinde görünür", async () => {
  kanallar({});
  const k = await agDogrula(TEMEL, "high");

  assert.equal(k.engel, undefined);
  assert.equal(k.kademe, undefined, "bozuk sinyal yokken yükseltme etiketi olmamalı");
  assert.equal(k.iz.kademe, undefined);
  assert.ok(!k.kanit.some((s) => /KADEMELİ/.test(s)));
});

test("doğrulama sırası önemsiz: bozuk sinyalden ÖNCE koşan temiz halka da sayılır", async () => {
  /**
   * İlk yazımda doğrulayanlar yalnız bozuk sinyalden SONRA koşanlardan sayılıyordu ve
   * bu, doğrulamayı zincirdeki sıraya bağlıyordu. simSwap halkası konum halkasından
   * ÖNCE koşar; temiz ve gerçek olduğu sürece kefil sayılmalıdır.
   *
   * Aynı vaka ikinci bir kuralı da çiviliyor: erişilebilirlik halkası da konumdan önce
   * koşar ve temiz döner, ama kefil sayılMAZ — bkz. KEFIL_ESLEMESI. Sıra bağımsızlığı
   * ile ilgililik şartı birbirinden ayrı iki kuraldır ve ikisi de burada ölçülür.
   */
  kanallar({ yurtDisinda: true, ulkeler: ["DE"] }); // konum bozuk, diğerleri temiz
  const k = await agDogrula(TEMEL, "high");

  assert.equal(k.kademe?.neden, "konum-beklenmedik");
  assert.ok(
    k.kademe!.dogrulayan.includes("simSwap"),
    `bozuk sinyalden önce koşan temiz halka da sayılmalı (gelen: ${k.kademe!.dogrulayan.join(",")})`
  );
  assert.ok(
    !k.kademe!.dogrulayan.includes("reach"),
    `canlılık sinyali konum sinyaline kefil olmamalı (gelen: ${k.kademe!.dogrulayan.join(",")})`
  );
});

test("KRİTİK: erişilebilirlik halkası TEK BAŞINA gerçek SIM değişimine kefil OLAMAZ", async () => {
  /**
   * Ölçülen açık buydu: SIM son 72 saatte GERÇEKTEN değişmişken, temiz dönen tek gerçek
   * halka erişilebilirlik olduğunda yükseltme veriliyor ve harcama insana daha güçlü bir
   * soru sorularak geçiyordu. Oysa SIM'i ele geçiren saldırganın telefonu da şebekeden
   * erişilebilirdir — bu halka o sinyalle ÇELİŞMEZ, dolayısıyla ona kefil de olamaz.
   *
   * Kefil olabilecek halkalar (devSwap, loc, callFwd) bilerek KAPALI bırakıldı; geriye
   * yalnız erişilebilirlik kalıyor. Beklenen sonuç: yükseltme YOK, düz RET.
   */
  kanallar({ simDegisti: true });
  /**
   * Kefil olabilecek halkaların HEPSİ kapatıldı: devSwap ve callFwd zaten TEMEL'de
   * kapalı, konum halkası da beklenen ülke verilmeyerek kapatıldı (halka "kapali"
   * döner ve gerçek sayılmaz). Geriye temiz dönen tek gerçek halka erişilebilirlik
   * kalıyor — tam da kefil olamayacak olan.
   */
  const k = await agDogrula({ ...TEMEL, expectedCountry: undefined }, "high");

  assert.equal(k.kademe, undefined, "yükseltme verilmemeli");
  assert.ok(k.engel, "işlem reddedilmeli");
  assert.match(
    k.engel!,
    /kefil olabilecek türden değil/,
    `ret sebebi ilgisiz kefaleti açıkça söylemeli (gelen: ${k.engel})`
  );
});

test("KEFIL_ESLEMESI, KADEME_UYGUN ile birebir örtüşür", () => {
  /**
   * Yeni bir ret nedeni kademeye uygun ilan edilip kefil tablosuna yazılmazsa, o neden
   * için kefil kümesi boş olur ve yükseltme SESSİZCE hiç verilmez — kapalı arıza doğru
   * yönde ama sebebi görünmez. Bu gözcü, iki listeyi birbirine çiviler.
   */
  for (const neden of KADEME_UYGUN) {
    assert.ok(
      Array.isArray(KEFIL_ESLEMESI[neden]) && KEFIL_ESLEMESI[neden]!.length > 0,
      `kademeye uygun '${neden}' için kefil tablosunda satır yok`
    );
  }
  for (const neden of Object.keys(KEFIL_ESLEMESI)) {
    assert.ok(KADEME_UYGUN.has(neden as any), `kefil tablosunda fazladan neden: '${neden}'`);
  }
  // Canlılık sinyali hiçbir satırda kefil olamaz.
  for (const [neden, kefiller] of Object.entries(KEFIL_ESLEMESI)) {
    assert.ok(!kefiller.includes("reach"), `'${neden}' satırında erişilebilirlik kefil görünüyor`);
    assert.ok(!kefiller.includes("nv"), `'${neden}' satırında simüle NV kefil görünüyor`);
  }
});

test("yapılandırma hatası yükseltilemez — kimlik doğrulaması onu düzeltmez", async () => {
  /**
   * Çelişkili yapılandırma OPERATÖRÜN durumudur, kullanıcının değil. Onu yükseltmek,
   * bir yapılandırma hatasını kullanıcı doğrulamasıyla örtmek olurdu.
   */
  kanallar({});
  const k = await agDogrula({ ...TEMEL, nacSimulate: "temiz" }, "high");

  assert.match(String(k.engel), /Reddedildi/);
  assert.equal(k.kademe, undefined);
  assert.equal(k.iz.retNedeni, "yapilandirma-celiskili");
});
