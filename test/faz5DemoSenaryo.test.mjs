// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PHASE-5 REGRESSION — scripts/demo-senaryo.mjs
 *
 * Two defects were MEASURED in the phase-4 state of this script and its layout sentinel, and
 * both are pinned here. They have nothing in common except the shape of the mistake: a claim
 * that outruns what was actually observed.
 *
 * 1) A READ-BACK THAT COULD NOT HAVE COME OUT OTHERWISE VOUCHES FOR NOTHING (behaviour).
 *    Act 3/B really calls set_campaign_status(ENABLED) and then reads the status BACK from
 *    the account, because "the gate is expected to refuse" is not "no write happened". On the
 *    act's own candidate — PAUSED before the run — that reading is evidence: any status other
 *    than ENABLED disproves an applied write. On the one candidate the act does NOT own, a
 *    campaign that --kampanya named while it was ALREADY ENABLED, a reading of ENABLED is the
 *    value the campaign already had: a refused write and an applied write leave the account
 *    looking exactly alike. MEASURED before the repair, by running the script against the
 *    fake server below with `--kampanya` on an ENABLED campaign: the stage printed
 *    "Geri okuma: kampanya #5550001 durumu ENABLED — yazma yapılmadı." and the summary table
 *    recorded "yok (geri okundu: ENABLED)", while the recorded calls showed the write really
 *    had been attempted. The BOND PRINCIPLE says a link may only vouch for a signal it could
 *    have contradicted; this one could not.
 *
 * 2) THE LAYOUT SENTINEL COULD BE PIERCED BY A QUOTE (test/faz4DemoSenaryo.test.mjs).
 *    Its `tasanSatirSonuYorumlari` scanner classifies each line ON ITS OWN, so a line that
 *    merely CLOSES a multi-line template literal — or carries a regex character class such as
 *    /['"]/ — leaves its per-line quote state open, `yorumBasi` returns -1, and the line is
 *    skipped. MEASURED: inserting into the script the exact defect that sentinel exists to
 *    prevent (an end-of-line comment whose tail wraps onto its own line) directly under a
 *    multi-line template left all six of its tests GREEN. The same blindness already hides a
 *    LIVE comment: on the file as it stands, 55 of its 1612 lines end with an open quote
 *    state, among them `/bütçe 0'dan büyük olmalı/, // ...` — so the phase-4 inventory counts
 *    13 end-of-line comments where the scanner below counts 14.
 *    The scanner below therefore does not guess per line: it walks the file as one stream,
 *    carrying template-literal, block-comment, string and regex state ACROSS lines, and it is
 *    FAIL-CLOSED — a line it cannot parse is a failure, not a line to skip. That is the whole
 *    difference: the old scanner fell silent on what it did not understand, this one goes red.
 *
 * WHY THIS FILE CANNOT PASS BY SEEING NOTHING:
 *   · Behaviour is measured by RUNNING the script against a fake MCP server, and the three
 *     scenes pull against each other: a reading that proves nothing may NOT be claimed, and a
 *     reading that does prove something MUST be claimed — in the summary table too. A script
 *     that simply stopped talking would fail the third test.
 *   · The scanner is run against the exact pre-repair text (encoded in this file) and must
 *     report the violation, and against the repaired text and must report none.
 *   · Its lexer is pinned separately on the shapes that blinded the old one, and every
 *     inventory asserts it is non-empty before it vouches for anything.
 *
 * The harness is the one from test/faz3DemoSenaryo.test.mjs (a temp project inside the repo
 * root so `@modelcontextprotocol/sdk` resolves), with one extra switch value:
 *   AEGIS_SAHTE_DURUMOKUMA : "" | "hata" | "paused" — does the STATUS read-back answer, fail,
 *                            or answer PAUSED whatever the campaign's real status is
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const KOK = fileURLToPath(new URL("..", import.meta.url));
const HEDEF = "scripts/demo-senaryo.mjs";
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
    if (DURUMOKUMA === "paused" && durumOkumasiMi(sorgu)) {
      // The status read-back answers PAUSED whatever the campaign really is: a reading that
      // CAN contradict "a write went through", even on a candidate that was already ENABLED.
      const zorlanan = [{ campaign: { id: d.kampanya.id, status: 3 } }];
      return sonuc(id, {
        content: [{ type: "text", text: "Satırlar:\n" + JSON.stringify(zorlanan) }],
        structuredContent: { satirlar: zorlanan },
      });
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
  const kok = join(KOK, `.tmp-faz5-demo-${ad}-${process.pid}`);
  rmSync(kok, { recursive: true, force: true });
  mkdirSync(join(kok, "scripts"), { recursive: true });
  mkdirSync(join(kok, "dist"), { recursive: true });
  cpSync(join(KOK, HEDEF), join(kok, "scripts", "demo-senaryo.mjs"));
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
/** …narrowed to the STATUS read-back line, the one Act 3/B prints about a campaign. */
const durumIddiasi = (cikti) => yazmaYokIddiasi(cikti).filter((s) => /kampanya #/.test(s));

/* ── 1) A reading that could not have come out otherwise may not be claimed ───── */

/**
 * `--kampanya` names a campaign that is ALREADY ENABLED, and the status read-back works
 * perfectly: it answers ENABLED. That is the value the campaign had BEFORE the call, so the
 * refusal we expect and a write that slipped through are indistinguishable in it. The write
 * really was attempted (the recorded calls prove it), so "yazma yapılmadı" is a claim this
 * reading cannot carry — on stage or in the summary table.
 */
test("Perde 3/B: koşudan ÖNCE de ENABLED olan adayda 'yazma yapılmadı' İDDİA EDİLMEZ", async () => {
  const sahne = sahneKur("zaten-yayinda-okunabilir", { durum: 2 });
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI, "--kampanya", KAMPANYA_ID]);
    const durum = sahne.durumOku();

    // The scene really is the one the defect describes: the write WAS attempted.
    assert.ok(
      durum.cagrilar.some((c) => c.arac === "set_campaign_status" && c.status === "ENABLED"),
      `Sahne kurgusu tutmadı: 3/B yazma çağrısı yapılmamış (${JSON.stringify(durum.cagrilar)}).\nÇıktı:\n${r.cikti}`
    );
    assert.deepEqual(
      durumIddiasi(r.cikti),
      [],
      "Ön durumu da ENABLED olan adayda «yazma yapılmadı» iddia edildi; bu geri okuma bir yazmayı " +
        `ÇÜRÜTEMEZ, dolayısıyla hiçbir şeye kefil olamaz.\nÇıktı:\n${r.cikti}`
    );
    assert.ok(
      !/yok \(geri okundu: ENABLED\)/.test(r.cikti),
      `Özet tablosu ayırt edilemeyen okumayı "yok (geri okundu: ENABLED)" diye kaydetti.\nÇıktı:\n${r.cikti}`
    );
    // Silence is not honesty either: the reservation has to be SPOKEN, and with its reason.
    assert.match(
      r.cikti,
      /ÇÜRÜTEMEZ, yazma yapılmadığı DOĞRULANAMADI/,
      `Ayırt edilemeyen okuma için çekince basılmadı.\nÇıktı:\n${r.cikti}`
    );
    assert.match(
      r.cikti,
      /DOĞRULANAMADI \(ön durum da ENABLED\)/,
      `Özet tablosunda çekince satırı yok — tablo hâlâ temiz bir "yok" gösteriyor.\nÇıktı:\n${r.cikti}`
    );
    // Someone else's live campaign is NOT paused: the act owns no reversal here.
    assert.deepEqual(
      durum.cagrilar.filter((c) => c.arac === "set_campaign_status" && c.status === "PAUSED"),
      [],
      `Zaten yayında olan kampanya duraklatıldı — bu perdenin işi değil.\nÇıktı:\n${r.cikti}`
    );
    assert.equal(durum.kampanya.durum, 2, "sahne kurgusu: kampanya ENABLED kalmalıydı");
    assert.equal(r.kod, 0, `Çekince bir hata değildir; koşu 0 ile bitmeliydi.\nÇıktı:\n${r.cikti}`);
  } finally {
    rmSync(sahne.kok, { recursive: true, force: true });
  }
});

/* ── 2) The counterweight: a reading that CAN contradict must still be claimed ── */

/**
 * The same flag and the same route through the script; only the candidate's PRE-STATE
 * differs, because `--kampanya` names a PAUSED campaign. Here a PAUSED read-back really does
 * disprove an applied write, so the honest claim must be made — otherwise "never claim
 * anything" would satisfy the test above. This also pins WHICH signal decides.
 */
test("Perde 3/B: adlandırılmış PAUSED adayda dürüst 'yazma yapılmadı' iddiası GERÇEKTEN basılır", async () => {
  const sahne = sahneKur("adlandirilmis-duraklatilmis");
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI, "--kampanya", KAMPANYA_ID]);
    const durum = sahne.durumOku();

    assert.match(
      r.cikti,
      new RegExp(`Geri okuma: kampanya #${KAMPANYA_ID} durumu PAUSED — yazma yapılmadı\\.`),
      `Çürütebilen okumada dürüst iddia basılmadı — bekçi "hiç konuşma" ile de geçerdi.\nÇıktı:\n${r.cikti}`
    );
    assert.match(
      r.cikti,
      /yok \(geri okundu: PAUSED\)/,
      `Özet tablosunda 3/B satırı "yok (geri okundu: PAUSED)" değil.\nÇıktı:\n${r.cikti}`
    );
    assert.ok(
      !/DOĞRULANAMADI/.test(r.cikti),
      `Çürütebilen okumada çekince basıldı — çekince her yere yayılmış.\nÇıktı:\n${r.cikti}`
    );
    assert.equal(durum.kampanya.durum, 3, "sahne kurgusu: kampanya PAUSED kalmalıydı");
    assert.equal(r.kod, 0, `Temiz koşu 0 ile bitmeliydi.\nÇıktı:\n${r.cikti}`);
  } finally {
    rmSync(sahne.kok, { recursive: true, force: true });
  }
});

/* ── 3) The discriminator is the READING, not the pre-state ───────────────────── */

/**
 * The candidate was ALREADY ENABLED — as in the first test — but this time the read-back
 * answers PAUSED. A write that went through would have left ENABLED, so this reading DOES
 * disprove one: the claim is owed and must be made. A repair that keyed on `zatenYayindaydi`
 * alone, silencing every already-live candidate, is red here.
 */
test("Perde 3/B: zaten ENABLED aday da olsa, ÇÜRÜTEBİLEN okuma iddiayı geri getirir", async () => {
  const sahne = sahneKur("zaten-yayinda-paused-okuma", { durum: 2 });
  try {
    const r = await kos(sahne.kok, ["--musteri", MUSTERI, "--kampanya", KAMPANYA_ID], {
      AEGIS_SAHTE_DURUMOKUMA: "paused",
    });

    assert.match(
      r.cikti,
      new RegExp(`Geri okuma: kampanya #${KAMPANYA_ID} durumu PAUSED — yazma yapılmadı\\.`),
      `Ön durum ENABLED diye çürütebilen okuma da susturulmuş.\nÇıktı:\n${r.cikti}`
    );
    assert.match(
      r.cikti,
      /yok \(geri okundu: PAUSED\)/,
      `Özet tablosu çürütebilen okumayı da çekinceye çevirmiş.\nÇıktı:\n${r.cikti}`
    );
    assert.equal(r.kod, 0, `Temiz koşu 0 ile bitmeliydi.\nÇıktı:\n${r.cikti}`);
  } finally {
    rmSync(sahne.kok, { recursive: true, force: true });
  }
});

/* ── The layout scanner: ONE STREAM, and fail-closed on what it cannot parse ──── */

const KAYNAK = readFileSync(join(KOK, HEDEF), "utf8");
const SATIRLAR = KAYNAK.split("\n");

/** Characters after which a `/` opens a REGEX rather than dividing. */
const REGEX_ONCESI = new Set([
  "", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^", "<", ">",
]);
/** …and the keywords after which the same is true (`return /re/.test(x)`). */
const REGEX_ONCESI_SOZCUK = /\b(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)\s*$/;

/**
 * Walks the file as a single stream and reports, per line, where a `//` comment starts.
 *
 * The phase-4 extractor decided this ONE LINE AT A TIME, which is what made it pierceable: a
 * line that merely CLOSES a multi-line template literal, or carries a regex character class
 * with a quote in it, left its quote state open, so the scan never reached the `//` and the
 * line was silently skipped. This one carries template-literal, block-comment, string and
 * regex state ACROSS lines, and — the part that matters most — it does not skip what it fails
 * to understand: a line it cannot parse comes back with `sorun` set, and the file-level test
 * below demands there be none. Blindness must be LOUD, or a sentinel of this shape passes by
 * seeing nothing.
 *
 * Per line: `{ no, metin, yorumBasi, sorun, blokIcinde, sablonIcinde }`, the last two being
 * the stream's state as the line STARTS.
 */
function akisiTara(satirlar) {
  let blok = false;
  const yigin = [];
  const bilgi = [];
  for (let n = 0; n < satirlar.length; n++) {
    const s = satirlar[n];
    const blokBasta = blok;
    const sablonBasta = yigin.length > 0;
    let i = 0;
    let yorum = -1;
    let sorun = null;
    let onceki = "";
    while (i < s.length) {
      const c = s[i];
      const d = s[i + 1];
      if (blok) {
        if (c === "*" && d === "/") {
          blok = false;
          onceki = "x";
          i += 2;
        } else i++;
        continue;
      }
      const ust = yigin[yigin.length - 1];
      if (ust && ust.tur === "sablon") {
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "`") {
          yigin.pop();
          onceki = "x";
          i++;
          continue;
        }
        if (c === "$" && d === "{") {
          yigin.push({ tur: "ifade", suslu: 0 });
          onceki = "{";
          i += 2;
          continue;
        }
        i++;
        continue;
      }
      if (c === "/" && d === "/") {
        yorum = i;
        break;
      }
      if (c === "/" && d === "*") {
        blok = true;
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < s.length && s[j] !== c) {
          if (s[j] === "\\") j++;
          j++;
        }
        if (j >= s.length) {
          sorun = `kapanmayan ${c} tırnağı`;
          break;
        }
        onceki = "x";
        i = j + 1;
        continue;
      }
      if (c === "`") {
        yigin.push({ tur: "sablon" });
        i++;
        continue;
      }
      if (c === "/" && (REGEX_ONCESI.has(onceki) || REGEX_ONCESI_SOZCUK.test(s.slice(0, i)))) {
        let j = i + 1;
        let sinif = false;
        let kapandi = false;
        while (j < s.length) {
          const e = s[j];
          if (e === "\\") {
            j += 2;
            continue;
          }
          if (sinif) {
            if (e === "]") sinif = false;
            j++;
            continue;
          }
          if (e === "[") {
            sinif = true;
            j++;
            continue;
          }
          if (e === "/") {
            kapandi = true;
            break;
          }
          j++;
        }
        if (!kapandi) {
          sorun = "kapanmayan regex";
          break;
        }
        onceki = "x";
        i = j + 1;
        continue;
      }
      if (ust && ust.tur === "ifade") {
        if (c === "{") ust.suslu++;
        else if (c === "}") {
          if (ust.suslu === 0) {
            yigin.pop();
            onceki = "x";
            i++;
            continue;
          }
          ust.suslu--;
        }
      }
      if (/\S/.test(c)) onceki = c;
      i++;
    }
    bilgi.push({ no: n + 1, metin: s, yorumBasi: yorum, sorun, blokIcinde: blokBasta, sablonIcinde: sablonBasta });
  }
  return { bilgi, acikBlok: blok, acikSablon: yigin.length };
}

/** A line that is NOTHING but a `//` comment. */
const yorumSatiriMi = (b) =>
  !b.blokIcinde && !b.sablonIcinde && b.yorumBasi >= 0 && !/\S/.test(b.metin.slice(0, b.yorumBasi));
/** A line carrying code AND an end-of-line comment — the population the scanner walks. */
const karmaSatirMi = (b) => b.yorumBasi > 0 && /\S/.test(b.metin.slice(0, b.yorumBasi));

/** Comment-only lines that are really the tail of an END-OF-LINE comment on the line above. */
function tasanSatirSonuYorumlari(satirlar) {
  const { bilgi } = akisiTara(satirlar);
  const tasanlar = [];
  for (let k = 1; k < bilgi.length; k++) {
    if (!yorumSatiriMi(bilgi[k]) || !karmaSatirMi(bilgi[k - 1])) continue;
    tasanlar.push({
      satir: k + 1,
      kod: bilgi[k - 1].metin.slice(0, bilgi[k - 1].yorumBasi).trim(),
      metin: bilgi[k].metin.trim(),
    });
  }
  return tasanlar;
}

/** The phase-4 per-line extractor, kept VERBATIM as the measured baseline it is compared to. */
const TIRNAKLAR = new Set(['"', "'", "`"]);
function korYorumBasi(satir) {
  let tirnak = null;
  for (let i = 0; i < satir.length; i++) {
    const c = satir[i];
    if (tirnak) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === tirnak) tirnak = null;
      continue;
    }
    if (TIRNAKLAR.has(c)) {
      tirnak = c;
      continue;
    }
    if (c === "/" && satir[i + 1] === "/") return i;
  }
  return -1;
}

/* ── The mutation, encoded: the exact defect the phase-4 sentinel let through ──── */

/**
 * The measured piercing case: an end-of-line comment whose tail wraps onto a line of its own,
 * written directly under a multi-line template literal. Inserted into the script verbatim, all
 * six phase-4 tests stayed green.
 */
const BOZUK_TASMA_SABLON = [
  "const mesaj = `ilk satir",
  "  ikinci satir`; // the tail of this sentence wraps onto",
  "  // the next line, exactly the repaired defect",
];
const ONARILMIS_TASMA_SABLON = [
  "// the tail of this sentence wraps onto the next line, exactly the repaired defect",
  "const mesaj = `ilk satir",
  "  ikinci satir`;",
];

/** The phase-4 case, which this scanner must keep catching: nothing is traded away. */
const BOZUK_TASMA = [
  'const DEMO_TELEFON = "+905550001122"; // the approver\'s DEMO number, passed to the server in',
  "// the spawn environment",
];

test("tarayıcı kendini sınar: şablon altına yazılan taşma KIRMIZI, onarılmış hâli yeşil", () => {
  const tasan = tasanSatirSonuYorumlari(BOZUK_TASMA_SABLON);
  assert.equal(
    tasan.length,
    1,
    `Şablonun altındaki taşan yorum görülmedi — faz-4'ün deliği duruyor: ${JSON.stringify(tasan)}`
  );
  assert.equal(tasan[0].metin, "// the next line, exactly the repaired defect");
  assert.deepEqual(
    tasanSatirSonuYorumlari(ONARILMIS_TASMA_SABLON),
    [],
    "Yorumu satırın üstüne alan onarılmış biçim yanlışlıkla kırmızı."
  );

  // The phase-4 scanner is blind to exactly this shape; that is why this file exists.
  assert.equal(
    korYorumBasi(BOZUK_TASMA_SABLON[1]),
    -1,
    "Faz-4 tarayıcısı artık kör değilse bu dosyanın gerekçesi bayatlamıştır — ölçümü yenile."
  );

  // …and the case it DID catch is still caught here.
  const eskiTasan = tasanSatirSonuYorumlari(BOZUK_TASMA);
  assert.equal(eskiTasan.length, 1, `Faz-4'ün kendi vakası kaybedildi: ${JSON.stringify(eskiTasan)}`);
  assert.equal(eskiTasan[0].metin, "// the spawn environment");
});

test("akisiTara: faz-4'ü körleştiren biçimlerde yorumu BULUR", () => {
  const ornek = [
    'const u = "https://ornek.test/yol";',
    "const t = `ilk satir",
    "  ikinci satir`; // kuyruk",
    "/bütçe 0'dan büyük olmalı/, // apostroflu regex — dosyada canlı olan biçim",
    "const d = /['\"]/; // tırnak sınıfı",
    "yaz(`a ${b(`c`)} d`); // iç içe şablon",
    "/* blok",
    " * içeride // yorum sayılmaz",
    " */ const n = 5; // blok kapandıktan sonra",
    'const e = "kaçışlı \\" tırnak"; // kaçış',
  ];
  const { bilgi, acikBlok, acikSablon } = akisiTara(ornek);
  const dilim = bilgi.map((b) => (b.yorumBasi >= 0 ? b.metin.slice(b.yorumBasi) : null));
  assert.deepEqual(dilim, [
    null,
    null,
    "// kuyruk",
    "// apostroflu regex — dosyada canlı olan biçim",
    "// tırnak sınıfı",
    "// iç içe şablon",
    null,
    null,
    "// blok kapandıktan sonra",
    "// kaçış",
  ]);
  assert.equal(acikBlok, false, "Blok yorum kapanmamış sayıldı.");
  assert.equal(acikSablon, 0, "Şablon yığını dengede kapanmadı.");
  assert.deepEqual(
    bilgi.filter((b) => b.sorun),
    [],
    "Geçerli kaynakta ayrıştırılamayan satır bildirildi."
  );

  // The measured contrast: the same three lines are invisible to the phase-4 extractor.
  for (const k of [2, 3, 4]) {
    assert.equal(korYorumBasi(ornek[k]), -1, `Faz-4 tarayıcısı ${k}. satırda artık kör değil — ölçümü yenile.`);
  }
});

test("akisiTara FAIL-CLOSED: ayrıştıramadığı satırı atlamaz, bildirir", () => {
  const kapanmayanTirnak = akisiTara(["const a = 'kapanmayan; // yorum gibi görünen kuyruk"]);
  assert.match(
    kapanmayanTirnak.bilgi[0].sorun ?? "",
    /kapanmayan ' tırnağı/,
    "Kapanmayan tırnak sessizce yutuldu — tarayıcı yine körleşebilir."
  );
  assert.equal(kapanmayanTirnak.bilgi[0].yorumBasi, -1, "Ayrıştırılamayan satırda yorum iddia edildi.");

  const kapanmayanRegex = akisiTara(["const r = /kapanmayan"]);
  assert.match(kapanmayanRegex.bilgi[0].sorun ?? "", /kapanmayan regex/);

  const acikSablon = akisiTara(["const t = `açık şablon"]);
  assert.equal(acikSablon.acikSablon, 1, "Kapanmayan şablon dosya sonunda dengede sayıldı.");

  const acikBlok = akisiTara(["/* açık blok"]);
  assert.equal(acikBlok.acikBlok, true, "Kapanmayan blok yorum dosya sonunda kapalı sayıldı.");
});

/* ── The repaired file ────────────────────────────────────────────────────────── */

test(`${HEDEF}: tarayıcı dosyanın TAMAMINI ayrıştırır (körleşme kırmızıdır)`, () => {
  const { bilgi, acikBlok, acikSablon } = akisiTara(SATIRLAR);
  const sorunlular = bilgi.filter((b) => b.sorun);
  assert.deepEqual(
    sorunlular.map((b) => `${HEDEF}:${b.no} ${b.sorun} → ${b.metin.trim()}`),
    [],
    "Tarayıcı bu satırları ayrıştıramadı. Bilinmeyen sinyal REDDE gider: burada kırmızı olmak, " +
      "o satırı sessizce atlayıp yokluk iddia etmekten iyidir."
  );
  assert.equal(acikBlok, false, "Dosya açık bir blok yorumla bitiyor — tarayıcı kaymış olabilir.");
  assert.equal(acikSablon, 0, "Dosya açık bir şablon dizesiyle bitiyor — tarayıcı kaymış olabilir.");
});

test(`${HEDEF}: satır sonu yorumu kendi başına bir satıra taşmaz (şablon altında da)`, () => {
  const { bilgi } = akisiTara(SATIRLAR);
  const karma = bilgi.filter(karmaSatirMi);
  const yorumSatirlari = bilgi.filter(yorumSatiriMi);
  assert.ok(
    karma.length >= 10,
    `Envanter boş sayılır (${karma.length} satır sonu yorumu) — bekçi hiçbir şeye kefil olamaz.`
  );
  assert.ok(yorumSatirlari.length >= 50, `Yorum satırı envanteri boş sayılır (${yorumSatirlari.length}).`);

  // Strictly stronger than the phase-4 scanner: every line it counted is counted here too.
  const eski = SATIRLAR.map((s, i) => ({ no: i + 1, p: korYorumBasi(s) })).filter(
    (x) => x.p > 0 && /\S/.test(SATIRLAR[x.no - 1].slice(0, x.p))
  );
  const yeni = new Set(karma.map((b) => b.no));
  assert.deepEqual(
    eski.filter((x) => !yeni.has(x.no)),
    [],
    "Faz-4 tarayıcısının saydığı bir satır burada sayılmıyor — yeni tarayıcı eskisinin üst kümesi değil."
  );

  const tasanlar = tasanSatirSonuYorumlari(SATIRLAR);
  assert.deepEqual(
    tasanlar,
    [],
    "Satır sonu yorumunun devamı ayrı satıra taşmış; bir SONRAKİ satır hakkında bağımsız bir " +
      "yorum gibi okunuyor. Yorumu satırın üstüne al ya da tek satıra sığdır:\n" +
      tasanlar.map((t) => `  ${HEDEF}:${t.satir} ${t.kod} ⏎ ${t.metin}`).join("\n")
  );
});

/* ── The sentence the behaviour above is bound to ─────────────────────────────── */

/**
 * The repair is worth nothing if the paragraph over it goes stale, so the two are bound in
 * both directions: the doctrine must name the indistinguishable reading, and the code under it
 * must still be the branch that acts on it.
 */
test(`${HEDEF}: 3/B geri okuma doktrini ile kodu birbirini tutuyor`, () => {
  const i = SATIRLAR.findIndex((s) => /const geriOkumaCurutebilir = /.test(s));
  assert.ok(i > 0, "geriOkumaCurutebilir kararı kaynakta yok — doktrini uygulayan satır kaybolmuş.");
  assert.match(
    SATIRLAR[i],
    /okunabildiB && !\(zatenYayindaydi && durumB === "ENABLED"\)/,
    `Karar artık «okunabildi VE ayırt edilebilir» değil: ${SATIRLAR[i].trim()}`
  );

  let bas = i;
  while (bas > 0 && !/^\s*\/\*\*/.test(SATIRLAR[bas - 1])) bas--;
  const doktrin = SATIRLAR.slice(bas - 1, i).join(" ");
  assert.match(doktrin, /NOT A DEFAULT/, "«Ölçümdür, varsayılan değildir» cümlesi düşmüş.");
  // Anchored to the ENABLED reading itself: a general remark elsewhere in the paragraph must
  // not be able to satisfy this — that is how a positive claim quietly goes vacuous.
  assert.match(
    doktrin,
    /this reading cannot contradict/,
    "Doktrin artık ENABLED okumasının ÇELİŞEMEZ olduğunu söylemiyor — kefalet gerekçesi kayıp."
  );
  assert.match(
    doktrin,
    /ALREADY HAD/,
    "Doktrin, ENABLED okumasının kampanyanın ZATEN sahip olduğu değer olduğunu söylemiyor."
  );
});
