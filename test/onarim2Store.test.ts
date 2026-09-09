// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ROUND-2 REGRESSION COVER FOR THE STARTUP GATE'S RECOVERY ROUTE.
 *
 * Round 1 widened `UserStore.anahtarCalisiyorMu()` from a single sampled row to every row,
 * which was right: a store holding rows written under different keys must REFUSE. The
 * independent reviewer then found what the widening cost. The gate's only caller
 * (src/http.ts:110) answers a refusal with `process.exit(1)`, so ANY unreadable row now
 * holds the whole process down — and under systemd `Restart=` or Docker `--restart
 * unless-stopped` that is a crash loop, not a stop. Meanwhile there is no way out:
 *
 *   - the codebase has NO user-deletion path (`grep -rn "DELETE FROM users|deleteUser"`
 *     over src/ scripts/ test/ deploy/ returns nothing),
 *   - http.ts's own advice — "kullanıcıları yeniden bağla" — needs /connect, which needs a
 *     process that starts,
 *   - deploy/README.md reaches for sqlite3 only in the backup section.
 *
 * Two properties close that, and both live in the refusal text because after `process.exit`
 * there is no other surface left to carry them:
 *
 *   1) THE WHOLE CENSUS. Returning at the first failure named ONE row. Measured against the
 *      pre-fix code on a four-tenant store with rows #2 and #4 written under a foreign key,
 *      the gate said exactly `{"hata":"kayıt #2: Unsupported state or unable to
 *      authenticate data"}` — so the operator deletes #2, restarts into the crash loop, and
 *      only then learns about #4. One restart per broken row.
 *   2) A RUNNABLE WAY OUT, in the order that cannot lose data: back up, restore the key,
 *      and only then delete — naming ONLY the unreadable rows.
 *
 * WHAT THESE TESTS MUST NOT LET THROUGH: a "recovery" that relaxes the gate. Every
 * assertion below is paired with one that keeps the refusal a refusal — one unreadable row
 * still stops the process, a healthy store still passes, and no email, secret or subject
 * joins the row ids on their way to the operator's terminal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createCipheriv } from "node:crypto";

process.env.AEGIS_MASTER_KEY = "onarim2-store-testi-32-bayttan-uzun-anahtar";

const { UserStore } = await import("../src/store.js");

const KLASOR = mkdtempSync(join(tmpdir(), `aegis-onarim2-store-${process.pid}-`));

/**
 * A well-formed package written under a FOREIGN key: 12-byte IV, 16-byte tag, non-empty
 * body, so it clears decryptSecret's structural shape check and fails only on
 * authentication — exactly what a row left behind by another key looks like.
 */
function yabanciPaket(duz: string): string {
  const anahtar = randomBytes(32);
  const iv = randomBytes(12);
  const sifre = createCipheriv("aes-256-gcm", anahtar, iv);
  const govde = Buffer.concat([sifre.update(duz, "utf8"), sifre.final()]);
  return [iv.toString("base64"), sifre.getAuthTag().toString("base64"), govde.toString("base64")].join(".");
}

/** Builds a store with `adet` tenants and rewrites the ciphertext of `kirikIdler` in place. */
function depoKur(etiket: string, adet: number, kirikIdler: number[]): string {
  const yol = join(KLASOR, `${etiket}.db`);
  const depo = new UserStore(yol);
  for (let i = 1; i <= adet; i++) {
    depo.upsertUser({ subject: `sub-${i}`, email: `kiraci${i}@ornek.com`, refreshToken: `jeton-GIZLI-${i}` });
  }
  depo.close();
  const db = new DatabaseSync(yol);
  try {
    for (const id of kirikIdler) {
      db.prepare("UPDATE users SET refresh_token_enc = ? WHERE id = ?").run(yabanciPaket(`jeton-GIZLI-${id}`), id);
    }
  } finally {
    db.close();
  }
  return yol;
}

function ret(yol: string): string {
  const depo = new UserStore(yol);
  try {
    const durum = depo.anahtarCalisiyorMu();
    assert.equal(typeof durum, "object", `Kapı GEÇİRDİ: ${JSON.stringify(durum)}`);
    return (durum as { hata: string }).hata;
  } finally {
    depo.close();
  }
}

/**
 * THE HEADLINE REGRESSION. The pre-fix gate returned at the first failure, so the second
 * broken row was invisible until the next restart — and the process is in a restart loop
 * precisely because it refuses.
 */
test("KRİTİK: açılamayan HER satır tek seferde bildirilir, ilkinde durulmaz", () => {
  const hata = ret(depoKur("cok-kirik", 4, [2, 4]));

  assert.match(hata, /#2/, "İlk kırık satır adıyla söylenmeli.");
  assert.match(
    hata,
    /#4/,
    "İKİNCİ kırık satır bildirilmedi: operatör #2'yi onarıp yeniden başlatır, çökme " +
      "döngüsünün bir turu daha döner ve #4'ü ancak o zaman öğrenir — kırık satır başına " +
      "bir yeniden başlatma."
  );
  assert.match(
    hata,
    /2\/4/,
    "Sayım yok: dört kayıttan ikisinin kırık olmasıyla dördünün de kırık olması aynı " +
      "ekranı verirse teşhis (tek satırlık geri yükleme mi, döndürülmüş anahtar mı) " +
      "operatöre kalır."
  );
});

/**
 * The way out has to be IN the refusal: there is no in-process route left. `process.exit(1)`
 * has already happened by the time anyone could open /connect or call an MCP tool.
 */
test("ret metni çalıştırılabilir bir kurtarma yordamı taşır: yedek → anahtar → silme", () => {
  const yol = depoKur("kurtarma", 3, [2]);
  const hata = ret(yol);

  assert.match(hata, /sqlite3/, "Süreç dışı onarımın aracı adıyla verilmeli.");
  assert.match(hata, /\.backup/, "Silmeden ÖNCE yedek adımı olmalı (WAL modunda dosya kopyalamak bozuk yedek verir).");
  assert.match(hata, /AEGIS_MASTER_KEY/, "Veri kaybetmeyen çözüm (doğru anahtarı geri koymak) önce önerilmeli.");
  assert.match(hata, /DELETE FROM users WHERE id IN \(2\);/, "Silme komutu olduğu gibi çalıştırılabilir olmalı.");
  assert.match(hata, /\/connect/, "Silinen kiracının nasıl geri döneceği yazılmalı.");
  assert.ok(
    hata.includes(yol),
    `Açılan dosyanın yolu yazılmamış: kurtarma komutu YANLIŞ dosyaya karşı koşulabilir ` +
      `(varsayilanYol() eski 'adspilot.db'ye düşmüş olabilir). Metin: ${hata}`
  );

  // The order is load-bearing: a DELETE that lands before the backup is unrecoverable.
  assert.ok(
    hata.indexOf(".backup") < hata.indexOf("DELETE FROM users"),
    "Yedek adımı silme adımından SONRA gelirse yordam veri kaybettirir."
  );
});

/**
 * The recovery command must never invite the operator to delete a row that OPENS. A
 * readable row deleted here is a live tenant thrown out of a store that was only partly
 * broken.
 */
test("silme komutu YALNIZ açılamayan satırları adlandırır, okunabilenlere dokunmaz", () => {
  const hata = ret(depoKur("secici", 5, [2, 5]));
  const komut = /DELETE FROM users WHERE id IN \(([^)]*)\);/.exec(hata);
  assert.ok(komut, `Silme komutu bulunamadı: ${hata}`);
  assert.deepEqual(
    komut[1].split(",").map((p) => Number(p.trim())),
    [2, 5],
    "Komut, açılabilen bir satırı (1, 3, 4) siliyor ya da kırık bir satırı atlıyor."
  );
});

/**
 * A wholesale failure (a rotated key, a foreign restore) must not turn one fatal line into
 * thousands — but a truncated list may not leave an ellipsis inside SQL either: the command
 * is copy-pasted, so it has to stay valid, and what it does NOT cover has to be said.
 */
test("kırık satır sayısı tavanı aşınca liste kırpılır ama komut geçerli SQL kalır", () => {
  const idler = Array.from({ length: 23 }, (_, i) => i + 1);
  const hata = ret(depoKur("tavan", 23, idler));

  assert.match(hata, /23\/23/, "Toplam sayı kırpmadan etkilenmemeli.");
  const komut = /DELETE FROM users WHERE id IN \(([^)]*)\);/.exec(hata);
  assert.ok(komut, `Silme komutu bulunamadı: ${hata}`);
  const listelenen = komut[1].split(",").map((p) => p.trim());
  assert.equal(listelenen.length, 20, "Liste tavanı 20 satır olmalı.");
  for (const p of listelenen) {
    assert.match(p, /^\d+$/, `SQL içinde rakam olmayan bir parça var ('${p}') — komut olduğu gibi koşmaz.`);
  }
  assert.match(hata, /kalan 3 satır/, "Kırpılan satırların varlığı SESSİZCE geçilemez.");
});

/**
 * THE GATE IS NOT RELAXED. Everything above adds text to a refusal; none of it may turn a
 * refusal into a pass.
 */
test("kurtarma metni kapıyı gevşetmez: tek kırık satır hâlâ REDDEDİLİR", () => {
  const depo = new UserStore(depoKur("tek-kirik", 3, [3]));
  try {
    const durum = depo.anahtarCalisiyorMu();
    assert.equal(typeof durum, "object", "Tek bir açılamayan satır bile GEÇEMEZ.");
    assert.match((durum as { hata: string }).hata, /#3/);
  } finally {
    depo.close();
  }
});

test("sağlam depo 'calisiyor', boş depo 'bos' döner (yanlış alarm yok)", () => {
  const saglam = new UserStore(depoKur("saglam", 3, []));
  try {
    assert.equal(saglam.anahtarCalisiyorMu(), "calisiyor");
  } finally {
    saglam.close();
  }
  const bos = new UserStore(join(KLASOR, "bos.db"));
  try {
    assert.equal(bos.anahtarCalisiyorMu(), "bos");
  } finally {
    bos.close();
  }
});

/**
 * The refusal grew; what it may CARRY did not. Row ids, counts and the operator's own file
 * path are operational facts — emails, ciphertext and secrets are not.
 */
test("büyüyen ret metni hâlâ PII ya da sır taşımaz", () => {
  const hata = ret(depoKur("sizinti", 4, [2, 4]));
  for (const yasak of ["kiraci1@ornek.com", "kiraci2@ornek.com", "jeton-GIZLI-2", "jeton-GIZLI-4", "sub-2"]) {
    assert.ok(!hata.includes(yasak), `Ret metni '${yasak}' sızdırdı: ${hata}`);
  }
});

process.on("exit", () => {
  try {
    rmSync(KLASOR, { recursive: true, force: true });
  } catch {
    /* the files may still be locked on Windows */
  }
});
