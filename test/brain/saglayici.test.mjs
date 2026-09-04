// SPDX-License-Identifier: AGPL-3.0-only
/**
 * MODEL SAĞLAYICI KATMANI.
 *
 * MENA Ignite'ın Resource & Tooling Guide'ında ajanın MODELİ 3. bölümde listelenen
 * sağlayıcılardan gelmeli; orada Google AI Studio var, Anthropic yok. Varsayılan bu
 * yüzden Gemini.
 *
 * BU DOSYANIN ASIL İDDİASI ŞU: sağlayıcı değiştirmek HİÇBİR KAPIYI ZAYIFLATMAZ.
 * Uyarlayıcı Anthropic'in yanıt şeklini taklit ettiği için fallback sınırı, `stop_reason`
 * kapalı arızası ve şema doğrulaması tek kod yolundan koşar. Aşağıdaki testler bunu
 * sağlayıcıya özel dal aramadan, DAVRANIŞ üzerinden ölçer.
 *
 * ENV NEDEN PARAMETRE: ilk yazımda seçim `process.env`'den modül gövdesinde okunuyordu ve
 * her vakayı sınamak için modül taze yükleniyordu (`import("...?v=" + rastgele)`). Ölçüm
 * aracı her kopyayı ayrı bir dosya saydı: ortak.mjs kapsamı %54'e, depo geneli %89.95'ten
 * %77'ye düştü — kod değişmeden. Seçim artık saf fonksiyon; env argüman olarak geçiliyor
 * ve tek bir modül örneği yetiyor.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BRAIN_MODEL,
  BRAIN_SAGLAYICI,
  saglayiciSec,
  modelSec,
  beyinIstemcisi,
  geminiIstemcisi,
  metinUret,
  jsonUret,
} from "../../scripts/brain/ortak.mjs";

const gercekFetch = globalThis.fetch;

/** Boş ortam: gerçek kabuğun değişkenleri sızmasın diye her vaka kendi env'ini verir. */
const env = (ek = {}) => ({ ...ek });

test("varsayılan sağlayıcı GEMINI ve varsayılan model ona ait", () => {
  assert.equal(saglayiciSec(env()), "gemini", "teslim edilen ürün listedeki sağlayıcıyla koşmalı");
  assert.match(modelSec(env()), /^gemini-/, "varsayılan model Gemini olmalı: " + modelSec(env()));
});

test("anthropic seçilince varsayılan model de Claude'a döner", () => {
  const e = env({ AEGIS_BRAIN_PROVIDER: "anthropic" });
  assert.equal(saglayiciSec(e), "anthropic");
  assert.match(modelSec(e), /^claude-/, "sağlayıcı değişince varsayılan model de değişmeli");
});

test("AEGIS_BRAIN_MODEL her iki sağlayıcıyı da geçersiz kılar", () => {
  assert.equal(modelSec(env({ AEGIS_BRAIN_MODEL: "elle-secilen" })), "elle-secilen");
  assert.equal(
    modelSec(env({ AEGIS_BRAIN_PROVIDER: "anthropic", AEGIS_BRAIN_MODEL: "elle-secilen" })),
    "elle-secilen"
  );
});

test("büyük harf ve boşluk sağlayıcı adını bozmaz", () => {
  assert.equal(saglayiciSec(env({ AEGIS_BRAIN_PROVIDER: "  ANTHROPIC  " })), "anthropic");
});

test("dışa açılan sabitler seçim fonksiyonlarına BAĞLI (kopya değil)", () => {
  /**
   * Sabitler yükleme anında hesaplanır; bu iddia onların hâlâ AYNI kuraldan türediğini
   * söyler. Biri elle sabitlenirse (ör. doğrudan "gemini" yazılırsa) burası kızarır.
   */
  assert.equal(BRAIN_SAGLAYICI, saglayiciSec(process.env));
  assert.equal(BRAIN_MODEL, modelSec(process.env));
});

test("KRİTİK: tanınmayan sağlayıcı SESSİZCE varsayılana düşmez", () => {
  /**
   * Yazım hatası yapan operatör ("gemeni", "claude", "openai"), kullandığını sandığından
   * başka bir modelle koşmamalı. Sessiz düşüş, raporun hangi modelle üretildiği sorusunu
   * cevapsız bırakırdı.
   */
  assert.throws(
    () => beyinIstemcisi(env({ AEGIS_BRAIN_PROVIDER: "gemeni" })),
    /tanınmadı/u,
    "yazım hatası açıkça reddedilmeli"
  );
});

test("anahtar yoksa hata HANGİ anahtarın gerektiğini söyler ve sır sızdırmaz", () => {
  assert.throws(
    () => geminiIstemcisi(env()),
    (e) => {
      assert.match(e.message, /AEGIS_GEMINI_API_KEY/u, "eksik değişken adıyla söylenmeli");
      assert.match(e.message, /aistudio\.google\.com/u, "nereden alınacağı söylenmeli");
      assert.match(e.message, /AEGIS_BRAIN_PROVIDER=anthropic/u, "diğer yol da hatırlatılmalı");
      return true;
    }
  );
});

test("GEMINI_API_KEY de kabul edilir (Google'ın yaygın adı)", () => {
  assert.doesNotThrow(() => geminiIstemcisi(env({ GEMINI_API_KEY: "k" })));
});

/* ── Uyarlayıcının teldeki davranışı ──────────────────────────────────────────── */

/** Gemini yanıtı taklit eden fetch; giden isteği kaydeder. */
function geminiYaniti(govde, { ok = true, durum = 200 } = {}) {
  const kayit = { url: "", basliklar: {}, govde: null };
  globalThis.fetch = async (u, init) => {
    kayit.url = String(u);
    kayit.basliklar = init?.headers ?? {};
    kayit.govde = JSON.parse(String(init?.body ?? "{}"));
    return { ok, status: durum, text: async () => JSON.stringify(govde) };
  };
  return kayit;
}

test("KRİTİK: API anahtarı BAŞLIKTA taşınır, URL'de değil", async () => {
  /**
   * URL'ler günlüklere, proxy kayıtlarına ve hata izlerine düşer. Anahtarı sorgu
   * dizesine koymak, onu bu üçüne birden yazmak demektir.
   */
  const kayit = geminiYaniti({
    candidates: [{ content: { parts: [{ text: "merhaba" }] }, finishReason: "STOP" }],
  });
  await metinUret(geminiIstemcisi(env({ AEGIS_GEMINI_API_KEY: "gizli-anahtar-123" })), {
    sistem: "s",
    kullanici: "k",
  });
  globalThis.fetch = gercekFetch;

  assert.doesNotMatch(kayit.url, /gizli-anahtar-123/u, "KRİTİK: anahtar URL'de görünmemeli");
  assert.equal(kayit.basliklar["x-goog-api-key"], "gizli-anahtar-123", "anahtar başlıkta taşınmalı");
});

test("sistem istemi systemInstruction'a, kullanıcı istemi contents'e gider", async () => {
  const kayit = geminiYaniti({
    candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }],
  });
  await metinUret(geminiIstemcisi(env({ AEGIS_GEMINI_API_KEY: "k" })), {
    sistem: "SISTEM METNI",
    kullanici: "KULLANICI METNI",
  });
  globalThis.fetch = gercekFetch;

  assert.equal(kayit.govde.systemInstruction.parts[0].text, "SISTEM METNI", "güven sınırı korunmalı");
  assert.equal(kayit.govde.contents[0].parts[0].text, "KULLANICI METNI");
  assert.equal(kayit.govde.contents[0].role, "user");
});

test("KRİTİK stop_reason eşlemesi: YALNIZ STOP end_turn olur", async () => {
  /**
   * jsonUret `stop_reason !== "end_turn"` ile kapalı arızaya düşer. Tanınmayan bir
   * bitiş sebebini "end_turn" saymak, kesilmiş ya da engellenmiş bir yanıtı TAM
   * saymak olurdu — kapalı arızanın tam tersi.
   */
  const istemci = geminiIstemcisi(env({ AEGIS_GEMINI_API_KEY: "k" }));
  const olc = async (finishReason) => {
    geminiYaniti({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason }] });
    const y = await istemci.messages.create({ model: "x", messages: [] });
    return y.stop_reason;
  };
  assert.equal(await olc("STOP"), "end_turn");
  assert.equal(await olc("MAX_TOKENS"), "max_tokens");
  for (const sebep of ["SAFETY", "RECITATION", "OTHER", "BILINMEYEN_YENI_SEBEP", undefined, ""]) {
    const g = await olc(sebep);
    assert.notEqual(g, "end_turn", sebep + " tam yanıt sayılmamalı (gelen: " + g + ")");
  }
  globalThis.fetch = gercekFetch;
});

test("KRİTİK: istem düzeyinde engellenen yanıt end_turn olmaz", async () => {
  geminiYaniti({ promptFeedback: { blockReason: "SAFETY" } });
  const y = await geminiIstemcisi(env({ AEGIS_GEMINI_API_KEY: "k" })).messages.create({
    model: "x",
    messages: [],
  });
  globalThis.fetch = gercekFetch;

  assert.notEqual(y.stop_reason, "end_turn", "engellenen istem tam yanıt sayılmamalı");
  assert.match(y.stop_reason, /engellendi/u, "sebep kaybolmamalı");
  assert.deepEqual(y.content, [], "içerik boş olmalı");
});

test("KRİTİK: kapalı arıza Gemini yolunda da koşuyor (jsonUret max_tokens reddeder)", async () => {
  /**
   * Asıl iddia: kapılar sağlayıcıdan bağımsız. Kırpılmış ama PARSE OLABİLEN bir JSON,
   * Gemini üzerinden de geçmemeli.
   */
  geminiYaniti({
    candidates: [{ content: { parts: [{ text: '{"a":1}' }] }, finishReason: "MAX_TOKENS" }],
  });
  await assert.rejects(
    () =>
      jsonUret(geminiIstemcisi(env({ AEGIS_GEMINI_API_KEY: "k" })), {
        sistem: "s",
        kullanici: "k",
        sema: { a: "number" },
      }),
    /geçerli JSON alınamadı/u,
    "kırpılmış çıktı parse olabilse bile reddedilmeli"
  );
  globalThis.fetch = gercekFetch;
});

test("KRİTİK: şema doğrulaması Gemini yolunda da koşuyor", async () => {
  geminiYaniti({
    candidates: [{ content: { parts: [{ text: '{"a":"metin"}' }] }, finishReason: "STOP" }],
  });
  await assert.rejects(
    () =>
      jsonUret(geminiIstemcisi(env({ AEGIS_GEMINI_API_KEY: "k" })), {
        sistem: "s",
        kullanici: "k",
        sema: { a: "number" },
      }),
    /geçerli JSON alınamadı/u,
    "şema ihlali sağlayıcıdan bağımsız reddedilmeli"
  );
  globalThis.fetch = gercekFetch;
});

test("Gemini yolunda geçerli JSON normal döner (kapı her şeyi reddetmiyor)", async () => {
  const citli = "```json\n{\"a\":7}\n```";
  geminiYaniti({ candidates: [{ content: { parts: [{ text: citli }] }, finishReason: "STOP" }] });
  const n = await jsonUret(geminiIstemcisi(env({ AEGIS_GEMINI_API_KEY: "k" })), {
    sistem: "s",
    kullanici: "k",
    sema: { a: "number" },
  });
  globalThis.fetch = gercekFetch;
  assert.deepEqual(n, { a: 7 }, "çit sıyırma Gemini yolunda da çalışmalı");
});

test("HTTP hatası ajana ham gövde dökmez", async () => {
  geminiYaniti({ error: { message: "x".repeat(5000) } }, { ok: false, durum: 400 });
  await assert.rejects(
    () => geminiIstemcisi(env({ AEGIS_GEMINI_API_KEY: "k" })).messages.create({ model: "x", messages: [] }),
    (e) => {
      assert.match(e.message, /Gemini API 400/u);
      assert.ok(e.message.length < 400, "hata metni kısaltılmalı (uzunluk: " + e.message.length + ")");
      return true;
    }
  );
  globalThis.fetch = gercekFetch;
});
