// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GROWTH BRAIN'İN İNSAN KAPISI — bir denetimde testsiz bulundu.
 *
 * This gate is the only thing standing in front of the brain's two spending moments
 * (writing the draft, and going live), so it is worth measuring the way it is actually
 * used. `operatorOnayi` holds TWO locks and they guard different failures:
 *
 *   1) THE CHANNEL. If stdin is not a terminal the question is never asked at all: the
 *      answer is "" and the run is refused, loudly. A pipe, a file, `< /dev/null`, CI and
 *      a background job are all the same thing — nobody is at the keyboard.
 *   2) THE CLOSE RACE. For the terminal that DOES answer, the question is raced against
 *      the stream closing, so a session dropped mid-question resolves with "" instead of
 *      leaving the process hung while looking, from outside, like it is working. That hang
 *      was a real incident here.
 *
 * WHY THE CHANNEL TESTS SPAWN A CHILD PROCESS. The earlier version of this file fed the gate an
 * in-memory `Readable.from(["evet\n"])` and called that "the pipe case". It is not: such a
 * stream closes inside the same tick, so the close race answers "" and the test stays green
 * on a mechanism that has nothing to do with lock 1. Measured with the channel lock deleted:
 * `Readable.from(["evet\n"])` still yields RET, while a REAL operating-system pipe yields
 * ONAY. The old guard could not have seen the regression it was named after. So the pipe
 * here is a real pipe, the file redirect is a real file, and what runs is the very command
 * an operator would type.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { operatorOnayi, onayVerildiMi } from "../../scripts/growth-brain.mjs";

const KOK = join(import.meta.dirname, "..", "..");
const BEYIN_URL = pathToFileURL(join(KOK, "scripts", "growth-brain.mjs")).href;

/** Yazılanı yutan çıktı akışı: test terminale bir şey basmasın. */
const sessizCikti = () => new Writable({ write(_p, _e, cb) { cb(); } });

/**
 * A hang has to be an ASSERTABLE VALUE, not a slow test. `sureSinirli` resolves with the
 * promise's own result, or with ASILDI if the deadline passes first — so "the gate never
 * answered" fails on its own line with its own message instead of being reported as a
 * timeout somewhere in the runner.
 */
const ASILDI = Symbol("asıldı");
function sureSinirli(soz, ms) {
  let sayac;
  return Promise.race([
    Promise.resolve(soz).finally(() => clearTimeout(sayac)),
    new Promise((coz) => { sayac = setTimeout(() => coz(ASILDI), ms); }),
  ]);
}

/**
 * The child asks the gate exactly once and prints the RAW answer next to the verdict, so a
 * test can tell "refused with an empty answer" apart from "refused after reading a word".
 */
const COCUK_KOD =
  'import(process.env.AEGIS_BEYIN_URL).then(async (m) => {' +
  '  const c = await m.operatorOnayi("Onaylıyor musun? ");' +
  '  process.stdout.write("\\nCEVAP:" + JSON.stringify(c) + " SONUC:" + (m.onayVerildiMi(c) ? "ONAY" : "RET") + "\\n");' +
  '  process.exit(0);' +
  '});';

/**
 * Runs the gate in a separate process over a REAL stdin channel. `stdinAyari` is whatever
 * `child_process` accepts as fd 0 — "pipe" for a true OS pipe, a file descriptor for a
 * `< dosya` redirect. Resolves with the collected output and the exit code; a gate that
 * hangs is killed, and the null exit code that follows is itself the evidence.
 */
function kapiyiKos(stdinAyari, yazilan) {
  return new Promise((coz, tik) => {
    const cocuk = spawn(process.execPath, ["-e", COCUK_KOD], {
      cwd: KOK,
      stdio: [stdinAyari, "pipe", "pipe"],
      env: { ...process.env, AEGIS_BEYIN_URL: BEYIN_URL },
    });
    let cikti = "";
    cocuk.stdout.on("data", (p) => (cikti += String(p)));
    cocuk.stderr.on("data", (p) => (cikti += String(p)));
    cocuk.on("error", tik);
    const zaman = setTimeout(() => cocuk.kill("SIGKILL"), 20000);
    cocuk.on("close", (kod) => {
      clearTimeout(zaman);
      coz({ cikti, kod });
    });
    if (cocuk.stdin) {
      if (yazilan !== undefined) cocuk.stdin.write(yazilan);
      cocuk.stdin.end();
    }
  });
}

/* ── 1) Gerçek kanal: boru, kapalı boru, dosya ────────────────────────────────── */

test("KRİTİK: GERÇEK işletim sistemi borusundan 'evet' göndererek onay geçirilemez", { timeout: 30000 }, async () => {
  /**
   * This is `printf 'evet\n' | npm run brain -- --uygula ...` verbatim. If it turns red,
   * the [4/5] draft-write approval can be given with nobody at the keyboard and a campaign
   * lands in a customer's real Google Ads account.
   */
  const { cikti, kod } = await kapiyiKos("pipe", "evet\n");
  assert.match(cikti, /SONUC:RET/, `borudan gelen 'evet' onay sayıldı — çıktı:\n${cikti}`);
  assert.equal(/SONUC:ONAY/.test(cikti), false, "boru insan yerine geçemez");
  assert.match(cikti, /CEVAP:""/, "boruya yazılan metin okunmadan reddedilmeli");
  assert.equal(kod, 0, "kapı reddederken süreç asılı kalmamalı");
});

test("KRİTİK: boru veri yollamadan kapanırsa soru asılı kalmaz ve cevap boş (yani ret) döner", { timeout: 30000 }, async () => {
  // `... < /dev/null`, CI, arka plan işi: stdin hemen kapanır. Belirti ASILMAKTIR; süre
  // sınırı ve çıkış kodu, arızayı "yavaş test" gibi görünmekten çıkarır.
  const { cikti, kod } = await kapiyiKos("pipe", undefined);
  assert.match(cikti, /CEVAP:"" SONUC:RET/, `cevapsızlık onay sayıldı — çıktı:\n${cikti}`);
  assert.equal(kod, 0, "cevaplanamayan soru süreci asmamalı");
});

test("KRİTİK: dosyadan yönlendirilen 'evet' (`< onay.txt`) de onay değildir", { timeout: 30000 }, async () => {
  /**
   * A pipe is not the only channel with nobody on it. `nohup ... < onay.txt` and a cron job
   * hand the process a plain file on fd 0; the lock is the channel, not the timing, so this
   * has to refuse for the same reason.
   */
  const dizin = mkdtempSync(join(tmpdir(), "aegis-insan-kapisi-"));
  const yol = join(dizin, "onay.txt");
  writeFileSync(yol, "evet\n");
  const fd = openSync(yol, "r");
  try {
    const { cikti, kod } = await kapiyiKos(fd, undefined);
    assert.match(cikti, /SONUC:RET/, `dosyadan gelen 'evet' onay sayıldı — çıktı:\n${cikti}`);
    assert.equal(kod, 0, "dosya yönlendirmesinde de asılma olmamalı");
  } finally {
    closeSync(fd);
    rmSync(dizin, { recursive: true, force: true });
  }
});

test("Ret SESSİZ değildir: borunun neden reddedildiği ekrana yazılır", { timeout: 30000 }, async () => {
  // Sessiz bir ret, asılmadan ayırt edilemez; boruyu kuran kişi sebebini görmeli.
  const { cikti } = await kapiyiKos("pipe", "evet\n");
  assert.match(cikti, /Onay ALINMADI/, "reddin gerekçesi operatöre söylenmeli");
});

/* ── 2) Karşı kontrol: kapı gerçekten AÇILABİLİR olmalı ───────────────────────── */

test("KARŞI KONTROL: gerçek terminalde (isTTY) 'evet' hâlâ onaydır", { timeout: 10000 }, async () => {
  /**
   * "Always refuse" is not a repair either — it would pass every test above while leaving
   * the product unusable. A stream that marks itself isTTY stands in for the keyboard.
   */
  const girdi = new PassThrough();
  girdi.isTTY = true;
  girdi.setRawMode = () => girdi;
  const bekleyen = operatorOnayi("Onaylıyor musun? ", { girdi, cikti: sessizCikti() });
  setImmediate(() => girdi.write("evet\n"));
  assert.equal(onayVerildiMi(await bekleyen), true, "terminalden gelen 'evet' onaydır");
});

/* ── 3) İKİNCİ KİLİT: soru ekrandayken düşen oturum (KAPANMA YARIŞI) ─────────── */

test("KRİTİK: terminal soru ekrandayken kapanırsa kapı asılmaz, boş cevap (ret) döner", { timeout: 15000 }, async () => {
  /**
   * Lock 2, measured on its own — the header of this file claims it, and until this test
   * nothing here touched it. An operator's ssh session drops while the question is on the
   * screen: the stream IS a terminal, so lock 1 lets it through and the only thing left
   * standing is the race between `rl.question` and the stream closing.
   *
   * This one deliberately does NOT spawn a child, unlike the channel tests above. The fault
   * being measured is a HANG, and a hang is only meaningful once the question is provably
   * already asked; a killed child would report the same null exit code whether the gate
   * hung or never got that far. So the prompt is WAITED FOR on the output stream, and only
   * then is the input closed.
   *
   * Measured against a copy of the gate with the `Promise.race` deleted (the channel lock
   * left in place): this exact sequence yields ASILDI instead of "". The lock carries load,
   * and this guard can go red.
   */
  const soru = "Onaylıyor musun? ";
  const girdi = new PassThrough();
  girdi.isTTY = true;
  girdi.setRawMode = () => girdi;

  // Soru SORULMADAN kapatmak bu kilidi ölçmez, kurulum yarışını ölçer: istemin ekrana
  // yazıldığını görene kadar bekliyoruz.
  let soruldu;
  const soruEkranda = new Promise((coz) => (soruldu = coz));
  const cikti = new Writable({
    write(parca, _e, cb) {
      if (String(parca).includes(soru)) soruldu();
      cb();
    },
  });

  const bekleyen = operatorOnayi(soru, { girdi, cikti });
  assert.notEqual(await sureSinirli(soruEkranda, 5000), ASILDI, "kapı soruyu ekrana hiç yazmadı");

  girdi.end(); // oturum düşüyor: tek bayt yazılmadan akış kapanıyor

  const cevap = await sureSinirli(bekleyen, 5000);
  assert.notEqual(
    cevap,
    ASILDI,
    "düşen oturumda kapı ASILI KALDI: soru ne cevaplandı ne de kapandı — süreç dışarıdan çalışıyor görünür"
  );
  assert.equal(cevap, "", `kapanan terminal boş cevap vermeli, gelen: ${JSON.stringify(cevap)}`);
  assert.equal(onayVerildiMi(cevap), false, "kapanma onay sayılamaz");
});

/* ── 4) Onay ifadesinin kuralı ────────────────────────────────────────────────── */

test("onay kuralı: yalnız 'evet' geçer, yakın duran hiçbir şey geçmez", () => {
  assert.equal(onayVerildiMi("evet"), true);
  assert.equal(onayVerildiMi("Evet"), true);
  assert.equal(onayVerildiMi("  EVET  "), true, "büyük harf ve boşluk kabul edilir");

  for (const yakin of ["e", "eve", "evett", "yes", "y", "tamam", "olur", "hayır", "", "  ", "hayir"]) {
    assert.equal(onayVerildiMi(yakin), false, `'${yakin}' onay sayılmamalı`);
  }
  assert.equal(onayVerildiMi(undefined), false, "eksik cevap onay değildir");
  assert.equal(onayVerildiMi(null), false);
});

test("onay yazımı: klavye ve satır sonu değişse de onay tek kelimedir", () => {
  /**
   * WHAT THIS DOES NOT PIN, said out loud so the file does not claim more scope than it
   * measures. The rule lowercases with an explicit `tr-TR`, but "evet" contains none of the
   * letters whose casing differs between Turkish and the default rules (I / İ / ı), so NO
   * answer can tell the two castings apart: swapping `toLocaleLowerCase("tr-TR")` for a plain
   * `toLowerCase()` cannot turn any test in this file red. The previous version of this test
   * asserted `"EVET".toLocaleLowerCase("tr-TR") === "evet"`, which is a statement about the
   * JavaScript engine and not about the gate — it could not fail for the locale regression it
   * was named after.
   *
   * WHAT IT DOES PIN is the part that can break. The verdict is ONE exact word, whatever the
   * keyboard and the terminal do to it: caps lock still approves, a Windows line ending
   * (`evet\r\n`, what a CRLF terminal hands the reader) still approves, and the I-family
   * spellings a Turkish keyboard actually produces are refusals — a rule that matched loosely
   * would accept "EVETİ", and a rule that dropped `.trim()` would refuse "evet\r\n". Both of
   * those turn this red.
   */
  assert.equal(onayVerildiMi("EVET"), true, "caps lock onayı düşürmemeli");
  assert.equal(onayVerildiMi("evet\r\n"), true, "Windows satır sonu onayı düşürmemeli");

  for (const yakin of ["EVETİ", "EVET I", "ıevet", "evetı"]) {
    assert.equal(onayVerildiMi(yakin), false, `'${yakin}' onay sayılmamalı`);
  }
});
