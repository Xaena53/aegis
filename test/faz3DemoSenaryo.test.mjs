// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PHASE-3 REGRESSION — scripts/demo-senaryo.mjs, the Act 3/B status READ-BACK
 *
 * Act 3/B really calls set_campaign_status(ENABLED) — in dry mode too, because there the
 * NETWORK GATE is what refuses. "Expected to refuse" is not "verified", so the act reads the
 * campaign's status BACK from the account afterwards. What this file measures is what happens
 * when that read-back FAILS, i.e. when nothing at all was measured:
 *
 *   1) On the candidate the act OWNS (PAUSED before the run, so 3/B armed the interlock
 *      itself) an unreadable status must count as LIVE: the reversal is attempted and, when
 *      it cannot be verified either, the red emergency box fires and the exit code is 1.
 *      Fail-closed — "unknown" is not "nothing happened".
 *   2) On the one candidate it does NOT own — a campaign already ENABLED before the run,
 *      reachable only through --kampanya — no reversal is owed (we do not pause someone
 *      else's live campaign) and the interlock rightly stays down. But no CLAIM is owed
 *      either: "yazma yapılmadı" is a MEASUREMENT, and a status that could not be read
 *      measured nothing. The screen and the summary table must say DOĞRULANAMADI.
 *   3) And when the read-back does answer, the honest claim must still be made — so this file
 *      cannot be satisfied by a script that simply never says "yazma yapılmadı". Cases 2 and
 *      3 pull in opposite directions on purpose: each is the other's mutation.
 *
 * What is measured is BEHAVIOUR: the script is really run against a FAKE MCP server, and the
 * questions are "what did it write to the account", "what did it claim on stage" and "what
 * exit code did it leave". No source text is read.
 *
 * The harness is the one from test/onarim2DemoSenaryo.test.mjs (a temp project inside the repo
 * root so `@modelcontextprotocol/sdk` resolves), with one extra switch:
 *   AEGIS_SAHTE_DURUMOKUMA : "" | "hata" — does the STATUS read-back query answer, or fail
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
const TAVAN = 1000;

/**
 * THE FAKE MCP SERVER (the temp project's dist/index.js), plain JSON-RPC over stdio.
 *
 * Written with String.raw so backslash escapes reach the child VERBATIM — which is why the
 * child source below uses no backticks and no ${...}. The switches MUST carry the AEGIS_
 * prefix: the demo script forwards only GOOGLE_ADS_/AEGIS_ variables into the server process.
 */
const SAHTE_SUNUCU = String.raw`
import { readFileSync, writeFileSync } from "node:fs";

const DOSYA = process.env.AEGIS_SAHTE_DURUM;
const SIM = process.env.AEGIS_NAC_SIMULATE || "";
const BUTCE = process.env.AEGIS_SAHTE_BUTCE || "ret";
const YAYIN = process.env.AEGIS_SAHTE_YAYIN || "ret";
const DUSURME = process.env.AEGIS_SAHTE_DUSURME || "uygula";
const DURUMOKUMA = process.env.AEGIS_SAHTE_DURUMOKUMA || "";
const TAVAN = Number(process.env.AEGIS_SAHTE_TAVAN || "1000");
const PENCERE = process.env.AEGIS_SIMSWAP_WINDOW_HOURS || "72";
const RET =
  "Reddedildi: AĞ DOĞRULAMASI BAŞARISIZ — işlem uygulanmadı.\n" +
  "• Ağ doğrulaması [SİMÜLASYON]: SIM değişimi bildirildi (son " + PENCERE + " saat, onaylayıcı hattı).";

const oku = () => JSON.parse(readFileSync(DOSYA, "utf8"));
const durumYaz = (d) => writeFileSync(DOSYA, JSON.stringify(d, null, 2));
const gonder = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const sonuc = (id, r) => gonder({ jsonrpc: "2.0", id, result: r });
const metin = (id, t, hata) => sonuc(id, { content: [{ type: "text", text: t }], isError: Boolean(hata) });

// THE STATUS READ-BACK is the query asking for campaign.status with neither the candidate's
// name nor a budget beside it: exactly the one Act 3/B fires after its call, and the one
// duraklatVeDogrula uses to verify a reversal.
const durumOkumasiMi = (s) =>
  /campaign\.status/.test(s) && !/campaign\.name/.test(s) && !/amount_micros/.test(s);

function gaql(sorgu, d) {
  const k = d.kampanya;
  const suzgec = sorgu.match(/campaign\.id\s*=\s*(\d+)/);
  if (suzgec && suzgec[1] !== String(k.id)) return [];
  if (/ad_group_ad/.test(sorgu)) return [{ campaign: { id: k.id }, ad_group_ad: { ad: { id: "9001" } } }];
  if (/campaign\.name/.test(sorgu)) {
    return [
      {
        campaign: { id: k.id, name: k.ad, status: k.durum },
        campaign_budget: { amount_micros: k.butceMikro, explicitly_shared: false },
      },
    ];
  }
  if (/amount_micros/.test(sorgu)) {
    return [{ campaign: { id: k.id }, campaign_budget: { amount_micros: k.butceMikro } }];
  }
  return [{ campaign: { id: k.id, status: k.durum } }];
}

function aracCagrisi(id, p) {
  const ad = p.name;
  const arg = p.arguments || {};
  const d = oku();

  if (ad === "run_gaql") {
    const sorgu = String(arg.query || "");
    if (DURUMOKUMA === "hata" && durumOkumasiMi(sorgu)) {
      return metin(id, "Sorgu başarısız (sahte durum okuma hatası).", true);
    }
    const satirlar = gaql(sorgu, d);
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
    if (yeni > TAVAN) {
      cevap = { t: "Reddedildi: istenen günlük bütçe hesabın güvenlik tavanının üzerinde.", hata: true };
    } else if (yeni < suanki) {
      // A decrease is the REVERSAL path; it needs no approval.
      if (DUSURME === "reddet") cevap = { t: "Bütçe düşürülemedi (sahte hata).", hata: true };
      else {
        d.kampanya.butceMikro = Math.round(yeni * 1e6);
        cevap = { t: "Kampanya bütçesi güncellendi: " + yeni, hata: false };
      }
    } else if (BUTCE !== "uygula") {
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
          text: JSON.stringify({ gunlukButceTavani: TAVAN }),
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

/** The temp fake project: the script under test + a fake dist/index.js + a state file. */
function sahneKur(ad, { durum = 3, butce = BASLANGIC_BUTCE } = {}) {
  const kok = join(KOK, `.tmp-faz3-demo-${ad}-${process.pid}`);
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
  writeFileSync(join(kok, "dist", "index.js"), SAHTE_SUNUCU);
  return { kok, durumOku: () => JSON.parse(readFileSync(durumDosyasi, "utf8")) };
}

/**
 * Runs the script from the temp root. The environment is pinned ON PURPOSE: AEGIS_ variables
 * in the developer's shell (window hours, the NV simulation, a real token) must not reshape
 * the scene.
 */
function kos(kok, argumanlar, ek = {}, zamanAsimiMs = 180_000) {
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
        AEGIS_SAHTE_DURUMOKUMA: "",
        AEGIS_SAHTE_TAVAN: String(TAVAN),
        ...ek,
      },
    });
    let cikti = "";
    const bitir = setTimeout(() => p.kill("SIGKILL"), zamanAsimiMs);
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c) => (cikti += c));
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (c) => (cikti += c));
    p.on("exit", (kod) => {
      clearTimeout(bitir);
      coz({ kod, cikti });
    });
  });
}

/** Every line that claims, in ANY wording, that no write happened. */
const yazmaYokIddiasi = (cikti) => cikti.split("\n").filter((s) => /yazma yapılmadı\./.test(s));

/* ── 1) The act's OWN candidate: an unreadable status counts as LIVE ──────────── */

/**
 * The candidate was PAUSED, so 3/B armed the interlock before its call. The gate refuses, but
 * the status read-back then fails: NOTHING was measured. That may not become "yazma
 * yapılmadı" — the reversal has to be attempted and, since its verification read fails too,
 * the run must end with the red emergency box and exit code 1.
 */
test("Perde 3/B: durum geri okunamazsa yayında sayılır — geri alma denenir, kilit ateşlenir", async () => {
  const sahne = sahneKur("okunamaz-kapali");
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI], { AEGIS_SAHTE_DURUMOKUMA: "hata" });
    const durum = sahne.durumOku();

    const duraklatmalar = durum.cagrilar.filter(
      (c) => c.arac === "set_campaign_status" && c.status === "PAUSED"
    );
    assert.ok(
      duraklatmalar.length >= 1,
      `Durum okunamadığı hâlde geri alma HİÇ denenmedi (çağrılar: ${JSON.stringify(durum.cagrilar)}).\nÇıktı:\n${r.cikti}`
    );
    assert.match(
      r.cikti,
      /GERİ ALMA DOĞRULANAMADI — KAMPANYA HÂLÂ YAYINDA OLABİLİR/,
      `Acil kutusu basılmadı — okunamayan durum sessizce temize çıkarıldı.\nÇıktı:\n${r.cikti}`
    );
    assert.equal(r.kod, 1, `Çıkış kodu 1 olmalıydı.\nÇıktı:\n${r.cikti}`);
    assert.deepEqual(
      yazmaYokIddiasi(r.cikti).filter((s) => /okunamadı/.test(s)),
      [],
      `Ölçülemeyen durum için "yazma yapılmadı" iddiası basıldı.\nÇıktı:\n${r.cikti}`
    );
  } finally {
    rmSync(sahne.kok, { recursive: true, force: true });
  }
});

/* ── 2) A candidate that was ALREADY live: no reversal, but no claim either ───── */

/**
 * `--kampanya` may name a campaign that is already ENABLED. 3/B did not put it live, so it
 * neither arms the interlock nor pauses it — that part is right and must stay. What must NOT
 * happen is the screen and the summary table reporting an UNREADABLE status as "yazma
 * yapılmadı": that is a measurement nobody made.
 */
test("Perde 3/B: zaten ENABLED adayda okunamayan durum 'yazma yapılmadı' diye raporlanmaz", async () => {
  const sahne = sahneKur("okunamaz-zaten-yayinda", { durum: 2 });
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI, "--kampanya", KAMPANYA_ID], {
      AEGIS_SAHTE_DURUMOKUMA: "hata",
    });
    const durum = sahne.durumOku();

    assert.deepEqual(
      yazmaYokIddiasi(r.cikti).filter((s) => /okunamadı/.test(s)),
      [],
      `Ölçülemeyen durum "yazma yapılmadı" diye sunuldu.\nÇıktı:\n${r.cikti}`
    );
    assert.match(
      r.cikti,
      /yazma yapılmadığı DOĞRULANAMADI/,
      `Okunamayan durum için DOĞRULANAMADI ibaresi yok.\nÇıktı:\n${r.cikti}`
    );
    // The summary table's Yazma column must carry the same reservation, not a clean "yok".
    assert.ok(
      !/yok \(geri okundu: okunamadı/.test(r.cikti),
      `Özet tablosu ölçülmeyeni "yok (geri okundu: okunamadı ...)" diye kaydetti.\nÇıktı:\n${r.cikti}`
    );
    assert.match(
      r.cikti,
      /DOĞRULANAMADI \(okunamadı/,
      `Özet tablosunda DOĞRULANAMADI satırı yok.\nÇıktı:\n${r.cikti}`
    );
    // Someone else's live campaign is NOT paused: the act owns no reversal here.
    assert.deepEqual(
      durum.cagrilar.filter((c) => c.arac === "set_campaign_status" && c.status === "PAUSED"),
      [],
      `Zaten yayında olan kampanya duraklatıldı — bu perdenin işi değil.\nÇıktı:\n${r.cikti}`
    );
    assert.equal(durum.kampanya.durum, 2, "sahne kurgusu: kampanya ENABLED kalmalıydı");
  } finally {
    rmSync(sahne.kok, { recursive: true, force: true });
  }
});

/* ── 3) The other direction: a status that WAS read is claimed honestly ───────── */

/**
 * The counterweight to case 2. A script that simply never says "yazma yapılmadı" would pass
 * the two cases above while saying nothing true; here the read-back answers PAUSED and the
 * claim must actually be made, in the summary table too.
 */
test("Perde 3/B: durum okunabildiğinde 'yazma yapılmadı' iddiası GERÇEKTEN basılır", async () => {
  const sahne = sahneKur("okunabilir");
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI]);
    const durum = sahne.durumOku();

    assert.match(
      r.cikti,
      new RegExp(`Geri okuma: kampanya #${KAMPANYA_ID} durumu PAUSED — yazma yapılmadı\\.`),
      `Okunabilen durumda dürüst "yazma yapılmadı" iddiası basılmadı.\nÇıktı:\n${r.cikti}`
    );
    assert.match(
      r.cikti,
      /yok \(geri okundu: PAUSED\)/,
      `Özet tablosunda 3/B satırı "yok (geri okundu: PAUSED)" değil.\nÇıktı:\n${r.cikti}`
    );
    assert.ok(
      !/DOĞRULANAMADI/.test(r.cikti),
      `Okunabilen durumda DOĞRULANAMADI çekincesi basıldı.\nÇıktı:\n${r.cikti}`
    );
    assert.equal(durum.kampanya.durum, 3, "sahne kurgusu: kampanya PAUSED kalmalıydı");
    assert.equal(r.kod, 0, `Temiz koşu 0 ile bitmeliydi.\nÇıktı:\n${r.cikti}`);
  } finally {
    rmSync(sahne.kok, { recursive: true, force: true });
  }
});
