// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Regression cover for the startup gate `UserStore.anahtarCalisiyorMu()`.
 *
 * The gate had NO test at all: before this file, the only caller was src/http.ts:110, where
 * a wrong answer costs the whole process (`process.exit(1)`) or — worse — a silent green
 * light over a store it cannot read.
 *
 * The defect these tests lock down: the gate used to sample ONE row
 * (`SELECT refresh_token_enc FROM users ORDER BY id LIMIT 1`) and generalise from it, on the
 * comment's reasoning that "the key either opens all of them or none". Rows encrypted under
 * DIFFERENT keys can sit side by side — a partial restore, a row merged back from an older
 * backup, a key rotation caught halfway — and when the sampled row was one of the readable
 * ones the gate answered 'calisiyor'. The process then came up healthy and the tenants whose
 * rows were written under the other key met exactly the unexplained 500 the gate exists to
 * prevent. A contradictory store must REFUSE, not pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createCipheriv } from "node:crypto";

process.env.AEGIS_MASTER_KEY = "onarim-store-testi-32-bayttan-uzun-anahtar";

const { UserStore } = await import("../src/store.js");

const KLASOR = mkdtempSync(join(tmpdir(), `aegis-onarim-store-${process.pid}-`));

function yeniYol(etiket: string): string {
  return join(KLASOR, `${etiket}.db`);
}

/**
 * A well-formed package written under a FOREIGN key: 12-byte IV, 16-byte tag, non-empty
 * body, so it clears decryptSecret's structural shape check and fails only on
 * authentication. That is precisely what a row left behind by another key looks like — not
 * a corrupt string that any cheap check would have caught.
 */
function yabanciPaket(duz: string): string {
  const anahtar = randomBytes(32);
  const iv = randomBytes(12);
  const sifre = createCipheriv("aes-256-gcm", anahtar, iv);
  const govde = Buffer.concat([sifre.update(duz, "utf8"), sifre.final()]);
  return [iv.toString("base64"), sifre.getAuthTag().toString("base64"), govde.toString("base64")].join(".");
}

/** Rewrites one row's ciphertext directly, the way a restore or a merge would. */
function satiriYabancilastir(yol: string, id: number, duz: string): void {
  const db = new DatabaseSync(yol);
  try {
    db.prepare("UPDATE users SET refresh_token_enc = ? WHERE id = ?").run(yabanciPaket(duz), id);
  } finally {
    db.close();
  }
}

function ikiKiraciliDepo(etiket: string): string {
  const yol = yeniYol(etiket);
  const depo = new UserStore(yol);
  depo.upsertUser({ subject: "sub-1", email: "bir@ornek.com", refreshToken: "jeton-BIR" });
  depo.upsertUser({ subject: "sub-2", email: "iki@ornek.com", refreshToken: "jeton-IKI" });
  depo.close();
  return yol;
}

test("boş depo meşru bir durumdur: 'bos' döner", () => {
  const depo = new UserStore(yeniYol("bos"));
  try {
    assert.equal(depo.anahtarCalisiyorMu(), "bos");
  } finally {
    depo.close();
  }
});

test("her satır aynı anahtarla yazılmışsa 'calisiyor' döner", () => {
  const yol = ikiKiraciliDepo("saglam");
  const depo = new UserStore(yol);
  try {
    assert.equal(depo.anahtarCalisiyorMu(), "calisiyor");
  } finally {
    depo.close();
  }
});

/**
 * THE REGRESSION. Row #1 opens, row #2 does not. Sampling only the oldest row reports
 * 'calisiyor' here — a green gate over a store with an unreadable tenant in it.
 */
test("KRİTİK: ilk satır açılıyor ama başka bir satır açılmıyorsa kapı GEÇİRMEZ", () => {
  const yol = ikiKiraciliDepo("karisik");
  satiriYabancilastir(yol, 2, "jeton-IKI");

  const depo = new UserStore(yol);
  try {
    const durum = depo.anahtarCalisiyorMu();
    assert.notEqual(
      durum,
      "calisiyor",
      "Karışık depo GEÇTİ: en eski satır okunabildiği için kapı, açamadığı bir satırın " +
        "üzerinden yeşil yandı — kiracı ilk isteğinde sebepsiz 500 alır."
    );
    assert.equal(typeof durum, "object");
    assert.match((durum as { hata: string }).hata, /#2/, "Açılamayan satırın kimliği operatöre söylenmeli.");
  } finally {
    depo.close();
  }
});

/**
 * The complementary direction: the sample being the BROKEN row was the only case the old
 * code caught. It must keep refusing — the fix widens the gate's reach, it does not move it.
 */
test("ilk satır açılmıyorsa kapı yine reddeder (eski davranış korunur)", () => {
  const yol = ikiKiraciliDepo("ilki-bozuk");
  satiriYabancilastir(yol, 1, "jeton-BIR");

  const depo = new UserStore(yol);
  try {
    const durum = depo.anahtarCalisiyorMu();
    assert.equal(typeof durum, "object");
    assert.match((durum as { hata: string }).hata, /#1/);
  } finally {
    depo.close();
  }
});

/**
 * The whole store written under another key — the rotation / "restored from another
 * installation" case named in the gate's own docblock.
 */
test("tüm depo başka bir anahtarla yazılmışsa reddeder", () => {
  const yol = ikiKiraciliDepo("tumu-yabanci");
  satiriYabancilastir(yol, 1, "jeton-BIR");
  satiriYabancilastir(yol, 2, "jeton-IKI");

  const depo = new UserStore(yol);
  try {
    assert.equal(typeof depo.anahtarCalisiyorMu(), "object");
  } finally {
    depo.close();
  }
});

/**
 * The refusal text goes to stderr in http.ts. It names the row, and nothing else about it:
 * no email, no ciphertext, no plaintext secret.
 */
test("ret metni PII ya da sır taşımaz: yalnız satır kimliği", () => {
  const yol = ikiKiraciliDepo("sizinti");
  satiriYabancilastir(yol, 2, "jeton-IKI");

  const depo = new UserStore(yol);
  try {
    const durum = depo.anahtarCalisiyorMu() as { hata: string };
    assert.equal(typeof durum, "object");
    for (const yasak of ["iki@ornek.com", "bir@ornek.com", "jeton-IKI", "jeton-BIR", "sub-2"]) {
      assert.ok(!durum.hata.includes(yasak), `Ret metni '${yasak}' sızdırdı: ${durum.hata}`);
    }
  } finally {
    depo.close();
  }
});

process.on("exit", () => {
  try {
    rmSync(KLASOR, { recursive: true, force: true });
  } catch {
    /* the files may still be locked on Windows */
  }
});
