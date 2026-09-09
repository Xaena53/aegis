// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Round-4 regression watchers for src/approval.ts.
 *
 * THE FINDING ("the step-up comment promises a LOWERED CEILING that nothing applies") WAS
 * ALREADY CLOSED before this round, and no source line was changed for it here. Measured:
 * `grep -n "a lowered ceiling" src/approval.ts` is empty, and commit 76679d4 replaced the
 * fourth item of the trade with "and a REFUSAL wherever that prompt cannot be shown" plus an
 * explicit NO SPENDING CEILING IS LOWERED paragraph. What this file adds is the part of the
 * watchdog that was missing, and it is missing in a specific way.
 *
 * WHAT WAS ALREADY PINNED, AND WHAT WAS NOT. test/approval.test.ts drives a real escalation
 * and checks the prompt header, the changed question and the weak-channel refusal.
 * test/faz3Approval.test.ts and test/onarim2Approval.test.ts pin the HEADLINE of the denial
 * ("NO SPENDING CEILING IS LOWERED") and the absence of the old promise, and read the source
 * text of the OnaySonucu interface. Measured with grep across test/ (the phrases below have a
 * single hit, and it is PROSE inside a comment in test/onarim2Approval.test.ts, not an
 * assertion): nothing pinned the two lists the paragraph actually rests on —
 *   (a) the three things the gate now gives INSTEAD of a ceiling ("a prompt that names the
 *       degraded signal, a changed question, and a REFUSAL wherever that prompt cannot be
 *       shown"), and
 *   (b) the three mechanisms the denial names as its reasons ("KademeKarari carries no
 *       ceiling", "OnaySonucu never carries the escalation back to the caller",
 *       "onaySonrasiKelepce re-reads the tenant's UNCHANGED maxDailyBudget").
 * Either list could be rewritten, shortened or reversed and every gate stayed green. A
 * paragraph that argues "no ceiling is lowered, and here is why" is worth exactly as much as
 * its reasons, so the reasons are what this file measures.
 *
 * THE WATCHERS ARE TWO-WAY BY CONSTRUCTION. The behaviour tests measure the three mechanisms
 * at run time, so they go red when the CODE moves away from the paragraph; the source test
 * pins the two lists, so it goes red when the PARAGRAPH moves away from the code. Neither can
 * pass on a vacuum: the code side runs a genuine escalation through agDogrula() (a swapped SIM
 * vouched for by two clean links) and compares it against a clean run, and the source side
 * asserts its anchors were found before it asserts anything about what lies between them.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { onayAl, onaySonrasiKelepce } from "../src/approval.js";
import {
  __setSimSwapKanalForTests,
  __setErisimKanalForTests,
  __setKonumKanalForTests,
  type AgAyar,
} from "../src/networkTrust.js";

/** Step-up ON, and two links (reachability, location) able to vouch for a swapped SIM. */
const AG_AYARI: AgAyar = {
  nacToken: "TEST-ONLY-nac-token",
  approverPhone: "+905550000000",
  simSwapWindowHours: 72,
  reachCheck: true,
  devSwapCheck: false,
  callFwdCheck: false,
  expectedCountry: "TR",
  stepUp: true,
};

/**
 * The account ceiling and the amount this decision is about are DELIBERATELY EQUAL. That is
 * the measurement the whole finding turns on: if an escalation lowered the ceiling by any
 * amount at all, a spend sitting exactly ON the ceiling would stop passing.
 */
const TAVAN = 500;
const TUTAR = 500;

/** The network as the links see it: only the SIM signal differs between the two runs. */
function kanallar(simDegisti: boolean): void {
  __setSimSwapKanalForTests({ verifySimSwap: async () => simDegisti });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setKonumKanalForTests({
    ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: ["TR"] }),
  });
}

afterEach(() => {
  __setSimSwapKanalForTests(undefined);
  __setErisimKanalForTests(undefined);
  __setKonumKanalForTests(undefined);
});

interface Istem {
  metinler: string[];
  sorular: string[];
}

/** A client that advertises elicitation form support and records what it was asked to show. */
function elicitliSunucu(kayit: Istem): any {
  return {
    server: {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      elicitInput: async (istek: any) => {
        kayit.metinler.push(String(istek.message));
        kayit.sorular.push(String(istek.requestedSchema?.properties?.onay?.title ?? ""));
        return { action: "accept", content: { onay: true } };
      },
    },
  };
}

/** A client with no elicitation: there is no prompt to show, so there is no escalation. */
const elicitsizSunucu: any = { server: { getClientCapabilities: () => ({}) } };

function ozet() {
  return {
    eylem: `"Ayakkabı" kampanyası YAYINA ALINACAK — bu andan itibaren gerçek para harcanır.`,
    satirlar: [`Hesap: 1234567890 · Kampanya: 24120539226`, `Günlük bütçe: ${TUTAR}`],
    risk: "high" as const,
    agAyar: AG_AYARI,
    hesapId: "1234567890",
    tutar: TUTAR,
  };
}

/* ── (a) The three halves the gate gives INSTEAD of a ceiling ──────────────── */

test("BEDEL: yükseltme, istem başlığı + değişmiş soru + zayıf kanalda RET ile ödenir", async () => {
  /**
   * The comment's list, measured item by item, and each one against its CLEAN counterpart —
   * a constant string would satisfy the first assertion of every pair but not the second.
   */
  const kademeli: Istem = { metinler: [], sorular: [] };
  kanallar(true);
  const yukseltilmis = await onayAl(elicitliSunucu(kademeli), ozet(), undefined);

  const temiz: Istem = { metinler: [], sorular: [] };
  kanallar(false);
  const duz = await onayAl(elicitliSunucu(temiz), ozet(), undefined);

  assert.equal(yukseltilmis.onaylandi, true, "güçlü kanalda yükseltme yolu AÇIK kalmalı");
  assert.equal(duz.onaylandi, true, "temiz sinyalde de onay alınmalı — düzenek çalışıyor olmalı");
  assert.equal(kademeli.metinler.length, 1, "insana gerçekten sorulmuş olmalı");
  assert.equal(temiz.metinler.length, 1, "temiz koşuda da insana sorulmalı");

  // 1) A prompt that NAMES the degraded signal — and names none when there is none.
  assert.match(
    kademeli.metinler[0],
    /AĞ SİNYALİ BOZUK — onaylayıcının SIM kartı yakın zamanda değişmiş/,
    "bozuk sinyal insana ADIYLA söylenmeli; takasın birinci yarısı bu"
  );
  assert.doesNotMatch(
    temiz.metinler[0],
    /AĞ SİNYALİ BOZUK/,
    "temiz sinyalde uyarı çıkmamalı — yoksa başlık sabit bir metindir, yükseltmenin bedeli değil"
  );

  // 2) A CHANGED question: consent is given TO the degraded signal, not to a generic prompt.
  assert.match(
    kademeli.sorular[0],
    /Bozuk ağ sinyaline RAĞMEN onaylıyor musun\?/,
    "onay kutusunun sorusu bozuk sinyali anmalı; takasın ikinci yarısı bu"
  );
  assert.notEqual(
    kademeli.sorular[0],
    temiz.sorular[0],
    "yükseltilmiş soru ile olağan soru AYNI olamaz — değişmeyen bir soru bedel değildir"
  );

  // 3) A REFUSAL wherever that prompt cannot be shown — even with the agent claiming consent.
  kanallar(true);
  const zayif = await onayAl(elicitsizSunucu, ozet(), true);
  assert.equal(zayif.onaylandi, false, "istem gösterilemeyen istemcide yükseltme GEÇEMEZ");
  assert.equal(zayif.kanal, "ag", "ret ağ kapısına ait sayılmalı");
  assert.match(zayif.mesaj ?? "", /BU İSTEMCİDE YÜKSELTME YAPILAMAZ/);
  /**
   * The refusal itself names the signal too — measured separately, because the prompt and the
   * refusal are built from DIFFERENT strings (kademeIstemEylemi vs ozet.eylem). Dropping the
   * header from ozet.eylem leaves the prompt intact and silently strips the agent's only way
   * to pass the reason on to the user, so one assertion cannot stand in for the other.
   */
  assert.match(
    zayif.mesaj ?? "",
    /AĞ SİNYALİ BOZUK — onaylayıcının SIM kartı yakın zamanda değişmiş/,
    "ret metni de bozuk sinyali ADIYLA söylemeli; ajan bunu kullanıcıya ancak böyle aktarır"
  );
});

/* ── (b) The three mechanisms the denial rests on ──────────────────────────── */

test("TAVAN İNMEZ: yükseltilmiş onay, çağırana tavanı indirtecek hiçbir şey vermez", async () => {
  /**
   * "OnaySonucu never carries the escalation back to the caller" — measured at run time
   * rather than read off the interface. If the caller cannot even LEARN that an escalation
   * happened, it cannot pick a different ceiling for it; that absence IS the mechanism.
   */
  const kademeli: Istem = { metinler: [], sorular: [] };
  kanallar(true);
  const yukseltilmis = await onayAl(elicitliSunucu(kademeli), ozet(), undefined);

  const temiz: Istem = { metinler: [], sorular: [] };
  kanallar(false);
  const duz = await onayAl(elicitliSunucu(temiz), ozet(), undefined);

  /**
   * THE VACUUM GUARD, and it has to name the header rather than merely compare the two
   * prompts: the evidence lines already differ between a swapped-SIM run and a clean one, so
   * "the two prompts are not equal" stays true even when the escalation branch never runs —
   * measured. Only the header proves an escalation actually happened, and without one the
   * equality asserted below would be comparing two ordinary approvals.
   */
  assert.match(
    kademeli.metinler[0],
    /AĞ SİNYALİ BOZUK/,
    "düzenek gerçekten bir yükseltme koşturmalı — yoksa aşağıdaki eşitlik boş bir ölçümdür"
  );
  assert.doesNotMatch(
    temiz.metinler[0],
    /AĞ SİNYALİ BOZUK/,
    "karşılaştırma kolu yükseltilmemiş olmalı — iki koşu da yükseltilirse fark ölçülemez"
  );
  assert.deepEqual(
    yukseltilmis,
    duz,
    "yükseltilmiş onay ile olağan onay çağırana AYNI sonucu vermeli; fark taşıyan bir alan, " +
      "aşağı akışta 'kademede tavanı indir' dalının doğabileceği yerdir"
  );
  for (const [alan, deger] of Object.entries(yukseltilmis)) {
    assert.doesNotMatch(
      alan,
      /tavan|ceiling|kademe|limit|budget|bütçe|butce/i,
      `OnaySonucu artık '${alan}' alanını taşıyor: "hiçbir tavan indirilmez" cümlesi güncellenmeli`
    );
    assert.notEqual(
      typeof deger,
      "number",
      `OnaySonucu artık sayısal bir alan ('${alan}') döndürüyor — indirilmiş tavan böyle taşınır`
    );
  }

  /**
   * "onaySonrasiKelepce re-reads the tenant's UNCHANGED maxDailyBudget" — the escalated spend
   * runs against the FULL ceiling, and the clamp genuinely measures rather than always passing.
   */
  assert.equal(
    onaySonrasiKelepce({ writeEnabled: true, maxDailyBudget: TAVAN }, TUTAR),
    null,
    "tavana EŞİT tutar geçmeli; tavan yükseltmede indirilseydi burası reddederdi"
  );
  assert.match(
    onaySonrasiKelepce({ writeEnabled: true, maxDailyBudget: TAVAN }, TUTAR + 0.01) ?? "",
    /Reddedildi/,
    "tavanın üstü reddedilmeli — kelepçenin gerçekten ölçtüğünün kanıtı"
  );
  assert.equal(
    onaySonrasiKelepce.length,
    2,
    "kelepçeye üçüncü bir parametre eklenmiş: kademenin tavanı seçebileceği ilk yer burasıdır"
  );
});

/* ── The paragraph itself: both lists pinned, nothing stripped ─────────────── */

const KAYNAK = readFileSync(fileURLToPath(new URL("../src/approval.ts", import.meta.url)), "utf8");
/** Block-comment line prefixes joined, so a sentence can be matched across line breaks. */
const DUZ = KAYNAK.replace(/\r?\n[ \t]*\*[ \t]?/g, " ");

test("BELGE↔KOD: takas cümlesi üç yarımı sayar, dördüncüyü saymaz, gerekçeleri yazılı", () => {
  /**
   * ABSENCE IS ASKED OF THE WHOLE FILE, PRESENCE OF THE PARAGRAPH. Nothing is cut out before
   * the absence check: a watcher that strips a region and then claims a phrase is gone is only
   * as tight as its strip, and one strip too wide silently lets the promise back in. The
   * narrow slice carries the POSITIVE assertions only, where a slice that is too wide can make
   * a test pass by accident but can never hide a regression.
   */
  assert.doesNotMatch(
    DUZ,
    /a lowered ceiling|lowers the ceiling|indirilmiş tavan/i,
    "approval.ts yine var olmayan bir 'indirilmiş tavan' telafisi vaat ediyor"
  );

  const bas = DUZ.indexOf("AN ESCALATION PRODUCES NO PASS ON THE WEAK CHANNEL");
  const son = DUZ.indexOf("On a client without elicitation there IS no prompt to show");
  assert.ok(bas >= 0, "takas paragrafının başlangıcı bulunamadı — gözcü kör kalmamalı");
  assert.ok(son > bas, "takas paragrafının sonu bulunamadı — gözcü kör kalmamalı");
  const takas = DUZ.slice(bas, son);

  // The three halves the gate gives instead of a ceiling — each measured by the test above.
  const yarimlar: [string, RegExp][] = [
    ["istem bozuk sinyali adıyla söyler", /a prompt that names the degraded signal/],
    ["soru değişir", /a changed question/],
    ["istem gösterilemeyen istemcide RET", /a REFUSAL wherever that prompt cannot be shown/],
  ];
  for (const [cumle, kalip] of yarimlar) {
    assert.match(
      takas,
      kalip,
      `takasın karşılığı olarak yazılan "${cumle}" maddesi cümleden düştü; ölçülen davranış ` +
        `duruyor, yorum artık onu anlatmıyor`
    );
  }

  // The denial and the three mechanisms it rests on — each measured by the test above.
  assert.match(
    takas,
    /NO SPENDING CEILING IS LOWERED/,
    "telafinin ne OLMADIĞI açıkça yazılı kalmalı; cümle silinirse okuyucu yine yanlış varsayar"
  );
  const gerekceler: [string, RegExp][] = [
    ["KademeKarari tavan taşımaz", /KademeKarari carries no ceiling/],
    [
      "OnaySonucu kademeyi çağırana taşımaz",
      /OnaySonucu never carries the escalation back to the caller/,
    ],
    [
      "kelepçe tavanı değişmeden okur",
      /onaySonrasiKelepce re-reads the tenant's UNCHANGED maxDailyBudget/,
    ],
  ];
  for (const [mekanizma, kalip] of gerekceler) {
    assert.match(
      takas,
      kalip,
      `"tavan indirilmez" gerekçesindeki "${mekanizma}" maddesi kayboldu; gerekçesiz bir ` +
        `olumsuzlama, okuyucunun doğrulayamadığı bir iddiadır`
    );
  }
});
