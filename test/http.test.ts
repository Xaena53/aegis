import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Hosted HTTP layer — where multi-tenant isolation is enforced.
 *
 * A real server process is started and driven over the wire, because http.ts is an
 * entry point rather than an importable module. Google credentials are fake: nothing
 * here reaches Google, only the auth, session, rate-limit and OAuth-state gates.
 */

const PORT = 8800 + (process.pid % 500);
const BASE = `http://localhost:${PORT}`;
const DB = join(tmpdir(), `aegis-http-${process.pid}.db`);
const MASTER = "a".repeat(64); // 64 hex chars → used directly as the key
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
      AEGIS_PUBLIC_URL: BASE,
      AEGIS_DB: DB,
      AEGIS_MASTER_KEY: MASTER,
      GOOGLE_ADS_DEVELOPER_TOKEN: "sahte-token",
      GOOGLE_ADS_CLIENT_ID: "sahte-client-id",
      GOOGLE_ADS_CLIENT_SECRET: "sahte-secret",
      AEGIS_RATE_PER_MINUTE: "8",
    },
    // stdio yutulmaz: sunucu başlangıçta düşerse SEBEBİNİ görmek gerekir. Yutulduğunda
    // her arıza aynı "ayağa kalkmadı" cümlesine dönüşüyordu ve gerçek neden kayboluyordu.
    stdio: ["ignore", "ignore", "pipe"],
  });

  let sunucuHatasi = "";
  sunucu.stderr?.on("data", (d) => {
    sunucuHatasi += String(d);
  });
  sunucu.once("exit", (kod) => {
    if (kod !== 0 && kod !== null) sunucuHatasi += `\n(süreç ${kod} koduyla çıktı)`;
  });

  /**
   * BEKLEME BÜTÇESİ: 10 sn değil 45 sn.
   *
   * Bu test dosyası TEK BAŞINA koşarken 10 saniye fazlasıyla yetiyordu; ama `npm test`
   * yirmiden fazla test dosyasını paralel koşuyor ve bu makinede sunucunun ayağa kalkması
   * o yük altında sınırı aşabiliyordu. Sonuç, ürün hatası olmadığı hâlde süitin yarı yarıya
   * kırmızı olması — ve gerçek bir regresyonu gürültüden ayıramaz hâle gelmemizdi.
   * Bütçeyi yüke göre değil, "gerçekten bozuksa yine de hızlı biter" ilkesine göre seçtik:
   * sağlıklı durumda ilk denemede döner, bozuk durumda 45 sn sonra SEBEBİYLE birlikte düşer.
   */
  const AZAMI_BEKLEME_MS = 45_000;
  const ADIM_MS = 100;
  for (let gecen = 0; gecen < AZAMI_BEKLEME_MS; gecen += ADIM_MS) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* not listening yet */
    }
    await bekle(ADIM_MS);
  }
  throw new Error(
    `sunucu ${AZAMI_BEKLEME_MS / 1000} saniyede ayağa kalkmadı` +
      (sunucuHatasi.trim() ? ` — sunucu stderr: ${sunucuHatasi.trim().slice(0, 400)}` : "")
  );
});

after(() => {
  sunucu?.kill();
  for (const ek of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB + ek, { force: true });
    } catch {
      /* file still locked on Windows */
    }
  }
});

/** Inserts a user straight into the store, bypassing the OAuth flow. */
async function kullaniciEkle(email: string, subject: string): Promise<string> {
  process.env.AEGIS_MASTER_KEY = MASTER;
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

  // B behaves as though it had stolen A's session id
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

/* ── TOPLU İSTEK (JSON-RPC batch) ─────────────────────────────────────────────
 *
 * JSON-RPC gövdesi bir DİZİ olabilir ve MCP taşıması her elemanı ayrı bir mesaj olarak
 * işler. Hız sınırı istek başına bir kez koştuğu sürece tek POST = 1 jeton = N araç
 * çağrısı demekti: paylaşılan Google/Meta kotası, operatörün CAMARA kotası ve bu süreç,
 * limitin hiç görmediği bir çarpanla tüketilebiliyordu. Hiçbir test /mcp'ye dizi
 * göndermediği için boşluk sessizdi.
 *
 * NOT: sunucu AEGIS_RATE_PER_MINUTE=8 ile koşuyor (bkz. before).
 * ─────────────────────────────────────────────────────────────────────────────── */

test("KRİTİK: toplu istek MESAJ BAŞINA jeton düşer (tek POST, N işlem değil)", async () => {
  const k = await kullaniciEkle("toplu@ornek.com", "sub-toplu");
  const dizi = Array.from({ length: 6 }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/list" }));

  const toplu = await mcp(k, dizi);
  assert.notEqual(toplu.status, 429, "6 mesaj 8'lik tavana sığmalı");

  // Kalan hak: 2. Üçüncü tekil istek 429 olmalı — jeton MESAJ başına düştüyse.
  const bir = await mcp(k, INIT);
  assert.notEqual(bir.status, 429);
  const iki = await mcp(k, INIT);
  assert.notEqual(iki.status, 429);
  const uc = await mcp(k, INIT);
  assert.equal(uc.status, 429, "6+2 jeton tükendi: dizi tek jetona sayılmış olamaz");
  assert.match(JSON.stringify(await uc.json()), /rate_limited/);
});

test("KRİTİK: tavanı aşan toplu istek HİÇ koşturulmaz (kısmi uygulama yok)", async () => {
  const k = await kullaniciEkle("buyuktoplu@ornek.com", "sub-buyuktoplu");
  const dizi = Array.from({ length: 200 }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/list" }));

  const r = await mcp(k, dizi);
  assert.equal(r.status, 429, "mesaj adedi tavanı aşıldığında istek reddedilmeli");
  assert.match(JSON.stringify(await r.json()), /batch_too_large/);

  // Reddedilen toplu istek kullanıcının kotasını da yakmamalı: sonraki istek geçer.
  const sonra = await mcp(k, INIT);
  assert.notEqual(sonra.status, 429, "reddedilen dizi jeton tüketmemeli");
});

test("OAuth: /connect imzalı state çerezi koyar ve önbelleklenmez", async () => {
  const r = await fetch(`${BASE}/connect`);
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie") ?? "";
  assert.match(cookie, /aegis_state=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(r.headers.get("cache-control") ?? "", /no-store/);
  assert.match(r.headers.get("referrer-policy") ?? "", /no-referrer/);
});

test("OAuth CSRF: çerezsiz ya da uydurma state ile callback 403", async () => {
  const connect = await fetch(`${BASE}/connect`);
  const state = /aegis_state=([^;]+)/.exec(connect.headers.get("set-cookie") ?? "")![1];

  // The attacker gets the victim to follow the link, but the victim's browser holds no cookie
  const cerezsiz = await fetch(`${BASE}/oauth/callback?code=x&state=${state}`, { redirect: "manual" });
  assert.equal(cerezsiz.status, 403);

  // A forged state whose signature does not verify
  const uydurma = await fetch(`${BASE}/oauth/callback?code=x&state=uydurma.1.abc`, {
    headers: { Cookie: "aegis_state=uydurma.1.abc" },
  });
  assert.equal(uydurma.status, 403);
});

/**
 * Guardrail management.
 *
 * The invariant: an agent can read its budget ceiling and write permission but never
 * change them. Reads go through MCP; writes require a human browser session.
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
  // The API key is the only credential an agent holds, so try it every possible way
  const bearer = await fetch(`${BASE}/settings`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(bearer.status, 401, "bearer ile ayar sayfası açılmamalı");

  const cerezOlarak = await fetch(`${BASE}/settings`, { headers: { Cookie: `aegis_session=${key}` } });
  assert.equal(cerezOlarak.status, 401, "API anahtarı oturum çerezi yerine geçmemeli");

  const post = await fetch(`${BASE}/settings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "tavan=99999",
  });
  assert.equal(post.status, 401);
});

test("uydurulmuş oturum çerezi imza doğrulamasına takılır", async () => {
  const sahte = await fetch(`${BASE}/settings`, { headers: { Cookie: "aegis_session=1.9999999999999.sahteimza" } });
  assert.equal(sahte.status, 401);
});

test("MCP tarafında kelepçe değiştiren HİÇBİR araç yok (yalnız okunur)", async () => {
  const key = await kullaniciEkle("araclar@ornek.com", "sub-araclar");
  const init = await mcp(key, INIT);
  const sid = init.headers.get("mcp-session-id")!;
  await mcp(key, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  const liste = await mcp(key, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
  const govde = await liste.text();

  // No tool name may even look like it changes a setting or a limit
  assert.doesNotMatch(govde, /"name":"[a-z_]*(settings|limit|cap|tavan)[a-z_]*"/i);
});

/** A signed session cookie identical to the server's own, standing in for a human browser. */
async function insanOturumu(userId: number): Promise<string> {
  const { createHmac } = await import("node:crypto");
  const ts = Date.now();
  const body = `${userId}.${ts}`;
  const mac = createHmac("sha256", MASTER).update(`oturum:${body}`).digest("base64url");
  return `aegis_session=${encodeURIComponent(`${body}.${mac}`)}`;
}

test("İNSAN oturumuyla ayar değişir ve MCP tarafına ANINDA yansır", async () => {
  process.env.AEGIS_MASTER_KEY = MASTER;
  const { UserStore } = await import("../src/store.js");
  const s = new UserStore(DB);
  const { apiKey, userId } = s.upsertUser({ subject: "sub-ayar", email: "ayar@ornek.com", refreshToken: "sahte" });
  s.close();

  const cookie = await insanOturumu(userId);

  // 1) The page loads and shows the current values
  const sayfa = await fetch(`${BASE}/settings`, { headers: { Cookie: cookie } });
  assert.equal(sayfa.status, 200);
  const html = await sayfa.text();
  assert.match(html, /ayar@ornek\.com/);
  assert.match(html, /değiştiremez/, "ajanın değiştiremeyeceği sayfada yazmalı");

  // 2) Lower the ceiling and switch writes off
  const kaydet = await fetch(`${BASE}/settings`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: "tavan=25", // 'yazma' is omitted → writes off
  });
  assert.equal(kaydet.status, 200);
  assert.match(await kaydet.text(), /yazma KAPALI/);

  /**
   * 3) The MCP side must observe the new setting immediately — no stale context.
   *
   * Ölçüm limits KAYNAĞINDAN değil, kelepçenin GERÇEKTEN uygulandığı yazma yolundan
   * alınıyor. Kaynak artık hesabın erişilebilirliğini kanıtlamadan kelepçe raporu
   * yayınlamıyor (doğrulanmamış bir hesap için "yazmaIzni: true, tavan: 500" demek
   * yetkili görünüşlü bir yalandı) ve bu testin kimlik bilgileri sahte, Google'a çıkış
   * yok. Yazma yolu ise Google'a hiç dokunmadan reddediyor: burada ölçülen şey ayarın
   * yansıması olmakla kalmıyor, ayarın UYGULANDIĞI da oluyor.
   */
  const init = await mcp(apiKey, INIT);
  const sid = init.headers.get("mcp-session-id")!;
  await mcp(apiKey, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  const kampanyaCagrisi = (id: number, dailyBudget: number) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "create_search_campaign",
      arguments: { customerId: "1466231519", name: "T", dailyBudget, keywords: ["a"], countryCodes: ["TR"] },
    },
  });

  const yazmaKapali = await mcp(apiKey, kampanyaCagrisi(5, 10), sid);
  assert.match(await yazmaKapali.text(), /devre dışı/, "yazma kapatması MCP'ye ANINDA yansımalı");

  // Yazmayı aç, tavanı 25'te bırak: tavanın da yansıdığı reddin METNİNDEN okunuyor.
  const acik = await fetch(`${BASE}/settings`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: "tavan=25&yazma=1",
  });
  assert.equal(acik.status, 200);
  const tavanUstu = await mcp(apiKey, kampanyaCagrisi(6, 30), sid);
  const ret = await tavanUstu.text();
  assert.match(ret, /güvenlik tavanının \(25\)/, "yeni tavan MCP'ye yansımalı");
  assert.doesNotMatch(ret, /\(500\)/, "eski/varsayılan tavan servis edilmemeli");
});

test("KRİTİK CSRF: çapraz-site ayar gönderimi 403 ve kelepçeyi DEĞİŞTİRMEZ", async () => {
  /**
   * Ayarlar sayfası kelepçenin tek gevşetme noktası: yazma anahtarı ve günlük tavan
   * buradan değişir. Oturum çerezi tarayıcı tarafından her isteğe eklendiği için, kapı
   * yalnız "oturum var mı" diye sorsaydı, kurbanın açık sekmesi varken ziyaret ettiği
   * herhangi bir sayfa gizli bir formla tavanı 50'den yüz binlere çıkarabilirdi.
   *
   * Bu kapı yazılmıştı ama BEKÇİSİZDİ: ölçüldü, iki satır da silindiğinde takım yeşil
   * kalıyordu. Aşağıda üç vaka ayrı ayrı çivileniyor ve her birinde tavanın GERÇEKTEN
   * değişmediği okunarak doğrulanıyor — durum kodu tek başına yeterli kanıt değil.
   */
  process.env.AEGIS_MASTER_KEY = MASTER;
  const { UserStore } = await import("../src/store.js");
  const s2 = new UserStore(DB);
  const { userId } = s2.upsertUser({ subject: "sub-csrf", email: "csrf@ornek.com", refreshToken: "sahte" });
  s2.close();
  const cookie = await insanOturumu(userId);

  const tavani = async (): Promise<string> => {
    const r = await fetch(`${BASE}/settings`, { headers: { Cookie: cookie } });
    const m = /name="tavan"[^>]*value="(\d+)"/.exec(await r.text());
    return m?.[1] ?? "(okunamadı)";
  };
  const once = await tavani();

  // 1) Yabancı Origin
  const yabanci = await fetch(`${BASE}/settings`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: "https://kotu.ornek" },
    body: "tavan=99999&yazma=1",
  });
  assert.equal(yabanci.status, 403, "yabancı origin reddedilmeli");
  assert.equal(await tavani(), once, "KRİTİK: reddedilen istek tavanı değiştirmemeli");

  // 2) Origin yok ama tarayıcı çapraz-site olduğunu söylüyor (klasik gizli form gönderimi)
  const caprazSite = await fetch(`${BASE}/settings`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
      "Sec-Fetch-Site": "cross-site",
    },
    body: "tavan=99999&yazma=1",
  });
  assert.equal(caprazSite.status, 403, "çapraz-site gönderim reddedilmeli");
  assert.equal(await tavani(), once, "KRİTİK: reddedilen istek tavanı değiştirmemeli");

  // 3) Aynı-site gönderim GEÇMELİ — kapı meşru kullanımı öldürmüyor.
  const mesru = await fetch(`${BASE}/settings`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
      "Sec-Fetch-Site": "same-origin",
    },
    body: "tavan=77&yazma=1",
  });
  assert.equal(mesru.status, 200, "aynı-site gönderim çalışmalı");
  assert.equal(await tavani(), "77", "meşru değişiklik uygulanmalı");
});

test("geçersiz tavan reddedilir (yazım hatası emniyeti)", async () => {
  process.env.AEGIS_MASTER_KEY = MASTER;
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

/**
 * BAŞLANGIÇ KAPISI: zayıf ana anahtarla süreç AYAĞA KALKMAZ.
 *
 * NEDEN: bu eşiğin (min 32 karakter) iki kopyası da — store.ts ve http.ts — silindiğinde
 * tüm test paketi yeşil kalıyordu. Eşik düşerse kısa bir parola sabit tuzla geçerli bir
 * AES anahtarı üretir ve DB dosyasını ele geçiren biri sözlük saldırısıyla tüm refresh
 * token'ları çözer. Ayrıca uzunluk artık KIRPILMIŞ değer üzerinde ölçülüyor: "30 karakter
 * + iki boşluk" eskiden bu kapıdan geçip ilk kullanıcıda patlıyordu, yani kapalı arıza
 * açılışta değil, sağlık yeşile döndükten SONRA gerçekleşiyordu.
 */
async function zayifAnahtarlaBaslat(anahtar: string): Promise<{ kod: number | null; stderr: string }> {
  const yalitikDB = join(tmpdir(), `aegis-zayif-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const p = spawn(process.execPath, ["--import", "tsx", "src/http.ts"], {
    // Port BİLEREK farklı: aynı portu kullansaydık EADDRINUSE de sıfırdan farklı kod
    // verirdi ve test, anahtar kapısı hiç koşmasa bile yeşil kalırdı.
    env: {
      ...process.env,
      PORT: String(PORT + 1),
      AEGIS_PUBLIC_URL: `http://localhost:${PORT + 1}`,
      AEGIS_DB: yalitikDB,
      AEGIS_MASTER_KEY: anahtar,
      GOOGLE_ADS_DEVELOPER_TOKEN: "sahte-token",
      GOOGLE_ADS_CLIENT_ID: "sahte-client-id",
      GOOGLE_ADS_CLIENT_SECRET: "sahte-secret",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  p.stderr?.on("data", (d) => {
    stderr += String(d);
  });
  const kod = await new Promise<number | null>((r) => {
    const zamanlayici = setTimeout(() => {
      p.kill();
      r(null); // ayakta kaldı = kapı geçirdi
    }, 20_000);
    p.once("exit", (c) => {
      clearTimeout(zamanlayici);
      r(c);
    });
  });
  for (const ek of ["", "-wal", "-shm"]) {
    try {
      rmSync(yalitikDB + ek, { force: true });
    } catch {
      /* file still locked on Windows */
    }
  }
  return { kod, stderr };
}

test("KRİTİK: ana anahtar veritabanını ÇÖZEMİYORSA süreç açılmaz", async () => {
  /**
   * Anahtar döndürüldüğünde ya da veritabanı başka bir kurulumdan geri yüklendiğinde,
   * eski açılış denetimi bunu göremiyordu: yalnız `encryptSecret` çağrılıyordu ve
   * ŞİFRELEMEK yanlış anahtarla da başarılıdır. Süreç sağlıkla ayağa kalkıyor, /health
   * yeşil yanıyor ve her kiracı ilk isteğinde sebebi yazmayan bir 500 alıyordu.
   *
   * Burada bir kullanıcı BİR anahtarla yazılıyor, süreç BAŞKA bir anahtarla açılıyor.
   * Beklenen: sıfırdan farklı çıkış kodu ve operatöre sebebi söyleyen bir mesaj.
   */
  const db = join(tmpdir(), `aegis-anahtar-${process.pid}.db`);
  rmSync(db, { force: true });
  process.env.AEGIS_MASTER_KEY = MASTER;
  const { UserStore } = await import("../src/store.js");
  const s2 = new UserStore(db);
  s2.upsertUser({ subject: "sub-anahtar", email: "anahtar@ornek.com", refreshToken: "gizli-jeton" });
  s2.close();

  const baskaAnahtar = "b".repeat(64);
  const cocuk = spawn(process.execPath, ["--import", "tsx", "src/http.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AEGIS_MASTER_KEY: baskaAnahtar,
      AEGIS_DB: db,
      AEGIS_PORT: String(PORT + 77),
      AEGIS_PUBLIC_URL: `http://localhost:${PORT + 77}`,
      /**
       * Kimlik bilgileri TESTİN KENDİSİNDEN gelir, geliştiricinin .env'inden değil.
       *
       * Sunucu açılışta önce yapılandırmayı doğrular, anahtar sınamasına ondan SONRA
       * gelir. Bunlar verilmediğinde süreç "Google Ads kimlik bilgileri eksik" ile
       * çıkıyor — yine sıfırdan farklı bir kodla, yani iddia geçiyor ama ÖLÇTÜĞÜ ŞEY
       * anahtar uyuşmazlığı değil, eksik yapılandırma oluyordu. Yerelde .env dosyası
       * bunları sağladığı için fark görünmüyordu; CI'da test "operatör sebebi görmeli"
       * ile kızardı ve asıl sebep buydu.
       */
      GOOGLE_ADS_DEVELOPER_TOKEN: "sahte-token",
      GOOGLE_ADS_CLIENT_ID: "sahte-client-id",
      GOOGLE_ADS_CLIENT_SECRET: "sahte-secret",
    },
  });
  let cikti = "";
  cocuk.stderr.on("data", (d) => (cikti += String(d)));
  cocuk.stdout.on("data", (d) => (cikti += String(d)));
  /**
   * SÜRE SINIRI ŞART: kapı kaldırıldığında süreç AÇILIR ve hiç çıkmaz, yani çıkışı
   * süresiz beklemek testi kızarmak yerine ASMAYA çevirir. Asılan test, kaldırılmış
   * bir kapıyı bildiremez — sonsuza kadar "henüz bitmedi" der. Zaman aşımı, "açıldı"
   * durumunu ölçülebilir bir başarısızlığa dönüştürür.
   */
  const kod: number = await new Promise((r) => {
    const sure = setTimeout(() => {
      cocuk.kill();
      r(0); // 0 = "çıkmadı, yani açıldı" → aşağıdaki notEqual iddiası kızarır
    }, 15_000);
    cocuk.on("exit", (c) => {
      clearTimeout(sure);
      r(c ?? -1);
    });
  });

  rmSync(db, { force: true });
  assert.notEqual(kod, 0, `KRİTİK: çözemediği veritabanıyla süreç açılmamalı (çıkış: ${kod})`);
  assert.match(cikti, /ÇÖZEMİYOR/, "operatör sebebi görmeli");
  assert.match(cikti, /döndürüldü|geri yüklendi/, "olası sebepler adıyla söylenmeli");
});

test("ZAYIF ANA ANAHTAR: 8 karakterlik anahtarla süreç sıfırdan farklı kodla çıkar", async () => {
  const { kod, stderr } = await zayifAnahtarlaBaslat("kisa1234");
  assert.notEqual(kod, 0, "zayıf anahtarla ayağa kalkmamalı");
  assert.notEqual(kod, null, "süreç ayakta kalmamalı — kapı geçirmiş demektir");
  assert.match(stderr, /AEGIS_MASTER_KEY/, "hangi değişkenin sorunlu olduğu söylenmeli");
  assert.doesNotMatch(stderr, /kisa1234/, "anahtarın kendisi loga yazılmamalı");
});

test("ZAYIF ANA ANAHTAR: boşlukla 32'ye tamamlanan anahtar da REDDEDİLİR", async () => {
  const { kod } = await zayifAnahtarlaBaslat(`  ${"k".repeat(30)}  `);
  assert.notEqual(kod, 0, "kırpılmış uzunluk 30 — eşik boşlukla atlatılamamalı");
  assert.notEqual(kod, null, "süreç ayakta kalmamalı");
});
