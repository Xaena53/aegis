#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Growth Brain CLI — research → strategy → creative → application (only with --uygula)
 * → the go-live attempt (only with --yayinla) → the report.
 *
 * Usage:
 *   node scripts/growth-brain.mjs --hedef "..." --url <finalUrl> --butce <daily ceiling> \
 *     --musteri <id> [--sektor "..."] [--uygula [--yayinla]]
 *
 * DRY RUN IS THE DEFAULT:
 *   - MCP is NOT connected at all, and the application module is not even imported.
 *   - Nothing is written to the Google Ads account; only the plan, the creative and the
 *     report are produced.
 *   - The report carries the "KURU MOD — HİÇBİR YAZMA YAPILMADI" stamp.
 *
 * THE --uygula MODE, the second belt on the client side:
 *   - The aegis://accounts/{id}/limits resource is read, the effective ceiling is COLLAPSED
 *     to min(the CLI ceiling, the server's ceiling), and that value is what reaches
 *     planDogrula.
 *   - Before the first write, the full summary of the plan is shown in the terminal and
 *     approval is asked for: unless 'Evet' is typed, no write call happens.
 *   - mcpBaglan DOES NOT ADVERTISE elicitation, and no tool is sent confirm: operations that
 *     want approval — going live, raising a budget — are refused on the server side by
 *     design. The campaign is born PAUSED.
 *
 * THE --yayinla MODE, only alongside --uygula, and behind a separate, explicit SECOND
 * approval:
 *   - AFTER the campaign has been created, set_campaign_status → ENABLED is ATTEMPTED. That
 *     call is labelled HIGH risk on the server: the network gate, the CAMARA SIM-swap chain,
 *     runs BEFORE the human-approval prompt — so the claim "the LLM plans, every movement of
 *     money passes the network gate" is DEMONSTRATED end to end in a single run.
 *   - The security invariants are NOT RELAXED: elicitation is still not advertised, confirm
 *     is still not sent. So even with a clean network signal the server may refuse for want
 *     of verified human approval, and the CLI reports that outcome honestly too. The decision
 *     to go live is the SERVER's under every condition; this client cannot fabricate an
 *     approval.
 *   - The ENABLED call leaves ONLY through the yayinaAl() function in brain/uygulama.mjs;
 *     kurulum yolunun kara listesi (set_campaign_status/update_campaign_budget) aynen durur.
 *
 * Secret hygiene: every catch prints e?.message only, and environment values reach neither
 * the output nor a prompt.
 */
import "dotenv/config"; // model sağlayıcısının anahtarı projenin .env dosyasından da okunabilsin (hata metni bunu tarif eder)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BRAIN_MODEL, BRAIN_SAGLAYICI, beyinIstemcisi, jsonUret, mcpBaglan } from "./brain/ortak.mjs";
import { arastir } from "./brain/arastirma.mjs";
import { stratejiKur, planDogrula } from "./brain/strateji.mjs";
import { kreatifUret } from "./brain/kreatif.mjs";
import { butceDagit, dagitimOzeti, kullanilabilirKanallar, uygulanacakPay } from "./brain/dagitim.mjs";

/**
 * The channel the campaign-creation path ACTUALLY writes to.
 *
 * uygulama.mjs calls only create_search_campaign, add_keywords and
 * create_responsive_search_ad, all of them Google Ads tools. This constant decides which
 * share is taken from the allocation, and guarantees that the code and the report name the
 * same channel.
 */
const UYGULANAN_KANAL = "google";
import { raporOlustur } from "./brain/rapor.mjs";

/** The default from parseBudgetCap in src/config.ts — the safe floor when the server's
 * ceiling cannot be read. */
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

/* ── Argument parsing ───────────────────────────────────────────────────────── */

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
 * Flag and argument validation. It runs BEFORE the API-key check, since ana() builds the
 * client afterwards: a malformed command line is not fixed by any API key, so giving the most
 * concrete error first is the right order — otherwise "--yayinla cannot be used on its own"
 * hides behind "no key", and the user goes off to fix the wrong thing.
 */
export function girdileriDogrula(args) {
  // The flag combination FIRST OF ALL: the most specific and the cheapest check.
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

/* ── Helpers ────────────────────────────────────────────────────────────────── */

/** Strips control and ANSI characters from text bound for the terminal, most of which is
 * already validated. */
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

/** Builds a filename-safe slug from a campaign name, transliterating Turkish letters. */
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

/** The full plan summary shown in the terminal before approval — validated fields
 * only. */
function planOzetiSatirlari({ plan, kreatif, efektifTavan, tavanKaynagi, musteri, url, yayinla, dagitim }) {
  const gruplar = Array.isArray(plan.adGruplari) ? plan.adGruplari : [];
  const kelimeSayisi = gruplar.reduce(
    (t, g) => t + (Array.isArray(g?.anahtarKelimeler) ? g.anahtarKelimeler.length : 0),
    0
  );
  const negatifSayisi = Array.isArray(plan.negatifKelimeler) ? plan.negatifKelimeler.length : 0;
  /**
   * IF THE BUDGET WAS SPLIT, THE APPROVAL SCREEN IS OBLIGED TO SAY SO.
   *
   * Otherwise the line reads as "45 (binding ceiling: 100)" and the operator takes it to
   * mean "I am spending 45 under a ceiling of 100". But 100 is not a ceiling, it is the
   * TOTAL BEING SPLIT, and the remainder has been recommended to another channel. Whoever
   * approves the write must not approve without seeing that what they are approving is a
   * PART of the total.
   */
  const coklu = Array.isArray(dagitim) && dagitim.length > 1;
  const kanalAdi = Array.isArray(dagitim) && dagitim.length ? dagitim[0].kanal : null;
  const butceSatirlari = coklu
    ? [
        `│ Günlük bütçe : ${plan.butceGunlukTL} TL — '${kanalAdi}' kanalının PAYI`,
        `│ Toplam bütçe : ${efektifTavan} TL, ${dagitim.length} kanala bölündü (${dagitimOzeti(dagitim)})`,
        `│ DİKKAT       : bu onay YALNIZ '${kanalAdi}' payı içindir; diğer kanalların payı`,
        "│                yalnızca ÖNERİDİR — bu koşuda o platformlara hiçbir çağrı yapılmaz.",
      ]
    : [`│ Günlük bütçe : ${plan.butceGunlukTL} TL (bağlayıcı tavan: ${efektifTavan} TL — ${tavanKaynagi})`];

  return [
    "┌─ PLAN ÖZETİ — YAZMADAN ÖNCE KONTROL ET ─────────────────",
    `│ Kampanya adı : ${terminalTemiz(plan.kampanyaAdi)}`,
    `│ Müşteri ID   : ${terminalTemiz(musteri)}`,
    ...butceSatirlari,
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

/** The second approval screen, before going live — this is the step where money starts
 * moving. */
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

/** Prints the outcome of the go-live attempt honestly to the terminal; refusal text is
 * shown VERBATIM. */
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
 * The effective budget ceiling: min(the CLI ceiling, the server's maxDailyBudget).
 * If the server's ceiling cannot be read it fails closed to min(the CLI ceiling, the server
 * default of 500).
 */
async function efektifTavanBelirle(mcp, musteri, cliTavan) {
  try {
    const metin = await mcp.kaynakOku(`aegis://accounts/${musteri.replace(/\D/g, "")}/limits`);
    const limits = JSON.parse(metin);
    if (limits?.yazmaIzni === false) {
      throw new Error(
        "Sunucuda yazma araçları kapalı (AEGIS_WRITE_ENABLED) — --uygula çalıştırılamaz. " +
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

/* ── The main flow ──────────────────────────────────────────────────────────── */

/**
 * Reads the operator's approval from the keyboard — and waits for no answer once stdin
 * CLOSES.
 *
 * WHY: `rl.question` NEVER resolves when the input runs out — the end of a pipe,
 * `< /dev/null`, a dropped session. Node reports that as an "unsettled top-level await" and
 * ends the process with EXIT CODE 0 — so the caller believes the run succeeded when no
 * approval was ever given. This actually happened: in a piped run the go-live question hung
 * and the script finished quietly "successfully".
 *
 * EOF is NOT an answer: an empty string is returned, and since the caller does not count that
 * as 'Evet', the outcome is a REFUSAL. A silent channel does not stand in for approval — it
 * fails closed, the same contract as operatoreSor in the demo script.
 *
 * THERE IS A SECOND CONSEQUENCE, AND IT IS DELIBERATE TOO: because each call builds its own
 * interface, on piped input the first question consumes stdin and the SECOND question sees
 * EOF immediately.
 * So `printf 'Evet\nEvet\n' | npm run brain -- --uygula --yayinla`
 * CANNOT AUTOMATE the go-live STEP; the second approval is refused and the campaign stays
 * PAUSED.
 *
 * That is not a shortcoming, it is the very reason the gate exists: human approval that can
 * be fed down a pipe is not human approval. For a script-driven demonstration there is
 * `npm run demo`, and it says plainly on screen that it is giving the approval itself.
 */
/**
 * THE HUMAN GATE. An empty string is ALWAYS a refusal, and that is a rule, not a quiet
 * default.
 *
 * The question is RACED against the stream closing. Without that race, in an environment
 * whose input is closed — a pipeline, CI, a background job — `rl.question` never resolves:
 * the process hangs and looks from outside like it is working. Because the close returns ""
 * and the caller accepts ONLY "evet", a question that cannot be answered becomes a refusal —
 * and passing approval down a pipe is deliberately impossible: `echo evet | ...` gets caught
 * by the same close race.
 *
 * The streams are taken as parameters and default to the real ones in production. That seam
 * is for the tests alone, so the gate's behaviour can be exercised without a real
 * terminal.
 */
export async function operatorOnayi(soru, { girdi = process.stdin, cikti = process.stdout } = {}) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: girdi, output: cikti });
  try {
    return await Promise.race([
      rl.question(soru).then((c) => c.trim(), () => ""),
      new Promise((coz) => rl.once("close", () => coz(""))),
    ]);
  } finally {
    rl.close();
  }
}

/**
 * The SINGLE acceptance rule for the approval phrase. It lives here rather than being
 * repeated at the call sites, so the two gates — writing the draft and going live — cannot
 * drift apart.
 */
export function onayVerildiMi(cevap) {
  return String(cevap ?? "").trim().toLocaleLowerCase("tr-TR") === "evet";
}

async function ana() {
  const ham = argumanlariAyristir(process.argv.slice(2));
  if (ham.yardim) {
    console.log(KULLANIM);
    return 0;
  }
  const girdi = girdileriDogrula(ham);
  const kuruMod = !girdi.uygula;

  /**
   * The provider is selected with `AEGIS_BRAIN_PROVIDER`, defaulting to gemini. With no
   * key, the error raised here is shown verbatim by the layer above and names the key that
   * is required.
   */
  const anthropic = beyinIstemcisi();
  console.log(`Model: ${BRAIN_MODEL} (${BRAIN_SAGLAYICI})`);
  const jsonUret2 = (sistem, kullanici) => jsonUret(anthropic, { sistem, kullanici });

  let mcp = null;
  try {
    let efektifTavan = girdi.butce;
    let tavanKaynagi = "CLI --butce tavanı (kuru mod — sunucu tavanı okunmadı)";
    if (!kuruMod) {
      console.log("Aegis MCP sunucusuna bağlanılıyor…");
      mcp = await mcpBaglan();
      const sonuc = await efektifTavanBelirle(mcp, girdi.musteri, girdi.butce);
      efektifTavan = sonuc.tavan;
      tavanKaynagi = sonuc.kaynak;
    } else {
      console.log("KURU MOD — Google Ads'e hiçbir yazma yapılmayacak (MCP bağlantısı yok).");
    }
    console.log(`Bağlayıcı günlük bütçe tavanı: ${efektifTavan} TL (${tavanKaynagi})`);

    // --yayinla adds one more step, and the counter is written accordingly.
    const N = girdi.yayinla ? 5 : 4;

    console.log(`\n[1/${N}] Araştırma…`);
    const arastirma = await arastir(
      { hedef: girdi.hedef, siteUrl: girdi.url, sektor: girdi.sektor },
      { jsonUret2, cagir: mcp?.cagir }
    );
    console.log(`Araştırma tamam: ${arastirma.anahtarKelimeAdaylari.length} anahtar kelime adayı.`);

    /**
     * CHANNEL ALLOCATION — this is where the strategy learns which budget it works with.
     *
     * The set of usable channels is read FROM THE ENVIRONMENT, not asked of the model:
     * allocating a share to an unconfigured channel would mean presenting a plan that
     * cannot run as a recommendation. With only one channel the model is never called — we
     * do not spend an LLM on a question whose answer is already known.
     */
    const kanallar = kullanilabilirKanallar();
    const dagitim = await butceDagit(
      { hedef: girdi.hedef, toplamButce: efektifTavan, kanallar, arastirma },
      { jsonUret2 }
    );
    console.log(`Kanal dağıtımı: ${dagitimOzeti(dagitim)}`);
    if (kanallar.length === 1) {
      console.log(
        `  (yalnız '${kanallar[0]}' yapılandırılmış — Meta için AEGIS_META_TOKEN ve ` +
          `AEGIS_META_AD_ACCOUNT_ID tanımlanmalı)`
      );
    }

    /**
     * The strategy is built with the share of the channel THE APPLICATION PATH ACTUALLY
     * WRITES TO.
     *
     * It used to take `dagitim[0]`, which left the ordering to the MODEL: the creation path
     * in uygulama.mjs calls only create_search_campaign, so it writes to GOOGLE under every
     * condition. When the model returned the allocation in the order
     * `[{kanal:"meta",...},{kanal:"google",...}]`, the approval screen and the report both
     * said "the SHARE of the 'meta' channel", while what got created was a GOOGLE campaign
     * built with Meta's share. The operator was getting something other than what they
     * approved — and at the wrong figure too.
     *
     * The channel is now selected by name. Today's honest limit stays as it is: the
     * allocation may split across several channels while the creation path goes through
     * one; the other channels' shares are written into the report as RECOMMENDATIONS, and
     * said there plainly to be recommendations.
     */
    const birincilPay = uygulanacakPay(dagitim, UYGULANAN_KANAL);
    if (!birincilPay) {
      /**
       * Fail closed: if no share fell to the channel we write to, no campaign is created.
       * Quietly carrying on with another channel's share would let the very bug closed
       * above back in through a different door.
       */
      throw new Error(
        `Bütçe dağıtımında '${UYGULANAN_KANAL}' kanalına pay düşmedi (${dagitimOzeti(dagitim)}). ` +
          `Kampanya kurma yolu yalnız '${UYGULANAN_KANAL}' kanalına yazdığı için plan uygulanamaz.`
      );
    }
    const kanalButcesi = birincilPay.gunlukButce;

    console.log(`\n[2/${N}] Strateji… (${birincilPay.kanal}: ${kanalButcesi} TL)`);
    const plan = await stratejiKur(
      { hedef: girdi.hedef, butceGunlukTL: kanalButcesi, arastirma },
      { jsonUret2 }
    );
    planDogrula(plan, kanalButcesi);
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
        dagitim,
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
      if (!onayVerildiMi(cevap)) {
        console.log("Onay verilmedi — hiçbir yazma yapılmadı. Kuru mod raporu üretiliyor.");
        uygulamaSonucu = undefined;
      } else {
        // The application module is loaded ONLY at this point; on a dry run it is not even
        // imported.
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
     * [5/5] The go-live attempt — ONLY on the --yayinla path, and ONLY when this run
     * created a complete campaign. yayinaAl() is called from nowhere else; this is the sole
     * exit point of the ENABLED call.
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
        if (!onayVerildiMi(cevap2)) {
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
            {
              kampanyaId: uygulamaSonucu.kampanyaId,
              musteriId: girdi.musteri,
              /**
               * The name is passed in so it can be removed from the CLASSIFICATION of the
               * result: the server puts the campaign name into its refusal text, and that
               * name was written by the model, so a pattern search could mistake the
               * model's free text for the gate's own output.
               */
              kampanyaAdi: plan.kampanyaAdi,
            },
            { cagir: mcp.cagir }
          );
          yayinSonucuYazdir(yayinSonucu);
        }
      }
    }

    const yazmaYapilmadi = kuruMod || uygulamaSonucu === undefined;
    const rapor = raporOlustur({
        dagitim,
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
     * A gate's decisions — a network refusal, a demand for verified approval, a refusal by
     * the server — are NOT FAILURES: this is what the system is for, and the exit code stays
     * 0. Only 'hata', an unintelligible response or a tool error, returns 1, because it
     * leaves the outcome uncertain.
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
 * Run only when invoked directly: a test or tool that imports this file must not trigger
 * ana() and the argv parsing by accident.
 */
const dogrudanCalisti = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (dogrudanCalisti) try {
  process.exitCode = await ana();
} catch (e) {
  // Secret hygiene: the message only — the error object, which can carry the request and
  // its headers, is never dumped whole.
  console.error(`\nHata: ${e?.message ?? e}`);
  process.exitCode = 1;
}
