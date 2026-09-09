// SPDX-License-Identifier: AGPL-3.0-only
/**
 * THE STDIO ENTRY POINT'S CRASH HANDLERS — nothing the contract protects may reach the
 * operator's terminal out of an unexpected error, and an uncaught exception must CLOSE THE
 * DOOR rather than leave a server running on undefined state.
 *
 * WHY THIS FILE EXISTS. src/index.ts is the entry point of the product's PRIMARY mode, and its
 * two `process.on` handlers used to pass the exception OBJECT straight to console.error, which
 * prints it with util.inspect and walks its own enumerable properties. Measured by spawning
 * the real entry point with AEGIS_NAC_TOKEN / AEGIS_APPROVER_PHONE set and failing with an
 * error shaped the way the NaC and google-ads clients really shape one:
 *
 *     [aegis] uncaughtException: Error: NaC 400: invalid phoneNumber %2B905551112233
 *       response: { body: 'Bearer TEST-ONLY-... for +90 555 111 22 33', status: 400 }
 *       config: { headers: { authorization: 'Bearer TEST-ONLY-...' } }
 *     [gozcu] SUREC HALA AYAKTA        <- and it was still serving MCP afterwards
 *
 * That is the application key verbatim, the approver's full number in two spellings and the
 * raw upstream body — on a stdio server stderr IS the operator's terminal and, under Claude
 * Desktop, a persistent log file — plus a process that kept answering tool calls after its
 * invariants had already broken. Exit code 1 below, and the absence of that "still alive"
 * marker, are what make the second half measurable.
 *
 * WHY IT IS SPAWNED INSTEAD OF IMPORTED. src/index.ts installs the handlers and then awaits
 * `server.connect(new StdioServerTransport())` at the top level; importing it from a test
 * would hijack the test runner's own stdin/stdout. The child is the real file, run the way
 * `npm run dev` runs it, so what is asserted here is the entry point's actual behaviour and
 * not a re-implementation of it.
 *
 * WHY THE LEAK IS LOOKED FOR THREE WAYS (a lesson this repo paid for once in
 * test/agSizintiStderr.test.ts): a digits-only comparison CANNOT FAIL for the spelling
 * `%2B90%20555%20111%2022%2033`, because the percent escapes inject 2s and 0s into the digit
 * stream and the sought run never forms. The raw spelling, the digits as printed and the
 * digits after percent-decoding are therefore all checked.
 *
 * AND WHY EACH CASE ALSO ASSERTS WHAT SURVIVED. A handler that printed nothing at all, or one
 * that ate every character of the diagnostic, would pass every leak assertion above and leave
 * the operator with a log that no longer says what went wrong. Each case demands the upstream
 * status ("NaC 400") back.
 *
 * MUTATION-PROVEN. With both handlers put back to `console.error("[aegis] ...:", e)`, the
 * first case fails on the token and on the number, and the second on the exit code; with only
 * `process.exit(1)` removed, the second case fails on the marker and on the exit code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const KOK = path.join(import.meta.dirname, "..");

/** E.164 spelling of the approver's number, as configured. */
const TELEFON = "+905551112233";
/** The same number as digits alone — one of the three ways the leak is looked for. */
const RAKAM_DIZISI = "905551112233";

/**
 * DELIBERATELY SHAPELESS, exactly as in test/agSizintiStderr.test.ts: no provider prefix, no
 * JWT shape, and under the 32-character opaque-run length, so NO shape rule can catch it. The
 * only thing between this value and the operator's terminal is the by-VALUE redaction of the
 * secret the process HOLDS. A realistic `nac_tok_...` value would be masked by a shape rule
 * even with the value path broken, and the test would then measure the wrong defence.
 */
const JETON = "TEST-ONLY-n4C-ops-2026-anahtar";

/** Printed by the child if it is still alive a beat after the crash. */
const AYAKTA = "[gozcu] SUREC HALA AYAKTA";

type Kosu = { kod: number | null; sinyal: NodeJS.Signals | null; stderr: string; stdout: string };

/**
 * Runs the REAL entry point and makes it fail the way an SDK fails outside a tool wrapper —
 * on a timer callback, that is at a boundary no `try` of ours encloses.
 *
 * The failure is scheduled AFTER the dynamic import resolves, so it can never race the handler
 * registration: index.ts finishes its top-level `await server.connect(...)` first, and only
 * then is the timer armed.
 */
function kaza(kip: "throw" | "reject"): Kosu {
  const kod = [
    `await import("./src/index.ts");`,
    `const e = new Error("NaC 400: invalid phoneNumber %2B905551112233");`,
    // The secrets live in FIELDS, not in the message: this is what util.inspect used to walk.
    `e.response = { body: "Bearer ${JETON} for +90 555 111 22 33", status: 400 };`,
    `e.config = { headers: { authorization: "Bearer ${JETON}" } };`,
    `setTimeout(() => { ${kip === "reject" ? "Promise.reject(e);" : "throw e;"} }, 50);`,
    `setTimeout(() => { console.error(${JSON.stringify(AYAKTA)}); process.exit(7); }, 1500);`,
  ].join("\n");
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", kod], {
    cwd: KOK,
    // The configured values WIN over .env: dotenv does not overwrite an existing variable, so
    // the operator's real number and key never enter this measurement.
    env: { ...process.env, AEGIS_APPROVER_PHONE: TELEFON, AEGIS_NAC_TOKEN: JETON },
    encoding: "utf8",
    timeout: 90_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(r.error, undefined, `alt sürec başlatılamadı: ${r.error?.message}`);
  assert.notEqual(r.signal, "SIGTERM", "alt süreç zaman aşımına uğradı — ölçüm yapılamadı");
  return { kod: r.status, sinyal: r.signal, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

/** Digits as PRINTED, and digits after percent-decoding — see the file docblock. */
function numaraSizdiMi(metin: string): boolean {
  if (metin.includes(TELEFON)) return true;
  if (metin.replace(/\D/g, "").includes(RAKAM_DIZISI)) return true;
  let cozulmus = metin;
  try {
    cozulmus = decodeURIComponent(metin.replace(/%(?![0-9A-Fa-f]{2})/g, "%25"));
  } catch {
    /* a malformed escape stays as it is; the two checks above already ran */
  }
  return cozulmus.replace(/\D/g, "").includes(RAKAM_DIZISI);
}

function sizintiYok(stderr: string, etiket: string): void {
  assert.ok(!stderr.includes(JETON), `${etiket}: NaC anahtarı stderr'e düştü`);
  assert.ok(!numaraSizdiMi(stderr), `${etiket}: onaylayıcının tam numarası stderr'e düştü`);
  assert.ok(!/Bearer\s+\S/.test(stderr), `${etiket}: ham Authorization başlığı stderr'e düştü`);
  assert.ok(!stderr.includes("response:"), `${etiket}: ham upstream gövdesi stderr'e düştü`);
}

test("uncaughtException: temizlenmiş tek satır, ham hata nesnesi yok", () => {
  const r = kaza("throw");
  sizintiYok(r.stderr, "uncaughtException");
  // The opposite direction: over-redaction that leaves the operator with nothing is a failure
  // too. The handler must still say WHICH upstream failure this was.
  assert.match(r.stderr, /\[aegis\] uncaughtException: /);
  assert.ok(r.stderr.includes("NaC 400"), "tanı satırı boşaltılmış — operatöre hiçbir şey kalmıyor");
  // The masked form proves the by-value redaction ran, rather than the text having been cut.
  assert.ok(r.stderr.includes("+905*******33"), "numara maskelenmiş hâliyle bile görünmüyor");
  // stdout is the MCP JSON-RPC channel: not one byte of a diagnostic may go there.
  assert.equal(r.stdout, "");
});

test("uncaughtException: süreç KAPANIR — tanımsız durumda MCP konuşmaya devam etmez", () => {
  const r = kaza("throw");
  assert.ok(
    !r.stderr.includes(AYAKTA),
    "yakalanmamış istisnadan sonra süreç ayakta kaldı: bir sonraki araç çağrısı, yarım " +
      "kalmış bir mutasyonun ve bilinmeyen bir ağ kapısı kararının üstüne para hareketi yapar"
  );
  assert.equal(r.kod, 1, "kapalı arıza beklenirdi (çıkış kodu 1)");
});

test("unhandledRejection: temizlenmiş tek satır, ham hata nesnesi yok", () => {
  const r = kaza("reject");
  sizintiYok(r.stderr, "unhandledRejection");
  assert.match(r.stderr, /\[aegis\] unhandledRejection: /);
  assert.ok(r.stderr.includes("NaC 400"), "tanı satırı boşaltılmış — operatöre hiçbir şey kalmıyor");
  assert.equal(r.stdout, "");
});
