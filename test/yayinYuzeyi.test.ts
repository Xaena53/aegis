// SPDX-License-Identifier: AGPL-3.0-only
/**
 * YAYIN YÜZEYİ — TLS'in atlanabildiği yer.
 *
 * NEDEN VAR: sunucu düz HTTP konuşur, şifrelemeyi önündeki nginx/Caddy sonlandırır.
 * docker-compose ve iki belge portu `8787:8787` diye yayınlıyordu; yayın adresi
 * yazılmadığında Docker 0.0.0.0'a bağlar ve 443'ün YANINDA şifresiz bir kapı açılır.
 * O kapıdan /connect ile /settings düz HTTP yanıtlar, /mcp için doğru Host başlığı
 * yeter — yani ters vekil, saldırgan için isteğe bağlı olur. Sunucunun uyarısı da tam
 * bu iki yapılandırmada (https PUBLIC_URL, ya da localhost PUBLIC_URL) SUSUYORDU.
 *
 * Buradaki testler iki bekçiyi birden tutar: (1) örnek/dağıtım artefaktları loopback'e
 * yayınlar, (2) süreç düz metin durumunu yayın biçiminden BAĞIMSIZ olarak söyler ve
 * şifresiz bir genel adreste açık onay olmadan HİÇ dinlemez.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duzMetinKarari, yerelAdres } from "../src/config.js";

const KOK = join(import.meta.dirname, "..");

/* ── 1) Artefaktlar: yayın loopback'e sabitlenmiş mi ─────────────────────────── */

/**
 * Kapsam bilerek geniş: bir sonraki kopyala-yapıştır hangi belgeye düşerse düşsün
 * yakalansın. `docker run -p ...` ve compose'un `- "..."` port satırlarını arar.
 */
const ARTEFAKTLAR = [
  "docker-compose.yml",
  "docs/DOCKER.md",
  "docs/DEMO.md",
  "deploy/README.md",
  "README.md",
  "README.tr.md",
];

test("örnek dağıtımlar 8787'i YALNIZ loopback'e yayınlar (TLS atlanamasın)", () => {
  const desen = /(?:-p\s+|-\s*")((?:[0-9a-fA-F.:]+:)?)(\d+):8787/g;
  const suclular: string[] = [];
  let toplam = 0;
  for (const ad of ARTEFAKTLAR) {
    const metin = readFileSync(join(KOK, ad), "utf8");
    for (const m of metin.matchAll(desen)) {
      toplam++;
      if (m[1] !== "127.0.0.1:") suclular.push(`${ad}: '${m[0].trim()}'`);
    }
  }
  // Desen bayatlarsa test sessizce "hiçbir şey bulamadım" deyip yeşil kalmasın.
  assert.ok(toplam >= 4, `port yayını hiç bulunamadı (${toplam}) — desen bayatlamış olabilir`);
  assert.deepEqual(
    suclular,
    [],
    "port 0.0.0.0'a yayınlanıyor: şifreli 443'ün yanında şifresiz bir kapı açılır — '127.0.0.1:' öneki şart"
  );
});

/* ── 2) Karar: yayın biçiminden bağımsız ─────────────────────────────────────── */

test("düz HTTP dinleyici loopback dışına bağlıysa PUBLIC_URL https olsa DA uyarılır", () => {
  const k = duzMetinKarari({ bind: "0.0.0.0", publicUrl: "https://ads.ornek.com", izinVerildi: false });
  assert.equal(k.engel, undefined, "https genel adres engel değildir");
  assert.match(String(k.uyari), /127\.0\.0\.1/, "0.0.0.0 dinleyicisi için uyarı susmamalı");
});

test("yalnız loopback'e bağlı yerel koşu ne engellenir ne uyarılır", () => {
  assert.deepEqual(duzMetinKarari({ bind: "127.0.0.1", publicUrl: "http://localhost:8787", izinVerildi: false }), {});
});

test("şifresiz genel adres AÇIK ONAY olmadan engeldir (kapalı arıza)", () => {
  const k = duzMetinKarari({ bind: "0.0.0.0", publicUrl: "http://ads.ornek.com", izinVerildi: false });
  assert.match(String(k.engel), /ADSPILOT_ALLOW_PLAINTEXT/);
});

test("açık onay verilince engel kalkar ama uyarı susmaz", () => {
  const k = duzMetinKarari({ bind: "0.0.0.0", publicUrl: "http://ads.ornek.com", izinVerildi: true });
  assert.equal(k.engel, undefined);
  assert.match(String(k.uyari), /ONAYLANDI/);
});

test("çözümlenemeyen PUBLIC_URL 'temiz' sayılmaz", () => {
  const k = duzMetinKarari({ bind: "127.0.0.1", publicUrl: "bu-bir-url-degil", izinVerildi: false });
  assert.match(String(k.uyari), /DOĞRULANAMADI/);
});

test("127.0.0.0/8'in tamamı loopback sayılır", () => {
  assert.equal(yerelAdres("127.9.9.9"), true);
  assert.equal(yerelAdres("[::1]"), true);
  assert.equal(yerelAdres("10.0.0.5"), false);
});

/* ── 3) Süreç davranışı: engel varsa HİÇ dinlemez ────────────────────────────── */

const PORT = 9400 + (process.pid % 180);
const DB = join(tmpdir(), `adspilot-yayin-${process.pid}.db`);

function sunucuyuKostur(ek: Record<string, string>): Promise<{ kod: number | null; hata: string; cikti: string }> {
  return new Promise((coz) => {
    const p = spawn(process.execPath, ["--import", "tsx", "src/http.ts"], {
      cwd: KOK,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: String(PORT),
        ADSPILOT_DB: DB,
        ADSPILOT_MASTER_KEY: "a".repeat(64),
        GOOGLE_ADS_DEVELOPER_TOKEN: "sahte-token",
        GOOGLE_ADS_CLIENT_ID: "sahte-client-id",
        GOOGLE_ADS_CLIENT_SECRET: "sahte-secret",
        ADSPILOT_ALLOW_PLAINTEXT: "",
        ...ek,
      },
    });
    let cikti = "";
    let hata = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c) => {
      cikti += c;
      // Dinlemeye başladıysa kararı vermiş demektir; süreci bekletmeye gerek yok.
      if (/dinliyor/.test(cikti)) setTimeout(() => p.kill(), 150);
    });
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (c) => (hata += c));
    p.on("exit", (kod) => coz({ kod, hata, cikti }));
  });
}

test("şifresiz genel adreste süreç BAŞLAMAZ (onay yoksa)", async () => {
  const r = await sunucuyuKostur({ ADSPILOT_PUBLIC_URL: `http://ads.ornek.test:${PORT}` });
  assert.equal(r.kod, 1, `süreç dinlemeye geçmemeliydi — çıktı: ${r.cikti.slice(0, 200)}`);
  assert.doesNotMatch(r.cikti, /dinliyor/, "engel varken hiçbir port açılmamalı");
  assert.match(r.hata, /ADSPILOT_ALLOW_PLAINTEXT/);
  rmSync(DB, { force: true });
});

test("https PUBLIC_URL ile bile 0.0.0.0 dinleyicisi uyarıyı yazar", async () => {
  const r = await sunucuyuKostur({
    ADSPILOT_PUBLIC_URL: `https://ads.ornek.test`,
    ADSPILOT_BIND: "0.0.0.0",
  });
  assert.match(r.cikti, /dinliyor/, `süreç ayağa kalkmalıydı — stderr: ${r.hata.slice(0, 300)}`);
  assert.match(r.hata, /UYARI:.*127\.0\.0\.1/s, "yayın biçiminden bağımsız uyarı susmamalı");
  rmSync(DB, { force: true });
});
