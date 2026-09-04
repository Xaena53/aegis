// SPDX-License-Identifier: AGPL-3.0-only
/**
 * META'NIN CANLI DOĞRULAMASI — `npm run metatest`
 *
 * `npm run smoke` Google tarafını, `npm run agtest` ağ tarafını gerçek platforma karşı
 * sınar. Bu betik üçüncüsü: Meta Marketing API.
 *
 * NEDEN AYRI BİR BETİK GEREKİYORDU. Meta araçlarının birim testleri sahte bir kanal
 * enjekte eder, bütçe testleri de `fetch`'i taklit eder. İkisi de bizim yazdığımız
 * yanıtları okur — yani ayrıştırmamızın ve retlerimizin kanıtıdır, Meta'nın gerçekten
 * bu biçimlerde cevap verdiğinin kanıtı DEĞİLDİR. O ayrımı ancak canlı çağrı kapatır.
 *
 * GÜVENLİK: varsayılan olarak SALT OKUNUR koşar. `--write` verilirse hesapta gerçek bir
 * kampanya oluşturur — ama Meta'ya giden gövdede `status=PAUSED` sabittir, yani kampanya
 * duraklatılmış doğar ve hiçbir harcama başlatmaz. Betik sonunda oluşturduğu kampanyayı
 * adıyla bildirir; Meta silme aracı sunmadığımız için temizliği operatör yapar.
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

/* ── 1. Kimlik ve erişim ─────────────────────────────────────────────────────── */
{
  try {
    // Var olmayan bir kampanya kimliği: 400/404 bekleriz, ama 190 (geçersiz jeton) DEĞİL.
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

/* ── 2. Yazma yolu (yalnız --write) ──────────────────────────────────────────── */
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
     * olan her gövdeyi PAUSED'a çeviriyordu; bu satır Meta hiç `status` göndermese bile
     * yeşil basıyor, yani "bilinmiyor"u bir teyit gibi yazıyordu. Artık okunamayan durum
     * undefined'dır ve bu doğrulama KALIR — istediğimiz de bu.
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
     * Bu satır aynı zamanda PARA BİRİMİ ÇARPANININ canlı kanıtıdır: çarpan hesabın
     * `currency_offset` alanından okunuyor ve yazma ile okuma aynı çarpanı kullanıyor.
     * Yanlış çarpan (ör. JPY hesapta sabit ×100) burada 100 kat sapma olarak görünür.
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

/* ── 3. Özet ─────────────────────────────────────────────────────────────────── */
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
