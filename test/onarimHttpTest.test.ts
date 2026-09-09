// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Repair regression for test/http.test.ts.
 *
 * DEFECT: in "KRİTİK: ana anahtar veritabanını ÇÖZEMİYORSA süreç açılmaz" the temp
 * database was deleted with a bare `rmSync(db, { force: true })` placed BEFORE the three
 * assertions and outside any try/catch. On Windows the just-killed child process can
 * still hold the SQLite handle, so that unlink throws EPERM (`force: true` suppresses
 * ENOENT only) and the test dies THERE - having measured neither the exit code nor the
 * operator message. The gate itself is never exercised.
 *
 * That is damage in both directions: a genuinely removed startup gate produces the same
 * red as a locked file, so the watchman's colour no longer distinguishes a broken product
 * from environment noise. The sibling helper in the same file (`zayifAnahtarlaBaslat`)
 * already knew the trap and cleans up inside try/catch across `-wal`/`-shm`; this test
 * had drifted outside that discipline.
 *
 * FIX: assertions first, cleanup in `finally`, every unlink guarded.
 *
 * These checks are structural on purpose - the subject under repair IS a test, and what
 * broke was the ORDER of its statements, which no runtime observation of a green run can
 * pin down. The repo already tests source text this way (kaynakHijyeni, belgeTutarliligi).
 */

const KAYNAK = readFileSync(new URL("./http.test.ts", import.meta.url), "utf8");
const BASLIK = "KRİTİK: ana anahtar veritabanını ÇÖZEMİYORSA süreç açılmaz";

/** Returns the source text of one `test("<baslik>", ...)` block, up to the next test. */
function testGovdesi(baslik: string): string {
  const bas = KAYNAK.indexOf(`test("${baslik}"`);
  assert.notEqual(bas, -1, `test/http.test.ts içinde bulunamadı: ${baslik}`);
  const kalan = KAYNAK.slice(bas + 1);
  const son = kalan.indexOf("\ntest(");
  return son === -1 ? kalan : kalan.slice(0, son);
}

test("KRİTİK anahtar testi: temizlik İDDİALARDAN SONRA koşar", () => {
  const govde = testGovdesi(BASLIK);

  const sonIddia = govde.lastIndexOf("assert.");
  const sonTemizlik = govde.lastIndexOf("rmSync(");
  assert.notEqual(sonIddia, -1, "test iddiasız kalmış olamaz");
  assert.notEqual(sonTemizlik, -1, "test geçici veritabanını temizlemeli");

  assert.ok(
    sonTemizlik > sonIddia,
    "geçici veritabanının silinmesi İDDİALARDAN SONRA gelmeli: kilitli bir dosya (Windows'ta " +
      "EPERM) testi iddialara HİÇ ulaşmadan düşürürse, açılış kapısının çalışıp çalışmadığı " +
      "o koşuda ölçülmemiş olur"
  );
});

test("KRİTİK anahtar testi: temizlik `finally` içinde ve her rmSync try/catch ile sarılı", () => {
  const govde = testGovdesi(BASLIK);

  const finallyIdx = govde.indexOf("} finally {");
  assert.notEqual(finallyIdx, -1, "temizlik `finally` bloğunda olmalı — iddia kızarsa da dosya silinsin");

  const ilkIddia = govde.indexOf("assert.");
  assert.ok(
    ilkIddia !== -1 && ilkIddia < finallyIdx,
    "iddialar `finally`den ÖNCE, yani onu koruyan `try` bloğunun içinde olmalı"
  );
  const tryIdx = govde.lastIndexOf("try {", ilkIddia);
  assert.ok(tryIdx !== -1, "iddiaları saran bir `try {` bulunmalı");

  const temizlik = govde.slice(finallyIdx);
  assert.match(temizlik, /rmSync\(/, "silme çağrısı `finally` içinde olmalı");
  assert.match(
    temizlik,
    /catch\s*(\([^)]*\)\s*)?\{/,
    "rmSync try/catch ile sarılmalı: `force: true` yalnız ENOENT'i bastırır, dosya KİLİDİNİ değil"
  );
  for (const ek of ["-wal", "-shm"]) {
    assert.ok(
      temizlik.includes(ek),
      `SQLite yan dosyası ${ek} da temizlenmeli (kardeş yardımcı zayifAnahtarlaBaslat ile aynı kalıp)`
    );
  }
});

/**
 * The premise of the whole repair, measured rather than asserted from memory: an open
 * SQLite handle makes `rmSync(..., { force: true })` THROW. Windows only - POSIX unlinks
 * an open file happily, which is exactly why the bug was invisible outside Windows.
 */
test(
  "kanıt: kilitli SQLite dosyasında rmSync(force:true) FIRLATIR",
  { skip: process.platform !== "win32" ? "yalnız Windows'ta anlamlı" : false },
  () => {
    const yol = join(tmpdir(), `aegis-onarim-kilit-${process.pid}-${Date.now()}.db`);
    const db = new DatabaseSync(yol);
    try {
      db.exec("CREATE TABLE t (a INTEGER)");
      assert.throws(
        () => rmSync(yol, { force: true }),
        (e: NodeJS.ErrnoException) => e.code === "EPERM" || e.code === "EBUSY",
        "açık tanıtıcılı dosyada force:true silmeyi kurtarmaz — bu yüzden temizlik try/catch ister"
      );
    } finally {
      db.close();
      for (const ek of ["", "-wal", "-shm"]) {
        try {
          rmSync(yol + ek, { force: true });
        } catch {
          /* file still locked on Windows */
        }
      }
    }
  }
);
