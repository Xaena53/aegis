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
 */
import test from "node:test";
import assert from "node:assert/strict";

const gercekFetch = globalThis.fetch;

/** Modülü, istenen env ile TAZE yükler (sağlayıcı sabiti yükleme anında hesaplanır). */
async function modul(env = {}) {
  for (const k of [
    "ADSPILOT_BRAIN_PROVIDER",
    "ADSPILOT_BRAIN_MODEL",
    "ADSPILOT_GEMINI_API_KEY",
    "GEMINI_API_KEY",
    "ANTHROPIC_API_KEY",
  ]) {
    delete process.env[k];
  }
  Object.assign(process.env, env);
  return import("../../scripts/brain/ortak.mjs?v=" + Math.random());
}

test("varsayılan sağlayıcı GEMINI ve varsayılan model ona ait", async () => {
  const m = await modul();
  assert.equal(m.BRAIN_SAGLAYICI, "gemini", "teslim edilen ürün listedeki sağlayıcıyla koşmalı");
  assert.match(m.BRAIN_MODEL, /^gemini-/, "varsayılan model Gemini olmalı: " + m.BRAIN_MODEL);
});

test("anthropic seçilince varsayılan model de Claude'a döner", async () => {
  const m = await modul({ ADSPILOT_BRAIN_PROVIDER: "anthropic" });
  assert.equal(m.BRAIN_SAGLAYICI, "anthropic");
  assert.match(m.BRAIN_MODEL, /^claude-/, "sağlayıcı değişince varsayılan model de değişmeli");
});

test("ADSPILOT_BRAIN_MODEL her iki sağlayıcıyı da geçersiz kılar", async () => {
  const a = await modul({ ADSPILOT_BRAIN_MODEL: "elle-secilen" });
  assert.equal(a.BRAIN_MODEL, "elle-secilen");
  const b = await modul({ ADSPILOT_BRAIN_PROVIDER: "anthropic", ADSPILOT_BRAIN_MODEL: "elle-secilen" });
  assert.equal(b.BRAIN_MODEL, "elle-secilen");
});

test("KRİTİK: tanınmayan sağlayıcı SESSİZCE varsayılana düşmez", async () => {
  /**
   * Yazım hatası yapan operatör ("gemeni", "claude", "openai"), kullandığını sandığından
   * başka bir modelle koşmamalı. Sessiz düşüş, raporun hangi modelle üretildiği sorusunu
   * cevapsız bırakırdı.
   */
  const m = await modul({ ADSPILOT_BRAIN_PROVIDER: "gemeni" });
  assert.throws(() => m.beyinIstemcisi(), /tanınmadı/u, "yazım hatası açıkça reddedilmeli");
});

test("anahtar yoksa hata HANGİ anahtarın gerektiğini söyler ve sır sızdırmaz", async () => {
  const m = await modul();
  assert.throws(
    () => m.geminiIstemcisi(),
    (e) => {
      assert.match(e.message, /ADSPILOT_GEMINI_API_KEY/u, "eksik değişken adıyla söylenmeli");
      assert.match(e.message, /aistudio\.google\.com/u, "nereden alınacağı söylenmeli");
      assert.match(e.message, /ADSPILOT_BRAIN_PROVIDER=anthropic/u, "diğer yol da hatırlatılmalı");
      return true;
    }
  );
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
  const m = await modul({ ADSPILOT_GEMINI_API_KEY: "gizli-anahtar-123" });
  const kayit = geminiYaniti({
    candidates: [{ content: { parts: [{ text: "merhaba" }] }, finishReason: "STOP" }],
  });
  await m.metinUret(m.geminiIstemcisi(), { sistem: "s", kullanici: "k" });
  globalThis.fetch = gercekFetch;

  assert.doesNotMatch(kayit.url, /gizli-anahtar-123/u, "KRİTİK: anahtar URL'de görünmemeli");
  assert.equal(kayit.basliklar["x-goog-api-key"], "gizli-anahtar-123", "anahtar başlıkta taşınmalı");
});

test("sistem istemi systemInstruction'a, kullanıcı istemi contents'e gider", async () => {
  const m = await modul({ ADSPILOT_GEMINI_API_KEY: "k" });
  const kayit = geminiYaniti({
    candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }],
  });
  await m.metinUret(m.geminiIstemcisi(), { sistem: "SISTEM METNI", kullanici: "KULLANICI METNI" });
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
  const m = await modul({ ADSPILOT_GEMINI_API_KEY: "k" });
  const olc = async (finishReason) => {
    geminiYaniti({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason }] });
    const y = await m.geminiIstemcisi().messages.create({ model: "x", messages: [] });
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
  const m = await modul({ ADSPILOT_GEMINI_API_KEY: "k" });
  geminiYaniti({ promptFeedback: { blockReason: "SAFETY" } });
  const y = await m.geminiIstemcisi().messages.create({ model: "x", messages: [] });
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
  const m = await modul({ ADSPILOT_GEMINI_API_KEY: "k" });
  geminiYaniti({
    candidates: [{ content: { parts: [{ text: '{"a":1}' }] }, finishReason: "MAX_TOKENS" }],
  });
  await assert.rejects(
    () => m.jsonUret(m.geminiIstemcisi(), { sistem: "s", kullanici: "k", sema: { a: "number" } }),
    /geçerli JSON alınamadı/u,
    "kırpılmış çıktı parse olabilse bile reddedilmeli"
  );
  globalThis.fetch = gercekFetch;
});

test("KRİTİK: şema doğrulaması Gemini yolunda da koşuyor", async () => {
  const m = await modul({ ADSPILOT_GEMINI_API_KEY: "k" });
  geminiYaniti({
    candidates: [{ content: { parts: [{ text: '{"a":"metin"}' }] }, finishReason: "STOP" }],
  });
  await assert.rejects(
    () => m.jsonUret(m.geminiIstemcisi(), { sistem: "s", kullanici: "k", sema: { a: "number" } }),
    /geçerli JSON alınamadı/u,
    "şema ihlali sağlayıcıdan bağımsız reddedilmeli"
  );
  globalThis.fetch = gercekFetch;
});

test("Gemini yolunda geçerli JSON normal döner (kapı her şeyi reddetmiyor)", async () => {
  const m = await modul({ ADSPILOT_GEMINI_API_KEY: "k" });
  const citli = "```json\n{\"a\":7}\n```";
  geminiYaniti({ candidates: [{ content: { parts: [{ text: citli }] }, finishReason: "STOP" }] });
  const n = await m.jsonUret(m.geminiIstemcisi(), { sistem: "s", kullanici: "k", sema: { a: "number" } });
  globalThis.fetch = gercekFetch;
  assert.deepEqual(n, { a: 7 }, "çit sıyırma Gemini yolunda da çalışmalı");
});

test("HTTP hatası ajana ham gövde dökmez", async () => {
  const m = await modul({ ADSPILOT_GEMINI_API_KEY: "k" });
  geminiYaniti({ error: { message: "x".repeat(5000) } }, { ok: false, durum: 400 });
  await assert.rejects(
    () => m.geminiIstemcisi().messages.create({ model: "x", messages: [] }),
    (e) => {
      assert.match(e.message, /Gemini API 400/u);
      assert.ok(e.message.length < 400, "hata metni kısaltılmalı (uzunluk: " + e.message.length + ")");
      return true;
    }
  );
  globalThis.fetch = gercekFetch;
});
