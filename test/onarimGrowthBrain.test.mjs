// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GROWTH BRAIN'İN İNSAN KAPISI — denetim onarımlarının bekçisi.
 *
 * İki onarım burada kilitlenir; ikisi de "operatörün gördüğü ekran ile gerçekte olan iş
 * aynı mıdır" sorusunun aynı yüzüdür:
 *
 *   1) ONAY EKRANI, YAZILACAK KANALI ADIYLA SÖYLER. Bütçe birden çok kanala bölündüğünde
 *      ekrandaki kanal adı `dagitim[0].kanal` ile, yani MODELİN sıralamasıyla seçiliyordu;
 *      kurulan kampanya ise her koşulda Google'a yazılıyordu. Model dağıtımı
 *      [meta, google] sırasıyla döndürdüğünde ekran "30 TL — 'meta' kanalının PAYI" ve
 *      "bu onay YALNIZ 'meta' payı içindir" diyor, iki satır yukarıda meta payını 70
 *      gösteriyor, kurulan şey ise 30 TL'lik bir GOOGLE kampanyası oluyordu. Operatör
 *      onayladığından başka bir şey alıyordu.
 *
 *   2) BORUDAN ONAY GEÇMEZ. `echo evet | ...` ÖLÇÜLDÜ: `rl.question` kapanma yarışından
 *      ÖNCE "evet" ile çözülüyor ve TASLAK YAZMA onayı, klavyede kimse yokken geçiyordu.
 *      Yalnız ikinci soru EOF görüyordu — yani asıl kapı zaten aşılmış oluyordu.
 *
 * NEDEN GERÇEK ALT SÜREÇ: bellek içi akış (`Readable.from([...])`) üretimdeki davranışı
 * ÖLÇMÜYOR — mevcut test tam bu yüzden yeşil kalırken hata canlıydı. Buradaki boru testi
 * gerçek bir işletim sistemi borusu kurar; ölçtüğü şey operatörün yazacağı komutun ta
 * kendisidir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { planOzetiSatirlari, operatorOnayi, onayVerildiMi } from "../scripts/growth-brain.mjs";

const KOK = join(import.meta.dirname, "..");
const BEYIN_URL = pathToFileURL(join(KOK, "scripts", "growth-brain.mjs")).href;

/** Yazılanı yutan çıktı akışı: test terminale bir şey basmasın. */
const sessizCikti = () => new Writable({ write(_p, _e, cb) { cb(); } });

/** Ekranın gerektirdiği en küçük geçerli plan/kreatif — alanların içeriği bu testin konusu değil. */
const planKur = (butceGunlukTL) => ({
  kampanyaAdi: "Deri Çanta — Arama",
  butceGunlukTL,
  hedefUlke: "TR",
  dil: "tr",
  adGruplari: [{ anahtarKelimeler: ["deri çanta"] }],
  negatifKelimeler: ["ucuz"],
});
const KREATIF = { basliklar: ["b1", "b2"], aciklamalar: ["a1"] };

/* ── 1) Onay ekranı: kanal adı konumdan değil, yazılacak kanaldan gelir ──────── */

test("KRİTİK: çok kanallı onay ekranı, KURULACAK kanalı adlandırır (model sırası değil)", () => {
  /**
   * Model dağıtımı meta'yı ÖNE koyuyor, kampanya ise google'a yazılıyor. Ekranın her
   * satırı google demeli; hiçbir satır onaylananın meta payı olduğunu ima etmemeli.
   */
  const dagitim = [
    { kanal: "meta", gunlukButce: 70, gerekce: "sosyal ağırlık" },
    { kanal: "google", gunlukButce: 30, gerekce: "arama niyeti" },
  ];
  const satirlar = planOzetiSatirlari({
    dagitim,
    uygulananKanal: "google",
    plan: planKur(30),
    kreatif: KREATIF,
    efektifTavan: 100,
    tavanKaynagi: "CLI --butce tavanı",
    musteri: "1234567890",
    url: "https://ornek.example",
    yayinla: false,
  });

  const payiSatiri = satirlar.find((s) => s.includes("kanalının PAYI"));
  assert.ok(payiSatiri, "çok kanallı ekranda 'kanalının PAYI' satırı bulunmalı");
  assert.match(
    payiSatiri,
    /'google' kanalının PAYI/,
    `Onay ekranı YANLIŞ kanalı adlandırıyor: kampanya google'a yazılıyor ama ekran ` +
      `şunu diyor -> ${payiSatiri}`
  );
  assert.equal(
    payiSatiri.includes("'meta'"),
    false,
    "yazılmayacak kanalın adı, onaylanan payın etiketi olamaz"
  );

  const dikkatSatiri = satirlar.find((s) => s.includes("DİKKAT"));
  assert.ok(dikkatSatiri, "'DİKKAT' satırı kaybolmamalı");
  assert.match(
    dikkatSatiri,
    /YALNIZ 'google' payı içindir/,
    `DİKKAT satırı yanlış kanalı adlandırıyor -> ${dikkatSatiri}`
  );

  // Bölünme bilgisi ve toplam, olduğu gibi durmalı: operatör payın bir PARÇA olduğunu görmeli.
  assert.ok(
    satirlar.some((s) => s.includes("2 kanala bölündü") && s.includes("meta: 70 · google: 30")),
    "toplam ve dağılım satırı, payın bir parça olduğunu göstermeye devam etmeli"
  );
});

test("Onay ekranı sıralamadan bağımsız: google başta olduğunda da google adlandırılır", () => {
  const satirlar = planOzetiSatirlari({
    dagitim: [
      { kanal: "google", gunlukButce: 60, gerekce: "arama" },
      { kanal: "meta", gunlukButce: 40, gerekce: "sosyal" },
    ],
    uygulananKanal: "google",
    plan: planKur(60),
    kreatif: KREATIF,
    efektifTavan: 100,
    tavanKaynagi: "CLI --butce tavanı",
    musteri: "1234567890",
    url: "https://ornek.example",
    yayinla: true,
  });
  assert.match(satirlar.find((s) => s.includes("kanalının PAYI")), /'google' kanalının PAYI/);
});

test("KAPALI ARIZA: yazılacak kanal dağıtımda yoksa onay ekranı hiç kurulmaz", () => {
  /**
   * Kanal adı söylenemiyorsa ekran gösterilmez: adı olmayan (ya da yanlış adlı) bir onay,
   * kurulacak şeyden başka bir şeyin onayıdır. Fırlatma, ilk yazmadan önce koşuyu durdurur.
   */
  assert.throws(
    () =>
      planOzetiSatirlari({
        dagitim: [
          { kanal: "meta", gunlukButce: 70, gerekce: "a" },
          { kanal: "tiktok", gunlukButce: 30, gerekce: "b" },
        ],
        uygulananKanal: "google",
        plan: planKur(30),
        kreatif: KREATIF,
        efektifTavan: 100,
        tavanKaynagi: "CLI --butce tavanı",
        musteri: "1234567890",
        url: "https://ornek.example",
        yayinla: false,
      }),
    /Onay ekranı kurulamadı/,
    "yazılacak kanal dağıtımda yokken ekran sessizce başka bir kanalı adlandıramaz"
  );
});

/* ── 2) İnsan kapısı: gerçek boru ─────────────────────────────────────────────── */

/** Gerçek bir işletim sistemi borusundan 'evet' gönderir; çocuk süreç kararı basar. */
function boruylaOnayDene(yazilan) {
  return new Promise((coz, tik) => {
    const kod =
      'import(process.env.AEGIS_BEYIN_URL).then(async (m) => {' +
      '  const c = await m.operatorOnayi("Onaylıyor musun? ");' +
      '  process.stdout.write("SONUC:" + (m.onayVerildiMi(c) ? "ONAY" : "RET") + "\\n");' +
      '  process.exit(0);' +
      '});';
    const cocuk = spawn(process.execPath, ["-e", kod], {
      cwd: KOK,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AEGIS_BEYIN_URL: BEYIN_URL },
    });
    let cikti = "";
    cocuk.stdout.on("data", (p) => (cikti += String(p)));
    cocuk.stderr.on("data", (p) => (cikti += String(p)));
    cocuk.on("error", tik);
    cocuk.on("close", () => coz(cikti));
    const zaman = setTimeout(() => cocuk.kill("SIGKILL"), 15000);
    cocuk.on("close", () => clearTimeout(zaman));
    cocuk.stdin.write(yazilan);
    cocuk.stdin.end();
  });
}

test("KRİTİK: GERÇEK borudan 'evet' göndererek onay geçirilemez", { timeout: 30000 }, async () => {
  /**
   * Bellek içi akışla değil, `echo evet | node ...` ile aynı şekilde. Bu test kırmızıya
   * dönerse, klavyede kimse yokken gerçek Google Ads hesabına yazma onayı verilebiliyor
   * demektir.
   */
  const cikti = await boruylaOnayDene("evet\n");
  assert.match(cikti, /SONUC:RET/, `borudan gelen 'evet' onay sayıldı — çıktı:\n${cikti}`);
  assert.equal(/SONUC:ONAY/.test(cikti), false, "boru insan yerine geçemez");
});

test("KRİTİK: boruya 'Evet' ve ardından ikinci bir satır yazmak da geçmez", { timeout: 30000 }, async () => {
  // `printf 'Evet\nEvet\n' | npm run brain -- --uygula --yayinla` senaryosu: İLK kapı da tutmalı.
  const cikti = await boruylaOnayDene("Evet\nEvet\n");
  assert.match(cikti, /SONUC:RET/, `iki satırlık boru ilk onayı geçirdi — çıktı:\n${cikti}`);
});

test("Boru reddi SESSİZ değildir: neden reddedildiği ekrana yazılır", { timeout: 30000 }, async () => {
  const cikti = await boruylaOnayDene("evet\n");
  assert.match(
    cikti,
    /Onay ALINMADI/,
    "reddin gerekçesi operatöre söylenmeli; sessiz ret bir asılmadan ayırt edilemez"
  );
});

test("KARŞI KONTROL: gerçek terminalde 'evet' hâlâ onaydır", { timeout: 10000 }, async () => {
  /**
   * Kapıyı "her zaman ret" yapmak da bir onarım değildir: operatör klavyedeyken kapı
   * açılmalı. isTTY işaretli akış, gerçek terminalin yerine geçer.
   */
  const girdi = new PassThrough();
  girdi.isTTY = true;
  girdi.setRawMode = () => girdi;
  const bekleyen = operatorOnayi("Onaylıyor musun? ", { girdi, cikti: sessizCikti() });
  setImmediate(() => girdi.write("evet\n"));
  const cevap = await bekleyen;
  assert.equal(onayVerildiMi(cevap), true, "terminalden gelen 'evet' onaydır");
});
