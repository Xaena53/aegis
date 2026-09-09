// SPDX-License-Identifier: AGPL-3.0-only
/**
 * scripts/metaDogrula.mts — REDDEDİLEN JETON DALI, VE GERÇEKTEN HERMETİK BİR KOŞUM.
 *
 * NEDEN VAR (1/2) — ÜÇLÜĞÜN SINANMAYAN DALI. The read path chooses what to print with
 * `jetonSorunu ? "jeton reddedildi: …" : "beklenen hata alındı: …"`. faz3MetaDogrula.test.ts
 * drives that path with a single upstream shape — `proxy: access_token=<T> rejected upstream`
 * — and that text matches NOTHING in `/OAuth|190|access token|Invalid OAuth/i`: the pattern
 * spells "access token" with a space, the message with an underscore. So `jetonSorunu` is
 * always false over there, and only the FALSE arm is ever exercised.
 *
 * MEASURED, not assumed: putting the raw upstream text back into the TRUE arm
 * (`jeton reddedildi: ${m.slice(0, 140)}`) left all four faz3 tests green. And that arm is
 * the DANGEROUS one of the two: it is reached exactly when the credential was REJECTED —
 * the moment a proxy or a gateway in front of Meta is most likely to be echoing that
 * credential back at us — and it prints 140 characters where the other arm prints 110.
 *
 * NEDEN VAR (2/2) — KOŞUMUN HERMETİKLİĞİ. The script resolves its own `.env` as
 * `<own dir>/..`. A copy written straight into `<repo>/.tmp-…/` therefore resolves that
 * path onto the REPOSITORY ROOT, and the repository root really does carry a `.env` with the
 * operator's live credentials. Measured with a probe: a copy sitting at the top of the
 * throwaway directory parsed 12 keys out of that file, a copy one directory deeper parsed 0.
 * Both harnesses now nest the copy, and the third assertion below MEASURES that instead of
 * promising it in prose.
 *
 * BU GÖZCÜ NEDEN VAKUM DEĞİL — several ways to go red, and each covers a way the others
 * could quietly stop measuring:
 *   1. The TRUE arm must really be selected: `KALDI  jeton kabul ediliyor …` is asserted. If
 *      the pattern and the fake message ever stop meeting, this file stops measuring the arm
 *      it is named after, and it says so instead of passing.
 *   2. The leak canary must report KALDI. That is the script itself testifying that the RAW
 *      message did carry the token. Without it, "the token is not in the output" would be an
 *      assertion about a message that never held one.
 *   3. The masked line must be visible verbatim. Without it, an empty or truncated capture
 *      would satisfy "no token" while measuring nothing at all.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const KOK = join(import.meta.dirname, "..");
const BETIK = join(KOK, "scripts", "metaDogrula.mts");
const ISTEMCI = join(KOK, "src", "meta", "client.ts");

/**
 * The fake credential the stub feeds back through the upstream error text. The `TEST-ONLY-`
 * prefix is mandatory in this repo: without it the secret scanner in CI reads a token-shaped
 * literal as a real one.
 */
const JETON = "TEST-ONLY-EAAB-faz5-jeton-kalibi-0123456789";

/** The upstream sentence that DOES match the script's token-problem pattern, token included. */
const UPSTREAM_SEKLI = "Invalid OAuth access token: <jeton>";

/**
 * THE COPY LIVES INSIDE THE REPOSITORY — AND ONE LEVEL BELOW THE THROWAWAY DIRECTORY.
 *
 * Inside the repository, because the copy imports what the original imports (`dotenv` among
 * them) and Node resolves a bare specifier by walking UP from the importing file looking for
 * `node_modules`; from the system temp directory there is no such ancestor on Linux CI.
 *
 * One level below, because the script reads its `.env` from `<own dir>/..`: a copy
 * placed directly in `<repo>/.tmp-…/` points that resolution at the repository root and loads
 * the operator's real credentials into the child. Nesting sends it back into the throwaway
 * directory, which holds nothing. The walk for `node_modules` passes through the repository
 * root either way, so nothing is lost — measured, the nested copy still imports `dotenv`.
 */
const gecici = mkdtempSync(join(KOK, ".tmp-faz5metadogrula-"));
const kopyaDizini = join(gecici, "alt");
mkdirSync(kopyaDizini);
after(() => rmSync(gecici, { recursive: true, force: true }));

/**
 * The `fetch` replacement: every call throws the same transport-level error. On a GET `graf`
 * rethrows it verbatim (`throw e`, src/meta/client.ts), so what reaches the script's catch is
 * an UNCLEANED upstream text carrying the token — the only text worth measuring here.
 */
const ONYUKLEME = [
  `process.env.AEGIS_META_TOKEN = ${JSON.stringify(JETON)};`,
  `process.env.AEGIS_META_AD_ACCOUNT_ID = "act_TEST-ONLY-0";`,
  `globalThis.fetch = async () => {`,
  `  throw new TypeError("Invalid OAuth access token: " + process.env.AEGIS_META_TOKEN);`,
  `};`,
  ``,
].join("\n");

/** The script copy, written once. */
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

/** Runs the copy in read-only mode and returns everything it put on stdout+stderr. */
function kostur(): string {
  const ortam: NodeJS.ProcessEnv = { ...process.env };
  // No real Aegis credential is handed to the child; the prologue supplies its own.
  for (const anahtar of Object.keys(ortam)) if (anahtar.startsWith("AEGIS_")) delete ortam[anahtar];
  const s = spawnSync(process.execPath, ["--import", "tsx", kopyaYolu], {
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

test("okuma yolu: jeton REDDEDİLDİĞİNDE de ham upstream metni terminale basılmaz", () => {
  const cikti = kostur();

  assert.match(
    cikti,
    /KALDI\s+jeton kabul ediliyor \(kimlik doğrulama geçti\)/,
    `Üçlüğün TRUE dalına hiç girilmedi: bu koşu, adını taşıdığı dalı ölçmüyor. Sahte ` +
      `upstream metni ("${UPSTREAM_SEKLI}") ile betikteki ` +
      `/OAuth|190|access token|Invalid OAuth/i deseni artık buluşmuyor olabilir; ikisini ` +
      `yeniden buluşturmadan aşağıdaki iddiaların hiçbiri bir şey ölçmez.\nÇıktı:\n${cikti}`
  );
  assert.match(
    cikti,
    /KALDI\s+hata metni erişim jetonunu SIZDIRMIYOR/,
    `Sızıntı kanaryası ötmedi. İki anlamı var, ikisi de kırmızı: ya sahte upstream metni ` +
      `jetonu taşımıyor (düzenek bozuk, "jeton çıktıda yok" iddiası hiçbir şey ölçmez), ya ` +
      `da kontrol HAM metin yerine TEMİZLENMİŞ metin üzerinde yapılıyor. İkincisi düzeltme ` +
      `gibi görünen bir zayıflatmadır: hataTemizle jetonu siler, kontrol hiçbir şey bulamaz ` +
      `ve jetonumuzu geri yankılayan gerçek bir upstream GEÇTİ diye raporlanır.\nÇıktı:\n` +
      `${cikti}`
  );
  assert.ok(
    cikti.includes("jeton reddedildi:"),
    `TRUE dalının kendi satırı basılmamış; ölçtüğümüz şey tam olarak o satır.\nÇıktı:\n${cikti}`
  );
  assert.ok(
    !cikti.includes(JETON),
    `Erişim jetonu terminale basıldı — ve tam olarak jetonun REDDEDİLDİĞİ dalda, yani bir ` +
      `ara katmanın kimlik bilgisini geri yankılamasının en olası olduğu anda. Sözleşme: ham ` +
      `upstream metin ve jeton asla ajana/loga/terminale sızmaz. Üçlüğün İKİ dalı da ` +
      `hataTemizle'den geçmiş metni basmalı: tespit ham metnin işi, basım temizlenmiş ` +
      `metnin.\nÇıktı:\n${cikti}`
  );
  assert.ok(
    cikti.includes("Invalid OAuth access token: ***"),
    `Maskelenmiş metin görünmüyor — hata metni ya hiç basılmadı ya da başka bir yoldan ` +
      `geldi; bu durumda "jeton yok" iddiası da bir şey ölçmüyor.\nÇıktı:\n${cikti}`
  );
});

/**
 * The claim this replaces used to be prose in the sibling harness ("the copy's `.env` path
 * resolves into the temp directory, where there is none") and it was false. Here it is a
 * measurement.
 */
test("koşum hermetik: kopyanın çözdüğü .env yolu deponun kökü DEĞİL ve orada .env yok", () => {
  const kaynak = readFileSync(BETIK, "utf8");
  assert.ok(
    kaynak.includes('path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")') &&
      kaynak.includes('path.join(kok, ".env")'),
    `Betiğin .env çözme kuralı değişmiş: aşağıdaki iddia artık BAŞKA bir dizini ölçüyor ve ` +
      `hermetiklik hakkında hiçbir şey söylemiyor. Kuralı yeniden okuyup bu gözcüyü tazele.`
  );

  const cozulenEnvDizini = resolve(dirname(kopyaYolu), "..");
  assert.notEqual(
    cozulenEnvDizini,
    resolve(KOK),
    `Kopya, betiğin .env'ini deponun KÖKÜNDEN okuyacağı yere yazılmış. Orada operatörün ` +
      `gerçek .env'i duruyor (ölçüldü: dotenv oradan 12 anahtarı çocuk sürece yüklüyor), ` +
      `yani koşum hermetik değil ve "gerçek sır yok" iddiası yalan olur. Kopyayı bir dizin ` +
      `daha derine yaz.`
  );
  assert.ok(
    !existsSync(join(cozulenEnvDizini, ".env")),
    `Kopyanın çözdüğü dizinde bir .env var (${cozulenEnvDizini}); dotenv onu çocuk sürece ` +
      `yükler, yani koşum hermetik değil.`
  );
});
