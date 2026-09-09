// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ONARIM GÖZCÜLERİ — src/networkTrust.ts denetim bulguları.
 *
 * Bu dosyadaki her test, ÖLÇÜLMÜŞ bir açığı çiviler. Hepsi mutasyonla doğrulandı: düzeltme
 * geçici olarak geri alındığında test KIRMIZI olur, geri konduğunda YEŞİL.
 *
 * Kapsanan bulgular:
 *   1) Konum halkası: `countryName` beklenmedik tipte gelirse (string/obje/null/sayı dizisi)
 *      sessizce "ülke bildirilmedi" sayılıp TEMİZ geçiyordu — üstelik kanıt satırı, kodun
 *      hiç doğrulamadığı bir iddia yazıyordu. Şimdi kapalı arıza ("ag-yanitsiz").
 *   2) Sessiz kalan ÇAĞRI YÖNLENDİRME halkasına, yönlendirmeyi göremeyen halkalar kefil
 *      oluyordu: 501 dönen bir şebekede her yüksek riskli onay yükseltilerek geçiyordu.
 *      Şimdi bu halkanın sessizliğine kefil YOKTUR (fail closed).
 *   3) Yükseltme açıklaması HALKAYA sabitliydi, oysa aynı halka iki neden üretebiliyor:
 *      "ag-yanitsiz" iken insana "SIM kartı yakın zamanda değişmiş" deniyordu. Hiç
 *      gözlenmemiş bir olguya onay alınıyordu; iz ise "ag-yanitsiz" yazıyordu.
 *   4) Yorumlar, kademeli doğrulamanın karşılığında "indirilmiş bir tavan" vaat ediyordu;
 *      kodda tavanı indiren hiçbir şey yok.
 *   5) "Bir halkanın reddi KESİNDİR" değişmezi AEGIS_STEPUP açıkken yanlıştı.
 *   6) Dosya başı "risk katmanı karar mantığını değiştirmez" diyordu; oysa hangi halkaların
 *      koşacağını risk katmanı belirliyor (RISK_HALKA_ESLEMESI).
 *
 * Hiçbir testte ağa çıkılmaz: ya sahte SDK istemcisi (üretimdeki uyarlayıcı kapanışları
 * gerçekten koşar) ya da sahte kanal enjekte edilir.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { onayAl } from "../src/approval.js";
import {
  agDogrula,
  YANITSIZ_KEFIL_ESLEMESI,
  __setCagriYonlendirmeKanalForTests,
  __setCihazDegisimKanalForTests,
  __setErisimKanalForTests,
  __setKonumKanalForTests,
  __setNacIstemciFabrikasiForTests,
  __setSimSwapKanalForTests,
  type AgAyar,
} from "../src/networkTrust.js";

const TELEFON = "+905551112233";
const MASKELI = "+905*******33";

/** Yalnız SIM Swap + konum halkalarını açan yapılandırma (uyarlayıcı testleri için). */
const KONUM_AYARI: AgAyar = {
  nacToken: "TEST-ONLY-gercek-token",
  approverPhone: TELEFON,
  simSwapWindowHours: 72,
  expectedCountry: "TR",
};

/** Altı halkanın hepsi açık; kademe testleri bunun üzerinden koşar. */
const TAM_ZINCIR: AgAyar = {
  ...KONUM_AYARI,
  reachCheck: true,
  devSwapCheck: true,
  callFwdCheck: true,
  stepUp: true,
};

/* ── sahte SDK istemcisi: ÜRETİMDEKİ uyarlayıcı kapanışları koşar, ağa çıkılmaz ─── */

function sahteIstemci(g: { roaming?: unknown; simSwap?: unknown }): any {
  const don = (v: unknown) => async () => v;
  return {
    simSwap: { check: don(g.simSwap ?? { swapped: false }) },
    deviceStatus: {
      retrieveReachabilityStatus: don({ reachable: true }),
      checkRoaming: don(g.roaming ?? { roaming: false }),
    },
    deviceSwap: { check: don({ swapped: false }) },
    callForwardingSignal: { retrieveUnconditionalCallForwarding: don({ active: false }) },
  };
}

function istemciKur(g: { roaming?: unknown; simSwap?: unknown }): void {
  __setNacIstemciFabrikasiForTests(async () => sahteIstemci(g) as any);
}

/** Sahte kanallar: varsayılanı TEMİZ, yalnız sınanan halka bozulur. */
function kanallar(o: {
  sim?: boolean | undefined;
  reach?: boolean | undefined;
  dev?: boolean | undefined;
  cf?: boolean | undefined;
  cfPatlasin?: boolean;
}): void {
  __setSimSwapKanalForTests({ verifySimSwap: async () => ("sim" in o ? o.sim : false) });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => ("reach" in o ? o.reach : true) });
  __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: ["TR"] }) });
  __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => ("dev" in o ? o.dev : false) });
  __setCagriYonlendirmeKanalForTests({
    kosulsuzYonlendirmeAcikMi: async () => {
      if (o.cfPatlasin) throw new Error("501 NotImplementedError");
      return "cf" in o ? o.cf : false;
    },
  });
}

/** Elicitation yeteneği BİLDİREN sahte sunucu; gösterilen istemleri kaydeder. */
function istemKaydedenSunucu(sorulanlar: string[]): any {
  return {
    server: {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      elicitInput: async (istek: any) => {
        sorulanlar.push(String(istek.message));
        return { action: "accept", content: { onay: true } };
      },
    },
  };
}

// Dikişlerin HEPSİ modül-global: biri sıfırlanmazsa sonraki teste sızar.
afterEach(() => {
  __setNacIstemciFabrikasiForTests(undefined);
  __setSimSwapKanalForTests(undefined);
  __setErisimKanalForTests(undefined);
  __setKonumKanalForTests(undefined);
  __setCihazDegisimKanalForTests(undefined);
  __setCagriYonlendirmeKanalForTests(undefined);
});

/* ── 1) countryName okunamıyorsa "ülke bildirilmedi" SAYILMAZ ─────────────────── */

/**
 * Anlamı AYNI, tipi bozuk gövdeler. Hepsi {roaming:false} ile birlikte gelir; düzeltmeden
 * önce dördü de GEÇİYORDU — üstelik "ağ beklenen ülkeyle çelişen bir ülke bildirmedi" diye
 * DOĞRULANMAMIŞ bir kanıt satırıyla.
 */
const OKUNAMAYAN_ULKE: ReadonlyArray<readonly [string, unknown]> = [
  ['string "NL" (dizi değil)', "NL"],
  ["obje {0:'NL'}", { 0: "NL" }],
  ["null", null],
  ["sayı dizisi [1,2]", [1, 2]],
  ["karışık dizi ['TR',7]", ["TR", 7]],
];

for (const [ad, deger] of OKUNAMAYAN_ULKE) {
  test(`konum: okunamayan countryName (${ad}) RET üretir — "temiz" SAYILMAZ`, async () => {
    istemciKur({ roaming: { roaming: false, countryName: deger } });

    const k = await agDogrula(KONUM_AYARI, "high");

    assert.ok(k.engel, "okunamayan ülke alanı fail-OPEN olamaz — harcama geçerdi");
    assert.match(k.engel!, /konum kontrolünden okunabilir yanıt alınamadı/, "reti üreten halka adıyla anılmalı");
    assert.equal(k.iz.retNedeni, "ag-yanitsiz", "bilinmeyen, bir suçlamaya çevrilemez");
    assert.equal(k.iz.loc, "gercek", "sorgu gerçekten denendi: 'calismadi' değil");
    assert.equal(k.kanit.length, 0, "reddedilen halka kanıt satırı yazmaz");
    assert.doesNotMatch(k.engel!, /NL/, "gözlenen ülke ajana yankılanmaz");
    assert.doesNotMatch(k.engel!, /5551112233/, "tam numara ret metnine sızmaz");
    assert.equal(k.iz.maskeliNumara, MASKELI);
  });
}

test("konum: alan HİÇ YOKSA eski davranış korunur — 'yok' ile 'okunamadı' aynı şey değil", async () => {
  /**
   * Düzeltmenin kapsamı burada bitiyor: ağ hiç ülke bildirmediyse karşılaştırılacak bir
   * çelişki yoktur ve halka (roaming:false ile) TEMİZ döner. Bu dal daraltılsaydı, ülke
   * alanını hiç göndermeyen meşru bir operatörde kapı kalıcı olarak kapanırdı.
   */
  istemciKur({ roaming: { roaming: false } });

  const k = await agDogrula(KONUM_AYARI, "high");

  assert.equal(k.engel, undefined, "alanı hiç göndermeyen operatör reddedilmemeli");
  assert.equal(k.iz.loc, "gercek");
  assert.ok(k.kanit.some((s) => /çelişen bir ülke bildirmedi/.test(s)));
});

test("konum: DÜZGÜN TİPLİ ülke listesi eski hükmünü korur (çelişki -> konum-beklenmedik)", async () => {
  // Kontrol grubu: düzeltme, okunabilir gövdelerin ret NEDENİNİ değiştirmemeli.
  istemciKur({ roaming: { roaming: false, countryName: ["NL"] } });
  const celiski = await agDogrula(KONUM_AYARI, "high");
  assert.ok(celiski.engel);
  assert.equal(celiski.iz.retNedeni, "konum-beklenmedik", "okunabilir çelişki 'ag-yanitsiz'e kaymamalı");

  // Boş/boşluklu dize hâlâ OKUNABİLİR sayılır ve karşılaştırmada düşer (belgelenmiş davranış).
  istemciKur({ roaming: { roaming: false, countryName: [""] } });
  const bos = await agDogrula(KONUM_AYARI, "high");
  assert.ok(bos.engel);
  assert.equal(bos.iz.retNedeni, "konum-beklenmedik");

  // Yalnız beklenen ülke: GEÇER.
  istemciKur({ roaming: { roaming: true, countryName: ["TR"] } });
  const temiz = await agDogrula(KONUM_AYARI, "high");
  assert.equal(temiz.engel, undefined, "yalnızca beklenen ülke reddedilmez");
});

test("KRİTİK: okunamayan konum yanıtı, SAPTANMIŞ bir SIM değişimine KEFİL OLAMAZ", async () => {
  /**
   * Ölçülen en ağır sonuç buydu: gerçek bir SIM değişimi (swapped:true) varken
   * {roaming:false, countryName:["NL"]} gövdesi RET veriyor, aynı anlamı taşıyan ama tipi
   * bozuk {roaming:false, countryName:"NL"} gövdesi ise "kademe=yükseltildi,
   * kefil=[loc]" ile GEÇİYORDU — okunamayan bir yanıt, ele geçirme işaretine kefil oluyordu.
   */
  istemciKur({ simSwap: { swapped: true }, roaming: { roaming: false, countryName: "NL" } });

  const k = await agDogrula({ ...KONUM_AYARI, stepUp: true }, "high");

  assert.ok(k.engel, "okunamayan konum yanıtı yükseltmeyi taşıyamaz");
  assert.equal(k.kademe, undefined, "KRİTİK: yükseltme verilmemeli");
  assert.ok(
    !(k.iz.kademeDogrulayan ?? []).includes("loc"),
    `okunamayan halka kefil listesine giremez (gelen: ${(k.iz.kademeDogrulayan ?? []).join(",")})`
  );
});

/* ── 2) Sessiz çağrı yönlendirme halkasına KEFİL YOKTUR ───────────────────────── */

for (const [ad, secenek] of [
  ["501 fırlatıyor", { cfPatlasin: true }],
  ["active alanı okunamıyor", { cf: undefined }],
] as const) {
  test(`KRİTİK: çağrı yönlendirme halkası sessizken (${ad}) YÜKSELTME YAPILMAZ`, async () => {
    /**
     * Ters teşvik buydu: yönlendirmenin AÇIK olduğu BİLİNDİĞİNDE kademe bilerek yasak
     * (yükseltmeyi saldırganın kanalına göndermek olurdu), ama açık olup olmadığı
     * BİLİNEMEDİĞİNDE kademe serbestti — bilinmeyen, bilinenden daha müsamahalı muamele
     * görüyordu. Kefiller (simSwap/loc/devSwap) yönlendirmeyi ZATEN göremez.
     */
    const eskiError = console.error;
    console.error = () => {};
    try {
      kanallar(secenek);
      const k = await agDogrula(TAM_ZINCIR, "high");

      assert.ok(k.engel, "hiçbir halkanın göremediği sinyal yükseltilemez");
      assert.equal(k.kademe, undefined, "KRİTİK: sessiz yönlendirme kontrolü kademeye taşınamaz");
      assert.equal(k.iz.kademe, undefined);
      assert.equal(k.iz.retNedeni, "ag-yanitsiz", "yapısal iz doğru nedeni taşımalı");
      assert.match(k.engel!, /kefil olabilecek türden değil/, "ret sebebi ilgisiz kefaleti söylemeli");
    } finally {
      console.error = eskiError;
    }
  });
}

test("kapsam denetimi: SESSİZ KALAN BAŞKA bir halka hâlâ yükseltilebilir", async () => {
  /**
   * Düzeltme dar olmalı: "ag-yanitsiz" toptan kademe dışına atılsaydı mentörün adlandırdığı
   * yol (sessiz ağ = düz ret değil, daha güçlü doğrulama) kapanırdı. Yalnız KENDİSİNİ
   * ÇÜRÜTECEK halkası olmayan sessizlik kapatıldı.
   */
  kanallar({ sim: undefined });
  const k = await agDogrula(TAM_ZINCIR, "high");

  assert.equal(k.engel, undefined, "diğer halkalar çürütebiliyorsa yükseltme sürmeli");
  assert.equal(k.kademe?.neden, "ag-yanitsiz");
  assert.deepEqual(k.kademe!.dogrulayan, ["loc", "devSwap", "callFwd"], "kefiller halkaya göre seçilmeli");
});

test("kefil tablosu: sessiz ÇAĞRI YÖNLENDİRME halkasının kefil kümesi BOŞ", () => {
  assert.deepEqual(
    [...YANITSIZ_KEFIL_ESLEMESI.callFwd],
    [],
    "çağrı yönlendirmeyi hiçbir halka göremez: sessizliğine kefil olunamaz"
  );
  for (const [halka, kefiller] of Object.entries(YANITSIZ_KEFIL_ESLEMESI)) {
    assert.ok(!kefiller.includes(halka), `'${halka}' kendi sessizliğine kefil görünüyor`);
    assert.ok(!kefiller.includes("reach"), `'${halka}' satırında canlılık sinyali kefil görünüyor`);
    assert.ok(!kefiller.includes("nv"), `'${halka}' satırında simüle NV kefil görünüyor`);
  }
});

/* ── 3) Yükseltme açıklaması NEDENDEN türer, halkadan değil ───────────────────── */

const SUCLAMALAR = [
  /SIM kartı yakın zamanda değişmiş/,
  /şebekeden erişilemez durumda/,
  /beklenen ülke dışında/,
  /cihazı yakın zamanda değişmiş/,
];

for (const [ad, secenek, beklenenAd] of [
  ["simSwap", { sim: undefined }, "SIM Swap"],
  ["reach", { reach: undefined }, "cihaz erişilebilirlik"],
  ["devSwap", { dev: undefined }, "cihaz değişimi"],
] as const) {
  test(`KRİTİK: '${ad}' okunamaz yanıt verdiğinde açıklama SAPTAMA İDDİA ETMEZ`, async () => {
    /**
     * Ölçülen kayma: iz.retNedeni="ag-yanitsiz" iken insana gösterilen başlık
     * "⚠ AĞ SİNYALİ BOZUK — onaylayıcının SIM kartı yakın zamanda değişmiş." oluyordu.
     * Hiçbir SIM değişimi SAPTANMADI; sorgu yalnızca cevaplanamadı. İnsan, olmayan bir
     * olguya onay veriyordu; denetim günlüğü ise başka bir şey yazıyordu.
     */
    kanallar(secenek);
    const k = await agDogrula(TAM_ZINCIR, "high");

    assert.equal(k.iz.retNedeni, "ag-yanitsiz");
    assert.ok(k.kademe, "bu vaka yükseltme ile geçmeli (yoksa test kendi konusunu ölçmüyor)");
    for (const suclama of SUCLAMALAR) {
      assert.doesNotMatch(
        k.kademe!.aciklama,
        suclama,
        `cevaplanamayan kontrol bir SAPTAMA gibi anlatılamaz (gelen: ${k.kademe!.aciklama})`
      );
    }
    assert.match(k.kademe!.aciklama, /okunabilir yanıt alınamadı/, "gerçekte ne olduğu yazılmalı");
    assert.ok(
      k.kademe!.aciklama.startsWith(beklenenAd),
      `susan halka adıyla anılmalı (gelen: ${k.kademe!.aciklama})`
    );
    assert.ok(
      k.kanit.some((s) => /KADEMELİ DOĞRULAMA/.test(s) && /okunabilir yanıt alınamadı/.test(s)),
      "insana giden kanıt satırı da aynı metni taşımalı"
    );
  });
}

test("KRİTİK (uçtan uca): onay istemi, GÖZLENMEMİŞ bir SIM değişimi iddia etmez", async () => {
  kanallar({ sim: undefined });
  const sorulanlar: string[] = [];

  const sonuc = await onayAl(
    istemKaydedenSunucu(sorulanlar),
    {
      eylem: "kampanya YAYINA ALINACAK",
      satirlar: ["Günlük bütçe: 50"],
      risk: "high",
      agAyar: TAM_ZINCIR,
    },
    undefined
  );

  assert.equal(sonuc.onaylandi, true, "yükseltme yolu insana sorularak geçmeli");
  assert.equal(sorulanlar.length, 1, "istem gerçekten gösterilmeli");
  assert.match(sorulanlar[0], /AĞ SİNYALİ BOZUK/, "bozuk sinyal insana söylenmeli");
  assert.doesNotMatch(
    sorulanlar[0],
    /SIM kartı yakın zamanda değişmiş/,
    `insana SAPTANMAMIŞ bir SIM değişimi bildirilemez (istem: ${sorulanlar[0]})`
  );
  assert.match(sorulanlar[0], /SIM Swap kontrolünden okunabilir yanıt alınamadı/);
});

test("kontrol grubu: GERÇEK saptamalarda açıklama DEĞİŞMEDİ", async () => {
  // Düzeltme yalnız "ag-yanitsiz" dalını hedefliyor; saptama metinleri aynı kalmalı.
  kanallar({ sim: true });
  const sim = await agDogrula(TAM_ZINCIR, "high");
  assert.equal(sim.kademe?.neden, "sim-degisti");
  assert.equal(sim.kademe?.aciklama, "onaylayıcının SIM kartı yakın zamanda değişmiş");

  kanallar({ dev: true });
  const dev = await agDogrula(TAM_ZINCIR, "high");
  assert.equal(dev.kademe?.neden, "cihaz-degisti");
  assert.equal(dev.kademe?.aciklama, "onaylayıcının cihazı yakın zamanda değişmiş");
});

/* ── 4-6) Yorum ↔ kod tutarlılığı: yanlış yorum bir hatadır ───────────────────── */

const KAYNAK = readFileSync(fileURLToPath(new URL("../src/networkTrust.ts", import.meta.url)), "utf8");
/** Blok yorumların satır başlarındaki " * " kaldırılır: cümleler satır sonlarında kesilmesin. */
const DUZ = KAYNAK.replace(/\r?\n[ \t]*\*[ \t]?/g, " ");

test("yorum: kademeli doğrulama artık VAR OLMAYAN 'indirilmiş tavan' telafisini vaat etmiyor", () => {
  /**
   * Dört yorum, yükseltmenin karşılığında işlemin "indirilmiş bir tavana" bağlandığını
   * söylüyordu. Kodda tavanı indiren hiçbir şey yok: KademeKarari tavan taşımıyor,
   * OnaySonucu yükseltmeyi çağırana hiç iletmiyor, onaySonrasiKelepce kiracının
   * DEĞİŞMEMİŞ maxDailyBudget'ıyla çalışıyor. Var olmayan bir telafi edici kontrol vaat
   * etmek, kapıyı olduğundan güçlü gösterir.
   */
  assert.doesNotMatch(
    DUZ,
    /lowered ceiling|lowers the ceiling/i,
    "networkTrust.ts hâlâ 'indirilmiş tavan' vaat ediyor; kodda tavanı indiren bir satır yok"
  );
  assert.match(
    DUZ,
    /does NOT lower any spending ceiling|No spending ceiling is lowered/i,
    "telafinin gerçekte ne olduğu (ve ne OLMADIĞI) açıkça yazılmalı"
  );
});

test("yorum: 'bir halkanın reddi KESİNDİR' değişmezi AEGIS_STEPUP'a bağlanmış", () => {
  /**
   * Kapalı kademede doğru, açık kademede yanlış olan bir değişmez KOŞULSUZ ilan ediliyordu.
   * Ölçüldü: stepUp açıkken gerçek bir `swapped:true` engel ÜRETMİYOR, iz.kademe
   * "yukseltildi" oluyor — yani sonraki halkalar birincinin reddini yumuşatıyor.
   */
  const bildirimler = [...DUZ.matchAll(/refusal is FINAL|a swapped SIM already refuses the action/gi)];
  assert.ok(bildirimler.length >= 2, "her iki değişmez cümlesi de yerinde durmalı (yol bayatlamış olabilir)");
  for (const m of bildirimler) {
    const onceki = DUZ.slice(Math.max(0, m.index! - 220), m.index!);
    assert.match(
      onceki,
      /AEGIS_STEPUP/,
      `"${DUZ.slice(m.index!, m.index! + 60)}..." koşulsuz ilan edilmiş: AEGIS_STEPUP açıkken bu ` +
        "değişmez geçerli değil, kademeye uygun ret beklemeye alınır ve yükseltilebilir"
    );
  }
});

test("yorum: dosya başı risk katmanının HANGİ HALKALARIN koştuğunu belirlediğini söylüyor", () => {
  /**
   * Dosya başı tek halkalı sürümden kalma cümleyi taşıyordu: "risk katmanları yalnız
   * geriye bakış penceresini değiştirir, karar mantığını değil". Bugün RISK_HALKA_ESLEMESI
   * medium için yalnız ["simSwap"] döndürüyor — yani 6 halkanın 5'i hiç koşmuyor. Bu bir
   * pencere daralması değil, karar mantığının kendisi.
   */
  assert.doesNotMatch(
    DUZ,
    /Risk tiers widen the lookback window rather than change the decision logic/i,
    "dosya başı hâlâ tek halkalı sürümün cümlesini taşıyor"
  );
  const bas = DUZ.slice(0, DUZ.indexOf("Link 2 of the trust chain"));
  assert.match(bas, /RISK_HALKA_ESLEMESI/, "tek kaynak adıyla anılmalı");
  assert.match(bas, /WHICH LINKS RUN/i, "risk katmanının ikinci işi açıkça yazılmalı");
});
