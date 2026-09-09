// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PHASE-4 REGRESSION — scripts/demo-senaryo.mjs, COMMENT LAYOUT
 *
 * This file guards no behaviour. It guards the readability of the demo script, which on stage
 * is the only narration a reviewer gets, and which the public repo puts in front of a jury.
 * Two residues of the same class were MEASURED in it and repaired alongside this file:
 *
 *   1) The two-line `//` block inside Act 3/A's `} else if (perde3aIstemSayisi > 0 &&
 *      !perde3OperatorOnayi)` branch had its SECOND line at column 6 while the block starts at
 *      column 10. Indented out of its own branch, "no write was applied" read as a remark on
 *      the enclosing `if (suanki === "ENABLED")` chain — that is, on a DIFFERENT decision, and
 *      exactly the branch where a write DID go out. Measured before the repair: one mismatched
 *      continuation line, expected column 10, got 6.
 *   2) The end-of-line comment on `const DEMO_TELEFON` wrapped onto a line of its own at
 *      column 0 ("// the spawn environment"), where it no longer reads as the tail of the
 *      previous sentence but as an independent remark about the NEXT declaration.
 *
 * WHY A SENTINEL AND NOT ONLY A REPAIR: both are whitespace slips. The script runs
 * identically, so every behavioural gate in the repo stays green while the sentence that says
 * which decision was taken points at the wrong one. Nothing here was looking at layout.
 *
 * WHY THIS SENTINEL CAN GO RED — no vacuum guard:
 *   · Both scanners are run against a SYNTHETIC copy of the exact pre-repair text and must
 *     report exactly one hit each; against the repaired text they must report none. The
 *     mutation is therefore encoded in the file, not just performed once by hand.
 *   · `yorumBasi` — the "where does the comment start" extractor — is pinned separately. An
 *     extractor that strips too much stops seeing comments at all, and then every check below
 *     passes by seeing nothing; that is the exact way a sentinel of this shape gets pierced.
 *   · Every inventory asserts it is NON-EMPTY before it vouches for anything.
 *   · The two anchored checks bind a SENTENCE to the CODE next to it in both directions: the
 *     comment going stale is red, and the code moving out from under the comment is red too.
 *
 * SCOPE: scripts/demo-senaryo.mjs only. scripts/prova.mjs:53-54 carries the same wrapped
 * end-of-line comment ("// the narration") and belongs to another agent in this round, so it
 * is deliberately NOT covered here — a sentinel must not be red for a repair it may not make.
 *
 * ASSUMPTION, stated because it is the scanners' only blind spot: lines are classified one at
 * a time, so a line that begins with `//` INSIDE a multi-line template literal would be read
 * as a comment. Measured today: scripts/demo-senaryo.mjs has no such line — both scanners
 * report zero on the repaired file, and the pinning test above proves they are not silent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const KOK = fileURLToPath(new URL("..", import.meta.url));
const HEDEF = "scripts/demo-senaryo.mjs";
const KAYNAK = readFileSync(join(KOK, HEDEF), "utf8");
const SATIRLAR = KAYNAK.split("\n");

const TIRNAKLAR = new Set(['"', "'", "`"]);

/**
 * Index of the `//` that opens a line comment, or -1 when the line has none.
 *
 * Quoted spans are skipped so that a URL inside a string ("https://…") is not mistaken for a
 * comment, and a backslash escape is honoured so that a quote written as \" does not close the
 * span early. It strips NOTHING else on purpose: the wider this gets, the more comments it
 * fails to find, and a scanner that finds no comments reports no violations.
 */
function yorumBasi(satir) {
  let tirnak = null;
  for (let i = 0; i < satir.length; i++) {
    const c = satir[i];
    if (tirnak) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === tirnak) tirnak = null;
      continue;
    }
    if (TIRNAKLAR.has(c)) {
      tirnak = c;
      continue;
    }
    if (c === "/" && satir[i + 1] === "/") return i;
  }
  return -1;
}

const girinti = (satir) => satir.match(/^\s*/)[0].length;
const yorumSatiriMi = (satir) => /^\s*\/\//.test(satir);

/** Runs of consecutive `//`-only lines: `{ bas, girintiler[] }`, `bas` 1-based. */
function yorumBloklari(satirlar) {
  const bloklar = [];
  let i = 0;
  while (i < satirlar.length) {
    if (!yorumSatiriMi(satirlar[i])) {
      i++;
      continue;
    }
    const bas = i;
    while (i < satirlar.length && yorumSatiriMi(satirlar[i])) i++;
    bloklar.push({ bas: bas + 1, girintiler: satirlar.slice(bas, i).map(girinti) });
  }
  return bloklar;
}

/** Continuation lines sitting at a different column than their block's first line. */
function hizaKacaklari(satirlar) {
  const kacaklar = [];
  for (const blok of yorumBloklari(satirlar)) {
    const beklenen = blok.girintiler[0];
    for (let k = 1; k < blok.girintiler.length; k++) {
      if (blok.girintiler[k] !== beklenen) {
        kacaklar.push({
          satir: blok.bas + k,
          beklenen,
          olcum: blok.girintiler[k],
          metin: satirlar[blok.bas + k - 1].trim(),
        });
      }
    }
  }
  return kacaklar;
}

/** Comment-only lines that are really the tail of an END-OF-LINE comment on the line above. */
function tasanSatirSonuYorumlari(satirlar) {
  const tasanlar = [];
  for (let k = 1; k < satirlar.length; k++) {
    const onceki = satirlar[k - 1];
    if (!yorumSatiriMi(satirlar[k])) continue;
    const p = yorumBasi(onceki);
    if (p <= 0) continue; // -1: no comment · 0: the line above is itself a comment line
    if (!/\S/.test(onceki.slice(0, p))) continue; // whitespace then `//` is a comment line too
    tasanlar.push({ satir: k + 1, kod: onceki.slice(0, p).trim(), metin: satirlar[k].trim() });
  }
  return tasanlar;
}

/** Every line carrying an end-of-line comment — the population the scanner above walks. */
const satirSonuYorumlariSayisi = (satirlar) =>
  satirlar.filter((s) => {
    const p = yorumBasi(s);
    return p > 0 && /\S/.test(s.slice(0, p));
  }).length;

/* ── The mutation, encoded: the exact pre-repair text must be RED ───────────────────────── */

/** scripts/demo-senaryo.mjs:1381-1384 as it stood before the repair (continuation at col 6). */
const BOZUK_HIZA = [
  "        } else if (perde3aIstemSayisi > 0 && !perde3OperatorOnayi) {",
  "          // The operator did not type 'Evet': no write was applied — that is not a demo",
  "      // failure, it is a real decision.",
  "          yaz(sari(`Operatör onay vermedi.`));",
];
const ONARILMIS_HIZA = [
  BOZUK_HIZA[0],
  BOZUK_HIZA[1],
  "          // failure, it is a real decision.",
  BOZUK_HIZA[3],
];

/** scripts/demo-senaryo.mjs:88-89 as it stood before the repair (trailing comment wrapped). */
const BOZUK_TASMA = [
  'const DEMO_TELEFON = "+905550001122"; // the approver\'s DEMO number, passed to the server in',
  "// the spawn environment",
];
const ONARILMIS_TASMA = [
  "// The approver's DEMO number, passed to the server in the spawn environment.",
  'const DEMO_TELEFON = "+905550001122";',
];

test("bekçi kendini sınar: onarımdan ÖNCEKİ metin iki tarayıcıda da kırmızı, sonraki yeşil", () => {
  const kacak = hizaKacaklari(BOZUK_HIZA);
  assert.equal(kacak.length, 1, `Bozuk hizalama görülmedi: ${JSON.stringify(kacak)}`);
  assert.equal(kacak[0].beklenen, 10);
  assert.equal(kacak[0].olcum, 6);
  assert.deepEqual(hizaKacaklari(ONARILMIS_HIZA), [], "Onarılmış metin yanlışlıkla kırmızı.");

  const tasan = tasanSatirSonuYorumlari(BOZUK_TASMA);
  assert.equal(tasan.length, 1, `Taşan satır sonu yorumu görülmedi: ${JSON.stringify(tasan)}`);
  assert.equal(tasan[0].metin, "// the spawn environment");
  assert.deepEqual(
    tasanSatirSonuYorumlari(ONARILMIS_TASMA),
    [],
    "Sabitin üstüne alınmış yorum yanlışlıkla kırmızı."
  );
});

test("yorumBasi ne fazlasını ne eksiğini ayıklar (tarayıcı körleşirse her şey yeşile döner)", () => {
  assert.equal(yorumBasi("// düz yorum"), 0);
  assert.equal(yorumBasi("      // girintili yorum"), 6);
  assert.equal(yorumBasi('const u = "https://ornek.test/yol";'), -1, "Dizedeki // yorum sanıldı.");
  assert.equal(yorumBasi('const u = "https://ornek.test/yol"; // not'), 36);
  assert.equal(yorumBasi('const s = "kaçışlı \\" tırnak"; // not'), 31, "Kaçışlı tırnak dizeyi erken kapattı.");
  assert.equal(yorumBasi("const n = 5;"), -1);
  assert.equal(yorumBasi("const t = `şablon`; // not"), 20);
  // The apostrophe lives INSIDE the comment: the scanner must already have stopped by then.
  assert.equal(yorumBasi("const n = 5; // it's fine"), 13);
});

/* ── The repaired file ──────────────────────────────────────────────────────────────────── */

test(`${HEDEF}: // yorum bloklarının devam satırları bloğun sütununda durur`, () => {
  const bloklar = yorumBloklari(SATIRLAR);
  const cokSatirli = bloklar.filter((b) => b.girintiler.length > 1);
  assert.ok(
    cokSatirli.length >= 5,
    `Envanter boş sayılır (${cokSatirli.length} çok satırlı blok) — bekçi hiçbir şeye kefil olamaz.`
  );
  const kacaklar = hizaKacaklari(SATIRLAR);
  assert.deepEqual(
    kacaklar,
    [],
    "Yorum bloğunun devamı kendi sütunundan kaçmış — hangi dala ait olduğu okunamaz:\n" +
      kacaklar.map((k) => `  ${HEDEF}:${k.satir} beklenen ${k.beklenen}, ölçülen ${k.olcum} → ${k.metin}`).join("\n")
  );
});

test(`${HEDEF}: satır sonu yorumu kendi başına bir satıra taşmaz`, () => {
  const sayi = satirSonuYorumlariSayisi(SATIRLAR);
  assert.ok(sayi >= 5, `Dosyada ${sayi} satır sonu yorumu görüldü — tarayıcı körleşmiş olabilir.`);
  const tasanlar = tasanSatirSonuYorumlari(SATIRLAR);
  assert.deepEqual(
    tasanlar,
    [],
    "Satır sonu yorumunun devamı ayrı satıra taşmış; bir SONRAKİ satır hakkında bağımsız bir " +
      "yorum gibi okunuyor. Yorumu sabitin üstüne al ya da tek satıra sığdır:\n" +
      tasanlar.map((t) => `  ${HEDEF}:${t.satir} ${t.kod} ⏎ ${t.metin}`).join("\n")
  );
});

test(`${HEDEF}: Perde 3/A operatör-reddi yorumu kendi else-if gövdesiyle hizalı`, () => {
  const dalDesen = /^\s*\}?\s*else if \(perde3aIstemSayisi > 0 && !perde3OperatorOnayi\) \{\s*$/;
  const dalIndeksleri = SATIRLAR.map((s, i) => (dalDesen.test(s) ? i : -1)).filter((i) => i >= 0);
  assert.equal(
    dalIndeksleri.length,
    1,
    `Perde 3/A operatör-reddi dalı bulunamadı ya da çoğaldı (${dalIndeksleri.length} eşleşme) — ` +
      "bekçi artık iddia ettiği yeri göstermiyor."
  );

  const dal = dalIndeksleri[0];
  const bekleyen = girinti(SATIRLAR[dal]) + 2;
  let k = dal + 1;
  const yorum = [];
  while (k < SATIRLAR.length && yorumSatiriMi(SATIRLAR[k])) yorum.push(SATIRLAR[k++]);

  assert.ok(
    yorum.length >= 2,
    `Dalın "yazma uygulanmadı" gerekçesi kaybolmuş (${yorum.length} yorum satırı) — kefil ` +
      "olduğu cümle yoksa bekçinin de dayanağı yok."
  );
  for (const [n, satir] of yorum.entries()) {
    assert.equal(
      girinti(satir),
      bekleyen,
      `${HEDEF}:${dal + 2 + n} yorumu ${girinti(satir)}. sütunda; dalın gövdesi ${bekleyen}. ` +
        `sütunda. Dışarıdaki zincire aitmiş gibi okunuyor → ${satir.trim()}`
    );
  }
  const metin = yorum.join(" ");
  assert.match(metin, /no write was applied/, "Dalın asıl iddiası (yazma uygulanmadı) yorumdan düşmüş.");
  assert.match(metin, /real decision/, "«Bu bir demo arızası değil, gerçek bir karar» ifadesi düşmüş.");

  // The comment is bound to the code under it: this branch may only NARRATE, never write.
  assert.ok(k < SATIRLAR.length, "Yorumdan sonra kod kalmamış.");
  assert.equal(girinti(SATIRLAR[k]), bekleyen, "Yorumdan sonraki ilk satır yorumla aynı sütunda değil.");
  assert.match(
    SATIRLAR[k],
    /yaz\(sari\(`Operatör onay vermedi/,
    `Yorum "yazma uygulanmadı" diyor ama altındaki satır artık o ekran metnini basmıyor: ${SATIRLAR[k].trim()}`
  );
});

test(`${HEDEF}: DEMO_TELEFON açıklaması sabitin ÜSTÜNDE ve hâlâ doğru`, () => {
  const i = SATIRLAR.findIndex((s) => /^const DEMO_TELEFON = /.test(s));
  assert.ok(i > 0, "DEMO_TELEFON sabiti bulunamadı.");
  assert.equal(
    yorumBasi(SATIRLAR[i]),
    -1,
    `DEMO_TELEFON satırına yeniden satır sonu yorumu eklenmiş; taşarsa aynı tuzak geri gelir: ${SATIRLAR[i]}`
  );

  let bas = i;
  while (bas > 0 && yorumSatiriMi(SATIRLAR[bas - 1])) bas--;
  assert.ok(bas < i, "Sabitin üstünde açıklama kalmamış — numaranın neden orada olduğu okunamıyor.");
  const aciklama = SATIRLAR.slice(bas, i).join(" ");
  assert.match(aciklama, /DEMO number/, "Numaranın DEMO olduğu bilgisi düşmüş.");
  assert.match(aciklama, /spawn environment/, "Numaranın spawn ortamıyla geçtiği bilgisi düşmüş.");

  // The other direction: the sentence above may not outlive the line it describes.
  assert.match(
    KAYNAK,
    /env\.AEGIS_APPROVER_PHONE = DEMO_TELEFON;/,
    "Yorum «spawn ortamıyla geçirilir» diyor ama sabiti spawn ortamına yazan satır kalmamış — " +
      "yorum bayat."
  );
});
