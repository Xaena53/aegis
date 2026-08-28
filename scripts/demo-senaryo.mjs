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
 *   Perde 3 (temiz + degisti, iki alt sahne): AYNI kapının HIGH katmanı —
 *                                            set_campaign_status → ENABLED (go-live),
 *                                            pencere 24 değil 72 saat
 *
 * Varsayılan mod KURU'dur: Perde 1 ve 3/A'da gerçek yazma aracı ÇAĞRILMAZ — betik araç
 * çağrısından hemen önce durur ve "[kuru] araç çağrısı atlandı" yazar. --canli
 * bayrağı verilirse gerçekten çağrılır (+1 küçük artış; onaydan sonra bütçe eski
 * değerine geri alınır — azaltma onay istemez). --canli'da onay kararını betik
 * DEĞİL, klavyeden yalnız 'Evet' yazan gerçek operatör verir (readline).
 *
 * Perde 3'ün canlı provası YALNIZCA --kampanya ile açıkça verilen ve PAUSED olan TEST
 * kampanyasında yapılır: kampanya gerçekten ENABLED edilir, sahne biter bitmez PAUSED'a
 * geri alınır ve durum GERİ OKUNARAK doğrulanır. Geri alma doğrulanamazsa betik BAĞIRIR
 * (kırmızı acil kutusu + çıkış kodu 1) — yayında kalan kampanya gerçek para harcar.
 *
 * Perde 2'nin ve Perde 3/B'nin çağrısı kuru modda da güvenlidir: ağ kapısı yazmadan ÖNCE
 * reddeder. Beklenen ret gelmezse (ya da istem bir kez bile gösterilirse) demo HATA ile
 * biter; bu perdelerin elicitation handler'ı her ihtimale karşı DAİMA reddeder (fail-closed).
 *
 * ADSPILOT_NV_SIMULATE tanımlıysa (değerini bu betik BELİRLEMEZ, yalnız sunucu süreçlerine
 * olduğu gibi geçirir) Perde 3'te zincirin 2. halkasının kanıt satırı da vurgulanır.
 *
 * Kullanım:
 *   npm run demo -- --musteri <müşteri-id> [--kampanya <kampanya-id>] [--canli]
 *   Varsayılan KURU moddur (hiç yazma yok); --canli gerçek (küçük, geri alınan) bir bütçe
 *   artışı uygular ve --kampanya verilmişse TEST kampanyasını kısa süre yayına alır.
 *
 *   node scripts/demo-senaryo.mjs --kendini-sina   (gizli; müşteri/dist gerektirmez)
 *   Senaryoyu OYNATMAZ: yalnız yukarıdaki güvenlik kilidinin — "geri alma doğrulanamadı"
 *   bayrağının — gerçekten kırmızı acil kutusunu bastığını ve çıkış kodunu 1 yaptığını
 *   kanıtlar. Kilidin kendisi çağrılır, kopyası değil.
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
/** Gizli: senaryoyu değil, Perde 3'ün güvenlik kilidini sınar (aşağıda kendiniSina). */
const KENDINI_SINA = process.argv.includes("--kendini-sina");

/**
 * HIGH katman (yayına alma) penceresi — sunucudakiyle AYNI kural: CAMARA aralığı 1–2400,
 * kullanılamaz değer 72'ye düşer. Burada yalnız EKRANA yazmak ve isteme gelen kanıt
 * satırını doğrulamak için hesaplanır; kararı her zaman sunucu verir.
 */
function yuksekPencereSaat() {
  const ham = Number(process.env.ADSPILOT_SIMSWAP_WINDOW_HOURS);
  if (!Number.isFinite(ham) || ham < 1) return 72;
  return Math.min(2400, Math.round(ham));
}
const PENCERE_YUKSEK = yuksekPencereSaat();

/**
 * Zincirin 2. halkası (ADSPILOT_NV_SIMULATE). Değerini BU BETİK BELİRLEMEZ: yalnız
 * tanımlı mı diye bakar ve sunucu süreçlerine mevcut değeriyle geçirir (bkz. sunucuBaslat,
 * ADSPILOT_ önekli tüm değişkenler aynen iletilir).
 */
const ZINCIR_2 = Boolean(process.env.ADSPILOT_NV_SIMULATE?.trim());

/**
 * Onay isteyen araç çağrıları için İSTEMCİ tarafı zaman aşımı. MCP SDK varsayılanı 60
 * saniyedir ve insan onayı beklerken bu çok kısadır: operatör istemi okurken çağrı
 * düşer, ekrana "Request timed out" gelir ve sahne kırılır. Sunucunun elicitInput
 * zaman aşımıyla (approval.ts: 10 dakika) hizalanır ki kapıyı ikisinden biri değil,
 * hep aynı süre belirlesin.
 */
const ONAY_ZAMAN_ASIMI = { timeout: 10 * 60_000, resetTimeoutOnProgress: true };

// --kendini-sina hiçbir sunucuya bağlanmaz ve hiçbir hesap okumaz: ne müşteri kimliği
// ne de derlenmiş dist/ ister. Bu yüzden aşağıdaki iki ön koşulun dışında tutulur.
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
 * --canli provasında GERÇEK operatör kararını klavyeden okur (betik karar VERMEZ).
 *
 * stdin kapanırsa (borulanmış girdi tükendi, `< /dev/null`, kopmuş oturum) rl.question
 * hiçbir zaman çözülmez ve koşu onay zaman aşımı boyunca asılı kalırdı. EOF bir cevap
 * değildir: boş dize döner ve çağıran onu 'Evet' saymadığı için sonuç RET olur — susan
 * bir kanal onay yerine geçmez (kapalı arıza).
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

  /**
   * GERÇEK TOKEN BİLEREK BOŞALTILIR.
   *
   * Sunucu, token ile simülasyon değişkeninin BİRLİKTE tanımlı olmasını çelişkili
   * yapılandırma sayar ve harcamayı reddeder (belirsizlikte gevşek kanal seçilmez).
   * O kural doğrudur ve kalmalıdır — ama sahne demosunu da kırar: .env'de gerçek bir
   * ADSPILOT_NAC_TOKEN bulunduğu an, yukarıdaki döngü onu spawn ortamına kopyalar ve
   * her perde "çelişkili yapılandırma" retiyle biter. Bu yaşandı: token geldiği gün
   * demo, kodda hiçbir şey değişmeden çalışmaz oldu.
   *
   * Boş dize yeterli: config.ts `?.trim() || undefined` ile okuduğu için boş değer
   * "tanımsız" demektir. Sunucu .env'i kendi de yüklediğinden, DEĞİŞKENİ ATLAMAK
   * yetmez — üzerine boş yazmak gerekir.
   *
   * Demo bir SİMÜLASYON gösterisidir; gerçek CAMARA sorgusu için demo değil,
   * `docs/CAMARA.md` §3 kontrol listesi izlenir.
   */
  env.ADSPILOT_NAC_TOKEN = "";

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

/** run_gaql (salt-okunur) çalıştırır ve satırları döndürür. */
async function gaqlSatirlar(client, sorgu, limit = 50) {
  const res = await client.callTool({ name: "run_gaql", arguments: { customerId: MUSTERI, query: sorgu, limit } });
  if (res.isError) throw new Error(`Okuma başarısız (run_gaql): ${ilkMetin(res)}`);
  const satirlar = res.structuredContent?.satirlar;
  if (Array.isArray(satirlar)) return satirlar;
  // structuredContent gelmezse metindeki JSON'a düş (":\n[...]" biçimi)
  const m = ilkMetin(res).match(/:\n(\[[\s\S]*\])\s*$/);
  return m ? JSON.parse(m[1]) : [];
}

/** run_gaql (salt-okunur) ile kampanya adaylarını + mevcut bütçelerini okur (sıralı). */
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
  // Otomatik seçimde: önce PAUSED, sonra en küçük bütçe (tavan kelepçesine takılma
  // riski en düşük; --canli modunda da en tehlikesiz aday budur).
  adaylar.sort((a, b) => (a.durum === "PAUSED" ? 0 : 1) - (b.durum === "PAUSED" ? 0 : 1) || a.butce - b.butce);
  return adaylar;
}

/** Perde 1/2'nin tek adayı: en tehlikesiz kampanya. */
async function kampanyaOku(client, kampanyaId) {
  return (await kampanyalariOku(client, kampanyaId))[0];
}

/** Hesabın günlük bütçe tavanını SALT-OKUNUR limits kaynağından okur (okunamazsa undefined). */
async function tavanOku(client) {
  try {
    const res = await client.readResource({ uri: `adspilot://accounts/${MUSTERI}/limits` });
    const tavan = Number(JSON.parse(String(res?.contents?.[0]?.text ?? "{}"))?.gunlukButceTavani);
    return Number.isFinite(tavan) ? tavan : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Perde 3 adayı. set_campaign_status ağ kapısına gelmeden ÖNCE iki kapıya bakar:
 * (1) kampanyanın günlük bütçesi hesabın güvenlik tavanını aşmamalı, (2) yayınlanabilir
 * (ENABLED reklam grubunda ENABLED) bir reklamı olmalı. Bunlardan birine takılan bir
 * kampanyada perde ağ kanıtını gösteremez — o yüzden aday ÖNCEDEN salt-okunur sorgularla
 * doğrulanır ve uygun aday yoksa perde dürüstçe atlanır (uydurma kanıt üretilmez).
 *
 * --canli yayına alma yalnız PAUSED bir kampanyada anlamlıdır: zaten yayındaki bir
 * kampanyayı "geri alma" adımı DURDURUR — başkasının canlı kampanyasını duraklatmayız.
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
 * Kampanyayı PAUSED'a döndürür ve durumu GERİ OKUYARAK doğrular — araç yanıtına inanmak
 * yetmez, yayında kalan kampanya gerçek para harcar. Bir kez yeniden dener.
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

/** Geri alma doğrulanamadı: sessiz kalmak yok — ekranda BAĞIR. */
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
 * İstem metnindeki ağ doğrulama kanıt satırlarını (zincir halkalarını) ayıklar.
 * Halka sayısı sunucunun kaç kanıt eklediğine bağlıdır; betik hiçbirini uydurmaz.
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
/** Perde 3/A canlı provası: kanıtlanana kadar "yayında" sayılır (kapalı arıza). */
let perde3Kampanya;
let perde3GeriAlinmadi = false;

/**
 * GÜVENLİK KİLİDİ — tek nokta, tek gerçek.
 *
 * Perde 3/A canlı provasında yayına alınan kampanyanın PAUSED'a döndüğü KANITLANAMADIYSA
 * sessiz kalınmaz: kırmızı acil kutusu basılır ve çıkış kodu 1 olur. Bayrağın çıkış
 * koduna bağlanması BU fonksiyonda olur; koşunun finally'si ile gizli --kendini-sina
 * yolu AYNI fonksiyonu çağırır, dolayısıyla sınanan yol canlı provanın kullandığı yolun
 * ta kendisidir (kopya kod yok).
 *
 * @returns kilit tetiklendi mi
 */
function guvenlikKilidiniUygula() {
  if (!perde3GeriAlinmadi) return false;
  geriAlmaBagir(perde3Kampanya);
  cikisKodu = 1;
  process.exitCode = 1;
  return true;
}

/**
 * Sinyalle ölüm, finally'yi ATLAR.
 *
 * Perde 3/A canlı provasında kampanya ENABLED edildikten sonra PAUSED'a dönene kadar
 * kısa ama gerçek bir pencere vardır. O aralıkta Ctrl+C'ye basılırsa Node varsayılan
 * davranışıyla süreci finally'yi çalıştırmadan sonlandırır: ne acil kutusu basılır ne
 * çıkış kodu 1 olur — kampanya yayında kalıp gerçek para harcamaya devam eder. Kanca,
 * kilidin "koşu nasıl biterse bitsin en son burası konuşur" sözünü sinyal yoluna da
 * taşır. Kilit tetiklenmiyorsa (tehlike penceresi dışında) sinyal olağan biçimde,
 * 128+sinyal koduyla sonlanır.
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
 * Gizli --kendini-sina: senaryoyu OYNATMAZ, yalnız güvenlik kilidinin gerçekten bağlı
 * olduğunu iki yönde kanıtlar (geri alma doğrulandı → kutu yok/kod 0; doğrulanamadı →
 * kutu + kod 1). Sınama kendi beklentisini doğrulayamazsa 2 ile çıkar: "kilit sınandı"
 * diye sessizce geçmesindense gürültülü kırılsın.
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
    "AEGIS DEMO — Ağ Doğrulamalı Onay (AdsPilot MCP, LLM'siz)",
    [
      "Gerçek sunucu, gerçek MCP protokolü, gerçek Google Ads okuması.",
      `Mod: ${CANLI ? "CANLI (yazma araçları GERÇEKTEN çağrılır)" : "KURU (gerçek yazma yok; --canli ile açılır)"}`,
      `Müşteri: ${MUSTERI}   Onaylayıcı (demo): ${DEMO_TELEFON} — spawn env ile geçirildi`,
      "SIM Swap kanalı: SİMÜLASYON (ADSPILOT_NAC_SIMULATE) — gerçek ağ sorgusu yapılmaz.",
      `Perde 1: ${EYLEM_BUTCE} · Perde 2: aynı istek, SIM değişmiş · Perde 3: ${EYLEM_YAYIN}`,
      ...(ZINCIR_2
        ? ["Zincirin 2. halkası etkin (ADSPILOT_NV_SIMULATE tanımlı) — kanıt satırı Perde 3'te vurgulanır."]
        : []),
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
      // Operatör 'Evet' yazmadı: yazma uygulanmadı — bu bir demo hatası değil, gerçek karardır.
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
    eylem: EYLEM_BUTCE,
    sim: "degisti",
    karar: "RET (ağ doğrulaması başarısız)",
    istem: "HİÇ gösterilmedi (0)",
    yazma: "yok (kapıda reddedildi)",
  });
  await istemci.close();
  istemci = undefined;
  await bekle(900);

  /* ── PERDE 3: AYNI kapının HIGH katmanı — yayına alma ──────────────────────── */
  await perdeBasligi(
    3,
    `set_campaign_status → ENABLED — AYNI kapı, HIGH katman: pencere 24 değil ${PENCERE_YUKSEK} saat`
  );
  yaz(soluk("İki alt sahne: 3/A ağ temiz (onay akışı işler) · 3/B SIM değişmiş (sert ret)."));

  /* ── PERDE 3/A: ağ temiz ───────────────────────────────────────────────────── */
  yaz("\n" + kalin(`── PERDE 3/A ── ADSPILOT_NAC_SIMULATE=temiz — yayına alma denenir`));

  let perde3aIstemSayisi = 0;
  let perde3KanitVar = false;
  let perde3OperatorOnayi = false;
  /** Handler kapanışı: kampanya ancak sunucu açıldıktan sonra okunabilir, çağrı anında dolu olur. */
  let aday3;

  istemci = await sunucuBaslat("temiz", async (req) => {
    perde3aIstemSayisi++;
    const mesaj = String(req.params.message);
    kutu("ONAY İSTEMİ — YAYINA ALMA (gerçek MCP elicitation)", mesaj.split("\n"), sari);

    // Kanıt satırlarını sunucu üretir; betik hiçbirini uydurmaz, yalnız ayıklayıp
    // zincir halkalarına göre işaretler.
    const kanitlar = kanitSatirlari(mesaj);
    const ikinciHalkaMi = (s) => /numara doğrulaması/i.test(s);
    for (const k of kanitlar) {
      yaz(ikinciHalkaMi(k) ? cyan(`  zincir 2 ▶ ${k}`) : soluk(`  zincir 1 ▶ ${k}`));
    }
    if (ZINCIR_2 && !kanitlar.some(ikinciHalkaMi)) {
      yaz(sari("ADSPILOT_NV_SIMULATE tanımlı ama istemde 2. halkanın kanıt satırı YOK — vurgulanacak kanıt üretilmedi."));
    }

    if (!CANLI) {
      // Kuru modda buraya hiç gelinmemeli; gelinirse fail-closed reddet (stdin bekletme).
      yaz(kirmizi("[kuru] modda onay istemi beklenmiyordu — demo güvenlik gereği 'hayır' dedi."));
      return { action: "decline" };
    }
    // HIGH katmanın kanıtı penceredir: medium 24 saatken burası PENCERE_YUKSEK saat olmalı.
    if (!(/SİMÜLASYON/.test(mesaj) && new RegExp(`son ${PENCERE_YUKSEK} saat`).test(mesaj))) {
      yaz(kirmizi(`Beklenen HIGH kanıt satırı (SİMÜLASYON + "son ${PENCERE_YUKSEK} saat") istemde YOK — demo güvenlik gereği 'hayır' dedi.`));
      return { action: "decline" };
    }
    perde3KanitVar = true;
    // Karar betiğin DEĞİL, klavyenin: yalnız birebir 'Evet' kabul edilir.
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
    // Uydurma kanıt yok: ön kapılara takılan bir kampanyada ağ kapısı hiç konuşmaz.
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

    // Canlı prova YALNIZ PAUSED kampanyada: zaten yayındaki bir kampanyada "geri alma"
    // adımı onu DURDURURDU — başkasının canlı kampanyasını duraklatmayız.
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
              ? '      "Numara doğrulaması [SİMÜLASYON]: ... cihazından geliyor SAYILDI" — zincirin 2. halkası (ADSPILOT_NV_SIMULATE tanımlı)\n'
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
      // Kapalı arıza: çağrıdan ÖNCE "yayında" say. Aksi KANITLANANA kadar bayrak kalkmaz;
      // koşu nasıl biterse bitsin finally'deki güvenlik kilidi bağırır ve çıkış kodunu bozar.
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
        // Çağrı düştü: yazmanın olup olmadığı BİLİNMİYOR. Karar aşağıdaki geri okumaya
        // bırakılır — "hata aldım, demek ki yazılmadı" varsayımı tam da kilidin
        // yakalaması gereken sessiz yayında-kalma durumunu kaçırırdı.
        cagriHatasi = e?.message ?? String(e);
        yaz(kirmizi(`Yayına alma çağrısı hata verdi: ${cagriHatasi}`));
      }

      // Araç yanıtına İNANILMAZ: gerçek durum her koşulda hesaptan GERİ OKUNUR.
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
        // Çağrı hata verdiyse bu bir başarı değil, sessizce yayında kalmış bir kampanyadır.
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
        // Yayına hiç alınmadı: geri alınacak bir şey yok, kilit kalkar. Bayrak YALNIZ
        // durumun hesaptan geri okunmasıyla düşer; okuma başarısız olduğunda yukarıdaki
        // catch "ENABLED" varsayar ve kilit açık kalır (kapalı arıza korunur).
        perde3GeriAlinmadi = false;
        perde3Kampanya = undefined;
        if (cagriHatasi) {
          // Çağrı düştü ama kampanya yayına ALINMADI (geri okundu) — yanlış yere acil
          // alarmı çalmadan, dürüst bir demo hatasıyla bit.
          throw new Error(
            `Perde 3/A çağrısı tamamlanamadı: ${cagriHatasi}\n` +
              `Kampanya #${aday3.id} yayına ALINMADI — durum hesaptan geri okundu: ${suanki}.`
          );
        }
        if (/NUMARA DOĞRULAMASI BAŞARISIZ/.test(metin3)) {
          // Zincirin 2. halkası reddetti: SIM Swap temiz olsa bile istem gösterilmez.
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
          // Operatör 'Evet' yazmadı: yazma uygulanmadı — bu bir demo hatası değil, gerçek karardır.
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

    /* ── PERDE 3/B: SIM değişmiş — sert ret, istem HİÇ gösterilmez ──────────── */
    if (perde3GeriAlinmadi) {
      // Yayında kalmış olabilecek bir kampanya varken yeni yazma denemesi yapılmaz.
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
      yaz("\n" + kalin("── PERDE 3/B ── ADSPILOT_NAC_SIMULATE=degisti — AYNI yayına alma isteği"));
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

      // Söze değil hesaba bakılır: yazmanın gerçekten olmadığı GERİ OKUNARAK doğrulanır.
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
      // Aday zaten ENABLED verilmişse (yalnız kuru modda mümkün) bu bir ihlal değildir.
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

  /* ── Özet tablosu ──────────────────────────────────────────────────────────── */
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
  yaz(soluk("Not: tüm ağ metinleri SİMÜLASYON etiketlidir; gerçek CAMARA sorgusu için ADSPILOT_NAC_TOKEN kullanılır.\n"));
} catch (e) {
  console.error(kirmizi(`\nDEMO HATASI: ${e?.message ?? e}`));
  cikisKodu = 1;
} finally {
  if (istemci) await istemci.close().catch(() => {});
  // GÜVENLİK KİLİDİ: koşu nasıl biterse bitsin (başarı, hata, beklenmedik fırlatma)
  // en son burası konuşur. Ekranın SONUNDA durması bilinçlidir — kutu özet tablosunun
  // altında kalır, yukarı kaymaz. Kilidi --kendini-sina aynı fonksiyondan sınar.
  guvenlikKilidiniUygula();
}
process.exitCode = cikisKodu;
process.exit(cikisKodu);
