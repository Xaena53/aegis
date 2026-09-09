// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PHASE 4 — THE GROWTH BRAIN CLI'S HEADER, TIED TO WHAT THE CODE ACTUALLY DOES.
 *
 * The header comment of scripts/growth-brain.mjs is not decoration: it is the only place
 * that tells a reader — a maintainer, or a hackathon jury — what the client-side belts are.
 * Two of its claims had come loose, and both are locked here.
 *
 *   1) "THE EFFECTIVE CEILING IS WHAT REACHES planDogrula" WAS FALSE ON A MULTI-CHANNEL
 *      RUN. The effective ceiling is min(the CLI ceiling, the server's ceiling) — that part
 *      was right — but that figure is the TOTAL THAT GETS SPLIT. butceDagit divides it over
 *      the configured channels and planDogrula is handed kanalButcesi, the share of
 *      UYGULANAN_KANAL. With one configured channel the two are equal, which is exactly why
 *      the wrong sentence survived. MEASURED below, end to end: with a 100 TL ceiling split
 *      60/40, a plan asking for 100 TL is REFUSED and the refusal names "tavan: 40".
 *
 *   2) THE LAST SAFETY BULLET OF --yayinla WAS HALF-TRANSLATED. Its first line had been
 *      turned into English while the second — the clause carrying the actual guarantee, that
 *      the creation path's blacklist is untouched — was left in Turkish mid-sentence. An
 *      auditor reading the most dangerous mode of this CLI could read that the ENABLED call
 *      has a single exit point, but not that the second belt is still fastened.
 *
 * WHY THESE GUARDS CAN GO RED IN BOTH DIRECTIONS — the point of the exercise:
 *   - Stale sentence, live code: the prose assertions below name the exact claims. Put the
 *     old wording back and they fail.
 *   - Live sentence, changed code: the header's claims are checked AGAINST the code. Pass
 *     efektifTavan to planDogrula instead of kanalButcesi and both the source-shape guard
 *     and the subprocess measurement fail; drop a member from uygulama.mjs's KARA_LISTE and
 *     the blacklist guard fails, because it is derived from that export rather than from a
 *     copy of it.
 *
 * WHY A REAL SUBPROCESS: the flow being measured — ceiling, allocation, share, plan
 * validation — lives inside ana(), which is not exported and runs only when the file is
 * invoked directly. The measurement therefore RUNS THE REAL FILE IN PLACE, with a resolve
 * hook that swaps only scripts/brain/ortak.mjs (the model client and the MCP connection) for
 * a stub. Everything else on the path — butceDagit, dagitimDogrula, uygulanacakPay,
 * planDogrula, the approval screen — is the production code.
 *
 * The scratch directory is created INSIDE THE REPOSITORY (.tmp-faz4gb-*, already ignored by
 * .gitignore) and removed in after(). Not in the system temp directory: Node resolves bare
 * specifiers by walking UP from the importing file, and above the system temp directory
 * there is no node_modules, so a copy placed there dies with ERR_MODULE_NOT_FOUND on Linux
 * CI.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { KARA_LISTE } from "../scripts/brain/uygulama.mjs";

const KOK = join(import.meta.dirname, "..");
const BEYIN = join(KOK, "scripts", "growth-brain.mjs");
const KAYNAK = readFileSync(BEYIN, "utf8");

/* ── The header block ────────────────────────────────────────────────────────── */

/**
 * The file's first block comment — the header. Anchored on a phrase of its own so that a
 * header that was deleted, or a comment that is no longer the first one, is reported as a
 * failure instead of being silently replaced by some other block.
 */
function basligiAl(kaynak) {
  const bas = kaynak.indexOf("/**");
  const son = kaynak.indexOf("*/", bas);
  assert.ok(bas >= 0 && son > bas, "scripts/growth-brain.mjs has no header block comment.");
  const blok = kaynak.slice(bas, son + 2);
  assert.ok(
    blok.includes("The Growth Brain CLI"),
    "The first block comment of scripts/growth-brain.mjs is no longer the CLI header — " +
      "these guards would be reading the wrong block."
  );
  return blok;
}

const BASLIK = basligiAl(KAYNAK);

/** The header as flowing text: the ` * ` prefixes dropped, whitespace collapsed. A claim
 * stays findable after the block is re-wrapped. */
const BASLIK_DUZ = BASLIK.replace(/^[ \t]*\*[ \t]?/gm, " ").replace(/\s+/g, " ").trim();

/* ── Guard 1: the ceiling sentence, tied to the code ─────────────────────────── */

test("BELGE: header says the SHARE reaches planDogrula, not the effective ceiling", () => {
  assert.ok(
    !/that value is what reaches\s+planDogrula/.test(BASLIK_DUZ),
    "The header has gone back to the stale claim that min(CLI ceiling, server ceiling) is " +
      "'what reaches planDogrula'. MEASURED false on a multi-channel run: with a 100 TL " +
      "effective ceiling split 60/40, planDogrula is handed 40."
  );
  assert.match(
    BASLIK_DUZ,
    /what reaches planDogrula is kanalButcesi/,
    "The header must state which figure planDogrula actually receives (kanalButcesi, the " +
      "share of UYGULANAN_KANAL). Without it, a reader who relaxes the ceiling check on the " +
      "strength of this comment is aiming at the wrong number."
  );
  for (const ad of ["butceDagit", "UYGULANAN_KANAL", "kanalButcesi", "planDogrula"]) {
    assert.ok(
      BASLIK_DUZ.includes(ad),
      `The header no longer names '${ad}'; the sentence can no longer be checked against the code.`
    );
  }
});

test("KOD: planDogrula is called with kanalButcesi — the share, picked by channel name", () => {
  /**
   * The other direction of the same claim. A tight pattern on purpose: rewrite the call as
   * planDogrula(plan, efektifTavan) and the captured name no longer matches; inline the
   * expression as planDogrula(plan, birincilPay.gunlukButce) and there is no match at all.
   * Either way the header's sentence has to be revisited rather than quietly outlived.
   */
  const cagrilar = [
    ...KAYNAK.matchAll(/planDogrula\(\s*([A-Za-z0-9_$]+)\s*,\s*([A-Za-z0-9_$]+)\s*\)/g),
  ];
  assert.equal(
    cagrilar.length,
    1,
    `Expected exactly one planDogrula(x, y) call site in growth-brain.mjs, found ${cagrilar.length}. ` +
      "The header describes ONE validation point; more (or none) means the header is stale."
  );
  assert.deepEqual(
    [cagrilar[0][1], cagrilar[0][2]],
    ["plan", "kanalButcesi"],
    "planDogrula is no longer validating the plan against the applied channel's share. " +
      "The header claims kanalButcesi reaches it; fix one or the other."
  );

  for (const desen of [
    /const UYGULANAN_KANAL = "google";/,
    /const birincilPay = uygulanacakPay\(dagitim, UYGULANAN_KANAL\);/,
    /const kanalButcesi = birincilPay\.gunlukButce;/,
    /toplamButce: efektifTavan/,
  ]) {
    assert.match(
      KAYNAK,
      desen,
      "The chain the header describes (effective ceiling -> butceDagit -> share of " +
        `UYGULANAN_KANAL -> planDogrula) is broken: ${desen} no longer matches.`
    );
  }
});

/* ── Guard 2: the go-live bullet, tied to the real blacklist ─────────────────── */

/**
 * The blacklist claim, as a pure function so its CODE direction can be exercised rather than
 * asserted. Called below both with the genuine KARA_LISTE and with a shortened stand-in.
 */
function karaListeIddiasiniDogrula(baslikDuz, karaListe) {
  assert.ok(
    /blacklist \(KARA_LISTE = set_campaign_status \/ update_campaign_budget\) stays exactly as it is/.test(
      baslikDuz
    ),
    "The --yayinla section must state, in English, that the creation path's blacklist is " +
      "untouched. This clause was left in Turkish mid-sentence once already, which put the " +
      "second belt out of an auditor's reach."
  );
  for (const arac of karaListe) {
    assert.ok(
      baslikDuz.includes(arac),
      `uygulama.mjs blacklists '${arac}', and the header does not name it. The header ` +
        "promises the whole blacklist stands; a member it does not name is a promise " +
        "nobody can check."
    );
  }
  assert.equal(
    karaListe.length,
    2,
    "KARA_LISTE has changed size. The header's bullet names its members one by one, so it " +
      "has to be rewritten with the new list — this guard will not vouch for a list it " +
      "cannot see."
  );
}

test("BELGE: the go-live bullet names the real blacklist of uygulama.mjs", () => {
  karaListeIddiasiniDogrula(BASLIK_DUZ, KARA_LISTE);

  assert.ok(
    BASLIK_DUZ.includes("leaves ONLY through the yayinaAl() function"),
    "The header must keep saying that the ENABLED call has a single exit point."
  );
  /**
   * "A single exit point" as the source can show it: exactly one dynamic import binding
   * yayinaAl, and exactly one call of it. Prose in comments is not counted — WHERE that call
   * sits (inside the --yayinla branch) already has its own guard in test/brain/yayin.test.mjs;
   * what is locked here is that the header's ONLY-claim still has exactly one referent.
   */
  const alimlar = [...KAYNAK.matchAll(/const \{ yayinaAl \} = await import\(/g)];
  const cagrilar = [...KAYNAK.matchAll(/await yayinaAl\(/g)];
  assert.deepEqual(
    [alimlar.length, cagrilar.length],
    [1, 1],
    `growth-brain.mjs has ${alimlar.length} yayinaAl import(s) and ${cagrilar.length} call(s); ` +
      "exactly one of each is what makes the header's 'leaves ONLY through yayinaAl' true."
  );
});

test("MUTASYON: the blacklist guard is red when the code side shrinks", () => {
  /**
   * The code direction, executed. uygulama.mjs belongs to another worker in this phase, so
   * it is not mutated on disk; the guard is fed a blacklist that has lost a member instead —
   * which is precisely what the guard has to notice.
   */
  assert.throws(
    () => karaListeIddiasiniDogrula(BASLIK_DUZ, ["set_campaign_status"]),
    /KARA_LISTE has changed size/,
    "The blacklist guard would stay green while KARA_LISTE shrank — that is a vacuum guard."
  );
});

/* ── Guard 3: no half-translated line survives in the header ─────────────────── */

/** Letters that occur in Turkish and not in English. */
const TURKCE_HARF = /[ıİşŞğĞçÇöÖüÜ]/;
/**
 * Turkish function words that cannot appear as standalone English words. They are what
 * catches a leftover clause written entirely in ASCII — "…kara listesi … aynen durur." has
 * no Turkish-specific letter in it at all.
 */
const TURKCE_KELIME =
  /\b(ve|ile|bir|bu|ama|gibi|sonra|kadar|aynen|durur|kalir|olur|yolunun|listesi|kurulum|kara|degil|icin|yalniz|hicbir)\b/i;

test("BELGE: every line of the header is English (no half-translated leftovers)", () => {
  /**
   * Quoted product strings are exempt and NOTHING ELSE IS: the header quotes user-facing
   * Turkish verbatim (the "KURU MOD — HİÇBİR YAZMA YAPILMADI" stamp), and that is correct.
   * The exemption is deliberately narrow — a single-line double-quoted span. A leftover
   * clause is prose, not a quoted string, so it cannot hide behind this; widening the
   * exemption to multi-line spans would let a stray pair of quotes swallow one.
   */
  const suclular = [];
  BASLIK.split("\n").forEach((satir, i) => {
    const cikarilmis = satir.replace(/"[^"\n]*"/g, '""');
    if (TURKCE_HARF.test(cikarilmis) || TURKCE_KELIME.test(cikarilmis)) {
      suclular.push(`${i + 1}: ${satir.trim()}`);
    }
  });
  assert.deepEqual(
    suclular,
    [],
    "Turkish left over in the English header of growth-brain.mjs:\n" +
      suclular.join("\n") +
      "\nA sentence that stops mid-clause is worse than no sentence: the invariant it was " +
      "carrying becomes unreadable exactly where it matters."
  );
});

/* ── The measurement: run the real CLI ───────────────────────────────────────── */

/** The system-prompt anchors the stub dispatches on. Each is asserted to still exist. */
const SISTEM_ANAHTARLARI = {
  arastirma: ["scripts/brain/arastirma.mjs", "pazar araştırması analistisin"],
  dagitim: ["scripts/brain/dagitim.mjs", "bütçe stratejistisin"],
  strateji: ["scripts/brain/strateji.mjs", "strateji katmanısın"],
  kreatif: ["scripts/brain/kreatif.mjs", "(RSA) metin yazarısın"],
};

test("DÜZENEK: the stub's dispatch anchors still exist in the real prompts", () => {
  for (const [adim, [dosya, capa]] of Object.entries(SISTEM_ANAHTARLARI)) {
    assert.ok(
      readFileSync(join(KOK, dosya), "utf8").includes(capa),
      `The '${adim}' step's system prompt no longer contains "${capa}"; the stub would ` +
        "answer the wrong step and this measurement would stop measuring anything."
    );
  }
});

const temizlenecek = [];
after(() => {
  for (const dizin of temizlenecek) rmSync(dizin, { recursive: true, force: true });
});

/** Writes the resolve hook and the ortak.mjs stub into a scratch directory in the repo. */
function duzenekKur() {
  const dizin = mkdtempSync(join(KOK, ".tmp-faz4gb-"));
  temizlenecek.push(dizin);

  // The query suffix keeps the stub's own import of the real module out of the hook's reach.
  const gercekOrtak = `${pathToFileURL(join(KOK, "scripts", "brain", "ortak.mjs")).href}?gercek=1`;
  const a = (deger) => JSON.stringify(deger);

  writeFileSync(
    join(dizin, "stub-ortak.mjs"),
    [
      "// SPDX-License-Identifier: AGPL-3.0-only",
      `export * from ${a(gercekOrtak)};`,
      "",
      "// Only the model client and the MCP connection are replaced; ayracNotrle, semaDogrula",
      "// and the rest keep coming from the real module through the star re-export above.",
      "export const BRAIN_MODEL = 'faz4-stub';",
      "export const BRAIN_SAGLAYICI = 'faz4-stub';",
      "export function beyinIstemcisi() { return { stub: true }; }",
      "",
      "const AY = JSON.parse(process.env.FAZ4_AYAR ?? '{}');",
      "",
      "const ARASTIRMA = {",
      "  pazarOzeti: 'Deri canta pazari yogun rekabetli.',",
      "  hedefKitle: '25-45 yas, sehirli, kalite odakli alicilar.',",
      "  rakipYaklasimlari: ['indirim odakli'],",
      "  anahtarKelimeAdaylari: [",
      "    { kelime: 'deri canta', gerekce: 'yuksek niyet' },",
      "    { kelime: 'el yapimi canta', gerekce: 'farklilasma' },",
      "  ],",
      "  riskler: ['marka bilinirligi dusuk'],",
      "};",
      "",
      "export async function jsonUret(_istemci, { sistem }) {",
      "  const s = String(sistem ?? '');",
      `  if (s.includes(${a(SISTEM_ANAHTARLARI.arastirma[1])})) return ARASTIRMA;`,
      `  if (s.includes(${a(SISTEM_ANAHTARLARI.dagitim[1])})) return { dagitim: AY.dagitim };`,
      `  if (s.includes(${a(SISTEM_ANAHTARLARI.strateji[1])})) {`,
      "    return {",
      "      kampanyaAdi: 'Deri Canta Arama',",
      "      butceGunlukTL: AY.planButce,",
      "      hedefUlke: 'TR',",
      "      dil: 'tr',",
      "      adGruplari: [{ ad: 'Genel', eslesmeTipi: 'PHRASE', anahtarKelimeler: ['deri canta', 'el yapimi canta'] }],",
      "      negatifKelimeler: ['ucuz'],",
      "      basariMetrikleri: ['donusum basina maliyet'],",
      "    };",
      "  }",
      `  if (s.includes(${a(SISTEM_ANAHTARLARI.kreatif[1])})) {`,
      "    return {",
      "      basliklar: Array.from({ length: 15 }, (_, i) => `Deri Canta Secenek ${i + 1}`),",
      "      aciklamalar: Array.from({ length: 4 }, (_, i) => `El yapimi deri canta koleksiyonu ${i + 1}.`),",
      "    };",
      "  }",
      "  // Fail closed: an unrecognised prompt is a drifted stub, not a reason to invent an answer.",
      "  throw new Error('faz4 stub: unrecognised system prompt');",
      "}",
      "",
      "export async function mcpBaglan() {",
      "  return {",
      "    async cagir(arac) { throw new Error(`faz4 stub: '${arac}' is not available in this run`); },",
      "    async kaynakOku(uri) {",
      "      if (!uri.endsWith('/limits')) throw new Error(`faz4 stub: unexpected resource ${uri}`);",
      "      return JSON.stringify({ yazmaIzni: true, gunlukButceTavani: AY.sunucuTavan });",
      "    },",
      "    async kapat() {},",
      "  };",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  writeFileSync(
    join(dizin, "kanca.mjs"),
    [
      "// SPDX-License-Identifier: AGPL-3.0-only",
      "import * as modul from 'node:module';",
      "",
      "const STUB = new URL('./stub-ortak.mjs', import.meta.url).href;",
      "const hedefMi = (url) => typeof url === 'string' && url.endsWith('/scripts/brain/ortak.mjs');",
      "",
      "// registerHooks (Node >= 22.15) runs in-thread and is not deprecated; register() is the",
      "// fallback for the older runtimes the engines field still allows.",
      "if (typeof modul.registerHooks === 'function') {",
      "  modul.registerHooks({",
      "    resolve(specifier, context, nextResolve) {",
      "      const r = nextResolve(specifier, context);",
      "      return hedefMi(r.url) ? { ...r, url: STUB, shortCircuit: true } : r;",
      "    },",
      "  });",
      "} else {",
      "  modul.register('./kanca-async.mjs', import.meta.url);",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  writeFileSync(
    join(dizin, "kanca-async.mjs"),
    [
      "// SPDX-License-Identifier: AGPL-3.0-only",
      "const STUB = new URL('./stub-ortak.mjs', import.meta.url).href;",
      "export async function resolve(specifier, context, next) {",
      "  const r = await next(specifier, context);",
      "  if (typeof r.url === 'string' && r.url.endsWith('/scripts/brain/ortak.mjs')) {",
      "    return { ...r, url: STUB, shortCircuit: true };",
      "  }",
      "  return r;",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );

  return dizin;
}

/**
 * Runs the real growth-brain.mjs. cwd is the scratch directory, so dotenv finds no .env and
 * the report file lands there instead of in the working tree. stdin is closed: the approval
 * question is answered with a refusal, which is enough — everything measured here happens
 * BEFORE the first write.
 */
function kosu(dizin, { sunucuTavan, planButce, dagitim, metaVar }) {
  const ortam = { ...process.env, FAZ4_AYAR: JSON.stringify({ sunucuTavan, planButce, dagitim }) };
  if (metaVar) {
    ortam.AEGIS_META_TOKEN = "TEST-ONLY-faz4-meta-token";
    ortam.AEGIS_META_AD_ACCOUNT_ID = "TEST-ONLY-faz4-act";
  } else {
    delete ortam.AEGIS_META_TOKEN;
    delete ortam.AEGIS_META_AD_ACCOUNT_ID;
  }
  const sonuc = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(join(dizin, "kanca.mjs")).href,
      BEYIN,
      "--hedef",
      "yeni musteri kaydi",
      "--url",
      "https://ornek.example",
      "--butce",
      "200",
      "--musteri",
      "1234567890",
      "--uygula",
    ],
    { cwd: dizin, env: ortam, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  return { kod: sonuc.status, cikti: `${sonuc.stdout ?? ""}${sonuc.stderr ?? ""}` };
}

const COK_KANALLI = [
  { kanal: "meta", gunlukButce: 60, gerekce: "sosyal agirlik" },
  { kanal: "google", gunlukButce: 40, gerekce: "arama niyeti" },
];

test("ÖLÇÜM: on a multi-channel run planDogrula gets the SHARE (40), not the ceiling (100)", () => {
  const dizin = duzenekKur();
  /**
   * The CLI ceiling is 200 and the server's is 100, so the effective ceiling is 100. The
   * allocation splits it 60/40 and the plan asks for exactly 100 — the effective ceiling.
   * If the header's old claim were true the plan would pass. It is refused, and the refusal
   * prints the ceiling it was measured against.
   */
  const { kod, cikti } = kosu(dizin, {
    sunucuTavan: 100,
    planButce: 100,
    dagitim: COK_KANALLI,
    metaVar: true,
  });
  assert.equal(kod, 1, `Expected the plan to be refused. Output:\n${cikti}`);
  const eslesme = /\(gelen: 100, tavan: (\d+)\)/.exec(cikti);
  assert.ok(eslesme, `planDogrula's ceiling refusal was not seen at all. Output:\n${cikti}`);
  assert.equal(
    eslesme[1],
    "40",
    `planDogrula was validated against ${eslesme[1]} TL. 40 is the share of the channel the ` +
      "campaign is created on; 100 is the effective ceiling, which is only the total being " +
      "split. The header says kanalButcesi reaches planDogrula — if that is no longer true, " +
      "both have to move together."
  );
  assert.ok(
    cikti.includes("Bağlayıcı günlük bütçe tavanı: 100 TL"),
    `The effective ceiling was not collapsed to min(200, 100). Output:\n${cikti}`
  );
});

test("ÖLÇÜM: the approval screen shows the ceiling as the SPLIT TOTAL beside the share", () => {
  const dizin = duzenekKur();
  const { kod, cikti } = kosu(dizin, {
    sunucuTavan: 100,
    planButce: 40,
    dagitim: COK_KANALLI,
    metaVar: true,
  });
  assert.equal(kod, 0, `Expected a clean run ending in a refused approval. Output:\n${cikti}`);
  assert.ok(
    cikti.includes("Günlük bütçe : 40 TL — 'google' kanalının PAYI"),
    `The approval screen does not present 40 TL as the applied channel's share. Output:\n${cikti}`
  );
  assert.ok(
    cikti.includes("Toplam bütçe : 100 TL, 2 kanala bölündü"),
    "The approval screen does not present the effective ceiling as the split total — the " +
      `header claims it does. Output:\n${cikti}`
  );
  assert.ok(
    cikti.includes("Onay verilmedi — hiçbir yazma yapılmadı."),
    `A closed stdin must count as a refusal. Output:\n${cikti}`
  );
});

test("ÖLÇÜM: with one configured channel the ceiling and the share coincide", () => {
  const dizin = duzenekKur();
  /**
   * Why the wrong sentence went unnoticed for so long, made explicit: without Meta
   * configured butceDagit does not even call the model, the single share IS the effective
   * ceiling, and a plan at 100 passes against both readings.
   */
  const { kod, cikti } = kosu(dizin, {
    sunucuTavan: 100,
    planButce: 100,
    dagitim: COK_KANALLI, // ignored: with one channel the model is never asked
    metaVar: false,
  });
  assert.equal(kod, 0, `Expected a clean single-channel run. Output:\n${cikti}`);
  assert.ok(
    cikti.includes("Kanal dağıtımı: google: 100"),
    `The whole ceiling should fall to the single channel. Output:\n${cikti}`
  );
  assert.ok(
    cikti.includes("Günlük bütçe : 100 TL (bağlayıcı tavan: 100 TL"),
    `A single-channel run should show one figure, not a split. Output:\n${cikti}`
  );
});
