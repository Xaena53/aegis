// SPDX-License-Identifier: AGPL-3.0-only
/**
 * RUNNER COVERAGE — a test file the runner never opens is not a guard, it is a comment.
 *
 * WHY THIS EXISTS: `npm test` names its inputs as three separate globs
 * ("test/*.test.ts", "test/*.test.mjs", "test/brain/*.test.mjs"), and the only sentinel
 * standing over that line looked for ONE of them as a substring — test/derlemeGirdileri
 * .test.ts asserts `/test\/\*\.test\.mjs/` against the script. MEASURED: delete the third
 * glob and that assertion still passes, while ELEVEN files under test/brain/ stop running
 * without a word — among them the brain-side proof of the human gate (insanKapisi), of
 * go-live classification (yayin) and of report honesty (rapor). A pattern sentinel can
 * only see the pattern it was given; it cannot see what fell out of the run.
 *
 * The same hole is open forwards. MEASURED on a scratch tree with this repo's exact globs:
 * of four test files, `test/brain/c.test.ts` and `test/meta/d.test.mjs` were never picked
 * up, the other two ran, and the runner reported success. So a `.test.ts` placed next to
 * the brain tests, or any file under a new subdirectory, is silently dead on arrival.
 *
 * THEREFORE THE SENTINEL IS AN INVENTORY, NOT A PATTERN. It walks test/, collects every
 * `*.test.ts` / `*.test.mjs`, and demands that each one be matched by at least one glob on
 * the `npm test` line. It is red in BOTH directions: shrink the globs and the files that
 * fell out are named; add a test file the runner cannot reach and it is named too. A glob
 * that matches no file at all is red as well, so a stale line cannot pretend to cover
 * anything. And the walk has to find THIS file, so an inventory that silently comes back
 * empty fails instead of vouching for nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const KOK = join(import.meta.dirname, "..");
const paket = JSON.parse(readFileSync(join(KOK, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};
const KOSU = String(paket.scripts?.test ?? "");

/** This file's own path, as the inventory must report it. */
const KENDI = "test/kosucuKapsami.test.ts";

/**
 * Quoted arguments of the `npm test` line that look like a path pattern. Flags and plain
 * words (a reporter name, say) are not globs and must not be demanded to match a file.
 */
const kosucuGloblari = (): string[] =>
  [...KOSU.matchAll(/"([^"]+)"/g)]
    .map((e) => e[1] ?? "")
    .filter((s) => s.includes("/") || s.includes("*"));

const AYIRAC = "\u0000";

/**
 * Glob → RegExp. `*` stays inside one path segment and `**\/` crosses directories, so the
 * sentinel keeps telling the truth if the globs are later widened rather than replaced.
 */
const globDeseni = (g: string): RegExp =>
  new RegExp(
    "^" +
      g
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .split("**/")
        .join(AYIRAC)
        .replace(/\*/g, "[^/]*")
        .split(AYIRAC)
        .join("(?:.*/)?") +
      "$"
  );

/** Every test file that EXISTS under test/, as repo-relative POSIX paths. */
const testDosyalari = (): string[] => {
  const bulunan: string[] = [];
  const yuru = (dizin: string): void => {
    for (const girdi of readdirSync(dizin, { withFileTypes: true })) {
      const tam = join(dizin, girdi.name);
      if (girdi.isDirectory()) yuru(tam);
      else if (/\.test\.(ts|mjs)$/.test(girdi.name))
        bulunan.push(relative(KOK, tam).split("\\").join("/"));
    }
  };
  yuru(join(KOK, "test"));
  return bulunan.sort();
};

test("npm test satırı node --test ile koşar ve dosya desenlerini AÇIKÇA sayar", () => {
  assert.match(KOSU, /node\b[^"]*--test\b/, "npm test artık node --test koşmuyor — gözcü bayat");
  assert.ok(
    kosucuGloblari().length > 0,
    `npm test satırında tırnaklı dosya deseni yok: ${KOSU} — koşucunun neyi açtığı ölçülemez`
  );
});

test("test/ altındaki HER test dosyası npm test globlarından en az birine düşer", () => {
  const dosyalar = testDosyalari();

  // Vacuum guard: an inventory that comes back empty (or blind to subdirectories) would
  // vouch for everything while measuring nothing.
  assert.ok(dosyalar.includes(KENDI), `envanter kendini görmüyor (${dosyalar.length} dosya) — yürüyüş bozuk`);
  assert.ok(
    dosyalar.some((f) => f.startsWith("test/brain/")),
    "envanter alt dizinleri görmüyor — yürüyüş yalnız kökü tarıyor"
  );

  const desenler = kosucuGloblari().map(globDeseni);
  const kapsamsiz = dosyalar.filter((f) => !desenler.some((d) => d.test(f)));
  assert.deepEqual(
    kapsamsiz,
    [],
    `npm test bu test dosyalarını HİÇ koşmuyor:\n  ${kapsamsiz.join("\n  ")}\n` +
      `Koşu satırı: ${KOSU}\n` +
      "Ya glob eklensin ya dosya kapsanan bir konuma taşınsın; sessiz üçüncü seçenek yok."
  );
});

test("npm test'in her globu en az bir GERÇEK dosya eşler (bayat desen kalmaz)", () => {
  const dosyalar = testDosyalari();
  const bos = kosucuGloblari().filter((g) => {
    const d = globDeseni(g);
    return !dosyalar.some((f) => d.test(f));
  });
  assert.deepEqual(
    bos,
    [],
    `npm test satırındaki şu desen(ler) hiçbir dosyayı eşlemiyor: ${bos.join(", ")} — ` +
      "kapsıyormuş gibi duran, aslında ölü desen"
  );
});

test("beyin tarafının sözleşme gözcüleri koşucunun kapsamında", () => {
  /**
   * The human gate, the go-live classification and report honesty are asserted on the
   * brain side by these files ALONE. Naming them here makes their deletion — and their
   * dropping out of the runner — two separate, loud failures instead of a silent one.
   */
  const SOZLESME = [
    "test/brain/insanKapisi.test.mjs",
    "test/brain/yayin.test.mjs",
    "test/brain/rapor.test.mjs",
    "test/brain/uygulama.test.mjs",
  ];
  const dosyalar = testDosyalari();
  const desenler = kosucuGloblari().map(globDeseni);

  for (const ad of SOZLESME) {
    assert.ok(dosyalar.includes(ad), `${ad} yok — beyin tarafının sözleşme kanıtı silinmiş`);
    assert.ok(desenler.some((d) => d.test(ad)), `${ad} npm test globlarının dışında — sessizce koşmuyor`);
  }
});
