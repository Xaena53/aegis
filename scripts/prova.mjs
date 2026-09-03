#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/*
 * AdsPilot — Google Ads MCP server
 * Copyright (C) 2026 Xaena53 (github.com/Xaena53) and the AdsPilot contributors
 *
 * This program is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License version 3 as published by the Free
 * Software Foundation. See the LICENSE file for details.
 */

/**
 * Sahne günü ön-uçuş kontrolü ("prova").
 *
 * `npm run demo` sahnede tek atışlıktır: jüri karşısında bayat bir `dist/`, süresi dolmuş
 * bir refresh token ya da kapalı bir Docker Desktop demoyu bitirir. Bu betik o arızaları
 * SAHNEDEN ÖNCE, aynı gerçek yollardan geçerek bulur: sunucu ikilisini stdio ile açar,
 * canlı Google Ads okuması yapar ve demo senaryosunu KURU modda baştan sona oynatır.
 *
 * Hiçbir yazma yapılmaz: canlı çağrı salt-okunurdur (list_accounts) ve senaryo kuru
 * modda çalışır — Perde 1 ve 3/A'da araç hiç çağrılmaz, Perde 2 ve 3/B ağ kapısında
 * yazmadan ÖNCE reddedilir. Sır sızdırmaz: .env değişkenleri yalnız "var/yok" olarak
 * raporlanır, değerleri (tanınmayan ADSPILOT_NAC_SIMULATE değeri dahil) asla yazılmaz.
 *
 * Rapor biçimi `scripts/smoke.mjs` ile aynıdır; tek fark üç durumlu olmasıdır:
 *   GEÇTİ  — sahneye engel yok
 *   UYARI  — demo yine de oynar ama bilmen gereken bir eksik var (çıkış kodunu bozmaz)
 *   KALDI  — sahnede kırılır; çıkış kodu 1
 *
 * Kullanım:
 *   npm run prova -- --musteri <müşteri-id> [--kampanya <kampanya-id>]
 *   --musteri verilmezse demo kuru koşusu ATLANIR (uyarı) — diğer kontroller yine çalışır.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config as dotenvYukle } from "dotenv";
// Kararlar burada değil, sınanabilir saf fonksiyonlarda yaşıyor (bkz. onucusKurallari.mjs):
// betiğe gömülü bir kuralın yanlış olduğunu hiçbir test söyleyemiyordu.
import { agKapisiKarari, derlemeTazeligi } from "./onucusKurallari.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_GIRIS = join(ROOT, "dist", "index.js");

/** Sürüm bilgisi engines'te yoksa dayanılacak alt sınır. */
const VARSAYILAN_NODE = "22";
const MCP_ZAMAN_ASIMI_MS = 90_000; // smoke.mjs ile aynı: canlı Google çağrısı yavaş olabilir
const DEMO_ZAMAN_ASIMI_MS = 240_000; // senaryo dört sunucu süreci açar ve anlatım için bekler

/**
 * Senaryonun oynatması BEKLENEN perde sayısı. Kuru koşunun çıkış kodu 0 olması tek
 * başına yetmez: perdelerden biri sessizce düşerse (ölü yardımcı, atlanan sahne) çıkış
 * kodu yine 0 olur ve eksik demo ancak jüri karşısında fark edilir. Bu yüzden perde
 * sayısı çıktıdan GERÇEKTEN sayılır, sabit metin basılmaz.
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

/* ── .env okuması (yalnız VARLIK; değerler asla yazdırılmaz) ─────────────────── */

/**
 * Sunucu .env'i proje kökünden kendi yükler (bkz. src/config.ts). Prova aynı dosyayı
 * okur ama `processEnv: {}` ile KENDİ ortamına yazmaz: çocuğa geçen ortamı değiştirip
 * ölçtüğü davranışı bozmamalı. Öncelik dotenv'inkiyle aynıdır — kabuk değişkeni kazanır.
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

/* ── kontrol kaydı ───────────────────────────────────────────────────────────── */

const GECTI = "GEÇTİ";
const UYARI = "UYARI";
const KALDI = "KALDI";

const sonuclar = [];

/**
 * Tek bir kontrolü çalıştırır. Fırlatılan hata KALDI olarak kaydedilir, koşuyu durdurmaz:
 * sahneden önce eksiklerin TAMAMINI görmek, ilkinde durup ikinciyi sahnede keşfetmekten
 * iyidir.
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

/* ── yardımcılar ─────────────────────────────────────────────────────────────── */

function surumParcala(ham) {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(ham ?? ""));
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : undefined;
}

function surumKarsilastir(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Bir komutu zaman aşımıyla çalıştırır; ENOENT (komut yok) hata değil, sonuçtur. */
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
 * Kuru koşu çıktısındaki perde başlıklarını sayar — senaryo bunları
 * `═══ PERDE <n> ═══…` biçiminde basar (renk kapalıyken de aynı metin). Aynı perde
 * numarası birden çok kez görünse bile bir kez sayılır; dönen küme sıralıdır.
 *
 * Başlığı saymak TEK BAŞINA yetmez: senaryo, perde başlığını uygun kampanya arayan
 * ön kapılardan ÖNCE basar ve aday bulunamazsa "PERDE <n> ATLANDI" deyip geçer.
 * Başlığa bakan bir sayaç o durumda 3/3 der ve sahnede iki perde oynar — provanın
 * yakalaması gereken tam da budur. Bu yüzden ATLANDI işaretli perdeler DÜŞÜLÜR.
 */
function perdeleriSay(metin) {
  const metinStr = String(metin);
  const bulunan = new Set();
  for (const m of metinStr.matchAll(/═+\s*PERDE\s+(\d+)/g)) bulunan.add(Number(m[1]));
  for (const m of metinStr.matchAll(/PERDE\s+(\d+)\s+ATLANDI/g)) bulunan.delete(Number(m[1]));
  return [...bulunan].sort((a, b) => a - b);
}

/* ── 1) Node sürümü ──────────────────────────────────────────────────────────── */

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

/* ── 2) dist/ güncelliği ─────────────────────────────────────────────────────── */

/**
 * Tazelik kararı UYARI değil ENGEL: uyarı çıkış kodunu bozmuyordu, dolayısıyla derlemeyi
 * unutan geliştirici "SAHNEYE HAZIR" raporu alıyor, prova da bayat ikiliyi koşturup o
 * ikilinin sağlam kapılarını doğruluyordu. Sahnede oynayan kod ise başka bir koddu.
 * Karar artık onucusKurallari.mjs'te ve sınanıyor.
 */
const TAZELIK = derlemeTazeligi(ROOT);

await kontrol("dist/ kaynakla güncel", "build tazeliği", async () =>
  TAZELIK.taze ? gectiSonuc(TAZELIK.not) : kaldiSonuc(TAZELIK.not)
);

/* ── 3) .env — zorunlular, hosted anahtarı, demo ağ kapısı ───────────────────── */

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

await kontrol("Hosted mod anahtarı", "ADSPILOT_MASTER_KEY", async () => {
  const ham = envDegeri("ADSPILOT_MASTER_KEY");
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
  const simVar = envVar("ADSPILOT_NAC_SIMULATE");
  const tokenVar = envVar("ADSPILOT_NAC_TOKEN");
  const telefonVar = envVar("ADSPILOT_APPROVER_PHONE");
  const ozet = [varYok("ADSPILOT_NAC_SIMULATE"), varYok("ADSPILOT_NAC_TOKEN"), varYok("ADSPILOT_APPROVER_PHONE")].join(", ");

  // Kural sunucunun kapalı arıza davranışının aynasıdır ve saf fonksiyonda sınanır;
  // burada yalnız RAPORLANIR. (Değerler asla yazdırılmaz — sır olabilir.)
  const karar = agKapisiKarari({
    simVar,
    tokenVar,
    telefonVar,
    simDeger: envDegeri("ADSPILOT_NAC_SIMULATE"),
  });

  switch (karar.kod) {
    // Çelişkili yapılandırma sahnede en sinsi arıza: sunucu HER harcama artışını reddeder,
    // Perde 1 kırılır ve Perde 2 beklenen SIM metni yerine yapılandırma reti verir.
    case "yapilandirma-celiskili":
      return kaldiSonuc(
        `${ozet} — ikisi birlikte tanımlı: sunucu çelişkili yapılandırma sayıp her harcama artışını ` +
          "reddeder (Perde 1 kırılır). Demo için token'ı, gerçek doğrulama için SIMULATE'i kaldır"
      );
    // Onaylayıcı numarası SİMÜLASYONDA DA zorunlu (src/networkTrust.ts, "onaylayici-numarasi-yok"):
    // eskiden bu dal yalnız gerçek token için sorulurdu; compose'da yalnız simülasyonu açan
    // operatör yeşil rapor alıp sahnede her artışın istemsiz reddedildiğini görüyordu.
    case "onaylayici-numarasi-yok":
      return kaldiSonuc(
        `${ozet} — ${tokenVar ? "token" : "simülasyon kanalı"} var ama onaylayıcı numarası yok: ` +
          "kapalı arıza, her artış istem gösterilmeden reddedilir (ADSPILOT_APPROVER_PHONE ekle)"
      );
    case "simulasyon-degeri-tanimsiz":
      return uyariSonuc(
        `${ozet} — ADSPILOT_NAC_SIMULATE değeri tanınmadı (gösterilmez; geçerli: "temiz" | "degisti"). ` +
          "Senaryo betiği kendi değerini geçirdiği için `npm run demo` etkilenmez, betik dışı sürüşte reddedilir"
      );
    default:
      return gectiSonuc(
        `${ozet} — senaryo betiği simülasyon kanalını ve demo onaylayıcı numarasını kendi geçirir; ` +
          ".env ayarı yalnız betik dışı sürüşte (masaüstü MCP istemcisi) gerekir"
      );
  }
});

/* ── 4) Canlı Google Ads okuması (refresh token gerçekten çalışıyor mu) ──────── */

/**
 * Sunucu ikilisini stdio ile açıp TEK hafif salt-okunur araç çağrısı yapar (smoke.mjs
 * deseni). Kimlik bilgilerinin "dolu" olması yetmez: süresi dolmuş bir refresh token da
 * dolu görünür ve ancak canlı çağrıda (invalid_grant) ortaya çıkar.
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
  // Sunucu çökerse her çağrının zaman aşımına uğramasını beklemeden gürültülü başarısız ol.
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
      clientInfo: { name: "adspilot-prova", version: "1.0.0" },
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
  // Bayat/doğrulanamayan ikili KOŞTURULMAZ: koşturulursa raporun ölçtüğü kod ile sahnede
  // oynayacak kod farklı olur ve rapor, artık var olmayan bir sürümün fişi hâline gelir.
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

/* ── 5) Demo senaryosu — kuru koşu ───────────────────────────────────────────── */

await kontrol("Demo senaryosu kuru koşuda geçer", "demo-senaryo.mjs (kuru)", async () => {
  if (!MUSTERI) return uyariSonuc("--musteri verilmedi — kuru koşu atlandı (sahneden önce mutlaka koştur)");
  // Aynı gerekçe: bayat ikilinin kuru koşusu sahneyi temsil etmez, "geçti" demesi yanıltır.
  if (!TAZELIK.taze) return kaldiSonuc(`derleme güvenilmez (${TAZELIK.kod}) — kuru koşu KOŞTURULMADI; \`npm run build\``);

  const argumanlar = [join(ROOT, "scripts", "demo-senaryo.mjs"), "--musteri", MUSTERI];
  if (KAMPANYA) argumanlar.push("--kampanya", KAMPANYA);
  // stdin kapalı: kuru modda klavye sorusu yoktur (yalnız --canli sorar); kapalı stdin
  // beklenmedik bir istemin provayı sessizce asmasını da engeller.
  const r = await komutCalistir(process.execPath, argumanlar, DEMO_ZAMAN_ASIMI_MS, {
    env: { ...process.env, NO_COLOR: "1" },
  });
  const tumu = `${r.cikti}\n${r.hata}`;

  if (r.zamanAsimi) return kaldiSonuc(`${DEMO_ZAMAN_ASIMI_MS / 1000} sn içinde bitmedi — son satır: ${sonSatir(tumu)}`);
  if (r.kod !== 0) {
    const hataSatiri = /DEMO HATASI: .*/.exec(tumu)?.[0] ?? sonSatir(tumu);
    return kaldiSonuc(`çıkış kodu ${r.kod} — ${hataSatiri.slice(0, 260)}`);
  }
  // Çıkış kodu tek başına yetmez: perdeler ÖLÇÜLÜR, sayı çıktıdan gerçekten sayılır.
  const perdeler = perdeleriSay(tumu);
  const perdeMetni = perdeler.length ? `oynayan perdeler: ${perdeler.join(", ")}` : "hiç perde başlığı yok";
  if (perdeler.length < BEKLENEN_PERDE_SAYISI) {
    return kaldiSonuc(
      `çıkış kodu 0 ama yalnız ${perdeler.length}/${BEKLENEN_PERDE_SAYISI} perde oynadı (${perdeMetni}) — ` +
        "bir perde sessizce düşmüş; sahnede eksik demo oynar"
    );
  }
  // Perde 2'nin (ve Perde 3/B'nin) sert reti sahnenin can damarıdır.
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

/* ── rapor ───────────────────────────────────────────────────────────────────── */

const genislik = Math.max(...sonuclar.map((s) => s.soz.length), 10);

/**
 * Sahnede en beter sürpriz, GEÇTİ diyen ama sınırda koşan bir kontroldür: canlı
 * çağrı prova sırasında 80 sn sürerse rapor "hazır" der, sahnede zaman aşımına
 * takılır. Süre zaten ölçülüyor — yavaş olanı görünür kılıyoruz.
 */
const YAVAS_ESIK_MS = 15_000;
const sure = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} sn` : `${ms} ms`);

console.log("\n  AdsPilot — sahne öncesi ön-uçuş (prova)\n");
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
