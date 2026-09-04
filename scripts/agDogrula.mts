// SPDX-License-Identifier: AGPL-3.0-only
/**
 * LIVE VERIFICATION OF THE TRUST CHAIN — `npm run agtest`
 *
 * `npm run smoke` exercises the Google side against a real account; this script does the
 * same for the NETWORK side: the six-link chain, step-up verification and the risk
 * mapping, against the Nokia Network-as-Code platform, in one command.
 *
 * EVERY STEP GOES THROUGH THE PRODUCTION PATH: nacIstemciSecenekleri() and agDogrula().
 * No hand-built URLs, no hand-written headers — and that distinction matters, because the
 * 404s we spent weeks reading as "Device Status is not enabled on our account" came from
 * exactly those hand-built URLs; the SDK's own paths were right all along. You can only
 * verify a gate by going through the gate itself.
 *
 * A green run is proof that the decision logic AND the wire work together — something the
 * unit tests cannot show on their own, because they inject a fake channel.
 *
 * REQUIRES: the Nokia NaC Simulator tier and AEGIS_NAC_TOKEN in .env. The numbers used are
 * the simulator's documented lines (…1001 answers clean, …0404 returns HTTP 404).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const kok = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
config({ path: path.join(kok, ".env"), quiet: true });

if (!process.env.AEGIS_NAC_TOKEN?.trim()) {
  console.error(
    [
      "",
      "  AEGIS_NAC_TOKEN tanımlı değil.",
      "  Bu betik canlı Network-as-Code çağrıları yapar; token olmadan doğrulayacak bir şey yok.",
      "  Simülatör katmanı ücretsiz: https://developer.networkascode.nokia.io",
      "",
    ].join("\n")
  );
  process.exit(2);
}

const { agDogrula, nacIstemciSecenekleri, RISK_HALKA_ESLEMESI } = await import("../src/networkTrust.js");
const { nacConfigFromEnv } = await import("../src/config.js");

const sonuclar: Array<[string, boolean, string]> = [];
const kayit = (ad: string, gecti: boolean, not: string) => {
  sonuclar.push([ad, gecti, not]);
  console.log(`  ${gecti ? "GEÇTİ" : "KALDI"}  ${ad}\n         ${not}`);
};

function env(v: Record<string, string | undefined>) {
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined) delete process.env[k];
    else process.env[k] = val;
  }
}

const TEMEL = {
  AEGIS_APPROVER_PHONE: "+99999991001",
  AEGIS_REACH_CHECK: "1",
  AEGIS_EXPECTED_COUNTRY: undefined,
  AEGIS_DEVICESWAP_CHECK: undefined,
  AEGIS_CALLFWD_CHECK: undefined,
  AEGIS_CALLFWD_SIMULATE: undefined,
  AEGIS_NAC_SIMULATE: undefined,
  AEGIS_NV_SIMULATE: undefined,
  AEGIS_STEPUP: "0",
};

console.log("\n╔══ Q1 — Device Status canlı mı (halka 3 ve 4) ══════════════════════════════╗");
{
  env({ ...TEMEL, AEGIS_EXPECTED_COUNTRY: "HU" }); // simülatör hattı HU'da: beklenen = HU
  const k = await agDogrula(nacConfigFromEnv() as any, "high");
  const iz = k.iz as any;
  kayit(
    "halka 3 (Device Reachability) GERÇEK kanaldan koşuyor",
    iz.reach === "gercek",
    `iz.reach = ${iz.reach}`
  );
  kayit(
    "halka 4 (Device Roaming/Location) GERÇEK kanaldan koşuyor",
    iz.loc === "gercek",
    `iz.loc = ${iz.loc}`
  );
  kayit(
    "beklenen ülke HU iken zincir TEMİZ geçiyor (kapı bir duvar değil)",
    k.engel === undefined,
    k.engel ? k.engel.slice(0, 110) : "engel yok"
  );
}

console.log("\n╔══ Q1b — beklenen ülke yanlışsa GERÇEK ret üretiyor mu ═════════════════════╗");
{
  env({ ...TEMEL, AEGIS_EXPECTED_COUNTRY: "TR" });
  const k = await agDogrula(nacConfigFromEnv() as any, "high");
  kayit(
    "hat TR dışındayken canlı RET",
    k.engel !== undefined && (k.iz as any).retNedeni === "konum-beklenmedik",
    `retNedeni = ${(k.iz as any).retNedeni}`
  );
  kayit(
    "gözlenen ülke ret metnine SIZMIYOR",
    !/HU/.test(String(k.engel)),
    "ham ülke listesi gizli tutulmalı"
  );
}

console.log("\n╔══ Q2 — rapidapiHost: SDK'nın kendi seçeneği ═══════════════════════════════╗");
{
  const s = nacIstemciSecenekleri("TEST-ONLY");
  kayit(
    "rapidapiHost seçeneği veriliyor (Nokia'nın resmî yolu)",
    s.rapidapiHost === "network-as-code.nokia.rapidapi.com",
    `rapidapiHost = ${s.rapidapiHost}`
  );
  kayit(
    "elle konan başlık da duruyor ve AYNI host'u gösteriyor",
    s.headers["X-RapidAPI-Host"] === s.rapidapiHost,
    `header = ${s.headers["X-RapidAPI-Host"]}`
  );
  // That the production path really works is already proven by the Q1 calls above.
  kayit(
    "bu yapılandırmayla canlı çağrılar 200 dönüyor",
    sonuclar[0][1] && sonuclar[1][1],
    "Q1'deki gerçek kanal izleri bunun kanıtı"
  );
}

console.log("\n╔══ Q3a — geriye bakış pencereleri (24s / 72s) ══════════════════════════════╗");
{
  env(TEMEL);
  const m = await agDogrula(nacConfigFromEnv() as any, "medium");
  const h = await agDogrula(nacConfigFromEnv() as any, "high");
  kayit("bütçe artışı (medium) 24 saatlik pencere soruyor", (m.iz as any).pencereSaat === 24, `pencereSaat = ${(m.iz as any).pencereSaat}`);
  kayit("yayına alma (high) 72 saatlik pencere soruyor", (h.iz as any).pencereSaat === 72, `pencereSaat = ${(h.iz as any).pencereSaat}`);
}

console.log("\n╔══ Q3b — 200 DIŞINDAKİ yanıt sonuçsuz sayılıyor mu (Aleksi: 404) ═══════════╗");
{
  // The simulator line that returns 404; Aleksi identified it as
  // IDENTIFIER_NOT_FOUND / TARGET_NOT_FOUND.
  env({ ...TEMEL, AEGIS_APPROVER_PHONE: "+99999990404" });
  const k = await agDogrula(nacConfigFromEnv() as any, "high");
  kayit(
    "404 dönen numara için kapı REDDEDİYOR (kapalı arıza)",
    k.engel !== undefined,
    k.engel ? k.engel.slice(0, 110) : "REDDETMEDİ — fail-open!"
  );
  kayit(
    "ham upstream gövdesi ajana sızmıyor",
    !/IDENTIFIER_NOT_FOUND|TARGET_NOT_FOUND|\{"/.test(String(k.engel)),
    "yalnız Türkçe özet gösterilmeli"
  );
  kayit(
    "onaylayıcı numarası maskeli",
    !/\+99999990404/.test(String(k.engel)),
    `metinde tam numara olmamalı`
  );
}

console.log("\n╔══ Q3c — kademeli doğrulama (step-up) canlı ═══════════════════════════════╗");
{
  env({ ...TEMEL, AEGIS_EXPECTED_COUNTRY: "TR", AEGIS_STEPUP: "1" });
  const k = await agDogrula(nacConfigFromEnv() as any, "high");
  kayit(
    "yükseltilebilir sinyal RET yerine YÜKSELTME üretiyor",
    k.engel === undefined && k.kademe !== undefined,
    k.kademe ? `neden=${k.kademe.neden}, doğrulayan=${k.kademe.dogrulayan.join(",")}` : "yükseltme olmadı"
  );
  kayit(
    "yükseltmeyi GERÇEK halkalar taşıyor",
    (k.kademe?.dogrulayan.length ?? 0) >= 1,
    `${k.kademe?.dogrulayan.length ?? 0} bağımsız gerçek sinyal: ${k.kademe?.dogrulayan.join(",") ?? "-"}`
  );
  /**
   * A VOUCHER HAS TO BE RELEVANT. This check used to look only at the COUNT ("at least
   * two real signals"), and the count only added up because reachability was counted as a
   * voucher. Reachability is a LIVENESS signal: the handset holding a stolen SIM answers
   * the network too, so it never DISAGREES with that signal and cannot vouch for it (see
   * KEFIL_ESLEMESI). The live check now measures that instead of a number.
   */
  kayit(
    "canlılık sinyali kefil sayılmıyor (erişilebilirlik yükseltme taşımaz)",
    !(k.kademe?.dogrulayan ?? []).includes("reach"),
    `doğrulayanlar: ${k.kademe?.dogrulayan.join(",") ?? "-"}`
  );
  kayit(
    "iz 'yukseltildi' taşıyor (denetçi ayırt edebilsin)",
    (k.iz as any).kademe === "yukseltildi",
    `iz.kademe = ${(k.iz as any).kademe}`
  );

  // SECURITY BOUNDARY: no escalation while call forwarding is active
  env({ ...TEMEL, AEGIS_STEPUP: "1", AEGIS_CALLFWD_SIMULATE: "acik" });
  const y = await agDogrula(nacConfigFromEnv() as any, "high");
  kayit(
    "çağrı yönlendirme AÇIKKEN yükseltme YAPILMIYOR",
    y.engel !== undefined && y.kademe === undefined,
    `retNedeni = ${(y.iz as any).retNedeni}`
  );

  // 404 with step-up on: no voucher, so still a refusal
  env({ ...TEMEL, AEGIS_APPROVER_PHONE: "+99999990404", AEGIS_STEPUP: "1" });
  const z = await agDogrula(nacConfigFromEnv() as any, "high");
  kayit(
    "sinyal okunamıyorsa kademe de kurtarmıyor (doğrulayan yok)",
    z.engel !== undefined && z.kademe === undefined,
    z.engel ? z.engel.slice(0, 100) : "GEÇTİ — hatalı!"
  );
}

console.log("\n╔══ Q4 — risk-orantılı halka eşlemesi ══════════════════════════════════════╗");
{
  env({ ...TEMEL, AEGIS_EXPECTED_COUNTRY: "HU", AEGIS_DEVICESWAP_CHECK: "1", AEGIS_CALLFWD_CHECK: "1" });
  const kosdu = (v: unknown) => v !== undefined && v !== "kapali" && v !== "calismadi";
  const kosanlar = (iz: any) =>
    ["simSwap", "nv", "reach", "loc", "devSwap", "callFwd"].filter((k) => kosdu(iz[k]));

  const m = await agDogrula(nacConfigFromEnv() as any, "medium");
  const h = await agDogrula(nacConfigFromEnv() as any, "high");
  const mK = kosanlar(m.iz), hK = kosanlar(h.iz);

  kayit("medium YALNIZ tek güçlü sinyal koşturuyor", mK.length === 1 && mK[0] === "simSwap", `koşan: ${mK.join(",")}`);
  kayit("high tüm AÇIK halkaları koşturuyor", hK.length >= 5, `koşan (${hK.length}): ${hK.join(",")}`);
  kayit(
    "davranış tabloyla uyuşuyor",
    mK.every((x) => RISK_HALKA_ESLEMESI.medium.includes(x)) && hK.every((x) => RISK_HALKA_ESLEMESI.high.includes(x)),
    `tablo medium=${RISK_HALKA_ESLEMESI.medium.join(",")}`
  );
  kayit("high katmanında canlı zincir TEMİZ geçiyor", h.engel === undefined, h.engel ? h.engel.slice(0, 100) : "engel yok");
}

const kaldi = sonuclar.filter(([, g]) => !g);
console.log(`\n${"═".repeat(78)}`);
console.log(`  ${sonuclar.length - kaldi.length}/${sonuclar.length} doğrulama geçti`);
if (kaldi.length) {
  console.log("  KALANLAR:");
  for (const [ad, , not] of kaldi) console.log(`    ✖ ${ad} — ${not}`);
  process.exitCode = 1;
}
