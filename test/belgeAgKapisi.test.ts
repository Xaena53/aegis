// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CHANGELOG ↔ AĞ KAPISI: sürüm notunun anlattığı doktrin kodun bugünkü doktrini mi?
 *
 * NEDEN VAR (ölçüldü). Bu depoda kademeli doğrulama (`AEGIS_STEPUP`) için belge gözcüsü
 * ZATEN vardı — test/zincirBelgeKademe.test.ts — ama üç dosyaya bakıyordu: README.md,
 * README.tr.md, docs/DEMO.md. CHANGELOG.md o ağın DIŞINDAYDI ve tek gözcüsü
 * (test/anahtarBelgesi.test.ts) yalnız AEGIS_MASTER_KEY bloğunu okuyordu. Sonuç:
 *
 *   `grep -c AEGIS_STEPUP CHANGELOG.md` → 0
 *
 * ve dosya hâlâ ESKİ MUTLAK DOKTRİNİ anlatıyordu: "A recently swapped approver SIM is
 * refused outright and the prompt is never shown". Bugünkü kodda bu cümle KOŞULLU:
 * ölçüldü (scripts yerine doğrudan `agDogrula` ile), `AEGIS_STEPUP=1` altında
 * "sim-degisti" reddi askıya alınır, kalan halkalar yine koşar ve gerçek bir kanaldan
 * temiz dönen KEFİL varsa ret bir YÜKSELTMEYE dönüşür (test/kademeliDogrulama.test.ts
 * bunu uçtan uca sabitliyor). Depo PUBLIC ve jüri CHANGELOG'u okuyacak; sürüm notu
 * kapının tersine çalışan bir davranışını KURAL diye ilan ediyordu.
 *
 * BU DOSYANIN SÖZLEŞMESİ — her gözcü ÇİFT YÖNLÜ olmalı:
 *   (a) BELGE kayarsa kırmızı: cümle koşulunu kaybederse, liste eksilirse, bölüm silinirse.
 *   (b) KOD kayarsa kırmızı: KADEME_UYGUN değişirse, step-up varsayılanı dönerse,
 *       kefalet tabloları gevşerse — çünkü o an CHANGELOG'daki cümle YANLIŞ olur.
 * Tek yönlü bir gözcü (yalnız "şu kelime geçiyor mu") bu fazda vakum çıktı; buradaki her
 * test için hangi yönden kırmızı olduğu yorumda yazılıdır.
 *
 * Hiçbir test kapı mantığına dokunmaz, gevşetmez, ağa çıkmaz.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HALKA_SAPTAMA_NEDENI,
  KADEME_UYGUN,
  KEFIL_ESLEMESI,
  RISK_HALKA_ESLEMESI,
  YANITSIZ_KEFIL_ESLEMESI,
  ZINCIR_HALKALARI,
  ZINCIR_ORTAK_ENVLERI,
  agDogrula,
  maskele,
  __setCagriYonlendirmeKanalForTests,
  __setCihazDegisimKanalForTests,
  __setErisimKanalForTests,
  __setKonumKanalForTests,
  __setNacIstemciFabrikasiForTests,
  __setSimSwapKanalForTests,
  type AgRisk,
  type AgAyar,
  type AgIz,
} from "../src/networkTrust.js";
import { onayAl } from "../src/approval.js";
import { KARAR_SONUCLARI, agKararKaydiOlustur } from "../src/kararGunlugu.js";
import { nacConfigFromEnv } from "../src/config.js";

/**
 * CRLF'e NORMALLEŞTİRİLEREK okunur. Aşağıdaki bölüm/cümle sınırları boşluk arıyor;
 * Windows'ta dosya CRLF'e çevrildiğinde sınırlar kayar ve gözcü bölüm yerine dosyanın
 * yarısını tarar. Kırmızı olma sebebi belgenin İÇERİĞİ olmalı, kaydedildiği işletim
 * sistemi değil (aynı tuzak test/zincirBelgeKademe.test.ts'te ölçüldü).
 */
const CHANGELOG = readFileSync(
  fileURLToPath(new URL("../CHANGELOG.md", import.meta.url)),
  "utf8"
).replace(/\r\n/g, "\n");

/** `- **` ile başlayan bir madde: çapadan bir sonraki maddeye kadar. */
function madde(capa: string): string {
  const bas = CHANGELOG.indexOf(capa);
  assert.notEqual(
    bas,
    -1,
    `CHANGELOG.md'de "${capa}" maddesi bulunamadı. Madde yeniden adlandırıldıysa gözcü ` +
      `SESSİZCE boşa düşmesin diye burada durur: çapayı güncelle ya da maddeyi geri getir.`
  );
  const son = CHANGELOG.indexOf("\n- **", bas + 1);
  return CHANGELOG.slice(bas, son === -1 ? undefined : son);
}

/**
 * CÜMLE kapsamı, satır kapsamı DEĞİL — ve bu bilinçli bir seçim.
 *
 * CHANGELOG ~95 sütuna elle sarılmış düzyazıdır: tek bir iddia rutin olarak üç satıra
 * yayılır, dolayısıyla "koşul AYNI SATIRDA olsun" kuralı burada belgenin biçimini
 * denetlerdi, anlamını değil. Paragraf kapsamı ise ters yönde ölçülmüş bir hata:
 * paragrafın herhangi bir yerindeki tek bir "step-up" kelimesi bütün cümleleri
 * "kanıtlanmış" sayar. Cümle, bir iddianın doğal birimidir.
 */
function cumleler(metin: string): string[] {
  return metin.split(/(?<=[.?!])\s+/);
}

/* ── 1) Kademeli doğrulama CHANGELOG'a GİRMİŞ ve listesi KODDAN türüyor ──────── */

test("CHANGELOG kademeli doğrulamadan söz ediyor (grep=0 gerilemesi)", () => {
  /**
   * KIRMIZI OLMA YÖNÜ: belge. Bölüm silinir ya da `AEGIS_STEPUP` adı CHANGELOG'dan
   * düşerse burası kırmızıdır — bu testin doğduğu durumun ta kendisi.
   */
  assert.match(
    CHANGELOG,
    /AEGIS_STEPUP/,
    "CHANGELOG.md `AEGIS_STEPUP`'tan hiç söz etmiyor. Sürüm notunu okuyan (ve deponun " +
      "geri kalanını okumayan) bir değerlendirici, kapının koşulsuz reddettiğini sanır."
  );
});

test("CHANGELOG'un step-up maddesi KADEME_UYGUN'un TAM listesini sayıyor", () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ.
   *   - Kod: KADEME_UYGUN'a yeni bir neden eklenirse CHANGELOG eksik kalır → kırmızı.
   *   - Belge: listeden bir neden düşerse ya da yükseltilEMEYEN bir neden listeye
   *     sızarsa → kırmızı. İkincisi bir güvenlik yanlış beyanıdır: belge, kapının
   *     yumuşatMADIĞI bir sinyali yumuşuyor gösterir.
   */
  const blok = madde("- **Step-up verification (`AEGIS_STEPUP`)");
  const sayilan = new Set(
    [...blok.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1])
      .filter((s) => /^[a-z]+(?:-[a-z]+)+$/.test(s))
  );

  assert.deepEqual(
    [...sayilan].sort(),
    [...KADEME_UYGUN].sort(),
    "CHANGELOG.md'nin step-up maddesi ile src/networkTrust.ts · KADEME_UYGUN ayrışmış. " +
      "Bu liste, kapının 'koşulsuz reddeder' davranışının tam olarak NEREDE koşullu " +
      "hâle geldiğini söyler; eksiği de fazlası da okuyucuyu yanlış yönlendirir."
  );
});

test("kod: yükseltilemez nedenler KADEME_UYGUN'a sızmamış — CHANGELOG'un dışlama maddesi", () => {
  /**
   * KIRMIZI OLMA YÖNÜ: kod. CHANGELOG "Call forwarding never escalates — active or
   * silent — and neither does a configuration fault" diyor. O cümle ancak bu üç neden
   * KADEME_UYGUN'un DIŞINDA kaldığı sürece doğrudur; içeri alınırsa cümle yalan olur ve
   * bu test onu belge güncellenmeden yakalar.
   */
  for (const neden of ["cagri-yonlendirme-acik", "nv-uyusmadi", "yapilandirma-celiskili"] as const) {
    assert.equal(
      KADEME_UYGUN.has(neden),
      false,
      `'${neden}' KADEME_UYGUN'a eklenmiş — CHANGELOG bunun ASLA yükseltilmediğini yazıyor. ` +
        `Bu bir güvenlik gerilemesiyse geri al; kasıtlıysa CHANGELOG'un dışlama maddesi yalan.`
    );
  }
  assert.match(
    madde("- **Call forwarding never escalates"),
    /configuration/i,
    "CHANGELOG'un dışlama maddesi yapılandırma hatasını anmıyor — oysa kodda " +
      "`yapilandirma-celiskili` de yükseltilemez ve sebebi operatörün durumu olması."
  );
});

/* ── 2) 'İstem hiç gösterilmez' iddiası KOŞULA bağlı mı? ─────────────────────── */

/**
 * ONAY İSTEMİNİN HİÇ GÖSTERİLMEDİĞİNİ söyleyen kalıplar. Her biri, KADEME_UYGUN
 * kapsamındaki bir sinyalin sonucunu anlatırsa KOŞULLUDUR ve koşulunu söylemek zorundadır.
 */
const MUTLAK_IDDIA: readonly RegExp[] = [
  /refused outright/i,
  /prompt is never shown/i,
  /never (?:asked|prompted)/i,
  /before any (?:human )?prompt\b/i,
  /zero (?:prompts|elicitations)/i,
  /refuses immediately/i,
];

/** İddiayı koşula bağlayan ifadeler — aynı CÜMLEDE bulunmak zorunda. */
const KOSUL = /AEGIS_STEPUP|step-up|escalat/i;

test("CHANGELOG: 'istem hiç gösterilmez' diyen her cümle step-up koşulunu SÖYLÜYOR", () => {
  /**
   * KIRMIZI OLMA YÖNÜ: belge. Koşul cümleden çıkarılırsa — yani dosya eski mutlak
   * doktrinine dönerse — burası kırmızıdır.
   */
  const suclular: string[] = [];
  for (const cumle of cumleler(CHANGELOG)) {
    if (!MUTLAK_IDDIA.some((d) => d.test(cumle))) continue;
    if (KOSUL.test(cumle)) continue;
    suclular.push(cumle.replace(/\s+/g, " ").trim().slice(0, 160));
  }

  assert.deepEqual(
    suclular,
    [],
    "Bu cümleler onay isteminin HİÇ gösterilmediğini KOŞULSUZ bir kural gibi yazıyor. " +
      "KADEME_UYGUN'daki her neden için bu yalnız `AEGIS_STEPUP=0` iken (varsayılan) " +
      "doğrudur; cümleyi koşula bağla:\n" +
      suclular.join("\n")
  );
});

test("gözcü vakum DEĞİL: mutlak-iddia cümlesi CHANGELOG'da GERÇEKTEN duruyor", () => {
  /**
   * Yukarıdaki test boş liste bekler, yani cümleler yeniden yazıldığında SESSİZCE
   * yeşile döner ve hiçbir şey ölçmez. Bu depoda tam olarak öyle bir test yazıldı ve
   * hiçbir koşulda kırmızı olamıyordu. Bu yüzden çapa cümlenin KENDİSİ sınanır: hem
   * durduğu, hem koşulunu taşıdığı.
   */
  const capa = cumleler(CHANGELOG).filter((c) => /swapped approver SIM/i.test(c));
  assert.equal(
    capa.length,
    1,
    "CHANGELOG'da 'swapped approver SIM' cümlesi tam olarak bir kez geçmiyor " +
      `(bulunan: ${capa.length}). Cümle yeniden yazıldıysa bu gözcünün çapasını da ` +
      "güncelle; yoksa yukarıdaki tarayıcı hiçbir şey ölçmez."
  );
  assert.ok(
    MUTLAK_IDDIA.some((d) => d.test(capa[0])),
    "Çapa cümle artık hiçbir mutlak-iddia kalıbına uymuyor — desenler bayatlamış, " +
      "tarayıcı boşa düşer."
  );
  assert.match(
    capa[0],
    KOSUL,
    "SIM değişimi reddi KOŞULSUZ anlatılıyor. Bugünkü kodda `AEGIS_STEPUP=1` altında bu " +
      "ret askıya alınır ve gerçek kefil varsa YÜKSELTMEYE döner (bkz. agDogrula)."
  );
});

/* ── 3) Kod tarafı: CHANGELOG'un iddia ettiği değişmezler hâlâ duruyor mu? ───── */

test("kod: step-up VARSAYILAN OLARAK KAPALI — CHANGELOG 'off by default' diyor", () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ. Varsayılan koddan OKUNUR (ortam değişkeni silinerek),
   * belge iddiası ayrıca aranır. Kod varsayılanı açığa çevrilirse CHANGELOG'un
   * "off by default" cümlesi yalan olur ve burası kırmızıdır.
   */
  const onceki = process.env.AEGIS_STEPUP;
  let varsayilan: boolean;
  try {
    delete process.env.AEGIS_STEPUP;
    varsayilan = nacConfigFromEnv().stepUp;
  } finally {
    if (onceki === undefined) delete process.env.AEGIS_STEPUP;
    else process.env.AEGIS_STEPUP = onceki;
  }

  assert.equal(
    varsayilan,
    false,
    "AEGIS_STEPUP varsayılanı AÇIK. Yükseltme bir GEVŞEMEDİR ve CHANGELOG onu " +
      "'off by default' diye duyuruyor; varsayılan bilerek çevrildiyse sürüm notu da " +
      "değişmeli (ve bu BREAKING'dir)."
  );
  assert.match(
    madde("- **Step-up verification (`AEGIS_STEPUP`)"),
    /off by default/i,
    "CHANGELOG'un step-up maddesi varsayılanın KAPALI olduğunu söylemiyor — okuyucu " +
      "gevşemenin kendiliğinden geldiğini sanabilir."
  );
});

test("kod: erişilebilirlik ve NV halkaları HİÇBİR sinyale kefil olamaz", () => {
  /**
   * KIRMIZI OLMA YÖNÜ: kod. CHANGELOG "Reachability ... therefore vouches for nothing,
   * and neither does the simulation-only Number Verification link" diyor. Bu cümle
   * KEFIL_ESLEMESI'nin hiçbir satırında `reach`/`nv` bulunmamasına dayanır; biri
   * eklenirse cümle yalan olur — ve bu, ölçülmüş bir açığın (canlılık sinyalinin kimlik
   * sinyaline kefil olması) geri gelmesi demektir.
   */
  const sizanlar: string[] = [];
  for (const [neden, kefiller] of Object.entries(KEFIL_ESLEMESI)) {
    for (const id of kefiller) if (id === "reach" || id === "nv") sizanlar.push(`${neden} ← ${id}`);
  }
  for (const [halka, kefiller] of Object.entries(YANITSIZ_KEFIL_ESLEMESI)) {
    for (const id of kefiller) if (id === "reach" || id === "nv") sizanlar.push(`yanitsiz:${halka} ← ${id}`);
  }
  assert.deepEqual(
    sizanlar,
    [],
    "Kefalet tablolarına `reach`/`nv` sızmış:\n" +
      sizanlar.join("\n") +
      "\nCHANGELOG bunun tersini yazıyor. Erişilebilirlik bir CANLILIK sinyalidir " +
      "(saldırganın cihazı da ağa yanıt verir), NV ise yalnız simülasyondur."
  );
});

test("kod: SESSİZ çağrı yönlendirme halkasının kefili YOK — CHANGELOG 'refuses' diyor", () => {
  /**
   * KIRMIZI OLMA YÖNÜ: kod. "a silent call-forwarding check has an empty voucher set and
   * refuses" cümlesi doğrudan bu boş kümeye dayanır. Küme dolarsa, DURUMU BİLİNMEYEN
   * yönlendirme, DURUMU BİLİNEN yönlendirmeden daha hoşgörülü işlem görmeye başlar —
   * dosyanın kapalı-arıza sözleşmesinin tam tersi.
   */
  assert.deepEqual(
    [...(YANITSIZ_KEFIL_ESLEMESI["callFwd"] ?? [])],
    [],
    "Sessiz çağrı yönlendirme halkasına kefil atanmış. Zincirdeki başka hiçbir halka " +
      "yönlendirmeyi göremez; bir sinyali ÇÜRÜTEMEYEN halka ona kefil de olamaz."
  );
  assert.match(
    madde("- **The vouching rule"),
    /call-forwarding check has an empty voucher set/i,
    "CHANGELOG'un kefalet maddesi sessiz yönlendirme halkasının kefilsiz olduğunu " +
      "yazmıyor — kademenin en ters-sezgisel sınırı budur ve söylenmezse okunmaz."
  );
});

test("kod: yükseltme AYRI bir karar sonucu — CHANGELOG denetim izini doğru anlatıyor", () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ. Sonuç sözlüğünden "kademeli" düşerse (yani yükseltme
   * `gecti` içine katlanırsa) denetçi bir yükseltmeyi düz geçişten ayıramaz ve
   * CHANGELOG'un "never folded into `gecti`" cümlesi yalan olur.
   */
  assert.ok(
    (KARAR_SONUCLARI as readonly string[]).includes("kademeli"),
    "src/kararGunlugu.ts · KARAR_SONUCLARI artık 'kademeli' taşımıyor — yükseltme " +
      "başka bir sonuca katlanmışsa CHANGELOG'un denetim izi iddiası yanlış."
  );
  assert.match(
    madde("- **An escalation is a stronger consent"),
    /"karar":"kademeli"/,
    "CHANGELOG, yükseltmenin denetim izinde KENDİ sonucu olarak yazıldığını söylemiyor."
  );
});

/* ── 4) CHANGELOG'un SAYILARI: prozadan mı yazılmış, ÖLÇÜMDEN mi? ────────────── */

/** SIM Swap halkasını açan, kademe KAPALI taban yapılandırma (bu bölüme özel). */
const KDM_AYAR: AgAyar = {
  nacToken: "TEST-ONLY-gercek-token",
  approverPhone: "+905321234567",
  simSwapWindowHours: 72,
};

/**
 * Kademe cümlesindeki saat değerleri PROZADAN değil DAVRANIŞTAN doğrulanır: `agDogrula`
 * gerçekten koşturulur ve izin `pencereSaat` alanı okunur. `MEDIUM_WINDOW_HOURS` dışa
 * verilmemiştir; onu import etmek zaten kodun ikinci bir kopyasını doğrulamak olurdu —
 * burada kapının GERÇEKTEN sorduğu pencere ölçülür.
 */
async function olculenPencere(risk: AgRisk, ayar: AgAyar): Promise<number | undefined> {
  __setSimSwapKanalForTests({ verifySimSwap: async () => false });
  try {
    return (await agDogrula(ayar, risk)).iz.pencereSaat;
  } finally {
    __setSimSwapKanalForTests(undefined);
  }
}

/** "Risk is tiered: …" cümlesi — çapa, ayrı bir testte ayrıca sınanır. */
function kademeCumlesi(): string {
  const m = CHANGELOG.match(/Risk is tiered:[^.]*\./);
  assert.ok(
    m,
    "CHANGELOG.md'de 'Risk is tiered: …' cümlesi yok. Cümle yeniden adlandırıldıysa " +
      "aşağıdaki sayı gözcüleri SESSİZCE boşa düşmesin diye burada durulur."
  );
  return m[0].replace(/\s+/g, " ");
}

test("CHANGELOG: kademe cümlesinin saat sayıları ÖLÇÜLEN pencerelerle aynı", async () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ.
   *   - Belge: cümledeki 24/72 elle değiştirilirse ölçümle ayrışır → kırmızı.
   *   - Kod: medium kademesinin tavanı (MEDIUM_WINDOW_HOURS) ya da yapılandırılmamış
   *     pencerenin 72'lik varsayılanı değiştirilirse cümle YALAN olur → kırmızı.
   * Bu iki sayı, jüriye "kapı ne kadar geriye bakıyor" diye anlatılan tek nicel iddiadır;
   * kaynağı proza olamaz.
   */
  const cumle = kademeCumlesi();
  const sayilar = [...cumle.matchAll(/(\d+)\s*h\b/g)].map((m) => Number(m[1]));
  assert.equal(
    sayilar.length,
    2,
    `Kademe cümlesi iki saat değeri saymıyor (bulunan: ${sayilar.join(", ") || "yok"}). ` +
      "Bir kademenin penceresi belgeden düşerse okuyucu onu ötekiyle aynı sanır."
  );

  const olculen = [
    await olculenPencere("medium", KDM_AYAR),
    await olculenPencere("high", KDM_AYAR),
  ];
  assert.deepEqual(
    sayilar,
    olculen,
    `CHANGELOG ${sayilar.join("h / ")}h diyor, kapı ${olculen.join("h / ")}h soruyor ` +
      "(medium / high). Sürüm notundaki sayı ölçülmemiş bir iddiadır."
  );
});

test("CHANGELOG: 'caps' ve 'configured window in full' ölçümle DOĞRULANIYOR", async () => {
  /**
   * NEDEN BU CÜMLE DEĞİŞTİ (ölçüldü). Dosya önce "a budget increase uses a 24 h lookback,
   * a go-live widens to the configured window" diyordu. Kodda medium kademesi
   * `Math.min(24, yapılandırılan)`, yani 24 bir SABİT değil TAVANDIR:
   *
   *   AEGIS_SIMSWAP_WINDOW_HOURS=6 → medium `pencereSaat`=6, high `pencereSaat`=6
   *
   * Yani o kurulumda ne "24 h lookback" doğruydu ne de high'ın "widens" iddiası. Cümle
   * ölçüme hizalandı; bu test iki yarısını da ölçerek sabitler.
   *
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ. Cümle eski mutlak hâline döndürülürse belge tarafından;
   * medium tavan olmaktan çıkıp sabitlenirse ya da high yapılandırmayı dinlemez olursa
   * kod tarafından.
   */
  const cumle = kademeCumlesi();
  assert.match(
    cumle,
    /caps the lookback at 24 h/i,
    "Kademe cümlesi medium penceresini SABİT gibi anlatıyor. Kod `Math.min` uygular: " +
      "24 saat bir tavandır, daha dar bir yapılandırma onu da daraltır."
  );
  assert.match(
    cumle,
    /configured window in full/i,
    "Kademe cümlesi high kademesinin yapılandırılan pencereyi OLDUĞU GİBİ kullandığını " +
      "söylemiyor — 'widens' iddiası dar yapılandırmada yanlıştır."
  );

  // Tavan davranışının kendisi: 6 saatlik yapılandırmada İKİ kademe de 6 saat sorar.
  const dar: AgAyar = { ...KDM_AYAR, simSwapWindowHours: 6 };
  assert.equal(await olculenPencere("medium", dar), 6, "medium 24'ü SABİT uyguluyor — tavan değil");
  assert.equal(await olculenPencere("high", dar), 6, "high yapılandırılan pencereyi dinlemiyor");

  // Ve high gerçekten yapılandırmayı okuyor, 72'yi sabitlemiyor.
  const genis: AgAyar = { ...KDM_AYAR, simSwapWindowHours: 96 };
  assert.equal(await olculenPencere("high", genis), 96, "high penceresi 72'ye çakılı");
});

/* ── 5) 'Six-link' iddiası zincirin GERÇEK boyu mu ───────────────────────────── */

/** CHANGELOG düzyazı sayı adı kullanır; zincir boyu sayıdır. Tek dönüşüm tablosu. */
const SAYI_ADI: Readonly<Record<number, string>> = Object.freeze({
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
});

/** Zincir maddesi ve içindeki halka sayımı — iki test de aynı okumayı kullanır. */
function zincirMaddesi(): { blok: string; sayilanlar: string[] } {
  const blok = madde("- **A six-link trust chain**");
  const liste = blok.match(/asked for:\s*([^.]*)\./);
  assert.ok(liste, "Zincir maddesi halkaları saymıyor — 'asked for: …' listesi kayıp.");
  const sayilanlar = liste[1]
    .replace(/\s+/g, " ")
    .split(/,\s*|\s+and\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { blok, sayilanlar };
}

test("CHANGELOG'un 'six-link' iddiası ZINCIR_HALKALARI'nın gerçek boyu", () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ. Zincire yedinci halka eklenirse beklenen ad "seven"
   * olur ve CHANGELOG'daki "six-link" kırmızıya döner; madde elle "five-link" yapılırsa
   * da kırmızıdır. ARCHITECTURE.md için aynı iddianın gözcüsü zaten vardı — CHANGELOG o
   * ağın DIŞINDAYDI, ve jüriye "altı halka" diyen ilk dosya budur.
   */
  const boy = ZINCIR_HALKALARI.length;
  const ad = SAYI_ADI[boy];
  assert.ok(ad, `Zincir boyu ${boy} için sayı adı tablosu yok — SAYI_ADI'yı genişlet.`);

  const { blok, sayilanlar } = zincirMaddesi();
  assert.match(
    blok,
    new RegExp(`\\b${ad}-link\\b`, "i"),
    `Zincir ${boy} halka (src/networkTrust.ts · ZINCIR_HALKALARI) ama CHANGELOG "${ad}-link" ` +
      "demiyor. Sürüm notunu okuyan bir değerlendirici kapının boyunu yanlış öğrenir."
  );
  assert.equal(
    sayilanlar.length,
    boy,
    `Zincir maddesi ${sayilanlar.length} halka sayıyor, kayıtta ${boy} var: ` +
      `${sayilanlar.join(" | ")}. Adı geçmeyen halka, anlatılmayan bir ret sebebidir.`
  );
});

test("gözcü vakum DEĞİL: sayı-adı eşleşmesi YANLIŞ boyu ELER", () => {
  /**
   * Yukarıdaki testin iki iddiası da "eşleşiyor mu" biçiminde; yanlış kurulmuş bir desen
   * her metinde yeşil kalırdı. Bu depoda tam olarak öyle bir gözcü yazıldı. Burada aynı
   * karşılaştırma KASITLI YANLIŞ bir boyla kurulur ve ELEMESİ beklenir — yani ölçüm
   * gerçekten ayırt ediyor.
   */
  const boy = ZINCIR_HALKALARI.length;
  const { blok, sayilanlar } = zincirMaddesi();

  const yanlisBoy = boy === 6 ? 7 : 6;
  const yanlisAd = SAYI_ADI[yanlisBoy];
  assert.ok(yanlisAd, "kontrol grubu için sayı adı yok");
  assert.doesNotMatch(
    blok,
    new RegExp(`\\b${yanlisAd}-link\\b`, "i"),
    `Zincir maddesi hem "${SAYI_ADI[boy]}-link" hem "${yanlisAd}-link" içeriyor — desen ` +
      "ayırt etmiyor, gözcü vakum."
  );
  assert.notEqual(
    sayilanlar.length,
    yanlisBoy,
    "Halka sayımı kontrol grubunu da geçiyor — bölme deseni bayatlamış olabilir."
  );
});

/* ── 6) Step-up bir GEVŞEMEDİR: CHANGELOG onu KOŞULSUZ mu anlatıyor? ─────────── */

/**
 * NEDEN BU BÖLÜM VAR (ölçüldü). CHANGELOG kademeli doğrulamayı iki yerde KOŞULSUZ
 * anlatıyordu — yani step-up'ın KENDİSİNİ yükseltmenin sebebi gibi:
 *
 *   giriş maddesi : "with step-up on, that same signal is escalated instead of refused"
 *   Verified      : "with step-up on that same silence takes the escalation path instead
 *                    of ending the request"
 *
 * Kod bunu YAPMAZ. `agDogrula` doğrudan koşturularak ölçüldü (aşağıdaki üçüncü test aynı
 * ölçümü sabitler): `stepUp:true` + GERÇEKTEN değişmiş SIM + kefil olabilecek başka hiçbir
 * halka koşmamış → karar yine RET ("kademeli doğrulama açık, ama sinyali doğrulayacak
 * GERÇEK bir ağ halkası koşmadı"). Yükseltme step-up'ın değil KEFİLİN sonucudur.
 *
 * Bayat cümlenin YÖNÜ önemli: kapıyı OLDUĞUNDAN GEVŞEK gösteriyordu. `AEGIS_STEPUP=1`i
 * "SIM değişimi artık istem gösterir" diye okuyan bir operatör, kapının hâlâ reddettiği
 * bir kurulumu güvenli sanırdı. docs/DEMO.md aynı cümlede koşulu ZATEN söylüyordu; ayrışan
 * dosya CHANGELOG'du.
 *
 * ÇİFT YÖNLÜLÜK: (a) belge eski koşulsuz hâline dönerse tarayıcı kırmızı; (b) kod kefalet
 * şartını düşürür (kefilsiz yükseltirse) ya da yükseltmeyi tümden kaldırırsa ölçüm kırmızı.
 */

/** Cümle, step-up'ın reddi yükseltmeye çevirdiğini İDDİA ediyor mu? */
function yukseltmeIddiasi(cumle: string): boolean {
  return (
    /step-up|AEGIS_STEPUP/i.test(cumle) &&
    /escalat|no longer final|eligible/i.test(cumle) &&
    /refus|ending the request/i.test(cumle)
  );
}

/** İddiayı KEFİL şartına bağlayan ifadeler — aynı cümlede bulunmak zorunda. */
function kefilKosulu(cumle: string): boolean {
  return /only where|only if|vouch|came back clean|unless/i.test(cumle);
}

/**
 * Tarayıcının ÖLÇÜ ALETİ olduğunun kanıtı: dosyada gerçekten durmuş iki bayat cümle.
 * Bunlar birer KONTROL GRUBUDUR; tarayıcı ikisini de "iddia, ama koşulsuz" diye ayırt
 * edemiyorsa aşağıdaki boş-liste testi hiçbir şey ölçmüyor demektir.
 */
const ESKI_KOSULSUZ_CUMLELER: readonly string[] = [
  "While step-up verification is off (`AEGIS_STEPUP=0`, the default) a recently swapped " +
    "approver SIM is refused outright and the prompt is never shown, on the reasoning that " +
    "whoever would answer it may be the attacker; with step-up on, that same signal is " +
    "escalated instead of refused — see the entries below.",
  "A line the platform fails on returns 500 and, at the default `AEGIS_STEPUP=0`, the gate " +
    "refuses fail-closed with the upstream body redacted and the number masked; with step-up " +
    "on that same silence takes the escalation path instead of ending the request.",
];

test("gözcü vakum DEĞİL: tarayıcı ESKİ koşulsuz cümleleri GERÇEKTEN ayırt ediyor", () => {
  for (const eski of ESKI_KOSULSUZ_CUMLELER) {
    assert.ok(
      yukseltmeIddiasi(eski),
      "Tarayıcı, dosyada GERÇEKTEN durmuş bir yükseltme iddiasını tanımıyor — desenler " +
        `bayatlamış ve aşağıdaki gözcü vakum:\n${eski}`
    );
    assert.equal(
      kefilKosulu(eski),
      false,
      "Kontrol grubu cümlesi KOŞULLU sayılıyor — koşul deseni her metne uyuyor demektir; " +
        `bu hâlde boş-liste testi hiçbir şeyi eleyemez:\n${eski}`
    );
  }
});

test("CHANGELOG: step-up'ın yükseltmesini anlatan her cümle KEFİL şartını söylüyor", () => {
  /**
   * KIRMIZI OLMA YÖNÜ: belge. Cümle "step-up açıksa yükseltilir" hâline döndürülürse
   * burası kırmızıdır — bu testin doğduğu durumun ta kendisi.
   */
  const iddialar = cumleler(CHANGELOG).filter(yukseltmeIddiasi);
  assert.ok(
    iddialar.length >= 2,
    `CHANGELOG'da step-up yükseltmesini anlatan cümle sayısı ${iddialar.length}. Kademeli ` +
      "yol dosyanın en kritik GEVŞEMESİDİR; anlatılmıyorsa (ya da tarayıcının deseni " +
      "bayatladıysa) bu gözcü hiçbir şey ölçmüyor demektir."
  );

  const suclular = iddialar
    .filter((c) => !kefilKosulu(c))
    .map((c) => c.replace(/\s+/g, " ").trim().slice(0, 180));
  assert.deepEqual(
    suclular,
    [],
    "Bu cümleler yükseltmeyi step-up'ın KENDİSİNE bağlıyor. Ölçüldü: kefil olabilecek bir " +
      "halka koşmadan `agDogrula` yine REDDEDER; cümleyi kefil şartına bağla:\n" +
      suclular.join("\n")
  );
});

test("kod: KEFİLSİZ yükseltme YOK, kefille VAR — CHANGELOG'un koşulu ölçülür", async () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ, ve iki yarısı iki ayrı gerilemeyi yakalar.
   *   - Kefalet şartı düşerse (kefilsiz yükseltme) ilk yarı kırmızı: CHANGELOG'un
   *     "with no such voucher the same refusal still stands" cümlesi yalan olur.
   *   - Yükseltme tümden kalkarsa ikinci yarı kırmızı: bu kez "it turns into an escalation"
   *     yalan olur ve sürüm notu var olmayan bir çıkış yolu vaat eder.
   * Ölçüm ağa çıkmaz: iki halka da test kanalıyla beslenir.
   */
  const kefilsiz: AgAyar = { ...KDM_AYAR, stepUp: true };
  __setSimSwapKanalForTests({ verifySimSwap: async () => true });
  try {
    for (const risk of ["medium", "high"] as const) {
      const k = await agDogrula(kefilsiz, risk);
      assert.ok(
        k.engel,
        `${risk}: SIM değişmiş ve kefil olabilecek halka koşmamış — kapı yine de reddetmedi.`
      );
      assert.equal(
        k.kademe,
        undefined,
        `${risk}: kefilsiz YÜKSELTME verildi. Bu, kefalet ilkesinin (bir halka ancak ` +
          "çelişebileceği bir sinyale kefil olabilir) düşmesi demektir."
      );
      assert.notEqual(k.iz.kademe, "yukseltildi", `${risk}: iz kefilsiz yükseltme taşıyor.`);
    }

    // İkinci yarı: GERÇEKTEN gözlemiş bir kefil (konum halkası, hattı TR'de görüyor) varsa
    // yükseltme OLUR — yani cümlenin "turns into an escalation" yarısı da ölçülür.
    const kefilli: AgAyar = { ...kefilsiz, expectedCountry: "TR" };
    __setKonumKanalForTests({
      ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: ["TR"] }),
    });
    try {
      const k = await agDogrula(kefilli, "high");
      assert.equal(
        k.engel,
        undefined,
        "Kefil koşan bir zincirde SIM değişimi hâlâ düz retle bitiyor — CHANGELOG " +
          "'it turns into an escalation' diyor, yani var olmayan bir yolu anlatıyor."
      );
      assert.equal(k.kademe?.neden, "sim-degisti", "yükseltme bozulan sinyali adıyla taşımalı");
      assert.equal(k.iz.kademe, "yukseltildi", "iz yükseltmeyi kendi sonucu olarak taşımalı");
    } finally {
      __setKonumKanalForTests(undefined);
    }
  } finally {
    __setSimSwapKanalForTests(undefined);
  }

  assert.match(
    CHANGELOG,
    /with no such\s+voucher the same refusal still stands/i,
    "CHANGELOG'un giriş maddesi artık kefilsiz reddin AYAKTA KALDIĞINI söylemiyor — " +
      "ölçülen davranış budur ve sürüm notunun ilk maddesi jürinin okuduğu ilk cümledir."
  );
});

test("CHANGELOG'un 'gözlemsiz kefil olamaz' maddesi DAVRANIŞLA ölçülür", async () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ.
   *   - Belge: madde silinir ya da yeniden adlandırılırsa `madde()` çapası durdurur.
   *   - Kod: `gozlemsiz` süzgeci düşerse — yani ağın HİÇBİR ülke bildirmediği bir konum
   *     halkası yeniden kefil sayılırsa — ölçüm kırmızı olur. CHANGELOG bunun ölçülmüş bir
   *     açık olduğunu yazıyor: "a real `swapped:true` passed the gate vouched for by a
   *     location link that had never established which country the line was in".
   * İki yarı birlikte VAKUM DEĞİL: aynı düzenek yalnız GÖZLEM bakımından değiştirilir;
   * hattı TR'de gören halka yükseltmeyi taşır, hiçbir ülke görmeyen taşımaz.
   */
  assert.match(
    madde("- **A voucher must also have observed something"),
    /no country at all/i,
    "CHANGELOG'un gözlem maddesi, konum halkasının HİÇBİR ülke bildirilmeden temiz " +
      "dönebildiğini söylemiyor — kuralın neden gerektiği o cümlede duruyor."
  );

  const ayar: AgAyar = { ...KDM_AYAR, stepUp: true, expectedCountry: "TR" };
  __setSimSwapKanalForTests({ verifySimSwap: async () => true });
  try {
    // (a) Halka temiz döndü ama HİÇBİR ŞEY GÖZLEMEDİ: ağ ülke bildirmedi.
    __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: [] }) });
    const gozlemsiz = await agDogrula(ayar, "high");
    assert.ok(
      gozlemsiz.engel,
      "Hiçbir ülke gözlememiş konum halkası saptanmış bir SIM değişimini geçirdi — " +
        "CHANGELOG'un kapattığını yazdığı açığın ta kendisi."
    );
    assert.equal(gozlemsiz.kademe, undefined, "gözlemsiz halka YÜKSELTME taşıdı");

    // (b) Kontrol grubu: aynı halka hattı TR'de GÖRÜRSE kefil olur — ölçüm ayırt ediyor.
    __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: ["TR"] }) });
    const gozlemli = await agDogrula(ayar, "high");
    assert.equal(
      gozlemli.kademe?.neden,
      "sim-degisti",
      "GÖZLEM YAPMIŞ konum halkası da yükseltme taşımıyor — o hâlde (a) yarısı gözlemi " +
        "değil, kapalı bir halkayı ölçüyor olabilir: gözcü vakum."
    );
  } finally {
    __setKonumKanalForTests(undefined);
    __setSimSwapKanalForTests(undefined);
  }
});

/* ── 7) 'Exactly five reasons' — düzyazı sayı KADEME_UYGUN'un boyu mu ────────── */

test("CHANGELOG'un 'Exactly N reasons' sayısı KADEME_UYGUN'un GERÇEK boyu", () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ. Liste gözcüsü (bölüm 1) yalnız backtick'li adları
   * karşılaştırır: KADEME_UYGUN'a altıncı bir neden eklenip madde de güncellenirse liste
   * yeşil kalır ama "Exactly five" BAYATLAR. Sayı ile liste ayrı iki iddiadır; ikisi de
   * ölçülür. Maddeye elle "four" yazılması da kırmızıdır.
   */
  const blok = madde("- **Step-up verification (`AEGIS_STEPUP`)");
  const m = blok.match(/Exactly\s+([a-z]+)\s+reasons?\s+qualify/i);
  assert.ok(
    m,
    "Step-up maddesi 'Exactly N reasons qualify' demiyor. Cümle yeniden yazıldıysa bu gözcü " +
      "SESSİZCE boşa düşmesin diye burada durur: çapayı güncelle."
  );

  const boy = KADEME_UYGUN.size;
  const beklenen = SAYI_ADI[boy];
  assert.ok(beklenen, `KADEME_UYGUN boyu ${boy} için sayı adı tablosu yok — SAYI_ADI'yı genişlet.`);
  assert.equal(
    m[1].toLowerCase(),
    beklenen,
    `CHANGELOG "${m[1]}" neden sayıyor, src/networkTrust.ts · KADEME_UYGUN ${boy} taşıyor. ` +
      "Kapının kaç sinyalde yumuşadığı, sürüm notundaki tek nicel gevşeme iddiasıdır."
  );

  // Kontrol grubu: karşılaştırma YANLIŞ boyu gerçekten eliyor (eşitlik deseni vakum değil).
  const yanlisAd = SAYI_ADI[boy === 5 ? 6 : 5];
  assert.ok(yanlisAd, "kontrol grubu için sayı adı yok");
  assert.notEqual(
    m[1].toLowerCase(),
    yanlisAd,
    "Sayı hem doğru hem yanlış boya eşit çıkıyor — karşılaştırma ayırt etmiyor."
  );
});

/* ── README ↔ ölçülen gerçek · satır sayısı ve TR/EN komut paritesi ──────────── */

/**
 * NEDEN BURADA (ölçüldü). İki sapma daha; ikisi de "eksik cümle" değil BAYAT cümleydi.
 *
 *   (1) Her iki README de `scripts/demo-senaryo.mjs` için "1363 lines / 1363 satır"
 *       diyordu; `wc -l` 1514 ölçtü. Rakam elle yazılmıştı, dosya büyüdü, cümle bayatladı.
 *       Üstelik cümle tam da KAPSAM tartışmasının ortasında duruyor: "kanıtı olmayan şey
 *       iddia edilmez" diyen bir depoda yanlış bir sayı ucuz bir güven kaybıdır.
 *   (2) README.md'nin "Development" komut bloğu SEKİZ komut sayarken README.tr.md'nin
 *       "Geliştirme" bloğu ALTI sayıyordu: eksik olan `prova` ve `demo` — yani sahne günü
 *       ön-uçuşu ve demonun kendisi. Bu ürünün BİRİNCİL okuru Türkçe okuyan kişi; ondan
 *       gizlenen de tam olarak jüri önünde koşturulacak iki komuttu.
 *
 * ÇİFT YÖNLÜLÜK (bu dosyanın sözleşmesi):
 *   (a) BELGE kayarsa kırmızı: rakam elle bozulursa, bir dil diğerinden ayrışırsa.
 *   (b) KOD kayarsa kırmızı: betik büyür/küçülürse satır gözcüsü, belgelenen bir betik
 *       package.json'dan kalkarsa komut gözcüsü kızarır.
 * Desenini bulamayan gözcü de BAŞARISIZ olur: aradığını bulamadığı için yeşil kalan bir
 * belge testi vakumdur.
 */

/** Depo kökündeki bir dosya — LF'e normalleştirilir, gözcü satır sonuna değil içeriğe bakar. */
function kokDosya(goreliYol: string): string {
  return readFileSync(fileURLToPath(new URL(`../${goreliYol}`, import.meta.url)), "utf8").replace(
    /\r\n/g,
    "\n"
  );
}

/**
 * Satır sayısı — `wc -l` ile AYNI anlamda: sondaki newline yeni bir satır başlatmaz.
 * README'deki rakamın hangi ölçüyle karşılaştırıldığı belirsiz kalmasın.
 */
function satirSayisi(metin: string): number {
  const parcalar = metin.split("\n");
  if (parcalar.length > 0 && parcalar[parcalar.length - 1] === "") parcalar.pop();
  return parcalar.length;
}

/** `## Başlık` bölümü (bir sonraki `## `'e kadar). Başlık TAM eşleşir: Development≠Docker. */
function mdBolum(belge: string, baslik: string, ad: string): string {
  const satirlar = belge.split("\n");
  const bas = satirlar.findIndex((s) => s.trim() === `## ${baslik}`);
  assert.notEqual(bas, -1, `${ad} içinde "## ${baslik}" bölümü yok — test yolu bayatlamış`);
  const kalan = satirlar.slice(bas + 1);
  const son = kalan.findIndex((s) => s.startsWith("## "));
  return (son === -1 ? kalan : kalan.slice(0, son)).join("\n");
}

/** Bölümdeki ilk ```bash çitinin içeriği. */
function ilkBashBlogu(bolumMetni: string, ad: string): string {
  const eslesme = bolumMetni.match(/```bash\n([\s\S]*?)```/);
  assert.ok(eslesme, `${ad}: bölümde \`\`\`bash bloğu bulunamadı — test yolu bayatlamış`);
  return eslesme[1];
}

/**
 * Bloktaki npm betiklerinin ADLARI: `npm run prova -- --musteri <id>` → "prova",
 * `npm test` → "test". Karşılaştırma bayrak/yorum farkına değil ÇAĞRILAN BETİĞE bakar:
 * iki dilin yorumu elbette farklı, betik listesi farklı olamaz.
 */
function npmBetikAdlari(blok: string): string[] {
  const adlar: string[] = [];
  for (const satir of blok.split("\n")) {
    const kirpik = satir.trim();
    const calistir = kirpik.match(/^npm\s+run\s+([A-Za-z0-9:_-]+)/);
    if (calistir) {
      adlar.push(calistir[1]);
      continue;
    }
    const kisayol = kirpik.match(/^npm\s+(test|start)\b/);
    if (kisayol) adlar.push(kisayol[1]);
  }
  return adlar;
}

test("README'ler demo-senaryo.mjs'in GERÇEK satır sayısını söyler", () => {
  /**
   * NEDEN TAM SAYI DEĞİL, ALT SINIR. İlk hâli tam sayıyı ("1514") sabitliyordu ve bu gözcü
   * yazıldığı oturumda GERÇEKTEN kırmızı yandı: betik 1514'ten 1562 satıra çıktı. Yani
   * dosya, README'yi düzenleyemeyen başkaları tarafından düzenli olarak büyüyor. Tam sayıya
   * çakılmış bir iddia, her dokunuşta bu deponun kapısını başkasına kırdırırdı; oysa
   * cümlenin söylemek istediği şey rakamın kendisi değil, "bu dosya BÜYÜK ve testsizdi".
   *
   * Bu yüzden belge KANITLAYABİLECEĞİ bir alt sınır söyler ve gözcü iki yönden de bağlar:
   *   (a) ABARTMA YOK — belge dosyadan büyük bir sayı söyleyemez (gerçek >= iddia). Bu,
   *       deponun "kanıtı olmayan şey iddia edilmez" kuralının doğrudan uygulanışıdır.
   *   (b) BAYATLAMA YOK — alt sınır hâlâ EN SIKI 500'lük basamak olmalı (gerçek < iddia+500).
   *       Dosya 2000 satırı geçerse "1.500'ün üzerinde" teknik olarak doğru ama artık
   *       bilgilendirici değildir; o noktada cümle güncellenmek ZORUNDA.
   * Dosya alt sınırın altına düşerse de kırmızı olur: o zaman cümle düpedüz yanlıştır.
   */
  const gercek = satirSayisi(kokDosya("scripts/demo-senaryo.mjs"));
  assert.ok(gercek > 0, "scripts/demo-senaryo.mjs boş okundu");

  const iddialar: Array<[string, number]> = [];
  for (const [ad, desen] of [
    ["README.md", /`scripts\/demo-senaryo\.mjs`\s*—\s*over\s+([\d.,]+)\s+lines\b/],
    ["README.tr.md", /`scripts\/demo-senaryo\.mjs`\s*—\s*([\d.,]+)\s+satırın üzerinde\b/],
  ] as Array<[string, RegExp]>) {
    const eslesme = kokDosya(ad).match(desen);
    assert.ok(
      eslesme,
      `${ad}: demo-senaryo.mjs'in satır sayısı iddiası bulunamadı — cümle silindiyse bu ` +
        "gözcü de kaldırılmalı, yoksa hiçbir şeyi ölçmeden yeşil kalır"
    );
    iddialar.push([ad, Number(eslesme[1].replace(/[.,]/g, ""))]);
  }

  const BASAMAK = 500;
  for (const [ad, iddia] of iddialar) {
    assert.ok(
      gercek >= iddia,
      `${ad}: scripts/demo-senaryo.mjs "${iddia} satırın üzerinde" diyor, dosya ${gercek} satır — ` +
        "belge dosyadan BÜYÜK bir sayı iddia ediyor; kanıtı olmayan şey iddia edilmez"
    );
    assert.ok(
      gercek < iddia + BASAMAK,
      `${ad}: "${iddia} satırın üzerinde" iddiası bayatladı — dosya ${gercek} satır, yani alt ` +
        `sınır artık en sıkı ${BASAMAK}'lük basamak değil (her iki README'de de yükselt)`
    );
  }
});

test("iki README'nin geliştirme komut bloğu AYNI npm betiklerini sayar", () => {
  /**
   * Blok, deponun "bu depoyu nasıl koştururum" cevabıdır. Bir dilde eksik komut, o dilin
   * okuruna var olmayan bir sınır çizer: `prova`yı görmeyen Türkçe okur sahne günü
   * ön-uçuşunu hiç koşturmaz.
   */
  const en = npmBetikAdlari(
    ilkBashBlogu(mdBolum(kokDosya("README.md"), "Development", "README.md"), "README.md")
  );
  const tr = npmBetikAdlari(
    ilkBashBlogu(mdBolum(kokDosya("README.tr.md"), "Geliştirme", "README.tr.md"), "README.tr.md")
  );

  // Vakum koruması: blok boşalırsa deepEqual iki boş listeyi mutlu mesut eşitler.
  assert.ok(
    en.length >= 8,
    `README.md geliştirme bloğu ${en.length} komut sayıyor, en az 8 bekleniyordu`
  );

  assert.deepEqual(
    [...tr].sort(),
    [...en].sort(),
    `Geliştirme komut blokları ayrışmış — EN: [${en.join(", ")}] / TR: [${tr.join(", ")}]. ` +
      "İki README aynı komut kümesini saymalı."
  );
});

test("geliştirme bloğunda belgelenen her komut package.json'da GERÇEKTEN vardır", () => {
  /**
   * Gözcünün KODLA temas ettiği yer. Üstteki test iki BELGEYİ birbirine bağlar; ikisi
   * birden yanlış olsaydı sessiz kalırdı. Bu test listeyi package.json'a bağlar: belgelenen
   * bir betik kaldırılırsa ya da adı değişirse kırmızı olur.
   *
   * Ters yön kasıtlı olarak sınanmıyor: package.json'daki HER betiğin belgelenmesi
   * gerekmiyor (`predemo`, `preprova` gibi kanca betikleri okura anlatılacak şeyler
   * değil). Kural tek yönlü: belge, var olmayan bir komut VAAT EDEMEZ.
   */
  const paket = JSON.parse(kokDosya("package.json")) as { scripts?: Record<string, string> };
  const betikler = paket.scripts ?? {};
  assert.ok(Object.keys(betikler).length > 0, "package.json'da scripts yok — test yolu bayatlamış");

  for (const [ad, baslik] of [
    ["README.md", "Development"],
    ["README.tr.md", "Geliştirme"],
  ] as Array<[string, string]>) {
    const adlar = npmBetikAdlari(ilkBashBlogu(mdBolum(kokDosya(ad), baslik, ad), ad));
    assert.ok(adlar.length > 0, `${ad}: geliştirme bloğunda hiç npm komutu bulunamadı`);
    for (const betik of adlar) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(betikler, betik),
        `${ad} "npm run ${betik}" komutunu belgeliyor ama package.json'da böyle bir betik yok`
      );
    }
  }
});

/* ── README ↔ SAHNE komut bloğu · ikinci blok da ağa girsin ─────────────────── */

/**
 * NEDEN BURADA (bu turda MUTASYONLA ÖLÇÜLDÜ). Üstteki parite gözcüleri yalnız
 * "Development / Geliştirme" bölümünün İLK bash bloğunu okuyor. Oysa READMElerde İKİNCİ
 * bir komut bloğu daha var — "Seeing it run" / "Çalışırken görmek" — ve sahne günü jürinin
 * önünde gerçekten koşturulacak komutlar tam olarak oradakilerdir. O blok hiçbir gözcünün
 * ağında değildi; ölçüm şuydu:
 *
 *   README.md "Seeing it run" bloğunda `npm run prova` → `npm run provaX`
 *     ⇒ test/belgeAgKapisi.test.ts 37/37 YEŞİL kaldı.
 *
 * Yani sahne bloğunda var OLMAYAN bir komut belgelemek serbestti. Boşluk BAYRAKLARDA daha
 * da genişti: `--canli` demonun gerçekten yazma yapan bayrağıdır; belgede yanlış yazılsa ya
 * da kodda adı değişse hiçbir şey kızarmaz, komut sahnede sessizce KURU koşardı — ve kuru
 * koşu, ağ kapısının canlı çalıştığının kanıtı DEĞİLDİR.
 *
 * ÇİFT YÖNLÜLÜK (bu dosyanın sözleşmesi):
 *   (a) BELGE kayarsa kırmızı: iki dil ayrışırsa, bir komut ya da bayrak bir dilden düşerse.
 *   (b) KOD kayarsa kırmızı: belgelenen betik package.json'dan kalkarsa, ya da betiğin
 *       tanıdığı bayrağın adı değişirse — bayrak, betiğin KENDİ KAYNAĞINDA tırnak içinde
 *       (yani gerçek bir ayrıştırma yerinde) aranır, düz yorum metninde değil.
 */

/** Sahne bölümünün iki dildeki başlığı — tek yerde dursun ki bir dil sessizce düşmesin. */
const SAHNE_BOLUMU: Array<[string, string]> = [
  ["README.md", "Seeing it run"],
  ["README.tr.md", "Çalışırken görmek"],
];

/**
 * Bloğun `npm run <betik>` satırları: betik adı + O SATIRDA belgelenen uzun bayraklar.
 * `#` sonrası açıklama çeviriyle değişir, karşılaştırmaya girmez; bare `--` ayıracı da
 * bayrak sayılmaz (desen bayrağın harfle başlamasını ister).
 */
function npmSatirlari(blok: string): Array<{ betik: string; bayraklar: string[] }> {
  const satirlar: Array<{ betik: string; bayraklar: string[] }> = [];
  for (const ham of blok.split("\n")) {
    const komut = ham.split("#")[0].trim();
    const eslesme = komut.match(/^npm\s+run\s+([A-Za-z0-9:_-]+)/);
    if (!eslesme) continue;
    satirlar.push({
      betik: eslesme[1],
      bayraklar: [...new Set(komut.match(/--[A-Za-z][A-Za-z0-9-]*/g) ?? [])].sort(),
    });
  }
  return satirlar;
}

/** package.json betiğinin çalıştırdığı dosya: "node scripts/prova.mjs" → scripts/prova.mjs */
function betikDosyaYolu(paketKomutu: string): string | undefined {
  return paketKomutu.match(/scripts\/[A-Za-z0-9._-]+\.(?:mjs|mts|js)/)?.[0];
}

test("iki README'nin SAHNE komut bloğu aynı betikleri ve aynı bayrakları sayar", () => {
  const [enAd, enBaslik] = SAHNE_BOLUMU[0];
  const [trAd, trBaslik] = SAHNE_BOLUMU[1];
  const en = npmSatirlari(ilkBashBlogu(mdBolum(kokDosya(enAd), enBaslik, enAd), enAd));
  const tr = npmSatirlari(ilkBashBlogu(mdBolum(kokDosya(trAd), trBaslik, trAd), trAd));

  // Vakum koruması: blok boşalırsa deepEqual iki boş listeyi mutlu mesut eşitler.
  assert.ok(
    en.length >= 3,
    `README.md "${enBaslik}" bloğu ${en.length} komut sayıyor, en az 3 bekleniyordu`
  );
  assert.ok(
    en.some((s) => s.bayraklar.length > 0),
    "sahne bloğunda hiç bayrak belgelenmemiş — bayrak gözcüsünün ölçecek şeyi kalmaz"
  );

  const yaz = (liste: Array<{ betik: string; bayraklar: string[] }>): string =>
    liste.map((s) => `${s.betik} ${s.bayraklar.join(" ")}`.trim()).join(" | ");
  assert.deepEqual(
    tr,
    en,
    `Sahne komut blokları ayrışmış — EN: [${yaz(en)}] / TR: [${yaz(tr)}]. ` +
      "Jürinin önünde koşacak komutları iki README aynı yazmalı."
  );
});

test("belgelenen her bayrak, betiğin GERÇEKTEN ayrıştırdığı bir bayraktır", () => {
  /**
   * Gözcünün KODA dokunduğu yer. Üstteki test iki BELGEYİ birbirine bağlar; ikisi birden
   * yanlış olsaydı sessiz kalırdı. Burada zincir belge → package.json → betiğin kaynağı
   * diye uzar: `--canli` kodda `process.argv.includes("--canli")` olarak ayrıştırılmıyorsa
   * belge var olmayan bir bayrak vaat ediyordur.
   *
   * Ters yön kasıtlı olarak sınanmıyor: betiğin tanıdığı HER bayrağın belgelenmesi
   * gerekmiyor (`--kampanya` ileri seviye bir seçenek). Kural tek yönlü: belge, var
   * olmayan bir bayrak VAAT EDEMEZ.
   */
  const paket = JSON.parse(kokDosya("package.json")) as { scripts?: Record<string, string> };
  const betikler = paket.scripts ?? {};
  let olculenBayrak = 0;

  for (const [ad, baslik] of [
    ...SAHNE_BOLUMU,
    ["README.md", "Development"],
    ["README.tr.md", "Geliştirme"],
  ] as Array<[string, string]>) {
    for (const { betik, bayraklar } of npmSatirlari(
      ilkBashBlogu(mdBolum(kokDosya(ad), baslik, ad), ad)
    )) {
      const paketKomutu = betikler[betik];
      assert.ok(
        paketKomutu,
        `${ad} (${baslik}) "npm run ${betik}" belgeliyor ama package.json'da böyle bir betik yok`
      );
      if (bayraklar.length === 0) continue;
      const yol = betikDosyaYolu(paketKomutu);
      assert.ok(
        yol,
        `package.json "${betik}" betiğinden bir scripts/ dosyası çıkarılamadı: ${paketKomutu}`
      );
      const kaynak = kokDosya(yol);
      for (const bayrak of bayraklar) {
        olculenBayrak += 1;
        assert.ok(
          kaynak.includes(`"${bayrak}"`) || kaynak.includes(`'${bayrak}'`),
          `${ad} (${baslik}) "npm run ${betik} ${bayrak}" belgeliyor ama ${yol} bu bayrağı ` +
            "hiçbir yerde ayrıştırmıyor — belge var olmayan bir bayrak vaat ediyor"
        );
      }
    }
  }

  // Vakum koruması: hiç bayrak ölçmediyse bu test hiçbir şey kanıtlamamıştır.
  assert.ok(
    olculenBayrak >= 4,
    `yalnız ${olculenBayrak} bayrak ölçüldü — gözcü ağını kaybetmiş, blok desenleri bayatlamış olabilir`
  );
});

/* ── CONTRIBUTING.md ve docs/DOCKER.md · kapı TEK halkaya indirgenmesin ──────── */

/**
 * NEDEN BURADA (ölçüldü). İki sapma daha, ikisi de "yanlış cümle" değil EKSİK cümle
 * olduğu için hiçbir gözcünün ağına takılmıyordu.
 *
 *   (3) CONTRIBUTING.md'nin test haritası ("Kind of test | File") ağ kapısına ait TEK bir
 *       dosya anmıyordu. Katkıcıdan "her guard değişikliği test ister, ve o testin guard
 *       kaldırılınca GERÇEKTEN kızardığını sen doğrula" isteniyor — ama deponun merkezî
 *       guard'ının testleri haritada hiç yoktu. Katkıcı, altı halkalı zincirin testlerini
 *       80 dosyalık test/ dizininde ada bakarak arıyordu; bulamayınca yeni bir dosya açması
 *       da hiç test yazmaması da SESSİZ sonuçtur.
 *   (4) docs/DOCKER.md güven kapısını TEK halkaya indirgiyordu: `AEGIS_NAC_TOKEN` satırının
 *       tamamı "Real network-verified approvals (Nokia Network-as-Code / CAMARA SIM Swap)"
 *       idi ve env tablosunda `AEGIS_NAC_SIMULATE` dışında hiçbir halkanın değişkeni yoktu.
 *       Konteyneri kuran operatör için sonuç doğrudan ölçülebilir: token'ı yazar,
 *       erişilebilirlik / konum / cihaz değişimi / çağrı yönlendirme halkalarının VAR
 *       olduğunu bilmediği için hiçbirini açmaz, ve altı halkanın yalnız biri koşarken tam
 *       korumada olduğunu sanır.
 *
 * ÇİFT YÖNLÜLÜK (bu dosyanın sözleşmesi): iddialar KODDAN türetilir — `ZINCIR_HALKALARI`,
 * `ZINCIR_ORTAK_ENVLERI` ve test/ dizininin gerçek içeriği. (a) Belge kayarsa kırmızı:
 * satır silinir, sayı elle bozulur. (b) Kod kayarsa kırmızı: kayda halka eklenir, bir halka
 * canlıya çıkar, env adı değişir, haritadaki test dosyası yeniden adlandırılır.
 */

const KATKI_BELGESI = kokDosya("CONTRIBUTING.md");
const DOCKER_BELGESI = kokDosya("docs/DOCKER.md");

/** test/ dizinindeki test dosyaları — bu dosya hariç, kendine kefil olmasın. */
function agKapisiTestDosyalari(): string[] {
  return readdirSync(fileURLToPath(new URL("./", import.meta.url)))
    .filter((ad) => ad.endsWith(".test.ts") && ad !== "belgeAgKapisi.test.ts")
    .sort();
}

/** Bir test dosyasının kaynağı. */
function testKaynagi(ad: string): string {
  return readFileSync(fileURLToPath(new URL(`./${ad}`, import.meta.url)), "utf8");
}

/** CONTRIBUTING.md'nin test haritası satırları: "| ... | `test/x.test.ts`, ... |". */
function haritaSatirlari(): string[] {
  const bas = KATKI_BELGESI.indexOf("| Kind of test | File |");
  assert.notEqual(
    bas,
    -1,
    "CONTRIBUTING.md'de test haritası ('| Kind of test | File |') bulunamadı — başlık " +
      "değiştiyse bu gözcü SESSİZCE boşa düşmesin diye burada durur"
  );
  const son = KATKI_BELGESI.indexOf("\n\n", bas);
  return KATKI_BELGESI.slice(bas, son === -1 ? undefined : son)
    .split("\n")
    .filter((s) => s.startsWith("|") && s.includes("`test/"));
}

/** Haritada ADI GEÇEN test dosyaları (yalnız dosya adı; `test/` öneki atılmış). */
function haritadakiDosyalar(): string[] {
  const kume = new Set<string>();
  for (const satir of haritaSatirlari()) {
    for (const m of satir.matchAll(/`test\/([A-Za-z0-9.]+)`/g)) kume.add(m[1]);
  }
  return [...kume].sort();
}

test("CONTRIBUTING.md test haritasındaki her dosya GERÇEKTEN var", () => {
  /**
   * YÖN (b): kod. Bir test dosyası yeniden adlandırıldığında harita var olmayan bir yolu
   * göstermeye başlar ve katkıcı, aradığı guard'ın testi silinmiş sanır.
   */
  const mevcut = new Set(readdirSync(fileURLToPath(new URL("./", import.meta.url))));
  const adlar = haritadakiDosyalar();
  assert.ok(
    haritaSatirlari().length >= 8 && adlar.length >= 12,
    `test haritası beklenenden küçük (${haritaSatirlari().length} satır, ${adlar.length} dosya) — ` +
      "tablo yolu bayatlamış olabilir; gözcü boş kümeye bakıp yeşil kalmasın"
  );
  const eksik = adlar.filter((ad) => !mevcut.has(ad));
  assert.deepEqual(
    eksik,
    [],
    `CONTRIBUTING.md test haritası var olmayan dosyaları gösteriyor: ${eksik.join(", ")}`
  );
});

test("CONTRIBUTING.md test haritası HER halkanın testine işaret ediyor", () => {
  /**
   * Türetim HALKA HALKA, çünkü "kapının bir testi haritada var" YETMEZ — ölçüldü: bu
   * gözcünün ilk taslağı `src/networkTrust.js`'i çeken dosyaları arıyordu, ama
   * `approval.test.ts` de onu çekiyor ve haritada zaten vardı; kapı satırlarının TAMAMI
   * silindiğinde gözcü YEŞİL kalıyordu. Gevşek türetim, tam da yakalaması gereken sapmayı
   * kaçırıyordu.
   *
   * Bağ artık halkanın KENDİ ret imzasına kurulu (`retIsaretleri` — kayıttaki, gerçekten o
   * halkanın ret metninde geçen ifadeler). YÖN (a): kapı satırları silinirse kırmızı.
   * YÖN (b): kayda yedinci halka eklendiğinde, testi haritaya girene kadar kırmızı.
   */
  const haritada = new Set(haritadakiDosyalar());
  const dosyalar = agKapisiTestDosyalari().map((ad) => ({ ad, metin: testKaynagi(ad) }));
  const acikta: string[] = [];
  for (const halka of ZINCIR_HALKALARI) {
    const adaylar = dosyalar
      .filter(({ metin }) => halka.retIsaretleri.some((imza) => metin.includes(imza)))
      .map(({ ad }) => ad);
    assert.ok(
      adaylar.length > 0,
      `'${halka.id}' halkasının ret imzasını taşıyan HİÇBİR test dosyası yok — halkanın ` +
        "testi mi kalmadı, yoksa retIsaretleri mi bayatladı? Gözcü boş kümeye bakıp yeşil " +
        "kalmasın diye burada durur"
    );
    if (!adaylar.some((ad) => haritada.has(ad))) acikta.push(`${halka.id} → ${adaylar.join(", ")}`);
  }
  assert.deepEqual(
    acikta,
    [],
    "CONTRIBUTING.md test haritası bu halkaların testine hiç işaret etmiyor (halka → aday " +
      `dosyalar):\n${acikta.join("\n")}\n` +
      "Katkıcıdan her guard değişikliği için test isteniyor; deponun merkezî guard'ı " +
      "haritada görünmüyorsa o test ada bakarak aranmak zorunda kalır."
  );
});

test("CONTRIBUTING.md test haritası zincir KAYDININ bütünlük testini anıyor", () => {
  /**
   * Ayrı bir test, çünkü ayrı bir bilgi: halkanın kendi katmanını test etmek YETMEZ — bu
   * depoda dört tur üst üste halka eklendi, kapı çalıştı, aşağı akış (karar günlüğü,
   * contextFor önbellek anahtarı, ret sınıflandırıcısı) SESSİZCE bağlanmadan kaldı. O bağı
   * tutan dosya haritada olmalı ki katkıcı yeni halkasını nereye bağlayacağını dosya adına
   * bakarak değil haritadan öğrensin.
   */
  const kayitTestleri = agKapisiTestDosyalari().filter((ad) =>
    testKaynagi(ad).includes("ZINCIR_HALKALARI")
  );
  assert.ok(
    kayitTestleri.length >= 1,
    "test/ içinde ZINCIR_HALKALARI kaydını okuyan dosya bulunamadı — kaydın adı değiştiyse " +
      "bu gözcü boşa düşmesin diye burada durur"
  );
  const haritada = haritadakiDosyalar().filter((ad) => kayitTestleri.includes(ad));
  assert.notDeepEqual(
    haritada,
    [],
    "CONTRIBUTING.md test haritası, zincir kaydını aşağı akıştaki tüketicilerine bağlayan " +
      `testi anmıyor. Aday dosyalar: ${kayitTestleri.join(", ")}`
  );
});

/** docs/DOCKER.md'nin "## Environment variables" bölümü — geçerken düşen anma sayılmasın. */
function dockerEnvBolumu(): string {
  const bas = DOCKER_BELGESI.indexOf("## Environment variables");
  assert.notEqual(
    bas,
    -1,
    "docs/DOCKER.md'de '## Environment variables' bölümü bulunamadı — başlık değiştiyse bu " +
      "gözcü SESSİZCE boşa düşmesin diye burada durur"
  );
  const son = DOCKER_BELGESI.indexOf("\n## ", bas + 1);
  return DOCKER_BELGESI.slice(bas, son === -1 ? undefined : son);
}

test("docs/DOCKER.md zincirin BOYUNU koddan sayıyor (tek halkaya indirgemiyor)", () => {
  /**
   * İddia serbest metinde değil, koddan doğrulanabilir bir biçimde durmalı. YÖN (a): rakam
   * elle bozulursa ya da cümle silinirse kırmızı. YÖN (b): kayda yedinci halka eklenir ya da
   * bir halka canlıya çıkarsa belge kendiliğinden bayatlar ve burası kırmızı olur.
   */
  const m = dockerEnvBolumu().match(/\*\*(\d+) links, (\d+) live\*\*/);
  assert.ok(
    m,
    "docs/DOCKER.md'nin env tablosu zincirin boyunu ('**N links, M live**') hiç söylemiyor — " +
      "güven kapısı tek bir halkanın adıyla anılıyorsa operatör diğerlerini hiç açmaz"
  );
  const canli = ZINCIR_HALKALARI.filter((h) => h.canliDogrulandi).length;
  assert.equal(
    Number(m[1]),
    ZINCIR_HALKALARI.length,
    `docs/DOCKER.md ${m[1]} halka diyor, kayıtta ${ZINCIR_HALKALARI.length} halka var`
  );
  assert.equal(
    Number(m[2]),
    canli,
    `docs/DOCKER.md ${m[2]} halkayı canlı gösteriyor, kayıtta canlı doğrulanmış ${canli} halka var`
  );
});

test("docs/DOCKER.md env tablosu HER halkanın kendi değişkenlerini belgeliyor", () => {
  /**
   * Varlık sorusu, ama doğru yerde sorulmuş: bir halkanın env adı DOCKER.md'nin env
   * tablosunda geçmiyorsa konteyneri kuran kişi o halkayı AÇAMAZ — halkanın kodda var
   * olması onun için hiçbir şey ifade etmez. YÖN (b): kayda halka eklendiğinde ya da bir
   * env yeniden adlandırıldığında burası kırmızı olur.
   */
  const bolum = dockerEnvBolumu();
  const beklenen = [
    ...new Set([...ZINCIR_HALKALARI.flatMap((h) => [...h.envler]), ...ZINCIR_ORTAK_ENVLERI]),
  ].sort();
  assert.ok(
    beklenen.length >= 10,
    `zincir kaydından beklenenden az env türedi (${beklenen.length}) — kayıt alanı yeniden ` +
      "adlandırıldıysa bu gözcü boş listeye bakıp yeşil kalmasın"
  );
  const eksik = beklenen.filter((env) => !bolum.includes(env));
  assert.deepEqual(
    eksik,
    [],
    "docs/DOCKER.md env tablosu bu zincir değişkenlerinden hiç söz etmiyor: " +
      `${eksik.join(", ")}. Operatör, açamadığı halkayı koşuyor sanır.`
  );
});

/**
 * Yukarıdaki iki gözcü VARLIK soruyor: sayı doğru mu, env adı geçiyor mu. Env tablosunun
 * opt-in satırı ise DAVRANIŞ vaat ediyor ("off by default", "a value the parser can't read
 * leaves them off rather than on", "only on the high tier") ve bu üç cümleyi hiçbir şey
 * kodun yaptığına bağlamıyordu: `grep -rl DOCKER.md test/` yalnız anahtar belgesini ve yayın
 * yüzeyini buluyor, ikisi de kapıya bakmıyor. Sonuç ölçülebilir bir sessizlik olurdu —
 * parseBool varsayılanı ya da RISK_HALKA_ESLEMESI değişse ARCHITECTURE.md gözcüleri kırmızı
 * olur, DOCKER.md'nin cümlesi ise SESSİZCE yalan olur; konteyneri kuran kişi bu dosyayı
 * okuyor.
 */

/** DOCKER.md env tablosunda bu değişkenin geçtiği satır (tablo satırı, prose değil). */
function dockerSatiri(env: string): string {
  const satir = dockerEnvBolumu()
    .split("\n")
    .find((s) => s.startsWith("|") && s.includes(`\`${env}\``));
  assert.ok(
    satir,
    `docs/DOCKER.md env tablosunda \`${env}\` satırı yok — bir üstteki gözcü bu adın ` +
      "bölümde GEÇTİĞİNİ söylüyorsa ad prose'a kaçmış demektir"
  );
  return satir;
}

/** Kayıttaki opt-in halkaları: kendi `*_CHECK` env'i olan halkalar. */
function optInHalkalari(): { checkEnv: string; halka: (typeof ZINCIR_HALKALARI)[number] }[] {
  return ZINCIR_HALKALARI.flatMap((halka) => {
    const checkEnv = halka.envler.find((e) => e.endsWith("_CHECK"));
    return checkEnv ? [{ checkEnv, halka }] : [];
  });
}

/** Bir env'i geçici olarak kurup okuyucuyu çalıştırır; parseBool'un stderr uyarısını yutar. */
function ortamla<T>(env: string, deger: string | undefined, oku: () => T): T {
  const onceki = process.env[env];
  const oncekiHata = console.error;
  try {
    if (deger === undefined) delete process.env[env];
    else process.env[env] = deger;
    // parseBool okunamayan değerde stderr'e uyarı yazar; test çıktısı onunla dolmasın.
    console.error = () => {};
    return oku();
  } finally {
    console.error = oncekiHata;
    if (onceki === undefined) delete process.env[env];
    else process.env[env] = onceki;
  }
}

test("docs/DOCKER.md: opt-in halkanın 'off by default' sözü DAVRANIŞLA ölçülür", () => {
  /**
   * YÖN (b): kod. Varsayılan `nacConfigFromEnv`'den OKUNUR ve okunamayan değer de GERÇEKTEN
   * denenir. parseBool'un varsayılanı ya da güvenli tarafı çevrilirse — yani "bilinmiyor"
   * bir anda AÇIK sayılırsa — belgedeki cümle yalan olur ve burası kırmızıdır. Bu, kapının
   * FAIL-CLOSED sözleşmesinin operatöre bakan yüzü: halkanın kapalı kalması bir tercih
   * değil, okunamayan sinyalin varsayılanıdır.
   * YÖN (a): belge. Satır varsayılanı ya da okunamayan-değer kuralını söylemeyi bırakırsa
   * kırmızı — operatör bozuk bir değerin halkayı açık bıraktığını sanabilir.
   */
  const optIn = optInHalkalari();
  assert.ok(
    optIn.length >= 3,
    `zincir kaydında \`*_CHECK\` env'i olan halka sayısı ${optIn.length} — kayıt alanı ya da ` +
      "env adlandırması değiştiyse bu gözcü boş kümeye bakıp yeşil kalmasın"
  );

  for (const { checkEnv, halka } of optIn) {
    for (const deger of [undefined, "belki", "??", "sonra", "  "]) {
      const cfg = ortamla(checkEnv, deger, () => nacConfigFromEnv()) as Record<string, unknown>;
      const bayraklar = halka.ayarAlanlari.filter((alan) => typeof cfg[alan] === "boolean");
      assert.equal(
        bayraklar.length,
        1,
        `'${halka.id}' halkasının TEK bir boolean ayarı beklenirdi (${checkEnv}), ` +
          `${bayraklar.length} bulundu — kayıt bayatladıysa gözcü hiçbir şeyi ölçmesin`
      );
      assert.equal(
        cfg[bayraklar[0]],
        false,
        `${checkEnv}=${deger === undefined ? "(yok)" : JSON.stringify(deger)} iken ` +
          `'${halka.id}' halkası AÇIK geldi. docs/DOCKER.md "off by default, and a value the ` +
          'parser can\'t read leaves them off rather than on" diyor; kapıyı açan bir varsayılan ' +
          "hem o cümleyi hem fail-closed ilkesini bozar."
      );
    }

    const satir = dockerSatiri(checkEnv);
    assert.match(
      satir,
      /off by default/i,
      `docs/DOCKER.md'de \`${checkEnv}\` satırı varsayılanın KAPALI olduğunu söylemiyor`
    );
    assert.match(
      satir,
      /can['’]t read|cannot read|unreadable|unintelligible/i,
      `docs/DOCKER.md'de \`${checkEnv}\` satırı okunamayan değerin halkayı AÇMADIĞINI ` +
        "söylemiyor — operatör bozuk bir değeri 'açık' sanabilir"
    );
  }
});

test("docs/DOCKER.md: opt-in halkalar YALNIZ yüksek kademede koşar (kodun eşlemesinden)", () => {
  /**
   * YÖN (b): kod. İddia RISK_HALKA_ESLEMESI'nden türer. Bir opt-in halka orta kademeye
   * eklenirse DOCKER.md'nin "Each runs only on the high tier" cümlesi o an yalan olur; ve
   * bu, bütçe artışlarında sessizce yeni bir CAMARA gidiş-dönüşü demektir (aynı satırın
   * gecikme uyarısı da yanlışlanır). ARCHITECTURE.md'nin kademe tablosu ayrı bir gözcüyle
   * bağlı; bu satırın okuyucusu başka: konteyneri kuran operatör.
   * YÖN (a): belge. Cümle düşerse kırmızı.
   */
  const optIn = optInHalkalari();
  assert.ok(optIn.length >= 3, "opt-in halka bulunamadı — gözcü boş kümeye bakıp yeşil kalmasın");

  for (const { checkEnv, halka } of optIn) {
    const kimlik = halka.izAlani;
    assert.ok(
      RISK_HALKA_ESLEMESI.high.includes(kimlik),
      `'${kimlik}' yüksek kademede hiç koşmuyor ama DOCKER.md onu opt-in bir halka gibi ` +
        "anlatıyor — eşleme mi değişti, kayıt mı bayatladı?"
    );
    const satir = dockerSatiri(checkEnv);
    assert.ok(
      !RISK_HALKA_ESLEMESI.medium.includes(kimlik),
      `kod değişti: '${kimlik}' artık ORTA kademede de koşuyor, dolayısıyla docs/DOCKER.md'nin ` +
        `\`${checkEnv}\` satırındaki "only on the high tier" cümlesi yalan. Belge de düzeltilmeli.`
    );
    assert.match(
      satir,
      /only on the high tier/i,
      `docs/DOCKER.md'de \`${checkEnv}\` satırı halkanın hangi kademede koştuğunu söylemiyor`
    );
  }
});

/**
 * BU TURDA ÖLÇÜLEN İKİ BOŞLUK — ikisi de yukarıdaki gözcülerin ağının DIŞINDAYDI.
 *
 *   (5) Zinciri tek halkadan çoğaltan düzeltme, env tablosuna YENİ ve YANLIŞ bir nicel iddia
 *       soktu: `AEGIS_SIMSWAP_WINDOW_HOURS` satırı "The medium tier is fixed at 24" diyordu.
 *       Kodda orta kademe `Math.min(24, yapılandırılan)`, yani 24 bir TAVAN. Ölçüldü
 *       (enjekte kanalla, ağa çıkmadan):
 *
 *         AEGIS_SIMSWAP_WINDOW_HOURS=6 → medium pencereSaat = 6   ("fixed at 24" YALAN)
 *
 *       Sapmanın yönü tam da tehlikeli olan yön: orta kademe BÜTÇE ARTIŞLARININ kademesidir
 *       (src/tools/write.ts · meta.ts, `risk: "medium"`). Belgeyi okuyan operatör, pencereyi
 *       yanlış pozitifleri azaltmak için 6'ya çekince bütçe onaylarının hâlâ 24 saat geriye
 *       baktığını sanır; oysa o kademe de 6 saate daralmıştır. Aynı cümlenin CHANGELOG'daki
 *       eşi bu fazda düzeltilmişti (yukarıdaki "caps the lookback" gözcüsü) — DOCKER.md
 *       düzeltilmemiş kopyayı taşıyordu ve onu ölçen hiçbir test yoktu.
 *   (6) Satırın ANA vaadi — "With just these two set, **only SIM Swap runs**" — kapının tek
 *       halkaya indirgenmemesi düzeltmesinin ta kendisidir, ama hiçbir gözcü onu DAVRANIŞA
 *       bağlamıyordu: üstteki iki gözcü yalnız env ADLARINI ve zincirin BOYUNU sayıyor.
 *       Bir halkanın varsayılanı açığa dönse (`parseBool(..., true)`) ya da
 *       RISK_HALKA_ESLEMESI değişse, cümle SESSİZCE yalan olurdu — üstelik ters yönde:
 *       operatör açmadığı bir halkanın her yüksek-kademe onayında CAMARA'ya gittiğini
 *       öğrenemezdi.
 *
 * Aşağıdaki iki gözcü de ÇİFT YÖNLÜ ve ikisi de ağa çıkmaz: gerçek kanalların HEPSİ enjekte
 * edilir, hiçbir CAMARA çağrısı kurulmaz.
 */

/** Yalnız jeton + numara: belgenin "just these two" dediği taban yapılandırma. */
const DOCKER_TABAN: AgAyar = {
  nacToken: "TEST-ONLY-gercek-token",
  approverPhone: "+905321234567",
  simSwapWindowHours: 72,
};

/**
 * Taban yapılandırmanın izi. BEŞ gerçek kanalın hepsi enjekte edilir — yalnız SIM Swap'ınki
 * değil: bir halka kazara açık gelirse gözcü onu enjekte edilmiş TEMİZ yanıtla yakalasın,
 * gerçek bir CAMARA çağrısıyla değil. (Bu dosyanın kuralı: hiçbir test ağa çıkmaz.)
 */
async function dockerIzi(ayar: AgAyar, risk: AgRisk): Promise<AgIz> {
  __setSimSwapKanalForTests({ verifySimSwap: async () => false });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: ["TR"] }) });
  __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => false });
  __setCagriYonlendirmeKanalForTests({ kosulsuzYonlendirmeAcikMi: async () => false });
  try {
    return (await agDogrula(ayar, risk)).iz;
  } finally {
    __setSimSwapKanalForTests(undefined);
    __setErisimKanalForTests(undefined);
    __setKonumKanalForTests(undefined);
    __setCihazDegisimKanalForTests(undefined);
    __setCagriYonlendirmeKanalForTests(undefined);
  }
}

/** `iz[alan]` — `keyof AgIz` ile indeksleme; arayan yalnız "koştu mu" diye bakar. */
function izDegeri(iz: AgIz, alan: keyof AgIz): unknown {
  return iz[alan];
}

/** Halka GERÇEKTEN sorgu yaptı mı? "kapali"/"calismadi" ve alanın hiç yazılmaması koşmamaktır. */
function halkaKostu(deger: unknown): boolean {
  return deger === "gercek" || deger === "simulasyon";
}

/**
 * Taban yapılandırma + KAYITTAN gelen tek bir opt-in bayrağı açık.
 *
 * Alan adı `ZincirHalkasi.ayarAlanlari`'ndan okunur (derleyici onu `keyof AgAyar`'a bağlar),
 * ama hangi alanın hangi halkaya ait olduğu çalışma zamanında belli olur; tip köprüsü bu
 * yüzden kasıtlı ve yalnız buraya kapatılmış.
 */
function tabanBayrakli(alan: keyof AgAyar): AgAyar {
  const kopya = { ...DOCKER_TABAN } as unknown as Record<string, unknown>;
  kopya[alan] = true;
  return kopya as unknown as AgAyar;
}

test("docs/DOCKER.md: 24 saat orta kademede TAVAN — cümle ölçülen pencereyle sınanır", async () => {
  /**
   * YÖN (a) — belge: satır eski "fixed at 24" doktrinine dönerse ya da tavan olduğunu
   * söylemeyi bırakırsa kırmızı.
   * YÖN (b) — kod: `pencereSec` orta kademeyi 24'e SABİTLERSE (tavan yerine), yüksek kademe
   * yapılandırmayı dinlemeyi bırakırsa, ya da `pencereNormalize`'ın sınırları/varsayılanı
   * değişirse kırmızı — o an belgedeki üç sayı da (72 / 24 / 2400) yalan olur.
   */
  const satir = dockerSatiri("AEGIS_SIMSWAP_WINDOW_HOURS");

  assert.doesNotMatch(
    satir,
    /fixed at 24|medium tier is fixed/i,
    "docs/DOCKER.md orta kademe penceresini SABİT gibi anlatıyor. Kod `Math.min(24, …)` " +
      "uygular: daha dar bir yapılandırma orta kademeyi de daraltır, ve orta kademe " +
      "bütçe artışlarının kademesidir."
  );
  assert.match(
    satir,
    /cap,? not a floor/i,
    "docs/DOCKER.md'nin pencere satırı 24 saatin bir TAVAN olduğunu söylemiyor — operatör " +
      "onu bütçe onaylarının garantili alt sınırı sanır"
  );

  // Belgelenen varsayılan, config.ts'in GERÇEK varsayılanı mı?
  const varsayilan = ortamla(
    "AEGIS_SIMSWAP_WINDOW_HOURS",
    undefined,
    () => nacConfigFromEnv().simSwapWindowHours
  );
  const belgelenen = satir.match(/default \*\*(\d+)\*\*/);
  assert.ok(belgelenen, "pencere satırı varsayılanı ('default **N**') hiç söylemiyor");
  assert.equal(
    Number(belgelenen[1]),
    varsayilan,
    `docs/DOCKER.md varsayılanı ${belgelenen[1]} diyor, config.ts ${varsayilan} okuyor`
  );

  // TAVAN DAVRANIŞI: dar yapılandırmada İKİ kademe de daralır.
  const dar: AgAyar = { ...DOCKER_TABAN, simSwapWindowHours: 6 };
  assert.equal(
    await olculenPencere("medium", dar),
    6,
    "orta kademe 24'ü SABİT uyguluyor — belge 'cap, not a floor' diyor"
  );
  // KONTROL GRUBU: tavan gerçekten BAĞLIYOR mu? Yoksa üstteki satır her kodda yeşil kalırdı.
  const genis: AgAyar = { ...DOCKER_TABAN, simSwapWindowHours: 96 };
  assert.equal(await olculenPencere("medium", genis), 24, "orta kademedeki 24 saatlik tavan bağlamıyor");
  assert.equal(await olculenPencere("high", genis), 96, "yüksek kademe yapılandırmayı dinlemiyor");

  // SINIR DAVRANIŞI, satırın söylediği gibi.
  assert.match(satir, /2400/, "pencere satırı CAMARA'nın 2400 saatlik tavanını anmıyor");
  assert.equal(
    await olculenPencere("high", { ...DOCKER_TABAN, simSwapWindowHours: 5000 }),
    2400,
    "2400 üstü değer tavana çekilmiyor — belgedeki sınır yanlış"
  );
  assert.equal(
    await olculenPencere("high", { ...DOCKER_TABAN, simSwapWindowHours: 0 }),
    varsayilan,
    "1 saatin altındaki değer varsayılana düşmüyor — belgedeki geri-düşüş yanlış"
  );
});

test("docs/DOCKER.md: 'yalnız SIM Swap koşar' iddiası İZDEN ölçülür", async () => {
  /**
   * YÖN (a) — belge: cümle satırdan düşerse kırmızı; bu, kapıyı tek halkaya indirgemeyen
   * düzeltmenin taşıyıcı cümlesidir.
   * YÖN (b) — kod: bir halkanın opt-in'i varsayılan olarak AÇILIRSA ya da RISK_HALKA_ESLEMESI
   * onu tabana sokarsa kırmızı — o an operatör, açmadığı bir halkanın her yüksek-kademe
   * onayında CAMARA'ya gittiğini belgeden öğrenemez.
   */
  const satir = dockerSatiri("AEGIS_NAC_TOKEN");
  assert.match(
    satir,
    /only SIM Swap runs/i,
    "docs/DOCKER.md, yalnız jeton + numara ile hangi halkaların koştuğunu söylemiyor"
  );

  const digerleri = ZINCIR_HALKALARI.filter((h) => h.id !== "simSwap");
  assert.ok(
    digerleri.length >= 4,
    `kayıtta SIM Swap dışında ${digerleri.length} halka var — gözcü küçük bir kümeye bakıp ` +
      "yeşil kalmasın"
  );

  const iz = await dockerIzi(DOCKER_TABAN, "high");
  // Vakum koruması: SIM Swap GERÇEKTEN koşmadıysa aşağıdaki "hiçbiri koşmadı" boş bir iz
  // üstünde de doğrulanırdı.
  assert.equal(
    iz.simSwap,
    "gercek",
    `taban yapılandırmada SIM Swap halkası koşmadı (iz: ${String(iz.simSwap)}) — gözcü boş ` +
      "ize bakıyor olurdu"
  );

  const kosanlar = digerleri
    .filter((h) => halkaKostu(izDegeri(iz, h.izAlani)))
    .map((h) => `${h.id}=${String(izDegeri(iz, h.izAlani))}`);
  assert.deepEqual(
    kosanlar,
    [],
    `Yalnız jeton + numara verilmişken şu halkalar da koştu: ${kosanlar.join(", ")}. ` +
      "docs/DOCKER.md 'only SIM Swap runs' diyor; ya varsayılan gevşedi ya belge yalan."
  );

  /**
   * KONTROL GRUBU — ölçümün AYIRT ETTİĞİNİ kanıtlar. Yukarıdaki iddia "hiçbiri koşmadı"
   * biçiminde: hiçbir halkayı GÖREMEYEN bir gözcü de onu geçerdi. Burada her opt-in halka
   * tek tek açılır ve izde GERÇEKTEN belirmesi beklenir; belirmiyorsa ölçüm boşta koşuyordur.
   */
  const optIn = optInHalkalari();
  assert.ok(optIn.length >= 3, "opt-in halka bulunamadı — kontrol grubu kurulamıyor");
  for (const { halka } of optIn) {
    const bayrak = halka.ayarAlanlari.find((alan) => alan.endsWith("Check"));
    assert.ok(bayrak, `'${halka.id}' halkasının opt-in ayar alanı kayıtta bulunamadı`);
    const acikIz = await dockerIzi(tabanBayrakli(bayrak), "high");
    assert.ok(
      halkaKostu(izDegeri(acikIz, halka.izAlani)),
      `'${halka.id}' halkası opt-in AÇIKKEN bile izde koşmuş görünmüyor ` +
        `(${String(izDegeri(acikIz, halka.izAlani))}) — üstteki "yalnız SIM Swap" ölçümü ` +
        "hiçbir halkayı göremiyor, yani vakum"
    );
  }

  /**
   * "links 3-6" numaralandırması KAYITTAN türer: opt-in'i olan halkalar zincirde bitişik
   * durmazsa ya da sıraları değişirse belge okuyucuyu yanlış halkaya bakar hâle getirir.
   * (Link 2 — Number Verification — bilerek dışarıda: onun açılabilir bir kanalı yok.)
   */
  const siralar = ZINCIR_HALKALARI.map((h, i) => ({ id: h.id, sira: i + 1 })).filter(
    ({ id }) => id !== "simSwap" && id !== "numberVerification"
  );
  assert.ok(siralar.length > 0, "kayıtta açılabilir halka kalmamış — numaralandırma gözcüsü boşta");
  const bitisik = siralar.every((s, i) => i === 0 || s.sira === siralar[i - 1].sira + 1);
  assert.ok(
    bitisik,
    `açılabilir halkalar zincirde bitişik değil (${siralar.map((s) => s.sira).join(", ")}) — ` +
      "docs/DOCKER.md'nin aralık gösterimi ('links N-M') artık kurulamaz"
  );
  const aralik = `${siralar[0].sira}-${siralar[siralar.length - 1].sira}`;
  assert.match(
    satir,
    new RegExp(`links ${aralik}\\b`, "i"),
    `docs/DOCKER.md açılabilir halkaları "links ${aralik}" diye saymıyor — kayıttaki sıra ` +
      "değiştiyse cümle okuyucuyu yanlış halkaya yollar"
  );
});

/* ═══════════════════════════════════════════════════════════════════════════════
 * SECURITY.md ↔ AĞ GÜVEN KAPISI — güvenlik belgesi merkezî mekanizmayı SAYIYOR mu?
 *
 * NEDEN VAR (ölçüldü): SECURITY.md'nin "Tasarım gereği güvenlik değişmezleri" listesi beş
 * madde sayıyordu ve
 *
 *   grep -icE "CAMARA|ağ kapısı" SECURITY.md  →  0
 *
 * Yani bu deponun EN ÖNEMLİ güvenlik denetimi — her para hareketinden önce koşan CAMARA
 * halkaları — güvenlik belgesinde hiç geçmiyordu. Liste, "bunlardan birini kırdığınızı
 * gösterirseniz açık doğrudan kabul edilir" diyen bir SÖZLEŞMEDİR: kapı orada yazmıyorsa,
 * kapıyı atlatan bir bulgu kapsam dışı görünür ve bildiren araştırmacı kapının VARLIĞINI
 * bile öğrenemez.
 *
 * ÇİFT YÖNLÜLÜK (bu dosyanın sözleşmesi, yukarıdaki başlıkta da yazılı):
 *   (a) BELGE kayarsa kırmızı — iddia "Tasarım gereği güvenlik değişmezleri" bölümünün
 *       İÇİNDEN düşerse. Bölüm kapsamı bilinçli: bulgunun yeri tam olarak orasıydı, bir
 *       cümlenin dosyanın başka bir köşesinde durması bulguyu KAPATMAZ.
 *   (b) KOD kayarsa kırmızı — aynı iddia DAVRANIŞLA (enjekte kanallarla `agDogrula`,
 *       `onayAl`) ya da koddan türetilmiş tablolarla ölçülür; kapı gevşerse belgedeki
 *       cümle yalan olur ve test onu belge güncellenmeden yakalar.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const SEC_BELGE = kokDosya("SECURITY.md");

/** SECURITY.md'de "## Başlık" ile bir sonraki "## " arası; iddia bu bölümün İÇİNDE aranır. */
function secBolum(basligiIceren: string): string {
  const satirlar = SEC_BELGE.split("\n");
  const bas = satirlar.findIndex((s) => s.startsWith("## ") && s.includes(basligiIceren));
  assert.notEqual(bas, -1, `SECURITY.md içinde "${basligiIceren}" başlıklı bölüm yok`);
  const kalan = satirlar.slice(bas + 1);
  const son = kalan.findIndex((s) => s.startsWith("## "));
  return (son === -1 ? kalan : kalan.slice(0, son)).join("\n");
}

/**
 * Değişmezler bölümü, SATIR KAYDIRMASINDAN ARINDIRILMIŞ hâlde.
 *
 * Belge ~90 sütunda elle sarılıyor ve kalın işaretçiler cümlenin ortasına düşüyor:
 * "**onay istemi hiç\n   gösterilmez**". Ham metne bakan bir regex, cümle DURURKEN kırmızı
 * olurdu — yani gözcü belgenin anlamını değil biçimlendirmesini ölçerdi. Bu yüzden `**`
 * atılır ve boşluklar teke indirilir.
 */
const SEC_DUZ = secBolum("Tasarım gereği güvenlik değişmezleri")
  .replace(/\*\*/g, "")
  .replace(/\s+/g, " ");

const SEC_TELEFON = "+905551112233";
/** Numaranın "+90"sız gövdesi: sızıntı aramaları biçim değişikliğine takılmasın. */
const SEC_GOVDE = "5551112233";

/** SIM Swap + konum halkalarını açan taban yapılandırma; kademe KAPALI (varsayılan). */
const SEC_AYAR: AgAyar = {
  nacToken: "TEST-ONLY-gercek-token",
  approverPhone: SEC_TELEFON,
  simSwapWindowHours: 72,
  expectedCountry: "TR",
};

/**
 * YALNIZ SIM Swap halkasını açan yapılandırma — `expectedCountry` bilerek YOK.
 *
 * Kapalı-arıza testleri bunu kullanır, ve sebebi MUTASYONLA ölçüldü: SEC_AYAR ile konum
 * halkası da koşar; enjekte edilmemişse kendi başına "ag-yanitsiz" üretir. O kurulumda SIM
 * halkası "okunamayan yanıt = temiz" diye gevşetilse bile test YEŞİL kalmıyordu ama
 * kırmızılığı da SIM halkasından gelmiyordu — gözcü doğru sonucu YANLIŞ sebeple ölçüyordu.
 * Tek halka açıkken ret KESİNLİKLE SIM halkasından gelir.
 */
const SEC_TEK_HALKA: AgAyar = {
  nacToken: "TEST-ONLY-gercek-token",
  approverPhone: SEC_TELEFON,
  simSwapWindowHours: 72,
};

/** Elicitation DESTEKLEYEN istemci; gösterilen istem metinlerini biriktirir. */
function secIstemSunucu(sorulanlar: string[]): any {
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

/** Elicitation DESTEKLEMEYEN istemci: ajanın `confirm` değeri tek onay kanalı. */
function secZayifSunucu(): any {
  return { server: { getClientCapabilities: () => ({}) } };
}

/**
 * Kanal dikişleri modül-GLOBAL: biri sıfırlanmazsa sonraki teste sızar — ve bu dosyada
 * başka bir grubun testleri de yaşıyor. Global bir `afterEach` onların davranışını da
 * değiştirirdi; bu yüzden temizlik yalnız BU testleri sarmalayan yardımcıda yapılır.
 */
async function secIzole(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } finally {
    __setNacIstemciFabrikasiForTests(undefined);
    __setSimSwapKanalForTests(undefined);
    __setErisimKanalForTests(undefined);
    __setKonumKanalForTests(undefined);
    __setCihazDegisimKanalForTests(undefined);
    __setCagriYonlendirmeKanalForTests(undefined);
  }
}

/* ── S0) Bulgunun kendisi: liste kapıyı SAYIYOR mu ────────────────────────────── */

test("SECURITY.md: değişmezler listesi ağ güven kapısını adıyla sayıyor", () => {
  /**
   * KIRMIZI OLMA YÖNÜ: belge. Bulgunun doğduğu durum buydu (grep = 0). Arama BÖLÜMLE
   * sınırlı: kapının dosyanın başka bir yerinde anılması, "kabul edilen değişmezler"
   * sözleşmesine girdiği anlamına gelmez.
   */
  assert.match(SEC_DUZ, /CAMARA/, "değişmezler bölümünde CAMARA hiç geçmiyor");
  assert.match(SEC_DUZ, /GSMA Open Gateway/, "kapının hangi standart olduğu yazılmalı");
  assert.match(SEC_DUZ, /ağ güven kapısı/i, "kapı, değişmez olarak adlandırılmalı");
});

/* ── S1) İstem, kapı temiz geçmeden gösterilmez ───────────────────────────────── */

test("SECURITY.md: kapı reddederse onay istemi HİÇ gösterilmez (belge + davranış)", async () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ. Cümle düşerse belge tarafından; `onayAl` ağ kontrolünü
   * istemden SONRAYA alırsa kod tarafından. İkincisi sessiz bir gerileme olurdu: istem
   * gösterildikten sonra reddetmek, ele geçirilmiş onaylayıcıya kapının boyutlarını
   * gösterir ve "istem hiç gösterilmez" vaadini bozar.
   */
  assert.match(SEC_DUZ, /onay istemi hiç gösterilmez/i, "belgedeki hüküm kayıp");

  await secIzole(async () => {
    __setSimSwapKanalForTests({ verifySimSwap: async () => true });
    const sorulanlar: string[] = [];
    const sonuc = await onayAl(
      secIstemSunucu(sorulanlar),
      { eylem: "kampanya YAYINA ALINACAK", satirlar: [], risk: "high", agAyar: SEC_AYAR },
      undefined
    );

    assert.equal(sonuc.onaylandi, false, "SIM değişimi saptandı, işlem reddedilmeliydi");
    assert.equal(sonuc.kanal, "ag", "reddin kaynağı ağ kapısı olmalı");
    assert.equal(
      sorulanlar.length,
      0,
      `kapı reddederken istem gösterildi: ${sorulanlar.join(" | ")}`
    );
  });
});

test("SECURITY.md: kontrol ZAYIF (confirm) kanaldan da önce koşar", async () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ. Kapı yalnız elicitation dalına takılsaydı, çalınmış bir
   * oturum kendi seçtiği (elicitation'sız) istemciyle `confirm=true` göndererek kapıyı
   * atlardı. Belge bunu "ikisinden de önce koşar" diye vaat ediyor; burada ölçülür.
   */
  assert.match(SEC_DUZ, /ikisinden de önce koşar/i, "iki kanalın da kapsandığı yazılmalı");

  await secIzole(async () => {
    __setSimSwapKanalForTests({ verifySimSwap: async () => true });
    const sonuc = await onayAl(
      secZayifSunucu(),
      { eylem: "kampanya YAYINA ALINACAK", satirlar: [], risk: "high", agAyar: SEC_AYAR },
      true
    );
    assert.equal(sonuc.onaylandi, false, "confirm=true kapıyı atlattı");
    assert.equal(sonuc.kanal, "ag");
  });
});

/* ── S2) Kapalı arıza: "bilinmiyor" 0 değildir ────────────────────────────────── */

test('SECURITY.md: okunamayan/yanıtsız kontrol "temiz" sayılmaz, REDDE gider', async () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ. Okunamayan yanıt "değişmedi" sayılırsa (sessiz gevşeme)
   * ya da fırlatan çağrı yutulursa kod tarafından; hüküm belgeden düşerse belge tarafından.
   */
  assert.match(SEC_DUZ, /"bilinmiyor" 0 değildir/i, "belgedeki fail-closed hükmü kayıp");
  assert.match(SEC_DUZ, /Okunamayan yanıt/i);

  await secIzole(async () => {
    __setSimSwapKanalForTests({ verifySimSwap: async () => undefined });
    const okunamaz = await agDogrula(SEC_TEK_HALKA, "high");
    assert.ok(okunamaz.engel, "okunamayan yanıt geçirildi (sessiz gevşeme)");
    assert.equal(okunamaz.iz.retNedeni, "ag-yanitsiz");
    // Reddi ÜRETEN halkanın SIM Swap olduğu sabitlenir: iz "gercek" der, yani sorgu
    // gerçekten denendi ve cevaplanamadı. Bu satır olmadan gözcü, başka bir halkanın
    // reddiyle de yeşil kalırdı.
    assert.equal(okunamaz.iz.simSwap, "gercek");
    assert.deepEqual(okunamaz.kanit, [], "reddedilen kontrol insana kanıt üretemez");

    __setSimSwapKanalForTests({
      verifySimSwap: async () => {
        throw new Error("upstream patladi");
      },
    });
    const yanitsiz = await agDogrula(SEC_TEK_HALKA, "high");
    assert.ok(yanitsiz.engel, "fırlatan çağrı geçirildi (fail-open)");
    assert.equal(yanitsiz.iz.retNedeni, "ag-yanitsiz");
    assert.equal(yanitsiz.iz.simSwap, "gercek");
  });
});

test("SECURITY.md: ÇELİŞKİ eksik bilgi kadar ciddiye alınır (küme beklenen ülkeyi içerse bile)", async () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ. Konum halkasındaki ölçüt `every` yerine "içeriyor mu"ya
   * çevrilirse {TR, NL} temiz geçer ve belgedeki cümle yalan olur.
   *
   * KONTROL GRUBU zorunlu: yalnız beklenen ülke görüldüğünde aynı halka TEMİZ geçmeli.
   * Yoksa test "her şeyi reddeden" bir kapıda da yeşil kalır — yani vakum olur.
   */
  assert.match(SEC_DUZ, /küme beklenen ülkeyi içerse bile/i, "çelişki hükmü belgede kayıp");

  await secIzole(async () => {
    __setSimSwapKanalForTests({ verifySimSwap: async () => false });
    __setKonumKanalForTests({
      ulkeDurumu: async () => ({ yurtDisinda: true, ulkeler: ["TR", "NL"] }),
    });
    const celiskili = await agDogrula(SEC_AYAR, "high");
    assert.ok(celiskili.engel, "beklenen ülkeyi İÇEREN çelişkili küme geçirildi");
    assert.equal(celiskili.iz.retNedeni, "konum-beklenmedik");

    __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: ["TR"] }) });
    const temiz = await agDogrula(SEC_AYAR, "high");
    assert.equal(temiz.engel, undefined, "tek ve beklenen ülke reddedilmemeli");
  });
});

test("SECURITY.md: bilerek kapalı halka koşmaz ve ize yazılır; eksik yapılandırma REDDEDİLİR", async () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ. Belge iki ayrı durumu ayırıyor — "kapalı" (yapılandırma
   * yok, hata değil) ve "eksik" (jeton var, onaylayıcı numarası yok → ret). İkisi tek
   * kovaya düşerse ya kapalı kurulum her harcamayı reddeder, ya da eksik yapılandırma
   * SESSİZCE geçer; ikincisi fail-open'dır.
   */
  assert.match(SEC_DUZ, /bilerek kapalıysa/i);
  assert.match(SEC_DUZ, /sessizce "temiz" sayılmaz/i);

  const kapali = await agDogrula({ simSwapWindowHours: 72 }, "high");
  assert.equal(kapali.engel, undefined, "yapılandırılmamış özellik bir hata değildir");
  assert.equal(kapali.iz.simSwap, "kapali", "kapalı halka izde kapali görünmeli");

  const eksik = await agDogrula({ nacToken: "t", simSwapWindowHours: 72 }, "high");
  assert.ok(eksik.engel, "eksik yapılandırma sessizce geçirildi");
  assert.equal(eksik.iz.retNedeni, "onaylayici-numarasi-yok");
});

/* ── S3) Kefalet ilkesi ───────────────────────────────────────────────────────── */

test("SECURITY.md: kefil OLAMAYAN halkalar belgede adıyla sayılı ve tablolarda YOK", () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ. Aynı kod değişmezi CHANGELOG için de sınanıyor (yukarıda);
   * burada bağlanan şey SECURITY.md'nin kendi cümlesidir — bir belgenin gözcüsü diğerinin
   * gözcüsünün yerine geçmez, çünkü açık bildiren araştırmacı SECURITY.md'yi okur.
   */
  assert.match(
    SEC_DUZ,
    /erişilebilirlik halkası ile simülasyon olan numara doğrulaması hiçbir kefil satırında yer almaz/i,
    "SECURITY.md, kefil OLAMAYAN halkaları adıyla saymalı"
  );

  /**
   * ARANAN KİMLİKLER KODDAN TÜRETİLİR — bu satırlar süsleme değil, ÖLÇÜLMÜŞ bir vakumun
   * kapağıdır. Gözcü `id === "reach" || id === "nv"` yazıyordu ve iki yoldan SESSİZCE boşa
   * düşüyordu; aynı sızıntı üç kurulumda tarandı (scratch betiği, ağa çıkmadan):
   *
   *   1) bugünkü kimliklerle sızıntı                             → ["sim-degisti ← reach"] ✔
   *   2) halka kimliği kodda YENİDEN ADLANDIRILMIŞ, AYNI sızıntı → []                      ✘
   *   3) kefalet tabloları boşaltılmış                           → []                      ✘
   *
   * Yani SECURITY.md'nin bu cümlesinin TEK kod-tarafı bağı, kodun sözlüğü değişince
   * kendiliğinden yeşile dönüyordu: belge yerinde durur, vaat doğrulanmamış hâle gelirdi.
   * Kimlikler artık zincir KAYDINDAN okunur (kayıt id → halkanın kendi `izAlani`'ı; kefalet
   * tablolarının konuştuğu sözlük budur), kayıttaki satırın varlığı ve tabloların gerçekten
   * satır taşıdığı ayrıca sınanır — üç durumda da kırmızı.
   */
  function kefilOlamazId(kayitId: string): string {
    const halka = ZINCIR_HALKALARI.find((h) => h.id === kayitId);
    assert.notEqual(
      halka,
      undefined,
      `ZINCIR_HALKALARI'nda "${kayitId}" halkası yok. Halka yeniden adlandırıldıysa bu gözcü ` +
        `SESSİZCE boşa düşmesin diye burada durur: çapayı güncelle ya da satırı geri getir.`
    );
    return String(halka?.izAlani);
  }
  const KEFIL_OLAMAZ = [
    kefilOlamazId("deviceStatusReachability"),
    kefilOlamazId("numberVerification"),
  ];
  /**
   * SÖZLÜK DENETİMİ: kayıttan gelen kimlik, kefalet tablolarının konuştuğu kimlik mi? İki
   * sözlük ayrışırsa tarama doğru tabloda YANLIŞ alfabeyle arar — yine vakum olur.
   */
  for (const id of KEFIL_OLAMAZ) {
    assert.ok(
      Object.hasOwn(HALKA_SAPTAMA_NEDENI, id),
      `"${id}" kimliği kefalet tablolarının sözlüğünde (HALKA_SAPTAMA_NEDENI) yok — ` +
        `tarama boş alfabeyle koşuyor olurdu.`
    );
  }
  /** BOŞ TABLO TARAMASI DA VAKUMDUR: kefalet satırları gerçekten var olmalı. */
  assert.ok(
    Object.values(KEFIL_ESLEMESI).some((k) => k.length > 0),
    "KEFIL_ESLEMESI hiç kefil taşımıyor — sızıntı taraması boşlukta koşuyor"
  );
  assert.ok(
    Object.values(YANITSIZ_KEFIL_ESLEMESI).some((k) => k.length > 0),
    "YANITSIZ_KEFIL_ESLEMESI hiç kefil taşımıyor — sızıntı taraması boşlukta koşuyor"
  );

  const sizanlar: string[] = [];
  for (const [neden, kefiller] of Object.entries(KEFIL_ESLEMESI)) {
    for (const id of kefiller) if (KEFIL_OLAMAZ.includes(id)) sizanlar.push(`${neden} ← ${id}`);
  }
  for (const [halka, kefiller] of Object.entries(YANITSIZ_KEFIL_ESLEMESI)) {
    for (const id of kefiller) {
      if (KEFIL_OLAMAZ.includes(id)) sizanlar.push(`yanitsiz:${halka} ← ${id}`);
    }
  }
  assert.deepEqual(
    sizanlar,
    [],
    `Kefalet tablolarına ${KEFIL_OLAMAZ.join("/")} sızmış:\n` +
      sizanlar.join("\n") +
      "\nSECURITY.md bunun tersini VAAT ediyor; ya gerileme geri alınmalı ya belge düzeltilmeli."
  );
});

test("SECURITY.md: hiçbir şey GÖZLEMEMİŞ halka kefil olamaz — yükseltme verilmez", async () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ, ve bu testin çekirdeği KONTROL GRUBUDUR.
   *
   * Kurgu: bozuk sinyal "sim-degisti". Kefil adayları devSwap/loc/callFwd; birincisi ve
   * sonuncusu yapılandırmada kapalı, geriye YALNIZ konum halkası kalıyor. Konum halkası
   * yurt içinde ve HİÇBİR ÜLKE bildirilmemişken TEMİZ döner ama hiçbir şey ÖLÇMEMİŞTİR
   * (`gozlemsiz`) — bir sinyali çürütemeyen halka ona kefil olamaz, hiçbir şey gözlememiş
   * halka hiçbir şeye kefil olamaz.
   *
   * `gozlemsizler` süzgeci koddan kaldırılırsa ilk blok yeşile döner; ikinci blok ise o
   * süzgeç dururken de yeşildir. İkisi birlikte, kırmızının sebebinin "kapı her şeyi
   * reddediyor" değil GÖZLEM ŞARTI olduğunu kanıtlar.
   */
  assert.match(
    SEC_DUZ,
    /hiçbir şey gözlememiş halka da kefil olamaz/i,
    "gözlem şartı SECURITY.md'de kayıp"
  );

  await secIzole(async () => {
    const kademeli: AgAyar = { ...SEC_AYAR, stepUp: true };
    __setSimSwapKanalForTests({ verifySimSwap: async () => true });

    __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: [] }) });
    const gozlemsiz = await agDogrula(kademeli, "high");
    assert.ok(gozlemsiz.engel, "hiçbir şey gözlememiş halka yükseltmeyi taşıdı");
    assert.equal(gozlemsiz.kademe, undefined, "kefilsiz yükseltme verilemez");
    assert.match(gozlemsiz.engel!, /GÖZLEMEDEN/, "reddin gerekçesi gözlemsizlik olmalı");

    // KONTROL GRUBU: aynı bozuk sinyal, aynı halka — ama bu kez GERÇEKTEN ölçüyor.
    __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: ["TR"] }) });
    const kefilli = await agDogrula(kademeli, "high");
    assert.equal(kefilli.engel, undefined, "gözlem yapan kefil yükseltmeyi taşımalı");
    assert.deepEqual(kefilli.kademe?.dogrulayan, ["loc"]);
  });
});

test("SECURITY.md: yükseltme hiçbir harcama tavanı indirmez — KademeKarari telafi taşımıyor", async () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ. Bu depoda dört yorum bir zamanlar yükseltmenin
   * karşılığında "indirilmiş bir tavan" vaat ediyordu ve kodda tavanı indiren hiçbir satır
   * yoktu. Belge aynı hataya düşmesin diye alan kümesi SABİTLENİR: birisi buraya bir telafi
   * alanı eklerse test kırmızı olur ve SECURITY.md'deki cümlenin bilerek güncellenmesini
   * zorlar.
   */
  assert.match(SEC_DUZ, /Hiçbir harcama tavanı indirilmez/i, "telafi olmadığı yazılmalı");

  await secIzole(async () => {
    const kademeli: AgAyar = { ...SEC_AYAR, stepUp: true };
    __setSimSwapKanalForTests({ verifySimSwap: async () => true });
    __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: ["TR"] }) });
    const k = await agDogrula(kademeli, "high");

    assert.ok(k.kademe, "bu vaka yükseltmeyle geçmeli (yoksa test kendi konusunu ölçmüyor)");
    assert.deepEqual(Object.keys(k.kademe!).sort(), ["aciklama", "dogrulayan", "neden"]);
  });
});

test("SECURITY.md: yükseltme, istemin gösterilebildiği kanalla sınırlı", async () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ. Yükseltme bir GEVŞEME değil TAKAS'tır: kapı düz reddi
   * bırakır, karşılığında bozuk sinyali ADIYLA söyleyen bir istem ve o istemin
   * gösterilemediği yerde RET ister. Zayıf kanalda yükseltme geçirilirse takas tek taraflı
   * kalır — belgedeki cümle de yalan olur.
   */
  assert.match(SEC_DUZ, /elicitation yoksa yükseltme redde düşer/i, "kanal sınırı belgede kayıp");

  await secIzole(async () => {
    const kademeli: AgAyar = { ...SEC_AYAR, stepUp: true };
    __setSimSwapKanalForTests({ verifySimSwap: async () => true });
    __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: ["TR"] }) });
    const ozet = {
      eylem: "kampanya YAYINA ALINACAK",
      satirlar: [] as string[],
      risk: "high" as const,
      agAyar: kademeli,
    };

    const sorulanlar: string[] = [];
    const guclu = await onayAl(secIstemSunucu(sorulanlar), { ...ozet }, undefined);
    assert.equal(guclu.onaylandi, true, "yükseltme yolu insana sorularak geçmeli");
    assert.equal(sorulanlar.length, 1, "istem gerçekten gösterilmeli");
    assert.match(sorulanlar[0], /AĞ SİNYALİ BOZUK/, "bozuk sinyal insana söylenmeli");

    const zayif = await onayAl(secZayifSunucu(), { ...ozet }, true);
    assert.equal(zayif.onaylandi, false, "istem gösterilemeyen kanalda yükseltme geçti");
  });
});

test("SECURITY.md: kademe VARSAYILAN OLARAK KAPALI — bozuk sinyal doğrudan reddeder", async () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ. Varsayılan koddan OKUNUR (ortam değişkeni silinerek) ve
   * kapının varsayılan davranışı ayrıca ölçülür: `stepUp` yokken SIM değişimi KESİN rettir.
   * Varsayılan açığa çevrilirse belgedeki "(varsayılan kapalı)" ibaresi yalan olur.
   */
  assert.match(SEC_DUZ, /varsayılan kapalı/i, "varsayılanın kapalı olduğu belgede kayıp");

  const onceki = process.env.AEGIS_STEPUP;
  let varsayilan: boolean;
  try {
    delete process.env.AEGIS_STEPUP;
    varsayilan = nacConfigFromEnv().stepUp;
  } finally {
    if (onceki === undefined) delete process.env.AEGIS_STEPUP;
    else process.env.AEGIS_STEPUP = onceki;
  }
  assert.equal(varsayilan, false, "AEGIS_STEPUP varsayılanı AÇIK — SECURITY.md güncellenmeli");

  await secIzole(async () => {
    __setSimSwapKanalForTests({ verifySimSwap: async () => true });
    __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: ["TR"] }) });
    const k = await agDogrula(SEC_AYAR, "high"); // stepUp yok
    assert.ok(k.engel, "kademe kapalıyken SIM değişimi kesin ret olmalı");
    assert.equal(k.kademe, undefined, "kademe kapalıyken yükseltme üretilemez");
  });
});

/* ── S4) Sır hijyeni ──────────────────────────────────────────────────────────── */

test("SECURITY.md: onaylayıcının numarası hiçbir yere TAM yazılmaz", () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ. `maskele` çıktısı istem kanıt satırlarına, karar
   * günlüğüne ve ajana dönen ret metnine gider; ikinci bir maskeleme katmanı YOKTUR.
   * Kısa girdi kelepçesi de sınanır: kelepçe kalkarsa 6 haneli girdide her hane açığa
   * çıkar (ve 5 hanede RangeError fırlar).
   */
  assert.match(
    SEC_DUZ,
    /Onaylayıcının numarası hiçbir yere tam yazılmaz/i,
    "maskeleme hükmü belgede kayıp"
  );

  const m = maskele(SEC_TELEFON);
  assert.ok(!m.includes(SEC_TELEFON), `maskeleme numarayı tam bıraktı: ${m}`);
  assert.ok(!m.includes(SEC_GOVDE), `maskeleme numaranın gövdesini bıraktı: ${m}`);
  assert.equal(maskele("123456"), "***");
});

test("SECURITY.md: ağdan gelen HAM YANIT ne ajana ne operatör günlüğüne olduğu gibi geçer", async () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ. CAMARA 4xx gövdeleri kusurlu `phoneNumber`ı olduğu gibi
   * yankılar ve NaC SDK'sı `error.message`ı o gövdeden kurar; upstream metni redde
   * yapıştırmak, `maskele()`nin koruduğu sırrı ajana (ve çalınmış oturumdaki saldırgana)
   * elden teslim etmek olur. İki taraf da ölçülür: ajana dönen metin ve stderr.
   */
  assert.match(SEC_DUZ, /ham yanıt/i, "ham yanıt hükmü belgede kayıp");
  assert.match(SEC_DUZ, /biçimden bağımsız olarak redakte edilir/i, "stderr hükmü kayıp");

  await secIzole(async () => {
    __setSimSwapKanalForTests({
      verifySimSwap: async () => {
        throw new Error(`400 Bad Request {"phoneNumber":"${SEC_TELEFON}","status":400}`);
      },
    });

    const hatalar: string[] = [];
    const eskiHata = console.error;
    console.error = (...a: unknown[]) => {
      hatalar.push(a.map((x) => String(x)).join(" "));
    };
    let k;
    try {
      k = await agDogrula(SEC_TEK_HALKA, "high");
    } finally {
      console.error = eskiHata;
    }

    assert.ok(k.engel, "yanıtsız kontrol geçirildi");
    assert.equal(k.iz.simSwap, "gercek", "reddi üreten halka SIM Swap olmalı");
    assert.ok(!k.engel!.includes(SEC_GOVDE), `ajana dönen redde numara sızdı: ${k.engel}`);
    assert.ok(
      !k.engel!.includes("Bad Request"),
      `ajana dönen redde ham upstream metin sızdı: ${k.engel}`
    );

    assert.ok(hatalar.length > 0, "operatör için stderr'e ayrıntı yazılmalı");
    const gunluk = hatalar.join("\n");
    assert.ok(!gunluk.includes(SEC_GOVDE), `ham numara stderr'e sızdı: ${gunluk}`);
  });
});

test("SECURITY.md: ham yanıt KARAR GÜNLÜĞÜ kaydına da girmez (üçüncü varış noktası)", async () => {
  /**
   * KIRMIZI OLMA YÖNÜ: HER İKİSİ — ve bu gözcü ÖLÇÜLMÜŞ bir kör noktayı kapatır.
   *
   * SECURITY.md'nin sır hijyeni maddesi ham yanıt için ÜÇ varış noktası sayıyor: ajana dönen
   * metin, insana giden kanıt satırları ve KARAR GÜNLÜĞÜ. Yukarıdaki gözcü ilk ikisini (artı
   * stderr'i) ölçüyordu; günlüğü hiçbir SECURITY.md gözcüsü ölçmüyordu. Kör nokta varsayım
   * değil, MUTASYONLA ölçüldü (kum havuzuna kopyalanmış kaynakta, ağa çıkmadan):
   *
   *   SIM Swap halkasının catch dalı ham upstream metnini ize koyar
   *     + kararGunlugu.ts o alanı kayda geçirir
   *   → kayıt: {"…","hamYanit":"400 {\"phoneNumber\":\"+90…\"}"}   (tam E.164 numara DA içinde)
   *   → test/belgeAgKapisi.test.ts [SECURITY.md]: 14/14 YEŞİL
   *   → test/kararGunlugu.test.ts:                36/36 YEŞİL
   *
   * Yani belge o cümleyi VAAT ederken hiçbir gözcü onu tutmuyordu. kararGunlugu.test.ts'nin
   * kapalı alan kümesi denetimi bu yolu görmedi çünkü orada üretilen kayıtlar bu dalı
   * geçmiyor; bu gözcü kaydı GERÇEK bir kapı reddinden üretir.
   *
   * TARAMA ALAN ADINA DEĞİL İÇERİĞE bakar: ileride eklenecek herhangi bir geçirgen alan —
   * adı ne olursa olsun — upstream metni ya da numarayı taşıyorsa kırmızı olur.
   */
  assert.match(SEC_DUZ, /karar günlüğüne girmez/i, "günlük varış noktası belgede kayıp");
  assert.match(
    SEC_DUZ,
    /yalnız türetilmiş karar ile yapılandırmadan gelen değerler çıkar/i,
    "kayda YALNIZ türetilmiş değerin çıktığı hükmü belgede kayıp"
  );

  await secIzole(async () => {
    __setSimSwapKanalForTests({
      verifySimSwap: async () => {
        throw new Error(`400 Bad Request {"phoneNumber":"${SEC_TELEFON}","status":400}`);
      },
    });

    const eskiHata = console.error;
    console.error = () => {};
    let k;
    try {
      k = await agDogrula(SEC_TEK_HALKA, "high");
    } finally {
      console.error = eskiHata;
    }
    assert.ok(k.engel, "yanıtsız kontrol geçirildi");

    /** Hesap kimliği bilerek numaradan BAĞIMSIZ: tarama "kayıt boş" diye yeşil kalmasın. */
    const kayit = agKararKaydiOlustur("kampanya YAYINA ALINACAK", "high", k, "9876543210");
    const seri = JSON.stringify(kayit);

    assert.ok(!seri.includes(SEC_GOVDE), `karar günlüğü kaydına tam numara sızdı: ${seri}`);
    assert.ok(!seri.includes("Bad Request"), `karar günlüğü kaydına ham upstream metin sızdı: ${seri}`);
    assert.ok(!seri.includes("phoneNumber"), `karar günlüğü kaydına upstream gövdesi sızdı: ${seri}`);

    /**
     * KONTROL GRUBU: kayıt gerçekten DOLU ve türetilmiş değerleri taşıyor. Bu satırlar
     * olmadan gözcü, hiçbir şey yazmayan bir kayıt üreticisiyle de yeşil kalırdı — yani
     * "sır yok" yerine "içerik yok" ölçerdi.
     */
    assert.equal(kayit.karar, "ret", "kapı reddi kayda 'ret' olarak geçmeli");
    assert.equal(kayit.retNedeniKisa, "ag-yanitsiz", "ret nedeni SABİT sözlükten gelmeli");
    assert.equal(kayit.simSwapKanali, "gercek", "sorgu gerçekten denendi, kayda öyle geçmeli");
    assert.equal(kayit.maskeliNumara, maskele(SEC_TELEFON), "numara yalnız MASKELİ hâliyle geçer");
  });
});

test("SECURITY.md: belgenin KENDİSİ sır taşımıyor — uzun rakam dizisi yok", () => {
  /**
   * KIRMIZI OLMA YÖNÜ: belge. Yasakladığı şeyi örnek diye yapıştırmak (gerçek bir numara
   * ya da jeton) bu bölümün en olası kaza biçimidir. 7+ ardışık hane bu belgede hiçbir
   * meşru bağlamda geçmiyor.
   */
  assert.match(SEC_DUZ, /NAC jetonu hiçbir çıktıda görünmez/i);
  const bulunan = /\d{7,}/.exec(SEC_BELGE);
  assert.equal(
    bulunan,
    null,
    `SECURITY.md uzun bir rakam dizisi taşıyor (sır olabilir): ${bulunan?.[0]}`
  );
});

/* ── ARCHITECTURE.md · kapının OMURGASI belgede duruyor mu ───────────────────── */

/**
 * NEDEN BURADA (ölçüldü). ARCHITECTURE.md, güvenlik bölümünü kendi cümlesiyle "this is the
 * part worth reading closely" diye açar. Bu fazın başında o dosyada ağ kapısı HİÇ YOKTU:
 *
 *   grep -niE "networkTrust|CAMARA" ARCHITECTURE.md  →  0 eşleşme
 *
 * Yani projenin ANA güvenlik mekanizması — altı CAMARA halkası, kefalet ilkesi, kademeli
 * doğrulama, kapının kapalı-arıza sözleşmesi, karar günlüğü — mimari belgesinde yoktu; katman
 * şemasında `networkTrust.ts` ile `kararGunlugu.ts` çizilmemişti, depo yerleşiminde
 * listelenmemişti. Bu, "yanlış cümle"den daha sinsi bir sapmadır: dosyayı okuyan jüri üyesi
 * ya da katkıcı sistemin ne yaptığını ÖĞRENEMEZ ve eksikliği fark edecek bir işaret de yoktur.
 *
 * ÇİFT YÖNLÜLÜK (bu dosyanın sözleşmesi) — aşağıdaki gözcülerin hiçbiri "şu kelime geçiyor mu"
 * demez; her biri belgedeki bir TABLOYU koddaki bir kaynaktan türetir:
 *   (a) BELGE kayarsa kırmızı: tablodan satır düşerse, bir simge elle bozulursa, bölüm
 *       silinirse (çapasını bulamayan gözcü de BAŞARISIZ olur — vakuma düşmez).
 *   (b) KOD kayarsa kırmızı: kayda halka eklenirse, RISK_HALKA_ESLEMESI'nde bir kademe
 *       değişirse, KADEME_UYGUN'a neden girerse, KARAR_SONUCLARI'na sonuç eklenirse,
 *       src/ ağacına yeni bir dosya girerse — çünkü o an belgedeki tablo YANLIŞ olur.
 *
 * Hiçbiri ağa çıkmaz, .env okumaz, kapı mantığına dokunmaz: yalnız depodaki dosyalar.
 */

const MIMARI = kokDosya("ARCHITECTURE.md");

interface MimariTablo {
  basliklar: string[];
  satirlar: string[][];
}

/** Bir markdown tablo satırının hücreleri. */
function mimariHucreler(satir: string): string[] {
  const kirpik = satir.trim();
  return kirpik
    .slice(1, kirpik.length - 1)
    .split("|")
    .map((h) => h.trim());
}

/**
 * Verilen başlık parçalarının HEPSİNİ taşıyan ilk tabloyu döndürür.
 *
 * Bulamazsa FIRLATIR. Kasıtlı: aradığı tabloyu bulamayınca sessizce geçen bir belge gözcüsü
 * vakuma dönüşür ve ölçtüğü şey belgeden silinmiş olsa bile sonsuza kadar yeşil kalır — bu
 * fazda tam olarak öyle bir test ölçüldü.
 */
function mimariTablosu(ad: string, basliklar: readonly string[]): MimariTablo {
  const satirlar = MIMARI.split("\n");
  for (let i = 0; i < satirlar.length; i++) {
    if (!satirlar[i].trim().startsWith("|")) continue;
    const bas = mimariHucreler(satirlar[i]);
    if (!basliklar.every((b) => bas.some((h) => h.includes(b)))) continue;
    // İkinci satır ayırıcı olmalı: düzyazıdaki tablo-benzeri bir satıra kanmayalım.
    if (!/^\|[\s:|-]+\|$/.test(satirlar[i + 1]?.trim() ?? "")) continue;
    const govde: string[][] = [];
    for (let j = i + 2; j < satirlar.length && satirlar[j].trim().startsWith("|"); j++) {
      govde.push(mimariHucreler(satirlar[j]));
    }
    assert.ok(govde.length > 0, `ARCHITECTURE.md · ${ad}: tablo başlığı var, gövdesi yok`);
    return { basliklar: bas, satirlar: govde };
  }
  throw new Error(
    `ARCHITECTURE.md içinde "${ad}" tablosu bulunamadı (aranan başlıklar: ${basliklar.join(", ")}). ` +
      "Tablo yeniden yazıldıysa gözcü boşa düşmesin diye burada durur: ya çapayı güncelle ya " +
      "da gözcüyü kaldır — ölçmediği hâlde yeşil kalmasın."
  );
}

/** Bir hücredeki backtick'li simgeler: "`simSwap` · `nv`" → ["simSwap", "nv"]. */
function mimariSimgeler(hucre: string): string[] {
  return [...hucre.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/** Başlık adına göre sütun indeksi. */
function mimariSutun(t: MimariTablo, baslik: string): number {
  const i = t.basliklar.findIndex((h) => h.includes(baslik));
  assert.notEqual(i, -1, `ARCHITECTURE.md: "${baslik}" sütunu yok — çapa bayatlamış`);
  return i;
}

test("ARCHITECTURE.md halka tablosu ZINCIR_HALKALARI kaydından türüyor", () => {
  /**
   * YÖN (a): tablodan bir satır silinir ya da bir iz/günlük alanı elle bozulursa kırmızı.
   * YÖN (b): kayda yedinci halka eklenir, bir halkanın `izAlani`/`gunlukAlani` alanı yeniden
   * adlandırılırsa kırmızı — o an belge, var olmayan bir alanı belgeliyor olur.
   *
   * Neden İZ ve GÜNLÜK alanları: kapının en kolay bozulan vaadi "iki halka TEK alana
   * katlanmaz"dır (bkz. AgIz, KararKaydi). Belgede bu iki sütun yan yana durduğu sürece
   * katlama sessizce yapılamaz — tablo o anda yalan söylemeye başlar.
   */
  const t = mimariTablosu("zincir halkaları", ["Trace field", "Log field"]);
  const izSut = mimariSutun(t, "Trace field");
  const gunlukSut = mimariSutun(t, "Log field");

  assert.equal(
    t.satirlar.length,
    ZINCIR_HALKALARI.length,
    `ARCHITECTURE.md halka tablosu ${t.satirlar.length} satır sayıyor, kayıtta ` +
      `${ZINCIR_HALKALARI.length} halka var`
  );

  const belgelenen = t.satirlar.map(
    (r) => `${mimariSimgeler(r[izSut])[0]}/${mimariSimgeler(r[gunlukSut])[0]}`
  );
  const beklenen = ZINCIR_HALKALARI.map((h) => `${h.izAlani}/${h.gunlukAlani}`);
  assert.deepEqual(
    [...belgelenen].sort(),
    [...beklenen].sort(),
    "ARCHITECTURE.md halka tablosu ile src/networkTrust.ts · ZINCIR_HALKALARI ayrışmış " +
      `(belge: ${belgelenen.join(", ")} / kayıt: ${beklenen.join(", ")}). Belgeyi kodun ` +
      "yaptığına hizala."
  );
});

test("ARCHITECTURE.md'nin 'six-link' iddiası zincirin GERÇEK boyudur", () => {
  /**
   * Tablo doğru sayıda satır taşısa bile düzyazı bayatlayabilir: şema etiketi, depo yerleşimi
   * ve bölüm başlığı zincirin boyunu KELİMEYLE söyler. YÖN (b): kayda halka eklendiğinde bu
   * üç yer birden yanlış olur ve gözcü kırmızıdır.
   */
  const SAYILAR = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const beklenen = SAYILAR[ZINCIR_HALKALARI.length - 1];
  assert.ok(beklenen, `zincirde ${ZINCIR_HALKALARI.length} halka var — kelime tablosu bayatlamış`);

  const iddialar = [...MIMARI.matchAll(/\b([A-Za-z]+)-link\b/g)].map((m) => m[1].toLowerCase());
  assert.ok(
    iddialar.length >= 2,
    `ARCHITECTURE.md zincirin boyunu ('${beklenen}-link') hiç söylemiyor (bulunan: ` +
      `${iddialar.length}). Cümle silindiyse bu gözcü de kaldırılmalı, yoksa hiçbir şey ölçmez.`
  );
  for (const iddia of iddialar) {
    assert.equal(
      iddia,
      beklenen,
      `ARCHITECTURE.md "${iddia}-link" diyor, kayıtta ${ZINCIR_HALKALARI.length} halka var`
    );
  }
});

test("ARCHITECTURE.md risk kademesi tablosu RISK_HALKA_ESLEMESI'nden türüyor", () => {
  /**
   * Bu tablo, kapının POLİTİKASIDIR: hangi işlemde hangi halkalar koşar. Kod tarafında tek
   * kaynağı var (RISK_HALKA_ESLEMESI); belgede ise elle yazılmış bir liste olurdu — beş
   * dağınık `if` hâlindeyken görünmez olan şey aynen belgede de görünmez olurdu.
   *
   * YÖN (a): tablodan bir simge düşerse kırmızı. YÖN (b): eşlemeye halka eklenir/çıkarılır ya
   * da yeni bir kademe tanımlanırsa kırmızı — belge o an var olmayan bir politika anlatır.
   */
  const t = mimariTablosu("risk kademeleri", ["Tier", "Links that run"]);
  const kademeSut = mimariSutun(t, "Tier");
  const halkaSut = mimariSutun(t, "Links that run");

  const belge = new Map<string, string[]>();
  for (const satir of t.satirlar) {
    const kademe = mimariSimgeler(satir[kademeSut])[0];
    assert.ok(kademe, `ARCHITECTURE.md kademe tablosunda adsız satır: ${satir.join(" | ")}`);
    belge.set(kademe, mimariSimgeler(satir[halkaSut]));
  }

  assert.deepEqual(
    [...belge.keys()].sort(),
    Object.keys(RISK_HALKA_ESLEMESI).sort(),
    "ARCHITECTURE.md'nin saydığı risk kademeleri ile RISK_HALKA_ESLEMESI ayrışmış"
  );
  for (const [kademe, halkalar] of belge) {
    const kod = RISK_HALKA_ESLEMESI[kademe as AgRisk];
    assert.deepEqual(
      [...halkalar].sort(),
      [...kod].sort(),
      `'${kademe}' kademesi için belge [${halkalar.join(", ")}] diyor, kod ` +
        `[${kod.join(", ")}] koşuyor. Belge, koşmayan bir halkayı koşuyor gösterirse ` +
        "okuyucu kapıyı olduğundan güçlü sanır."
    );
  }
});

test("ARCHITECTURE.md kademeli doğrulama tablosu KADEME_UYGUN'dan türüyor", () => {
  /**
   * Aynı doktrinin CHANGELOG gözcüsü yukarıda; bu ayrı bir dosya ve ayrı bir okuyucu için.
   * YÖN (b) burada bir GÜVENLİK yanlış beyanını yakalar: KADEME_UYGUN'a yeni bir neden
   * girerse belge, kapının artık yumuşattığı bir sinyali hâlâ "koşulsuz ret" sayar.
   */
  const t = mimariTablosu("kademe nedenleri", ["Step-up reason"]);
  const sut = mimariSutun(t, "Step-up reason");
  const belgelenen = t.satirlar.map((r) => mimariSimgeler(r[sut])[0]);
  assert.deepEqual(
    [...belgelenen].sort(),
    [...KADEME_UYGUN].sort(),
    "ARCHITECTURE.md'nin kademe tablosu ile src/networkTrust.ts · KADEME_UYGUN ayrışmış " +
      `(belge: ${belgelenen.join(", ")})`
  );
});

test("ARCHITECTURE.md karar günlüğü sözlüğü KARAR_SONUCLARI'ndan türüyor", () => {
  /**
   * Denetçi sayaçlarını bu sözlükten kurar. Sonuç kümesine sessizce bir değer eklenirse —
   * "kademeli" tam olarak böyle eklenmişti — belgeden sayan kişinin kovaları eksik kalır ve
   * kapının GEVŞEDİĞİ satırlar hiçbir kovaya düşmez.
   */
  const t = mimariTablosu("karar sözlüğü", ["`karar` value"]);
  const sut = mimariSutun(t, "`karar` value");
  const belgelenen = t.satirlar.map((r) => mimariSimgeler(r[sut])[0]);
  assert.deepEqual(
    [...belgelenen].sort(),
    [...KARAR_SONUCLARI].sort(),
    "ARCHITECTURE.md'nin karar sözlüğü ile src/kararGunlugu.ts · KARAR_SONUCLARI ayrışmış " +
      `(belge: ${belgelenen.join(", ")})`
  );
});

/** src/ kökü — göreli import'ları çözerken taban URL. */
const SRC_KOKU = new URL("../src/", import.meta.url);

/** src/ ağacındaki .ts dosyaları, `src/`'e göreli yollarla ("meta/client.ts" gibi). */
function srcAgaci(onek = ""): string[] {
  const dizin = fileURLToPath(new URL(`../src/${onek}`, import.meta.url));
  const cikti: string[] = [];
  for (const ad of readdirSync(dizin)) {
    const goreli = `${onek}${ad}`;
    const tam = fileURLToPath(new URL(`../src/${goreli}`, import.meta.url));
    if (statSync(tam).isDirectory()) cikti.push(...srcAgaci(`${goreli}/`));
    else if (ad.endsWith(".ts")) cikti.push(goreli);
  }
  return cikti;
}

/** ARCHITECTURE.md'nin depo yerleşimi bloğu (dilsiz ``` çiti, `src/` ile başlar). */
function yerlesimBlogu(): string {
  const bloklar = [...MIMARI.matchAll(/^```([a-z]*)\n([\s\S]*?)^```/gm)]
    .filter((m) => m[1] === "")
    .map((m) => m[2]);
  const aday = bloklar.filter((b) => b.startsWith("src/") && b.includes("\ndeploy/"));
  assert.equal(
    aday.length,
    1,
    `ARCHITECTURE.md'de depo yerleşimi bloğu tam olarak bir kez bulunmalı (bulunan: ${aday.length}) — ` +
      "blok yeniden yazıldıysa gözcü boşa düşmesin diye burada durur"
  );
  return aday[0];
}

test("ARCHITECTURE.md depo yerleşimi src/ ağacının TAMAMINI sayıyor", () => {
  /**
   * NEDEN (ölçüldü): yerleşim bloğu bu fazın başında `networkTrust.ts`, `kararGunlugu.ts`,
   * `meta/client.ts` ve `tools/meta` yokmuş gibi duruyordu — yani deponun MERKEZÎ guard'ı ve
   * ikinci harcama alanı, "depo yerleşimi" başlıklı listede hiç yoktu. Eksik satır yanlış
   * satırdan sinsidir: okuyanın fark edeceği bir işaret bırakmaz.
   *
   * YÖN (b): src/ ağacına yeni bir dosya girdiğinde kırmızı olur — belge o an eksiktir.
   * YÖN (a): blokta adı geçen bir .ts diskten kalkarsa kırmızı olur — belge o an hayalet bir
   * dosya gösterir.
   */
  const blok = yerlesimBlogu();
  const dosyalar = srcAgaci();
  assert.ok(
    dosyalar.length >= 10,
    `src/ ağacından beklenenden az dosya türedi (${dosyalar.length}) — yol bayatlamış olabilir`
  );

  /**
   * ÖLÇÜT "src/ altındaki her dosya" DEĞİL, "sunucunun GERÇEKTEN kurulduğu dosyalar":
   * package.json'un gösterdiği giriş noktaları ve başka bir src dosyasından import edilen
   * her modül. Hiçbir yerden import edilmeyen bir dosya sunucunun bir parçası değildir —
   * mimari yerleşimi de onu anlatmak zorunda değil. (Bu ayrım ölçüldü: eşzamanlı çalışan
   * başka bir ajanın bıraktığı, hiçbir yerden çağrılmayan geçici bir prob dosyası bu
   * gözcüyü, belgede gerçekten eksik hiçbir şey yokken kırmızı yapıyordu.)
   */
  const girisler = new Set(
    [...kokDosya("package.json").matchAll(/dist\/([A-Za-z0-9_]+)\.js/g)].map((m) => `${m[1]}.ts`)
  );
  assert.ok(girisler.size > 0, "package.json'da dist/*.js girişi yok — yol bayatlamış");

  const ithal = new Set<string>();
  for (const goreli of dosyalar) {
    const kaynak = readFileSync(new URL(goreli, SRC_KOKU), "utf8");
    for (const m of kaynak.matchAll(/from "(\.[^"]*)\.js"/g)) {
      const hedef = new URL(`${m[1]}.ts`, new URL(goreli, SRC_KOKU));
      if (hedef.href.startsWith(SRC_KOKU.href)) ithal.add(hedef.href.slice(SRC_KOKU.href.length));
    }
  }
  assert.ok(
    ithal.size >= 12,
    `src/ içinde beklenenden az iç import bulundu (${ithal.size}) — desen bayatlamış olabilir`
  );

  const gerekli = dosyalar.filter((d) => ithal.has(d) || girisler.has(d));
  assert.ok(
    gerekli.length >= 15,
    `belgelenmesi gereken modül sayısı beklenenden az (${gerekli.length}) — gözcü küçük bir ` +
      "kümeye bakıp yeşil kalmasın"
  );

  /**
   * Kapsama kuralı: kök dosyalar tam adıyla ("networkTrust.ts") aranır; alt dizindeki bir
   * dosya ya tam yoluyla ("meta/client.ts") ya da dizin satırındaki listede adıyla
   * ("tools/  read · write · site · meta") sayılabilir — blok bir ağaç çizimidir, dosya
   * dökümü değil.
   */
  const kapsandi = (goreli: string): boolean => {
    if (blok.includes(goreli)) return true;
    const egik = goreli.lastIndexOf("/");
    if (egik === -1) return false;
    const dizin = goreli.slice(0, egik + 1);
    const ad = goreli.slice(egik + 1).replace(/\.ts$/, "");
    return blok
      .split("\n")
      .some((s) => s.trim().startsWith(dizin) && new RegExp(`\\b${ad}\\b`).test(s));
  };

  const eksik = gerekli.filter((d) => !kapsandi(d));
  assert.deepEqual(
    eksik,
    [],
    `ARCHITECTURE.md'nin depo yerleşimi bu kaynak dosyalardan hiç söz etmiyor: ${eksik.join(", ")}. ` +
      "Yerleşim listesi eksikse okuyucu, olmadığını sandığı katmanı hiç aramaz."
  );

  const anilan = [...blok.matchAll(/([A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*\.ts)/g)].map((m) => m[1]);
  assert.ok(
    anilan.length >= 10,
    `yerleşim bloğunda beklenenden az .ts adı var (${anilan.length}) — blok yolu bayatlamış olabilir`
  );
  const hayalet = anilan.filter(
    (ad) => !existsSync(fileURLToPath(new URL(`../src/${ad}`, import.meta.url)))
  );
  assert.deepEqual(
    hayalet,
    [],
    `ARCHITECTURE.md var olmayan kaynak dosyalar gösteriyor: ${hayalet.join(", ")}`
  );
});

/* ── ARCHITECTURE.md · kapının POLİTİKASI: kademe, ortam, pencere, şema ──────── */

/**
 * NEDEN İKİNCİ BİR ARCHITECTURE BÖLÜMÜ (ölçüldü).
 *
 * Yukarıdaki altı gözcü belgedeki TABLOLARI kodun kayıtlarına bağladı (halka kaydı, risk
 * eşlemesi, kademe kümesi, karar sözlüğü, depo yerleşimi). Ama bu fazda dosyaya giren
 * iddiaların bir bölümü o tabloların DIŞINDA kaldı ve hiçbir şey onları ölçmüyordu:
 *
 *   1. Harcama tablosuna eklenen "Risk tier" sütunu — kapının hangi işlemde hangi halkaları
 *      koşturacağını belirleyen tek girdi. Hiçbir test onu `onayAl` çağrı yerlerine
 *      bağlamıyordu: write.ts'te `risk: "high"` bir anda `"medium"` olsa belge sessizce
 *      yalan olurdu (ve kapı, yayına alma işleminde altı halka yerine bir halka koşardı).
 *   2. "no link is on by default" paragrafının saydığı ortam değişkenleri. Bir ad yanlış
 *      yazılsa ya da yedinci bir opt-in halka eklense operatör açamadığı halkayı açık sanır.
 *      (docs/DOCKER.md'nin env gözcüsü VAR; ARCHITECTURE.md o ağın dışındaydı.)
 *   3. "24 hours at most / 72 hours by default" — dosyanın kapı hakkındaki tek NİCEL iddiası.
 *   4. Katman şeması: `networkTrust.ts` ve `kararGunlugu.ts` düğümleri ile onlara giden
 *      kenarlar. Şema silinse depo yerleşimi gözcüsü yine yeşil kalırdı; oysa dosyayı
 *      okuyan önce şemaya bakar.
 *   5. "Link 2 simulation only, structurally" — kapının en güçlü ÇEKİNCESİ. Kod bir gün
 *      NV izine "gercek" değerini eklerse belgedeki "structurally" kelimesi yalan olur.
 *
 * ÇİFT YÖNLÜLÜK. Aşağıdaki gözcülerin hepsi ya KATI EŞİTLİK (belge kümesi === kod kümesi)
 * ya da DAVRANIŞ ÖLÇÜMÜ kurar; katı eşitlik iki taraflıdır — hangi taraf kayarsa kırmızıdır.
 * Vakum riski eşitlikte değil ÇAPADA olduğu için her gözcü çapasını bulamazsa FIRLATIR ve
 * kod tarafındaki kümenin boş olmadığını ayrıca doğrular.
 */

/** Boşlukları tek boşluğa indirgenmiş belge — satır sarmalı cümleleri bölmesin. */
const MIMARI_DUZ = MIMARI.replace(/\s+/g, " ");

/**
 * Bir kaynak dosyadaki `risk: "..."` ÇAĞRI YERLERİ — sırasıyla.
 *
 * Kademe bir tip değil bir DEĞERdir: `onayAl`a geçilen dize sabiti. Tip imzaları
 * (`risk: AgRisk`) desene takılmaz, çünkü desen dize sabiti arar.
 */
function riskCagriYerleri(goreliYol: string): string[] {
  return [...kokDosya(goreliYol).matchAll(/\brisk:\s*"([a-z]+)"/g)].map((m) => m[1]);
}

test('ARCHITECTURE.md "Risk tier" sütunu onayAl ÇAĞRI YERLERİNDEN türüyor', () => {
  /**
   * YÖN (a) belge: bir hücre elle `high`→`medium` çevrilirse çoklu-küme ayrışır → kırmızı.
   * YÖN (b) kod: write.ts'teki bir çağrı yerinin kademesi değişirse ya da yeni bir harcama
   * artıran yol eklenirse aynı eşitlik bozulur → kırmızı. Tek bir eşitlik kuruluyor; hangi
   * taraf kayarsa kaysın gözcü kırmızıdır.
   *
   * ONAY sütunu da bağlıdır: "no" diyen satır KADEME TAŞIYAMAZ. Koşmayan bir kapıya kademe
   * yazmak kapıyı olduğundan geniş gösterir — taslak akışının (duraklatılmış kampanyaya
   * reklam ekleme) ağ kapısından geçtiği izlenimini verirdi.
   */
  const t = mimariTablosu("harcama tablosu", ["Action", "Approval", "Risk tier"]);
  const onaySut = mimariSutun(t, "Approval");
  const kademeSut = mimariSutun(t, "Risk tier");
  const gecerliKademeler = Object.keys(RISK_HALKA_ESLEMESI);

  const belgeKademeleri: string[] = [];
  for (const satir of t.satirlar) {
    const onay = satir[onaySut].trim().toLowerCase();
    const simgeler = mimariSimgeler(satir[kademeSut]);
    assert.ok(
      onay === "yes" || onay === "no",
      `ARCHITECTURE.md harcama tablosunda okunamayan onay hücresi: "${onay}" — sütun ` +
        "yeniden yazıldıysa gözcü boşa düşmesin diye burada durur"
    );
    if (onay === "no") {
      assert.deepEqual(
        simgeler,
        [],
        `"${satir[0]}" satırı onay İSTEMİYOR ama bir risk kademesi taşıyor ` +
          `(${simgeler.join(", ")}). Kademe yalnız kapıdan geçen yolun özelliğidir.`
      );
      continue;
    }
    assert.equal(
      simgeler.length,
      1,
      `"${satir[0]}" satırı tek bir risk kademesi saymıyor (${simgeler.length})`
    );
    assert.ok(
      gecerliKademeler.includes(simgeler[0]),
      `ARCHITECTURE.md '${simgeler[0]}' kademesini belgeliyor; RISK_HALKA_ESLEMESI böyle bir ` +
        `kademe tanımıyor (tanınanlar: ${gecerliKademeler.join(", ")})`
    );
    belgeKademeleri.push(simgeler[0]);
  }

  const google = riskCagriYerleri("src/tools/write.ts");
  assert.ok(
    google.length >= 3,
    `src/tools/write.ts içinde beklenenden az \`risk:\` çağrı yeri bulundu (${google.length}) — ` +
      "desen bayatladıysa gözcü boş kümeyle yeşil kalmasın"
  );
  assert.deepEqual(
    [...belgeKademeleri].sort(),
    [...google].sort(),
    `ARCHITECTURE.md harcama tablosu [${belgeKademeleri.join(", ")}] kademelerini sayıyor, ` +
      `src/tools/write.ts [${google.join(", ")}] geçiyor. Belgedeki kademe kapının hangi ` +
      "halkaları koşturacağını söyler; yanlış kademe okuyucuya yanlış bir kapı anlatır."
  );

  /**
   * "Meta's two write paths carry the same two tiers as Google's" cümlesi ÖLÇÜLÜR: ikinci
   * harcama alanının aynı kapıda olduğu iddiası bu dosyanın en pahalı iddiasıdır.
   */
  assert.match(
    MIMARI_DUZ,
    /Meta['’]s two write paths carry the same two tiers as Google['’]s/,
    "ARCHITECTURE.md, Meta'nın aynı iki kademeyi taşıdığını artık söylemiyor — cümle " +
      "kaldırıldıysa aşağıdaki ölçüm de kaldırılmalı, yoksa hiçbir iddiayı korumaz"
  );
  const meta = riskCagriYerleri("src/tools/meta.ts");
  assert.equal(
    meta.length,
    2,
    `ARCHITECTURE.md Meta için "two write paths" diyor, src/tools/meta.ts ${meta.length} ` +
      "onay çağrısı taşıyor"
  );
  assert.deepEqual(
    [...new Set(meta)].sort(),
    [...new Set(google)].sort(),
    `Meta kademeleri [${[...new Set(meta)].sort().join(", ")}], Google kademeleri ` +
      `[${[...new Set(google)].sort().join(", ")}] — cümle "aynı iki kademe" diyor.`
  );
});

test("ARCHITECTURE.md: andığı her AEGIS_* GERÇEKTEN okunuyor, açılış anahtarları eksiksiz", () => {
  /**
   * İKİ AYRI GERİLEME, TEK GÖZCÜ:
   *   (i) HAYALET DEĞİŞKEN — belgede var, kodda yok. Operatör kapıyı açtığını sanır, kapı
   *       kapalıdır ve bunu söyleyen hiçbir işaret yoktur (kapalı halka ize `kapali` yazar,
   *       ama operatör izi okumuyorsa haberi olmaz).
   *   (ii) BELGESİZ ANAHTAR — kodda var, belgede yok. Yedinci bir opt-in halka eklendiğinde
   *       tam olarak böyle olur: halka koşmaz, belge de nasıl koşturulacağını söylemez.
   *
   * KAPSAM KURALI: `*_SIMULATE` adları DIŞARIDA. Onlar demo kanalıdır ve docs/DEMO.md ile
   * docs/DOCKER.md'nin işidir; ARCHITECTURE.md ÜRETİM anahtarlarını anlatır. Kural burada
   * yazılıdır ki gözcü "hangi env'i istiyor" sorusunu sessizce cevaplamasın.
   */
  const okunanlar = new Set<string>();
  for (const goreli of srcAgaci()) {
    const kaynak = readFileSync(new URL(goreli, SRC_KOKU), "utf8");
    for (const m of kaynak.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) okunanlar.add(m[1]);
  }
  assert.ok(
    okunanlar.size >= 15,
    `src/ ağacından beklenenden az ortam değişkeni türedi (${okunanlar.size}) — desen bayatlamış`
  );

  const anilanlar = [...new Set([...MIMARI.matchAll(/AEGIS_[A-Z0-9_]+/g)].map((m) => m[0]))];
  assert.ok(
    anilanlar.length >= 5,
    `ARCHITECTURE.md beklenenden az AEGIS_* değişkeni anıyor (${anilanlar.length}) — ağ ` +
      "kapısı bölümü silindiyse bu gözcü de kaldırılmalı"
  );
  const hayalet = anilanlar.filter((e) => !okunanlar.has(e));
  assert.deepEqual(
    hayalet,
    [],
    `ARCHITECTURE.md hiçbir kodun okumadığı ortam değişkenlerini belgeliyor: ${hayalet.join(", ")}`
  );

  const acilis = [
    ...new Set([
      ...ZINCIR_HALKALARI.flatMap((h) => h.envler.filter((e) => !e.endsWith("_SIMULATE"))),
      ...ZINCIR_ORTAK_ENVLERI,
    ]),
  ];
  assert.ok(
    acilis.length >= 7,
    `zincir kaydından beklenenden az üretim anahtarı türedi (${acilis.length}) — kayıt alanı ` +
      "değiştiyse gözcü küçük bir kümeye bakıp yeşil kalmasın"
  );
  const belgesiz = acilis.filter((e) => !MIMARI.includes(e));
  assert.deepEqual(
    belgesiz,
    [],
    `ARCHITECTURE.md bu üretim anahtarlarından hiç söz etmiyor: ${belgesiz.join(", ")}. ` +
      '"no link is on by default" diyen bir dosya, halkanın NASIL açıldığını da söylemek zorunda.'
  );
});

test("ARCHITECTURE.md pencere sayıları ÖLÇÜLEN pencerelerdir (tavan / varsayılan)", async () => {
  /**
   * YÖN (a): cümledeki 24 ya da 72 elle değiştirilirse ölçümle ayrışır.
   * YÖN (b): medium tavanı ya da AEGIS_SIMSWAP_WINDOW_HOURS'un varsayılanı değişirse cümle
   * yalan olur. Sayılar PROZADAN değil `agDogrula`nın gerçekten sorduğu pencereden ve
   * `nacConfigFromEnv`in gerçekten okuduğu varsayılandan doğrulanır.
   *
   * "at most" kelimesi ayrıca sınanır: 24 bir SABİT değil TAVANdır (kod `Math.min` uygular)
   * ve daha dar bir yapılandırma medium'u da daraltır. Bunu söylemeyen bir cümle dar
   * yapılandırmada yanlıştır.
   */
  const m = MIMARI_DUZ.match(/The tier also narrows the SIM-swap look-back:[^.]*\./);
  assert.ok(
    m,
    "ARCHITECTURE.md'de 'The tier also narrows the SIM-swap look-back: …' cümlesi yok. " +
      "Cümle yeniden yazıldıysa sayı gözcüsü SESSİZCE boşa düşmesin diye burada durulur."
  );
  const cumle = m[0];
  assert.match(
    cumle,
    /at most/i,
    "Cümle medium penceresini SABİT gibi anlatıyor; kod `Math.min` uygular — 24 bir tavandır"
  );
  const sayilar = [...cumle.matchAll(/(\d+)\s*hours?\b/g)].map((s) => Number(s[1]));
  assert.equal(
    sayilar.length,
    2,
    `Cümle iki saat değeri saymıyor (bulunan: ${sayilar.join(", ") || "yok"})`
  );
  const [tavan, varsayilan] = sayilar;

  const ayar: AgAyar = { ...KDM_AYAR, simSwapWindowHours: varsayilan };
  assert.equal(
    await olculenPencere("medium", ayar),
    tavan,
    `ARCHITECTURE.md medium için ${tavan} saat diyor, kapı başka bir pencere soruyor`
  );
  assert.equal(
    await olculenPencere("high", ayar),
    varsayilan,
    "ARCHITECTURE.md high için yapılandırılan pencerenin OLDUĞU GİBİ kullanıldığını söylüyor"
  );
  assert.equal(
    await olculenPencere("medium", { ...KDM_AYAR, simSwapWindowHours: 6 }),
    6,
    `medium ${tavan} saati SABİT uyguluyor — belge "at most" diyor, yani tavan olmalı`
  );

  const cfg = ortamla("AEGIS_SIMSWAP_WINDOW_HOURS", undefined, () => nacConfigFromEnv());
  assert.equal(
    cfg.simSwapWindowHours,
    varsayilan,
    `ARCHITECTURE.md varsayılanı ${varsayilan} saat diyor, config.ts ` +
      `${cfg.simSwapWindowHours} okuyor`
  );
});

/** ARCHITECTURE.md'nin katman şeması (tek mermaid `flowchart TB` bloğu). */
function katmanSemasi(): string {
  const aday = [...MIMARI.matchAll(/^```mermaid\n([\s\S]*?)^```/gm)]
    .map((m) => m[1])
    .filter((b) => b.includes("flowchart TB"));
  assert.equal(
    aday.length,
    1,
    `ARCHITECTURE.md'de katman şeması tam olarak bir kez bulunmalı (bulunan: ${aday.length}) — ` +
      "şema yeniden yazıldıysa gözcü boşa düşmesin diye burada durur"
  );
  return aday[0];
}

test("ARCHITECTURE.md katman şeması kapının GERÇEK bağlantısını çiziyor", () => {
  /**
   * NEDEN (ölçüldü): bu fazın başında şemada ne `networkTrust.ts` ne `kararGunlugu.ts`
   * vardı — dosyayı açan kişi ilk baktığı resimde kapıyı GÖREMİYORDU. Eksik düğüm yanlış
   * düğümden sinsidir: okuyucuya bir işaret bırakmaz.
   *
   * YÖN (a): şemadan düğüm ya da kenar silinirse kırmızı; şemada var olmayan bir kaynak
   * dosya gösterilirse kırmızı.
   * YÖN (b): `approval.ts` ağ kapısını ya da karar günlüğünü artık import etmiyorsa kırmızı
   * — şema o an var olmayan bir bağlantı çiziyor olur. Kenar, kodun GERÇEK import'undan
   * türetilir; elle yazılmış bir liste ikinci bir doktrin kopyası olurdu.
   */
  const sema = katmanSemasi();

  const dugumler = new Map<string, string>();
  for (const m of sema.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\["([^"]*)"\]/gm)) {
    dugumler.set(m[1], m[2]);
  }
  assert.ok(
    dugumler.size >= 8,
    `katman şemasından beklenenden az düğüm türedi (${dugumler.size}) — desen bayatlamış olabilir`
  );

  const anilan = [
    ...new Set([...sema.matchAll(/([A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*\.ts)/g)].map((x) => x[1])),
  ];
  assert.ok(
    anilan.length >= 8,
    `katman şemasında beklenenden az .ts adı var (${anilan.length}) — şema yolu bayatlamış olabilir`
  );
  const hayalet = anilan.filter(
    (ad) => !existsSync(fileURLToPath(new URL(`../src/${ad}`, import.meta.url)))
  );
  assert.deepEqual(
    hayalet,
    [],
    `katman şeması var olmayan kaynak dosyalar çiziyor: ${hayalet.join(", ")}`
  );

  const ithal = new Set(
    [...kokDosya("src/approval.ts").matchAll(/from "\.\/([A-Za-z0-9_]+)\.js"/g)].map(
      (x) => `${x[1]}.ts`
    )
  );
  const kapiModulleri = ["networkTrust.ts", "kararGunlugu.ts"].filter((d) => ithal.has(d));
  assert.deepEqual(
    kapiModulleri,
    ["networkTrust.ts", "kararGunlugu.ts"],
    "src/approval.ts ağ kapısını ya da karar günlüğünü artık import etmiyor — şemadaki " +
      `kenar o an var olmayan bir bağlantıyı çizer (bulunan import'lar: ${[...ithal].join(", ")})`
  );

  const dugumBul = (dosya: string): string => {
    const bulunan = [...dugumler].filter(([, etiket]) => etiket.includes(dosya));
    assert.equal(
      bulunan.length,
      1,
      `katman şemasında "${dosya}" düğümü tam olarak bir kez olmalı (bulunan: ${bulunan.length})`
    );
    return bulunan[0][0];
  };

  const kaynakDugum = dugumBul("approval.ts");
  for (const hedef of kapiModulleri) {
    const hedefDugum = dugumBul(hedef);
    assert.match(
      sema,
      new RegExp(`^\\s*${kaynakDugum}\\s*[-.][^\\n]*->\\s*${hedefDugum}\\s*$`, "m"),
      `katman şemasında approval.ts → ${hedef} kenarı yok. Kod bu bağlantıyı GERÇEKTEN ` +
        "kuruyor; şema onu çizmezse kapı okuyucuya görünmez."
    );
  }
});

test("ARCHITECTURE.md'nin 'yalnız simülasyon' halkası kodda GERÇEK kanal taşıyamaz", () => {
  /**
   * Bu, dosyanın en güçlü ÇEKİNCESİDİR: bir halka "structurally" simülasyondur — yapılacak
   * bir iş değil MİMARİ BİR HÜKÜM. Böyle bir cümlenin bedeli, kod bir gün tersini yaparsa
   * bunun görülmesidir.
   *
   * YÖN (a): "simulation only" işareti başka bir satıra taşınır ya da silinirse kırmızı.
   * YÖN (b): halkanın iz tipine "gercek" değeri eklenirse ya da kayıt satırına canlı
   * doğrulama tarihi girerse kırmızı — o an belge yalan söyler.
   *
   * Tip adı ÇAPADAN türetilir (izAlani "nv" → NvIzi): halka yeniden adlandırılırsa gözcü
   * tipi bulamaz ve durur, sessizce yeşil kalmaz.
   */
  const t = mimariTablosu("zincir halkaları", ["Trace field", "Channel today"]);
  const izSut = mimariSutun(t, "Trace field");
  const kanalSut = mimariSutun(t, "Channel today");

  const simSatirlari = t.satirlar.filter((r) => /simulation only/i.test(r[kanalSut]));
  assert.equal(
    simSatirlari.length,
    1,
    `ARCHITECTURE.md zincir tablosunda "simulation only" diyen satır sayısı ` +
      `${simSatirlari.length} — bu, tam olarak bir halka için geçerli bir hükümdür`
  );
  const izAlani = mimariSimgeler(simSatirlari[0][izSut])[0];
  assert.ok(izAlani, "simülasyon satırı bir iz alanı adı taşımıyor");

  const halka = ZINCIR_HALKALARI.find((h) => h.izAlani === izAlani);
  assert.ok(
    halka,
    `ARCHITECTURE.md '${izAlani}' iz alanını belgeliyor; ZINCIR_HALKALARI böyle bir halka tanımıyor`
  );
  assert.equal(
    halka.canliDogrulandi,
    undefined,
    `'${halka.id}' halkası kayıtta CANLI DOĞRULANMIŞ görünüyor (${halka.canliDogrulandi}), ` +
      'ama ARCHITECTURE.md onu "simulation only, structurally" diye anlatıyor'
  );

  const tipAdi = `${izAlani[0].toUpperCase()}${izAlani.slice(1)}Izi`;
  const tip = kokDosya("src/networkTrust.ts").match(new RegExp(`export type ${tipAdi} =([^;]*);`));
  assert.ok(
    tip,
    `src/networkTrust.ts içinde '${tipAdi}' iz tipi yok — halka yeniden adlandırıldıysa ` +
      "gözcü ölçmediği hâlde yeşil kalmasın"
  );
  assert.ok(
    !/"gercek"/.test(tip[1]),
    `${tipAdi} artık "gercek" değerini kabul ediyor (${tip[1].trim()}). ARCHITECTURE.md bu ` +
      "halkanın gerçek kanalının YAPISAL olarak imkânsız olduğunu söylüyor; biri artık yanlış."
  );
});

test("ARCHITECTURE.md'nin işaret ettiği depo yolları GERÇEKTEN var", () => {
  /**
   * Belge testlere ve runbook'lara adıyla işaret ediyor ("gerileme testleri şurada", "kayıt
   * docs/CAMARA.md'de"). Bir dosya taşındığında bu işaretler sessizce ölür: okuyucu kanıtı
   * aramaya gider ve bulamaz. Ucuz gözcü, gerçek gerileme.
   */
  const yollar = [
    ...new Set(
      [...MIMARI.matchAll(/\b((?:test|docs|deploy|scripts)\/[A-Za-z0-9_./-]*[A-Za-z0-9_])/g)]
        .map((m) => m[1])
        .filter((y) => /\.[a-z]+$/.test(y))
    ),
  ];
  assert.ok(
    yollar.length >= 3,
    `ARCHITECTURE.md beklenenden az depo yoluna işaret ediyor (${yollar.length}) — desen bayatlamış`
  );
  const eksik = yollar.filter(
    (y) => !existsSync(fileURLToPath(new URL(`../${y}`, import.meta.url)))
  );
  assert.deepEqual(
    eksik,
    [],
    `ARCHITECTURE.md var olmayan dosyalara işaret ediyor: ${eksik.join(", ")}`
  );
});

/* ═══════════════════════════════════════════════════════════════════════════════
 * README.md ↔ README.tr.md — TR/EN PARİTE: iki README aynı şeyi söylüyor mu?
 *
 * NEDEN VAR (ölçüldü, bu turda). Bölüm SAYISI için bir gözcü zaten vardı
 * (test/belgeTutarliligi.test.ts, `##` sayısı ±1 toleransla) ve o gözcü YEŞİLKEN iki
 * README aşağıdaki altı noktada ayrışmış durumdaydı — hepsi ölçüldü:
 *
 *   1. README.tr.md'de MCP rozeti YOKTU (EN 6 rozet, TR 5).
 *   2. "2–6. halkalar yalnız yüksek katmanda koşar, her biri kendi değişkenini ister;
 *      kapatılmış halka denetim izine `kapali` düşer" paragrafı YALNIZ EN'deydi. Bu
 *      paragraf, kapının "sormadım" ile "sordum ve geçti"yi ayırdığını söyleyen tek yer.
 *   3. Güvenlik bölümünde "ağ güven kapısı da aynı kurala tabidir; yapmadığı canlı
 *      sorguyu yapmış gibi göstermez" cümlesi YALNIZ EN'deydi.
 *   4. Geliştirme bölümünde "ağ kapısı enjekte kanalla test edilir; o yeşil testler canlı
 *      CAMARA teli hakkında hiçbir şey söylemez" çekincesi YALNIZ EN'deydi.
 *   5. Demo paragrafında `AEGIS_NV_SIMULATE`'in ikinci kanıt satırı YALNIZ EN'deydi.
 *   6. Aynı paragrafta "sert ret, sıfır istem" iddiası TR'de KOŞULSUZ duruyordu: EN
 *      "at the default `AEGIS_STEPUP=0`" diyor, TR hiçbir koşul söylemiyordu.
 *
 * (6) tek başına bir güvenlik yanlış beyanıdır ve deponun BİRİNCİL okuru Türkçe okuyan
 * kişidir: kademe açıkken aynı senaryo istem GÖSTERİR. Eksik cümleler "çeviri zevki"
 * değil, okurdan gizlenmiş davranıştı.
 *
 * ÇİFT YÖNLÜLÜK (bu dosyanın sözleşmesi):
 *   (a) BELGE kayarsa kırmızı — bir dil diğerinden ayrışırsa: rozet, kod jetonu, doktrin
 *       cümlesi ya da zincir değişkeni tek dilde kalırsa.
 *   (b) KOD/DEPO kayarsa kırmızı — rozetin gösterdiği dosya silinirse, zincir kaydına yeni
 *       bir halka (yeni bir anahtar değişkenle) girerse, kapatılmış halka artık `kapali`
 *       yazmazsa, ya da test dikişi kalkarsa: o an cümleler YANLIŞ olur.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const PAR_EN = kokDosya("README.md");
const PAR_TR = kokDosya("README.tr.md");

/** İki README, gözcülerin üzerinde döndüğü tek liste. */
const PAR_IKISI: ReadonlyArray<readonly [string, string]> = [
  ["README.md", PAR_EN],
  ["README.tr.md", PAR_TR],
];

/**
 * `##`/`###` bölümleri, belgedeki SIRAYLA. Eşleştirme başlığa değil sıraya bakar:
 * başlıklar zaten farklı dillerde, ayrışan şey İÇERİK.
 */
function parBolumler(belge: string): { baslik: string; govde: string }[] {
  const cikti: { baslik: string; govde: string }[] = [];
  for (const satir of belge.split("\n")) {
    if (/^#{2,3} /.test(satir)) cikti.push({ baslik: satir.trim(), govde: "" });
    else if (cikti.length > 0) cikti[cikti.length - 1].govde += satir + "\n";
  }
  return cikti;
}

/**
 * Bir bölümdeki KOD JETONLARI: ters tırnak içindeki, tanımlayıcıya benzeyen parçalar
 * (`AEGIS_REACH_CHECK`, `analyze_site`, `src/http.ts`, `aegis://accounts`, `kapali`).
 *
 * NEDEN NORMALLEŞTİRME: `AEGIS_STEPUP=0` ile `AEGIS_STEPUP` aynı değişkendir; ilk `=`
 * ya da boşlukta kesilmezse gözcü, aynı şeyi söyleyen iki dili "ayrışmış" ilan ederdi.
 * Kesme ayrıca düzyazı alıntılarını (`404 "API doesn't exists"`, `{"swapped":true}`)
 * kendiliğinden eler: baş harf tanımlayıcı kuralına uymaz.
 */
function parKodJetonlari(govde: string): Set<string> {
  const cikti = new Set<string>();
  for (const m of govde.matchAll(/`([^`\n]+)`/g)) {
    const bas = m[1].split(/[=\s]/)[0];
    if (/^[A-Za-z_][A-Za-z0-9_.:/{}*-]*$/.test(bas)) cikti.add(bas);
  }
  return cikti;
}

/** Başlık bloğundaki rozetler: `[![etiket](shields…)](hedef)`. */
function parRozetler(belge: string): { etiket: string; hedef: string }[] {
  const cikti: { etiket: string; hedef: string }[] = [];
  for (const m of belge.matchAll(/^\[!\[([^\]]*)\]\((https:\/\/[^)]+)\)\]\(([^)]+)\)$/gm)) {
    cikti.push({ etiket: m[1], hedef: m[3] });
  }
  return cikti;
}

/** `## Başlık` → GitHub çapası: küçük harf, boşluk `-`, noktalama atılır. */
function parCapa(baslik: string): string {
  return baslik
    .replace(/^#+\s*/, "")
    .toLocaleLowerCase("tr")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

test("iki README AYNI rozet kümesini taşır ve her rozet VAR OLAN bir hedefe bakar", () => {
  /**
   * YÖN (a) — belge: bir rozet tek dile eklenir/tek dilden düşerse kırmızı. Bulgu buydu:
   * MCP rozeti yalnız İngilizce README'deydi, yani Türkçe okur sunucunun elicitation
   * dahil hangi MCP yüzeylerini sunduğunu başlıkta hiç görmüyordu.
   * YÖN (b) — depo: rozet, depoda GERÇEKTEN duran bir şeyi göstermeli. `LICENSE` silinir,
   * `package.json` taşınır, `test/` yeniden adlandırılır ya da kapsam rozetinin çapası
   * (`#test-metrics` / `#test-metrikleri`) başlık yeniden adlandırıldığı için boşa
   * düşerse kırmızı — o an rozet, olmayan bir kanıta bağlanmış olur.
   *
   * Karşılaştırma çapaları `#` diye NORMALLEŞTİRİR: çapa dile göre farklı olmak
   * ZORUNDA (`#test-metrics` ≠ `#test-metrikleri`), ayrışma orada değil rozet KÜMESİNDE
   * aranıyor. Çapanın kendisi aşağıdaki blokta ayrıca çözülüyor.
   */
  const enRozet = parRozetler(PAR_EN);
  const trRozet = parRozetler(PAR_TR);
  assert.ok(
    enRozet.length >= 6 && trRozet.length >= 6,
    `başlık bloğunda beklenenden az rozet var (EN ${enRozet.length}, TR ${trRozet.length}) — ` +
      "rozet deseni bayatlamışsa gözcü boş kümeleri mutlu mesut eşitlerdi"
  );

  const kume = (r: { hedef: string }[]) =>
    [...new Set(r.map((x) => (x.hedef.startsWith("#") ? "#" : x.hedef)))].sort();
  assert.deepEqual(
    kume(enRozet),
    kume(trRozet),
    "İki README farklı rozet kümesi taşıyor — biri güncellenip diğeri unutulmuş. Rozetler " +
      "deponun ilk cümlesidir: bir dilde eksik rozet, o dilin okuruna eksik bir depo gösterir."
  );

  let capaSayisi = 0;
  let yolSayisi = 0;
  for (const [ad, belge] of PAR_IKISI) {
    const capalar = new Set(parBolumler(belge).map((b) => parCapa(b.baslik)));
    for (const { etiket, hedef } of parRozetler(belge)) {
      if (hedef.startsWith("#")) {
        capaSayisi++;
        assert.ok(
          capalar.has(hedef.slice(1)),
          `${ad}: "${etiket}" rozeti ${hedef} çapasını gösteriyor ama o başlıkta bölüm yok — ` +
            "bölüm yeniden adlandırıldıysa rozet sessizce hiçbir yere götürmüyor (çapalar: " +
            `${[...capalar].join(", ")})`
        );
        continue;
      }
      if (/^https?:/.test(hedef)) continue; // ağa çıkmadan doğrulanamaz; bilerek atlanır
      yolSayisi++;
      const yol = hedef.replace(/#.*$/, "").replace(/\/$/, "");
      assert.ok(
        existsSync(fileURLToPath(new URL(`../${yol}`, import.meta.url))),
        `${ad}: "${etiket}" rozeti depoda olmayan "${hedef}" yolunu gösteriyor`
      );
    }
  }
  assert.ok(
    capaSayisi >= 2 && yolSayisi >= 4,
    `çözülen rozet hedefi az (çapa ${capaSayisi}, yol ${yolSayisi}) — hedef ayrıştırması ` +
      "bayatladıysa bu blok hiçbir şeyi doğrulamadan yeşil kalır"
  );
});

test("iki README'nin her BÖLÜMÜ aynı KOD JETONLARINI anıyor (TR/EN parite)", () => {
  /**
   * Bu gözcünün yakaladığı ayrışma türü ölçüldü: `AEGIS_NV_SIMULATE`'in ikinci kanıt
   * satırı ve `AEGIS_STEPUP=0` koşulu demo paragrafında YALNIZ İngilizce'deydi; zincir
   * tablosunun 6. satırı EN'de SDK'nın çağırdığı tam metodu
   * (`callForwardingSignal.retrieveUnconditionalCallForwarding`) adlandırırken TR yalnız
   * ad alanını yazıyordu. Düzyazı çevrilebilir; DEĞİŞKEN ADI, ARAÇ ADI, İZ DEĞERİ ve
   * DOSYA YOLU çevrilemez — bir dilde geçip diğerinde geçmiyorsa orada okura
   * anlatılmayan bir davranış vardır.
   *
   * YÖN (a) — belge: bir dil jeton kazanır/kaybederse kırmızı (iki yön de).
   * YÖN (b) — kod: kodda yeni bir değişken/araç doğup tek dile belgelenirse kırmızı.
   *
   * Eşleştirme SIRAYA göre; bölüm sayısının eşitliği burada ayrıca sabitlenir, çünkü
   * kayan bir sıra bu gözcüyü anlamsız çiftler üzerinde koştururdu.
   */
  const en = parBolumler(PAR_EN);
  const tr = parBolumler(PAR_TR);
  assert.equal(
    en.length,
    tr.length,
    `README bölüm sayıları ayrışmış (EN ${en.length}, TR ${tr.length}) — bölümler sırayla ` +
      "eşleştiği için bu gözcü önce sırayı sabitler"
  );
  assert.ok(en.length >= 15, `beklenenden az bölüm bulundu (${en.length}) — bölme deseni bayat`);

  const ayrisan: string[] = [];
  let jetonSayisi = 0;
  for (let i = 0; i < en.length; i++) {
    const a = parKodJetonlari(en[i].govde);
    const b = parKodJetonlari(tr[i].govde);
    jetonSayisi += a.size;
    const yalnizEn = [...a].filter((x) => !b.has(x));
    const yalnizTr = [...b].filter((x) => !a.has(x));
    if (yalnizEn.length > 0 || yalnizTr.length > 0) {
      ayrisan.push(
        `${en[i].baslik} ↔ ${tr[i].baslik}` +
          (yalnizEn.length > 0 ? ` · yalnız EN: ${yalnizEn.join(", ")}` : "") +
          (yalnizTr.length > 0 ? ` · yalnız TR: ${yalnizTr.join(", ")}` : "")
      );
    }
  }
  // Vakum koruması: jeton hiç toplanmadıysa yukarıdaki döngü boş kümeleri eşitler.
  assert.ok(
    jetonSayisi >= 60,
    `bölümlerden toplanan kod jetonu sayısı ${jetonSayisi} — ters tırnak deseni bayatladıysa ` +
      "gözcü hiçbir şey karşılaştırmadan yeşil kalır"
  );
  assert.deepEqual(
    ayrisan,
    [],
    "İki README aynı bölümde farklı kod jetonları anıyor:\n  " + ayrisan.join("\n  ")
  );
});

test("her zincir halkasının ANAHTAR değişkeni İKİ README'de de yazılı (kayıttan türer)", () => {
  /**
   * YÖN (b) — kod: liste `ZINCIR_HALKALARI`'ndan türer. Zincire yedinci bir halka
   * eklenip anahtarı yalnız bir dile (ya da hiçbirine) yazılırsa kırmızı: operatör
   * açmadığı bir halkanın onay yoluna girdiğini belgeden öğrenemez.
   * YÖN (a) — belge: bir dil değişkeni düşürürse kırmızı.
   *
   * "Anahtar değişken" = halkayı AÇAN değişken: `*_SIMULATE` olmayanı. Gerçek kanalı
   * olmayan tek halka (Number Verification) için o küme boştur; onun anahtarı da
   * simülasyon değişkenidir, çünkü halkayı koşturan tek şey odur.
   */
  const anahtarlar = ZINCIR_HALKALARI.map((halka) => {
    const gercek = halka.envler.filter((e) => !e.endsWith("_SIMULATE"));
    return { id: halka.id, envler: gercek.length > 0 ? gercek : [...halka.envler] };
  });
  assert.equal(
    anahtarlar.length,
    ZINCIR_HALKALARI.length,
    "her halkanın anahtarı çıkarılamadı — kayıt alanı `envler` yeniden adlandırılmış olabilir"
  );
  const envsiz = anahtarlar.filter((a) => a.envler.length === 0).map((a) => a.id);
  assert.deepEqual(
    envsiz,
    [],
    `env'i hiç olmayan halka var (${envsiz.join(", ")}) — gözcü boş listeye bakıp yeşil kalmasın`
  );

  const eksik: string[] = [];
  for (const { id, envler } of anahtarlar) {
    for (const [ad, belge] of PAR_IKISI) {
      // Ters tırnak İÇİNDE aranır: düzyazıda geçen bir ad "belgelenmiş" sayılmaz.
      const yazili = envler.some((env) => new RegExp("`" + env + "\\b").test(belge));
      if (!yazili) eksik.push(`${ad}: ${id} (${envler.join(" / ")})`);
    }
  }
  assert.deepEqual(
    eksik,
    [],
    "Zincir kaydındaki bir halkanın anahtar değişkeni bu belgelerde hiç geçmiyor:\n  " +
      eksik.join("\n  ")
  );
});

test("'kapali' doktrini: DAVRANIŞLA ölçülür ve İKİ dilde de yazılı", async () => {
  /**
   * Bu, TR README'den eksik olan (2) numaralı paragrafın gözcüsü ve kapının en kolay
   * kaybedilen ayrımı: "SORMADIM" ≠ "SORDUM VE GEÇTİ". Bir halka kapalıyken izin sessiz
   * kalması, sonradan izi okuyan birine halkanın TEMİZ döndüğünü düşündürür.
   *
   * YÖN (b) — kod: taban yapılandırmada (yalnız jeton + numara) opt-in halkaların izi
   * GERÇEKTEN "kapali" mi? Alan hiç yazılmazsa, `undefined` kalırsa ya da "calismadi"ya
   * dönerse kırmızı — o an her iki README'deki cümle yalan olur.
   * YÖN (a) — belge: cümle bir dilden düşerse ya da iki durumu ayırmayı bırakırsa kırmızı.
   *
   * Ağa çıkılmaz: beş gerçek kanalın hepsi enjekte edilir (bkz. dockerIzi).
   */
  const iz = await dockerIzi(DOCKER_TABAN, "high");
  // Vakum koruması: SIM Swap koşmadıysa aşağıdaki "hepsi kapali" boş bir iz üstünde de
  // doğrulanır ve gözcü hiçbir şey ölçmemiş olur.
  assert.equal(
    iz.simSwap,
    "gercek",
    `taban yapılandırmada SIM Swap koşmadı (iz: ${String(iz.simSwap)}) — gözcü boş ize bakıyor`
  );

  const optIn = optInHalkalari();
  assert.ok(optIn.length >= 3, `opt-in halka sayısı ${optIn.length} — kayıt/env adlandırması bayat`);
  for (const { checkEnv, halka } of optIn) {
    assert.equal(
      izDegeri(iz, halka.izAlani),
      "kapali",
      `'${halka.id}' halkası ${checkEnv} kapalıyken ize "kapali" YAZMIYOR ` +
        `(okunan: ${String(izDegeri(iz, halka.izAlani))}). İz sessiz kalırsa "sormadım" ile ` +
        '"sordum ve geçti" ayrılamaz ve iki README\'deki cümle yanlış olur.'
    );
  }

  /**
   * KONTROL GRUBU — üstteki döngünün VAKUM olmadığının kanıtı. "kapali" bir varsayılan
   * ya da sabit değil, POZİTİF bir beyandır; iki yönden de ölçülür:
   *   (1) halka AÇILINCA aynı alan "gercek" olur — alan sabit "kapali" yazmıyor;
   *   (2) ORTA kademede alan hiç YAZILMAZ — yani "kapali", yüksek kademede bilerek
   *       kapatılmış bir halkanın beyanıdır, "hiç sorulmadı"nın sessizliği değil.
   * Bu iki satır olmasaydı üstteki döngü, her alana "kapali" basan bir kodda da yeşil
   * kalırdı — ve README'lerin ayırdığı iki durum aslında ayrılmamış olurdu.
   */
  const acik = await dockerIzi({ ...DOCKER_TABAN, reachCheck: true }, "high");
  assert.equal(
    acik.reach,
    "gercek",
    "erişilebilirlik halkası AÇIKKEN bile ize 'kapali' yazıyor — alan sabit, gözcü ayırt etmiyor"
  );
  const orta = await dockerIzi(DOCKER_TABAN, "medium");
  assert.equal(
    izDegeri(orta, "reach"),
    undefined,
    "orta kademede de 'kapali' yazılıyor — o zaman 'kapali' bir beyan değil varsayılan olurdu"
  );

  /** `kapali`yı ANAN cümle: iddia cümle biriminde aranır, paragraf boyunca değil. */
  const kapaliCumlesi = (belge: string) =>
    cumleler(belge.replace(/\n/g, " ")).filter((c) => /`kapali`/.test(c));

  for (const [ad, belge, ...kosullar] of [
    ["README.md", PAR_EN, /did not ask/i, /passed/i],
    ["README.tr.md", PAR_TR, /sormadım/i, /geçti/i],
  ] as Array<[string, string, RegExp, RegExp]>) {
    const adaylar = kapaliCumlesi(belge);
    assert.ok(
      adaylar.length > 0,
      `${ad}: \`kapali\` iz değeri hiç geçmiyor — kapatılmış halkanın ize ne yazdığını ` +
        "okur öğrenemiyor"
    );
    assert.ok(
      adaylar.some((c) => kosullar.every((k) => k.test(c))),
      `${ad}: \`kapali\` geçiyor ama hiçbir cümlesi "sormadım" ile "sordum ve geçti"yi ` +
        `AYIRMIYOR. Bulunan cümleler: ${JSON.stringify(adaylar)}`
    );
  }
});

test("iki README'nin GÜVENLİK bölümü ağ kapısını da kapalı-arıza kuralına bağlıyor", async () => {
  /**
   * YÖN (a) — belge: cümle TR'de YOKTU. Beş değişmezin ikisi sayılıyor ama ağ kapısının
   * aynı kurala tabi olduğu ve YAPMADIĞI bir canlı sorguyu yapmış gibi göstermediği
   * yalnız İngilizce README'de yazıyordu.
   * YÖN (b) — kod: cevap veremeyen güven çapası GERÇEKTEN reddediyor mu? Fırlatan çağrı
   * yutulur ya da "değişmedi" sayılırsa kırmızı.
   */
  for (const [ad, belge] of PAR_IKISI) {
    const bolum = parBolumler(belge).find((b) => /^##\s+(Security|Güvenlik)$/.test(b.baslik));
    assert.ok(bolum, `${ad}: "Security"/"Güvenlik" bölümü bulunamadı — test yolu bayatlamış`);
    const duz = bolum.govde.replace(/\s+/g, " ");
    assert.match(
      duz,
      /docs\/CAMARA\.md/,
      `${ad}: Güvenlik bölümü ağ güven kapısının belgesine (docs/CAMARA.md) hiç bağlamıyor — ` +
        "açık bildiren araştırmacı kapının VARLIĞINI öğrenemez"
    );
    assert.match(
      duz,
      /(cannot answer|cevap veremiyorsa)/i,
      `${ad}: Güvenlik bölümü "güven çapası cevap veremezse harcama olmaz" kuralını söylemiyor`
    );
    assert.match(
      duz,
      /(never claims a live query it did not make|yapmadığı bir canlı sorguyu)/i,
      `${ad}: Güvenlik bölümü, kapının yapmadığı canlı sorguyu yapmış gibi göstermediğini ` +
        "söylemiyor — simülasyonla gerçeği ayıran vaat tam olarak budur"
    );
  }

  await secIzole(async () => {
    __setSimSwapKanalForTests({
      verifySimSwap: async () => {
        throw new Error("guven capasi cevap veremiyor");
      },
    });
    const yanitsiz = await agDogrula(SEC_TEK_HALKA, "medium");
    assert.ok(yanitsiz.engel, "cevap veremeyen güven çapası harcamayı GEÇİRDİ (fail-open)");
    assert.equal(yanitsiz.iz.retNedeni, "ag-yanitsiz");

    // KONTROL GRUBU: kapı her şeyi reddetmiyor — yoksa üstteki satır her kodda yeşil kalırdı.
    __setSimSwapKanalForTests({ verifySimSwap: async () => false });
    const temiz = await agDogrula(SEC_TEK_HALKA, "medium");
    assert.equal(temiz.engel, undefined, "temiz sinyalde de reddediliyor — gözcü ayırt etmiyor");
  });
});

test("iki README'nin GELİŞTİRME bölümü yeşil testin canlı tel hakkında SUSTUĞUNU söylüyor", () => {
  /**
   * YÖN (a) — belge: çekince TR'de YOKTU. Türkçe okur, yeşil paketin CAMARA telini de
   * kanıtladığını sanabilirdi; oysa kanıtladığı şey KARAR MANTIĞI.
   * YÖN (b) — kod: çekince, test dikişinin VARLIĞINA dayanıyor. Dikiş kaldırılırsa cümle
   * ("enjekte edilmiş sahte bir kanal üzerinden") dayanaksız kalır.
   */
  for (const [ad, belge] of PAR_IKISI) {
    const bolum = parBolumler(belge).find((b) => /^##\s+(Development|Geliştirme)$/.test(b.baslik));
    assert.ok(bolum, `${ad}: "Development"/"Geliştirme" bölümü bulunamadı — test yolu bayat`);
    const duz = bolum.govde.replace(/\s+/g, " ");
    assert.match(
      duz,
      /(injected fake channel|enjekte edilmiş sahte bir kanal)/i,
      `${ad}: Geliştirme bölümü ağ kapısının ENJEKTE kanalla test edildiğini söylemiyor`
    );
    assert.match(
      duz,
      /(say nothing about the live CAMARA wire|canlı CAMARA teli hakkında hiçbir şey)/i,
      `${ad}: Geliştirme bölümü, yeşil testlerin canlı CAMARA teli hakkında hiçbir şey ` +
        "söylemediği çekincesini taşımıyor — depo PUBLIC ve bu, jürinin okuyacağı bir vaat"
    );
  }

  assert.equal(
    typeof __setSimSwapKanalForTests,
    "function",
    "test dikişi (__setSimSwapKanalForTests) yok — belgedeki 'enjekte kanal' cümlesi dayanaksız"
  );
});
