// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PHASE 3 — README.md's COVERAGE NUMBERS, held to something that can contradict them.
 *
 * The audit found two things in the same paragraph of README.md:
 *
 *   1) TWO OF THE PER-AREA FLOORS WERE NOT HELD. The table says it prints what the suite is
 *      "held above", yet `tools/` claimed a function floor of 84% while `src/tools/site.ts`
 *      measured 76.92%, and `scripts/brain/` claimed 95% while `scripts/brain/ortak.mjs`
 *      measured 93.94%. A third cell was in the same state and the audit had not seen it:
 *      `approval.ts` measured 94.64% branch under a 95% floor.
 *   2) THE ALL-FILES ROW WAS STALE, and stale UPWARDS — the README printed a higher line and
 *      function figure than the runner does. That is the direction that matters: a README
 *      that undersells itself is a missed opportunity, one that oversells itself is a lie a
 *      juror finds by running the one command the README told them to run.
 *
 * WHY THIS FILE EXISTS AT ALL. Every one of those numbers rots on the next commit that adds
 * a test, and nothing in the repository was watching them: the whole suite could be rewritten
 * without a single assertion noticing that the README still described the old one.
 *
 * WHAT IT CAN AND CANNOT SEE — stated plainly, because a watcher that overstates its own
 * reach is the same defect one level up:
 *
 *   ALWAYS ON (no coverage run needed, therefore runs in CI):
 *     · the four places README.md prints the test count, and the two that print line
 *       coverage, have to agree with each other — the measured drift class is "one place
 *       updated, three forgotten";
 *     · every file the floors table and the prose name has to exist;
 *     · every per-file figure quoted in the prose has to sit ABOVE that file's own floor, so
 *       a floor cannot be raised past the text underneath it, nor a figure edited below it;
 *     · the mechanism claims are paired with the code that causes them — the README explains
 *       `src/http.ts`'s low reading by a SPAWNED server process and the Growth Brain gate by
 *       a REAL terminal-less channel, and both claims go red if that code stops being true.
 *
 *   ONLY WITH A REAL REPORT (`KAPSAM_RAPORU=<dosya>`): whether the numbers are STALE.
 *     No test can answer that from the README alone, and pretending otherwise would be the
 *     vacuum guard this project has already been burned by once. The coverage run takes
 *     minutes and would recurse into this very file, so it is not run from inside the suite;
 *     the report is handed in instead. README.md prints the two commands.
 *
 * This file imports nothing from `src/` or `scripts/` on purpose: it reads them as text. An
 * import here would execute instrumented lines and MOVE the very numbers it is checking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const KOK = fileURLToPath(new URL("../", import.meta.url));

function oku(gorece: string): string {
  return readFileSync(join(KOK, gorece), "utf8");
}

const README = oku("README.md");

/* ── Bölüm ayıklama ───────────────────────────────────────────────────────────── */

/**
 * The "### Test metrics" section only. Whole-file matching is how a doc watcher stays
 * green on a stale sentence: these words occur in half a dozen unrelated paragraphs.
 */
function bolumOku(metin: string, baslik: string): string {
  const satirlar = metin.split(/\r?\n/);
  const bas = satirlar.findIndex((s) => s.startsWith("### ") && s.includes(baslik));
  assert.notEqual(bas, -1, `README.md: "${baslik}" bölümü yok — gözcünün yolu bayatlamış`);
  const kalan = satirlar.slice(bas + 1);
  const son = kalan.findIndex((s) => s.startsWith("### ") || s.startsWith("## "));
  return (son === -1 ? kalan : kalan.slice(0, son)).join("\n");
}

const OLCUM = bolumOku(README, "Test metrics");

/* ── README'nin kendi rakamları ───────────────────────────────────────────────── */

function sayi(ham: string): number {
  return Number(ham.replace(/,/g, ""));
}

/** One capture, with a message that says which line of the README went missing. */
function tekYakala(metin: string, desen: RegExp, nerede: string): RegExpExecArray {
  const m = desen.exec(metin);
  assert.ok(m, `README.md · ${nerede} bulunamadı (aranan: ${String(desen)})`);
  return m;
}

const ROZET_TEST = tekYakala(
  README,
  /img\.shields\.io\/badge\/tests-([\d,]+)-/,
  "test sayısı rozeti"
);
const ROZET_KAPSAM = tekYakala(
  README,
  /img\.shields\.io\/badge\/line%20coverage-([\d.]+)%25-/,
  "satır kapsamı rozeti"
);
const DURUM_SATIRI = tekYakala(
  README,
  /([\d,]+) automated tests at ([\d.]+)% line coverage/,
  "Status tablosundaki test/kapsam cümlesi"
);
const GELISTIRME = tekYakala(
  README,
  /npm test\s+#\s+([\d,]+) offline tests/,
  "Development bloğundaki `npm test` yorumu"
);
const BLOK = tekYakala(
  OLCUM,
  /([\d,]+) tests · 0 failures\s+line ([\d.]+)%\s+·\s+branch ([\d.]+)%\s+·\s+function ([\d.]+)%/,
  "Test metrics kod bloğu"
);

const BEYAN = {
  testler: sayi(BLOK[1]),
  satir: Number(BLOK[2]),
  dal: Number(BLOK[3]),
  fonksiyon: Number(BLOK[4]),
} as const;

test("README'nin DÖRT yerindeki test sayısı ve İKİ yerindeki satır kapsamı birbirini tutuyor", () => {
  /**
   * The drift this catches is the ordinary one: the metrics block is updated after a round
   * of new tests and the badge — the first thing a juror sees — keeps the old figure.
   */
  const sayilar: ReadonlyArray<readonly [string, number]> = [
    ["rozet", sayi(ROZET_TEST[1])],
    ["Status satırı", sayi(DURUM_SATIRI[1])],
    ["Development bloğu", sayi(GELISTIRME[1])],
    ["Test metrics bloğu", BEYAN.testler],
  ];
  for (const [nerede, deger] of sayilar) {
    assert.equal(
      deger,
      BEYAN.testler,
      `test sayısı ayrışmış: ${nerede} ${deger}, Test metrics bloğu ${BEYAN.testler} diyor`
    );
  }

  assert.equal(
    Number(ROZET_KAPSAM[1]),
    BEYAN.satir,
    `satır kapsamı ayrışmış: rozet %${ROZET_KAPSAM[1]}, Test metrics bloğu %${BEYAN.satir}`
  );
  assert.equal(
    Number(DURUM_SATIRI[2]),
    BEYAN.satir,
    `satır kapsamı ayrışmış: Status satırı %${DURUM_SATIRI[2]}, blok %${BEYAN.satir}`
  );

  // Sanity: a percentage outside 0-100 means the parse latched onto the wrong number.
  for (const [ad, d] of Object.entries(BEYAN)) {
    if (ad === "testler") continue;
    assert.ok(d > 0 && d <= 100, `Test metrics bloğundaki ${ad} rakamı yüzde değil: ${d}`);
  }
});

/* ── Alan tabanları tablosu ───────────────────────────────────────────────────── */

interface Taban {
  readonly alan: string;
  readonly dosyalar: readonly string[];
  readonly satir: number;
  readonly dal: number;
  readonly fonksiyon: number;
}

/** "≥ 96%" and a bare "100%" both mean "not below this". */
function tabanDegeri(hucre: string): number {
  const m = /([\d.]+)\s*%/.exec(hucre);
  assert.ok(m, `taban hücresi okunamadı: "${hucre}"`);
  return Number(m[1]);
}

/**
 * The files an area row covers. A token ending in "/" is a directory and every source file
 * in it is covered — which is what makes the row go red when a new module is dropped into
 * `src/tools/` untested.
 */
function alanDosyalari(hucre: string): string[] {
  const jetonlar = [...hucre.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.ok(jetonlar.length > 0, `alan hücresinde hiç dosya adı yok: "${hucre}"`);
  const cikti: string[] = [];
  for (const jeton of jetonlar) {
    const yol = [jeton, `src/${jeton}`, `scripts/${jeton}`].find((a) =>
      existsSync(join(KOK, a))
    );
    assert.ok(
      yol,
      `README kapsam tablosu var olmayan bir yolu sayıyor: \`${jeton}\` — ` +
        `dosya taşındı ya da silindi, tablo bayat`
    );
    if (jeton.endsWith("/")) {
      const icerik = readdirSync(join(KOK, yol)).filter((d) => /\.(ts|mjs)$/.test(d));
      assert.ok(icerik.length > 0, `\`${jeton}\` dizininde kaynak dosya yok`);
      for (const d of icerik) cikti.push(`${yol.replace(/\/$/, "")}/${d}`);
    } else {
      cikti.push(yol);
    }
  }
  return cikti;
}

const TABANLAR: readonly Taban[] = (() => {
  const satirlar = OLCUM.split(/\r?\n/);
  const bas = satirlar.findIndex((s) => /^\|\s*Area\s*\|/.test(s));
  assert.notEqual(bas, -1, "README.md: alan tabanları tablosunun başlığı bulunamadı");
  const cikti: Taban[] = [];
  for (const s of satirlar.slice(bas + 2)) {
    if (!s.startsWith("|")) break;
    const hucreler = s.split("|").slice(1, -1);
    assert.equal(hucreler.length, 4, `kapsam tablosu satırı 4 hücre değil: "${s}"`);
    cikti.push({
      alan: hucreler[0].trim(),
      dosyalar: alanDosyalari(hucreler[0]),
      satir: tabanDegeri(hucreler[1]),
      dal: tabanDegeri(hucreler[2]),
      fonksiyon: tabanDegeri(hucreler[3]),
    });
  }
  return cikti;
})();

test("kapsam tablosundaki her alan gerçek dosyalara karşılık geliyor", () => {
  assert.ok(
    TABANLAR.length >= 6,
    `alan tablosunda ${TABANLAR.length} satır var, en az 6 bekleniyor — bir satır düşmüş olabilir`
  );
  for (const t of TABANLAR) {
    for (const d of t.dosyalar) {
      assert.ok(existsSync(join(KOK, d)), `${t.alan}: ${d} yok`);
    }
    for (const [ad, deger] of [
      ["satır", t.satir],
      ["dal", t.dal],
      ["fonksiyon", t.fonksiyon],
    ] as const) {
      assert.ok(
        deger > 0 && deger <= 100,
        `${t.alan}: ${ad} tabanı yüzde değil (${deger})`
      );
    }
  }
});

/* ── Düzyazıdaki dosya-başı rakamlar ──────────────────────────────────────────── */

interface DuzyaziRakam {
  readonly yol: string;
  readonly satir: number;
}

/** "`src/approval.ts` 99.77%" and "`scripts/growth-brain.mjs` sits at 59.75%". */
const DUZYAZI: readonly DuzyaziRakam[] = [
  ...OLCUM.matchAll(/`((?:src|scripts)\/[A-Za-z0-9_./-]+)`(?:\s+sits\s+at)?\s+([\d.]+)%/g),
].map((m) => ({ yol: m[1], satir: Number(m[2]) }));

test("düzyazıda anılan her dosya var ve verdiği rakam kendi tabanının ÜSTÜNDE", () => {
  /**
   * BIDIRECTIONAL, and that is the whole point: raise a floor past the sentence underneath
   * it and this goes red; edit a per-file figure below its own floor and it goes red too.
   * The stale README that started this round had `tools/` at a function floor of 84% with a
   * file measuring 76.92% — the same shape of contradiction, one table cell over.
   */
  assert.ok(
    DUZYAZI.length >= 5,
    `Test metrics bölümünde dosya-başı rakam sayısı ${DUZYAZI.length} — desen bayatlamış olabilir`
  );
  for (const r of DUZYAZI) {
    assert.ok(
      existsSync(join(KOK, r.yol)),
      `README düzyazısı var olmayan bir dosyayı anıyor: ${r.yol}`
    );
    assert.ok(r.satir > 0 && r.satir <= 100, `${r.yol}: %${r.satir} yüzde değil`);
    const taban = TABANLAR.find((t) => t.dosyalar.includes(r.yol));
    if (!taban) continue; // tabloda tabanı olmayan dosya (ör. growth-brain.mjs) — rapor kipi ölçer
    assert.ok(
      r.satir >= taban.satir,
      `README kendi kendisiyle çelişiyor: düzyazı ${r.yol} için %${r.satir} diyor, ` +
        `"${taban.alan}" satırı ise satır tabanını ≥ %${taban.satir} gösteriyor`
    );
  }
});

/* ── Belge ↔ kod: düşük rakamların GEREKÇESİ hâlâ doğru mu ────────────────────── */

test("BELGE↔KOD: http.ts'in düşük okunmasının gerekçesi (ayrı süreç) hâlâ geçerli", () => {
  /**
   * The README explains a 15% reading by saying `test/http.test.ts` drives the server as a
   * SPAWNED PROCESS, so the parent's instrumentation cannot see it. If that test is ever
   * rewritten in-process the number jumps and the explanation becomes a lie — this fails
   * from either side.
   */
  assert.match(
    OLCUM,
    /spawned server process/i,
    "README artık http.ts'in düşük kapsamını ayrı süreçle açıklamıyor — rakam açıklamasız kaldı"
  );
  const httpTesti = oku("test/http.test.ts");
  assert.match(
    httpTesti,
    /spawn\(\s*process\.execPath/,
    "test/http.test.ts artık sunucuyu ayrı süreçte başlatmıyor — README'nin gerekçesi bayat"
  );
  assert.match(
    httpTesti,
    /src\/http\.ts/,
    "test/http.test.ts artık src/http.ts'i çalıştırmıyor — README'nin gerekçesi bayat"
  );
});

test("BELGE↔KOD: Growth Brain onay kapısının nasıl sınandığı doğru anlatılıyor", () => {
  /**
   * The README used to say the gate is "tested directly through an injected stream". The
   * test file itself records that as a MEASURED SHAM: an in-memory `Readable.from` closes in
   * the same tick, so the close race answers "" and the guard stays green with the channel
   * lock deleted. The doc must not sell that back, and the code must still hold the lock.
   */
  assert.doesNotMatch(
    OLCUM,
    /injected stream|in-memory stream is what|through an injected/i,
    "README yeniden 'enjekte akış' diyor — o akış kanal kilidini göremez, ölçüldü"
  );
  assert.match(
    OLCUM,
    /real operating-system pipe/i,
    "README onay kapısının GERÇEK bir işletim sistemi borusuyla sınandığını söylemiyor"
  );

  const kapiTesti = oku("test/brain/insanKapisi.test.mjs");
  assert.match(
    kapiTesti,
    /spawn\(/,
    "test/brain/insanKapisi.test.mjs artık çocuk süreç başlatmıyor — README'nin anlattığı düzenek yok"
  );
  assert.match(
    kapiTesti,
    /growth-brain\.mjs/,
    "test/brain/insanKapisi.test.mjs artık growth-brain.mjs'i koşturmuyor"
  );
  assert.match(
    oku("scripts/growth-brain.mjs"),
    /isTTY/,
    "scripts/growth-brain.mjs'te kanal kilidi (isTTY) kalmamış — README hâlâ var diyor"
  );
});

test("BELGE↔KOD: README'nin verdiği kapsam komutu paketin gerçek test komutuyla aynı kümeyi kapsıyor", () => {
  /**
   * The all-files row only means what the README says it means if the run really includes
   * `scripts/` — the brain modules live under a third glob, and dropping it would raise the
   * average while the README kept boasting that it counts them.
   */
  assert.match(
    OLCUM,
    /--experimental-test-coverage/,
    "README artık kapsam komutunu vermiyor — 'tek komutla yeniden üretilebilir' iddiası dayanaksız"
  );
  assert.match(OLCUM, /scripts\//, "README artık scripts/'in de sayıldığını söylemiyor");

  const paket = JSON.parse(oku("package.json")) as { scripts: Record<string, string> };
  for (const desen of ["test/*.test.ts", "test/*.test.mjs", "test/brain/*.test.mjs"]) {
    assert.ok(
      paket.scripts["test"].includes(desen),
      `package.json'daki test komutu artık "${desen}" kümesini koşmuyor — ` +
        `README'nin "scripts/ da sayılıyor" cümlesi bayat`
    );
  }
});

/* ── Rapor kipi: rakamlar BAYAT MI ────────────────────────────────────────────── */

/**
 * One row of `node --test --experimental-test-coverage`'s table.
 * Paths are rebuilt from the report's own indentation: "src" › " tools" › "  site.ts".
 */
function raporuAyristir(metin: string): Map<string, { satir: number; dal: number; fonk: number }> {
  const harita = new Map<string, { satir: number; dal: number; fonk: number }>();
  const yigin: string[] = [];
  for (const ham of metin.split(/\r?\n/)) {
    const s = ham.replace(/^ℹ\s?/, "");
    if (!s.includes("|")) continue;
    const m = /^(\s*)(\S.*?)\s*\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|/.exec(s);
    if (!m) continue;
    const derinlik = m[1].length;
    const ad = m[2];
    if (ad.startsWith("-")) continue;
    if (m[3] === "" || m[4] === "" || m[5] === "") {
      yigin.length = derinlik;
      yigin.push(ad);
      continue;
    }
    const yol = derinlik === 0 ? ad : `${yigin.slice(0, derinlik).join("/")}/${ad}`;
    harita.set(yol, { satir: Number(m[3]), dal: Number(m[4]), fonk: Number(m[5]) });
  }
  return harita;
}

const RAPOR_YOLU = process.env["KAPSAM_RAPORU"];

test(
  "RAPOR KİPİ: README'nin rakamları bugünkü kapsam raporuyla birebir tutuyor",
  {
    skip: RAPOR_YOLU
      ? false
      : "KAPSAM_RAPORU verilmedi — komut README.md'nin 'Test metrics' bölümünde",
  },
  () => {
    const metin = readFileSync(String(RAPOR_YOLU), "utf8");
    const olculen = raporuAyristir(metin);
    const hepsi = olculen.get("all files");
    assert.ok(hepsi, `kapsam raporunda "all files" satırı yok: ${RAPOR_YOLU}`);

    const testSayisi = /^tests (\d+)$/m.exec(metin.replace(/^ℹ\s?/gm, ""));
    assert.ok(testSayisi, "kapsam raporunda 'tests N' özeti yok");
    assert.equal(
      BEYAN.testler,
      Number(testSayisi[1]),
      `README ${BEYAN.testler} test diyor, rapor ${testSayisi[1]} sayıyor`
    );

    // Line and function are stable run to run; the README says so and it is measured so.
    assert.equal(BEYAN.satir, hepsi.satir, `all-files SATIR: README %${BEYAN.satir}, ölçülen %${hepsi.satir}`);
    assert.equal(
      BEYAN.fonksiyon,
      hepsi.fonk,
      `all-files FONKSİYON: README %${BEYAN.fonksiyon}, ölçülen %${hepsi.fonk}`
    );
    // Branch is not: one timeout race in networkTrust.ts moves it by about a tenth of a
    // point, which the README states. A tolerance here, and nowhere else.
    assert.ok(
      Math.abs(BEYAN.dal - hepsi.dal) <= 0.5,
      `all-files DAL: README %${BEYAN.dal}, ölçülen %${hepsi.dal} — dalgalanma payının dışında`
    );

    for (const t of TABANLAR) {
      for (const d of t.dosyalar) {
        const o = olculen.get(d);
        assert.ok(o, `kapsam raporunda ${d} satırı yok — dosya hiç koşulmuyor olabilir`);
        assert.ok(o.satir >= t.satir, `${d}: satır %${o.satir} < taban %${t.satir} ("${t.alan}")`);
        assert.ok(o.dal >= t.dal, `${d}: dal %${o.dal} < taban %${t.dal} ("${t.alan}")`);
        assert.ok(
          o.fonk >= t.fonksiyon,
          `${d}: fonksiyon %${o.fonk} < taban %${t.fonksiyon} ("${t.alan}")`
        );
      }
    }

    for (const r of DUZYAZI) {
      const o = olculen.get(r.yol);
      assert.ok(o, `kapsam raporunda ${r.yol} satırı yok`);
      assert.ok(
        Math.abs(o.satir - r.satir) <= 0.05,
        `README düzyazısı ${r.yol} için %${r.satir} diyor, ölçülen %${o.satir}`
      );
    }
  }
);
