// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SECOND-ROUND REPAIR REGRESSIONS — scripts/demo-senaryo.mjs + scripts/prova.mjs
 *
 * The first repair round hardened Act 1 and Act 3/B. An independent review then found the
 * same class of hole still standing NEXT TO the repaired code. This file nails those down at
 * the level of BEHAVIOUR — the script is really run against a FAKE MCP server and what is
 * measured is "what happened in the account" and "which tool was actually called", never the
 * source text.
 *
 * The harness is the one from test/onarimDemoSenaryo.test.mjs (a temp project inside the repo
 * root so `@modelcontextprotocol/sdk` resolves), with three extra switches:
 *   AEGIS_SAHTE_PERDE2    : "ret" | "uygula"        — does the gate REGRESS in Act 2, i.e. is a
 *                                                     raise really applied on the "degisti"
 *                                                     channel
 *   AEGIS_SAHTE_GERIOKUMA : "" | "null" | "bos" | "hata"
 *                                                   — what the budget READ-BACK query answers:
 *                                                     the real value, null, "", or an error
 *
 * Three findings, three measurements:
 *   1) Act 2 is the twin of the repaired Act 3/B: it really calls update_campaign_budget in
 *      dry mode too, and its only protection is the gate refusing. It must arm the interlock
 *      BEFORE the call, READ THE BUDGET BACK from the account afterwards, revert what it finds
 *      raised, and shout when the reversal cannot be verified — and it must not start a new
 *      money-spending write at all while Act 1's raise is still unreverted.
 *   2) scripts/prova.mjs must not silently repair --kampanya: `223-344-55` may not become
 *      22334455 (a DIFFERENT campaign), and `--kampanya=<id>` may not be silently ignored.
 *   3) "Unknown is not 0": a budget whose amount_micros comes back null or "" is UNREADABLE,
 *      not zero. Number(null) === 0 turned an unreadable budget into a false accusation on
 *      stage.
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
const PERDE2 = process.env.AEGIS_SAHTE_PERDE2 || "ret";
const YAYIN = process.env.AEGIS_SAHTE_YAYIN || "ret";
const DUSURME = process.env.AEGIS_SAHTE_DUSURME || "uygula";
const GERIOKUMA = process.env.AEGIS_SAHTE_GERIOKUMA || "";
const PENCERE = process.env.AEGIS_SIMSWAP_WINDOW_HOURS || "72";
const RET =
  "AĞ DOĞRULAMASI BAŞARISIZ — işlem uygulanmadı.\n" +
  "• Ağ doğrulaması [SİMÜLASYON]: SIM değişimi bildirildi (son " + PENCERE + " saat, onaylayıcı hattı).";

const oku = () => JSON.parse(readFileSync(DOSYA, "utf8"));
const durumYaz = (d) => writeFileSync(DOSYA, JSON.stringify(d, null, 2));
const gonder = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const sonuc = (id, r) => gonder({ jsonrpc: "2.0", id, result: r });
const metin = (id, t, hata) => sonuc(id, { content: [{ type: "text", text: t }], isError: Boolean(hata) });

// The budget-only query is the READ-BACK; the one that also selects campaign.name is the
// candidate read every act starts with.
const geriOkumaMi = (s) => /amount_micros/.test(s) && !/campaign\.name/.test(s);

function gaql(sorgu, d) {
  const k = d.kampanya;
  if (/ad_group_ad/.test(sorgu)) return [{ campaign: { id: k.id }, ad_group_ad: { ad: { id: "9001" } } }];
  // The account holds ONE campaign: a query that explicitly names another id returns nothing.
  const suzgec = sorgu.match(/campaign\.id\s*=\s*(\d+)/);
  if (suzgec && suzgec[1] !== String(k.id)) return [];
  if (/campaign\.name/.test(sorgu)) {
    return [{ campaign: { id: k.id, name: k.ad, status: k.durum }, campaign_budget: { amount_micros: k.butceMikro } }];
  }
  if (/amount_micros/.test(sorgu)) {
    const mikro = GERIOKUMA === "null" ? null : GERIOKUMA === "bos" ? "" : k.butceMikro;
    return [{ campaign: { id: k.id }, campaign_budget: { amount_micros: mikro } }];
  }
  return [{ campaign: { id: k.id, status: k.durum } }];
}

function aracCagrisi(id, p) {
  const ad = p.name;
  const arg = p.arguments || {};
  const d = oku();

  if (ad === "run_gaql") {
    const sorgu = String(arg.query || "");
    if (GERIOKUMA === "hata" && geriOkumaMi(sorgu)) {
      return metin(id, "Sorgu başarısız (sahte geri okuma hatası).", true);
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
    const uygulanir = SIM === "degisti" ? PERDE2 === "uygula" : BUTCE === "uygula";
    if (yeni < suanki) {
      // A decrease is the REVERSAL path; it needs no approval.
      if (DUSURME === "reddet") cevap = { t: "Bütçe düşürülemedi (sahte hata).", hata: true };
      else {
        d.kampanya.butceMikro = Math.round(yeni * 1e6);
        cevap = { t: "Kampanya bütçesi güncellendi: " + yeni, hata: false };
      }
    } else if (!uygulanir) {
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

/** The temp fake project: the script under test + a fake dist/index.js + a state file. */
function sahneKur(ad, { durum = 3, butce = BASLANGIC_BUTCE, sunucuKur = true, prova = false } = {}) {
  const kok = join(KOK, `.tmp-onarim2-demo-${ad}-${process.pid}`);
  rmSync(kok, { recursive: true, force: true });
  mkdirSync(join(kok, "scripts"), { recursive: true });
  mkdirSync(join(kok, "dist"), { recursive: true });
  cpSync(join(KOK, "scripts", "demo-senaryo.mjs"), join(kok, "scripts", "demo-senaryo.mjs"));
  if (prova) {
    // The rehearsal is copied WITH its rule module: run from the temp root it finds no .env
    // and no dist there, so the CLI contract is what gets measured, nothing else.
    cpSync(join(KOK, "scripts", "prova.mjs"), join(kok, "scripts", "prova.mjs"));
    cpSync(join(KOK, "scripts", "onucusKurallari.mjs"), join(kok, "scripts", "onucusKurallari.mjs"));
  }
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
 * Runs a script from the temp root. The environment is pinned ON PURPOSE: AEGIS_ variables in
 * the developer's shell (window hours, the NV simulation, a real token) must not reshape the
 * scene.
 */
function kos(kok, betik, argumanlar, ek = {}, zamanAsimiMs = 120_000) {
  return new Promise((coz) => {
    const p = spawn(process.execPath, [join(kok, "scripts", betik), ...argumanlar], {
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
        AEGIS_SAHTE_PERDE2: "ret",
        AEGIS_SAHTE_YAYIN: "ret",
        AEGIS_SAHTE_DUSURME: "uygula",
        AEGIS_SAHTE_GERIOKUMA: "",
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

const yazmalar = (durum, arac, sim) =>
  durum.cagrilar.filter((c) => c.arac === arac && (sim === undefined || c.sim === sim));

/* ── FINDING 1 (high) — Act 2 is a money write too: read back, revert, shout ───── */

/**
 * Act 2 REALLY CALLS update_campaign_budget, in dry mode as well: its entire safety rests on
 * the network gate refusing. Here the gate REGRESSES (AEGIS_SAHTE_PERDE2=uygula) and the +1
 * really lands in the account. The act may not end in a bare "DEMO HATASI" with the money left
 * standing: the budget has to be READ BACK and pushed down again BEFORE anything throws.
 */
test("Perde 2: ağ kapısı reddetmezse artış hesaptan geri okunur ve geri alınır", async () => {
  const sahne = sahneKur("perde2-geri-al");
  try {
    const r = await kos(sahne.kok, "demo-senaryo.mjs", ["--musteri", MUSTERI], {
      AEGIS_SAHTE_PERDE2: "uygula", // the gate regression: the raise really is applied
      AEGIS_SAHTE_DUSURME: "uygula", // the reversal holds → the account must end up clean
    });
    const durum = sahne.durumOku();

    const geriAlmalar = yazmalar(durum, "update_campaign_budget", "degisti").filter(
      (c) => c.butce === BASLANGIC_BUTCE
    );
    assert.ok(
      geriAlmalar.length >= 1,
      `Perde 2 artışı uygulandı ama geri alma HİÇ denenmedi (çağrılar: ${JSON.stringify(durum.cagrilar)}).\nÇıktı:\n${r.cikti}`
    );
    assert.equal(
      durum.kampanya.butceMikro,
      BASLANGIC_BUTCE * 1e6,
      `Günlük bütçe hesapta yüksek kaldı (${durum.kampanya.butceMikro / 1e6}).\nÇıktı:\n${r.cikti}`
    );
    assert.equal(r.kod, 1, `Kapı reddetmediyse koşu hata ile bitmeli.\nÇıktı:\n${r.cikti}`);
  } finally {
    rmSync(sahne.kok, { recursive: true, force: true });
  }
});

/**
 * The same regression, but now the reversal does not hold either: the +1 stays in the account.
 * A bare "DEMO HATASI" is not enough — the interlock must fire, with the red emergency box, the
 * manual-fix instruction and exit code 1, exactly as Act 1 and Act 3/B already do.
 */
test("Perde 2: geri alma doğrulanamazsa bütçe acil kutusu basılır ve çıkış kodu 1 olur", async () => {
  const sahne = sahneKur("perde2-bagir");
  try {
    const r = await kos(sahne.kok, "demo-senaryo.mjs", ["--musteri", MUSTERI], {
      AEGIS_SAHTE_PERDE2: "uygula",
      AEGIS_SAHTE_DUSURME: "reddet", // the reversal does not hold → the interlock must fire
    });
    const durum = sahne.durumOku();

    assert.equal(
      durum.kampanya.butceMikro,
      (BASLANGIC_BUTCE + 1) * 1e6,
      "sahne kurgusu: artış hesapta kalmalıydı"
    );
    assert.match(
      r.cikti,
      /BÜTÇE ARTIŞININ GERİ ALINDIĞI DOĞRULANAMADI/,
      `Bütçe acil kutusu basılmadı — bütçe yüksek kalmış olabilir.\nÇıktı:\n${r.cikti}`
    );
    assert.match(r.cikti, /ŞİMDİ ELLE DÜŞÜR/, `Elle müdahale talimatı yok.\nÇıktı:\n${r.cikti}`);
    assert.equal(r.kod, 1, `Çıkış kodu 1 olmalıydı.\nÇıktı:\n${r.cikti}`);
  } finally {
    rmSync(sahne.kok, { recursive: true, force: true });
  }
});

/**
 * "No new money-spending write is started while an earlier one is still unreverted" — the rule
 * Act 3/A already follows. Act 1's raise lands and cannot be reverted (the read-back errors, so
 * the flag stays up fail-closed); from that moment on NOTHING may be written any more. Act 2
 * used to re-read the RAISED budget and try +1 on top of it.
 */
test("Perde 1'in artışı geri alınamamışken Perde 2 ve 3/B yeni yazma DENEMEZ", async () => {
  const sahne = sahneKur("perde1-kilitli");
  try {
    const r = await kos(sahne.kok, "demo-senaryo.mjs", ["--musteri", MUSTERI, "--canli"], {
      AEGIS_SAHTE_BUTCE: "uygula", // Act 1's raise really lands
      AEGIS_SAHTE_GERIOKUMA: "hata", // and cannot be verified back → the flag stays up
      AEGIS_SAHTE_DUSURME: "reddet",
    });
    const durum = sahne.durumOku();

    assert.deepEqual(
      yazmalar(durum, "update_campaign_budget", "degisti"),
      [],
      `Perde 1'in artışı geri alınamamışken Perde 2 yeni bir bütçe yazması denedi.\nÇıktı:\n${r.cikti}`
    );
    assert.deepEqual(
      yazmalar(durum, "set_campaign_status", "degisti"),
      [],
      `Perde 1'in artışı geri alınamamışken Perde 3/B yazma denedi.\nÇıktı:\n${r.cikti}`
    );
    assert.match(
      r.cikti,
      /Perde 2 atlandı/,
      `Atlama gerekçesi ekranda söylenmedi.\nÇıktı:\n${r.cikti}`
    );
    assert.equal(r.kod, 1, `Geri alınamayan artış çıkış kodunu bozmalı.\nÇıktı:\n${r.cikti}`);
  } finally {
    rmSync(sahne.kok, { recursive: true, force: true });
  }
});

/**
 * The other side of the same coin: the new "skip while a raise is standing" branch may not
 * swallow Act 2 on a HEALTHY run. Nothing is stuck here, the gate refuses as it should, so all
 * three acts play, the account is untouched and the run ends with 0 — no emergency box.
 */
test("Sağlıklı kuru koşu: Perde 2 atlanmaz, hesap değişmez, çıkış kodu 0", async () => {
  const sahne = sahneKur("saglikli-kuru");
  try {
    const r = await kos(sahne.kok, "demo-senaryo.mjs", ["--musteri", MUSTERI]);
    const durum = sahne.durumOku();

    assert.doesNotMatch(r.cikti, /Perde 2 atlandı/, `Sağlıklı koşuda Perde 2 atlandı.\nÇıktı:\n${r.cikti}`);
    assert.match(r.cikti, /RET — AĞ DOĞRULAMASI BAŞARISIZ/, `Perde 2'nin sert reddi ekranda yok.\nÇıktı:\n${r.cikti}`);
    assert.doesNotMatch(r.cikti, /ELLE MÜDAHALE GEREKİYOR/, `Sebepsiz acil kutusu basıldı.\nÇıktı:\n${r.cikti}`);
    assert.equal(
      durum.kampanya.butceMikro,
      BASLANGIC_BUTCE * 1e6,
      `Kapı reddederken hesapta bütçe değişti.\nÇıktı:\n${r.cikti}`
    );
    assert.equal(durum.kampanya.durum, 3, `Kampanya PAUSED kalmalıydı.\nÇıktı:\n${r.cikti}`);
    assert.equal(r.kod, 0, `Sağlıklı kuru koşu 0 ile bitmeli.\nÇıktı:\n${r.cikti}`);
  } finally {
    rmSync(sahne.kok, { recursive: true, force: true });
  }
});

/* ── FINDING 3 (medium) — "unknown is not 0" in the budget read-back ───────────── */

/**
 * `Number(satir?.campaign_budget?.amount_micros) / 1e6` reads null and "" as 0. A budget that
 * could NOT be read then looks like a REAL, different value: the script accuses the server of
 * a write nobody made ("operatör onay vermedi ama günlük bütçe 25 yerine 0 okundu") and ends
 * the show with a fabricated breach. Unknown is not 0 — it is unknown.
 */
for (const [ad, geriOkuma] of [
  ["null", "null"],
  ["boş dize", "bos"],
]) {
  test(`Okunamayan bütçe (${ad}) 0 sayılmaz: sahte "GÜVENLİK İHLALİ" suçlaması üretilmez`, async () => {
    const sahne = sahneKur(`butce-okunamaz-${geriOkuma}`);
    try {
      const r = await kos(sahne.kok, "demo-senaryo.mjs", ["--musteri", MUSTERI, "--canli"], {
        AEGIS_SAHTE_BUTCE: "ret", // no write is applied at all: the gate refuses the raise
        AEGIS_SAHTE_GERIOKUMA: geriOkuma, // but the read-back cannot be read
      });
      const durum = sahne.durumOku();

      assert.equal(
        durum.kampanya.butceMikro,
        BASLANGIC_BUTCE * 1e6,
        "sahne kurgusu: hiçbir artış uygulanmamalıydı"
      );
      assert.doesNotMatch(
        r.cikti,
        /yerine 0 okundu/,
        `Okunamayan bütçe 0 sayıldı ve sahte bir ihlal suçlaması üretildi.\nÇıktı:\n${r.cikti}`
      );
      assert.doesNotMatch(
        r.cikti,
        /hâlâ 0 \(beklenen/,
        `Okunamayan bütçe ekranda "0" diye raporlandı.\nÇıktı:\n${r.cikti}`
      );
      assert.match(
        r.cikti,
        /okunamadı/,
        `Okunamayan bütçe dürüstçe "okunamadı" diye anılmalı.\nÇıktı:\n${r.cikti}`
      );
    } finally {
      rmSync(sahne.kok, { recursive: true, force: true });
    }
  });
}

/* ── FINDING 2 (medium) — prova.mjs must not repair --kampanya in silence ──────── */

/**
 * The rehearsal is the wrapper the operator is told to run BEFORE the stage, and it passes
 * --kampanya on to the demo as a separate argument. `replace(/\D/g, "")` turned "223-344-55"
 * into 22334455 — a DIFFERENT campaign — and the demo's own digits-only gate then saw nothing
 * but digits and waved it through. The gate never fired on this path because the invalid value
 * was made to look valid before it got there.
 */
test("prova: --kampanya sessizce rakamlara kırpılmaz, hata verir", async () => {
  const sahne = sahneKur("prova-kirpma", { sunucuKur: false, prova: true });
  try {
    const r = await kos(sahne.kok, "prova.mjs", ["--musteri", MUSTERI, "--kampanya", "223-344-55"], {}, 60_000);
    assert.match(r.cikti, /Geçersiz --kampanya değeri/, `Sessizce düzeltildi.\nÇıktı:\n${r.cikti}`);
    assert.doesNotMatch(r.cikti, /22334455/, `Kırpılmış kimlik üretildi.\nÇıktı:\n${r.cikti}`);
    assert.equal(r.kod, 1, `Geçersiz kimlik hata vermeli.\nÇıktı:\n${r.cikti}`);
  } finally {
    rmSync(sahne.kok, { recursive: true, force: true });
  }
});

/**
 * The `--kampanya=<id>` spelling used to be invisible to the rehearsal's indexOf: the flag
 * counted as ABSENT, the demo ran with no campaign at all and the report said "everything is
 * fine" for a scene the operator never named. An invalid value in that spelling has to be seen
 * and refused, not skipped over.
 */
test("prova: --kampanya=<id> biçimi görülür, geçersizse reddedilir", async () => {
  const sahne = sahneKur("prova-esitli", { sunucuKur: false, prova: true });
  try {
    const r = await kos(sahne.kok, "prova.mjs", ["--musteri", MUSTERI, "--kampanya=demo-test"], {}, 60_000);
    assert.match(
      r.cikti,
      /Geçersiz --kampanya değeri/,
      `"=" biçimi sessizce yok sayıldı.\nÇıktı:\n${r.cikti}`
    );
    assert.equal(r.kod, 1, `Geçersiz kimlik hata vermeli.\nÇıktı:\n${r.cikti}`);
  } finally {
    rmSync(sahne.kok, { recursive: true, force: true });
  }
});
