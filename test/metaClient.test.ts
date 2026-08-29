// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Meta istemcisi — TELE GİDEN İSTEĞİN KENDİSİ.
 *
 * Araç testleri sahte bir kanal enjekte eder, yani istemcinin gerçekte NE GÖNDERDİĞİNİ
 * hiç görmezler. Bu dosya `fetch`'i taklit ederek isteğin gövdesine bakar. İki söz
 * yalnız burada kanıtlanabilir ve ikisi de mutasyonla testsiz bulundu:
 *
 *   1) Kampanyalar DURAKLATILMIŞ doğar. Bu, ürünün ilk cümlesi. Sabit `ACTIVE`'e
 *      çevrildiğinde takım yeşil kalıyordu — söz koddaydı, kanıtı yoktu.
 *   2) Hata metinleri access_token sızdırmaz. Meta'nın hata gövdeleri istek URL'sini
 *      yankılayabilir ve token bir SORGU PARAMETRESİDİR; ham gövdeyi ajana göstermek,
 *      token'ı ajana (ve çalınmış bir oturuma) vermektir.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { metaKanali, hataTemizle, __setMetaKanalForTests } from "../src/meta/client.js";

const TOKEN = "TEST-ONLY-gizli-jeton-123456";
const AYAR = { metaToken: TOKEN, metaAdAccountId: "act_1" };

const gercekFetch = globalThis.fetch;
/** Yapılan isteklerin çözümlenmiş gövdeleri. */
let govdeler: URLSearchParams[] = [];
let urller: string[] = [];

afterEach(() => {
  globalThis.fetch = gercekFetch;
  __setMetaKanalForTests(undefined);
  govdeler = [];
  urller = [];
});

function kanalKur(yanitGovdesi: unknown = { id: "120200000000009" }) {
  globalThis.fetch = (async (u: any, init: any) => {
    urller.push(String(u));
    if (init?.body) govdeler.push(new URLSearchParams(String(init.body)));
    return { ok: true, text: async () => JSON.stringify(yanitGovdesi) } as any;
  }) as typeof fetch;
  __setMetaKanalForTests(undefined);
  return metaKanali(AYAR);
}

/* ── kampanyalar duraklatılmış doğar ──────────────────────────────────────────── */

test("KRİTİK: Meta kampanyası TELDE de DURAKLATILMIŞ oluşturulur", async () => {
  /**
   * Sözün gerçek yeri burası. Araç katmanı ne derse desin, Meta'ya giden gövdede
   * status=PAUSED yoksa kampanya yayına girer ve harcamaya başlar — onay kapısı hiç
   * çalışmadan, çünkü oluşturma onay istemeyen bir işlemdir.
   */
  const k = kanalKur();
  await k.kampanyaOlustur({ ad: "Yaz", hedef: "OUTCOME_TRAFFIC", gunlukButce: 100 });

  assert.equal(govdeler.length, 1, "tek bir oluşturma isteği gitmeli");
  assert.equal(
    govdeler[0].get("status"),
    "PAUSED",
    "KRİTİK: kampanya yayında doğarsa onay kapısı hiç çalışmadan para harcanır"
  );
});

test("KRİTİK: çağıran, kampanyayı yayında doğurmayı SEÇEMEZ", async () => {
  /**
   * PAUSED bir parametre değil, sabit. Parametre olsaydı söz çağrı yerine bırakılırdı
   * ve her yeni çağrı yeri onu yeniden doğru yapmak zorunda kalırdı. Burada, çağıran
   * ne geçirirse geçirsin gövdenin değişmediği ölçülüyor.
   */
  const k = kanalKur();
  await (k.kampanyaOlustur as any)({
    ad: "Sızma denemesi",
    hedef: "OUTCOME_SALES",
    gunlukButce: 100,
    status: "ACTIVE",
    durum: "ACTIVE",
  });
  assert.equal(govdeler[0].get("status"), "PAUSED", "çağıranın geçirdiği durum yok sayılmalı");
});

test("oluşturma isteği bütçeyi minor unit olarak taşır", async () => {
  const k = kanalKur();
  await k.kampanyaOlustur({ ad: "Yaz", hedef: "OUTCOME_TRAFFIC", gunlukButce: 100 });
  assert.equal(govdeler[0].get("daily_budget"), "10000", "100 birim = 10000 minor unit");
});

test("dönen kampanya, gönderilen değerleri taşır ve PAUSED bildirir", async () => {
  const k = kanalKur({ id: "120200000000009" });
  const c = await k.kampanyaOlustur({ ad: "Yaz", hedef: "OUTCOME_TRAFFIC", gunlukButce: 100 });
  assert.equal(c.durum, "PAUSED", "çağırana da duraklatılmış olduğu söylenmeli");
  assert.equal(c.id, "120200000000009");
  assert.equal(c.gunlukButce, 100);
});

/* ── sır sızıntısı ────────────────────────────────────────────────────────────── */

test("KRİTİK SIZINTI: hata metni access_token'ı olduğu gibi göstermez", async () => {
  /**
   * Meta'nın hata gövdeleri istek URL'sini yankılar ve token orada bir sorgu
   * parametresidir. Ham gövdeyi ajana döndürmek, jetonu ajanın bağlamına yazmaktır —
   * ve o bağlam kaydedilir, taşınır, bazen paylaşılır. Aynı ders CAMARA tarafında
   * yaşandı; burada baştan uygulanıyor.
   */
  const ham =
    '{"error":{"message":"Unsupported request","fbtrace_id":"A1"},' +
    `"request":"https://graph.facebook.com/v21.0/act_1/campaigns?access_token=${TOKEN}&fields=id"}`;
  const temiz = hataTemizle(ham, TOKEN);

  assert.doesNotMatch(temiz, new RegExp(TOKEN), "KRİTİK: jeton hata metninde görünemez");
  assert.match(temiz, /access_token=\*\*\*/, "maskelendiği görülmeli");
  assert.match(temiz, /Unsupported request/, "gerçek hata sebebi korunmalı — mesaj işe yaramalı");
});

test("KRİTİK SIZINTI: jeton gövdede ÇIPLAK geçse de maskelenir", async () => {
  /**
   * Yankı her zaman `access_token=` biçiminde gelmez; jeton bir JSON alanında ya da
   * serbest metinde de görünebilir. Yalnız sorgu-parametresi desenine güvenmek, en
   * olası biçimi kapatıp diğerlerini açık bırakmak olurdu.
   */
  const ham = `{"error":{"message":"Invalid OAuth access token: ${TOKEN}"}}`;
  const temiz = hataTemizle(ham, TOKEN);
  assert.doesNotMatch(temiz, new RegExp(TOKEN), "jeton nerede geçerse geçsin gizlenmeli");
});

test("KRİTİK SIZINTI: API hatası ajana ulaşırken jeton taşımaz", async () => {
  /**
   * Uçtan uca: maskeleme yardımcı fonksiyonda doğru olsa bile, hata yolunda
   * ÇAĞRILMIYORSA hiçbir işe yaramaz.
   */
  globalThis.fetch = (async (u: any) => {
    urller.push(String(u));
    return {
      ok: false,
      status: 400,
      text: async () => `{"error":{"message":"Bad request","url":"${String(u)}"}}`,
    } as any;
  }) as typeof fetch;
  __setMetaKanalForTests(undefined);

  const k = metaKanali(AYAR);
  const hata = await k.kampanyaOku("120200000000001").then(
    () => null,
    (e: Error) => e
  );

  assert.ok(hata, "hata fırlatılmalı");
  assert.doesNotMatch(hata!.message, new RegExp(TOKEN), "KRİTİK: jeton hata mesajına sızmamalı");
  assert.match(hata!.message, /400/, "durum kodu operatöre söylenmeli");
});

test("jeton tanımsızken maskeleme yine de çalışır (çökmez)", () => {
  const temiz = hataTemizle('{"url":"https://x/?access_token=abc123"}', undefined);
  assert.match(temiz, /access_token=\*\*\*/, "sorgu parametresi jeton bilinmese de maskelenmeli");
});
