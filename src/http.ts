#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/*
 * AdsPilot — Google Ads MCP sunucusu (hosted mod)
 * Copyright (C) 2026 Xaena53 (github.com/Xaena53) ve AdsPilot katkıcıları
 *
 * GNU Affero General Public License v3 altında dağıtılır — bkz. LICENSE.
 * AGPL §13 gereği bu servisin kullanıcılarına kaynak kod sunulur (/source).
 */
import "dotenv/config";
import http from "node:http";
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "./server.js";
import { AdsContext } from "./adsClient.js";
import { UserStore, encryptSecret, type StoredUser } from "./store.js";
import { RateLimiter } from "./rateLimit.js";
import { setRuntimeMode } from "./util.js";
import { parseNumEnv } from "./config.js";

/**
 * AGPL-3.0 BÖLÜM 13 UYUMU.
 *
 * "Ağ üzerinden etkileşen kullanıcılara Karşılık Gelen Kaynak sunulmalıdır."
 * AdsPilot bir ağ servisi olduğu için bu yükümlülük İŞLETMECİYİ (bu sunucuyu
 * çalıştıran kişiyi) bağlar. Bağlantı her sayfanın altbilgisinde ve /source
 * adresinde sunulur.
 *
 * DİKKAT: Bu adres GERÇEKTEN erişilebilir olmalı. Depo private iken dışarıya
 * açık bir servis çalıştırmak lisans ihlalidir.
 */
const SOURCE_URL = process.env.ADSPILOT_SOURCE_URL?.trim() || "https://github.com/Xaena53/google-ads-mcp";

const PORT = parseNumEnv("PORT", process.env.PORT, 8787);
const PUBLIC_URL = process.env.ADSPILOT_PUBLIC_URL?.trim() || `http://localhost:${PORT}`;

/**
 * BAŞLANGIÇTA HIZLI BAŞARISIZLIK. Eskiden eksik yapılandırma yalnız ilk
 * kullanımda patlıyordu: sunucu ayağa kalkıyor, /health {ok:true} diyor,
 * monitör yeşil yanıyor ve hata ancak ilk gerçek kullanıcı Google'dan
 * dönerken görünüyordu. Bozuk deploy sessiz kalmamalı.
 */
function validateHostedEnv(): void {
  const eksik: string[] = [];
  for (const k of ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET"]) {
    if (!process.env[k]?.trim()) eksik.push(k);
  }
  const mk = process.env.ADSPILOT_MASTER_KEY;
  if (!mk?.trim() || mk.length < 32) eksik.push("ADSPILOT_MASTER_KEY (min 32 karakter)");
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
// Şifreleme anahtarını hemen dene: bozuksa ilk kullanıcıda değil ŞİMDİ patlasın
try {
  encryptSecret("baslangic-dogrulamasi");
} catch (e: any) {
  console.error(`[adspilot-http] BAŞLATILAMADI — şifreleme anahtarı kullanılamıyor: ${e?.message ?? e}`);
  process.exit(1);
}

// ── Sınırlar (bellek tükenmesine karşı) ──────────────────────────────────
const SESSION_IDLE_MS = 30 * 60_000; // 30 dk hareketsiz oturum kapatılır
const OAUTH_STATE_TTL_MS = 10 * 60_000; // OAuth state 10 dk geçerli
const MAX_SESSIONS = 1_000;
const MAX_SESSIONS_PER_USER = 10; // tek kullanıcı havuzu tüketemesin
const SWEEP_MS = 60_000;

// Paylaşılan Google Ads kotasını koruyan kullanıcı-başı hız sınırı
const limiter = new RateLimiter({
  // parseNumEnv şart: boş string Number("")===0 verip "her istek 429" yapardı
  perMinute: parseNumEnv("ADSPILOT_RATE_PER_MINUTE", process.env.ADSPILOT_RATE_PER_MINUTE, 120),
  perDay: parseNumEnv("ADSPILOT_RATE_PER_DAY", process.env.ADSPILOT_RATE_PER_DAY, 2000),
});

// Hosted modda hata ipuçları ".env düzenle" değil "yeniden bağlan" demeli
setRuntimeMode("hosted", `${PUBLIC_URL}/connect`);

/**
 * DNS rebinding koruması için izinli Host/Origin listesi (MCP spec gereği).
 * Yerel adreslerde 127.0.0.1/localhost varyantları birlikte kabul edilir;
 * ek isimler ADSPILOT_ALLOWED_HOSTS ile virgüllü verilebilir (nginx/proxy arkası).
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

/** Sunucunun kendi OAuth istemcisi (hosted modda kullanıcılar bunu paylaşır). */
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
 * Kullanıcı ayarlarına göre memoize edilmiş context. Anahtar kullanıcının
 * TÜM etkin alanlarını içerir: ayar değişince (token yenilenmesi, yazma
 * izninin kapatılması, tavan düşürülmesi) yeni context üretilir — açık
 * oturumlar eski/gevşek ayarlarla çalışmaya devam edemez.
 */
const ctxCache = new Map<string, AdsContext>();

function contextFor(user: StoredUser): AdsContext {
  const key = [user.id, user.refreshToken, user.loginCustomerId ?? "", user.writeEnabled, user.maxDailyBudget].join("|");
  let ctx = ctxCache.get(key);
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
    });
    if (ctxCache.size > 500) ctxCache.clear(); // sınırsız büyümeyi engelle
    ctxCache.set(key, ctx);
  }
  return ctx;
}

// ── Oturum yönetimi: her MCP oturumu TEK kullanıcıya bağlı ────────────────
interface Session {
  transport: StreamableHTTPServerTransport;
  userId: number;
  /**
   * Paylaşılan kutu: her istekte DB'den tazelenir. Araç context sağlayıcısı
   * AYNI nesneyi okuduğu için ayar değişiklikleri açık oturuma da yansır.
   */
  live: { user: StoredUser };
  lastSeen: number;
}
const sessions = new Map<string, Session>();

/** Kurulmakta olan (henüz kaydedilmemiş) oturumlar — tavan yarışını kapatır. */
const pendingSessions = new Map<number, number>();

/** Süresi geçen oturum ve OAuth state'lerini temizler (bellek DoS koruması). */
function sweep(): void {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.lastSeen > SESSION_IDLE_MS) {
      sessions.delete(sid);
      try {
        void s.transport.close();
      } catch {
        /* kapanış hatası önemsiz */
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
    // API anahtarı içeren sayfa önbelleğe/proxy'ye yazılmasın, referrer sızmasın
    "Cache-Control": "no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    ...extraHeaders,
  });
  res.end(body);
}

/** HTML'e gömülecek her dış veri buradan geçer (XSS savunması). */
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
 * OAuth state'i TARAYICIYA bağlar (imzalı çerez). İki sorunu birden çözer:
 *  1) Sunucu tarafı `pendingStates` havuzu yoktu edilir → kimliksiz istekle
 *     doldurulup tüm yeni kullanıcılara 503 verdirme yolu kapanır.
 *  2) "state eşleşti" artık "bu tarayıcı üretti" demek olur → saldırganın
 *     kendi Google hesabını kurbanın tarayıcısına bağlatması (login CSRF)
 *     engellenir; aksi halde kurbanın kampanyaları saldırganın hesabına yazardı.
 */
function signState(nonce: string, ts: number): string {
  const body = `${nonce}.${ts}`;
  const mac = createHmac("sha256", process.env.ADSPILOT_MASTER_KEY ?? "").update(body).digest("base64url");
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
 * Q7 — İNSAN OTURUMU (ayar sayfası için).
 *
 * Değişmez kural: AJAN KENDİ KELEPÇESİNİ GEVŞETEMEZ. Bütçe tavanı ve yazma
 * izni MCP üzerinden yalnız OKUNUR (adspilot://accounts/{id}/limits); değişiklik
 * yalnız insanın tarayıcısındaki bu oturumla yapılır. API anahtarı bu iş için
 * kullanılamaz — ajan da o anahtara sahip olduğundan kapı anlamsız kalırdı.
 */
const OTURUM_TTL_MS = 2 * 60 * 60_000; // 2 saat

function signSession(userId: number, ts: number): string {
  const body = `${userId}.${ts}`;
  const mac = createHmac("sha256", process.env.ADSPILOT_MASTER_KEY ?? "").update(`oturum:${body}`).digest("base64url");
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
  // SameSite=Strict: ayar değişikliği başka siteden tetiklenemesin
  return `adspilot_session=${encodeURIComponent(signSession(userId, Date.now()))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${OTURUM_TTL_MS / 1000}${secure}`;
}

function readCookie(req: http.IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      // Bozuk yüzde dizisi (ör. "%") URIError fırlatır. Çerez tamamen
      // saldırgan kontrolündedir; kimliksiz bir istekle sunucu düşmemeli.
      try {
        return decodeURIComponent(v.join("="));
      } catch {
        return undefined; // geçersiz çerez = çerez yok
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
      // openid ZORUNLU: onsuz Google id_token döndürmez, e-posta hiç çözülemezdi
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
  // state hem imzalı+taze olmalı HEM DE bu tarayıcının çerezindekiyle aynı olmalı
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

  // Kimlik: id_token'ın `sub` claim'i (imza doğrulaması gerekmez — token
  // doğrudan Google'dan TLS üzerinden geldi). `sub` DEĞİŞMEZ; e-posta değil.
  let subject: string | undefined;
  let email = "bilinmiyor";
  try {
    const payload = JSON.parse(Buffer.from(String(tokens.id_token).split(".")[1], "base64url").toString("utf8"));
    if (payload.sub) subject = String(payload.sub);
    if (payload.email) email = String(payload.email);
  } catch {
    /* aşağıda kapalı-arıza */
  }

  // KAPALI ARIZA: kimlik çözülemezse kullanıcıyı PAYLAŞILAN bir satıra yazma.
  // Aksi halde iki farklı kişi aynı kayda düşer, biri diğerinin API anahtarını
  // ve Google token'ını sessizce geçersizleştirir.
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
    // İnsan oturumu: ayar sayfası API anahtarıyla DEĞİL bununla korunur
    { "Set-Cookie": oturumCerezi(userId) }
  );
}

// ── Ayarlar (yalnız insan oturumu) ────────────────────────────────────────
const MUTLAK_BUTCE_TAVANI = 100_000; // yazım hatasına karşı emniyet

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
     * CSRF: SameSite=Strict tek başına YETMEZ. SameSite "kayıt edilebilir alan"
     * (eTLD+1) bazlıdır; adspilot.ornek.com kurulumunda ornek.com altındaki
     * HERHANGİ bir alt alan (pazarlama sitesi, ele geçirilmiş eski uygulama)
     * "same-site" sayılır ve çerez gönderilir. Oradan gelen otomatik bir form
     * gönderimi yazmayı açıp tavanı sonuna kadar yükseltebilirdi — yani
     * "kelepçeyi yalnız insan gevşetebilir" iddiası tam burada kırılıyordu.
     * Origin doğrulaması bu yolu kapatır (izin listesi zaten mevcut).
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

  // Paylaşılan Google Ads kotasını ve sunucuyu koruyan kullanıcı-başı sınır
  const rl = limiter.check(user.id);
  if (!rl.allowed) {
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(rl.retryAfterSec ?? 60),
    });
    return res.end(JSON.stringify({ error: "rate_limited", message: rl.reason, retryAfterSec: rl.retryAfterSec }));
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const session = sessionId ? sessions.get(sessionId) : undefined;

  // Oturum kaçırma koruması: mevcut oturum başka kullanıcıya aitse reddet
  if (session && session.userId !== user.id) return json(res, 403, { error: "session_owner_mismatch" });

  // Bilinmeyen/süresi dolmuş oturum kimliği: spec gereği 404 (istemci yeniden
  // initialize eder). Sessizce yeni sunucu kurmak, rastgele oturum kimlikleriyle
  // sınırsız nesne üretimine (DoS) yol açardı.
  if (sessionId && !session) {
    return json(res, 404, { error: "session_not_found", hint: "Oturum düştü — yeniden initialize et." });
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch (e: any) {
    return json(res, 400, { error: "bad_request", message: e?.message });
  }

  if (session) {
    // Ayarlar bayatlamasın: kullanıcıyı her istekte DB'den tazele
    session.live.user = store.findById(session.userId) ?? session.live.user;
    session.lastSeen = Date.now();
    return await session.transport.handleRequest(req, res, body);
  }

  // Oturum kimliği yok → yalnız initialize isteği yeni oturum açabilir
  if (!isInitializeRequest(body)) {
    return json(res, 400, { error: "invalid_request", hint: "Önce initialize çağır (mcp-session-id yok)." });
  }
  if (sessions.size >= MAX_SESSIONS) {
    sweep();
    if (sessions.size >= MAX_SESSIONS) return json(res, 503, { error: "too_many_sessions" });
  }
  // Tek kullanıcı oturum havuzunu tüketip diğerlerini kilitleyemesin.
  // YER AYIRMA senkron yapılır: kontrol ile kaydın arasında `await` var ve
  // eşzamanlı initialize istekleri tavanı hep "0 oturum" görüp aşabiliyordu.
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

  // Paylaşılan kutu: hem oturum kaydı hem araç context sağlayıcısı bunu okur
  const live: { user: StoredUser } = { user };
  const { hosts, origins } = allowList();
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // MCP spec: DNS rebinding'e karşı Host/Origin doğrulaması
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

  // Bu oturumun araçları YALNIZ bu kullanıcının GÜNCEL context'ini görür
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
    // `await` ŞART: await'siz `return` edilen bir async fonksiyonun reddi bu
    // try/catch'e HİÇ uğramaz, en üste sızar ve süreci öldürür. Kimliksiz tek
    // bir istekle tüm sunucunun düştüğü uzaktan servis-dışı bırakma açığıydı.
    if (url.pathname === "/oauth/callback" && req.method === "GET") return await handleCallback(req, res, url);
    if (url.pathname === "/settings") return await handleSettings(req, res);
    // AGPL §13: kaynak kod teklifi — makine tarafından da bulunabilir olsun
    if (url.pathname === "/source") {
      res.writeHead(302, { Location: SOURCE_URL, "Cache-Control": "no-store" });
      return res.end();
    }
    if (url.pathname === "/mcp") return await handleMcp(req, res);
    if (url.pathname === "/")
      return html(res, 200, page("AdsPilot", `<h1>AdsPilot</h1><p>Google Ads MCP sunucusu. <a href="/connect">Hesabını bağla</a>.</p>`));
    json(res, 404, { error: "not_found" });
  } catch (e: any) {
    // Ayrıntı yalnız sunucu loguna; istemciye iç hata metni sızdırma
    console.error("[adspilot-http] hata:", e);
    if (!res.headersSent) json(res, 500, { error: "internal" });
  }
});

/**
 * SON EMNİYET AĞI. Tek bir isteğin işlenmesi sırasındaki beklenmeyen bir hata
 * TÜM kullanıcıların servisini düşürmemeli: süreç ölünce bellekteki bütün MCP
 * oturumları da kaybolur ve herkes `404 session_not_found` alır.
 * Hata loglanır, süreç ayakta kalır. (stdio modunda index.ts'te zaten vardı;
 * hosted modda eksikti.)
 */
process.on("unhandledRejection", (e) => console.error("[adspilot-http] unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("[adspilot-http] uncaughtException:", e));

// Yavaş-istemci (slowloris) savunması: başlık ve gövde için üst sınırlar
server.headersTimeout = 20_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 30_000;
server.maxConnections = 512;

// Düzgün kapanma: açık oturumları ve veritabanını temiz bırak (deploy/restart).
// NOT: Windows SIGTERM teslimini desteklemez (süreç doğrudan sonlandırılır);
// bu yol yalnız Linux/VPS dağıtımında etkindir — yerelde doğrulanamaz.
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
          /* yoksay */
        }
      }
      sessions.clear();
      try {
        store.close();
      } catch {
        /* yoksay */
      }
      process.exit(0);
    });
    // Takılan bağlantılar kapanışı sonsuza dek bekletmesin
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

server.listen(PORT, () => {
  console.log(`[adspilot-http] ${PUBLIC_URL} üzerinde dinliyor (port ${PORT})`);
  console.log(`[adspilot-http] Bağlanma sayfası: ${PUBLIC_URL}/connect`);
  const pub = new URL(PUBLIC_URL);
  if (pub.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(pub.hostname)) {
    console.error(
      "[adspilot-http] UYARI: PUBLIC_URL http:// — API anahtarları ve OAuth kodları AÇIK METİN taşınır. " +
        "Üretimde TLS (nginx/Caddy) arkasına al ve ADSPILOT_PUBLIC_URL'i https:// yap."
    );
  }
});
