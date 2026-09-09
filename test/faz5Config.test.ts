// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 5 — src/config.ts: YAZILANIN ÖLÇÜLENE UYMASI.
 *
 * Bu dosyadaki gözcülerin hepsi tek bir kusur ailesine ait: "kodun yaptığından BAŞKASINI
 * söyleyen metin". İki bayat iddia vardı, ikisi de ölçülerek yanlışlandı.
 *
 * 1) "SUNUCU AÇILMAZ" — AÇILIYOR. config.ts iki YORUMDA (approverPhone JSDoc'u,
 *    parseBudgetCap başlığı) ve operatöre giden iki RET METNİNDE bunu söylüyordu.
 *    ÖLÇÜM (`node --import tsx src/index.ts`, sahte kimlik bilgileriyle spawn edilerek):
 *    AEGIS_MAX_DAILY_BUDGET="250,00" ile de AEGIS_APPROVER_PHONE="9" ile de süreç
 *    "[aegis] MCP sunucusu stdio üzerinde hazır." yazdı ve AYAKTA KALDI. Aynı ölçüm
 *    gerçek MCP çifti üzerinden de yapıldı: el sıkışma tamamlandı, 15 araç listelendi,
 *    list_accounts `isError:true` döndü, bağlam istemeyen analyze_site normal yanıt verdi.
 *    Sebebi yapısal: loadConfig/nacConfigFromEnv TEMBEL okunuyor (stdio: adsClient.ts
 *    getEnvContext, barındırılan: http.ts contextFor) ve hiçbir açılış yolu onlara dokunmuyor.
 *
 *    SÖZLEŞME ZAYIFLAMADI: kapalı arıza aynı yerde duruyor, yalnız YERİ doğru yazıldı —
 *    "açılışta" değil, "hesabına dokunan her araç çağrısında". Gözcüler bu yüzden ÇİFT
 *    YÖNLÜ: metin bayatlarsa da (C, D), metnin anlattığı davranış bozulursa da (A, B)
 *    kırmızıya döner.
 *
 * 2) BAYAT ÖNCÜL: numara doğrulaması geldikten sonra üç cümle depoda kaldı —
 *    src/networkTrust.ts'te "src/config.ts only trims AEGIS_APPROVER_PHONE", ve
 *    test/agSizintiStderr.test.ts'te iki yerde "config.ts only trims the value" /
 *    "there is no E.164 validation". Bu cümleler GIZLI_ASGARI_UZUNLUK=8 tabanının
 *    GEREKÇESİ; gerekçe yanlış okunursa biri "artık kısa değer buraya ulaşamıyor" deyip
 *    tabanı kaldırabilir. Hiçbir gözcü bakmıyordu. E testi cümlelerin dönüşünü, F testi
 *    tabanın YENİ gerekçesinin (AEGIS_NAC_TOKEN yalnız trim ediliyor) doğru kalmasını bekler.
 *
 * BU DOSYA AĞA ÇIKMAZ. Araç çağrısı yerine, araçların gerçekten kullandığı bağlam
 * sağlayıcısı (getEnvContext) doğrudan sınanır: gerçek bir list_accounts çağrısı, retleri
 * kaldıran bir mutasyon altında Google API'sine gitmeye kalkardı ve gözcü kendi
 * mutasyon provasında ağa çıkardı.
 */
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { getEnvContext } from "../src/adsClient.js";
import { loadConfig, nacConfigFromEnv } from "../src/config.js";
import { operatorMetniTemizle } from "../src/networkTrust.js";

/** Restores every environment variable this file touches. */
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
 * The credentials are set BY THE TEST: loadConfig() throws when the four are missing, so
 * every assertion below would otherwise depend on the developer's .env (green in CI, red
 * locally, or the reverse). The values are fake and nothing here reaches the network.
 *
 * The three variables under examination are explicitly cleared too — a value left in the
 * developer's environment could quietly falsify the "the server does come up" measurement.
 */
beforeEach(() => {
  ayarla("GOOGLE_ADS_DEVELOPER_TOKEN", "TEST-ONLY-developer-token");
  ayarla("GOOGLE_ADS_CLIENT_ID", "TEST-ONLY-client-id");
  ayarla("GOOGLE_ADS_CLIENT_SECRET", "TEST-ONLY-client-secret");
  ayarla("GOOGLE_ADS_REFRESH_TOKEN", "TEST-ONLY-refresh-token");
  ayarla("AEGIS_MAX_DAILY_BUDGET", undefined);
  ayarla("AEGIS_APPROVER_PHONE", undefined);
  ayarla("AEGIS_NAC_TOKEN", undefined);
});

/**
 * Brings the REAL server assembly up over an in-memory MCP pair and reports what an operator
 * would actually see. Nothing is faked here on purpose: `buildServer(getEnvContext)` is the
 * exact call src/index.ts makes, so "does the server start?" is answered by the server.
 */
async function sunucuyuAyagaKaldir(): Promise<{ aracSayisi: number; kapat: () => Promise<void> }> {
  const server = buildServer(getEnvContext);
  const [istemciUcu, sunucuUcu] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "faz5-gozcu", version: "0" });
  await Promise.all([server.connect(sunucuUcu), client.connect(istemciUcu)]);
  const liste = await client.listTools();
  return {
    aracSayisi: liste.tools.length,
    kapat: async () => {
      await client.close();
      await server.close();
    },
  };
}

/* ── A + B) ÖLÇÜM: sunucu açılır, ret ARAÇ ÇAĞRISINDA gelir ───────────────────── */

/**
 * A ve B aynı iddianın iki yarısıdır ve ikisi de tek bir cümlede toplanır: "okunamayan
 * değer sunucuyu düşürmez, hesabına dokunan her aracı düşürür."
 *
 * İLK YARI (sunucu ayakta): buildServer + el sıkışma + listTools geçmeli. Mutasyonla
 * denendi — src/server.ts'te buildServer'ın başına `getCtx();` eklendiğinde bu satır
 * KIRMIZI oldu, yani "açılır" iddiası gerçekten ölçülüyor.
 *
 * İKİNCİ YARI (kapalı arıza yerinde): getEnvContext — araçlara verilen bağlam
 * sağlayıcısının ta kendisi — fırlatmalı ve HANGİ değişken olduğunu söylemeli. Mutasyonla
 * denendi: parseBudgetCap'i eski "sessizce 500'e düş" hâline çevirince KIRMIZI oldu.
 */
test("KRİTİK ÖLÇÜM: okunamayan bütçe tavanı sunucuyu DÜŞÜRMEZ, her araç çağrısını düşürür", async () => {
  ayarla("AEGIS_MAX_DAILY_BUDGET", "250,00");

  const s = await sunucuyuAyagaKaldir();
  try {
    assert.ok(
      s.aracSayisi > 0,
      "ÖLÇÜLEN DAVRANIŞ: sunucu açılır ve araçlarını listeler — 'açılmaz' diyen her metin yanlıştır"
    );
  } finally {
    await s.kapat();
  }

  assert.throws(
    () => getEnvContext(),
    /AEGIS_MAX_DAILY_BUDGET/,
    "okunamayan tavan sessizce varsayılana çekilemez: bağlam çözümü REDDE gitmeli, hangi değişken olduğu söylenerek"
  );
});

test("KRİTİK ÖLÇÜM: okunamayan onaylayıcı numarası sunucuyu DÜŞÜRMEZ, her araç çağrısını düşürür", async () => {
  ayarla("AEGIS_APPROVER_PHONE", "9");

  const s = await sunucuyuAyagaKaldir();
  try {
    assert.ok(
      s.aracSayisi > 0,
      "ÖLÇÜLEN DAVRANIŞ: sunucu açılır ve araçlarını listeler — 'açılmaz' diyen her metin yanlıştır"
    );
  } finally {
    await s.kapat();
  }

  assert.throws(
    () => getEnvContext(),
    /AEGIS_APPROVER_PHONE/,
    "numara olmayan değer sessizce 'onaylayıcı' sayılamaz: bağlam çözümü REDDE gitmeli"
  );
  // Barındırılan yol loadConfig'i hiç çağırmaz; ret orada da aynı yerde durmalı.
  assert.throws(() => nacConfigFromEnv(), /AEGIS_APPROVER_PHONE/, "barındırılan yol da kapalı arızaya düşmeli");
});

/* ── C) BELGE: config.ts açılış vaadi vermez, tembel okumanın gerçeğini yazar ─── */

const CONFIG_KAYNAK = readFileSync(fileURLToPath(new URL("../src/config.ts", import.meta.url)), "utf8");

/**
 * Flattens a source file for phrase matching: leading comment markers are dropped and every
 * whitespace run becomes one space, so a claim WRAPPED ACROSS TWO COMMENT LINES is still
 * found. Nothing is filtered out — joining lines can only ADD matches, never hide one; the
 * raw text is searched as well, at every call site below.
 */
function duzMetin(kaynak: string): string {
  return kaynak
    .replace(/^[ \t]*\*[ \t]?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The JSDoc block immediately above `capa`, flattened to one line. */
function ustBelge(capa: string): string {
  const satirlar = CONFIG_KAYNAK.split("\n");
  const i = satirlar.findIndex((s) => s.trim().startsWith(capa));
  assert.notEqual(i, -1, `'${capa}' bulunamadı — testin çapası kaymış`);
  const blok: string[] = [];
  for (let j = i - 1; j >= 0; j--) {
    const t = satirlar[j]!.trim();
    blok.unshift(t.replace(/^\/\*\*|^\*\/|^\*/, "").trim());
    if (t.startsWith("/**")) break;
    assert.ok(j > i - 80, `'${capa}' üstünde JSDoc bloğu yok`);
  }
  return blok.join(" ").replace(/\s+/g, " ").trim();
}

/** Measured false: neither entry point reads these settings while it starts. */
const ACILIS_VAADI = [
  /sunucu açılmaz/i,
  /sunucu başlamaz/i,
  /server does not start/i,
  /server will not start/i,
  /does not come up/i,
];

test("BELGE: config.ts artık AÇILIŞ vaadi vermiyor — TEMBEL okumanın ölçülen gerçeğini yazıyor", () => {
  for (const desen of ACILIS_VAADI) {
    assert.equal(desen.test(CONFIG_KAYNAK), false, `bayat açılış iddiası ham kaynağa geri geldi: ${desen}`);
    assert.equal(
      desen.test(duzMetin(CONFIG_KAYNAK)),
      false,
      `bayat açılış iddiası geri geldi (satır sonuna bölünmüş hâliyle): ${desen}`
    );
  }

  // Ve YERİNE ne yazdığı: iki blok da tembel okumanın seamini ADIYLA söylemeli, yoksa
  // "açılmaz"ı silmek yorumu doğru değil yalnızca sessiz yapardı.
  const numaraBelgesi = ustBelge("approverPhone?:");
  assert.match(numaraBelgesi, /LAZILY/, "yorum okumanın TEMBEL olduğunu söylemeli");
  assert.match(numaraBelgesi, /getEnvContext/, "stdio yolundaki gerçek seam adıyla anılmalı");
  assert.match(numaraBelgesi, /contextFor/, "barındırılan yoldaki gerçek seam adıyla anılmalı");
  assert.match(numaraBelgesi, /isError/, "retin araç çağrısında görüldüğü söylenmeli");

  const tavanBelgesi = ustBelge("function parseBudgetCap");
  assert.match(tavanBelgesi, /LAZILY/, "tavan yorumu da okumanın TEMBEL olduğunu söylemeli");
  assert.match(tavanBelgesi, /getEnvContext/, "tavan yorumu gerçek seami adıyla anmalı");
  assert.match(tavanBelgesi, /isError/, "retin araç çağrısında görüldüğü söylenmeli");
});

/* ── D) RET METNİ: operatöre giden cümle de ölçülen davranışı söyler ──────────── */

/** Runs `kur`, then returns the message loadConfig() refuses with. */
function retMetni(kur: () => void): string {
  kur();
  try {
    loadConfig();
  } catch (e) {
    return (e as Error).message;
  }
  assert.fail("loadConfig REDDETMELİYDİ — kapalı arıza kalktı");
}

test("RET METNİ: operatöre 'sunucu açılmaz' denmez; araçların durduğu söylenir", () => {
  /**
   * Bozuk değerler bir SIZINTI SENTİNELİ taşır. Gerçekçi yazım hataları ("250,00", "9")
   * A ve B testlerinde koşuyor; burada aranan şey ret CÜMLESİ, ve tek karakterlik bir
   * değerle "ham değer sızmadı" iddiası ölçülemez: "9" zaten metnin içindeki "7-15 rakam"
   * ifadesinde geçer, yani gözcü hiçbir zaman kırmızıya dönemezdi.
   */
  const durumlar: Array<[string, string, string]> = [
    ["AEGIS_MAX_DAILY_BUDGET", "250,00 TEST-ONLY-sizinti-sentineli", "AEGIS_MAX_DAILY_BUDGET"],
    ["AEGIS_APPROVER_PHONE", "+9 TEST-ONLY-sizinti-sentineli", "AEGIS_APPROVER_PHONE"],
  ];
  for (const [degisken, bozuk, beklenenAd] of durumlar) {
    const m = retMetni(() => {
      // Her tur yalnız BİR değişken bozuk olmalı: loadConfig ilk reddettiği yerde durur, ve
      // önceki turdan kalan bozuk değer bu turun iddiasını sessizce başka bir rette ölçerdi.
      for (const [d] of durumlar) ayarla(d, undefined);
      ayarla(degisken, bozuk);
    });

    assert.match(m, new RegExp(beklenenAd), "operatör hangi değişkeni düzelteceğini görmeli");
    for (const desen of ACILIS_VAADI) {
      assert.equal(desen.test(m), false, `${degisken} reddi ölçülmemiş bir açılış vaadi taşıyor: ${desen}`);
    }
    assert.match(
      m,
      /hiçbir araç çalışmaz/,
      `${degisken} reddi ölçülen sonucu söylemeli: sunucu ayakta kalır, hesaba dokunan araçlar durur`
    );
    assert.equal(m.includes(bozuk), false, "ham değer ret metnine sızmamalı (sır olabilir)");
  }
});

/* ── E) BAYAT ÖNCÜL: "config.ts numarayı yalnız trim ediyor" cümlesi ──────────── */

const NETWORKTRUST_KAYNAK = readFileSync(
  fileURLToPath(new URL("../src/networkTrust.ts", import.meta.url)),
  "utf8"
);
const SIZINTI_KAYNAK = readFileSync(
  fileURLToPath(new URL("../test/agSizintiStderr.test.ts", import.meta.url)),
  "utf8"
);

/** Each was true before parseApproverPhone existed, and each is false now. */
const BAYAT_ONCUL = [
  /only trims AEGIS_APPROVER_PHONE/i,
  /config\.ts only trims the value/i,
  /no E\.164 validation/i,
  /yalnızca trim/i,
];

test("BAYAT ÖNCÜL: 'config.ts numarayı yalnız trim ediyor' hiçbir dosyada duramaz", () => {
  const dosyalar: Array<[string, string]> = [
    ["src/networkTrust.ts", NETWORKTRUST_KAYNAK],
    ["test/agSizintiStderr.test.ts", SIZINTI_KAYNAK],
    ["src/config.ts", CONFIG_KAYNAK],
  ];
  for (const [ad, kaynak] of dosyalar) {
    for (const desen of BAYAT_ONCUL) {
      assert.equal(desen.test(kaynak), false, `${ad}: bayat öncül geri geldi — ${desen}`);
      assert.equal(
        desen.test(duzMetin(kaynak)),
        false,
        `${ad}: bayat öncül geri geldi (satır sonuna bölünmüş hâliyle) — ${desen}`
      );
    }
  }

  /**
   * Cümlelerin YANLIŞ olduğunun kanıtı burada ölçülür, iddia edilmez. Bu satır düşerse
   * öncül yeniden DOĞRU olmuş demektir: o zaman silinecek şey cümleler değil, geri
   * getirilecek şey doğrulamadır.
   */
  ayarla("AEGIS_APPROVER_PHONE", "9");
  assert.throws(
    () => nacConfigFromEnv(),
    /AEGIS_APPROVER_PHONE/,
    "öncül yeniden doğru: config.ts numarayı gerçekten yalnız trim ediyor"
  );
});

/* ── F) TABANIN YENİ GEREKÇESİ ölçülebilir kalmalı ────────────────────────────── */

/**
 * GIZLI_ASGARI_UZUNLUK=8 tabanının eski gerekçesi (numara doğrulanmıyordu) öldü; yenisi
 * ölçülebilir olmalı, yoksa taban ikinci kez gerekçesiz kalır ve biri onu kaldırır.
 *
 * İKİ AÇIK KAPI VAR ve ikisi de burada ölçülür: (a) AEGIS_NAC_TOKEN config.ts'te YALNIZ
 * trim ediliyor, yani tek karakterlik bir jeton temizleyiciye ulaşabiliyor; (b) taban
 * gerçekten koruyor — o jetonla tanı satırı bozulmadan kalıyor. Taban olmasaydı satır
 * `Status 42***. Body: rate limited, retry after ***0 s` olurdu (ölçüldü).
 */
test("TABANIN GEREKÇESİ: AEGIS_NAC_TOKEN yalnız trim edilir, taban tanı satırını korur", () => {
  ayarla("AEGIS_NAC_TOKEN", "9");
  assert.equal(
    nacConfigFromEnv().nacToken,
    "9",
    "config.ts jetona uzunluk şartı koyduysa GIZLI_ASGARI_UZUNLUK'un gerekçesi bayatladı — o yorumu da güncelle"
  );

  const TANI = "Status 429. Body: rate limited, retry after 90 s";
  assert.equal(
    operatorMetniTemizle(TANI, { nacToken: "9" }),
    TANI,
    "kısa jeton tanı satırını PARÇALAMAMALI — taban tam olarak bunun için var"
  );
});
