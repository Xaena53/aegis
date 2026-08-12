#!/usr/bin/env node
import "dotenv/config";
import http from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "./server.js";
import { AdsContext } from "./adsClient.js";
import { UserStore, type StoredUser } from "./store.js";

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_URL = process.env.ADSPILOT_PUBLIC_URL ?? `http://localhost:${PORT}`;
const store = new UserStore();

// ── Sınırlar (bellek tükenmesine karşı) ──────────────────────────────────
const SESSION_IDLE_MS = 30 * 60_000; // 30 dk hareketsiz oturum kapatılır
const OAUTH_STATE_TTL_MS = 10 * 60_000; // OAuth state 10 dk geçerli
const MAX_PENDING_STATES = 5_000;
const MAX_SESSIONS = 1_000;
const SWEEP_MS = 60_000;

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

// OAuth state → oluşturulma zamanı (CSRF); tek kullanımlık + TTL'li
const pendingStates = new Map<string, number>();

/** Süresi geçen oturum ve OAuth state'lerini temizler (bellek DoS koruması). */
function sweep(): void {
  const now = Date.now();
  for (const [state, born] of pendingStates) {
    if (now - born > OAUTH_STATE_TTL_MS) pendingStates.delete(state);
  }
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
}
setInterval(sweep, SWEEP_MS).unref();

function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function html(res: http.ServerResponse, status: number, body: string) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
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
</style></head><body>${inner}</body></html>`;
}

// ── OAuth: /connect → Google → /oauth/callback ────────────────────────────
function handleConnect(res: http.ServerResponse) {
  const { id } = oauthClient();
  if (pendingStates.size >= MAX_PENDING_STATES) {
    sweep();
    if (pendingStates.size >= MAX_PENDING_STATES) {
      return html(res, 503, page("Meşgul", "<h1>Şu an meşgul</h1><p>Birazdan tekrar dene.</p>"));
    }
  }
  const state = randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now());
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
    )
  );
}

async function handleCallback(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const state = url.searchParams.get("state") ?? "";
  const born = pendingStates.get(state);
  pendingStates.delete(state); // tek kullanımlık
  if (born === undefined) {
    return html(res, 403, page("Hata", "<h1>Geçersiz istek</h1><p>state eşleşmedi (CSRF koruması).</p>"));
  }
  if (Date.now() - born > OAUTH_STATE_TTL_MS) {
    return html(res, 403, page("Süre doldu", "<h1>Bağlantı isteği zaman aşımına uğradı</h1><p><a href='/connect'>Yeniden dene</a>.</p>"));
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

  // Kullanıcı e-postası (id_token'ın payload'ından; imza doğrulaması gerekmez —
  // token doğrudan Google'dan TLS üzerinden geldi, sadece etiketleme amaçlı)
  let email = "bilinmiyor";
  try {
    const payload = JSON.parse(Buffer.from(String(tokens.id_token).split(".")[1], "base64url").toString("utf8"));
    if (payload.email) email = String(payload.email);
  } catch {
    /* etiket yoksa sorun değil */
  }

  const { apiKey } = store.upsertUser({ email, refreshToken: tokens.refresh_token });
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
       <p>Ardından Claude'a “Google Ads hesaplarımı listele” diyebilirsin.</p>`
    )
  );
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
  const server = buildServer(() => contextFor(live.user));
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ── Router ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", PUBLIC_URL);
    if (url.pathname === "/health") return json(res, 200, { ok: true, sessions: sessions.size });
    if (url.pathname === "/connect" && req.method === "GET") return handleConnect(res);
    if (url.pathname === "/oauth/callback" && req.method === "GET") return handleCallback(req, res, url);
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
