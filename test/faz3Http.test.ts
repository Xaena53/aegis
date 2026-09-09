// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ROUND-3 REGRESSION COVER — src/http.ts, the five gaps that all had the same shape: a
 * ceiling that was announced somewhere and not applied where the cost is actually paid.
 *
 * Every watcher here is measured against a REAL server process driven over the wire, because
 * http.ts is an entry point rather than an importable module. Nothing reaches the network:
 * Google credentials are fake, and the one outbound call this file exercises (the OAuth token
 * exchange) is intercepted by a stub injected with `--import` from a temporary directory, so
 * the socket is never opened. What the stub does is decided by the `code` the callback
 * carries, which lets the same server answer both "upstream throws" and "upstream hangs".
 *
 * WHAT EACH WATCHER CAN TURN RED (all five were measured red before the fix):
 *
 *   1) TOKEN COST. A harvest-shaped message (list_accounts, aegis://accounts, any completion)
 *      fans out into one listAccessibleCustomers + one query per parent account + one per
 *      manager among them — 61 upstream operations against a developer-token quota every
 *      tenant shares. It used to cost ONE token, so 1,440 polite messages a day could spend
 *      ~87,000 operations of a 15,000/day quota. Here the server runs at 100 tokens/minute:
 *      one harvest fits, two do not, and five ordinary messages still do. Charge a harvest
 *      one token again and the second-harvest assertion goes green — that is the mutation.
 *
 *   2) LOG HYGIENE. The router's catch and both process-level handlers printed the error
 *      OBJECT, which Node inspects: stack plus the error's own enumerable properties. The
 *      stub throws exactly what those paths really meet — a SyntaxError carrying a prefix of
 *      a proxy's HTML page, with a GaxiosError-shaped `config.data` holding a refresh token
 *      and a client secret. The watcher reads the operator's terminal and requires the secret,
 *      the object dump, the stack and the untruncated upstream text all to be absent while the
 *      CAUSE is still legible.
 *
 *   3) HOSTED MODE AND META. config.ts reads AEGIS_META_TOKEN, contextFor() does not carry it,
 *      and nothing said so: the operator set the variable, the container had it, and the Meta
 *      tools answered "not defined". The watcher is bidirectional on purpose — the startup
 *      warning must be there (delete it and this goes red), and the hosted context must still
 *      carry no Meta credential (wire one in without removing the warning and the same test
 *      goes red, because the sentence would have become a lie).
 *
 *   4) THE UNAUTHENTICATED OAUTH SURFACE. /connect mints a state, /oauth/callback spends one,
 *      and spending one used to mean a real POST to Google's token endpoint with no ceiling,
 *      no deadline and no single-use rule. Three separate facts are pinned: a hung upstream
 *      ends on OUR deadline rather than undici's 300 seconds, a state is spent exactly once,
 *      and the surface as a whole has a per-minute ceiling.
 *
 *   5) THE REFUSED-REQUEST PATH. An oversized batch is refused only after the body has been
 *      read and parsed, and nothing counted it, so the cost was free to repeat for ever. The
 *      watcher drives twenty refusals and then requires the twenty-first to be cut with
 *      `too_many_bad_requests` — an answer that can only be produced WITHOUT parsing, since a
 *      parsed body would have answered `batch_too_large`. The doctrine it must not break
 *      (a refused request does not burn the user's own quota) is pinned in the same file.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const KOK = join(dirname(fileURLToPath(import.meta.url)), "..");
const MASTER = "a".repeat(64); // 64 hex chars → used directly as the key
const KABUL = "application/json, text/event-stream";

/** Planted in the thrown error's OWN enumerable property — the GaxiosError shape. */
const SIZAN_SIR = "TEST-ONLY-kacak-refresh-jetonu";
/** Sits past the 300-character cap: it may only appear if the message is printed untrimmed. */
const UZUN_IZ = "KIRPILMADIYSA-BU-IZ-GORUNUR";

let sunucu: ChildProcess;
let PORT = 0;
let BASE = "";
let DB = "";
let geciciDizin = "";
let stderrBirikimi = "";

function bekle(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A free port, so this file can run beside the other server-spawning test files. */
function bosPort(): Promise<number> {
  return new Promise((coz, red) => {
    const s = net.createServer();
    s.once("error", red);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => coz(port));
    });
  });
}

/**
 * The fetch stub. It never reaches the network: the Google token endpoint is answered here,
 * and every other URL is passed through untouched.
 *
 * The `code` the callback carries selects the failure being simulated, so one server covers
 * both an upstream that throws (a proxy's HTML page in front of Google) and an upstream that
 * never answers at all.
 */
const STUB_KAYNAK = `
const gercek = globalThis.fetch;
globalThis.fetch = async (girdi, init) => {
  const url = String(girdi?.url ?? girdi);
  if (!url.startsWith("https://oauth2.googleapis.com/")) return gercek(girdi, init);
  const govde = String(init?.body ?? "");
  console.error("[stub] token-ucu signal=" + (init && init.signal ? "VAR" : "YOK"));
  if (govde.includes("code=asili")) {
    // Never settles on its own: only the caller's own deadline can end this request.
    return new Promise((_, red) => {
      init?.signal?.addEventListener("abort", () =>
        red(new Error("aegis-test-stub: istek iptal edildi"))
      );
    });
  }
  const e = new Error(
    "Unexpected token '<', \\"<html><body>vekil hata sayfasi " + "x".repeat(400) + " ${UZUN_IZ}\\" is not valid JSON"
  );
  e.config = { data: "refresh_token=${SIZAN_SIR}&client_secret=TEST-ONLY-istemci-sirri" };
  throw e;
};
`;

before(async () => {
  geciciDizin = mkdtempSync(join(tmpdir(), "aegis-faz3-"));
  DB = join(geciciDizin, "faz3.db");
  const stubYolu = join(geciciDizin, "fetch-stub.mjs");
  writeFileSync(stubYolu, STUB_KAYNAK, "utf8");
  PORT = await bosPort();
  BASE = `http://localhost:${PORT}`;

  sunucu = spawn(
    process.execPath,
    ["--import", "tsx", "--import", pathToFileURL(stubYolu).href, "src/http.ts"],
    {
      cwd: KOK,
      env: {
        ...process.env,
        PORT: String(PORT),
        AEGIS_PUBLIC_URL: BASE,
        AEGIS_DB: DB,
        AEGIS_MASTER_KEY: MASTER,
        GOOGLE_ADS_DEVELOPER_TOKEN: "TEST-ONLY-dev-token",
        GOOGLE_ADS_CLIENT_ID: "TEST-ONLY-client-id",
        GOOGLE_ADS_CLIENT_SECRET: "TEST-ONLY-client-secret",
        /**
         * Meta credentials are set ON PURPOSE: watcher 3 is about what the server says when
         * an operator HAS filled them in and hosted mode still cannot use them.
         */
        AEGIS_META_TOKEN: "TEST-ONLY-meta-jetonu",
        AEGIS_META_AD_ACCOUNT_ID: "act_1234567890",
        /**
         * 100 tokens/minute is chosen against the harvest price (61): one harvest fits, two
         * cannot, and an ordinary message is nowhere near either edge. With the old
         * one-token-per-message accounting BOTH harvests fit — which is the mutation this
         * file has to be able to see.
         */
        AEGIS_RATE_PER_MINUTE: "100",
        AEGIS_RATE_PER_DAY: "2000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  // The operator's terminal IS the measurement surface for watchers 2 and 3.
  sunucu.stderr?.on("data", (d) => (stderrBirikimi += String(d)));
  sunucu.stdout?.on("data", (d) => (stderrBirikimi += String(d)));
  sunucu.once("exit", (kod) => {
    if (kod !== 0 && kod !== null) stderrBirikimi += `\n(süreç ${kod} koduyla çıktı)`;
  });

  // Same budget as the sibling http test: healthy runs answer on the first try; a broken
  // one fails after 45 s WITH the reason instead of hanging the suite.
  for (let gecen = 0; gecen < 45_000; gecen += 100) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        await r.text();
        return;
      }
    } catch {
      /* not listening yet */
    }
    await bekle(100);
  }
  throw new Error(
    `sunucu 45 saniyede ayağa kalkmadı — stderr: ${stderrBirikimi.trim().slice(0, 500)}`
  );
});

after(() => {
  sunucu?.kill();
  try {
    rmSync(geciciDizin, { recursive: true, force: true });
  } catch {
    /* SQLite may still hold the file on Windows */
  }
});

/** Inserts a user straight into the store, bypassing the OAuth flow. */
async function kullaniciEkle(subject: string): Promise<string> {
  process.env.AEGIS_MASTER_KEY = MASTER;
  const { UserStore } = await import("../src/store.js");
  const s = new UserStore(DB);
  const { apiKey } = s.upsertUser({
    subject,
    email: `${subject}@ornek.com`,
    refreshToken: `TEST-ONLY-${subject}`,
  });
  s.close();
  return apiKey;
}

async function mcp(key: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: KABUL },
    body: JSON.stringify(body),
  });
}

/** How many times the stub has actually been reached — i.e. real upstream calls. */
function stubCagriSayisi(): number {
  return (stderrBirikimi.match(/\[stub\] token-ucu/g) ?? []).length;
}

async function stderrBekle(desen: RegExp, azamiMs = 15_000): Promise<string> {
  for (let gecen = 0; gecen < azamiMs; gecen += 100) {
    const satir = stderrBirikimi.split("\n").find((l) => desen.test(l));
    if (satir) return satir;
    await bekle(100);
  }
  throw new Error(
    `stderr'de ${desen} beklenirken süre doldu — görülen: ${stderrBirikimi.trim().slice(-600)}`
  );
}

/** Runs a full /connect → /oauth/callback round for one browser. */
async function baglanVeCallback(kod: string): Promise<Response> {
  const c = await fetch(`${BASE}/connect`);
  const cerez = c.headers.get("set-cookie") ?? "";
  await c.text();
  const state = /aegis_state=([^;]+)/.exec(cerez)?.[1];
  assert.ok(state, "/connect state çerezi vermeli");
  return fetch(`${BASE}/oauth/callback?code=${kod}&state=${state}`, {
    headers: { Cookie: `aegis_state=${state}` },
    redirect: "manual",
  });
}

/* ── 1) HASAT MESAJININ BEDELİ ────────────────────────────────────────────── */

test("BULGU 1: hesap ağacını tarayan mesaj, tarama BEDELİYLE ücretlendirilir", async () => {
  const hasatlar: Array<{ ad: string; mesaj: unknown }> = [
    {
      ad: "list_accounts aracı",
      mesaj: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_accounts", arguments: {} } },
    },
    {
      ad: "aegis://accounts kaynağı",
      mesaj: { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "aegis://accounts" } },
    },
    {
      ad: "completion/complete (tuş başına bir istek)",
      mesaj: {
        jsonrpc: "2.0",
        id: 1,
        method: "completion/complete",
        params: { ref: { type: "ref/prompt", name: "reklam-kur" }, argument: { name: "customerId", value: "1" } },
      },
    },
  ];

  for (const [sira, { ad, mesaj }] of hasatlar.entries()) {
    const k = await kullaniciEkle(`faz3-hasat-${sira}`);
    const bir = await mcp(k, mesaj);
    await bir.text();
    assert.notEqual(bir.status, 429, `${ad}: ilk tarama 100 jetonluk dakikalık bütçeye sığmalı`);

    const iki = await mcp(k, mesaj);
    const govde = await iki.text();
    assert.equal(
      iki.status,
      429,
      `${ad}: iki tarama (2 x 61 işlem) 100 jetonu aşar. Bu satır yeşilse jeton yine MESAJ ` +
        `başına düşülüyor demektir ve paylaşılan Google kotasını koruyan sayaç, kendisini ` +
        `61 kat aşan çarpanı görmüyor.`
    );
    assert.match(govde, /rate_limited/, `${ad}: ret sebebi hız sınırı olmalı`);
  }
});

test("BULGU 1: sıradan mesajın bedeli 1 kalır (tarama fiyatı her şeye yayılmaz)", async () => {
  const k = await kullaniciEkle("faz3-siradan");
  for (let i = 0; i < 5; i++) {
    const r = await mcp(k, { jsonrpc: "2.0", id: i + 1, method: "tools/list" });
    await r.text();
    assert.notEqual(
      r.status,
      429,
      `${i + 1}. sıradan mesaj reddedildi — tarama bedeli taramayan mesajlara da uygulanıyor`
    );
  }
});

/* ── 2) LOG HİJYENİ ──────────────────────────────────────────────────────── */

test("BULGU 2: giriş noktası hata NESNESİNİ değil, kırpılmış mesajı loglar", async () => {
  const yanit = await baglanVeCallback("hata");
  const istemciGovdesi = await yanit.text();
  assert.equal(yanit.status, 500, "yukarı-akış hatası istemciye 500 olarak döner");
  assert.doesNotMatch(istemciGovdesi, /refresh_token|TEST-ONLY/, "istemciye hiçbir iç metin sızmaz");

  const satir = await stderrBekle(/\[aegis-http\] hata:/);
  assert.match(satir, /Unexpected token/, "sebep operatöre görünmeye devam etmeli (sessizlik de arıza)");
  assert.ok(
    !stderrBirikimi.includes(SIZAN_SIR),
    "KRİTİK: hatanın KENDİ sayılabilir alanları (GaxiosError.config.data = refresh_token + " +
      "client_secret) loga yazıldı — nesne util.inspect ile basılıyor demektir"
  );
  assert.doesNotMatch(stderrBirikimi, /config:/, "nesne dökümü yapılmamalı");
  assert.doesNotMatch(stderrBirikimi, /\n\s+at .*http\.ts/, "yığın izi basılmamalı");
  assert.ok(
    !stderrBirikimi.includes(UZUN_IZ),
    "ham yukarı-akış metni kırpılmadan yazıldı — depo bu metni her yerde 300 karakterle sınırlıyor"
  );
});

/* ── 3) HOSTED MOD VE META ───────────────────────────────────────────────── */

test("BULGU 3: hosted mod Meta kimlik bilgisi TAŞIMAZ ve bunu açıkça söyler", () => {
  assert.match(
    stderrBirikimi,
    /AEGIS_META_TOKEN[\s\S]{0,300}HOSTED MODDA/,
    "operatör AEGIS_META_TOKEN'ı doldurmuş: hosted modda kullanılmadığı AÇILIŞTA söylenmeli — " +
      "yoksa tek geri bildirim, araçların olgusal olarak yanlış 'tanımlı değil' cümlesi olur"
  );

  /**
   * The other direction. The warning is only true while the hosted context really carries no
   * Meta credential; wiring one into contextFor without touching the warning would turn the
   * sentence into a lie, and this assertion is what catches that.
   */
  const kaynak = readFileSync(join(KOK, "src/http.ts"), "utf8");
  const bas = kaynak.indexOf("function contextFor");
  const son = kaynak.indexOf("// ── Sessions");
  assert.ok(bas !== -1 && son > bas, "contextFor dilimi bulunamadı — gözcünün yolu bayatlamış");
  const kod = kaynak
    .slice(bas, son)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  assert.doesNotMatch(
    kod,
    /metaToken|metaAdAccountId/,
    "hosted bağlam artık Meta kimlik bilgisi taşıyor: ya kiracı başına saklanmalı ya da " +
      "açılıştaki 'hosted modda kullanılmıyor' uyarısı kaldırılmalı — ikisi aynı anda doğru olamaz"
  );
});

/* ── 4) KİMLİKSİZ OAUTH YÜZEYİ ───────────────────────────────────────────── */

test("BULGU 4: asılı kalan token çağrısı KENDİ süremizle biter (undici'nin 300 sn'siyle değil)", async () => {
  const bas = Date.now();
  let zamanlayici: NodeJS.Timeout | undefined;
  const sure = new Promise<string>((r) => {
    zamanlayici = setTimeout(() => r("asılı kaldı"), 25_000);
  });
  const sonuc = await Promise.race([
    baglanVeCallback("asili").then(
      async (r) => {
        await r.text();
        return "yanıtladı";
      },
      (e: unknown) => `istek hata verdi: ${String((e as { message?: unknown })?.message ?? e)}`
    ),
    sure,
  ]);
  clearTimeout(zamanlayici);
  const gecen = Date.now() - bas;

  assert.equal(
    sonuc,
    "yanıtladı",
    `asılı yukarı-akış 25 sn içinde bitmedi (${gecen} ms) — fetch'e AbortSignal verilmemiş demektir`
  );
  assert.ok(gecen > 2_000, `istek beklemeden döndü (${gecen} ms): asılı yol hiç ölçülmemiş olabilir`);
  assert.match(stderrBirikimi, /\[stub\] token-ucu signal=VAR/, "token çağrısı bir AbortSignal taşımalı");
  assert.doesNotMatch(stderrBirikimi, /signal=YOK/, "süresiz (signalsiz) bir token çağrısı kalmamalı");
});

test("BULGU 4: harcanmış state ikinci bir yukarı-akış çağrısı DOĞURMAZ", async () => {
  const once = stubCagriSayisi();
  const c = await fetch(`${BASE}/connect`);
  const cerez = c.headers.get("set-cookie") ?? "";
  await c.text();
  const state = /aegis_state=([^;]+)/.exec(cerez)?.[1];
  assert.ok(state, "/connect state çerezi vermeli");

  const cagir = () =>
    fetch(`${BASE}/oauth/callback?code=hata&state=${state}`, {
      headers: { Cookie: `aegis_state=${state}` },
      redirect: "manual",
    });

  const ilk = await cagir();
  await ilk.text();
  assert.equal(ilk.status, 500, "ilk callback gerçekten token değişimine gitmeli (stub fırlatır)");
  await stderrBekle(/\[stub\] token-ucu/);

  for (let i = 0; i < 3; i++) {
    const tekrar = await cagir();
    await tekrar.text();
    assert.equal(tekrar.status, 403, `${i + 1}. tekrar: harcanmış state kabul edilemez`);
    assert.match(
      tekrar.headers.get("set-cookie") ?? "",
      /aegis_state=;[^]*Max-Age=0/,
      "state çerezi her çıkışta silinmeli (tarayıcı tarafında tek kullanımlık)"
    );
  }

  await bekle(300); // stderr borusunun yetişmesi için
  assert.equal(
    stubCagriSayisi() - once,
    1,
    "dört callback yalnız BİR yukarı-akış çağrısı doğurmalı: state tek kullanımlık değilse " +
      "tek /connect, TTL boyunca sınırsız TLS POST'u basar"
  );
});

/* ── 5) REDDEDİLEN İSTEK YOLU ────────────────────────────────────────────── */

test("BULGU 5: reddedilen toplu istekler sayılır ve gövde OKUNMADAN kesilir", async () => {
  const k = await kullaniciEkle("faz3-toplu");
  const dizi = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/list" }));

  for (let i = 0; i < 20; i++) {
    const r = await mcp(k, dizi);
    const govde = await r.text();
    assert.equal(r.status, 429, `${i + 1}. toplu istek reddedilmeli`);
    assert.match(govde, /batch_too_large/, `${i + 1}. istek tavan içinde batch_too_large olmalı`);
  }

  /**
   * The twenty-first. `too_many_bad_requests` can only be produced BEFORE the body is parsed:
   * a parsed body would have counted 21 messages and answered `batch_too_large`. So this pair
   * of assertions is what proves the ceiling sits above the cost it bounds, rather than below
   * it where it can never bound anything.
   */
  const sisik = Array.from({ length: 21 }, (_, i) => ({
    jsonrpc: "2.0",
    id: i + 1,
    method: "tools/list",
    params: { dolgu: "x".repeat(20_000) },
  }));
  const kesildi = await mcp(k, sisik);
  const kesikGovde = await kesildi.text();
  assert.equal(kesildi.status, 429, "21. reddedilen istek de reddedilmeli");
  assert.match(
    kesikGovde,
    /too_many_bad_requests/,
    "reddedilen istek yolunun HİÇBİR tavanı yok: 4 MB'a kadar gövde okuma + parse bedeli " +
      "sonsuza dek bedavaya tekrarlanabiliyor"
  );
  assert.doesNotMatch(
    kesikGovde,
    /batch_too_large/,
    "batch_too_large cevabı gövdenin PARSE EDİLDİĞİNİ gösterir — kesme, okumadan ÖNCE olmalı"
  );
  assert.ok(Number(kesildi.headers.get("retry-after")) > 0, "Retry-After verilmeli");
});

test("BULGU 5: tek bir reddedilen toplu istek kullanıcının KOTASINI yakmaz", async () => {
  /**
   * The fix must not quietly overturn the decision it sits next to (rateLimit.ts: a refused
   * request does not increment the counters, otherwise a client over the limit keeps
   * extending its own penalty). Start charging the main limiter on this path and this goes
   * red.
   */
  const k = await kullaniciEkle("faz3-kota");
  const dizi = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/list" }));
  const red = await mcp(k, dizi);
  assert.match(await red.text(), /batch_too_large/, "tavanı aşan dizi reddedilmeli");

  const sonra = await mcp(k, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  await sonra.text();
  assert.notEqual(sonra.status, 429, "reddedilen istek kullanıcının jetonunu yakmamalı");
});

/* ── 6) KİMLİKSİZ YÜZEYİN DAKİKALIK TAVANI ───────────────────────────────────
 *
 * BU TEST DOSYANIN SONUNDA DURMALI. It deliberately exhausts the per-minute ceiling of the
 * OAuth surface for this server's IP bucket, so any /connect-driven test placed after it
 * would be answered 429 for reasons that have nothing to do with what it measures.
 * ─────────────────────────────────────────────────────────────────────────── */

test("BULGU 4: kimliksiz OAuth yüzeyinin dakikalık tavanı VAR", async () => {
  let goruldu = 0;
  let bekleme = "";
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${BASE}/connect`);
    await r.text();
    if (r.status === 429) {
      goruldu = 429;
      bekleme = r.headers.get("retry-after") ?? "";
      break;
    }
  }
  assert.equal(
    goruldu,
    429,
    "120 kimliksiz istekte hiç 429 gelmedi: /connect ve /oauth/callback hiçbir sayaca tabi " +
      "değil demektir ve her callback bir gerçek TLS POST'u doğurabilir"
  );
  assert.ok(Number(bekleme) > 0, "Retry-After verilmeli (istemci ne zaman döneceğini bilmeli)");
});
