// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 3 — src/networkTrust.ts gözcüleri.
 *
 * Bu dosya altı ORTA şiddetli, tur-1 tarihli bulgunun her biri için bir gözcü tutar.
 * Bulguların üçü ölçüldüğünde ZATEN KAPALI çıktı (sonraki turlarda kapanmışlar); onlar
 * için de gözcü yazıldı, çünkü kapalı bir deliği hiçbir şey açık kalmaktan koruyamaz —
 * gözcü yoksa aynı delik sessizce geri gelir.
 *
 * HER GÖZCÜ ÇİFT YÖNLÜDÜR ve hangi yönden kırmızı olduğu testin başında yazılıdır:
 *   (a) KOD kayarsa kırmızı — davranış ölçülür, yorum değil.
 *   (b) BELGE/YORUM kayarsa kırmızı — cümle bugünün kodunu anlatmayı bırakırsa.
 * Tek yönlü gözcü bu programda bir kez vakum çıktı (hiçbir koşulda kırmızı olamayan bir
 * gözcü sahte güvence üretti); buradaki her testin mutasyonla kırmızı olduğu görüldü.
 *
 * Hiçbir test kapıyı gevşetmez, ağa çıkmaz, sır yazmaz.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  agDogrula,
  RISK_HALKA_ESLEMESI,
  YANITSIZ_KEFIL_ESLEMESI,
  __setCagriYonlendirmeKanalForTests,
  __setCihazDegisimKanalForTests,
  __setErisimKanalForTests,
  __setKonumKanalForTests,
  __setSimSwapKanalForTests,
} from "../src/networkTrust.js";
import type { AgAyar } from "../src/networkTrust.js";

const KAYNAK = readFileSync(
  fileURLToPath(new URL("../src/networkTrust.ts", import.meta.url)),
  "utf8"
);

const TELEFON = "+905551112233";
/** Numaranın yalnız rakamları — sızıntı üç ayrı biçimde aranır. */
const RAKAMLAR = "905551112233";
/**
 * BİLEREK ŞEKİLSİZ jeton: sağlayıcı öneki yok, JWT değil, opak-dizi eşiğinin altında.
 * Hiçbir ŞEKİL kuralı bunu yakalayamaz; onu operatörün terminalinden uzak tutan tek şey
 * DEĞERE göre maskelemedir. Gerçekçi bir `nac_tok_…` değeri, değer yolu tamamen bozuk
 * olsa bile 32 karakterlik opak kuralla maskelenirdi ve test yanlış savunmayı ölçerdi.
 */
const JETON = "TEST-ONLY-kisa-jeton";

const TEMEL: AgAyar = {
  nacToken: JETON,
  approverPhone: TELEFON,
  simSwapWindowHours: 72,
  reachCheck: true,
  devSwapCheck: true,
  callFwdCheck: true,
  expectedCountry: "TR",
  stepUp: true,
};

/** Altı halkanın hepsi GERÇEK kanaldan TEMİZ döner; her test yalnız birini bozar. */
function temizKanallar(): void {
  __setSimSwapKanalForTests({ verifySimSwap: async () => false });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setKonumKanalForTests({
    // Ağ, hattı GERÇEKTEN TR'de görmeli: hiçbir ülke gözlememiş halka kefil sayılmaz
    // (HalkaSonuc.gozlemsiz). Boş ülke listesiyle kurulan düzenek yükseltmeyi ölçmez.
    ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: ["TR"] }),
  });
  __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => false });
  __setCagriYonlendirmeKanalForTests({ kosulsuzYonlendirmeAcikMi: async () => false });
}

afterEach(() => {
  __setSimSwapKanalForTests(undefined);
  __setErisimKanalForTests(undefined);
  __setKonumKanalForTests(undefined);
  __setCihazDegisimKanalForTests(undefined);
  __setCagriYonlendirmeKanalForTests(undefined);
});

/** Dosyanın YALNIZ yorum metni; kod satırları ve dize sabitleri dışarıda kalır. */
function yorumMetni(): string {
  return KAYNAK.split("\n")
    .filter((s) => /^\s*(\/\*\*?|\*|\/\/)/.test(s))
    .map((s) => s.replace(/^\s*(\/\*\*?|\*\/|\*|\/\/)\s?/, ""))
    .join("\n");
}

/** Yorum metni, satır sonları ve girinti tek boşluğa indirilmiş — cümle aramak için. */
function yorumDuz(): string {
  return yorumMetni().replace(/\s+/g, " ");
}

/**
 * Yorum metninden ALINTILARI çıkarır. Yorumlar Türkçe ÜRÜN metnini bilerek alıntılar
 * ("⚠ AĞ SİNYALİ BOZUK — …" gibi); çeviri artığı aramak alıntının içine bakmamalı,
 * yoksa gözcü meşru bir alıntıda kırmızı yanar ve ilk fırsatta devre dışı bırakılır.
 */
function alintisizYorum(): string {
  return yorumMetni()
    .replace(/"[^"]*"/g, ' "" ')
    .replace(/`[^`]*`/g, " `` ")
    .replace(/'[^'\n]*'/g, " '' ")
    // Alıntı dışında geçen TEK Türkçe sözcük, bilerek: simülasyon çıktılarının etiketi.
    .replace(/SİMÜLASYON/g, "SIMULATION");
}

/* ────────────────────────────────────────────────────────────────────────────
 * BULGU 1 — "callFwd yükseltme açıklaması bozuk sinyali adlandırmıyor".
 * ÖLÇÜLDÜ: ZATEN KAPALI. Açıklama artık halka + ret-nedeni çiftinden türetiliyor
 * (kademeAciklamasi), ve callFwd'in SESSİZLİĞİNİN kefili yok
 * (YANITSIZ_KEFIL_ESLEMESI.callFwd boş küme) — o halka yükseltmeye hiç ulaşamıyor.
 * KIRMIZI YÖNLERİ: (a) açıklama yeniden halka başına sabit metne dönerse,
 * (b) callFwd sessizliği kefilsiz yükseltilir hâle gelirse. İkisi de KOD yönü.
 * ──────────────────────────────────────────────────────────────────────────── */

test("BULGU1: yanıtsız halkanın yükseltme açıklaması, SESSİZ KALAN HALKAYI adıyla söyler", async () => {
  temizKanallar();
  __setErisimKanalForTests({
    cihazErisilebilirMi: async () => {
      throw new Error("reach 503");
    },
  });
  const k = await agDogrula(TEMEL, "high");

  assert.equal(k.engel, undefined, "temiz kefiller varken yanıtsız halka düz retle bitmemeli");
  assert.equal(k.kademe?.neden, "ag-yanitsiz");
  assert.equal(
    k.kademe?.aciklama,
    "cihaz erişilebilirlik kontrolünden okunabilir yanıt alınamadı",
    "insana gösterilen cümle 'kontrol cevap vermedi' demeli, bir SAPTAMA cümlesi olmamalı"
  );
  // Saptama cümlesine kaymadığını AYRICA sabitle: yalnız eşitlik kontrolü, metin ileride
  // başka bir saptama cümlesine dönerse de yeşil kalırdı.
  assert.ok(
    !/erişilemez durumda/.test(k.kademe!.aciklama),
    "yanıtsız kontrol, GÖZLENMEMİŞ bir olayın iddiasına dönüştürülemez"
  );
});

test("BULGU1: yanıtsız cihaz-değişimi halkası da çıplak isim tamlaması göstermez", async () => {
  temizKanallar();
  __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => undefined });
  const k = await agDogrula(TEMEL, "high");

  assert.equal(k.kademe?.neden, "ag-yanitsiz");
  assert.equal(k.kademe?.aciklama, "cihaz değişimi kontrolünden okunabilir yanıt alınamadı");
  assert.ok(
    !/yakın zamanda değişmiş/.test(k.kademe!.aciklama),
    "okunamayan yanıt 'cihaz değişti' iddiasına çevrilemez"
  );
});

test("BULGU1: çağrı yönlendirme SESSİZ kalınca yükseltme HİÇ olmaz — çıplak metin insana ulaşamaz", async () => {
  // Bulgunun senaryosunun ta kendisi: AEGIS_CALLFWD_CHECK=1 ve uç 501/timeout dönüyor.
  temizKanallar();
  __setCagriYonlendirmeKanalForTests({
    kosulsuzYonlendirmeAcikMi: async () => {
      throw new Error("NotImplementedError: 501");
    },
  });
  const k = await agDogrula(TEMEL, "high");

  assert.ok(k.engel, "kefilsiz sessizlik REDDE gider (fail-closed)");
  assert.equal(k.kademe, undefined, "yükseltme verilmemeli; dolayısıyla insana istem gösterilmez");
  assert.equal(k.iz.retNedeni, "ag-yanitsiz");
  // Politika tarafı: callFwd sessizliğinin kefili YOKTUR. Bu satır gevşerse yukarıdaki ret
  // de gevşer; ikisi aynı anda kırmızı olsun diye tablo da sabitleniyor.
  assert.deepEqual(
    [...YANITSIZ_KEFIL_ESLEMESI["callFwd"]!],
    [],
    "koşulsuz yönlendirme diğer halkalara görünmez; sessizliğine kimse kefil olamaz"
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * BULGU 2 — dosya başı: "risk katmanları yalnız pencereyi değiştirir" iddiası.
 * ÖLÇÜLDÜ: iddianın BÜYÜK yarısı (karar mantığı) önceki bir turda düzeltilmiş; ikinci
 * yarısı ("medium son 24 saate bakar") HÂLÂ duruyordu ve YANLIŞTI: pencereSec
 * min(24, yapılandırılan) uyguluyor. Başlık bu turda düzeltildi.
 * KIRMIZI YÖNLERİ: (a) pencere kelepçesi kalkarsa ya da medium 24'e sabitlenirse (KOD),
 * (b) başlık eski "checks the last 24h" cümlesine dönerse (BELGE).
 * ──────────────────────────────────────────────────────────────────────────── */

test("BULGU2: medium katmanı pencereyi 24'e YÜKSELTMEZ — min(24, yapılandırılan)", async () => {
  temizKanallar();
  const dar = await agDogrula({ ...TEMEL, simSwapWindowHours: 12 }, "medium");
  assert.equal(dar.iz.pencereSaat, 12, "12 saatlik yapılandırma medium'da 24'e genişletilemez");

  const genis = await agDogrula({ ...TEMEL, simSwapWindowHours: 72 }, "medium");
  assert.equal(genis.iz.pencereSaat, 24, "72 saatlik yapılandırma medium'da 24'e daraltılır");

  const yuksek = await agDogrula({ ...TEMEL, simSwapWindowHours: 72 }, "high");
  assert.equal(yuksek.iz.pencereSaat, 72, "high, yapılandırılan pencereyi kullanır");
});

test("BULGU2: dosya başı, pencereyi ve HANGİ HALKALAR sorusunu kodun yaptığı gibi anlatır", () => {
  const kesim = KAYNAK.indexOf("── Link 2 of the trust chain");
  assert.ok(kesim > 0, "dosya başı bölümü bulunamadı — gözcü boşa ölçüyor olurdu");
  const bas = KAYNAK.slice(0, kesim).replace(/\s+/g, " ");

  // (b) yönü — BELGE kayarsa kırmızı.
  assert.ok(
    /AT MOST the last 24h/.test(bas) && /min\(24, configured\)/.test(bas),
    "başlık medium penceresini TAVAN olarak anlatmalı: min(24, yapılandırılan)"
  );
  assert.ok(
    !/checks the last 24h/.test(bas),
    "eski 'medium son 24 saate bakar' cümlesi yanlıştı ve geri gelmemeli"
  );
  assert.ok(
    /decide WHICH LINKS RUN AT ALL/.test(bas) && /RISK_HALKA_ESLEMESI/.test(bas),
    "risk katmanının KARAR MANTIĞINI da belirlediği başlıkta yazılı olmalı"
  );

  // (a) yönü — KOD kayarsa kırmızı: başlığın "medium'da yalnız SIM Swap" cümlesi
  // tablonun bugünkü hâliyle birlikte ölçülür.
  assert.deepEqual([...RISK_HALKA_ESLEMESI.medium], ["simSwap"]);
  assert.equal(RISK_HALKA_ESLEMESI.high.length, 6);
  assert.ok(
    /on "medium" only SIM Swap runs, on "high" all six/.test(bas),
    "başlıktaki cümle RISK_HALKA_ESLEMESI ile aynı şeyi söylemeli"
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * BULGU 3 — "indirilmiş tavan" vaadi.
 * ÖLÇÜLDÜ: ZATEN KAPALI. Yorum vaadi AÇIKÇA reddediyor ve `KademeKarari` hiçbir tavan
 * alanı taşımıyor.
 * KIRMIZI YÖNLERİ: (a) yükseltme kararı bir tavan alanı taşımaya başlarsa (KOD) —
 * o an yorumdaki ret cümlesi yanlış olur, (b) yorum yeniden tavan vaat ederse (BELGE).
 * ──────────────────────────────────────────────────────────────────────────── */

test("BULGU3: yükseltme kararı hiçbir TAVAN alanı taşımaz", async () => {
  temizKanallar();
  __setSimSwapKanalForTests({ verifySimSwap: async () => true });
  const k = await agDogrula(TEMEL, "high");

  assert.equal(k.engel, undefined);
  assert.ok(k.kademe, "SIM değişimi, temiz kefillerle yükseltmeye dönmeli");
  assert.deepEqual(
    Object.keys(k.kademe!).sort(),
    ["aciklama", "dogrulayan", "neden"],
    "KademeKarari yalnız {neden, aciklama, dogrulayan} taşır — bir tavan alanı eklenirse " +
      "yorumdaki 'hiçbir tavan indirilmiyor' cümlesi YANLIŞ olur ve bu gözcü onu yakalar"
  );
});

test("BULGU3: yorumlar indirilmiş tavan VAAT ETMEZ, reddi açıkça yazılıdır", () => {
  const duz = yorumDuz();
  assert.ok(
    /NOTHING in this codebase lowers a ceiling on an escalation/.test(duz),
    "vaadin kaldırıldığı açıkça yazılı olmalı; sessiz kaldırma yeniden yazılmaya davettir"
  );
  assert.ok(
    !/(bound|tied|and) to a lowered ceiling|a lowered ceiling as well/.test(duz),
    "yükseltme, karşılığı olmayan bir tavan indirimi vaat edemez"
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * BULGU 4 — yarım kalmış çeviri: cümle ortasında Türkçe kalıntı.
 * ÖLÇÜLDÜ: DÖRT kalıntı duruyordu (dokunulmaz / YOKTUR / kalamaz / yazar—bkz).
 * Dördü de bu turda çevrildi.
 * KIRMIZI YÖNLERİ: (a) düzeltilen cümleler geri alınırsa (BELGE), (b) YENİ bir yorumda
 * yarım kalmış çeviri belirirse — sözcük/harf taraması onu da yakalar.
 * NOT: tarama ALINTI DIŞINDA çalışır; Türkçe ürün metni yorumda alıntılanabilir.
 * ──────────────────────────────────────────────────────────────────────────── */

test("BULGU4: yorumlarda çeviri artığı (alıntı dışı Türkçe) kalmadı", () => {
  const metin = alintisizYorum();

  const turkceSozcukler =
    /\b(için|değil|değildir|yoktur|kalamaz|dokunulmaz|edilmez|halkada|bkz|hiçbir|olduğu|gerekir|yalnız|sadece|yazar|okunur|olmaz|vardır|çünkü|ayrıca|bile|ile|ve|bir)\b/gi;
  const bulunan = [...new Set(metin.match(turkceSozcukler) ?? [])];
  assert.deepEqual(
    bulunan,
    [],
    `alıntı dışı yorumda Türkçe sözcük kaldı (yarım çeviri): ${bulunan.join(", ")}`
  );

  const turkceHarfler = [...new Set(metin.match(/[ıİğĞşŞ]/g) ?? [])];
  assert.deepEqual(
    turkceHarfler,
    [],
    `alıntı dışı yorumda Türkçe'ye özgü harf kaldı: ${turkceHarfler.join(", ")}`
  );
});

test("BULGU4: dört kesik cümlenin İngilizce hâli yerinde — en kritiği simülasyon vaadi", () => {
  const duz = yorumDuz();

  // En zararlısı: simülasyon kanalının gerçek SDK'ya dokunmadığı vaadi okunamaz hâldeydi.
  assert.ok(
    /The real SDK is NEVER TOUCHED here — it is not even imported/.test(duz),
    "simülasyon kanalının en kritik vaadi TAM CÜMLE olmalı"
  );
  assert.ok(
    /for a link that HAS no window \(links 2, 3, 4 and 6\) it is ABSENT/.test(duz),
    "penceresiz halkaların (2, 3, 4, 6) bilgisi İngilizce metinde durmalı"
  );
  assert.ok(
    /turns RED in the compiler or the tests rather than staying silent\./.test(duz),
    "kayıt defteri cümlesi yarım kalmamalı"
  );
  assert.ok(
    /each writes it to its OWN field in the trace — see AgIz\.devSwapPencereSaat\./.test(duz),
    "1. ve 5. halkanın pencereyi paylaştığı ama ize AYRI yazdığı cümlesi tam olmalı"
  );

  // Vaat ÖLÇÜLEBİLİR olmalı: gerçek SDK'nın tek çalışma-zamanı import'u nacIstemci'nin
  // içindedir; bu satır çoğalırsa yukarıdaki cümle yanlışa döner (KOD yönü).
  const importSatirlari = KAYNAK.split("\n").filter((s) =>
    /await import\("network-as-code"\)/.test(s)
  );
  assert.equal(importSatirlari.length, 1, "gerçek SDK'nın TEK bir tembel import'u olmalı");
});

/* ────────────────────────────────────────────────────────────────────────────
 * BULGU 5 — "corroborates the degraded signal": kefalet mantığının tersi.
 * ÖLÇÜLDÜ: cümle duruyordu ve davranışın TERSİNİ anlatıyordu. Düzeltildi.
 * KIRMIZI YÖNLERİ: (a) kefalet davranışı tersine dönerse (KOD), (b) cümle "corroborate"
 * sözlüğüne geri dönerse (BELGE).
 * ──────────────────────────────────────────────────────────────────────────── */

test("BULGU5: kalan halkalar bozuk sinyali TEYİT için değil, ÇÜRÜTEBİLECEK kefil için koşar", async () => {
  // (a) yönü — davranış. SIM değişimi saptandı; kalan halkalar TEMİZ döndüğü için işlem
  // GEÇİYOR. Hiçbir halka "SIM gerçekten değişti" yönünde kanıt toplamıyor.
  temizKanallar();
  __setSimSwapKanalForTests({ verifySimSwap: async () => true });
  const gecen = await agDogrula(TEMEL, "high");
  assert.equal(gecen.engel, undefined, "temiz dönen ÇÜRÜTÜCÜ halkalar işlemi geçirir");
  assert.deepEqual(
    [...(gecen.kademe?.dogrulayan ?? [])].sort(),
    ["callFwd", "devSwap", "loc"],
    "yükseltmeyi taşıyanlar, sim-degisti'yi ÇÜRÜTEBİLEN temiz halkalardır"
  );

  // Aynı bozuk sinyal, ama çürütebilecek halkaların hepsi kapalı: kefil yok → RET.
  temizKanallar();
  __setSimSwapKanalForTests({ verifySimSwap: async () => true });
  const kefilsiz = await agDogrula(
    { ...TEMEL, devSwapCheck: false, callFwdCheck: false, expectedCountry: undefined },
    "high"
  );
  assert.ok(kefilsiz.engel, "çürütebilecek temiz halka yoksa yükseltme YOKTUR — kefalet ilkesi");
  assert.equal(kefilsiz.kademe, undefined);
});

test("BULGU5: agDogrula yorumu kefalet yönünü doğru anlatır; 'corroborate' sözlüğü kalmadı", () => {
  const duz = yorumDuz();
  assert.ok(
    /run to look for a link that can VOUCH FOR the approver DESPITE the degraded signal/.test(duz),
    "kalan halkaların NİÇİN koştuğu, kefalet yönünde yazılmalı"
  );
  assert.ok(
    /CAPABLE OF DISPROVING/.test(duz),
    "kefil olabilmenin koşulu (o sinyali çürütebilmek) cümlede geçmeli"
  );
  // Tek meşru kullanım, bilerek büyük harfli olumsuz cümle: "NO LINK EVER CORROBORATES".
  //
  // ÖLÇÜLDÜ (faz 4): eski ayıklama `duz.replace(/CORROBORATES/g, "")` ÇOK GENİŞTİ —
  // dosyadaki HER büyük harfli geçişi siliyordu. Kefalet yönünü TERS anlatan yeni bir
  // yorum eklendiğinde ("every remaining link CORROBORATES the degraded signal") o sözcük
  // de ayıklanıyor, gözcü YEŞİL kalıyordu. Ayıklama artık TAM İFADEYE bağlı ve ifadenin
  // BİR KEZ geçtiği ayrıca doğrulanıyor: ifadeyi çoğaltarak da delinemez.
  const MESRU_IFADE = "NO LINK EVER CORROBORATES";
  const parcalar = duz.split(MESRU_IFADE);
  assert.equal(
    parcalar.length,
    2,
    `meşru olumsuz cümle ("${MESRU_IFADE}") yorumlarda TAM OLARAK bir kez geçmeli`
  );
  assert.ok(
    !/corroborat/i.test(parcalar.join(" ")),
    "hiçbir halka bozuk sinyali TEYİT etmez; 'corroborate' sözlüğü bu dosyada ters okunur"
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * BULGU 6 — operatör stderr'ine ham CAMARA metni + ANSI, tavansız.
 * ÖLÇÜLDÜ: ZATEN KAPALI. Beş catch bloğu da ortak `operatorMetniTemizle`den geçiyor:
 * ANSI/C0/C1 ayıklanıyor, jeton DEĞERE göre, numara BİÇİMDEN BAĞIMSIZ maskeleniyor,
 * satır 300 karakterde kesiliyor.
 * KIRMIZI YÖNÜ: beş halkadan HERHANGİ BİRİ temizleyiciyi atlarsa (KOD). Bu gözcünün
 * belge yönü yoktur; ölçtüğü şey doğrudan davranıştır.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Numarayı üç bağımsız yoldan arar: ham yazım, basılan rakamlar, yüzde-çözülmüş hâl. */
function numaraSizdiMi(satir: string): boolean {
  if (satir.includes(TELEFON)) return true;
  if (satir.replace(/\D/g, "").includes(RAKAMLAR)) return true;
  let cozulmus = satir;
  try {
    cozulmus = decodeURIComponent(satir);
  } catch {
    /* bozuk yüzde dizisi: ham hâliyle bakmak yeterli */
  }
  return cozulmus.replace(/\D/g, "").includes(RAKAMLAR);
}

test("BULGU6: beş halkanın da stderr satırı temizlenmiş ve TAVANLI çıkar", async () => {
  const kirli =
    "CAMARA 503 upstream \u001B[31mRED\u001B[0m \u001B[2J\u001B[1;1H SAHTE: onaylandı " +
    `token=${JETON} phone=%2B905551112233 alt=905551112233 ` +
    "X".repeat(5000);

  const bozanlar: ReadonlyArray<readonly [string, () => void]> = [
    [
      "simSwap",
      () =>
        __setSimSwapKanalForTests({
          verifySimSwap: async () => {
            throw new Error(kirli);
          },
        }),
    ],
    [
      "reach",
      () =>
        __setErisimKanalForTests({
          cihazErisilebilirMi: async () => {
            throw new Error(kirli);
          },
        }),
    ],
    [
      "loc",
      () =>
        __setKonumKanalForTests({
          ulkeDurumu: async () => {
            throw new Error(kirli);
          },
        }),
    ],
    [
      "devSwap",
      () =>
        __setCihazDegisimKanalForTests({
          cihazDegistiMi: async () => {
            throw new Error(kirli);
          },
        }),
    ],
    [
      "callFwd",
      () =>
        __setCagriYonlendirmeKanalForTests({
          kosulsuzYonlendirmeAcikMi: async () => {
            throw new Error(kirli);
          },
        }),
    ],
  ];

  for (const [halka, boz] of bozanlar) {
    temizKanallar();
    boz();
    const yakalanan: string[] = [];
    const eski = console.error;
    console.error = (...a: unknown[]) => {
      yakalanan.push(a.map((p) => String(p)).join(" "));
    };
    try {
      // stepUp KAPALI: her halka kendi catch bloğuna girsin, zincir erken dönmesin.
      await agDogrula({ ...TEMEL, stepUp: false }, "high");
    } finally {
      console.error = eski;
    }

    const satir = yakalanan.find((s) => s.includes("[aegis]"));
    assert.ok(satir, `${halka}: catch bloğu operatöre bir satır yazmalı`);
    assert.ok(
      !/[\u0000-\u001F\u007F-\u009F]/.test(satir!),
      `${halka}: ESC/kontrol baytı operatörün terminaline ulaşamaz (ekran silme, sahte satır)`
    );
    assert.ok(!satir!.includes(JETON), `${halka}: NaC jetonu stderr'e yazılamaz`);
    assert.ok(!numaraSizdiMi(satir!), `${halka}: onaylayıcının tam numarası stderr'e yazılamaz`);
    assert.ok(
      satir!.length < 500,
      `${halka}: satır TAVANLI olmalı; 5000 karakterlik gövde olduğu gibi basılamaz (${satir!.length})`
    );
    // Aşırı temizlemenin diğer yönü: tanı bilgisi TAMAMEN yenmemeli.
    assert.ok(
      /CAMARA 503 upstream/.test(satir!),
      `${halka}: temizleyici operatörün tanısını da silmemeli`
    );
  }
});
