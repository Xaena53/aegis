// SPDX-License-Identifier: AGPL-3.0-only
/**
 * LIVE VERIFICATION OF THE META PATH — `npm run metatest`
 *
 * `npm run smoke` exercises the Google side and `npm run agtest` the network side against
 * their real platforms. This script is the third: the Meta Marketing API.
 *
 * WHY A SEPARATE SCRIPT WAS NEEDED. The unit tests for the Meta tools inject a fake
 * channel, and the budget tests stub `fetch`. Both read responses we wrote ourselves —
 * which makes them proof of our parsing and our refusals, and NOT proof that Meta actually
 * answers in those shapes. Only a live call closes that gap.
 *
 * SAFETY: the default run is READ-ONLY. With `--write` it creates a real campaign in the
 * account — but `status=PAUSED` is fixed in the body sent to Meta, so the campaign is born
 * paused and starts no spend. The script names the campaign it created at the end; since
 * we expose no deletion tool for Meta, the cleanup is the operator's.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const kok = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
config({ path: path.join(kok, ".env"), quiet: true });

const yazmaModu = process.argv.includes("--write");

const eksik: string[] = [];
if (!process.env.AEGIS_META_TOKEN?.trim()) eksik.push("AEGIS_META_TOKEN");
if (!process.env.AEGIS_META_AD_ACCOUNT_ID?.trim()) eksik.push("AEGIS_META_AD_ACCOUNT_ID");
if (eksik.length) {
  console.error(
    [
      "",
      `  Meta kimlik bilgileri eksik: ${eksik.join(", ")}`,
      "",
      "  Bu betik canlı Meta Marketing API çağrıları yapar; onlarsız doğrulanacak bir şey yok.",
      "  .env dosyasına ekleyip tekrar çalıştırın (bkz. .env.example).",
      "",
    ].join("\n")
  );
  process.exit(2);
}

const { metaKanali, __setMetaKanalForTests } = await import("../src/meta/client.js");

const sonuclar: Array<[string, boolean, string]> = [];
const kayit = (ad: string, gecti: boolean, not: string) => {
  sonuclar.push([ad, gecti, not]);
  console.log(`  ${gecti ? "GEÇTİ" : "KALDI"}  ${ad}\n         ${not}`);
};

const ayar = {
  metaToken: process.env.AEGIS_META_TOKEN!.trim(),
  metaAdAccountId: process.env.AEGIS_META_AD_ACCOUNT_ID!.trim(),
};

__setMetaKanalForTests(undefined); // gerçek kanal kullanılsın
const kanal = metaKanali(ayar);

console.log("\n  Aegis — Meta canlı doğrulaması");
console.log(`  Reklam hesabı: ${ayar.metaAdAccountId}${yazmaModu ? "  ·  YAZMA MODU AÇIK" : "  ·  salt okunur"}\n`);

/* ── 1. Identity and access ──────────────────────────────────────────────────── */
{
  try {
    // A campaign ID that does not exist: 400/404 is expected, but NOT 190 (invalid token).
    await kanal.kampanyaOku("0");
    kayit("jeton kabul ediliyor", true, "beklenmedik biçimde başarılı döndü ama jeton geçerli");
  } catch (e: any) {
    const m = String(e?.message ?? e);
    const jetonSorunu = /OAuth|190|access token|Invalid OAuth/i.test(m);
    kayit(
      "jeton kabul ediliyor (kimlik doğrulama geçti)",
      !jetonSorunu,
      jetonSorunu ? `jeton reddedildi: ${m.slice(0, 140)}` : `beklenen hata alındı: ${m.slice(0, 110)}`
    );
    kayit(
      "hata metni erişim jetonunu SIZDIRMIYOR",
      !m.includes(ayar.metaToken),
      "jeton hiçbir hata mesajında görünmemeli"
    );
  }
}

/* ── 2. The write path (only with --write) ───────────────────────────────────── */
let olusanId: string | undefined;
let olusanAd: string | undefined;
if (yazmaModu) {
  const ad = `Aegis-dogrulama-${new Date().toISOString().slice(0, 16).replace(/[:T-]/g, "")}`;
  try {
    const k = await kanal.kampanyaOlustur({ ad, hedef: "OUTCOME_TRAFFIC", gunlukButce: 100 });
    olusanId = k.id;
    olusanAd = ad;
    kayit("kampanya oluşturuldu", Boolean(k.id), `id ${k.id}`);
    kayit(
      "KRİTİK: kampanya DURAKLATILMIŞ doğdu (hiç harcama başlamadı)",
      k.durum === "PAUSED",
      `durum = ${k.durum}`
    );

    const geri = await kanal.kampanyaOku(k.id);
    /**
     * DURUM ARTIK "OKUNDU MU" SORUSUNU DA SORUYOR. Eskiden istemci `status !== "ACTIVE"`
     * turned every body that was not ACTIVE into PAUSED; this line then printed green
     * even when Meta sent no `status` at all, writing down "unknown" as if it were a
     * confirmation. An unreadable status is now undefined and this check STAYS red — which
     * is exactly what we want.
     */
    kayit(
      "geri okuma Meta'dan PAUSED doğruluyor (durum GERÇEKTEN okundu)",
      geri.durum === "PAUSED",
      `Meta'nın döndürdüğü durum = ${geri.durum ?? "okunamadı"}${geri.durumNotu ? ` · ${geri.durumNotu}` : ""}`
    );
    kayit(
      "bütçe geri okunabiliyor ve kaynağı bildiriliyor",
      geri.gunlukButce !== undefined,
      `gunlukButce = ${geri.gunlukButce} · kaynak = ${geri.butceKaynagi}${geri.butceNotu ? ` · not: ${geri.butceNotu}` : ""}`
    );
    /**
     * This line is also the live proof of the CURRENCY MULTIPLIER: the multiplier is read
     * from the account's `currency_offset` field, and the write and the read use the same
     * one. A wrong multiplier (a hard-coded x100 on a JPY account, say) shows up here as a
     * hundredfold discrepancy.
     */
    kayit(
      "bütçe gidiş-dönüşte bozulmuyor (hesabın para birimi çarpanı doğru okundu)",
      geri.gunlukButce === 100,
      `yazılan 100 → okunan ${geri.gunlukButce}`
    );
  } catch (e: any) {
    kayit("kampanya oluşturuldu", false, String(e?.message ?? e).slice(0, 180));
  }
} else {
  console.log("  (yazma denemeleri atlandı — gerçek kampanya oluşturmak için --write ekleyin)\n");
}

/* ── 3. Summary ──────────────────────────────────────────────────────────────── */
const kaldi = sonuclar.filter(([, g]) => !g);
console.log(`\n${"═".repeat(70)}`);
console.log(`  ${sonuclar.length - kaldi.length}/${sonuclar.length} doğrulama geçti`);
if (olusanId) {
  console.log(
    `\n  TEMİZLİK: "${olusanAd}" (id ${olusanId}) hesabınızda DURAKLATILMIŞ duruyor.\n` +
      `  Aegis silme aracı sunmuyor (silme geri alınamaz); Ads Manager'dan kaldırabilirsiniz.`
  );
}
if (kaldi.length) {
  console.log("\n  KALANLAR:");
  for (const [ad, , not] of kaldi) console.log(`    ✖ ${ad} — ${not}`);
  process.exitCode = 1;
}
