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
 * The stage-day pre-flight check, the "rehearsal".
 *
 * `npm run demo` gets one shot on stage: in front of a jury, a stale `dist/`, an expired
 * refresh token or a closed Docker Desktop ends the demo. This script finds those failures
 * BEFORE THE STAGE, by going down the same real paths: it opens the server binary over stdio,
 * makes a live Google Ads read, and plays the demo scenario end to end in DRY mode.
 *
 * Nothing is written: the live call is read-only (list_accounts) and the scenario runs dry —
 * in Act 1 and Act 3/A no tool is called at all, and Act 2 and Act 3/B are refused at the
 * network gate BEFORE any write. It leaks no secrets: .env variables are reported only as
 * present or absent, and their values — including an unrecognised AEGIS_NAC_SIMULATE value —
 * are never printed.
 *
 * The report format is the same as `scripts/smoke.mjs`; the only difference is that it has
 * three states:
 *   GEÇTİ  — nothing stands in the way of the stage
 *   UYARI  — the demo will still play, but there is a gap you should know about; it does not
 *            affect the exit code
 *   KALDI  — it will break on stage; exit code 1
 *
 * Usage:
 *   npm run prova -- --musteri <customer-id> [--kampanya <campaign-id>]
 *   Without --musteri the demo dry run is SKIPPED with a warning; the other checks still
 *   run.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config as dotenvYukle } from "dotenv";
// The decisions live in testable pure functions rather than here — see onucusKurallari.mjs:
// no test could tell us that a rule embedded in the script was wrong.
import { agKapisiKarari, derlemeTazeligi } from "./onucusKurallari.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_GIRIS = join(ROOT, "dist", "index.js");

/** The floor to fall back on when engines carries no version. */
const VARSAYILAN_NODE = "22";
const MCP_ZAMAN_ASIMI_MS = 90_000; // as in smoke.mjs: a live Google call can be slow
const DEMO_ZAMAN_ASIMI_MS = 240_000; // the scenario opens four server processes and pauses for
// the narration

/**
 * The number of acts the scenario is EXPECTED to play. A dry run exiting 0 is not enough on
 * its own: if one of the acts quietly drops out — a dead helper, a skipped scene — the exit
 * code is still 0, and the incomplete demo is only noticed in front of the jury. So the count
 * of acts is REALLY COUNTED from the output; no fixed text is printed.
 */
const BEKLENEN_PERDE_SAYISI = 3;
const DOCKER_ZAMAN_ASIMI_MS = 20_000;

/* ── CLI ─────────────────────────────────────────────────────────────────────── */

function bayrakDegeri(ad) {
  const i = process.argv.indexOf(ad);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}
const MUSTERI = bayrakDegeri("--musteri");
const KAMPANYA = bayrakDegeri("--kampanya")?.replace(/\D/g, "") || undefined;

/* ── Reading .env: PRESENCE only, values are never printed ───────────────────── */

/**
 * The server loads .env from the project root itself (see src/config.ts). The rehearsal reads
 * the same file but, thanks to `processEnv: {}`, does not write into its OWN environment: it
 * must not alter the environment handed to the child and thereby disturb the behaviour it is
 * measuring. The precedence matches dotenv's — a shell variable wins.
 */
const DOSYA_ENV = (() => {
  const yol = join(ROOT, ".env");
  if (!existsSync(yol)) return {};
  try {
    return dotenvYukle({ path: yol, quiet: true, processEnv: {} }).parsed ?? {};
  } catch {
    return {};
  }
})();

const envDegeri = (ad) => String(process.env[ad] ?? DOSYA_ENV[ad] ?? "").trim();
const envVar = (ad) => envDegeri(ad).length > 0;
const varYok = (ad) => `${ad}: ${envVar(ad) ? "var" : "yok"}`;

/* ── The check register ──────────────────────────────────────────────────────── */

const GECTI = "GEÇTİ";
const UYARI = "UYARI";
const KALDI = "KALDI";

const sonuclar = [];

/**
 * Runs a single check. An error thrown is recorded as a failure and does not stop the run:
 * seeing ALL the gaps before the stage beats stopping at the first and discovering the second
 * on stage.
 */
async function kontrol(soz, ad, fn) {
  const t0 = Date.now();
  try {
    const r = (await fn()) ?? {};
    sonuclar.push({ soz, ad, durum: r.durum ?? GECTI, not: r.not ?? "", ms: Date.now() - t0 });
  } catch (e) {
    sonuclar.push({ soz, ad, durum: KALDI, not: e?.message ?? String(e), ms: Date.now() - t0 });
  }
}

const gectiSonuc = (not) => ({ durum: GECTI, not });
const uyariSonuc = (not) => ({ durum: UYARI, not });
const kaldiSonuc = (not) => ({ durum: KALDI, not });

/* ── Helpers ─────────────────────────────────────────────────────────────────── */

function surumParcala(ham) {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(ham ?? ""));
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : undefined;
}

function surumKarsilastir(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Runs a command with a timeout; ENOENT — the command is missing — is a result, not an
 * error. */
function komutCalistir(komut, argumanlar, zamanAsimiMs, ek = {}) {
  return new Promise((coz) => {
    let p;
    try {
      p = spawn(komut, argumanlar, {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        ...ek,
      });
    } catch (e) {
      coz({ yok: true, kod: null, cikti: "", hata: String(e?.message ?? e) });
      return;
    }
    let cikti = "";
    let hata = "";
    let bitti = false;
    const zamanlayici = setTimeout(() => {
      if (!bitti) {
        bitti = true;
        p.kill();
        coz({ zamanAsimi: true, kod: null, cikti, hata });
      }
    }, zamanAsimiMs);
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c) => (cikti += c));
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (c) => (hata += c));
    p.on("error", (e) => {
      if (bitti) return;
      bitti = true;
      clearTimeout(zamanlayici);
      coz({ yok: e?.code === "ENOENT", kod: null, cikti, hata: String(e?.message ?? e) });
    });
    p.on("close", (kod) => {
      if (bitti) return;
      bitti = true;
      clearTimeout(zamanlayici);
      coz({ kod, cikti, hata });
    });
  });
}

const sonSatir = (metin) => {
  const satirlar = String(metin).split(/\r?\n/).filter((s) => s.trim());
  return satirlar.length ? satirlar[satirlar.length - 1].trim() : "";
};

/**
 * Counts the act headings in the dry run's output — the scenario prints them as
 * `═══ PERDE <n> ═══…`, and the text is the same with colour off. An act number appearing
 * more than once is counted once, and the set returned is sorted.
 *
 * Counting the headings is NOT ENOUGH ON ITS OWN: the scenario prints an act's heading BEFORE
 * the pre-gates that look for a suitable campaign, and if it finds no candidate it says
 * "PERDE <n> ATLANDI" and moves on. A counter that looks at headings would say 3 of 3 while
 * two acts play on stage — which is exactly what the rehearsal is supposed to catch. So acts
 * marked ATLANDI are SUBTRACTED.
 */
function perdeleriSay(metin) {
  const metinStr = String(metin);
  const bulunan = new Set();
  for (const m of metinStr.matchAll(/═+\s*PERDE\s+(\d+)/g)) bulunan.add(Number(m[1]));
  for (const m of metinStr.matchAll(/PERDE\s+(\d+)\s+ATLANDI/g)) bulunan.delete(Number(m[1]));
  return [...bulunan].sort((a, b) => a - b);
}

/* ── 1) The Node version ─────────────────────────────────────────────────────── */

await kontrol("Node sürümü yeterli", "engines.node", async () => {
  let engines;
  try {
    engines = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))?.engines?.node;
  } catch {
    engines = undefined;
  }
  const kaynak = engines ? `package.json engines "${engines}"` : `varsayılan ${VARSAYILAN_NODE}`;
  const gerekli = surumParcala(engines ?? VARSAYILAN_NODE);
  const mevcut = surumParcala(process.versions.node);
  if (!gerekli || !mevcut) return uyariSonuc(`sürüm okunamadı (${kaynak}) — elle doğrula`);
  const yeter = surumKarsilastir(mevcut, gerekli) >= 0;
  const metin = `v${process.versions.node} ${yeter ? ">=" : "<"} ${gerekli.join(".")} (${kaynak})`;
  return yeter ? gectiSonuc(metin) : kaldiSonuc(`${metin} — sahne makinesinde Node yükselt`);
});

/* ── 2) Whether dist/ is up to date ──────────────────────────────────────────── */

/**
 * The freshness decision is a BLOCKER, not a warning: a warning did not affect the exit code,
 * so a developer who forgot to compile got a "READY FOR THE STAGE" report while the rehearsal
 * ran the stale binary and verified that binary's perfectly good gates. The code that played
 * on stage was different code. The decision now lives in onucusKurallari.mjs and is tested.
 */
const TAZELIK = derlemeTazeligi(ROOT);

await kontrol("dist/ kaynakla güncel", "build tazeliği", async () =>
  TAZELIK.taze ? gectiSonuc(TAZELIK.not) : kaldiSonuc(TAZELIK.not)
);

/* ── 3) .env — the required values, the hosted key, the demo network gate ────── */

await kontrol("Google Ads kimlik bilgileri tam", ".env zorunluları", async () => {
  const zorunlu = [
    "GOOGLE_ADS_DEVELOPER_TOKEN",
    "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_REFRESH_TOKEN",
  ];
  const eksik = zorunlu.filter((a) => !envVar(a));
  if (eksik.length) {
    return kaldiSonuc(`eksik: ${eksik.join(", ")} — .env.example'a bak, token için \`npm run auth\``);
  }
  const mcc = envVar("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
  return gectiSonuc(`4/4 değişken dolu (değerler gösterilmez); GOOGLE_ADS_LOGIN_CUSTOMER_ID: ${mcc ? "var" : "yok"}`);
});

await kontrol("Hosted mod anahtarı", "AEGIS_MASTER_KEY", async () => {
  const ham = envDegeri("AEGIS_MASTER_KEY");
  if (!ham) {
    return uyariSonuc(
      "yok — yalnız hosted mod (`npm run serve`) için zorunlu; stdio sahne demosu etkilenmez"
    );
  }
  if (ham.length < 32) {
    return uyariSonuc("var ama 32 karakterden kısa — hosted mod başlamaz (stdio demosu etkilenmez)");
  }
  return gectiSonuc(`var, ${ham.length} karakter (değer gösterilmez)`);
});

await kontrol("Demo ağ kapısı yapılandırması", ".env — NAC / onaylayıcı", async () => {
  const simVar = envVar("AEGIS_NAC_SIMULATE");
  const tokenVar = envVar("AEGIS_NAC_TOKEN");
  const telefonVar = envVar("AEGIS_APPROVER_PHONE");
  const ozet = [varYok("AEGIS_NAC_SIMULATE"), varYok("AEGIS_NAC_TOKEN"), varYok("AEGIS_APPROVER_PHONE")].join(", ");

  // The rule mirrors the server's fail-closed behaviour and is tested in a pure function;
  // here it is only REPORTED. (Values are never printed — they may be secrets.)
  const karar = agKapisiKarari({
    simVar,
    tokenVar,
    telefonVar,
    simDeger: envDegeri("AEGIS_NAC_SIMULATE"),
  });

  switch (karar.kod) {
    // A contradictory configuration is the most insidious failure on stage: the server
    // refuses EVERY spend increase, Act 1 breaks, and Act 2 gives a configuration refusal
    // instead of the expected SIM-swap text.
    case "yapilandirma-celiskili":
      return kaldiSonuc(
        `${ozet} — ikisi birlikte tanımlı: sunucu çelişkili yapılandırma sayıp her harcama artışını ` +
          "reddeder (Perde 1 kırılır). Demo için token'ı, gerçek doğrulama için SIMULATE'i kaldır"
      );
    // The approver's number is required IN SIMULATION TOO (src/networkTrust.ts,
    // "onaylayici-numarasi-yok"): this branch used to be checked only for a real token, so an
    // operator who uncommented only the simulation line in compose got a green report and
    // then watched every increase refused on stage without a prompt.
    case "onaylayici-numarasi-yok":
      return kaldiSonuc(
        `${ozet} — ${tokenVar ? "token" : "simülasyon kanalı"} var ama onaylayıcı numarası yok: ` +
          "kapalı arıza, her artış istem gösterilmeden reddedilir (AEGIS_APPROVER_PHONE ekle)"
      );
    case "simulasyon-degeri-tanimsiz":
      return uyariSonuc(
        `${ozet} — AEGIS_NAC_SIMULATE değeri tanınmadı (gösterilmez; geçerli: "temiz" | "degisti"). ` +
          "Senaryo betiği kendi değerini geçirdiği için `npm run demo` etkilenmez, betik dışı sürüşte reddedilir"
      );
    default:
      return gectiSonuc(
        `${ozet} — senaryo betiği simülasyon kanalını ve demo onaylayıcı numarasını kendi geçirir; ` +
          ".env ayarı yalnız betik dışı sürüşte (masaüstü MCP istemcisi) gerekir"
      );
  }
});

/* ── 4) A live Google Ads read: does the refresh token actually work ─────────── */

/**
 * Opens the server binary over stdio and makes ONE light, read-only tool call, following the
 * smoke.mjs pattern. Credentials being "filled in" is not enough: an expired refresh token
 * looks filled in too, and only shows itself on a live call, as invalid_grant.
 */
async function hesaplariOku() {
  const proc = spawn(process.execPath, [DIST_GIRIS], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  const bekleyen = new Map();
  let tampon = "";
  let stderr = "";
  let sonrakiId = 1;

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    tampon += chunk;
    let nl;
    while ((nl = tampon.indexOf("\n")) >= 0) {
      const satir = tampon.slice(0, nl).trim();
      tampon = tampon.slice(nl + 1);
      if (!satir) continue;
      let mesaj;
      try {
        mesaj = JSON.parse(satir);
      } catch {
        continue;
      }
      const istek = bekleyen.get(mesaj.id);
      if (istek) {
        bekleyen.delete(mesaj.id);
        clearTimeout(istek.zamanlayici);
        istek.coz(mesaj);
      }
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c) => (stderr += c));
  // If the server crashes, fail loudly rather than waiting for every call to time out.
  proc.on("exit", (kod) => {
    for (const { red, zamanlayici } of bekleyen.values()) {
      clearTimeout(zamanlayici);
      red(new Error(`sunucu beklenmedik şekilde kapandı (kod ${kod})\n${stderr.slice(-400)}`));
    }
    bekleyen.clear();
  });

  const istek = (method, params) =>
    new Promise((coz, red) => {
      const id = sonrakiId++;
      const zamanlayici = setTimeout(() => {
        bekleyen.delete(id);
        red(new Error(`${method} ${MCP_ZAMAN_ASIMI_MS} ms içinde yanıt vermedi`));
      }, MCP_ZAMAN_ASIMI_MS);
      bekleyen.set(id, { coz, red, zamanlayici });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  try {
    const init = await istek("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "aegis-prova", version: "1.0.0" },
    });
    if (init.error) throw new Error(`initialize başarısız: ${init.error.message}`);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const yanit = await istek("tools/call", { name: "list_accounts", arguments: {} });
    if (yanit.error) throw new Error(`list_accounts protokol hatası: ${yanit.error.message}`);
    const r = yanit.result ?? {};
    return {
      metin: (r.content ?? []).map((c) => c.text ?? "").join("\n"),
      hesaplar: r.structuredContent?.hesaplar ?? [],
      hataMi: r.isError === true,
    };
  } finally {
    proc.kill();
  }
}

await kontrol("Refresh token canlı", "list_accounts (salt-okunur)", async () => {
  // A stale or unverifiable binary is NOT RUN: run it and the code the report measures
  // differs from the code that will play on stage, turning the report into a receipt for a
  // version that no longer exists.
  if (!TAZELIK.taze) return kaldiSonuc(`derleme güvenilmez (${TAZELIK.kod}) — canlı çağrı KOŞTURULMADI; \`npm run build\``);
  const r = await hesaplariOku();
  if (r.hataMi) {
    const ipucu = /invalid_grant/i.test(r.metin) ? " → token süresi dolmuş/iptal: `npm run auth`" : "";
    return kaldiSonuc(`list_accounts hata döndü: ${r.metin.slice(0, 220)}${ipucu}`);
  }
  const kullanilabilir = r.hesaplar.filter((h) => !h.yonetici && !h.erisilemedi);
  if (!kullanilabilir.length) {
    return kaldiSonuc(`${r.hesaplar.length} hesap döndü ama kullanılabilir reklam hesabı yok (yalnız MCC/erişilemeyen)`);
  }
  const ozet = `${r.hesaplar.length} hesap, ${kullanilabilir.length} kullanılabilir`;
  if (MUSTERI && !kullanilabilir.some((h) => h.id === MUSTERI)) {
    return uyariSonuc(`${ozet} — ama --musteri ${MUSTERI} kullanılabilir listede YOK (yanlış kimlik ya da erişim yok)`);
  }
  return gectiSonuc(MUSTERI ? `${ozet}; --musteri ${MUSTERI} listede` : ozet);
});

/* ── 5) The demo scenario — a dry run ────────────────────────────────────────── */

await kontrol("Demo senaryosu kuru koşuda geçer", "demo-senaryo.mjs (kuru)", async () => {
  if (!MUSTERI) return uyariSonuc("--musteri verilmedi — kuru koşu atlandı (sahneden önce mutlaka koştur)");
  // The same reasoning: a stale binary's dry run does not represent the stage, and its
  // "passed" is misleading.
  if (!TAZELIK.taze) return kaldiSonuc(`derleme güvenilmez (${TAZELIK.kod}) — kuru koşu KOŞTURULMADI; \`npm run build\``);

  const argumanlar = [join(ROOT, "scripts", "demo-senaryo.mjs"), "--musteri", MUSTERI];
  if (KAMPANYA) argumanlar.push("--kampanya", KAMPANYA);
  // stdin is closed: in dry mode there is no keyboard question, only --canli asks one; and
  // a closed stdin also stops an unexpected prompt from hanging the rehearsal silently.
  const r = await komutCalistir(process.execPath, argumanlar, DEMO_ZAMAN_ASIMI_MS, {
    env: { ...process.env, NO_COLOR: "1" },
  });
  const tumu = `${r.cikti}\n${r.hata}`;

  if (r.zamanAsimi) return kaldiSonuc(`${DEMO_ZAMAN_ASIMI_MS / 1000} sn içinde bitmedi — son satır: ${sonSatir(tumu)}`);
  if (r.kod !== 0) {
    const hataSatiri = /DEMO HATASI: .*/.exec(tumu)?.[0] ?? sonSatir(tumu);
    return kaldiSonuc(`çıkış kodu ${r.kod} — ${hataSatiri.slice(0, 260)}`);
  }
  // The exit code is not enough on its own: the acts are MEASURED, counted from the real
  // output.
  const perdeler = perdeleriSay(tumu);
  const perdeMetni = perdeler.length ? `oynayan perdeler: ${perdeler.join(", ")}` : "hiç perde başlığı yok";
  if (perdeler.length < BEKLENEN_PERDE_SAYISI) {
    return kaldiSonuc(
      `çıkış kodu 0 ama yalnız ${perdeler.length}/${BEKLENEN_PERDE_SAYISI} perde oynadı (${perdeMetni}) — ` +
        "bir perde sessizce düşmüş; sahnede eksik demo oynar"
    );
  }
  // The hard refusal in Act 2, and in Act 3/B, is the lifeblood of the performance.
  if (!/AĞ DOĞRULAMASI BAŞARISIZ/.test(tumu)) {
    return uyariSonuc(`çıkış kodu 0, ${perdeler.length} perde oynadı ama ağ ret metni çıktıda yok — senaryo değişmiş olabilir`);
  }
  return gectiSonuc(`çıkış kodu 0, ${perdeler.length} perde oynadı (${perdeler.join(", ")}), sert ret doğrulandı (yazma yok)`);
});

/* ── 6) Docker (konteyner demosu istenirse) ──────────────────────────────────── */

await kontrol("Docker hazır", "docker CLI + daemon", async () => {
  const surum = await komutCalistir("docker", ["--version"], DOCKER_ZAMAN_ASIMI_MS);
  if (surum.yok) return uyariSonuc("docker CLI bulunamadı — konteyner demosu yapılamaz (sahne için şart değil)");
  if (surum.zamanAsimi || surum.kod !== 0) {
    return uyariSonuc(`docker --version başarısız (kod ${surum.kod}) — ${sonSatir(surum.hata) || "çıktı yok"}`);
  }
  const bilgi = await komutCalistir("docker", ["info", "--format", "{{.ServerVersion}}"], DOCKER_ZAMAN_ASIMI_MS);
  if (bilgi.zamanAsimi || bilgi.kod !== 0) {
    return uyariSonuc(
      `${sonSatir(surum.cikti)} var ama daemon yanıt vermiyor (Docker Desktop kapalı?) — konteyner demosu yapılamaz`
    );
  }
  return gectiSonuc(`${sonSatir(surum.cikti)}, daemon ayakta (server ${sonSatir(bilgi.cikti) || "?"})`);
});

/* ── The report ──────────────────────────────────────────────────────────────── */

const genislik = Math.max(...sonuclar.map((s) => s.soz.length), 10);

/**
 * The worst surprise on stage is a check that says it passed while running right at the
 * edge: if the live call takes 80 seconds during the rehearsal, the report says "ready" and
 * on stage it hits the timeout. The duration is measured anyway — we simply make the slow
 * ones visible.
 */
const YAVAS_ESIK_MS = 15_000;
const sure = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} sn` : `${ms} ms`);

console.log("\n  Aegis — sahne öncesi ön-uçuş (prova)\n");
for (const s of sonuclar) {
  const damga = s.ms >= YAVAS_ESIK_MS ? `  [yavaş: ${sure(s.ms)}]` : "";
  console.log(`  ${s.durum}  ${s.soz.padEnd(genislik)}  ${s.ad}${damga}`);
  if (s.not) console.log(`         ${" ".repeat(genislik)}  ${s.not}`);
}

const yavaslar = sonuclar.filter((s) => s.ms >= YAVAS_ESIK_MS);

const kalanlar = sonuclar.filter((s) => s.durum === KALDI);
const uyarilar = sonuclar.filter((s) => s.durum === UYARI);
const gecenler = sonuclar.filter((s) => s.durum === GECTI);

console.log(`\n  ${gecenler.length}/${sonuclar.length} kontrol geçti, ${uyarilar.length} uyarı, ${kalanlar.length} engel`);

if (kalanlar.length) {
  console.log("\n  SAHNEYE HAZIR DEĞİL — eksikler:");
  for (const s of kalanlar) console.log(`    - ${s.soz}: ${s.not}`);
} else {
  console.log("\n  SAHNEYE HAZIR");
}
if (uyarilar.length) {
  console.log(`\n  Uyarılar (sahneyi durdurmaz${kalanlar.length ? "" : ", ama bilerek çık"}):`);
  for (const s of uyarilar) console.log(`    - ${s.soz}: ${s.not}`);
}
if (yavaslar.length) {
  console.log(`\n  Yavaş kontroller (sahnede zaman aşımına dönüşebilir, eşik ${sure(YAVAS_ESIK_MS)}):`);
  for (const s of yavaslar) console.log(`    - ${s.soz}: ${sure(s.ms)}`);
}
console.log("");

process.exit(kalanlar.length ? 1 : 0);
