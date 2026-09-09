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
 *   · nest a `kayit()` call inside a branch and the "in one command" claim would start
 *     over-promising, so the flat, unconditional shape of the call sites is measured too.
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

/** One `kayit(...)` call site: which line it is on and how deep it sits. */
interface Cagri {
  readonly satir: number;
  readonly girinti: number;
}

/**
 * The `kayit(...)` CALL SITES of the script — comments excluded on purpose. A commented-out
 * check does not run, and counting one would let the README promise a check the platform is
 * never asked for. The property-access guard (`[^A-Za-z0-9_$.]`) keeps a hypothetical
 * `x.kayit(...)` from being counted as this recorder.
 */
function kayitCagrilari(kaynak: string): Cagri[] {
  const cagrilar: Cagri[] = [];
  const satirlar = kaynak.split(/\r?\n/);
  let blokYorumda = false;
  for (let i = 0; i < satirlar.length; i++) {
    const satir = satirlar[i] ?? "";
    const kirpik = satir.trim();
    if (blokYorumda) {
      if (kirpik.includes("*/")) blokYorumda = false;
      continue;
    }
    if (kirpik.startsWith("/*")) {
      if (!kirpik.includes("*/")) blokYorumda = true;
      continue;
    }
    if (kirpik.startsWith("//") || kirpik.startsWith("*")) continue;
    if (!new RegExp(`(^|[^A-Za-z0-9_$.])${KAYITCI}\\s*\\(`).test(satir)) continue;
    cagrilar.push({ satir: i + 1, girinti: (satir.match(/^ */)?.[0] ?? "").length });
  }
  return cagrilar;
}

const BETIK_KAYNAK = oku(BETIK);
const CAGRILAR = kayitCagrilari(BETIK_KAYNAK);
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
   * The claim both READMEs make is a FLAT count for a SINGLE run. A `kayit()` nested inside
   * a branch or a loop would break that in either direction — fewer checks than promised on
   * one path, or the same check counted twice — and the count above cannot see it. The
   * script keeps every call site inside a top-level block, i.e. at most one indent level.
   */
  const nested = CAGRILAR.filter((c) => c.girinti > 2);
  assert.deepEqual(
    nested.map((c) => c.satir),
    [],
    `${BETIK}: bu satırlardaki ${KAYITCI}() çağrıları bir dal/döngü içine girmiş. ` +
      `İçeri girmiş bir kontrol her koşuda çalışmaz; iki README'nin "tek komutta ` +
      `${KONTROL_SAYISI} kontrol" cümlesi o anda gerçekten koşan sayıdan fazlasını vaat ` +
      `etmeye başlar. Ya çağrı en üst seviyeye çıkarılmalı, ya cümle koşullu olduğunu ` +
      `söylemeli.`
  );
});
