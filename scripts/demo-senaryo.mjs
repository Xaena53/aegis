#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Aegis — Google Ads MCP server
 * Copyright (C) 2026 Xaena53 (github.com/Xaena53) and the Aegis contributors
 *
 * This program is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License version 3 as published by the Free
 * Software Foundation. See the LICENSE file for details.
 */

/**
 * The demo scenario: it plays the deck's terminal story against the REAL MCP server,
 * without an LLM and without needing an API key. The server is started from dist/index.js
 * over stdio, and this script is an MCP client that advertises the elicitation form
 * capability.
 *
 *   Act 1 (AEGIS_NAC_SIMULATE=temiz)  : the network is clean → the approval prompt →
 *                                          SUCCESS
 *   Act 2 (AEGIS_NAC_SIMULATE=degisti): the SIM counts as swapped → a HARD REFUSAL, and the
 *                                          approval prompt is NEVER shown
 *   Act 3 (clean and swapped, two sub-scenes): the HIGH layer of the SAME gate —
 *                                          set_campaign_status → ENABLED (going live),
 *                                          with a window of 72 hours rather than 24
 *
 * The default mode is DRY: in Act 1 and Act 3/A the real write tool is NOT CALLED — the
 * script stops immediately before the tool call and prints "[kuru] araç çağrısı atlandı".
 * With the --canli flag it really is called, as a small increase of one unit, and after the
 * approval the budget is returned to its old value, since a decrease needs no approval. Under
 * --canli the approval decision is NOT the script's: it belongs to a real operator typing
 * 'Evet' at the keyboard, through readline.
 *
 * Act 3's live rehearsal is performed ONLY on a TEST campaign that is PAUSED and named
 * explicitly with --kampanya: the campaign really is set to ENABLED, returned to PAUSED the
 * moment the scene ends, and the status is verified BY READING IT BACK. If that reversal
 * cannot be verified, the script SHOUTS — a red emergency box and exit code 1 — because a
 * campaign left live spends real money.
 *
 * The calls in Act 2 and Act 3/B are safe in dry mode too: the network gate refuses BEFORE
 * any write. If the expected refusal does not arrive, or the prompt is shown even once, the
 * demo ends in an ERROR; the elicitation handler for those acts ALWAYS refuses, as a
 * fail-closed precaution.
 *
 * If AEGIS_NV_SIMULATE is defined — this script DOES NOT SET its value, it only passes it
 * through to the server processes as-is — Act 3 also highlights the evidence line of the
 * chain's second link.
 *
 * Usage:
 *   npm run demo -- --musteri <customer-id> [--kampanya <campaign-id>] [--canli]
 *   The default is DRY mode with no writes at all; --canli applies a real, small, reverted
 *   budget increase, and with --kampanya it takes the TEST campaign live briefly.
 *
 *   node scripts/demo-senaryo.mjs --kendini-sina   (hidden; needs no customer and no dist)
 *   This DOES NOT PLAY the scenario: it only proves that the safety interlock above — the
 *   "the reversal could not be verified" flag — really does print the red emergency box and
 *   set the exit code to 1. The interlock itself is called, not a copy of it.
 */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_TELEFON = "+905550001122"; // the approver's DEMO number, passed to the server in
// the spawn environment

/* ── CLI ─────────────────────────────────────────────────────────────────────── */

function bayrakDegeri(ad) {
  const i = process.argv.indexOf(ad);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}
const MUSTERI = bayrakDegeri("--musteri");
const KAMPANYA_ARG = bayrakDegeri("--kampanya")?.replace(/\D/g, "") || undefined;
const CANLI = process.argv.includes("--canli");
/** Hidden: it exercises Act 3's safety interlock, not the scenario — see kendiniSina
 * below. */
const KENDINI_SINA = process.argv.includes("--kendini-sina");

/**
 * The HIGH layer's window, the one for going live — the SAME rule as the server's: CAMARA's
 * range is 1 to 2400, and an unusable value falls back to 72. It is computed here only to
 * PRINT it and to verify the evidence line that arrives in the prompt; the decision is always
 * the server's.
 */
function yuksekPencereSaat() {
  const ham = Number(process.env.AEGIS_SIMSWAP_WINDOW_HOURS);
  if (!Number.isFinite(ham) || ham < 1) return 72;
  return Math.min(2400, Math.round(ham));
}
const PENCERE_YUKSEK = yuksekPencereSaat();

/**
 * The chain's second link (AEGIS_NV_SIMULATE). THIS SCRIPT DOES NOT SET its value: it only
 * checks whether it is defined and passes it to the server processes with whatever value it
 * has — see sunucuBaslat, where every AEGIS_-prefixed variable is forwarded verbatim.
 */
const ZINCIR_2 = Boolean(process.env.AEGIS_NV_SIMULATE?.trim());

/**
 * The CLIENT-side timeout for tool calls that ask for approval. The MCP SDK's default is 60
 * seconds, which is far too short while waiting for a human: the call drops while the
 * operator is still reading the prompt, "Request timed out" appears on screen, and the scene
 * breaks. It is aligned with the server's elicitInput timeout of ten minutes in approval.ts,
 * so the gate is governed by one duration rather than by whichever of the two fires first.
 */
const ONAY_ZAMAN_ASIMI = { timeout: 10 * 60_000, resetTimeoutOnProgress: true };

// --kendini-sina connects to no server and reads no account: it needs neither a customer id
// nor a compiled dist/. That is why it is held outside the two preconditions below.
if (!MUSTERI && !KENDINI_SINA) {
  console.error("Kullanım: npm run demo -- --musteri <müşteri-id> [--kampanya <kampanya-id>] [--canli]");
  console.error("Varsayılan KURU moddur (hiç yazma yok); --canli gerçek (küçük, geri alınan) bir bütçe artışı uygular.");
  process.exit(1);
}
if (!KENDINI_SINA && !existsSync(join(ROOT, "dist", "index.js"))) {
  console.error("dist/index.js bulunamadı — önce `npm run build` çalıştır.");
  process.exit(1);
}

/* ── Renk + tempo ────────────────────────────────────────────────────────────── */

const RENKLI = process.stdout.isTTY && !process.env.NO_COLOR;
const boya = (kod) => (s) => (RENKLI ? `\x1b[${kod}m${s}\x1b[0m` : String(s));
const kirmizi = boya("31;1");
const yesil = boya("32;1");
const sari = boya("33");
const cyan = boya("36");
const kalin = boya("1");
const soluk = boya("2");

const bekle = (ms = 700) => new Promise((r) => setTimeout(r, ms));
const yaz = (s = "") => console.log(s);

function kutu(baslik, satirlar, renk = cyan) {
  yaz(renk(`\n┌─ ${baslik} ${"─".repeat(Math.max(3, 60 - baslik.length))}`));
  for (const satir of satirlar) for (const parca of String(satir).split("\n")) yaz(renk("│ ") + parca);
  yaz(renk(`└${"─".repeat(63)}`));
}

/**
 * In a --canli rehearsal, this reads a REAL operator's decision from the keyboard; the
 * script DOES NOT DECIDE.
 *
 * If stdin closes — piped input exhausted, `< /dev/null`, a dropped session — rl.question
 * would never resolve and the run would hang for the whole approval timeout. EOF is not an
 * answer: an empty string is returned, and because the caller does not count it as 'Evet',
 * the outcome is a REFUSAL. A silent channel does not stand in for approval; it fails
 * closed.
 */
async function operatoreSor(soru) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await Promise.race([
      rl.question(sari(soru)).then((c) => c.trim(), () => ""),
      new Promise((coz) => rl.once("close", () => coz(""))),
    ]);
  } finally {
    rl.close();
  }
}

async function perdeBasligi(no, aciklama) {
  yaz("\n" + kalin(`═══ PERDE ${no} ══════════════════════════════════════════════════`));
  yaz(kalin(aciklama));
  await bekle(500);
}

/* ── MCP helpers ─────────────────────────────────────────────────────────────── */

const ilkMetin = (res) => String(res?.content?.[0]?.text ?? "");

/**
 * Starts dist/index.js over stdio and connects with a client that advertises the
 * elicitation FORM capability. The simulation channel and the demo approver's number are
 * passed in the SPAWN ENVIRONMENT; the Google credentials come from the server's own .env
 * loading, and shell variables prefixed GOOGLE_ADS_ and AEGIS_ are forwarded verbatim.
 */
async function sunucuBaslat(simDegeri, elicitHandler) {
  const env = getDefaultEnvironment();
  for (const [k, v] of Object.entries(process.env)) {
    if ((k.startsWith("GOOGLE_ADS_") || k.startsWith("AEGIS_")) && v !== undefined) env[k] = v;
  }
  env.AEGIS_NAC_SIMULATE = simDegeri;
  env.AEGIS_APPROVER_PHONE = DEMO_TELEFON;

  /**
   * THE REAL TOKEN IS DELIBERATELY BLANKED.
   *
   * The server treats the token and the simulation variable being defined TOGETHER as a
   * contradictory configuration and refuses to spend — under ambiguity, the looser channel is
   * not chosen. That rule is right and must stay — but it also breaks the stage demo: the
   * moment a real AEGIS_NAC_TOKEN is present in .env, the loop above copies it into the spawn
   * environment and every act ends in a "contradictory configuration" refusal. This actually
   * happened: on the day the token arrived, the demo stopped working with nothing changed in
   * the code.
   *
   * An empty string is enough: config.ts reads it with `?.trim() || undefined`, so an empty
   * value means "undefined". And because the server loads .env itself, SKIPPING the variable
   * is not sufficient — it has to be overwritten as empty.
   *
   * The demo is a SIMULATION showcase; for a real CAMARA query the checklist in
   * `docs/CAMARA.md` §3 is followed, not the demo.
   */
  env.AEGIS_NAC_TOKEN = "";

  const client = new Client(
    { name: "aegis-demo-senaryo", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } } // form yeteneği açıkça İLAN edilir
  );
  client.setRequestHandler(ElicitRequestSchema, elicitHandler);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, "dist", "index.js")],
    cwd: ROOT,
    env,
  });
  await client.connect(transport);
  return client;
}

const DURUM_ADLARI = { 2: "ENABLED", 3: "PAUSED", 4: "REMOVED" };
const durumAdi = (d) => (typeof d === "number" ? DURUM_ADLARI[d] ?? String(d) : String(d ?? "?"));

/** Runs run_gaql, which is read-only, and returns the rows. */
async function gaqlSatirlar(client, sorgu, limit = 50) {
  const res = await client.callTool({ name: "run_gaql", arguments: { customerId: MUSTERI, query: sorgu, limit } });
  if (res.isError) throw new Error(`Okuma başarısız (run_gaql): ${ilkMetin(res)}`);
  const satirlar = res.structuredContent?.satirlar;
  if (Array.isArray(satirlar)) return satirlar;
  // With no structuredContent, fall back to the JSON in the text, in the ":\n[...]" form.
  const m = ilkMetin(res).match(/:\n(\[[\s\S]*\])\s*$/);
  return m ? JSON.parse(m[1]) : [];
}

/** Reads the candidate campaigns and their current budgets with run_gaql, read-only and
 * sorted. */
async function kampanyalariOku(client, kampanyaId) {
  const sorgu = kampanyaId
    ? `SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${Number(kampanyaId)} LIMIT 1`
    : `SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED' LIMIT 50`;
  const satirlar = await gaqlSatirlar(client, sorgu, 50);
  const adaylar = satirlar
    .map((r) => ({
      id: String(r?.campaign?.id ?? ""),
      ad: String(r?.campaign?.name ?? "(adsız)"),
      durum: durumAdi(r?.campaign?.status),
      butce: Number(r?.campaign_budget?.amount_micros) / 1e6,
    }))
    .filter((k) => k.id && Number.isFinite(k.butce) && k.butce > 0);
  if (!adaylar.length) {
    throw new Error(
      kampanyaId
        ? `Kampanya ${kampanyaId} bulunamadı ya da bütçesi okunamadı.`
        : "Hesapta bütçesi okunabilen kampanya yok — --kampanya ile kimlik ver."
    );
  }
  // For the automatic pick: PAUSED first, then the smallest budget — the lowest risk of
  // hitting the ceiling clamp, and under --canli the least dangerous candidate too.
  adaylar.sort((a, b) => (a.durum === "PAUSED" ? 0 : 1) - (b.durum === "PAUSED" ? 0 : 1) || a.butce - b.butce);
  return adaylar;
}

/** The single candidate for Acts 1 and 2: the least dangerous campaign. */
async function kampanyaOku(client, kampanyaId) {
  return (await kampanyalariOku(client, kampanyaId))[0];
}

/** Reads the account's daily budget ceiling from the READ-ONLY limits resource; undefined
 * when it cannot be read. */
async function tavanOku(client) {
  try {
    const res = await client.readResource({ uri: `aegis://accounts/${MUSTERI}/limits` });
    const tavan = Number(JSON.parse(String(res?.contents?.[0]?.text ?? "{}"))?.gunlukButceTavani);
    return Number.isFinite(tavan) ? tavan : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Act 3's candidate. BEFORE reaching the network gate, set_campaign_status passes two other
 * gates: (1) the campaign's daily budget must not exceed the account's safety ceiling, and
 * (2) it must have a servable ad, meaning an ENABLED ad in an ENABLED ad group. On a campaign
 * that trips either of those, the act cannot show the network evidence — so the candidate is
 * verified IN ADVANCE with read-only queries, and if no suitable candidate exists the act is
 * honestly skipped rather than producing fabricated evidence.
 *
 * Going live under --canli only makes sense on a PAUSED campaign: on one that is already
 * live, the reversal step would STOP it — and we do not pause someone else's live
 * campaign.
 */
async function yayinaAdayBul(client, tercihId, tavan) {
  const adaylar = await kampanyalariOku(client, tercihId);
  const reklamli = new Set(
    (
      await gaqlSatirlar(
        client,
        `SELECT campaign.id, ad_group_ad.ad.id FROM ad_group_ad WHERE ad_group_ad.status = 'ENABLED' AND ad_group.status = 'ENABLED' LIMIT 200`,
        200
      )
    )
      .map((r) => String(r?.campaign?.id ?? ""))
      .filter(Boolean)
  );
  const tavanUygun = (k) => tavan === undefined || k.butce <= tavan;

  if (tercihId) {
    const k = adaylar[0];
    if (!reklamli.has(k.id)) {
      return { hazir: false, kampanya: k, neden: `"${k.ad}" (#${k.id}) içinde yayınlanabilir reklam yok — ön kapı ağ kapısından önce cevap verir.` };
    }
    if (!tavanUygun(k)) {
      return { hazir: false, kampanya: k, neden: `"${k.ad}" (#${k.id}) günlük bütçesi ${k.butce}, hesabın güvenlik tavanı ${tavan} — ön kapı ağ kapısından önce cevap verir.` };
    }
    return { hazir: true, kampanya: k };
  }

  const uygun = adaylar.filter((k) => k.durum === "PAUSED" && reklamli.has(k.id) && tavanUygun(k));
  if (!uygun.length) {
    return {
      hazir: false,
      neden: "hesapta yayına hazır (PAUSED + yayınlanabilir reklamı olan + tavan altı) kampanya bulunamadı.",
    };
  }
  return { hazir: true, kampanya: uygun[0] };
}

/**
 * Returns the campaign to PAUSED and verifies the status BY READING IT BACK — believing the
 * tool's response is not enough, because a campaign left live spends real money. It retries
 * once.
 */
async function duraklatVeDogrula(client, kampanya) {
  for (let deneme = 1; deneme <= 2; deneme++) {
    try {
      const res = await client.callTool({
        name: "set_campaign_status",
        arguments: { customerId: MUSTERI, campaignId: kampanya.id, status: "PAUSED" },
      });
      yaz(soluk(`Geri alma denemesi ${deneme}: ${ilkMetin(res)}`));
      const [satir] = await gaqlSatirlar(
        client,
        `SELECT campaign.id, campaign.status FROM campaign WHERE campaign.id = ${Number(kampanya.id)} LIMIT 1`,
        1
      );
      if (durumAdi(satir?.campaign?.status) === "PAUSED") return true;
      yaz(kirmizi(`Geri alma denemesi ${deneme}: durum hâlâ ${durumAdi(satir?.campaign?.status)}.`));
    } catch (e) {
      yaz(kirmizi(`Geri alma denemesi ${deneme} hata verdi: ${e?.message ?? e}`));
    }
    await bekle(1500);
  }
  return false;
}

/** The reversal could not be verified: no staying quiet — SHOUT on screen. */
function geriAlmaBagir(kampanya) {
  kutu(
    "ACİL — ELLE MÜDAHALE GEREKİYOR",
    [
      "!!! GERİ ALMA DOĞRULANAMADI — KAMPANYA HÂLÂ YAYINDA OLABİLİR !!!",
      `Kampanya: "${kampanya?.ad ?? "?"}" (#${kampanya?.id ?? "?"}) · Hesap: ${MUSTERI ?? "?"}`,
      "GERÇEK PARA HARCANIYOR OLABİLİR — ŞİMDİ ELLE DURAKLAT:",
      "  Google Ads arayüzü → Kampanyalar → kampanyayı duraklat",
      `  ya da MCP: set_campaign_status(customerId=${MUSTERI ?? "?"}, campaignId=${kampanya?.id ?? "?"}, status="PAUSED")`,
      "(Duraklatma onay istemez; harcamayı azaltan işlemler her zaman serbesttir.)",
    ],
    kirmizi
  );
}

/**
 * Extracts the network-verification evidence lines — the chain's links — from the prompt
 * text. How many links there are depends on how much evidence the server attached; the script
 * fabricates none of them.
 */
function kanitSatirlari(mesaj) {
  return mesaj
    .split("\n")
    .map((s) => s.replace(/^[•\s]+/, "").trim())
    .filter((s) => /doğrulama|SİMÜLASYON/i.test(s));
}

/* ── Senaryo ─────────────────────────────────────────────────────────────────── */

let istemci; // her perdede yeniden atanır; finally'de kapatılır
let cikisKodu = 0;
const ozet = []; // karşılaştırma tablosu satırları
const EYLEM_BUTCE = "bütçe +1 (MEDIUM/24s)";
const EYLEM_YAYIN = `yayına alma (HIGH/${PENCERE_YUKSEK}s)`;
/** Act 3/A's live rehearsal: the campaign counts as "live" until proven otherwise — it
 * fails closed. */
let perde3Kampanya;
let perde3GeriAlinmadi = false;

/**
 * THE SAFETY INTERLOCK — one place, one truth.
 *
 * If, in Act 3/A's live rehearsal, it CANNOT BE PROVEN that the campaign taken live returned
 * to PAUSED, we do not stay quiet: the red emergency box is printed and the exit code becomes
 * 1. Binding that flag to the exit code happens in THIS function; the run's finally block and
 * the hidden --kendini-sina path both call the SAME function, so the path under test is
 * exactly the path the live rehearsal uses, with no duplicated code.
 *
 * @returns whether the interlock fired
 */
function guvenlikKilidiniUygula() {
  if (!perde3GeriAlinmadi) return false;
  geriAlmaBagir(perde3Kampanya);
  cikisKodu = 1;
  process.exitCode = 1;
  return true;
}

/**
 * Death by signal SKIPS the finally block.
 *
 * In Act 3/A's live rehearsal there is a short but real window between the campaign being set
 * to ENABLED and its return to PAUSED. Press Ctrl+C in that window and Node's default
 * behaviour ends the process without running the finally: no emergency box is printed, the
 * exit code is not 1, and the campaign stays live spending real money. This hook carries the
 * interlock's promise — that however the run ends, this is what speaks last — onto the signal
 * path too. When the interlock does not fire, outside the danger window, the signal ends the
 * process the usual way, with code 128 plus the signal number.
 */
for (const sinyal of ["SIGINT", "SIGTERM"]) {
  process.on(sinyal, () => {
    const tetiklendi = guvenlikKilidiniUygula();
    if (tetiklendi) {
      console.error(
        kirmizi(`\n${sinyal} ile yarıda kesildi — YUKARIDAKİ KAMPANYA HÂLÂ YAYINDA OLABİLİR.`)
      );
      process.exit(1);
    }
    process.exit(sinyal === "SIGINT" ? 130 : 143);
  });
}

/**
 * The hidden --kendini-sina: it DOES NOT PLAY the scenario, it only proves in both
 * directions that the safety interlock really is wired up — reversal verified means no box
 * and code 0; not verified means the box and code 1. If the check cannot confirm its own
 * expectation it exits 2: better a loud break than quietly passing as "the interlock was
 * tested".
 */
if (KENDINI_SINA) {
  yaz(kalin("KENDİNİ SINAMA — Perde 3 güvenlik kilidi çıkış koduna bağlı mı?"));

  perde3Kampanya = { id: "0", ad: "(kendini-sınama sahte kampanyası)", durum: "PAUSED", butce: 0 };
  perde3GeriAlinmadi = false;
  if (guvenlikKilidiniUygula() !== false || cikisKodu !== 0 || process.exitCode) {
    console.error(kirmizi("KENDİNİ SINAMA BAŞARISIZ: geri alma DOĞRULANMIŞKEN kilit tetiklendi."));
    process.exit(2);
  }
  yaz(yesil("  1/2  perde3GeriAlinmadi=false → acil kutusu YOK, çıkış kodu 0 (beklenen)."));

  perde3GeriAlinmadi = true;
  const tetiklendi = guvenlikKilidiniUygula();
  if (!tetiklendi || cikisKodu !== 1 || process.exitCode !== 1) {
    console.error(kirmizi("KENDİNİ SINAMA BAŞARISIZ: geri alma DOĞRULANAMAMIŞKEN çıkış kodu 1 olmadı."));
    process.exit(2);
  }
  yaz(yesil("  2/2  perde3GeriAlinmadi=true → acil kutusu basıldı, çıkış kodu 1 (beklenen)."));
  yaz(kalin(`Kilit bağlı: bayrak çıkış kodunu ${cikisKodu} yaptı — aynı fonksiyonu koşunun finally'si de çağırır.`));
  process.exit(cikisKodu); // 1 — kilidin çıkış kodunu gerçekten bozduğunun kanıtı
}

try {
  kutu(
    "AEGIS DEMO — Ağ Doğrulamalı Onay (Aegis MCP, LLM'siz)",
    [
      "Gerçek sunucu, gerçek MCP protokolü, gerçek Google Ads okuması.",
      `Mod: ${CANLI ? "CANLI (yazma araçları GERÇEKTEN çağrılır)" : "KURU (gerçek yazma yok; --canli ile açılır)"}`,
      `Müşteri: ${MUSTERI}   Onaylayıcı (demo): ${DEMO_TELEFON} — spawn env ile geçirildi`,
      "SIM Swap kanalı: SİMÜLASYON (AEGIS_NAC_SIMULATE) — gerçek ağ sorgusu yapılmaz.",
      `Perde 1: ${EYLEM_BUTCE} · Perde 2: aynı istek, SIM değişmiş · Perde 3: ${EYLEM_YAYIN}`,
      ...(ZINCIR_2
        ? ["Zincirin 2. halkası etkin (AEGIS_NV_SIMULATE tanımlı) — kanıt satırı Perde 3'te vurgulanır."]
        : []),
    ],
    kalin
  );
  await bekle(900);

  /* ── ACT 1: the network is clean ───────────────────────────────────────────── */
  await perdeBasligi(1, `AEGIS_NAC_SIMULATE=temiz — ağ temiz: onay akışı normal işler`);

  let perde1IstemSayisi = 0;
  let perde1KanitVar = false;
  let perde1OperatorOnayi = false;
  istemci = await sunucuBaslat("temiz", async (req) => {
    perde1IstemSayisi++;
    const mesaj = String(req.params.message);
    kutu("ONAY İSTEMİ (gerçek MCP elicitation)", mesaj.split("\n"), sari);
    if (!CANLI) {
      // Dry mode should never reach here; if it does, refuse fail-closed rather than
      // blocking on stdin.
      yaz(kirmizi("[kuru] modda onay istemi beklenmiyordu — demo güvenlik gereği 'hayır' dedi."));
      return { action: "decline" };
    }
    if (!(/SİMÜLASYON/.test(mesaj) && /SIM değişimi yok/.test(mesaj))) {
      // Without the expected simulation evidence something has gone wrong — refuse,
      // fail-closed.
      yaz(kirmizi("Beklenen SİMÜLASYON kanıt satırı istemde YOK — demo güvenlik gereği 'hayır' dedi."));
      return { action: "decline" };
    }
    perde1KanitVar = true;
    // The decision is NOT the script's but the keyboard's: only an exact 'Evet' is accepted.
    const cevap = await operatoreSor("Operatör kararı — bütçe artışını onaylıyor musun? (yalnız 'Evet' kabul edilir): ");
    if (cevap === "Evet") {
      perde1OperatorOnayi = true;
      yaz(yesil("Operatör klavyeden 'Evet' yazdı → onay verildi."));
      return { action: "accept", content: { onay: true } };
    }
    yaz(sari(`Operatör '${cevap || "(boş)"}' yazdı ('Evet' değil) → istem reddedildi.`));
    return { action: "decline" };
  });
  yaz(soluk("Sunucu süreci 1 başlatıldı (stdio) — araçlar yüklendi."));
  await bekle();

  const kampanya = await kampanyaOku(istemci, KAMPANYA_ARG);
  const hedefButce = Math.round((kampanya.butce + 1) * 100) / 100;
  yaz(`Kampanya: ${kalin(`"${kampanya.ad}"`)} (#${kampanya.id}, ${kampanya.durum}) — mevcut günlük bütçe: ${kalin(kampanya.butce)}`);
  yaz(`Deneme: ${cyan(`update_campaign_budget ${kampanya.butce} → ${hedefButce}`)} (küçük artış — onay + ağ kapısı gerektirir)`);
  await bekle();

  if (!CANLI) {
    yaz(sari("[kuru] araç çağrısı atlandı — gerçek yazma yapılmadı (--canli bayrağı verilirse gerçekten çağrılır)."));
    yaz(
      soluk(
        "      Aşağıdaki TAHMİNDİR — onay istemi ve kanıt satırı yalnız --canli provasında gerçekten görünür:\n" +
          "      --canli akışında ağ kapısı önce çalışır ve onay istemine şu kanıt satırı eklenir:\n" +
          `      "Ağ doğrulaması [SİMÜLASYON]: SIM değişimi yok (son 24 saat, ...)" — kararı klavyeden operatör verir.`
      )
    );
    ozet.push({
      perde: "1",
      eylem: EYLEM_BUTCE,
      sim: "temiz",
      karar: "[kuru] koşulmadı",
      istem: "[kuru] çağrıya gelinmedi",
      yazma: "[kuru] atlandı",
    });
  } else {
    const res = await istemci.callTool(
      {
        name: "update_campaign_budget",
        arguments: { customerId: MUSTERI, campaignId: kampanya.id, newDailyBudget: hedefButce },
      },
      undefined,
      ONAY_ZAMAN_ASIMI // insan klavyeye uzanırken 60 sn'lik SDK varsayılanı çağrıyı düşürürdü
    );
    const metin = ilkMetin(res);
    if (!perde1OperatorOnayi) {
      // The operator did not type 'Evet': no write was applied — that is not a demo
      // failure, it is a real decision.
      yaz(sari(`Operatör onay vermedi — sunucu yazmayı uygulamadı. Sunucu yanıtı: ${metin}`));
      ozet.push({
        perde: "1",
        eylem: EYLEM_BUTCE,
        sim: "temiz",
        karar: "GEÇER (SIM değişimi yok)",
        istem: `gösterildi (${perde1IstemSayisi}) → operatör reddetti`,
        yazma: "yok (onay verilmedi)",
      });
    } else {
      if (!/güncellendi/.test(metin) || !perde1KanitVar) {
        throw new Error(`Perde 1 beklenen BAŞARI ile bitmedi. Sunucu yanıtı:\n${metin}`);
      }
      yaz(yesil(`BAŞARI: ${metin}`));
      await bekle();
      const geri = await istemci.callTool({
        name: "update_campaign_budget",
        arguments: { customerId: MUSTERI, campaignId: kampanya.id, newDailyBudget: kampanya.butce },
      });
      yaz(soluk(`Temizlik: bütçe eski değerine döndürüldü (azaltma onay istemez) — ${ilkMetin(geri)}`));
      ozet.push({
        perde: "1",
        eylem: EYLEM_BUTCE,
        sim: "temiz",
        karar: "GEÇER (SIM değişimi yok)",
        istem: `gösterildi (${perde1IstemSayisi}) → operatör Evet yazdı`,
        yazma: "+1 uygulandı, geri alındı",
      });
    }
  }
  await istemci.close();
  istemci = undefined;
  await bekle(900);

  /* ── ACT 2: the SIM was swapped ────────────────────────────────────────────── */
  await perdeBasligi(2, `AEGIS_NAC_SIMULATE=degisti — İKİNCİ sunucu süreci: SIM değişmiş sayılır`);

  let perde2IstemSayisi = 0;
  istemci = await sunucuBaslat("degisti", async () => {
    perde2IstemSayisi++;
    return { action: "decline" }; // buraya HİÇ düşmemeli; düşerse bile fail-closed
  });
  yaz(soluk("Sunucu süreci 2 başlatıldı (stdio) — aynı istemci, aynı elicitation yeteneği."));
  await bekle();

  // The budget is RE-READ in this process: the attempt must be a definite INCREASE under
  // every condition — a call that is not an increase never reaches the network gate, and in
  // dry mode it would perform a write.
  const kampanya2 = await kampanyaOku(istemci, kampanya.id);
  const hedefButce2 = Math.round((kampanya2.butce + 1) * 100) / 100;
  yaz(`Aynı deneme: ${cyan(`update_campaign_budget ${kampanya2.butce} → ${hedefButce2}`)} — bu kez ağ "SIM değişti" diyor.`);
  yaz(soluk("(Bu çağrı kuru modda da güvenli: ağ kapısı yazmadan ÖNCE reddeder — reddetmezse demo hata verir.)"));
  await bekle();

  const res2 = await istemci.callTool({
    name: "update_campaign_budget",
    arguments: { customerId: MUSTERI, campaignId: kampanya2.id, newDailyBudget: hedefButce2 },
  });
  const metin2 = ilkMetin(res2);
  if (!/AĞ DOĞRULAMASI BAŞARISIZ/.test(metin2)) {
    throw new Error(`Perde 2 beklenen ağ retiyle bitmedi (istem sayısı: ${perde2IstemSayisi}). Sunucu yanıtı:\n${metin2}`);
  }
  kutu("RET — AĞ DOĞRULAMASI BAŞARISIZ", metin2.split("\n"), kirmizi);
  if (perde2IstemSayisi !== 0) {
    throw new Error(`GÜVENLİK İHLALİ: onay istemi ${perde2IstemSayisi} kez gösterildi — hiç gösterilmemeliydi.`);
  }
  yaz(yesil("Doğrulandı: elicitation handler HİÇ çağrılmadı (0 istem)."));
  yaz(kalin("Onay istemi insana hiç ulaşmadı — SIM'i yeni değişmiş 'onaylayıcı' saldırgan olabilir."));
  ozet.push({
    perde: "2",
    eylem: EYLEM_BUTCE,
    sim: "degisti",
    karar: "RET (ağ doğrulaması başarısız)",
    istem: "HİÇ gösterilmedi (0)",
    yazma: "yok (kapıda reddedildi)",
  });
  await istemci.close();
  istemci = undefined;
  await bekle(900);

  /* ── ACT 3: the HIGH layer of the SAME gate — going live ───────────────────── */
  await perdeBasligi(
    3,
    `set_campaign_status → ENABLED — AYNI kapı, HIGH katman: pencere 24 değil ${PENCERE_YUKSEK} saat`
  );
  yaz(soluk("İki alt sahne: 3/A ağ temiz (onay akışı işler) · 3/B SIM değişmiş (sert ret)."));

  /* ── ACT 3/A: the network is clean ─────────────────────────────────────────── */
  yaz("\n" + kalin(`── PERDE 3/A ── AEGIS_NAC_SIMULATE=temiz — yayına alma denenir`));

  let perde3aIstemSayisi = 0;
  let perde3KanitVar = false;
  let perde3OperatorOnayi = false;
  /** A closure for the handler: the campaign can only be read once the server is up, and it
   * is populated by the time the call happens. */
  let aday3;

  istemci = await sunucuBaslat("temiz", async (req) => {
    perde3aIstemSayisi++;
    const mesaj = String(req.params.message);
    kutu("ONAY İSTEMİ — YAYINA ALMA (gerçek MCP elicitation)", mesaj.split("\n"), sari);

    // The evidence lines are produced by the server; the script fabricates none of them, it
    // only extracts them and marks them against the chain's links.
    const kanitlar = kanitSatirlari(mesaj);
    const ikinciHalkaMi = (s) => /numara doğrulaması/i.test(s);
    for (const k of kanitlar) {
      yaz(ikinciHalkaMi(k) ? cyan(`  zincir 2 ▶ ${k}`) : soluk(`  zincir 1 ▶ ${k}`));
    }
    if (ZINCIR_2 && !kanitlar.some(ikinciHalkaMi)) {
      yaz(sari("AEGIS_NV_SIMULATE tanımlı ama istemde 2. halkanın kanıt satırı YOK — vurgulanacak kanıt üretilmedi."));
    }

    if (!CANLI) {
      // Dry mode should never reach here; if it does, refuse fail-closed rather than
      // blocking on stdin.
      yaz(kirmizi("[kuru] modda onay istemi beklenmiyordu — demo güvenlik gereği 'hayır' dedi."));
      return { action: "decline" };
    }
    // The HIGH layer's proof is the window: where medium is 24 hours, this must be
    // PENCERE_YUKSEK hours.
    if (!(/SİMÜLASYON/.test(mesaj) && new RegExp(`son ${PENCERE_YUKSEK} saat`).test(mesaj))) {
      yaz(kirmizi(`Beklenen HIGH kanıt satırı (SİMÜLASYON + "son ${PENCERE_YUKSEK} saat") istemde YOK — demo güvenlik gereği 'hayır' dedi.`));
      return { action: "decline" };
    }
    perde3KanitVar = true;
    // The decision is NOT the script's but the keyboard's: only an exact 'Evet' is accepted.
    const cevap = await operatoreSor(
      `Operatör kararı — "${aday3?.ad ?? "?"}" (#${aday3?.id ?? "?"}) GERÇEKTEN yayına alınsın mı? (yalnız 'Evet' kabul edilir): `
    );
    if (cevap === "Evet") {
      perde3OperatorOnayi = true;
      yaz(yesil("Operatör klavyeden 'Evet' yazdı → onay verildi (sahne sonunda geri alınacak)."));
      return { action: "accept", content: { onay: true } };
    }
    yaz(sari(`Operatör '${cevap || "(boş)"}' yazdı ('Evet' değil) → istem reddedildi.`));
    return { action: "decline" };
  });
  yaz(soluk("Sunucu süreci 3 başlatıldı (stdio) — aynı istemci, bu kez HIGH katman denenecek."));
  await bekle();

  const tavan = await tavanOku(istemci);
  yaz(soluk(`Hesabın günlük bütçe tavanı (salt-okunur limits kaynağı): ${tavan ?? "okunamadı"}`));
  const aday = await yayinaAdayBul(istemci, KAMPANYA_ARG, tavan);

  if (!aday.hazir) {
    // No fabricated evidence: on a campaign that trips the pre-gates, the network gate never
    // speaks at all.
    kutu(
      "PERDE 3 ATLANDI — uydurma kanıt üretilmez",
      [
        aday.neden,
        "Ön kapılar (bütçe tavanı + yayınlanabilir reklam) AĞ kapısından ÖNCE cevap verir;",
        "böyle bir kampanyada bu perde ağ kanıtını gösteremez — o yüzden dürüstçe atlanır.",
        "Uygun aday: PAUSED + yayınlanabilir reklamı olan + tavan altı kampanya (--kampanya ile de verilebilir).",
      ],
      sari
    );
    for (const alt of ["3/A", "3/B"]) {
      ozet.push({
        perde: alt,
        eylem: EYLEM_YAYIN,
        sim: alt === "3/A" ? "temiz" : "degisti",
        karar: "atlandı (uygun aday yok)",
        istem: "gösterilmedi (perde koşmadı)",
        yazma: "yok (perde koşmadı)",
      });
    }
    await istemci.close();
    istemci = undefined;
  } else {
    aday3 = aday.kampanya;
    yaz(
      `Yayın adayı: ${kalin(`"${aday3.ad}"`)} (#${aday3.id}, ${aday3.durum}) — günlük bütçe: ${kalin(aday3.butce)}` +
        (tavan === undefined ? "" : ` (hesap tavanı ${tavan})`)
    );
    yaz(`Deneme: ${cyan(`set_campaign_status #${aday3.id} → ENABLED`)} (HIGH katman — ${PENCERE_YUKSEK} saatlik pencere)`);
    await bekle();

    // The live rehearsal runs ONLY on a PAUSED campaign: on one that is already live, the
    // reversal step would STOP it — and we do not pause someone else's live campaign.
    const canliProva = CANLI && aday3.durum === "PAUSED";
    if (CANLI && !canliProva) {
      yaz(
        sari(
          `[canlı atlandı] "${aday3.ad}" (#${aday3.id}) PAUSED değil (${aday3.durum}) — ` +
            "sahne sonundaki geri alma adımı zaten yayındaki bir kampanyayı DURDURURDU."
        )
      );
    }

    if (!canliProva) {
      if (!CANLI) {
        yaz(sari("[kuru] araç çağrısı atlandı — kampanya yayına ALINMADI (--canli bayrağı verilirse gerçekten alınır ve geri alınır)."));
      }
      yaz(
        soluk(
          "      Aşağıdaki TAHMİNDİR — onay istemi ve kanıt satırları yalnız --canli provasında gerçekten görünür:\n" +
            `      "Ağ doğrulaması [SİMÜLASYON]: SIM değişimi yok (son ${PENCERE_YUKSEK} saat, ...)" — HIGH katman penceresi\n` +
            (ZINCIR_2
              ? '      "Numara doğrulaması [SİMÜLASYON]: ... cihazından geliyor SAYILDI" — zincirin 2. halkası (AEGIS_NV_SIMULATE tanımlı)\n'
              : "") +
            "      kararı klavyeden operatör verir; sahne biter bitmez kampanya PAUSED'a alınır ve durum GERİ OKUNUR."
        )
      );
      ozet.push({
        perde: "3/A",
        eylem: EYLEM_YAYIN,
        sim: "temiz",
        karar: CANLI ? `atlandı (${aday3.durum} — PAUSED değil)` : "[kuru] koşulmadı",
        istem: CANLI ? "gösterilmedi (perde koşmadı)" : "[kuru] çağrıya gelinmedi",
        yazma: CANLI ? "yok (atlandı)" : "[kuru] atlandı",
      });
    } else {
      // Fail closed: count it as live BEFORE the call. The flag stays up until the contrary
      // is PROVEN; however the run ends, the safety interlock in the finally shouts and
      // breaks the exit code.
      perde3Kampanya = aday3;
      perde3GeriAlinmadi = true;

      let metin3 = "";
      let cagriHatasi;
      try {
        const res3 = await istemci.callTool(
          {
            name: "set_campaign_status",
            arguments: { customerId: MUSTERI, campaignId: aday3.id, status: "ENABLED" },
          },
          undefined,
          ONAY_ZAMAN_ASIMI // insan klavyeye uzanırken 60 sn'lik SDK varsayılanı çağrıyı düşürürdü
        );
        metin3 = ilkMetin(res3);
      } catch (e) {
        // The call dropped: whether the write happened is UNKNOWN. The decision is left to
        // the read-back below — the assumption "I got an error, so nothing was written"
        // would miss precisely the silent left-live case the interlock exists to catch.
        cagriHatasi = e?.message ?? String(e);
        yaz(kirmizi(`Yayına alma çağrısı hata verdi: ${cagriHatasi}`));
      }

      // The tool's response is NOT BELIEVED: under every condition the real status is READ
      // BACK from the account.
      let suanki;
      try {
        const [satir3] = await gaqlSatirlar(
          istemci,
          `SELECT campaign.id, campaign.status FROM campaign WHERE campaign.id = ${Number(aday3.id)} LIMIT 1`,
          1
        );
        suanki = durumAdi(satir3?.campaign?.status);
      } catch (e) {
        yaz(kirmizi(`Durum geri okunamadı (${e?.message ?? e}) — güvenli varsayım: kampanya YAYINDA sayılır.`));
        suanki = "ENABLED";
      }

      if (suanki === "ENABLED") {
        // If the call errored, this is not a success but a campaign quietly left live.
        yaz(
          cagriHatasi
            ? kirmizi(`YAYINDA — çağrı hata verdi ama kampanya ENABLED okundu (tam da kilidin varlık sebebi).`)
            : yesil(`YAYINDA (hesaptan geri okundu: ${suanki}) — ${metin3}`)
        );
        await bekle();
        yaz(soluk("Sahne bitti — kampanya PAUSED'a geri alınıyor ve durum GERİ OKUNARAK doğrulanıyor..."));
        const geriAlindi = await duraklatVeDogrula(istemci, aday3);
        perde3GeriAlinmadi = !geriAlindi;
        ozet.push({
          perde: "3/A",
          eylem: EYLEM_YAYIN,
          sim: "temiz",
          karar: "GEÇER (SIM değişimi yok)",
          istem: cagriHatasi
            ? `gösterildi (${perde3aIstemSayisi}) → çağrı düştü`
            : `gösterildi (${perde3aIstemSayisi}) → operatör Evet yazdı`,
          yazma: geriAlindi ? "ENABLED, geri alındı (doğrulandı)" : "ENABLED — GERİ ALINAMADI (!)",
        });
        if (geriAlindi) {
          yaz(yesil("Geri alma DOĞRULANDI: kampanya yeniden PAUSED (durum hesaptan geri okundu)."));
        } else {
          yaz(kirmizi("GERİ ALMA DOĞRULANAMADI — ayrıntı ve elle müdahale adımları koşunun EN SONUNDA."));
        }
      } else {
        // It never went live: there is nothing to reverse and the interlock lifts. The flag
        // comes down ONLY by reading the status back from the account; when that read
        // fails, the catch above assumes "ENABLED" and the interlock stays up, preserving
        // the fail-closed behaviour.
        perde3GeriAlinmadi = false;
        perde3Kampanya = undefined;
        if (cagriHatasi) {
          // The call dropped but the campaign was NOT taken live, as the read-back shows —
          // so end with an honest demo error rather than sounding a false emergency.
          throw new Error(
            `Perde 3/A çağrısı tamamlanamadı: ${cagriHatasi}\n` +
              `Kampanya #${aday3.id} yayına ALINMADI — durum hesaptan geri okundu: ${suanki}.`
          );
        }
        if (/NUMARA DOĞRULAMASI BAŞARISIZ/.test(metin3)) {
          // The chain's second link refused: even with a clean SIM Swap, the prompt is not
          // shown.
          kutu("RET — NUMARA DOĞRULAMASI BAŞARISIZ (zincirin 2. halkası)", metin3.split("\n"), kirmizi);
          if (perde3aIstemSayisi !== 0) {
            throw new Error(`GÜVENLİK İHLALİ: 2. halka reddederken onay istemi ${perde3aIstemSayisi} kez gösterildi.`);
          }
          yaz(yesil("Doğrulandı: SIM Swap temiz olsa da 2. halka reddetti ve istem HİÇ gösterilmedi (0)."));
          ozet.push({
            perde: "3/A",
            eylem: EYLEM_YAYIN,
            sim: "temiz",
            karar: "RET (numara doğrulaması — zincir 2)",
            istem: "HİÇ gösterilmedi (0)",
            yazma: `yok (geri okundu: ${suanki})`,
          });
        } else if (perde3aIstemSayisi > 0 && !perde3OperatorOnayi) {
          // The operator did not type 'Evet': no write was applied — that is not a demo
      // failure, it is a real decision.
          yaz(sari(`Operatör onay vermedi — sunucu kampanyayı yayına almadı. Sunucu yanıtı: ${metin3}`));
          ozet.push({
            perde: "3/A",
            eylem: EYLEM_YAYIN,
            sim: "temiz",
            karar: "GEÇER (SIM değişimi yok)",
            istem: `gösterildi (${perde3aIstemSayisi}) → operatör reddetti`,
            yazma: `yok (geri okundu: ${suanki})`,
          });
        } else {
          throw new Error(
            `Perde 3/A beklenmedik şekilde bitti (istem ${perde3aIstemSayisi}, kanıt ${perde3KanitVar}, ` +
              `durum ${suanki}). Sunucu yanıtı:\n${metin3}`
          );
        }
      }
    }
    await istemci.close();
    istemci = undefined;
    await bekle(900);

    /* ── ACT 3/B: the SIM was swapped — a hard refusal, the prompt NEVER shown ─── */
    if (perde3GeriAlinmadi) {
      // While a campaign may still be live, no new write is attempted.
      yaz(kirmizi("Perde 3/B atlandı: 3/A'nın geri alması doğrulanana kadar başka yazma denenmez."));
      ozet.push({
        perde: "3/B",
        eylem: EYLEM_YAYIN,
        sim: "degisti",
        karar: "atlandı (3/A geri alınamadı)",
        istem: "gösterilmedi (perde koşmadı)",
        yazma: "yok (perde koşmadı)",
      });
    } else {
      yaz("\n" + kalin("── PERDE 3/B ── AEGIS_NAC_SIMULATE=degisti — AYNI yayına alma isteği"));
      let perde3bIstemSayisi = 0;
      istemci = await sunucuBaslat("degisti", async () => {
        perde3bIstemSayisi++;
        return { action: "decline" }; // buraya HİÇ düşmemeli; düşerse bile fail-closed
      });
      yaz(soluk("Sunucu süreci 4 başlatıldı (stdio) — aynı aday, aynı araç, tek fark ağın cevabı."));
      await bekle();
      yaz(`Aynı deneme: ${cyan(`set_campaign_status #${aday3.id} → ENABLED`)} — bu kez ağ "SIM değişti" diyor.`);
      yaz(soluk("(Ön kapılar 3/A'da geçildi; cevabı veren AĞ kapısıdır. Kuru modda da güvenli: kapı yazmadan ÖNCE reddeder.)"));
      await bekle();

      const res3b = await istemci.callTool({
        name: "set_campaign_status",
        arguments: { customerId: MUSTERI, campaignId: aday3.id, status: "ENABLED" },
      });
      const metin3b = ilkMetin(res3b);
      if (!/AĞ DOĞRULAMASI BAŞARISIZ/.test(metin3b)) {
        throw new Error(`Perde 3/B beklenen ağ retiyle bitmedi (istem sayısı: ${perde3bIstemSayisi}). Sunucu yanıtı:\n${metin3b}`);
      }
      kutu(`RET — AĞ DOĞRULAMASI BAŞARISIZ (HIGH katman, ${PENCERE_YUKSEK} saat)`, metin3b.split("\n"), kirmizi);
      if (perde3bIstemSayisi !== 0) {
        throw new Error(`GÜVENLİK İHLALİ: onay istemi ${perde3bIstemSayisi} kez gösterildi — hiç gösterilmemeliydi.`);
      }
      yaz(yesil("Doğrulandı: elicitation handler HİÇ çağrılmadı (0 istem)."));
      if (!new RegExp(`son ${PENCERE_YUKSEK} saat`).test(metin3b)) {
        yaz(sari(`Uyarı: ret metninde "son ${PENCERE_YUKSEK} saat" geçmiyor — HIGH pencere beklendiği gibi değil.`));
      } else {
        yaz(kalin(`Perde 2'nin 24 saatlik penceresi burada ${PENCERE_YUKSEK} saat: aynı kapı, daha riskli eylem, daha geniş bakış.`));
      }

      // We look at the account, not at what we were told: that no write happened is verified
      // BY READING IT BACK.
      let durumB;
      try {
        const [satirB] = await gaqlSatirlar(
          istemci,
          `SELECT campaign.id, campaign.status FROM campaign WHERE campaign.id = ${Number(aday3.id)} LIMIT 1`,
          1
        );
        durumB = durumAdi(satirB?.campaign?.status);
      } catch (e) {
        durumB = `okunamadı (${e?.message ?? e})`;
      }
      // If the candidate was already handed to us as ENABLED, which is possible only in dry
      // mode, that is not a violation.
      if (durumB === "ENABLED" && aday3.durum !== "ENABLED") {
        throw new Error(`GÜVENLİK İHLALİ: ret metnine rağmen kampanya #${aday3.id} ENABLED okundu.`);
      }
      yaz(soluk(`Geri okuma: kampanya #${aday3.id} durumu ${durumB} — yazma yapılmadı.`));
      ozet.push({
        perde: "3/B",
        eylem: EYLEM_YAYIN,
        sim: "degisti",
        karar: "RET (ağ doğrulaması başarısız)",
        istem: "HİÇ gösterilmedi (0)",
        yazma: `yok (geri okundu: ${durumB})`,
      });
      await istemci.close();
      istemci = undefined;
      await bekle(900);
    }
  }

  /* ── The summary table ─────────────────────────────────────────────────────── */
  yaz("\n" + kalin("═══ ÖZET — üç perdenin karşılaştırması ════════════════════════════"));
  const basliklar = {
    perde: "Perde",
    eylem: "Eylem",
    sim: "NAC_SIMULATE",
    karar: "Ağ kararı",
    istem: "Onay istemi",
    yazma: "Yazma",
  };
  const kolonlar = Object.keys(basliklar);
  const gen = Object.fromEntries(
    kolonlar.map((k) => [k, Math.max(basliklar[k].length, ...ozet.map((s) => String(s[k]).length))])
  );
  const cizgi = (sol, orta, sag) => sol + kolonlar.map((k) => "─".repeat(gen[k] + 2)).join(orta) + sag;
  const satir = (h) => "│ " + kolonlar.map((k) => String(h[k]).padEnd(gen[k])).join(" │ ") + " │";
  yaz(cizgi("┌", "┬", "┐"));
  yaz(satir(basliklar));
  yaz(cizgi("├", "┼", "┤"));
  for (const s of ozet) yaz(satir(s));
  yaz(cizgi("└", "┴", "┘"));
  yaz(kalin("\nAynı ajan, aynı istek, aynı sunucu kodu — tek fark ağın verdiği cevap."));
  yaz(`Katman farkı: bütçe artışı 24 saatlik pencereden, yayına alma ${PENCERE_YUKSEK} saatlik pencereden geçer.`);
  yaz("Fail-closed: ağ 'değişti' ya da 'yanıtsız' olduğunda harcama artışı uygulanmaz, istem insana gösterilmez.");
  yaz(soluk("Not: tüm ağ metinleri SİMÜLASYON etiketlidir; gerçek CAMARA sorgusu için AEGIS_NAC_TOKEN kullanılır.\n"));
} catch (e) {
  console.error(kirmizi(`\nDEMO HATASI: ${e?.message ?? e}`));
  cikisKodu = 1;
} finally {
  if (istemci) await istemci.close().catch(() => {});
  // THE SAFETY INTERLOCK: however the run ends — success, error, an unexpected throw —
  // this speaks last. Standing at the END of the screen is deliberate: the box stays below
  // the summary table rather than scrolling above it. --kendini-sina exercises the interlock
  // through this same function.
  guvenlikKilidiniUygula();
}
process.exitCode = cikisKodu;
process.exit(cikisKodu);
