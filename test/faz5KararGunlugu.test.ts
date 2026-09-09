// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 5 — src/kararGunlugu.ts: the translation-residue watchdog, rebuilt so it CAN go red.
 *
 * WHAT WAS WRONG. test/faz4KararGunlugu.test.ts claims, in its own test title, that there is
 * no half-finished Turkish translation left in src/kararGunlugu.ts. It reached that verdict
 * through an EXTRACTOR that first threw whole lines away: a line whose code half contained a
 * quote was dropped entirely (so any trailing `//` on it was invisible), and the inner lines
 * of a `/* ... *\/` block that do not start with `*` were never comment at all. Both holes
 * were MEASURED, not argued: four separate residue lines were injected into the source and
 * the six watchdogs stayed 6/6 green, including the scanner's OWN "must be caught" sample
 * moved to the tail of a quoted code line.
 *
 * That is the exact shape this phase exists to close — "filter, then claim absence" — where
 * the filter removes a CLASS (every line that has a quote in it) instead of one legitimate
 * expression. faz4's extractor is repaired in place; this file adds the backstop.
 *
 * WHY THIS FILE DOES NOT EXTRACT COMMENTS AT ALL. A second comment extractor would inherit
 * the first one's blind spots — an oracle that is a copy of the thing it audits can only be
 * blind in the same places. So the claim here is made over the WHOLE FILE, every line, with
 * no notion of "comment" and therefore no extraction step to be wrong about:
 *
 *   Every line of src/kararGunlugu.ts that carries a Turkish signal must be BYTE-IDENTICAL
 *   (after trimming) to a declared entry in MESRU_TURKCE_SATIRLAR.
 *
 * The exemption is a list of VERBATIM LINES, never a class of lines. Append anything to a
 * declared product string — a comment, a second statement — and the line stops matching, so
 * the exemption cannot be used as a hiding place. Measured below, as mutation M4.
 *
 * FAIL-CLOSED. Undeclared Turkish is a finding whether it sits in a comment, in a string, in
 * an identifier or in a block form nobody modelled. A legitimate new Turkish product text is
 * cheap to declare — one line added to the list, in review. An unknown signal going to
 * refusal is the same rule the gate itself runs on.
 *
 * WHY BOTH LETTERS AND WORDS. Measured: the historical residue of this very file — " * etmez,
 * denetim izi sessizce durur." — carries NO Turkish-specific letter; it is pure ASCII. A
 * `[çğıöşü]` scan alone would have reported the file clean while the residue sat in it.
 *
 * No test here touches the network gate, loosens it, goes to the network, or reads .env.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KAYNAK_YOLU = fileURLToPath(new URL("../src/kararGunlugu.ts", import.meta.url));
const FAZ4_YOLU = fileURLToPath(new URL("./faz4KararGunlugu.test.ts", import.meta.url));

/** Normalised to LF: a watchdog must go red over CONTENT, not over the checkout's line
 * endings. */
const oku = (yol: string): string => readFileSync(yol, "utf8").split("\r\n").join("\n");
const KAYNAK = oku(KAYNAK_YOLU);

/* ── THE SIGNAL ───────────────────────────────────────────────────────────────── */

/** Letters that exist in Turkish and not in this repo's English prose. */
const TURKCE_HARF = /[çğıöşüÇĞİÖŞÜâîû]/;

/**
 * Turkish words with no English homograph.
 *
 * Deliberately PROSE words only. This codebase names its identifiers in Turkish
 * (`satir`, `hedef`, `kayit`, `tutar`), so a word that can appear as an identifier would make
 * the whole-file scan fire on ordinary code and the watchdog would be turned off within a
 * week. Measured against the real file: the list below produces exactly four hits, and all
 * four are the declared product strings.
 *
 * The list is checked for staleness against faz4's list in a test below — a superset is
 * required, because a later list that quietly LOST words is how the sibling watchdog in
 * networkTrust.ts came to miss the very residue it was written for.
 */
const TURKCE_KELIMELER = new Set<string>([
  // faz4's set, in full (the staleness test below enforces this)
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
  // Function words and connectives: what a half-finished sentence is most likely to carry.
  // "once" and "her" are deliberately ABSENT — both are English words, and a word list that
  // fires on English prose gets deleted rather than fixed.
  "ve",
  "bir",
  "ile",
  "bile",
  "yazar",
  "yoksa",
  "degil",
  "icin",
  "olan",
  "gibi",
  "kadar",
  "sonra",
  "hala",
  "artik",
  "yalniz",
  "ancak",
  "ayrica",
  "hic",
  "cunku",
  "ayni",
  "kendi",
  "buna",
  "bunu",
  "sadece",
  "hem",
  "ama",
  "fakat",
  "veya",
  "yani",
  "kalir",
  "eklenir",
  "yine",
  "tavan",
  "akis",
  "gore",
  "uzere",
  "boyle",
  "burada",
  "orada",
  "simdi",
]);

/** The Turkish negative suffix (-maz/-mez): the most likely tail of a future half-translation. */
const OLUMSUZ_EK = /^[a-zçğıöşü]{4,}m[ae]z$/;

/** Why the line is suspected, or "" when it carries no Turkish signal at all. */
function turkceIz(satir: string): string {
  if (TURKCE_HARF.test(satir)) return "Türkçe'ye özgü harf";
  for (const kelime of satir.toLowerCase().match(/[\p{L}]+/gu) ?? []) {
    if (TURKCE_KELIMELER.has(kelime)) return `Türkçe kelime: ${kelime}`;
    if (OLUMSUZ_EK.test(kelime)) return `Türkçe olumsuzluk eki: ${kelime}`;
  }
  return "";
}

/* ── THE EXEMPTION: VERBATIM LINES, NOT A CLASS ──────────────────────────────── */

/**
 * The Turkish that BELONGS in this file: operator-facing product text. Every entry is one
 * whole source line, trimmed, quoted exactly as it is written in src/kararGunlugu.ts.
 *
 * Product text stays Turkish — that is the repo's rule. What is not allowed is a line that
 * merely RESEMBLES product text. Hence the exemption is exact-match on the entire trimmed
 * line: nothing can be appended to a declared line and ride along with it.
 */
const MESRU_TURKCE_SATIRLAR: readonly string[] = [
  '"[aegis] karar günlüğü: maskesiz görünen numara alanı kayda YAZILMADI (sır sızıntısı önlendi)"',
  '"[aegis] karar günlüğü: geçersiz riskteki tutar kayda YAZILMADI (uydurma büyüklük önlendi)"',
  '`[aegis] karar günlüğü devredilemedi (${hedef}): ${e?.message ?? e} — satır yine de eklenecek`',
  '`[aegis] karar günlüğü yazılamadı (${hedef}): ${e?.message ?? e} — onay akışı etkilenmedi`',
];

type Bulgu = { satir: number; iz: string; parca: string };

function beyanEdilmemisTurkce(kaynak: string): Bulgu[] {
  const bulgular: Bulgu[] = [];
  kaynak.split("\n").forEach((ham, i) => {
    const iz = turkceIz(ham);
    if (!iz) return;
    if (MESRU_TURKCE_SATIRLAR.includes(ham.trim())) return;
    bulgular.push({ satir: i + 1, iz, parca: ham.trim() });
  });
  return bulgular;
}

/* ── MUTATION HELPERS (in memory; nothing is written to disk) ─────────────────── */

function kuyrukEkle(kaynak: string, capa: string, kuyruk: string): string {
  const satirlar = kaynak.split("\n");
  const j = satirlar.findIndex((s) => s.includes(capa));
  assert.notEqual(j, -1, `mutasyon çapası kayboldu: ${capa} — mutasyon tablosu bayat`);
  satirlar[j] += kuyruk;
  return satirlar.join("\n");
}

function satirlariEkle(kaynak: string, capa: string, ...yeni: string[]): string {
  const satirlar = kaynak.split("\n");
  const j = satirlar.findIndex((s) => s.includes(capa));
  assert.notEqual(j, -1, `mutasyon çapası kayboldu: ${capa} — mutasyon tablosu bayat`);
  satirlar.splice(j, 0, ...yeni);
  return satirlar.join("\n");
}

/**
 * Every entry was FIRST run against the repository as a real on-disk mutation of
 * src/kararGunlugu.ts, with faz4's watchdogs as the measurement. The four marked "faz4 kör"
 * left that suite at pass=6 fail=0 — they are the holes. They are replayed here in memory so
 * the proof lives inside the suite instead of in a report nobody re-runs.
 */
const MUTASYONLAR: Array<{ ad: string; uygula: (k: string) => string; iz: string }> = [
  {
    ad: "faz4 kör (M1): tırnak ve regex taşıyan kod satırının kuyruğundaki yorum",
    uygula: (k) => kuyrukEkle(k, "const tek = metin.replace(", " // pencere yoksa halkada YOKTUR."),
    iz: "halkada YOKTUR",
  },
  {
    ad: "faz4 kör (M2): import satırının kuyruğundaki yorum, ASCII Türkçe",
    uygula: (k) =>
      kuyrukEkle(k, 'from "node:fs";', " // COK ONEMLI: bu satir sessizce degistirilemez."),
    iz: "sessizce degistirilemez",
  },
  {
    ad: "faz4 kör (M3): yıldızsız blok yorumunun iç satırı",
    uygula: (k) =>
      satirlariEkle(
        k,
        "const GUNLUK_AZAMI_BAYT = 16",
        "/*",
        "  Tavan asilirsa devir olur; devir basarisiz olursa satir yine eklenir.",
        "  etmez, denetim izi sessizce durur — YARIM CEVIRI KALINTISI.",
        "*/"
      ),
    iz: "denetim izi sessizce durur",
  },
  {
    ad: "faz4 kör (M4): BEYAN EDİLMİŞ ürün dizesinin kuyruğuna eklenen yorum",
    uygula: (k) =>
      kuyrukEkle(k, "[aegis] karar günlüğü devredilemedi", " // bu satir asla degistirilmez"),
    iz: "asla degistirilmez",
  },
  {
    ad: "tek satırlık blok yorum",
    uygula: (k) => satirlariEkle(k, "const EYLEM_AZAMI", "/* pencere yoksa halkada YOKTUR. */"),
    iz: "halkada YOKTUR",
  },
  {
    ad: "beyan edilmemiş YENİ Türkçe ürün dizesi",
    uygula: (k) =>
      satirlariEkle(k, "const EYLEM_AZAMI", 'const YENI_UYARI = "[aegis] yeni uyarı";'),
    iz: "yeni uyar",
  },
];

/* ── (1) THE WATCHDOG CAN GO RED — MEASURED, NOT ASSERTED ─────────────────────── */

test("çeviri kalıntısı gözcüsü ÖLÇÜLEN kör noktaların HEPSİNDE kırmızı olabiliyor", () => {
  for (const { ad, uygula, iz } of MUTASYONLAR) {
    const bulgular = beyanEdilmemisTurkce(uygula(KAYNAK));
    const yakalanan = bulgular.filter((b) => b.parca.includes(iz));
    assert.ok(
      yakalanan.length > 0,
      `GÖZCÜ KÖR: "${ad}" enjekte edildi ve tarayıcı sessiz kaldı. Enjekte edilen iz: ` +
        `"${iz}". Toplam bulgu: ${bulgular.length} (${bulgular
          .map((b) => b.satir)
          .join(", ")}). Kırmızı OLAMAYAN bir gözcü sahte güvencedir — bu fazın kapattığı ` +
        `kusurun ta kendisi.`
    );
  }
});

test("gözcü İngilizce düzyazıya YANLIŞ ALARM vermiyor (yeşil kalabildiği ölçülür)", () => {
  // The other direction of the same coin: a watchdog that fires on everything is deleted
  // within a week, and a deleted watchdog protects nothing.
  //
  // The claim is about the INJECTED lines only, never about the file's total. Asserting a
  // total of zero here would make this test a duplicate of the absence claim below and would
  // turn it red for reasons that have nothing to do with false alarms.
  // Every injected line carries its OWN marker: a filter that could only see some of them
  // would let an unnoticed false alarm through on the rest.
  const IMZALAR = ["ING-A", "ING-B1", "ING-B2", "ING-C"];
  const ingilizce = satirlariEkle(
    KAYNAK,
    "const EYLEM_AZAMI",
    "// ING-A: a bounded action line keeps the record small; that is its only job.",
    "/* ING-B1: the ceiling is deliberate — an unbounded audit file is a disk-filling",
    "   primitive, ING-B2: and a full disk stops the trail without anyone being told. */",
    'const DENETCI_ORNEK = "https://example.invalid/ING-C";'
  );
  const yanlisAlarm = beyanEdilmemisTurkce(ingilizce).filter((b) =>
    IMZALAR.some((imza) => b.parca.includes(imza))
  );
  assert.deepEqual(
    yanlisAlarm.map((b) => `[${b.iz}] ${b.parca}`),
    [],
    "İngilizce yorum / blok yorum / dize kalıntı sayıldı: gözcü kullanılamaz derecede " +
      "gürültülü olur, gürültülü gözcü de silinir — silinen gözcü hiçbir şeyi korumaz"
  );
});

/* ── (2) THE CLAIM ITSELF ─────────────────────────────────────────────────────── */

test("src/kararGunlugu.ts'te BEYAN EDİLMEMİŞ Türkçe metin YOK (satır biçimi ne olursa olsun)", () => {
  const bulgular = beyanEdilmemisTurkce(KAYNAK);
  assert.deepEqual(
    bulgular.map((b) => `src/kararGunlugu.ts:${b.satir} [${b.iz}] ${b.parca.slice(0, 120)}`),
    [],
    `Beyan edilmemiş Türkçe satır. İki meşru sonuç var: (a) bu bir çeviri kalıntısıysa ` +
      `cümleyi İngilizce TAMAMLA — depo PUBLIC ve jüri okuyacak, yarım cümle bırakma; ` +
      `(b) bu gerçekten operatöre giden yeni bir ÜRÜN metniyse satırı BİREBİR ` +
      `MESRU_TURKCE_SATIRLAR listesine ekle. Üçüncü seçenek — tarayıcının muafiyetini ` +
      `genişletmek — yasak: muafiyet bir SINIF olduğu anda gözcü delinir, faz 4'te tam ` +
      `olarak böyle delindi.`
  );
});

/* ── (3) THE EXEMPTION LIST CANNOT GO STALE ───────────────────────────────────── */

test("meşru Türkçe satır listesi bayat DEĞİL: her girdi kaynakta birebir ve TEK kez duruyor", () => {
  const trimliSatirlar = KAYNAK.split("\n").map((s) => s.trim());
  for (const girdi of MESRU_TURKCE_SATIRLAR) {
    const kac = trimliSatirlar.filter((s) => s === girdi).length;
    assert.equal(
      kac,
      1,
      `Muafiyet girdisi kaynakta ${kac} kez geçiyor: ${girdi.slice(0, 90)}. Sıfır ise girdi ` +
        `BAYAT ve artık hiçbir şeyi muaf tutmadığı hâlde listede duruyor; birden fazla ise ` +
        `metin çoğalmış ve muafiyet tek bir satırdan fazlasını kapsar hâle gelmiş.`
    );
  }
  // The exemption must stay small enough to read in review. A growing list is how a verbatim
  // exemption turns back into a class exemption without anyone deciding to make it one.
  assert.ok(
    MESRU_TURKCE_SATIRLAR.length <= 8,
    `Muafiyet listesi ${MESRU_TURKCE_SATIRLAR.length} satıra çıkmış — bu boyutta liste ` +
      `gözden geçirilmez, yalnızca uzatılır.`
  );
});

/* ── (4) THE WORD LIST CANNOT SHRINK ──────────────────────────────────────────── */

test("kelime listesi faz4'ünkinin ÜST KÜMESİ (liste küçülerek bayatlayamaz)", () => {
  const faz4 = oku(FAZ4_YOLU);
  const blok = /const TURKCE_KELIMELER = new Set\(\[([\s\S]*?)\]\)/.exec(faz4);
  assert.ok(
    blok,
    "test/faz4KararGunlugu.test.ts içindeki TURKCE_KELIMELER bloğu bulunamadı — anket bozuk. " +
      "Okunamayan bir sinyal 'sorun yok' demek DEĞİLDİR: ya blok taşındı ya adı değişti."
  );
  const faz4Kelimeleri = [...blok[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(
    faz4Kelimeleri.length >= 24,
    `faz4'ün kelime listesinden yalnız ${faz4Kelimeleri.length} kelime ayrıştırılabildi — ` +
      `bu sayı ile kurulan "üst küme" hükmü hiçbir şeye kefil olamaz (ayrıştırıcı bozuk).`
  );
  const eksik = faz4Kelimeleri.filter((k) => !TURKCE_KELIMELER.has(k));
  assert.deepEqual(
    eksik,
    [],
    `faz4'ün saydığı ama bu dosyanın listesinde OLMAYAN kelime(ler): ${eksik.join(", ")}. ` +
      `Kardeş gözcüde tam olarak bu oldu: sonraki turun listesi öncekinin üst kümesi değildi ` +
      `ve düşen kelimelerle yazılmış yepyeni bir kalıntı hiçbir yerde yakalanmadı.`
  );
});
