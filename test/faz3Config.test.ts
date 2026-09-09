// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 3 — src/config.ts gerileme gözcüleri.
 *
 * BURADAKİ TEK KONU: bütçe tavanının YÖNÜ. Geçersiz bir tavanın "devre dışı kalmaması"
 * yetmez; geri düşülen değerin operatörün NİYETİNDEN YÜKSEK olamaması gerekir. Sabit bir
 * 500'e düşmek bu ikinci şartı sağlamıyordu: tavanı 250'ye İNDİRMEK isteyip `250,00`
 * (ondalık virgül), `250 TL` ya da `₺250` yazan operatör sessizce 500 ile koşuyordu —
 * istediğinin İKİ KATI. Tek uyarı stderr'e gidiyordu; MCP stdio kipinde bu satır
 * istemcinin log dosyasına düşer ve operatör onu hiç görmez.
 *
 * Bu yüzden sözleşme: geçersiz değer HATA FIRLATIR, sessizce düzeltilmez.
 */
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

/** Testin dokunduğu değişkenleri eski hâline döndürür. */
const yedek = new Map<string, string | undefined>();
function ayarla(ad: string, deger: string | undefined): void {
  if (!yedek.has(ad)) yedek.set(ad, process.env[ad]);
  if (deger === undefined) delete process.env[ad];
  else process.env[ad] = deger;
}
afterEach(() => {
  for (const [ad, eski] of yedek) {
    if (eski === undefined) delete process.env[ad];
    else process.env[ad] = eski;
  }
  yedek.clear();
});

/**
 * Kimlik bilgilerini testin kendisi kurar: loadConfig() dördü eksikse zaten fırlatır ve
 * bu dosyadaki her iddia geliştiricinin .env'ine bağlı hâle gelirdi. Değerler sahtedir,
 * hiçbir test ağa çıkmaz.
 */
beforeEach(() => {
  ayarla("GOOGLE_ADS_DEVELOPER_TOKEN", "TEST-ONLY-developer-token");
  ayarla("GOOGLE_ADS_CLIENT_ID", "TEST-ONLY-client-id");
  ayarla("GOOGLE_ADS_CLIENT_SECRET", "TEST-ONLY-client-secret");
  ayarla("GOOGLE_ADS_REFRESH_TOKEN", "TEST-ONLY-refresh-token");
});

/* ── tavanın yönü: geri düşülen değer niyetten YÜKSEK olamaz ──────────────────── */

/**
 * Ölçülmüş kaza kalıpları. Hepsi `Number(...)` için NaN'dır, hepsi 500'ün ALTINDA bir
 * niyeti anlatır — yani eski davranışta tavanı sessizce YÜKSELTİRLERDİ.
 */
const NIYETI_DUSUK_YAZIM_HATALARI = ["250,00", "250 TL", "₺250", "1.250,50", "250₺"];

test("KRİTİK: 500'ün ALTINDAKİ niyeti anlatan geçersiz tavan, tavanı YÜKSELTEMEZ", () => {
  for (const bozuk of NIYETI_DUSUK_YAZIM_HATALARI) {
    ayarla("AEGIS_MAX_DAILY_BUDGET", bozuk);
    let tavan: number | undefined;
    try {
      tavan = loadConfig().maxDailyBudget;
    } catch {
      // Fırlatmak bu iddiayı sağlar: hiçbir tavanla koşulmuyor, sunucu açılmıyor.
      continue;
    }
    assert.fail(
      `'${bozuk}' 250 civarı bir niyeti anlatıyor ama tavan ${String(tavan)} oldu — ` +
        "geri düşülen değer niyetten YÜKSEK olamaz"
    );
  }
});

test("KRİTİK: geçersiz bütçe tavanı loadConfig'i DÜŞÜRÜR (sessiz düzeltme yok)", () => {
  for (const bozuk of ["abc", "0", "-100", "NaN", "Infinity", "250,00", "1e", "%50"]) {
    ayarla("AEGIS_MAX_DAILY_BUDGET", bozuk);
    assert.throws(
      () => loadConfig(),
      /AEGIS_MAX_DAILY_BUDGET/,
      `'${bozuk}' sessizce bir varsayılana çekilemez, hangi değişken olduğu söylenerek reddedilmeli`
    );
  }
});

test("hata metni operatöre DOĞRU yazımı gösterir (ondalık ayırıcı NOKTA)", () => {
  ayarla("AEGIS_MAX_DAILY_BUDGET", "250,00");
  assert.throws(() => loadConfig(), (e: unknown) => {
    const m = (e as Error).message;
    assert.match(m, /NOKTA/, "ondalık virgülle yazan operatöre doğru ayırıcı söylenmeli");
    assert.match(m, /250/, "somut bir örnek verilmeli");
    return true;
  });
});

/* ── kapı bir duvar değil: geçerli ve yokluk hâlleri korunur ──────────────────── */

test("geçerli tavan aynen geçer, yokluk varsayılanı korur (regresyon kelepçesi)", () => {
  ayarla("AEGIS_MAX_DAILY_BUDGET", "250");
  assert.equal(loadConfig().maxDailyBudget, 250, "geçerli değer olduğu gibi kullanılmalı");
  ayarla("AEGIS_MAX_DAILY_BUDGET", "250.5");
  assert.equal(loadConfig().maxDailyBudget, 250.5, "noktalı ondalık geçerlidir");
  // Değişkenin YOKLUĞU bir yazım hatası değil, bir tercih etmeme hâlidir: belgelenmiş
  // varsayılan korunur. Bu satır düşerse ".env yazmayan herkes açılışta reddedilir"
  // demektir — düzeltmenin aşırıya kaçtığını gösteren tek gözcü budur.
  ayarla("AEGIS_MAX_DAILY_BUDGET", undefined);
  assert.equal(loadConfig().maxDailyBudget, 500, "tanımsız değişken varsayılana düşer");
  ayarla("AEGIS_MAX_DAILY_BUDGET", "   ");
  assert.equal(loadConfig().maxDailyBudget, 500, "boş değişken de varsayılana düşer");
});

/* ── sır sızıntısı: ret metni HAM DEĞERİ taşımaz ──────────────────────────────── */

test("ret HAM DEĞERİ sızdırmaz — ne hata metnine ne stderr'e", () => {
  const SIZINTI_SENTINELI = "EAAG-TEST-ONLY-jeton-905551112233";
  ayarla("AEGIS_MAX_DAILY_BUDGET", SIZINTI_SENTINELI);
  const gercek = console.error;
  let yazilanlar = "";
  console.error = (...p: unknown[]) => {
    yazilanlar += p.map(String).join(" ") + "\n";
  };
  try {
    assert.throws(() => loadConfig(), (e: unknown) => {
      const m = (e as Error).message;
      assert.equal(
        m.includes(SIZINTI_SENTINELI),
        false,
        "yanlış slota yapıştırılmış bir jeton hata metniyle dışarı çıkamaz"
      );
      assert.match(m, /AEGIS_MAX_DAILY_BUDGET/, "operatör hangi değişkeni düzelteceğini görmeli");
      return true;
    });
  } finally {
    console.error = gercek;
  }
  assert.equal(yazilanlar.includes(SIZINTI_SENTINELI), false, "ham değer stderr'e de yazılmamalı");
});

/* ── belge gözcüsü: yorum ile kod aynı şeyi söylemeli (ÇİFT YÖNLÜ) ───────────── */

test("BELGE: config.ts'teki tavan yorumu kodla aynı şeyi söyler", async () => {
  const { readFile } = await import("node:fs/promises");
  const kaynak = await readFile(new URL("../src/config.ts", import.meta.url), "utf8");
  const i = kaynak.indexOf("function parseBudgetCap");
  assert.notEqual(i, -1, "parseBudgetCap kayboldu ya da adı değişti — gözcüyü güncelle");
  const yorum = kaynak.slice(Math.max(0, i - 1400), i);
  const govde = kaynak.slice(i, i + 900);

  // KOD yönü: gövde gerçekten fırlatıyor ve sessiz bir geri düşüş bırakmıyor olmalı.
  assert.match(govde, /throw new Error\(/, "geçersiz tavan fırlatmalı");
  assert.equal(
    /console\.error\(/.test(govde),
    false,
    "geçersiz tavan artık uyarıyla geçiştirilmiyor; uyarı geri geldiyse yorum bayatladı"
  );

  // BELGE yönü: yorum hâlâ 'sabit 500'e düşülüyor' diye anlatıyorsa bayattır.
  assert.match(yorum, /Fail-closed/, "yorum sözleşmeyi adıyla anmalı");
  assert.equal(
    /falls back to the default \(500\) and warns on stderr/.test(yorum),
    false,
    "yorum eski (sabit 500'e düşen) davranışı anlatıyor — bayat"
  );
});
