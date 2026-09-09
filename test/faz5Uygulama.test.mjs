// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 5A — scripts/brain/uygulama.mjs · üç kusurun gözcüleri.
 *
 * Üçü de "gözcü deliği" ya da "yorum kodun yaptığından fazlasını söylüyor" ailesinden;
 * üçü de burada ÖLÇÜLEREK kapatılıyor.
 *
 *  1) RAPOR BAŞLIĞI YALAN SÖYLÜYORDU. rapor.mjs kanıt bloğunun üstüne "**Kanıt satırları**
 *     _(onay özetine ağ katmanının eklediği satırlar dahil)_" basıyordu. Gerçek kapı
 *     koşturularak ölçüldü: temiz CAMARA zinciri + elicitation bildirmeyen istemci ile
 *     agDogrula ÜÇ kanıt satırı üretti ve ÜÇÜ DE ne bu istemciye ne de rapora ulaştı —
 *     approval.ts onları `insanSatirlari`na koyar. Blokta yalnız onay özetinin maddeleri
 *     (Hesap/Kampanya · Günlük bütçe · Coğrafi hedef) vardı. Aşağıdaki gözcü hem davranışı
 *     (kanıt SIZMIYOR) hem başlığın kendisini (artık vaat ETMİYOR) çiviler.
 *
 *  2) YEŞİL BİR TEST VAR OLMAYAN DAVRANIŞI KORUYORDU. test/brain/yayin.test.mjs'in
 *     INSAN_ONAYI fixture'ında uydurma bir "Ağ doğrulaması [SİMÜLASYON]: SIM değişimi yok…"
 *     maddesi vardı ve test onu `kanitSatirlari` içinde arıyordu. O madde bugün hiçbir
 *     koşulda üretilmiyor. Fixture temizlendi; sözleşmenin GERÇEK hâli burada, fixture'dan
 *     değil GERÇEK KAPIDAN ölçülerek çivileniyor — yani approval.ts kanıtı ajan kanalına
 *     geri bağlarsa bu dosya kırmızı olur.
 *
 *  3) DESEN ANKETİ DELİKTİ. test/faz4Uygulama.test.mjs'in ayrıştırıcısı
 *     /^\s*\/(.+)\/([a-z]*),?\s*$/ olduğu için satır sonunda `// …` yorumu taşıyan bir
 *     desen ankete HİÇ girmiyordu: `/kademeli doğrulama/iu, // gecici` eklendiğinde altı
 *     testin altısı da yeşil kalıyordu (ölçüldü). Buradaki ayrıştırıcı YORUMLARI JS'in
 *     ayırdığı gibi ayırır ve KALAN HER KOD SATIRININ tek bir desen olmasını ŞART KOŞAR:
 *     okunamayan satır sessizce düşmez, gözcü FIRLATIR (kapalı arıza). Anket eksik
 *     kurulamadığı için "kaçak yok" iddiası artık tam küme üzerinden kuruluyor.
 *
 * AĞSIZ, YAZMASIZ, SIRSIZ: gerçek MCP/Google/CAMARA bağlantısı yok, .env okunmuyor,
 * geçici dosya bırakılmıyor. CAMARA halkaları test kanallarıyla oynatılır.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { onayAl } from "../src/approval.js";
import {
  agDogrula,
  __setSimSwapKanalForTests,
  __setErisimKanalForTests,
  __setCihazDegisimKanalForTests,
} from "../src/networkTrust.js";
import { yayinaAl, yayinSonucuSinifla } from "../scripts/brain/uygulama.mjs";
import { raporOlustur } from "../scripts/brain/rapor.mjs";

const KOK = join(dirname(fileURLToPath(import.meta.url)), "..");
const oku = (p) => readFileSync(join(KOK, p), "utf8");

const KAMPANYA_ADI = "GB-20260909-1200 — El Yapımı Deri Çanta";

/** write.ts'in set_campaign_status onay özetinden birebir alınmış madde satırları. */
const OZET_SATIRLARI = Object.freeze([
  "Hesap: 1234567890 · Kampanya: 9002",
  "Günlük bütçe: 40 (hesabın para biriminde; Google günlük bütçenin katlarını harcayabilir)",
  "Coğrafi hedef: 1 konum",
]);

/** Zincirin GERÇEKTEN kanıt üretmesi için üç halka da açık; kademe kapalı. */
const AG_AYARI = Object.freeze({
  nacToken: "TEST-ONLY-token",
  approverPhone: "+905551112277",
  simSwapWindowHours: 72,
  reachCheck: true,
  devSwapCheck: true,
  callFwdCheck: false,
  stepUp: false,
});

/** Kademeli doğrulamanın açık olduğu ayar — 3. kusurun gövdesini üretir. */
const KADEME_AYARI = Object.freeze({ ...AG_AYARI, simSwapWindowHours: 137, stepUp: true });

function ozetUret(agAyar) {
  return {
    eylem: `"${KAMPANYA_ADI}" kampanyası YAYINA ALINACAK — bu andan itibaren gerçek para harcanır.`,
    satirlar: [...OZET_SATIRLARI],
    risk: "high",
    agAyar,
  };
}

/** Elicitation BİLDİRMEYEN istemci — Growth Brain'in mcpBaglan'ı da böyledir. */
function zayifIstemci() {
  return {
    server: {
      getClientCapabilities: () => ({}),
      elicitInput: async () => {
        throw new Error("zayıf kanalda insana istem GÖSTERİLMEMELİ");
      },
    },
  };
}

/** Zincirin tamamı temiz: kapı GEÇER, kanıt satırları üretilir. */
function temizKosullar() {
  __setSimSwapKanalForTests({ verifySimSwap: async () => false });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => false });
}

/** SIM taşınmış ama cihaz değişimi halkası temiz → kefil var → kademe doğar. */
function kademeKosullari() {
  __setSimSwapKanalForTests({ verifySimSwap: async () => true });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => false });
}

afterEach(() => {
  __setSimSwapKanalForTests(undefined);
  __setErisimKanalForTests(undefined);
  __setCihazDegisimKanalForTests(undefined);
});

/* ── 1) & 2) Ağ kanıtı ajan kanalına AKMAZ — ve rapor bunun tersini söylemez ─── */

/**
 * Gerçek kapıdan bir tur: ağ TEMİZ geçer, istemci elicitation bildirmediği için onay
 * kapısı ajan kanalından reddeder. Dönen { kanit, mesaj } çifti bu dosyanın tüm
 * ölçümlerinin kaynağıdır — fixture yoktur.
 */
async function temizTurdanRet() {
  temizKosullar();
  const ag = await agDogrula(AG_AYARI, "high");
  assert.equal(ag.engel, undefined, "temiz zincirde kapı GEÇMELİYDİ — gözcünün öncülü bozuk");
  /**
   * KEFALET İLKESİ: kanıt üretilmediyse "kanıt sızmıyor" iddiası hiçbir şeye kefil olmaz.
   * Bu satır gözcüyü vakumdan çıkarır — üç halkanın gerçekten konuştuğunu ölçer.
   */
  assert.ok(ag.kanit.length >= 3, `zincir kanıt üretmedi (${ag.kanit.length}) — iddia vakuma düşer`);

  const sonuc = await onayAl(zayifIstemci(), ozetUret(AG_AYARI), undefined);
  assert.equal(sonuc.onaylandi, false);
  assert.equal(sonuc.kanal, "ajan", "elicitation yokken karar ajan kanalından reddedilir");
  return { kanit: ag.kanit, mesaj: sonuc.mesaj };
}

test("KRİTİK: ağ kapısının kanıtı ajana DÖNMEZ — gerçek kapıdan ölçülür", async () => {
  const { kanit, mesaj } = await temizTurdanRet();

  for (const satir of kanit) {
    assert.ok(
      !mesaj.includes(satir),
      `ağ kanıtı ajan kanalına sızdı: ${satir.slice(0, 48)}… — approval.ts onu ` +
        "insanSatirlari'nda tutmalı (maskeli numara, geriye bakış penceresi ve beklenen " +
        "ülke, kapıyı yoklayan birine kapının ölçülerini verir)"
    );
  }

  const yayinSonucu = await yayinaAl(
    { kampanyaId: "9002", musteriId: "1234567890", kampanyaAdi: KAMPANYA_ADI },
    { cagir: async () => mesaj }
  );
  assert.equal(yayinSonucu.durum, "insan-onayi-gerekli");
  assert.deepEqual(
    yayinSonucu.kanitSatirlari,
    [...OZET_SATIRLARI],
    "bu kanaldan gelen tek şey onay özetinin maddeleridir"
  );
});

/**
 * BAŞLIK, BLOĞUN GERÇEKTEN TAŞIDIĞINI SÖYLEMELİ.
 *
 * Eski başlık "_(onay özetine ağ katmanının eklediği satırlar dahil)_" diyordu; yukarıdaki
 * ölçüm bunun yanlış olduğunu gösteriyor. Gözcü BİREBİR eşitlik kurar — dar bir "şu sözcük
 * geçmesin" ayıklaması değil: yalan cümle geri gelirse de, başlık habersiz değişirse de
 * kırmızı olur ve cümlenin doğruluğu yeniden ölçülür.
 */
const BEKLENEN_BASLIK =
  "**Kanıt satırları** _(sunucunun AJANA gönderdiği onay özetinin maddeleri; ağ " +
  "kapısının kanıt satırları bu kanala GELMEZ — onlar yalnız insana gösterilen " +
  "isteme yazılır)_:";

test("KRİTİK: rapor kanıt bloğunun başlığı ağ kanıtı VAAT ETMEZ", async () => {
  const { kanit, mesaj } = await temizTurdanRet();
  const yayinSonucu = await yayinaAl(
    { kampanyaId: "9002", musteriId: "1234567890", kampanyaAdi: KAMPANYA_ADI },
    { cagir: async () => mesaj }
  );
  const rapor = raporOlustur({ hedef: "test", kuruMod: false, yayinSonucu });

  const baslikSatiri = rapor.split("\n").find((s) => s.startsWith("**Kanıt satırları**"));
  assert.ok(baslikSatiri, "kanıt bloğunun başlığı raporda bulunamadı");
  assert.equal(
    baslikSatiri,
    BEKLENEN_BASLIK,
    "rapor başlığı bloğun taşıdığından başkasını söylüyor: blokta onay özetinin maddeleri " +
      "var, ağ kapısının kanıtı YOK (ölçüldü). Depo PUBLIC ve jüri bu raporu okuyor."
  );

  /**
   * Davranış yönü: kanıt satırları raporun HİÇBİR yerinde geçmemeli.
   *
   * Satırın TAMAMI aranmaz — rapor markdown kaçışlar ve müşteri ID'si maskeler, yani birebir
   * arama sızıntı VARKEN de yeşil kalabilirdi (ölçüldü: kanıt ajan kanalına bağlandığında
   * `rapor.includes(satir)` yine false dönüyordu). Aranan şey, o kaçış/maske hijyeninden
   * DEĞİŞMEDEN geçen parçalar; her birinin gerçekten kanıtın içinde olduğu da ayrıca
   * çivileniyor, yoksa "yok" iddiası vakuma düşer.
   */
  const IZLER = ["SIM değişimi yok", "Cihaz erişilebilirliği", "Cihaz değişimi"];
  for (const iz of IZLER) {
    assert.ok(
      kanit.some((s) => s.includes(iz)),
      `"${iz}" artık kanıt satırlarında geçmiyor — bu gözcünün öncülü bayatladı`
    );
    assert.ok(!rapor.includes(iz), `ağ kanıtı rapora sızdı: "${iz}"`);
  }
  // Blok gerçekten onay özetini taşıyor (başlık kadar içerik de çivilenir).
  assert.ok(rapor.includes("Günlük bütçe: 40"));
  assert.ok(rapor.includes("Coğrafi hedef: 1 konum"));
});

/**
 * SAVUNMA DERİNLİĞİ — VARSAYIMSAL, ÇÜNKÜ BUGÜN ÜRETİLEMEZ.
 *
 * Sınıflandırıcı ağ desenlerini yalnız MADDESİZ gövdede arar. Bugün onay özetinin
 * maddelerine model metni girmiyor (set_campaign_status özetinde kampanya ADI değil, sayısal
 * ID var), yani bu senaryo şu an üretilemez — bu yüzden fixture GERÇEKMİŞ gibi sunulmuyor.
 * Yine de madde kanalı ileride model metni taşırsa sınıflandırma çevrilmemeli; kaldırılan
 * uydurma fixture'ın koruduğu tek gerçek değer buydu ve dürüst biçimiyle burada duruyor.
 */
test("madde satırındaki ağ sözcükleri sınıflandırmayı 'ag-retti'ye ÇEVİREMEZ (varsayımsal)", () => {
  const ret = [
    `Reddedildi: "${KAMPANYA_ADI}" kampanyası YAYINA ALINACAK — bu andan itibaren gerçek para harcanır.`,
    "  • Hesap: 1234567890 · Kampanya: AĞ DOĞRULAMASI BAŞARISIZ (AEGIS_NAC_SIMULATE=degisti)",
    "  • Günlük bütçe: 40 (hesabın para biriminde)",
    "Kullanıcıya bu özeti göster ve açık onayını al; onay geldiyse confirm=true ile tekrar çağır.",
  ].join("\n");
  assert.equal(
    yayinSonucuSinifla(ret, KAMPANYA_ADI),
    "insan-onayi-gerekli",
    "madde satırına sokulmuş ağ sözcükleri, insan kapısının reddini ağ reddi diye sunamaz"
  );
});

/* ── 3) Desen anketi: EKSİKSİZ ayrıştırma, kapalı arıza ──────────────────────── */

const DIZI_ANAHTARI = "const AG_KAPISI_IZLERI = [";

/**
 * Bugün dizideki desen sayısı. Bayatlama muhafızı: bir desenin sessizce düşmesi
 * sınıflandırmayı fail-OPEN yönünde zayıflatır (ağ reddi 'reddedildi' görünür), o yüzden
 * azalma DELİBERE olmalı ve bu satırla birlikte gözden geçirilmeli.
 */
const BEKLENEN_DESEN_SAYISI = 19;

const KADEME_DESEN_KAYNAKLARI = ["AĞ SİNYALİ BOZUK", "BU İSTEMCİDE YÜKSELTME YAPILAMAZ"];

/** Bir regex literalinin kapanış '/' konumu; karakter sınıfı ve kaçışlar sayılır. */
function regexSonu(metin, bas) {
  let sinifta = false;
  let kacis = false;
  for (let i = bas + 1; i < metin.length; i++) {
    const c = metin[i];
    if (kacis) {
      kacis = false;
      continue;
    }
    if (c === "\\") {
      kacis = true;
      continue;
    }
    if (sinifta) {
      if (c === "]") sinifta = false;
      continue;
    }
    if (c === "[") {
      sinifta = true;
      continue;
    }
    if (c === "/") return i;
  }
  return -1;
}

/**
 * Bir satırdan YORUMLARI ayırır — JS'in ayırdığı gibi.
 *
 * Kritik nokta: '/' üç şeyin başı olabilir ve ayrımı SONRAKİ karakter yapar. '//' satır
 * yorumu, '/*' blok yorumu, geri kalanı regex literalidir (bir regex '*' ile başlayamaz).
 * Regex literalinin İÇİ olduğu gibi kopyalanır, böylece `/https?:\/\//iu` gibi içinde '//'
 * geçen bir desen yorum sanılmaz. Blok yorumu satır ATLAYABİLİR: durum çağrıya geri döner,
 * yıldızsız blokların iç satırları da yorum sayılır.
 */
function yorumlariAyikla(satir, blokYorumda) {
  let kod = "";
  let i = 0;
  while (i < satir.length) {
    if (blokYorumda) {
      const kapanis = satir.indexOf("*/", i);
      if (kapanis === -1) return { kod, blokYorumda: true };
      blokYorumda = false;
      i = kapanis + 2;
      continue;
    }
    if (satir[i] === "/") {
      const sonraki = satir[i + 1];
      if (sonraki === "/") break;
      if (sonraki === "*") {
        blokYorumda = true;
        i += 2;
        continue;
      }
      const son = regexSonu(satir, i);
      if (son === -1) {
        throw new Error(`AG_KAPISI_IZLERI: kapanmayan regex literali — ${satir.trim()}`);
      }
      kod += satir.slice(i, son + 1);
      i = son + 1;
      continue;
    }
    kod += satir[i];
    i++;
  }
  return { kod, blokYorumda };
}

/**
 * Kod satırını TEK bir regex literaline çözer; çözemezse FIRLATIR.
 *
 * Ayıklama değil, ŞART: "okuyamadığım satırı ankete katmam" sessiz bir delik olurdu — faz4
 * gözcüsünün deliği tam olarak buydu. Okunamayan satır burada kırmızıdır; anket ancak
 * EKSİKSİZ kurulabildiğinde "kaçak yok" diyebilir.
 */
function tekDesenAyikla(kod) {
  const t = kod.trim();
  if (t === "") return null;
  if (!t.startsWith("/")) {
    throw new Error(`AG_KAPISI_IZLERI: desen olarak okunamayan satır — ${t}`);
  }
  const son = regexSonu(t, 0);
  if (son === -1) throw new Error(`AG_KAPISI_IZLERI: kapanmayan regex literali — ${t}`);
  const kaynak = t.slice(1, son);
  let k = son + 1;
  let bayraklar = "";
  while (k < t.length && /[a-z]/.test(t[k])) bayraklar += t[k++];
  const kalan = t.slice(k).trim().replace(/^,/, "").trim();
  if (kalan !== "") {
    throw new Error(`AG_KAPISI_IZLERI: satır tek bir desen taşımıyor — ${t}`);
  }
  return new RegExp(kaynak, bayraklar);
}

/** Diziyi KAYNAKTAN ayrıştırır (içe aktarmaz: sınanan şey sevk edilen dosyanın metnidir). */
function agKapisiDesenleri(kaynak) {
  const bas = kaynak.indexOf(DIZI_ANAHTARI);
  assert.notEqual(bas, -1, "AG_KAPISI_IZLERI bulunamadı — yeniden adlandırıldıysa bu gözcü de güncellenmeli");
  const govdeBas = bas + DIZI_ANAHTARI.length;
  const son = kaynak.indexOf("\n];", govdeBas);
  assert.notEqual(son, -1, "AG_KAPISI_IZLERI dizisi kapanmıyor — kaynak ayrıştırılamadı");

  const desenler = [];
  let blokYorumda = false;
  for (const satir of kaynak.slice(govdeBas, son).split(/\r?\n/)) {
    const cozum = yorumlariAyikla(satir, blokYorumda);
    blokYorumda = cozum.blokYorumda;
    const desen = tekDesenAyikla(cozum.kod);
    if (desen) desenler.push(desen);
  }
  assert.equal(blokYorumda, false, "AG_KAPISI_IZLERI: kapanmayan blok yorumu");
  return desenler;
}

/** Kademe başlıkları DIŞINDA kalan desenlerden bu gövdeyi yakalayanlar. */
function kacaklariBul(kaynak, govde) {
  return agKapisiDesenleri(kaynak).filter(
    (d) => !KADEME_DESEN_KAYNAKLARI.includes(d.source) && d.test(govde)
  );
}

/** Sınıflandırıcının ağ desenlerine verdiği gövde: madde satırları ÇIKARILMIŞ metin. */
function maddesiz(metin) {
  return String(metin)
    .split("\n")
    .filter((s) => !s.trim().startsWith("•"))
    .join("\n");
}

/** GERÇEK kademe reddi — fixture değil, approval.ts + networkTrust.ts koşturularak. */
async function gercekKademeReti() {
  kademeKosullari();
  const sonuc = await onayAl(zayifIstemci(), ozetUret(KADEME_AYARI), true /* ajan rızayı UYDURUYOR */);
  assert.equal(sonuc.onaylandi, false, "yükseltme zayıf kanalda GEÇMEMELİ");
  assert.equal(sonuc.kanal, "ag", "bu ret ağ kapısının reddidir");
  return sonuc.mesaj;
}

test("KRİTİK: desen anketi EKSİKSİZ — satır sonu yorumlu geniş desen ankete GİRER", async () => {
  const kaynak = oku("scripts/brain/uygulama.mjs");
  const govde = maddesiz(await gercekKademeReti());

  const desenler = agKapisiDesenleri(kaynak);
  assert.ok(
    desenler.length >= BEKLENEN_DESEN_SAYISI,
    `ankette ${desenler.length} desen var, beklenen en az ${BEKLENEN_DESEN_SAYISI} — bir ağ ` +
      "deseninin düşmesi ağ reddini 'reddedildi' gösterir (fail-open yönü); azalma bilinçliyse " +
      "BEKLENEN_DESEN_SAYISI da bu gerekçeyle güncellenmeli"
  );
  const yeniler = desenler.filter((d) => KADEME_DESEN_KAYNAKLARI.includes(d.source));
  assert.equal(yeniler.length, 2, "kademe reddinin iki başlığı da dizide olmalı");
  for (const d of yeniler) assert.ok(d.test(govde), `${d} gerçek kademe reddiyle eşleşmiyor`);

  assert.deepEqual(
    kacaklariBul(kaynak, govde).map(String),
    [],
    "kademe reddini eski desenlerden biri de yakalıyor: gözcü artık düzeltmeye BAĞLI değil"
  );

  /**
   * MUTASYON, GÖZCÜNÜN İÇİNDE — faz4 ayrıştırıcısının deliği burada kırmızı.
   * Denetçinin ölçtüğü mutasyonun BİREBİR aynısı: satır sonu yorumu taşıyan geniş desen.
   */
  const mutasyon = kaynak.replace(
    `${DIZI_ANAHTARI}\n`,
    `${DIZI_ANAHTARI}\n  /kademeli doğrulama/iu, // gecici\n`
  );
  assert.notEqual(mutasyon, kaynak, "mutasyon uygulanamadı — çapa değişmiş olabilir");
  assert.deepEqual(
    kacaklariBul(mutasyon, govde).map((d) => d.source),
    ["kademeli doğrulama"],
    "satır sonu yorumu taşıyan desen ankete girmiyor: yokluk iddiası EKSİK küme üzerinden kurulur"
  );
});

test("KAPALI ARIZA: okunamayan desen satırı sessizce düşmez, gözcü FIRLATIR", () => {
  const kaynak = oku("scripts/brain/uygulama.mjs");
  assert.doesNotThrow(() => agKapisiDesenleri(kaynak));

  const bozuk = (satir) => kaynak.replace(`${DIZI_ANAHTARI}\n`, `${DIZI_ANAHTARI}\n${satir}\n`);
  // Regex literali olmayan bir giriş (RegExp kurucusu) ankete sessizce girmemeli.
  assert.throws(
    () => agKapisiDesenleri(bozuk('  new RegExp("kademeli dogrulama", "iu"),')),
    /desen olarak okunamayan satır/u
  );
  // Tek satıra sıkıştırılmış iki desen de anketi bozar.
  assert.throws(
    () => agKapisiDesenleri(bozuk("  /a/u, /kademeli doğrulama/iu,")),
    /tek bir desen taşımıyor/u
  );
  // Yıldızsız blok yorumunun İÇİ yorumdur — desen sayılmamalı (faz4'ün de göremediği biçim).
  const blokla = bozuk("  /*\n  /kademeli doğrulama/iu,\n  */");
  assert.doesNotThrow(() => agKapisiDesenleri(blokla));
  assert.equal(
    agKapisiDesenleri(blokla).length,
    agKapisiDesenleri(kaynak).length,
    "blok yorumu içindeki satır desen sayılmamalı"
  );
  // Satır sonu yorumu ise DESENİ GİZLEMEZ: aynı satır ankete girer.
  assert.equal(
    agKapisiDesenleri(bozuk("  /kademeli doğrulama/iu, // gecici")).length,
    agKapisiDesenleri(kaynak).length + 1
  );
  // İçinde '//' geçen meşru bir desen yorum sanılmamalı.
  assert.equal(
    agKapisiDesenleri(bozuk("  /https?:\\/\\/ornek/iu,")).length,
    agKapisiDesenleri(kaynak).length + 1
  );
});
