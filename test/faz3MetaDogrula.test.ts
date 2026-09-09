// SPDX-License-Identifier: AGPL-3.0-only
/**
 * scripts/metaDogrula.mts — THE LEAK CANARY MUST SING BEFORE THE BIRD IS LET OUT.
 *
 * NEDEN VAR: the live Meta verification script holds a REAL access token and prints to the
 * operator's terminal (and, at a demo, to a projector). Its catch block used to print the
 * raw upstream error message first — `m.slice(0, 140)` — and only afterwards ask whether
 * that same text contained the token. Measured against the real script with the transport
 * stubbed, the terminal read:
 *
 *   GEÇTİ  jeton kabul ediliyor … proxy: access_token=<token> rejected upstream
 *   KALDI  hata metni erişim jetonunu SIZDIRMIYOR
 *
 * The leak was announced one line AFTER it had already happened, and the write-path catch
 * (`String(e?.message ?? e).slice(0, 180)`) printed the same thing with no canary at all.
 *
 * NASIL ÖLÇÜLÜR: not by reading the source — by RUNNING it. The script's own bytes are
 * copied into a throwaway directory with exactly two harness edits: the
 * `../src/meta/client.js` specifier is rewritten to an absolute file URL (so the copy still
 * loads THIS repo's client), and a prologue is prepended that sets TEST-ONLY credentials and
 * replaces `fetch`. No network call and no real secret: the copy is NESTED so that the
 * `.env` path the script resolves lands inside that throwaway directory, which holds none —
 * see the block over `kopyaDizini` and the assertion that measures it. What runs is the
 * repository's real control flow.
 *
 * BU GÖZCÜ NEDEN VAKUM DEĞİL: three independent ways for it to go red, and one of them fires
 * if the harness itself stops working.
 *   1. The token appears in the output          → the leak is back.
 *   2. The canary reports GEÇTİ                 → either the stub failed to put a token in
 *      the raw message (harness broken, so the "no token in the output" assertion would have
 *      been meaningless), or somebody "fixed" the leak by cleaning `m` BEFORE the check —
 *      which hides a real upstream echo instead of stopping it.
 *   3. The error line is printed before the canary line → the old ordering is back.
 * A control run additionally proves that a token printed by a child process really is
 * visible to these assertions, so the "not in the output" checks cannot pass by blindness.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const KOK = join(import.meta.dirname, "..");
const BETIK = join(KOK, "scripts", "metaDogrula.mts");
const ISTEMCI = join(KOK, "src", "meta", "client.ts");

/**
 * The fake credential the stub feeds back through the upstream error text. The `TEST-ONLY-`
 * prefix is mandatory in this repo: without it the secret scanner in CI reads a token-shaped
 * literal as a real one.
 */
const JETON = "TEST-ONLY-EAAB-jeton-kalibi-0123456789";

/**
 * THE COPY LIVES INSIDE THE REPOSITORY, NOT IN THE SYSTEM TEMP DIRECTORY.
 *
 * The copy still imports what the original imports — `dotenv` among them — and Node resolves
 * a bare specifier by walking UP from the importing file looking for `node_modules`. From
 * `/tmp/...` there is no such ancestor, so on Linux CI every run of this file died with
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'dotenv'` and all three assertions failed. It
 * passed on Windows only by accident: `os.tmpdir()` sits under the user profile there, and
 * the walk up happened to find a `node_modules` on the way to the drive root.
 *
 * Putting the copy under the repository root makes resolution identical on every platform —
 * it finds THIS project's node_modules, which is the one the script is meant to run against.
 * `.tmp*` is covered by .gitignore, and the directory is removed in `after()` regardless.
 *
 * AND ONE DIRECTORY DEEPER THAN THAT — otherwise the run is not hermetic. The script reads
 * its `.env` from `<own dir>/..`, so a copy written straight into `<repo>/.tmp-…/` resolves
 * that onto the REPOSITORY ROOT, and the repository root carries a real `.env` with the
 * operator's live credentials. This docblock used to claim the opposite ("the copy's
 * `.env` path resolves into the temp directory, where there is none"); measured with a probe,
 * the flat copy parsed 12 keys out of that file into the child process and the nested copy
 * parsed 0. The effect was harmless — the prologue sets both AEGIS_* values before dotenv
 * runs, and dotenv does not overwrite what is already set — but a run that silently loads the
 * operator's credentials is not the hermetic run this file promises, and a false sentence in
 * a "BU GÖZCÜ NEDEN VAKUM DEĞİL" docblock is worse than no sentence. Nesting makes it true;
 * the assertion below keeps it true. `node_modules` is still found by walking up through the
 * same repository root.
 */
const gecici = mkdtempSync(join(KOK, ".tmp-metadogrula-"));
const kopyaDizini = join(gecici, "alt");
mkdirSync(kopyaDizini);
after(() => rmSync(gecici, { recursive: true, force: true }));

/**
 * Hermeticity is ASSERTED, not assumed: lift the copy back up next to the repository root and
 * this fails here, loudly, instead of quietly loading the operator's `.env` into the child.
 * The rule mirrors the script's own (`<copy dir>/..`), so it measures the same path the
 * script will actually read.
 */
const cozulenEnvDizini = resolve(kopyaDizini, "..");
assert.notEqual(
  cozulenEnvDizini,
  resolve(KOK),
  `Kopya, betiğin .env'ini deponun KÖKÜNDEN okuyacağı yere yazılmış; orada operatörün ` +
    `gerçek .env'i duruyor. Koşum hermetik olmaz ve bu dosyanın "gerçek sır yok" cümlesi ` +
    `yalan olur. Kopyayı bir dizin daha derine yaz.`
);
assert.ok(
  !existsSync(join(cozulenEnvDizini, ".env")),
  `Kopyanın çözdüğü dizinde bir .env var (${cozulenEnvDizini}); dotenv onu çocuk sürece ` +
    `yükler, yani koşum hermetik değil.`
);

/**
 * The `fetch` replacement. Two shapes, both of them errors that reach the script UNCLEANED:
 * a GET whose transport throw `graf` rethrows verbatim (the read path), and the read-back GET
 * that follows a successful create (the write path).
 */
const ONYUKLEME = [
  `process.env.AEGIS_META_TOKEN = ${JSON.stringify(JETON)};`,
  `process.env.AEGIS_META_AD_ACCOUNT_ID = "act_TEST-ONLY-0";`,
  `const MOD = process.env.SIZINTI_PROVASI_MOD;`,
  `const T = process.env.AEGIS_META_TOKEN;`,
  `const patla = () => {`,
  `  throw new TypeError("proxy: access_token=" + T + " rejected upstream");`,
  `};`,
  `const govde = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });`,
  `globalThis.fetch = async (u, i) => {`,
  `  if (MOD === "okuma") patla();`,
  `  if (String(u).includes("currency")) return govde({ currency: "USD", currency_offset: 100 });`,
  `  if (i && i.method === "POST") return govde({ id: "120000000000001" });`,
  `  return patla();`,
  `};`,
  ``,
].join("\n");

/** The script copy, written once and reused by every case below. */
const kopyaYolu = (() => {
  const kaynak = readFileSync(BETIK, "utf8");
  const eski = '"../src/meta/client.js"';
  const parcalar = kaynak.split(eski);
  assert.equal(
    parcalar.length,
    2,
    `Koşum düzeneği bayat: scripts/metaDogrula.mts artık ${eski} ifadesini tam olarak bir ` +
      `kez geçirmiyor (${parcalar.length - 1} kez). Yönlendirme yapılmadan bu dosyadaki her ` +
      `iddia ölçmediği bir şeyi onaylar; önce düzeneği tazele.`
  );
  const yol = join(kopyaDizini, "metaDogrulaKopya.mts");
  writeFileSync(yol, ONYUKLEME + parcalar.join(JSON.stringify(pathToFileURL(ISTEMCI).href)), {
    encoding: "utf8",
  });
  return yol;
})();

/** Runs the copy and returns everything it put on stdout+stderr. */
function kostur(mod: "okuma" | "yazma", ...ek: string[]): string {
  const ortam: NodeJS.ProcessEnv = { ...process.env, SIZINTI_PROVASI_MOD: mod };
  // No real Aegis credential is handed to the child; the prologue supplies its own.
  for (const anahtar of Object.keys(ortam)) if (anahtar.startsWith("AEGIS_")) delete ortam[anahtar];
  const s = spawnSync(process.execPath, ["--import", "tsx", kopyaYolu, ...ek], {
    cwd: KOK,
    env: ortam,
    encoding: "utf8",
  });
  const cikti = `${s.stdout ?? ""}${s.stderr ?? ""}`;
  assert.ok(
    cikti.includes("Aegis — Meta canlı doğrulaması"),
    `Betik hiç çalışmadı; ölçülecek çıktı yok:\n${cikti.slice(0, 800)}`
  );
  return cikti;
}

/**
 * The capture path is proven able to SEE a token before anything is asserted about not
 * seeing one. Without this, a spawn that silently returned an empty string would make every
 * "jeton çıktıda yok" assertion below pass while measuring nothing.
 */
test("düzenek kontrolü: çocuk süreçte basılan bir jeton bu iddialara GÖRÜNÜR", () => {
  const s = spawnSync(process.execPath, ["-e", `console.log(${JSON.stringify(JETON)})`], {
    encoding: "utf8",
  });
  assert.ok(
    `${s.stdout ?? ""}${s.stderr ?? ""}`.includes(JETON),
    "Çocuk sürecin çıktısı yakalanamıyor — aşağıdaki sızıntı iddiaları kör olurdu."
  );
});

test("okuma yolu: upstream jetonu yankılasa bile jeton TERMİNALE basılmaz", () => {
  const cikti = kostur("okuma");

  assert.match(
    cikti,
    /KALDI\s+hata metni erişim jetonunu SIZDIRMIYOR/,
    `Sızıntı kanaryası ötmedi. İki anlamı var, ikisi de kırmızı: ya sahte upstream metni ` +
      `jetonu taşımıyor (düzenek bozuk, "jeton çıktıda yok" iddiası hiçbir şey ölçmez), ya ` +
      `da kontrol HAM metin yerine TEMİZLENMİŞ metin üzerinde yapılıyor. İkincisi düzeltme ` +
      `gibi görünen bir zayıflatmadır: hataTemizle jetonu siler, kontrol hiçbir şey bulamaz ` +
      `ve jetonumuzu geri yankılayan gerçek bir upstream GEÇTİ diye raporlanır. Tespit HAM ` +
      `metnin işi, maskeleme ekrana giden metnin.\nÇıktı:\n${cikti}`
  );
  assert.ok(
    !cikti.includes(JETON),
    `Erişim jetonu terminale basıldı. Sözleşme: ham upstream metin ve jeton asla ajana/loga/` +
      `terminale sızmaz. Hata metnini kayit() çağrısına vermeden ÖNCE hataTemizle'den geçir.` +
      `\nÇıktı:\n${cikti}`
  );
  assert.ok(
    cikti.includes("access_token=***"),
    `Maskelenmiş metin görünmüyor — hata metni ya hiç basılmadı ya da başka bir yoldan ` +
      `geldi; bu durumda "jeton yok" iddiası da bir şey ölçmüyor.\nÇıktı:\n${cikti}`
  );
});

test("okuma yolu: kanarya, upstream metnini basan satırdan ÖNCE öter", () => {
  const cikti = kostur("okuma");
  const kanarya = cikti.indexOf("hata metni erişim jetonunu SIZDIRMIYOR");
  const hataSatiri = cikti.indexOf("beklenen hata alındı");
  assert.ok(kanarya >= 0 && hataSatiri >= 0, `Beklenen iki satır da yok:\n${cikti}`);
  assert.ok(
    kanarya < hataSatiri,
    `Sıra ters: upstream metni ekrana yazıldıktan SONRA sızıntı sorgulanıyor. Basımdan ` +
      `sonra koşan bir kontrol muhafız değil, otopsidir.\nÇıktı:\n${cikti}`
  );
});

test("yazma yolu: kanaryası olmayan catch de jetonu basmaz", () => {
  const cikti = kostur("yazma", "--write");
  assert.match(
    cikti,
    /KALDI\s+kampanya oluşturuldu/,
    `Yazma yolundaki catch'e hiç girilmedi; bu koşu o dalı ölçmüyor.\nÇıktı:\n${cikti}`
  );
  assert.ok(
    !cikti.includes(JETON),
    `Yazma yolundaki catch erişim jetonunu bastı. Bu dalda sızıntıyı bildirecek bir kanarya ` +
      `da yok: maskelenmezse hem durdurulmamış hem raporlanmamış olur.\nÇıktı:\n${cikti}`
  );
  assert.ok(
    cikti.includes("access_token=***"),
    `Yazma yolunda maskelenmiş metin görünmüyor; iddia bir şey ölçmüyor olabilir.\nÇıktı:\n` +
      `${cikti}`
  );
});
