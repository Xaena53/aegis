// SPDX-License-Identifier: AGPL-3.0-only
/**
 * REPAIR REGRESSION TESTS — scripts/brain/uygulama.mjs
 *
 * Two audited findings are locked down here:
 *
 *  1) yayinSonucuSinifla() strips the campaign name out of the text it classifies, because
 *     the server echoes that MODEL-CHOSEN name inside its refusal. It stripped only the name
 *     exactly as handed in — but uygula() writes a TRIMMED name behind a run stamp, so a
 *     single leading/trailing space (or a NBSP, which trim() also removes while the module's
 *     control-character guard does not reject it) made split() match nothing. An ordinary
 *     budget-ceiling refusal then came out as 'ag-retti' and the report printed
 *     "✔ GÜVENLİK KAPISI ÇALIŞTI" for a CAMARA gate THAT NEVER RAN.
 *
 *  2) The creative's display path (yol1/yol2) is produced, validated and printed in the
 *     report, but create_responsive_search_ad carries no path1/path2 field, so it reaches no
 *     ad. The drop was silent; it now names itself in the warnings.
 *
 * No network, no environment variables, no real tool: `cagir` is a local stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
/*
 * uygulama.mjs is plain JavaScript and tsconfig.json does not set allowJs, so TypeScript has
 * no declaration for it and reports TS7016. The test drives the REAL module at runtime — an
 * .mts twin or a hand-written .d.mts would be a second copy of the contract that could drift
 * away from it, which is the failure mode this repair set exists to close. The suppression is
 * ts-expect-error, not ts-ignore, on purpose: the day the module gains types, the compiler
 * flags this line as an unnecessary suppression instead of hiding a genuine error behind it.
 */
// @ts-expect-error TS7016 — untyped .mjs module, imported deliberately.
import { uygula, yayinSonucuSinifla } from "../scripts/brain/uygulama.mjs";

/** The run stamp uygula() prefixes; only its shape matters here. */
const DAMGA = "GB-20260907-1530";

/** A plain server refusal that has NOTHING to do with the network gate. */
function butceRetti(yazilanAd: string): string {
  return `Reddedildi: "${yazilanAd}" kampanyasının günlük bütçesi 900 — tavan 500 TL.`;
}

test("ONARIM 1: baştaki/sondaki boşluklu ad 'ag-retti' sınıflandırmasını sahteleyemez", () => {
  const modelAdi = " AĞ DOĞRULAMASI BAŞARISIZ ";
  // uygula() adı guvenliDize ile TRIM ederek yazar; sunucu reddinde duran ad budur.
  const yazilanAd = `${DAMGA} — ${modelAdi.trim()}`;

  assert.equal(
    yayinSonucuSinifla(butceRetti(yazilanAd), modelAdi),
    "reddedildi",
    "Bütçe tavanı reddi ağ kapısı reddi gibi sınıflandırıldı — modelin seçtiği ad " +
      "sınıflandırma metninden çıkarılmamış demektir."
  );
});

test("ONARIM 1: NBSP ile çevrelenmiş ad da sahteleme sağlamaz", () => {
  // U+00A0 kontrol karakteri sayılmaz (KONTROL_KARAKTERI: \x00-\x1f\x7f-\x9f) ama trim() siler.
  const modelAdi = "\u00a0AEGIS_NAC_SIMULATE\u00a0";
  const yazilanAd = `${DAMGA} — ${modelAdi.trim()}`;

  assert.equal(yayinSonucuSinifla(butceRetti(yazilanAd), modelAdi), "reddedildi");
});

test("ONARIM 1: gerçek ağ kapısı reddi hâlâ 'ag-retti' — düzeltme kapıyı zayıflatmadı", () => {
  const gercekRet =
    "AĞ DOĞRULAMASI BAŞARISIZ\n" +
    "Onaylayıcının SIM kartı son 72 saatte değişmiş; işlem yapılmadı.\n" +
    "• Ağ kanıtı: AEGIS_NAC_TOKEN ile gerçek kanal.";

  assert.equal(yayinSonucuSinifla(gercekRet, " Temiz Kampanya Adı "), "ag-retti");
  assert.equal(yayinSonucuSinifla(gercekRet, `${DAMGA} — Temiz Kampanya Adı`), "ag-retti");
});

test("ONARIM 1: uygula() GERÇEKTEN yazdığı kampanya adını geri döndürür", async () => {
  const modelAdi = "  AĞ DOĞRULAMASI BAŞARISIZ  ";
  const cagrilanAdlar: string[] = [];

  const sonuc = await uygula(
    {
      plan: {
        kampanyaAdi: modelAdi,
        butceGunlukTL: 100,
        hedefUlke: "TR",
        adGruplari: [{ ad: "Grup 1", anahtarKelimeler: ["kahve"], eslesmeTipi: "PHRASE" }],
      },
      kreatif: {
        basliklar: ["Başlık A", "Başlık B", "Başlık C"],
        aciklamalar: ["Açıklama bir", "Açıklama iki"],
      },
      musteriId: "1234567890",
      finalUrl: "https://ornek.test/kahve",
    },
    { cagir: sahteCagir(cagrilanAdlar) }
  );

  assert.equal(sonuc.basari, true);
  assert.equal(typeof sonuc.kampanyaAdi, "string");
  assert.equal(
    sonuc.kampanyaAdi,
    cagrilanAdlar[0],
    "Dönen ad, create_search_campaign'e GÖNDERİLEN adla birebir aynı olmalı."
  );
  assert.notEqual(
    sonuc.kampanyaAdi,
    modelAdi,
    "Yazılan ad modelin verdiği ham addan farklıdır (damga + trim) — bu fark bulgunun kökü."
  );
  // Ve asıl kilit: yazılan adla sınıflandırma dürüst kalıyor.
  assert.equal(yayinSonucuSinifla(butceRetti(sonuc.kampanyaAdi!), sonuc.kampanyaAdi), "reddedildi");
});

test("ONARIM 2: uygulanmayan görünen yol (yol1/yol2) uyarı olarak SÖYLENİR", async () => {
  const gonderilenArgs: Record<string, unknown>[] = [];
  const cagir = async (arac: string, args: Record<string, unknown>) => {
    gonderilenArgs.push({ arac, ...args });
    return sahteYanit(arac);
  };

  const sonuc = await uygula(
    {
      plan: {
        kampanyaAdi: "Kahve Kampanyası",
        butceGunlukTL: 100,
        hedefUlke: "TR",
        adGruplari: [{ ad: "Grup 1", anahtarKelimeler: ["kahve"], eslesmeTipi: "PHRASE" }],
      },
      kreatif: {
        basliklar: ["Başlık A", "Başlık B", "Başlık C"],
        aciklamalar: ["Açıklama bir", "Açıklama iki"],
        yol1: "kurumsal",
        yol2: "fiyatlar",
      },
      musteriId: "1234567890",
      finalUrl: "https://ornek.test/kahve",
    },
    { cagir }
  );

  const rsa = gonderilenArgs.find((a) => a.arac === "create_responsive_search_ad");
  assert.ok(rsa, "create_responsive_search_ad çağrılmadı.");
  assert.equal(rsa!.path1, undefined, "path1 gönderilmiyor — uyarı bu yüzden zorunlu.");
  assert.equal(rsa!.path2, undefined);

  assert.ok(
    sonuc.uyarilar.some((u: string) => /yol1\/yol2\) UYGULANMADI/u.test(u)),
    "Görünen yol sessizce düşürüldü: rapor '**Görünen yol:** /kurumsal/fiyatlar' basarken " +
      "uygulama izinde bunun uygulanmadığına dair tek satır yok."
  );
});

test("ONARIM 2: yol verilmediğinde sahte uyarı üretilmez", async () => {
  const sonuc = await uygula(
    {
      plan: {
        kampanyaAdi: "Kahve Kampanyası",
        butceGunlukTL: 100,
        hedefUlke: "TR",
        adGruplari: [{ ad: "Grup 1", anahtarKelimeler: ["kahve"], eslesmeTipi: "PHRASE" }],
      },
      kreatif: {
        basliklar: ["Başlık A", "Başlık B", "Başlık C"],
        aciklamalar: ["Açıklama bir", "Açıklama iki"],
      },
      musteriId: "1234567890",
      finalUrl: "https://ornek.test/kahve",
    },
    { cagir: async (arac: string) => sahteYanit(arac) }
  );

  assert.equal(
    sonuc.uyarilar.some((u: string) => /UYGULANMADI/u.test(u)),
    false
  );
});

/* ── Local stubs ─────────────────────────────────────────────────────────────── */

/** The server's affirmative sentences, verbatim enough for BASARI_IZLERI to match. */
function sahteYanit(arac: string): string {
  switch (arac) {
    case "run_gaql":
      return "0 satır";
    case "create_search_campaign":
      return (
        "Kampanya PAUSED olarak oluşturuldu: customers/1234567890/campaigns/5550001 · " +
        "reklam grubu customers/1234567890/adGroups/7770001"
      );
    case "add_keywords":
      return "3 anahtar kelime eklendi [EXACT]";
    case "add_campaign_negative_keywords":
      return "2 anahtar kelime KAMPANYA seviyesinde eklendi [PHRASE]";
    case "create_responsive_search_ad":
      return "RSA oluşturuldu: customers/1234567890/ads/9990001";
    default:
      return "(boş yanıt)";
  }
}

/** Records the `name` create_search_campaign was actually called with. */
function sahteCagir(adlar: string[]) {
  return async (arac: string, args: Record<string, unknown>) => {
    if (arac === "create_search_campaign") adlar.push(String(args.name));
    return sahteYanit(arac);
  };
}
