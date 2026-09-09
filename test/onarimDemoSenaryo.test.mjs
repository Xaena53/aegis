// SPDX-License-Identifier: AGPL-3.0-only
/**
 * REPAIR REGRESSIONS — scripts/demo-senaryo.mjs
 *
 * On stage the demo script calls REAL write tools: Act 1's +1 budget raise and Act 3's going
 * live both spend real money. This file nails down four audited defects at the level of
 * BEHAVIOUR — by running the script end to end, not by grepping its source for a phrase.
 *
 * HOW: instead of the real server (dist/index.js), a FAKE MCP server is written into a
 * temporary project created inside the repo root (the fake-project pattern of
 * test/onucusKurallari.test.mjs; the temp root has to live inside the repo so that
 * `@modelcontextprotocol/sdk` resolves from node_modules — here the SCRIPT is the client, so
 * the SDK is only needed on its side). The fake server speaks plain JSON-RPC over stdio, keeps
 * the campaign's status and budget in a file, and RECORDS EVERY WRITE CALL it receives. So what
 * is measured is not "what the script said it did" but "what happened in the account" and
 * "which tool was actually called".
 *
 * Four findings, four measurements:
 *   1) When the gate fails to refuse in Act 3/B and the campaign reads back ENABLED, the
 *      reversal IS ATTEMPTED and, if it cannot be verified, the red emergency box is printed
 *      (there used to be nothing but a `throw`).
 *   2) With --canli but no --kampanya, Act 3/A NEVER makes the going-live call (it used to
 *      really take the script's own pick live).
 *   3) When Act 1's +1 raise cannot be reverted the screen does NOT say "geri alındı": the
 *      budget emergency box is printed and the exit code is 1 (it used to claim the reversal
 *      unconditionally and end with 0).
 *   4) The --kampanya value is never silently trimmed, and the --kampanya=<id> spelling is
 *      never silently ignored.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const KOK = fileURLToPath(new URL("..", import.meta.url));
const MUSTERI = "1234567890";
const KAMPANYA_ID = "5550001";
const BASLANGIC_BUTCE = 25;

/**
 * THE FAKE MCP SERVER (the temporary project's dist/index.js).
 *
 * Written with String.raw so backslash escapes reach the child VERBATIM — which is why the
 * child source below uses no backticks and no ${...}.
 *
 * Behaviour switches (they MUST carry the AEGIS_ prefix: the demo script forwards only
 * GOOGLE_ADS_/AEGIS_ variables into the server process):
 *   AEGIS_SAHTE_DURUM   : path of the state + call-log file
 *   AEGIS_SAHTE_BUTCE   : "uygula" | "ret"    — is a budget RAISE applied on the clean channel
 *   AEGIS_SAHTE_YAYIN   : "uygula" | "ret"    — is an ENABLED request applied (the regression)
 *   AEGIS_SAHTE_DUSURME : "uygula" | "reddet" — does the REVERSAL (decrease/PAUSED) succeed
 */
const SAHTE_SUNUCU = String.raw`
import { readFileSync, writeFileSync } from "node:fs";

const DOSYA = process.env.AEGIS_SAHTE_DURUM;
const SIM = process.env.AEGIS_NAC_SIMULATE || "";
const BUTCE = process.env.AEGIS_SAHTE_BUTCE || "ret";
const YAYIN = process.env.AEGIS_SAHTE_YAYIN || "ret";
const DUSURME = process.env.AEGIS_SAHTE_DUSURME || "uygula";
const PENCERE = process.env.AEGIS_SIMSWAP_WINDOW_HOURS || "72";
const RET =
  "AĞ DOĞRULAMASI BAŞARISIZ — işlem uygulanmadı.\n" +
  "• Ağ doğrulaması [SİMÜLASYON]: SIM değişimi bildirildi (son " + PENCERE + " saat, onaylayıcı hattı).";

const oku = () => JSON.parse(readFileSync(DOSYA, "utf8"));
const durumYaz = (d) => writeFileSync(DOSYA, JSON.stringify(d, null, 2));
const gonder = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const sonuc = (id, r) => gonder({ jsonrpc: "2.0", id, result: r });
const metin = (id, t, hata) => sonuc(id, { content: [{ type: "text", text: t }], isError: Boolean(hata) });

function gaql(sorgu, d) {
  const k = d.kampanya;
  if (/ad_group_ad/.test(sorgu)) return [{ campaign: { id: k.id }, ad_group_ad: { ad: { id: "9001" } } }];
  // The account holds ONE campaign: a query that explicitly names another id returns nothing.
  const suzgec = sorgu.match(/campaign\.id\s*=\s*(\d+)/);
  if (suzgec && suzgec[1] !== String(k.id)) return [];
  if (/campaign\.name/.test(sorgu)) {
    return [{ campaign: { id: k.id, name: k.ad, status: k.durum }, campaign_budget: { amount_micros: k.butceMikro } }];
  }
  if (/amount_micros/.test(sorgu)) return [{ campaign: { id: k.id }, campaign_budget: { amount_micros: k.butceMikro } }];
  return [{ campaign: { id: k.id, status: k.durum } }];
}

function aracCagrisi(id, p) {
  const ad = p.name;
  const arg = p.arguments || {};
  const d = oku();

  if (ad === "run_gaql") {
    const satirlar = gaql(String(arg.query || ""), d);
    return sonuc(id, {
      content: [{ type: "text", text: "Satırlar:\n" + JSON.stringify(satirlar) }],
      structuredContent: { satirlar },
    });
  }

  d.cagrilar.push({
    arac: ad,
    sim: SIM,
    status: arg.status === undefined ? null : String(arg.status),
    butce: arg.newDailyBudget === undefined ? null : Number(arg.newDailyBudget),
  });

  let cevap = { t: "bilinmeyen araç: " + ad, hata: true };
  if (ad === "update_campaign_budget") {
    const yeni = Number(arg.newDailyBudget);
    const suanki = d.kampanya.butceMikro / 1e6;
    if (yeni < suanki) {
      // A decrease is the REVERSAL path; it needs no approval.
      if (DUSURME === "reddet") cevap = { t: "Bütçe düşürülemedi (sahte hata).", hata: true };
      else {
        d.kampanya.butceMikro = Math.round(yeni * 1e6);
        cevap = { t: "Kampanya bütçesi güncellendi: " + yeni, hata: false };
      }
    } else if (SIM === "degisti" || BUTCE !== "uygula") {
      cevap = { t: RET, hata: true };
    } else {
      d.kampanya.butceMikro = Math.round(yeni * 1e6);
      cevap = { t: "Kampanya bütçesi güncellendi: " + yeni, hata: false };
    }
  } else if (ad === "set_campaign_status") {
    const istenen = String(arg.status || "");
    if (istenen === "PAUSED") {
      if (DUSURME === "reddet") cevap = { t: "Kampanya duraklatılamadı (sahte hata).", hata: true };
      else {
        d.kampanya.durum = 3;
        cevap = { t: "Kampanya durumu güncellendi: PAUSED", hata: false };
      }
    } else if (YAYIN === "uygula") {
      d.kampanya.durum = 2;
      cevap = { t: "Kampanya durumu güncellendi: ENABLED", hata: false };
    } else {
      cevap = { t: RET, hata: true };
    }
  }

  durumYaz(d);
  return metin(id, cevap.t, cevap.hata);
}

function isle(m) {
  if (m.id === undefined || m.id === null) return; // notification
  if (m.method === "initialize") {
    return sonuc(m.id, {
      protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "sahte-aegis", version: "0.0.0" },
    });
  }
  if (m.method === "ping") return sonuc(m.id, {});
  if (m.method === "tools/list") return sonuc(m.id, { tools: [] });
  if (m.method === "resources/list") return sonuc(m.id, { resources: [] });
  if (m.method === "resources/read") {
    return sonuc(m.id, {
      contents: [
        {
          uri: (m.params || {}).uri,
          mimeType: "application/json",
          text: JSON.stringify({ gunlukButceTavani: 1000 }),
        },
      ],
    });
  }
  if (m.method === "tools/call") return aracCagrisi(m.id, m.params || {});
  gonder({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "yok: " + m.method } });
}

let tampon = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (parca) => {
  tampon += parca;
  let n;
  while ((n = tampon.indexOf("\n")) >= 0) {
    const satir = tampon.slice(0, n).trim();
    tampon = tampon.slice(n + 1);
    if (!satir) continue;
    try {
      isle(JSON.parse(satir));
    } catch {
      /* a malformed line is ignored */
    }
  }
});
`;

/** The temporary fake project: scripts/demo-senaryo.mjs + a fake dist/index.js + a state file. */
function sahneKur(ad, { durum = 3, butce = BASLANGIC_BUTCE, sunucuKur = true } = {}) {
  const kok = join(KOK, `.tmp-onarim-demo-${ad}-${process.pid}`);
  rmSync(kok, { recursive: true, force: true });
  mkdirSync(join(kok, "scripts"), { recursive: true });
  mkdirSync(join(kok, "dist"), { recursive: true });
  cpSync(join(KOK, "scripts", "demo-senaryo.mjs"), join(kok, "scripts", "demo-senaryo.mjs"));
  const durumDosyasi = join(kok, "durum.json");
  writeFileSync(
    durumDosyasi,
    JSON.stringify(
      {
        kampanya: { id: KAMPANYA_ID, ad: "TEST — sahne kampanyası", durum, butceMikro: butce * 1e6 },
        cagrilar: [],
      },
      null,
      2
    )
  );
  if (sunucuKur) writeFileSync(join(kok, "dist", "index.js"), SAHTE_SUNUCU);
  else rmSync(join(kok, "dist"), { recursive: true, force: true });
  return { kok, durumDosyasi, durumOku: () => JSON.parse(readFileSync(durumDosyasi, "utf8")) };
}

/**
 * Runs the script. The environment is pinned ON PURPOSE: AEGIS_ variables in the developer's
 * shell (window hours, the NV simulation, a real token) must not reshape the scene.
 */
function kos(kok, argumanlar, ek = {}) {
  return new Promise((coz) => {
    const p = spawn(process.execPath, [join(kok, "scripts", "demo-senaryo.mjs"), ...argumanlar], {
      cwd: kok,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
        AEGIS_NAC_TOKEN: "",
        AEGIS_NV_SIMULATE: "",
        AEGIS_SIMSWAP_WINDOW_HOURS: "72",
        AEGIS_SAHTE_DURUM: join(kok, "durum.json"),
        AEGIS_SAHTE_BUTCE: "ret",
        AEGIS_SAHTE_YAYIN: "ret",
        AEGIS_SAHTE_DUSURME: "uygula",
        ...ek,
      },
    });
    let cikti = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c) => (cikti += c));
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (c) => (cikti += c));
    p.on("exit", (kod) => coz({ kod, cikti }));
  });
}

const yazmalar = (durum, arac, sim) =>
  durum.cagrilar.filter((c) => c.arac === arac && (sim === undefined || c.sim === sim));

/* ── FINDING 1 (critical) — Act 3/B: an ENABLED read-back must be reverted, and shouted ─ */

/**
 * Act 3/B really calls `set_campaign_status → ENABLED`, in DRY mode too: its safety rests
 * entirely on the network gate refusing. If a regression stops the gate from refusing, the
 * campaign goes live ON STAGE. The old code answered that with a bare `throw`: no reversal
 * attempt, no red emergency box, nothing on screen but "DEMO HATASI" — campaign live, nobody
 * the wiser. Here the gate deliberately does NOT refuse (AEGIS_SAHTE_YAYIN=uygula) and the
 * reversal is refused as well (AEGIS_SAHTE_DUSURME=reddet): the script must both TRY to revert
 * and, failing to verify it, SHOUT.
 */
test("Perde 3/B: ret gelmeyip kampanya ENABLED okunursa geri alma denenir ve acil kutusu basılır", async () => {
  const sahne = sahneKur("3b");
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI], {
      AEGIS_SAHTE_YAYIN: "uygula", // the gate regression: ENABLED really is applied
      AEGIS_SAHTE_DUSURME: "reddet", // and the reversal does not hold → the interlock must fire
    });
    const durum = sahne.durumOku();

    const duraklatmalar = yazmalar(durum, "set_campaign_status").filter((c) => c.status === "PAUSED");
    assert.ok(
      duraklatmalar.length >= 1,
      `Kampanya ENABLED okundu ama HİÇ duraklatma denenmedi (çağrılar: ${JSON.stringify(durum.cagrilar)}).\nÇıktı:\n${r.cikti}`
    );
    assert.match(
      r.cikti,
      /GERİ ALMA DOĞRULANAMADI — KAMPANYA HÂLÂ YAYINDA OLABİLİR/,
      `Acil kutusu basılmadı — kampanya yayında kalmış olabilir.\nÇıktı:\n${r.cikti}`
    );
    assert.match(r.cikti, /ŞİMDİ ELLE DURAKLAT/, `Elle müdahale talimatı yok.\nÇıktı:\n${r.cikti}`);
    assert.equal(r.kod, 1, `Çıkış kodu 1 olmalıydı.\nÇıktı:\n${r.cikti}`);
  } finally {
    rmSync(sahne.kok, { recursive: true, force: true });
  }
});

/* ── FINDING 2 (critical) — --canli without --kampanya takes NOTHING live ──────── */

/**
 * The file header described going live as happening "ONLY on a TEST campaign named explicitly
 * with --kampanya"; the code, with no --kampanya, picked a candidate ITSELF and really took it
 * live. The one path that spends money asks for explicit intent: run --canli without
 * --kampanya and Act 3/A must NEVER make the going-live call.
 */
test("--kampanya verilmeden --canli, Perde 3/A'da yayına alma çağrısını HİÇ yapmaz", async () => {
  const sahne = sahneKur("canli-adsiz");
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI, "--canli"]);
    const durum = sahne.durumOku();

    // Act 3/A's server is started on the "temiz" channel and 3/B's on "degisti", so a
    // going-live call arriving on "temiz" means 3/A's live rehearsal actually ran.
    assert.deepEqual(
      yazmalar(durum, "set_campaign_status", "temiz"),
      [],
      `Betiğin KENDİ seçtiği kampanya yayına alınmaya çalışıldı.\nÇıktı:\n${r.cikti}`
    );
    assert.match(r.cikti, /--kampanya verilmedi/, `Atlama gerekçesi ekranda söylenmedi.\nÇıktı:\n${r.cikti}`);
    assert.equal(r.kod, 0, `Koşu temiz bitmeliydi.\nÇıktı:\n${r.cikti}`);
  } finally {
    rmSync(sahne.kok, { recursive: true, force: true });
  }
});

/* ── FINDING 3 (high) — Act 1's +1 raise lives under the interlock ─────────────── */

/**
 * The result of Act 1's reversal call was never read: the screen said "bütçe eski değerine
 * döndürüldü" unconditionally, the summary table said "+1 uygulandı, geri alındı"
 * unconditionally, and the run ended with 0. Here the server APPLIES the raise but refuses the
 * decrease, so the +1 stays in the account. The script has to READ THAT BACK and shout —
 * claiming "geri alındı" is forbidden.
 */
test("Perde 1: bütçe artışı geri alınamazsa 'geri alındı' denmez, bütçe acil kutusu basılır", async () => {
  const sahne = sahneKur("butce");
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI, "--canli"], {
      AEGIS_SAHTE_BUTCE: "uygula", // the raise really is applied
      AEGIS_SAHTE_DUSURME: "reddet", // the reversal does not hold → the +1 stays in the account
    });
    const durum = sahne.durumOku();

    assert.equal(durum.kampanya.butceMikro, (BASLANGIC_BUTCE + 1) * 1e6, "sahne kurgusu: artış hesapta kalmalıydı");
    const geriAlmalar = yazmalar(durum, "update_campaign_budget").filter((c) => c.butce === BASLANGIC_BUTCE);
    assert.ok(
      geriAlmalar.length >= 1,
      `Bütçe geri alma HİÇ denenmedi (çağrılar: ${JSON.stringify(durum.cagrilar)}).\nÇıktı:\n${r.cikti}`
    );
    assert.match(
      r.cikti,
      /BÜTÇE ARTIŞININ GERİ ALINDIĞI DOĞRULANAMADI/,
      `Bütçe acil kutusu basılmadı.\nÇıktı:\n${r.cikti}`
    );
    assert.doesNotMatch(
      r.cikti,
      /bütçe eski değerine döndürüldü/i,
      `Geri alma doğrulanmadan "döndürüldü" denmiş.\nÇıktı:\n${r.cikti}`
    );
    assert.equal(r.kod, 1, `Çıkış kodu 1 olmalıydı.\nÇıktı:\n${r.cikti}`);
  } finally {
    rmSync(sahne.kok, { recursive: true, force: true });
  }
});

/**
 * The interlock must bind BOTH flags to the exit code. The hidden --kendini-sina path calls the
 * VERY FUNCTION the run's finally calls; here it is exercised in a child process.
 */
test("--kendini-sina: hem bütçe hem yayın bayrağı acil kutusunu ve çıkış kodu 1'i üretir", async () => {
  const sahne = sahneKur("kendini-sina", { sunucuKur: false });
  try {
    const r = await kos(sahne.kok, ["--kendini-sina"]);
    assert.equal(r.kod, 1, `Kilit çıkış kodunu bozmalı.\nÇıktı:\n${r.cikti}`);
    assert.match(r.cikti, /GERİ ALMA DOĞRULANAMADI — KAMPANYA HÂLÂ YAYINDA OLABİLİR/);
    assert.match(r.cikti, /BÜTÇE ARTIŞININ GERİ ALINDIĞI DOĞRULANAMADI/);
    assert.match(r.cikti, /3\/3/, `Bütçe bayrağı ayrı ayrı sınanmalı.\nÇıktı:\n${r.cikti}`);
  } finally {
    rmSync(sahne.kok, { recursive: true, force: true });
  }
});

/* ── FINDING 4 (high) — --kampanya is neither trimmed nor ignored in silence ───── */

/**
 * The "no silent trimming or repair" contract. `replace(/\D/g, "")` turned "223-344-55" into
 * 22334455 — a DIFFERENT campaign id — while a value containing letters became "" and then, via
 * `|| undefined`, "the flag was never given", which drops the run into the AUTOMATIC pick. The
 * --kampanya=<id> spelling was never seen by indexOf at all.
 *
 * dist/ is deliberately ABSENT: the validation has to speak BEFORE a server is started and
 * before the account is read, so a run that dies on "no dist" never said the value was invalid.
 */
for (const [ad, deger] of [
  ["kesikli", "223-344-55"],
  ["harfli", "demo-test"],
  ["esitli-harfli", "--kampanya=demo-test"],
]) {
  test(`--kampanya geçersiz değeri (${ad}) sessizce düzeltilmez, hata verir`, async () => {
    const sahne = sahneKur(`arg-${ad}`, { sunucuKur: false });
    try {
      const argumanlar = deger.startsWith("--kampanya=")
        ? ["--musteri", MUSTERI, deger]
        : ["--musteri", MUSTERI, "--kampanya", deger];
      const r = await kos(sahne.kok, argumanlar);
      assert.equal(r.kod, 1, `Geçersiz kimlik hata vermeli.\nÇıktı:\n${r.cikti}`);
      assert.match(r.cikti, /Geçersiz --kampanya değeri/, `Sessizce yutuldu.\nÇıktı:\n${r.cikti}`);
      assert.doesNotMatch(r.cikti, /dist\/index\.js bulunamadı/, "doğrulama dist kontrolünden ÖNCE olmalı");
    } finally {
      rmSync(sahne.kok, { recursive: true, force: true });
    }
  });
}

/**
 * `--kampanya=<id>` is a valid spelling and must ACTUALLY BE USED. "It did not error" proves
 * nothing: a silently ignored flag does not error either — the run just slides into the
 * AUTOMATIC pick, which is the real damage in this finding. So the id given here does NOT exist
 * in the account: if the value was read, the script asks for it and reports "bulunamadı"; if it
 * was ignored, the scene carries on with the script's own pick.
 */
test("--kampanya=<id> biçimi yalnız tanınmakla kalmaz, o kampanya SORULUR", async () => {
  const sahne = sahneKur("arg-esitli-gecerli");
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI, "--kampanya=9999999"]);
    assert.doesNotMatch(r.cikti, /Geçersiz --kampanya değeri/, `Geçerli kimlik reddedildi.\nÇıktı:\n${r.cikti}`);
    assert.match(
      r.cikti,
      /Kampanya 9999999 bulunamadı/,
      `--kampanya=<id> sessizce yok sayıldı ve koşu otomatik aday seçimine düştü.\nÇıktı:\n${r.cikti}`
    );
    assert.equal(r.kod, 1, `Bulunamayan kampanya hata vermeli.\nÇıktı:\n${r.cikti}`);
  } finally {
    rmSync(sahne.kok, { recursive: true, force: true });
  }
});
