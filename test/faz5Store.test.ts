// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PHASE 5A — src/store.ts: three holes the phase-4 audit MEASURED, closed here.
 *
 * Every claim below was produced by running something, not by reading it:
 *
 *   1) THE UPDATE BRANCH WAS NEVER RUN. test/faz4Store.test.ts is titled "BOŞ subject
 *      REDDEDİLİR: ne satır yazılır ne de google_sub='' doğar", but it only ever exercises
 *      the INSERT branch. Measured: turning the UPDATE branch's `input.subject ?? null` into
 *      `input.subject ?? ""` left all 14 tests of test/faz3Store.test.ts +
 *      test/faz4Store.test.ts GREEN (pass 14 / fail 0). The reachable path is ordinary —
 *      the stdio/test flow calling `upsertUser` a SECOND time with the same e-mail and no
 *      subject falls into UPDATE — and under that mutation `COALESCE('', google_sub)` does
 *      not just birth a blank owner, it ERASES an owner that was already there. The first
 *      test here runs that path and reads the column back with raw SQL.
 *
 *   2) THE COMMENT SAID THE GATE COULD NOT BE REACHED. src/store.ts used to close its
 *      blank-subject block with "Today the hosted flow cannot reach this (http.ts drops a
 *      falsy `sub` before calling), so this is defence in depth, not a live hole." Measured
 *      with http.ts's own two expressions: `sub = "   "` is TRUTHY, so `if (payload.sub)`
 *      keeps it and `if (!subject)` waves it through; `upsertUser` is reached with "   ",
 *      and the store's refusal is the only thing that stops it. The sentence was rewritten
 *      to say that, and the second test binds the sentence to the code on BOTH sides: it
 *      re-measures that http.ts still does not trim, and requires the comment to say so.
 *
 *   3) THE RUNBOOK RE-OPENED THE LEAK THE STORE CLOSES. deploy/README.md's backup step
 *      created the copy with no umask and the directory with none either. Measured under
 *      systemd's default `umask 022`: a newly created file comes back 0644 and a new
 *      directory 0755 — i.e. a world-readable copy of every tenant's e-mail, google_sub,
 *      budget ceiling and encrypted refresh token, sitting beside a database this file
 *      narrows to DEPO_DOSYA_MODU on the way in. Measured again under `umask 077`: 0600.
 *      The last three tests do not grep for a magic string: they read the umask out of the
 *      snippet and COMPUTE what a 0666 creation lands on, so `umask 022` goes red and a
 *      change to DEPO_DOSYA_MODU drags every snippet with it.
 *
 *      THE NIGHTLY JOB WAS NOT THE ONLY BACKUP. The page tells the operator to copy the
 *      store twice — the nightly `.backup` and the `.kurtarma-yedegi` taken during a key
 *      rotation — and src/store.ts PRINTS a third, in the refusal that runs when the process
 *      will not start. Closing one and vouching for "the runbook" would have been the very
 *      thing this phase is about, so all three are narrowed and all three are measured, the
 *      printed one out of a LIVE refusal rather than out of the source text.
 *
 *      AND THE FIRST VERSION OF THAT WATCHER WAS ITSELF HOLED. It scanned whole code blocks,
 *      so reverting the recovery backup to its unprotected form left it GREEN: the `#` line
 *      explaining the umask still carried the word. Measured, then fixed by measuring the
 *      COMMAND rather than the block — see `yorumsuz`.
 *
 * Nothing here relaxes anything: every assertion is a refusal staying a refusal, an owner
 * staying unreadable, or a permission staying narrow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createCipheriv } from "node:crypto";

process.env.AEGIS_MASTER_KEY = "faz5-store-testi-32-bayttan-uzun-anahtar";

const { UserStore, DEPO_DOSYA_MODU } = await import("../src/store.js");

const KOK = fileURLToPath(new URL("..", import.meta.url));
const KLASOR = mkdtempSync(join(tmpdir(), `aegis-faz5-store-${process.pid}-`));
let sayac = 0;

/** A fresh store plus a raw handle on the SAME file, so the owner column can be read UNFILTERED. */
function yeniDepo(): { depo: InstanceType<typeof UserStore>; ham: DatabaseSync } {
  const yol = join(KLASOR, `faz5-${++sayac}.db`);
  const depo = new UserStore(yol);
  return { depo, ham: new DatabaseSync(yol) };
}

/**
 * The owner column exactly as SQLite holds it. Reading it through findById would go through
 * rowToUser, which maps NULL to `undefined` — and NULL vs "" is the whole question here.
 */
function hamSahip(ham: DatabaseSync, id: number): string | null {
  const satir = ham.prepare("SELECT google_sub FROM users WHERE id = ?").get(id) as any;
  assert.ok(satir, `satır #${id} yok — ölçüm boşluğa bakıyor olurdu`);
  return satir.google_sub === null ? null : String(satir.google_sub);
}

/* ── 1) The UPDATE branch: a renewal without a subject may not write a blank owner ─── */

test("KRİTİK: subject'siz YENİLEME (UPDATE kolu) google_sub='' DOĞURAMAZ ve sahibi SİLEMEZ", () => {
  const { depo, ham } = yeniDepo();
  try {
    /* (a) First registration — the INSERT branch, no subject: SQL NULL, "never linked". */
    const ilk = depo.upsertUser({ email: "yenile@ornek.com", refreshToken: "jeton-1" });
    assert.equal(hamSahip(ham, ilk.userId), null, "subject'siz ilk kayıt SQL NULL yazmalı");

    /* (b) The path phase 4 never ran: the SAME e-mail, still no subject. bySub is undefined,
     *     byEmail finds the row, so this lands in the UPDATE branch — and the parameter that
     *     feeds `COALESCE(?, google_sub)` has to stay SQL NULL. A blank there is not NULL,
     *     so COALESCE would keep it and the row would be born with an unreadable owner. */
    const ikinci = depo.upsertUser({ email: "yenile@ornek.com", refreshToken: "jeton-2" });
    assert.equal(
      ikinci.userId,
      ilk.userId,
      "aynı e-posta subject'siz gelince AYNI satırı yenilemeli — bu ölçüm UPDATE kolunu koşmuyorsa hiçbir şey ölçmez"
    );
    assert.equal(
      (ham.prepare("SELECT COUNT(*) AS n FROM users").get() as any).n,
      1,
      "yenileme yeni satır açmamalı (INSERT koluna düşseydi bu ölçüm UPDATE'i hiç görmezdi)"
    );
    assert.equal(
      hamSahip(ham, ilk.userId),
      null,
      "UPDATE kolu google_sub'ı NULL bırakmalı: boş dize 'sahipsiz' değil, 'sahipliği OKUNAMAYAN' bir satırdır"
    );
    // And the renewal really happened — otherwise the assertion above would be trivially
    // true on a store that wrote nothing at all.
    assert.equal(depo.findByApiKey(ikinci.apiKey)?.refreshToken, "jeton-2", "yenileme gerçekten yazmalı");
    assert.equal(depo.findById(ilk.userId)?.googleSub, undefined, "NULL, 'hiç bağlanmamış'ın tek biçimidir");

    /* (c) The other side of the same branch, measured while writing this test: a row that IS
     *     linked cannot be renewed WITHOUT a subject at all — the takeover gate refuses,
     *     because an owner that is present and does not match the (absent) claim is never
     *     handed over. That is why (b) is the ONLY subjectless route into UPDATE, and why
     *     the NULL there has to be pinned: it is the single place a blank owner could be
     *     born on this branch. Pinned so the gate cannot quietly become a wall or a door. */
    const bagli = depo.upsertUser({ subject: "sub-sahip", email: "bagli@ornek.com", refreshToken: "jeton-3" });
    assert.equal(hamSahip(ham, bagli.userId), "sub-sahip", "bağlama yazılmalı");
    assert.throws(
      () => depo.upsertUser({ email: "bagli@ornek.com", refreshToken: "jeton-4" }),
      /başka bir Google hesabına bağlı/,
      "sahibi OKUNAN bir satır, sahiplik iddiası TAŞIMAYAN bir çağrıya devredilemez"
    );
    assert.equal(hamSahip(ham, bagli.userId), "sub-sahip", "reddedilen çağrı sahibi bozmamalı");
    assert.equal(
      depo.findById(bagli.userId)?.refreshToken,
      "jeton-3",
      "reddedilen çağrı token'ı da değiştirmemeli (ret, yarım uygulanmış bir yazma bırakmaz)"
    );

    /* (d) The whole store, not just the rows named above. */
    assert.equal(
      (ham.prepare("SELECT COUNT(*) AS n FROM users WHERE google_sub = ''").get() as any).n,
      0,
      "hiçbir satır boş google_sub taşıyamaz"
    );
  } finally {
    ham.close();
    depo.close();
  }
});

/* ── 2) The blank-subject block says what the code does — measured on both sides ───── */

const KAYNAK = readFileSync(join(KOK, "src/store.ts"), "utf8");
const HTTP = readFileSync(join(KOK, "src/http.ts"), "utf8");

/**
 * The JSDoc block sitting directly above the blank-subject refusal, flattened to one line:
 * the sentences read here wrap across ` * ` prefixes, and a regex that cannot cross them
 * would find nothing and go green for the wrong reason.
 */
function bosSubjectYorumu(): string {
  const kapi = KAYNAK.indexOf('if (input.subject !== undefined && input.subject.trim() === "")');
  assert.ok(kapi > 0, "boş-subject kapısı bulunamadı — gözcü boşluğa bakıyor olurdu");
  const oncesi = KAYNAK.slice(0, kapi);
  const bas = oncesi.lastIndexOf("/**");
  const son = oncesi.lastIndexOf("*/");
  assert.ok(bas >= 0 && son > bas, "kapının üstünde bir JSDoc bloğu yok");
  return oncesi
    .slice(bas, son)
    .replace(/^\s*\*\s?/gm, " ")
    .replace(/\s+/g, " ");
}

/**
 * Everything http.ts does between reading `sub` out of the id_token and handing it to the
 * store. The region is bounded by two anchors that are asserted to exist, so an edit that
 * moves either one fails loudly instead of shrinking the region to nothing.
 */
function http_kimlikBolgesi(): string {
  const bas = HTTP.indexOf("let subject: string | undefined;");
  const son = HTTP.indexOf("store.upsertUser(");
  assert.ok(bas > 0, "http.ts'te `let subject` çapası yok — bölge çapası bayatlamış");
  assert.ok(son > bas, "http.ts'te `store.upsertUser(` çağrısı `let subject`ten sonra gelmiyor");
  return HTTP.slice(bas, son);
}

test("KRİTİK: YALNIZ-BOŞLUK bir `sub` depoya ULAŞIYOR — kod bunu yapıyor, yorum bunu söylüyor", () => {
  const bolge = http_kimlikBolgesi();

  /* (a) http.ts weighs the claim for TRUTHINESS, twice — and a whitespace-only string is
   *     truthy. Both expressions are required to be there verbatim: if either becomes an
   *     emptiness check, the comment in store.ts stops being true and has to be rewritten. */
  assert.ok(
    bolge.includes("if (payload.sub) subject = String(payload.sub);"),
    "http.ts artık `sub`u doğrulukla ölçmüyor — store.ts'teki 'yalnız-boşluk buraya ulaşır' cümlesi de birlikte güncellenmeli"
  );
  assert.ok(
    bolge.includes("if (!subject) {"),
    "http.ts'in kapalı-arıza kontrolü değişmiş — aynı cümle yeniden ölçülmeli"
  );

  /* (b) NOTHING between the id_token and the call trims. This is the sentence's whole
   *     premise; the region is small and bounded above, so the absence claim is about a
   *     named stretch of code rather than about a class of expressions. */
  assert.doesNotMatch(
    bolge,
    /\.trim\(\)/,
    "http.ts artık kimlik yolunda kırpma yapıyor: yalnız-boşluk bir `sub` depoya ULAŞMIYOR olabilir — " +
      "store.ts'teki 'ARRIVES at this call' cümlesi ölçüme dayanmalı"
  );

  /* (c) The behaviour the sentence promises, run: the store refuses "   " itself. */
  const { depo, ham } = yeniDepo();
  try {
    assert.throws(
      () => depo.upsertUser({ subject: "   ", email: "bosluk@ornek.com", refreshToken: "jeton" }),
      /google_sub \(subject\) boş/,
      "yalnız-boşluk subject reddedilmeli — http.ts onu elemediği için burası TEK kapı"
    );
    assert.equal(
      (ham.prepare("SELECT COUNT(*) AS n FROM users").get() as any).n,
      0,
      "reddedilen kayıt arkasında satır bırakmamalı"
    );
  } finally {
    ham.close();
    depo.close();
  }

  /* (d) And the comment has to carry the measurement, in both directions. */
  const yorum = bosSubjectYorumu();
  assert.match(
    yorum,
    /WHITESPACE-ONLY/,
    "yorum, buraya ULAŞAN tek biçimi (yalnız-boşluk `sub`) anmıyor — kapının var oluş sebebi yazılı değil"
  );
  assert.match(
    yorum,
    /ARRIVES at this call/,
    "yorum, yalnız-boşluk `sub`un bu çağrıya ULAŞTIĞINI söylemiyor"
  );
  assert.doesNotMatch(
    yorum,
    /cannot reach this/,
    "yorum yine 'barındırılan akış buraya ulaşamaz' diyor — ÖLÇÜLDÜ, ulaşıyor: `sub = \"   \"` " +
      "http.ts'teki iki doğruluk denetiminden de geçiyor"
  );
});

/* ── 3) The runbook's backup step narrows what the store narrows ───────────────────── */

const DEPLOY = readFileSync(join(KOK, "deploy", "README.md"), "utf8");

/** "## Başlık" ile bir sonraki "## " arasındaki gövde. */
function bolum(basligiIceren: string): string {
  const satirlar = DEPLOY.split(/\r?\n/);
  const bas = satirlar.findIndex((s) => s.startsWith("## ") && s.includes(basligiIceren));
  assert.notEqual(bas, -1, `deploy/README.md içinde "${basligiIceren}" başlıklı bölüm yok`);
  const kalan = satirlar.slice(bas + 1);
  const son = kalan.findIndex((s) => s.startsWith("## "));
  return (son === -1 ? kalan : kalan.slice(0, son)).join("\n");
}

/**
 * The RUNNABLE half of a text: its fenced code blocks. Prose is where a page EXPLAINS a
 * mode; the block is where it SETS one, and only the block is what the operator pastes.
 * Scanning the page as a whole would let a paragraph that merely MENTIONS `umask 022` (this
 * one has such a paragraph, as the measurement it reports) stand in for a command that sets
 * it — the watcher would be reading the wrong half of the page.
 */
/**
 * A shell snippet with its `#` comment tails removed — because a COMMENT that mentions
 * `umask 077` is not a command that sets it. This was not theory: the first version of this
 * watcher scanned whole code blocks, and reverting the recovery backup to its unprotected
 * form left it GREEN (measured, mutation M3f), since the explanatory `#` line above it still
 * carried the word. Comments are the third half of the page, after prose and command.
 *
 * The cut is deliberately blunt — a `#` inside a quoted string would take the rest of its
 * line with it. That direction is safe: this helper only ever REMOVES text, and every claim
 * built on it is "the command must CONTAIN …", so over-cutting can turn a watcher red but
 * can never make one go quiet.
 */
function yorumsuz(kod: string): string {
  return kod
    .split(/\r?\n/)
    .map((s) => s.replace(/#.*$/, ""))
    .join("\n");
}

function kodBloklari(metin: string): string[] {
  return [...metin.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => yorumsuz(m[1]));
}

function komutlar(bolumMetni: string): string {
  const bloklar = kodBloklari(bolumMetni);
  assert.ok(bloklar.length > 0, "bölümde hiç kod bloğu yok — gözcü boş bir metni onaylıyor olurdu");
  return bloklar.join("\n");
}

/**
 * The one rule, applied to any pasteable snippet that takes a backup: the copy carries the
 * live store's secrets, so it has to be born at DEPO_DOSYA_MODU. The umask is COMPUTED
 * against a 0666 creation rather than matched as a string, so `umask 022` (measured: 0644)
 * is red and a change to DEPO_DOSYA_MODU drags every one of these snippets with it.
 */
function yedekModunuOlc(ham: string, nerede: string): void {
  const parca = yorumsuz(ham);
  const backupIdx = parca.indexOf(".backup");
  assert.ok(backupIdx >= 0, `${nerede}: `.concat(".backup çağrısı yok — çapa bayatlamış"));
  const umasklar = [...parca.matchAll(/umask\s+0?([0-7]{3})/g)];
  assert.ok(
    umasklar.length > 0,
    `${nerede}: yedek komutunda \`umask\` yok. sqlite3'ün açtığı kopya sistemin varsayılanıyla ` +
      "doğar (ölçüldü: umask 022 altında 0644) ve tüm kiracıların e-postası, google_sub'ı, " +
      "bütçe tavanı ve şifreli refresh token'ı sunucudaki her yerel hesaba açılır — depo kendi " +
      "dosyasını kapatırken kopyası açık kalamaz"
  );
  for (const m of umasklar) {
    const umask = parseInt(m[1], 8);
    assert.equal(
      0o666 & ~umask,
      DEPO_DOSYA_MODU,
      `${nerede}: umask 0${m[1]}, yeni bir dosyayı 0${(0o666 & ~umask).toString(8)} olarak doğurur; ` +
        `depo kendi dosyasını 0${DEPO_DOSYA_MODU.toString(8)} yapıyor — yedek aynı sırları taşıdığı hâlde daha açık kalamaz`
    );
    assert.ok(
      m.index! < backupIdx,
      `${nerede}: \`umask 0${m[1]}\` \`.backup\`tan SONRA geliyor — kopya zaten geniş modla doğmuş olur`
    );
  }
}

test("KRİTİK: runbook'un yedek adımı kopyayı deponun kendi moduna (0600) daraltıyor", () => {
  const yedek = komutlar(bolum("Backups"));

  /* (a) The mode the copy is born with, computed rather than grepped. */
  yedekModunuOlc(yedek, "deploy/README.md · Backups");

  /* (b) The umask only shapes files that are NEW; a re-run that overwrites yesterday's file
   *     keeps its old mode, so the explicit chmod is not decoration. */
  const chmodlar = [...yedek.matchAll(/chmod\s+0?([0-7]{3})/g)].map((m) => parseInt(m[1], 8));
  assert.ok(
    chmodlar.includes(DEPO_DOSYA_MODU),
    `yedek bölümü kopyayı 0${DEPO_DOSYA_MODU.toString(8)}'a çeken bir chmod içermiyor — umask yalnız YENİ dosyayı şekillendirir, ` +
      "dünkü yedeğin üzerine yazan bir koşu eski modu korur"
  );

  /* (c) The directory: measured, `mkdir` under umask 022 comes back 0755, so a 0600 file
   *     inside a listable directory still advertises which tenants exist and when. */
  assert.ok(
    chmodlar.includes(0o700),
    "yedek dizini daraltılmıyor (ölçüldü: `mkdir` umask 022 altında 0755 doğuruyor) — " +
      "chmod 700 olmadan dizin içeriği her yerel hesaba listelenir"
  );

  /* (d) ATTEMPTING IS NOT ACHIEVING — the same rule depoIzinleriniKisitla applies to the
   *     live file. The runbook has to read the mode back, not merely ask for it. */
  assert.match(
    yedek,
    /stat\s+-c/,
    "yedek adımı sonucu ÖLÇMÜYOR: chmod'u kabul edip yok sayan bir dosya sistemi, kapatıldığı sanılan bir kopya bırakır"
  );
});

test("KRİTİK: runbook'ta yedek alan HER komut daraltılmış — bir adımı kapatmak yetmez", () => {
  /**
   * The nightly job is not the only place the page tells the operator to copy the store: the
   * upgrade path takes a `.kurtarma-yedegi` before it deletes rows, and that copy is made at
   * the worst possible moment — the process is down and nobody is looking at modes. Closing
   * only the section above would leave the leak open one heading away, so the claim is made
   * over EVERY pasteable backup on the page.
   */
  const yedekBloklari = kodBloklari(DEPLOY).filter((b) => b.includes(".backup"));
  assert.ok(
    yedekBloklari.length >= 2,
    `deploy/README.md'de yedek alan ${yedekBloklari.length} kod bloğu bulundu; sayfada gece yedeği ve ` +
      "kurtarma yedeği olmak üzere en az iki tane vardı — bir adım silinmiş ya da çapa bayatlamış olabilir"
  );
  yedekBloklari.forEach((b, i) => yedekModunuOlc(b, `deploy/README.md · ${i + 1}. yedek bloğu`));
});

/**
 * A well-formed package written under a FOREIGN key — 12-byte IV, 16-byte tag, non-empty
 * body — i.e. what a row left behind by the PREVIOUS master key looks like: structurally
 * valid, failing only on authentication. It is what makes the startup gate refuse.
 */
function yabanciPaket(duz: string): string {
  const anahtar = randomBytes(32);
  const iv = randomBytes(12);
  const sifre = createCipheriv("aes-256-gcm", anahtar, iv);
  const govde = Buffer.concat([sifre.update(duz, "utf8"), sifre.final()]);
  return [iv.toString("base64"), sifre.getAuthTag().toString("base64"), govde.toString("base64")].join(".");
}

test("KRİTİK: deponun KENDİ bastığı kurtarma yedeği de 0600 doğuruyor", () => {
  /**
   * This one is read out of the LIVE refusal rather than out of the source text. It is the
   * only surface the operator has left at that moment — the process exits right after — so
   * "the command it prints" and "the command that gets run" are the same string, and a
   * source-level match would not have proved the operator sees it.
   */
  const yol = join(KLASOR, `kurtarma-${++sayac}.db`);
  const depo = new UserStore(yol);
  depo.upsertUser({ subject: "sub-1", email: "kiraci@ornek.com", refreshToken: "jeton-GIZLI" });
  depo.close();

  const ham = new DatabaseSync(yol);
  try {
    ham.prepare("UPDATE users SET refresh_token_enc = ? WHERE id = 1").run(yabanciPaket("jeton-GIZLI"));
  } finally {
    ham.close();
  }

  const tekrar = new UserStore(yol);
  try {
    const durum = tekrar.anahtarCalisiyorMu();
    assert.equal(
      typeof durum,
      "object",
      `Başlangıç kapısı çözülemeyen satırı GEÇİRDİ (${JSON.stringify(durum)}) — bu bir gevşeme olurdu ` +
        "ve basılan kurtarma yordamının dayanağı da kalmazdı"
    );
    const ret = (durum as { hata: string }).hata;
    assert.match(ret, /DELETE FROM users WHERE id IN \(/, "ret metni silme komutunu basmıyor — desen bayat");
    yedekModunuOlc(ret, "src/store.ts · anahtarCalisiyorMu() ret metni");
  } finally {
    tekrar.close();
  }
});

process.on("exit", () => {
  try {
    rmSync(KLASOR, { recursive: true, force: true });
  } catch {
    /* the file may still be locked on Windows */
  }
});
