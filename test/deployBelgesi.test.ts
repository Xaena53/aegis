// SPDX-License-Identifier: AGPL-3.0-only
/**
 * deploy/README.md — THE HOSTED RUNBOOK, PINNED TO WHAT THE CODE ACTUALLY DOES.
 *
 * This file is the product's ONLY official hosted-install guide, and two things the code
 * does were missing from it entirely. Both were measured before this watcher was written:
 *
 *   1) THE NETWORK GATE WAS NEVER MENTIONED. `grep -iE "NAC|CAMARA|approver"
 *      deploy/README.md` returned ZERO matches, while `agDogrula({ simSwapWindowHours: 72 },
 *      "medium")` with no token returns `{ engel: undefined, iz: { simSwap: "kapali" } }` —
 *      i.e. an operator who follows every step on the page ends up with the product's
 *      headline control switched OFF, no query made, no warning printed, `/health` green.
 *      The page even promised the opposite: "The server refuses to start on missing or
 *      invalid configuration, so a broken deployment fails loudly instead of reporting
 *      itself healthy."
 *   2) THE OFFLINE RECOVERY HAD NO COUNTERPART. The upgrade section told the operator to
 *      put a fresh AEGIS_MASTER_KEY in .env and then "have every tenant reconnect through
 *      /connect… until they do, their first request fails". Measured on a real store whose
 *      rows were written under the previous key: the startup gate refuses (`2/2 — #1, #2`),
 *      src/http.ts answers with process.exit(1), and `Restart=on-failure` in aegis.service
 *      turns that into a crash loop. There IS no /connect to reconnect through, and no
 *      in-process way to delete a user — the only way out is the offline sqlite3 procedure
 *      that store.ts prints, which the runbook reached for only in its backup section.
 *
 * WHY EVERY TEXT ASSERTION HERE IS BIDIRECTIONAL. A doc watcher that only greps for a
 * sentence rots in one direction: the doc keeps its promise while the code drifts out from
 * under it. So each claim checked in the runbook is first PRODUCED BY RUNNING THE CODE —
 * the evidence line, the refusal text and the recovery commands are read out of live
 * return values — and only then required to appear in the page. Reword the code and this
 * test goes red; delete the paragraph and it goes red too.
 *
 * NOTHING HERE RELAXES ANYTHING. The gate is only ever read: the token-less pass and the
 * token-without-phone refusal are both asserted to keep their current, fail-closed shape,
 * and the store's refusal is asserted to stay a refusal.
 *
 * No test in this file touches the network: the token-less path makes no query at all, and
 * the configuration-fault path refuses before any channel is built.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createCipheriv } from "node:crypto";
import { agDogrula } from "../src/networkTrust.js";

const KOK = path.join(import.meta.dirname, "..");
const BELGE = readFileSync(path.join(KOK, "deploy", "README.md"), "utf8");

/**
 * The page as flowing text: blockquote markers dropped and every run of whitespace
 * collapsed, so a sentence that the file wraps across two `>` lines is still one string.
 * Without this, a watcher comparing against a runtime message would pass or fail on where
 * the paragraph happened to wrap.
 */
const DUZ = BELGE.split(/\r?\n/)
  .map((s) => s.replace(/^\s*>\s?/, ""))
  .join(" ")
  .replace(/\s+/g, " ");

/** "## Başlık" ile bir sonraki "## " arasındaki gövde. */
function bolum(basligiIceren: string): string {
  const satirlar = BELGE.split(/\r?\n/);
  const bas = satirlar.findIndex((s) => s.startsWith("## ") && s.includes(basligiIceren));
  assert.notEqual(bas, -1, `deploy/README.md içinde "${basligiIceren}" başlıklı bölüm yok`);
  const kalan = satirlar.slice(bas + 1);
  const son = kalan.findIndex((s) => s.startsWith("## "));
  return (son === -1 ? kalan : kalan.slice(0, son)).join("\n");
}

/* ── 1) Token yokken kapı SESSİZCE geçer — ve runbook bunu kodun cümlesiyle söyler ── */

test("KRİTİK: AEGIS_NAC_TOKEN yokken kapı sessizce geçer ve runbook bunu AÇIKÇA yazar", async () => {
  /**
   * The measurement and the paragraph are bound to each other: the evidence line is taken
   * from the live decision, not typed into the test, so rewording it in networkTrust.ts
   * forces the runbook to be updated in the same commit.
   */
  const karar = await agDogrula({ simSwapWindowHours: 72 }, "medium");

  assert.equal(
    karar.engel,
    undefined,
    "Token'sız kurulum artık REDDEDİYOR: bu bir sıkılaştırma olurdu ama runbook hâlâ " +
      "'kapı kapalı, sessizce geçer' diyor — belgeyi de birlikte güncelle."
  );
  assert.equal(karar.iz.simSwap, "kapali", "Token'sız durumun izi 'kapali' olmalı (yapılandırma hatası değil)");
  assert.equal(karar.kanit.length, 1, "Kapalı katman tek kanıt satırı üretmeli");

  const kanitSatiri = karar.kanit[0];
  assert.match(kanitSatiri, /AEGIS_NAC_TOKEN/, "Kanıt satırı hangi değişkenin eksik olduğunu adlandırmalı");
  assert.ok(
    DUZ.includes(kanitSatiri),
    `deploy/README.md, kapalı kapının ÜRETTİĞİ kanıt satırını taşımıyor: "${kanitSatiri}". ` +
      `Operatör bu cümleyi onay isteminde görecek; runbook'ta karşılığı yoksa neyin kapalı ` +
      `olduğunu ancak kaynağı okuyarak öğrenir.`
  );
  assert.match(
    DUZ,
    /networkascode\.nokia\.io/,
    "Runbook, token'ın nereden alınacağını söylemiyor — 'kapalı' uyarısı çıkışsız kalıyor"
  );
});

/* ── 2) Token var, numara yok: karar anında RET — runbook 'ikisi birden' diyor ─────── */

test("token var ama AEGIS_APPROVER_PHONE boşsa RET; runbook bu takası anlatıyor", async () => {
  /**
   * The other side of the same configuration: this one fails CLOSED at decision time and
   * the server still starts, which is exactly the asymmetry the runbook has to explain.
   * The refusal text is again read from the live decision.
   */
  const karar = await agDogrula({ nacToken: "TEST-ONLY-sahte-jeton-ag-cagrisi-yok", simSwapWindowHours: 72 }, "medium");

  const engel = karar.engel;
  assert.ok(engel, "Token'lı ama numarasız yapılandırma GEÇTİ — kapalı arıza ilkesi kırıldı");
  assert.equal(karar.iz.simSwap, "calismadi", "Yapılandırma hatasının izi 'calismadi' olmalı");
  assert.deepEqual(karar.kanit, [], "Reddedilen kararda insana gösterilecek kanıt satırı olmamalı");

  const bas = engel.split(" — ")[0].trim();
  assert.ok(
    DUZ.includes(bas),
    `deploy/README.md, token'lı-numarasız kurulumun ürettiği reddi anmıyor: "${bas}". ` +
      `Operatör sunucuyu sorunsuz başlatır ve arızayı ancak ilk onay isteminde görür.`
  );
  assert.match(
    DUZ,
    /AEGIS_APPROVER_PHONE/,
    "Runbook AEGIS_APPROVER_PHONE'u hiç anmıyor — token tek başına kapıyı çalıştırmaz"
  );
});

/* ── 3) "Eksik yapılandırmada açılmaz" vaadi, ağ kapısını İSTİSNA olarak anıyor mu ── */

test("'eksik yapılandırmada açılmaz' cümlesi ağ kapısı istisnasını TAŞIYOR", async () => {
  /**
   * The sentence was true for every other value on the page and false for this one. The
   * behavioural half is measured again here on purpose: if a missing token ever becomes a
   * startup fault, this test goes red and the exception has to be deleted from the page.
   */
  const karar = await agDogrula({ simSwapWindowHours: 72 }, "medium");
  assert.equal(karar.engel, undefined, "Token'sız kurulum artık reddediyorsa istisna cümlesi de kaldırılmalı");

  const vaat = "refuses to start on missing or invalid configuration";
  assert.ok(DUZ.includes(vaat), `Runbook'taki "${vaat}" vaadi bulunamadı — desen bayatlamış olabilir`);

  const i = DUZ.indexOf(vaat);
  const paragraf = DUZ.slice(i, i + 600);
  assert.match(
    paragraf,
    /AEGIS_NAC_TOKEN/,
    "Vaat, ağ kapısını istisna olarak anmıyor: sayfa 'eksik yapılandırma gürültüyle düşer' " +
      "diyor, oysa eksik AEGIS_NAC_TOKEN tam tersini yapıyor — sessizce geçiyor"
  );
  assert.match(
    paragraf,
    /exception/i,
    "İstisna, istisna olduğunu söylemeden yazılmış — okuyan cümleyi hâlâ genel kural sanır"
  );
});

/* ── 4) Depo ne basıyorsa runbook onu anlatıyor (çevrimdışı kurtarma) ──────────────── */

process.env.AEGIS_MASTER_KEY = "deploy-belgesi-testi-32-bayttan-uzun-anahtar";
const { UserStore } = await import("../src/store.js");

const KLASOR = mkdtempSync(path.join(tmpdir(), `aegis-deploy-belgesi-${process.pid}-`));

/**
 * A well-formed package written under a FOREIGN key — 12-byte IV, 16-byte tag, non-empty
 * body — which is exactly what a row left behind by the PREVIOUS master key looks like:
 * structurally valid, and failing only on authentication.
 */
function yabanciPaket(duz: string): string {
  const anahtar = randomBytes(32);
  const iv = randomBytes(12);
  const sifre = createCipheriv("aes-256-gcm", anahtar, iv);
  const govde = Buffer.concat([sifre.update(duz, "utf8"), sifre.final()]);
  return [iv.toString("base64"), sifre.getAuthTag().toString("base64"), govde.toString("base64")].join(".");
}

/** Anahtar döndürülmüş bir kurulumu taklit eder ve başlangıç kapısının ret metnini verir. */
function anahtarDondurulmusDeponunReddi(): string {
  const yol = path.join(KLASOR, "donmus.db");
  const depo = new UserStore(yol);
  for (let i = 1; i <= 4; i++) {
    depo.upsertUser({ subject: `sub-${i}`, email: `kiraci${i}@ornek.com`, refreshToken: `jeton-GIZLI-${i}` });
  }
  depo.close();

  const db = new DatabaseSync(yol);
  try {
    for (const id of [1, 2, 3, 4]) {
      db.prepare("UPDATE users SET refresh_token_enc = ? WHERE id = ?").run(yabanciPaket(`jeton-GIZLI-${id}`), id);
    }
  } finally {
    db.close();
  }

  const tekrar = new UserStore(yol);
  try {
    const durum = tekrar.anahtarCalisiyorMu();
    assert.equal(
      typeof durum,
      "object",
      `Başlangıç kapısı çözülemeyen satırları GEÇİRDİ (${JSON.stringify(durum)}) — bu bir ` +
        `gevşeme olurdu ve runbook'un anlattığı kurtarma yordamının dayanağı da kalmazdı.`
    );
    return (durum as { hata: string }).hata;
  } finally {
    tekrar.close();
    rmSync(yol, { force: true });
  }
}

test("KRİTİK: depo hangi çevrimdışı yordamı basıyorsa runbook onu anlatıyor", () => {
  /**
   * Code → doc: the two operations are extracted from the refusal the store actually
   * prints, so replacing the procedure in store.ts (a different table, a different backup
   * command) makes this red until the runbook follows.
   */
  const ret = anahtarDondurulmusDeponunReddi();

  assert.match(ret, /\.backup/, "Ret metni yedek adımını basmıyor — desen bayat");
  assert.match(ret, /DELETE FROM users WHERE id IN \(/, "Ret metni silme komutunu basmıyor — desen bayat");
  assert.match(ret, /4\/4/, "Ret metni sayımı basmıyor: operatör kaç satırın kırık olduğunu bilemez");

  const yukseltme = bolum("Upgrading");
  for (const [desen, ad] of [
    [/\.backup/, "önce yedek adımı"],
    [/DELETE FROM users/, "yalnız kırık satırların silinmesi"],
    [/sqlite3/, "çevrimdışı sqlite3 aracı"],
    [/journalctl/, "ret metninin nereden okunacağı"],
  ] as const) {
    assert.match(
      yukseltme,
      desen,
      `Yükseltme bölümü ${ad} adımını anmıyor. Süreç bu hâlde açılmadığı için operatörün ` +
        `başka yüzeyi yok: yordamın tamamı burada olmalı.`
    );
  }
});

test("KRİTİK: yükseltme yolu ÖNCE çevrimdışı onarımı, SONRA /connect'i söylüyor", () => {
  /**
   * The order is not editorial. With rows written under the old key still present the
   * process exits at startup, so /connect does not exist yet; a runbook that puts the
   * reconnect first sends the operator to a URL that cannot answer. The behavioural anchor
   * is re-measured here: the gate really does refuse such a store.
   */
  const ret = anahtarDondurulmusDeponunReddi();
  assert.ok(ret.length > 0, "Ret metni boş");

  const yukseltme = bolum("Upgrading");

  assert.match(
    yukseltme,
    /not to start|crash loop|Restart=/,
    "Yükseltme bölümü, taze anahtardan sonra servisin HİÇ AÇILMADIĞINI söylemiyor — " +
      "oysa ölçüldü: eski anahtarla yazılmış her satır süreci düşürüyor"
  );
  assert.doesNotMatch(
    yukseltme,
    /their first request fails/i,
    "Bayat cümle geri geldi: 'ilk istekleri başarısız olur' bir ÇALIŞAN süreç varsayar. " +
      "Ölçülen davranış bu değil — hiç istek alınmıyor, süreç açılmıyor."
  );

  const silme = yukseltme.indexOf("DELETE FROM users");
  const baglan = yukseltme.search(/reconnect through `\/connect`/);
  assert.ok(silme >= 0 && baglan >= 0, "Yükseltme bölümünde silme ya da yeniden bağlanma adımı yok");
  assert.ok(
    silme < baglan,
    "Yeniden bağlanma adımı çevrimdışı onarımdan ÖNCE geliyor: o sırada /connect diye bir " +
      "yüzey yok (süreç açılmıyor), yani operatör var olmayan bir sayfaya gönderiliyor."
  );
});

/* ── 5) Runbook'ta geçen her AEGIS_* adı kodda gerçekten okunuyor mu ───────────────── */

test("runbook'ta geçen her AEGIS_* adı kaynakta GERÇEKTEN okunuyor", () => {
  /**
   * test/ayarAdlari.test.ts scans README.md, README.tr.md, .env.example and docs/*.md —
   * deploy/ is outside its list, so a typo in the hosted runbook (the file an operator
   * copies from) was invisible. Sending an operator to a setting that does not exist costs
   * the same whether the wrong name is in an error message or in a runbook.
   */
  function dosyalar(dizin: string): string[] {
    const cikti: string[] = [];
    for (const ad of readdirSync(dizin)) {
      const tam = path.join(dizin, ad);
      if (statSync(tam).isDirectory()) cikti.push(...dosyalar(tam));
      else if (/\.(ts|mjs|js)$/.test(ad)) cikti.push(tam);
    }
    return cikti;
  }

  const kaynak = ["src", "scripts"]
    .flatMap((d) => dosyalar(path.join(KOK, d)))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  const adlar = [...new Set([...BELGE.matchAll(/AEGIS_[A-Z0-9_]+/g)].map((m) => m[0]))];
  assert.ok(adlar.length >= 8, `Runbook'ta beklenenden az AEGIS_* adı var (${adlar.length}) — desen bayat`);

  const uydurma = adlar.filter((ad) => !kaynak.includes(ad));
  assert.deepEqual(
    uydurma,
    [],
    `Runbook var olmayan ayar adı öneriyor: ${uydurma.join(", ")} — operatör dediğini yapar, ` +
      `hiçbir şey değişmez ve elinde ne hata ne ipucu kalır.`
  );
});

/* ── 6) Runbook sır taşımıyor ──────────────────────────────────────────────────────── */

test("runbook örnek numarası GERÇEK numara değil (tam E.164 sızmıyor)", () => {
  /**
   * The approver's number is the one piece of PII this page invites an operator to paste.
   * A full E.164 number in a public repository would be a leak by copy-paste, so the
   * example stays a mask.
   */
  assert.match(BELGE, /AEGIS_APPROVER_PHONE=\+\d{1,3}X{4,}/, "Örnek numara maskeli biçimde değil");
  assert.doesNotMatch(
    BELGE,
    /\+\d{10,}/,
    "Runbook'ta tam E.164 görünümlü bir numara var — depo PUBLIC, örnek maskeli kalmalı"
  );
});

/* ── 7) Onarım, veritabanına dokunmadan ÖNCE servisi durduruyor ───────────────────── */

const BIRIM = readFileSync(path.join(KOK, "deploy", "aegis.service"), "utf8");

test("KRİTİK: çevrimdışı onarım, DB'ye dokunmadan ÖNCE servisi DURDURUYOR", () => {
  /**
   * The runbook used to say "repair offline" and then "start the service" while never
   * stopping anything, so the operator ran `.backup` and `DELETE FROM users` against a
   * database a supervised process kept reopening. Both halves are pinned here: the unit's
   * restart policy (the whole reason a stop is needed) and the order of the commands.
   * Change `Restart=`/`RestartSec=` in the unit and this goes red so the paragraph is
   * rewritten with it; drop the stop from the page and it goes red too.
   */
  const yeniden = /^\s*Restart=(.+)$/m.exec(BIRIM);
  assert.ok(yeniden, "aegis.service'te Restart= satırı yok — desen bayat");
  assert.equal(
    yeniden[1].trim(),
    "on-failure",
    "aegis.service'in yeniden başlatma politikası değişti. Runbook 4. adımda durdurmayı " +
      "'crash loop' gerekçesiyle emrediyor ve 'Restart=on-failure açık durdurmadan sonra " +
      "ateşlemez' diyor — gerekçe artık doğru olmayabilir, birimle belgeyi birlikte güncelle."
  );

  const aralik = /^\s*RestartSec=(\d+)\s*$/m.exec(BIRIM);
  assert.ok(aralik, "aegis.service'te RestartSec= satırı yok — desen bayat");
  assert.equal(
    Number(aralik[1]),
    5,
    "RestartSec değişti: runbook 'five-second crash loop' ve 'every five seconds' diyor, " +
      "bu cümleler artık yanlış — ikisini de yeni değere göre düzelt."
  );

  const yukseltme = bolum("Upgrading");
  assert.match(yukseltme, /five-second crash loop/, "3. adım artık crash loop'u anmıyor — desen bayat");
  assert.match(
    yukseltme,
    /every five seconds/,
    "4. adım durdurmanın NEDEN gerektiğini (süreç aynı veritabanını beş saniyede bir yeniden " +
      "açıyor) söylemiyor; gerekçesiz bir adım atlanır."
  );

  // The order is read off the RUNNABLE commands, not off prose: the paragraph above the
  // block is allowed to name `.backup` while explaining why the stop comes first, and an
  // anchor that matched that mention would call a correctly ordered runbook out of order.
  const dur = yukseltme.indexOf("systemctl stop aegis");
  const yedek = yukseltme.indexOf('".backup ');
  const sil = yukseltme.indexOf("DELETE FROM users WHERE id IN");
  const basla = yukseltme.indexOf("systemctl start aegis");

  assert.ok(
    dur >= 0,
    "Çevrimdışı onarım bloğunda `systemctl stop aegis` yok: 3. adım servisi crash loop'ta " +
      "bırakıyor, 5. adım ise 'başlat' diyor — operatör hiç durdurmadığı bir servisin " +
      "veritabanını elle onarmaya çalışır."
  );
  assert.ok(yedek >= 0 && sil >= 0 && basla >= 0, "Yedek, silme ya da başlatma komutu bölümde yok");
  assert.ok(
    dur < yedek && yedek < sil,
    "Durdurma `.backup` ve `DELETE FROM users`'tan SONRA geliyor: bu sırayla onarım hâlâ " +
      "yeniden açılan bir süreçle yarışıyor, yani 'çevrimdışı' sözü tutulmuyor."
  );
  assert.ok(
    basla > sil,
    "Başlatma komutu onarımdan ÖNCE geliyor: silinmemiş kırık satırlarla açılan süreç yine düşer."
  );
});

test("KRİTİK: 'önce durdur' gerekçesi ÖLÇÜLÜYOR — yeniden açılış eski şemada YAZIYOR", () => {
  /**
   * Code → doc again. The page claims the crash-looping process is not merely a reader: on
   * a store whose schema predates `google_sub`, `new UserStore()` migrates the table BEFORE
   * the key gate ever runs. That claim is produced here by running the constructor over
   * exactly such a database, so deleting the migration from store.ts turns this red and the
   * sentence has to leave the runbook in the same commit.
   */
  const yol = path.join(KLASOR, "eski-sema.db");
  const once = new DatabaseSync(yol);
  try {
    once.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        refresh_token_enc TEXT NOT NULL,
        api_key_hash TEXT NOT NULL UNIQUE,
        login_customer_id TEXT,
        write_enabled INTEGER NOT NULL DEFAULT 1,
        max_daily_budget REAL NOT NULL DEFAULT 500,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    once
      .prepare("INSERT INTO users (email, refresh_token_enc, api_key_hash) VALUES (?, ?, ?)")
      .run("kiraci@ornek.com", yabanciPaket("jeton-GIZLI"), "anahtar-ozeti-1");
    const baslangic = (once.prepare("PRAGMA table_info(users)").all() as any[]).map((c) => String(c.name));
    assert.ok(!baslangic.includes("google_sub"), "Kurgu bozuk: eski şemada google_sub bulunmamalı");
  } finally {
    once.close();
  }

  // Exactly what one iteration of the crash loop does: construct the store, then read the gate.
  const depo = new UserStore(yol);
  let durum: "bos" | "calisiyor" | { hata: string };
  try {
    durum = depo.anahtarCalisiyorMu();
  } finally {
    depo.close();
  }

  assert.equal(
    typeof durum,
    "object",
    "Başlangıç kapısı çözülemeyen satırı GEÇİRDİ — bu bir gevşeme olurdu ve kurtarma " +
      "yordamının dayanağı da kalmazdı."
  );

  const sonra = new DatabaseSync(yol);
  let sutunlar: string[];
  try {
    sutunlar = (sonra.prepare("PRAGMA table_info(users)").all() as any[]).map((c) => String(c.name));
  } finally {
    sonra.close();
  }

  assert.ok(
    sutunlar.includes("google_sub"),
    "Yeniden açılış artık şemayı taşımıyor: runbook durdurmayı 'süreç pasif okuyucu değil, " +
      "anahtar kontrolünden ÖNCE ALTER TABLE çalıştırıyor' diye gerekçelendiriyor — o cümle " +
      "artık ölçümle uyuşmuyor, belgeden çıkarılmalı."
  );

  const yukseltme = bolum("Upgrading");
  assert.match(
    yukseltme,
    /ALTER TABLE users ADD COLUMN google_sub/,
    "Runbook, durdurmanın ölçülmüş gerekçesini (yeniden açılışın YAZAN bir göç çalıştırması) " +
      "anlatmıyor; gerekçesini görmeyen operatör durdurma adımını gereksiz sanıp atlar."
  );

  rmSync(yol, { force: true });
});

process.on("exit", () => {
  try {
    rmSync(KLASOR, { recursive: true, force: true });
  } catch {
    /* the files may still be locked on Windows */
  }
});
