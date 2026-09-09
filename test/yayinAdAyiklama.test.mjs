// SPDX-License-Identifier: AGPL-3.0-only
/**
 * YAYIN SONUCU SINIFLANDIRMASI — CLI HANGİ ADI TESLİM EDİYOR?
 *
 * SÖZLEŞME: rapor, ağ kapısının gerçekten çalıştığını ancak GERÇEKTEN çalıştığında
 * söyleyebilir. yayinSonucuSinifla bu yüzden kampanya adını sınıflandırdığı metinden
 * AYIKLAR: sunucu ret metnine kampanyanın adını koyar, o ad da MODELİN serbest metnidir;
 * ayıklanmazsa desen araması modelin kendi cümlesini kapının çıktısı sanabilir.
 *
 * AMA AYIKLAMA ANCAK DOĞRU DİZEYLE ÇALIŞIR. İki katman farklı ad kullanıyordu:
 *
 *   - hesaba GERÇEKTEN yazılan ad  = "<damga> — <trimlenmiş plan adı>"  (uygulama.mjs)
 *   - growth-brain'in sınıflandırıcıya verdiği ad = plan.kampanyaAdi   (modelin ham metni)
 *
 * Çıplak model dizesini vermek AZ değil ÇOK ayıklar: dize metinde nerede geçiyorsa oradan
 * silinir. Model kampanyaya "AĞ DOĞRULAMASI BAŞARISIZ" adını verdiğinde, içinde kampanya
 * adı HİÇ GEÇMEYEN gerçek bir CAMARA reddinden kapının KENDİ manşeti silinir; ret
 * 'reddedildi' diye sınıflanır ve rapor "GÜVENLİK KAPISI ÇALIŞTI" bloğunu hiç basmaz.
 * Ağ kapısının kaydının ne zaman yok olacağına model karar vermiş olur.
 *
 * BU DOSYA DAVRANIŞ KİLİTLER, METİN DEĞİL. growth-brain.mjs'in GERÇEK kopyası, sahte
 * brain/ modülleriyle bir alt süreçte baştan sona koşturulur; ölçülen şey, --yayinla
 * yolunun yayinaAl'a teslim ettiği dizedir ve o dizeyle üretilen GERÇEK sınıflandırmadır.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { yayinSonucuSinifla } from "../scripts/brain/uygulama.mjs";

const KOK = fileURLToPath(new URL("..", import.meta.url));
const BEYIN = join(KOK, "scripts", "growth-brain.mjs");
const GERCEK_UYGULAMA_URL = pathToFileURL(join(KOK, "scripts", "brain", "uygulama.mjs")).href;

/** Modelin seçtiği kampanya adı — ağ kapısının KENDİ manşetiyle birebir aynı. */
const PLAN_ADI = "AĞ DOĞRULAMASI BAŞARISIZ";
/** uygula()'nın hesaba gerçekten yazdığı ad: guvenliDize trimler, koşu damgası öne eklenir. */
const YAZILAN_AD = `GB-20260908-1200 — ${PLAN_ADI}`;
/**
 * GERÇEK bir CAMARA reddi — networkTrust.ts:2681'in biçimi. Dikkat: bu metinde kampanya
 * adı HİÇ GEÇMEZ; ayıklamanın burada silecek bir şeyi olmamalıdır.
 */
const AG_RETTI_METNI =
  "Reddedildi: AĞ DOĞRULAMASI BAŞARISIZ — onaylayıcının (+905*******33) SIM kartı " +
  "son 7 gün içinde değiştirilmiş (2 gün önce).";

/** Sahte uygula()'ya "hiç ad döndürme" demenin yolu. */
const AD_YOK = "__AD_YOK__";

/* ── Alt süreç düzeneği ──────────────────────────────────────────────────────── */

/**
 * growth-brain.mjs'in BİREBİR kopyasını, sahte brain/ modülleriyle dolu geçici bir dizine
 * koyup çalıştırır. Kopya node_modules altında durur: kaynak-hijyeni yürüyücüsü orayı
 * atlar, dotenv gibi çıplak belirteçler ise depo köküne kadar yürüyerek çözülür.
 *
 * Sahte stdin'in isTTY'si BİLEREK true'dur. Boru/TTY kapısının kendi bekçisi var
 * (test/onarimGrowthBrain.test.mjs); buradaki konu insan kapısı değil, kapıdan SONRA hangi
 * adın teslim edildiği. O kapıyı burada da kapalı tutmak, bu testin ölçmek istediği koda
 * hiç ulaşamamak demek olurdu.
 */
function duzenekKur(temizle) {
  const dizin = mkdtempSync(join(KOK, "node_modules", ".gb-yayin-ad-"));
  temizle.push(dizin);
  mkdirSync(join(dizin, "brain"));
  copyFileSync(BEYIN, join(dizin, "growth-brain.mjs"));

  const yaz = (goreli, kaynak) => writeFileSync(join(dizin, goreli), kaynak, "utf8");

  yaz(
    "tty.mjs",
    [
      "import { PassThrough } from 'node:stream';",
      "const sahte = new PassThrough();",
      "sahte.isTTY = true;",
      "sahte.setRawMode = () => sahte;",
      "Object.defineProperty(process, 'stdin', { value: sahte, configurable: true });",
      "const asilYaz = process.stdout.write.bind(process.stdout);",
      "process.stdout.write = function (parca, ...kalan) {",
      "  if (String(parca).includes(\"Yalnız 'Evet' devam ettirir:\")) {",
      "    setImmediate(() => sahte.write('Evet\\n'));",
      "  }",
      "  return asilYaz(parca, ...kalan);",
      "};",
      "",
    ].join("\n")
  );

  yaz(
    "brain/ortak.mjs",
    [
      "export const BRAIN_MODEL = 'test-model';",
      "export const BRAIN_SAGLAYICI = 'test';",
      "export function beyinIstemcisi() { return {}; }",
      "export async function jsonUret() { return {}; }",
      "export async function mcpBaglan() {",
      "  return {",
      "    cagir: async () => '(test)',",
      "    kaynakOku: async () => '{\"yazmaIzni\":true,\"gunlukButceTavani\":100}',",
      "    kapat: async () => {},",
      "  };",
      "}",
      "",
    ].join("\n")
  );

  yaz(
    "brain/arastirma.mjs",
    ["export async function arastir() { return { anahtarKelimeAdaylari: ['deri canta'] }; }", ""].join("\n")
  );

  yaz(
    "brain/strateji.mjs",
    [
      "export async function stratejiKur() {",
      "  return {",
      "    kampanyaAdi: process.env.GB_TEST_PLAN_ADI,",
      "    butceGunlukTL: 50,",
      "    hedefUlke: 'TR',",
      "    dil: 'tr',",
      "    adGruplari: [{ anahtarKelimeler: ['deri canta'] }],",
      "    negatifKelimeler: ['ucuz'],",
      "  };",
      "}",
      "export function planDogrula(plan) { return plan; }",
      "",
    ].join("\n")
  );

  yaz(
    "brain/kreatif.mjs",
    [
      "export async function kreatifUret() {",
      "  return { basliklar: ['b1', 'b2', 'b3'], aciklamalar: ['a1', 'a2'] };",
      "}",
      "",
    ].join("\n")
  );

  yaz(
    "brain/dagitim.mjs",
    [
      "export function kullanilabilirKanallar() { return ['google']; }",
      "export async function butceDagit(girdi) {",
      "  return [{ kanal: 'google', gunlukButce: girdi.toplamButce, gerekce: 'test' }];",
      "}",
      "export function dagitimOzeti(d) { return d.map((p) => p.kanal + ':' + p.gunlukButce).join(', '); }",
      "export function uygulanacakPay(d, kanal) { return d.find((p) => p.kanal === kanal); }",
      "",
    ].join("\n")
  );

  yaz("brain/rapor.mjs", ["export function raporOlustur() { return '# test raporu\\n'; }", ""].join("\n"));

  /**
   * Sahte uygulama katmanı. yayinaAl SAHTE DEĞİL: sınıflandırmayı GERÇEK
   * yayinSonucuSinifla yapar, yalnız sunucu cevabı sabitlenmiştir. Böylece ölçülen şey
   * gerçek zincir olur — CLI'nın verdiği ad, gerçek ayıklama, gerçek desen araması.
   */
  yaz(
    "brain/uygulama.mjs",
    [
      `import { yayinSonucuSinifla } from ${JSON.stringify(GERCEK_UYGULAMA_URL)};`,
      "export async function uygula() {",
      "  const ad = process.env.GB_TEST_YAZILAN_AD;",
      `  const AD_YOK = ${JSON.stringify(AD_YOK)};`,
      "  return {",
      "    kampanyaId: '1111111111',",
      "    adGrubuId: '2222222222',",
      "    kampanyaAdi: ad === AD_YOK ? undefined : ad,",
      "    basari: true,",
      "    kirpik: false,",
      "    adimlar: [],",
      "    uyarilar: [],",
      "    eksikAdimlar: [],",
      "  };",
      "}",
      "export async function yayinaAl(girdi) {",
      "  const metin = process.env.GB_TEST_SUNUCU_METNI;",
      "  const durum = yayinSonucuSinifla(metin, girdi.kampanyaAdi);",
      "  process.stdout.write('<<AD>>' + String(girdi.kampanyaAdi) + '<</AD>>\\n');",
      "  process.stdout.write('<<DURUM>>' + durum + '<</DURUM>>\\n');",
      "  return {",
      "    denendi: true,",
      "    kampanyaId: girdi.kampanyaId,",
      "    durum,",
      "    sonucMetni: metin,",
      "    kanitSatirlari: [],",
      "  };",
      "}",
      "",
    ].join("\n")
  );

  return dizin;
}

/** Düzeneği kurup --uygula --yayinla ile koşturur; stdout+stderr birleşik döner. */
function beyniKostur(dizin, { planAdi, yazilanAd, sunucuMetni }) {
  return new Promise((coz, tik) => {
    const cocuk = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(join(dizin, "tty.mjs")).href,
        join(dizin, "growth-brain.mjs"),
        "--hedef",
        "test hedefi",
        "--url",
        "https://ornek.example",
        "--butce",
        "50",
        "--musteri",
        "1234567890",
        "--uygula",
        "--yayinla",
      ],
      {
        cwd: dizin,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          GB_TEST_PLAN_ADI: planAdi,
          GB_TEST_YAZILAN_AD: yazilanAd,
          GB_TEST_SUNUCU_METNI: sunucuMetni,
        },
      }
    );
    let cikti = "";
    cocuk.stdout.on("data", (p) => (cikti += String(p)));
    cocuk.stderr.on("data", (p) => (cikti += String(p)));
    cocuk.on("error", tik);
    const zaman = setTimeout(() => cocuk.kill("SIGKILL"), 40000);
    cocuk.on("close", () => {
      clearTimeout(zaman);
      coz(cikti);
    });
  });
}

const arasindaki = (metin, etiket) => {
  const d = new RegExp(`<<${etiket}>>([\\s\\S]*?)<</${etiket}>>`).exec(metin);
  return d ? d[1] : undefined;
};

/* ── 1) Ne ölçtüğümüzün gerekçesi: iki dize aynı metni farklı sınıflandırır ──── */

test("GERÇEK ağ reddi, hesaba YAZILAN adla ayıklandığında 'ag-retti' kalır", () => {
  /**
   * Kapının kendi manşetini taşıyan bu metinde kampanya adı geçmez; yazılan ad
   * ayıklanınca metinde hiçbir şey değişmez ve kapının reddi olduğu gibi görünür.
   */
  assert.equal(
    yayinSonucuSinifla(AG_RETTI_METNI, YAZILAN_AD),
    "ag-retti",
    "hesaba yazılan ad ayıklanınca gerçek CAMARA reddi ağ reddi olarak kalmalı"
  );
});

test("Çıplak model adı ayıklanırsa aynı GERÇEK ağ reddi ağ reddi SAYILMAZ", () => {
  /**
   * Bu, düzeltilen arızanın ta kendisi ve bu testin var oluş sebebi: çıplak model dizesi
   * metinde nerede geçiyorsa oradan silinir, kapının manşeti de silinenler arasındadır.
   * Buradaki iddia "hangi sınıf çıkar" değil, "AYNI SINIF ÇIKMAZ"; ayıklamanın hangi
   * dizeyle yapıldığı sonucu değiştiriyor demektir — dolayısıyla CLI'nın doğru dizeyi
   * teslim etmesi bir zorunluluktur, tercih değil.
   */
  assert.notEqual(
    yayinSonucuSinifla(AG_RETTI_METNI, PLAN_ADI),
    "ag-retti",
    "çıplak model adıyla ayıklama kapının manşetini silmeliydi — silmiyorsa bu testin " +
      "dayandığı zemin değişmiş, yayinSonucuSinifla yeniden okunmalı"
  );
});

/* ── 2) Asıl bekçi: CLI hangi dizeyi teslim ediyor? ──────────────────────────── */

test(
  "YÜKSEK: --yayinla, sınıflandırıcıya hesaba YAZILAN adı verir (modelin ham adını değil)",
  { timeout: 90000 },
  async () => {
    const temizle = [];
    try {
      const dizin = duzenekKur(temizle);
      const cikti = await beyniKostur(dizin, {
        planAdi: PLAN_ADI,
        yazilanAd: YAZILAN_AD,
        sunucuMetni: AG_RETTI_METNI,
      });

      assert.equal(
        arasindaki(cikti, "AD"),
        YAZILAN_AD,
        `yayinaAl'a teslim edilen ad hesaba yazılan ad olmalı — çıktı:\n${cikti}`
      );
      assert.equal(
        arasindaki(cikti, "DURUM"),
        "ag-retti",
        `gerçek CAMARA reddi 'ag-retti' sınıflanmalı; başka bir sınıf, kapının kaydının ` +
          `silindiği anlamına gelir — çıktı:\n${cikti}`
      );
      assert.match(
        cikti,
        /AĞ KAPISI REDDETTİ/,
        `operatöre kapının çalıştığı söylenmeli — çıktı:\n${cikti}`
      );
    } finally {
      for (const d of temizle) rmSync(d, { recursive: true, force: true });
    }
  }
);

/* ── 3) Kapalı arıza: yazılan ad bilinmiyorsa yayına alma HİÇ denenmez ───────── */

test(
  "KAPALI ARIZA: kurulum yazılan adı döndürmezse yayına alma atlanır, yayinaAl çağrılmaz",
  { timeout: 90000 },
  async () => {
    /**
     * Ad bilinmiyorsa ayıklama kurulamaz, sınıflandırmaya güvenilemez. "Bilinmiyor" boş
     * dize değildir: yayına alma denenmez, kampanya PAUSED kalır.
     */
    const temizle = [];
    try {
      const dizin = duzenekKur(temizle);
      const cikti = await beyniKostur(dizin, {
        planAdi: PLAN_ADI,
        yazilanAd: AD_YOK,
        sunucuMetni: AG_RETTI_METNI,
      });

      assert.equal(
        arasindaki(cikti, "AD"),
        undefined,
        `yazılan ad bilinmezken yayinaAl HİÇ çağrılmamalıydı — çıktı:\n${cikti}`
      );
      assert.match(
        cikti,
        /Yayına alma ATLANDI/,
        `atlama sessiz olamaz, gerekçesi ekrana yazılmalı — çıktı:\n${cikti}`
      );
      assert.match(
        cikti,
        /YAZDIĞI kampanya adı geri dönmedi/,
        `atlamanın gerekçesi ADIN bilinmemesi olmalı — çıktı:\n${cikti}`
      );
    } finally {
      for (const d of temizle) rmSync(d, { recursive: true, force: true });
    }
  }
);
