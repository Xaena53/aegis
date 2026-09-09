// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PHASE 5 — THE LANGUAGE GUARD OF THE GROWTH BRAIN HEADER, MEASURED INSTEAD OF ASSUMED.
 *
 * scripts/growth-brain.mjs has an English header that carries the client-side safety belts.
 * Phase 4 put a guard on it ("every line of the header is English"), built on a Turkish
 * letter class plus a 17-word list. MEASURED, that guard was fitted to the one leftover it
 * had been written for: twelve real Turkish sentences taken from this repository and folded
 * to ASCII (the state a half-finished translation actually leaves behind) were dropped into
 * the header one at a time, and ELEVEN OF THE TWELVE kept the suite green. The end-to-end
 * check ran too: " * Kampanyalar DURAKLATILMIS dogar." spliced into the real header left
 * test/faz4GrowthBrain.test.mjs at pass 9 / fail 0.
 *
 * So the sentence the phase-4 guard vouched for was wider than what it could observe. This
 * file replaces the detection with something that can be held to account:
 *
 *   1) DETECTION IS SEVERAL INDEPENDENT SIGNALS, none of them read off the one leftover:
 *      Turkish-only letters, a closed-class function-word set, and Turkish inflectional
 *      suffixes on word endings. The suffixes are what catch a sentence with no function
 *      word in it at all ("Gerekcesiz dagitim denetlenemez."). Each signal is held to its
 *      own weight: the corpus contains a sentence only the word set catches and a sentence
 *      only the suffix table catches, so emptying either one turns a test red.
 *
 *   2) THE EXEMPTION REMOVES A VERBATIM SPAN, NEVER A CLASS. Phase 4 exempted any
 *      double-quoted span; a stray pair of quotes around a leftover therefore erased it.
 *      Here MESRU_TURKCE lists the exact Turkish text that legitimately belongs in this
 *      English header — today a single quoted product string — and each entry is asserted
 *      to be (a) still present in the header, so a dead exemption cannot linger, and (b)
 *      load-bearing, i.e. actually flagged when it is not exempted. Quoted Turkish that is
 *      not on the list is still caught; that direction is executed below.
 *
 *   3) THE GUARD PROVES IT CAN GO RED. The corpus is not commentary: every sentence in it
 *      must be detected, and each one is also spliced into the real header text and the
 *      header check must throw. A guard that cannot be shown failing is not evidence.
 *
 * THE DETECTOR ERRS TOWARD FLAGGING, on purpose and in the direction of this repository's
 * fail-closed contract: an English word that happens to end in a Turkish suffix (a "subdir",
 * a "Lenin") costs a rename or a new verbatim entry, while a missed leftover costs the
 * invariant the sentence was carrying. The negative corpus below pins down which English
 * word shapes are deliberately NOT treated as Turkish, so that trade-off is documented
 * rather than discovered.
 *
 * SCOPE, stated so it is not overread: this file judges the FIRST BLOCK COMMENT of
 * scripts/growth-brain.mjs. The Turkish product strings of the CLI (KULLANIM, the approval
 * screen, the error messages) are user-facing output and stay Turkish; they are not headers
 * and are not examined here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const KOK = join(import.meta.dirname, "..");
const BEYIN = join(KOK, "scripts", "growth-brain.mjs");
const KAYNAK = readFileSync(BEYIN, "utf8");

/* ── The header block ────────────────────────────────────────────────────────── */

/**
 * The file's first block comment. Anchored on a phrase of its own, so a deleted header — or
 * a header that is no longer the first block — is a failure rather than a silent swap.
 */
function basligiAl(kaynak) {
  const bas = kaynak.indexOf("/**");
  const son = kaynak.indexOf("*/", bas);
  assert.ok(bas >= 0 && son > bas, "scripts/growth-brain.mjs has no header block comment.");
  const blok = kaynak.slice(bas, son + 2);
  assert.ok(
    blok.includes("The Growth Brain CLI"),
    "The first block comment of scripts/growth-brain.mjs is no longer the CLI header — " +
      "this guard would be reading the wrong block."
  );
  return blok;
}

const BASLIK = basligiAl(KAYNAK);

/* ── The detector ────────────────────────────────────────────────────────────── */

/** Letters that occur in Turkish and not in English. */
const TURKCE_HARF = /[ıİşŞğĞçÇöÖüÜ]/g;

/**
 * Closed-class Turkish words. Chosen for one property only: each is a frequent Turkish
 * function word that is NOT an English word, so a whole-token match is a leftover and not a
 * coincidence. Words that collide with English are deliberately absent — "her", "once",
 * "gore", "var", "hem", "son", "de", "da", "en", "az", "ki", "mi", "o" — and the negative
 * corpus below asserts they stay silent, so the omission is a recorded decision.
 */
const TURKCE_SOZCUK = new Set([
  "ve", "veya", "ile", "bir", "biri", "birkac", "bu", "bunu", "bunun", "buna", "sunu",
  "ama", "fakat", "ancak", "gibi", "sonra", "kadar", "icin", "degil", "yok", "cok", "sey",
  "olarak", "asla", "zaten", "hicbir", "hicbiri", "yalniz", "yalnizca", "artik", "hala",
  "henuz", "bile", "dahi", "baska", "boyle", "soyle", "oyle", "tum", "butun", "kendi",
  "kendisi", "aynen", "ayni", "birlikte", "sadece", "nasil", "neden", "nicin", "hangi",
  "zaman", "eger", "cunku", "ayrica", "yani", "diye", "uzere", "karsi", "daha", "ise",
  "durur", "kalir", "olur", "kurulum", "listesi", "yolunun",
]);

/**
 * Turkish inflectional endings, with the shortest word each may be claimed from. The length
 * floors are what keep short English fragments out; the endings that are also common English
 * word-endings ("-lar", "-ler", "-den", "-ten", "-der") are NOT listed at all, which is why
 * the corpus has to be caught through the longer forms ("-lari", "-lerin", "-meyen").
 */
const TURKCE_EKLER = [
  { ek: "mis", enAz: 5 }, { ek: "mus", enAz: 5 },
  { ek: "maz", enAz: 5 }, { ek: "mez", enAz: 5 },
  { ek: "mali", enAz: 6 }, { ek: "meli", enAz: 6 },
  { ek: "siz", enAz: 5 }, { ek: "suz", enAz: 5 },
  { ek: "dir", enAz: 6 }, { ek: "tir", enAz: 6 }, { ek: "dur", enAz: 6 }, { ek: "tur", enAz: 6 },
  { ek: "arak", enAz: 6 }, { ek: "erek", enAz: 6 },
  { ek: "daki", enAz: 6 }, { ek: "deki", enAz: 6 }, { ek: "taki", enAz: 6 }, { ek: "teki", enAz: 6 },
  { ek: "yor", enAz: 6 },
  { ek: "acak", enAz: 6 }, { ek: "ecek", enAz: 6 },
  { ek: "mak", enAz: 5 }, { ek: "mek", enAz: 5 },
  { ek: "lik", enAz: 6 }, { ek: "luk", enAz: 6 },
  { ek: "ligi", enAz: 6 }, { ek: "lugu", enAz: 6 },
  { ek: "lari", enAz: 6 }, { ek: "leri", enAz: 6 },
  { ek: "larin", enAz: 7 }, { ek: "lerin", enAz: 7 },
  { ek: "mayan", enAz: 7 }, { ek: "meyen", enAz: 7 },
  { ek: "nin", enAz: 5 }, { ek: "nun", enAz: 5 },
];

/**
 * Every Turkish trace in a piece of text, each tagged with the SIGNAL that produced it
 * ("harf", "sozcuk", "ek") and named so a failure says why it fired. The tag is what lets
 * the corpus below prove that each signal carries weight of its own.
 */
function turkceIzleri(metin) {
  const izler = [];
  const harfler = metin.match(TURKCE_HARF);
  if (harfler) izler.push({ tur: "harf", not: `Turkish letter ${[...new Set(harfler)].join("")}` });
  for (const kelime of metin.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (TURKCE_SOZCUK.has(kelime)) {
      izler.push({ tur: "sozcuk", not: `Turkish word "${kelime}"` });
      continue;
    }
    const ek = TURKCE_EKLER.find((e) => kelime.length >= e.enAz && kelime.endsWith(e.ek));
    if (ek) izler.push({ tur: "ek", not: `Turkish suffix "-${ek.ek}" in "${kelime}"` });
  }
  return izler;
}

/** The traces of a text as one readable line. */
const izMetni = (izler) => izler.map((iz) => iz.not).join(", ");

/* ── The verbatim exemptions ─────────────────────────────────────────────────── */

/**
 * Turkish that legitimately belongs in this English header, quoted here CHARACTER FOR
 * CHARACTER. Removal is by exact span, so nothing that merely resembles one of these is
 * excused. Both directions are asserted below: every entry must still occur in the header,
 * and every entry must be something the detector would otherwise have flagged.
 */
const MESRU_TURKCE = ['"KURU MOD — HİÇBİR YAZMA YAPILMADI"'];

/** The header with the exempt spans cut out, verbatim, wherever they occur. */
function mesrulariAyikla(metin) {
  let kalan = metin;
  for (const ifade of MESRU_TURKCE) kalan = kalan.split(ifade).join(" ");
  return kalan;
}

/**
 * The claim itself, as a function so the CODE direction can be RUN rather than asserted:
 * called below on the real header, and on the real header with a leftover spliced in.
 */
function baslikDenetle(baslik) {
  const suclular = [];
  baslik.split("\n").forEach((satir, i) => {
    const izler = turkceIzleri(mesrulariAyikla(satir));
    if (izler.length > 0) suclular.push(`${i + 1}: ${satir.trim()}\n      -> ${izMetni(izler)}`);
  });
  assert.deepEqual(
    suclular,
    [],
    "Turkish left over in the English header of scripts/growth-brain.mjs:\n" +
      suclular.join("\n") +
      "\nA sentence that stops mid-clause is worse than no sentence: the invariant it was " +
      "carrying becomes unreadable exactly where it matters. If the flagged text is genuine " +
      "English, rename the word or add the exact span to MESRU_TURKCE — and expect the " +
      "exemption guard to make you prove that span is really Turkish."
  );
}

/* ── The corpora ─────────────────────────────────────────────────────────────── */

/**
 * Turkish sentences from this repository — the MCP server instructions, the core contract,
 * this CLI's own usage text — folded to ASCII, which is what a half-finished translation
 * leaves behind. Eleven of the first twelve passed the phase-4 guard untouched.
 *
 * The last two carry no listed suffix at all and are caught by the function-word set alone.
 * Without them, emptying TURKCE_SOZCUK left this file at pass 6 / fail 0 (measured) — half
 * the detector would have been a claim nothing here could contradict.
 */
const TURKCE_KORPUS = [
  "Kampanyalar DURAKLATILMIS dogar.",
  "Sunucudaki butce tavani KAMPANYA BASINADIR.",
  "Ham upstream metin asla ajana sizmaz.",
  "Para tutari SAYI olarak gelmeli.",
  "Gerekcesiz dagitim denetlenemez.",
  "Sessiz kirpma yoktur; gecersiz deger hata firlatir.",
  "Harcamayi azaltan islem her zaman serbesttir.",
  "Onay istemi ag kapisi temiz gecmeden gosterilmez.",
  "Bilinmeyen her sinyal redde gider.",
  "Kanal kumesi ortamdan okunur, modele sorulmaz.",
  "Butce azaltma ve negatif anahtar kelime ekleme onay istemez.",
  "Bayrak verilmezse KURU MOD: hicbir yazma yapilmaz, yalniz rapor uretilir.",
  "--yayinla yalniz --uygula ile birlikte kullanilabilir.",
  "Butce tavanini ve yazma iznini yalniz hesap sahibi degistirebilir.",
];

/**
 * English the detector must NOT claim. Every line is loaded with the shapes the rules come
 * closest to: "-lar/-ler/-der" endings, "-den/-ten" endings, and the Turkish function words
 * that were kept out of the set precisely because they are English words too.
 */
const INGILIZCE_KORPUS = [
  "The caller passes a smaller dollar figure to the handler.",
  "A similar particular reader is regular, modular and earlier than the scheduler.",
  "Her golden burden was hidden in the garden, written down and often listened to.",
  "Once the promise is a premise, we normalise otherwise sudden behaviour.",
  "The var of the son is not hem, de, da, en, az, ki, mi or o.",
  "This module writes nothing to the account and the campaign is born paused.",
];

/* ── Guard 1: the detector can go red on real Turkish ────────────────────────── */

test("KEFALET: the detector fires on every ASCII-folded Turkish sentence of the corpus", () => {
  const kacanlar = TURKCE_KORPUS.filter((cumle) => turkceIzleri(cumle).length === 0);
  assert.deepEqual(
    kacanlar,
    [],
    "These real Turkish sentences pass the detector untouched, so the header claim would be " +
      "vouching for something it cannot observe:\n" + kacanlar.join("\n")
  );
});

test("KEFALET: the corpus exercises the word set and the suffix table SEPARATELY", () => {
  /**
   * Without this, one signal could be dead weight and nothing would say so. MEASURED: the
   * suffix table alone caught the first twelve sentences, so emptying TURKCE_SOZCUK left
   * the file at pass 6 / fail 0. Each signal now has at least one sentence only it can
   * catch, which turns deleting either one into a red test instead of a silent loss.
   */
  const turler = TURKCE_KORPUS.map((cumle) => new Set(turkceIzleri(cumle).map((iz) => iz.tur)));
  assert.ok(
    turler.some((t) => t.has("sozcuk") && !t.has("ek")),
    "No corpus sentence is caught by the function-word set ALONE, so TURKCE_SOZCUK could be " +
      "emptied without a single test going red. Add a Turkish sentence carrying no listed " +
      "suffix."
  );
  assert.ok(
    turler.some((t) => t.has("ek") && !t.has("sozcuk")),
    "No corpus sentence is caught by the suffix table ALONE, so TURKCE_EKLER could be " +
      "emptied without a single test going red. Add a Turkish sentence with no function " +
      "word in it — that is the shape the phase-4 guard missed."
  );
});

/* ── Guard 2: the detector is silent on English ──────────────────────────────── */

test("KEFALET: the detector stays silent on English that merely looks Turkish", () => {
  const yanlislar = [];
  for (const cumle of INGILIZCE_KORPUS) {
    const izler = turkceIzleri(cumle);
    if (izler.length > 0) yanlislar.push(`${cumle}\n      -> ${izMetni(izler)}`);
  }
  assert.deepEqual(
    yanlislar,
    [],
    "The detector calls plain English Turkish. A rule that fires on everything proves " +
      "nothing when it fires on a leftover:\n" + yanlislar.join("\n")
  );
});

/* ── Guard 3: the header itself ──────────────────────────────────────────────── */

test("BELGE: the header of growth-brain.mjs carries no Turkish leftover", () => {
  baslikDenetle(BASLIK);
});

/* ── Guard 4: the exemptions, both directions ───────────────────────────────── */

test("AYIKLAMA: every verbatim exemption is present in the header AND load-bearing", () => {
  for (const ifade of MESRU_TURKCE) {
    assert.ok(
      BASLIK.includes(ifade),
      `MESRU_TURKCE excuses ${JSON.stringify(ifade)}, which no longer occurs in the header. ` +
        "A dead exemption is a hole waiting for text that looks like it: remove the entry."
    );
    assert.ok(
      turkceIzleri(ifade).length > 0,
      `MESRU_TURKCE excuses ${JSON.stringify(ifade)}, but the detector would not have ` +
        "flagged it anyway. An exemption that excuses nothing is either stale or a way in."
    );
  }
});

test("AYIKLAMA: the exemption is a verbatim span, not the class of quoted text", () => {
  /**
   * The phase-4 guard exempted ANY single-line double-quoted span, so a leftover wrapped in
   * quotes disappeared. Here quoting is not a hiding place: only the listed spans are cut.
   */
  for (const cumle of TURKCE_KORPUS.slice(0, 3)) {
    assert.throws(
      () => baslikDenetle(`${BASLIK}\n * The report prints "${cumle}" at the end.`),
      /Turkish left over in the English header/,
      `Quoting "${cumle}" hid it from the guard — the exemption is behaving like a class.`
    );
  }
});

/* ── Guard 5: the mutation, executed ─────────────────────────────────────────── */

const CAPA = " * Secret hygiene:";

test("MUTASYON: each corpus sentence spliced into the real header turns the guard red", () => {
  assert.ok(
    BASLIK.includes(CAPA),
    `The splice point ${JSON.stringify(CAPA)} no longer exists in the header, so the ` +
      "assertions below would be testing an unmodified string. Pick a new anchor."
  );
  for (const cumle of TURKCE_KORPUS) {
    assert.throws(
      () => baslikDenetle(BASLIK.replace(CAPA, ` * ${cumle}\n${CAPA}`)),
      /Turkish left over in the English header/,
      `The header guard stayed green with "${cumle}" inside the header. That is the exact ` +
        "shape this file exists to stop: a half-translated clause, folded to ASCII."
    );
  }
});
