import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Q2 — hosted HTTP katmanı. Çok kiracılı izolasyonun tek kapısı burada;
 * gerçek bir sunucu süreci başlatılıp protokolün tamamı üzerinden test edilir
 * (http.ts bir betik olduğu için içeri import edilemez).
 *
 * Google kimlik bilgileri SAHTE: hiçbir test Google'a çıkmaz, yalnız kimlik
 * doğrulama / oturum / hız sınırı / OAuth-state kapıları sınanır.
 */

const PORT = 8800 + (process.pid % 500);
const BASE = `http://localhost:${PORT}`;
const DB = join(tmpdir(), `adspilot-http-${process.pid}.db`);
const MASTER = "a".repeat(64); // 64-hex → doğrudan anahtar
const KABUL = "application/json, text/event-stream";

let sunucu: ChildProcess;

async function bekle(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

before(async () => {
  sunucu = spawn(process.execPath, ["--import", "tsx", "src/http.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ADSPILOT_PUBLIC_URL: BASE,
      ADSPILOT_DB: DB,
      ADSPILOT_MASTER_KEY: MASTER,
      GOOGLE_ADS_DEVELOPER_TOKEN: "sahte-token",
      GOOGLE_ADS_CLIENT_ID: "sahte-client-id",
      GOOGLE_ADS_CLIENT_SECRET: "sahte-secret",
      ADSPILOT_RATE_PER_MINUTE: "8",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* henüz ayakta değil */
    }
    await bekle(100);
  }
  throw new Error("sunucu 10 saniyede ayağa kalkmadı");
});

after(() => {
  sunucu?.kill();
  for (const ek of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB + ek, { force: true });
    } catch {
      /* Windows kilidi */
    }
  }
});

/** Depoya doğrudan kullanıcı ekler (OAuth akışını taklit etmeden). */
async function kullaniciEkle(email: string, subject: string): Promise<string> {
  process.env.ADSPILOT_MASTER_KEY = MASTER;
  const { UserStore } = await import("../src/store.js");
  const s = new UserStore(DB);
  const { apiKey } = s.upsertUser({ subject, email, refreshToken: `sahte-${subject}` });
  s.close();
  return apiKey;
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

async function mcp(key: string, body: unknown, sid?: string) {
  return fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: KABUL,
      ...(sid ? { "mcp-session-id": sid } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("kimlik doğrulama: bearer yok → 401, geçersiz anahtar → 401", async () => {
  const yok = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: KABUL },
    body: JSON.stringify(INIT),
  });
  assert.equal(yok.status, 401);
  assert.match(yok.headers.get("www-authenticate") ?? "", /Bearer/);

  const sahte = await mcp("ap_hicvarolmayan", INIT);
  assert.equal(sahte.status, 401);
  assert.match(JSON.stringify(await sahte.json()), /invalid_api_key/);
});

test("KİRACI İZOLASYONU: başka kullanıcının oturumu 403 ile reddedilir", async () => {
  const a = await kullaniciEkle("a@ornek.com", "sub-a");
  const b = await kullaniciEkle("b@ornek.com", "sub-b");

  const acilis = await mcp(a, INIT);
  assert.equal(acilis.status, 200);
  const sid = acilis.headers.get("mcp-session-id")!;
  assert.ok(sid, "oturum kimliği dönmeli");

  // B, A'nın oturum kimliğini ele geçirmiş gibi davranır
  const kacirma = await mcp(b, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
  assert.equal(kacirma.status, 403);
  assert.match(JSON.stringify(await kacirma.json()), /session_owner_mismatch/);
});

test("bilinmeyen oturum kimliği → 404 (sessizce yeni sunucu kurulmaz)", async () => {
  const k = await kullaniciEkle("c@ornek.com", "sub-c");
  const r = await mcp(k, { jsonrpc: "2.0", id: 2, method: "tools/list" }, "00000000-0000-0000-0000-000000000000");
  assert.equal(r.status, 404);
  assert.match(JSON.stringify(await r.json()), /session_not_found/);
});

test("oturumsuz initialize-olmayan istek → 400", async () => {
  const k = await kullaniciEkle("d@ornek.com", "sub-d");
  const r = await mcp(k, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(await r.json()), /invalid_request/);
});

test("DNS rebinding: yabancı Origin reddedilir, doğru Origin geçer", async () => {
  const k = await kullaniciEkle("e@ornek.com", "sub-e");
  const kotu = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json", Accept: KABUL, Origin: "https://kotu-site.com" },
    body: JSON.stringify(INIT),
  });
  assert.equal(kotu.status, 403);

  const iyi = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json", Accept: KABUL, Origin: BASE },
    body: JSON.stringify(INIT),
  });
  assert.equal(iyi.status, 200);
});

test("hız sınırı: tavan aşılınca 429 + Retry-After", async () => {
  const k = await kullaniciEkle("f@ornek.com", "sub-f");
  let sonuncu: Response | undefined;
  for (let i = 0; i < 12; i++) sonuncu = await mcp(k, INIT);
  assert.equal(sonuncu!.status, 429, "8/dk tavanında 12. istek reddedilmeli");
  assert.ok(Number(sonuncu!.headers.get("retry-after")) > 0);
  assert.match(JSON.stringify(await sonuncu!.json()), /rate_limited/);
});

test("OAuth: /connect imzalı state çerezi koyar ve önbelleklenmez", async () => {
  const r = await fetch(`${BASE}/connect`);
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie") ?? "";
  assert.match(cookie, /adspilot_state=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(r.headers.get("cache-control") ?? "", /no-store/);
  assert.match(r.headers.get("referrer-policy") ?? "", /no-referrer/);
});

test("OAuth CSRF: çerezsiz ya da uydurma state ile callback 403", async () => {
  const connect = await fetch(`${BASE}/connect`);
  const state = /adspilot_state=([^;]+)/.exec(connect.headers.get("set-cookie") ?? "")![1];

  // Saldırgan kurbana linki tıklatır ama kurbanın tarayıcısında çerez yok
  const cerezsiz = await fetch(`${BASE}/oauth/callback?code=x&state=${state}`, { redirect: "manual" });
  assert.equal(cerezsiz.status, 403);

  // İmzası tutmayan uydurma state
  const uydurma = await fetch(`${BASE}/oauth/callback?code=x&state=uydurma.1.abc`, {
    headers: { Cookie: "adspilot_state=uydurma.1.abc" },
  });
  assert.equal(uydurma.status, 403);
});

/**
 * Q7 — KELEPÇE YÖNETİMİ.
 * Değişmez kural: ajan kendi bütçe tavanını/yazma iznini DEĞİŞTİREMEZ.
 * Okuma MCP'den (resource), yazma yalnız insan tarayıcı oturumundan.
 */
test("ayarlar sayfası oturumsuz erişime KAPALI", async () => {
  const get = await fetch(`${BASE}/settings`, { redirect: "manual" });
  assert.equal(get.status, 401);

  const post = await fetch(`${BASE}/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "tavan=99999&yazma=1",
  });
  assert.equal(post.status, 401, "oturumsuz POST ayar değiştirememeli");
});

test("API ANAHTARI ayar sayfasına giriş için KULLANILAMAZ (ajan kelepçeyi gevşetemez)", async () => {
  const key = await kullaniciEkle("kelepce@ornek.com", "sub-kelepce");
  // Ajanın elindeki tek kimlik API anahtarıdır; onu her yolla denesin
  const bearer = await fetch(`${BASE}/settings`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(bearer.status, 401, "bearer ile ayar sayfası açılmamalı");

  const cerezOlarak = await fetch(`${BASE}/settings`, { headers: { Cookie: `adspilot_session=${key}` } });
  assert.equal(cerezOlarak.status, 401, "API anahtarı oturum çerezi yerine geçmemeli");

  const post = await fetch(`${BASE}/settings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "tavan=99999",
  });
  assert.equal(post.status, 401);
});

test("uydurulmuş oturum çerezi imza doğrulamasına takılır", async () => {
  const sahte = await fetch(`${BASE}/settings`, { headers: { Cookie: "adspilot_session=1.9999999999999.sahteimza" } });
  assert.equal(sahte.status, 401);
});

test("MCP tarafında kelepçe değiştiren HİÇBİR araç yok (yalnız okunur)", async () => {
  const key = await kullaniciEkle("araclar@ornek.com", "sub-araclar");
  const init = await mcp(key, INIT);
  const sid = init.headers.get("mcp-session-id")!;
  await mcp(key, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  const liste = await mcp(key, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
  const govde = await liste.text();

  // Ayar/limit değiştirmeye benzeyen bir araç adı bulunmamalı
  assert.doesNotMatch(govde, /"name":"[a-z_]*(settings|limit|cap|tavan)[a-z_]*"/i);
});

/** Sunucunun ürettiğiyle aynı imzalı oturum çerezi (insan tarayıcısını taklit eder). */
async function insanOturumu(userId: number): Promise<string> {
  const { createHmac } = await import("node:crypto");
  const ts = Date.now();
  const body = `${userId}.${ts}`;
  const mac = createHmac("sha256", MASTER).update(`oturum:${body}`).digest("base64url");
  return `adspilot_session=${encodeURIComponent(`${body}.${mac}`)}`;
}

test("İNSAN oturumuyla ayar değişir ve MCP tarafına ANINDA yansır", async () => {
  process.env.ADSPILOT_MASTER_KEY = MASTER;
  const { UserStore } = await import("../src/store.js");
  const s = new UserStore(DB);
  const { apiKey, userId } = s.upsertUser({ subject: "sub-ayar", email: "ayar@ornek.com", refreshToken: "sahte" });
  s.close();

  const cookie = await insanOturumu(userId);

  // 1) Sayfa açılıyor ve mevcut değerleri gösteriyor
  const sayfa = await fetch(`${BASE}/settings`, { headers: { Cookie: cookie } });
  assert.equal(sayfa.status, 200);
  const html = await sayfa.text();
  assert.match(html, /ayar@ornek\.com/);
  assert.match(html, /değiştiremez/, "ajanın değiştiremeyeceği sayfada yazmalı");

  // 2) Tavanı düşür ve yazmayı kapat
  const kaydet = await fetch(`${BASE}/settings`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: "tavan=25", // 'yazma' gönderilmiyor → kapalı
  });
  assert.equal(kaydet.status, 200);
  assert.match(await kaydet.text(), /yazma KAPALI/);

  // 3) MCP tarafı yeni ayarı görüyor mu? (bayat context olmamalı)
  const init = await mcp(apiKey, INIT);
  const sid = init.headers.get("mcp-session-id")!;
  await mcp(apiKey, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  const kaynak = await mcp(
    apiKey,
    { jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: `adspilot://accounts/${1466231519}/limits` } },
    sid
  );
  const govde = await kaynak.text();
  assert.match(govde, /\\"gunlukButceTavani\\": 25|"gunlukButceTavani": 25/, "yeni tavan MCP'ye yansımalı");
  assert.match(govde, /\\"yazmaIzni\\": false|"yazmaIzni": false/, "yazma kapalı görünmeli");
});

test("geçersiz tavan reddedilir (yazım hatası emniyeti)", async () => {
  process.env.ADSPILOT_MASTER_KEY = MASTER;
  const { UserStore } = await import("../src/store.js");
  const s = new UserStore(DB);
  const { userId } = s.upsertUser({ subject: "sub-gecersiz", email: "gecersiz@ornek.com", refreshToken: "sahte" });
  s.close();
  const cookie = await insanOturumu(userId);

  for (const govde of ["tavan=0", "tavan=-5", "tavan=abc", "tavan=999999999"]) {
    const r = await fetch(`${BASE}/settings`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: govde,
    });
    assert.equal(r.status, 400, `${govde} kabul edilmemeli`);
  }
});

test("/health kimliksiz çalışır (izleme için)", async () => {
  const r = await fetch(`${BASE}/health`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});
