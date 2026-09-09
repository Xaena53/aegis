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
 * With the --canli flag it really is called, as a small increase of one unit, and the budget is
 * returned to its old value, since a decrease needs no approval. Whether it really came back is
 * decided by READING THE BUDGET BACK from the account, not by the tool's answer — and the same
 * read-back is what says whether a write happened at all, because "the operator declined" is
 * not by itself proof that nothing was written. Under --canli the approval decision is NOT the
 * script's: it belongs to a real operator typing 'Evet' at the keyboard, through readline.
 *
 * Act 3's live rehearsal is performed ONLY on a TEST campaign that is PAUSED and named
 * explicitly with --kampanya: the campaign really is set to ENABLED, returned to PAUSED the
 * moment the scene ends, and the status is verified BY READING IT BACK. If a reversal cannot
 * be verified — a budget raise's (Act 1's or Act 2's) or Act 3's status — the script SHOUTS: a
 * red emergency box and exit code 1, because a raised budget and a campaign left live both
 * spend real money. And while such a write is still standing, no later act starts a new one.
 *
 * Acts 2 and 3/B REALLY CALL the write tool, in dry mode too: what stands between them and a
 * write is the NETWORK GATE refusing. "Expected to refuse" is not "verified", so both acts
 * READ THE ACCOUNT BACK after the call, push back whatever they find changed and, when that
 * cannot be proven, shout through the same interlock — an unreadable answer counting as
 * changed. Only after the account is back where it belongs may the missing refusal, or a
 * prompt shown even once, end the demo in an ERROR; the elicitation handler for those acts
 * ALWAYS refuses, as a fail-closed precaution. The one campaign 3/B does not push back is one
 * that --kampanya named while it was ALREADY ENABLED: that is not a write of ours to reverse,
 * and pausing it would stop someone else's live campaign. There the reservation is spoken
 * instead of shouted, and it covers BOTH readings that settle nothing: a status that could not
 * be read, and a status that reads ENABLED — the value the campaign already had, which a
 * refused write and an applied one leave looking exactly alike. Neither is reported as "no
 * write happened"; only a reading that COULD have disproved the claim is allowed to make it.
 *
 * Every act first verifies, with READ-ONLY queries, that its candidate can reach the network
 * gate at all: update_campaign_budget answers first on the account's safety ceiling and then
 * on whether the budget is SHARED, and set_campaign_status on the ceiling and on having a
 * servable ad — all of them BEFORE the network gate, and each with a text of its own. On a
 * candidate that trips one of those, the act is SKIPPED with the reason on screen instead of
 * being played, because there the network evidence cannot exist. Sharedness that the response
 * does not carry cannot be checked in advance; the refusal it produces is then reported as
 * what it is — an earlier gate's answer, never the network's.
 *
 * If AEGIS_NV_SIMULATE is defined — this script DOES NOT SET its value, it only passes it
 * through to the server processes as-is — Act 3 also highlights the evidence line of the
 * chain's second link.
 *
 * Usage:
 *   npm run demo -- --musteri <customer-id> [--kampanya <campaign-id>] [--canli]
 *   The default is DRY mode with no writes at all; --canli applies a real, small, reverted
 *   budget increase, and ONLY TOGETHER WITH --kampanya does it take that named TEST campaign
 *   live briefly. A campaign id must be digits only: an unreadable value is an error, never a
 *   silently trimmed one, because a trimmed id names a DIFFERENT campaign.
 *
 *   node scripts/demo-senaryo.mjs --kendini-sina   (hidden; needs no customer and no dist)
 *   This DOES NOT PLAY the scenario: it only proves that the safety interlock above — the
 *   "the reversal could not be verified" flags, both of them — really does print the red
 *   emergency box and set the exit code to 1. The interlock itself is called, not a copy of it.
 */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The approver's DEMO number, passed to the server in the spawn environment.
const DEMO_TELEFON = "+905550001122";

/* ── CLI ─────────────────────────────────────────────────────────────────────── */

/**
 * A flag's value, in BOTH spellings: `--kampanya 123` and `--kampanya=123`. The `=` form used
 * to be invisible here — `indexOf("--kampanya")` never matches `--kampanya=123`, so the flag
 * counted as ABSENT and the run silently fell through to the automatic candidate pick. A very
 * common habit must not quietly select a different campaign than the one that was typed.
 */
function bayrakDegeri(ad) {
  const esitli = process.argv.find((a) => a.startsWith(`${ad}=`));
  if (esitli !== undefined) return esitli.slice(ad.length + 1);
  const i = process.argv.indexOf(ad);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}
const MUSTERI = bayrakDegeri("--musteri");
/**
 * The campaign id is NOT REPAIRED. It used to be pushed through `replace(/\D/g, "")`:
 * "223-344-55" silently became 22334455 — a DIFFERENT, possibly existing campaign — and
 * "demo-test" became "" which, through `|| undefined`, turned into "no flag was given at all"
 * and dropped the run into the automatic pick. Both are silent corrections of a value that
 * decides WHICH campaign is touched, and under --canli which campaign goes live. An unreadable
 * value is an ERROR here, loudly, before any server is started or any account is read.
 */
const KAMPANYA_ARG = bayrakDegeri("--kampanya");
if (KAMPANYA_ARG !== undefined && !/^\d+$/.test(KAMPANYA_ARG)) {
  console.error(
    `Geçersiz --kampanya değeri: "${KAMPANYA_ARG}" — kampanya kimliği yalnız rakamlardan oluşur (örn. --kampanya 1234567890).`
  );
  console.error("Değer sessizce düzeltilmez: kırpılmış bir kimlik BAŞKA bir kampanyayı seçerdi.");
  process.exit(1);
}
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

/**
 * Reads the candidate campaigns, their current budgets and — the reason
 * `campaign_budget.explicitly_shared` is selected — whether that budget is SHARED, read-only
 * and sorted.
 *
 * Sharedness is candidate DATA, not decoration: update_campaign_budget refuses a shared budget
 * before it ever reaches the approval prompt, and therefore before the network gate. Only an
 * explicit `false` means "campaign-specific"; every other value — the field missing from the
 * response, null, a string — is UNKNOWN and stays unknown. Rewriting it to false is the one
 * thing that must not happen: that is how "could not be read" turns into "is safe".
 */
async function kampanyalariOku(client, kampanyaId) {
  const alanlar =
    "campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, campaign_budget.explicitly_shared";
  const sorgu = kampanyaId
    ? `SELECT ${alanlar} FROM campaign WHERE campaign.id = ${Number(kampanyaId)} LIMIT 1`
    : `SELECT ${alanlar} FROM campaign WHERE campaign.status != 'REMOVED' LIMIT 50`;
  const satirlar = await gaqlSatirlar(client, sorgu, 50);
  const adaylar = satirlar
    .map((r) => ({
      id: String(r?.campaign?.id ?? ""),
      ad: String(r?.campaign?.name ?? "(adsız)"),
      durum: durumAdi(r?.campaign?.status),
      butce: Number(r?.campaign_budget?.amount_micros) / 1e6,
      paylasimli:
        typeof r?.campaign_budget?.explicitly_shared === "boolean"
          ? r.campaign_budget.explicitly_shared
          : undefined,
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

/** The demo's own attempt in Acts 1 and 2: a raise of exactly one unit. */
const denemeButcesi = (kampanya) => Math.round((kampanya.butce + 1) * 100) / 100;

/**
 * The gates update_campaign_budget applies BEFORE the network gate (src/tools/write.ts:415 and
 * :440): the account's safety ceiling and the budget's sharedness. Each answers with a text of
 * its own, so on a campaign that trips one of them Acts 1 and 2 CANNOT show the network
 * evidence — the very situation Act 3 already checks for in advance and skips honestly instead
 * of throwing on stage. Returns the reason, or undefined when nothing is known to block it.
 *
 * A sharedness that could not be read is not called clear here — it is simply not provable
 * from the read-only surface. The server still refuses it, and that refusal is recognised by
 * onKapiRediMi, so the act reports an honest skip rather than a demo crash.
 */
function butceOnKapisi(kampanya, hedefButce, tavan) {
  if (kampanya.paylasimli === true) {
    return `"${kampanya.ad}" (#${kampanya.id}) PAYLAŞIMLI bir bütçe kullanıyor — ön kapı ağ kapısından önce cevap verir.`;
  }
  if (tavan !== undefined && hedefButce > tavan) {
    return (
      `"${kampanya.ad}" (#${kampanya.id}) günlük bütçesi ${kampanya.butce}, denenecek artış ${hedefButce}, ` +
      `hesabın güvenlik tavanı ${tavan} — ön kapı ağ kapısından önce cevap verir.`
    );
  }
  return undefined;
}

/**
 * EVERY refusal update_campaign_budget can produce BEFORE it consults the network gate, each
 * recognised by a phrase of its own: the safety ceiling, a ceiling configuration that is itself
 * broken and a non-positive amount (src/util.ts budgetGuard, called at src/tools/write.ts:415),
 * then the two sharedness answers — unreadable, and shared (src/tools/write.ts:443 and :448).
 *
 * This list is the ONLY thing that makes a refusal a front-door refusal. A new pre-gate, or a
 * reworded one, drops OUT of the list rather than into it, and lands on the loud path below —
 * which is the fail-closed direction: the stage never claims a gate that it cannot name.
 */
const ON_KAPI_RETLERI = [
  /hesabın güvenlik tavanının \(/, // requested budget over the account's safety ceiling
  /bütçe tavanı yapılandırması geçersiz/, // the ceiling itself is unusable (NaN or <= 0)
  /bütçe 0'dan büyük olmalı/, // a non-positive amount never reaches the network gate
  /kampanyaya özel mi OKUNAMADI/, // explicitly_shared absent from the response
  /PAYLAŞIMLI bir bütçe kullanıyor/, // the budget is shared with other campaigns
];

/**
 * Did a gate BEFORE the network's answer this? RECOGNISED BY NAME — never by exclusion.
 *
 * This used to read "opens with 'Reddedildi:' and does not carry 'AĞ DOĞRULAMASI'", and that
 * classified the NETWORK GATE'S OWN fail-closed refusals as front-door ones: the gate writes
 * its accusations in capitals ("AĞ DOĞRULAMASI BAŞARISIZ") but its unanswered-check refusals
 * in lower case — "Reddedildi: ağ doğrulaması tamamlanamadı — SIM Swap kontrolünden yanıt
 * alınamadı." and its siblings for the location, device-swap, call-forwarding and
 * reachability links, plus the missing-config refusals in src/networkTrust.ts and the
 * "ağ doğrulama yapılandırması onay kapısına ulaşmadı" refusal in src/approval.ts. Measured
 * against those two files, the old predicate called nearly half of the gate's own refusal
 * texts a front-door refusal. The exact moment the gate DID speak — and refused BECAUSE it
 * could not trust what it saw — was then staged as "the front door answered, the network gate
 * never spoke", and the run exited 0 telling the jury the opposite of what happened.
 *
 * So only a refusal MATCHING a known pre-gate phrase is called one. Anything unrecognised —
 * the network's own fail-closed text, a refusal from a gate added later, an error text — is
 * NOT claimed as a front-door answer: Act 2 ends loudly with the server's words on screen
 * (exit code 1) and Act 1 refuses to narrate a decision nobody made.
 *
 * This softens NOTHING: a refusal is still a refusal, no write happened, and the act goes on
 * to report that the network evidence could NOT be shown instead of claiming that it was. The
 * checks that accuse — a prompt shown even once, a budget that really moved — run BEFORE this
 * classification and are never reclassified by it.
 */
const onKapiRediMi = (metin) =>
  /Reddedildi:/.test(metin) && !/AĞ DOĞRULAMASI/.test(metin) && ON_KAPI_RETLERI.some((d) => d.test(metin));

/**
 * The single candidate for Acts 1 and 2: the least dangerous campaign whose path is not
 * ALREADY KNOWN to end at a gate before the network's.
 *
 * The old pick was "PAUSED first, then the smallest budget", and the cheapest campaign won even
 * when its budget was shared — so the act attempted a raise the server refuses at the door, and
 * Act 2 died with "beklenen ağ retiyle bitmedi" mid-demo. Ranking is a PREFERENCE, not a
 * filter: on an account where nothing is provably clear a candidate is still returned, and
 * whether the act may run at all stays butceOnKapisi's decision.
 */
async function kampanyaOku(client, kampanyaId, tavan) {
  const adaylar = await kampanyalariOku(client, kampanyaId);
  // 0 = provably clear · 1 = sharedness unknown · 2 = known to be refused before the network.
  // Array#sort is stable, so within one rank the order kampanyalariOku chose is preserved.
  const sira = (k) => (butceOnKapisi(k, denemeButcesi(k), tavan) ? 2 : k.paylasimli === false ? 0 : 1);
  return [...adaylar].sort((a, b) => sira(a) - sira(b))[0];
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
 * Reads the campaign's CURRENT daily budget back from the account; undefined when it cannot be
 * read. An unreadable budget is NOT "unchanged": every caller treats undefined as the
 * fail-closed case and goes on to revert.
 *
 * UNKNOWN IS NOT 0. `Number(null)` and `Number("")` are both 0, and 0 is a perfectly readable
 * budget — so a field arriving as null or empty used to come back as a REAL value of zero.
 * That is the very bug the server side documents at src/tools/write.ts:665 ("`?? 0` was
 * REMOVED here: it counted an unreadable budget as 0"); here it accused the server of a write
 * nobody made: read back as 0, `eskisiGibi` goes false, Act 1 performs a needless revert and,
 * when the operator declined, throws "GÜVENLİK İHLALİ ... 25 yerine 0 okundu" on stage. Only
 * a number or a non-empty string is a reading; anything else is silence.
 */
async function butceOku(client, kampanyaId) {
  try {
    const [satir] = await gaqlSatirlar(
      client,
      `SELECT campaign.id, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${Number(kampanyaId)} LIMIT 1`,
      1
    );
    const ham = satir?.campaign_budget?.amount_micros;
    if (typeof ham !== "number" && typeof ham !== "string") return undefined;
    if (typeof ham === "string" && ham.trim() === "") return undefined;
    const tl = Number(ham) / 1e6;
    return Number.isFinite(tl) ? tl : undefined;
  } catch (e) {
    yaz(kirmizi(`Günlük bütçe geri okunamadı (${e?.message ?? e}).`));
    return undefined;
  }
}

/** Two budgets are the same value: they come back as floats over the wire. */
const ayniButce = (a, b) => a !== undefined && b !== undefined && Math.abs(a - b) < 0.005;

/**
 * Returns the daily budget to its old value and verifies it BY READING IT BACK — the same
 * doctrine as duraklatVeDogrula, for the same reason: believing the tool's answer is not
 * enough, because a budget left raised spends real money every day it stays up. It retries
 * once.
 */
async function butceGeriAlVeDogrula(client, kampanya) {
  for (let deneme = 1; deneme <= 2; deneme++) {
    try {
      const res = await client.callTool({
        name: "update_campaign_budget",
        arguments: { customerId: MUSTERI, campaignId: kampanya.id, newDailyBudget: kampanya.butce },
      });
      const metin = ilkMetin(res);
      yaz(res.isError ? kirmizi(`Bütçe geri alma denemesi ${deneme} HATA döndü: ${metin}`) : soluk(`Bütçe geri alma denemesi ${deneme}: ${metin}`));
    } catch (e) {
      yaz(kirmizi(`Bütçe geri alma denemesi ${deneme} hata verdi: ${e?.message ?? e}`));
    }
    const suanki = await butceOku(client, kampanya.id);
    if (ayniButce(suanki, kampanya.butce)) return true;
    yaz(kirmizi(`Bütçe geri alma denemesi ${deneme}: günlük bütçe hâlâ ${suanki ?? "okunamadı"} (beklenen ${kampanya.butce}).`));
    if (deneme < 2) await bekle(1500);
  }
  return false;
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

/** The budget raise could not be proven reverted: no staying quiet — SHOUT on screen. */
function butceGeriAlmaBagir(kampanya, eskiButce) {
  kutu(
    "ACİL — ELLE MÜDAHALE GEREKİYOR",
    [
      "!!! BÜTÇE ARTIŞININ GERİ ALINDIĞI DOĞRULANAMADI !!!",
      `Kampanya: "${kampanya?.ad ?? "?"}" (#${kampanya?.id ?? "?"}) · Hesap: ${MUSTERI ?? "?"}`,
      `Olması gereken günlük bütçe: ${eskiButce ?? "?"} — hesapta DAHA YÜKSEK kalmış olabilir.`,
      "GERÇEK PARA HARCANIYOR OLABİLİR — ŞİMDİ ELLE DÜŞÜR:",
      "  Google Ads arayüzü → Kampanyalar → günlük bütçeyi eski değerine çek",
      `  ya da MCP: update_campaign_budget(customerId=${MUSTERI ?? "?"}, campaignId=${kampanya?.id ?? "?"}, newDailyBudget=${eskiButce ?? "?"})`,
      "(Bütçe düşürme onay istemez; harcamayı azaltan işlemler her zaman serbesttir.)",
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
/** THE BUDGET SLOT of the interlock, shared by BOTH budget raises: Act 1's live +1 and Act 2's
 * attempt, which really calls the write tool in dry mode too. A raise counts as APPLIED until
 * the ACCOUNT proves otherwise — it fails closed, exactly like Act 3's flag below. One slot,
 * because a raise left standing is one and the same emergency whichever act made it; the act
 * that armed it is named on screen at the time, not in the flag. */
let butceKampanya;
let butceEskiDeger;
let butceGeriAlinmadi = false;
/** Act 3's live rehearsal (3/A) and its write attempt in 3/B: the campaign counts as "live"
 * until proven otherwise — it fails closed. */
let perde3Kampanya;
let perde3GeriAlinmadi = false;

/**
 * THE SAFETY INTERLOCK — one place, one truth.
 *
 * If it CANNOT BE PROVEN that a write which spends money was reverted — Act 1's +1 budget
 * raise returning to its old value, or the campaign taken live in Act 3 returning to PAUSED —
 * we do not stay quiet: the red emergency box is printed and the exit code becomes 1. Binding
 * those flags to the exit code happens in THIS function; the run's finally block and the
 * hidden --kendini-sina path both call the SAME function, so the path under test is exactly
 * the path the live rehearsals use, with no duplicated code.
 *
 * Both flags are checked, not the first one that happens to be up: two different writes can be
 * left standing in one run, and each names its own manual fix.
 *
 * @returns whether the interlock fired
 */
function guvenlikKilidiniUygula() {
  let tetiklendi = false;
  if (butceGeriAlinmadi) {
    butceGeriAlmaBagir(butceKampanya, butceEskiDeger);
    tetiklendi = true;
  }
  if (perde3GeriAlinmadi) {
    geriAlmaBagir(perde3Kampanya);
    tetiklendi = true;
  }
  if (!tetiklendi) return false;
  cikisKodu = 1;
  process.exitCode = 1;
  return true;
}

/**
 * Death by signal SKIPS the finally block.
 *
 * In the live rehearsals there is a short but real window between the money-spending write and
 * its reversal — Act 1 between the +1 raise and the return to the old budget, Act 3 between
 * ENABLED and the return to PAUSED. Press Ctrl+C in that window and Node's default
 * behaviour ends the process without running the finally: no emergency box is printed, the
 * exit code is not 1, and the write stays up spending real money. This hook carries the
 * interlock's promise — that however the run ends, this is what speaks last — onto the signal
 * path too. When the interlock does not fire, outside the danger window, the signal ends the
 * process the usual way, with code 128 plus the signal number.
 */
for (const sinyal of ["SIGINT", "SIGTERM"]) {
  process.on(sinyal, () => {
    const tetiklendi = guvenlikKilidiniUygula();
    if (tetiklendi) {
      console.error(
        kirmizi(`\n${sinyal} ile yarıda kesildi — YUKARIDAKİ ACİL KUTUSU GEÇERLİDİR: kampanya yayında ya da bütçesi yüksek kalmış olabilir.`)
      );
      process.exit(1);
    }
    process.exit(sinyal === "SIGINT" ? 130 : 143);
  });
}

/**
 * The hidden --kendini-sina: it DOES NOT PLAY the scenario, it only proves in both
 * directions that the safety interlock really is wired up — reversal verified means no box
 * and code 0; not verified means the box and code 1. BOTH money-spending writes are exercised,
 * each on its own: Act 3's going live and a budget raise. If the check cannot confirm
 * its own expectation it exits 2: better a loud break than quietly passing as "the interlock
 * was tested".
 */
if (KENDINI_SINA) {
  yaz(kalin("KENDİNİ SINAMA — güvenlik kilidi çıkış koduna bağlı mı? (Perde 1 bütçesi + Perde 3 yayını)"));

  perde3Kampanya = { id: "0", ad: "(kendini-sınama sahte kampanyası)", durum: "PAUSED", butce: 0 };
  perde3GeriAlinmadi = false;
  if (guvenlikKilidiniUygula() !== false || cikisKodu !== 0 || process.exitCode) {
    console.error(kirmizi("KENDİNİ SINAMA BAŞARISIZ: geri alma DOĞRULANMIŞKEN kilit tetiklendi."));
    process.exit(2);
  }
  yaz(yesil("  1/3  iki bayrak da false → acil kutusu YOK, çıkış kodu 0 (beklenen)."));

  perde3GeriAlinmadi = true;
  const tetiklendi = guvenlikKilidiniUygula();
  if (!tetiklendi || cikisKodu !== 1 || process.exitCode !== 1) {
    console.error(kirmizi("KENDİNİ SINAMA BAŞARISIZ: geri alma DOĞRULANAMAMIŞKEN çıkış kodu 1 olmadı."));
    process.exit(2);
  }
  yaz(yesil("  2/3  perde3GeriAlinmadi=true → yayın acil kutusu basıldı, çıkış kodu 1 (beklenen)."));

  // The budget flag is exercised ON ITS OWN: with Act 3's flag down again, the exit code may
  // only be 1 if an unreverted budget raise reaches the interlock by itself.
  perde3GeriAlinmadi = false;
  perde3Kampanya = undefined;
  cikisKodu = 0;
  process.exitCode = 0;
  butceKampanya = { id: "0", ad: "(kendini-sınama sahte kampanyası)", durum: "PAUSED", butce: 10 };
  butceEskiDeger = 10;
  butceGeriAlinmadi = true;
  const butceTetiklendi = guvenlikKilidiniUygula();
  if (!butceTetiklendi || cikisKodu !== 1 || process.exitCode !== 1) {
    console.error(kirmizi("KENDİNİ SINAMA BAŞARISIZ: bütçe geri alması DOĞRULANAMAMIŞKEN çıkış kodu 1 olmadı."));
    process.exit(2);
  }
  yaz(yesil("  3/3  butceGeriAlinmadi=true → bütçe acil kutusu basıldı, çıkış kodu 1 (beklenen)."));
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

  // The pre-gates are verified IN ADVANCE with read-only queries, exactly as Act 3 does for
  // its own: the ceiling comes from the limits resource, sharedness from the candidate query.
  const butceTavani = await tavanOku(istemci);
  const kampanya = await kampanyaOku(istemci, KAMPANYA_ARG, butceTavani);
  const hedefButce = denemeButcesi(kampanya);
  const butceOnKapiEngeli = butceOnKapisi(kampanya, hedefButce, butceTavani);
  yaz(`Kampanya: ${kalin(`"${kampanya.ad}"`)} (#${kampanya.id}, ${kampanya.durum}) — mevcut günlük bütçe: ${kalin(kampanya.butce)}`);
  yaz(
    soluk(
      `Hesabın günlük bütçe tavanı (salt-okunur limits kaynağı): ${butceTavani ?? "okunamadı"} · ` +
        `bütçe paylaşımlı mı: ${kampanya.paylasimli === undefined ? "okunamadı" : kampanya.paylasimli ? "EVET" : "hayır"}`
    )
  );
  if (!butceOnKapiEngeli) {
    yaz(`Deneme: ${cyan(`update_campaign_budget ${kampanya.butce} → ${hedefButce}`)} (küçük artış — onay + ağ kapısı gerektirir)`);
    await bekle();
  }

  if (butceOnKapiEngeli) {
    // No fabricated evidence: on a campaign an earlier gate refuses, the network gate never
    // speaks at all — so both budget acts are skipped honestly, with the reason on screen.
    kutu(
      "PERDE 1 ve 2 ATLANDI — uydurma kanıt üretilmez",
      [
        butceOnKapiEngeli,
        "update_campaign_budget önce bütçe tavanını, sonra bütçenin PAYLAŞIMLI olup olmadığını",
        "uygular; ikisi de AĞ kapısından ÖNCE cevap verir. Böyle bir kampanyada bu perdeler",
        "ağ kanıtını gösteremez — o yüzden dürüstçe atlanır, yazma da hiç denenmez.",
        "Uygun aday: kampanyaya özel bütçeli + bütçesi tavanın bir birim altında kalan kampanya",
        "(--kampanya ile de verilebilir).",
      ],
      sari
    );
    for (const perde of ["1", "2"]) {
      ozet.push({
        perde,
        eylem: EYLEM_BUTCE,
        sim: perde === "1" ? "temiz" : "degisti",
        karar: "atlandı (ön kapı ağ kapısından önce cevap verir)",
        istem: "gösterilmedi (perde koşmadı)",
        yazma: "yok (perde koşmadı)",
      });
    }
  } else if (!CANLI) {
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
    // Fail closed: from the moment BEFORE the call, the raise counts as APPLIED. Whether it
    // really was is decided by the ACCOUNT — not by the tool's answer, and not by the
    // assumption "the operator said no, so nothing was written". That is Act 3's doctrine,
    // and money left on a daily budget is spent every day it stays up.
    butceKampanya = kampanya;
    butceEskiDeger = kampanya.butce;
    butceGeriAlinmadi = true;

    let metin = "";
    let cagriHatasi1;
    try {
      const res = await istemci.callTool(
        {
          name: "update_campaign_budget",
          arguments: { customerId: MUSTERI, campaignId: kampanya.id, newDailyBudget: hedefButce },
        },
        undefined,
        ONAY_ZAMAN_ASIMI // insan klavyeye uzanırken 60 sn'lik SDK varsayılanı çağrıyı düşürürdü
      );
      metin = ilkMetin(res);
      yaz(perde1OperatorOnayi ? yesil(`BAŞARI: ${metin}`) : sari(`Sunucu yanıtı: ${metin}`));
    } catch (e) {
      // The call dropped: whether the write happened is UNKNOWN. The read-back below decides,
      // not the assumption "I got an error, so nothing was written".
      cagriHatasi1 = e?.message ?? String(e);
      yaz(kirmizi(`Bütçe artışı çağrısı hata verdi: ${cagriHatasi1}`));
    }
    await bekle();

    // The account is read, not the answer. An unreadable budget is NOT "unchanged": it goes
    // down the revert path too, because a revert is a DECREASE and a decrease is always safe.
    const butceSonrasi = await butceOku(istemci, kampanya.id);
    const eskisiGibi = ayniButce(butceSonrasi, kampanya.butce);
    let geriAlindi = eskisiGibi; // nothing to revert if the budget never moved
    if (!eskisiGibi) {
      yaz(soluk(`Temizlik: günlük bütçe ${kampanya.butce} değerine çekiliyor (azaltma onay istemez) — hesaptan GERİ OKUNARAK doğrulanacak.`));
      geriAlindi = await butceGeriAlVeDogrula(istemci, kampanya);
    }
    butceGeriAlinmadi = !geriAlindi;
    if (!geriAlindi) {
      yaz(kirmizi("BÜTÇE GERİ ALMA DOĞRULANAMADI — ayrıntı ve elle müdahale adımları koşunun EN SONUNDA."));
    } else {
      butceKampanya = undefined;
      if (!eskisiGibi) yaz(yesil(`Geri alma DOĞRULANDI: günlük bütçe yeniden ${kampanya.butce} (hesaptan geri okundu).`));
    }

    // Only now — with the account back where it belongs — may this act end in an error.
    if (cagriHatasi1) {
      throw new Error(
        `Perde 1 çağrısı tamamlanamadı: ${cagriHatasi1}\n` +
          `Günlük bütçe hesaptan geri okundu: ${butceSonrasi ?? "okunamadı"} (beklenen ${kampanya.butce}).`
      );
    }
    if (!perde1OperatorOnayi) {
      // The operator did not type 'Evet': that is a real decision, not a demo failure — but
      // the ACCOUNT says whether a write happened, and a write with no approval is a breach.
      // Only a budget actually READ as different accuses anyone: an unreadable budget was
      // already pushed back down above, and "unknown" is not evidence of a write.
      if (butceSonrasi !== undefined && !eskisiGibi) {
        throw new Error(
          `GÜVENLİK İHLALİ: operatör onay vermedi ama günlük bütçe ${kampanya.butce} yerine ${butceSonrasi} okundu.`
        );
      }
      // The prompt was never shown at all: an earlier gate answered and NOBODY was asked, so
      // the operator is not the one who said no. Saying otherwise would put a decision on
      // stage that no human ever made. The pre-flight rules this out where it can; a
      // sharedness that could not be read cannot be ruled out in advance.
      const kimseyeSorulmadi = perde1IstemSayisi === 0;
      const onKapiCevapladi = kimseyeSorulmadi && onKapiRediMi(metin);
      /**
       * NOBODY WAS ASKED AND THE GATE CANNOT BE NAMED.
       *
       * The network gate's own fail-closed refusals ("...ağ doğrulaması tamamlanamadı — SIM
       * Swap kontrolünden yanıt alınamadı"), its accusation, and any refusal added later all
       * land here. This branch used to fall through to "Operatör onay vermedi", which is a
       * DECISION NOBODY MADE — the very thing the paragraph above forbids. So the act now says
       * only what it can prove: the prompt was never shown, and the server's answer, whatever
       * it was, is quoted rather than attributed.
       */
      const adsizRet = kimseyeSorulmadi && !onKapiCevapladi;
      yaz(
        sari(
          onKapiCevapladi
            ? `Onay istemi HİÇ gösterilmedi: ret ağ kapısından ÖNCEKİ bir kapıdan geldi — ${metin}`
            : adsizRet
              ? `Onay istemi HİÇ gösterilmedi — bu bir OPERATÖR KARARI DEĞİLDİR; reddi ÖN KAPININ verdiği DOĞRULANAMADI (sunucu metni tanınan hiçbir ön kapı reddiyle eşleşmiyor). Sunucu yanıtı: ${metin}`
              : eskisiGibi
                ? "Operatör onay vermedi — sunucu yazmayı uygulamadı (bütçe hesaptan GERİ OKUNARAK doğrulandı)."
                : "Operatör onay vermedi — bütçe geri okunamadı; güvenli taraf olarak eski değere çekildi."
        )
      );
      ozet.push({
        perde: "1",
        eylem: EYLEM_BUTCE,
        sim: "temiz",
        karar: onKapiCevapladi
          ? "atlandı (ön kapı ağ kapısından önce cevap verdi)"
          : adsizRet
            ? "atlandı (reddi veren kapı ADLANDIRILAMADI)"
            : "GEÇER (SIM değişimi yok)",
        istem: onKapiCevapladi
          ? "gösterilmedi (ön kapı reddetti)"
          : adsizRet
            ? "HİÇ gösterilmedi (0) — kimseye sorulmadı"
            : `gösterildi (${perde1IstemSayisi}) → operatör reddetti`,
        yazma: onKapiCevapladi
          ? "yok (ön kapı reddetti)"
          : adsizRet
            ? `yok (geri okundu: ${butceSonrasi ?? "okunamadı"})`
            : eskisiGibi
              ? "yok (onay verilmedi)"
              : "yok (onay verilmedi; bütçe eski değere çekildi)",
      });
    } else {
      if (!/güncellendi/.test(metin) || !perde1KanitVar) {
        throw new Error(`Perde 1 beklenen BAŞARI ile bitmedi. Sunucu yanıtı:\n${metin}`);
      }
      ozet.push({
        perde: "1",
        eylem: EYLEM_BUTCE,
        sim: "temiz",
        karar: "GEÇER (SIM değişimi yok)",
        istem: `gösterildi (${perde1IstemSayisi}) → operatör Evet yazdı`,
        yazma: geriAlindi ? "+1 uygulandı, geri alındı (doğrulandı)" : "+1 uygulandı — GERİ ALINAMADI (!)",
      });
    }
  }
  await istemci.close();
  istemci = undefined;
  await bekle(900);

  /* ── ACT 2: the SIM was swapped ────────────────────────────────────────────── */
  await perdeBasligi(2, `AEGIS_NAC_SIMULATE=degisti — İKİNCİ sunucu süreci: SIM değişmiş sayılır`);

  if (butceOnKapiEngeli) {
    // The pre-flight in Act 1 already found the gate that would answer instead of the
    // network's, and pushed BOTH summary rows there; this scene has nothing left to attempt.
    yaz(sari(`Perde 2 atlandı: ${butceOnKapiEngeli}`));
  } else if (butceGeriAlinmadi) {
    // A raise that is still standing is not a reason to attempt another one: Act 2 re-reads
    // the budget, so it would take the RAISED value and try +1 ON TOP of it. This is the same
    // rule Acts 3/A and 3/B follow — no new money-spending write while an earlier one is
    // unreverted — and it is the reason the emergency box at the end names a single amount.
    yaz(kirmizi("Perde 2 atlandı: bütçe artışının geri alındığı doğrulanana kadar başka yazma denenmez."));
    ozet.push({
      perde: "2",
      eylem: EYLEM_BUTCE,
      sim: "degisti",
      karar: "atlandı (bütçe geri alınamadı)",
      istem: "gösterilmedi (perde koşmadı)",
      yazma: "yok (perde koşmadı)",
    });
  } else {
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
    const kampanya2 = await kampanyaOku(istemci, kampanya.id, butceTavani);
    const hedefButce2 = denemeButcesi(kampanya2);
    yaz(`Aynı deneme: ${cyan(`update_campaign_budget ${kampanya2.butce} → ${hedefButce2}`)} — bu kez ağ "SIM değişti" diyor.`);
    yaz(soluk("(Bu çağrı kuru modda da güvenli: ağ kapısı yazmadan ÖNCE reddeder — reddetmezse demo hata verir.)"));
    await bekle();

    // Fail closed, exactly as in Act 1 and Act 3/B: this scene REALLY CALLS the write tool —
    // in dry mode too, because here it is the NETWORK GATE that answers. The gate is EXPECTED
    // to refuse before any write, but "expected" is not "verified": a regression that let the
    // write through would leave a raised daily budget spending real money every day it stays
    // up, and a bare "DEMO HATASI" would be the only thing on screen. So the flag goes up
    // BEFORE the call and only comes down once the ACCOUNT has proven the budget did not move.
    butceKampanya = kampanya2;
    butceEskiDeger = kampanya2.butce;
    butceGeriAlinmadi = true;

    let metin2 = "";
    let cagriHatasi2;
    try {
      const res2 = await istemci.callTool({
        name: "update_campaign_budget",
        arguments: { customerId: MUSTERI, campaignId: kampanya2.id, newDailyBudget: hedefButce2 },
      });
      metin2 = ilkMetin(res2);
    } catch (e) {
      // The call dropped: whether the write happened is UNKNOWN — the read-back below decides,
      // not the assumption "I got an error, so nothing was written".
      cagriHatasi2 = e?.message ?? String(e);
      yaz(kirmizi(`Perde 2 çağrısı hata verdi: ${cagriHatasi2}`));
    }

    // We look at the account, not at what we were told — and BEFORE any check that can throw,
    // because a throw ahead of the read-back would leave the real budget unmeasured. An
    // unreadable budget is NOT proof that nothing was written: it counts as raised, and the
    // revert is a DECREASE, which is always safe and never asks for approval.
    const butce2Sonrasi = await butceOku(istemci, kampanya2.id);
    const butce2Yazilmis = !ayniButce(butce2Sonrasi, kampanya2.butce);
    if (butce2Yazilmis) {
      yaz(
        kirmizi(
          butce2Sonrasi === undefined
            ? "Perde 2: RET beklenirken günlük bütçe hesaptan OKUNAMADI — yazılmış sayılır, geri alınıyor."
            : `Perde 2: RET beklenirken günlük bütçe ${butce2Sonrasi} okundu (beklenen ${kampanya2.butce}) — geri alınıyor.`
        )
      );
      const geriAlindi2 = await butceGeriAlVeDogrula(istemci, kampanya2);
      butceGeriAlinmadi = !geriAlindi2;
      if (geriAlindi2) {
        butceKampanya = undefined;
        yaz(yesil(`Geri alma DOĞRULANDI: günlük bütçe yeniden ${kampanya2.butce} (hesaptan geri okundu).`));
      } else {
        yaz(kirmizi("BÜTÇE GERİ ALMA DOĞRULANAMADI — ayrıntı ve elle müdahale adımları koşunun EN SONUNDA."));
      }
    } else {
      butceGeriAlinmadi = false;
      butceKampanya = undefined;
    }

    // Only now — with the account back where it belongs — may this act end in an error.
    if (cagriHatasi2) {
      throw new Error(
        `Perde 2 çağrısı tamamlanamadı: ${cagriHatasi2}\n` +
          `Günlük bütçe hesaptan geri okundu: ${butce2Sonrasi ?? "okunamadı"} (beklenen ${kampanya2.butce}).`
      );
    }
    // THE ACCUSING CHECKS COME FIRST, before any classification of the refusal text: a prompt
    // shown even once, or a budget the account says really moved, is a breach WHATEVER came
    // back — and neither may be softened into an honest skip below.
    if (perde2IstemSayisi !== 0) {
      throw new Error(`GÜVENLİK İHLALİ: onay istemi ${perde2IstemSayisi} kez gösterildi — hiç gösterilmemeliydi.`);
    }
    if (butce2Yazilmis) {
      throw new Error(
        `GÜVENLİK İHLALİ: ağ kapısı reddetmeliyken kampanya #${kampanya2.id} günlük bütçesinin ` +
          `${kampanya2.butce} kaldığı DOĞRULANAMADI (geri okuma: ${butce2Sonrasi ?? "okunamadı"}). ` +
          `Sunucu yanıtı:\n${metin2}`
      );
    }
    const agRetti = /AĞ DOĞRULAMASI BAŞARISIZ/.test(metin2);
    if (!agRetti && !onKapiRediMi(metin2)) {
      throw new Error(
        `Perde 2 beklenen ağ retiyle bitmedi (istem sayısı: ${perde2IstemSayisi}, geri okunan bütçe: ` +
          `${butce2Sonrasi ?? "okunamadı"}). Sunucu yanıtı:\n${metin2}`
      );
    }
    if (!agRetti) {
      // A gate BEFORE the network's answered — the pre-flight could not rule it out (an
      // unreadable `explicitly_shared` is the ordinary case). No write happened, but the
      // network evidence was never produced, so it is not claimed: the act is skipped
      // honestly, with the server's own refusal on screen.
      kutu("PERDE 2 ATLANDI — ön kapı cevap verdi, ağ kapısı hiç konuşmadı", metin2.split("\n"), sari);
      yaz(sari("Bu bir ağ kanıtı DEĞİLDİR: yazma yapılmadı, ama reddi veren ağ kapısı değil önceki bir kapıdır."));
      yaz(soluk(`Geri okuma: günlük bütçe ${butce2Sonrasi ?? "okunamadı"} — yazma yapılmadı.`));
      ozet.push({
        perde: "2",
        eylem: EYLEM_BUTCE,
        sim: "degisti",
        karar: "atlandı (ön kapı ağ kapısından önce cevap verdi)",
        istem: "HİÇ gösterilmedi (0)",
        yazma: `yok (geri okundu: ${butce2Sonrasi ?? "okunamadı"})`,
      });
    } else {
      kutu("RET — AĞ DOĞRULAMASI BAŞARISIZ", metin2.split("\n"), kirmizi);
      yaz(yesil("Doğrulandı: elicitation handler HİÇ çağrılmadı (0 istem)."));
      yaz(kalin("Onay istemi insana hiç ulaşmadı — SIM'i yeni değişmiş 'onaylayıcı' saldırgan olabilir."));
      yaz(soluk(`Geri okuma: günlük bütçe ${butce2Sonrasi} — yazma yapılmadı.`));
      ozet.push({
        perde: "2",
        eylem: EYLEM_BUTCE,
        sim: "degisti",
        karar: "RET (ağ doğrulaması başarısız)",
        istem: "HİÇ gösterilmedi (0)",
        yazma: `yok (geri okundu: ${butce2Sonrasi})`,
      });
    }
    await istemci.close();
    istemci = undefined;
  }
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

    // The live rehearsal is performed ONLY on a campaign the operator NAMED with --kampanya,
    // and only while it is PAUSED. The naming half of that promise used to live in the file
    // header alone: with no --kampanya the script picks a candidate ITSELF, and --canli then
    // took THAT campaign live — a real, merely paused campaign whose name the operator had
    // never even seen. The automatic pick stays read-only; the path that spends money asks for
    // explicit intent. The PAUSED half is the other reason: on a campaign that is already
    // live, the reversal step would STOP it, and we do not pause someone else's live campaign.
    // And no new money-spending write is started while an EARLIER raise (Act 1's or Act 2's)
    // is still unreverted — the same rule Act 2 and 3/B follow.
    const adlandirilmis = Boolean(KAMPANYA_ARG);
    const canliProva = CANLI && adlandirilmis && aday3.durum === "PAUSED" && !butceGeriAlinmadi;
    if (CANLI && !canliProva) {
      yaz(
        sari(
          !adlandirilmis
            ? `[canlı atlandı] --kampanya verilmedi: "${aday3.ad}" (#${aday3.id}) betiğin KENDİ seçtiği adaydır — ` +
                "gerçekten yayına alma yalnız operatörün açıkça adlandırdığı TEST kampanyasında yapılır."
            : butceGeriAlinmadi
              ? "[canlı atlandı] Bütçe artışı geri alınamadı — doğrulanana kadar başka yazma denenmez."
              : `[canlı atlandı] "${aday3.ad}" (#${aday3.id}) PAUSED değil (${aday3.durum}) — ` +
                "sahne sonundaki geri alma adımı zaten yayındaki bir kampanyayı DURDURURDU."
        )
      );
    }

    if (!canliProva) {
      if (!CANLI) {
        yaz(sari("[kuru] araç çağrısı atlandı — kampanya yayına ALINMADI (--canli ve --kampanya BİRLİKTE verilirse gerçekten alınır ve geri alınır)."));
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
        karar: CANLI
          ? !adlandirilmis
            ? "atlandı (--kampanya verilmedi)"
            : butceGeriAlinmadi
              ? "atlandı (bütçe geri alınamadı)"
              : `atlandı (${aday3.durum} — PAUSED değil)`
          : "[kuru] koşulmadı",
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
    // While ANY earlier money-spending write may still be standing — a campaign left live in
    // 3/A, or a budget raise from Acts 1 or 2 — no new write is attempted. 3/B calls the write
    // tool for real (the gate is what refuses), so it belongs under the same rule.
    const bekleyenYazma = perde3GeriAlinmadi
      ? "3/A'nın geri alması"
      : butceGeriAlinmadi
        ? "bütçe artışının geri alınması"
        : undefined;
    if (bekleyenYazma) {
      yaz(kirmizi(`Perde 3/B atlandı: ${bekleyenYazma} doğrulanana kadar başka yazma denenmez.`));
      ozet.push({
        perde: "3/B",
        eylem: EYLEM_YAYIN,
        sim: "degisti",
        karar: perde3GeriAlinmadi ? "atlandı (3/A geri alınamadı)" : "atlandı (bütçe geri alınamadı)",
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

      // Fail closed, exactly as in 3/A: this scene REALLY CALLS the write tool — in dry mode
      // too, because here the network gate is what answers. The gate is EXPECTED to refuse
      // before any write, but "expected" is not "verified": a regression that lets the write
      // through would put a campaign live on stage, and the flag is what turns that into a red
      // box instead of a bare demo error. So it goes up BEFORE the call and only comes down
      // once the account has PROVEN the campaign is not live.
      // A candidate that was already ENABLED before this run — possible only when --kampanya
      // names one — was not put live by us, and we do not pause someone else's live campaign.
      const zatenYayindaydi = aday3.durum === "ENABLED";
      if (!zatenYayindaydi) {
        perde3Kampanya = aday3;
        perde3GeriAlinmadi = true;
      }

      let metin3b = "";
      let cagriHatasi3b;
      try {
        const res3b = await istemci.callTool({
          name: "set_campaign_status",
          arguments: { customerId: MUSTERI, campaignId: aday3.id, status: "ENABLED" },
        });
        metin3b = ilkMetin(res3b);
      } catch (e) {
        // The call dropped: whether the write happened is UNKNOWN — the read-back below
        // decides, not the assumption "I got an error, so nothing was written".
        cagriHatasi3b = e?.message ?? String(e);
        yaz(kirmizi(`Perde 3/B çağrısı hata verdi: ${cagriHatasi3b}`));
      }

      // We look at the account, not at what we were told: that no write happened is verified
      // BY READING IT BACK — and BEFORE any check that can throw, because a throw ahead of the
      // read-back would leave the campaign's real state unmeasured.
      let durumB;
      let okunabildiB = true;
      try {
        const [satirB] = await gaqlSatirlar(
          istemci,
          `SELECT campaign.id, campaign.status FROM campaign WHERE campaign.id = ${Number(aday3.id)} LIMIT 1`,
          1
        );
        durumB = durumAdi(satirB?.campaign?.status);
      } catch (e) {
        okunabildiB = false;
        durumB = `okunamadı (${e?.message ?? e})`;
      }

      // An unreadable status is NOT proof that nothing was written: it counts as live.
      const yayindaOlabilir = !zatenYayindaydi && (durumB === "ENABLED" || !okunabildiB);
      if (yayindaOlabilir) {
        yaz(kirmizi(`Perde 3/B: RET beklenirken kampanya #${aday3.id} durumu "${durumB}" okundu — geri alınıyor.`));
        const geriAlindiB = await duraklatVeDogrula(istemci, aday3);
        perde3GeriAlinmadi = !geriAlindiB;
        if (geriAlindiB) {
          perde3Kampanya = undefined;
          yaz(yesil("Geri alma DOĞRULANDI: kampanya yeniden PAUSED (durum hesaptan geri okundu)."));
        } else {
          yaz(kirmizi("GERİ ALMA DOĞRULANAMADI — ayrıntı ve elle müdahale adımları koşunun EN SONUNDA."));
        }
      } else {
        perde3GeriAlinmadi = false;
        perde3Kampanya = undefined;
      }

      // Only now — with the account back where it belongs — may this act end in an error.
      if (cagriHatasi3b) {
        throw new Error(
          `Perde 3/B çağrısı tamamlanamadı: ${cagriHatasi3b}\nKampanya #${aday3.id} durumu hesaptan geri okundu: ${durumB}.`
        );
      }
      if (!/AĞ DOĞRULAMASI BAŞARISIZ/.test(metin3b)) {
        throw new Error(
          `Perde 3/B beklenen ağ retiyle bitmedi (istem sayısı: ${perde3bIstemSayisi}, geri okunan durum: ${durumB}). Sunucu yanıtı:\n${metin3b}`
        );
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
      if (yayindaOlabilir) {
        throw new Error(`GÜVENLİK İHLALİ: ret metnine rağmen kampanya #${aday3.id} durumu "${durumB}" okundu.`);
      }
      /**
       * "NO WRITE HAPPENED" IS A MEASUREMENT, NOT A DEFAULT — and a reading that could not
       * have come out the other way is not a measurement of anything.
       *
       * Two readings reach this line carrying no evidence, and both belong to the ONE
       * candidate the act does not own: a campaign that --kampanya named while it was ALREADY
       * ENABLED, whose `zatenYayindaydi` lifted the live check above. No reversal is owed
       * there — we do not pause someone else's live campaign — but no CLAIM is owed either:
       *   · the status could not be READ at all, so nothing was measured;
       *   · the status reads ENABLED, the value it ALREADY HAD before the call. A write the
       *     gate refused and a write that went through leave the account looking exactly the
       *     same, so this reading cannot contradict "a write happened" — and a signal that
       *     cannot contradict the claim cannot vouch for it either.
       * A reading vouches only where it COULD HAVE DISPROVED the claim: on the act's own
       * candidate, PAUSED before the run, any status other than ENABLED does exactly that, and
       * there the honest claim is really made. That is also why the branch is decided by the
       * READING, not by whether --kampanya was typed. Everywhere else the screen and the
       * summary table say what the account answered AND that it settles nothing.
       */
      const geriOkumaCurutebilir = okunabildiB && !(zatenYayindaydi && durumB === "ENABLED");
      yaz(
        geriOkumaCurutebilir
          ? soluk(`Geri okuma: kampanya #${aday3.id} durumu ${durumB} — yazma yapılmadı.`)
          : okunabildiB
            ? sari(
                `Geri okuma: kampanya #${aday3.id} durumu ${durumB} — kampanya koşudan ÖNCE de ENABLED'dı; ` +
                  "bu okuma bir yazmayı ÇÜRÜTEMEZ, yazma yapılmadığı DOĞRULANAMADI."
              )
            : sari(`Geri okuma BAŞARISIZ: kampanya #${aday3.id} durumu ${durumB} — yazma yapılmadığı DOĞRULANAMADI.`)
      );
      ozet.push({
        perde: "3/B",
        eylem: EYLEM_YAYIN,
        sim: "degisti",
        karar: "RET (ağ doğrulaması başarısız)",
        istem: "HİÇ gösterilmedi (0)",
        yazma: geriOkumaCurutebilir
          ? `yok (geri okundu: ${durumB})`
          : okunabildiB
            ? "DOĞRULANAMADI (ön durum da ENABLED)"
            : `DOĞRULANAMADI (${durumB})`,
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
