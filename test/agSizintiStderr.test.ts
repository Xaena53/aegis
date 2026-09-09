// SPDX-License-Identifier: AGPL-3.0-only
/**
 * THE STDERR LEAK SENTINEL — nothing the contract protects may reach the operator's log or
 * terminal, from EITHER of the two files that write such a line.
 *
 * THE CONTRACT names them in one breath: "raw upstream text, TOKENS, the FULL PHONE NUMBER and
 * PII never leak to the agent, the log or the terminal." On a stdio MCP server stderr IS the
 * operator's log and terminal, and two modules write to it out of an upstream exception:
 * src/networkTrust.ts (five catch branches, one per real CAMARA link) and src/approval.ts
 * (the failed-elicitation branch). They now share ONE cleaner — operatorMetniTemizle — and
 * this file holds BOTH callers to it.
 *
 * WHAT WAS MEASURED, and why each assertion below exists:
 *   - networkTrust.ts, with a NaC token configured: the token reached stderr verbatim; an
 *     `ESC[2J ESC[1;1H SAHTE: onaylandı` body reached it verbatim too — that clears the
 *     operator's screen and prints a forged "approved" line at the top of it; and a
 *     5000-character body printed whole, at 5047 characters.
 *   - approval.ts: only the byte-for-byte E.164 spelling of the approver's number was masked,
 *     so five of six spellings a CAMARA 4xx really produces went to stderr in full.
 *   - a stub secret ("9") shredded the diagnostic instead of the number: `Status 429 … retry
 *     after 90 s` came out as `Status 42*** … retry after ***0 s`. config.ts REFUSES a
 *     non-E.164 AEGIS_APPROVER_PHONE today, so the environment no longer delivers a stub
 *     number — but AEGIS_NAC_TOKEN is still only trimmed there, and AgAyar is a plain object
 *     an in-process caller builds by hand (this file does exactly that), so the floor under
 *     the by-value redaction still carries weight.
 *
 * WHY THE LEAK TEST IS NOT A DIGITS-ONLY COMPARISON — a lesson paid for once in this file.
 * The previous version asserted `metin.replace(/\D/g,"").includes("905551112233")`, and for
 * the spelling `%2B90%20555%20111%2022%2033` that assertion CANNOT FAIL: the percent escapes
 * inject 2s and 0s into the digit stream, so the sought run never forms — the case measured
 * GREEN with the redaction fully reverted. A guard that cannot go red measures nothing.
 * `numaraSizdiMi` therefore looks three independent ways: the raw spelling as written, the
 * digits as printed, and the digits AFTER percent-decoding.
 *
 * The over-redaction tests guard the OPPOSITE direction: a cleaner that ate every digit, or
 * shredded the line around a stub configured value, would pass every leak assertion above and
 * leave the operator with a log that no longer says WHAT went wrong.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { onayAl } from "../src/approval.js";
import {
  agDogrula,
  __setCagriYonlendirmeKanalForTests,
  __setCihazDegisimKanalForTests,
  __setErisimKanalForTests,
  __setKonumKanalForTests,
  __setSimSwapKanalForTests,
} from "../src/networkTrust.js";
import type { AgAyar, AgIz, AgRisk } from "../src/networkTrust.js";

const TELEFON = "+905551112233";
/** The number as digits alone — one of the three ways a leak is looked for. */
const RAKAM_DIZISI = "905551112233";
const MASKELI = "+905*******33";

/**
 * DELIBERATELY SHAPELESS. This token carries no provider prefix, is no JWT and is under the
 * opaque-run length, so NO shape rule can catch it: the only thing between it and the
 * operator's terminal is the by-VALUE redaction of the secret this server holds. A realistic
 * `nac_tok_…` value would be masked by the 32-character opaque rule even with the value path
 * broken, and the test would then be measuring the wrong defence.
 */
const JETON = "TEST-ONLY-n4C-ops-2026-anahtar";

const ESC = String.fromCharCode(27);

/** Every channel override is module-global; a leak here poisons later files. */
afterEach(() => {
  __setSimSwapKanalForTests(undefined);
  __setErisimKanalForTests(undefined);
  __setKonumKanalForTests(undefined);
  __setCihazDegisimKanalForTests(undefined);
  __setCagriYonlendirmeKanalForTests(undefined);
});

function rakamlar(metin: string): string {
  return metin.replace(/\D/g, "");
}

/**
 * Percent-escapes resolved. `%2B90%20555…` is a spelling of the number, but its digits as
 * PRINTED are "2902055…" — the escapes inject 2s and 0s and break the run apart. Decoding
 * first is what lets a digit comparison see that spelling at all.
 */
function yuzdeCoz(metin: string): string {
  return metin.replace(/%([0-9A-Fa-f]{2})/g, (_tam: string, onalti: string) =>
    String.fromCharCode(parseInt(onalti, 16))
  );
}

/**
 * DID THE NUMBER SURVIVE IN ANY READABLE FORM? Three independent ways, because no single one
 * covers the spellings CAMARA produces:
 *   1. the raw spelling exactly as the upstream wrote it (catches escapes and separators a
 *      digit comparison cannot see),
 *   2. the digits as printed (catches any punctuation a future redaction forgets),
 *   3. the digits after percent-decoding (catches the `%2B`/`%20` spellings).
 * Any one of the three is a leak.
 */
function numaraSizdiMi(metin: string, hamYazim?: string): boolean {
  if (hamYazim && metin.includes(hamYazim)) return true;
  if (rakamlar(metin).includes(RAKAM_DIZISI)) return true;
  return rakamlar(yuzdeCoz(metin)).includes(RAKAM_DIZISI);
}

async function stderrYakala<T>(is: () => Promise<T>): Promise<{ sonuc: T; yazilanlar: string }> {
  const gercek = console.error;
  let yazilanlar = "";
  console.error = (...p: unknown[]) => {
    yazilanlar += p.map(String).join(" ") + "\n";
  };
  try {
    return { sonuc: await is(), yazilanlar };
  } finally {
    console.error = gercek;
  }
}

/**
 * A CAMARA 4xx as the NaC SDK really surfaces it, carrying everything the contract protects at
 * once: the number in four spellings (not one of them the literal E.164 form), the NaC token
 * this server holds, and an ANSI sequence chosen by whoever wrote the upstream text.
 */
function upstreamHatasi(): never {
  throw new Error(
    'Status 400. Body: {"message":"invalid phoneNumber %2B905551112233 ' +
      "(905551112233) [+90 555 111 22 33] [%2B90%20555%20111%2022%2033] " +
      `tok=${JETON}"}${ESC}[31m`
  );
}

/** Every link real and switched on, so the chain reaches the one under test. */
const AYAR: AgAyar = {
  nacToken: JETON,
  approverPhone: TELEFON,
  simSwapWindowHours: 72,
  reachCheck: true,
  devSwapCheck: true,
  callFwdCheck: true,
  expectedCountry: "TR",
};

function temizKanallar(): void {
  __setSimSwapKanalForTests({ verifySimSwap: async () => false });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: ["TR"] }) });
  __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => false });
  __setCagriYonlendirmeKanalForTests({ kosulsuzYonlendirmeAcikMi: async () => false });
}

/**
 * All five catch branches, each identified by its OWN trace field — not by the wording of its
 * stderr line. Which link ran is a behaviour the gate declares itself (AgIz); asserting on the
 * Turkish log prefix would pin the text instead.
 */
const HALKALAR: ReadonlyArray<{
  readonly id: string;
  readonly izAlani: keyof AgIz;
  readonly risk: AgRisk;
  readonly patlat: () => void;
}> = [
  {
    id: "simSwap",
    izAlani: "simSwap",
    risk: "medium",
    patlat: () => __setSimSwapKanalForTests({ verifySimSwap: upstreamHatasi }),
  },
  {
    id: "reach",
    izAlani: "reach",
    risk: "high",
    patlat: () => __setErisimKanalForTests({ cihazErisilebilirMi: upstreamHatasi }),
  },
  {
    id: "loc",
    izAlani: "loc",
    risk: "high",
    patlat: () => __setKonumKanalForTests({ ulkeDurumu: upstreamHatasi }),
  },
  {
    id: "devSwap",
    izAlani: "devSwap",
    risk: "high",
    patlat: () => __setCihazDegisimKanalForTests({ cihazDegistiMi: upstreamHatasi }),
  },
  {
    id: "callFwd",
    izAlani: "callFwd",
    risk: "high",
    patlat: () => __setCagriYonlendirmeKanalForTests({ kosulsuzYonlendirmeAcikMi: upstreamHatasi }),
  },
];

for (const halka of HALKALAR) {
  test(`SIZINTI SENTİNELİ: ${halka.id} halkasının hata dalı numarayı, jetonu ve ANSI'yi stderr'e YAZMAZ`, async () => {
    temizKanallar();
    halka.patlat();

    const { sonuc, yazilanlar } = await stderrYakala(() => agDogrula(AYAR, halka.risk));

    // The link really ran and really fell into its catch branch — otherwise a "clean" stderr
    // would prove nothing at all.
    assert.equal(sonuc.iz[halka.izAlani], "gercek", `${halka.id}: halka gerçekten koşmalı`);
    assert.equal(sonuc.iz.retNedeni, "ag-yanitsiz", `${halka.id}: yanıtsız kontrol REDDE gitmeli`);
    assert.ok(sonuc.engel, `${halka.id}: yanıtsız kontrolde engel dönmeli (fail-closed)`);

    // The operator still gets a usable line: deleting console.error must not be a way to pass.
    assert.ok(
      yazilanlar.includes(MASKELI),
      `${halka.id}: operatör maskeli numarayı görmeli — stderr satırı hiç yazılmamış olabilir`
    );

    assert.equal(
      numaraSizdiMi(yazilanlar),
      false,
      `${halka.id}: onaylayıcının numarası stderr'e sızdı:\n${yazilanlar}`
    );
    assert.ok(!yazilanlar.includes(JETON), `${halka.id}: NaC jetonu stderr'e sızdı:\n${yazilanlar}`);
    assert.ok(
      !yazilanlar.includes(ESC),
      `${halka.id}: ANSI kaçışı operatörün terminaline ulaştı:\n${JSON.stringify(yazilanlar)}`
    );
    assert.equal(
      numaraSizdiMi(sonuc.engel ?? ""),
      false,
      `${halka.id}: onaylayıcının numarası ajana giden ret metnine sızdı`
    );
    assert.ok(
      !(sonuc.engel ?? "").includes(JETON),
      `${halka.id}: NaC jetonu ajana giden ret metnine sızdı`
    );
  });
}

/**
 * FORMAT INDEPENDENCE, spelling by spelling. The bug was not "one format was missed" but
 * "redaction was bound to a format", so the guard enumerates the spellings CAMARA and the SDK
 * actually produce — and compares them with numaraSizdiMi, which can see all of them (see the
 * file header: the digits-only comparison was blind to the percent-escaped one).
 */
const BICIMLER: readonly string[] = [
  "+905551112233",
  "%2B905551112233",
  "905551112233",
  "+90 555 111 22 33",
  "+90-555-111-22-33",
  "(90) 555 111 2233",
  "%2B90%20555%20111%2022%2033",
  "0090 555 111 22 33",
];

for (const bicim of BICIMLER) {
  test(`SIZINTI SENTİNELİ: "${bicim}" biçimi de maskelenir (maskeleme yazıma bağlı değil)`, async () => {
    temizKanallar();
    __setSimSwapKanalForTests({
      verifySimSwap: () => {
        throw new Error(`Status 400. Body: {"phoneNumber":"${bicim}"}`);
      },
    });

    const { sonuc, yazilanlar } = await stderrYakala(() => agDogrula(AYAR, "medium"));

    assert.equal(sonuc.iz.simSwap, "gercek");
    assert.ok(yazilanlar.includes(MASKELI), `"${bicim}": maskeli numara satırda olmalı`);
    assert.equal(
      numaraSizdiMi(yazilanlar, bicim),
      false,
      `"${bicim}" biçimi maskelenmeden stderr'e düştü:\n${yazilanlar}`
    );
  });
}

/**
 * THE SIBLING PATH. src/approval.ts writes the same kind of line out of a failed elicitation,
 * and it held the approver number and the NaC token in `ozet.agAyar` the whole time while
 * masking only the literal E.164 spelling. One cleaner now serves both files; this test is
 * what keeps the second caller wired to it.
 */
function sahteSunucu(firlat: unknown): any {
  return {
    server: {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      elicitInput: async () => {
        throw firlat;
      },
    },
  };
}

test("SIZINTI SENTİNELİ (kardeş yol): approval.ts stderr satırı HER yazımı ve jetonu maskeler", async () => {
  for (const bicim of BICIMLER) {
    const { sonuc, yazilanlar } = await stderrYakala(() =>
      // `risk` is deliberately absent: no CAMARA link is consulted, so what this measures is
      // the approval file's OWN error channel and nothing else.
      onayAl(
        sahteSunucu(new Error(`Status 400. Body: {"phoneNumber":"${bicim}"} tok=${JETON}`)),
        { eylem: "kampanya YAYINA ALINACAK", satirlar: ["Günlük bütçe: 50"], agAyar: AYAR },
        undefined
      )
    );

    assert.equal(sonuc.onaylandi, false, "onay alınamadıysa işlem KOŞMAZ");
    assert.match(yazilanlar, /onay istemi başarısız/, "operatör satırı gerçekten yazılmalı");
    assert.equal(
      numaraSizdiMi(yazilanlar, bicim),
      false,
      `approval.ts: "${bicim}" yazımı stderr'e sızdı:\n${yazilanlar}`
    );
    assert.ok(!yazilanlar.includes(JETON), `approval.ts: NaC jetonu stderr'e sızdı:\n${yazilanlar}`);
  }
});

/**
 * THE FORGED TERMINAL. An upstream body is attacker-influenced text; with the escapes passed
 * through it does not merely look untidy — `ESC[2J ESC[1;1H` clears the operator's screen and
 * puts the next words at its top left, so a refusal can print a convincing "onaylandı" over
 * the evidence of the refusal. Both passes are asserted: the whole CSI sequence must go, not
 * just the ESC byte, or "[2J" survives as visible noise.
 */
test("SIZINTI SENTİNELİ: ANSI kaçışı terminali SİLİP sahte bir satır basamaz", async () => {
  temizKanallar();
  __setSimSwapKanalForTests({
    verifySimSwap: () => {
      throw new Error(`Status 500 ${ESC}[2J${ESC}[1;1H SAHTE: onaylandı ${ESC}[31m`);
    },
  });

  const { yazilanlar } = await stderrYakala(() => agDogrula(AYAR, "medium"));

  assert.ok(!yazilanlar.includes(ESC), `ESC baytı stderr'e ulaştı: ${JSON.stringify(yazilanlar)}`);
  assert.doesNotMatch(yazilanlar, /\[2J|\[1;1H|\[31m/, "CSI gövdesi de silinmeli");
  assert.match(yazilanlar, /Status 500/, "sır olmayan teşhis operatörde kalmalı");
});

/**
 * THE LENGTH OF THE LINE IS NOT THE UPSTREAM'S CHOICE. Measured before the cap: a
 * 5000-character body printed as 5047 characters of terminal, which buries every earlier line
 * of the operator's log — a denial of the log itself.
 */
test("SIZINTI SENTİNELİ: dev upstream gövdesi stderr'i basmaz — satır tavana bağlı", async () => {
  temizKanallar();
  __setSimSwapKanalForTests({
    verifySimSwap: () => {
      throw new Error("Status 500. Body: " + "Z".repeat(5000));
    },
  });

  const { yazilanlar } = await stderrYakala(() => agDogrula(AYAR, "medium"));

  assert.ok(yazilanlar.length < 600, `stderr satırı sınırsız: ${yazilanlar.length} karakter yazıldı`);
  assert.match(yazilanlar, /Status 500/, "tavan teşhisin BAŞINI kesmemeli");
});

/**
 * OVER-REDACTION, DIRECTION ONE: a stub configured value must not shred the diagnostic.
 * src/config.ts now REFUSES a non-E.164 AEGIS_APPROVER_PHONE, so the ENVIRONMENT can no longer
 * deliver the value below — but AgAyar is a plain object and the call two lines down builds one
 * by hand, exactly as any other in-process caller may; AEGIS_NAC_TOKEN is only trimmed in
 * config.ts and reaches the same floor. A one-character value therefore still gets to the
 * cleaner, and without a floor its digits match everywhere. Measured before the floor:
 * `Status 42***. Body: rate limited, retry after ***0 s`. What the operator lost there was the
 * HTTP status code, not a phone-shaped fragment.
 */
test("SIZINTI SENTİNELİ: kısa/bozuk AEGIS_APPROVER_PHONE tanı satırını PARÇALAMAZ", async () => {
  temizKanallar();
  __setSimSwapKanalForTests({
    verifySimSwap: () => {
      throw new Error("Status 429. Body: rate limited, retry after 90 s");
    },
  });

  const { yazilanlar } = await stderrYakala(() =>
    agDogrula({ ...AYAR, approverPhone: "9" }, "medium")
  );

  assert.match(yazilanlar, /Status 429\./, "durum kodunun ortası yıldızlanmamalı");
  assert.match(yazilanlar, /retry after 90 s/, "zaman bilgisi parçalanmamalı");
});

/**
 * OVER-REDACTION, DIRECTION TWO: stripping every digit would pass every leak assertion above
 * and leave the operator with a log that no longer says WHAT went wrong — the whole reason the
 * line is written.
 */
test("SIZINTI SENTİNELİ: numara içermeyen tanı bilgisi (durum kodu, süre) stderr'de KALIR", async () => {
  temizKanallar();
  __setSimSwapKanalForTests({
    verifySimSwap: () => {
      throw new Error("Status 503. Body: gateway timeout after 10000 ms");
    },
  });

  const { yazilanlar } = await stderrYakala(() => agDogrula(AYAR, "medium"));

  assert.match(yazilanlar, /503/, "durum kodu operatöre kalmalı");
  assert.match(yazilanlar, /10000/, "zaman aşımı değeri operatöre kalmalı");
});
