// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AEGIS — ekran kaydı için tasarlanmış CANLI demo.
 *
 * npm run demo (scripts/demo-senaryo.mjs) operatör provası içindir: ayrıntılı, Türkçe ve
 * hızlıdır. Bu betik BAŞKA bir işi yapar — 2-3 dakikalık bir jüri videosunda okunabilecek
 * kadar yavaş ve az satırla, TEK bir iddiayı kanıtlar:
 *
 *   Aynı ajan, aynı istek, aynı kod. Tek fark ŞEBEKENİN cevabı.
 *
 * FARKLAR VE NEDENLERİ:
 *  - SİMÜLASYON YOK. AEGIS_NAC_SIMULATE bilerek TEMİZLENİR; her çağrı Nokia
 *    Network-as-Code'a gerçekten gider. Bir demo videosunda "simüle" etiketi, izleyicinin
 *    aklına gelen ilk soruyu cevapsız bırakır.
 *  - ÖNCE İNGİLİZCE, SONRA HAM ÇIKTI. Jüri uluslararası; anlaşılmayan bir kanıt kanıt
 *    değildir. Ama ürünün kendi Türkçe metni SİLİNMEZ — "raw output" etiketiyle hemen
 *    altında durur. Anlaşılırlığı çeviri, gerçekliği ham çıktı taşır.
 *  - Tempo `--hiz` ile ayarlanır; kayıt sırasında satırların okunacak zamanı olsun diye.
 *
 * KULLANIM:
 *   npm run video                 # normal tempo (kayıt için)
 *   npm run video -- --hiz 0      # beklemesiz (CI / hızlı kontrol)
 *
 * GEREKSİNİM: AEGIS_NAC_TOKEN. Numaralar Nokia'nın KAMUYA AÇIK simülatör hatlarıdır
 * (dokümanlarında yayımlanmıştır), gerçek bir aboneye ait değildir.
 */
import "dotenv/config";
import readline from "node:readline";
import { agDogrula } from "../src/networkTrust.js";
import { nacConfigFromEnv } from "../src/config.js";
import { INGILIZCE_RET } from "./video-metin.mjs";

/** Nokia simülatör hatları — dokümanlarından, herkese açık. */
const TEMIZ_HAT = "+99999991001"; // swapped:false
const DEGISMIS_HAT = "+99999991000"; // swapped:true

const hizArg = process.argv.indexOf("--hiz");
const HIZ = hizArg !== -1 ? Number(process.argv[hizArg + 1]) : 1;
/**
 * ADIM KİPİ — anlatımı betiğe değil, KONUŞANA bağlar.
 *
 * İlk sürüm sabit beklemelerle koşuyordu ve baştan sona 16 saniye sürüyordu: beş halka
 * 350 ms arayla akıyor, üzerine konuşan insan yetişemiyordu. Kayıtta doğru tempo,
 * sunucunun sesiyle ekranın hizasıdır — bunu önceden kestirmek yerine sunucuya bırakmak
 * daha sağlam. `--adim` ile her duraktan sonra Enter beklenir.
 */
const ADIM = process.argv.includes("--adim");

/**
 * Tek satır bekler. `readline` kullanılıyor, ham `stdin.once("data")` değil.
 *
 * Ham okumada girdi bir BORU olduğunda (`printf '\n\n' | npm run video -- --adim`) ilk
 * okuma tamponun tamamını yutar ve sonraki bekleyişler hiç tetiklenmez — betik sessizce
 * asılır. readline satır sınırında keser, dolayısıyla hem klavyede hem boruda aynı
 * davranır; bu da adım kipinin testten geçirilebilmesi demektir.
 */
const satirOkuyucu = readline.createInterface({ input: process.stdin });

/**
 * Gelen satırlar KUYRUĞA alınır; `once("line")` yetmez.
 *
 * readline satırları okuyabildiği hızda yayar. Girdi bir boruysa hepsi ilk anda gelir ve
 * o sırada dinleyici takılı olmadığı için kaybolur — betik üçüncü durakta sessizce asılır
 * (ölçüldü: yedi durağın yalnız ikisi göründü). Kuyruk, erken gelen satırı saklar;
 * klavyede de boruda da aynı çalışır.
 */
const satirKuyrugu: string[] = [];
let satirBekleyen: (() => void) | undefined;
satirOkuyucu.on("line", (satir) => {
  if (satirBekleyen) {
    const coz = satirBekleyen;
    satirBekleyen = undefined;
    coz();
  } else {
    satirKuyrugu.push(satir);
  }
});

function enterBekle(): Promise<void> {
  if (satirKuyrugu.length > 0) {
    satirKuyrugu.shift();
    return Promise.resolve();
  }
  return new Promise((coz) => {
    satirBekleyen = coz;
  });
}

const bekle = async (ms: number): Promise<void> => {
  if (ADIM) return;
  await new Promise((r) => setTimeout(r, ms * (Number.isFinite(HIZ) ? HIZ : 1)));
};

/** Anlatımın nefes alacağı yer: adım kipinde Enter, değilse ölçülü bir duraklama. */
const durak = async (ms: number): Promise<void> => {
  if (ADIM) {
    console.log(gri("\n      [Enter] — anlatımın bittiğinde devam et"));
    await enterBekle();
    return;
  }
  await new Promise((r) => setTimeout(r, ms * (Number.isFinite(HIZ) ? HIZ : 1)));
};

const R = "[0m";
const kalin = (s: string) => `[1m${s}${R}`;
const gri = (s: string) => `[90m${s}${R}`;
const camgobegi = (s: string) => `[36m${s}${R}`;
const yesil = (s: string) => `[32m${s}${R}`;
const kirmizi = (s: string) => `[31m${s}${R}`;

function baslik(metin: string): void {
  console.log("\n" + camgobegi("─".repeat(72)));
  console.log(camgobegi(kalin("  " + metin)));
  console.log(camgobegi("─".repeat(72)) + "\n");
}

/**
 * Zincirin TAM hâli. Beş halka da açık: video "beşi canlı" diyorsa ekranda beşi
 * koşmalıdır. expectedCountry, konum halkasının çalışması için şart.
 */
function ayarKur(numara: string) {
  const temel = nacConfigFromEnv() as any;
  return {
    ...temel,
    nacSimulate: undefined,
    nvSimulate: undefined,
    reachSimulate: undefined,
    locSimulate: undefined,
    devSwapSimulate: undefined,
    callFwdSimulate: undefined,
    approverPhone: numara,
    simSwapWindowHours: 72,
    reachCheck: true,
    devSwapCheck: true,
    callFwdCheck: true,
    expectedCountry: temel.expectedCountry ?? "HU",
    stepUp: false,
  };
}

/** İzdeki halka durumlarını okunur satırlara çevirir. */
function halkaSatirlari(iz: any): string[] {
  const ad: Record<string, string> = {
    simSwap: "SIM Swap",
    reach: "Device Reachability",
    loc: "Device Roaming / Location",
    devSwap: "Device Swap",
    callFwd: "Call Forwarding",
  };
  const cikti: string[] = [];
  for (const anahtar of Object.keys(ad)) {
    const durum = iz[anahtar];
    if (durum === undefined || durum === "kapali") continue;
    const gercek = durum === "gercek";
    const bozuk = iz.retNedenleri?.length && anahtar === "simSwap" && iz.retNedeni === "sim-degisti";
    const isaret = bozuk ? kirmizi("SWAPPED") : yesil("clean");
    const kanal = gercek ? gri("real CAMARA call") : gri(`channel: ${durum}`);
    cikti.push(`    ${ad[anahtar]!.padEnd(28, ".")} ${isaret}   ${kanal}`);
  }
  return cikti;
}

async function sahne(no: string, etiket: string, numara: string): Promise<void> {
  console.log(kalin(`  ${no}  ${etiket}`));
  console.log(gri(`      approver line: ${numara.slice(0, 4)}${"*".repeat(6)}${numara.slice(-2)}`));
  console.log(gri(`      action:        take campaign live  (high risk -> full chain)`));
  await durak(3500);
  console.log(gri("\n      querying the operator network ..."));

  const t0 = Date.now();
  const karar = await agDogrula(ayarKur(numara) as any, "high");
  const sure = Date.now() - t0;

  await bekle(600);
  console.log("");
  for (const satir of halkaSatirlari(karar.iz)) {
    console.log(satir);
    await bekle(1100);
  }
  console.log(gri(`\n      answered in ${sure} ms`));
  await durak(3000);

  if (karar.engel) {
    /**
     * SIRA BİLİNÇLİ: ÖNCE İNGİLİZCE, SONRA HAM TÜRKÇE ÇIKTI.
     *
     * İlk sürümde ham çıktı üstteydi ve İngilizce altında küçük duruyordu. Videonun en
     * kritik anında, Türkçe bilmeyen bir jüri ekranda anlamadığı bir metin duvarı
     * görüyordu — anlaşılmayan bir kanıt kanıt değildir.
     *
     * Ham çıktı SİLİNMEDİ, aşağı alındı ve "raw output" diye etiketlendi: anlaşılırlığı
     * İngilizce, gerçekliği Türkçe taşıyor. Ürünün kendi metnini kameraya çevirip
     * göstermek, ekranda ürünün değil pazarlamanın görünmesi olurdu.
     *
     * Çeviri elle yazılmıştır ve kayabilir; test/videoCevirisi.test.ts ham ret metninin
     * hâlâ bu çevirinin anlattığı şeyi söylediğini çiviler.
     */
    console.log("\n  " + kirmizi(kalin("  REFUSED — the approval prompt was never shown  ")));
    console.log("");
    for (const satir of INGILIZCE_RET) console.log(kirmizi("    " + satir));
    console.log("");
    console.log(gri("    ── raw output from the gate (Turkish — the product's language) ──"));
    for (const satir of sarmala(karar.engel, 66)) console.log(gri("    " + satir));
    console.log("");
    console.log("    " + kalin("elicitation prompts shown: ") + kirmizi(kalin("0")));
    console.log("    " + kalin("campaign state:            ") + yesil(kalin("unchanged")));
    console.log("");
    console.log(gri("    The chain stops at the first bad signal — the remaining links were"));
    console.log(gri("    never asked. A refusal does not need a second opinion."));
  } else {
    console.log("\n  " + yesil(kalin("  CHAIN CLEAN — the human is asked, and only now  ")));
    console.log("");
    console.log(gri("    The approval prompt is shown to the account owner over MCP"));
    console.log(gri("    elicitation, carrying the network evidence with it. Nothing is"));
    console.log(gri("    written until a person answers."));
  }
  await durak(5000);
}

/** Uzun ret metnini sabit genişlikte sarmalar (terminal genişliğine bağımlı olmasın). */
function sarmala(metin: string, genislik: number): string[] {
  const kelimeler = metin.split(/\s+/);
  const satirlar: string[] = [];
  let s = "";
  for (const k of kelimeler) {
    if ((s + " " + k).trim().length > genislik) {
      satirlar.push(s.trim());
      s = k;
    } else s += " " + k;
  }
  if (s.trim()) satirlar.push(s.trim());
  return satirlar;
}

async function ana(): Promise<void> {
  if (!process.env.AEGIS_NAC_TOKEN?.trim()) {
    console.error(
      "AEGIS_NAC_TOKEN tanımlı değil — bu demo GERÇEK CAMARA çağrıları yapar ve " +
        "simülasyona düşmez. Token olmadan gösterilecek bir şey yok."
    );
    process.exit(1);
  }

  console.clear();
  console.log("");
  console.log(kalin(camgobegi("  A E G I S")));
  console.log(gri("  Network-verified trust for AI agents that spend money"));
  console.log(gri("  GSMA Open Gateway · CAMARA on Nokia Network-as-Code"));
  console.log("");
  console.log(gri("  Every call below is real. No simulation flags are set."));
  await durak(4000);

  baslik("1 — The agent asks to spend. The network is asked first.");
  await sahne("[1/2]", "Normal day: the approver's line is untouched.", TEMIZ_HAT);

  baslik("2 — Same agent. Same request. The SIM was swapped overnight.");
  await sahne("[2/2]", "Account takeover in progress.", DEGISMIS_HAT);

  baslik("What just happened");
  console.log("  " + kalin("Same agent, same request, same server code."));
  console.log("  " + kalin("The only difference was the operator's answer."));
  console.log("");
  console.log(gri("  The stolen session could answer an approval prompt perfectly."));
  console.log(gri("  It was never shown one."));
  console.log("");
  console.log(gri("  github.com/Xaena53/aegis   ·   npm run smoke · agtest · metatest"));
  console.log("");
}

await ana();
satirOkuyucu.close();
