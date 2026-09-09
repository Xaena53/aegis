// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ONARIM TURU 2 — src/networkTrust.ts: bağımsız gözden geçirenin bulduğu ARTIK KUSURLAR.
 *
 * Birinci onarım turu kefalet kurallarını (KEFIL_ESLEMESI / YANITSIZ_KEFIL_ESLEMESI) getirdi
 * ama üç şey açık kaldı. Bu dosyadaki her test ÖLÇÜLMÜŞ bir açığı çiviler; hepsi mutasyonla
 * doğrulandı (düzeltme geçici geri alındı → KIRMIZI, geri kondu → YEŞİL).
 *
 *   1) HİÇBİR ŞEY GÖZLEMEMİŞ HALKA KEFİL OLUYORDU. Ölçülen: kademe açık + gerçek
 *      `swapped:true` + `{roaming:false, countryName:[]}` → `GECTI | kademe=sim-degisti
 *      kefil=[loc]`. Konum halkası "yurt dışında değil ve çelişen ülke bildirilmedi" diyerek
 *      temiz dönüyor, ama hattın beklenen ülkede olduğunu DOĞRULAMIŞ değil — saptanmış bir
 *      SIM değişimini, hiçbir şey ölçmemiş bir halkanın kefaleti taşıyordu. Kefalet ilkesi:
 *      bir halka ancak ÇELİŞEBİLECEĞİ bir sinyale kefil olabilir.
 *   2) İKİ KEFİL TABLOSU BİRBİRİNE ÇİVİLENMEMİŞTİ. YANITSIZ_KEFIL_ESLEMESI, satır satır
 *      KEFIL_ESLEMESI'nin elle yazılmış ikinci bir kopyasıydı ve hiçbir test eşleşmeyi
 *      zorlamıyordu. Bir doktrin iki yerde yazılırsa tek yönde kayar: biri güncellenir,
 *      diğeri unutulur, kefil kümesi SESSİZCE genişler. Artık tablo türetiliyor.
 *   3) BELGE BAYATLAMIŞTI. docs/CAMARA.md yalnız "AKTİF çağrı yönlendirme yükseltilmez"
 *      diyordu ve eşleşmeyi tek tabloya bağlıyordu; oysa SESSİZ yönlendirme de asla
 *      yükseltilmiyor ve "ag-yanitsiz" ikinci tablodan okunuyor. Yanlış yorum/belge bu
 *      depoda hatadır.
 *
 * Hiçbir testte ağa çıkılmaz: sahte kanallar enjekte edilir.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  agDogrula,
  HALKA_SAPTAMA_NEDENI,
  KADEME_UYGUN,
  KEFIL_ESLEMESI,
  YANITSIZ_KEFIL_ESLEMESI,
  ZINCIR_HALKALARI,
  __setCagriYonlendirmeKanalForTests,
  __setCihazDegisimKanalForTests,
  __setErisimKanalForTests,
  __setKonumKanalForTests,
  __setSimSwapKanalForTests,
  type AgAyar,
} from "../src/networkTrust.js";

/**
 * Kefil olabilecek TEK halka konum halkasıdır: erişilebilirlik kefil sayılmaz (canlılık
 * sinyali), cihaz değişimi ve çağrı yönlendirme kapalı. Böylece "konum kefil oldu mu?"
 * sorusu tek başına ölçülebiliyor.
 */
const YALNIZ_KONUM_KEFIL: AgAyar = {
  nacToken: "TEST-ONLY-token",
  approverPhone: "+905550000000",
  simSwapWindowHours: 72,
  reachCheck: true,
  devSwapCheck: false,
  callFwdCheck: false,
  expectedCountry: "TR",
  stepUp: true,
};

/** SIM GERÇEKTEN değişmiş; konum halkasının ağdan ne gördüğü teste göre değişir. */
function kanallar(konum: { yurtDisinda?: boolean; ulkeler?: string[] }): void {
  __setSimSwapKanalForTests({ verifySimSwap: async () => true });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setKonumKanalForTests({ ulkeDurumu: async () => konum });
}

// Dikişler modül-global: sıfırlanmazsa sonraki teste sızar.
afterEach(() => {
  __setSimSwapKanalForTests(undefined);
  __setErisimKanalForTests(undefined);
  __setKonumKanalForTests(undefined);
  __setCihazDegisimKanalForTests(undefined);
  __setCagriYonlendirmeKanalForTests(undefined);
});

/* ── 1) Hiçbir şey gözlememiş halka kefil olamaz ──────────────────────────────── */

/** İki ayrı gövde, tek bir olgu: ağ HİÇBİR ülke bildirmedi. */
const GOZLEMSIZ_GOVDELER: Array<[string, { yurtDisinda?: boolean; ulkeler?: string[] }]> = [
  ["ağ ülke listesini BOŞ döndürdü", { yurtDisinda: false, ulkeler: [] }],
  ["ağ ülke alanını HİÇ göndermedi", { yurtDisinda: false }],
];

for (const [ad, konum] of GOZLEMSIZ_GOVDELER) {
  test(`KRİTİK: ${ad} → konum halkası TEMİZ döner ama SIM değişimine KEFİL OLAMAZ`, async () => {
    /**
     * Ölçülen açık buydu. `{roaming:false, countryName:[]}` gövdesinde konum halkası temiz
     * döner — reddedecek bir çelişki yoktur — ama hattın beklenen ülkede olduğunu da
     * doğrulamaz. Kademe açıkken bu halka, GERÇEKTEN saptanmış bir SIM değişimine kefil
     * oluyor ve harcama insana "SIM değişmiş ama diğer sinyaller temiz" denerek geçiyordu.
     * Hiçbir ülke görmemiş bir halkanın "diğer sinyal temiz" diye sayılması, kapının
     * kapanması gereken anda kapıyı açmaktır.
     */
    kanallar(konum);
    const k = await agDogrula(YALNIZ_KONUM_KEFIL, "high");

    assert.equal(k.kademe, undefined, "KRİTİK: gözlemsiz halka yükseltmeyi taşıyamaz");
    assert.equal(k.iz.kademe, undefined, "iz de yükseltme göstermemeli");
    assert.ok(k.engel, "işlem reddedilmeli");
    assert.equal(k.iz.retNedeni, "sim-degisti", "bozulan sinyal kayda geçmeli");
    assert.ok(
      !(k.iz.kademeDogrulayan ?? []).includes("loc"),
      `hiçbir ülke gözlememiş konum halkası kefil yazılmamalı (gelen: ${JSON.stringify(
        k.iz.kademeDogrulayan
      )})`
    );
  });
}

test("gözlemsiz halka 'hiç koşmadı' sayılmaz — ret sebebi doğru durumu anlatır", async () => {
  /**
   * İki durum ayrı raporlanmalı: hiç gerçek halka koşmaması ile halkaların koşup bu
   * sinyale kefil olamaması aynı şey değil. Gözlemsiz halkayı temiz-gerçek listesinden
   * tamamen silmek, operatöre var olmayan bir yapılandırma sorunu gösterirdi.
   */
  kanallar({ yurtDisinda: false, ulkeler: [] });
  const k = await agDogrula(YALNIZ_KONUM_KEFIL, "high");

  assert.match(
    String(k.engel),
    /kefil olabilecek türden değil/,
    `koşan ama kefil olamayan halka durumu anlatılmalı (gelen: ${k.engel})`
  );
  assert.doesNotMatch(
    String(k.engel),
    /GERÇEK bir ağ halkası koşmadı/,
    "gerçek halka koştu; 'hiç koşmadı' demek operatöre yanlış teşhis verir"
  );
});

test("düzeltme DAR: ülkeyi GERÇEKTEN gözlemiş konum halkası kefil olmayı sürdürür", async () => {
  /**
   * Gevşemeler gibi sıkılaştırmalar da ölçülmezse fazla ileri gider: "konum halkası kefil
   * olamaz" demek mentörün adlandırdığı yolu (meşru hat yenilemesi → düz ret değil, daha
   * güçlü doğrulama) kapatırdı. Kapatılan yalnızca HİÇBİR ŞEY GÖZLEMEMİŞ olan hâldir.
   */
  kanallar({ yurtDisinda: false, ulkeler: ["TR"] });
  const k = await agDogrula(YALNIZ_KONUM_KEFIL, "high");

  assert.equal(k.engel, undefined, "gerçek gözlem yükseltmeyi taşımalı");
  assert.equal(k.kademe?.neden, "sim-degisti");
  assert.deepEqual(k.kademe?.dogrulayan, ["loc"], "kefil, ülkeyi gerçekten gören halka olmalı");
});

/* ── 2) İki kefil tablosu birbirine ÇİVİLİ ────────────────────────────────────── */

test("kefil tabloları çivili: YANITSIZ_KEFIL_ESLEMESI, KEFIL_ESLEMESI'nden TÜRER", () => {
  /**
   * Aynı doktrin iki yerde yazılırsa tek yönde kayar. Bu gözcü, sessiz halkanın kefil
   * kümesinin, o halkanın SAPTAMA nedeninin kefil kümesiyle birebir aynı kalmasını
   * zorlar: biri elle genişletilip diğeri unutulursa KIRMIZI olur.
   */
  for (const [halka, neden] of Object.entries(HALKA_SAPTAMA_NEDENI)) {
    const beklenen = KADEME_UYGUN.has(neden)
      ? (KEFIL_ESLEMESI[neden] ?? []).filter((id) => id !== halka)
      : [];
    assert.deepEqual(
      [...(YANITSIZ_KEFIL_ESLEMESI[halka] ?? [])],
      [...beklenen],
      `'${halka}' halkasının sessizliğine kefil kümesi, saptama nedeni '${neden}' için ` +
        `yazılan kefil kümesinden sapmış — bir doktrin, iki tablo`
    );
  }
});

test("bilinen KADEME_UYGUN dışı sinyalin SESSİZLİĞİ de yükseltilemez (bilinmeyen ≤ bilinen)", () => {
  /**
   * Ters teşvik buydu: AKTİF çağrı yönlendirme asla yükseltilemezken, DURUMU BİLİNMEYEN
   * yönlendirme serbestçe yükseltiliyordu — bilinmeyene bilinenden daha yumuşak davranmak,
   * bu dosyanın kapalı-arıza sözleşmesinin tam tersi. Türetme bunu kural hâline getiriyor.
   */
  for (const [halka, neden] of Object.entries(HALKA_SAPTAMA_NEDENI)) {
    if (KADEME_UYGUN.has(neden)) continue;
    assert.deepEqual(
      [...(YANITSIZ_KEFIL_ESLEMESI[halka] ?? [])],
      [],
      `'${halka}' saptandığında yükseltilemiyor ('${neden}' KADEME_UYGUN dışı) ama ` +
        `sessizliğine kefil bulunuyor — bilinmeyen, bilinenden daha yumuşak davranılamaz`
    );
  }
});

test("zincirdeki her halkanın SAPTAMA NEDENİ kayıtlı — yeni halka sessizce boş geçemez", () => {
  /**
   * Türetme, kaydı olmayan halkaya boş küme verir (kapalı arıza, doğru yön). Ama yeni bir
   * halka eklenirken bunun BİLEREK mi olduğu görünmeli: kayıt zorunlu.
   */
  for (const halka of ZINCIR_HALKALARI) {
    assert.ok(
      HALKA_SAPTAMA_NEDENI[halka.izAlani as string],
      `halka '${halka.id}' (iz alanı '${halka.izAlani}') için saptama nedeni kaydı yok — ` +
        `sessizliğinin kefil kümesi sessizce boş kalır`
    );
  }
});

/* ── 3) Belge, kodun yaptığını söylüyor ───────────────────────────────────────── */

const CAMARA = readFileSync(fileURLToPath(new URL("../docs/CAMARA.md", import.meta.url)), "utf8");

/** AEGIS_STEPUP'ın anlatıldığı bölüm — iddialar orada aranır, dosyanın rastgele yerinde değil. */
function kademeBolumu(): string {
  const bas = CAMARA.indexOf("AEGIS_STEPUP");
  assert.notEqual(bas, -1, "docs/CAMARA.md AEGIS_STEPUP'tan söz etmiyor — yol bayatlamış");
  const son = CAMARA.indexOf("### Step 3", bas);
  assert.notEqual(son, -1, "docs/CAMARA.md '### Step 3' başlığı bulunamadı — yol bayatlamış");
  return CAMARA.slice(bas, son);
}

test("belge: kademe bölümü İKİ kefil tablosunu da adıyla anıyor", () => {
  /**
   * Belge "eşleşme KEFIL_ESLEMESI'nde yaşıyor" diyordu; oysa "ag-yanitsiz" için eşleşme
   * ikinci tablodan (YANITSIZ_KEFIL_ESLEMESI) okunuyor. Jüri/mentör belgeyi okuyup kodun
   * yapmadığı bir kural öğreniyordu.
   */
  const bolum = kademeBolumu();
  assert.match(bolum, /KEFIL_ESLEMESI/, "birinci tablo anılmalı");
  assert.match(
    bolum,
    /YANITSIZ_KEFIL_ESLEMESI/,
    "ikinci tablo (sessiz halkaya göre kefil seçimi) belgede hiç geçmiyor"
  );
});

test("belge: SESSİZ çağrı yönlendirmenin de yükseltilmediğini söylüyor — ve kod öyle", () => {
  /**
   * ÇİFT YÖNLÜ ÇİVİ: cümle belgeden düşerse bu test kırmızı olur; kod gevşeyip sessiz
   * yönlendirmeye kefil bulmaya başlarsa da kırmızı olur. Belgedeki iddia ile koddaki
   * davranış birlikte tutuluyor.
   */
  const bolum = kademeBolumu();
  /**
   * CÜMLE cümle aranır, paragraf paragraf değil. Fark ölçüldü: bayat belgede "network
   * silent" ifadesi zaten AYNI PARAGRAFTA geçiyor (bozuk sinyal listesinin bir üyesi
   * olarak), dolayısıyla paragraf kapsamı gözcüyü kural belgede hiç yazmıyorken sessizce
   * yeşile düşürüyordu.
   */
  const cumleler = bolum
    .split(/(?<=[.!?])\s+/)
    .filter((c) => /forward/i.test(c) && /silent/i.test(c));
  assert.ok(
    cumleler.length > 0,
    "docs/CAMARA.md kademe bölümü, SESSİZ çağrı yönlendirmenin yükseltilmediğini hiç " +
      "söylemiyor — belge yalnız AKTİF hâli anlatıyorsa okuyucu kodun tersini öğrenir"
  );
  assert.match(
    bolum,
    /ag-yanitsiz/,
    "sessizliğin ret nedeni kodda 'ag-yanitsiz'; belge o adı hiç anmıyorsa okuyucu kuralı " +
      "izde ve karar günlüğünde tanıyamaz"
  );
  assert.deepEqual(
    [...(YANITSIZ_KEFIL_ESLEMESI.callFwd ?? [])],
    [],
    "belge 'sessiz yönlendirmeye kefil yoktur' diyor ama kodda kefil var — biri bayat"
  );
});

/**
 * KELİME DEĞİL KURAL ARANIR — bu gözcünün kendi onarımı.
 *
 * Önceki hâli bölümde yalnızca /observ/i arıyordu ve açığı ÖLÇÜLDÜ: 4. maddeyi kodun TAM
 * TERSİNİ söyleyecek biçimde ("A link that came back clean MAY vouch even when it observed
 * nothing.") yeniden yazınca gözcü YEŞİL kaldı, çünkü komşu cümlede ("Nothing observed is
 * not evidence") kelime hâlâ geçiyordu. Bir kelimeyi çivilemek iddiayı çivilemek değildir:
 * belge kuralın tersini öğretirken test gözcülük ettiğini sanıyordu.
 *
 * Aranan artık kuralın İKİ YARISININ AYNI CÜMLEDE buluşmasıdır — gözlem yokluğu → kefalet
 * yokluğu — ve ayrıca tersi YASAKTIR: gözlemsiz halkaya kefalet İZNİ veren bir cümle bu
 * bölümde duramaz. Kural silinirse kırmızı, tersine çevrilirse kırmızı.
 */
const GOZLEM_YOKLUGU =
  /(observ\w*\s+(nothing|no\b)|without\s+observ\w*|nothing\s+(\w+\s+){0,2}observ\w*)/i;
const KEFALET_YOKLUGU =
  /(vouch\w*\s+for\s+(nothing|no\b)|cannot\s+vouch|never\s+vouch|not\s+vouch|no\s+escalation|carries\s+no\b|is\s+not\s+evidence|no\s+corroborat)/i;
/** İzin kipi: "may/can/still … vouch". Kefaleti gözlemsizliğe AÇAN cümlenin imzası. */
const KEFALET_IZNI = /\b(may|can|could|still|does|do|will|allowed)\b[^.]{0,80}\b(vouch|corroborat|escalat)/i;

type BelgeTaramasi = { readonly kuralCumleleri: string[]; readonly izinCumleleri: string[] };

/**
 * Bölümü CÜMLE cümle okur. Bir cümle hem gözlem yokluğunu hem kefalet yokluğunu söylüyorsa
 * KURALI kurar; gözlem yokluğuna kefalet izni veriyorsa (ve bir yerinde reddetmiyorsa)
 * kuralın TERSİNİ kurar. İkinci liste boş olmalı, birincisi dolu.
 */
function gozlemsizKuraliniTara(bolum: string): BelgeTaramasi {
  const cumleler = bolum.split(/(?<=[.!?])\s+/);
  return {
    kuralCumleleri: cumleler.filter((c) => GOZLEM_YOKLUGU.test(c) && KEFALET_YOKLUGU.test(c)),
    izinCumleleri: cumleler.filter(
      (c) => GOZLEM_YOKLUGU.test(c) && KEFALET_IZNI.test(c) && !KEFALET_YOKLUGU.test(c)
    ),
  };
}

test("belge: 'gözlemsiz halka kefil olamaz' kuralı YAZILI — ve kod aynı anda öyle davranıyor", async () => {
  const tarama = gozlemsizKuraliniTara(kademeBolumu());

  assert.ok(
    tarama.kuralCumleleri.length > 0,
    "docs/CAMARA.md kademe bölümünde, HİÇBİR ŞEY GÖZLEMEMİŞ halkanın kefil olamadığını " +
      "TEK CÜMLEDE söyleyen bir kural yok. Bölümde 'observ' kelimesinin geçmesi yetmez: " +
      "kelime komşu cümlede dururken kural tersine yazılabiliyordu."
  );
  assert.deepEqual(
    tarama.izinCumleleri,
    [],
    "docs/CAMARA.md kademe bölümü, gözlemsiz bir halkanın kefil OLABİLECEĞİNİ söyleyen bir " +
      "cümle taşıyor — kod bunun tersini yapıyor (aşağıdaki ölçüm), yani belge bayat."
  );

  /**
   * ÇİFT YÖNLÜ ÇİVİ. Yukarısı belgeyi, burası kodu tutar: belge kuralı yazarken kod gevşer
   * ve gözlemsiz konum halkası yine kefil olmaya başlarsa aynı test kırmızı olur. Metin ile
   * davranış birlikte, tek yerde.
   */
  kanallar({ yurtDisinda: false, ulkeler: [] });
  const k = await agDogrula(YALNIZ_KONUM_KEFIL, "high");
  assert.equal(
    k.kademe,
    undefined,
    "belge 'gözlemsiz halka kefil olamaz' diyor ama kod gözlemsiz halkayla yükseltiyor"
  );
});

test("gözcü gerçekten kırmızıya düşebiliyor: kural SİLİNSE de TERSİNE çevrilse de", () => {
  /**
   * Mutasyon sentetik metin üzerinde yapılır: docs/CAMARA.md'ye dokunmak, üzerinde başka
   * bir değişiklik uçuşuyorsa onu ezme riski taşır (kardeş gözcü onarim2VideoDemo.test.ts
   * aynı gerekçeyle sentetik kaynak kullanıyor). Ölçülen kusurun kendisi buraya fikstür
   * olarak kondu: eski /observ/i taraması bu üç belgenin ÜÇÜNÜ DE yeşil geçiyordu.
   */
  const KURAL_MADDESI =
    "4. **A link that came back clean without OBSERVING anything vouches for nothing either.**";
  const TERS_MADDE = "4. **A link that came back clean MAY vouch even when it observed nothing.**";
  const SATIRLAR = [
    "3. **A clean link only counts as corroboration for a signal it could actually have",
    "   contradicted.** This is why device reachability vouches for nothing.",
    KURAL_MADDESI,
    '   The location link answers clean when the network says "not roaming" and reports no',
    "   country at all. Nothing observed is not evidence, so it carries no escalation.",
  ];
  const saglam = SATIRLAR.join("\n");
  const tersine = saglam.replace(KURAL_MADDESI, TERS_MADDE);
  const silinmis = SATIRLAR.slice(0, 2).join("\n");

  assert.ok(gozlemsizKuraliniTara(saglam).kuralCumleleri.length > 0, "sağlam belge yeşil olmalı");
  assert.deepEqual(gozlemsizKuraliniTara(saglam).izinCumleleri, [], "sağlam belgede izin cümlesi yok");

  assert.ok(
    gozlemsizKuraliniTara(tersine).izinCumleleri.length > 0,
    "kural TERSİNE çevrildiğinde gözcü kırmızıya düşmüyor — ölçülen sahte-yeşil geri gelmiş"
  );
  assert.equal(
    gozlemsizKuraliniTara(silinmis).kuralCumleleri.length,
    0,
    "kural SİLİNDİĞİNDE gözcü kırmızıya düşmüyor"
  );

  /**
   * Eski gözcünün açığı, aynı fikstürle kanıtlı. Silme onu da kırmızıya düşürürdü (kelime
   * de giderdi); kaçırdığı hâl TERSİNE ÇEVİRMEYDİ — kural yok olmadan anlamı yok ediliyor,
   * kelime yerinde kalıyordu. Bu satır o farkı ölçülebilir tutar.
   */
  assert.match(
    tersine,
    /observ/i,
    "kelime taraması (/observ/i) tersine çevrilmiş belgeyi YEŞİL geçerdi — daraltmanın sebebi bu"
  );
});
