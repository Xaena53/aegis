#!/usr/bin/env node
/*
 * AdsPilot — Google Ads MCP server
 * Copyright (C) 2026 Xaena53 (github.com/Xaena53) and the AdsPilot contributors
 *
 * This program is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License version 3 as published by the Free
 * Software Foundation. See the LICENSE file for details.
 */

/**
 * Live smoke test against a real Google Ads account.
 *
 * The unit and integration suites run entirely offline against a fake API, which is what
 * makes them fast and deterministic — but it also means they can only prove the server
 * behaves correctly against the API *as modelled*. This script closes that gap: it starts
 * the real stdio binary, speaks MCP over stdin/stdout exactly as Claude Desktop does, and
 * checks the guarantees the README makes against Google's live servers.
 *
 * Safety: the default run performs NO mutation. It exercises read paths and, for the
 * spend-related guards, the REFUSAL path — a refusal is verified by confirming the server
 * declined AND that the underlying value is unchanged afterwards. Pass --write to also
 * create a real paused draft campaign; see the note on that flag below.
 *
 * Usage:
 *   npm run smoke                    # read-only, safe to run any time
 *   npm run smoke -- --customer=123  # pick an account explicitly
 *   npm run smoke -- --write         # also create a paused draft campaign
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARGS = process.argv.slice(2);
const WRITE = ARGS.includes("--write");
const CUSTOMER_ARG = (ARGS.find((a) => a.startsWith("--customer=")) ?? "").split("=")[1];
const CALL_TIMEOUT_MS = 90_000;

/* ── MCP client over stdio ──────────────────────────────────────────────────────── */

/**
 * Minimal MCP client. Deliberately does NOT advertise the elicitation capability, so the
 * approval gate takes its fallback branch — which is the branch this script asserts on.
 */
function baglan() {
  const proc = spawn(process.execPath, [join(ROOT, "dist", "index.js")], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const bekleyen = new Map();
  let tampon = "";
  let stderr = "";

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    tampon += chunk;
    let nl;
    while ((nl = tampon.indexOf("\n")) >= 0) {
      const satir = tampon.slice(0, nl).trim();
      tampon = tampon.slice(nl + 1);
      if (!satir) continue;
      let mesaj;
      try { mesaj = JSON.parse(satir); } catch { continue; }
      const bekleyenIstek = bekleyen.get(mesaj.id);
      if (bekleyenIstek) {
        bekleyen.delete(mesaj.id);
        clearTimeout(bekleyenIstek.zamanlayici);
        bekleyenIstek.coz(mesaj);
      }
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c) => { stderr += c; });

  // A server crash must fail the run loudly rather than hang until every call times out.
  proc.on("exit", (code) => {
    for (const { red, zamanlayici } of bekleyen.values()) {
      clearTimeout(zamanlayici);
      red(new Error(`sunucu beklenmedik şekilde kapandı (kod ${code})\n${stderr.slice(-800)}`));
    }
    bekleyen.clear();
  });

  let sonrakiId = 1;
  const istek = (method, params) =>
    new Promise((coz, red) => {
      const id = sonrakiId++;
      const zamanlayici = setTimeout(() => {
        bekleyen.delete(id);
        red(new Error(`${method} ${CALL_TIMEOUT_MS} ms içinde yanıt vermedi`));
      }, CALL_TIMEOUT_MS);
      bekleyen.set(id, { coz, red, zamanlayici });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  const bildirim = (method, params) =>
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

  return { istek, bildirim, kapat: () => proc.kill(), stderr: () => stderr };
}

/** Calls a tool and returns { metin, yapisal, hataMi }. */
async function arac(mcp, name, args) {
  const yanit = await mcp.istek("tools/call", { name, arguments: args });
  if (yanit.error) throw new Error(`${name} protokol hatası: ${yanit.error.message}`);
  const r = yanit.result ?? {};
  return {
    metin: (r.content ?? []).map((c) => c.text ?? "").join("\n"),
    yapisal: r.structuredContent,
    hataMi: r.isError === true,
  };
}

/* ── check registry ─────────────────────────────────────────────────────────────── */

const sonuclar = [];

/**
 * Runs one check. A thrown error is recorded as a failure rather than aborting the run,
 * so a single broken guarantee still leaves the rest of the report readable.
 */
async function kontrol(soz, ad, fn) {
  const t0 = Date.now();
  try {
    const not = await fn();
    sonuclar.push({ soz, ad, gecti: true, not: not ?? "", ms: Date.now() - t0 });
  } catch (e) {
    sonuclar.push({ soz, ad, gecti: false, not: e?.message ?? String(e), ms: Date.now() - t0 });
  }
}

function dogrula(kosul, mesaj) {
  if (!kosul) throw new Error(mesaj);
}

/* ── run ────────────────────────────────────────────────────────────────────────── */

const mcp = baglan();
let cikisKodu = 0;

try {
  const init = await mcp.istek("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {}, // no elicitation: the approval gate must fall back to confirm
    clientInfo: { name: "adspilot-smoke", version: "1.0.0" },
  });
  if (init.error) throw new Error(`initialize başarısız: ${init.error.message}`);
  mcp.bildirim("notifications/initialized");

  await kontrol("Sunucu ajana kurallarını anlatır", "initialize → instructions", async () => {
    const yonerge = init.result?.instructions ?? "";
    dogrula(yonerge.length > 100, "instructions boş ya da çok kısa");
    dogrula(/DURAKLATILMI[ŞS]/i.test(yonerge), "instructions 'duraklatılmış oluşturulur' kuralını içermiyor");
    const yetenekler = Object.keys(init.result?.capabilities ?? {});
    for (const y of ["tools", "resources", "prompts", "completions"]) {
      dogrula(yetenekler.includes(y), `capability eksik: ${y}`);
    }
    return `${yonerge.length} karakter yönerge, ${yetenekler.length} yetenek`;
  });

  // Account discovery drives every later check, so a failure here stops the run.
  const hesaplar = await arac(mcp, "list_accounts", {});
  dogrula(!hesaplar.hataMi, `list_accounts başarısız: ${hesaplar.metin.slice(0, 300)}`);
  /**
   * `erisilemedi` accounts are listed as accessible but their details cannot be read, so
   * they are not usable targets. Skipping them here is not a workaround: it is the same
   * decision the tool now tells the agent to make.
   */
  const reklamHesaplari = (hesaplar.yapisal?.hesaplar ?? []).filter((h) => !h.yonetici && !h.erisilemedi);
  dogrula(reklamHesaplari.length > 0, "kullanılabilir reklam hesabı yok (yalnız MCC ya da erişilemeyen hesaplar)");
  const CID = CUSTOMER_ARG ?? reklamHesaplari[0].id;

  await kontrol("Hesaplar listelenir", "list_accounts", async () => {
    dogrula(hesaplar.yapisal != null, "structuredContent dönmedi (outputSchema bozuk)");
    for (const h of hesaplar.yapisal.hesaplar) {
      dogrula(/^\d{10}$/.test(h.id), `hesap ID 10 hane değil: ${h.id}`);
    }
    return `${hesaplar.yapisal.hesaplar.length} hesap, seçilen: ${CID}`;
  });

  await kontrol("Rapor yapısal çıktı döner", "campaign_performance", async () => {
    const r = await arac(mcp, "campaign_performance", { customerId: CID, days: 30 });
    dogrula(!r.hataMi, r.metin.slice(0, 300));
    dogrula(r.yapisal != null, "structuredContent yok — ajan metin ayrıştırmak zorunda kalır");
    dogrula(Array.isArray(r.yapisal.kampanyalar), "yapısal çıktıda kampanyalar dizisi yok");
    return `${r.yapisal.kampanyalar.length} kampanya`;
  });

  /**
   * The guarantee this protects: the client library parses the query itself and drops the
   * LAST field of a multi-line SELECT, returning null for it *silently*. An agent reading
   * that as "no spend" could raise a budget on bad data.
   */
  await kontrol("Çok satırlı GAQL alan kaybetmez", "run_gaql (çok satırlı)", async () => {
    const r = await arac(mcp, "run_gaql", {
      customerId: CID,
      query: "SELECT campaign.id,\n  campaign.name,\n  metrics.cost_micros\nFROM campaign",
    });
    dogrula(!r.hataMi, r.metin.slice(0, 300));
    const satirlar = r.yapisal?.satirlar ?? [];
    dogrula(satirlar.length > 0, "hiç satır dönmedi — hesapta kampanya yok, kontrol doğrulanamıyor");
    const sonAlanVar = satirlar.some((s) => s?.metrics && "cost_micros" in s.metrics);
    dogrula(sonAlanVar, "SELECT listesinin SON alanı (metrics.cost_micros) satırlarda yok — sessiz veri kaybı");
    return `${satirlar.length} satır, son alan yerinde`;
  });

  /**
   * The clamp must be shown to bite. Asserting `rows <= cap` against an account that holds
   * fewer rows than the cap passes without exercising anything, so the unclamped count is
   * measured first and the check reports itself inconclusive when the data cannot prove it.
   */
  await kontrol("Devasa LIMIT tavana kırpılır", "run_gaql (LIMIT 999999)", async () => {
    const sorgu = "SELECT campaign.id FROM campaign LIMIT 999999";
    const serbest = await arac(mcp, "run_gaql", { customerId: CID, query: sorgu });
    const toplam = (serbest.yapisal?.satirlar ?? []).length;
    dogrula(toplam >= 2, `hesapta ${toplam} kampanya var; kırpmayı kanıtlamak için en az 2 gerekir`);

    const tavan = toplam - 1;
    const r = await arac(mcp, "run_gaql", { customerId: CID, query: sorgu, limit: tavan });
    dogrula(!r.hataMi, r.metin.slice(0, 300));
    const n = (r.yapisal?.satirlar ?? []).length;
    dogrula(n === tavan, `kırpılmadı: tavan ${tavan}, dönen ${n} (kırpmasız ${toplam})`);
    return `kırpmasız ${toplam} satır, tavan ${tavan} → ${n} satır`;
  });

  await kontrol("Kelepçeler kaynak olarak okunur", "resources/read limits", async () => {
    const y = await mcp.istek("resources/read", { uri: `adspilot://accounts/${CID}/limits` });
    dogrula(!y.error, `kaynak okunamadı: ${y.error?.message}`);
    const veri = JSON.parse(y.result.contents[0].text);
    dogrula(typeof veri.gunlukButceTavani === "number", "bütçe tavanı sayı değil");
    dogrula(typeof veri.yazmaIzni === "boolean", "yazma izni boolean değil");
    dogrula(Array.isArray(veri.kurallar) && veri.kurallar.length >= 5, "kurallar listesi eksik");
    return `tavan ${veri.gunlukButceTavani}, yazma ${veri.yazmaIzni}, ${veri.kurallar.length} kural`;
  });

  await kontrol("Slash komutları ve canlı tamamlama", "prompts + completion", async () => {
    const p = await mcp.istek("prompts/list", {});
    dogrula(!p.error, `prompts/list hatası: ${p.error?.message}`);
    dogrula(p.result.prompts.length >= 5, `beklenen 5+ prompt, gelen ${p.result.prompts.length}`);
    const c = await mcp.istek("completion/complete", {
      ref: { type: "ref/prompt", name: "reklam-kur" },
      argument: { name: "customerId", value: CID.slice(0, 3) },
    });
    dogrula(!c.error, `completion hatası: ${c.error?.message}`);
    const oneriler = c.result?.completion?.values ?? [];
    dogrula(oneriler.includes(CID), `tamamlama gerçek hesabı önermedi (${oneriler.length} öneri)`);
    return `${p.result.prompts.length} prompt, ${oneriler.length} hesap önerisi`;
  });

  /* ── refusal paths: the guards, verified against the live account ─────────────── */

  const kampanyalar = await arac(mcp, "run_gaql", {
    customerId: CID,
    query: "SELECT campaign.id, campaign.status, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED' LIMIT 1",
  });
  const ilk = (kampanyalar.yapisal?.satirlar ?? [])[0];

  if (!ilk) {
    sonuclar.push({
      soz: "Para kapıları", ad: "reddetme yolları", gecti: false, ms: 0,
      not: "hesapta kampanya yok — bütçe/durum kapıları canlı doğrulanamadı",
    });
  } else {
    const kampanyaId = String(ilk.campaign.id);
    const butceOnce = Number(ilk.campaign_budget?.amount_micros ?? 0);

    await kontrol("Tavan üstü bütçe reddedilir", "update_campaign_budget (tavan üstü)", async () => {
      const r = await arac(mcp, "update_campaign_budget", {
        customerId: CID, campaignId: kampanyaId, newDailyBudget: 9_999_999, confirm: true,
      });
      dogrula(/Reddedildi/i.test(r.metin), `reddedilmedi: ${r.metin.slice(0, 200)}`);
      // A refusal message alone is not proof; confirm the live budget is untouched.
      const sonra = await arac(mcp, "run_gaql", {
        customerId: CID,
        query: `SELECT campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${kampanyaId}`,
      });
      const butceSonra = Number((sonra.yapisal?.satirlar ?? [])[0]?.campaign_budget?.amount_micros ?? -1);
      dogrula(butceSonra === butceOnce, `bütçe DEĞİŞTİ: ${butceOnce} → ${butceSonra}`);
      return "reddedildi ve bütçe değişmedi";
    });

    await kontrol("Onaysız yayına alma reddedilir", "set_campaign_status ENABLED (onaysız)", async () => {
      const durumOnce = String(ilk.campaign.status);
      const r = await arac(mcp, "set_campaign_status", {
        customerId: CID, campaignId: kampanyaId, status: "ENABLED",
      });
      dogrula(/Reddedildi|İşlem yapılmadı/i.test(r.metin), `reddedilmedi: ${r.metin.slice(0, 200)}`);
      const sonra = await arac(mcp, "run_gaql", {
        customerId: CID,
        query: `SELECT campaign.status FROM campaign WHERE campaign.id = ${kampanyaId}`,
      });
      const durumSonra = String((sonra.yapisal?.satirlar ?? [])[0]?.campaign?.status ?? "");
      dogrula(durumSonra === durumOnce, `durum DEĞİŞTİ: ${durumOnce} → ${durumSonra}`);
      return "reddedildi ve durum değişmedi";
    });
  }

  /* ── optional: real mutation ──────────────────────────────────────────────────── */

  if (WRITE) {
    await kontrol("Kampanya DURAKLATILMIŞ oluşur", "create_search_campaign (--write)", async () => {
      const ad = `AdsPilot Duman ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      const r = await arac(mcp, "create_search_campaign", {
        customerId: CID, name: ad, dailyBudget: 1, countryCodes: ["TR"],
        keywords: ["adspilot duman testi"], adGroupName: "duman",
      });
      dogrula(!r.hataMi, r.metin.slice(0, 300));
      const idEsl = /campaigns\/(\d+)|kampanya (?:ID|id)[:\s]+(\d+)/.exec(r.metin);
      const yeniId = idEsl?.[1] ?? idEsl?.[2];
      dogrula(yeniId, `oluşturuldu ama ID okunamadı: ${r.metin.slice(0, 200)}`);
      const dogrulama = await arac(mcp, "run_gaql", {
        customerId: CID,
        query: `SELECT campaign.status FROM campaign WHERE campaign.id = ${yeniId}`,
      });
      const durum = String((dogrulama.yapisal?.satirlar ?? [])[0]?.campaign?.status ?? "");
      dogrula(/PAUSED|3/.test(durum), `ENABLED oluştu! durum: ${durum}`);
      return `kampanya ${yeniId} PAUSED — ELLE SİL (sunucuda bilinçli olarak silme aracı yok)`;
    });
  }
} catch (e) {
  sonuclar.push({ soz: "Çalıştırma", ad: "önkoşul", gecti: false, not: e?.message ?? String(e), ms: 0 });
} finally {
  mcp.kapat();
}

/* ── report ─────────────────────────────────────────────────────────────────────── */

const gecen = sonuclar.filter((s) => s.gecti).length;
const genislik = Math.max(...sonuclar.map((s) => s.soz.length), 10);

console.log("\n  AdsPilot — canlı duman testi\n");
for (const s of sonuclar) {
  const isaret = s.gecti ? "GEÇTİ" : "KALDI";
  console.log(`  ${isaret}  ${s.soz.padEnd(genislik)}  ${s.ad}`);
  if (s.not) console.log(`         ${" ".repeat(genislik)}  ${s.not}`);
}
console.log(`\n  ${gecen}/${sonuclar.length} kontrol geçti${WRITE ? "" : "  (yazma yok — --write ile kampanya oluşturma da denenir)"}\n`);

cikisKodu = gecen === sonuclar.length ? 0 : 1;
process.exit(cikisKodu);
