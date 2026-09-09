// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PHASE-1 REGRESSION — scripts/demo-senaryo.mjs, the Act 1/2 candidate
 *
 * Act 3 verifies IN ADVANCE, with read-only queries, that its candidate clears the gates
 * set_campaign_status applies BEFORE the network gate, and honestly skips the act when it
 * cannot. Acts 1 and 2 showed no such care: update_campaign_budget refuses a request over the
 * safety ceiling and one on a SHARED budget before ever reaching the approval prompt (and thus
 * before the network gate), and both refusals carry text other than "AĞ DOĞRULAMASI BAŞARISIZ".
 * Act 2 then threw "Perde 2 beklenen ağ retiyle bitmedi" — the demo dying mid-stage, with the
 * jury told nothing about why.
 *
 * What is measured here is BEHAVIOUR: the script is really run against a FAKE MCP server that
 * reproduces the real server's GATE ORDER (ceiling → sharedness → increase → network), and the
 * questions asked are "which campaign did it write to", "did it attempt a write at all" and
 * "what did it claim on stage". Source text is read for ONE purpose: keeping the refusal
 * fixtures and the classifier's own vocabulary tied to the sources that produce them, in BOTH
 * directions — reword a message in src/ and the tie breaks loudly, instead of these scenes
 * quietly rehearsing a refusal the server no longer writes.
 *
 * The harness is the one from test/onarim2DemoSenaryo.test.mjs (a temp project inside the repo
 * root so `@modelcontextprotocol/sdk` resolves), with a multi-campaign account whose budgets
 * carry `explicitly_shared`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const KOK = fileURLToPath(new URL("..", import.meta.url));
const MUSTERI = "1234567890";
const PAYLASIMLI_ID = "5550001";
const OZEL_ID = "5550002";

/**
 * THE FAKE MCP SERVER (the temp project's dist/index.js), plain JSON-RPC over stdio.
 *
 * Written with String.raw so backslash escapes reach the child VERBATIM — which is why the
 * child source below uses no backticks and no ${...}.
 *
 * update_campaign_budget answers IN THE REAL SERVER'S ORDER (src/tools/write.ts:415-459):
 *   1) the safety ceiling, 2) sharedness (an unreadable value is refused too), 3) is this an
 *   increase — and only there does the network gate speak. The first two refusals are the ones
 *   the demo used to mistake for a missing network refusal.
 */
const SAHTE_SUNUCU = String.raw`
import { readFileSync, writeFileSync } from "node:fs";

const DOSYA = process.env.AEGIS_SAHTE_DURUM;
const SIM = process.env.AEGIS_NAC_SIMULATE || "";
// A refusal forced AT THE NETWORK GATE'S OWN POSITION: after every pre-gate has passed, where
// the real server consults agDogrula. It is how a scene stages "the gate itself spoke".
const ZORLA_RET = process.env.AEGIS_SAHTE_AG_RET || "";
const PENCERE = process.env.AEGIS_SIMSWAP_WINDOW_HOURS || "72";
const RET =
  "Reddedildi: AĞ DOĞRULAMASI BAŞARISIZ — işlem uygulanmadı.\n" +
  "• Ağ doğrulaması [SİMÜLASYON]: SIM değişimi bildirildi (son " + PENCERE + " saat, onaylayıcı hattı).";

const oku = () => JSON.parse(readFileSync(DOSYA, "utf8"));
const durumYaz = (d) => writeFileSync(DOSYA, JSON.stringify(d, null, 2));
const gonder = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const sonuc = (id, r) => gonder({ jsonrpc: "2.0", id, result: r });
const metin = (id, t, hata) => sonuc(id, { content: [{ type: "text", text: t }], isError: Boolean(hata) });
const bul = (d, id) => d.kampanyalar.find((k) => String(k.id) === String(id));

// An "explicitly_shared" left out of the state file is left out of the ROW as well: the proto
// field is optional, and the demo must survive its absence.
function butceAlani(k, tam) {
  const alan = { amount_micros: k.butceMikro };
  if (tam && typeof k.paylasimli === "boolean") alan.explicitly_shared = k.paylasimli;
  return alan;
}

function gaql(sorgu, d) {
  let liste = d.kampanyalar;
  const suzgec = sorgu.match(/campaign\.id\s*=\s*(\d+)/);
  if (suzgec) liste = liste.filter((k) => String(k.id) === suzgec[1]);
  // The API applies the sharedness predicate itself when the query carries one.
  if (/explicitly_shared\s*=\s*false/i.test(sorgu)) liste = liste.filter((k) => k.paylasimli === false);
  if (/ad_group_ad/.test(sorgu)) return liste.map((k) => ({ campaign: { id: k.id }, ad_group_ad: { ad: { id: "9001" } } }));
  if (/campaign\.name/.test(sorgu)) {
    return liste.map((k) => ({
      campaign: { id: k.id, name: k.ad, status: k.durum },
      campaign_budget: butceAlani(k, true),
    }));
  }
  if (/amount_micros/.test(sorgu)) {
    return liste.map((k) => ({ campaign: { id: k.id }, campaign_budget: butceAlani(k, false) }));
  }
  return liste.map((k) => ({ campaign: { id: k.id, status: k.durum } }));
}

function butceAraci(id, arg, d) {
  const k = bul(d, arg.campaignId);
  if (!k) return metin(id, "Kampanya bulunamadı: " + arg.campaignId, true);
  const yeni = Number(arg.newDailyBudget);
  const tavan = Number(d.tavan);
  if (yeni > tavan) {
    return metin(
      id,
      "Reddedildi: istenen günlük bütçe (" + yeni + ") hesabın güvenlik tavanının (" + tavan +
        ") üzerinde. Tavanı yalnızca hesap sahibi yükseltebilir.",
      true
    );
  }
  if (typeof k.paylasimli !== "boolean") {
    return metin(
      id,
      "Reddedildi: \"" + k.ad + "\" kampanyasının bütçesi PAYLAŞIMLI mi, kampanyaya özel mi OKUNAMADI.",
      true
    );
  }
  if (k.paylasimli) {
    return metin(
      id,
      "Reddedildi: \"" + k.ad + "\" PAYLAŞIMLI bir bütçe kullanıyor — değişiklik bu bütçeyi kullanan TÜM kampanyaları etkiler.",
      true
    );
  }
  const suanki = k.butceMikro / 1e6;
  if (yeni > suanki && ZORLA_RET) return metin(id, ZORLA_RET, true);
  if (yeni > suanki && SIM === "degisti") return metin(id, RET, true);
  k.butceMikro = Math.round(yeni * 1e6);
  durumYaz(d);
  return metin(id, "\"" + k.ad + "\" bütçesi güncellendi: " + suanki + " → " + yeni + " (günlük).", false);
}

function durumAraci(id, arg, d) {
  const k = bul(d, arg.campaignId);
  if (!k) return metin(id, "Kampanya bulunamadı: " + arg.campaignId, true);
  const istenen = String(arg.status || "");
  if (istenen === "ENABLED" && SIM === "degisti") return metin(id, RET, true);
  k.durum = istenen === "ENABLED" ? 2 : 3;
  durumYaz(d);
  return metin(id, "Kampanya durumu güncellendi: " + istenen, false);
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
    kampanyaId: arg.campaignId === undefined ? null : String(arg.campaignId),
    status: arg.status === undefined ? null : String(arg.status),
    butce: arg.newDailyBudget === undefined ? null : Number(arg.newDailyBudget),
  });
  durumYaz(d);

  if (ad === "update_campaign_budget") return butceAraci(id, arg, oku());
  if (ad === "set_campaign_status") return durumAraci(id, arg, oku());
  return metin(id, "bilinmeyen araç: " + ad, true);
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
          text: JSON.stringify({ gunlukButceTavani: oku().tavan }),
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
function sahneKur(ad, { kampanyalar, tavan = 1000 }) {
  const kok = join(KOK, `.tmp-faz1-aday-${ad}-${process.pid}`);
  rmSync(kok, { recursive: true, force: true });
  mkdirSync(join(kok, "scripts"), { recursive: true });
  mkdirSync(join(kok, "dist"), { recursive: true });
  cpSync(join(KOK, "scripts", "demo-senaryo.mjs"), join(kok, "scripts", "demo-senaryo.mjs"));
  const durumDosyasi = join(kok, "durum.json");
  writeFileSync(durumDosyasi, JSON.stringify({ tavan, kampanyalar, cagrilar: [] }, null, 2));
  writeFileSync(join(kok, "dist", "index.js"), SAHTE_SUNUCU);
  return {
    kok,
    durumOku: () => JSON.parse(readFileSync(durumDosyasi, "utf8")),
    temizle: () => rmSync(kok, { recursive: true, force: true }),
  };
}

/**
 * Runs the demo from the temp root. The environment is pinned ON PURPOSE: AEGIS_ variables in
 * the developer's shell (window hours, the NV simulation, a real token) must not reshape the
 * scene.
 */
function kos(kok, argumanlar, ekEnv = {}, zamanAsimiMs = 120_000) {
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
        ...ekEnv,
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

const butceYazmalari = (durum) => durum.cagrilar.filter((c) => c.arac === "update_campaign_budget");

/**
 * One act's row from the closing summary table ("│ 2 │ bütçe +1 … │ degisti │ … │").
 *
 * The claim has to be read PER ACT: Act 3/B ends with a real network refusal in every scene
 * here, so searching the whole output for "RET (ağ doğrulaması başarısız)" would find 3/B's
 * honest row and say nothing about what Act 2 claimed.
 */
function ozetSatiri(cikti, perde) {
  const satir = cikti.split("\n").find((s) => new RegExp(`^│ ${perde}\\s`).test(s));
  assert.ok(satir, `özet tablosunda "${perde}" perdesinin satırı yok:\n${cikti}`);
  return satir;
}

const paylasimliKampanya = {
  id: PAYLASIMLI_ID,
  ad: "TEST — paylaşımlı bütçeli",
  durum: 3,
  butceMikro: 10 * 1e6,
  paylasimli: true,
};
const ozelKampanya = {
  id: OZEL_ID,
  ad: "TEST — kampanyaya özel bütçeli",
  durum: 3,
  butceMikro: 25 * 1e6,
  paylasimli: false,
};

/* ── 1) The automatic pick may not choose a campaign the pre-gates will refuse ──── */

/**
 * The old sort took "PAUSED first, then the smallest budget" and stopped there, so the
 * cheapest campaign won even when its budget was SHARED — and a shared budget is refused by
 * update_campaign_budget before the network gate is ever consulted.
 */
test("Perde 1/2 adayı: paylaşımlı bütçeli kampanya SEÇİLMEZ, kampanyaya özel olan seçilir", async () => {
  const sahne = sahneKur("aday-secimi", { kampanyalar: [paylasimliKampanya, ozelKampanya] });
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI]);
    const yazmalar = butceYazmalari(sahne.durumOku());

    assert.equal(r.kod, 0, `demo sıfır olmayan kodla bitti (${r.kod}):\n${r.cikti}`);
    assert.ok(yazmalar.length > 0, `Perde 2 bütçe aracını hiç çağırmadı:\n${r.cikti}`);
    assert.deepEqual(
      [...new Set(yazmalar.map((c) => c.kampanyaId))],
      [OZEL_ID],
      `paylaşımlı bütçeli kampanyaya yazma denendi:\n${JSON.stringify(yazmalar)}`
    );
    assert.match(
      ozetSatiri(r.cikti, "2"),
      /RET \(ağ doğrulaması başarısız\)/,
      `Perde 2 ağ retini gösteremedi:\n${r.cikti}`
    );
  } finally {
    sahne.temizle();
  }
});

/* ── 2) A named shared campaign: honest skip, not a stage crash ─────────────────── */

test("--kampanya paylaşımlı bütçeliyse Perde 1/2 dürüstçe atlanır, yazma HİÇ denenmez", async () => {
  const sahne = sahneKur("adlandirilmis-paylasimli", { kampanyalar: [paylasimliKampanya] });
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI, "--kampanya", PAYLASIMLI_ID]);
    const durum = sahne.durumOku();

    assert.equal(r.kod, 0, `demo sıfır olmayan kodla bitti (${r.kod}):\n${r.cikti}`);
    assert.deepEqual(
      butceYazmalari(durum),
      [],
      `ön kapıya takılacağı bilinen kampanyaya yazma denendi:\n${JSON.stringify(durum.cagrilar)}`
    );
    for (const perde of ["1", "2"]) {
      assert.doesNotMatch(
        ozetSatiri(r.cikti, perde),
        /RET \(ağ doğrulaması başarısız\)/,
        `ağ kapısı hiç konuşmadığı hâlde Perde ${perde} ağ reti iddia etti:\n${r.cikti}`
      );
      assert.match(ozetSatiri(r.cikti, perde), /atlandı/, `Perde ${perde} atlandığını söylemiyor:\n${r.cikti}`);
    }
    assert.match(
      r.cikti,
      /PAYLAŞIMLI bir bütçe kullanıyor/,
      `atlama gerekçesi (paylaşımlı bütçe) ekranda yok:\n${r.cikti}`
    );
  } finally {
    sahne.temizle();
  }
});

/* ── 3) The ceiling: budget + 1 above the cap is refused before the network gate ── */

test("Tavana dayanmış bütçede Perde 1/2 dürüstçe atlanır, demo çakılmaz", async () => {
  // The ceiling equals the campaign's budget: the demo's own +1 would trip budgetGuard.
  const sahne = sahneKur("tavan", { kampanyalar: [ozelKampanya], tavan: 25 });
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI]);
    const durum = sahne.durumOku();

    assert.equal(r.kod, 0, `demo sıfır olmayan kodla bitti (${r.kod}):\n${r.cikti}`);
    assert.deepEqual(
      butceYazmalari(durum),
      [],
      `tavanı aşacağı bilinen artış yine de denendi:\n${JSON.stringify(durum.cagrilar)}`
    );
    for (const perde of ["1", "2"]) {
      assert.doesNotMatch(
        ozetSatiri(r.cikti, perde),
        /RET \(ağ doğrulaması başarısız\)/,
        `ağ kapısı hiç konuşmadığı hâlde Perde ${perde} ağ reti iddia etti:\n${r.cikti}`
      );
      assert.match(ozetSatiri(r.cikti, perde), /atlandı/, `Perde ${perde} atlandığını söylemiyor:\n${r.cikti}`);
    }
    assert.match(
      r.cikti,
      /denenecek artış 26, hesabın güvenlik tavanı 25/,
      `atlama gerekçesi (tavan) ekranda yok:\n${r.cikti}`
    );
  } finally {
    sahne.temizle();
  }
});

/* ── 4) Sharedness UNREADABLE: the pre-flight cannot prove it, the answer must ──── */

/**
 * `explicitly_shared` is an optional bool: it can be missing from the response entirely, and
 * then no read-only pre-flight can rule the pre-gate out. The attempt is safe — the server
 * refuses before writing — but the answer is a PRE-GATE refusal, not the network one, and the
 * demo must report that honestly instead of dying with "Perde 2 beklenen ağ retiyle bitmedi".
 */
test("Paylaşımlılık OKUNAMAYAN hesapta ön kapı reddi demoyu çökertmez, uydurma ağ kanıtı da üretmez", async () => {
  const sahne = sahneKur("okunamayan-paylasimlilik", {
    kampanyalar: [{ id: OZEL_ID, ad: "TEST — paylaşımlılığı okunamayan", durum: 3, butceMikro: 25 * 1e6 }],
  });
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI]);
    const durum = sahne.durumOku();

    assert.equal(r.kod, 0, `demo sıfır olmayan kodla bitti (${r.kod}):\n${r.cikti}`);
    assert.doesNotMatch(
      ozetSatiri(r.cikti, "2"),
      /RET \(ağ doğrulaması başarısız\)/,
      `ön kapı cevaplamışken Perde 2 ağ reti iddia etti:\n${r.cikti}`
    );
    assert.match(
      ozetSatiri(r.cikti, "2"),
      /atlandı \(ön kapı/,
      `ön kapı reddi dürüst bir atlama olarak raporlanmadı:\n${r.cikti}`
    );
    // The attempt itself is fine — the server refuses before writing — but it must be named
    // for what it was: a gate before the network's, not the network gate.
    assert.match(
      r.cikti,
      /ön kapı cevap verdi, ağ kapısı hiç konuşmadı/,
      `ön kapı reddi ağ kanıtından ayırt edilmedi:\n${r.cikti}`
    );
    // Nothing was written: the account still holds the original budget.
    assert.equal(durum.kampanyalar[0].butceMikro, 25 * 1e6, "hesaptaki bütçe değişmiş");
  } finally {
    sahne.temizle();
  }
});

/* ── 5) The over-correction watchdog: a healthy account still shows the gate ────── */

/**
 * A "fix" that turned every act into a skip would pass tests 2-4 and destroy the demo. On a
 * clean candidate — campaign-specific budget, room under the ceiling — Act 2 must still REALLY
 * call the write tool and still end with the network refusal.
 */
test("Sağlıklı adayda Perde 2 hâlâ GERÇEKTEN çağırır ve AĞ RETİYLE biter", async () => {
  const sahne = sahneKur("saglikli", { kampanyalar: [ozelKampanya] });
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI]);
    const durum = sahne.durumOku();
    const yazmalar = butceYazmalari(durum);

    assert.equal(r.kod, 0, `demo sıfır olmayan kodla bitti (${r.kod}):\n${r.cikti}`);
    assert.equal(yazmalar.length, 1, `Perde 2 tam bir artış denemesi yapmalıydı:\n${JSON.stringify(yazmalar)}`);
    assert.equal(yazmalar[0].butce, 26, "denenen artış +1 değil");
    assert.match(
      ozetSatiri(r.cikti, "2"),
      /RET \(ağ doğrulaması başarısız\)/,
      `Perde 2 ağ retini gösteremedi:\n${r.cikti}`
    );
    assert.equal(durum.kampanyalar[0].butceMikro, 25 * 1e6, "ağ reddettiği hâlde bütçe değişmiş");
  } finally {
    sahne.temizle();
  }
});

/* ── 6-8) The classifier: only a NAMED front-door refusal may be staged as one ──── */

/**
 * VERBATIM refusal texts, copied from the sources that produce them.
 *
 * `kaynaktaVar` keeps them from going stale in EITHER direction: reword the message in the
 * source and the assertion fires, delete this fixture and the scenes below stop reproducing
 * the real answer. The check is on a distinctive PHRASE rather than the whole sentence, so
 * re-wrapping a string literal across lines does not raise a false alarm.
 */
function kaynaktaVar(dosya, parca) {
  const kaynak = readFileSync(join(KOK, dosya), "utf8");
  assert.ok(kaynak.includes(parca), `${dosya} artık "${parca}" ifadesini üretmiyor — fikstür bayat`);
}

/** src/networkTrust.ts — the SIM Swap link's own FAIL-CLOSED refusal: the gate ran and got no
 *  answer. It carries neither "AĞ DOĞRULAMASI" nor any pre-gate phrase. */
const AG_KAPISI_FAILCLOSED =
  "Reddedildi: ağ doğrulaması tamamlanamadı — SIM Swap kontrolünden yanıt alınamadı. " +
  "Güvenlik gereği yanıtsız kontrolde harcama artışı uygulanmaz; daha sonra tekrar dene. " +
  "Sorun sürerse operatör sunucu günlüklerine bakmalı (ayrıntı oraya yazıldı).";

/** src/util.ts budgetGuard — a REAL front-door refusal, produced before the network gate. */
const ON_KAPI_TAVAN_RETI =
  "Reddedildi: istenen günlük bütçe (26) hesabın güvenlik tavanının (25) üzerinde. " +
  "Tavanı yalnızca hesap sahibi yükseltebilir; kendi başına aşmaya çalışma, kullanıcıya bildir.";

/**
 * THE DEFECT THIS CLOSES. The classifier used to read "opens with 'Reddedildi:' and does not
 * carry 'AĞ DOĞRULAMASI'" — and the gate's own fail-closed refusals carry neither phrase. Act
 * 2 then printed "PERDE 2 ATLANDI — ön kapı cevap verdi, ağ kapısı hiç konuşmadı" and exited
 * 0, narrating the OPPOSITE of what happened at the very moment the gate did its job.
 *
 * Fail-closed: a refusal the script cannot NAME is never staged as a front-door answer.
 */
test("Ağ kapısının KENDİ fail-closed reddi ön kapı reddi sayılmaz — Perde 2 sessizce atlamaz", async () => {
  kaynaktaVar("src/networkTrust.ts", "SIM Swap kontrolünden yanıt alınamadı");
  const sahne = sahneKur("ag-failclosed", { kampanyalar: [ozelKampanya] });
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI], { AEGIS_SAHTE_AG_RET: AG_KAPISI_FAILCLOSED });
    const durum = sahne.durumOku();

    assert.notEqual(r.kod, 0, `ağ kapısının kendi reddi sessizce yutuldu (çıkış kodu 0):\n${r.cikti}`);
    assert.doesNotMatch(
      r.cikti,
      /ön kapı cevap verdi, ağ kapısı hiç konuşmadı/,
      `ağ kapısı KONUŞTUĞU hâlde sahne "ön kapı cevap verdi" dedi:\n${r.cikti}`
    );
    assert.doesNotMatch(
      r.cikti,
      /atlandı \(ön kapı/,
      `ağ kapısının kendi reddi özet tablosunda ön kapıya yazıldı:\n${r.cikti}`
    );
    // The server's own words have to be on screen — a loud end is not a silent one.
    assert.match(r.cikti, /SIM Swap kontrolünden yanıt alınamadı/, `sunucunun ret metni ekranda yok:\n${r.cikti}`);
    assert.equal(durum.kampanyalar[0].butceMikro, 25 * 1e6, "ret verilmişken bütçe değişmiş");
  } finally {
    sahne.temizle();
  }
});

/**
 * The same misreading on Act 1's side. Here the prompt is never shown either — but with a
 * refusal nobody can name, "ön kapı reddetti" invents a gate and "operatör onay vermedi"
 * invents a human decision. Neither may go on stage.
 *
 * --canli is required because Act 1 only calls the write tool there; stdin is closed, so the
 * operator's answer is EOF, which the script already treats as a refusal.
 */
test("Perde 1: istem hiç gösterilmeden gelen TANINMAYAN ret ön kapıya da operatöre de yazılmaz", async () => {
  const sahne = sahneKur("perde1-taninmayan", { kampanyalar: [ozelKampanya] });
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI, "--canli"], {
      AEGIS_SAHTE_AG_RET: AG_KAPISI_FAILCLOSED,
    });
    const durum = sahne.durumOku();

    assert.doesNotMatch(
      r.cikti,
      /ret ağ kapısından ÖNCEKİ bir kapıdan geldi/,
      `Perde 1 tanınmayan reddi ön kapıya yazdı:\n${r.cikti}`
    );
    assert.doesNotMatch(
      r.cikti,
      /Operatör onay vermedi/,
      `kimseye sorulmadığı hâlde Perde 1 operatörün karar verdiğini söyledi:\n${r.cikti}`
    );
    assert.match(
      r.cikti,
      /reddi ÖN KAPININ verdiği DOĞRULANAMADI/,
      `Perde 1 bilinmeyeni dürüstçe adlandırmadı:\n${r.cikti}`
    );
    assert.equal(durum.kampanyalar[0].butceMikro, 25 * 1e6, "ret verilmişken bütçe değişmiş");
  } finally {
    sahne.temizle();
  }
});

/**
 * THE OVER-CORRECTION WATCHDOG for the same classifier: a predicate that answered "no" to
 * everything would pass tests 6 and 7 and turn every real front-door refusal into a stage
 * crash. The account's safety ceiling is a REAL pre-gate, its message comes verbatim from
 * src/util.ts, and it must still produce an honest skip with exit code 0.
 *
 * The scene delivers it through the same knob — i.e. at the network gate's position — on
 * purpose: what is under test is the CLASSIFICATION of the text, and feeding it from the
 * furthest-away position proves the answer does not depend on where it came from.
 */
test("Gerçek ön kapı reddi (tavan) hâlâ dürüst bir ATLAMA olarak raporlanır", async () => {
  kaynaktaVar("src/util.ts", "hesabın güvenlik tavanının (${cap}) üzerinde");
  const sahne = sahneKur("onkapi-tavan-metni", { kampanyalar: [ozelKampanya] });
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI], { AEGIS_SAHTE_AG_RET: ON_KAPI_TAVAN_RETI });
    const durum = sahne.durumOku();

    assert.equal(r.kod, 0, `gerçek ön kapı reddi demoyu çökertti (${r.kod}):\n${r.cikti}`);
    assert.match(
      r.cikti,
      /ön kapı cevap verdi, ağ kapısı hiç konuşmadı/,
      `ön kapı reddi dürüst bir atlama olarak sahnelenmedi:\n${r.cikti}`
    );
    assert.match(
      ozetSatiri(r.cikti, "2"),
      /atlandı \(ön kapı/,
      `özet tablosu ön kapı atlamasını göstermiyor:\n${r.cikti}`
    );
    assert.doesNotMatch(
      ozetSatiri(r.cikti, "2"),
      /RET \(ağ doğrulaması başarısız\)/,
      `ön kapı cevaplamışken Perde 2 ağ reti iddia etti:\n${r.cikti}`
    );
    assert.equal(durum.kampanyalar[0].butceMikro, 25 * 1e6, "ret verilmişken bütçe değişmiş");
  } finally {
    sahne.temizle();
  }
});

/* ── 9) The classifier's VOCABULARY, tied to the sources in both directions ───────── */

/**
 * The patterns are read VERBATIM out of the script — never re-typed here, because a copy would
 * pass while the script's own list rotted.
 */
function onKapiDesenleri() {
  const kaynak = readFileSync(join(KOK, "scripts", "demo-senaryo.mjs"), "utf8");
  const bas = kaynak.indexOf("const ON_KAPI_RETLERI = [");
  assert.ok(bas >= 0, "scripts/demo-senaryo.mjs artık ON_KAPI_RETLERI listesi tanımlamıyor");
  const son = kaynak.indexOf("\n];", bas);
  assert.ok(son > bas, "ON_KAPI_RETLERI listesinin sonu bulunamadı");
  const govde = kaynak.slice(bas + "const ON_KAPI_RETLERI = ".length, son + 2);
  const desenler = new Function(`return ${govde};`)();
  assert.ok(Array.isArray(desenler) && desenler.length > 0, `ON_KAPI_RETLERI okunamadı: ${govde}`);
  return desenler;
}

/**
 * ON_KAPI_RETLERI is a CLAIM ABOUT src/: "these phrases, and only these, belong to gates that
 * answer before the network's". Nothing checked that claim, and it can rot in two directions.
 *
 * Stale (a pre-gate message reworded in src/): the pattern stops matching anything, the refusal
 * drops out of the list — which is the fail-closed direction, but silently, and the scenes above
 * would keep passing on a fake server still reciting the OLD text. Loosened (a pattern that also
 * touches the network gate's or the approval gate's wording): the exact defect this file exists
 * to close comes back, because a NETWORK refusal would again be staged as a front-door answer.
 *
 * So every pattern must hit the pre-gate sources AND miss the network/approval ones.
 */
test("Ön kapı sözlüğü kaynakla ÇİFT YÖNLÜ bağlı: her desen bir ön kapı metnini yakalar, hiçbiri ağ kapısının metnine değmez", () => {
  const oku = (dosyalar) => dosyalar.map((d) => readFileSync(join(KOK, d), "utf8")).join("\n");
  // budgetGuard (ceiling, broken ceiling config, non-positive amount) and the sharedness
  // refusals — every gate update_campaign_budget applies BEFORE it consults the network.
  const onKapiKaynagi = oku(["src/util.ts", "src/tools/write.ts"]);
  // The gate itself, and the approval gate that speaks for it.
  const agKapisiKaynagi = oku(["src/networkTrust.ts", "src/approval.ts"]);

  for (const desen of onKapiDesenleri()) {
    assert.ok(
      desen.test(onKapiKaynagi),
      `${desen} artık hiçbir ön kapı reddine denk gelmiyor — sözlük bayat`
    );
    assert.ok(
      !desen.test(agKapisiKaynagi),
      `${desen} AĞ KAPISININ metnine de değiyor — ağ reddi ön kapı sayılabilir`
    );
  }
});
