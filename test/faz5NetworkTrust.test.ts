// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 5 — src/networkTrust.ts: three measured holes in this file's OWN watchers.
 *
 * The independent audit reported three defects against the faz3/faz4 guards of this module.
 * Every one of them was re-measured here before a line was written; the verdicts below are
 * this run's numbers, not the report's.
 *
 * KUSUR 1 — "CORROBORATES is stripped wholesale, so the reversed sentence can move back in".
 *   ALREADY CLOSED, measured: the M12 mutation (a comment inside agDogrula claiming the chain
 *   CORROBORATES the degraded signal) turns test/faz3NetworkTrust.test.ts RED today — the strip
 *   is now bound to the exact phrase. BUT the same guarantee was still walkable from one step
 *   away: `void 0; // ... CORROBORATES ...` written after a code line left all fifteen
 *   faz3+faz4 watchers GREEN, because both files harvest comments with
 *   `/^\s*(\/\*\*?|\*|\/\/)/` — a filter that cannot see a trailing comment or the interior of
 *   a star-less block. The absence claim was therefore made over an INCOMPLETE comment surface.
 *
 * KUSUR 2 — the faz4 Turkish-residue list is not a superset of faz3's.
 *   OPEN, measured: `// AUDIT-M4: each link's own window alanina yazar, that's the rule.`
 *   left 15/15 GREEN. faz3 misses it because its `'[^'\n]*'` quote strip swallows everything
 *   between two apostrophes, and faz4 misses it because "yazar" is not in its list. The same
 *   line WITHOUT apostrophes turns faz3 red (measured 14/1), which is exactly the report's
 *   point: in the apostrophe blind spot faz4 stands alone, and there it is the weaker list.
 *
 * KUSUR 3 — "the simulation channel never touches the real SDK" is nailed by a DENIAL LIST of
 *   six fixed names, and only for DIRECT calls.
 *   OPEN, measured: `void simSwapKatmani(ayar, risk);` inside simDogrula (K7 — that layer
 *   reaches the real channel) left 15/15 GREEN, and so did a freshly named constructor
 *   (K8, a `yeniKanaliGetir` that calls nacIstemci) invoked from simDogrula.
 *
 * HOW THE THREE ARE CLOSED — one instrument, used three times. A denial list can only deny
 * what it was told to look for, and a line filter can only see the comment shapes it was told
 * about. So this file does not add more names or more shapes: it SPLITS the source once, with
 * a scanner that walks it character by character (strings, template literals with their
 * interpolations, regex literals, line and block comments), and then asks POSITIVE questions
 * of the two halves:
 *   - the comment half is the WHOLE comment surface, so an absence claim over it is a claim
 *     about every comment in the file rather than about the ones a regex recognised;
 *   - the code half has string and comment text blanked out, so "what does simDogrula call?"
 *     can be answered by an ALLOW LIST — the transitive closure of its calls — instead of a
 *     denial list that a new name walks around.
 * The scanner itself is the single point of failure of both claims, so the first test measures
 * it against the exact shapes that defeated the old filters. Without that test the absence
 * claims below would be the very pattern this phase exists to remove: strip first, then claim
 * the absence of what the strip could never have shown.
 *
 * No watcher here loosens the gate, goes to the network, or writes a secret.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  agDogrula,
  __setCagriYonlendirmeKanalForTests,
  __setCihazDegisimKanalForTests,
  __setErisimKanalForTests,
  __setKonumKanalForTests,
  __setNacIstemciFabrikasiForTests,
  __setSimSwapKanalForTests,
} from "../src/networkTrust.js";
import type { AgAyar } from "../src/networkTrust.js";

const KAYNAK = readFileSync(
  fileURLToPath(new URL("../src/networkTrust.ts", import.meta.url)),
  "utf8"
);

const FAZ3 = readFileSync(
  fileURLToPath(new URL("./faz3NetworkTrust.test.ts", import.meta.url)),
  "utf8"
);
const FAZ4 = readFileSync(
  fileURLToPath(new URL("./faz4NetworkTrust.test.ts", import.meta.url)),
  "utf8"
);

/* ────────────────────────────────────────────────────────────────────────────
 * THE INSTRUMENT: one pass over the source, two halves out.
 * ──────────────────────────────────────────────────────────────────────────── */

interface Bolum {
  /** The source with every comment and every string / regex BODY blanked to spaces. */
  kod: string;
  /** The source with everything but comment bodies blanked to spaces. */
  yorum: string;
}

/**
 * Keywords after which a `/` opens a REGEX rather than being a division sign. Without this
 * the scanner would read `return /x/.test(s)` as a division and then treat the rest of the
 * file as a regex — every claim downstream would be measured against garbage.
 */
const REGEX_ONCESI_KELIMELER = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "do",
  "else",
  "yield",
  "await",
  "void",
  "delete",
  "instanceof",
]);

/**
 * Split the source into a "code" half and a "comment" half, character by character.
 *
 * Both halves keep the ORIGINAL length and the original newlines, so an index into either
 * half is an index into the source. Blanking (rather than deleting) is what lets the code
 * half be searched for a function signature without a string's contents ever pretending to
 * be code.
 */
function bolumle(k: string): Bolum {
  const kodParcalari: string[] = [];
  const yorumParcalari: string[] = [];
  const bosluk = (c: string): string => (c === "\n" ? "\n" : " ");
  const yaz = (hedef: "kod" | "yorum" | "hic", c: string): void => {
    kodParcalari.push(hedef === "kod" ? c : bosluk(c));
    yorumParcalari.push(hedef === "yorum" ? c : bosluk(c));
  };
  type Durum =
    | "kod"
    | "satirYorumu"
    | "blokYorumu"
    | "tekTirnak"
    | "ciftTirnak"
    | "sablon"
    | "regex"
    | "regexSinifi";
  let durum: Durum = "kod";
  /** `${` inside a template literal re-enters code; the stack carries the way back. */
  const yigin: Array<{ durum: Durum; derinlik: number }> = [];
  let derinlik = 0;
  let sonAnlamli = "";
  let sonKelime = "";

  for (let i = 0; i < k.length; i++) {
    const c = k[i];
    const n = i + 1 < k.length ? k[i + 1] : "";

    if (durum === "kod") {
      if (c === "/" && n === "/") {
        durum = "satirYorumu";
        yaz("hic", c);
        yaz("hic", n);
        i++;
        continue;
      }
      if (c === "/" && n === "*") {
        durum = "blokYorumu";
        yaz("hic", c);
        yaz("hic", n);
        i++;
        continue;
      }
      if (
        c === "/" &&
        (sonAnlamli === "" ||
          "(,=:[!&|?{};+-*%^~<>".includes(sonAnlamli) ||
          REGEX_ONCESI_KELIMELER.has(sonKelime))
      ) {
        durum = "regex";
        yaz("kod", c);
        sonAnlamli = c;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        durum = c === "'" ? "tekTirnak" : c === '"' ? "ciftTirnak" : "sablon";
        yaz("kod", c);
        sonAnlamli = c;
        continue;
      }
      if (c === "{") derinlik++;
      if (c === "}") {
        if (derinlik === 0 && yigin.length > 0) {
          const ust = yigin.pop();
          durum = ust === undefined ? "kod" : ust.durum;
          derinlik = ust === undefined ? 0 : ust.derinlik;
          yaz("kod", c);
          sonAnlamli = c;
          continue;
        }
        derinlik--;
      }
      yaz("kod", c);
      if (!/\s/.test(c)) {
        sonAnlamli = c;
        sonKelime = /[A-Za-z_$0-9]/.test(c) ? sonKelime + c : "";
      }
      continue;
    }

    if (durum === "satirYorumu") {
      if (c === "\n") {
        durum = "kod";
        yaz("hic", c);
      } else {
        yaz("yorum", c);
      }
      continue;
    }

    if (durum === "blokYorumu") {
      if (c === "*" && n === "/") {
        durum = "kod";
        yaz("hic", c);
        yaz("hic", n);
        i++;
        continue;
      }
      yaz("yorum", c);
      continue;
    }

    if (durum === "tekTirnak" || durum === "ciftTirnak") {
      const kapanis = durum === "tekTirnak" ? "'" : '"';
      if (c === "\\") {
        yaz("hic", c);
        yaz("hic", n);
        i++;
        continue;
      }
      if (c === kapanis || c === "\n") {
        durum = "kod";
        yaz("kod", c);
        continue;
      }
      yaz("hic", c);
      continue;
    }

    if (durum === "sablon") {
      if (c === "\\") {
        yaz("hic", c);
        yaz("hic", n);
        i++;
        continue;
      }
      if (c === "$" && n === "{") {
        yigin.push({ durum: "sablon", derinlik });
        derinlik = 0;
        durum = "kod";
        yaz("kod", c);
        yaz("kod", n);
        i++;
        continue;
      }
      if (c === "`") {
        durum = "kod";
        yaz("kod", c);
        continue;
      }
      yaz("hic", c);
      continue;
    }

    if (durum === "regex" || durum === "regexSinifi") {
      if (c === "\\") {
        yaz("hic", c);
        yaz("hic", n);
        i++;
        continue;
      }
      if (durum === "regex" && c === "[") {
        durum = "regexSinifi";
        yaz("hic", c);
        continue;
      }
      if (durum === "regexSinifi" && c === "]") {
        durum = "regex";
        yaz("hic", c);
        continue;
      }
      if (durum === "regex" && (c === "/" || c === "\n")) {
        durum = "kod";
        yaz("kod", c);
        if (c === "/") sonAnlamli = c;
        continue;
      }
      yaz("hic", c);
      continue;
    }
  }

  return { kod: kodParcalari.join(""), yorum: yorumParcalari.join("") };
}

const BOLUM = bolumle(KAYNAK);

/**
 * The comment surface as one line. The leading `*` of a JSDoc continuation is a MARKER, not
 * content: leaving it in cuts a quoted sentence in two ("… BOZUK — * onaylayıcının …") and an
 * exact-phrase strip could no longer find it. Only that marker is removed.
 */
function yorumDuz(): string {
  return BOLUM.yorum
    .split("\n")
    .map((s) => s.replace(/^\s*\*+\s?/, ""))
    .join("\n")
    .replace(/\s+/g, " ");
}

/* ────────────────────────────────────────────────────────────────────────────
 * TEST 1 — the instrument itself. Every absence claim below rests on it.
 * ──────────────────────────────────────────────────────────────────────────── */

test("FAZ5: ayrıştırıcı, eski satır süzgecinin GÖREMEDİĞİ yorum biçimlerini görür", () => {
  const ornek = [
    'const a = "http://x.example // dize içi, yorum DEĞİL";  // KUYRUK_YORUMU',
    "/* yildizsiz blok",
    "   BLOK_IC_SATIRI",
    "*/",
    "const re = /[abc]\\/\\//g; // IKINCI_KUYRUK",
    "const t = `metin ${ hesapla(1) } SABLON_GOVDESI`;",
    "/** yildizli blok */",
  ].join("\n");
  const b = bolumle(ornek);

  // (a) The three shapes the old line filter could not see.
  assert.ok(b.yorum.includes("KUYRUK_YORUMU"), "kod satırının SONUNDAKİ yorum görülmeli");
  assert.ok(b.yorum.includes("BLOK_IC_SATIRI"), "yıldızsız blok yorumunun İÇ satırı görülmeli");
  assert.ok(b.yorum.includes("IKINCI_KUYRUK"), "regex taşıyan satırın kuyruk yorumu görülmeli");

  // (b) The other direction: what is NOT a comment must not become one, or the absence
  //     claims below would go red for perfectly ordinary code and get switched off.
  assert.ok(
    !b.yorum.includes("dize içi"),
    "dize içindeki // yorum sayılamaz — yanlış kırmızı, gözcünün kapatılmasına davettir"
  );
  assert.ok(!b.yorum.includes("SABLON_GOVDESI"), "şablon dizesinin gövdesi yorum değildir");

  // (c) The code half: string and comment text is blanked, interpolated code is NOT.
  assert.ok(!b.kod.includes("dize içi"), "dize gövdesi kod yarısında kalamaz");
  assert.ok(!b.kod.includes("KUYRUK_YORUMU"), "yorum metni kod yarısında kalamaz");
  assert.ok(b.kod.includes("hesapla("), "şablon içindeki ${...} GERÇEK koddur, silinmemeli");
  assert.ok(/const re = \/ *\/g;/.test(b.kod), "regex gövdesi boşaltılır, sınırları durur");

  // (d) Indexes stay usable: both halves are as long as the source.
  assert.equal(b.kod.length, ornek.length);
  assert.equal(b.yorum.length, ornek.length);

  // (e) And on the REAL file it is not measuring an empty surface.
  assert.ok(
    BOLUM.yorum.includes("Network-verified approval"),
    "gerçek dosyanın yorum yüzeyi boş çıkarsa aşağıdaki yokluk iddiaları vakumdur"
  );
  assert.ok(
    BOLUM.kod.includes("export async function agDogrula("),
    "gerçek dosyanın kod yarısı boş çıkarsa çağrı kapanışı vakumdur"
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * KUSUR 1 — the reversed vouching sentence, over the WHOLE comment surface.
 * RED WHEN: any comment anywhere in the file — trailing, star-less block, JSDoc —
 * uses the "corroborate" vocabulary outside the single legitimate negative sentence.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The ONE legitimate use, deliberately in capitals: the negative sentence. */
const MESRU_KEFALET_IFADESI = "NO LINK EVER CORROBORATES";

test("FAZ5: 'corroborate' sözlüğü YORUM YÜZEYİNİN TAMAMINDA yok (kuyruk ve yıldızsız blok dahil)", () => {
  const duz = yorumDuz();
  const parcalar = duz.split(MESRU_KEFALET_IFADESI);
  assert.equal(
    parcalar.length,
    2,
    `meşru olumsuz cümle ("${MESRU_KEFALET_IFADESI}") yorumlarda TAM OLARAK bir kez geçmeli`
  );
  assert.ok(
    !/corroborat/i.test(parcalar.join(" ")),
    "hiçbir halka bozuk sinyali TEYİT etmez; kefalet yönünü ters anlatan bir cümle, hangi " +
      "yorum biçiminde yazılırsa yazılsın, meşru olumsuz cümlenin yanında yaşayamaz"
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * KUSUR 2 — the Turkish-residue scan, over the same whole surface and with a list
 * that is provably not weaker than its two predecessors.
 * RED WHEN: a half-translated Turkish tail appears in any comment, in any shape — or
 * when faz3/faz4 learn a word this list does not know.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Turkish that is QUOTED in the comments on purpose: the simulation label, the escalation
 * prompt's header and the report block's name. The list is exact and closed — a general
 * "delete anything between quotes" rule is what let a whole residue class through faz3 — and
 * each entry's presence is asserted, so the list cannot quietly become a wider exemption.
 */
const MESRU_TURKCE: readonly string[] = [
  "⚠ AĞ SİNYALİ BOZUK — onaylayıcının SIM kartı yakın zamanda değişmiş.",
  "GÜVENLİK KAPISI ÇALIŞTI",
  "SİMÜLASYON",
];

/**
 * The word list: the UNION of faz3's and faz4's, plus the ASCII-folded spelling of every
 * entry, because a residue typed without Turkish letters is still a residue. Turkish
 * IDENTIFIERS from the code (kefil, halka, kademe, gozlemsiz…) are legitimate in these
 * comments and are deliberately absent.
 */
const TURKCE_SOZCUKLER: readonly string[] = [
  "için",
  "icin",
  "değil",
  "degil",
  "değildir",
  "degildir",
  "değildi",
  "degildi",
  "yoktur",
  "vardır",
  "vardir",
  "kalamaz",
  "kalmaz",
  "dokunulmaz",
  "edilmez",
  "yapılmaz",
  "yapilmaz",
  "olmaz",
  "hiçbir",
  "hicbir",
  "çünkü",
  "cunku",
  "ayrıca",
  "ayrica",
  "bkz",
  "yalnız",
  "yalniz",
  "sadece",
  "olduğu",
  "oldugu",
  "gerekir",
  "okunur",
  "sorulmaz",
  "halkada",
  "kalır",
  "kalir",
  "girmez",
  "etmez",
  "yazar",
  "gösterilmez",
  "gosterilmez",
  "uygulanmaz",
  "bile",
  "ile",
  "ve",
  "bir",
];

/**
 * The word list a sibling watcher scans with, read out of its source.
 *
 * `imza` is a word both lists have carried since they were written; anchoring on it is what
 * separates the residue alternation from the other `\b(...)\b` groups in the same file (faz4
 * nails a list of channel-constructor names with one). If the anchor is gone the list has
 * been rewritten, and this watcher says so instead of vouching for a comparison it never
 * made.
 */
function kardesListe(dosya: string, ad: string, imza: string): string[] {
  for (const m of dosya.matchAll(/\\b\(([^)]+)\)\\b/g)) {
    const parcalar = (m[1] ?? "").split("|").map((s) => s.trim());
    if (parcalar.includes(imza)) return parcalar;
  }
  return assert.fail(
    `${ad}: Türkçe artık listesi bulunamadı ("${imza}" içeren alternasyon yok). Liste yeniden ` +
      `yazıldıysa faz5'in listesi de elden geçmeli — karşılaştırılmayan bir üst küme iddiası ` +
      `sahte güvencedir`
  );
}

test("FAZ5: faz5 sözcük listesi, faz3 ve faz4 listelerinin ÜST KÜMESİDİR", () => {
  const benim = new Set(TURKCE_SOZCUKLER);
  for (const [ad, dosya] of [
    ["faz3NetworkTrust", FAZ3],
    ["faz4NetworkTrust", FAZ4],
  ] as const) {
    const eksik = kardesListe(dosya, ad, "dokunulmaz").filter((s) => !benim.has(s));
    assert.deepEqual(
      eksik,
      [],
      `${ad}'ün bildiği ama faz5'in bilmediği sözcükler var: ${eksik.join(", ")} — bir sonraki ` +
        `gözcü öncekinden zayıf olamaz; kusurun ta kendisi buydu`
    );
  }
});

test("FAZ5: yorum yüzeyinin TAMAMINDA yarım çeviri artığı yok", () => {
  let metin = yorumDuz();
  for (const ifade of MESRU_TURKCE) {
    assert.ok(
      metin.includes(ifade),
      `meşru Türkçe alıntı yorumlardan kaybolmuş, ayıklama listesi bayat: ${ifade}`
    );
    metin = metin.split(ifade).join(" ");
  }

  /**
   * The lookbehind removes exactly one English artefact and nothing else: in "we've" the
   * apostrophe makes "ve" a word of its own. It skips a match ONLY when a letter and an
   * apostrophe sit immediately before it, so a residue such as "… 've bir alana yazar" still
   * trips on the two words after it.
   */
  const desen = new RegExp(`(?<![A-Za-zÀ-ÿ]['’])\\b(${TURKCE_SOZCUKLER.join("|")})\\b`, "gi");
  const bulunan = [...new Set(metin.match(desen) ?? [])];
  assert.deepEqual(
    bulunan,
    [],
    `alıntı dışı yorumda Türkçe sözcük kaldı (yarım çeviri): ${bulunan.join(", ")}`
  );

  const harfler = [...new Set(metin.match(/[ıİğĞşŞçÇöÖüÜ]/g) ?? [])];
  assert.deepEqual(
    harfler,
    [],
    `alıntı dışı yorumda Türkçe'ye özgü harf kaldı: ${harfler.join(", ")}`
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * KUSUR 3 — "the simulation channel never touches the real SDK", nailed by an ALLOW
 * LIST over the transitive closure of simDogrula's calls.
 * RED WHEN: simDogrula, or anything it reaches, starts calling ANYTHING new — a layer
 * that owns a real channel, a freshly named constructor, a dynamic import.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Words that are followed by `(` without being a call. */
const CAGRI_OLMAYANLAR = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "typeof",
  "function",
  "await",
  "new",
  "of",
  "in",
  "do",
  "else",
  "throw",
  "case",
  "void",
  "delete",
  "instanceof",
  "yield",
  "super",
]);

/** Every top-level function in the module, by name, with its brace-matched body. */
function tumGovdeler(): Map<string, string> {
  const govdeler = new Map<string, string>();
  for (const m of BOLUM.kod.matchAll(
    /\n(?:export )?(?:async )?function ([A-Za-z_$][A-Za-z0-9_$]*)\s*[(<]/g
  )) {
    const ad = m[1] ?? "";
    const acilis = BOLUM.kod.indexOf("{", (m.index ?? 0) + m[0].length - 1);
    let derinlik = 0;
    for (let j = acilis; j < BOLUM.kod.length; j++) {
      if (BOLUM.kod[j] === "{") derinlik++;
      else if (BOLUM.kod[j] === "}") {
        derinlik--;
        if (derinlik === 0) {
          govdeler.set(ad, BOLUM.kod.slice(acilis + 1, j));
          break;
        }
      }
    }
  }
  return govdeler;
}

/** Everything the body calls, member expressions included (`kanal.verifySimSwap`). */
function cagriHedefleri(govde: string): string[] {
  const hedefler = new Set<string>();
  for (const m of govde.matchAll(
    /([A-Za-z_$][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\(/g
  )) {
    const ad = (m[1] ?? "").replace(/\s+/g, "");
    if (!CAGRI_OLMAYANLAR.has(ad)) hedefler.add(ad);
  }
  return [...hedefler];
}

test("FAZ5: simDogrula'nın çağrı KAPANIŞI kapalı bir listedir — dolaylı erişim de yakalanır", () => {
  const govdeler = tumGovdeler();
  assert.ok(govdeler.has("simDogrula"), "simDogrula gövdesi bulunamadı — gözcü vakum olurdu");
  assert.ok(
    (govdeler.get("simDogrula") ?? "").includes("pencereSec(ayar, risk)"),
    "simDogrula gövdesi beklenen çapayı taşımalı; yanlış gövde ölçmek yokluk iddiasını çürütür"
  );
  assert.ok(
    govdeler.size > 25,
    `kaynakta yalnız ${govdeler.size} fonksiyon bulundu — ayrıştırma bozuk, ölçüm güvenilmez`
  );

  const kuyruk = ["simDogrula"];
  const yerelKapanis = new Set<string>();
  const disHedefler = new Set<string>();
  while (kuyruk.length > 0) {
    const ad = kuyruk.shift() ?? "";
    if (yerelKapanis.has(ad)) continue;
    yerelKapanis.add(ad);
    for (const hedef of cagriHedefleri(govdeler.get(ad) ?? "")) {
      if (govdeler.has(hedef)) kuyruk.push(hedef);
      else disHedefler.add(hedef);
    }
  }

  // (a) The local closure is stated EXACTLY. A new call — to a layer that owns a real channel
  //     (K7), or to a newly named constructor (K8) — enlarges this set and is named here,
  //     whether it was reached directly or through another function.
  assert.deepEqual(
    [...yerelKapanis].sort(),
    ["maskele", "pencereNormalize", "pencereSec", "simDogrula"],
    "simülasyon kanalı yalnız pencere hesabı ile maskelemeyi çağırır; bu kümeyi büyüten her " +
      "değişiklik 'gerçek SDK'ya dokunulmaz' vaadini yeniden okutmalıdır"
  );

  // (b) Whatever that closure calls from OUTSIDE the module must be a pure built-in. An
  //     unknown name here is a channel, a dynamic import, or a global reaching out of the
  //     process.
  const IZINLI_DIS_HEDEFLER = new Set([
    "Math.min",
    "Math.round",
    "Number.isFinite",
    "phone.slice",
    "repeat",
  ]);
  const tanimsiz = [...disHedefler].filter((h) => !IZINLI_DIS_HEDEFLER.has(h)).sort();
  assert.deepEqual(
    tanimsiz,
    [],
    `simülasyon kapanışı, saf yerleşiklerin dışında bir şey çağırıyor: ${tanimsiz.join(", ")} ` +
      `— dinamik import ve her yeni kanal bu satırda görünür`
  );
});

test("FAZ5: kanal kurucularının adları BAYAT DEĞİL ve SDK'nın tek tembel import'u nacIstemci'de", () => {
  const govdeler = tumGovdeler();

  // The names faz4's denial list is written against. A denial list whose names no longer
  // exist denies nothing: renaming one would leave that watcher green over an empty set.
  for (const ad of [
    "nacIstemci",
    "kanalGetir",
    "erisimKanaliGetir",
    "konumKanaliGetir",
    "cihazDegisimKanaliGetir",
    "cagriYonlendirmeKanaliGetir",
  ]) {
    assert.ok(
      govdeler.has(ad),
      `gerçek kanal kurucusu "${ad}" kaynakta tanımlı değil — adı yasaklayan gözcüler artık ` +
        `boş kümeyi yasaklıyor`
    );
  }

  const importluFonksiyonlar = [...govdeler.entries()]
    .filter(([, govde]) => /\bimport\s*\(/.test(govde))
    .map(([ad]) => ad)
    .sort();
  assert.deepEqual(
    importluFonksiyonlar,
    ["nacIstemci"],
    "gerçek SDK'nın TEK tembel import'u nacIstemci'nin içindedir; başka bir yere kopyalanması " +
      "'yalnız burada yüklenir' cümlesini yanlışlar"
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * KUSUR 3, KOD YÖNÜ — the same promise, measured at run time instead of read.
 * ──────────────────────────────────────────────────────────────────────────── */

const TELEFON = "+905551112233";

const SIM_AYAR: AgAyar = {
  approverPhone: TELEFON,
  simSwapWindowHours: 72,
  nacSimulate: "temiz",
};

afterEach(() => {
  __setSimSwapKanalForTests(undefined);
  __setErisimKanalForTests(undefined);
  __setKonumKanalForTests(undefined);
  __setCihazDegisimKanalForTests(undefined);
  __setCagriYonlendirmeKanalForTests(undefined);
  __setNacIstemciFabrikasiForTests(undefined);
});

test("FAZ5: simülasyon koşusu hiçbir kanalı ve SDK istemcisini KURDURMAZ (çalışma zamanı)", async () => {
  const dokunulanlar: string[] = [];
  __setNacIstemciFabrikasiForTests(async () => {
    dokunulanlar.push("nacIstemci");
    throw new Error("SDK istemcisi simülasyon yolunda kurulamaz");
  });
  __setSimSwapKanalForTests({
    verifySimSwap: async () => {
      dokunulanlar.push("simSwap");
      return undefined;
    },
  });
  __setErisimKanalForTests({
    cihazErisilebilirMi: async () => {
      dokunulanlar.push("reach");
      return undefined;
    },
  });
  __setKonumKanalForTests({
    ulkeDurumu: async () => {
      dokunulanlar.push("loc");
      return {};
    },
  });
  __setCihazDegisimKanalForTests({
    cihazDegistiMi: async () => {
      dokunulanlar.push("devSwap");
      return undefined;
    },
  });
  __setCagriYonlendirmeKanalForTests({
    kosulsuzYonlendirmeAcikMi: async () => {
      dokunulanlar.push("callFwd");
      return undefined;
    },
  });

  const karar = await agDogrula(SIM_AYAR, "medium");

  assert.deepEqual(
    dokunulanlar,
    [],
    `simülasyon kanalı ağ tarafına uzandı: ${dokunulanlar.join(", ")} — bu vaat, jüriye ` +
      `"gerçek ağ sorgusu YAPILMADI" diye gösterilen her satırın dayanağıdır`
  );
  assert.equal(karar.engel, undefined, "temiz simülasyon işlemi durdurmaz");
  assert.equal(karar.iz.simSwap, "simulasyon");
  assert.equal(karar.iz.pencereSaat, 24, "medium katmanı pencereyi 24'e kelepçeler");
});
