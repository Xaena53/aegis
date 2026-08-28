#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Growth Brain CLI — araştırma → strateji → kreatif → (yalnız --uygula ile) uygulama
 * → (yalnız --yayinla ile) yayına alma denemesi → rapor.
 *
 * Kullanım:
 *   node scripts/growth-brain.mjs --hedef "..." --url <finalUrl> --butce <günlük TL tavanı> \
 *     --musteri <id> [--sektor "..."] [--uygula [--yayinla]]
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
 *     Kampanya PAUSED doğar.
 *
 * --yayinla MODU (yalnız --uygula ile birlikte; ayrı ve açık İKİNCİ onay):
 *   - Kampanya kurulduktan SONRA set_campaign_status → ENABLED DENENİR. Bu çağrı
 *     sunucuda HIGH risk etiketlidir: ağ kapısı (CAMARA SIM-swap zinciri) insan onayı
 *     isteminden ÖNCE çalışır — "LLM planlar, her para hareketi ağ kapısından geçer"
 *     iddiası tek koşuda uçtan uca GÖSTERİLİR.
 *   - Güvenlik değişmezleri GEVŞETİLMEZ: elicitation yine ilan edilmez, confirm yine
 *     gönderilmez. Yani ağ sinyali temiz olsa bile sunucu doğrulanmış insan onayı
 *     olmadığı için reddedebilir; CLI bu sonucu da dürüstçe raporlar. Yayına alma
 *     kararını her koşulda SUNUCU verir, bu istemci onay uyduramaz.
 *   - ENABLED çağrısı YALNIZ brain/uygulama.mjs'teki yayinaAl() fonksiyonundan çıkar;
 *     kurulum yolunun kara listesi (set_campaign_status/update_campaign_budget) aynen durur.
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
  '  node scripts/growth-brain.mjs --hedef "kampanya hedefi" --url https://site.example --butce 50 --musteri 1234567890 [--sektor "..."] [--uygula [--yayinla]]',
  "",
  "Argümanlar:",
  '  --hedef    Kampanyanın iş hedefi (zorunlu, örn. "yeni müşteri kaydı").',
  "  --url      Reklamın gideceği sayfa (zorunlu, http/https).",
  "  --butce    Günlük bütçe TAVANI, TL (zorunlu, pozitif sayı).",
  "  --musteri  Google Ads müşteri ID (zorunlu, yalnız rakam ve tire).",
  "  --sektor   Sektör bilgisi (isteğe bağlı).",
  "  --uygula   Planı Google Ads'e TASLAK (PAUSED) olarak yazar; terminalde 'Evet' onayı ister.",
  "             Bayrak verilmezse KURU MOD: hiçbir yazma yapılmaz, yalnız rapor üretilir.",
  "  --yayinla  Kurulan kampanyayı AYRI ve açık bir ikinci 'Evet' onayından sonra YAYINA ALMAYI",
  "             dener (set_campaign_status → ENABLED). Bu çağrı HIGH risk etiketlidir: sunucudaki",
  "             ağ kapısı (CAMARA SIM-swap doğrulaması) ateşlenir ve kararı o verir.",
  "             --uygula OLMADAN kullanılamaz.",
].join("\n");

/* ── Argüman ayrıştırma ─────────────────────────────────────────────────────── */

export function argumanlariAyristir(argv) {
  const DEGERLI = new Map([
    ["--hedef", "hedef"],
    ["--url", "url"],
    ["--butce", "butce"],
    ["--musteri", "musteri"],
    ["--sektor", "sektor"],
  ]);
  const sonuc = { uygula: false, yayinla: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--uygula") {
      sonuc.uygula = true;
      continue;
    }
    if (arg === "--yayinla") {
      sonuc.yayinla = true;
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

/**
 * Bayrak/argüman doğrulaması. ANTHROPIC_API_KEY kontrolünden ÖNCE çalışır (ana()
 * istemciyi bundan sonra kurar): bozuk bir komut satırı hiçbir API anahtarıyla
 * düzelmez, dolayısıyla en somut hatayı önce vermek doğrudur — aksi hâlde
 * "--yayinla tek başına kullanılamaz" hatası "anahtar yok" hatasının arkasında
 * kalır ve kullanıcı yanlış şeyi düzeltmeye çalışır.
 */
export function girdileriDogrula(args) {
  // Bayrak birleşimi EN ÖNCE: en spesifik ve en ucuz kontrol.
  if (args.yayinla === true && args.uygula !== true) {
    throw new Error(
      "--yayinla yalnız --uygula ile birlikte kullanılabilir: yayına alınacak kampanyanın " +
        "önce bu koşuda TASLAK (PAUSED) olarak kurulmuş olması gerekir. Var olan bir " +
        "kampanyayı yayına almak bu aracın işi değildir.\n\n" +
        KULLANIM
    );
  }
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
    yayinla: args.yayinla === true,
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
function planOzetiSatirlari({ plan, kreatif, efektifTavan, tavanKaynagi, musteri, url, yayinla }) {
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
    "│ Kampanya DURAKLATILMIŞ (PAUSED) taslak olarak yazılır.",
    yayinla
      ? "│ --yayinla açık: bu adımdan SONRA yayına alma için AYRI bir onay daha istenecek."
      : "│ Yayına alma bu koşuda YOK (--yayinla verilmedi).",
    "└──────────────────────────────────────────────────────────",
  ];
}

/** Yayına alma öncesi ikinci onay ekranı — para hareketi bu adımda başlar. */
function yayinOzetiSatirlari({ plan, kampanyaId, musteri }) {
  return [
    "┌─ YAYINA ALMA — GERÇEK PARA HAREKETİ ────────────────────",
    `│ Kampanya    : ${terminalTemiz(plan.kampanyaAdi)} (ID ${terminalTemiz(kampanyaId)})`,
    `│ Müşteri ID  : ${terminalTemiz(musteri)}`,
    `│ Günlük bütçe: ${plan.butceGunlukTL} TL — Google günlük bütçenin katlarını harcayabilir.`,
    "│ Çağrı       : set_campaign_status → ENABLED (sunucuda HIGH risk etiketli)",
    "│ Bu çağrıda sunucudaki AĞ KAPISI ateşlenir: CAMARA SIM-swap doğrulaması, onay",
    "│ isteminden ÖNCE çalışır ve reddederse hiç para harcanmaz.",
    "│ NOT: bu CLI insan onayı UYDURAMAZ (elicitation ilan edilmez, confirm gönderilmez);",
    "│ ağ temiz geçse bile sunucu doğrulanmış onay isteyerek reddedebilir — bu normaldir.",
    "└──────────────────────────────────────────────────────────",
  ];
}

/** Yayın denemesinin sonucunu terminale dürüstçe basar (ret metni AYNEN gösterilir). */
function yayinSonucuYazdir(yayinSonucu) {
  const basliklar = {
    basarili: "SONUÇ: KAMPANYA YAYINDA (ENABLED) — gerçek harcama başladı.",
    "ag-retti": "SONUÇ: AĞ KAPISI REDDETTİ — güvenlik çalıştı, hiç para harcanmadı.",
    "insan-onayi-gerekli":
      "SONUÇ: SUNUCU DOĞRULANMIŞ İNSAN ONAYI İSTEDİ — bu CLI onay uyduramaz, hiç para harcanmadı.",
    reddedildi: "SONUÇ: SUNUCU REDDETTİ — hiç para harcanmadı.",
    hata: "SONUÇ: YAYIN DENEMESİ SONUÇSUZ — sunucudan anlaşılır karar alınamadı.",
  };
  console.log("\n" + (basliklar[yayinSonucu.durum] ?? `SONUÇ: ${terminalTemiz(yayinSonucu.durum)}`));
  if (yayinSonucu.sonucMetni) {
    console.log("── Sunucunun cevabı (aynen) ──────────────────────────────");
    console.log(yayinSonucu.sonucMetni);
    console.log("──────────────────────────────────────────────────────────");
  }
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

/**
 * Operatör onayını klavyeden okur — ve stdin KAPANIRSA cevap beklemez.
 *
 * NEDEN: `rl.question` girdi tükendiğinde (boru sonu, `< /dev/null`, kopmuş oturum)
 * HİÇBİR ZAMAN çözülmez. Node bunu "unsettled top-level await" diye bildirip süreci
 * ÇIKIŞ KODU 0 ile sonlandırır — yani çağıran taraf, onay hiç alınmamışken koşuyu
 * başarılı sanır. Bu yaşandı: borulanmış bir koşuda yayına alma sorusu asılı kaldı ve
 * betik sessizce "başarıyla" bitti.
 *
 * EOF bir cevap DEĞİLDİR: boş dize döner, çağıran onu 'Evet' saymadığı için sonuç
 * RET olur. Susan bir kanal onay yerine geçmez (kapalı arıza) — demo betiğindeki
 * operatoreSor ile aynı sözleşme.
 *
 * BUNUN İKİNCİ BİR SONUCU VAR VE O DA BİLEREKTİR: her çağrı kendi arayüzünü kurduğu
 * için, borulanmış girdide ilk soru stdin'i tüketir ve İKİNCİ soru anında EOF görür.
 * Yani `printf 'Evet
Evet
' | npm run brain -- --uygula --yayinla` ile yayına alma
 * ADIMI OTOMATİKLEŞTİRİLEMEZ; ikinci onay reddedilir ve kampanya PAUSED kalır.
 *
 * Bu bir eksiklik değil, kapının varlık sebebinin ta kendisi: insan onayı borudan
 * beslenebiliyorsa insan onayı değildir. Betikle sürülen gösterim için `npm run demo`
 * vardır ve o, onayı kendisinin verdiğini ekranda açıkça söyler.
 */
async function operatorOnayi(soru) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await Promise.race([
      rl.question(soru).then((c) => c.trim(), () => ""),
      new Promise((coz) => rl.once("close", () => coz(""))),
    ]);
  } finally {
    rl.close();
  }
}

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

    // --yayinla bir adım daha ekler; sayaç buna göre yazılır.
    const N = girdi.yayinla ? 5 : 4;

    console.log(`\n[1/${N}] Araştırma…`);
    const arastirma = await arastir(
      { hedef: girdi.hedef, siteUrl: girdi.url, sektor: girdi.sektor },
      { jsonUret2, cagir: mcp?.cagir }
    );
    console.log(`Araştırma tamam: ${arastirma.anahtarKelimeAdaylari.length} anahtar kelime adayı.`);

    console.log(`\n[2/${N}] Strateji…`);
    const plan = await stratejiKur(
      { hedef: girdi.hedef, butceGunlukTL: efektifTavan, arastirma },
      { jsonUret2 }
    );
    planDogrula(plan, efektifTavan);
    console.log(`Plan doğrulandı: "${terminalTemiz(plan.kampanyaAdi)}" — günlük ${plan.butceGunlukTL} TL.`);

    console.log(`\n[3/${N}] Kreatif…`);
    const kreatif = await kreatifUret(
      { plan, arastirma, finalUrl: girdi.url },
      { jsonUret2 }
    );
    console.log(`Kreatif hazır: ${kreatif.basliklar.length} başlık / ${kreatif.aciklamalar.length} açıklama.`);

    let uygulamaSonucu;
    if (!kuruMod) {
      console.log(`\n[4/${N}] Uygulama — insan onayı gerekiyor.`);
      for (const satir of planOzetiSatirlari({
        plan,
        kreatif,
        efektifTavan,
        tavanKaynagi,
        musteri: girdi.musteri,
        url: girdi.url,
        yayinla: girdi.yayinla,
      })) {
        console.log(satir);
      }
      const cevap = await operatorOnayi(
        "Bu plan hesabına TASLAK (PAUSED) olarak yazılsın mı? Yalnız 'Evet' devam ettirir: "
      );
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
      console.log(`\n[4/${N}] Uygulama atlandı (kuru mod).`);
    }

    /*
     * [5/5] Yayına alma denemesi — YALNIZ --yayinla yolundan ve YALNIZ bu koşuda
     * kurulmuş, tamamlanmış bir kampanya varsa. yayinaAl() başka hiçbir yerden
     * çağrılmaz; ENABLED çağrısının tek çıkış noktası burasıdır.
     */
    let yayinSonucu;
    if (girdi.yayinla) {
      console.log(`\n[5/${N}] Yayına alma — AYRI ve açık ikinci onay gerekiyor.`);
      if (!uygulamaSonucu || uygulamaSonucu.basari !== true || !uygulamaSonucu.kampanyaId) {
        const neden =
          uygulamaSonucu === undefined
            ? "kurulum onayı verilmedi — ortada yayına alınacak kampanya yok."
            : "kurulum tamamlanmadı (kampanya yarım ya da ID doğrulanamadı); yarım kampanya yayına alınmaz.";
        console.log(`Yayına alma ATLANDI: ${neden}`);
        yayinSonucu = { denendi: false, durum: "atlandi", sonucMetni: neden, kanitSatirlari: [] };
      } else {
        for (const satir of yayinOzetiSatirlari({
          plan,
          kampanyaId: uygulamaSonucu.kampanyaId,
          musteri: girdi.musteri,
        })) {
          console.log(satir);
        }
        const cevap2 = await operatorOnayi(
          "Bu kampanya YAYINA ALINSIN mı? Yalnız 'Evet' devam ettirir: "
        );
        if (cevap2.toLocaleLowerCase("tr-TR") !== "evet") {
          console.log("Onay verilmedi — yayına alma çağrısı hiç yapılmadı. Kampanya PAUSED kalıyor.");
          yayinSonucu = {
            denendi: false,
            durum: "onaysiz",
            sonucMetni: "Operatör ikinci onayı vermedi; set_campaign_status hiç çağrılmadı.",
            kanitSatirlari: [],
          };
        } else {
          console.log("Ağ kapısına gidiliyor (set_campaign_status → ENABLED, HIGH risk)…");
          const { yayinaAl } = await import("./brain/uygulama.mjs");
          yayinSonucu = await yayinaAl(
            { kampanyaId: uygulamaSonucu.kampanyaId, musteriId: girdi.musteri },
            { cagir: mcp.cagir }
          );
          yayinSonucuYazdir(yayinSonucu);
        }
      }
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
      yayinSonucu,
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
    /*
     * Kapı kararları (ağ reddi, doğrulanmış onay istenmesi, sunucu reddi) BAŞARISIZLIK
     * DEĞİLDİR — sistemin amacı budur, çıkış kodu 0 kalır. Yalnız 'hata' (anlaşılmaz
     * yanıt / araç hatası) sonuç belirsiz bıraktığı için 1 döner.
     */
    if (yayinSonucu && yayinSonucu.durum === "hata") {
      console.error(
        "UYARI: yayın denemesinin sonucu belirsiz — kampanyanın gerçek durumunu hesaptan doğrula."
      );
      return 1;
    }
    return 0;
  } finally {
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
