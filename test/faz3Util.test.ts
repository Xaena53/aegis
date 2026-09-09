// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ROUND-3 REGRESSION COVER — src/util.ts. Two findings: one doctrine with no guard, one
 * channel with no scrub.
 *
 * (1) "UNKNOWN IS NEVER 0" WAS CARRIED BY COMMENTS ALONE. `sayiOku` and `mikrodanTutar` are
 *     unit-tested and each of today's call sites is tested against its own fixture — but
 *     nothing stopped the `Number(x ?? 0)` idiom from being written AGAIN on a NEW read
 *     surface. That matters here because the repository records the same mistake being born
 *     four separate times (write.ts, meta/client.ts, read.ts, resources.ts); its own
 *     comments say so. Faults that recurred only TWICE — a raw NUL byte in a cache key, an
 *     HMAC key read straight from the environment — each got a permanent source scanner in
 *     test/kaynakHijyeni.test.ts. The four-time fault had none. A new metric written as
 *     `Number(row.metrics.cost_micros ?? 0) / 1e6` would have shipped green: existing tests
 *     pin today's fields with today's fixtures, and a new field arrives with a new fixture
 *     that carries the bug along with it. An unreadable cost then reports as 0, the agent
 *     reads "nothing was spent", and it raises the budget — the exact failure the doctrine
 *     exists to stop.
 *
 *     The scanner below is an AST walk, not a grep. Eight doc comments in src/ discuss the
 *     forbidden idiom by name; a regex would report every one of them, and a scanner that
 *     cries wolf is a scanner someone deletes. The TypeScript parser sees executable code
 *     only, so comments and string literals stay free to talk about it.
 *
 * (2) BOTH ERROR FORMATTERS HANDED UPSTREAM CONTROL BYTES STRAIGHT TO THE OPERATOR AND THE
 *     AGENT. Measured before the fix: `formatAdsError(new Error("...ESC[2J ESC[31m..."))`
 *     returned the escape bytes untouched, and a 5000-character message came back as a
 *     5023-character line with no cap at all. ESC is not whitespace, so the `/\s+/` tidy-up
 *     the Meta twin (`hataTemizle`) performs would not have caught it either. Since
 *     `formatAdsError` is the single exit every `err()` in src/tools/{read,write}.ts passes
 *     through, an upstream string could clear the operator's terminal and paint a fake
 *     "BAŞARILI" line over the gate's real verdict — on a demo recording, over the only
 *     record of what the gate said — while an unbounded error list could flood the agent's
 *     context.
 *
 * MUTATION-CHECKED, each watcher on its own: dropping `metinTemizle` from `formatAdsError`,
 * dropping the ANSI pass inside `metinTemizle`, adding one `x ?? 0` to a src/ file, blinding
 * the detector's zero test, and rewriting the coverage sentence in src/util.ts each turn a
 * different test in this file red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { formatAdsError, metinTemizle, setRuntimeMode } from "../src/util.js";

const KOK = fileURLToPath(new URL("..", import.meta.url));
const UTIL_KAYNAK = readFileSync(join(KOK, "src", "util.ts"), "utf8");

/** Control bytes are built from their code points, so this file carries none of its own. */
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const NUL = String.fromCharCode(0x00);

/** Any C0/C1 byte left in a string that is about to be printed. */
function kontrolBaytlari(s: string): string[] {
  const kalan: string[] = [];
  for (const ch of s) {
    const kod = ch.codePointAt(0)!;
    // \n is allowed: formatAdsError puts its own hint on a second line.
    if (ch !== "\n" && (kod <= 0x1f || (kod >= 0x7f && kod <= 0x9f))) {
      kalan.push(`U+${kod.toString(16).padStart(4, "0")}`);
    }
  }
  return kalan;
}

/* ── (2) The scrub ───────────────────────────────────────────────────────────── */

test("metinTemizle ANSI'yi ve kontrol baytlarını söker, kırpmayı AÇIKÇA bildirir", () => {
  const ham = `Meta hata ${ESC}[2J${ESC}[31mSAHTE: işlem BAŞARILI${ESC}[0m${BEL}${NUL}`;
  const temiz = metinTemizle(ham);
  assert.deepEqual(kontrolBaytlari(temiz), [], `kontrol baytı kaldı: ${JSON.stringify(temiz)}`);
  assert.doesNotMatch(temiz, /\[2J|\[31m|\[0m/, "ANSI dizisinin gövdesi de gitmeli, yalnız ESC değil");
  assert.match(temiz, /SAHTE: işlem BAŞARILI/, "metnin kendisi sansürlenmez — yalnız kontrol baytları");

  // An OSC sequence (window title) and a two-character Fe escape are the two shapes a
  // CSI-only strip misses; both have to end up as plain separators.
  assert.equal(metinTemizle(`a${ESC}]0;başlık${BEL}b`), "a b");
  assert.equal(metinTemizle(`a${ESC}Mb`), "a b");
  // Newlines and tabs become spaces: this function's contract is ONE readable line, and a
  // newline is what would let upstream text forge a second line that looks like ours.
  assert.equal(metinTemizle("bir\niki\tüç"), "bir iki üç");

  assert.equal(metinTemizle("kısa"), "kısa", "tavanın altındaki metne işaret eklenmez");
  assert.equal(metinTemizle(undefined), "", "okunamayan girdi boş dizeye iner, 'undefined' yazısına değil");

  const uzun = metinTemizle("x".repeat(500), 100);
  assert.match(uzun, /^x{100}… \[400 karakter kırpıldı\]$/, `kırpma sessiz kalmamalı: ${uzun}`);
});

test("formatAdsError upstream metnini terminale enjekte EDİLEMEZ hâle getirir ve tavanlar", () => {
  const saldiri = `CAMARA 503 upstream ${ESC}[2J${ESC}[32m[aegis] AĞ KAPISI: TEMİZ${ESC}[0m`;
  const cikti = formatAdsError(new Error(saldiri));
  assert.deepEqual(
    kontrolBaytlari(cikti),
    [],
    `formatAdsError ham kontrol baytı geçiriyor: ${JSON.stringify(cikti)}`
  );
  assert.doesNotMatch(cikti, /\[2J/, "ekran silen dizi ajanın/operatörün metnine giremez");

  // The same hole on the list path (e?.errors), not only on e.message.
  const listeCikti = formatAdsError({ errors: [{ message: `x${ESC}[31mkırmızı${ESC}[0m` }] });
  assert.deepEqual(kontrolBaytlari(listeCikti), [], "hata LİSTESİ yolu da temizlenmeli");

  // The cap: uncapped, this used to come back as a 5023-character line.
  const tasan = formatAdsError(new Error("y".repeat(5000)));
  assert.ok(tasan.length < 1200, `tavan yok gibi görünüyor: ${tasan.length} karakter`);
  assert.match(tasan, /karakter kırpıldı\]$/, "kırpma metnin içinde ilan edilmeli");
});

test("formatAdsError'ın bugünkü sözleşmesi temizleme/kırpma sonrası da duruyor", () => {
  const s = formatAdsError({
    errors: [
      { error_code: { query_error: "UNRECOGNIZED_FIELD" }, message: "alan yok" },
      {
        error_code: { field_error: "REQUIRED" },
        message: "eksik",
        location: { field_path_elements: [{ field_name: "mutate_operations", index: 1 }] },
      },
    ],
  });
  assert.match(s, /query_error=UNRECOGNIZED_FIELD \| alan yok/);
  assert.match(s, /alan: mutate_operations\[1\]/);
  // The hint still fires: every list entry leads with its code name, so the keywords the
  // hints match on sit in front of the cap rather than past it.
  assert.match(
    formatAdsError({ errors: [{ error_code: { authorization_error: "USER_PERMISSION_DENIED" } }] }),
    /GOOGLE_ADS_LOGIN_CUSTOMER_ID/
  );
  assert.doesNotMatch(formatAdsError(new Error("alakasız hata")), /İpucu/);
});

/* ── (1) The doctrine guard ──────────────────────────────────────────────────── */

interface SifirBulgusu {
  dosya: string;
  satir: number;
  ifade: string;
}

/** A literal zero in any shape `Number()` turns into 0: 0, 0.0, "0", '0'. */
function sifirLiterali(d: ts.Node): boolean {
  if (ts.isNumericLiteral(d)) return Number(d.text) === 0;
  if (ts.isStringLiteral(d)) return d.text.trim() !== "" && Number(d.text) === 0;
  return false;
}

/**
 * Every `x ?? 0` and `x || 0` in EXECUTABLE code. Comments and string literals are invisible
 * to the parser, which is the whole reason this is an AST walk and not a grep.
 */
function sifirVarsayilanlari(kaynak: string, ad: string): SifirBulgusu[] {
  const sf = ts.createSourceFile(ad, kaynak, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bulunan: SifirBulgusu[] = [];
  const bak = (d: ts.Node): void => {
    if (ts.isBinaryExpression(d)) {
      const op = d.operatorToken.kind;
      const dusme = op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken;
      if (dusme && sifirLiterali(d.right)) {
        bulunan.push({
          dosya: ad,
          satir: sf.getLineAndCharacterOfPosition(d.getStart(sf)).line + 1,
          ifade: d.getText(sf).replace(/\s+/g, " ").slice(0, 160),
        });
      }
    }
    ts.forEachChild(d, bak);
  };
  ts.forEachChild(sf, bak);
  return bulunan;
}

function tsDosyalari(dizin: string, toplanan: string[] = []): string[] {
  for (const ad of readdirSync(dizin)) {
    const tam = join(dizin, ad);
    if (statSync(tam).isDirectory()) tsDosyalari(tam, toplanan);
    else if (extname(ad) === ".ts") toplanan.push(tam);
  }
  return toplanan;
}

/**
 * The only zero-defaults allowed in src/, each with the reason it is NOT the monetary bug.
 *
 * An entry has to keep EARNING its place: a stale exemption is a hole nobody sees, so an
 * entry that matches nothing today fails as loudly as an unlisted violation.
 */
const MUAF: ReadonlyArray<{ dosya: string; ifade: string; gerekce: string }> = [
  {
    dosya: "src/http.ts",
    ifade: "pendingSessions.get(user.id) ?? 0",
    gerekce:
      "Uçuştaki oturum SAYACI, para değil. Anahtarın Map'te bulunmaması 'okunamadı' değil, " +
      "'bu kullanıcının uçuşta oturumu yok' demektir; 0 burada ÖLÇÜLMÜŞ bir gerçektir.",
  },
];

const SUCLULAR = tsDosyalari(join(KOK, "src")).flatMap((yol) =>
  sifirVarsayilanlari(readFileSync(yol, "utf8"), yol.slice(KOK.length).split("\\").join("/"))
);

test("src/ altında hiçbir okuma `?? 0` deyimine geri dönmedi", () => {
  const beklenmeyen = SUCLULAR.filter(
    (b) => !MUAF.some((m) => m.dosya === b.dosya && b.ifade.includes(m.ifade))
  ).map((b) => `${b.dosya}:${b.satir} → ${b.ifade}`);
  assert.deepEqual(
    beklenmeyen,
    [],
    `"Bilinmiyor asla 0 değildir" ihlali:\n${beklenmeyen.join("\n")}\n\n` +
      `Okunamayan bir alanı 0 saymak bu depoda DÖRT kez doğdu: okunamayan maliyet 0 raporlanır, ` +
      `ajan "harcama yok" okur ve bütçeyi artırır. Para/ölçüm okurken sayiOku ya da mikrodanTutar ` +
      `kullan (ikisi de okunamayanda undefined döner); alanı ya hiç yazma ya da metinde sayiMetni ` +
      `ile "OKUNAMADI" de. Gerçekten sayaç/varsayılan ise bu dosyadaki MUAF listesine gerekçesiyle ekle.`
  );
});

test("MUAF listesindeki her istisna hâlâ gerçek bir satırı affediyor", () => {
  const bayat = MUAF.filter(
    (m) => !SUCLULAR.some((b) => b.dosya === m.dosya && b.ifade.includes(m.ifade))
  ).map((m) => `${m.dosya} → ${m.ifade}`);
  assert.deepEqual(
    bayat,
    [],
    `Karşılığı kalmamış muafiyet(ler):\n${bayat.join("\n")}\n` +
      `Muaf tutulan kod gitmişse muafiyet de gitmeli; duran her bayat satır, bir sonraki ihlali ` +
      `sessizce affedecek açık bir kapıdır.`
  );
});

test("`?? 0` tarayıcısı bilinen kötü kalıbı yakalar, temizlere dokunmaz", () => {
  const kotu = [
    "const a = Number(row.metrics.cost_micros ?? 0) / 1e6;",
    "const b = row.clicks || 0;",
    'const c = Number(row.conversions ?? "0");',
  ].join("\n");
  assert.deepEqual(
    sifirVarsayilanlari(kotu, "kotu.ts").map((b) => b.satir),
    [1, 2, 3],
    "tarayıcı bugün kırmızı OLABİLİYOR olmalı — üç kötü kalıbın üçünü de görmeli"
  );

  const temiz = [
    "// `?? 0` was REMOVED here: it counted an unreadable budget as 0.",
    "/* mikrodanTutar bu satırdaki ?? 0 yerine geçti */",
    'const s = "x ?? 0";',
    'const t = `${row.w ?? ""}`;',
    "const d = row.z ?? 1;",
    "const e = sayiOku(row.q);",
  ].join("\n");
  assert.deepEqual(
    sifirVarsayilanlari(temiz, "temiz.ts"),
    [],
    "yorumda/dizede geçen kalıp ya da 0 olmayan varsayılan tarayıcıyı tetiklememeli"
  );
});

/* ── The sentence this file is named in ──────────────────────────────────────── */

test("src/util.ts'in 'her export'u test ediliyor' cümlesi hâlâ doğru", () => {
  // Direction 1: the claim is still on the page.
  assert.match(
    UTIL_KAYNAK,
    /Every export here is covered by a direct unit test under test\//,
    "src/util.ts başlığındaki test kapsamı cümlesi kaldırılmış ya da değiştirilmiş"
  );
  // Direction 2: the claim is still true. `setRuntimeMode` had NO test at all when this file
  // was written — that is how the older wording ("directly unit-tested in test/util.test.ts")
  // had already gone stale before anything here was added.
  const adlar = [...UTIL_KAYNAK.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
  assert.ok(adlar.length > 15, `export taraması bozuk görünüyor: ${adlar.length} ad bulundu`);
  const govde = readdirSync(join(KOK, "test"))
    .filter((ad) => ad.endsWith(".ts"))
    .map((ad) => readFileSync(join(KOK, "test", ad), "utf8"))
    .join("\n");
  // Called, not merely imported: a name that appears only in an import line proves nothing.
  const cagrilmayan = adlar.filter((ad) => !new RegExp(`\\b${ad}\\s*\\(`).test(govde));
  assert.deepEqual(
    cagrilmayan,
    [],
    `Hiçbir testte ÇAĞRILMAYAN export(lar): ${cagrilmayan.join(", ")} — ya testini yaz ya da ` +
      `src/util.ts'teki cümleyi doğru olacak şekilde düzelt.`
  );
});

test("setRuntimeMode ipucunu gerçekten moda göre değiştirir", () => {
  try {
    setRuntimeMode("hosted", "https://aegis.example/connect");
    const barindirilan = formatAdsError(new Error("invalid_grant"));
    assert.match(barindirilan, /https:\/\/aegis\.example\/connect/);
    assert.doesNotMatch(
      barindirilan,
      /npm run auth/,
      "barındırılan kullanıcının terminali yok — ona 'npm run auth' demek çalıştırılamaz bir ipucudur"
    );
    setRuntimeMode("stdio");
    assert.match(formatAdsError(new Error("invalid_grant")), /npm run auth/);
  } finally {
    setRuntimeMode("stdio");
  }
});
