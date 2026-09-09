// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ROUND-5 REGRESSION COVER — src/util.ts. Four audited defects, all of them measured before
 * anything was written here.
 *
 * (1) A COVERAGE SENTENCE WITH A WALKER THAT COULD NOT SEE HALF THE EXPORTS. src/util.ts
 *     promises "Every export here is covered by a direct unit test under test/", and the
 *     round-3 watcher that guards the sentence matches `^export (?:async )?function` — so a
 *     value export written as `export const` was invisible to it. MEASURED: `ISO_NUMERIC`
 *     had no test of its own anywhere under test/ (it is read at a refusal site in
 *     src/tools/write.ts), and the suite was green while the sentence claimed the opposite.
 *     A false assurance is worse than a stale comment, because someone trusts it. The walker
 *     below PARSES src/util.ts with the TypeScript compiler instead of grepping it, so
 *     `const`, `class` and `enum` exports count exactly as much as functions.
 *
 * (2) AN INVALID `tavan` WAS ACCEPTED SILENTLY AND THE ANNOUNCEMENT LIED. MEASURED:
 *     `metinTemizle("abcdef", -3)` returned "abc… [9 karakter kırpıldı]" — three characters
 *     were dropped and nine were announced; `metinTemizle("abc", 0)` erased the whole message
 *     and returned the marker alone. The one thing this function sells is that its cut is
 *     ANNOUNCED rather than silent; an announcement carrying the wrong number destroys that.
 *     The repository's contract is explicit — an invalid value throws, it is not quietly
 *     corrected.
 *
 * (3) THE DOCBLOCK'S OWN ATTACK STILL WORKED WITHOUT A SINGLE ESCAPE BYTE. MEASURED:
 *     U+202E (right-to-left override), U+2028 and U+2029 all passed through `metinTemizle`
 *     and `formatAdsError` untouched. RLO reverses the render direction of everything after
 *     it — that is the no-ESC half of "paint a fake BAŞARILI over the gate's real verdict" —
 *     and U+2028/U+2029 are exactly the line separators that let upstream text forge a second
 *     line looking like ours, which is the contract test/faz3Util.test.ts already states in
 *     prose. The Unicode TAGS block (U+E0000–U+E007F) is the same hole pointed at the agent
 *     rather than the operator: invisible to a human, read as text by a model.
 *
 * (4) A HANDOFF NOTE PROPOSED WEAKENING A STRONGER DEFENCE. It suggested closing
 *     networkTrust's catch blocks with `console.error(... ${metinTemizle(detay)})` to avoid
 *     "a second copy" — but `operatorMetniTemizle` already exists there and masks the NaC
 *     token and the approver's number BY VALUE on top of the same cleaning. `metinTemizle`
 *     masks nothing. Following the note would have reopened "no token, no full phone number,
 *     no PII ever reaches a log or a terminal". The code was never wrong; the note was, and
 *     the note is what the next agent reads. The refusal is now written where it cannot be
 *     lost — in the docblock of the function being misrecommended — and pinned below.
 *
 * ORACLE INDEPENDENCE: the leak detector here is a hand-written table of code-point ranges.
 * It is deliberately NOT the `\p{Cf}`/`\p{Zl}`/`Default_Ignorable` test the implementation
 * uses. An oracle that is a copy of the implementation can never be red for a character the
 * implementation forgot — that failure has already been recorded in this repository once.
 *
 * MUTATION-CHECKED — ELEVEN mutations, one at a time, each reverted afterwards, each one
 * measured RED and against the intended watcher: dropping the `tavan` validation; dropping
 * the invisible-character test from the scrub loop; narrowing that test to `\p{Zl}\p{Zp}`
 * only; narrowing it to `\p{Cf}\p{Zl}\p{Zp}` only (the two narrowings are what prove the
 * oracle is not a copy of the implementation); deleting the "not a redactor" paragraph;
 * removing the coverage sentence; adding `export const DENETCI_TESTSIZ_SABIT = …`, an
 * `export const` arrow function, and an `export function` to src/util.ts with no test;
 * changing one ISO_NUMERIC entry; and blinding THIS file's own walker back to the round-3
 * function-only regex. The last one is why the coverage test checks its own survey before
 * it makes an absence claim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ISO_NUMERIC, formatAdsError, geoTargetId, metinTemizle } from "../src/util.js";

const KOK = fileURLToPath(new URL("..", import.meta.url));
const UTIL_KAYNAK = readFileSync(join(KOK, "src", "util.ts"), "utf8");

/* ── The independent leak oracle ─────────────────────────────────────────────── */

/**
 * Every character class that must NOT survive a scrub, written out by hand.
 *
 * Hand-written on purpose: this is the oracle, and an oracle built from the same expression
 * the implementation uses cannot disagree with it. Ranges rather than single points where
 * the whole block is unwanted.
 */
const YASAK_ARALIKLAR: ReadonlyArray<readonly [number, number, string]> = [
  [0x0000, 0x001f, "C0 kontrol baytı"],
  [0x007f, 0x009f, "DEL ve C1 kontrol baytı"],
  [0x00ad, 0x00ad, "yumuşak tire (görünmez)"],
  [0x061c, 0x061c, "Arabic letter mark"],
  [0x180e, 0x180e, "Mongolian vowel separator"],
  [0x200b, 0x200f, "sıfır genişlikli / LRM / RLM"],
  [0x2028, 0x2029, "satır ve paragraf ayırıcı"],
  [0x202a, 0x202e, "bidi gömme ve ÜSTÜNE YAZMA (RLO)"],
  [0x2060, 0x2064, "word joiner / görünmez operatörler"],
  [0x2066, 0x2069, "bidi izolasyon"],
  [0x3164, 0x3164, "Hangul dolgu karakteri"],
  [0xfe00, 0xfe0f, "varyasyon seçiciler"],
  [0xfeff, 0xfeff, "ZWNBSP / BOM"],
  [0xe0000, 0xe007f, "Unicode TAGS bloğu (ajana görünmez talimat kanalı)"],
];

/**
 * Anything from the table above that is still in the string.
 *
 * `satirSonuSerbest` exists for `formatAdsError` alone: that function puts its own hint on a
 * second line, so the newline there is text this repository wrote, not upstream text.
 */
function sizanlar(s: string, satirSonuSerbest = false): string[] {
  const kalan: string[] = [];
  for (const ch of s) {
    const kod = ch.codePointAt(0)!;
    if (satirSonuSerbest && ch === "\n") continue;
    const aralik = YASAK_ARALIKLAR.find(([alt, ust]) => kod >= alt && kod <= ust);
    if (aralik) kalan.push(`U+${kod.toString(16).toUpperCase().padStart(4, "0")} (${aralik[2]})`);
  }
  return kalan;
}

/** Built from code points so this file carries no raw control byte (test/kaynakHijyeni.test.ts). */
const RLO = String.fromCodePoint(0x202e);
const LS = String.fromCodePoint(0x2028);
const PS = String.fromCodePoint(0x2029);
const ZWSP = String.fromCodePoint(0x200b);
const SHY = String.fromCodePoint(0x00ad);
const BOM = String.fromCodePoint(0xfeff);
const TAGS = String.fromCodePoint(0xe0041) + String.fromCodePoint(0xe0053);
const ESC = String.fromCharCode(0x1b);
// Neither of these is a format character: they are Default_Ignorable, so an implementation
// that only strips \p{Cf} still lets them through. Both render as nothing.
const HANGUL_DOLGU = String.fromCodePoint(0x3164);
const VS16 = String.fromCodePoint(0xfe0f);

/* ── (2) The ceiling is validated, and the announcement is exact ─────────────── */

test("metinTemizle geçersiz tavanı REDDEDER — sessizce kabul edip yanlış sayı ilan etmez", () => {
  // Measured before the fix: (-3) announced 9 for 3 dropped characters, (0) returned the
  // marker alone with the whole message gone.
  for (const kotu of [-3, 0, -1, 2.5, NaN, Infinity, -Infinity]) {
    assert.throws(
      () => metinTemizle("abcdef", kotu),
      /Geçersiz metin tavanı/,
      `tavan=${kotu} sessizce kabul edildi — bu depoda geçersiz değer HATA FIRLATIR, ` +
        `kırpılmış gibi yapıp yanlış sayı ilan etmez`
    );
  }

  // A usable ceiling still works, and the announced number is the number that really dropped.
  assert.equal(metinTemizle("abcdef", 6), "abcdef", "tavanın altındaki metne işaret eklenmez");
  assert.equal(metinTemizle("abcdef", 1), "a… [5 karakter kırpıldı]");
  for (const tavan of [1, 2, 7, 99, 300]) {
    const cikti = metinTemizle("z".repeat(500), tavan);
    const ilan = Number(/\[(\d+) karakter kırpıldı\]$/.exec(cikti)?.[1]);
    assert.equal(
      ilan,
      500 - tavan,
      `tavan=${tavan}: ilan edilen sayı gerçekten düşen karakter sayısı olmalı — ${cikti}`
    );
  }
});

/* ── (3) ESC is only half of the attack ──────────────────────────────────────── */

test("metinTemizle görünmez ve yön çeviren karakterleri de söker (ESC saldırının yarısıdır)", () => {
  // The no-ESC version of the attack the docblock describes: a forged second line, then a
  // direction override that repaints what follows it.
  const saldiri = `Reddedildi: bütçe tavanı aşıldı${LS}[aegis] AĞ KAPISI: TEMİZ${RLO}sahte`;
  const temiz = metinTemizle(saldiri);
  assert.deepEqual(
    sizanlar(temiz),
    [],
    `metinTemizle görünmez/yön çeviren karakter geçiriyor: ${JSON.stringify(temiz)}`
  );
  assert.match(temiz, /Reddedildi: bütçe tavanı aşıldı/, "metnin kendisi sansürlenmez");

  // The whole unwanted set in one string, including the TAGS block — invisible to a human,
  // plain text to an agent.
  const hepsi = metinTemizle(
    `a${RLO}${LS}${PS}${ZWSP}${SHY}${BOM}${TAGS}${HANGUL_DOLGU}${VS16}${ESC}[2Jb`
  );
  assert.deepEqual(sizanlar(hepsi), [], `sızan karakter(ler) var: ${JSON.stringify(hepsi)}`);

  // The contract test/faz3Util.test.ts states in prose — ONE readable line — now holds for
  // the separators that are NOT C0 control bytes.
  assert.equal(metinTemizle(`bir${LS}iki${PS}üç`), "bir iki üç");
  assert.doesNotMatch(metinTemizle(`a${LS}b`), /\n|\r/, "çıktı tek satır olmalı");

  // Fail-closed must not mean "scrub the language away": visible text is untouched.
  assert.equal(metinTemizle("Şişli İĞNE ğüşiöç — 漢字 € 12,50"), "Şişli İĞNE ğüşiöç — 漢字 € 12,50");

  // Both paths into formatAdsError, since that is the single exit every err() passes through.
  assert.deepEqual(sizanlar(formatAdsError(new Error(`x${RLO}y${LS}z`)), true), []);
  assert.deepEqual(
    sizanlar(formatAdsError({ errors: [{ message: `q${TAGS}${PS}w` }] }), true),
    [],
    "hata LİSTESİ yolu da temizlenmeli"
  );
});

test("sızıntı oracle'ı kırmızı OLABİLİYOR ve uygulamanın ifadesinin kopyası değil", () => {
  // An oracle that cannot be red is not an oracle. Each class on the table, unscrubbed.
  assert.deepEqual(sizanlar(`a${RLO}`).length, 1);
  assert.equal(sizanlar(`${LS}${PS}${ZWSP}${SHY}${BOM}${TAGS}`).length, 7);
  assert.equal(sizanlar("düz metin — 漢字 €").length, 0, "görünür metni yanlışlıkla işaretlemez");
  assert.equal(sizanlar("a\nb").length, 1, "satır sonu varsayılan olarak sızıntıdır");
  assert.equal(sizanlar("a\nb", true).length, 0, "yalnız formatAdsError'ın ipucu satırı serbesttir");
  // The oracle is a hand-written table, not the implementation's expression: if src/util.ts
  // ever stops using property escapes the oracle must not follow it.
  assert.ok(YASAK_ARALIKLAR.length >= 14, "yasak aralık tablosu budanmış görünüyor");
});

/* ── (4) It cleans; it does not redact ───────────────────────────────────────── */

test("metinTemizle bir MASKELEYİCİ değildir — operatorMetniTemizle'nin yerine geçemez", () => {
  const sahteJeton = `TEST-ONLY-nac-${"a1b2c3d4".repeat(4)}`;
  const cikti = metinTemizle(`CAMARA reddi: ${sahteJeton}`);
  assert.ok(
    cikti.includes(sahteJeton),
    `Bu iddia bir ZAYIFLIĞI değil, bir SINIRI çiviliyor: metinTemizle jetonu OLDUĞU GİBİ ` +
      `geçirir. Buraya maskeleme eklediysen bu testi değil, src/util.ts'teki "IT IS NOT A ` +
      `REDACTOR" paragrafını ve networkTrust ile olan iş bölümünü de güncelle.`
  );

  // The refusal has to live where the mistaken advice would be applied.
  assert.match(
    UTIL_KAYNAK,
    /IT IS NOT A REDACTOR AND IT CANNOT REPLACE `operatorMetniTemizle`/,
    `src/util.ts'ten "maskeleyici değildir" uyarısı düşmüş. Bir devir notu tam olarak bunu ` +
      `öneriyordu: networkTrust'ın catch bloklarını metinTemizle ile kapatmak. Uygulansaydı ` +
      `NaC jetonu ve onaylayıcı numarası operatörün stderr'ine düşerdi.`
  );

  // A cross-reference that points at nothing is the same stale-sentence defect one level up.
  const AG_KAYNAK = readFileSync(join(KOK, "src", "networkTrust.ts"), "utf8");
  assert.match(
    AG_KAYNAK,
    /export function operatorMetniTemizle\b/,
    "src/util.ts operatorMetniTemizle'ye yönlendiriyor ama o ad src/networkTrust.ts'te yok"
  );
});

/* ── (1) The coverage sentence and a walker that can actually see ────────────── */

interface DisaAcilan {
  ad: string;
  tur: "deger" | "tip";
}

/**
 * Every export of a TypeScript source, split into value and type.
 *
 * A PARSE, not a grep. The round-3 walker read `^export (?:async )?function` and therefore
 * could not see `export const ISO_NUMERIC` — the export that was actually uncovered. A
 * regex over export syntax is a list of the shapes somebody remembered.
 */
function disaAcilanlar(kaynak: string, ad: string): DisaAcilan[] {
  const sf = ts.createSourceFile(ad, kaynak, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bulunan: DisaAcilan[] = [];
  const disaAcik = (d: ts.Node): boolean =>
    ts.canHaveModifiers(d) &&
    !!ts.getModifiers(d)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const d of sf.statements) {
    if (!disaAcik(d)) continue;
    if (ts.isFunctionDeclaration(d) && d.name) bulunan.push({ ad: d.name.text, tur: "deger" });
    else if (ts.isClassDeclaration(d) && d.name) bulunan.push({ ad: d.name.text, tur: "deger" });
    else if (ts.isEnumDeclaration(d)) bulunan.push({ ad: d.name.text, tur: "deger" });
    else if (ts.isVariableStatement(d)) {
      for (const b of d.declarationList.declarations) {
        if (ts.isIdentifier(b.name)) bulunan.push({ ad: b.name.text, tur: "deger" });
      }
    } else if (ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d)) {
      bulunan.push({ ad: d.name.text, tur: "tip" });
    }
  }
  return bulunan;
}

/** Names a test file imports from src/util.ts. An import alone proves nothing — see below. */
function utildenAlinanlar(kaynak: string, ad: string): Set<string> {
  const sf = ts.createSourceFile(ad, kaynak, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const alinan = new Set<string>();
  for (const d of sf.statements) {
    if (!ts.isImportDeclaration(d)) continue;
    if (!ts.isStringLiteral(d.moduleSpecifier) || !/\/util\.js$/.test(d.moduleSpecifier.text)) continue;
    const kisim = d.importClause?.namedBindings;
    if (kisim && ts.isNamedImports(kisim)) for (const e of kisim.elements) alinan.add(e.name.text);
  }
  return alinan;
}

/**
 * Identifiers a test file uses in EXECUTABLE code.
 *
 * Import clauses are skipped (a name that only appears in an import line proves nothing —
 * the round-3 walker made the same distinction with its `name(` check, and that distinction
 * has to survive the move to constants, which cannot be "called"). Comments and string
 * literals are invisible to the parser, which is why this is an AST walk. Property names are
 * skipped too: `sonuc.dedupe` is a different thing that happens to share a name.
 */
function kullanilanAdlar(kaynak: string, ad: string): Set<string> {
  const sf = ts.createSourceFile(ad, kaynak, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const adlar = new Set<string>();
  const bak = (d: ts.Node): void => {
    if (ts.isImportDeclaration(d) || ts.isExportDeclaration(d)) return;
    if (ts.isIdentifier(d)) {
      const p = d.parent;
      const ozellikAdi =
        (ts.isPropertyAccessExpression(p) && p.name === d) ||
        (ts.isPropertyAssignment(p) && p.name === d) ||
        (ts.isPropertySignature(p) && p.name === d) ||
        (ts.isQualifiedName(p) && p.right === d);
      if (!ozellikAdi) adlar.add(d.text);
    }
    ts.forEachChild(d, bak);
  };
  ts.forEachChild(sf, bak);
  return adlar;
}

const TEST_DOSYALARI = readdirSync(join(KOK, "test"))
  .filter((ad) => ad.endsWith(".test.ts"))
  .map((ad) => ({ ad, kaynak: readFileSync(join(KOK, "test", ad), "utf8") }));

/** A name counts as covered only where the SAME file both imports it and uses it. */
const KAPSANANLAR = new Set(
  TEST_DOSYALARI.flatMap(({ ad, kaynak }) => {
    const alinan = utildenAlinanlar(kaynak, ad);
    if (alinan.size === 0) return [];
    const kullanilan = kullanilanAdlar(kaynak, ad);
    return [...alinan].filter((x) => kullanilan.has(x));
  })
);

test("src/util.ts'in her DEĞER export'u test/ altında gerçekten kullanılıyor", () => {
  const degerler = disaAcilanlar(UTIL_KAYNAK, "util.ts").filter((d) => d.tur === "deger");
  assert.ok(degerler.length > 20, `export yürüyücüsü bozuk görünüyor: ${degerler.length} değer bulundu`);
  // The survey must be checked in the SAME test that makes the absence claim. An absence
  // claim built on an incomplete list is the failure this whole round exists to close: the
  // round-3 walker's list was missing every `export const`, and "no uncovered export" was
  // therefore true of a set that did not contain the uncovered one.
  assert.ok(
    degerler.some((d) => d.ad === "ISO_NUMERIC"),
    "ANKET EKSİK: bilinen bir `export const` (ISO_NUMERIC) yürüyücünün listesinde yok — " +
      "bu listeyle kurulan 'kapsanmayan export yok' hükmü hiçbir şeye kefil olamaz"
  );
  const kapsanmayan = degerler.map((d) => d.ad).filter((ad) => !KAPSANANLAR.has(ad));
  assert.deepEqual(
    kapsanmayan,
    [],
    `Hiçbir testte kullanılmayan DEĞER export(lar): ${kapsanmayan.join(", ")}.\n` +
      `src/util.ts başlığı "Every export here is covered by a direct unit test under test/" ` +
      `diyor. Ya testini yaz ya da cümleyi doğru olacak şekilde düzelt — üçüncü seçenek ` +
      `(cümleyi bırakıp gözcüyü kör tutmak) tam olarak bu turda kapatılan kusurdur: ` +
      `ISO_NUMERIC aylarca yeşil bir suit altında kapsamsız durdu, çünkü eski tarayıcı ` +
      `yalnız "export function" görüyordu.`
  );
});

test("kapsam cümlesi hâlâ sayfada ve ne bağladığını söylüyor", () => {
  assert.match(
    UTIL_KAYNAK,
    /Every export here is covered by a direct unit test under test\//,
    "kapsam cümlesi kaldırılmış — gözcü kefil olduğu iddiayı kaybetti"
  );
  assert.match(
    UTIL_KAYNAK,
    /WHAT THAT SENTENCE BINDS: every VALUE export/,
    "cümlenin neyi bağladığı (yalnız değer export'ları) yazılmamış — tip export'ları " +
      "derleyicinin işi, testin değil; bu ayrım yazılmazsa cümle yine fazlasını vaat eder"
  );
});

test("export yürüyücüsü ile kullanım yürüyücüsü kırmızı OLABİLİYOR", () => {
  // The walker sees every export shape, not just functions.
  const sentetik = [
    "export function f() {}",
    "export async function g() {}",
    "export const SABIT: Record<string, number> = { a: 1 };",
    "export const p = 1, q = 2;",
    "export class C {}",
    "export enum E { A }",
    "export type T = string;",
    "export interface I { a: number }",
    "const gizli = 1;",
    "function ic() {}",
  ].join("\n");
  assert.deepEqual(
    disaAcilanlar(sentetik, "sentetik.ts").filter((d) => d.tur === "deger").map((d) => d.ad),
    ["f", "g", "SABIT", "p", "q", "C", "E"],
    "değer export'larının bir şekli görülmüyor — eski regex tarayıcısının düştüğü delik budur"
  );
  assert.deepEqual(
    disaAcilanlar(sentetik, "sentetik.ts").filter((d) => d.tur === "tip").map((d) => d.ad),
    ["T", "I"]
  );
  // The real file: the const export the round-3 regex could not see must be in the list.
  const gercek = disaAcilanlar(UTIL_KAYNAK, "util.ts");
  assert.ok(
    gercek.some((d) => d.ad === "ISO_NUMERIC" && d.tur === "deger"),
    "ISO_NUMERIC değer export'u olarak görülmüyor — yürüyücü yine yalnız fonksiyonlara bakıyor"
  );

  // The usage walker: an import line, a comment and a string are NOT usage; an expression is.
  const testGibi = [
    'import { metinTemizle, dedupe, budgetGuard } from "../src/util.js";',
    "// dedupe burada yalnız yorumda geçiyor",
    'const s = "budgetGuard";',
    "const r = metinTemizle('x');",
    "const o = { budgetGuard: 1 };",
  ].join("\n");
  const kullanilan = kullanilanAdlar(testGibi, "testGibi.ts");
  assert.ok(kullanilan.has("metinTemizle"), "gerçek çağrı kullanım sayılmalı");
  assert.ok(!kullanilan.has("dedupe"), "yalnız import + yorumda geçen ad kullanım sayılmamalı");
  assert.ok(!kullanilan.has("budgetGuard"), "dizede ve özellik adında geçen ad kullanım sayılmamalı");
  assert.deepEqual([...utildenAlinanlar(testGibi, "testGibi.ts")].sort(), [
    "budgetGuard",
    "dedupe",
    "metinTemizle",
  ]);
});

/* ── The direct unit test the sentence was missing ───────────────────────────── */

test("ISO_NUMERIC: geoTargetId'nin dayandığı ISO 3166 sayısal kodları", () => {
  // Spot values from Google's own published geoTargetConstant list (2000 + ISO numeric).
  assert.equal(ISO_NUMERIC.TR, 792);
  assert.equal(ISO_NUMERIC.US, 840);
  assert.equal(ISO_NUMERIC.GB, 826);
  assert.equal(ISO_NUMERIC.DE, 276);
  assert.equal(ISO_NUMERIC.JP, 392);

  const girdiler = Object.entries(ISO_NUMERIC);
  assert.ok(girdiler.length >= 48, `tablo küçülmüş: ${girdiler.length} ülke`);

  // Shape: an ISO 3166-1 alpha-2 key and a numeric code in 1..999. A key with a lower-case
  // letter would be unreachable, since geoTargetId upper-cases before the lookup.
  const bozuk = girdiler.filter(
    ([k, v]) => !/^[A-Z]{2}$/.test(k) || !Number.isInteger(v) || v < 1 || v > 999
  );
  assert.deepEqual(bozuk, [], `ISO 3166 sayısal kodu olamayacak girdi(ler): ${JSON.stringify(bozuk)}`);

  // Two countries sharing a code would silently target the wrong country.
  const kodlar = girdiler.map(([, v]) => v);
  assert.equal(new Set(kodlar).size, kodlar.length, "aynı sayısal kodu paylaşan iki ülke var");

  // The docblock's rule, checked against every entry rather than the two that were sampled.
  for (const [k, v] of girdiler) {
    assert.equal(geoTargetId(k), 2000 + v, `${k} için 2000 + ${v} beklenirdi`);
    assert.equal(geoTargetId(k.toLowerCase()), 2000 + v, `${k} küçük harfle de çözülmeli`);
  }
  assert.equal(geoTargetId("ZZ"), null, "listede olmayan ülke kodu null döner, uydurulmaz");
});
