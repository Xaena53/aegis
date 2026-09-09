// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Repair regression for scripts/get-refresh-token.mjs.
 *
 * THE DEFECT: the OAuth callback embedded the WHOLE token-endpoint body into an error
 * message (`throw new Error("refresh_token dönmedi: " + JSON.stringify(tokens))`), and that
 * message was then printed by `console.error("Token hatası:", e.message)`. `tokenRes.ok` was
 * never consulted, so the code did not know whether it was printing an error body or a 200
 * body. A 200 body without a refresh_token ALWAYS carries a live, adwords-scoped
 * `access_token` (Google returns one whenever the grant is already offline-consented), so
 * `npm run auth` printed a working read/write credential for the user's Google Ads accounts
 * straight into the terminal history people paste into bug reports. The repo's contract:
 * raw upstream text and tokens never reach the terminal. src/http.ts's handleCallback
 * already shows only `error_description`/`error`; this script had drifted away from it.
 *
 * HOW THIS TEST WORKS: it runs the REAL script source. The file is read, its shebang and
 * imports are stripped, and the rest is evaluated with every side effect replaced by a stub
 * (no port is bound, no browser is opened, no network call is made, no .env is touched).
 * The `http.createServer` handler is captured and invoked with a callback request whose
 * `state` matches the one the script generated, so the assertions below run over the
 * production code path rather than over a copy of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BETIK = fileURLToPath(new URL("../scripts/get-refresh-token.mjs", import.meta.url));

interface KosuAyari {
  /** Body returned by the stubbed token endpoint. */
  govde?: unknown;
  ok?: boolean;
  status?: number;
  /** When set, `json()` rejects with it (a non-JSON body). */
  jsonHatasi?: Error;
}

interface KosuSonucu {
  /** Everything the operator sees: terminal lines plus the HTTP body sent to the browser. */
  cikti: string;
  yazmalar: Array<{ yol: string; icerik: string }>;
}

async function callbackKos(ayar: KosuAyari): Promise<KosuSonucu> {
  const kaynak = readFileSync(BETIK, "utf8")
    .replace(/^#![^\n]*\n/, "")
    .replace(/^import[^\n]*\n/gm, "");

  const satirlar: string[] = [];
  const yazmalar: Array<{ yol: string; icerik: string }> = [];
  let isleyici: ((req: unknown, res: unknown) => Promise<void>) | null = null;

  const sahteSunucu = {
    on: () => sahteSunucu,
    listen: (_port: number, _host: string, geriCagri?: () => void) => {
      // Calling the listen callback keeps the browser-opening branch on the tested path;
      // `exec` is stubbed, so nothing is actually launched.
      if (geriCagri) geriCagri();
      return sahteSunucu;
    },
    close: () => {},
  };

  const stub = {
    http: {
      createServer: (fn: (req: unknown, res: unknown) => Promise<void>) => {
        isleyici = fn;
        return sahteSunucu;
      },
    },
    exec: () => {},
    // A fixed "random" state so the request below can present a matching one.
    randomBytes: (n: number) => Buffer.alloc(n, 0xab),
    // No .env and no .env.example on disk: the script must not read the real ones.
    existsSync: () => false,
    readFileSync: () => "",
    writeFileSync: (yol: string, icerik: string) => {
      yazmalar.push({ yol, icerik });
    },
    fetch: async () => ({
      ok: ayar.ok ?? true,
      status: ayar.status ?? 200,
      json: async () => {
        if (ayar.jsonHatasi) throw ayar.jsonHatasi;
        return ayar.govde;
      },
    }),
    console: {
      log: (...a: unknown[]) => satirlar.push(a.map(String).join(" ")),
      error: (...a: unknown[]) => satirlar.push(a.map(String).join(" ")),
    },
    process: {
      env: { GOOGLE_ADS_CLIENT_ID: "TEST-ONLY-cid", GOOGLE_ADS_CLIENT_SECRET: "TEST-ONLY-secret" },
      platform: "linux",
      exit: (kod: number) => {
        throw new Error(`process.exit(${kod})`);
      },
      exitCode: 0,
    },
  };

  const fabrika = new Function(
    "http",
    "exec",
    "randomBytes",
    "readFileSync",
    "writeFileSync",
    "existsSync",
    "fetch",
    "console",
    "process",
    kaynak
  );
  fabrika(
    stub.http,
    stub.exec,
    stub.randomBytes,
    stub.readFileSync,
    stub.writeFileSync,
    stub.existsSync,
    stub.fetch,
    stub.console,
    stub.process
  );
  assert.ok(isleyici, "betikten istek işleyicisi alınamadı — harness bozuk");

  const res = {
    writeHead: () => res,
    setHeader: () => {},
    end: (icerik?: unknown) => {
      if (icerik !== undefined) satirlar.push(String(icerik));
    },
  };
  // 0xab repeated: the hex form of the stubbed randomBytes(16).
  const state = "ab".repeat(16);
  await (isleyici as (req: unknown, res: unknown) => Promise<void>)(
    { url: `/callback?code=4/0TEST-ONLY-code&state=${state}` },
    res
  );

  return { cikti: satirlar.join("\n"), yazmalar };
}

/** The exact shape Google returns for an already-consented offline grant. */
const CANLI_JETONLU_200 = {
  access_token: "ya29.a0TEST-ONLY-CANLI-ERISIM-JETONU",
  expires_in: 3599,
  scope: "https://www.googleapis.com/auth/adwords",
  token_type: "Bearer",
  id_token: "eyJhbGciOiJSUzI1NiJ9.TEST-ONLY-KIMLIK-JETONU.imza",
};

test("KRİTİK: refresh_token'sız 200 gövdesindeki canlı access_token terminale basılmaz", async () => {
  const { cikti } = await callbackKos({ govde: CANLI_JETONLU_200 });

  assert.ok(
    !cikti.includes("ya29."),
    `Canlı access_token terminale sızdı. Görülen çıktı:\n${cikti}`
  );
  assert.ok(!cikti.includes("TEST-ONLY-CANLI-ERISIM-JETONU"), "access_token değeri çıktıda");
  assert.ok(!cikti.includes("TEST-ONLY-KIMLIK-JETONU"), "id_token değeri çıktıda");
  assert.ok(!cikti.includes("access_token"), "gövdenin alan adları bile çıktıya girmemeli");
  // The operator still has to learn WHY it failed, otherwise the fix is just silence.
  assert.match(cikti, /refresh_token/);
  assert.match(cikti, /HTTP 200/);
});

test("hata gövdesinin yalnızca error/error_description alanları gösterilir, gövdenin tamamı değil", async () => {
  const { cikti } = await callbackKos({
    ok: false,
    status: 400,
    govde: {
      error: "invalid_grant",
      error_description: "Bad Request",
      // An unexpected extra field stands in for anything sensitive the endpoint may add.
      beklenmeyen_alan: "TEST-ONLY-SIZDIRMA-KANITI",
    },
  });

  assert.ok(!cikti.includes("TEST-ONLY-SIZDIRMA-KANITI"), `Ham gövde sızdı:\n${cikti}`);
  assert.ok(!cikti.includes("beklenmeyen_alan"), `Ham gövde sızdı:\n${cikti}`);
  assert.match(cikti, /Bad Request/);
  assert.match(cikti, /HTTP 400/);
});

test("JSON olmayan gövdenin ham parçası (ayrıştırıcı hata metni) terminale basılmaz", async () => {
  const { cikti } = await callbackKos({
    jsonHatasi: new SyntaxError(
      'Unexpected token \'<\', "<html>TEST-ONLY-HAM-UPSTREAM</html>" is not valid JSON'
    ),
  });

  assert.ok(!cikti.includes("TEST-ONLY-HAM-UPSTREAM"), `Ham upstream metin sızdı:\n${cikti}`);
  assert.match(cikti, /JSON değil/);
});

test("FAIL-CLOSED: dize olmayan refresh_token .env'e yazılmaz", async () => {
  const { cikti, yazmalar } = await callbackKos({ govde: { refresh_token: { hile: 1 } } });

  assert.deepEqual(yazmalar, [], "okunamayan bir refresh_token .env'e yazıldı");
  assert.ok(!cikti.includes("[object Object]"), `Bozuk değer kimlik bilgisi gibi sunuldu:\n${cikti}`);
  assert.ok(!cikti.includes("YAZILDI"), "başarı mesajı gösterildi");
});

test("mutlu yol bozulmadı: geçerli refresh_token .env'e yazılır", async () => {
  const { cikti, yazmalar } = await callbackKos({ govde: { refresh_token: "1//TEST-ONLY-tazeleme" } });

  assert.equal(yazmalar.length, 1);
  assert.equal(yazmalar[0].yol, ".env");
  assert.match(yazmalar[0].icerik, /^GOOGLE_ADS_REFRESH_TOKEN=1\/\/TEST-ONLY-tazeleme\n$/);
  assert.match(cikti, /YAZILDI/);
});
