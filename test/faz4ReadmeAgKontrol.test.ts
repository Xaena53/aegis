// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PHASE 4 — the "N checks" sentence in BOTH READMEs, pinned to the script that runs them.
 *
 * MEASURED DRIFT: README.md said `npm run agtest` runs "twenty-two checks against Nokia's
 * live platform" and README.tr.md said "yirmi iki kontrol", while scripts/agDogrula.mts had
 * carried TWENTY-THREE `kayit()` calls since e748a23 — the commit that added the "a liveness
 * signal cannot vouch" check, whose own message already read "23/23 live CAMARA checks pass".
 * Nothing in the repository was watching that sentence, so the number could only ever have
 * been noticed by a juror counting the lines of a live run against the README.
 *
 * WHY IT IS WORTH A TEST. This is the one paragraph that tells a reader what the live run
 * proves, and the run prints its own total ("23/23 doğrulama geçti"). A README that
 * disagrees with the output of the command it just told you to type is the cheapest possible
 * way to lose the audience of a project whose entire claim is auditability.
 *
 * RED IN BOTH DIRECTIONS — this is the point, and it is the difference between a watcher and
 * a decoration:
 *   · add or delete a `kayit()` in scripts/agDogrula.mts and the two README sentences are
 *     named as stale, with the word each one should now carry;
 *   · edit either sentence away from the measured count and the same test names which
 *     language drifted;
 *   · rename the recorder (`kayit`) and the count would silently collapse to zero, which is
 *     how a guard like this becomes a vacuum — so the recorder's own definition is asserted
 *     separately, and a count of zero is a failure rather than a comparison;
 *   · put a `kayit()` call somewhere a run does not always reach — inside a branch, or under
 *     a section wrapped in `if (…) {` — and the "in one command" claim starts over-promising,
 *     so the unconditional shape of every call site is measured too, from the enclosing
 *     block openers rather than from indentation (a top-level `if (…) {` indents its body
 *     exactly like a bare `{`, which is how the indentation version of this test was walked
 *     around: measured, three green tests, a run printing 19/19 against "twenty-three").
 *
 * The sentences are read from THEIR OWN SECTION, never from the whole file: the words
 * "checks" and "kontrol" occur dozens of times in a 35 KB document, and whole-file matching
 * is exactly how a doc watcher stays green on a stale line.
 *
 * This file reads scripts/agDogrula.mts as TEXT and never imports it: the script makes live
 * Network-as-Code calls at module scope and would turn an offline unit test into a network
 * one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const KOK = fileURLToPath(new URL("../", import.meta.url));

function oku(gorece: string): string {
  return readFileSync(join(KOK, gorece), "utf8");
}

/* ── Ölçüm: scripts/agDogrula.mts kaç kontrol kaydediyor ─────────────────────── */

const BETIK = "scripts/agDogrula.mts";
/** The recorder every live check goes through; the run's total is `sonuclar.length`. */
const KAYITCI = "kayit";

/** One `kayit(...)` call site: where it is, and what encloses it. */
interface Cagri {
  readonly satir: number;
  /**
   * The trimmed text of the line each enclosing `{` was opened on, outermost first. The
   * script's shape is one bare top-level block per section, i.e. `["{"]`. An `if (…) {`
   * around a section lands here VERBATIM — which is the whole reason this is a list of
   * opener texts and not, as it used to be, a count of leading spaces: a top-level
   * `if (…) {` leaves its body at exactly the same indent as a bare `{` does, so an
   * indentation test cannot see the one mutation it was written to catch (measured).
   */
  readonly kapsayanlar: readonly string[];
  /** Whatever precedes the call on its own line — an `if (x) ` prefix shows up here. */
  readonly onEk: string;
}

interface Tarama {
  readonly cagrilar: readonly Cagri[];
  /**
   * Every brace, string, template substitution and comment closed at EOF. A scanner that
   * loses its place would under-count the call sites and read their enclosing blocks wrong,
   * and both failures are silent — so the balance is asserted rather than assumed.
   */
  readonly dengeli: boolean;
}

/** What an open `{` belongs to while scanning. */
type Cerceve =
  | { readonly tur: "blok"; readonly acilis: string }
  | { readonly tur: "ikame" }
  | { readonly tur: "sablon" };

/**
 * Whether the `/` at `i` opens a regex literal rather than being a division. The script has
 * three (`!/HU/.test(…)`), and one of them contains both a `{` and a `"`; read as code, those
 * two characters desynchronise the block stack for the rest of the file.
 */
function regexBaslangici(kaynak: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(kaynak[j] ?? "")) j--;
  return !/[A-Za-z0-9_$)\]]/.test(kaynak[j] ?? "");
}

/**
 * The `kayit(...)` CALL SITES of the script, each with the chain of blocks enclosing it.
 * Comments and string bodies are skipped on purpose: a commented-out check does not run, and
 * counting one would let the README promise a check the platform is never asked for. The
 * property-access guard keeps a hypothetical `x.kayit(...)` from being counted as this
 * recorder.
 */
function kayitCagrilari(kaynak: string): Tarama {
  const satirlar = kaynak.split("\n").map((s) => s.replace(/\r$/, ""));
  const cagrilar: Cagri[] = [];
  const yigin: Cerceve[] = [];
  let modu: "kod" | "sablon" | "tek" | "cift" | "satirYorum" | "blokYorum" | "regex" = "kod";
  let sinifta = false; // inside a [...] class of a regex, where "/" does not close it
  let satir = 1;
  let satirBasi = 0;

  for (let i = 0; i < kaynak.length; i++) {
    const c = kaynak[i] ?? "";
    const d = kaynak[i + 1] ?? "";

    if (c === "\n") {
      if (modu === "satirYorum") modu = "kod";
      satir++;
      satirBasi = i + 1;
      continue;
    }
    if (modu === "satirYorum") continue;
    if (modu === "blokYorum") {
      if (c === "*" && d === "/") {
        modu = "kod";
        i++;
      }
      continue;
    }
    if (modu === "tek" || modu === "cift") {
      if (c === "\\") i++;
      else if ((modu === "tek" && c === "'") || (modu === "cift" && c === '"')) modu = "kod";
      continue;
    }
    if (modu === "regex") {
      if (c === "\\") i++;
      else if (c === "[") sinifta = true;
      else if (c === "]") sinifta = false;
      else if (c === "/" && !sinifta) modu = "kod";
      continue;
    }
    if (modu === "sablon") {
      if (c === "\\") i++;
      else if (c === "`") {
        yigin.pop(); // the "sablon" frame this literal opened
        modu = "kod";
      } else if (c === "$" && d === "{") {
        yigin.push({ tur: "ikame" });
        modu = "kod";
        i++;
      }
      continue;
    }

    // modu === "kod"
    if (c === "/" && d === "/") {
      modu = "satirYorum";
      i++;
      continue;
    }
    if (c === "/" && d === "*") {
      modu = "blokYorum";
      i++;
      continue;
    }
    if (c === "/") {
      if (regexBaslangici(kaynak, i)) {
        modu = "regex";
        sinifta = false;
      }
      continue;
    }
    if (c === "'") {
      modu = "tek";
      continue;
    }
    if (c === '"') {
      modu = "cift";
      continue;
    }
    if (c === "`") {
      yigin.push({ tur: "sablon" });
      modu = "sablon";
      continue;
    }
    if (c === "{") {
      yigin.push({ tur: "blok", acilis: (satirlar[satir - 1] ?? "").trim() });
      continue;
    }
    if (c === "}") {
      if (yigin.pop()?.tur === "ikame") modu = "sablon";
      continue;
    }
    if (
      !/[A-Za-z0-9_$.]/.test(kaynak[i - 1] ?? "") &&
      new RegExp(`^${KAYITCI}\\s*\\(`).test(kaynak.slice(i, i + KAYITCI.length + 8))
    ) {
      cagrilar.push({
        satir,
        kapsayanlar: yigin.flatMap((f) => (f.tur === "blok" ? [f.acilis] : [])),
        onEk: kaynak.slice(satirBasi, i),
      });
    }
  }

  return { cagrilar, dengeli: yigin.length === 0 && modu === "kod" };
}

const BETIK_KAYNAK = oku(BETIK);
const TARAMA = kayitCagrilari(BETIK_KAYNAK);
const CAGRILAR = TARAMA.cagrilar;
const KONTROL_SAYISI = CAGRILAR.length;

/* ── Sayı ↔ kelime ────────────────────────────────────────────────────────────── */

const EN_BIRLER = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const EN_ONLUK: Record<number, string> = {
  10: "ten",
  11: "eleven",
  12: "twelve",
  13: "thirteen",
  14: "fourteen",
  15: "fifteen",
  16: "sixteen",
  17: "seventeen",
  18: "eighteen",
  19: "nineteen",
};
const EN_ONLAR: Record<number, string> = {
  2: "twenty",
  3: "thirty",
  4: "forty",
  5: "fifty",
  6: "sixty",
  7: "seventy",
  8: "eighty",
  9: "ninety",
};

const TR_BIRLER = ["", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"];
const TR_ONLAR: Record<number, string> = {
  1: "on",
  2: "yirmi",
  3: "otuz",
  4: "kırk",
  5: "elli",
  6: "altmış",
  7: "yetmiş",
  8: "seksen",
  9: "doksan",
};

/** 1-99 in English words ("twenty-three"); the READMEs spell the count out, not in digits. */
function enKelime(n: number): string | undefined {
  if (n < 1 || n > 99) return undefined;
  if (n < 10) return EN_BIRLER[n];
  if (n < 20) return EN_ONLUK[n];
  const on = EN_ONLAR[Math.floor(n / 10)];
  const bir = EN_BIRLER[n % 10];
  if (on === undefined) return undefined;
  return n % 10 === 0 ? on : `${on}-${bir}`;
}

/** 1-99 in Turkish words ("yirmi üç"). */
function trKelime(n: number): string | undefined {
  if (n < 1 || n > 99) return undefined;
  if (n < 10) return TR_BIRLER[n];
  const on = TR_ONLAR[Math.floor(n / 10)];
  const bir = TR_BIRLER[n % 10];
  if (on === undefined) return undefined;
  return n % 10 === 0 ? on : `${on} ${bir}`;
}

/** Word → number, built from the same tables, so the two directions cannot disagree. */
function kelimeSayi(kelime: string, dil: "en" | "tr"): number | undefined {
  const uret = dil === "en" ? enKelime : trKelime;
  const aranan = kelime.trim().toLowerCase();
  for (let n = 1; n <= 99; n++) if (uret(n) === aranan) return n;
  return undefined;
}

/* ── README bölümü ve cümlesi ─────────────────────────────────────────────────── */

/**
 * One `###` section of a README. Reading the whole file instead would make this watcher
 * unfalsifiable in practice: the sentence's words appear all over both documents.
 */
function bolum(dosya: string, baslik: string): string {
  const satirlar = oku(dosya).split(/\r?\n/);
  const bas = satirlar.findIndex((s) => s.startsWith("### ") && s.includes(baslik));
  assert.notEqual(
    bas,
    -1,
    `${dosya}: "${baslik}" bölümü bulunamadı — gözcünün yolu bayatlamış, ` +
      `başlık yeniden adlandırıldıysa bu test de güncellenmeli`
  );
  const kalan = satirlar.slice(bas + 1);
  const son = kalan.findIndex((s) => s.startsWith("### ") || s.startsWith("## "));
  return (son === -1 ? kalan : kalan.slice(0, son)).join("\n");
}

interface Duyuru {
  readonly dosya: string;
  readonly kelime: string;
  readonly sayi: number | undefined;
}

function enDuyuru(): Duyuru {
  const metin = bolum("README.md", "Live trust-chain verification");
  const m = /\b([a-z]+(?:-[a-z]+)?)\s+checks against Nokia's live platform\b/.exec(metin);
  assert.ok(
    m,
    "README.md · 'Live trust-chain verification' bölümünde \"<kelime> checks against " +
      "Nokia's live platform\" cümlesi bulunamadı — cümle yeniden yazıldıysa bu gözcü de " +
      "birlikte güncellenmeli (sessizce yeşile dönmesin diye kırmızı)"
  );
  const kelime = m[1] ?? "";
  return { dosya: "README.md", kelime, sayi: kelimeSayi(kelime, "en") };
}

function trDuyuru(): Duyuru {
  const metin = bolum("README.tr.md", "Güven zincirinin canlı doğrulaması");
  const m = /tek komutta\s+([a-zçğıöşü]+(?:\s+[a-zçğıöşü]+)?)\s+kontrol\b/u.exec(metin);
  assert.ok(
    m,
    'README.tr.md · "Güven zincirinin canlı doğrulaması" bölümünde "tek komutta <kelime> ' +
      'kontrol" cümlesi bulunamadı — cümle yeniden yazıldıysa bu gözcü de güncellenmeli'
  );
  const kelime = (m[1] ?? "").trim();
  return { dosya: "README.tr.md", kelime, sayi: kelimeSayi(kelime, "tr") };
}

/* ── Testler ──────────────────────────────────────────────────────────────────── */

test("kayıtçı hâlâ `kayit` ve sayım sıfıra çökmüş değil (gözcünün kendi tabanı)", () => {
  assert.match(
    BETIK_KAYNAK,
    new RegExp(`const\\s+${KAYITCI}\\s*=`),
    `${BETIK}: \`const ${KAYITCI} = ...\` tanımı yok. Kayıtçı yeniden adlandırıldıysa ` +
      `bu dosyadaki sayım SESSİZCE sıfıra düşer ve gözcü hiçbir şeye kefil olmadan yeşil ` +
      `kalırdı; KAYITCI sabiti yeni adla güncellenmeli.`
  );
  assert.ok(
    KONTROL_SAYISI > 0,
    `${BETIK} içinde tek bir ${KAYITCI}() çağrısı bulunamadı. Bir README rakamını sıfır ` +
      `ölçümle doğrulamak, hiçbir şey ölçmemektir.`
  );
  assert.match(
    BETIK_KAYNAK,
    /sonuclar\.length/,
    `${BETIK}: koşu kendi toplamını \`sonuclar.length\` ile basıyordu; o satır gittiyse ` +
      `ekrandaki toplam ile buradaki sayım artık aynı şeyi saymıyor olabilir.`
  );
  assert.ok(
    TARAMA.dengeli,
    `${BETIK} taranırken ayrıştırıcı yerini kaybetti (dosya sonunda açık blok/dize/yorum ` +
      `kaldı). Bu sessiz bir arıza olurdu: eksik sayılan çağrılar ve yanlış okunan ` +
      `kapsayıcılar. Betikte alışılmadık bir sözdizimi (ör. yeni bir regex ya da iç içe ` +
      `şablon) varsa kayitCagrilari() onu tanıyacak biçimde genişletilmeli.`
  );
});

test("`npm run agtest`'in kontrol sayısı iki README'de de doğru yazıyor (TR/EN parite)", () => {
  const en = enDuyuru();
  const tr = trDuyuru();

  const beklenenEn = enKelime(KONTROL_SAYISI);
  const beklenenTr = trKelime(KONTROL_SAYISI);
  assert.ok(
    beklenenEn && beklenenTr,
    `${KONTROL_SAYISI} sayısı kelime tablosunun (1-99) dışında — tablo genişletilmeli`
  );

  for (const [duyuru, beklenen] of [
    [en, beklenenEn],
    [tr, beklenenTr],
  ] as const) {
    assert.equal(
      duyuru.sayi,
      KONTROL_SAYISI,
      `${duyuru.dosya} "${duyuru.kelime}" diyor, ${BETIK} ise ${KONTROL_SAYISI} kontrol ` +
        `koşuyor (${KAYITCI}() çağrıları: ${CAGRILAR.map((c) => c.satir).join(", ")}). ` +
        `Jüri komutu koşup "${KONTROL_SAYISI}/${KONTROL_SAYISI} doğrulama geçti" görecek; ` +
        `cümle "${beklenen}" demeli.`
    );
  }

  assert.equal(
    en.sayi,
    tr.sayi,
    `İki README farklı sayı duyuruyor (EN "${en.kelime}", TR "${tr.kelime}") — biri ` +
      `ölçümle güncellenip diğeri unutulmuş.`
  );
});

test("her kontrol koşulsuz koşuyor, yani 'tek komutta N kontrol' fazla söz vermiyor", () => {
  /**
   * The claim both READMEs make is a FLAT count for a SINGLE run. A `kayit()` reached only
   * on some paths breaks it in either direction — fewer checks than promised on one run, or
   * the same check counted twice — and the count above cannot see that.
   *
   * WHAT THIS USED TO MEASURE, AND WHY THAT WAS NOT ENOUGH: it counted leading spaces and
   * called anything past one indent level "nested". Measured: turning the Q4 section's bare
   * `{` into `if (process.env.AEGIS_Q4) {` leaves its four checks at the very same indent,
   * so all three tests stayed green while a real run printed 19/19 and both READMEs still
   * said twenty-three. The shape is read from the code now, not from the whitespace: each
   * call must sit in exactly ONE enclosing block, that block's opener must be a bare `{`,
   * and nothing may precede the call on its own line (`if (x) kayit(...)` is the same
   * defect written differently).
   */
  const sartli = CAGRILAR.filter(
    (c) => c.kapsayanlar.length !== 1 || c.kapsayanlar[0] !== "{" || c.onEk.trim() !== ""
  );
  assert.deepEqual(
    sartli.map((c) => `${BETIK}:${c.satir} → ${[...c.kapsayanlar, `${c.onEk.trim()}…`].join(" › ")}`),
    [],
    `${BETIK}: bu ${KAYITCI}() çağrılarına her koşuda varılmıyor — yukarıda listelenen ` +
      `kapsayıcı satır(lar) çıplak bir "{" değil, ya da çağrının önünde bir koşul var. ` +
      `Koşullu bir kontrol her koşuda çalışmaz; iki README'nin "tek komutta ` +
      `${KONTROL_SAYISI} kontrol" cümlesi o anda gerçekten koşan sayıdan fazlasını vaat ` +
      `etmeye başlar. Ya çağrı koşulsuz en üst seviye bloğa çıkarılmalı, ya iki cümle de ` +
      `kontrolün koşullu olduğunu söylemeli.`
  );
});
