// SPDX-License-Identifier: AGPL-3.0-only
/**
 * REPAIR REGRESSION TESTS — scripts/brain/rapor.mjs
 *
 * ONE audited finding is locked down here: the channel-allocation table stamped "bu koşuda
 * planlandı" on the FIRST ROW of the array, while the campaign is created from the share
 * picked BY NAME (uygulanacakPay(dagitim, "google") in growth-brain.mjs). The ordering of
 * that array is the MODEL's, so an allocation returned as [meta, google] made the report —
 * a permanent audit artifact — record Meta, a platform not one call was made to, as applied,
 * and Google, where the PAUSED campaign really was created, as "not applied".
 *
 * The stamp now follows the channel's NAME, and a channel that is missing from the
 * allocation stamps NO row at all (fail closed: "unknown" is not "row zero").
 *
 * Pure function, no network, no environment, no SDK.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
/*
 * rapor.mjs is plain JavaScript and tsconfig.json does not set allowJs, so TypeScript has no
 * declaration for it and reports TS7016. The test drives the REAL module at runtime; a
 * hand-written .d.mts twin would be a second copy of the contract, free to drift away from
 * it. ts-expect-error rather than ts-ignore on purpose: the day the module gains types, the
 * compiler flags this line instead of hiding a genuine error behind it.
 */
// @ts-expect-error TS7016 — untyped .mjs module, imported deliberately.
import { raporOlustur } from "../scripts/brain/rapor.mjs";

/** The model returned META FIRST; the campaign is created on Google with Google's share. */
const DAGITIM = [
  { kanal: "meta", gunlukButce: 70, gerekce: "görsel keşif" },
  { kanal: "google", gunlukButce: 30, gerekce: "arama niyeti yüksek" },
];

/** A plan built with the APPLIED channel's share — as growth-brain.mjs builds it. */
const PLAN = {
  kampanyaAdi: "K",
  hedefUlke: "TR",
  dil: "tr",
  butceGunlukTL: 30,
  adGruplari: [],
  negatifKelimeler: [],
  basariMetrikleri: [],
};

function rapor(ek: Record<string, unknown> = {}): string {
  return raporOlustur({ hedef: "test", kuruMod: true, plan: PLAN, dagitim: DAGITIM, ...ek });
}

/** The allocation table's row for one channel. */
function kanalSatiri(metin: string, kanal: string): string {
  const satir = metin.split("\n").find((s) => s.startsWith(`| ${kanal} |`));
  assert.ok(satir, `raporda '${kanal}' satırı yok`);
  return satir as string;
}

test("ONARIM: 'bu koşuda planlandı' damgası UYGULANAN kanala düşer, ilk satıra değil", () => {
  const metin = rapor({ uygulananKanal: "google" });

  assert.match(
    kanalSatiri(metin, "google"),
    /bu koşuda planlandı/u,
    "Kampanya Google'da kuruldu; 'bu koşuda planlandı' damgası Google satırında olmalı."
  );
  assert.match(
    kanalSatiri(metin, "meta"),
    /ÖNERİ — bu koşuda uygulanmadı/u,
    "Meta'ya hiçbir çağrı yapılmadı; satırı ÖNERİ olarak işaretlenmeli."
  );
  assert.doesNotMatch(
    kanalSatiri(metin, "meta"),
    /bu koşuda planlandı/u,
    "Uygulanmamış kanal uygulanmış gibi kaydedildi — raporun kalıcı yanlış kaydı."
  );
  assert.ok(
    metin.includes("Yalnız 'google' kanalı için kampanya kuruldu/planlandı."),
    "Tablonun altındaki not da kanalı ADIYLA söylemeli ('ilk satırdaki kanal' değil)."
  );
});

test("ONARIM: kanal adı verilmeyen çağrıda da damga konuma göre verilmez", () => {
  // growth-brain.mjs bugün raporOlustur'a uygulananKanal geçmiyor; varsayılan yol da
  // dizinin sırasına değil, yazma yolunun gerçekten yazdığı kanala bakmalı.
  const metin = rapor();

  assert.match(kanalSatiri(metin, "google"), /bu koşuda planlandı/u);
  assert.doesNotMatch(kanalSatiri(metin, "meta"), /bu koşuda planlandı/u);
});

test("ONARIM: uygulanan kanal dağıtımda yoksa HİÇBİR satır 'planlandı' damgası almaz", () => {
  const metin = rapor({
    dagitim: [{ kanal: "meta", gunlukButce: 100, gerekce: "tek pay" }],
    uygulananKanal: "google",
  });

  assert.ok(
    !metin.includes("bu koşuda planlandı"),
    "Bilinmeyen, sıfır değildir: uygulanan kanal dağıtımda yokken bir satır uygulanmış sayılamaz."
  );
  assert.match(kanalSatiri(metin, "meta"), /BELİRSİZ — uygulandığı DOĞRULANMADI/u);
  assert.ok(
    metin.includes("HANGİ KANALA UYGULANDIĞI BU RAPORDAN OKUNAMAZ"),
    "Belirsizlik sessizce yutulmamalı; rapor bunu açıkça yazmalı."
  );
});
