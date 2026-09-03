// SPDX-License-Identifier: AGPL-3.0-only
/**
 * DERLEME GİRDİLERİ — beyan edilmemiş bağımlılık, olmayan bağımlılıktır.
 *
 * NEDEN VAR: `npm run build` uzun süre @types/node'a dayandı ama onu hiç istemedi. Tipler
 * dört seviye derindeki bir ÇALIŞMA-ZAMANI bağımlılığından (google-ads-api → google-gax →
 * protobufjs → @types/node) hoisting sayesinde düşüyordu. Kilit tazelendiğinde o paket
 * nested'a düşse ya da majörü atlasa derleme hem CI'da hem `docker build`de sebebi
 * görünmeyen yüzlerce hatayla kırılırdı — ve tip paketinin majörü, çalıştırdığımız Node
 * majöründen (engines) bağımsız savrulurdu: Node 26 API'si 22.13'te derlenir, sahada
 * patlar. Bu test o zinciri beyanlı tutar.
 *
 * Kardeş bekçiler: prova/duman fişlerini (test/onucusKurallari.test.mjs) ve dağıtım
 * yayın yüzeyini (test/yayinYuzeyi.test.ts) sınayanlar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const KOK = join(import.meta.dirname, "..");
const oku = (ad: string) => readFileSync(join(KOK, ad), "utf8");
/** tsconfig'ler JSONC: satır yorumları temizlenmeden JSON.parse edilemez. */
const jsoncOku = (ad: string) => JSON.parse(oku(ad).replace(/^\s*\/\/.*$/gm, ""));

const paket = JSON.parse(oku("package.json"));
const kilit = JSON.parse(oku("package-lock.json"));

const majorAl = (s: string): number => Number(/(\d+)/.exec(String(s))?.[1] ?? NaN);

test("@types/node devDependencies'te BEYAN EDİLİR (hoisting'e güvenilmez)", () => {
  const beyan = paket.devDependencies?.["@types/node"];
  assert.ok(beyan, "@types/node beyan edilmemiş — derleme tesadüfen hoist edilen tiplere dayanır");
});

test("@types/node majörü engines.node minimumuyla aynı", () => {
  const beyan = paket.devDependencies?.["@types/node"];
  const engines = paket.engines?.node;
  assert.equal(
    majorAl(beyan),
    majorAl(engines),
    `tip paketi (${beyan}) çalıştırdığımız Node majöründen (${engines}) farklı — ` +
      "derlenen ama sahada olmayan API'ler sessizce geçer"
  );
});

test("kilitteki @types/node kök girdide ve beyan edilen majörle aynı", () => {
  const girdi = kilit.packages?.["node_modules/@types/node"];
  assert.ok(girdi, "kilitte kök @types/node girdisi yok — paket nested'a düşmüş olabilir");
  assert.equal(majorAl(girdi.version), majorAl(paket.devDependencies["@types/node"]));
});

test("tsconfig node tiplerini AÇIKÇA ister", () => {
  const ts = jsoncOku("tsconfig.json");
  assert.deepEqual(ts.compilerOptions?.types, ["node"]);
});

test("prova/demo/duman koşuları önce derler (bayat ikili sahneye çıkmasın)", () => {
  for (const ad of ["preprova", "predemo", "presmoke"]) {
    assert.equal(paket.scripts?.[ad], "npm run build", `${ad} kancası eksik ya da değişmiş`);
  }
});

test("CI üretim bağımlılıklarında zafiyet kapısını korur", () => {
  const ci = oku(".github/workflows/ci.yml");
  assert.match(ci, /npm audit --omit=dev --audit-level=moderate/);
});

test("kilit haftalık tazelenir (kapı sürekli kırmızıda kalmasın)", () => {
  // Elle tazelenmeyen kilit kapıyı er ya da geç kırmızıya çevirir; sürekli kırmızı bir
  // kapı da susturulur — yani zafiyet kapısı tam işe yarayacağı gün güvenilmez olur.
  const db = oku(".github/dependabot.yml");
  assert.match(db, /package-ecosystem:\s*npm/);
  assert.match(db, /interval:\s*weekly/);
});

test("npm test glob'u test/ altındaki .mjs testlerini de koşar", () => {
  // Bu dosyanın kardeşi onucusKurallari.test.mjs .mjs olmak ZORUNDA (sınadığı modül .mjs
  // ve tsconfig allowJs açmıyor). Glob unutulursa o testler sessizce hiç koşmaz.
  assert.match(String(paket.scripts?.test), /test\/\*\.test\.mjs/);
});
