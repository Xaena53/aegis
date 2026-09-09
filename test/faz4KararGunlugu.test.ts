// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 4 — src/kararGunlugu.ts gerileme gözcüleri.
 *
 * Üç bulgu kapatıldı; bu dosya her birini KIRMIZI OLABİLEN bir gözcüye bağlar.
 *
 *  (1) DOSYA İZNİ. kararYaz() `appendFileSync`i mode'suz çağırıyordu: dosya 0o666 & ~umask
 *      ile açılıyor, dağıtım biriminde UMask= satırı olmadığı için varsayılan 0022 geçerli
 *      oluyor ve /var/log/aegis/kararlar.jsonl 0644 doğuyordu — LogsDirectory'nin kendi
 *      varsayılanı 0755 olduğundan makinedeki HER yerel hesap tüm denetim izini okuyabiliyordu.
 *      ÖLÇÜLDÜ (Linux kabında, umask 0022, gerçek kararYaz): düzeltmeyle 600, düzeltme geri
 *      alınınca 644. Bu, "sır yazılmıyor" ile "dosya herkese açık değil" arasındaki farktır:
 *      izde maskeli numara, Google Ads müşteri ID'si, Meta reklam hesabı ID'si, günlük
 *      tutarlar ve hangi dakikada hangi sinyalden reddedildiği duruyor.
 *
 *  (2) YARIM KALMIŞ ÇEVİRİ. Türkçe→İngilizce çeviri turu tavan bloğunun cümlesini ortadan
 *      kesmişti: "…nobody" / " * etmez, denetim izi sessizce durur." Modülün EN KÖTÜ ARIZA
 *      BİÇİMİNİ anlatan tek paragraf hiçbir dilde okunmuyordu.
 *
 *  (3) ÖKSÜZ JSDoc. kararYaz'ın davranış sözleşmesi ("AEGIS_DECISION_LOG yoksa günlük
 *      KAPALI") fonksiyondan kopmuş, GUNLUK_AZAMI_BAYT bloğunun üstünde asılı kalmıştı;
 *      IDE hover'ında modülün tek dışa açık yazıcısının sözleşmesi görünmüyordu.
 *
 * HER GÖZCÜ ÇİFT YÖNLÜ. Bu fazın kuralı: hiçbir koşulda kırmızı olamayan gözcü sahte güvence
 * üretir. Bu yüzden her belge iddiası, doğru olmasını sağlayan DAVRANIŞLA eşleştirildi:
 *   - "yazma hatası akışı düşürmez, kimse fark etmez" cümlesi → hatayı gerçekten ölçen test
 *     (fırlatmıyor + stderr'e TEK satır). Günlük bir kapıya dönüşürse cümle yanlış olur ve
 *     test kızarır.
 *   - "AEGIS_DECISION_LOG yoksa KAPALI" cümlesi → env yokken dosya oluşmadığını ölçen test.
 *   - Yorum tarayıcısı KENDİNİ SINAR: tarihsel kırık satırı yakalamak ZORUNDA, dosyanın
 *     gerçek İngilizce satırlarını rahat bırakmak ZORUNDA. Kör bir tarayıcı "temiz" değildir.
 *
 * Hiçbir test ağ kapısına dokunmaz, gevşetmez, ağa çıkmaz, .env okumaz.
 */
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agKararKaydiOlustur, kararYaz } from "../src/kararGunlugu.js";

const KAYNAK_YOLU = fileURLToPath(new URL("../src/kararGunlugu.ts", import.meta.url));
/** CRLF'e normalleştirilir: gözcünün kırmızı olma sebebi dosyanın İÇERİĞİ olmalı, hangi
 * işletim sisteminde kaydedildiği değil. */
const KAYNAK = readFileSync(KAYNAK_YOLU, "utf8").split("\r\n").join("\n");
const SATIRLAR = KAYNAK.split("\n");

const MUSTERI = "1234567890";

let kok: string;
let gunluk: string;

beforeEach(() => {
  kok = mkdtempSync(path.join(tmpdir(), "aegis-faz4-karar-"));
  gunluk = path.join(kok, "kararlar.jsonl");
  delete process.env.AEGIS_DECISION_LOG;
});

afterEach(() => {
  delete process.env.AEGIS_DECISION_LOG;
  rmSync(kok, { recursive: true, force: true });
});

function ornekKayit() {
  return agKararKaydiOlustur(
    "kampanya yayına alınacak",
    "high",
    { kanit: [], iz: { simSwap: "kapali" } },
    MUSTERI
  );
}

/* ── (1) DOSYA İZNİ ───────────────────────────────────────────────────────────── */

/**
 * GERÇEK ÖLÇÜM, POSIX'te. Windows'ta atlanır çünkü Node orada POSIX izin bitlerini
 * modellemez: aynı çağrı mode'lu da mode'suz da 0666 raporlar, yani burada "yeşil" hiçbir
 * şey ölçmez — ve ölçmeyen bir yeşil, bu fazın yasakladığı vakum gözcüsünün ta kendisidir.
 * Windows'ta koşan karşılığı bir alttaki KAYNAK ÇİVİSİ testidir; CI Linux'ta ikisi de koşar.
 *
 * ÖLÇÜM (docker node:22-alpine, umask 0022, derlenmiş gerçek modül):
 *   mode: 0o600 ile   → 600
 *   mode kaldırılınca → 644   ← bulgunun kendisi
 */
test(
  "KRİTİK: denetim izi dosyası SAHİBİNE ÖZEL (0600) oluşturulur — dünyaya okunur doğmaz",
  {
    skip:
      process.platform === "win32"
        ? "POSIX izin bitleri Windows'ta modellenmiyor (mode'lu ve mode'suz çağrı aynı 0666'yı " +
          "raporlar); bu iddia CI'ın Linux koşusunda ölçülür, kaynak çivisi testi her yerde koşar"
        : false,
  },
  () => {
    const eskiUmask = process.umask(0o022); // dağıtım biriminde geçerli olan varsayılan
    try {
      process.env.AEGIS_DECISION_LOG = gunluk;
      kararYaz(ornekKayit());

      assert.ok(existsSync(gunluk), "günlük yazılmalıydı");
      const mod = statSync(gunluk).mode & 0o777;
      assert.equal(
        mod.toString(8),
        "600",
        `Denetim izi ${mod.toString(8)} ile oluştu. umask 0022 altında mode verilmeyen bir ` +
          `appendFileSync 0644 üretir; LogsDirectory'nin varsayılanı 0755 olduğu için bu, ` +
          `makinedeki her yerel hesabın maskeli onaylayıcı numarasını, hesap ID'lerini, ` +
          `günlük tutarları ve ret dakikalarını okuyabilmesi demektir.`
      );
      assert.equal(mod & 0o077, 0, "grup ve diğerleri için TEK bir izin biti bile kalmamalı");
    } finally {
      process.umask(eskiUmask);
    }
  }
);

/** Bir çağrının parantezleri arasındaki metin. Tavan bilinçli: maskeleme bozulursa pencere
 * sınırlı kalır ve en kötü ihtimalle GÜRÜLTÜLÜ bir yanlış bulgu üretir, sessiz bir kaçırma
 * değil. */
function cagriBolgesi(kod: string, acik: number): string {
  let derinlik = 0;
  const son = Math.min(kod.length, acik + 2000);
  for (let i = acik; i < son; i++) {
    if (kod[i] === "(") derinlik++;
    else if (kod[i] === ")") {
      derinlik--;
      if (derinlik === 0) return kod.slice(acik + 1, i);
    }
  }
  return kod.slice(acik + 1, son);
}

/**
 * KAYNAK ÇİVİSİ — Windows dahil her platformda kırmızı olur.
 *
 * İki yönlü: (a) mode düşerse ya da gevşerse kırmızı; (b) yazma başka bir fs çağrısına
 * taşınırsa kırmızı — çünkü modülün node:fs yüzeyi de çivili. İkincisi olmadan gözcü
 * delinebilir: `writeFileSync(..., { flag: "a" })` aynı işi mode'suz yapar ve yalnız
 * appendFileSync'e bakan bir kural bunu HİÇ görmez.
 */
test("kararYaz'ın dosya yazma çağrısı mode: 0o600 TAŞIR (kaynak çivisi, her platformda)", () => {
  const desen = /appendFileSync\s*\(/g;
  let m: RegExpExecArray | null;
  let sayac = 0;
  const suclular: string[] = [];
  while ((m = desen.exec(KAYNAK))) {
    // import listesindeki ad değil, gerçek çağrı: "(" ile biten eşleşme zaten çağrıdır.
    sayac++;
    const bolge = cagriBolgesi(KAYNAK, m.index + m[0].length - 1);
    const satir = KAYNAK.slice(0, m.index).split("\n").length;
    if (!/mode\s*:\s*0o600/.test(bolge)) {
      suclular.push(`src/kararGunlugu.ts:${satir} → ${bolge.replace(/\s+/g, " ").trim()}`);
    }
  }

  assert.ok(
    sayac >= 1,
    `src/kararGunlugu.ts içinde appendFileSync çağrısı bulunamadı (${sayac}) — yazma başka ` +
      `bir çağrıya taşınmış olabilir; sıfır "temiz" değil, KÖR demektir.`
  );
  assert.deepEqual(
    suclular,
    [],
    `mode'suz yazma çağrısı: ${suclular.join(" | ")}.\n` +
      `Mode verilmeyen bir oluşturma umask 0022 altında 0644 üretir ve denetim izini ` +
      `makinedeki her yerel hesaba açar. { encoding: "utf8", mode: 0o600 } kullan.`
  );

  const ithal = /import\s*\{([^}]*)\}\s*from\s*"node:fs"/.exec(KAYNAK);
  assert.ok(ithal, "src/kararGunlugu.ts artık node:fs'ten adlandırılmış içe aktarma yapmıyor");
  const adlar = ithal[1]
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(
    adlar,
    ["appendFileSync", "renameSync", "statSync"],
    `Modülün node:fs yüzeyi değişmiş: ${adlar.join(", ")}. Yeni bir dosya YAZAN çağrı ` +
      `eklendiyse onun da oluşturma modu 0600 olmalı ve bu liste ile yukarıdaki mode ` +
      `kuralı birlikte güncellenmeli — yoksa izin kuralı sessizce atlanabilir hale gelir.`
  );
});

/* ── (2) TAVAN PARAGRAFININ İDDİASI: CÜMLE TAM VE DOĞRU ───────────────────────── */

/** Bir tanımın (const/function/export) HEMEN üstündeki JSDoc bloğunun metni; blok yoksa "". */
function ustundekiBlok(tanimDeseni: RegExp): string {
  const idx = SATIRLAR.findIndex((s) => tanimDeseni.test(s));
  if (idx < 0) return "";
  let i = idx - 1;
  if (SATIRLAR[i]?.trim() !== "*/") return "";
  while (i >= 0 && !SATIRLAR[i].trim().startsWith("/**")) i--;
  if (i < 0) return "";
  return SATIRLAR.slice(i, idx).join("\n");
}

/**
 * ÇİFT YÖNLÜ. (a) Belge yönü: tavan bloğu "yazma hatası akışı düşürmez, kimse fark etmez"
 * cümlesini TAM bir cümle olarak taşımalı — bulgunun kendisi bu cümlenin ortasından
 * kesilmiş olmasıydı. (b) Kod yönü: cümlenin DOĞRU olduğu ölçülür. Günlük bir gün kapıya
 * dönüşürse (hata fırlatılırsa) ya da hata sessizce yutulursa cümle yanlış olur ve test
 * kızarır — belge gözcüsünü davranışa çivileyen halka budur.
 */
test("tavan paragrafının iddiası hem TAM cümle hem DOĞRU: hata akışı düşürmez, sessizce durur", () => {
  const blok = ustundekiBlok(/^const GUNLUK_AZAMI_BAYT\b/);
  assert.ok(blok, "GUNLUK_AZAMI_BAYT'ın hemen üstünde bir JSDoc bloğu yok");

  const duzMetin = blok
    .split("\n")
    .map((s) => s.replace(/^\s*\/?\*+\/?/, "").trim())
    .join(" ")
    .replace(/\s+/g, " ");
  assert.match(
    duzMetin,
    /a write error does not bring the flow down, nobody notices[^.]*\./,
    `Tavan paragrafındaki "en kötü arıza biçimi" cümlesi eksik ya da yarım. Bu cümle ` +
      `çeviri turunda tam ortasından kesilmişti ("…nobody" / " * etmez, denetim izi ` +
      `sessizce durur.") ve modülün tavanının GEREKÇESİ okunamaz hale gelmişti.`
  );
  assert.match(
    duzMetin,
    /rolled over to `<path>\.1`/,
    "Tavan paragrafı devir kuşağını (`<path>.1`) artık adlandırmıyor — kod onu üretmeye devam ediyor"
  );

  // (b) KOD YÖNÜ — cümlenin doğruluğu ölçülür.
  process.env.AEGIS_DECISION_LOG = path.join(kok, "olmayan-dizin", "alt", "kararlar.jsonl");
  const uyarilar: string[] = [];
  const eskiError = console.error;
  console.error = (...a: unknown[]) => void uyarilar.push(a.map(String).join(" "));
  try {
    assert.doesNotThrow(
      () => kararYaz(ornekKayit()),
      "günlük GÖZLEMDİR, KAPI DEĞİL: yazma hatası akışı düşürmemeli"
    );
  } finally {
    console.error = eskiError;
  }
  assert.equal(
    uyarilar.filter((u) => u.includes("karar günlüğü yazılamadı")).length,
    1,
    "hata sessizce yutulmamalı: operatör için stderr'e TEK satır düşmeli"
  );
  assert.equal(readdirSync(kok).length, 0, "hata durumunda hiçbir dosya arkada kalmamalı");
});

/* ── (3) ÖKSÜZ JSDoc ──────────────────────────────────────────────────────────── */

/**
 * ÇİFT YÖNLÜ. (a) Belge yönü: sözleşme bloğu kararYaz'ın HEMEN üstünde durmalı ve "env
 * yoksa KAPALI" cümlesini taşımalı. (b) Kod yönü: o cümlenin doğruluğu ölçülür — günlük bir
 * gün varsayılan AÇIK olursa blok yalan söyler ve test kızarır.
 */
test("kararYaz'ın sözleşme bloğu fonksiyonun HEMEN üstünde ve söylediği şey DOĞRU", () => {
  const blok = ustundekiBlok(/^export function kararYaz\b/);
  assert.ok(
    blok,
    "kararYaz'ın hemen üstünde JSDoc bloğu yok — sözleşme fonksiyondan koptu, IDE hover'ında " +
      "modülün tek dışa açık yazıcısının davranışı görünmez (bulgunun tam hâli)"
  );
  assert.match(
    blok,
    /AEGIS_DECISION_LOG unset the LOG IS OFF/,
    "kararYaz'ın üstündeki blok artık 'env yoksa günlük KAPALI' sözleşmesini taşımıyor"
  );

  // (b) KOD YÖNÜ. Çalışma dizini geçici köke alınır: env yokken bir VARSAYILAN YOLA
  // düşen bir uygulama (`?? "kararlar.jsonl"`) aksi hâlde dosyayı deponun köküne yazar ve
  // yalnız geçici köke bakan bir iddia bunu göremez — ölçüldü, gözcü o hâlde delinmişti.
  const eskiCwd = process.cwd();
  try {
    process.chdir(kok);
    delete process.env.AEGIS_DECISION_LOG;
    kararYaz(ornekKayit());
  } finally {
    process.chdir(eskiCwd);
  }
  assert.deepEqual(
    readdirSync(kok),
    [],
    "AEGIS_DECISION_LOG yokken günlük KAPALI olmalı: hiçbir yolda dosya oluşmamalı"
  );
});

/**
 * Öksüz blok, GENEL kural olarak. Bulgu tekil bir kaymaydı ama kalıbı makineyle yakalanabilir:
 * bir JSDoc bloğunun KAPANIŞ satırının hemen ardından yeni bir açılış satırı gelirse, ilk
 * blok hiçbir tanıma bağlı DEĞİLDİR — TypeScript bunu hata saymaz, IDE sessizce ikinci
 * bloğu gösterir.
 */
test("hiçbir JSDoc bloğu ÖKSÜZ değil (bir bloğun ardından doğrudan başka bir blok gelmez)", () => {
  const oksuzler: number[] = [];
  let blokSayisi = 0;
  for (let i = 0; i < SATIRLAR.length; i++) {
    if (SATIRLAR[i].trim().startsWith("/**")) blokSayisi++;
    if (SATIRLAR[i].trim() === "*/" && SATIRLAR[i + 1]?.trim().startsWith("/**")) {
      oksuzler.push(i + 1);
    }
  }
  assert.ok(
    blokSayisi >= 10,
    `src/kararGunlugu.ts içinde JSDoc bloğu neredeyse yok (${blokSayisi}) — tarayıcı ` +
      `bayatlamış olabilir; sıfıra yakın bir sayı "temiz" değil, KÖR demektir.`
  );
  assert.deepEqual(
    oksuzler,
    [],
    `Öksüz JSDoc bloğu (kapanış satırları): ${oksuzler.join(", ")}. Bir bloğun ardından ` +
      `doğrudan ikinci bir blok geliyorsa ilki hiçbir tanıma bağlı değildir ve hover'da ` +
      `görünmez. Bloğu ait olduğu tanımın HEMEN üstüne taşı.`
  );
});

/* ── (2b) YARIM ÇEVİRİ TARAYICISI ─────────────────────────────────────────────── */

/**
 * NEDEN KELİME LİSTESİ, "TÜRKÇE HARF" DEĞİL.
 *
 * ÖLÇÜLDÜ: bulgunun kendisi olan satır — " * etmez, denetim izi sessizce durur." — TEK BİR
 * Türkçe'ye özgü harf içermiyor; hepsi ASCII. Yalnız `[çğıöşü]` arayan bir gözcü bu fazın
 * asıl kalıntısını HİÇ görmezdi ve "temiz" raporlardı. Bu yüzden iki kural birlikte koşar:
 * Türkçe'ye özgü harf VE İngilizce'de bulunmayan Türkçe kelime/ek kalıbı.
 *
 * KAPSAM YALNIZ YORUMLAR. Ürün metinleri (console.error içindeki Türkçe uyarılar) TÜRKÇE
 * KALIR ve dize gövdelerinde dururlar. Muafiyet ARTIK BİR SINIF DEĞİL: "tırnak gören satırı
 * at" kuralı ölçülerek delik çıktı (bu tarayıcının KENDİ 'yakalanmalı' örneği, tırnaklı bir
 * kod satırının kuyruğuna konduğunda görünmez kalıyordu). Yerine dize/şablon/regex GÖVDELERİ
 * tek tek maskeleniyor ve geriye kalan taranıyor; blok yorumları da satır-üstü bir durum
 * makinesiyle izleniyor, böylece yıldızsız `/* ... *\/` bloğunun iç satırları da yorumdur.
 * Bu ayrımın darlığı aşağıdaki kendi kendini sınama testinde ÖLÇÜLEN kör noktalarla
 * çivilenir. Yedek halka: test/faz5KararGunlugu.test.ts hiç yorum ayıklamadan, dosyanın HER
 * satırı üzerinden aynı iddiayı kurar.
 */
const TURKCE_HARF = /[çğıöşüÇĞİÖŞÜâîû]/;
/** İngilizce'de karşılığı olmayan, bu programın çeviri kalıntılarında GEÇEN kelimeler. */
const TURKCE_KELIMELER = new Set([
  "etmez",
  "denetim",
  "izi",
  "sessizce",
  "durur",
  "dokunulmaz",
  "edilmez",
  "kalamaz",
  "halkada",
  "yoktur",
  "atlanabilir",
  "vekil",
  "ters",
  "reddedilmelidir",
  "bkz",
  "girmez",
  "asla",
  "istemine",
  "sorulmaz",
  "okunur",
  "modele",
  "aynen",
  "listesi",
  "kurulum",
]);
/** Türkçe olumsuzluk eki (-maz/-mez): gelecekteki yarım çevirilerin en olası kuyruğu. */
const OLUMSUZ_EK = /^[a-zçğıöşü]{4,}m[ae]z$/;

/** Whether a `/` at index `i` can legally OPEN a regex literal instead of being a division:
 * only right after an operator, an opening bracket, or at the start of the line. */
function regexBaslayabilir(satir: string, i: number): boolean {
  const onceki = satir.slice(0, i).replace(/\s+$/, "");
  return onceki === "" || /[(,=:[!&|?{};+\-*%~^<>]$/.test(onceki);
}

/**
 * Index just past the literal that OPENS at `i` — a string, a template or a regex. An
 * unterminated literal consumes the rest of the line: that is the safe direction, because the
 * scan then reports nothing for the line instead of reading string content as a comment.
 */
function literalAtla(satir: string, i: number): number {
  const kapanis = satir[i];
  let j = i + 1;
  while (j < satir.length) {
    const c = satir[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (kapanis === "/" && c === "[") {
      // A regex character class may hold an unescaped '/'.
      while (j < satir.length && satir[j] !== "]") j += satir[j] === "\\" ? 2 : 1;
      j++;
      continue;
    }
    if (c === kapanis) return j + 1;
    j++;
  }
  return satir.length;
}

/**
 * The COMMENT half of one line ("" when the line is pure code). `durum` carries the
 * block-comment state ACROSS lines.
 *
 * THE EXEMPTION REMOVES THE LEGITIMATE EXPRESSION, NEVER A CLASS OF LINES. The first version
 * of this function dropped the WHOLE line as soon as a quote appeared before `//`, and it
 * counted a block comment's inner lines as comment only when they began with `*`. Both were
 * MEASURED holes: this scanner's own "must be caught" sample went invisible at the tail of a
 * quoted code line, and a starless `/* ... *\/` block hid the historical residue verbatim.
 * So string, template and regex BODIES are masked one literal at a time and whatever is left
 * is read — a code line is no longer a reason to stop looking.
 *
 * A line that only LOOKS like the middle of a block (starts with `*`) is still treated as
 * comment even when no `/*` opened on this line: the self-test below feeds single fragments,
 * and erring toward "this is a comment" can only make a finding louder, never silence one.
 */
function yorumKismi(satir: string, durum: { blokIcinde: boolean }): string {
  const t = satir.trim();
  if (!durum.blokIcinde && t.startsWith("*")) {
    if (t.includes("*/")) durum.blokIcinde = false;
    return t;
  }
  const parcalar: string[] = [];
  let i = 0;
  while (i < satir.length) {
    if (durum.blokIcinde) {
      const kapanis = satir.indexOf("*/", i);
      if (kapanis < 0) {
        parcalar.push(satir.slice(i));
        break;
      }
      parcalar.push(satir.slice(i, kapanis));
      durum.blokIcinde = false;
      i = kapanis + 2;
      continue;
    }
    const c = satir[i];
    if (c === "/" && satir[i + 1] === "/") {
      parcalar.push(satir.slice(i));
      break;
    }
    if (c === "/" && satir[i + 1] === "*") {
      durum.blokIcinde = true;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`" || (c === "/" && regexBaslayabilir(satir, i))) {
      i = literalAtla(satir, i);
      continue;
    }
    i++;
  }
  return parcalar.join(" ").trim();
}

type Kalinti = { satir: number; parca: string };

function cevirKalintisiTara(kaynak: string): Kalinti[] {
  const bulgular: Kalinti[] = [];
  // The block state belongs to the SCAN, not to a line: the inner lines of a starless block
  // are comment as well, and a line-local decision could never see that.
  const durum = { blokIcinde: false };
  kaynak.split("\n").forEach((ham, i) => {
    const yorum = yorumKismi(ham, durum);
    if (!yorum) return;
    if (TURKCE_HARF.test(yorum)) {
      bulgular.push({ satir: i + 1, parca: yorum.trim() });
      return;
    }
    for (const kelime of yorum.toLowerCase().match(/[\p{L}]+/gu) ?? []) {
      if (TURKCE_KELIMELER.has(kelime) || OLUMSUZ_EK.test(kelime)) {
        bulgular.push({ satir: i + 1, parca: yorum.trim() });
        return;
      }
    }
  });
  return bulgular;
}

/**
 * TARAYICI KENDİNİ SINAR. Kör bir tarayıcı "temiz" değildir; bu test onun tarihsel kırık
 * satırı yakaladığını ve dosyanın gerçek İngilizce yorumlarını rahat bıraktığını ölçer.
 * Muafiyetin (kod satırı) darlığı da burada çivilenir: aynı Türkçe metin YORUMDA bulgu,
 * ürün dizesinde değil.
 */
const KOTU_ORNEKLER: Array<[string, string]> = [
  ["bulgunun tam hâli (Türkçe harf İÇERMEZ)", " * etmez, denetim izi sessizce durur."],
  ["networkTrust kalıntısı", " * dokunulmaz (import bile edilmez)."],
  ["http.ts kalıntısı", " * ters vekil atlanabilir hâle gelir."],
  ["config.ts kalıntısı", "   * reddedilmelidir (bkz. networkTrust.ts, fail-closed)."],
  ["dagitim.mjs kalıntısı", " *    OKUNUR, modele sorulmaz."],
  ["bilinmeyen ama -mez ekli kuyruk", " * bu satır hiçbir yerde görünmez"],
  ["tek satırlık yorumda kalıntı", "  // pencere yoksa halkada YOKTUR."],
  ["satır sonu yorumunda kalıntı", "  const x = 1; // sessizce durur"],
  // The four below were MEASURED as holes in the first version of yorumKismi: each one was
  // injected into src/kararGunlugu.ts on disk and the suite stayed 6/6 green.
  [
    "ÖLÇÜLEN KÖR NOKTA: tırnak ve regex taşıyan kod satırının kuyruğu",
    '  const tek = metin.replace(/\\s+/g, " ").trim(); // pencere yoksa halkada YOKTUR.',
  ],
  [
    "ÖLÇÜLEN KÖR NOKTA: import satırının kuyruğu",
    '  import { x } from "node:fs"; // ÇOK ÖNEMLİ: bu satır sessizce değiştirilemez.',
  ],
  [
    "ÖLÇÜLEN KÖR NOKTA: şablon dizesi taşıyan satırın kuyruğu",
    "  console.error(`[aegis] ${e} — bitti`); // bu satır asla değiştirilmez",
  ],
  [
    "ÖLÇÜLEN KÖR NOKTA: yıldızsız blok yorumunun İÇ satırı",
    "/*\n  etmez, denetim izi sessizce durur.\n*/",
  ],
  ["tek satırlık blok yorum", "/* pencere yoksa halkada YOKTUR. */"],
];

const TEMIZ_ORNEKLER: Array<[string, string]> = [
  ["düzeltilmiş cümle", " * down, nobody notices — the audit trail simply stops, silently."],
  ["ürün dizesi KOD satırındadır, yorum değil", '  console.error("[aegis] karar günlüğü yazılamadı");'],
  ["Türkçe dize içeren kod satırı", '  const m = "denetim izi sessizce durur";'],
  ["dize içindeki // yorum değildir", '  const u = "https://ornek.example/a";'],
  ["sözlük değerleri İngilizce yorumda geçebilir", ' * ("gecti/simulasyon", "gercek", "kapali")'],
  ["alan adları kalıntı sayılmaz", " * simSwapKanali / devSwapPencereSaat / retNedeniKisa"],
  // Masking must be exact in BOTH directions: the Turkish belongs to the string body, and the
  // English tail after it is a real comment that carries no residue.
  ["Türkçe dize + İngilizce yorum kuyruğu", '  const m = "denetim izi sessizce durur"; // english tail'],
  ["regex gövdesindeki eğik çizgi yorum açmaz", "  const p = /a\\/\\/b/;"],
];

test("çeviri kalıntısı tarayıcısı: kırık satırı YAKALAR, İngilizce yorumu rahat bırakır", () => {
  for (const [ad, ornek] of KOTU_ORNEKLER) {
    assert.ok(
      cevirKalintisiTara(ornek).length > 0,
      `yakalanmalıydı ama sessiz kaldı: ${ad} → ${ornek}`
    );
  }
  for (const [ad, ornek] of TEMIZ_ORNEKLER) {
    assert.deepEqual(
      cevirKalintisiTara(ornek),
      [],
      `yanlış alarm: ${ad} → ${ornek}`
    );
  }
});

test("src/kararGunlugu.ts yorumlarında yarım kalmış çeviri kalıntısı YOK", () => {
  const bulgular = cevirKalintisiTara(KAYNAK);
  assert.deepEqual(
    bulgular.map((b) => `src/kararGunlugu.ts:${b.satir} ${b.parca.slice(0, 120)}`),
    [],
    `Yorumda Türkçe kalıntı. Çeviri turunda bu dosyanın tavan paragrafı cümlenin tam ` +
      `ortasından kesilmişti ve modülün EN KÖTÜ ARIZA BİÇİMİNİ anlatan tek paragraf hiçbir ` +
      `dilde okunamıyordu. Depo PUBLIC: cümleyi İngilizce TAMAMLA, yarım bırakma. ` +
      `(Ürün metinleri Türkçe kalır — onlar kod satırındadır, yorumda değil.)`
  );
});
