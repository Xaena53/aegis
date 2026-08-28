// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Güven zincirinin 3. ve 4. halkaları: Device Reachability + Location (beklenen ülke).
 *
 * SIM Swap "hat ele geçirildi mi?", NV "onay sahibin cihazından mı geliyor?" sorularını
 * cevaplar. Bu iki halka sıradakileri sorar: "onaylayıcının cihazına şu an ağdan
 * ulaşılabiliyor mu?" ve "hat beklenen ülkenin DIŞINDA bir ülkede mi?". NV'nin aksine
 * ikisinin de GERÇEK CAMARA kanalı vardır (telefon numarası yeter, cihaz-taraflı OIDC
 * gerekmez), simülasyon kanalları yalnızca token'sız demo içindir.
 *
 * Merkezi iddialar:
 *  - Her iki halka da YALNIZ "high" katmanda koşar; medium'da "anormal"/"beklenmedik"
 *    bile karar üretmez.
 *  - Zincir sırası TEK YÖNLÜDÜR: önceki halkanın reti kesindir, sonraki halka ne koşar
 *    ne de o kararı yumuşatır.
 *  - Beklenti UYDURULMAZ: ADSPILOT_EXPECTED_COUNTRY yoksa konum halkası koşmaz ("kapali"
 *    izi), varsayılan bir ülke türetilmez.
 *  - Erişilebilirlik halkasının GERÇEK kanalı OPT-IN'dir: ADSPILOT_REACH_CHECK açılmadıkça
 *    NaC token'ı olsa bile sorgu yapılmaz (meşru dalgalanmanın yanlış-pozitif reti).
 *  - HAM DEĞER YANKILANMAZ: ne ham env değeri, ne upstream hata metni, ne de ağdan gelen
 *    GÖZLENEN ülke ajana giden hiçbir metne girer.
 *  - Yapısal iz dört halkayı AYRI alanlarda taşır; tek alana ezilmez.
 *
 * Fail-closed değişmezi: buradaki hiçbir senaryo mevcut kapıyı gevşetmez.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { sahteContext } from "./helpers/harness.js";
import { onayAl } from "../src/approval.js";
import {
  agDogrula,
  __setErisimKanalForTests,
  __setKonumKanalForTests,
  __setSimSwapKanalForTests,
} from "../src/networkTrust.js";

const MUSTERI = "1234567890";
const KAMPANYA = "24120539226";
const TELEFON = "+905551112233";
const MASKELI = "+905*******33";

/** Bilerek token'sız/simülasyonsuz: yeni halkaların SIM-Swap katmanından bağımsızlığı görünsün. */
const TEMEL = { approverPhone: TELEFON, simSwapWindowHours: 72 };

/** Gerçek SIM-Swap kanalı gerektiren senaryolarda 1. halkayı temiz geçirir. */
function simSwapTemiz(): void {
  __setSimSwapKanalForTests({ verifySimSwap: async () => false });
}

// Kanal override'ları modül-global: her testten sonra üçünü de sıfırla, yoksa sızarlar.
afterEach(() => {
  __setSimSwapKanalForTests(undefined);
  __setErisimKanalForTests(undefined);
  __setKonumKanalForTests(undefined);
});

/* ── Halka 3: SİMÜLASYON kanalı ───────────────────────────────────────────────── */

test("reach: 'erisilebilir' kanıt satırı ekler — SİMÜLASYON ibareli, maskeli, gerçek sorgu YAPILMADI", async () => {
  const k = await agDogrula({ ...TEMEL, reachSimulate: "erisilebilir" }, "high");
  assert.equal(k.engel, undefined);
  // 1. halka kapalı (token yok) kendi dürüst satırını yazar; 3. halka onun ÜSTÜNE eklenir.
  assert.equal(k.kanit.length, 2, "erişilebilirlik halkası SIM-Swap kapalıyken de koşmalı");
  assert.match(k.kanit[0], /Ağ doğrulaması: kapalı/);
  assert.match(k.kanit[1], /Cihaz erişilebilirliği/);
  assert.match(k.kanit[1], /SİMÜLASYON/, "her simüle metin SİMÜLASYON ibaresi taşımalı");
  assert.match(k.kanit[1], /YAPILMADI/, "gerçek ağ sorgusu gibi sunulamaz");
  assert.match(k.kanit[1], /\+905\*+33/, "numara maskeli görünmeli");
  assert.doesNotMatch(k.kanit[1], /5551112233/, "tam numara sızmamalı");
  assert.equal(k.iz.reach, "simulasyon");
  assert.equal(k.iz.maskeliNumara, MASKELI);
});

test("reach: 'anormal' SERT RET — SIM ve NV temiz olsa bile onay istemi hiç gösterilmez", async () => {
  const k = await agDogrula(
    { ...TEMEL, nacSimulate: "temiz", nvSimulate: "dogrulandi", reachSimulate: "anormal" },
    "high"
  );
  assert.ok(k.engel, "3. halka fail-open olamaz");
  assert.match(k.engel!, /SİMÜLASYON/);
  assert.match(k.engel!, /CİHAZ ERİŞİLEBİLİRLİĞİ ANORMAL/);
  assert.match(k.engel!, /gerçek ağ sorgusu YAPILMADI/);
  assert.match(k.engel!, /\+905\*+33/);
  assert.doesNotMatch(k.engel!, /5551112233/, "tam numara ret metnine sızmamalı");
  assert.equal(k.kanit.length, 0, "ret hâlinde önceki halkaların temiz kanıtı bile taşınmaz");
  assert.equal(k.iz.retNedeni, "cihaz-erisilemez");
  assert.equal(k.iz.simSwap, "simulasyon", "önceki halkaların izi silinmez");
  assert.equal(k.iz.nv, "simulasyon");
  assert.equal(k.iz.reach, "simulasyon");
});

test("reach: tanınmayan simülasyon değeri karar anında RET — ham env değeri YANKILANMAZ", async () => {
  const k = await agDogrula({ ...TEMEL, reachSimulate: "sanirim-aciktir" }, "high");
  assert.ok(k.engel, "tanınmayan değer fail-open olamaz");
  assert.match(k.engel!, /ADSPILOT_REACH_SIMULATE/);
  assert.match(k.engel!, /tanınmadı/);
  assert.match(k.engel!, /"erisilebilir" \| "anormal"/, "geçerli değerler operatöre söylenmeli");
  assert.doesNotMatch(k.engel!, /sanirim-aciktir/, "ham env değeri ret metnine yankılanmaz");
  assert.equal(k.kanit.length, 0);
  assert.equal(k.iz.reach, "calismadi", "yapılandırma hatası 'kapali' ile karıştırılamaz");
  assert.equal(k.iz.retNedeni, "simulasyon-degeri-tanimsiz");
  assert.equal(k.iz.maskeliNumara, undefined, "hiç değerlendirilmeyen numara ize yazılmaz");
});

test("reach: approverPhone yoksa kapalı arıza — sorgulanacak numara olmadan halka çalışmaz", async () => {
  const k = await agDogrula({ simSwapWindowHours: 72, reachSimulate: "erisilebilir" }, "high");
  assert.ok(k.engel);
  assert.match(k.engel!, /SİMÜLASYON/);
  assert.match(k.engel!, /ADSPILOT_APPROVER_PHONE/);
  assert.equal(k.kanit.length, 0);
  assert.equal(k.iz.reach, "calismadi");
  assert.equal(k.iz.retNedeni, "onaylayici-numarasi-yok");
});

/* ── Halka 3: GERÇEK CAMARA kanalı ────────────────────────────────────────────── */

test("reach: gerçek kanal — erişilebilir GEÇER, erişilemez SERT REDDEDER ('gercek' izi)", async () => {
  simSwapTemiz();
  let cagriSayisi = 0;
  __setErisimKanalForTests({
    cihazErisilebilirMi: async () => {
      cagriSayisi++;
      return true;
    },
  });
  const gecti = await agDogrula({ ...TEMEL, nacToken: "gercek-token", reachCheck: true }, "high");
  assert.equal(gecti.engel, undefined);
  assert.equal(cagriSayisi, 1, "gerçek sorgu gerçekten yapılmalı");
  assert.equal(gecti.kanit.length, 2);
  assert.match(gecti.kanit[1], /Cihaz erişilebilirliği: /);
  assert.match(gecti.kanit[1], /GSMA Open Gateway/);
  assert.doesNotMatch(gecti.kanit[1], /SİMÜLASYON/, "gerçek halka simüle gibi etiketlenmemeli");
  assert.equal(gecti.iz.reach, "gercek");

  __setErisimKanalForTests({ cihazErisilebilirMi: async () => false });
  const ret = await agDogrula({ ...TEMEL, nacToken: "gercek-token", reachCheck: true }, "high");
  assert.ok(ret.engel);
  assert.match(ret.engel!, /ERİŞİLEMİYOR/);
  assert.doesNotMatch(ret.engel!, /SİMÜLASYON/, "gerçek ret simülasyon diye etiketlenemez");
  assert.equal(ret.kanit.length, 0);
  assert.equal(ret.iz.reach, "gercek");
  assert.equal(ret.iz.retNedeni, "cihaz-erisilemez");
});

test("reach: okunamayan yanıt ve fırlatma KAPALI ARIZA — upstream metin ajana YANKILANMAZ", async () => {
  simSwapTemiz();
  const AYAR = { ...TEMEL, nacToken: "gercek-token", reachCheck: true };

  // (1) Yanıt geldi ama alan okunamadı: "erişilebilir" varsaymak sessiz gevşeme olurdu.
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => undefined });
  const okunamadi = await agDogrula(AYAR, "high");
  assert.ok(okunamadi.engel, "okunamayan yanıt fail-open olamaz");
  assert.match(okunamadi.engel!, /okunabilir yanıt alınamadı/);
  assert.equal(okunamadi.iz.retNedeni, "ag-yanitsiz");
  assert.notEqual(okunamadi.iz.retNedeni, "cihaz-erisilemez", "okunamayan yanıt yanlış suçlama üretmez");

  // (2) Kanal fırlattı: SDK hata gövdesi numarayı aynen taşıyabilir (CAMARA 4xx yankısı).
  const eskiError = console.error;
  const stderr: string[] = [];
  console.error = (...a: unknown[]) => void stderr.push(a.map(String).join(" "));
  try {
    __setErisimKanalForTests({
      cihazErisilebilirMi: async () => {
        throw new Error(`CAMARA 400: invalid phoneNumber ${TELEFON}`);
      },
    });
    const hata = await agDogrula(AYAR, "high");
    assert.ok(hata.engel);
    assert.match(hata.engel!, /yanıt alınamadı/);
    assert.doesNotMatch(hata.engel!, /5551112233/, "ham numara ret metnine sızmamalı");
    assert.doesNotMatch(hata.engel!, /CAMARA 400/, "upstream hata metni ajana yankılanmaz");
    assert.equal(hata.iz.reach, "gercek", "sorgu DENENDİ: 'calismadi' ile karıştırılamaz");
    assert.equal(hata.iz.retNedeni, "ag-yanitsiz");
    assert.equal(stderr.length, 1, "ayrıntı operatöre stderr'den gitmeli");
    assert.doesNotMatch(stderr[0], /5551112233/, "numara stderr'de bile maskelenmeli");
  } finally {
    console.error = eskiError;
  }
});

test("reach: gerçek kanal OPT-IN — ADSPILOT_REACH_CHECK kapalıyken SORGU YOK, iz 'kapali'", async () => {
  simSwapTemiz();
  let cagriSayisi = 0;
  __setErisimKanalForTests({
    cihazErisilebilirMi: async () => {
      cagriSayisi++;
      return false; // açık olsaydı REDDEDERDİ; kapalıyken kararı hiç etkilememeli
    },
  });
  const k = await agDogrula({ ...TEMEL, nacToken: "gercek-token" }, "high");
  assert.equal(cagriSayisi, 0, "anahtar kapalıyken CAMARA'ya hiç sorulmamalı");
  assert.equal(k.engel, undefined, "istenmemiş bir halka harcamayı reddedemez");
  assert.equal(k.iz.reach, "kapali", "sessiz kalmak 'sordum ve geçti' ile karışırdı");
  assert.equal(k.kanit.length, 1, "kapalı halka insan istemine gürültü satırı eklemez");
  assert.match(k.kanit[0], /SIM değişimi yok/, "tek kanıt 1. halkanınki olmalı");

  // Kontrol: tek fark anahtar olduğunda aynı kanal gerçekten reddediyor.
  const acik = await agDogrula({ ...TEMEL, nacToken: "gercek-token", reachCheck: true }, "high");
  assert.match(acik.engel!, /ERİŞİLEMİYOR/);
  assert.equal(cagriSayisi, 1);
});

test("reach: çelişki YALNIZ gerçek kanal AÇIKKEN vardır — anahtar kapalıyken demo serbesttir", async () => {
  simSwapTemiz();
  const celiski = await agDogrula(
    { ...TEMEL, nacToken: "gercek-token", reachCheck: true, reachSimulate: "erisilebilir" },
    "high"
  );
  assert.ok(celiski.engel, "belirsizlikte gevşek kanal SEÇİLMEZ");
  assert.match(celiski.engel!, /çelişkili yapılandırma/);
  assert.match(celiski.engel!, /ADSPILOT_REACH_CHECK/);
  assert.equal(celiski.iz.reach, "calismadi");
  assert.equal(celiski.iz.retNedeni, "yapilandirma-celiskili");

  // Anahtar kapalıyken sorgulanacak gerçek kanal yoktur: simülasyon hiçbir gerçek
  // doğrulamayı tiyatroya çevirmez, dolayısıyla çelişki de yoktur.
  const demo = await agDogrula(
    { ...TEMEL, nacToken: "gercek-token", reachSimulate: "anormal" },
    "high"
  );
  assert.match(demo.engel!, /CİHAZ ERİŞİLEBİLİRLİĞİ ANORMAL/, "karar simüle halkanın olmalı");
  assert.equal(demo.iz.reach, "simulasyon");
});

/* ── Halka 4: beklenti yapılandırması ─────────────────────────────────────────── */

test("loc: ADSPILOT_EXPECTED_COUNTRY yoksa halka KOŞMAZ — beklenen ülke UYDURULMAZ", async () => {
  simSwapTemiz();
  let cagriSayisi = 0;
  __setKonumKanalForTests({
    ulkeDurumu: async () => {
      cagriSayisi++;
      return { yurtDisinda: true, ulkeler: ["NL"] };
    },
  });
  const k = await agDogrula({ ...TEMEL, nacToken: "gercek-token" }, "high");
  assert.equal(cagriSayisi, 0, "beklenti yokken karşılaştırılacak bir şey de yok: sorgu YAPILMAZ");
  assert.equal(k.engel, undefined, "beklentisi olmayan halka harcamayı reddedemez");
  assert.equal(k.iz.loc, "kapali", "koşmayan halka izde 'kapali' der, sessiz kalmaz");
  assert.equal(k.kanit.length, 1, "kapalı halka kanıt satırı yazmaz");
  assert.doesNotMatch(k.kanit[0], /Konum doğrulaması/);

  // Kontrol: tek fark beklenti olduğunda halka gerçekten koşuyor ve reddediyor.
  const beklentili = await agDogrula(
    { ...TEMEL, nacToken: "gercek-token", expectedCountry: "TR" },
    "high"
  );
  assert.equal(cagriSayisi, 1);
  assert.match(beklentili.engel!, /DIŞINDA bir ülkede/);
});

test("loc: geçersiz ülke kodu KAPALI ARIZA — ham değer ret metnine yankılanmaz", async () => {
  for (const bozuk of ["Türkiye", "TRX", "T", "90"]) {
    const k = await agDogrula({ ...TEMEL, locSimulate: "beklenen", expectedCountry: bozuk }, "high");
    assert.ok(k.engel, `'${bozuk}' fail-open olamaz`);
    assert.match(k.engel!, /ADSPILOT_EXPECTED_COUNTRY/);
    assert.match(k.engel!, /ISO 3166-1 alpha-2/, "operatöre beklenen biçim söylenmeli");
    assert.equal(k.iz.loc, "calismadi", "yapılandırma hatası 'kapali' değildir");
    assert.equal(k.iz.retNedeni, "beklenen-ulke-gecersiz");
  }
  const uzun = await agDogrula(
    { ...TEMEL, locSimulate: "beklenen", expectedCountry: "Türkiye" },
    "high"
  );
  assert.doesNotMatch(uzun.engel!, /Türkiye/, "ham env değeri ret metnine yankılanmaz");
});

test("loc: NAC token + ADSPILOT_LOC_SIMULATE birlikte tanımlıysa çelişki RET", async () => {
  simSwapTemiz();
  const k = await agDogrula(
    { ...TEMEL, nacToken: "gercek-token", locSimulate: "beklenen", expectedCountry: "TR" },
    "high"
  );
  assert.ok(k.engel);
  assert.match(k.engel!, /çelişkili yapılandırma/);
  assert.equal(k.iz.loc, "calismadi");
  assert.equal(k.iz.retNedeni, "yapilandirma-celiskili");
  assert.equal(k.iz.reach, "kapali", "önceki halkanın izi korunur (token var, anahtar kapalı)");
});

/* ── Halka 4: SİMÜLASYON kanalı ───────────────────────────────────────────────── */

test("loc: 'beklenen' kanıt yazar, 'beklenmedik' SERT REDDEDER — ikisi de SİMÜLASYON ibareli", async () => {
  const gecti = await agDogrula(
    { ...TEMEL, locSimulate: "beklenen", expectedCountry: "tr" },
    "high"
  );
  assert.equal(gecti.engel, undefined);
  assert.equal(gecti.kanit.length, 2);
  assert.match(gecti.kanit[1], /Konum doğrulaması \[SİMÜLASYON\]/);
  assert.match(gecti.kanit[1], /\(TR\)/, "beklenen ülke normalize edilmiş biçimde görünmeli");
  assert.match(gecti.kanit[1], /YAPILMADI/);
  assert.match(gecti.kanit[1], /\+905\*+33/);
  assert.equal(gecti.iz.loc, "simulasyon");

  const ret = await agDogrula(
    { ...TEMEL, locSimulate: "beklenmedik", expectedCountry: "TR" },
    "high"
  );
  assert.ok(ret.engel);
  assert.match(ret.engel!, /KONUM BEKLENMEDİK/);
  assert.match(ret.engel!, /SİMÜLASYON/);
  assert.match(ret.engel!, /gerçek ağ sorgusu YAPILMADI/);
  assert.doesNotMatch(ret.engel!, /5551112233/);
  assert.equal(ret.kanit.length, 0);
  assert.equal(ret.iz.loc, "simulasyon");
  assert.equal(ret.iz.retNedeni, "konum-beklenmedik");

  const tanimsiz = await agDogrula(
    { ...TEMEL, locSimulate: "belki-oradadir", expectedCountry: "TR" },
    "high"
  );
  assert.match(tanimsiz.engel!, /"beklenen" \| "beklenmedik"/);
  assert.doesNotMatch(tanimsiz.engel!, /belki-oradadir/, "ham env değeri yankılanmaz");
  assert.equal(tanimsiz.iz.retNedeni, "simulasyon-degeri-tanimsiz");
});

/* ── Halka 4: GERÇEK CAMARA kanalı ────────────────────────────────────────────── */

test("loc: gerçek kanal — roaming yokken ve beklenen ülkede roaming'de GEÇER", async () => {
  simSwapTemiz();
  const AYAR = { ...TEMEL, nacToken: "gercek-token", expectedCountry: "TR" };

  __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false }) });
  const evde = await agDogrula(AYAR, "high");
  assert.equal(evde.engel, undefined, "ana şebekede olan hat beklenmedik coğrafya değildir");
  assert.match(evde.kanit[1], /yurt dışında değil/);
  assert.match(evde.kanit[1], /\(TR\)/);
  assert.doesNotMatch(evde.kanit[1], /SİMÜLASYON/);
  assert.equal(evde.iz.loc, "gercek");

  // Yabancı SIM beklenen ülkeye roaming yapıyor olabilir; karşılaştırma büyük/küçük
  // harf ve boşluktan bağımsızdır.
  __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: true, ulkeler: [" tr "] }) });
  const beklenenUlkede = await agDogrula(AYAR, "high");
  assert.equal(beklenenUlkede.engel, undefined);
  assert.match(beklenenUlkede.kanit[1], /beklenen ülkede \(TR\)/);
  assert.equal(beklenenUlkede.iz.loc, "gercek");
});

test("KRİTİK loc: beklenmedik ülke REDDEDER ve GÖZLENEN ülke ASLA yankılanmaz", async () => {
  simSwapTemiz();
  __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: true, ulkeler: ["NL", "BE"] }) });
  const k = await agDogrula(
    { ...TEMEL, nacToken: "gercek-token", expectedCountry: "TR" },
    "high"
  );
  assert.ok(k.engel, "beklenmedik coğrafya fail-open olamaz");
  assert.match(k.engel!, /AĞ DOĞRULAMASI BAŞARISIZ/);
  assert.match(k.engel!, /DIŞINDA bir ülkede/);
  assert.match(k.engel!, /\(TR\)/, "yapılandırmadan gelen beklenti gösterilebilir");
  assert.doesNotMatch(k.engel!, /NL/, "ağdan gelen gözlenen ülke ajana yankılanmaz");
  assert.doesNotMatch(k.engel!, /BE/, "ikinci gözlenen ülke de yankılanmaz");
  assert.doesNotMatch(k.engel!, /5551112233/);
  assert.equal(k.kanit.length, 0);
  assert.equal(k.iz.loc, "gercek");
  assert.equal(k.iz.retNedeni, "konum-beklenmedik");
  // İz de ham veri taşımaz: yalnız maskeli numara ve sabit ret kodu.
  assert.equal(k.iz.maskeliNumara, MASKELI);
});

test("loc: okunamayan roaming alanı ve boş ülke listesi KAPALI ARIZAYA gider", async () => {
  simSwapTemiz();
  const AYAR = { ...TEMEL, nacToken: "gercek-token", expectedCountry: "TR" };

  // roaming alanı tipte zorunlu ama çalışma zamanı garantisi değil: okunamazsa karar yok.
  __setKonumKanalForTests({ ulkeDurumu: async () => ({}) });
  const okunamadi = await agDogrula(AYAR, "high");
  assert.ok(okunamadi.engel);
  assert.match(okunamadi.engel!, /okunabilir yanıt alınamadı/);
  assert.equal(okunamadi.iz.retNedeni, "ag-yanitsiz");
  assert.notEqual(okunamadi.iz.retNedeni, "konum-beklenmedik", "okunamayan yanıt yanlış suçlama üretmez");

  // Yurt dışında ama MCC hiçbir ülkeye eşlenmemiş: beklentiyle karşılaştırılamaz.
  __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: true, ulkeler: [] }) });
  const ulkesiz = await agDogrula(AYAR, "high");
  assert.ok(ulkesiz.engel, "karşılaştırılamayan konum geçirilemez");
  assert.match(ulkesiz.engel!, /ülke ağdan okunamadı/);
  assert.equal(ulkesiz.iz.retNedeni, "ag-yanitsiz");

  const eskiError = console.error;
  console.error = () => {};
  try {
    __setKonumKanalForTests({
      ulkeDurumu: async () => {
        throw new Error(`upstream patladı: ${TELEFON}`);
      },
    });
    const hata = await agDogrula(AYAR, "high");
    assert.ok(hata.engel);
    assert.doesNotMatch(hata.engel!, /upstream patladı/, "upstream metin ajana yankılanmaz");
    assert.doesNotMatch(hata.engel!, /5551112233/);
    assert.equal(hata.iz.loc, "gercek", "sorgu DENENDİ");
    assert.equal(hata.iz.retNedeni, "ag-yanitsiz");
  } finally {
    console.error = eskiError;
  }
});

/* ── Zincir sırası ve katman ───────────────────────────────────────────────────── */

test("KRİTİK zincir: önceki halkanın reti KESİNDİR — sonraki halkalar hiç koşmaz", async () => {
  simSwapTemiz();
  let reachCagri = 0;
  let locCagri = 0;
  __setErisimKanalForTests({
    cihazErisilebilirMi: async () => {
      reachCagri++;
      return true; // "temiz" bir sonraki halka önceki reti YUMUŞATAMAMALI
    },
  });
  __setKonumKanalForTests({
    ulkeDurumu: async () => {
      locCagri++;
      return { yurtDisinda: false };
    },
  });

  // (1) SIM reti: 3. ve 4. halka ne koşar ne de kararı çevirir.
  const simReti = await agDogrula(
    { ...TEMEL, nacSimulate: "degisti", reachCheck: true, expectedCountry: "TR" },
    "high"
  );
  assert.match(simReti.engel!, /SIM kartı son 72 saat içinde değişmiş/, "karar 1. halkanın olmalı");
  assert.equal(simReti.iz.retNedeni, "sim-degisti");
  assert.equal(simReti.iz.reach, undefined, "1. halka reddettiyse 3. halka hiç koşmaz");
  assert.equal(simReti.iz.loc, undefined);
  assert.equal(reachCagri + locCagri, 0, "hiçbir sonraki halka ağa sormamalı");

  // (2) NV reti: 3. ve 4. halka yine koşmaz.
  const nvReti = await agDogrula(
    { ...TEMEL, nacSimulate: "temiz", nvSimulate: "uyusmadi", reachCheck: true, expectedCountry: "TR" },
    "high"
  );
  assert.match(nvReti.engel!, /NUMARA DOĞRULAMASI BAŞARISIZ/);
  assert.equal(nvReti.iz.retNedeni, "nv-uyusmadi");
  assert.equal(nvReti.iz.reach, undefined);
  assert.equal(nvReti.iz.loc, undefined);
  assert.equal(reachCagri + locCagri, 0);

  // (3) Reachability reti: 4. halka koşmaz, temiz konum kararı reti yumuşatamaz.
  const reachReti = await agDogrula(
    { ...TEMEL, nacSimulate: "temiz", reachSimulate: "anormal", locSimulate: "beklenen", expectedCountry: "TR" },
    "high"
  );
  assert.match(reachReti.engel!, /CİHAZ ERİŞİLEBİLİRLİĞİ ANORMAL/, "karar 3. halkanın olmalı");
  assert.equal(reachReti.iz.retNedeni, "cihaz-erisilemez");
  assert.equal(reachReti.iz.loc, undefined, "3. halka reddettiyse 4. halka hiç koşmaz");
  assert.equal(reachReti.kanit.length, 0, "temiz konum kanıtı bir retin yanına ASLA eklenmez");
  assert.equal(locCagri, 0);
});

test("katman: reach ve loc YALNIZ high'ta koşar — medium'da 'anormal'/'beklenmedik' bile karar üretmez", async () => {
  const m = await agDogrula(
    {
      ...TEMEL,
      nacSimulate: "temiz",
      reachSimulate: "anormal",
      locSimulate: "beklenmedik",
      expectedCountry: "TR",
    },
    "medium"
  );
  assert.equal(m.engel, undefined, "medium'da bu halkalar koşmadığı için reddedemez");
  assert.equal(m.kanit.length, 1, "medium'da yalnız SIM-Swap kanıtı olmalı");
  assert.doesNotMatch(m.kanit[0], /Cihaz erişilebilirliği/);
  assert.doesNotMatch(m.kanit[0], /Konum doğrulaması/);
  assert.equal(m.iz.reach, undefined, "koşmayan halkanın alanı HİÇ yoktur");
  assert.equal(m.iz.loc, undefined);

  // Aynı katmanda bozuk değerler de karar üretmez: halka orada YOK, gevşemiş değil.
  const bozuk = await agDogrula(
    { ...TEMEL, reachSimulate: "her ne ise", locSimulate: "her ne ise", expectedCountry: "geçersiz" },
    "medium"
  );
  assert.equal(bozuk.engel, undefined);
  assert.equal(bozuk.iz.reach, undefined);
  assert.equal(bozuk.iz.loc, undefined);

  // Kontrol: aynı yapılandırma high'a çıkınca halka koşar ve reddeder.
  const h = await agDogrula(
    { ...TEMEL, nacSimulate: "temiz", reachSimulate: "anormal", expectedCountry: "TR" },
    "high"
  );
  assert.match(h.engel!, /CİHAZ ERİŞİLEBİLİRLİĞİ ANORMAL/);
});

test("iz: DÖRT halka AYRI alanlarda durur — tek alana ezilmez, pencere yalnız SIM-Swap'ındır", async () => {
  simSwapTemiz();
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false }) });

  const k = await agDogrula(
    {
      ...TEMEL,
      nacToken: "gercek-token",
      nvSimulate: "dogrulandi",
      reachCheck: true,
      expectedCountry: "TR",
    },
    "high"
  );
  assert.equal(k.engel, undefined);
  assert.equal(k.kanit.length, 4, "koşan her halka insan istemine kendi kanıtını yazar");
  assert.equal(k.iz.simSwap, "gercek", "gerçek sorgu, simüle bir halka yüzünden indirgenemez");
  assert.equal(k.iz.nv, "simulasyon", "NV yapısal olarak yalnız simüle olabilir");
  assert.equal(k.iz.reach, "gercek");
  assert.equal(k.iz.loc, "gercek");
  assert.equal(k.iz.pencereSaat, 72, "pencere YALNIZ geriye bakış penceresi olan halkanındır");
  assert.equal(k.iz.maskeliNumara, MASKELI);
  assert.equal(k.iz.retNedeni, undefined);
});

/* ── integration: onay kapısı ve gerçek MCP protokolü üzerinden ───────────────── */

/** Onay kapısına elicitation yeteneği olan sahte bir sunucu; sorulan istemleri kaydeder. */
function istemKaydedenSunucu(sorulanlar: string[]): any {
  return {
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async (istek: any) => {
        sorulanlar.push(String(istek.message));
        return { action: "accept", content: { onay: true } };
      },
    },
  };
}

test("KRİTİK reach: 'anormal' onay kapısında İSTEM GÖSTERİLMEDEN reddeder (approval.ts uçtan uca)", async () => {
  const sorulanlar: string[] = [];
  const sonuc = await onayAl(
    istemKaydedenSunucu(sorulanlar),
    {
      eylem: "kampanya yayına alınacak",
      satirlar: ["Günlük bütçe: 50"],
      risk: "high",
      agAyar: { ...TEMEL, nacSimulate: "temiz", reachSimulate: "anormal" },
    },
    true // ajanın onay iddiası 3. halkanın retini de aşamamalı
  );
  assert.equal(sonuc.onaylandi, false);
  assert.equal(sonuc.kanal, "ag");
  assert.match(sonuc.mesaj!, /CİHAZ ERİŞİLEBİLİRLİĞİ ANORMAL/);
  assert.equal(sorulanlar.length, 0, "onay istemi HİÇ gösterilmemeli");

  // Pozitif kontrol: tek fark halkanın kararı olduğunda istem gerçekten gösteriliyor.
  const kontrol: string[] = [];
  const gecen = await onayAl(
    istemKaydedenSunucu(kontrol),
    {
      eylem: "kampanya yayına alınacak",
      satirlar: ["Günlük bütçe: 50"],
      risk: "high",
      agAyar: {
        ...TEMEL,
        nacSimulate: "temiz",
        reachSimulate: "erisilebilir",
        locSimulate: "beklenen",
        expectedCountry: "TR",
      },
    },
    undefined
  );
  assert.equal(gecen.onaylandi, true);
  assert.equal(kontrol.length, 1, "reti üreten şey istemin bastırılması değil, halkanın kararı olmalı");
  assert.match(kontrol[0], /Cihaz erişilebilirliği \[SİMÜLASYON\]/, "insan 3. halkanın kanıtını görmeli");
  assert.match(kontrol[0], /Konum doğrulaması \[SİMÜLASYON\]/, "insan 4. halkanın kanıtını görmeli");
});

async function elicitationliIstemci(ctx: any) {
  const sorulanlar: string[] = [];
  const client = new Client({ name: "halka-testi", version: "0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (req: any) => {
    sorulanlar.push(String(req.params.message));
    return { action: "accept", content: { onay: true } };
  });
  const server = buildServer(() => ctx);
  const [ist, sun] = InMemoryTransport.createLinkedPair();
  await server.connect(sun);
  await client.connect(ist);
  return { client, sorulanlar };
}

async function cagir(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const res: any = await client.callTool({ name, arguments: args });
  return String(res.content?.[0]?.text ?? "");
}

const YAYINA_HAZIR: Array<[RegExp, any[]]> = [
  [/campaign_budget\.amount_micros/, [{ campaign: { name: "Hazır" }, campaign_budget: { amount_micros: 50_000_000 } }]],
  [/FROM ad_group_ad/, [{ ad_group_ad: { ad: { id: 1 } } }]],
  [/FROM campaign_criterion/, []],
];

test("KRİTİK loc: 'beklenmedik' yayına almayı reddeder — MCP protokolü üzerinden, hiçbir yazma gitmez", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agSimulasyon: "temiz" });
  ctx.config.locSimulate = "beklenmedik";
  ctx.config.expectedCountry = "TR";
  const { client, sorulanlar } = await elicitationliIstemci(ctx);

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true,
  });

  assert.match(out, /SİMÜLASYON/, "ajanın gördüğü ret açıkça simülasyon olmalı");
  assert.match(out, /KONUM BEKLENMEDİK/);
  assert.equal(rec.mutations.length, 0, "hiçbir yazma gitmemeli");
  assert.equal(sorulanlar.length, 0, "onay istemi HİÇ gösterilmemeli");
});

test("halkalar akışı bozmaz: temiz zincir yayına almayı geçirir, insan DÖRT kanıtı da görür", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agSimulasyon: "temiz" });
  ctx.config.nvSimulate = "dogrulandi";
  ctx.config.reachSimulate = "erisilebilir";
  ctx.config.locSimulate = "beklenen";
  ctx.config.expectedCountry = "TR";
  const { client, sorulanlar } = await elicitationliIstemci(ctx);

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
  });

  assert.match(out, /YAYINDA/);
  assert.equal(rec.mutations.length, 1, "temiz zincir + insan onayı → işlem gitmeli");
  assert.match(sorulanlar[0], /SIM değişimi yok/, "1. halka kanıtı istemde olmalı");
  assert.match(sorulanlar[0], /Numara doğrulaması/, "2. halka kanıtı istemde olmalı");
  assert.match(sorulanlar[0], /Cihaz erişilebilirliği/, "3. halka kanıtı istemde olmalı");
  assert.match(sorulanlar[0], /Konum doğrulaması/, "4. halka kanıtı istemde olmalı");
});
