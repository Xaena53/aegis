// SPDX-License-Identifier: AGPL-3.0-only
/**
 * THE STDIO ENTRY POINT CLOSES THE DOOR ON A REJECTION TOO — and the hosted entry point's
 * comment may not tell a maintainer that the two ends behave alike.
 *
 * WHY THIS FILE EXISTS. Two audited defects, both raised against src/index.ts:
 *
 *  (1) `process.on("unhandledRejection", …)` only LOGGED. Measured on Node v26.7.0: with no
 *      handler installed at all, an unhandled rejection is FATAL (the process dies with exit 1),
 *      so a log-only handler does not preserve Node's behaviour — it downgrades Node's own
 *      fail-closed default into fail-open. The comment above it called that asymmetry deliberate
 *      and justified it with "an unawaited side promise says nothing about the state of the
 *      mutation path", which src/http.ts contradicts in its own words: a rejection from an async
 *      function returned without `await` "escapes to the top level", i.e. a forgotten `await` on
 *      a tool path arrives exactly there, with the mutation half-applied.
 *
 *  (2) src/http.ts said "Both entry points need this — stdio mode installs the same handlers in
 *      index.ts." That sentence invited someone to copy the exit into hosted mode, where one
 *      dying request would evict every other tenant's live MCP session.
 *
 * WHAT IS MEASURED, AND WHAT IS ONLY READ. The first two cases SPAWN the real entry point and
 * make it fail the way an SDK fails outside a tool wrapper — the exit code and the surviving
 * diagnostic are observed, not inferred. The third case reads the two files and compares CODE to
 * CODE (which handler calls process.exit). The last two compare CODE to its own DOCUMENTATION;
 * they can only see text, so each is written as an exact-sentence check against the wording that
 * was measured false, plus a positive anchor a wholesale rewrite cannot silently drop.
 *
 * WHY IT IS SPAWNED INSTEAD OF IMPORTED (same reason as test/faz3Index.test.ts): src/index.ts
 * awaits `server.connect(new StdioServerTransport())` at the top level, so importing it here
 * would hijack the test runner's own stdin/stdout.
 *
 * MUTATION-PROVEN, every case, by putting into the SOURCE the thing the case must forbid:
 *   • `process.exit(1)` removed from the rejection handler          → cases 1 and 3 RED
 *   • the `console.error` line removed from that handler            → case 2 RED
 *   • `process.exit(1)` added to src/http.ts's rejection handler    → case 3 RED
 *   • the old "installs the same handlers" sentence put back        → case 4 RED
 *   • the old "does NOT take the process down" excuse put back      → case 5 RED
 *   • the quoted src/http.ts sentence reworded on either side       → case 6 RED
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const KOK = path.join(import.meta.dirname, "..");
const oku = (goreli: string): string => readFileSync(path.join(KOK, goreli), "utf8");
const INDEX = oku("src/index.ts");
const HTTP = oku("src/http.ts");

/** E.164 spelling of the approver's number, as configured for the child. */
const TELEFON = "+905551112233";
const RAKAM_DIZISI = "905551112233";
/** Shapeless on purpose: only the by-VALUE redaction can catch it (see test/faz3Index.test.ts). */
const JETON = "TEST-ONLY-faz5-reddetme-anahtari";
/** Printed by the child if it is still alive a beat after the rejection. */
const AYAKTA = "[gozcu] SUREC HALA AYAKTA";

type Kosu = { kod: number | null; stderr: string; stdout: string };

/**
 * Runs the REAL entry point and rejects a promise nobody awaits, at a timer boundary no `try` of
 * ours encloses. The rejection is armed only after the dynamic import resolves, so it can never
 * race the handler registration. Memoised: one child answers both observations.
 */
let kosuOnbellek: Kosu | undefined;
function reddet(): Kosu {
  if (kosuOnbellek) return kosuOnbellek;
  const kod = [
    `await import("./src/index.ts");`,
    `const e = new Error("NaC 400: yarim kalmis mutasyon");`,
    // The secrets live in FIELDS, not in the message: this is what util.inspect used to walk.
    `e.response = { body: "Bearer ${JETON} for +90 555 111 22 33", status: 400 };`,
    `setTimeout(() => { Promise.reject(e); }, 50);`,
    `setTimeout(() => { console.error(${JSON.stringify(AYAKTA)}); process.exit(7); }, 1500);`,
  ].join("\n");
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", kod], {
    cwd: KOK,
    // The configured values WIN over .env: dotenv does not overwrite an existing variable, so the
    // operator's real number and key never enter this measurement.
    env: { ...process.env, AEGIS_APPROVER_PHONE: TELEFON, AEGIS_NAC_TOKEN: JETON },
    encoding: "utf8",
    timeout: 90_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(r.error, undefined, `alt süreç başlatılamadı: ${r.error?.message}`);
  assert.notEqual(r.signal, "SIGTERM", "alt süreç zaman aşımına uğradı — ölçüm yapılamadı");
  kosuOnbellek = { kod: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
  return kosuOnbellek;
}

/**
 * The argument list of `process.on("<olay>", …)`, read with a paren counter that skips over
 * string and template literals so a `(` inside a message cannot unbalance it. Returns "" when
 * the handler is absent; every caller asserts on the body's content first, so a broken
 * extraction fails the case instead of passing it quietly.
 */
function isleyiciGovdesi(kaynak: string, olay: string): string {
  const bas = kaynak.indexOf(`process.on("${olay}"`);
  if (bas < 0) return "";
  const acilis = kaynak.indexOf("(", bas);
  let derinlik = 0;
  let tirnak: string | undefined;
  for (let i = acilis; i < kaynak.length; i++) {
    const c = kaynak[i];
    if (tirnak) {
      if (c === "\\") i++;
      else if (c === tirnak) tirnak = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") tirnak = c;
    else if (c === "(") derinlik++;
    else if (c === ")" && --derinlik === 0) return kaynak.slice(acilis + 1, i);
  }
  return "";
}

/** Comment markers and line breaks removed, so a sentence wrapped across lines reads as one. */
function duz(kaynak: string): string {
  return kaynak.replace(/^[ \t]*(?:\*\/|\*|\/\/)[ \t]?/gm, "").replace(/\s+/g, " ");
}

/** The docblock that sits immediately above `process.on("<olay>", …)`. */
function ustBelge(kaynak: string, olay: string): string {
  const bas = kaynak.indexOf(`process.on("${olay}"`);
  assert.ok(bas > 0, `${olay} işleyicisi bulunamadı — ölçüm bozuk`);
  const belgeBas = kaynak.lastIndexOf("/**", bas);
  assert.ok(belgeBas > 0, `${olay} işleyicisinin üstünde belge bloğu yok`);
  return kaynak.slice(belgeBas, bas);
}

test("unhandledRejection: süreç KAPANIR — yarım kalmış mutasyonun üstüne MCP konuşmaya devam etmez", () => {
  const r = reddet();
  assert.ok(
    !r.stderr.includes(AYAKTA),
    "beklenmeyen bir reddetmeden sonra süreç ayakta kaldı: unutulmuş bir `await` tam olarak buraya " +
      "düşer ve bir sonraki araç çağrısı, yarım kalmış bir mutasyonun üstüne para hareketi yapar"
  );
  assert.equal(
    r.kod,
    1,
    "kapalı arıza beklenirdi (çıkış kodu 1) — işleyici hiç kurulmasaydı Node'un kendi davranışı da " +
      "budur, yalnız günlükleyen bir işleyici o varsayılanı fail-open'a çevirir"
  );
});

test("unhandledRejection: kapanmadan ÖNCE temizlenmiş tanı satırı çıkar, sır sızmaz", () => {
  const r = reddet();
  // The opposite direction of the case above: exiting silently would leave the operator with a
  // dead process and no reason for it.
  assert.match(r.stderr, /\[aegis\] unhandledRejection: /);
  assert.ok(r.stderr.includes("NaC 400"), "tanı satırı boşaltılmış — operatöre hiçbir şey kalmıyor");
  assert.ok(!r.stderr.includes(JETON), "NaC anahtarı stderr'e düştü");
  assert.ok(!r.stderr.includes(TELEFON), "onaylayıcının tam numarası stderr'e düştü");
  assert.ok(!r.stderr.replace(/\D/g, "").includes(RAKAM_DIZISI), "numara rakam dizisi olarak stderr'e düştü");
  assert.ok(!/Bearer\s+\S/.test(r.stderr), "ham Authorization başlığı stderr'e düştü");
  // stdout is the MCP JSON-RPC channel: not one byte of a diagnostic may go there.
  assert.equal(r.stdout, "");
});

test("iki uç KODDA ayrışır: stdio her iki çöküş işleyicisinde çıkar, barındırılan uç hiçbirinde", () => {
  for (const olay of ["unhandledRejection", "uncaughtException"]) {
    const stdio = isleyiciGovdesi(INDEX, olay);
    assert.ok(stdio.includes("console.error"), `src/index.ts ${olay} gövdesi okunamadı — ölçüm bozuk`);
    assert.ok(
      stdio.includes("process.exit(1)"),
      `src/index.ts ${olay} işleyicisi çıkmıyor: süreç tanımsız durumda MCP konuşmaya devam eder`
    );
    const hosted = isleyiciGovdesi(HTTP, olay);
    assert.ok(hosted.includes("console.error"), `src/http.ts ${olay} gövdesi okunamadı — ölçüm bozuk`);
    assert.ok(
      !hosted.includes("process.exit"),
      `src/http.ts ${olay} işleyicisi süreci öldürüyor: barındırılan kipte tek bir isteğin hatası ` +
        `bellekteki HER kiracının MCP oturumunu tahliye eder`
    );
  }
});

test("src/http.ts'in çöküş ağı belgesi iki ucu AYNI göstermez", () => {
  const belge = ustBelge(HTTP, "unhandledRejection");
  // Exact-sentence check against the audited wording: what is forbidden here is the one sentence
  // that was measured false, not a class of sentences.
  assert.ok(
    !belge.includes("installs the same handlers"),
    "src/http.ts yine 'stdio mode installs the same handlers' diyor: kaynakta stdio çıkıyor, bu uç çıkmıyor"
  );
  // Positive anchor: a wholesale rewrite that drops the divergence fails here even if it never
  // reuses the old sentence.
  assert.ok(
    belge.includes("src/index.ts") && belge.includes("process.exit(1)"),
    "belge, diğer ucun (src/index.ts) process.exit(1) ile kapandığını söylemiyor — ayrışma belgesiz kalıyor"
  );
});

test("src/index.ts'in reddetme belgesi artık ayakta kalma vaadi taşımaz", () => {
  const belge = ustBelge(INDEX, "unhandledRejection");
  for (const bayat of ["does NOT take the process down", "the asymmetry with the handler"]) {
    assert.ok(!belge.includes(bayat), `bayat gerekçe geri geldi: "${bayat}" — kod artık çıkıyor`);
  }
  assert.ok(
    /CLOSES THE DOOR/.test(belge),
    "reddetme belgesi kapının kapandığını söylemiyor — belge koddan az şey söylüyor"
  );
});

/**
 * The new comment in src/index.ts does not merely refer to src/http.ts, it QUOTES it — and a
 * quotation is a claim about another file's present text. Reword either side and the quotation
 * marks in src/index.ts start attributing a sentence nobody wrote, which is the very defect
 * family this file was opened to close. Both sides are therefore pinned to the same string.
 */
test("src/index.ts'in src/http.ts'ten yaptığı ALINTI iki tarafta da birebir duruyor", () => {
  const alinti =
    "a rejection from an async function that is returned without being awaited never reaches " +
    "this try/catch. It escapes to the top level";
  assert.ok(
    duz(INDEX).includes(alinti),
    "src/index.ts artık bu cümleyi alıntılamıyor — alıntı değiştiyse gerekçe de değişmiştir"
  );
  assert.ok(
    duz(HTTP).includes(alinti),
    "src/http.ts o cümleyi artık böyle yazmıyor: src/index.ts tırnak içinde kimsenin yazmadığı " +
      "bir cümleyi src/http.ts'e mal ediyor"
  );
});
