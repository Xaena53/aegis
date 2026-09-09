// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CANLI DUMAN TESTİNİN YARIÇAP KELEPÇESİ — scripts/smoke.mjs.
 *
 * THE DEFECT: `scripts/smoke.mjs` proves the spend gates by genuinely making the forbidden
 * call against a REAL Google Ads account. Its own comment says the blast radius is bounded
 * because "the rollback moves spending DOWN". That rollback needs a target, and the target
 * was read as `Number(ilk.campaign_budget?.amount_micros ?? 0)` — the exact `?? 0` pattern
 * deliberately removed elsewhere in this repo, because it turns "could not be read" into the
 * number zero. A shared budget, a partial row or a permission-limited field yields no
 * `amount_micros`; the baseline silently became 0, and the rollback was then gated behind
 * `butceOnce > 0`, so it never fired. If the ceiling gate had regressed, the script would
 * have written a 9,999,999 daily budget onto a live account, printed "bütçe DEĞİŞTİ:
 * 0 → 9999999000000", and exited — without a rollback, and without the "ELLE MÜDAHALE
 * GEREKİR" warning that only lives inside geriAl(). The call made to produce evidence
 * becomes the damage itself: unknown is not zero.
 *
 * HOW THIS TEST WORKS: no source text is matched. A throwaway project root is built in the
 * OS temp directory (a fresh `dist/` over an older `src/` so the freshness precondition
 * passes), the REAL `scripts/smoke.mjs` is copied into it, and `dist/index.js` is a scripted
 * MCP server speaking the same stdio protocol the live binary does. That fake server can be
 * told to let the over-ceiling write THROUGH — i.e. to play a repo whose ceiling gate has
 * regressed — and it records every write-tool call it receives. The assertions then read the
 * call log: what the script actually did to the account, not what it says it does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const KOK = fileURLToPath(new URL("..", import.meta.url));

/** Scenario knobs handed to the fake server through the environment. */
interface Sahne {
  /** `campaign_budget.amount_micros` exactly as the API returns it; undefined = field absent. */
  butce?: string;
  /** true = the ceiling gate has regressed and the forbidden write goes through. */
  kapiDusuk: boolean;
  /** true = the approval gate has regressed and the campaign really goes ENABLED. */
  durumKapisiDusuk?: boolean;
}

/** One write-tool call as the fake account saw it, plus the state it was left holding. */
interface Cagri {
  ad: string;
  arg: Record<string, unknown>;
  butceSonrasi: string | undefined;
  durumSonrasi: string;
}

interface Kosu {
  kod: number | null;
  cikti: string;
  cagrilar: Cagri[];
}

/**
 * The stand-in for `dist/index.js`. It answers every request the smoke script makes, so all
 * nine checks can run, and it appends each write-tool call to a log the test reads back.
 */
const SAHTE_SUNUCU = String.raw`
import { appendFileSync } from "node:fs";

const S = JSON.parse(process.env.DUMAN_SAHNE);
const KAYIT = process.env.DUMAN_KAYIT;
const KIMLIK = "1234567890";
const KAMPANYA = "555";

let butce = S.butce;   // micros, as a string — or undefined when the row has no such field
let durum = "PAUSED";

const kaydet = (ad, arg) =>
  appendFileSync(KAYIT, JSON.stringify({ ad, arg, butceSonrasi: butce, durumSonrasi: durum }) + "\n");

const metin = (t, yapisal) => ({
  content: [{ type: "text", text: t }],
  ...(yapisal ? { structuredContent: yapisal } : {}),
});
const satirlar = (arr) => metin(JSON.stringify(arr), { satirlar: arr });
const butceAlani = () => (butce === undefined ? {} : { campaign_budget: { amount_micros: butce } });

function gaql(q, limit) {
  if (/metrics\.cost_micros/.test(q))
    return satirlar([{ campaign: { id: KAMPANYA, name: "A" }, metrics: { cost_micros: "0" } }]);
  if (/LIMIT 999999/.test(q)) {
    const hepsi = [{ campaign: { id: "1" } }, { campaign: { id: "2" } }, { campaign: { id: "3" } }];
    return satirlar(typeof limit === "number" ? hepsi.slice(0, limit) : hepsi);
  }
  if (/status != 'REMOVED'/.test(q))
    return satirlar([{ campaign: { id: KAMPANYA, status: durum }, ...butceAlani() }]);
  if (/campaign_budget\.amount_micros FROM campaign WHERE campaign\.id/.test(q))
    return satirlar([butceAlani()]);
  if (/campaign\.status FROM campaign WHERE campaign\.id/.test(q))
    return satirlar([{ campaign: { status: durum } }]);
  return satirlar([]);
}

function aracCagir(ad, arg) {
  if (ad === "list_accounts")
    return metin("hesaplar", {
      hesaplar: [{ id: KIMLIK, ad: "Deneme", yonetici: false, erisilemedi: false }],
    });
  if (ad === "campaign_performance") return metin("rapor", { kampanyalar: [] });
  if (ad === "run_gaql") return gaql(String(arg.query ?? ""), arg.limit);
  if (ad === "update_campaign_budget") {
    const yeni = Math.round(Number(arg.newDailyBudget) * 1e6);
    const mevcut = butce === undefined ? undefined : Number(butce);
    // Lowering always gets through — that is precisely why the rollback is meant to work.
    const dusurme = mevcut !== undefined && Number.isFinite(yeni) && yeni <= mevcut;
    let cevap;
    if (dusurme || S.kapiDusuk) {
      butce = String(yeni);
      cevap = metin("Bütçe güncellendi: " + arg.newDailyBudget + " (günlük).");
    } else {
      cevap = metin("Reddedildi: günlük bütçe " + arg.newDailyBudget + " — tavanın üzerinde.");
    }
    kaydet(ad, arg);
    return cevap;
  }
  if (ad === "set_campaign_status") {
    if (arg.status === "ENABLED" && !S.durumKapisiDusuk) {
      kaydet(ad, arg);
      return metin("Reddedildi: onay gerekiyor — İşlem yapılmadı.");
    }
    durum = String(arg.status);
    kaydet(ad, arg);
    return metin("Durum güncellendi: " + durum);
  }
  return metin("bilinmeyen araç: " + ad);
}

function sonuc(m) {
  if (m.method === "initialize")
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, resources: {}, prompts: {}, completions: {} },
      serverInfo: { name: "sahte-aegis", version: "0.0.0" },
      instructions:
        "Aegis deneme sunucusu. Kampanyalar her zaman DURAKLATILMIŞ oluşturulur. " +
        "Harcama artışları insan onayı ve ağ doğrulaması ister; bilinmeyen sinyal reddedilir.",
    };
  if (m.method === "tools/call") return aracCagir(m.params.name, m.params.arguments ?? {});
  if (m.method === "resources/read")
    return {
      contents: [
        {
          uri: m.params.uri,
          mimeType: "application/json",
          text: JSON.stringify({
            gunlukButceTavani: 500,
            yazmaIzni: true,
            kurallar: ["bir", "iki", "üç", "dört", "beş"],
          }),
        },
      ],
    };
  if (m.method === "prompts/list")
    return { prompts: [1, 2, 3, 4, 5].map((i) => ({ name: "istem" + i })) };
  if (m.method === "completion/complete") return { completion: { values: [KIMLIK] } };
  return {};
}

let tampon = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  tampon += c;
  let nl;
  while ((nl = tampon.indexOf("\n")) >= 0) {
    const satir = tampon.slice(0, nl).trim();
    tampon = tampon.slice(nl + 1);
    if (!satir) continue;
    let m;
    try { m = JSON.parse(satir); } catch { continue; }
    if (m.id === undefined) continue;   // a notification wants no answer
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: sonuc(m) }) + "\n");
  }
});
`;

/** mtime is set by hand so the freshness precondition does not ride on clock resolution. */
function dosyaYaz(yol: string, icerik: string, saniyeOnce: number): void {
  writeFileSync(yol, icerik);
  const t = Date.now() / 1000 - saniyeOnce;
  utimesSync(yol, t, t);
}

async function dumanKos(sahne: Sahne): Promise<Kosu> {
  const kok = mkdtempSync(join(tmpdir(), "aegis-duman-"));
  const kayit = join(kok, "cagrilar.jsonl");
  try {
    mkdirSync(join(kok, "scripts"), { recursive: true });
    mkdirSync(join(kok, "src"), { recursive: true });
    mkdirSync(join(kok, "dist"), { recursive: true });
    for (const ad of ["smoke.mjs", "onucusKurallari.mjs"]) {
      cpSync(join(KOK, "scripts", ad), join(kok, "scripts", ad));
    }
    dosyaYaz(join(kok, "src", "a.ts"), "export const a = 1;\n", 1000);
    dosyaYaz(join(kok, "dist", "index.js"), SAHTE_SUNUCU, 100);
    writeFileSync(kayit, "");

    const r = await new Promise<{ kod: number | null; cikti: string }>((coz) => {
      const p = spawn(process.execPath, [join(kok, "scripts", "smoke.mjs")], {
        cwd: kok,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, DUMAN_SAHNE: JSON.stringify(sahne), DUMAN_KAYIT: kayit },
      });
      let cikti = "";
      p.stdout.setEncoding("utf8");
      p.stdout.on("data", (c) => (cikti += c));
      p.stderr.setEncoding("utf8");
      p.stderr.on("data", (c) => (cikti += c));
      p.on("close", (kod) => coz({ kod, cikti }));
    });

    const cagrilar = readFileSync(kayit, "utf8")
      .split("\n")
      .filter((s) => s.trim())
      .map((s) => JSON.parse(s) as Cagri);
    return { ...r, cagrilar };
  } finally {
    rmSync(kok, { recursive: true, force: true });
  }
}

const butceYazmalari = (k: Kosu): Cagri[] =>
  k.cagrilar.filter((c) => c.ad === "update_campaign_budget");

/* ── 1) ölçülemeyen taban çizgisi: yasak çağrı HİÇ yapılmaz ──────────────────── */

/**
 * The finding itself. The row carries no `campaign_budget` at all — a shared budget or a
 * partially readable row — and the ceiling gate is played as REGRESSED. Under the old `?? 0`
 * the script wrote 9,999,999 anyway and left it standing. The bound is now a precondition:
 * with no rollback target, the forbidden call is not made at all.
 */
test("KRİTİK: eski bütçe okunamıyorsa tavan üstü yazma DENENMEZ", async () => {
  const k = await dumanKos({ butce: undefined, kapiDusuk: true });

  assert.deepEqual(
    butceYazmalari(k),
    [],
    "Taban çizgisi ölçülemezken tavan üstü bütçe yazması yapıldı — geri alınacak bir hedef " +
      "yokken yarıçap sınırlanamaz; canlı hesapta 9.999.999 günlük bütçe kalırdı."
  );
  assert.match(k.cikti, /KALDI\s+Tavan üstü bütçe reddedilir/, "atlanan kontrol GEÇTİ sayılmamalı");
  assert.match(k.cikti, /okunama/i, "atlama gerekçesi rapora yazılmalı");
  assert.equal(k.kod, 1, "doğrulanamayan bir kapının fişi kesilmez");
});

/** A zero baseline is not a measurement either: no live budget is 0, and 0 is no target. */
test("0 mikro bir ölçüm değildir: tavan üstü yazma yine DENENMEZ", async () => {
  const k = await dumanKos({ butce: "0", kapiDusuk: true });

  assert.deepEqual(butceYazmalari(k), [], "sıfır taban çizgisiyle yasak çağrı yapıldı");
  assert.equal(k.kod, 1);
});

/* ── 2) taban çizgisi ölçülüyse: kapı düşerse geri alma KOŞAR ────────────────── */

/**
 * The other half of the contract. With a measured baseline the forbidden call IS made — live
 * proof of the gate is this product's central claim — and when the gate lets it through, the
 * rollback must actually run and put the account back where it was.
 */
test("kapı düşerse geri alma koşar ve bütçe eski değerine döner", async () => {
  const k = await dumanKos({ butce: "500000", kapiDusuk: true });
  const yazmalar = butceYazmalari(k);

  assert.equal(
    yazmalar.length,
    2,
    `beklenen: yasak çağrı + geri alma, gelen: ${JSON.stringify(yazmalar)}`
  );
  assert.equal(yazmalar[0].arg.newDailyBudget, 9_999_999);
  assert.equal(yazmalar[1].arg.newDailyBudget, 0.5, "geri alma eski bütçeyi hedeflemeli");
  assert.equal(yazmalar[1].butceSonrasi, "500000", "hesap eski bütçesine dönmedi");
  assert.match(k.cikti, /GÜVENLİK KAPISI DÜŞTÜ/, "düşen kapı sessizce geçmemeli");
  assert.equal(k.kod, 1);
});

/**
 * The sibling check had the identical shape: `dogrula(/Reddedildi/…)` fired before the
 * rollback, so a campaign that really went ENABLED — the one outcome that costs money —
 * would have been left SPENDING while the report merely said "reddedilmedi".
 */
test("onay kapısı düşerse kampanya PAUSED durumuna geri alınır", async () => {
  const k = await dumanKos({ butce: "500000", kapiDusuk: false, durumKapisiDusuk: true });
  const durumlar = k.cagrilar.filter((c) => c.ad === "set_campaign_status");

  assert.equal(durumlar.length, 2, `beklenen: ENABLED denemesi + PAUSED geri alma, gelen: ${JSON.stringify(durumlar)}`);
  assert.equal(durumlar[1].arg.status, "PAUSED", "yayına giren kampanya duraklatılmadı");
  assert.equal(durumlar[1].durumSonrasi, "PAUSED", "kampanya canlıda ENABLED kaldı");
  assert.match(k.cikti, /GÜVENLİK KAPISI DÜŞTÜ/);
  assert.equal(k.kod, 1);
});

/* ── 3) mutlu yol bozulmadı ──────────────────────────────────────────────────── */

test("kapı sağlamken tüm kontroller geçer ve geri alma çağrılmaz", async () => {
  const k = await dumanKos({ butce: "500000", kapiDusuk: false });
  const yazmalar = butceYazmalari(k);

  assert.equal(yazmalar.length, 1, "yalnız reddedilen yasak çağrı yapılmalıydı");
  assert.equal(yazmalar[0].butceSonrasi, "500000", "reddedilen çağrı bütçeyi değiştirmemeli");
  assert.doesNotMatch(k.cikti, /KALDI/, `bir kontrol kaldı:\n${k.cikti}`);
  assert.match(k.cikti, /9\/9 kontrol geçti/);
  assert.equal(k.kod, 0);
});
