// SPDX-License-Identifier: AGPL-3.0-only
/**
 * TYPECHECK SCOPE — a script that no gate compiles is a script that breaks in front of the jury.
 *
 * WHY THIS EXISTS: all three CI gates used to walk past scripts/. `npm run build` compiles
 * src, `npm run typecheck` compiled src + test, `npm test` runs test/. Yet
 * scripts/agDogrula.mts, scripts/metaDogrula.mts and scripts/video-demo.mts — the commands
 * `npm run agtest`, `npm run metatest` and `npm run video`, i.e. the three runs the deck
 * offers as CAMARA/Meta evidence — import NAMED exports from src. Rename one export in src
 * and every gate stays green; the break surfaces at run time, on stage. `npx tsc -p
 * tsconfig.check.json --listFiles | grep scripts` returned only scripts/video-metin.mts
 * (pulled in transitively by test/videoCevirisi.test.ts); the other three were compiled by
 * nothing. The fix is one glob in tsconfig.check.json; this file keeps it there.
 *
 * HOW IT IS MEASURED — not by reading the glob, by asking the compiler:
 *   1. TypeScript itself expands tsconfig.check.json (`parseJsonConfigFileContent`, the same
 *      code path `tsc -p` uses) and the npm entry scripts must appear among the ROOT files.
 *   2. Then the failure the gap allows is reproduced on the REAL repository files: the first
 *      named export each entry script pulls out of src is renamed IN MEMORY (a compiler-host
 *      overlay — nothing on disk is touched, no other agent's file is edited) and the program
 *      whose roots come from tsconfig.check.json must report that break INSIDE the entry
 *      script. TS2305 for the static import, TS2339 for the `await import()` destructuring.
 *
 * WHY THIS IS NOT A VACUUM GUARD — four independent ways to go red, and one of them fires if
 * the harness itself stops measuring:
 *   1. The scripts glob leaves the include list      → tests 1, 2 and 3 all go red (test 3
 *      because its roots come from the config: no roots, nothing to mutate, no diagnostics).
 *   2. An entry script moves out of the covered path → test 2 red.
 *   3. The mutation stops producing a diagnostic     → test 3 red (the scope has no teeth).
 *   4. The unmutated control run already reports the → test 3 red (the assertion in the
 *      renamed name                                     mutated run would prove nothing).
 * The control run is the answer to "could this pass while blind?": the same program, same
 * roots, no overlay, must be SILENT about those names.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const KOK = join(import.meta.dirname, "..");
const oku = (ad: string) => readFileSync(join(KOK, ad), "utf8");
/** tsconfig files are JSONC: line comments have to go before JSON.parse. */
const jsoncOku = (ad: string) => JSON.parse(oku(ad).replace(/^\s*\/\/.*$/gm, ""));
/** Windows vs POSIX separators and drive-letter case must not decide a gate. */
const duz = (p: string) => p.replace(/\\/g, "/").toLowerCase();

const paket = JSON.parse(oku("package.json")) as { scripts?: Record<string, string> };

/** npm scripts that run a `.mts` file out of scripts/ — agtest, metatest, video today. */
const mtsGirisleri: ReadonlyArray<{ komutAdi: string; goreliYol: string }> = Object.entries(
  paket.scripts ?? {}
)
  .map(([komutAdi, komut]) => ({
    komutAdi,
    goreliYol: /(scripts\/[\w./-]+\.mts)/.exec(String(komut))?.[1] ?? "",
  }))
  .filter((g) => g.goreliYol !== "");

/** The root files tsconfig.check.json feeds the compiler, expanded by TypeScript itself. */
function kontrolProgrami(): { kokler: string[]; secenekler: ts.CompilerOptions } {
  const yol = join(KOK, "tsconfig.check.json");
  const okunan = ts.readConfigFile(yol, ts.sys.readFile);
  assert.equal(okunan.error, undefined, "tsconfig.check.json okunamadı");
  const cozulen = ts.parseJsonConfigFileContent(okunan.config, ts.sys, KOK);
  assert.deepEqual(
    cozulen.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")),
    [],
    "tsconfig.check.json çözülürken hata verdi"
  );
  return { kokler: cozulen.fileNames.map(duz), secenekler: cozulen.options };
}

test("typecheck kapısı scripts/ dizinini de kapsar", () => {
  const dahil = jsoncOku("tsconfig.check.json").include as string[];
  assert.ok(
    dahil.includes("scripts/**/*"),
    "tsconfig.check.json include listesinde scripts globu yok — npm run agtest/metatest/video " +
      "betikleri hiçbir kapı tarafından derlenmez"
  );
});

test("npm ile koşan her .mts betiği typecheck programının kök dosyasıdır", () => {
  assert.ok(mtsGirisleri.length >= 3, "package.json'da .mts betik girişi bulunamadı — desen bayat");
  const { kokler } = kontrolProgrami();

  for (const g of mtsGirisleri) {
    assert.ok(
      kokler.includes(duz(join(KOK, g.goreliYol))),
      `npm run ${g.komutAdi} → ${g.goreliYol} typecheck programında yok; src'de bir export ` +
        "yeniden adlandırılsa CI yeşil kalır, betik sahada kırılır"
    );
  }

  // Ayrım kanıtı: liste her şeyi içeren bir dizin dökümü DEĞİL. src girer, allowJs kapalı
  // olduğu için .mjs betikleri (npm run smoke) girmez — yani yukarıdaki iddia körlükle geçemez.
  assert.ok(
    kokler.includes(duz(join(KOK, "src/index.ts"))),
    "src/index.ts programda yok — ölçüm bozuk"
  );
  assert.ok(
    !kokler.includes(duz(join(KOK, "scripts/smoke.mjs"))),
    "scripts/smoke.mjs programa girmiş — liste artık dosya sistemini olduğu gibi yansıtıyor, " +
      "kapsam iddiası ayırt edici olmaktan çıkar"
  );
});

/** `import { a, b } from "../src/x.js"` and `const { a } = await import("../src/x.js")`. */
function ilkSrcIthali(betikMetni: string): { modulYolu: string; ad: string } | undefined {
  const desenler = [
    /import\s*\{([^}]*)\}\s*from\s*"(\.\.\/src\/[^"]+)"/g,
    /\{([^}]*)\}\s*=\s*await\s+import\(\s*"(\.\.\/src\/[^"]+)"\s*\)/g,
  ];
  for (const desen of desenler) {
    for (const eslesme of betikMetni.matchAll(desen)) {
      const ad = eslesme[1]
        .split(",")
        .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
        .find((s) => /^[A-Za-z_$][\w$]*$/.test(s));
      if (ad !== undefined) return { modulYolu: eslesme[2], ad };
    }
  }
  return undefined;
}

test("src'de bir export yeniden adlandırılırsa betikler DERLENMEZ (kapsamın dişi var)", () => {
  const { kokler, secenekler } = kontrolProgrami();
  const girisler = mtsGirisleri
    .map((g) => ({ ...g, mutlak: join(KOK, g.goreliYol) }))
    .filter((g) => kokler.includes(duz(g.mutlak)));
  assert.ok(
    girisler.length >= 3,
    "mutasyon için betik kalmadı: girişler typecheck programında değil (kapsam geri alınmış olabilir)"
  );

  // In-memory rename only. Nothing on disk changes — other agents are editing src right now.
  // Two entry scripts can share one src module (agDogrula.mts and video-demo.mts both pull
  // agDogrula out of networkTrust.ts), so renames accumulate on the same buffer and the
  // "did the rename bite?" assertion is made against the ORIGINAL file text.
  const mutasyonlar = new Map<string, string>();
  const beklenen: Array<{ dosya: string; ad: string }> = [];
  for (const g of girisler) {
    const ithal = ilkSrcIthali(readFileSync(g.mutlak, "utf8"));
    assert.ok(ithal, `${g.goreliYol} artık src'den adlı export almıyor — bu gözcünün dayanağı bayat`);
    const modul = join(KOK, "scripts", ithal.modulYolu).replace(/\.js$/, ".ts");
    assert.ok(existsSync(modul), `${ithal.modulYolu} çözülemedi (${modul})`);
    const orijinal = readFileSync(modul, "utf8");
    const desen = new RegExp(`\\b${ithal.ad}\\b`, "g");
    assert.match(orijinal, desen, `${ithal.ad} adı ${modul} içinde yok — mutasyon boşa düşerdi`);
    mutasyonlar.set(
      duz(modul),
      (mutasyonlar.get(duz(modul)) ?? orijinal).replace(desen, `${ithal.ad}_MUTASYON`)
    );
    beklenen.push({ dosya: duz(g.mutlak), ad: ithal.ad });
  }

  const kokListesi = girisler.map((g) => g.mutlak);
  const tanilar = (overlay: boolean): readonly ts.Diagnostic[] => {
    const host = ts.createCompilerHost(secenekler, true);
    const kaynakAsil = host.getSourceFile.bind(host);
    const okuAsil = host.readFile.bind(host);
    host.readFile = (f) => (overlay ? mutasyonlar.get(duz(f)) : undefined) ?? okuAsil(f);
    host.getSourceFile = (f, dil, hataCb, yeniden) => {
      const metin = overlay ? mutasyonlar.get(duz(f)) : undefined;
      return metin === undefined
        ? kaynakAsil(f, dil, hataCb, yeniden)
        : ts.createSourceFile(f, metin, dil, true);
    };
    return ts.getPreEmitDiagnostics(ts.createProgram(kokListesi, secenekler, host));
  };

  const eslesenler = (liste: readonly ts.Diagnostic[], dosya: string, ad: string) =>
    liste.filter(
      (d) =>
        d.file !== undefined &&
        duz(d.file.fileName) === dosya &&
        ts.flattenDiagnosticMessageText(d.messageText, " ").includes(ad)
    );

  // KONTROL: aynı program, aynı kökler, mutasyonsuz. Bu adlar hakkında SESSİZ olmalı;
  // olmazsa aşağıdaki iddia hiçbir şey kanıtlamaz.
  const temiz = tanilar(false);
  for (const b of beklenen) {
    assert.equal(
      eslesenler(temiz, b.dosya, b.ad).length,
      0,
      `mutasyonsuz koşuda ${b.dosya} zaten '${b.ad}' hatası veriyor — ölçüm ayırt edici değil`
    );
  }

  const bozuk = tanilar(true);
  for (const b of beklenen) {
    const bulunan = eslesenler(bozuk, b.dosya, b.ad);
    assert.ok(
      bulunan.length > 0,
      `'${b.ad}' src'de yeniden adlandırıldı ama ${b.dosya} yine temiz derleniyor — ` +
        "betik typecheck kapsamında değil, kapı sessiz"
    );
    assert.ok(
      bulunan.some((d) => d.code === 2305 || d.code === 2339),
      `${b.dosya} için beklenen 'export yok' tanısı (TS2305/TS2339) gelmedi`
    );
  }
});

test("tsconfig yorumu ile src'ye bağlı betikler çift yönlü örtüşür", () => {
  // Belge gözcüsü: yorum bayatlarsa da (yeni betik eklendi, adı yazılmadı), kod değişirse de
  // (yorumdaki betik silindi ya da artık src'den import etmiyor) kırmızı olur.
  const tsconfigMetni = oku("tsconfig.check.json");
  const srcBagimliGirisler = mtsGirisleri.filter(
    (g) => ilkSrcIthali(readFileSync(join(KOK, g.goreliYol), "utf8")) !== undefined
  );
  assert.ok(srcBagimliGirisler.length >= 3, "src'den import eden .mts girişi kalmadı — yorum bayat");

  for (const g of srcBagimliGirisler) {
    assert.ok(
      tsconfigMetni.includes(g.goreliYol),
      `${g.goreliYol} src'den adlı export alıyor ama tsconfig.check.json yorumunda anılmıyor`
    );
  }
  for (const anilan of new Set(tsconfigMetni.match(/scripts\/[\w./-]+\.mts/g) ?? [])) {
    assert.ok(
      srcBagimliGirisler.some((g) => g.goreliYol === anilan),
      `tsconfig.check.json yorumu ${anilan} diyor ama bu dosya artık src'ye bağlı bir npm girişi değil`
    );
  }
});
