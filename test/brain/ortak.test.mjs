// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ortak.mjs testleri — TAMAMEN AĞSIZ.
 * Gerçek Anthropic/MCP bağlantısı YASAK: tüm testler sahte istemcilerle çalışır.
 * mcpBaglan() burada hiç çağrılmaz (süreç başlatırdı); mantığı cagirSarmala
 * üzerinden sahte MCP istemcisiyle doğrulanır.
 */
import test from "node:test";
import assert from "node:assert/strict";

// BRAIN_MODEL varsayılanını deterministik test edebilmek için modül, env
// temizlendikten SONRA yüklenir (modül sabiti yükleme anında hesaplanır).
delete process.env.ADSPILOT_BRAIN_MODEL;
const {
  BRAIN_MODEL,
  SONUC_TAVANI,
  KIRPMA_ISARETI,
  anthropicIstemci,
  metinUret,
  jsonUret,
  semaDogrula,
  fallbackSiniriUygula,
  sonucKirp,
  cagirSarmala,
} = await import("../../scripts/brain/ortak.mjs");

/* ── sahteler ──────────────────────────────────────────────────────────────── */

/** Sırayla verilen yanıtları döndüren sahte Anthropic istemcisi (ağsız). */
function sahteAnthropic(yanitlar) {
  const cagrilar = [];
  return {
    cagrilar,
    messages: {
      async create(istek) {
        cagrilar.push(istek);
        return yanitlar[Math.min(cagrilar.length - 1, yanitlar.length - 1)];
      },
    },
  };
}

function metinYaniti(metin, stop = "end_turn") {
  return { stop_reason: stop, content: [{ type: "text", text: metin }] };
}

/** Sahte MCP istemcisi: callTool çağrılarını kaydeder, verilen yanıtı döndürür. */
function sahteMcp(yanit, { closeHata } = {}) {
  const kayitlar = [];
  return {
    kayitlar,
    async callTool(istek) {
      kayitlar.push(istek);
      return typeof yanit === "function" ? yanit(istek) : yanit;
    },
    async close() {
      if (closeHata) throw new Error("kapanış patladı");
    },
  };
}

/* ── sabitler ──────────────────────────────────────────────────────────────── */

test("BRAIN_MODEL: env yokken varsayılan claude-sonnet-5", () => {
  assert.equal(BRAIN_MODEL, "claude-sonnet-5");
});

test("SONUC_TAVANI 30000'dir", () => {
  assert.equal(SONUC_TAVANI, 30_000);
});

/* ── anthropicIstemci ──────────────────────────────────────────────────────── */

test("anthropicIstemci: anahtar yokken Türkçe, env-tarifli, sır sızdırmayan hata", () => {
  const eski = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    assert.throws(
      () => anthropicIstemci(),
      (e) => {
        assert.match(e.message, /ANTHROPIC_API_KEY/);
        assert.match(e.message, /ortam değişkeni/);
        // düzeltme CLI argümanı olarak önerilmez
        assert.doesNotMatch(e.message, /--api|argüman(ı)? olarak ver(?!me)/i);
        return true;
      }
    );
    process.env.ANTHROPIC_API_KEY = "   ";
    assert.throws(() => anthropicIstemci(), /ANTHROPIC_API_KEY/);
  } finally {
    if (eski === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = eski;
  }
});

test("anthropicIstemci: anahtar varken istemci döner (ağ çağrısı yapılmaz)", () => {
  const eski = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = "test-anahtari-gercek-degil";
    const istemci = anthropicIstemci();
    assert.ok(istemci && typeof istemci.messages?.create === "function");
  } finally {
    if (eski === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = eski;
  }
});

/* ── fallbackSiniriUygula ──────────────────────────────────────────────────── */

test("fallbackSiniriUygula: fallback yoksa içerik değişmez", () => {
  const icerik = [{ type: "text", text: "a" }, { type: "tool_use" }];
  assert.deepEqual(fallbackSiniriUygula(icerik), icerik);
});

test("fallbackSiniriUygula: ön-çıktı fallback (ilk blok) içerik değişmez", () => {
  const icerik = [{ type: "fallback" }, { type: "tool_use" }, { type: "text", text: "a" }];
  assert.deepEqual(fallbackSiniriUygula(icerik), icerik);
});

test("fallbackSiniriUygula: orta-çıktı fallback öncesi thinking/tool_use atılır, text kalır", () => {
  const icerik = [
    { type: "thinking" },
    { type: "text", text: "a" },
    { type: "tool_use" },
    { type: "fallback" },
    { type: "text", text: "b" },
  ];
  const sonuc = fallbackSiniriUygula(icerik);
  assert.deepEqual(
    sonuc.map((b) => b.type),
    ["text", "fallback", "text"]
  );
});

/* ── metinUret ─────────────────────────────────────────────────────────────── */

test("metinUret: normal durumda ilkel string döner, istek doğru kurulur", async () => {
  const sahte = sahteAnthropic([metinYaniti("merhaba dünya")]);
  const sonuc = await metinUret(sahte, { sistem: "sistem metni", kullanici: "soru", maxTokens: 123 });
  assert.equal(typeof sonuc, "string");
  assert.equal(sonuc, "merhaba dünya");
  assert.equal(sonuc.kirpik, undefined);
  const istek = sahte.cagrilar[0];
  assert.equal(istek.model, BRAIN_MODEL);
  assert.equal(istek.system, "sistem metni");
  assert.equal(istek.max_tokens, 123);
  assert.deepEqual(istek.messages, [{ role: "user", content: "soru" }]);
});

test("metinUret: max_tokens'ta dönen değer kirpik:true işareti taşır", async () => {
  const sahte = sahteAnthropic([metinYaniti("yarım metin", "max_tokens")]);
  const sonuc = await metinUret(sahte, { sistem: "s", kullanici: "k" });
  assert.equal(sonuc.kirpik, true);
  assert.equal(String(sonuc), "yarım metin");
});

test("metinUret: fallback sınırı yanıt içeriğine uygulanır", async () => {
  const sahte = sahteAnthropic([
    {
      stop_reason: "end_turn",
      content: [{ type: "tool_use" }, { type: "fallback" }, { type: "text", text: "son" }],
    },
  ]);
  const sonuc = await metinUret(sahte, { sistem: "s", kullanici: "k" });
  assert.equal(sonuc, "son");
});

/* ── semaDogrula ───────────────────────────────────────────────────────────── */

test("semaDogrula: geçerli nesne null döner", () => {
  const sema = { ad: "string", sayi: "number", liste: "array", nesne: "object", bayrak: "boolean" };
  assert.equal(
    semaDogrula({ ad: "x", sayi: 1.5, liste: [], nesne: {}, bayrak: true }, sema),
    null
  );
});

test("semaDogrula: kök dizi/ilkel/null reddedilir", () => {
  assert.match(semaDogrula([], {}), /nesnesi değil/);
  assert.match(semaDogrula("metin", {}), /nesnesi değil/);
  assert.match(semaDogrula(null, {}), /nesnesi değil/);
});

test("semaDogrula: eksik zorunlu alan ve yanlış tür Türkçe hata verir", () => {
  assert.match(semaDogrula({}, { ad: "string" }), /'ad' alanı eksik/);
  assert.match(semaDogrula({ sayi: "5" }, { sayi: "number" }), /'sayi' alanı 'number' olmalı/);
  assert.match(semaDogrula({ liste: {} }, { liste: "array" }), /'liste' alanı 'array' olmalı/);
  assert.match(semaDogrula({ nesne: [] }, { nesne: "object" }), /'nesne' alanı 'object' olmalı/);
});

test("semaDogrula: isteğe bağlı alan ('?') yokken geçer, varsa türü denetlenir", () => {
  assert.equal(semaDogrula({}, { yol1: "string?" }), null);
  assert.match(semaDogrula({ yol1: 5 }, { yol1: "string?" }), /'yol1' alanı 'string' olmalı/);
});

/* ── jsonUret ──────────────────────────────────────────────────────────────── */

test("jsonUret: kod çiti ve açıklama cümlesi sıyrılır, şema geçer", async () => {
  const sahte = sahteAnthropic([
    metinYaniti('İşte istediğin JSON:\n```json\n{"ad":"x","sayi":3}\n```\nBaşka bir şey lazım mı?'),
  ]);
  const sonuc = await jsonUret(sahte, {
    sistem: "s",
    kullanici: "k",
    sema: { ad: "string", sayi: "number" },
  });
  assert.deepEqual(sonuc, { ad: "x", sayi: 3 });
  assert.equal(sahte.cagrilar.length, 1);
});

test("jsonUret: bozuk JSON'da 1 kez yeniden dener, düzeltme istemine hata+bozuk çıktı eklenir", async () => {
  const sahte = sahteAnthropic([metinYaniti("bozuk {{{"), metinYaniti('{"ad":"y"}')]);
  const sonuc = await jsonUret(sahte, { sistem: "s", kullanici: "asıl istem", sema: { ad: "string" } });
  assert.deepEqual(sonuc, { ad: "y" });
  assert.equal(sahte.cagrilar.length, 2);
  const duzeltmeIstemi = sahte.cagrilar[1].messages[0].content;
  assert.match(duzeltmeIstemi, /asıl istem/);
  assert.match(duzeltmeIstemi, /DÜZELTME/);
  assert.match(duzeltmeIstemi, /bozuk \{\{\{/); // bozuk çıktı geri beslenir
});

test("jsonUret: iki kez bozuksa Türkçe hata, mesajda en fazla 200 karakter model çıktısı", async () => {
  const uzunBozuk = "geçersiz ".repeat(100); // ~900 karakter, JSON değil
  const sahte = sahteAnthropic([metinYaniti(uzunBozuk)]);
  await assert.rejects(
    () => jsonUret(sahte, { sistem: "s", kullanici: "k", sema: { ad: "string" } }),
    (e) => {
      assert.match(e.message, /geçerli JSON alınamadı/);
      assert.match(e.message, /Model çıktısının başı/);
      // alıntı 200 karakteri aşmaz: uzun bozuk çıktının tamamı mesajda olamaz
      assert.ok(!e.message.includes(uzunBozuk));
      return true;
    }
  );
  assert.equal(sahte.cagrilar.length, 2);
});

test("jsonUret: stop_reason max_tokens ise PARSE EDİLEBİLİR JSON bile fail-closed reddedilir", async () => {
  const sahte = sahteAnthropic([metinYaniti('{"ad":"x"}', "max_tokens")]);
  await assert.rejects(
    () => jsonUret(sahte, { sistem: "s", kullanici: "k", sema: { ad: "string" } }),
    /max_tokens/
  );
  assert.equal(sahte.cagrilar.length, 2); // 1 deneme + 1 yeniden deneme, sonra hata
});

test("jsonUret: şema ihlalinde yeniden dener, düzelen ikinci yanıt kabul edilir", async () => {
  const sahte = sahteAnthropic([metinYaniti('{"sayi":"5"}'), metinYaniti('{"sayi":5}')]);
  const sonuc = await jsonUret(sahte, { sistem: "s", kullanici: "k", sema: { sayi: "number" } });
  assert.deepEqual(sonuc, { sayi: 5 });
  assert.equal(sahte.cagrilar.length, 2);
  assert.match(sahte.cagrilar[1].messages[0].content, /şema ihlali/);
});

/* ── sonucKirp ─────────────────────────────────────────────────────────────── */

test("sonucKirp: tavan altı ve tam tavan değişmez, üstü kırpılıp işaretlenir", () => {
  assert.equal(sonucKirp("kısa"), "kısa");
  const tamTavan = "x".repeat(SONUC_TAVANI);
  assert.equal(sonucKirp(tamTavan), tamTavan);
  const uzun = "y".repeat(SONUC_TAVANI + 5000);
  const kirpik = sonucKirp(uzun);
  assert.ok(kirpik.endsWith("\n" + KIRPMA_ISARETI));
  assert.equal(kirpik.length, SONUC_TAVANI + 1 + KIRPMA_ISARETI.length);
  assert.equal(sonucKirp(undefined), "");
});

/* ── cagirSarmala ──────────────────────────────────────────────────────────── */

test("cagir: 'confirm' anahtarı KOŞULSUZ silinir, girdi nesnesi mutasyona uğramaz", async () => {
  const mcp = sahteMcp({ content: [{ type: "text", text: "tamam" }] });
  const { cagir } = cagirSarmala(mcp);
  const args = { adGroupId: "1", keywords: ["a"], confirm: true };
  await cagir("add_keywords", args);
  const kayit = mcp.kayitlar[0];
  assert.equal(kayit.name, "add_keywords");
  assert.ok(!("confirm" in kayit.arguments));
  assert.deepEqual(kayit.arguments, { adGroupId: "1", keywords: ["a"] });
  assert.equal(args.confirm, true); // çağıranın nesnesi bozulmadı
});

test("cagir: args verilmezse boş argümanlarla çağırır", async () => {
  const mcp = sahteMcp({ content: [{ type: "text", text: "liste" }] });
  const { cagir } = cagirSarmala(mcp);
  await cagir("list_accounts");
  assert.deepEqual(mcp.kayitlar[0].arguments, {});
});

test("cagir: uzun sonuç 30000'de kırpılır ve KIRPMA_ISARETI eklenir", async () => {
  const mcp = sahteMcp({ content: [{ type: "text", text: "z".repeat(40_000) }] });
  const { cagir } = cagirSarmala(mcp);
  const sonuc = await cagir("run_gaql", { query: "SELECT 1" });
  assert.ok(sonuc.includes(KIRPMA_ISARETI));
  assert.equal(sonuc.length, SONUC_TAVANI + 1 + KIRPMA_ISARETI.length);
});

test("cagir: isError'lu yanıt metniyle birlikte HATA fırlatır (sessiz başarı yok)", async () => {
  const mcp = sahteMcp({ isError: true, content: [{ type: "text", text: "Reddedildi: test sebebi" }] });
  const { cagir } = cagirSarmala(mcp);
  await assert.rejects(() => cagir("create_search_campaign", {}), /Reddedildi: test sebebi/);
});

test("cagir: çoklu text blokları birleşir, text olmayan bloklar atlanır", async () => {
  const mcp = sahteMcp({
    content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }],
  });
  const { cagir } = cagirSarmala(mcp);
  assert.equal(await cagir("campaign_performance", {}), "a\nb");
});

test("cagir: boş içerik '(boş yanıt)' döner; boş araç adı Türkçe hata", async () => {
  const mcp = sahteMcp({ content: [] });
  const { cagir } = cagirSarmala(mcp);
  assert.equal(await cagir("list_accounts", {}), "(boş yanıt)");
  await assert.rejects(() => cagir("", {}), /Geçersiz araç adı/);
  await assert.rejects(() => cagir(undefined, {}), /Geçersiz araç adı/);
});

test("kapat: close hatası yutulur", async () => {
  const mcp = sahteMcp({ content: [] }, { closeHata: true });
  const { kapat } = cagirSarmala(mcp);
  await kapat(); // fırlatmamalı
});

/* ── kaynakOku ─────────────────────────────────────────────────────────────── */

test("kaynakOku: contents text blokları birleşir, text olmayanlar atlanır", async () => {
  const okumalar = [];
  const mcp = {
    async callTool() {
      throw new Error("kaynak okuma callTool kullanmamalı");
    },
    async readResource(istek) {
      okumalar.push(istek);
      return {
        contents: [
          { uri: istek.uri, mimeType: "application/json", text: '{"gunlukButceTavani":500}' },
          { uri: istek.uri, blob: "ikili-veri" },
        ],
      };
    },
    async close() {},
  };
  const { kaynakOku } = cagirSarmala(mcp);
  const sonuc = await kaynakOku("adspilot://accounts/1/limits");
  assert.equal(sonuc, '{"gunlukButceTavani":500}');
  assert.deepEqual(okumalar, [{ uri: "adspilot://accounts/1/limits" }]);
});

test("kaynakOku: uzun kaynak SONUC_TAVANI'nda kırpılır ve işaretlenir", async () => {
  const mcp = {
    async readResource() {
      return { contents: [{ text: "k".repeat(SONUC_TAVANI + 100) }] };
    },
    async close() {},
  };
  const { kaynakOku } = cagirSarmala(mcp);
  const sonuc = await kaynakOku("adspilot://accounts/1/limits");
  assert.ok(sonuc.endsWith(KIRPMA_ISARETI));
  assert.equal(sonuc.length, SONUC_TAVANI + 1 + KIRPMA_ISARETI.length);
});

test("kaynakOku: boş/geçersiz URI Türkçe hata verir", async () => {
  const { kaynakOku } = cagirSarmala({ async readResource() {}, async close() {} });
  await assert.rejects(() => kaynakOku(""), /Geçersiz kaynak URI/);
  await assert.rejects(() => kaynakOku(undefined), /Geçersiz kaynak URI/);
});
