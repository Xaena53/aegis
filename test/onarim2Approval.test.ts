// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { onayAl } from "../src/approval.js";
import { maskele, type AgAyar } from "../src/networkTrust.js";

/**
 * Round-2 repair regressions for src/approval.ts — the OPERATOR channel (stderr).
 *
 * Round 1 stopped the raw upstream error from reaching the agent. The reviewer then measured
 * what still reached stderr, which on a stdio MCP server IS the operator's log and terminal,
 * and the contract covers it word for word: "no token, no full phone number, no PII to the
 * agent, the LOG or the TERMINAL".
 *
 *  1. ORDER. hataOzeti() masked credential runs BEFORE it neutralised control bytes. JS does
 *     not count NUL, TAB or an ESC sequence as `\s`, so `Bearer<NUL>sk-live-…` matched
 *     nothing — and the control-stripping pass that ran next turned the NUL into a space and
 *     handed the operator a perfectly readable token. One byte, chosen by whoever wrote the
 *     upstream error text (the side the threat model treats as attacker-controlled),
 *     disarmed the mask; the following line re-armed the leak.
 *
 *  2. COVERAGE. The mask only ever fired on four fixed prefixes. A bare provider token, a
 *     JWT and a full E.164 number went to stderr untouched — and approval.ts held the
 *     approver's number and the NaC token in `ozet.agAyar` the whole time without redacting
 *     either, while networkTrust.ts redacts the number in its own stderr line.
 *
 * Every assertion below drives the real onayAl() path: a client that advertises elicitation,
 * an elicitInput that throws, and the one console.error the catch block writes.
 */

const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const ESC = String.fromCharCode(27);

const AYAR: AgAyar = {
  nacToken: "TEST-ONLY-nac-token-9f2b",
  approverPhone: "+905551112277",
  simSwapWindowHours: 72,
  reachCheck: false,
  devSwapCheck: false,
  callFwdCheck: false,
};

/** A client WITH elicitation whose prompt call fails — the only path that reaches stderr. */
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

/**
 * Runs the gate against a failing prompt and returns what the operator actually sees.
 * `risk` is deliberately left off so no CAMARA link is consulted: this file is about the
 * error channel, and agAyar reaches hataOzeti() whether or not the network gate ran.
 */
async function operatorSatiri(
  hataMetni: string,
  agAyar?: AgAyar
): Promise<{ stderr: string; ajanMesaji: string }> {
  const yakalanan: string[] = [];
  const asil = console.error;
  console.error = (...a: unknown[]) => {
    yakalanan.push(a.map(String).join(" "));
  };
  let sonuc;
  try {
    sonuc = await onayAl(
      sahteSunucu(new Error(hataMetni)),
      { eylem: "kampanya YAYINA ALINACAK", satirlar: ["Günlük bütçe: 50"], ...(agAyar ? { agAyar } : {}) },
      undefined
    );
  } finally {
    console.error = asil;
  }
  assert.equal(sonuc!.onaylandi, false, "onay alınamadıysa işlem KOŞMAZ");
  assert.equal(yakalanan.length, 1, "operatör körleşmemeli: ayrıntı tam bir kez yazılmalı");
  return { stderr: yakalanan[0], ajanMesaji: sonuc!.mesaj ?? "" };
}

/* ── Kusur 1: tek kontrol baytı maskeyi silahsızlandırıyordu ──────────────────── */

/**
 * DELIBERATELY SHAPELESS. This credential carries no provider prefix, is no JWT, is under
 * the opaque-run length and is no phone number: the ONLY thing standing between it and the
 * operator's terminal is the `bearer\s+` prefix mask. If the control-byte pass ever moves
 * back behind that mask, nothing else in the pipeline catches this string — which is exactly
 * what the reviewer measured, and exactly what these two tests have to be able to see.
 */
const CIPLAK = "A7c9-plain-credential";

test("SIRA: kontrol baytı maskeyi ATLATAMAZ — NUL ile ayrılmış Bearer kimlik bilgisi", async () => {
  const { stderr } = await operatorSatiri(`auth failed: Bearer${NUL}${CIPLAK}`);

  assert.ok(
    !stderr.includes(CIPLAK),
    `kimlik bilgisi operatör terminaline SIZDI: ${JSON.stringify(stderr)}`
  );
  assert.ok(!stderr.includes("plain-credential"), "sırrın gövdesi parça parça da görünmemeli");
  assert.match(stderr, /Bearer \*\*\*/, "maske çalışmalı: önek kalır, sır yıldızlanır");
});

test("SIRA: TAB, ESC ve CSI dizisi de ayraç olarak maskeyi atlatamaz", async () => {
  for (const ayrac of [TAB, ESC, `${ESC}[0m`, `${ESC}[31m${ESC}[1m`, NUL + NUL]) {
    const { stderr } = await operatorSatiri(`upstream: Bearer${ayrac}${CIPLAK}`);
    assert.ok(
      !stderr.includes(CIPLAK) && !stderr.includes("plain-credential"),
      `ayraç ${JSON.stringify(ayrac)} maskeyi atlattı: ${JSON.stringify(stderr)}`
    );
    assert.match(stderr, /Bearer \*\*\*/, "ayraç silinip önek sırra yapıştırılmamalı");
  }
});

test("SIRA: kontrol baytı ayıklaması maskeyi SİLMEZ — ANSI hâlâ terminale ulaşmaz", async () => {
  const { stderr } = await operatorSatiri(
    `MCP error -32001 ${ESC}[31m<<HAM>>${ESC}[0m token=sk-live-ANSI11`
  );

  assert.ok(!stderr.includes(ESC), "ANSI kaçışı terminali boyayamamalı");
  assert.ok(!stderr.includes("sk-live-ANSI11"), "token sızmamalı");
  assert.match(stderr, /token=\*\*\*/, "önekli kimlik bilgisi maskesi yerinde kalmalı");
  assert.match(stderr, /MCP error -32001/, "operatör teşhis edebilmeli: sır olmayan metin kalır");
});

/* ── Kusur 2: öneksiz sır / JWT / tam numara maskesiz gidiyordu ───────────────── */

test("KAPSAM: öneksiz token, JWT ve tam E.164 numara stderr'e MASKESİZ gitmez", async () => {
  const { stderr } = await operatorSatiri(
    "boom sk-live-NAKED42 eyJhbGciOiJIUzI1NiJ9.abc.def +905551112277"
  );

  assert.ok(!stderr.includes("sk-live-NAKED42"), `çıplak token sızdı: ${JSON.stringify(stderr)}`);
  assert.ok(!stderr.includes("eyJhbGciOiJIUzI1NiJ9"), "JWT sızdı");
  assert.ok(!stderr.includes("+905551112277"), "tam telefon numarası sızdı");
  assert.match(stderr, /^\[aegis\] onay istemi başarısız: boom /, "teşhis çerçevesi korunmalı");
});

test("KAPSAM: uzun opak sır-biçimli dizi (öneksiz, harf+rakam) maskelenir", async () => {
  const sir = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
  assert.equal(sir.length, 32, "sınır: kural 32 karakterden başlar");
  const { stderr } = await operatorSatiri(`refresh token rejected: ${sir}`);
  assert.ok(!stderr.includes(sir), `opak sır sızdı: ${JSON.stringify(stderr)}`);
});

test("KAPSAM: elimizdeki sırlar ADIYLA redakte edilir — numara networkTrust ile AYNI biçimde", async () => {
  // AgAyar declares both fields optional, so they are narrowed once here: this fixture sets
  // them, and asserting that at the top keeps the three checks below readable AND keeps
  // `npm run typecheck` (tsconfig.check.json, which — unlike the default config — compiles
  // test/) green. CI runs that gate, so a `string | undefined` slipping into includes() is a
  // red build, not a style nit.
  const numara = AYAR.approverPhone;
  const jeton = AYAR.nacToken;
  assert.ok(numara && jeton, "düzenek hatası: fixture hem numarayı hem jetonu tanımlamalı");

  const { stderr, ajanMesaji } = await operatorSatiri(
    `CAMARA 400: phoneNumber ${numara} rejected with ${jeton}`,
    AYAR
  );

  assert.ok(!stderr.includes(numara), "onaylayıcının ham numarası günlüğe yazılamaz");
  assert.ok(!stderr.includes(jeton), "NaC token'ı günlüğe yazılamaz");
  assert.ok(
    stderr.includes(maskele(numara)),
    `numara networkTrust.ts'in maskele() biçimiyle görünmeli: ${JSON.stringify(stderr)}`
  );
  assert.ok(!ajanMesaji.includes(numara), "ajan kanalı da ham numarayı görmez");
});

test("KAPSAM: boş/kısa yapılandırma değeri satırı PARÇALAMAZ (split(\"\") koruması)", async () => {
  const bozuk = { ...AYAR, nacToken: "", approverPhone: "+90555" } as AgAyar;
  const { stderr } = await operatorSatiri("upstream said no", bozuk);

  assert.match(stderr, /upstream said no/, "teşhis metni yıldıza boğulmamalı");
});

/* ── Sınır: kırpma EN SONDA, tavan hâlâ yerinde ───────────────────────────────── */

test("SINIR: kırpma en sonda uygulanır — tavan korunur, kırpılan sır önek bırakmaz", async () => {
  const { stderr } = await operatorSatiri("Z".repeat(280) + " token=sk-live-CUTOFF");

  assert.ok(stderr.length < 600, `stderr ayrıntısı sınırlı olmalı (uzunluk: ${stderr.length})`);
  assert.ok(!stderr.includes("sk-live-CUTOFF"), "kırpma sınırındaki sır sızmamalı");
  assert.ok(!stderr.includes("sk-live"), "sırrın öneki bile kalmamalı");
});

/**
 * The cap is what BIÇİM-based rules cannot survive: a 36-character opaque run cut at 19 is
 * no longer 32 characters long, so nothing recognises it as a secret any more. Cutting first
 * and masking afterwards leaves every prefix assertion above green — this is the only test
 * that sees it.
 */
test("SINIR: tavan MASKELERDEN SONRA uygulanır — yarısı kesilmiş opak sır sızmaz", async () => {
  const uzunSir = "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8";
  assert.equal(uzunSir.length, 36, "sır, tavana yakın yerde kesilecek kadar uzun olmalı");
  const { stderr } = await operatorSatiri("Z".repeat(280) + " " + uzunSir);

  assert.ok(!stderr.includes(uzunSir), "sır bütünüyle sızmamalı");
  assert.ok(
    !stderr.includes(uzunSir.slice(0, 16)),
    `sırrın kesilmiş yarısı sızdı: ${JSON.stringify(stderr.slice(-60))}`
  );
  assert.ok(stderr.length < 600, `tavan yine de geçerli olmalı (uzunluk: ${stderr.length})`);
});

/* ── Yorum ↔ kod tutarlılığı: yanlış yorum bir hatadır ────────────────────────── */

const KAYNAK = readFileSync(fileURLToPath(new URL("../src/approval.ts", import.meta.url)), "utf8");
/** Block-comment line prefixes are stripped so sentences are not cut at line ends. */
const DUZ = KAYNAK.replace(/\r?\n[ \t]*\*[ \t]?/g, " ");

/**
 * The FOURTH copy of a promise the previous round removed from networkTrust.ts three times.
 * Nothing here lowers a spending ceiling on an escalation: KademeKarari carries no ceiling,
 * OnaySonucu never returns the escalation to the caller, and onaySonrasiKelepce re-reads the
 * tenant's unchanged maxDailyBudget. The watchdog that guards the other three copies scans
 * networkTrust.ts only, so this file needed its own.
 */
test("yorum: approval.ts VAR OLMAYAN 'indirilmiş tavan' telafisini vaat etmiyor", () => {
  assert.doesNotMatch(
    DUZ,
    /a lowered ceiling|lowers the ceiling/i,
    "approval.ts hâlâ 'indirilmiş tavan' vaat ediyor; kodda tavanı indiren bir satır yok"
  );
  assert.match(
    DUZ,
    /NO SPENDING CEILING IS LOWERED/,
    "telafinin ne OLMADIĞI açıkça yazılı kalmalı"
  );
});

/**
 * The helper's own docblock used to document a danger that does not exist ("a cut token
 * still leaks its prefix") while saying nothing about the one that did: the control byte.
 * A comment that names the wrong hazard is what let the real one survive a review.
 */
test("yorum: hataOzeti() docblock'u GERÇEK tehlikeyi (kontrol baytı) adıyla anlatıyor", () => {
  const blok = DUZ.slice(DUZ.indexOf("Turns an exception into a line safe"));
  assert.match(blok, /control bytes are neutralised BEFORE the credential mask/i);
  assert.doesNotMatch(
    blok,
    /masking has to happen before anything is truncated/i,
    "kırpma-öncesi-maskeleme gerekçesi ölçülerek yanlışlandı; belge onu tekrar etmemeli"
  );
});
