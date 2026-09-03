#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/*
 * AdsPilot — Google Ads MCP server (hosted mode)
 * Copyright (C) 2026 Xaena53 (github.com/Xaena53) and the AdsPilot contributors
 *
 * Distributed under the GNU Affero General Public License v3 — see LICENSE.
 * Per AGPL §13, the source is offered to the users of this service at /source.
 */
import "dotenv/config";
import http from "node:http";
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "./server.js";
import { AdsContext } from "./adsClient.js";
import { UserStore, encryptSecret, masterKeyText, type StoredUser } from "./store.js";
import { RateLimiter } from "./rateLimit.js";
import { lruYerAc, setRuntimeMode } from "./util.js";
import {
  duzMetinKarari,
  kiraciAnahtarDilimi,
  nacAnahtarDilimi,
  nacConfigFromEnv,
  parseBool,
  parseNumEnv,
} from "./config.js";

/**
 * AGPL-3.0 SECTION 13 COMPLIANCE.
 *
 * "Users interacting with the program over a network must be offered the Corresponding
 * Source." AdsPilot is a network service, so the obligation binds the OPERATOR — whoever
 * runs this server. The link is served in every page footer and at /source.
 *
 * This URL must genuinely resolve: running a publicly reachable service while the
 * repository is private violates the license.
 */
const SOURCE_URL = process.env.ADSPILOT_SOURCE_URL?.trim() || "https://github.com/Xaena53/google-ads-mcp";

const PORT = parseNumEnv("PORT", process.env.PORT, 8787);
const PUBLIC_URL = process.env.ADSPILOT_PUBLIC_URL?.trim() || `http://localhost:${PORT}`;

/**
 * Fail fast at startup. Configuration errors must surface before the process
 * reports itself healthy — otherwise /health returns ok, monitoring goes green, and
 * the first real user is the one who discovers the deployment is broken.
 */
function validateHostedEnv(): void {
  const eksik: string[] = [];
  for (const k of ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET"]) {
    if (!process.env[k]?.trim()) eksik.push(k);
  }
  /**
   * UZUNLUK KIRPILMIŞ DEĞER ÜZERİNDE ÖLÇÜLÜR. `mk.length` ham değere bakıyordu: 30
   * karakterlik bir anahtar + iki boşluk bu kapıdan geçiyor, sonra store.ts'in kendi
   * (kırpan) denetiminde ilk kullanıcıda patlıyordu — yani kapalı arıza AÇILIŞTA değil,
   * sağlık yeşile döndükten sonra gerçekleşiyordu.
   */
  const mk = process.env.ADSPILOT_MASTER_KEY?.trim() ?? "";
  if (mk.length < 32) eksik.push("ADSPILOT_MASTER_KEY (min 32 karakter)");
  if (eksik.length) {
    console.error(
      `[adspilot-http] BAŞLATILAMADI — eksik/geçersiz yapılandırma:\n  - ${eksik.join("\n  - ")}\n` +
        `Örnek için .env.example dosyasına bak. Anahtar üretmek için:\n` +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
    process.exit(1);
  }
  try {
    new URL(PUBLIC_URL);
  } catch {
    console.error(`[adspilot-http] BAŞLATILAMADI — ADSPILOT_PUBLIC_URL geçersiz: '${PUBLIC_URL}'`);
    process.exit(1);
  }
  if (!process.env.ADSPILOT_DB?.trim()) {
    console.error(
      "[adspilot-http] Bilgi: ADSPILOT_DB tanımsız — çalışma dizinindeki 'adspilot.db' kullanılacak."
    );
  }
}
validateHostedEnv();

const store = new UserStore();
// Exercise the encryption key immediately: a broken key must fail here, not on the first user.
try {
  encryptSecret("baslangic-dogrulamasi");
} catch (e: any) {
  console.error(`[adspilot-http] BAŞLATILAMADI — şifreleme anahtarı kullanılamıyor: ${e?.message ?? e}`);
  process.exit(1);
}

// ── Limits (guards against memory exhaustion) ────────────────────────────
const SESSION_IDLE_MS = 30 * 60_000; // idle sessions are dropped after 30 min
const OAUTH_STATE_TTL_MS = 10 * 60_000; // an OAuth state stays valid for 10 min
const MAX_SESSIONS = 1_000;
const MAX_SESSIONS_PER_USER = 10; // a single user must not drain the pool
const SWEEP_MS = 60_000;

// Per-user rate limit that protects the shared Google Ads quota
const limiter = new RateLimiter({
  // parseNumEnv is required: an empty env var gives Number("") === 0, which would 429 every request
  perMinute: parseNumEnv("ADSPILOT_RATE_PER_MINUTE", process.env.ADSPILOT_RATE_PER_MINUTE, 120),
  perDay: parseNumEnv("ADSPILOT_RATE_PER_DAY", process.env.ADSPILOT_RATE_PER_DAY, 2000),
});

// In hosted mode an error hint must say "reconnect", never "edit your .env"
setRuntimeMode("hosted", `${PUBLIC_URL}/connect`);

/**
 * Host/Origin allow list for DNS rebinding protection, as the MCP spec requires.
 * For local addresses the 127.0.0.1 and localhost variants are accepted together;
 * extra names come from ADSPILOT_ALLOWED_HOSTS as a comma-separated list, which is what
 * a deployment behind nginx or another proxy needs.
 */
function allowList(): { hosts: string[]; origins: string[] } {
  const pub = new URL(PUBLIC_URL);
  const hosts = new Set<string>([pub.host]);
  const origins = new Set<string>([pub.origin]);
  if (["localhost", "127.0.0.1", "[::1]"].includes(pub.hostname)) {
    for (const h of ["localhost", "127.0.0.1"]) {
      hosts.add(`${h}:${pub.port || PORT}`);
      origins.add(`${pub.protocol}//${h}:${pub.port || PORT}`);
    }
  }
  for (const extra of (process.env.ADSPILOT_ALLOWED_HOSTS ?? "").split(",")) {
    const t = extra.trim();
    if (t) {
      hosts.add(t);
      origins.add(`https://${t}`);
    }
  }
  return { hosts: [...hosts], origins: [...origins] };
}

/** The server's own OAuth client — in hosted mode every user shares it. */
function oauthClient() {
  const id = process.env.GOOGLE_ADS_CLIENT_ID;
  const secret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!id || !secret || !devToken) {
    throw new Error("Hosted mod için GOOGLE_ADS_CLIENT_ID/SECRET ve DEVELOPER_TOKEN zorunlu.");
  }
  return { id, secret, devToken };
}

/**
 * Contexts memoized per user settings. The cache key covers EVERY setting that is in
 * force, so any change — a refreshed token, writes switched off, a lowered ceiling —
 * produces a new context. Open sessions can never keep running against the old,
 * looser settings.
 */
const ctxCache = new Map<string, AdsContext>();

/** Bağlam önbelleği tavanı — aşıldığında en az kullanılan düşer (bkz. lruYerAc). */
const CTX_ONBELLEK_TAVANI = 500;

function contextFor(user: StoredUser): AdsContext {
  // Network-verification settings join the key: env is read once per process today,
  // but a future runtime reload must not keep serving up to 500 stale contexts.
  //
  // EVERY field of the slice belongs here, and the omission is silent and
  // one-directional: an operator who switches a trust-chain link ON keeps being served
  // cached contexts with it OFF, and believes a guard is running that never runs.
  // Adding a link to AgAyar means adding it to this key.
  // Ağ-doğrulama dilimi config.ts'ten gelir: orada saf ve import edilebilir olduğu için
  // "alan düşerse anahtar değişmiyor" durumu davranışsal olarak test edilebiliyor.
  const nac = nacConfigFromEnv();
  const key = [...kiraciAnahtarDilimi(user), ...nacAnahtarDilimi(nac)].join("|");
  let ctx = ctxCache.get(key);
  if (ctx) {
    // LRU tazeleme: erişilen kayıt sıranın sonuna taşınır (Map ekleme sırasını korur).
    ctxCache.delete(key);
    ctxCache.set(key, ctx);
  }
  if (!ctx) {
    const { id, secret, devToken } = oauthClient();
    ctx = new AdsContext({
      developerToken: devToken,
      clientId: id,
      clientSecret: secret,
      refreshToken: user.refreshToken,
      loginCustomerId: user.loginCustomerId,
      writeEnabled: user.writeEnabled,
      maxDailyBudget: user.maxDailyBudget,
      ...nac,
    });
    /**
     * TAVAN LRU'DUR, TOPTAN SİLME DEĞİL.
     *
     * Eski hâli `ctxCache.clear()` idi ve bu, tek bir kiracının davranışını BÜTÜN
     * kiracılara yayıyordu: ayarlarını arka arkaya değiştiren (ya da bunu bilerek yapan)
     * bir kiracı 500 farklı anahtar üretip herkesin AdsContext'ini — ve onlara asılı
     * 60 saniyelik hesap önbelleğini — düşürebiliyordu. Sonuç güvenlik ihlali değil ama
     * kiracı izolasyonunun ihlali: komşunun maliyeti sana ödetiliyordu.
     *
     * En eski kayıt Map'in ilk anahtarıdır; erişilen kayıt yukarıda sona taşındığı için
     * "en eski" gerçekten en az kullanılandır.
     */
    lruYerAc(ctxCache, CTX_ONBELLEK_TAVANI);
    ctxCache.set(key, ctx);
  }
  return ctx;
}

// ── Sessions: every MCP session belongs to exactly ONE user ───────────────
interface Session {
  transport: StreamableHTTPServerTransport;
  userId: number;
  /**
   * Shared box, refreshed from the database on every request. The tool context provider
   * reads this same object, so a settings change reaches sessions that are already open.
   */
  live: { user: StoredUser };
  lastSeen: number;
}
const sessions = new Map<string, Session>();

/** Sessions being established but not yet registered — closes the per-user cap race. */
const pendingSessions = new Map<number, number>();

/** Drops expired sessions and OAuth state (memory-exhaustion DoS protection). */
function sweep(): void {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.lastSeen > SESSION_IDLE_MS) {
      sessions.delete(sid);
      try {
        void s.transport.close();
      } catch {
        /* a failed close is harmless here */
      }
    }
  }
  limiter.sweep();
}

function sessionCountFor(userId: number): number {
  let n = 0;
  for (const s of sessions.values()) if (s.userId === userId) n++;
  return n;
}
setInterval(sweep, SWEEP_MS).unref();

function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function html(res: http.ServerResponse, status: number, body: string, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    // These pages can carry an API key: keep them out of caches and proxies, and out of the referrer
    "Cache-Control": "no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    ...extraHeaders,
  });
  res.end(body);
}

/** Every piece of external data embedded into HTML goes through here (XSS defense). */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
 :root{color-scheme:light dark}
 body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1.25rem;line-height:1.6}
 code,pre{background:rgba(127,127,127,.15);border-radius:6px}
 code{padding:.15em .4em} pre{padding:1rem;overflow-x:auto}
 a.btn{display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:.7rem 1.2rem;border-radius:8px;font-weight:600}
 .warn{border-left:4px solid #e8a31a;padding:.6rem 1rem;background:rgba(232,163,26,.12);border-radius:0 6px 6px 0}
 .ok{border-left:4px solid #1a9e4b;padding:.6rem 1rem;background:rgba(26,158,75,.12);border-radius:0 6px 6px 0}
 label{display:block;margin:.3rem 0} input[type=number]{padding:.5rem;border-radius:6px;border:1px solid rgba(127,127,127,.4);width:12rem}
 button{background:#1a73e8;color:#fff;border:0;padding:.7rem 1.4rem;border-radius:8px;font-weight:600;cursor:pointer}
 footer{margin-top:3rem;padding-top:1rem;border-top:1px solid rgba(127,127,127,.25);font-size:.85rem;opacity:.75}
</style></head><body>${inner}
<footer>AdsPilot — <a href="${SOURCE_URL}">kaynak kodu</a> ·
AGPL-3.0 lisanslıdır: bu servisi kullanan herkes kaynağa erişme hakkına sahiptir.</footer>
</body></html>`;
}

// ── OAuth: /connect → Google → /oauth/callback ────────────────────────────
/**
 * Binds the OAuth state to the BROWSER via a signed cookie. That closes two holes at once:
 *  1) There is no server-side `pendingStates` pool to fill up, so unauthenticated requests
 *     cannot flood it and make every new user get a 503.
 *  2) "the state matches" now also means "this browser produced it", which blocks login
 *     CSRF — an attacker binding their own Google account to the victim's browser, after
 *     which the victim's campaigns would be written into the attacker's account.
 */
function signState(nonce: string, ts: number): string {
  const body = `${nonce}.${ts}`;
  // HMAC ANAHTARI store.ts'in masterKeyText()'i üzerinden alınır, ham env'den DEĞİL.
  // Kırpma farkı burada bir arıza değildi (imzalama ve doğrulama aynı ifadeyi kullanıyordu);
  // kaldırılan şey eski `?? ""` yedeğiydi: anahtar yokken çerezler BOŞ DİZEYLE, yani
  // herkesin bilebileceği bir anahtarla imzalanırdı. Şimdi böyle bir durumda fırlar.
  // Bu yola bugün ulaşılamıyor (validateHostedEnv eksik anahtarda süreci açılışta öldürür);
  // yani bu bir kapı değil, kapının arkasındaki ikinci kilittir.
  const mac = createHmac("sha256", masterKeyText()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verifyState(value: string | undefined): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [nonce, tsRaw] = parts;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Date.now() - ts > OAUTH_STATE_TTL_MS) return false;
  const expected = signState(nonce, ts);
  const a = Buffer.from(expected);
  const b = Buffer.from(value);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Browser session for the settings page.
 *
 * Guardrails are readable over MCP but writable only here. The API key deliberately
 * does not open this door: the agent holds that key, so a key-protected settings page
 * would be no protection at all.
 */
const OTURUM_TTL_MS = 2 * 60 * 60_000; // 2 hours

function signSession(userId: number, ts: number): string {
  const body = `${userId}.${ts}`;
  // Anahtar kaynağı signState ile aynı gerekçeyle masterKeyText(): boş-anahtar yedeği yok.
  const mac = createHmac("sha256", masterKeyText()).update(`oturum:${body}`).digest("base64url");
  return `${body}.${mac}`;
}

function verifySession(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parts = value.split(".");
  if (parts.length !== 3) return undefined;
  const userId = Number(parts[0]);
  const ts = Number(parts[1]);
  if (!Number.isInteger(userId) || !Number.isFinite(ts) || Date.now() - ts > OTURUM_TTL_MS) return undefined;
  const beklenen = Buffer.from(signSession(userId, ts));
  const gelen = Buffer.from(value);
  return beklenen.length === gelen.length && timingSafeEqual(beklenen, gelen) ? userId : undefined;
}

function oturumCerezi(userId: number): string {
  const secure = PUBLIC_URL.startsWith("https://") ? "; Secure" : "";
  // SameSite=Strict so a settings change cannot be triggered from another site
  return `adspilot_session=${encodeURIComponent(signSession(userId, Date.now()))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${OTURUM_TTL_MS / 1000}${secure}`;
}

function readCookie(req: http.IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      // A malformed percent-escape (e.g. a bare "%") throws URIError. The cookie is
      // entirely attacker-controlled, so an unauthenticated request must not crash the server.
      try {
        return decodeURIComponent(v.join("="));
      } catch {
        return undefined; // an invalid cookie counts as no cookie
      }
    }
  }
  return undefined;
}

function handleConnect(res: http.ServerResponse) {
  const { id } = oauthClient();
  const state = signState(randomBytes(16).toString("hex"), Date.now());
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: id,
      redirect_uri: `${PUBLIC_URL}/oauth/callback`,
      response_type: "code",
      // openid is mandatory: without it Google returns no id_token and the identity cannot be resolved
      scope: "openid email https://www.googleapis.com/auth/adwords",
      access_type: "offline",
      prompt: "consent",
      state,
    });
  const secure = PUBLIC_URL.startsWith("https://") ? "; Secure" : "";
  html(
    res,
    200,
    page(
      "AdsPilot'a bağlan",
      `<h1>AdsPilot'a bağlan</h1>
       <p>Google Ads hesabını bağla; Claude reklamlarını senin adına yönetsin.
       Tüm yazma işlemleri <strong>duraklatılmış taslak</strong> olarak oluşur ve
       yayına almak için <strong>senin onayını</strong> ister.</p>
       <p><a class="btn" href="${url}">Google ile bağlan</a></p>`
    ),
    { "Set-Cookie": `adspilot_state=${encodeURIComponent(state)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure}` }
  );
}

async function handleCallback(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const state = url.searchParams.get("state") ?? "";
  const cookieState = readCookie(req, "adspilot_state");
  // The state must be signed and fresh AND match what this browser has in its cookie
  if (!verifyState(state) || cookieState !== state) {
    return html(
      res,
      403,
      page(
        "Geçersiz istek",
        "<h1>Geçersiz ya da süresi dolmuş bağlantı isteği</h1><p>Bu bağlantı bu tarayıcıda başlatılmamış ya da süresi dolmuş. <a href='/connect'>Baştan başla</a>.</p>"
      )
    );
  }
  const code = url.searchParams.get("code");
  if (!code) return html(res, 400, page("Hata", "<h1>Yetkilendirme iptal edildi</h1>"));

  const { id, secret } = oauthClient();
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: id,
      client_secret: secret,
      redirect_uri: `${PUBLIC_URL}/oauth/callback`,
      grant_type: "authorization_code",
    }),
  });
  const tokens: any = await tokenRes.json();
  if (!tokens.refresh_token) {
    return html(
      res,
      400,
      page("Hata", `<h1>Token alınamadı</h1><p>${esc(String(tokens.error_description ?? tokens.error ?? "bilinmeyen hata"))}</p>`)
    );
  }

  // Identity is the id_token's `sub` claim. No signature check is needed — the token came
  // straight from Google over TLS. `sub` is immutable; the email address is not.
  let subject: string | undefined;
  let email = "bilinmiyor";
  try {
    const payload = JSON.parse(Buffer.from(String(tokens.id_token).split(".")[1], "base64url").toString("utf8"));
    if (payload.sub) subject = String(payload.sub);
    if (payload.email) email = String(payload.email);
  } catch {
    /* handled by the fail-closed check below */
  }

  // FAIL CLOSED: never write a user into a SHARED row when the identity cannot be resolved.
  // Two different people would land on the same record, and one would silently invalidate
  // the other's API key and Google token.
  if (!subject) {
    return html(
      res,
      400,
      page(
        "Kimlik doğrulanamadı",
        `<h1>Kimlik doğrulanamadı</h1><p>Google hesabının kimliği alınamadı (id_token yok).
         İzin ekranında e-posta/kimlik iznini onayladığından emin olup
         <a href="/connect">yeniden dene</a>.</p>`
      )
    );
  }

  const { apiKey, userId } = store.upsertUser({ subject, email, refreshToken: tokens.refresh_token });
  const mcpUrl = `${PUBLIC_URL}/mcp`;
  html(
    res,
    200,
    page(
      "Bağlandı",
      `<h1>Bağlandı ✔</h1>
       <p><strong>${esc(email)}</strong> hesabın AdsPilot'a bağlandı.</p>
       <div class="warn"><strong>API anahtarın (yalnız bir kez gösterilir):</strong>
       <pre>${esc(apiKey)}</pre></div>
       <h2>Claude Code'a ekle</h2>
       <pre>claude mcp add --transport http adspilot ${mcpUrl} \\
  --header "Authorization: Bearer ${apiKey}"</pre>
       <p>Ardından Claude'a “Google Ads hesaplarımı listele” diyebilirsin.</p>
       <h2>Güvenlik kelepçelerin</h2>
       <p>Yazma iznini ve günlük bütçe tavanını <a href="/settings">ayarlar sayfasından</a> yönetebilirsin.
       Claude bu değerleri okuyabilir ama <strong>değiştiremez</strong>.</p>`
    ),
    // The human session: the settings page is guarded by this cookie, NOT by the API key
    { "Set-Cookie": oturumCerezi(userId) }
  );
}

// ── Settings (human session only) ─────────────────────────────────────────
const MUTLAK_BUTCE_TAVANI = 100_000; // backstop against a typo

function ayarSayfasi(user: StoredUser, mesaj?: { tur: "ok" | "hata"; metin: string }): string {
  const bildirim = mesaj
    ? `<p class="${mesaj.tur === "ok" ? "ok" : "warn"}">${esc(mesaj.metin)}</p>`
    : "";
  return page(
    "AdsPilot ayarları",
    `<h1>Güvenlik ayarların</h1>
     <p>Hesap: <strong>${esc(user.email)}</strong></p>
     ${bildirim}
     <div class="warn"><strong>Bu sayfa yalnız sana açıktır.</strong> Claude (ya da herhangi bir ajan)
     bu değerleri <em>okuyabilir</em> ama <em>değiştiremez</em> — kelepçeyi gevşetme yetkisi sadece sende.</div>
     <form method="POST" action="/settings">
       <p><label><input type="checkbox" name="yazma" value="1" ${user.writeEnabled ? "checked" : ""}>
       Yazma işlemlerine izin ver (kampanya kurma, bütçe, yayına alma)</label></p>
       <p><label>Günlük bütçe tavanı (hesap para biriminde)<br>
       <input type="number" name="tavan" min="1" max="${MUTLAK_BUTCE_TAVANI}" step="1" value="${user.maxDailyBudget}" required></label></p>
       <p><button type="submit">Kaydet</button></p>
     </form>
     <h2>Bu ayarlar ne yapar?</h2>
     <ul>
       <li><strong>Yazma kapalıysa</strong> ajan yalnız rapor okuyabilir; hiçbir kampanya değişikliği yapamaz.</li>
       <li><strong>Bütçe tavanı</strong> tek bir kampanyanın günlük bütçesinin üst sınırıdır. Tavanın üzerinde
       bütçeyle kampanya kurulamaz ve tavanı aşan bütçeli bir kampanya yayına alınamaz.</li>
       <li>Değişiklik <strong>anında</strong> geçerli olur — açık bir Claude oturumu varsa o da yeni ayarla çalışır.</li>
     </ul>`
  );
}

async function handleSettings(req: http.IncomingMessage, res: http.ServerResponse) {
  const userId = verifySession(readCookie(req, "adspilot_session"));
  if (!userId) {
    return html(
      res,
      401,
      page(
        "Giriş gerekli",
        `<h1>Giriş gerekli</h1><p>Ayarlarını görmek için Google hesabınla giriş yap.</p>
         <p><a class="btn" href="/connect">Google ile giriş yap</a></p>`
      )
    );
  }
  const user = store.findById(userId);
  if (!user) return html(res, 404, page("Bulunamadı", "<h1>Kullanıcı bulunamadı</h1>"));

  if (req.method === "GET") return html(res, 200, ayarSayfasi(user));

  if (req.method === "POST") {
    /**
     * CSRF: SameSite=Strict alone is NOT enough. SameSite works at registrable-domain
     * (eTLD+1) granularity, so on an adspilot.example.com deployment ANY subdomain of
     * example.com — the marketing site, a compromised legacy app — counts as same-site and
     * receives the cookie. An auto-submitted form from there could switch writes on and
     * raise the ceiling to its maximum, which is exactly where the "only a human can
     * loosen the guardrails" guarantee would break. Origin validation closes that path,
     * reusing the allow list that already exists.
     */
    const origin = req.headers.origin;
    if (origin && !allowList().origins.includes(origin)) {
      return html(res, 403, ayarSayfasi(user, { tur: "hata", metin: "İstek reddedildi: kaynak (origin) doğrulanamadı." }));
    }
    if (!origin && req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") {
      return html(res, 403, ayarSayfasi(user, { tur: "hata", metin: "İstek reddedildi: çapraz-site form gönderimi." }));
    }

    const govde = await new Promise<string>((resolve, reject) => {
      let veri = "";
      req.on("data", (c) => {
        veri += c;
        if (veri.length > 10_000) reject(new Error("gövde çok büyük"));
      });
      req.on("end", () => resolve(veri));
      req.on("error", reject);
    });
    const form = new URLSearchParams(govde);
    const tavan = Number(form.get("tavan"));
    if (!Number.isFinite(tavan) || tavan <= 0 || tavan > MUTLAK_BUTCE_TAVANI) {
      return html(res, 400, ayarSayfasi(user, { tur: "hata", metin: `Tavan 1 ile ${MUTLAK_BUTCE_TAVANI} arasında olmalı.` }));
    }
    const yazma = form.get("yazma") === "1";
    store.updateSettings(userId, { writeEnabled: yazma, maxDailyBudget: tavan });
    const guncel = store.findById(userId)!;
    return html(
      res,
      200,
      ayarSayfasi(guncel, {
        tur: "ok",
        metin: `Kaydedildi: yazma ${yazma ? "AÇIK" : "KAPALI"}, günlük bütçe tavanı ${tavan}. Açık oturumlar bir sonraki istekte bu ayarı kullanır.`,
      })
    );
  }
  return json(res, 405, { error: "method_not_allowed" });
}

// ── MCP endpoint ──────────────────────────────────────────────────────────
function bearerFrom(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return undefined;
  return h.slice(7).trim();
}

/**
 * TEK POST'TAKİ AZAMİ JSON-RPC MESAJI.
 *
 * JSON-RPC gövdesi bir DİZİ olabilir ve MCP taşıması dizinin her elemanını ayrı bir
 * mesaj olarak işler. Bayt tavanı bunu görmez: 4 MB'lık bir gövdeye on binlerce ufak
 * araç çağrısı sığar. Tavan bu yüzden bayt cinsinden değil, MESAJ cinsinden de olmak
 * zorundadır — ve aşıldığında istek kısmen koşturulmaz, hiç koşturulmaz (kapalı arıza:
 * yarısı uygulanmış bir toplu harcama isteği hiç uygulanmamış olandan çok daha zor
 * geri alınır).
 *
 * Değer, meşru istemcilerin bir turda gönderdiği mesaj sayısının çok üstündedir;
 * amaç kullanımı kısıtlamak değil, çarpanı kapatmaktır.
 */
const MAX_MCP_TOPLU_MESAJ = 20;

/** Gövdedeki JSON-RPC MESAJ adedi; dizi değilse tek mesaj sayılır. */
function mcpMesajAdedi(body: unknown): number {
  // Boş dizi de bir istektir: 0 jeton düşmek "bedava istek" kapısı açardı.
  return Array.isArray(body) ? Math.max(1, body.length) : 1;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4_000_000) throw new Error("İstek gövdesi çok büyük.");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
  const key = bearerFrom(req);
  if (!key) {
    res.writeHead(401, { "WWW-Authenticate": `Bearer realm="adspilot"`, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "unauthorized", hint: `API anahtarı için: ${PUBLIC_URL}/connect` }));
  }
  const user = store.findByApiKey(key);
  if (!user) return json(res, 401, { error: "invalid_api_key" });

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const session = sessionId ? sessions.get(sessionId) : undefined;

  // Session hijacking guard: refuse when the existing session belongs to another user
  if (session && session.userId !== user.id) return json(res, 403, { error: "session_owner_mismatch" });

  // Unknown or expired session id: the spec requires a 404 so the client re-initializes.
  // Quietly standing up a new server instead would let random session ids drive unbounded
  // object creation (DoS).
  if (sessionId && !session) {
    return json(res, 404, { error: "session_not_found", hint: "Oturum düştü — yeniden initialize et." });
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch (e: any) {
    return json(res, 400, { error: "bad_request", message: e?.message });
  }

  /**
   * HIZ SINIRI GÖVDEYİ OKUDUKTAN SONRA, MESAJ BAŞINA UYGULANIR.
   *
   * Kontrol eskiden gövdeden ÖNCE ve istek başına bir kez koşuyordu; JSON-RPC gövdesi
   * bir dizi olabildiği için tek POST = 1 jeton = N araç çağrısı demekti. Her çağrı
   * kendi ağ kapısını (CAMARA sorgusu), kendi denetim günlüğü satırını ve kendi upstream
   * kotasını tükettiği için limitin ölçtüğü şey ile korumaya çalıştığı şey birbirinden
   * kopmuştu. Artık jeton MESAJ başına düşülür; tavanı aşan toplu istek hiç koşturulmaz.
   *
   * Sıra bilinçli: ölçebilmek için gövdeyi okumak gerekir, ama gövde taşımaya
   * VERİLMEDEN önce ölçülür — yani reddedilen bir toplu istekte hiçbir mesaj işlenmez.
   */
  const mesajAdedi = mcpMesajAdedi(body);
  if (mesajAdedi > MAX_MCP_TOPLU_MESAJ) {
    res.writeHead(429, { "Content-Type": "application/json; charset=utf-8", "Retry-After": "1" });
    return res.end(
      JSON.stringify({
        error: "batch_too_large",
        message: `Tek istekte en fazla ${MAX_MCP_TOPLU_MESAJ} JSON-RPC mesajı gönderilebilir (gelen: ${mesajAdedi}).`,
      })
    );
  }
  // Per-user limit that protects both the shared Google Ads quota and this server
  const rl = limiter.check(user.id, mesajAdedi);
  if (!rl.allowed) {
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(rl.retryAfterSec ?? 60),
    });
    return res.end(JSON.stringify({ error: "rate_limited", message: rl.reason, retryAfterSec: rl.retryAfterSec }));
  }

  if (session) {
    // Re-read the user from the database on every request so settings never go stale
    session.live.user = store.findById(session.userId) ?? session.live.user;
    session.lastSeen = Date.now();
    return await session.transport.handleRequest(req, res, body);
  }

  // No session id → only an initialize request may open a new session
  if (!isInitializeRequest(body)) {
    return json(res, 400, { error: "invalid_request", hint: "Önce initialize çağır (mcp-session-id yok)." });
  }
  if (sessions.size >= MAX_SESSIONS) {
    sweep();
    if (sessions.size >= MAX_SESSIONS) return json(res, 503, { error: "too_many_sessions" });
  }
  // One user must not drain the session pool and lock everyone else out.
  // The slot is RESERVED synchronously: there is an `await` between the check and the
  // registration, so concurrent initialize requests would each see "0 sessions" and
  // sail past the cap together.
  if (sessionCountFor(user.id) + (pendingSessions.get(user.id) ?? 0) >= MAX_SESSIONS_PER_USER) {
    sweep();
    if (sessionCountFor(user.id) + (pendingSessions.get(user.id) ?? 0) >= MAX_SESSIONS_PER_USER) {
      return json(res, 429, {
        error: "too_many_sessions_for_user",
        hint: `Aynı anda en fazla ${MAX_SESSIONS_PER_USER} oturum açabilirsin; eskilerini kapat.`,
      });
    }
  }
  pendingSessions.set(user.id, (pendingSessions.get(user.id) ?? 0) + 1);

  // Shared box: the session record and the tool context provider both read it
  const live: { user: StoredUser } = { user };
  const { hosts, origins } = allowList();
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // MCP spec: Host/Origin validation against DNS rebinding
    enableDnsRebindingProtection: true,
    allowedHosts: hosts,
    allowedOrigins: origins,
    onsessioninitialized: (sid: string): void => {
      sessions.set(sid, { transport, userId: user.id, live, lastSeen: Date.now() });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  // The tools of this session only ever see this one user's CURRENT context
  try {
    const server = buildServer(() => contextFor(live.user));
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } finally {
    const n = (pendingSessions.get(user.id) ?? 1) - 1;
    if (n > 0) pendingSessions.set(user.id, n);
    else pendingSessions.delete(user.id);
  }
}

// ── Router ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", PUBLIC_URL);
    if (url.pathname === "/health") return json(res, 200, { ok: true, sessions: sessions.size });
    if (url.pathname === "/connect" && req.method === "GET") return handleConnect(res);
    // `await` is mandatory here: a rejection from an async function that is returned without
    // being awaited never reaches this try/catch. It escapes to the top level and kills the
    // process — a remote denial of service from a single unauthenticated request.
    if (url.pathname === "/oauth/callback" && req.method === "GET") return await handleCallback(req, res, url);
    if (url.pathname === "/settings") return await handleSettings(req, res);
    // AGPL §13: the source offer, kept machine-discoverable as well
    if (url.pathname === "/source") {
      res.writeHead(302, { Location: SOURCE_URL, "Cache-Control": "no-store" });
      return res.end();
    }
    if (url.pathname === "/mcp") return await handleMcp(req, res);
    if (url.pathname === "/")
      return html(res, 200, page("AdsPilot", `<h1>AdsPilot</h1><p>Google Ads MCP sunucusu. <a href="/connect">Hesabını bağla</a>.</p>`));
    json(res, 404, { error: "not_found" });
  } catch (e: any) {
    // Details go to the server log only; never leak internal error text to the client
    console.error("[adspilot-http] hata:", e);
    if (!res.headersSent) json(res, 500, { error: "internal" });
  }
});

/**
 * LAST-RESORT SAFETY NET. An unexpected error while handling one request must not take
 * the service down for everyone: when the process dies, every in-memory MCP session dies
 * with it and all clients start getting `404 session_not_found`. Log the error and stay
 * up. Both entry points need this — stdio mode installs the same handlers in index.ts.
 */
process.on("unhandledRejection", (e) => console.error("[adspilot-http] unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("[adspilot-http] uncaughtException:", e));

// Slow-client (slowloris) defense: upper bounds for headers and bodies
server.headersTimeout = 20_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 30_000;
server.maxConnections = 512;

// Graceful shutdown: leave open sessions and the database clean across deploys/restarts.
// NOTE: Windows does not deliver SIGTERM (the process is terminated outright), so this
// path is only live on Linux/VPS deployments and cannot be verified locally.
let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[adspilot-http] ${sig} alındı — kapanıyor...`);
    server.close(() => {
      for (const s of sessions.values()) {
        try {
          void s.transport.close();
        } catch {
          /* ignore */
        }
      }
      sessions.clear();
      try {
        store.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    });
    // Don't let stuck connections hold shutdown open forever
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

/**
 * DÜZ METİN KARARI, DİNLEMEDEN ÖNCE.
 *
 * Karar burada değil src/config.ts'te (duzMetinKarari) çünkü hem sınanabilir olmalı hem de
 * tek bir yerden okunmalı. Engel varsa süreç HİÇ dinlemez: şifresiz bir genel adres, ancak
 * ADSPILOT_ALLOW_PLAINTEXT ile AÇIKÇA onaylandığında kabul edilir. Uyarı, PUBLIC_URL https
 * olsa bile susmaz — çünkü dinleyicinin kendisi düz HTTP'dir ve 0.0.0.0'a yayınlandığında
 * ters vekil atlanabilir hâle gelir.
 */
const BIND = process.env.ADSPILOT_BIND?.trim() || "0.0.0.0";
const duzMetin = duzMetinKarari({
  bind: BIND,
  publicUrl: PUBLIC_URL,
  izinVerildi: parseBool(process.env.ADSPILOT_ALLOW_PLAINTEXT, false, "ADSPILOT_ALLOW_PLAINTEXT"),
});
if (duzMetin.engel) {
  console.error(`[adspilot-http] BAŞLATILAMADI — ${duzMetin.engel}`);
  process.exit(1);
}

server.listen(PORT, BIND, () => {
  console.log(`[adspilot-http] ${PUBLIC_URL} üzerinde dinliyor (port ${PORT}, bağlanma adresi ${BIND})`);
  console.log(`[adspilot-http] Bağlanma sayfası: ${PUBLIC_URL}/connect`);
  if (duzMetin.uyari) console.error(`[adspilot-http] UYARI: ${duzMetin.uyari}`);
});
