#!/usr/bin/env node
import "dotenv/config";
import http from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";
import { AdsContext } from "./adsClient.js";
import { UserStore, type StoredUser } from "./store.js";

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_URL = process.env.ADSPILOT_PUBLIC_URL ?? `http://localhost:${PORT}`;
const store = new UserStore();

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

function contextFor(user: StoredUser): AdsContext {
  const { id, secret, devToken } = oauthClient();
  return new AdsContext({
    developerToken: devToken,
    clientId: id,
    clientSecret: secret,
    refreshToken: user.refreshToken,
    loginCustomerId: user.loginCustomerId,
    writeEnabled: user.writeEnabled,
    maxDailyBudget: user.maxDailyBudget,
  });
}

// ── Oturum yönetimi: her MCP oturumu TEK kullanıcıya bağlı ────────────────
interface Session {
  transport: StreamableHTTPServerTransport;
  userId: number;
}
const sessions = new Map<string, Session>();

// OAuth state → nonce (CSRF); tek kullanımlık
const pendingStates = new Map<string, number>();

function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function html(res: http.ServerResponse, status: number, body: string) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
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
  const state = randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now());
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: id,
      redirect_uri: `${PUBLIC_URL}/oauth/callback`,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/adwords email",
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
  if (!pendingStates.delete(state)) {
    return html(res, 403, page("Hata", "<h1>Geçersiz istek</h1><p>state eşleşmedi (CSRF koruması).</p>"));
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
    return html(res, 400, page("Hata", `<h1>Token alınamadı</h1><p>${tokens.error_description ?? tokens.error ?? "bilinmeyen hata"}</p>`));
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
       <p><strong>${email}</strong> hesabın AdsPilot'a bağlandı.</p>
       <div class="warn"><strong>API anahtarın (yalnız bir kez gösterilir):</strong>
       <pre>${apiKey}</pre></div>
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
  let session = sessionId ? sessions.get(sessionId) : undefined;

  // Oturum kaçırma koruması: mevcut oturum başka kullanıcıya aitse reddet
  if (session && session.userId !== user.id) return json(res, 403, { error: "session_owner_mismatch" });

  let body: unknown;
  try {
    body = await readBody(req);
  } catch (e: any) {
    return json(res, 400, { error: "bad_request", message: e?.message });
  }

  if (!session) {
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string): void => {
        sessions.set(sid, { transport, userId: user.id });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    // Bu oturumun araçları YALNIZ bu kullanıcının context'ini görür
    const ctx = contextFor(user);
    const server = buildServer(() => ctx);
    await server.connect(transport);
    session = { transport, userId: user.id };
  }

  await session.transport.handleRequest(req, res, body);
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
    console.error("[adspilot-http] hata:", e);
    if (!res.headersSent) json(res, 500, { error: "internal", message: e?.message });
  }
});

server.listen(PORT, () => {
  console.log(`[adspilot-http] ${PUBLIC_URL} üzerinde dinliyor (port ${PORT})`);
  console.log(`[adspilot-http] Bağlanma sayfası: ${PUBLIC_URL}/connect`);
});
