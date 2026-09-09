// SPDX-License-Identifier: AGPL-3.0-only
/**
 * REPAIR ROUND 3 — SECURITY.md, pinned to the two DIFFERENT fail-closed directions the
 * code actually implements.
 *
 * WHY THIS FILE EXISTS (measured, not read). SECURITY.md is the repo's normative document:
 * "## Kapsam" declares what counts as a vulnerability and the invariants list is a contract
 * that says "show us one of these broken and the report is accepted outright". An earlier
 * round already put the network gate INTO the invariants list (items 6-9) and
 * test/belgeAgKapisi.test.ts watches those. Two holes survived that round, and both were
 * measured at the start of this one:
 *
 *   1) The "## Kapsam" section never named the gate:
 *        grep -icE "CAMARA|ag guven kapisi" <Kapsam section>  ->  0
 *      Its nearest bullet is "onay kapilarinin atlatilmasi — insan onayi olmadan harcamayi
 *      artiran herhangi bir yol", which does NOT cover the gate's own promise: a prompt that
 *      is shown even though the gate never cleared still ends in a human approval, so a
 *      researcher reporting it could be told it is out of scope.
 *
 *   2) Invariant 3 read, unqualified: "Belirsizlikte kapali ariza: durum dogrulanamiyorsa
 *      onay istenir." For the Ads surface that is true. For the GATE it is exactly
 *      backwards, and it was measured to be backwards:
 *        onayAl(risk-tagged summary, unreadable gate signal)
 *          ->  onaylandi=false, kanal="ag", PROMPTS SHOWN = 0
 *      A researcher who found a path where the prompt IS shown on an unverifiable signal
 *      would have read invariant 3, concluded that was the documented behaviour, and not
 *      reported the one failure the product's headline control is built to prevent.
 *
 *   3) THAT MEASUREMENT WAS CONFIGURATION-DEPENDENT, and neither the document nor this file
 *      said so — a later round caught it. The run above uses the DEFAULT configuration; with
 *      AEGIS_STEPUP on (invariant 8, shipped and documented) the same unreadable signal
 *      measures as:
 *        stepUp:true, devSwapCheck:true, simSwap unreadable, devSwap clean over a REAL link
 *          ->  onaylandi=true, kanal="insan", PROMPTS SHOWN = 1
 *      So invariant 3's gate half, written without a qualifier, contradicted invariant 8 of
 *      its own list: one said "a prompt here is a vulnerability", the other described the
 *      feature that shows it. The document now carries the carve-out, and the guard below
 *      measures BOTH of its edges — voucherless escalation still refuses at zero prompts,
 *      vouched escalation does prompt — so neither edge can drift without going red.
 *
 * BIDIRECTIONALITY (this file's contract). No test here is text-only. Every documented
 * claim is paired with the BEHAVIOUR that makes it true, in the same test:
 *   (a) the DOC drifts -> red (the claim is searched inside the section it belongs to; a
 *       sentence sitting elsewhere in the file does not close the finding), and
 *   (b) the CODE drifts -> red (move the network check after the prompt, or let the live
 *       campaign guard step past an unknown status, and the same test fails while the
 *       document still says the opposite).
 *
 * No test here reaches the network: the CAMARA channels are injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { onayAl } from "../src/approval.js";
import {
  __setCagriYonlendirmeKanalForTests,
  __setCihazDegisimKanalForTests,
  __setErisimKanalForTests,
  __setKonumKanalForTests,
  __setSimSwapKanalForTests,
  type AgAyar,
} from "../src/networkTrust.js";
import { sahteContext, baglanti, cagir } from "./helpers/harness.js";

/* ── Belge okuma: iddia AİT OLDUĞU bölümün içinde aranır ─────────────────────── */

const BELGE = readFileSync(fileURLToPath(new URL("../SECURITY.md", import.meta.url)), "utf8").replace(
  /\r\n/g,
  "\n"
);

/** "## Başlık" ile bir sonraki "## " arası. Çapasını bulamayan gözcü BAŞARISIZ olur. */
function bolum(basligiIceren: string): string {
  const satirlar = BELGE.split("\n");
  const bas = satirlar.findIndex((s) => s.startsWith("## ") && s.includes(basligiIceren));
  assert.notEqual(bas, -1, `SECURITY.md içinde "${basligiIceren}" başlıklı bölüm yok`);
  const kalan = satirlar.slice(bas + 1);
  const son = kalan.findIndex((s) => s.startsWith("## "));
  return (son === -1 ? kalan : kalan.slice(0, son)).join("\n");
}

/**
 * Satır kaydırmasından arındırma. Belge ~90 sütunda ELLE sarılıyor ve kalın işaretçiler
 * cümlenin ortasına düşüyor ("onay istemi **gösterilmeden**\n     reddedilir"). Ham metne
 * bakan bir regex, cümle DURURKEN kırmızı olurdu — yani gözcü anlamı değil biçimlendirmeyi
 * ölçerdi.
 */
const duzle = (s: string): string =>
  s
    .replace(/\*\*/g, "")
    /**
     * Kod çitleri de biçimlendirmedir: belge ortam değişkenlerini `AEGIS_STEPUP` diye
     * yazıyor ve çitleri bırakan bir gözcü, cümle DURURKEN sırf yazım biçimi yüzünden
     * kırmızı olurdu — yine anlamı değil markdown'ı ölçerdi.
     */
    .replace(/`/g, "")
    .replace(/\s+/g, " ");

const KAPSAM = duzle(bolum("Kapsam"));
const DEGISMEZLER = bolum("Tasarım gereği güvenlik değişmezleri");

/**
 * Yalnız 3. değişmez: "3." ile başlayan satırdan "4." ile başlayan satıra kadar.
 *
 * Bölümün TAMAMINDA aramak bu bulguyu kapatmazdı: 6. ve 7. maddeler kapının kapalı-arıza
 * sözleşmesini zaten yazıyor, dolayısıyla bölüm geneline bakan bir gözcü 3. madde ters
 * dururken de yeşil kalırdı. Bulgunun yeri tam olarak bu maddeydi.
 */
function ucuncuDegismez(): string {
  const satirlar = DEGISMEZLER.split("\n");
  const bas = satirlar.findIndex((s) => /^3\./.test(s));
  assert.notEqual(bas, -1, "SECURITY.md değişmezler listesinde 3. madde yok");
  const kalan = satirlar.slice(bas);
  const son = kalan.findIndex((s, i) => i > 0 && /^4\./.test(s));
  assert.notEqual(son, -1, "3. maddenin bittiği yer (4. madde) bulunamadı");
  return duzle(kalan.slice(0, son).join("\n"));
}

const UCUNCU = ucuncuDegismez();

/* ── Kapı probu: enjekte kanallar, ağa çıkış yok ─────────────────────────────── */

/** YALNIZ SIM Swap halkasını açar (expectedCountry bilerek YOK): ret KESİNLİKLE o halkadan. */
const TEK_HALKA: AgAyar = {
  nacToken: "TEST-ONLY-onarim3-security",
  approverPhone: "+905551112233",
  simSwapWindowHours: 72,
};

/** Elicitation DESTEKLEYEN istemci — gösterilen istemleri sayar. İstem sayısı ölçülen şey. */
function istemSunucu(sorulanlar: string[]): any {
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

/** Kanal dikişleri modül-global: sıfırlanmazsa sonraki teste sızar. */
async function izole(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } finally {
    __setSimSwapKanalForTests(undefined);
    __setErisimKanalForTests(undefined);
    __setKonumKanalForTests(undefined);
    __setCihazDegisimKanalForTests(undefined);
    __setCagriYonlendirmeKanalForTests(undefined);
  }
}

/* ── K1) Kapsam: ağ kapısı atlatması AYRI bir açık sınıfı ────────────────────── */

test("SECURITY.md Kapsam: ağ kapısının atlatılması açıkça kapsam İÇİNDE", async () => {
  /**
   * KIRMIZI OLMA YÖNÜ — BELGE: madde silinirse ya da "onay kapısı" maddesinin içine
   * eritilirse. Arama Kapsam bölümüyle sınırlı: kapının değişmezler listesinde anılması,
   * bir bulgunun TRİYAJDA kapsam içi sayılacağı anlamına gelmez; bildiren araştırmacı
   * "açık sayılır" listesini okur.
   */
  assert.match(KAPSAM, /Ağ güven kapısının atlatılması/i, "Kapsam listesinde ağ kapısı maddesi yok");
  assert.match(
    KAPSAM,
    /kapı temiz geçmeden onay isteminin gösterilmesi/i,
    "maddenin ilk yarısı (istem, kapı temiz geçmeden gösterilemez) kayıp"
  );
  assert.match(
    KAPSAM,
    /doğrulanamayan\/okunamayan\/çelişkili bir sinyalin kapıdan geçirilmesi/i,
    "maddenin ikinci yarısı (bozuk sinyal geçirilemez) kayıp"
  );
  /**
   * VE AYNI KAYIT BURADA DA YAZILI OLMALI. Triyajın dayanağı iki yerde: araştırmacı önce
   * "açık sayılır" listesini okur, 3. maddeyi sonra. Kapsam maddesi kayıtsız kalırsa,
   * 3. maddede kapatılan çelişki (belge, 8. maddede SEVK EDİLMİŞ kademeli doğrulamayı
   * açık ilan ediyor) buradan aynen geri döner — "doğrudan kabul edilir" sözü yine
   * tutulamaz. Kayıt, açık sınıfını daraltmıyor: kefilSİZ yükseltmenin hâlâ açık olduğu
   * aynı cümlede yazılı.
   */
  assert.match(
    KAPSAM,
    /8\. maddedeki kefilli kademeli doğrulama/i,
    "Kapsam maddesi 8. maddedeki kademeyi kayıt olarak anmıyor — liste 8. maddeyle çelişiyor"
  );
  assert.match(
    KAPSAM,
    /kefilsiz yükseltme yine açıktır/i,
    "kaydın sınırı yazılmamış: kefilsiz yükseltmenin AÇIK sayıldığı da söylenmeli"
  );

  /**
   * KIRMIZI OLMA YÖNÜ — KOD: kapı, onay kapısından AYRI bir kontrol olmaktan çıkarsa.
   * Belge onu ayrı bir açık sınıfı ilan ediyor; kodun karşılığı, retlerin kendi kanalıyla
   * ("ag") dönmesidir. Kapı sökülür ya da onay akışına eritilirse kanal "ag" olmaz.
   */
  await izole(async () => {
    __setSimSwapKanalForTests({ verifySimSwap: async () => true }); // SIM yakın zamanda değişmiş
    const sorulanlar: string[] = [];
    const sonuc = await onayAl(
      istemSunucu(sorulanlar),
      { eylem: "bütçe artışı", satirlar: [], risk: "medium", agAyar: TEK_HALKA },
      undefined
    );
    assert.equal(sonuc.onaylandi, false, "SIM değişmişken işlem geçmemeli");
    assert.equal(sonuc.kanal, "ag", "ret ONAY kapısından değil, AĞ kapısından gelmeli");
    assert.equal(sorulanlar.length, 0, "kapı reddederken istem gösterilmemeli");
  });
});

/* ── K2) 3. değişmez, KAPI yarısı: doğrulanamayan sinyalde istem sayısı SIFIR ─── */

test("SECURITY.md 3. değişmez: kapıda belirsizlik insana SORULMAZ (istem sayısı sıfır)", async () => {
  /**
   * KIRMIZI OLMA YÖNÜ — BELGE: 3. madde eski hâline (kapsamsız "durum doğrulanamıyorsa onay
   * istenir") dönerse. Bulgunun tam senaryosu buydu: araştırmacı kapıda istem gösterilen bir
   * yol bulur, 3. maddeyi okur ve bulduğunu DOĞRU davranış sayıp bildirmez.
   */
  assert.match(UCUNCU, /Ağ güven kapısı:/i, "3. madde kapı yüzeyini ayrı ele almıyor");
  assert.match(UCUNCU, /hiç sorulmaz/i, "kapıdaki belirsizliğin insana sorulmadığı yazılmalı");
  assert.match(UCUNCU, /istemi gösterilmeden reddedilir/i, "istem gösterilmeden ret hükmü kayıp");
  assert.match(UCUNCU, /istem sayısı sıfırdır/i, '"ret anında istem sayısı sıfırdır" kuralı kayıp');
  assert.match(
    UCUNCU,
    /bir açıktır, doğru davranış değil/i,
    "kapıda istem gösterilmesinin AÇIK sayıldığı söylenmeli — triyajın dayanağı bu cümle"
  );
  /** Eski, tersine çevrilmiş cümle geri gelmemeli: bu, gerilemenin tam imzası. */
  assert.doesNotMatch(
    duzle(DEGISMEZLER),
    /Belirsizlikte kapalı arıza: durum doğrulanamıyorsa onay istenir/i,
    "kapsamsız eski cümle geri gelmiş — kapı için TERS hüküm"
  );

  /**
   * KIRMIZI OLMA YÖNÜ — BELGE, İKİNCİ TUR: kapı yarısı yeniden KOŞULSUZ yazılırsa.
   *
   * ÖLÇÜLDÜ (bu turun probu, enjekte kanallar, ağa çıkış yok): risk="high",
   * `stepUp:true`, `devSwapCheck:true`, SIM Swap yanıtı OKUNAMIYOR, cihaz değişimi
   * halkası gerçek kanaldan temiz  ->  onaylandi=true, kanal="insan", İSTEM SAYISI=1.
   * Yani "kapıda belirsizlik insana HİÇ sorulmaz, istem sayısı SIFIRDIR" hükmü, sevk
   * edilmiş ve 8. maddede BELGELENMİŞ bir yapılandırmada yanlıştı: aynı listenin 3. ve 8.
   * maddeleri birbirini yalanlıyordu. Public depoda "bu değişmezlerden birini kırdığınızı
   * gösterirseniz doğrudan kabul edilir" diyen bir belge için bu, tutulamayacak bir söz.
   *
   * Kayıt DAR tutulur: sıfır-istem hükmü varsayılan yapılandırmaya bağlanır, tek istisna
   * 8. maddedeki KEFİLLİ kademeye verilir ve kefilsiz hâlin hâlâ ret olduğu yazdırılır.
   */
  assert.match(
    UCUNCU,
    /AEGIS_STEPUP kapalıyken/i,
    "sıfır-istem hükmü koşulsuz yazılmış — AEGIS_STEPUP açıkken 8. madde bunu ÖLÇÜLEBİLİR biçimde yalanlıyor"
  );
  assert.match(
    UCUNCU,
    /bkz\. 6-8/,
    "kapı yarısı, kaydı tanımlayan 8. maddeye yönlendirmeli (6-7 durumu 8. maddeyi görmezden gelir)"
  );
  assert.match(
    UCUNCU,
    /kefil yoksa ret aynen durur ve istem sayısı yine sıfırdır/i,
    "kefilsiz yükseltmenin YAPILMADIĞI yazılmalı — kayıt bu cümle olmadan sınırsız okunur"
  );
  /**
   * "Açıktır" cümlesi triyajın dayanağı; kaydın DIŞINDA kalması gerekir. Aynı cümlede
   * (araya nokta girmeden) kaydı anan bir kayıt-cümleciği aranır: kayıt uzağa, ayrı bir
   * cümleye taşınırsa mutlak hüküm geri gelmiş olur.
   */
  assert.match(
    UCUNCU,
    /dışında[^.]{0,140}bir açıktır, doğru davranış değil/i,
    "mutlak \"bu bir açıktır\" hükmü kaydına bağlanmamış — 8. maddeyle çelişki geri döndü"
  );

  /**
   * KIRMIZI OLMA YÖNÜ — KOD: ağ kontrolü istemden SONRAYA alınırsa ya da okunamayan yanıt
   * "temiz" sayılırsa. Kanal `undefined` döndürüyor: operatör yanıtı OKUNAMADI — "bilinmiyor",
   * "hayır" değil.
   */
  await izole(async () => {
    __setSimSwapKanalForTests({ verifySimSwap: async () => undefined });
    const sorulanlar: string[] = [];
    const sonuc = await onayAl(
      istemSunucu(sorulanlar),
      { eylem: "bütçe artışı", satirlar: [], risk: "medium", agAyar: TEK_HALKA },
      undefined
    );
    assert.equal(sonuc.onaylandi, false, "okunamayan sinyal 'temiz' sayılmamalı");
    assert.equal(sonuc.kanal, "ag");
    assert.equal(
      sorulanlar.length,
      0,
      "doğrulanamayan sinyalde İSTEM GÖSTERİLMİŞ — SECURITY.md 3. maddesi bunun tersini vaat ediyor"
    );
  });

  /**
   * KIRMIZI OLMA YÖNÜ — KOD, KAYDIN İKİ KENARI. Belge artık tek bir kayıt ilan ediyor;
   * kaydın İKİ kenarı da burada ölçülür, çünkü belgeyi yanlışlayacak olan tam da kenarın
   * kayması. Bir önceki tur bu maddeyi yalnız stepUp KAPALI yapılandırmada ölçüyordu:
   * kayıt yazılmamıştı ve gözcü, hükmün açık yapılandırmada yanlış olduğunu göremiyordu.
   *
   * (a) KEFİLSİZ yükseltme YOKTUR. stepUp açık, ama sinyali çürütebilecek hiçbir gerçek
   *     halka koşmuyor: istem sayısı yine SIFIR. Bu kenar kayarsa hem 3. maddenin
   *     "kefil yoksa ret aynen durur" cümlesi hem 8. maddenin kefalet ilkesi yalan olur.
   */
  await izole(async () => {
    __setSimSwapKanalForTests({ verifySimSwap: async () => undefined });
    const sorulanlar: string[] = [];
    const sonuc = await onayAl(
      istemSunucu(sorulanlar),
      { eylem: "bütçe artışı", satirlar: [], risk: "high", agAyar: { ...TEK_HALKA, stepUp: true } },
      undefined
    );
    assert.equal(sonuc.onaylandi, false, "kefil yokken yükseltme verilmemeli");
    assert.equal(sonuc.kanal, "ag", "kefilsiz kademe reddi AĞ kapısından gelmeli");
    assert.equal(
      sorulanlar.length,
      0,
      "KEFİLSİZ kademe insana SORULMUŞ — 3. maddenin kaydı ve 8. maddenin kefalet ilkesi bunun tersini vaat ediyor"
    );
  });

  /**
   * (b) KEFİLLİ yükseltme VARDIR ve insana gider — belgenin ilan ettiği kaydın ta kendisi.
   *     Bu kenar kaybolursa (kademe sökülür ya da AEGIS_STEPUP koşulsuz reddeder hâle
   *     gelirse) belge, artık olmayan bir davranışı tarif ediyor olur ve madde yine
   *     kodun yaptığından başkasını söyler. İstem, bozuk sinyali ADIYLA anmak zorunda:
   *     kaydın karşılığı olan telafi kontrolü, insanın neyi doğruladığını bilmesidir.
   */
  await izole(async () => {
    __setSimSwapKanalForTests({ verifySimSwap: async () => undefined });
    __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => false });
    const sorulanlar: string[] = [];
    const sonuc = await onayAl(
      istemSunucu(sorulanlar),
      {
        eylem: "bütçe artışı",
        satirlar: [],
        risk: "high",
        agAyar: { ...TEK_HALKA, stepUp: true, devSwapCheck: true },
      },
      undefined
    );
    assert.equal(sorulanlar.length, 1, "KEFİLLİ kademe istem göstermeli — 3. maddenin kaydı bunu ilan ediyor");
    assert.match(sorulanlar[0], /SIM Swap/, "kademe istemi, bozuk sinyali ADIYLA anmalı");
    assert.equal(sonuc.kanal, "insan", "kefilli kademede karar İNSAN kanalından çıkmalı");
  });

  /**
   * İkinci kapalı-arıza biçimi: kapı hiç KOŞAMADI (yapılandırma onay kapısına ulaşmadı).
   * "Kapı çalıştırılamadı" da bir belirsizliktir ve yine istemsiz redde gider.
   */
  const sorulanlar2: string[] = [];
  const sonuc2 = await onayAl(
    istemSunucu(sorulanlar2),
    { eylem: "bütçe artışı", satirlar: [], risk: "medium" },
    undefined
  );
  assert.equal(sonuc2.onaylandi, false, "yapılandırma kapıya ulaşmadıysa işlem geçmemeli");
  assert.equal(sorulanlar2.length, 0, "kapı koşamadığında da istem gösterilmemeli");
});

/* ── K3) 3. değişmez, ADS yarısı: okunamayan kampanya durumunda onay İSTENİR ──── */

test("SECURITY.md 3. değişmez: Ads tarafında okunamayan durum onay İSTETİR", async () => {
  /**
   * KIRMIZI OLMA YÖNÜ — BELGE: madde tek yöne indirgenirse. İki yarı da gerçek: aynı
   * "kapalı arıza" adı, iki yüzeyde iki AYRI davranışa karşılık geliyor ve belgenin ikisini
   * de söylemesi gerekiyor — yoksa okur, kapının kuralını Ads tarafına (ya da tersini)
   * taşır.
   */
  assert.match(UCUNCU, /Ads tarafı:/i, "3. madde Ads yüzeyini ayrı ele almıyor");
  assert.match(UCUNCU, /yayında sayılır/i, "okunamayan durumun YAYINDA sayıldığı yazılmalı");
  assert.match(UCUNCU, /onay istenir/i, "Ads tarafının onay İSTEDİĞİ yazılmalı");

  /**
   * KIRMIZI OLMA YÖNÜ — KOD: canlı-kampanya kapısı okunamayan durumu taslak sayarsa.
   * Ölçüm iki adımlı, çünkü "onay istenir" ile "düpedüz reddedilir" farklı şeyler:
   *   (a) onaysız çağrı yazmaz ve belirsizliği KULLANICIYA bildirir,
   *   (b) onay verildiğinde AYNI çağrı geçer — demek ki durduran şey bir ONAY kapısıydı.
   */
  const args = {
    customerId: "1234567890",
    adGroupId: "200057393038",
    finalUrl: "https://ornek.com",
    headlines: ["Bir", "Iki", "Uc"],
    descriptions: ["Aciklama bir", "Aciklama iki"],
  };

  const bos = sahteContext({ queries: [[/FROM ad_group\b/, []]] });
  const c1 = await baglanti(bos.ctx);
  const red = await cagir(c1, "create_responsive_search_ad", args);
  assert.match(red, /doğrulanamadı/, "belirsizlik kullanıcıya bildirilmeli");
  assert.equal(bos.rec.mutations.length, 0, "durum doğrulanmadan yazma gitmemeli");

  const bos2 = sahteContext({ queries: [[/FROM ad_group\b/, []]] });
  const c2 = await baglanti(bos2.ctx);
  const ok = await cagir(c2, "create_responsive_search_ad", { ...args, confirm: true });
  assert.match(ok, /RSA oluşturuldu/, "onay verilince aynı çağrı geçmeli — durduran şey ONAY kapısıydı");
  assert.equal(bos2.rec.mutations.filter((m) => m.kind === "adGroupAds").length, 1);
});
