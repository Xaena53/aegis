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
 * Demo senaryosu: deck'teki terminal hikayesini GERÇEK MCP sunucusuyla, LLM'siz
 * (ANTHROPIC_API_KEY gerektirmeden) oynatır. Sunucu dist/index.js'ten stdio ile
 * başlatılır; bu betik elicitation form yeteneği ilan eden bir MCP istemcisidir.
 *
 *   Perde 1 (ADSPILOT_NAC_SIMULATE=temiz)  : ağ temiz → onay istemi → BAŞARI
 *   Perde 2 (ADSPILOT_NAC_SIMULATE=degisti): SIM değişmiş sayılır → SERT RET,
 *                                            onay istemi HİÇ gösterilmez
 *
 * Varsayılan mod KURU'dur: Perde 1'de gerçek yazma aracı ÇAĞRILMAZ — betik araç
 * çağrısından hemen önce durur ve "[kuru] araç çağrısı atlandı" yazar. --canli
 * bayrağı verilirse gerçekten çağrılır (+1 küçük artış; onaydan sonra bütçe eski
 * değerine geri alınır — azaltma onay istemez). --canli'da onay kararını betik
 * DEĞİL, klavyeden yalnız 'Evet' yazan gerçek operatör verir (readline).
 *
 * Perde 2'nin çağrısı kuru modda da güvenlidir: ağ kapısı yazmadan ÖNCE reddeder.
 * Beklenen ret gelmezse (ya da istem bir kez bile gösterilirse) demo HATA ile biter;
 * Perde 2'nin elicitation handler'ı her ihtimale karşı DAİMA reddeder (fail-closed).
 *
 * Kullanım:
 *   npm run demo -- --musteri <müşteri-id> [--kampanya <kampanya-id>] [--canli]
 *   Varsayılan KURU moddur (hiç yazma yok); --canli gerçek (küçük, geri alınan) bir bütçe artışı uygular.
 */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_TELEFON = "+905550001122"; // onaylayıcının DEMO numarası — spawn env ile sunucuya geçer

/* ── CLI ─────────────────────────────────────────────────────────────────────── */

function bayrakDegeri(ad) {
  const i = process.argv.indexOf(ad);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}
const MUSTERI = bayrakDegeri("--musteri");
const KAMPANYA_ARG = bayrakDegeri("--kampanya")?.replace(/\D/g, "") || undefined;
const CANLI = process.argv.includes("--canli");

if (!MUSTERI) {
  console.error("Kullanım: npm run demo -- --musteri <müşteri-id> [--kampanya <kampanya-id>] [--canli]");
  console.error("Varsayılan KURU moddur (hiç yazma yok); --canli gerçek (küçük, geri alınan) bir bütçe artışı uygular.");
  process.exit(1);
}
if (!existsSync(join(ROOT, "dist", "index.js"))) {
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

/** --canli provasında GERÇEK operatör kararını klavyeden okur (betik karar VERMEZ). */
async function operatoreSor(soru) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(sari(soru))).trim();
  } finally {
    rl.close();
  }
}

async function perdeBasligi(no, aciklama) {
  yaz("\n" + kalin(`═══ PERDE ${no} ══════════════════════════════════════════════════`));
  yaz(kalin(aciklama));
  await bekle(500);
}

/* ── MCP yardımcıları ────────────────────────────────────────────────────────── */

const ilkMetin = (res) => String(res?.content?.[0]?.text ?? "");

/**
 * dist/index.js'i stdio ile başlatır ve elicitation FORM yeteneği ilan eden bir
 * istemciyle bağlanır. Simülasyon kanalı + demo onaylayıcı numarası SPAWN ENV'iyle
 * geçirilir; Google kimlik bilgileri sunucunun kendi .env yüklemesinden gelir
 * (GOOGLE_ADS_ ve ADSPILOT_ önekli kabuk değişkenleri de aynen iletilir).
 */
async function sunucuBaslat(simDegeri, elicitHandler) {
  const env = getDefaultEnvironment();
  for (const [k, v] of Object.entries(process.env)) {
    if ((k.startsWith("GOOGLE_ADS_") || k.startsWith("ADSPILOT_")) && v !== undefined) env[k] = v;
  }
  env.ADSPILOT_NAC_SIMULATE = simDegeri;
  env.ADSPILOT_APPROVER_PHONE = DEMO_TELEFON;

  const client = new Client(
    { name: "adspilot-demo-senaryo", version: "1.0.0" },
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

/** run_gaql (salt-okunur) ile kampanya + mevcut bütçeyi okur. */
async function kampanyaOku(client, kampanyaId) {
  const sorgu = kampanyaId
    ? `SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${Number(kampanyaId)} LIMIT 1`
    : `SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED' LIMIT 50`;
  const res = await client.callTool({ name: "run_gaql", arguments: { customerId: MUSTERI, query: sorgu, limit: 50 } });
  if (res.isError) throw new Error(`Kampanya okunamadı (run_gaql): ${ilkMetin(res)}`);

  let satirlar = res.structuredContent?.satirlar;
  if (!Array.isArray(satirlar)) {
    // structuredContent gelmezse metindeki JSON'a düş (":\n[...]" biçimi)
    const m = ilkMetin(res).match(/:\n(\[[\s\S]*\])\s*$/);
    satirlar = m ? JSON.parse(m[1]) : [];
  }
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
  // Otomatik seçimde: önce PAUSED, sonra en küçük bütçe (tavan kelepçesine takılma
  // riski en düşük; --canli modunda da en tehlikesiz aday budur).
  adaylar.sort((a, b) => (a.durum === "PAUSED" ? 0 : 1) - (b.durum === "PAUSED" ? 0 : 1) || a.butce - b.butce);
  return adaylar[0];
}

/* ── Senaryo ─────────────────────────────────────────────────────────────────── */

let istemci; // her perdede yeniden atanır; finally'de kapatılır
let cikisKodu = 0;
const ozet = []; // karşılaştırma tablosu satırları

try {
  kutu(
    "AEGIS DEMO — Ağ Doğrulamalı Onay (AdsPilot MCP, LLM'siz)",
    [
      "Gerçek sunucu, gerçek MCP protokolü, gerçek Google Ads okuması.",
      `Mod: ${CANLI ? "CANLI (yazma araçları GERÇEKTEN çağrılır)" : "KURU (gerçek yazma yok; --canli ile açılır)"}`,
      `Müşteri: ${MUSTERI}   Onaylayıcı (demo): ${DEMO_TELEFON} — spawn env ile geçirildi`,
      "SIM Swap kanalı: SİMÜLASYON (ADSPILOT_NAC_SIMULATE) — gerçek ağ sorgusu yapılmaz.",
    ],
    kalin
  );
  await bekle(900);

  /* ── PERDE 1: ağ temiz ─────────────────────────────────────────────────────── */
  await perdeBasligi(1, `ADSPILOT_NAC_SIMULATE=temiz — ağ temiz: onay akışı normal işler`);

  let perde1IstemSayisi = 0;
  let perde1KanitVar = false;
  let perde1OperatorOnayi = false;
  istemci = await sunucuBaslat("temiz", async (req) => {
    perde1IstemSayisi++;
    const mesaj = String(req.params.message);
    kutu("ONAY İSTEMİ (gerçek MCP elicitation)", mesaj.split("\n"), sari);
    if (!CANLI) {
      // Kuru modda buraya hiç gelinmemeli; gelinirse fail-closed reddet (stdin bekletme).
      yaz(kirmizi("[kuru] modda onay istemi beklenmiyordu — demo güvenlik gereği 'hayır' dedi."));
      return { action: "decline" };
    }
    if (!(/SİMÜLASYON/.test(mesaj) && /SIM değişimi yok/.test(mesaj))) {
      // Beklenen simülasyon kanıtı yoksa bir şeyler ters gitti — fail-closed: reddet.
      yaz(kirmizi("Beklenen SİMÜLASYON kanıt satırı istemde YOK — demo güvenlik gereği 'hayır' dedi."));
      return { action: "decline" };
    }
    perde1KanitVar = true;
    // Karar betiğin DEĞİL, klavyenin: yalnız birebir 'Evet' kabul edilir.
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
      sim: "temiz",
      karar: "[kuru] koşulmadı",
      istem: "[kuru] çağrıya gelinmedi",
      yazma: "[kuru] atlandı",
    });
  } else {
    const res = await istemci.callTool({
      name: "update_campaign_budget",
      arguments: { customerId: MUSTERI, campaignId: kampanya.id, newDailyBudget: hedefButce },
    });
    const metin = ilkMetin(res);
    if (!perde1OperatorOnayi) {
      // Operatör 'Evet' yazmadı: yazma uygulanmadı — bu bir demo hatası değil, gerçek karardır.
      yaz(sari(`Operatör onay vermedi — sunucu yazmayı uygulamadı. Sunucu yanıtı: ${metin}`));
      ozet.push({
        perde: "1",
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

  /* ── PERDE 2: SIM değişmiş ─────────────────────────────────────────────────── */
  await perdeBasligi(2, `ADSPILOT_NAC_SIMULATE=degisti — İKİNCİ sunucu süreci: SIM değişmiş sayılır`);

  let perde2IstemSayisi = 0;
  istemci = await sunucuBaslat("degisti", async () => {
    perde2IstemSayisi++;
    return { action: "decline" }; // buraya HİÇ düşmemeli; düşerse bile fail-closed
  });
  yaz(soluk("Sunucu süreci 2 başlatıldı (stdio) — aynı istemci, aynı elicitation yeteneği."));
  await bekle();

  // Bütçe bu süreçte YENİDEN okunur: deneme her koşulda kesin ARTIŞ olmalı
  // (artış olmayan çağrı ağ kapısına hiç uğramaz ve kuru modda yazma yapardı).
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
    sim: "degisti",
    karar: "RET (ağ doğrulaması başarısız)",
    istem: "HİÇ gösterilmedi (0)",
    yazma: "yok (kapıda reddedildi)",
  });
  await istemci.close();
  istemci = undefined;
  await bekle(900);

  /* ── Özet tablosu ──────────────────────────────────────────────────────────── */
  yaz("\n" + kalin("═══ ÖZET — iki koşunun karşılaştırması ═══════════════════════════"));
  const basliklar = { perde: "Perde", sim: "NAC_SIMULATE", karar: "Ağ kararı", istem: "Onay istemi", yazma: "Yazma" };
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
  yaz("Fail-closed: ağ 'değişti' ya da 'yanıtsız' olduğunda harcama artışı uygulanmaz, istem insana gösterilmez.");
  yaz(soluk("Not: tüm ağ metinleri SİMÜLASYON etiketlidir; gerçek CAMARA sorgusu için ADSPILOT_NAC_TOKEN kullanılır.\n"));
} catch (e) {
  console.error(kirmizi(`\nDEMO HATASI: ${e?.message ?? e}`));
  cikisKodu = 1;
} finally {
  if (istemci) await istemci.close().catch(() => {});
}
process.exit(cikisKodu);
