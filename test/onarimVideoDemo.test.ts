// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Regression cover for the JURY VIDEO's refusal screen (scripts/video-demo.mts).
 *
 * The defect: the refusal screen printed
 *
 *     elicitation prompts shown: 0
 *     campaign state:            unchanged
 *
 * in the shape of a measurement, while both values were literals typed between quotes. The
 * script calls `agDogrula` directly — no MCP client, no elicitation handler, no write tool —
 * so it can neither count a prompt nor read a campaign's state back. The repo is public and
 * the deck links to it: a jury opening the file would find the "measurement" hard-coded, and
 * that one discovery discredits every other number in the video. The real counting exists
 * (scripts/demo-senaryo.mjs throws if a prompt is ever shown on a refusal); it just was not
 * the thing on screen.
 *
 * Testing this file cannot be done by importing it: video-demo.mts is an ENTRY POINT that
 * runs the demo and makes real CAMARA calls on import (that is why the fixed strings live in
 * scripts/video-metin.mts). So the watchdog reads the SOURCE — and it reads BOTH ends:
 *
 *  1. while the script owns no counter, it may not print a counter-shaped claim;
 *  2. the command it names on screen instead must really do that counting.
 *
 * Point 2 matters as much as point 1: replacing a fabricated measurement with a pointer to a
 * command that does not measure would be the same lie one level down.
 *
 * ROUND-4 NARROWING — THE SCAN NOW READS THE SCREEN, NOT THE SOURCE BYTES. Every line of this
 * screen is assembled from concatenated colour helpers (`"  " + kalin("state: ") + yesil("x")`),
 * and the guard matched raw source text, where a quote sits between the label and the value.
 * Measured: putting the fabrication back the way the file actually writes lines —
 * `console.log("    " + kalin("elicitation prompts displayed: ") + "0")` — left all ten tests of
 * this pair green, even though the single-literal spelling was caught. A watchdog that only
 * catches the tidy spelling of a defect is not watching the defect. String concatenation is now
 * collapsed first, so what is scanned is the line the jury sees.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const oku = (gorece: string): string =>
  readFileSync(new URL(gorece, import.meta.url), "utf8");

const KAYNAK = oku("../scripts/video-demo.mts");
const DEMO_KAYNAK = oku("../scripts/demo-senaryo.mjs");
const PAKET = JSON.parse(oku("../package.json")) as { scripts?: Record<string, string> };

/**
 * Comments are stripped: this watchdog judges what the script PRINTS, not what it explains
 * about itself. The fix's own comment quotes the removed line verbatim, and a scan that
 * could not tell the two apart would turn every honest explanation into a failure.
 */
const koduAyikla = (kaynak: string): string =>
  kaynak.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/**
 * Collapses `" + helper("` chains so two adjacent literals become the ONE line they print.
 *
 * The screen is built as `"    " + kalin("label: ") + yesil(kalin("value"))`; scanning that
 * verbatim, no pattern can ever span from the label to the value, because a quote, a plus and a
 * function name sit between them. Joining them is what turns a source scan into a screen scan.
 *
 * It cannot hide anything either: the patterns below all exclude quotes from their character
 * classes, so no match can contain the punctuation this removes — anything the raw source would
 * have matched still matches after the join.
 */
const ekranMetni = (kod: string): string =>
  kod.replace(/"[)\s]*\+\s*(?:[A-Za-z_$][\w$]*\s*\(\s*)*"/gu, "");

const KOD = koduAyikla(KAYNAK);

/**
 * EVERYTHING THE REFUSAL SCREEN SHOWS, not just the entry point.
 *
 * The English refusal block is printed from `INGILIZCE_RET` in scripts/video-metin.mts (the
 * strings live there because importing video-demo.mts would run the demo and hit the real
 * network). A guard that read only video-demo.mts could be sidestepped by putting the
 * fabricated line in the other file and printing it from here — same screen, same jury, no
 * watchdog.
 */
const EKRAN = ekranMetni(KOD + "\n" + koduAyikla(oku("../scripts/video-metin.mts")));

/** Traces of a real measurement: an elicitation actually requested, handled or counted. */
const SAYAC_KANITI = [/elicitInput/u, /ElicitRequestSchema/u, /setRequestHandler/u, /onayAl\s*\(/u];

/**
 * A NUMBER OF PROMPTS presented as an observation of the run — the SHAPE, not four spellings.
 *
 * An older version listed four fixed phrasings ("prompts shown", "prompt count", "elicitations
 * counted", "istem sayısı") and the hole was MEASURED: putting the removed fabrication back one
 * synonym away — `elicitation prompts displayed: 0` — left every test in this file green. A
 * synonym must not retire a watchdog, so what is matched now is the shape a counter takes: a
 * prompt noun tied to a quantity (`: 0`, `= 0`, `: none`), a number in front of it, or counting
 * vocabulary next to it. The patterns run over `ekranMetni()` output, so the label and the value
 * meet even when the source spells them as two concatenated literals.
 *
 * What is deliberately NOT matched: sentences that make a QUALITATIVE claim ("the approval
 * prompt was never shown", "approval prompt: never reached") or that point at the command
 * which does the counting ("counts the approval prompts and fails if one is ever shown").
 * The first two are backed elsewhere — test/onarim2VideoDemo.test.ts pins them to
 * src/approval.ts's ordering — and banning them here would only teach the team to ignore
 * this guard. The fixtures below hold both lists so the line between them stays measurable.
 */
const SAYAC_IDDIASI: readonly RegExp[] = [
  /\b(prompt|elicitation|istem)\w*\b[^\n"'`]{0,40}[:=]\s*(\d|none\b|zero\b|nil\b|sıfır|hiçbiri|yok\b)/iu,
  /\b\d+\s+(approval\s+|elicitation\s+)?(prompt|istem)\w*/iu,
  /\b(prompt|elicitation|istem)\w*\b[^\n"'`]{0,20}\b(count|counts|counted|tally|tallied|sayısı|sayisi|adedi)\b/iu,
  /\b(number|count|tally|toplam|sayı|adet)\w*\s+of\s+(the\s+)?(approval\s+|elicitation\s+)?(prompt|istem)/iu,
];

/** The first counter-shaped claim in a piece of screen text, if there is one. */
const sayacIddiasi = (metin: string): RegExp | undefined =>
  SAYAC_IDDIASI.find((iddia) => iddia.test(metin));

/** Source in, verdict out: the same two steps the test above runs, for the fixtures below. */
const kaynaktaSayacIddiasi = (kaynak: string): RegExp | undefined =>
  sayacIddiasi(ekranMetni(koduAyikla(kaynak)));

test("KRİTİK: sayacı olmayan ekran, sayaç biçiminde bir iddia basmıyor", () => {
  /**
   * The invariant is conditional, not a blanket ban on the words. If the script one day
   * really instruments an elicitation (option (a) of the finding: drive the server over MCP
   * and count), the premise falls away and it may print the number it measured — the guard
   * lifts itself. What may never happen is the claim WITHOUT the measurement.
   */
  const olcuyor = SAYAC_KANITI.some((k) => k.test(KOD));
  if (olcuyor) return;

  const iddia = sayacIddiasi(EKRAN);
  assert.equal(
    iddia,
    undefined,
    `video-demo.mts hiçbir istem saymıyor (MCP istemcisi, elicitation handler'ı yok) ama ` +
      `ekrana sayaç biçiminde bir iddia basıyor: ${iddia}. Sabit "0"ı jüriye ölçüm diye gösterme.`
  );
});

test("gözcü ŞU AN SİLAHLI: premis hâlâ doğru — script gerçekten saymıyor", () => {
  /**
   * The guard above lifts itself when the script starts counting. That is right when the
   * counting is real and a silent hole if the premise is merely BRUSHED — a rename, an
   * unrelated `setRequestHandler`, a copied line — so the armed state is pinned here rather
   * than left to chance. If video-demo.mts is ever rebuilt to drive the server over MCP and
   * count for real, this is the deliberate place to record that decision.
   */
  const kanit = SAYAC_KANITI.find((k) => k.test(KOD));
  assert.equal(
    kanit,
    undefined,
    `video-demo.mts artık bir sayım izi taşıyor (${kanit}). Gerçekten sayıyorsa yukarıdaki ` +
      `gözcü kendini kaldırdı: bu testi bilerek güncelle ve ekrandaki sayının ÖLÇÜLDÜĞÜNÜ ` +
      `kanıtlayan bir gözcü koy. Taşımıyorsa izi kaldır.`
  );
});

test("KRİTİK: kalıp ailesi eş anlamlıyı da yakalıyor — 'displayed: 0' kaçmıyor", () => {
  /**
   * The mutation that exposed the phrase-list guard, kept as a fixture: the fabricated line and
   * the synonyms it can be spelled with must all be caught, and the honest sentences currently
   * on screen must all pass. Without this pair the family could be quietly narrowed back to four
   * literals and nothing would notice.
   */
  const SAYAC_CUMLELERI = [
    "elicitation prompts shown: 0",
    "elicitation prompts displayed: 0",
    "prompts surfaced: 0",
    "prompts shown: none",
    "prompt count: 0",
    "elicitations counted: 0",
    "istem sayısı: 0",
    "0 approval prompts were shown",
    "elicitation prompts raised = 0",
    "number of prompts observed in this run",
    "onay istemi adedi bu koşuda",
  ];
  for (const cumle of SAYAC_CUMLELERI) {
    assert.notEqual(
      sayacIddiasi(cumle),
      undefined,
      `sayaç biçimli iddia kalıpların hiçbirine takılmıyor: ${JSON.stringify(cumle)} — ` +
        `ölçüm yapmadan sayı gösteren bir ekran gözcüsüz geri gelebilir.`
    );
  }

  const DURUST_CUMLELER = [
    "  REFUSED — the approval prompt was never shown  ",
    "approval prompt: never reached",
    "the refusal returns before any prompt",
    "MCP, counts the approval prompts and fails if one is ever shown.",
    "campaign state:  untouched",
  ];
  for (const cumle of DURUST_CUMLELER) {
    assert.equal(
      sayacIddiasi(cumle),
      undefined,
      `nitel (sayısız) cümle sayaç iddiası sayıldı: ${JSON.stringify(cumle)} — kurt masalı ` +
        `anlatan gözcü görmezden gelinir; bu cümleler onarim2VideoDemo.test.ts'te ayrıca çivili.`
    );
  }
});

test("KRİTİK: gözcü KAYNAK BİÇİMİNE bağlı değil — parçalara bölünmüş satır da yakalanıyor", () => {
  /**
   * The measured escape, kept as a fixture. Every line of this screen is written as
   * `"  " + kalin("label: ") + renk("value")`, so the fabrication's NATURAL spelling in this
   * file splits the label from the value across a quote — and the phrase-family guard, which
   * matched raw source, walked right past it while catching the single-literal spelling. These
   * are the shapes as they would really be typed here.
   */
  const KAYNAK_BICIMLERI = [
    'console.log("    elicitation prompts displayed: 0");',
    'console.log("    " + kalin("elicitation prompts displayed: ") + "0");',
    'console.log("    " + kalin("elicitation prompts shown: ") + kirmizi(kalin("0")));',
    'console.log("  " + kalin("istem sayısı: ") + yesil("0"));',
    'satirlar.push("    " + kalin("prompt count: ") + gri("0"));',
  ];
  for (const kaynak of KAYNAK_BICIMLERI) {
    assert.notEqual(
      kaynaktaSayacIddiasi(kaynak),
      undefined,
      `parçalara bölünmüş sayaç satırı kaçıyor: ${JSON.stringify(kaynak)} — ekranda birleşen ` +
        `iddia, kaynakta tırnakla ayrıldığı için görünmez oluyor.`
    );
  }

  /** ...and the honest lines this file really prints must survive the same joining. */
  const DURUST_BICIMLER = [
    'console.log("    " + kalin("approval prompt: ") + kirmizi(kalin("never reached")) + gri("   the refusal returns before any prompt"));',
    'console.log("    " + kalin("campaign state:  ") + yesil(kalin("untouched")) + gri("       this script calls no write tool"));',
    'console.log(gri("    MCP, counts the approval prompts and fails if one is ever shown."));',
  ];
  for (const kaynak of DURUST_BICIMLER) {
    assert.equal(
      kaynaktaSayacIddiasi(kaynak),
      undefined,
      `birleştirme dürüst satırı sayaç iddiasına çevirdi: ${JSON.stringify(kaynak)} — yanlış ` +
        `alarm veren gözcü kapatılır.`
    );
  }
});

test("ekran, sayımın GERÇEKTEN yapıldığı komutu adıyla veriyor", () => {
  assert.match(
    KOD,
    /npm run demo/u,
    "ret ekranı, istemleri fiilen sayan komutu (`npm run demo`) adlandırmalı — " +
      "aksi halde 'sayılmadı' bilgisi de ekranda hiç yok."
  );
});

test("KRİTİK: adı verilen komut gerçekten sayıyor ve sayı 0 değilse patlıyor", () => {
  /**
   * The attribution is checked against the named script itself, so a video pointing at a
   * command that quietly stopped counting fails here rather than on stage.
   */
  assert.match(
    PAKET.scripts?.demo ?? "",
    /demo-senaryo\.mjs/u,
    "`npm run demo` artık demo-senaryo.mjs'i koşmuyor — video yanlış komuta işaret ediyor."
  );
  assert.match(
    DEMO_KAYNAK,
    /istemSayisi\s*\+\+/iu,
    "demo-senaryo.mjs bir elicitation sayacı artırmıyor — video'nun 'counted' iddiası dayanaksız."
  );
  assert.match(
    DEMO_KAYNAK,
    /GÜVENLİK İHLALİ:[^\n]*onay istemi[^\n]*gösterildi/u,
    "demo-senaryo.mjs, ret perdesinde istem gösterilirse ARTIK PATLAMIYOR — " +
      "video'nun 'fails if one is ever shown' cümlesi karşılıksız kalır."
  );
});

test("'campaign state: untouched' iddiası dayanağını koruyor: script hiç yazma yapmıyor", () => {
  /**
   * The second line of the pair is a property of the script, not a read-back: it is true
   * only as long as this file calls no write tool. The moment it does, the claim needs a
   * real read-back instead of a word.
   */
  for (const yazma of [/callTool/u, /set_campaign_status/u, /\bmutate\b/u, /create_campaign/u]) {
    assert.doesNotMatch(
      KOD,
      yazma,
      `video-demo.mts artık bir yazma yolu içeriyor (${yazma}) — ekrandaki 'untouched' ` +
        `sözü artık bedava değil, geri okumayla kanıtlanmalı.`
    );
  }
});
