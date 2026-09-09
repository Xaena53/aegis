// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ONARIM TURU 3 — docs/DEMO.md: sahnede okunan runbook, kapının BUGÜNKÜ doktrinini anlatıyor mu?
 *
 * Üç onarım turu yükseltme (step-up) doktrinini değiştirdi; docs/CAMARA.md ve kod yeni
 * doktrini anlatıyordu, runbook eskisini. Public bir depoda jürinin sahnede takip ettiği
 * belgenin koddan BAŞKA bir güvenlik modeli anlatması en pahalı hatadır. Bu dosyadaki her
 * gözcü ölçülmüş dört sapmayı çiviler ve hiçbiri salt metin gözcüsü değildir: her biri ya
 * kapının GERÇEK DAVRANIŞINI ölçer ya da belgenin cümlesini KODDAN TÜRETİLEN bir olguya
 * bağlar — yani belge geri alınırsa da, kod değişirse de kırmızıya döner.
 *
 *   1) :619 kapalı-arıza matrisi "ag-yanitsiz" için KOŞULSUZ yükseltme vaat ediyordu
 *      ("her *diğer* halka gerçek kanaldan temiz dönerse istem olur"). Ölçüldü: çağrı
 *      yönlendirme halkası SESSİZKEN diğer dört halka gerçek+temizken kapı REDDEDİYOR,
 *      çünkü YANITSIZ_KEFIL_ESLEMESI.callFwd BOŞ küme.
 *   2) :457 "kuru modda hiçbir yazma aracı çağrılmaz" diyordu. Betiğin kendi Perde 2 ve
 *      Perde 3/B blokları yazma aracını KURU MODDA DA çağırıyor — yazmayı engelleyen tek
 *      şey ağ kapısının reddi.
 *   3) :177/:223/:234 yükseltme sınırlarını tur-1 öncesi hâliyle sayıyordu: "her kalan
 *      halka kefil olursa" yeter koşulu, iki bilinçli dışlama, ve kefalet ilkesinin
 *      (çürütebilme + gözlemiş olma) hiç anılmaması.
 *   4) :593-605 güvenlik kilidini yalnız Perde 3'e ait ve İKİ ADIMLI gösteriyordu; kilit
 *      artık iki bayrak taşıyor ve `--kendini-sina` ÜÇ adım koşuyor.
 *
 * Ağa çıkılmaz: tüm halkalar test dikişleriyle beslenir.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agDogrula,
  KEFIL_ESLEMESI,
  YANITSIZ_KEFIL_ESLEMESI,
  __setCagriYonlendirmeKanalForTests,
  __setCihazDegisimKanalForTests,
  __setErisimKanalForTests,
  __setKonumKanalForTests,
  __setSimSwapKanalForTests,
  type AgAyar,
} from "../src/networkTrust.js";

const KOK = fileURLToPath(new URL("..", import.meta.url));
/**
 * CRLF is normalised: a checkout with `core.autocrlf=true` would otherwise make every
 * multi-line pattern below miss, and the guard would go green for the wrong reason.
 */
const oku = (goreli: string) => readFileSync(join(KOK, goreli), "utf8").replace(/\r\n/g, "\n");

const DEMO = oku("docs/DEMO.md");
const BETIK = oku("scripts/demo-senaryo.mjs");

/** Belgenin bir bölümünü başlıktan bir sonraki başlığa kadar keser. */
function bolum(baslik: string): string {
  const bas = DEMO.indexOf(baslik);
  assert.notEqual(bas, -1, `docs/DEMO.md'de '${baslik}' başlığı yok — bölüm yeniden adlandırıldıysa bu gözcü sessizce boşa düşmesin diye burada durur`);
  const son = DEMO.indexOf("\n### ", bas + baslik.length);
  return DEMO.slice(bas, son === -1 ? undefined : son);
}

/* ── 1) :619 — "ag-yanitsiz" yükseltmesi KOŞULSUZ değil ─────────────────────── */

const GERCEK_ZINCIR: AgAyar = {
  nacToken: "TEST-ONLY-token",
  approverPhone: "+905550000000",
  simSwapWindowHours: 72,
  reachCheck: true,
  devSwapCheck: true,
  callFwdCheck: true,
  expectedCountry: "TR",
  stepUp: true,
};

// Dikişler modül-global: sıfırlanmazsa sonraki teste sızar.
afterEach(() => {
  __setSimSwapKanalForTests(undefined);
  __setErisimKanalForTests(undefined);
  __setKonumKanalForTests(undefined);
  __setCihazDegisimKanalForTests(undefined);
  __setCagriYonlendirmeKanalForTests(undefined);
});

test("DAVRANIŞ: çağrı yönlendirme SESSİZKEN, diğer dört halka gerçek+temiz olsa DA yükseltme yok", async () => {
  /**
   * The exact case the fail-closed matrix promised as a prompt. Every other link answers
   * clean over a real channel and observes something; only the forwarding link is unreadable.
   * The gate must still refuse, because nothing in the chain can see forwarding.
   */
  __setSimSwapKanalForTests({ verifySimSwap: async () => false });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: ["TR"] }) });
  __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => false });
  __setCagriYonlendirmeKanalForTests({ kosulsuzYonlendirmeAcikMi: async () => undefined });

  const karar = await agDogrula(GERCEK_ZINCIR, "high");

  assert.equal(karar.kademe, undefined, "SESSİZ çağrı yönlendirme yükseltildi — kefil kümesi boş olmalıydı");
  assert.ok(
    karar.engel,
    "SESSİZ çağrı yönlendirme reddedilmedi: bilinmeyen yönlendirme, bilinen yönlendirmeden daha hoşgörülü işlem gördü"
  );
  assert.equal(karar.iz.retNedeni, "ag-yanitsiz");
});

test("BELGE↔KOD: kapalı-arıza matrisinin 'ag-yanitsiz' satırı koşulsuz yükseltme VAAT ETMİYOR", () => {
  /**
   * Two-way: the code fact below is what makes the row true. Empty the callFwd voucher set in
   * the code (or fill it) and this test goes red before the row can quietly become a lie again.
   */
  assert.deepEqual(
    Object.entries(YANITSIZ_KEFIL_ESLEMESI)
      .filter(([, kefiller]) => kefiller.length === 0)
      .map(([halka]) => halka)
      .sort(),
    ["callFwd", "nv"],
    "YANITSIZ_KEFIL_ESLEMESI'nde kefilsiz halka kümesi değişti — docs/DEMO.md'nin matris satırı " +
      "hangi halkanın sessizliğinin ASLA yükseltilmediğini adıyla sayıyor, önce onu güncelle"
  );

  const satirlar = DEMO.split("\n").filter((s) => s.includes("| CAMARA API unreachable / errors |"));
  assert.equal(
    satirlar.length,
    1,
    "kapalı-arıza matrisinde 'CAMARA API unreachable / errors' satırı yok — satır adı değiştiyse gözcü boşa düşmesin diye burada durur"
  );
  const satir = satirlar[0];
  assert.doesNotMatch(
    satir,
    /if every \*other\* link answers clean/i,
    "matris yine 'her DİĞER halka temiz dönerse istem olur' diyor — ölçülen davranış bunun tersi: " +
      "sessiz çağrı yönlendirmede dört temiz gerçek halka varken bile REDDEDİLİYOR"
  );
  assert.match(
    satir,
    /YANITSIZ_KEFIL_ESLEMESI/,
    "matris, kefilleri hangi tablonun belirlediğini söylemiyor — okuyucu KEFIL_ESLEMESI'ni açıp üç halkanın kefil olduğu sonucuna varır"
  );
  assert.match(
    satir,
    /silent \*\*call-forwarding\*\* link never escalates/i,
    "matris, sessiz çağrı yönlendirmenin ASLA yükseltilmediğini söylemiyor"
  );
});

/* ── 2) :457 — KURU mod "yazma aracı hiç çağrılmaz" DEMEK DEĞİL ─────────────── */

/** Betiğin bir perde bloğunu kesip alır: `/* ── ACT n` işaretinden bir sonrakine kadar. */
function perdeBlogu(bas: string, son: string): string {
  const i = BETIK.indexOf(bas);
  assert.notEqual(i, -1, `scripts/demo-senaryo.mjs'de '${bas}' işareti yok — perde işaretleri yeniden yazıldıysa bu gözcü boşa düşmesin diye burada durur`);
  const j = BETIK.indexOf(son, i);
  assert.notEqual(j, -1, `scripts/demo-senaryo.mjs'de '${son}' işareti yok`);
  return BETIK.slice(i, j);
}

test("BELGE↔KOD: kuru mod maddesi, Perde 2/3-B'nin yazma aracını GERÇEKTEN çağırdığını söylüyor", () => {
  /**
   * The code fact first: act 2 calls the write tool with no `CANLI` guard anywhere in its
   * block, while act 1 does gate its call on `CANLI`. That contrast is what proves the
   * extraction is alive — if the acts are restructured, the act-1 half goes red instead of
   * this guard silently passing.
   */
  const perde1 = perdeBlogu("/* ── ACT 1:", "/* ── ACT 2:");
  const perde2 = perdeBlogu("/* ── ACT 2:", "/* ── ACT 3:");
  const perde3b = perdeBlogu("/* ── ACT 3/B:", "/* ── The summary table");

  assert.match(perde1, /\bCANLI\b/, "Perde 1 artık kuru modu hiç gözetmiyor — perde kesme işaretleri bayatlamış olabilir");
  assert.match(perde2, /callTool\(\{[\s\S]{0,200}update_campaign_budget/, "Perde 2 yazma aracını hiç çağırmıyor — blok kesimi bayatlamış olabilir");
  assert.doesNotMatch(
    perde2,
    /\bCANLI\b/,
    "Perde 2 artık --canli'ya bağlı: docs/DEMO.md kuru modda GERÇEKTEN çağırdığını yazıyor, önce belgeyi düzelt"
  );
  assert.doesNotMatch(
    perde3b,
    /\bCANLI\b/,
    "Perde 3/B artık --canli'ya bağlı: docs/DEMO.md kuru modda GERÇEKTEN çağırdığını yazıyor, önce belgeyi düzelt"
  );

  const maddeler = DEMO.split("\n").filter((s) => s.includes("The default mode is **DRY**"));
  assert.equal(maddeler.length, 1, "docs/DEMO.md'de kuru mod maddesi bulunamadı");
  const madde = maddeler[0];
  assert.doesNotMatch(
    madde,
    /no write tool is ever called/i,
    "runbook yine 'kuru modda hiçbir yazma aracı çağrılmaz' diyor — Perde 2 ve 3/B onu ölçülebilir biçimde çağırıyor; " +
      "operatörün canlı hesapta güvendiği cümle budur"
  );
  assert.match(
    bolum("## 4. Step-by-Step Scenario"),
    /acts 2 and 3\/B really do call the\n  write tool in dry mode too/i,
    "runbook, Perde 2 ve 3/B'nin kuru modda da yazma aracını çağırdığını söylemiyor"
  );
});

/* ── 3) :177/:223/:234 — yükseltme sınırları tur-1 öncesi hâlinde ───────────── */

test("DAVRANIŞ: 'kalan halkalar temiz' YETMEZ — çürütemeyen halka kefil olamaz", async () => {
  /**
   * Only the reachability link runs beside the swapped SIM, over a real channel, and clean.
   * The pre-round-1 sentence ("if — and only if — every remaining link vouches") predicts a
   * prompt here; the gate refuses, because a reachable phone can hold a swapped SIM.
   */
  __setSimSwapKanalForTests({ verifySimSwap: async () => true });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });

  const karar = await agDogrula(
    { ...GERCEK_ZINCIR, devSwapCheck: false, callFwdCheck: false, expectedCountry: undefined },
    "high"
  );

  assert.equal(karar.kademe, undefined, "erişilebilirlik halkası SIM değişimine kefil oldu — çürütemediği bir sinyale kefil olamaz");
  assert.ok(karar.engel, "temiz gerçek halka VAR ama kefil olamaz; kapı yine de reddetmeliydi");
});

test("DAVRANIŞ: hiçbir şey GÖZLEMEDEN temiz dönen halka kefil olamaz", async () => {
  /**
   * The location link answers "not roaming, no country named": nothing was refused, but the
   * line was not placed in the expected country either. The runbook's third voucher condition.
   */
  __setSimSwapKanalForTests({ verifySimSwap: async () => true });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: [] }) });

  const karar = await agDogrula({ ...GERCEK_ZINCIR, devSwapCheck: false, callFwdCheck: false }, "high");

  assert.equal(karar.kademe, undefined, "gözlemsiz konum halkası kefil sayıldı");
  assert.ok(karar.engel, "gözlemsiz kefil ile yükseltme yapıldı — 'hiçbir şey gözlenmedi' kanıt değildir");
});

test("BELGE↔KOD: 3.3 bölümü kefalet ilkesinin ÜÇ koşulunu da sayıyor", () => {
  const b = bolum("#### Step-up (`AEGIS_STEPUP`)");

  assert.doesNotMatch(
    b,
    /if — and only if — every remaining link vouches/i,
    "3.3 yine 'her kalan halka kefil olursa' YETER koşulunu kural diye yazıyor — ölçüldü, yetmiyor"
  );
  assert.doesNotMatch(
    b,
    /two of the exclusions are deliberate/i,
    "3.3 yine iki bilinçli dışlama sayıyor — SESSİZ çağrı yönlendirme üçüncüsüdür"
  );
  assert.match(
    b,
    /\*silent\* forwarding link never escalates/i,
    "3.3, SESSİZ çağrı yönlendirmenin de asla yükseltilmediğini söylemiyor"
  );
  assert.match(b, /KEFIL_ESLEMESI/, "3.3, kefil tablosunu adıyla anmıyor");
  assert.match(b, /YANITSIZ_KEFIL_ESLEMESI/, "3.3, 'ag-yanitsiz'in İKİNCİ tablodan okunduğunu söylemiyor");
  assert.match(b, /gozlemsiz/, "3.3, 'hiçbir şey gözlememiş halka kefil olamaz' kuralını anmıyor");

  /**
   * The doc's claim about the reachability link is derived from the code, not trusted: `reach`
   * is in no voucher row, and if it is ever added the sentence has to go before this passes.
   */
  const kefilOlabilenler = new Set(Object.values(KEFIL_ESLEMESI).flatMap((k) => [...k]));
  assert.equal(
    kefilOlabilenler.has("reach"),
    false,
    "KEFIL_ESLEMESI artık 'reach'i kefil sayıyor — docs/DEMO.md 3.3 'erişilebilirlik hiçbir şeye kefil olmaz' diyor, önce belgeyi düzelt"
  );
  assert.match(
    b,
    /Device reachability vouches for\n  nothing at all/i,
    "3.3, erişilebilirlik halkasının hiçbir şeye kefil olamadığını söylemiyor"
  );
});

/* ── 4) :593-605 — güvenlik kilidi iki bayrak, üç adım, Perde 1/2 dahil ─────── */

/** Runs the hidden self-test in a child process. It needs neither `--musteri` nor a built dist. */
function kendiniSina(): Promise<{ kod: number | null; cikti: string }> {
  return new Promise((coz) => {
    const p = spawn(process.execPath, [join(KOK, "scripts", "demo-senaryo.mjs"), "--kendini-sina"], {
      cwd: KOK,
      stdio: ["ignore", "pipe", "pipe"],
      // Pinned on purpose: an AEGIS_ variable in the developer's shell must not reshape it.
      env: { ...process.env, NO_COLOR: "1", AEGIS_NAC_TOKEN: "", AEGIS_NV_SIMULATE: "" },
    });
    let cikti = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c: string) => (cikti += c));
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (c: string) => (cikti += c));
    p.on("exit", (kod) => coz({ kod, cikti }));
  });
}

test("DAVRANIŞ↔BELGE: --kendini-sina ÜÇ adım koşar ve runbook üç adım olduğunu söyler", async () => {
  const r = await kendiniSina();

  assert.equal(r.kod, 1, `kilit çıkış kodunu bozmalı.\nÇıktı:\n${r.cikti}`);
  for (const adim of ["1/3", "2/3", "3/3"]) {
    assert.ok(r.cikti.includes(adim), `kendini-sınama '${adim}' adımını koşmadı.\nÇıktı:\n${r.cikti}`);
  }
  assert.match(r.cikti, /BÜTÇE ARTIŞININ GERİ ALINDIĞI DOĞRULANAMADI/, "bütçe bayrağı kendi acil kutusunu basmadı");
  assert.match(r.cikti, /KAMPANYA HÂLÂ YAYINDA OLABİLİR/, "yayın bayrağı kendi acil kutusunu basmadı");

  const b = bolum("### The safety lock, proven on demand");
  assert.doesNotMatch(
    b,
    /once with the revert verified/i,
    "runbook kendini-sınamayı yine İKİ adım anlatıyor — betik üçünü koşuyor (ölçüldü)"
  );
  assert.match(b, /\*\*three\*\* steps/i, "runbook, kendini-sınamanın üç adımını saymıyor");
});

test("BELGE↔KOD: kilit İKİ bayrak taşıyor ve runbook bütçe bayrağını da anlatıyor", () => {
  /**
   * The code fact: the single interlock function checks both flags. Drop one and this goes red
   * before the §2 sentence can quietly become a lie.
   */
  const kilit = perdeBlogu("function guvenlikKilidiniUygula()", "\n/**\n * Death by signal");
  for (const bayrak of ["butceGeriAlinmadi", "perde3GeriAlinmadi"]) {
    assert.ok(
      kilit.includes(bayrak),
      `güvenlik kilidi '${bayrak}' bayrağını artık kontrol etmiyor — docs/DEMO.md iki bayrağı da anlatıyor`
    );
  }

  const bolum2 = DEMO.slice(DEMO.indexOf("## 2. What You Will See"), DEMO.indexOf("## 3. Setup"));
  assert.doesNotMatch(
    bolum2,
    /Three things about act 3 that are worth saying/,
    "2. bölüm kilidi hâlâ yalnız Perde 3'e ait gösteriyor — Perde 1 ve 2'nin bütçe artışı aynı kilide bağlı"
  );
  assert.match(
    bolum2,
    /The \*\*budget\*\* raises of\n  acts 1 and 2 hang from the same interlock/,
    "2. bölüm, bütçe artışlarının aynı kilide bağlı olduğunu söylemiyor"
  );
});

/* ── 5) Aynı doktrin sapmasının runbook'ta kalan iki izi ────────────────────── */

test("DAVRANIŞ: çürütebilen + gözlemiş GERÇEK halka yükseltmeyi taşır, erişilebilirlik taşımaz", async () => {
  /**
   * The positive half of the vouching rule, measured: the SIM is swapped, the device-swap link
   * answers clean over a real channel (it could have agreed with the swap and did not), and the
   * reachability link is real and clean too. The escalation happens and names devSwap alone —
   * `reach` is in no voucher row, so a reachable phone never carries a step-up.
   */
  __setSimSwapKanalForTests({ verifySimSwap: async () => true });
  __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => false });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });

  const karar = await agDogrula({ ...GERCEK_ZINCIR, callFwdCheck: false, expectedCountry: undefined }, "high");

  assert.equal(karar.engel, undefined, "çürütebilen ve gözlemiş gerçek halka varken yükseltme engellendi");
  assert.equal(karar.kademe?.neden, "sim-degisti");
  assert.ok(karar.kademe?.dogrulayan.includes("devSwap"), "cihaz değişimi halkası kefil sayılmadı");
  assert.equal(
    karar.kademe?.dogrulayan.includes("reach"),
    false,
    "erişilebilirlik halkası yükseltmeyi taşıdı — docs/DEMO.md 'never reach' diyor, önce belgeyi düzelt"
  );
});

test("BELGE↔KOD: matris ve karar günlüğü sözlüğü 'kalan halkalar temiz' YETER koşulunu vaat etmiyor", () => {
  /**
   * Both doc claims below are derived from one code fact — `reach` vouches for nothing — so the
   * pair is two-way: add `reach` to a voucher row and the first assertion goes red before the
   * sentences can quietly become lies again.
   */
  const kefilOlabilenler = new Set(Object.values(KEFIL_ESLEMESI).flatMap((k) => [...k]));
  assert.equal(
    kefilOlabilenler.has("reach"),
    false,
    "KEFIL_ESLEMESI artık 'reach'i kefil sayıyor — docs/DEMO.md hem matriste hem günlük sözlüğünde 'never reachability' diyor"
  );

  const simSatiri = DEMO.split("\n").filter((s) => s.includes("| SIM swap says `degisti` |"));
  assert.equal(simSatiri.length, 1, "kapalı-arıza matrisinde 'SIM swap says degisti' satırı yok — satır yeniden adlandırıldıysa gözcü burada durur");
  assert.doesNotMatch(
    simSatiri[0],
    /provided the remaining real links are clean/i,
    "matris yine 'kalan gerçek halkalar temizse yükseltilir' diyor — ölçüldü: yalnız erişilebilirlik temizken REDDEDİLİYOR"
  );
  assert.match(
    simSatiri[0],
    /observed something/i,
    "matris, kefilin bir şey GÖZLEMİŞ olması şartını anmıyor"
  );

  const gunlukSatiri = DEMO.split("\n").filter((s) => s.includes("| `kademeDogrulayan` |"));
  assert.equal(gunlukSatiri.length, 1, "karar günlüğü sözlüğünde 'kademeDogrulayan' satırı yok");
  assert.doesNotMatch(
    gunlukSatiri[0],
    /\(`simSwap`, `reach`/,
    "günlük sözlüğü 'reach'i örnek KEFİL diye gösteriyor — hiçbir kefil kümesinde yok, yani bu alanda asla göremez"
  );

  const kararSatiri = DEMO.split("\n").filter((s) => s.includes("| `karar` |"));
  assert.equal(kararSatiri.length, 1, "karar günlüğü sözlüğünde 'karar' satırı yok");
  assert.doesNotMatch(
    kararSatiri[0],
    /the remaining links came back clean/i,
    "'kademeli' tanımı yine 'kalan halkalar temiz döndü' diyor — kefalet koşulunu (çürütebilme + gözlem) atlıyor"
  );
});
