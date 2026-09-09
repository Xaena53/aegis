// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PHASE 4 — src/store.ts: a BLANK tenant key is not an ABSENT one, and the pointer the file
 * gives to its own guard has to lead somewhere.
 *
 * WHAT WAS MEASURED (before the fix, on a scratch store):
 *   1) `upsertUser({ subject: "", ... })` wrote the row with google_sub = "" — a TEXT value,
 *      not NULL. The reason is that one field was read with two different notions of
 *      emptiness: the lookup and the takeover gate ask whether `subject` is TRUTHY, the
 *      INSERT asks whether it is NULLISH (`?? null`). An empty string walks between them.
 *   2) The takeover gate then read that row back as UNLINKED, so a later login with a
 *      DIFFERENT `sub` on the same e-mail CLAIMED it: measured, row #1 kept the victim's
 *      login_customer_id (111-222-3333) and budget ceiling (50) while the victim's API key
 *      stopped resolving. That is precisely the takeover the gate exists to refuse.
 *   3) A second blank subject failed the other way, with SQLite's raw
 *      "UNIQUE constraint failed: users.google_sub" escaping to the caller.
 *   4) `findById` reported that same row as `googleSub: undefined`, i.e. as unowned — the
 *      store agreeing with itself only by repeating the mistake.
 *
 * The fix goes in the FAIL-CLOSED direction rather than normalising quietly: a blank subject
 * is REFUSED at the entrance (a caller with no subject omits the field), a stored blank
 * google_sub counts as ownership that cannot be READ and is therefore never handed over, and
 * rowToUser reports the stored value as it stands. Only SQL NULL means "never linked".
 *
 * The last test is the DOCUMENT guard, and it is deliberately two-directional: the comment
 * over ANAHTAR_TUZU used to name `test/anahtarBelgesi.ts`, a file that does not exist, while
 * the real guard sat in test/store.test.ts. It goes red if that sentence goes stale again
 * (a named file that is not there, or a named file that no longer holds the guard) and just
 * as red if the guard itself moves or is renamed away from under the sentence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

process.env.AEGIS_MASTER_KEY = "faz4-store-testi-32-bayttan-uzun-anahtar";

const { UserStore, encryptSecret, decryptSecret } = await import("../src/store.js");

const KOK = fileURLToPath(new URL("..", import.meta.url));
const KLASOR = mkdtempSync(join(tmpdir(), `aegis-faz4-store-${process.pid}-`));
let sayac = 0;

/** A fresh store plus a raw handle on the SAME file, so the row can be read UNFILTERED. */
function yeniDepo(): { depo: InstanceType<typeof UserStore>; ham: DatabaseSync } {
  const yol = join(KLASOR, `faz4-${++sayac}.db`);
  const depo = new UserStore(yol);
  return { depo, ham: new DatabaseSync(yol) };
}

/** Writes the row a PRE-FIX build could produce: an owner column holding a blank string. */
function eskiBosSubSatiri(ham: DatabaseSync, eposta: string): number {
  ham
    .prepare(
      `INSERT INTO users (google_sub, email, refresh_token_enc, api_key_hash, login_customer_id, max_daily_budget)
       VALUES ('', ?, ?, ?, ?, ?)`
    )
    .run(eposta, encryptSecret("kurban-token"), `hash-${eposta}`, "111-222-3333", 50);
  return Number((ham.prepare("SELECT id FROM users WHERE email = ?").get(eposta) as any).id);
}

test("BOŞ subject REDDEDİLİR: ne satır yazılır ne de google_sub='' doğar", () => {
  const { depo, ham } = yeniDepo();
  try {
    for (const kotu of ["", "   ", "\t\n"]) {
      assert.throws(
        () => depo.upsertUser({ subject: kotu, email: "bos@ornek.com", refreshToken: "jeton" }),
        /google_sub \(subject\) boş/,
        `blank subject ${JSON.stringify(kotu)} must be refused, not written`
      );
    }
    assert.equal(
      (ham.prepare("SELECT COUNT(*) AS n FROM users").get() as any).n,
      0,
      "a refused registration must leave NO row behind"
    );

    // The refusal happens before the transaction opens, so the store is still usable: a
    // dangling BEGIN IMMEDIATE would take the next caller down with SQLITE_BUSY instead.
    const sonra = depo.upsertUser({ email: "sonra@ornek.com", refreshToken: "jeton-2" });
    assert.ok(sonra.userId > 0, "the store must stay usable after a refusal");
    assert.equal(
      (ham.prepare("SELECT COUNT(*) AS n FROM users WHERE google_sub = ''").get() as any).n,
      0,
      "no row may carry a blank google_sub"
    );
    assert.equal(
      (ham.prepare("SELECT google_sub FROM users WHERE id = ?").get(sonra.userId) as any).google_sub,
      null,
      "a subjectless registration writes SQL NULL — the only shape that means 'never linked'"
    );
  } finally {
    ham.close();
    depo.close();
  }
});

test("KRİTİK: '' google_sub taşıyan ESKİ satır DEVRALINAMAZ (okunamayan sahiplik ≠ sahipsizlik)", () => {
  const { depo, ham } = yeniDepo();
  try {
    const id = eskiBosSubSatiri(ham, "eski@ornek.com");

    assert.throws(
      () => depo.upsertUser({ subject: "sub-saldirgan", email: "eski@ornek.com", refreshToken: "saldirgan-token" }),
      /başka bir Google hesabına bağlı/,
      "a row whose ownership cannot be read is not free to claim"
    );

    // A refusal cannot be just a sentence: the row has to be untouched, including the two
    // fields the measured takeover carried over (COALESCE keeps them) and the secret.
    const satir = ham
      .prepare("SELECT google_sub, login_customer_id, max_daily_budget, refresh_token_enc FROM users WHERE id = ?")
      .get(id) as any;
    assert.equal(satir.google_sub, "", "the owner column must not be overwritten");
    assert.equal(satir.login_customer_id, "111-222-3333", "the victim's Ads customer id must not be inherited");
    assert.equal(Number(satir.max_daily_budget), 50, "the victim's ceiling must not be inherited");
    assert.equal(decryptSecret(String(satir.refresh_token_enc)), "kurban-token", "the victim's token must stand");
  } finally {
    ham.close();
    depo.close();
  }
});

test("KAPI BİR DUVAR DEĞİL: NULL sub'lı satır hâlâ sahiplenilir, aynı sub kendi satırını yeniler", () => {
  const { depo, ham } = yeniDepo();
  try {
    // The legitimate upgrade: a row opened through the stdio/test flow WITHOUT a subject is
    // linked to a Google login later. Closing this would turn a gate into a wall.
    const once = depo.upsertUser({ email: "yukselt@ornek.com", refreshToken: "ilk-token" });
    const sonra = depo.upsertUser({ subject: "sub-yukselt", email: "yukselt@ornek.com", refreshToken: "bagli-token" });
    assert.equal(sonra.userId, once.userId, "an unlinked (NULL) row must still be claimable");
    assert.equal(
      (ham.prepare("SELECT google_sub FROM users WHERE id = ?").get(once.userId) as any).google_sub,
      "sub-yukselt"
    );

    // And the same subject coming back is an ordinary renewal, e-mail change included.
    const tekrar = depo.upsertUser({ subject: "sub-yukselt", email: "yeni-adres@ornek.com", refreshToken: "yeni-token" });
    assert.equal(tekrar.userId, once.userId, "the same sub renews its own row");
    assert.equal(depo.findByApiKey(tekrar.apiKey)?.refreshToken, "yeni-token");
  } finally {
    ham.close();
    depo.close();
  }
});

test("BOŞ google_sub okunurken SAHİPSİZ gösterilmez (rowToUser sessizce düzeltmez)", () => {
  const { depo, ham } = yeniDepo();
  try {
    const id = eskiBosSubSatiri(ham, "okuma@ornek.com");
    const kirik = depo.findById(id);
    assert.ok(kirik, "the row must be readable");
    assert.equal(kirik!.googleSub, "", "a blank owner is reported as it stands, not smoothed into undefined");

    // The other half of the same rule: SQL NULL — and only NULL — reads back as undefined.
    const bagsiz = depo.upsertUser({ email: "bagsiz@ornek.com", refreshToken: "jeton" });
    assert.equal(depo.findById(bagsiz.userId)?.googleSub, undefined, "NULL is what 'never linked' looks like");
  } finally {
    ham.close();
    depo.close();
  }
});

/* ── DOCUMENT GUARD: the salt comment must point at a guard that is really there ────── */

const KAYNAK = readFileSync(join(KOK, "src/store.ts"), "utf8");

/**
 * The JSDoc block sitting directly above `const ANAHTAR_TUZU`, flattened into one line: the
 * sentences the guard reads about wrap across lines, and a regex that cannot cross a
 * ` * ` line prefix would silently find nothing — a watchdog that goes green because it
 * looked at the wrong shape.
 */
function tuzYorumBlogu(): string {
  const tanim = KAYNAK.indexOf("const ANAHTAR_TUZU");
  assert.ok(tanim > 0, "ANAHTAR_TUZU tanımı bulunamadı — gözcü boşluğa bakıyor olurdu");
  const oncesi = KAYNAK.slice(0, tanim);
  const bas = oncesi.lastIndexOf("/**");
  const son = oncesi.lastIndexOf("*/");
  assert.ok(bas >= 0 && son > bas, "ANAHTAR_TUZU'nun üstünde bir JSDoc bloğu yok");
  return oncesi
    .slice(bas, son)
    .replace(/^\s*\*\s?/gm, " ")
    .replace(/\s+/g, " ");
}

test("ANAHTAR_TUZU yorumu VAR OLAN bir bekçiyi gösteriyor ve o bekçi gerçekten bekliyor", () => {
  const blok = tuzYorumBlogu();

  // 1) Every file the block names must exist. This is the assertion the stale sentence broke:
  //    it pointed at test/anahtarBelgesi.ts, which was never a file.
  const yollar = [...blok.matchAll(/test\/[A-Za-z0-9_\-./]+\.ts/g)].map((e) => e[0]);
  assert.ok(yollar.length > 0, "the block must NAME the guard — a promise with no address is not one");
  for (const yol of yollar) {
    assert.ok(existsSync(join(KOK, yol)), `ANAHTAR_TUZU yorumu var olmayan bir dosyayı gösteriyor: ${yol}`);
  }

  // 2) The file it names as the holder of the embedded ciphertext must actually hold it.
  const nerede = blok.match(/embedded ciphertext in (test\/[A-Za-z0-9_\-./]+\.ts)/);
  assert.ok(nerede, "the block must say WHICH file carries the embedded ciphertext");
  const bekci = readFileSync(join(KOK, nerede![1]), "utf8");

  // 3) The guard's substance, measured rather than assumed: a pinned `iv.tag.data` package,
  //    and the salt REPEATED from the test's own side (importing it would measure nothing).
  //    Changing the salt in store.ts without touching the guard turns this red too.
  assert.match(
    bekci,
    /"[A-Za-z0-9+/=]{12,}\.[A-Za-z0-9+/=]{20,}\.[A-Za-z0-9+/=]{20,}"/,
    `${nerede![1]} artık gömülü şifreli metin taşımıyor — yorumun vaat ettiği bekçi yok`
  );
  const tuz = KAYNAK.match(/const ANAHTAR_TUZU = "([^"]+)"/)?.[1];
  assert.ok(tuz, "ANAHTAR_TUZU değeri okunamadı");
  assert.ok(
    bekci.includes(`"${tuz}"`),
    `${nerede![1]} tuzu ("${tuz}") kendi tarafından tekrar etmiyor — bilinen-cevap ölçümü kopmuş`
  );

  // 4) The test the sentence quotes by name must still be there under that name.
  const baslik = blok.match(/the "([^"]+)" test/);
  assert.ok(baslik, "the block must quote the guard test by name");
  assert.ok(
    bekci.includes(`test("${baslik![1]}`),
    `${nerede![1]} içinde "${baslik![1]}" adlı test yok — yorum bayatlamış ya da test yeniden adlandırılmış`
  );
});

process.on("exit", () => {
  try {
    rmSync(KLASOR, { recursive: true, force: true });
  } catch {
    /* the file may still be locked on Windows */
  }
});
