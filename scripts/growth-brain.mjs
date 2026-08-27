#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Growth Brain CLI — araştırma → strateji → kreatif → (yalnız --uygula ile) uygulama → rapor.
 *
 * Kullanım:
 *   node scripts/growth-brain.mjs --hedef "..." --url <finalUrl> --butce <günlük TL tavanı> \
 *     --musteri <id> [--sektor "..."] [--uygula]
 *
 * VARSAYILAN KURU MOD:
 *   - MCP'ye HİÇ bağlanılmaz, uygulama modülü import bile edilmez.
 *   - Google Ads hesabına hiçbir yazma yapılmaz; yalnız plan + kreatif + rapor üretilir.
 *   - Rapor "KURU MOD — HİÇBİR YAZMA YAPILMADI" damgası taşır.
 *
 * --uygula MODU (istemci-tarafı ikinci kemer):
 *   - adspilot://accounts/{id}/limits kaynağı okunur, efektif tavan =
 *     min(CLI tavanı, sunucu tavanı) olarak TEKLEŞTİRİLİR ve planDogrula'ya bu değer gider.
 *   - İlk yazmadan önce planın tam özeti terminalde gösterilir ve Türkçe onay istenir:
 *     'Evet' yazılmadıkça hiçbir yazma çağrısı yapılmaz.
 *   - mcpBaglan elicitation İLAN ETMEZ ve hiçbir araca confirm gönderilmez: yayına alma /
 *     bütçe artışı gibi onay isteyen işlemler sunucu tarafında tasarım gereği reddedilir.
 *     Kampanya PAUSED doğar; bu CLI onu hiçbir koşulda yayına almaz.
 *
 * Sır hijyeni: tüm catch'lerde yalnız e?.message yazdırılır; env değerleri hiçbir
 * çıktıya ve isteme taşınmaz.
 */
import "dotenv/config"; // ANTHROPIC_API_KEY projenin .env dosyasından da okunabilsin (hata metni bunu tarif eder)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { anthropicIstemci, jsonUret, mcpBaglan } from "./brain/ortak.mjs";
import { arastir } from "./brain/arastirma.mjs";
import { stratejiKur, planDogrula } from "./brain/strateji.mjs";
import { kreatifUret } from "./brain/kreatif.mjs";
import { raporOlustur } from "./brain/rapor.mjs";

/** src/config.ts parseBudgetCap varsayılanı — sunucu tavanı okunamadığında güvenli alt sınır. */
const SUNUCU_VARSAYILAN_TAVAN = 500;

const KULLANIM = [
  "Kullanım:",
  '  node scripts/growth-brain.mjs --hedef "kampanya hedefi" --url https://site.example --butce 50 --musteri 1234567890 [--sektor "..."] [--uygula]',
  "",
  "Argümanlar:",
  '  --hedef    Kampanyanın iş hedefi (zorunlu, örn. "yeni müşteri kaydı").',
  "  --url      Reklamın gideceği sayfa (zorunlu, http/https).",
  "  --butce    Günlük bütçe TAVANI, TL (zorunlu, pozitif sayı).",
  "  --musteri  Google Ads müşteri ID (zorunlu, yalnız rakam ve tire).",
  "  --sektor   Sektör bilgisi (isteğe bağlı).",
  "  --uygula   Planı Google Ads'e TASLAK (PAUSED) olarak yazar; terminalde 'Evet' onayı ister.",
  "             Bayrak verilmezse KURU MOD: hiçbir yazma yapılmaz, yalnız rapor üretilir.",
].join("\n");

/* ── Argüman ayrıştırma ─────────────────────────────────────────────────────── */

function argumanlariAyristir(argv) {
  const DEGERLI = new Map([
    ["--hedef", "hedef"],
    ["--url", "url"],
    ["--butce", "butce"],
    ["--musteri", "musteri"],
    ["--sektor", "sektor"],
  ]);
  const sonuc = { uygula: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--uygula") {
      sonuc.uygula = true;
      continue;
    }
    if (arg === "--yardim" || arg === "-h" || arg === "--help") {
      sonuc.yardim = true;
      continue;
    }
    const alan = DEGERLI.get(arg);
    if (!alan) throw new Error(`Bilinmeyen argüman: '${arg}'\n\n${KULLANIM}`);
    const deger = argv[i + 1];
    if (deger === undefined || deger.startsWith("--")) {
      throw new Error(`'${arg}' bir değer bekliyor.\n\n${KULLANIM}`);
    }
    sonuc[alan] = deger;
    i++;
  }
  return sonuc;
}

function girdileriDogrula(args) {
  const eksikler = ["hedef", "url", "butce", "musteri"].filter(
    (a) => typeof args[a] !== "string" || !args[a].trim()
  );
  if (eksikler.length) {
    throw new Error(`Eksik zorunlu argüman: ${eksikler.map((a) => "--" + a).join(", ")}\n\n${KULLANIM}`);
  }
  if (!/^https?:\/\//i.test(args.url.trim())) {
    throw new Error("--url http:// ya da https:// ile başlamalı.");
  }
  const butce = Number(args.butce);
  if (!Number.isFinite(butce) || butce <= 0) {
    throw new Error(`--butce pozitif bir sayı olmalı (gelen: '${args.butce}').`);
  }
  const musteri = args.musteri.trim();
  if (!/^[0-9-]{1,20}$/.test(musteri)) {
    throw new Error("--musteri yalnız rakam ve tire içerebilir (örn. 1234567890).");
  }
  return {
    hedef: args.hedef.trim(),
    url: args.url.trim(),
    butce,
    musteri,
    sektor: typeof args.sektor === "string" && args.sektor.trim() ? args.sektor.trim() : undefined,
    uygula: args.uygula === true,
  };
}

/* ── Yardımcılar ────────────────────────────────────────────────────────────── */

/** Terminale gidecek (çoğu zaten doğrulanmış) metinden kontrol/ANSI karakterlerini söker. */
function terminalTemiz(metin, tavan = 160) {
  // Ham kontrol bayti tasimamak icin regex literal yerine kod noktasi kontrolu (strateji.mjs deseni).
  let temiz = "";
  for (const ch of String(metin ?? "")) {
    const kod = ch.codePointAt(0);
    temiz += kod <= 0x1f || (kod >= 0x7f && kod <= 0x9f) ? " " : ch;
  }
  temiz = temiz.replace(/  +/g, " ").trim();
  return temiz.length > tavan ? temiz.slice(0, tavan) + "..." : temiz;
}

/** Kampanya adından dosya-güvenli slug üretir (Türkçe harfler çevrilir). */
export function slugUret(ad) {
  const cevrim = { ç: "c", ğ: "g", ı: "i", i: "i", ö: "o", ş: "s", ü: "u" };
  const slug = String(ad ?? "")
    .toLocaleLowerCase("tr-TR")
    .replace(/[çğıöşü]/g, (h) => cevrim[h])
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "kampanya";
}

/** Onay öncesi terminalde gösterilecek tam plan özeti (yalnız doğrulanmış alanlar). */
function planOzetiSatirlari({ plan, kreatif, efektifTavan, tavanKaynagi, musteri, url }) {
  const gruplar = Array.isArray(plan.adGruplari) ? plan.adGruplari : [];
  const kelimeSayisi = gruplar.reduce(
    (t, g) => t + (Array.isArray(g?.anahtarKelimeler) ? g.anahtarKelimeler.length : 0),
    0
  );
  const negatifSayisi = Array.isArray(plan.negatifKelimeler) ? plan.negatifKelimeler.length : 0;
  return [
    "┌─ PLAN ÖZETİ — YAZMADAN ÖNCE KONTROL ET ─────────────────",
    `│ Kampanya adı : ${terminalTemiz(plan.kampanyaAdi)}`,
    `│ Müşteri ID   : ${terminalTemiz(musteri)}`,
    `│ Günlük bütçe : ${plan.butceGunlukTL} TL (bağlayıcı tavan: ${efektifTavan} TL — ${tavanKaynagi})`,
    `│ Hedef ülke   : ${terminalTemiz(plan.hedefUlke)} · Dil: ${terminalTemiz(plan.dil)}`,
    `│ Kelimeler    : ${kelimeSayisi} pozitif / ${negatifSayisi} negatif`,
    `│ Kreatif      : ${kreatif.basliklar.length} başlık / ${kreatif.aciklamalar.length} açıklama`,
    `│ Hedef sayfa  : ${terminalTemiz(url)}`,
    "│ Kampanya DURAKLATILMIŞ (PAUSED) taslak olarak yazılır; yayına alma bu araçta YOK.",
    "└──────────────────────────────────────────────────────────",
  ];
}

/**
 * Efektif bütçe tavanı: min(CLI tavanı, sunucu maxDailyBudget).
 * Sunucu tavanı okunamazsa fail-closed: min(CLI, sunucu varsayılanı 500).
 */
async function efektifTavanBelirle(mcp, musteri, cliTavan) {
  try {
    const metin = await mcp.kaynakOku(`adspilot://accounts/${musteri.replace(/\D/g, "")}/limits`);
    const limits = JSON.parse(metin);
    if (limits?.yazmaIzni === false) {
      throw new Error(
        "Sunucuda yazma araçları kapalı (ADSPILOT_ENABLE_WRITE) — --uygula çalıştırılamaz. " +
          "Kuru modda rapor üretebilirsin."
      );
    }
    const sunucuTavan = limits?.gunlukButceTavani;
    if (typeof sunucuTavan === "number" && Number.isFinite(sunucuTavan) && sunucuTavan > 0) {
      return sunucuTavan < cliTavan
        ? { tavan: sunucuTavan, kaynak: `sunucu maxDailyBudget (${sunucuTavan} TL)` }
        : { tavan: cliTavan, kaynak: "CLI --butce tavanı" };
    }
    console.error("[brain] Uyarı: limits kaynağında geçerli tavan yok — güvenli varsayılan uygulandı.");
  } catch (e) {
    if (/--uygula çalıştırılamaz/.test(String(e?.message))) throw e;
    console.error(`[brain] Uyarı: sunucu tavanı okunamadı (${terminalTemiz(e?.message)}).`);
  }
  const tavan = Math.min(cliTavan, SUNUCU_VARSAYILAN_TAVAN);
  return {
    tavan,
    kaynak:
      tavan === cliTavan
        ? "CLI --butce tavanı (sunucu tavanı okunamadı)"
        : `güvenli varsayılan ${SUNUCU_VARSAYILAN_TAVAN} TL (sunucu tavanı okunamadı — fail-closed)`,
  };
}

/* ── Ana akış ───────────────────────────────────────────────────────────────── */

async function ana() {
  const ham = argumanlariAyristir(process.argv.slice(2));
  if (ham.yardim) {
    console.log(KULLANIM);
    return 0;
  }
  const girdi = girdileriDogrula(ham);
  const kuruMod = !girdi.uygula;

  // ANTHROPIC_API_KEY yoksa buradaki Türkçe hata üst katmanda aynen gösterilir.
  const anthropic = anthropicIstemci();
  const jsonUret2 = (sistem, kullanici) => jsonUret(anthropic, { sistem, kullanici });

  let mcp = null;
  let rl = null;
  try {
    let efektifTavan = girdi.butce;
    let tavanKaynagi = "CLI --butce tavanı (kuru mod — sunucu tavanı okunmadı)";
    if (!kuruMod) {
      console.log("AdsPilot MCP sunucusuna bağlanılıyor…");
      mcp = await mcpBaglan();
      const sonuc = await efektifTavanBelirle(mcp, girdi.musteri, girdi.butce);
      efektifTavan = sonuc.tavan;
      tavanKaynagi = sonuc.kaynak;
    } else {
      console.log("KURU MOD — Google Ads'e hiçbir yazma yapılmayacak (MCP bağlantısı yok).");
    }
    console.log(`Bağlayıcı günlük bütçe tavanı: ${efektifTavan} TL (${tavanKaynagi})`);

    console.log("\n[1/4] Araştırma…");
    const arastirma = await arastir(
      { hedef: girdi.hedef, siteUrl: girdi.url, sektor: girdi.sektor },
      { jsonUret2, cagir: mcp?.cagir }
    );
    console.log(`Araştırma tamam: ${arastirma.anahtarKelimeAdaylari.length} anahtar kelime adayı.`);

    console.log("\n[2/4] Strateji…");
    const plan = await stratejiKur(
      { hedef: girdi.hedef, butceGunlukTL: efektifTavan, arastirma },
      { jsonUret2 }
    );
    planDogrula(plan, efektifTavan);
    console.log(`Plan doğrulandı: "${terminalTemiz(plan.kampanyaAdi)}" — günlük ${plan.butceGunlukTL} TL.`);

    console.log("\n[3/4] Kreatif…");
    const kreatif = await kreatifUret(
      { plan, arastirma, finalUrl: girdi.url },
      { jsonUret2 }
    );
    console.log(`Kreatif hazır: ${kreatif.basliklar.length} başlık / ${kreatif.aciklamalar.length} açıklama.`);

    let uygulamaSonucu;
    if (!kuruMod) {
      console.log("\n[4/4] Uygulama — insan onayı gerekiyor.");
      for (const satir of planOzetiSatirlari({
        plan,
        kreatif,
        efektifTavan,
        tavanKaynagi,
        musteri: girdi.musteri,
        url: girdi.url,
      })) {
        console.log(satir);
      }
      const { createInterface } = await import("node:readline/promises");
      rl = createInterface({ input: process.stdin, output: process.stdout });
      const cevap = (
        await rl.question("Bu plan hesabına TASLAK (PAUSED) olarak yazılsın mı? Yalnız 'Evet' devam ettirir: ")
      ).trim();
      rl.close();
      rl = null;
      if (cevap.toLocaleLowerCase("tr-TR") !== "evet") {
        console.log("Onay verilmedi — hiçbir yazma yapılmadı. Kuru mod raporu üretiliyor.");
        uygulamaSonucu = undefined;
      } else {
        // uygulama modülü YALNIZ bu noktada yüklenir (kuru modda import bile edilmez).
        const { uygula } = await import("./brain/uygulama.mjs");
        uygulamaSonucu = await uygula(
          { plan, kreatif, musteriId: girdi.musteri, finalUrl: girdi.url },
          { cagir: mcp.cagir }
        );
      }
    } else {
      console.log("\n[4/4] Uygulama atlandı (kuru mod).");
    }

    const yazmaYapilmadi = kuruMod || uygulamaSonucu === undefined;
    const rapor = raporOlustur({
      hedef: girdi.hedef,
      arastirma,
      plan,
      kreatif,
      uygulamaSonucu,
      kuruMod: yazmaYapilmadi,
      efektifTavanTL: efektifTavan,
      tavanKaynagi,
    });
    const dosyaAdi = `rapor-brain-${slugUret(plan.kampanyaAdi)}.md`;
    const dosyaYolu = join(process.cwd(), dosyaAdi);
    writeFileSync(dosyaYolu, rapor, "utf8");
    console.log(`\nRapor yazıldı: ${dosyaYolu}`);

    if (uygulamaSonucu && uygulamaSonucu.basari === false) {
      console.error(
        "UYARI: uygulama KISMEN BAŞARISIZ — kampanya yarım kalmış olabilir; ayrıntı için rapora bak."
      );
      return 1;
    }
    return 0;
  } finally {
    if (rl) rl.close();
    if (mcp) await mcp.kapat();
  }
}

/**
 * Yalnız doğrudan çalıştırıldığında koş: import eden bir test/araç, ana()'yı ve
 * argv ayrıştırmasını istem dışı tetiklememeli.
 */
const dogrudanCalisti = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (dogrudanCalisti) try {
  process.exitCode = await ana();
} catch (e) {
  // Sır hijyeni: yalnız mesaj — hata nesnesi (istek/başlık taşıyabilir) asla komple dökülmez.
  console.error(`\nHata: ${e?.message ?? e}`);
  process.exitCode = 1;
}
