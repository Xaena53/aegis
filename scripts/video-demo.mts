// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AEGIS — a LIVE demo designed for screen recording.
 *
 * npm run demo (scripts/demo-senaryo.mjs) is the operator's rehearsal: detailed, in Turkish
 * and fast. This script does a DIFFERENT job — slowly enough, and with few enough lines, to
 * be readable in a two-to-three-minute jury video, and it proves ONE claim:
 *
 *   The same agent, the same request, the same code. The only difference is THE NETWORK's
 *   answer.
 *
 * THE DIFFERENCES, AND WHY:
 *  - NO SIMULATION. AEGIS_NAC_SIMULATE is deliberately CLEARED; every call really goes to
 *    Nokia Network-as-Code. In a demo video, a "simulated" label leaves the viewer's very
 *    first question unanswered.
 *  - ENGLISH FIRST, THEN THE RAW OUTPUT. The jury is international, and evidence that is not
 *    understood is not evidence. But the product's own Turkish text is NOT DELETED — it sits
 *    immediately below, labelled "raw output". The translation carries comprehensibility, the
 *    raw output carries authenticity.
 *  - The pace is set with `--hiz`, so the lines have time to be read while recording.
 *
 * USAGE:
 *   npm run video                 # normal pace, for recording
 *   npm run video -- --hiz 0      # no waiting, for CI or a quick check
 *
 * REQUIRES: AEGIS_NAC_TOKEN. The numbers are Nokia's PUBLIC simulator lines, published in
 * their documentation; they belong to no real subscriber.
 */
import "dotenv/config";
import readline from "node:readline";
import { agDogrula } from "../src/networkTrust.js";
import { nacConfigFromEnv } from "../src/config.js";
import { INGILIZCE_RET } from "./video-metin.mjs";

/** Nokia's simulator lines — from their documentation, public to everyone. */
const TEMIZ_HAT = "+99999991001"; // swapped:false
const DEGISMIS_HAT = "+99999991000"; // swapped:true

const hizArg = process.argv.indexOf("--hiz");
const HIZ = hizArg !== -1 ? Number(process.argv[hizArg + 1]) : 1;
/**
 * STEP MODE — it ties the narration to THE SPEAKER rather than to the script.
 *
 * The first version ran on fixed waits and took 16 seconds end to end: five links streaming
 * past 350 ms apart, with no human narrator able to keep up. In a recording, the right pace
 * is the alignment of the presenter's voice with the screen — and leaving that to the
 * presenter is sturdier than guessing it in advance. With `--adim`, each stop waits for
 * Enter.
 */
const ADIM = process.argv.includes("--adim");

/**
 * Waits for a single line. It uses `readline`, not a raw `stdin.once("data")`.
 *
 * On a raw read, when the input is a PIPE (`printf '\n\n' | npm run video -- --adim`), the
 * first read swallows the whole buffer and the later waits never fire — the script hangs
 * silently. readline cuts at line boundaries, so it behaves the same at a keyboard and down a
 * pipe, which is what makes step mode testable.
 */
const satirOkuyucu = readline.createInterface({ input: process.stdin });

/**
 * Incoming lines are QUEUED; `once("line")` is not enough.
 *
 * readline emits lines as fast as it can read them. If the input is a pipe they all arrive at
 * once, and because no listener is attached at that moment they are lost — the script hangs
 * silently at the third stop (measured: only two of seven stops appeared). The queue holds an
 * early line, and works the same at a keyboard as down a pipe.
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

/** Where the narration gets to breathe: Enter in step mode, a measured pause
 * otherwise. */
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
 * The chain in FULL. All five links are on: if the video says "five of them live", five
 * have to run on screen. expectedCountry is required for the location link to work.
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

/** Turns the link statuses in the trace into readable lines. */
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
     * THE ORDER IS DELIBERATE: ENGLISH FIRST, THEN THE RAW TURKISH OUTPUT.
     *
     * In the first version the raw output was on top and the English sat small beneath it.
     * At the video's most critical moment, a jury that does not read Turkish was looking at
     * a wall of text it could not understand — and evidence that is not understood is not
     * evidence.
     *
     * The raw output was NOT DELETED, it was moved down and labelled "raw output": the
     * English carries comprehensibility and the Turkish carries authenticity. Turning the
     * product's own text away from the camera would put marketing on screen instead of the
     * product.
     *
     * The translation is written by hand and can drift; test/videoCevirisi.test.ts nails
     * down that the raw refusal text still says what this translation claims it says.
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

/** Wraps a long refusal text at a fixed width, so it does not depend on the terminal's
 * width. */
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
