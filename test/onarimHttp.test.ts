// SPDX-License-Identifier: AGPL-3.0-only
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * REPAIR REGRESSION — src/http.ts, the POST /settings body ceiling.
 *
 * The finding: the 10 KB ceiling was announced but not enforced. The body was read with a
 * `data` listener that only REJECTED a promise once the ceiling was passed; the listener
 * stayed attached and the request was never destroyed, so an authenticated tenant could
 * drip a body and keep growing the server's heap until requestTimeout (60 s). Killing the
 * process takes every in-memory MCP session with it — exactly what this server's
 * last-resort handlers exist to prevent.
 *
 * WHY A REAL PROCESS WITH A SMALL HEAP: the difference between "refused" and "refused AND
 * stopped reading" is invisible from the wire — both answer immediately, and both leave the
 * client able to go on writing. The only observable that separates them is what the server
 * RETAINS. So the server is started with a capped old-space and then flooded: with the
 * ceiling enforced the flood is discarded and the process lives; with the old pattern the
 * heap runs out and the process dies. Measured on the isolated pattern: a 64 MB heap dies
 * in ~330 ms.
 *
 * The other two tests are the cheap, deterministic half of the same guarantee: an oversized
 * body is REFUSED rather than half-applied, and a legitimate body still saves.
 */

const KOK = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(tmpdir(), `aegis-onarim-http-${process.pid}.db`);
const MASTER = "a".repeat(64); // 64 hex chars → used directly as the HMAC/encryption key

/**
 * The heap cap has to clear the boot cost (tsx compiles the sources in-process: at 128 MB
 * the server does not come up at all, at 256 MB it comes up with room to spare) and still
 * be small enough for a flood to exhaust it within seconds.
 */
const YIGIN_TAVANI_MB = 256;

let sunucu: ChildProcess;
let PORT = 0;
let BASE = "";
let sunucuHatasi = "";

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

before(async () => {
  PORT = await bosPort();
  BASE = `http://localhost:${PORT}`;
  sunucu = spawn(
    process.execPath,
    [`--max-old-space-size=${YIGIN_TAVANI_MB}`, "--import", "tsx", join(KOK, "src", "http.ts")],
    {
      cwd: KOK,
      env: {
        ...process.env,
        PORT: String(PORT),
        AEGIS_PUBLIC_URL: BASE,
        AEGIS_DB: DB,
        AEGIS_MASTER_KEY: MASTER,
        GOOGLE_ADS_DEVELOPER_TOKEN: "sahte-token",
        GOOGLE_ADS_CLIENT_ID: "sahte-client-id",
        GOOGLE_ADS_CLIENT_SECRET: "sahte-secret",
      },
      // stderr is kept: when the process dies of OOM its own last words are the diagnosis
      stdio: ["ignore", "ignore", "pipe"],
    }
  );
  sunucu.stderr?.on("data", (d) => {
    sunucuHatasi += String(d);
  });

  const AZAMI_MS = 60_000;
  for (let gecen = 0; gecen < AZAMI_MS; gecen += 100) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* not listening yet */
    }
    await bekle(100);
  }
  throw new Error(
    `sunucu ${AZAMI_MS / 1000} sn içinde ayağa kalkmadı` +
      (sunucuHatasi.trim() ? ` — stderr: ${sunucuHatasi.trim().slice(0, 500)}` : "")
  );
});

after(() => {
  sunucu?.kill();
  for (const ek of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB + ek, { force: true });
    } catch {
      /* still locked on Windows */
    }
  }
});

/** A user in the store, plus the signed cookie of a human browser session for them. */
async function kullanici(subject: string): Promise<{ cookie: string }> {
  process.env.AEGIS_MASTER_KEY = MASTER;
  const { UserStore } = await import("../src/store.js");
  const s = new UserStore(DB);
  const { userId } = s.upsertUser({ subject, email: `${subject}@ornek.com`, refreshToken: `sahte-${subject}` });
  s.close();
  const govde = `${userId}.${Date.now()}`;
  const mac = createHmac("sha256", MASTER).update(`oturum:${govde}`).digest("base64url");
  return { cookie: `aegis_session=${encodeURIComponent(`${govde}.${mac}`)}` };
}

/** The ceiling as the settings page itself reports it — i.e. the value that really took. */
async function tavan(cookie: string): Promise<string> {
  const r = await fetch(`${BASE}/settings`, { headers: { Cookie: cookie } });
  const m = /name="tavan"[^>]*value="(\d+)"/.exec(await r.text());
  return m?.[1] ?? "(okunamadı)";
}

/**
 * Is the process still serving? Asked over a FRESH connection rather than with fetch: the
 * keep-alive pool would otherwise reuse a socket left over from before the flood, and such a
 * pooled socket answers slowly here even when the server is perfectly healthy — a delay that
 * has nothing to do with what is being measured.
 */
function ayakta(): Promise<boolean> {
  return new Promise((coz) => {
    const s = net.connect(PORT, "127.0.0.1", () => {
      s.write(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n\r\n`);
    });
    let bitti = false;
    const kapat = (sonuc: boolean): void => {
      if (bitti) return;
      bitti = true;
      clearTimeout(zamanlayici);
      try {
        s.destroy();
      } catch {
        /* already gone */
      }
      coz(sonuc);
    };
    const zamanlayici = setTimeout(() => kapat(false), 10_000);
    s.on("data", (d) => kapat(/^HTTP\/1\.1 200 /.test(d.toString("latin1"))));
    s.on("error", () => kapat(false));
    s.on("close", () => kapat(false));
  });
}

/**
 * Streams a chunked body of unbounded length at POST /settings and reports the status line
 * together with how much was written. Nothing here waits for the body to end: the server is
 * supposed to answer and stop reading long before that.
 */
function sel(cookie: string, hedefBayt: number, sureMs: number): Promise<{ durum: string; yazilan: number }> {
  return new Promise((coz) => {
    const s = net.connect(PORT, "127.0.0.1");
    let yanit = "";
    let yazilan = 0;
    let bitti = false;
    const bitir = (): void => {
      if (bitti) return;
      bitti = true;
      clearTimeout(zamanlayici);
      try {
        s.destroy();
      } catch {
        /* already gone */
      }
      coz({ durum: yanit.split("\r\n")[0] ?? "", yazilan });
    };
    const zamanlayici = setTimeout(bitir, sureMs);
    s.on("data", (d) => {
      yanit += d.toString("latin1");
    });
    s.on("error", bitir);
    s.on("close", bitir);
    s.on("connect", () => {
      s.write(
        `POST /settings HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nCookie: ${cookie}\r\n` +
          `Content-Type: application/x-www-form-urlencoded\r\nTransfer-Encoding: chunked\r\n\r\n`
      );
      const blok = "t".repeat(1024 * 1024);
      const parca = Buffer.from(`${(1024 * 1024).toString(16)}\r\n${blok}\r\n`);
      const yaz = (): void => {
        while (!bitti && !s.destroyed && yazilan < hedefBayt) {
          yazilan += blok.length;
          if (!s.write(parca)) {
            s.once("drain", yaz);
            return;
          }
        }
      };
      yaz();
    });
  });
}

test("KRİTİK: gövde tavanı AKIŞI durdurur — sel süreci öldüremez", async () => {
  const { cookie } = await kullanici("sub-sel");
  const once = await tavan(cookie);

  const sonuc = await sel(cookie, 600 * 1024 * 1024, 6_000);
  const akitilan = `${(sonuc.yazilan / 1048576).toFixed(1)} MB`;

  // The whole point of the fix, and therefore the first thing asked: the process is still
  // there. If the body kept accumulating after the ceiling, this heap is gone — and every
  // in-memory MCP session with it.
  await bekle(500);
  assert.equal(
    await ayakta(),
    true,
    `KRİTİK: selden sonra süreç ölmüş — tavan ilan ediliyor ama akış durdurulmuyor ` +
      `(akıtılan: ${akitilan}, yanıt: '${sonuc.durum}'). Sunucu stderr: ${sunucuHatasi.slice(-600)}`
  );

  assert.match(
    sonuc.durum,
    /^HTTP\/1\.1 413 /,
    `tavanı aşan gövde açıkça reddedilmeli (alınan: '${sonuc.durum}', akıtılan: ${akitilan})`
  );

  assert.equal(await tavan(cookie), once, "reddedilen istek kelepçeyi değiştirmemeli");
});

test("tavanı aşan gövde REDDEDİLİR, yarısı uygulanmaz", async () => {
  const { cookie } = await kullanici("sub-buyuk-govde");
  const once = await tavan(cookie);

  // A perfectly valid form field followed by padding past the ceiling: refusing is the only
  // correct answer — reading the first 10 KB and applying it would be a silent trim.
  const r = await fetch(`${BASE}/settings`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: `tavan=77&yazma=1&dolgu=${"x".repeat(64 * 1024)}`,
  });
  assert.equal(r.status, 413, "10 KB üstü gövde 413 ile reddedilmeli");
  assert.equal(await tavan(cookie), once, "reddedilen istekteki 'tavan=77' UYGULANMAMALI");
});

test("meşru (küçük) ayar gönderimi çalışmaya devam eder", async () => {
  const { cookie } = await kullanici("sub-mesru");
  const r = await fetch(`${BASE}/settings`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: "tavan=42&yazma=1",
  });
  assert.equal(r.status, 200, "kapı meşru kullanımı öldürmemeli");
  assert.equal(await tavan(cookie), "42", "meşru değişiklik uygulanmalı");
});
