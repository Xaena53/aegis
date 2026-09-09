// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ROUND-2 REPAIR REGRESSION TESTS — scripts/brain/uygulama.mjs
 *
 * The round-1 repair made the silently dropped display path (yol1/yol2) audible by pushing a
 * warning onto uygulamaSonucu.uyarilar, and then documented that warning with a sentence that
 * was NOT true: "the warning travels to the terminal and into the report". Measured: uygula()
 * writes zero bytes to stdout AND stderr, scripts/brain/uygulama.mjs makes no terminal write at
 * all, and uygulamaSonucu.uyarilar has exactly ONE production reader — scripts/brain/rapor.mjs,
 * which prints it into the report FILE. scripts/growth-brain.mjs prints the report's path, never
 * its warnings.
 *
 * A comment that promises a surface the code never writes to is the same class of defect the
 * warning itself exists to close: an audit trail claiming something that never happened. An
 * operator who trusts it watches the screen, sees no warning, and concludes there is none.
 *
 * ROUND-4 NARROWING. The first test used to CLAIM "a print added anywhere in the module's import
 * graph is caught too" while asserting only that stdout was empty; stderr was scanned for a
 * single warning-shaped regex and nothing else. The hole was measured: a bare
 * `process.stderr.write("[uygulama] gorunen yol dusuruldu")` left every test of this pair green,
 * and the sibling source guard missed it too because it looked only for `console.`. A watchdog
 * may not promise more than it measures, so the measurement was widened to match the promise
 * rather than the promise trimmed: BOTH streams must be empty, the forbidden-write family now
 * covers `process.stdout/stderr.write` and `process.emitWarning`, and each guard carries a
 * fixture proving it actually turns red (no production file is mutated for that proof).
 *
 * The tests below nail the pair the comment now describes:
 *  1) the module is SILENT on both terminal streams (measured in a child process, not grepped),
 *  2) that measurement can really fail — a byte written to either stream is seen,
 *  3) the warning really does reach the report through raporOlustur(),
 *  4) the source carries no claim of terminal delivery, and the "no terminal write" fact that
 *     makes such a claim false is pinned, so adding a print forces the comment to be revisited.
 *
 * No network, no environment variables, no real tool: `cagir` is a local stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
/*
 * uygulama.mjs and rapor.mjs are plain JavaScript and tsconfig.json does not set allowJs, so
 * TypeScript has no declaration for them (TS7016). The tests drive the REAL modules at runtime;
 * a hand-written .d.mts twin would be a second copy of the contract that could drift from it.
 */
// @ts-expect-error TS7016 — untyped .mjs module, imported deliberately.
import { uygula } from "../scripts/brain/uygulama.mjs";
// @ts-expect-error TS7016 — untyped .mjs module, imported deliberately.
import { raporOlustur } from "../scripts/brain/rapor.mjs";

const UYGULAMA_YOLU = new URL("../scripts/brain/uygulama.mjs", import.meta.url);

/** The server's affirmative sentences, verbatim enough for BASARI_IZLERI to match. */
const SAHTE_YANITLAR: Record<string, string> = {
  run_gaql: "0 satır",
  create_search_campaign:
    "Kampanya PAUSED olarak oluşturuldu: customers/1234567890/campaigns/5550001 · " +
    "reklam grubu customers/1234567890/adGroups/7770001",
  add_keywords: "3 anahtar kelime eklendi [EXACT]",
  add_campaign_negative_keywords: "2 anahtar kelime KAMPANYA seviyesinde eklendi [PHRASE]",
  create_responsive_search_ad: "RSA oluşturuldu: customers/1234567890/ads/9990001",
};

/** A plan/creative pair whose ONLY notable feature is a display path that cannot be applied. */
const GIRDI = {
  plan: {
    kampanyaAdi: "Kahve Kampanyası",
    butceGunlukTL: 100,
    hedefUlke: "TR",
    adGruplari: [{ ad: "Grup 1", anahtarKelimeler: ["kahve"], eslesmeTipi: "PHRASE" }],
  },
  kreatif: {
    basliklar: ["Başlık A", "Başlık B", "Başlık C"],
    aciklamalar: ["Açıklama bir", "Açıklama iki"],
    yol1: "kurumsal",
    yol2: "fiyatlar",
  },
  musteriId: "1234567890",
  finalUrl: "https://ornek.test/kahve",
};

/**
 * The dropped-path warning. rapor.mjs escapes markdown metacharacters, so the parentheses
 * arrive as \\( \\) in the report; the optional backslashes let ONE pattern match
 * both the raw warning and the rendered report.
 */
const YOL_UYARISI = /Görünen yol \\?\(yol1\/yol2\\?\) UYGULANMADI/u;

type TerminalOlcumu = {
  readonly stdout: string;
  readonly stderr: string;
  readonly uyarilar: readonly string[];
};

/**
 * Runs `uygula()` from `modulHref` inside a real child `node` process and hands back BOTH raw
 * terminal streams together with the warnings the call returned.
 *
 * A child process rather than a stubbed console: this reads the REAL file descriptors of a real
 * run, so a print added anywhere in the module's import graph shows up here — but only because
 * the caller now asserts on both streams. The helper deliberately asserts nothing about the
 * streams itself; that is the caller's job, which is what lets the fixture below feed it a
 * module that DOES write and check that the measurement notices.
 */
function terminalOlc(modulHref: string): TerminalOlcumu {
  const dizin = mkdtempSync(join(tmpdir(), "aegis-uyari-"));
  const cikti = join(dizin, "uyarilar.json");
  const betik =
    `import { writeFileSync } from "node:fs";\n` +
    `import { uygula } from ${JSON.stringify(modulHref)};\n` +
    `const yanitlar = ${JSON.stringify(SAHTE_YANITLAR)};\n` +
    `const sonuc = await uygula(${JSON.stringify(GIRDI)}, ` +
    `{ cagir: async (arac) => yanitlar[arac] ?? "(boş yanıt)" });\n` +
    `writeFileSync(${JSON.stringify(cikti)}, JSON.stringify(sonuc.uyarilar), "utf8");\n`;

  try {
    const kosum = spawnSync(process.execPath, ["--input-type=module", "-e", betik], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(kosum.status, 0, `Alt süreç başarısız: ${kosum.stderr}`);
    const uyarilar: string[] = JSON.parse(readFileSync(cikti, "utf8"));
    return { stdout: kosum.stdout, stderr: kosum.stderr, uyarilar };
  } finally {
    rmSync(dizin, { recursive: true, force: true });
  }
}

test("ONARIM 1: uygula() terminale TEK BAYT yazmaz — uyarı yalnızca dönüş değerinde taşınır", () => {
  const olcum = terminalOlc(UYGULAMA_YOLU.href);

  assert.equal(
    olcum.stdout,
    "",
    `uygula() stdout'a yazdı — modül sessiz değilse 'terminale ulaşmaz' cümlesi bayatlar. ` +
      `(gelen: ${JSON.stringify(olcum.stdout)})`
  );
  /*
   * The half that used to be missing. stderr was searched only for YOL_UYARISI, so any other
   * print — the measured `process.stderr.write("[uygulama] gorunen yol dusuruldu")` included —
   * passed unseen while the docblock claimed every print was caught. "Not a single byte" is now
   * measured the way it is written.
   */
  assert.equal(
    olcum.stderr,
    "",
    `uygula() stderr'e yazdı — 'TEK BAYT yazmaz' başlığı ve kaynaktaki 'terminale ulaşmaz' ` +
      `cümlesi artık yanlış. (gelen: ${JSON.stringify(olcum.stderr)})`
  );

  assert.ok(
    olcum.uyarilar.some((u) => YOL_UYARISI.test(u)),
    "Uyarı dönüş değerinde de yok — düşürme yeniden SESSİZ hale gelmiş demektir."
  );
});

/**
 * Writes a temporary module that forwards to the real `uygula` after emitting one byte on the
 * requested stream. The production file is never touched: a mutation proof that edited
 * scripts/brain/uygulama.mjs would race any other change in flight over the same file.
 */
function konusanModul(dizin: string, akis: "stdout" | "stderr"): string {
  const yol = join(dizin, `konusan-${akis}.mjs`);
  writeFileSync(
    yol,
    `import { uygula as gercek } from ${JSON.stringify(UYGULAMA_YOLU.href)};\n` +
      `export async function uygula(girdi, secenekler) {\n` +
      `  process.${akis}.write("[uygulama] gorunen yol dusuruldu");\n` +
      `  return gercek(girdi, secenekler);\n` +
      `}\n`,
    "utf8"
  );
  return pathToFileURL(yol).href;
}

test("gözcü gerçekten kırmızıya düşebiliyor: iki akışa da yazılan bayt ÖLÇÜMDE görünüyor", () => {
  /*
   * The measured escape, kept as a fixture. `process.stderr.write("[uygulama] gorunen yol
   * dusuruldu")` used to leave all nine tests of this pair green, because only stdout was
   * asserted empty and stderr was matched against one warning-shaped regex. If the assertions
   * above are ever narrowed back to stdout, this test shows the stream that would go unwatched
   * still carries the byte — the guard's reach is measured, not promised in a comment.
   */
  const dizin = mkdtempSync(join(tmpdir(), "aegis-konusan-"));
  try {
    const stdoutOlcumu = terminalOlc(konusanModul(dizin, "stdout"));
    assert.notEqual(stdoutOlcumu.stdout, "", "stdout'a yazılan bayt ölçümde görünmüyor");

    const stderrOlcumu = terminalOlc(konusanModul(dizin, "stderr"));
    assert.notEqual(
      stderrOlcumu.stderr,
      "",
      "stderr'e yazılan bayt ölçümde görünmüyor — ölçülen kaçış geri gelmiş"
    );
    assert.equal(
      YOL_UYARISI.test(stderrOlcumu.stderr),
      false,
      "fikstür, eski gözcünün stderr'de TEK aradığı kalıba takılmamalı: kaçışın sebebi buydu"
    );
    assert.equal(
      stderrOlcumu.stdout,
      "",
      "fikstür yalnız stderr'e yazmalı — aksi halde iki akışın ayrı ayrı ölçüldüğü kanıtlanmaz"
    );
  } finally {
    rmSync(dizin, { recursive: true, force: true });
  }
});

test("ONARIM 1: uyarının TEK okuyucusu rapor.mjs — cümle gerçekten raporda çıkıyor", async () => {
  const sonuc = await uygula(GIRDI, {
    cagir: async (arac: string) => SAHTE_YANITLAR[arac] ?? "(boş yanıt)",
  });

  const rapor: string = raporOlustur({
    hedef: "kahve satışı",
    plan: GIRDI.plan,
    kreatif: GIRDI.kreatif,
    uygulamaSonucu: sonuc,
    kuruMod: false,
  });

  assert.ok(rapor.includes("**Uyarılar:**"), "Raporda uyarı bölümü yok.");
  /*
   * rapor.mjs escapes markdown metacharacters, so the parentheses arrive as \( \); the regex
   * deliberately matches the SENTENCE, not the exact bytes.
   */
  assert.ok(
    YOL_UYARISI.test(rapor),
    "Uyarı rapora ulaşmıyor — uygulama.mjs'deki 'rapor.mjs bunu basar' cümlesi yanlış olurdu."
  );
});

/**
 * Every route this module could take to a terminal, not just `console.`.
 *
 * The old guard listed one of them and the gap was measured: `process.stderr.write` walked past
 * it. A source scan that covers less than the runtime measurement above lets the comment drift
 * back the day someone prints without touching `console`.
 */
const TERMINAL_YAZIMLARI: readonly RegExp[] = [
  /\bconsole\s*\./u,
  /\bprocess\s*\.\s*(stdout|stderr)\s*\.\s*write\b/u,
  /\bprocess\s*\.\s*emitWarning\b/u,
];

/** The first terminal-write trace in a piece of source, if there is one. */
const terminalYazimi = (kaynak: string): RegExp | undefined =>
  TERMINAL_YAZIMLARI.find((desen) => desen.test(kaynak));

test("ONARIM 1: kaynak, uyarının terminale ulaştığını İDDİA ETMEZ", () => {
  const kaynak = readFileSync(new URL(UYGULAMA_YOLU), "utf8");

  /*
   * The claim family, not one phrasing: any sentence that puts a warning and the terminal on
   * the same delivery path. [^.] keeps a match inside a single sentence.
   */
  const YASAK_IDDIALAR = [
    /(warning|uyar[ıi])[^.]{0,200}travels?[^.]{0,60}terminal/iu,
    /(warning|uyar[ıi])[^.]{0,200}\b(reach|reaches|go|goes|arrives?|lands?|prints?)\b[^.]{0,60}terminal/iu,
    /(warning|uyar[ıi])[^.]{0,200}terminale[^.]{0,60}(gider|ula[şs])/iu,
  ];
  for (const desen of YASAK_IDDIALAR) {
    const eslesme = desen.exec(kaynak);
    assert.equal(
      eslesme,
      null,
      `Kaynak, uyarının terminale ulaştığını iddia ediyor: ${JSON.stringify(eslesme?.[0])}`
    );
  }

  /*
   * ...and the fact that makes such a claim false. The module reaches no terminal stream by any
   * route; the day one is added this test goes red, which is the moment the comment has to be
   * rewritten rather than silently drifting again.
   */
  const yazim = terminalYazimi(kaynak);
  assert.equal(
    yazim,
    undefined,
    `Modül artık terminale yazıyor (${yazim}) — 'terminale ulaşmaz' yorumu bayatladı, güncellenmeli.`
  );
});

test("kaynak gözcüsü eş anlamlıyı da yakalıyor — 'process.stderr.write' kaçmıyor", () => {
  /*
   * The other half of the measured escape: the source guard used to see only `console.`, so the
   * same stderr write that slipped past the runtime measurement slipped past the grep as well.
   * Both lists are fixtures, so the family cannot be quietly narrowed back to one pattern.
   */
  const YAKALANMALI = [
    'console.log("x")',
    "console . error(hata)",
    'process.stdout.write("x")',
    'process.stderr.write("[uygulama] gorunen yol dusuruldu")',
    'process.emitWarning("x")',
  ];
  for (const ornek of YAKALANMALI) {
    assert.notEqual(
      terminalYazimi(ornek),
      undefined,
      `terminale yazan çağrı kalıpların hiçbirine takılmıyor: ${JSON.stringify(ornek)}`
    );
  }

  const YAKALANMAMALI = [
    "// uyarı terminale ulaşmaz; yalnızca dönüş değerinde taşınır",
    "const consoleLike = 1;",
    "sonuc.uyarilar.push(uyari);",
    "const process_stdout = false;",
  ];
  for (const ornek of YAKALANMAMALI) {
    assert.equal(
      terminalYazimi(ornek),
      undefined,
      `terminale yazmayan satır yazım sayıldı: ${JSON.stringify(ornek)} — kurt masalı anlatan ` +
        `gözcü görmezden gelinir`
    );
  }
});
