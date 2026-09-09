// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ROUND-3 REGRESSION COVER — two refusals that described a gate other than their own.
 *
 * (1) src/http.ts, the startup key gate. Its last line used to read
 *     "Çözüm: doğru AEGIS_MASTER_KEY'i geri koy ya da kullanıcıları yeniden bağla." The
 *     second half of that sentence stopped being possible when round 2 widened the gate:
 *     ANY unreadable row now answers with `process.exit(1)`, so /connect — the only surface
 *     a tenant could reconnect through — never comes up. src/store.ts says so in its own
 *     words ("reconnecting through /connect … needs a process that starts") and carries the
 *     offline sqlite3 procedure inside the refusal precisely because nothing in-process
 *     survives. http.ts then appended advice that contradicted the paragraph directly above
 *     it.
 *
 *     This is measured, not read: the real server is started against a store holding one
 *     row written under a foreign key, and three facts are pinned together —
 *       a) the process exits 1 (the refusal is a refusal),
 *       b) the port it was told to serve on refuses a connection, so /connect genuinely is
 *          not there,
 *       c) the store's refusal reaches the operator's terminal VERBATIM, and http.ts's OWN
 *          lines — everything left after that verbatim block is subtracted — offer no route
 *          that needs the process it just killed.
 *     (c) is what makes the watcher bidirectional: putting the old sentence back turns it
 *     red, and quietly dropping the store's runnable procedure turns it red as well.
 *
 * (2) src/util.ts, `gaqlDoymaProbu`. Its refusal announced "1 ile 1000 arasında tam sayı
 *     olmalı" while the condition is only `!Number.isInteger(goster) || goster < 1` —
 *     `gaqlDoymaProbu(q, 5000)` was accepted and returned `LIMIT 5001`. Today's only caller
 *     (tools/read.ts) constrains the value with zod `.max(1000)`, so nothing measurable
 *     broke; what broke is the sentence, in the one function whose comment states that this
 *     repository never silently corrects a value.
 *
 *     The watcher does not pin the wording. It reads the refusal the gate itself prints and
 *     requires every number named in it to be a REAL edge of that gate's behaviour: the
 *     verdict must change adjacent to the number. "1" survives that (0 refused, 1 accepted);
 *     "1000" cannot (999, 1000 and 1001 are all accepted). So the message may be reworded
 *     freely, may even gain a genuinely enforced ceiling, but can never again advertise a
 *     limit the code does not apply.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createCipheriv } from "node:crypto";
import { gaqlDoymaProbu } from "../src/util.js";

const ANAHTAR = "onarim3-http-util-testi-32-bayttan-uzun-anahtar";
process.env.AEGIS_MASTER_KEY = ANAHTAR;
// store.ts reads the master key while it loads, so it is imported AFTER the key is set.
const { UserStore } = await import("../src/store.js");

const KOK = join(dirname(fileURLToPath(import.meta.url)), "..");
const KLASOR = mkdtempSync(join(tmpdir(), `aegis-onarim3-${process.pid}-`));

after(() => {
  try {
    rmSync(KLASOR, { recursive: true, force: true });
  } catch {
    /* still locked on Windows — a temp directory is not worth failing a suite over */
  }
});

/**
 * A well-formed package written under a FOREIGN key: 12-byte IV, 16-byte tag, non-empty
 * body. It clears decryptSecret's shape check and fails only on authentication — which is
 * exactly what a row left behind by a rotated key or a foreign restore looks like.
 */
function yabanciPaket(duz: string): string {
  const anahtar = randomBytes(32);
  const iv = randomBytes(12);
  const sifre = createCipheriv("aes-256-gcm", anahtar, iv);
  const govde = Buffer.concat([sifre.update(duz, "utf8"), sifre.final()]);
  return [iv.toString("base64"), sifre.getAuthTag().toString("base64"), govde.toString("base64")].join(".");
}

/** Two tenants, the second one unreadable: the smallest store the startup gate must refuse. */
function kirikDepo(etiket: string): string {
  const yol = join(KLASOR, `${etiket}.db`);
  const depo = new UserStore(yol);
  depo.upsertUser({ subject: "sub-1", email: "kiraci1@ornek.com", refreshToken: "jeton-GIZLI-1" });
  depo.upsertUser({ subject: "sub-2", email: "kiraci2@ornek.com", refreshToken: "jeton-GIZLI-2" });
  depo.close();
  const db = new DatabaseSync(yol);
  try {
    db.prepare("UPDATE users SET refresh_token_enc = ? WHERE id = ?").run(yabanciPaket("jeton-GIZLI-2"), 2);
  } finally {
    db.close();
  }
  return yol;
}

/** The refusal the store produces for this exact database — computed, never hand-copied. */
function depoRetMetni(yol: string): string {
  const depo = new UserStore(yol);
  try {
    const durum = depo.anahtarCalisiyorMu();
    assert.equal(typeof durum, "object", `Kapı GEÇİRDİ: ${JSON.stringify(durum)}`);
    return (durum as { hata: string }).hata;
  } finally {
    depo.close();
  }
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

/** Starts the real hosted server and reports how it died and what it said on the way out. */
function acilisiKos(dbYolu: string, port: number): Promise<{ kod: number | null; stderr: string }> {
  const surec = spawn(process.execPath, ["--import", "tsx", join(KOK, "src", "http.ts")], {
    cwd: KOK,
    env: {
      ...process.env,
      PORT: String(port),
      AEGIS_PUBLIC_URL: `http://127.0.0.1:${port}`,
      AEGIS_DB: dbYolu,
      AEGIS_MASTER_KEY: ANAHTAR,
      GOOGLE_ADS_DEVELOPER_TOKEN: "sahte-token",
      GOOGLE_ADS_CLIENT_ID: "sahte-client-id",
      GOOGLE_ADS_CLIENT_SECRET: "sahte-secret",
    },
    // stderr is the whole measurement here: it is the operator's only surface after exit.
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  surec.stderr?.on("data", (d: Buffer) => {
    stderr += String(d);
  });
  return new Promise((coz, red) => {
    const zamanlayici = setTimeout(() => {
      surec.kill();
      red(new Error(`süreç 90 sn içinde çıkmadı — stderr: ${stderr.slice(0, 800)}`));
    }, 90_000);
    surec.once("error", (e: Error) => {
      clearTimeout(zamanlayici);
      red(e);
    });
    surec.once("close", (kod: number | null) => {
      clearTimeout(zamanlayici);
      coz({ kod, stderr });
    });
  });
}

test(
  "KRİTİK: açılış kapısının reddi, süreç öldükten sonra YAPILAMAYACAK bir çözüm önermez",
  { timeout: 120_000 },
  async () => {
    const yol = kirikDepo("acilis");
    const port = await bosPort();
    const { kod, stderr } = await acilisiKos(yol, port);

    assert.equal(
      kod,
      1,
      `Açılamayan satır varken süreç ayakta kalırsa red diye bir şey yok demektir. stderr: ${stderr.slice(0, 800)}`
    );

    // The reason the old advice was impossible, measured rather than assumed.
    let baglandi = true;
    try {
      await fetch(`http://127.0.0.1:${port}/connect`);
    } catch {
      baglandi = false;
    }
    assert.equal(
      baglandi,
      false,
      "Süreç çıktığı hâlde /connect cevap veriyor — bu testin dayandığı olgu yanlış demektir."
    );

    // The store's runnable procedure must reach the terminal exactly as written: a
    // reformatted or truncated sqlite3 command is not a procedure, it is a hint.
    const depoRet = depoRetMetni(yol);
    assert.ok(
      stderr.includes(depoRet),
      `Deponun kurtarma yordamı operatörün terminaline OLDUĞU GİBİ ulaşmıyor.\n` +
        `--- beklenen ---\n${depoRet}\n--- görülen ---\n${stderr.slice(0, 1500)}`
    );
    assert.match(stderr, /sqlite3/, "Süreç dışı onarımın aracı adıyla verilmeli.");
    assert.match(stderr, /DELETE FROM users WHERE id IN \(2\);/, "Silme komutu çalıştırılabilir olmalı.");

    /**
     * Everything http.ts says on its OWN account: the store's block is subtracted, so what
     * remains is exactly the text this file is responsible for.
     */
    const kendiSozleri = stderr.split(depoRet).join(" ");
    assert.doesNotMatch(
      kendiSozleri,
      /\/connect/,
      "http.ts kendi cümlesinde /connect'e yolluyor: o sayfayı sunan süreç bir satır altta " +
        "process.exit(1) ile ölüyor. /connect'ten söz eden tek yer, silinen kiracıların onarım " +
        "SONRASINDA nasıl döneceğini anlatan depo yordamı olabilir."
    );
    assert.doesNotMatch(
      kendiSozleri,
      /yeniden bağla/i,
      "http.ts hâlâ 'kullanıcıları yeniden bağla' diyor — süreç açılmadan bağlanılacak bir " +
        "yüzey yok; operatör bu tavsiyeyi uygulayamaz."
    );
    assert.match(
      kendiSozleri,
      /Kurtarma/,
      "Red, çalıştırılabilir yordamın NEREDE olduğunu söylemeli: exit'ten sonra operatörün " +
        "başka bir yüzeyi kalmıyor."
    );
  }
);

const SORGU = "SELECT campaign.id FROM campaign";

/** Does the gate let this ceiling through? */
function kabulEdiliyorMu(tavan: number): boolean {
  try {
    gaqlDoymaProbu(SORGU, tavan);
    return true;
  } catch {
    return false;
  }
}

/** The gate's own refusal text for a ceiling it rejects. */
function redMesaji(tavan: number): string {
  try {
    gaqlDoymaProbu(SORGU, tavan);
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error(`tavan ${tavan} reddedilmedi — mesaj okunamıyor`);
}

test("KRİTİK: gaqlDoymaProbu'nun reddi, kapının UYGULAMADIĞI bir sınır ilan edemez", () => {
  /**
   * NaN is the probe value on purpose: it is refused, and it carries NO DIGITS into the
   * interpolated message, so every number left in the text is a CLAIM ABOUT THE GATE rather
   * than an echo of the caller's input.
   */
  const mesaj = redMesaji(NaN);
  assert.match(mesaj, /NaN/, "Red, reddettiği değeri yankılamalı — sondajın rakamsız olduğu buradan görülür.");

  const sayilar = [...mesaj.matchAll(/\d+/g)].map((m) => Number(m[0]));
  assert.ok(
    sayilar.length > 0,
    `Red hiçbir sınır söylemiyor: operatör neyi düzelteceğini bilemez. Mesaj: ${mesaj}`
  );

  for (const n of sayilar) {
    const kenar = kabulEdiliyorMu(n - 1) !== kabulEdiliyorMu(n) || kabulEdiliyorMu(n) !== kabulEdiliyorMu(n + 1);
    assert.ok(
      kenar,
      `Mesaj ${n} sayısını bir sınır olarak anıyor ama kapı ${n - 1}, ${n} ve ${n + 1} tavanlarına ` +
        `AYNI cevabı veriyor (${kabulEdiliyorMu(n - 1)}/${kabulEdiliyorMu(n)}/${kabulEdiliyorMu(n + 1)}). ` +
        `Uygulanmayan bir sınırı ilan eden red, kendi kapısının söylemediğini söyler. Mesaj: ${mesaj}`
    );
  }
});

test("gaqlDoymaProbu: kapının gerçek kenarı 1'dir ve üst sınır yoktur (sessiz kırpma da yok)", () => {
  assert.throws(() => gaqlDoymaProbu(SORGU, 0), /Geçersiz satır tavanı/, "0 kabul edilmemeli");
  assert.deepEqual(
    gaqlDoymaProbu(SORGU, 1),
    { sorgu: `${SORGU} LIMIT 2`, tavan: 1 },
    "1 kabul edilmeli: reddin adını verdiği alt kenar burasıdır"
  );
  /**
   * The behaviour the old message denied: a ceiling above 1000 is accepted, unchanged. If a
   * future change really does impose a ceiling, this assertion has to be rewritten in the
   * same commit as the message — which is the point.
   */
  assert.deepEqual(
    gaqlDoymaProbu(SORGU, 5000),
    { sorgu: `${SORGU} LIMIT 5001`, tavan: 5000 },
    "Tavan ne kırpılıyor ne reddediliyor: 5000 aynen geçiyor ve prob 5001 satır istiyor"
  );
});
