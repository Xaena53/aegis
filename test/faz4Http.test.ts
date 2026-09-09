// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ROUND-4 COVER — src/http.ts, where the DOCUMENTATION is the thing under test.
 *
 * Both round-4 findings on this file were about comments, and comments are the only part of
 * this repository that no gate could contradict: a sentence can go stale, get cut in half by
 * a translation pass, or promise a control that was deleted three commits ago, and build,
 * typecheck, tests, audit and smoke all stay green. In a file whose comments carry the
 * SECURITY RATIONALE — why the plaintext gate exists, what the sweep is protecting — a
 * sentence nobody can contradict is a sentence nobody can trust.
 *
 * WHAT EACH WATCHER CAN TURN RED (each was measured red by mutation, see the notes):
 *
 *   1) SWEEP: DOC ↔ CODE, BOTH WAYS. sweep()'s docblock is read as a LIST: every backticked
 *      name in it must be swept in the body, and every collection the body sweeps must be
 *      named in it. This is the exact shape of the finding: a0d6c12 deleted the server-side
 *      `pendingStates` pool and its sweep, the docline kept saying "drops expired sessions
 *      AND OAuth state", and for the whole stretch until a9555fe added the spent-state sweep
 *      the sentence described a control that ran nowhere. Delete any one of the three window
 *      sweeps today and this test names it; add a fourth map without documenting it and it
 *      names that too. The docblock's ADJACENCY is checked as well (only whitespace between
 *      the closing delimiter and the signature), because a JSDoc block that has drifted off
 *      its function is invisible in IDE hover — the same drift the round-4 report found in
 *      kararGunlugu.ts.
 *
 *   2) TRANSLATION RESIDUE. The Turkish→English comment pass cut one sentence in half here
 *      ("…when it is published on 0.0.0.0 / ters vekil atlanabilir hâle gelir."), leaving the
 *      half that names the THREAT unreadable in both languages. The watcher walks the
 *      comments of src/http.ts and refuses TWO signals: a non-ASCII LETTER, and a word that
 *      cannot be English (TURKCE_KELIMELER). One signal was not enough, and this file's own
 *      self-test is what proved it: the sibling residue in kararGunlugu.ts — "etmez, denetim
 *      izi sessizce durur." — carries no diacritic at all, so a diacritic-only rule read it
 *      as clean. Punctuation stays untouched, so the em dashes, "…", "·", "§" and the
 *      box-drawing section rules this file is full of remain legal.
 *
 *      THE EXEMPTION IS PINNED TO A FRAGMENT, NOT TO A LINE OR A FILE (the lesson from
 *      kaynakHijyeni.test.ts): the fragment is removed and what REMAINS is scanned again, so
 *      a second residue pasted next to an exempt quotation is still a finding, and an
 *      exemption that stops matching fails the test rather than standing as a silent permit.
 *      A blanket "strip anything in quotes" rule was deliberately NOT written: it would have
 *      excused every future residue that happens to sit next to a quotation mark, which is
 *      how a watcher gets hollowed out.
 *
 *      LIMIT, stated so a green run is not read as more than it is: both signals are
 *      heuristics. Measured, they catch every residue this translation pass left in the
 *      repository (five, across four files) and fire on nothing in src/http.ts's English
 *      comments — but a residue that carries neither a diacritic nor a listed word would
 *      pass. Watcher 3 is what covers the specific block repaired here, whatever it is
 *      written in.
 *
 *   3) THE PLAINTEXT BLOCK, DOC ↔ CODE. The sentence repaired in this round lives in the
 *      docblock above BIND, and its claims are checkable: the decision comes from config.ts
 *      (duzMetinKarari), the default bind really is 0.0.0.0, a blocked decision exits BEFORE
 *      server.listen (not after), and the warning is gated on the decision alone rather than
 *      on the URL scheme. Move the listen above the exit, or make the warning conditional on
 *      https, and the block's own words become false — which is what this turns red on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KOK = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTTP = readFileSync(join(KOK, "src", "http.ts"), "utf8");

// ── Source helpers ────────────────────────────────────────────────────────

/** One comment, with the 1-based line its opener sits on. */
interface Yorum {
  satir: number;
  metin: string;
}

/**
 * The comments of a source file, and nothing else.
 *
 * A char scanner is required rather than a line filter: `indexOf("//")` reads the "//" of
 * "https://oauth2.googleapis.com/token" as a comment opener, and a quote counter is broken by
 * this very file's `/[&<>"']/g` — a regex literal holding both quote characters. String,
 * template, regex and comment states are therefore tracked properly; the two known-hard
 * shapes are pinned in the self-test below.
 */
function yorumlar(kaynak: string): Yorum[] {
  const bulunan: Array<{ bas: number; metin: string }> = [];
  // Brace depth of every open template literal; 0 means "inside its literal text".
  const sablon: number[] = [];
  // Regex-vs-division heuristic: a "/" is a division only after a value.
  const ANAHTAR = /(?:return|typeof|case|await|yield|new|throw|delete|void|in|of|do|else)$/;
  let sonAnlamli = "";
  let sonKelime = "";
  let i = 0;
  while (i < kaynak.length) {
    const ch = kaynak[i];
    const derinlik = sablon.length ? sablon[sablon.length - 1] : -1;
    if (derinlik === 0) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        sablon.pop();
        i++;
        sonAnlamli = "x";
        sonKelime = "";
        continue;
      }
      if (ch === "$" && kaynak[i + 1] === "{") {
        sablon[sablon.length - 1] = 1;
        i += 2;
        sonAnlamli = "{";
        sonKelime = "";
        continue;
      }
      i++;
      continue;
    }
    if (ch === "/" && kaynak[i + 1] === "/") {
      const s = kaynak.indexOf("\n", i);
      const son = s < 0 ? kaynak.length : s;
      bulunan.push({ bas: i, metin: kaynak.slice(i + 2, son) });
      i = son;
      continue;
    }
    if (ch === "/" && kaynak[i + 1] === "*") {
      const s = kaynak.indexOf("*/", i + 2);
      const son = s < 0 ? kaynak.length : s + 2;
      bulunan.push({ bas: i, metin: kaynak.slice(i + 2, Math.max(i + 2, son - 2)) });
      i = son;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < kaynak.length) {
        if (kaynak[j] === "\\") {
          j += 2;
          continue;
        }
        if (kaynak[j] === ch || kaynak[j] === "\n") {
          j++;
          break;
        }
        j++;
      }
      i = j;
      sonAnlamli = "x";
      sonKelime = "";
      continue;
    }
    if (ch === "`") {
      sablon.push(0);
      i++;
      continue;
    }
    if (ch === "/" && (!/[A-Za-z0-9_$)\]]/.test(sonAnlamli) || ANAHTAR.test(sonKelime))) {
      let j = i + 1;
      let sinif = false;
      while (j < kaynak.length) {
        const k = kaynak[j];
        if (k === "\\") {
          j += 2;
          continue;
        }
        if (k === "\n") break;
        if (k === "[") sinif = true;
        else if (k === "]") sinif = false;
        else if (k === "/" && !sinif) {
          j++;
          while (j < kaynak.length && /[a-z]/.test(kaynak[j])) j++;
          break;
        }
        j++;
      }
      i = j;
      sonAnlamli = "x";
      sonKelime = "";
      continue;
    }
    if (derinlik > 0) {
      if (ch === "{") sablon[sablon.length - 1] = derinlik + 1;
      else if (ch === "}") {
        sablon[sablon.length - 1] = derinlik - 1;
        if (derinlik - 1 === 0) {
          i++;
          sonAnlamli = "x";
          sonKelime = "";
          continue;
        }
      }
    }
    if (!/\s/.test(ch)) {
      sonAnlamli = ch;
      sonKelime = /[A-Za-z0-9_$]/.test(ch) ? sonKelime + ch : "";
    }
    i++;
  }
  return bulunan.map((y) => ({
    satir: kaynak.slice(0, y.bas).split("\n").length,
    metin: y.metin,
  }));
}

/** The body between the braces of the function whose signature text is `imza`. */
function govdeAl(kaynak: string, imza: string): string {
  const bas = kaynak.indexOf(imza);
  assert.notEqual(bas, -1, `'${imza}' bulunamadı — gözcünün yolu bayatlamış`);
  const acik = kaynak.indexOf("{", bas);
  let derinlik = 0;
  for (let i = acik; i < kaynak.length; i++) {
    if (kaynak[i] === "{") derinlik++;
    else if (kaynak[i] === "}") {
      derinlik--;
      if (derinlik === 0) return kaynak.slice(acik + 1, i);
    }
  }
  assert.fail(`'${imza}' gövdesi kapanmıyor — kaynak ayrıştırılamadı`);
}

/**
 * The JSDoc block immediately above `imza`. "Immediately" is enforced: only whitespace may
 * sit between the block's closing delimiter and the signature, so a block that has drifted
 * declaration is a failure rather than a silently-returned wrong block.
 */
function ustBelgeAl(kaynak: string, imza: string): string {
  const bas = kaynak.indexOf(imza);
  assert.notEqual(bas, -1, `'${imza}' bulunamadı — gözcünün yolu bayatlamış`);
  const kapanis = kaynak.lastIndexOf("*/", bas);
  const acilis = kaynak.lastIndexOf("/**", kapanis);
  assert.ok(acilis !== -1 && kapanis > acilis, `'${imza}' üstünde JSDoc bloğu yok`);
  assert.match(
    kaynak.slice(kapanis + 2, bas),
    /^\s*$/,
    `'${imza}' ile üstündeki JSDoc bloğu arasına kod girmiş: blok artık bu bildirimin ` +
      `dokümantasyonu değil ve IDE hover'ında görünmez.`
  );
  return kaynak.slice(acilis + 3, kapanis);
}

// ── 1) sweep(): the docblock is a list, and the list is checked both ways ──

const SWEEP_IMZA = "function sweep(): void {";

/** Collections this body drops entries from (`x.delete(`) or delegates a sweep to. */
function supurulenler(govde: string): string[] {
  const adlar = new Set<string>();
  for (const m of govde.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\.\s*(?:delete|sweep)\s*\(/g)) {
    adlar.add(m[1]);
  }
  return [...adlar].sort();
}

/** Names the docblock backticks — read as its claim about what gets swept. */
function belgedeAdlar(belge: string): string[] {
  const adlar = new Set<string>();
  for (const m of belge.matchAll(/`([A-Za-z_$][\w$]*)[^`]*`/g)) adlar.add(m[1]);
  return [...adlar].sort();
}

test("sweep(): belgesinin saydığı koleksiyonlarla süpürdükleri BİREBİR aynı", () => {
  const govde = govdeAl(HTTP, SWEEP_IMZA);
  const belge = ustBelgeAl(HTTP, SWEEP_IMZA);
  const supurulen = supurulenler(govde);
  const belgede = belgedeAdlar(belge);

  assert.ok(
    supurulen.length >= 4,
    `sweep() gövdesinde süpürülen koleksiyon bulunamadı (${supurulen.length}) — desen ` +
      `bayatlamış olabilir. Sıfıra yakın bir sayı "temiz" değil, "kör" demektir.`
  );
  assert.deepEqual(
    supurulen,
    belgede,
    `sweep()'in belgesi ile gövdesi ayrışmış.\n` +
      `  gövde süpürüyor: ${supurulen.join(", ")}\n` +
      `  belge sayıyor  : ${belgede.join(", ")}\n` +
      `Bu bulgunun tam şekli: sunucu tarafı state havuzu silindiğinde bu satır "OAuth ` +
      `state'i de temizler" demeye devam etti ve hiçbir yerde çalışmayan bir kontrolü ` +
      `vaat etti. Bir koleksiyonun süpürmesini kaldırıyorsan cümleden de çıkar; yeni bir ` +
      `koleksiyon süpürüyorsan belgeye ADINI ters tırnak içinde yaz. Blokta ters tırnaklı ` +
      `her ad "bu süpürülüyor" iddiasıdır — başka bir şeye atıf yapacaksan tırnaksız yaz.`
  );
});

test("sweep(): 'OAuth state' iddiası harcanmış state kaydına dayanıyor", () => {
  const govde = govdeAl(HTTP, SWEEP_IMZA);
  assert.match(
    govde,
    /harcananState\.delete\(/,
    `sweep() harcanmış state kaydını artık düşürmüyor. Bu kayıt, state'in TEK KULLANIMLIK ` +
      `olmasını sağlayan mekanizmanın hafızasıdır (stateHarcandiMi); süpürülmezse ya süresiz ` +
      `büyür ya da — silinirse — belgedeki "OAuth state" cümlesi yine karşılıksız kalır.`
  );
  assert.match(
    HTTP,
    /const harcananState = new Map<string, number>\(\)/,
    "harcananState haritası kaybolmuş — bu testin dayandığı yapı değişmiş"
  );
});

// ── 2) No translation residue in the comments of src/http.ts ──────────────

/** Non-ASCII LETTERS only: "—", "…", "·", "§", "→" and the box-drawing rules are
 * punctuation and belong to this file's house style. */
function yabanciHarfler(metin: string): string[] {
  return [...metin].filter((c) => !/^[\x00-\x7F]$/.test(c) && /\p{L}/u.test(c));
}

/**
 * Pinned exemptions. Each clears its OWN fragment and nothing else: the fragment is removed
 * and the remainder is scanned again, so a residue pasted beside an exempt quotation is still
 * a finding. An exemption that matches nothing fails the test — a permit left behind after
 * its line is gone would quietly forgive the next one.
 */
const YABANCI_MUAFLARI: Array<{ parca: string; gerekce: string }> = [
  {
    parca: "ya da kullanıcıları yeniden bağla",
    gerekce:
      "Türkçe bir OPERATÖR MESAJINDAN alıntı: çıkarılmış olan o cümlenin neden çıkarıldığını " +
      "anlatan yorum, cümleyi tırnak içinde birebir aktarıyor. Çeviri artığı değil, kanıt.",
  },
];

/**
 * THE SECOND SIGNAL: words that cannot be English, whole-word and case-insensitive.
 *
 * A diacritic rule alone is blind to half of these residues — "etmez, denetim izi sessizce
 * durur." is pure ASCII. The list is short and deliberately unremarkable: Turkish verbs,
 * negatives and adverbs whose letters happen to spell nothing in English. Whole-word matching
 * is what keeps it quiet inside this repository's Turkish IDENTIFIERS (kotuIstekPencereleri,
 * duzMetinKarari), which are code, not prose, and inside English words that merely contain
 * one of them (register, sister).
 */
const TURKCE_KELIMELER = [
  "etmez", "edilmez", "edilir", "olmaz", "olur", "kalamaz", "kalir", "kalır", "dokunulmaz",
  "gelir", "girmez", "gecmez", "geçmez", "yoktur", "vardir", "vardır", "asla", "yalniz",
  "yalnız", "cunku", "çünkü", "degil", "değil", "icin", "için", "sessizce", "durur",
  "sorulmaz", "yapilir", "yapılır", "yapilmaz", "yapılmaz", "gerekir", "ister", "verir",
  "atlanabilir", "hâle", "okunur", "modele", "denetim",
];
const TURKCE_DESEN = new RegExp(`\\b(?:${TURKCE_KELIMELER.join("|")})\\b`, "giu");

/** A readable window around the first offending character or word. */
function ozet(metin: string, isaret: string): string {
  const idx = Math.max(0, metin.indexOf(isaret));
  return metin
    .slice(Math.max(0, idx - 70), idx + 70)
    .replace(/\s+/g, " ")
    .trim();
}

function artikTara(kaynak: string): Array<{ satir: number; isaret: string; ozet: string }> {
  const bulgular: Array<{ satir: number; isaret: string; ozet: string }> = [];
  for (const y of yorumlar(kaynak)) {
    let kalan = y.metin;
    for (const mu of YABANCI_MUAFLARI) {
      if (kalan.includes(mu.parca)) kalan = kalan.split(mu.parca).join(" ");
    }
    const harfler = [...new Set(yabanciHarfler(kalan))];
    const kelimeler = kalan.match(TURKCE_DESEN) ?? [];
    if (harfler.length || kelimeler.length) {
      const ilk = harfler[0] ?? kelimeler[0];
      bulgular.push({
        satir: y.satir,
        isaret: [...harfler, ...new Set(kelimeler.map((k) => k.toLowerCase()))].join(" "),
        ozet: ozet(kalan, ilk),
      });
    }
  }
  return bulgular;
}

test("src/http.ts yorumları İngilizce: yarım kalmış çeviri kuyruğu yok", () => {
  const hepsi = yorumlar(HTTP);
  const toplam = hepsi.reduce((n, y) => n + y.metin.length, 0);
  assert.ok(
    hepsi.length >= 60 && toplam >= 10_000,
    `src/http.ts'te yorum bulunamadı (${hepsi.length} blok / ${toplam} karakter) — tarayıcı ` +
      `bozulmuş demektir. Taranmayan satır bulgu üretmez; sessiz bir tarayıcı "temiz" değil, ` +
      `"kör"dür.`
  );

  const bulgular = artikTara(HTTP);
  assert.deepEqual(
    bulgular.map((b) => `src/http.ts:${b.satir} [${b.isaret}] ${b.ozet}`),
    [],
    `Yorumda Türkçe kalıntısı var (ASCII dışı harf ya da İngilizce olamayacak kelime) — ` +
      `Türkçe→İngilizce çeviri turundan kalma yarım cümle ` +
      `bu şekilde görünüyordu ("…published on 0.0.0.0 / ters vekil atlanabilir hâle gelir."): ` +
      `İngilizce yarısı öznesiz, Türkçe yarısı yüklemsiz, hiçbir dilde okunmuyor. Cümleyi ` +
      `İngilizce tamamla. Bilinçli bir Türkçe ALINTIYSA YABANCI_MUAFLARI'na gerekçesiyle, ` +
      `TAM PARÇA olarak ekle.`
  );

  const kullanilan = new Set<string>();
  for (const y of yorumlar(HTTP)) {
    for (const mu of YABANCI_MUAFLARI) if (y.metin.includes(mu.parca)) kullanilan.add(mu.parca);
  }
  assert.deepEqual(
    YABANCI_MUAFLARI.filter((mu) => !kullanilan.has(mu.parca)).map((mu) => mu.parca),
    [],
    `Hiçbir şeyle eşleşmeyen muafiyet(ler). Alıntı silindiyse muafiyet de silinmeli — duran ` +
      `bir izin, bir sonraki çeviri artığını sessizce affeder.`
  );
});

/**
 * The scanner is behaviour too, so it is locked like behaviour: the shapes that make a naive
 * line filter wrong must not become comments, and the residue shape must be caught. Samples
 * are plain quoted strings, so they are source TEXT rather than code.
 */
const YORUM_KOTU_ORNEKLER: Array<[string, string]> = [
  ["satır sonu artığı", "// listener is plain HTTP\n// ters vekil atlanabilir hâle gelir."],
  // ASCII throughout: caught by the word list alone, which is why the word list exists.
  ["aksansız artık", "/**\n * nobody\n * etmez, denetim izi sessizce durur.\n */"],
  ["kod satırının sonundaki yorum", 'const u = "https://x.example/a"; // hâlâ yarım'],
];

const YORUM_TEMIZ_ORNEKLER: Array<[string, string]> = [
  ["URL yorum değildir", 'const u = "https://oauth2.googleapis.com/token";'],
  ["tırnak içeren regex ayrıştırmayı bozmaz", 'const e = (s) => s.replace(/[&<>"\']/g, "*");'],
  ["şablon içindeki // yorum değildir", "const t = `${a}//${b}`;"],
  ["Türkçe ÜRÜN metni yorum değildir", 'json(res, 400, { hint: "Önce initialize çağır." });'],
  ["ASCII dışı NOKTALAMA serbest", "// the listener itself is plain HTTP — see §13 · ok…"],
  // Whole-word matching: the list must not fire inside an English word or a Turkish identifier.
  ["kelime listesi İngilizce kelimenin içinde patlamaz", "// the register and its sister lister"],
  ["Türkçe TANIMLAYICI adı yorumda serbest", "// see kotuIstekPencereleri and duzMetinKarari"],
];

test("yorum tarayıcısı: kodu yorum sanmaz, artığı da kaçırmaz", () => {
  for (const [ad, ornek] of YORUM_KOTU_ORNEKLER) {
    assert.ok(artikTara(ornek).length > 0, `yakalanmalıydı ama sessiz kaldı: ${ad}`);
  }
  for (const [ad, ornek] of YORUM_TEMIZ_ORNEKLER) {
    assert.deepEqual(artikTara(ornek), [], `yanlış alarm: ${ad}`);
  }
  // The pinned exemption must clear its own fragment — and only that.
  assert.deepEqual(
    artikTara('// "…ya da kullanıcıları yeniden bağla" — an instruction that needs /connect'),
    [],
    "muaf alıntı yine de bulgu üretti — muafiyet parçası kaynakla eşleşmiyor"
  );
  assert.ok(
    artikTara('// "…ya da kullanıcıları yeniden bağla" — ve devamı: hâlâ yarım').length > 0,
    "muaf parçanın yanına yapıştırılan İKİNCİ artık affedildi — muafiyet parçaya değil " +
      "satıra çakılmış demektir"
  );
});

// ── 3) The plaintext block says what the code does ────────────────────────

const BIND_IMZA = "const BIND = process.env.AEGIS_BIND";

test("düz metin bloğu: iddiaları kodla örtüşüyor (0.0.0.0, ters vekil, açılıştan önce)", () => {
  const belge = ustBelgeAl(HTTP, BIND_IMZA);
  for (const anahtar of ["AEGIS_ALLOW_PLAINTEXT", "duzMetinKarari", "0.0.0.0", "reverse proxy"]) {
    assert.ok(
      belge.includes(anahtar),
      `Düz metin bloğu '${anahtar}' ifadesini artık taşımıyor. Bu blok, AEGIS_ALLOW_PLAINTEXT ` +
        `kapısının NEDEN var olduğunu anlatan tek yer; tehdidi ("0.0.0.0'da yayımlanınca ters ` +
        `vekil atlanabilir hâle gelir") söylemeyen bir gerekçe, gerekçe değildir.`
    );
  }

  assert.match(
    HTTP,
    /const BIND = process\.env\.AEGIS_BIND\?\.trim\(\) \|\| "0\.0\.0\.0";/,
    "Varsayılan bağlanma adresi 0.0.0.0 değilse bloktaki '0.0.0.0' cümlesi yanlıştır"
  );
  assert.match(
    HTTP,
    /izinVerildi: parseBool\(process\.env\.AEGIS_ALLOW_PLAINTEXT/,
    "Kararı besleyen izin artık AEGIS_ALLOW_PLAINTEXT'ten gelmiyor — blok bayatlamış"
  );

  const engelIdx = HTTP.indexOf("if (duzMetin.engel)");
  const listenIdx = HTTP.indexOf("server.listen(");
  assert.ok(engelIdx > 0 && listenIdx > 0, "düz metin kararı ya da server.listen bulunamadı");
  assert.ok(
    engelIdx < listenIdx,
    `Karar server.listen'dan SONRA sınanıyor. Blok "If it blocks, the process does NOT listen ` +
      `at all" diyor; bu sırada süreç şifresiz adresi zaten açmış olur ve cümle yalan olur.`
  );
  assert.match(
    HTTP.slice(engelIdx, listenIdx),
    /process\.exit\(1\)/,
    "Engellenen karar süreci sonlandırmıyor — 'hiç dinlemez' iddiası karşılıksız"
  );

  const dinlemeBlogu = HTTP.slice(listenIdx);
  assert.match(
    dinlemeBlogu,
    /if \(duzMetin\.uyari\)/,
    "Uyarı artık kararın kendisine bağlı değil — blok bunu açıkça iddia ediyor"
  );
  assert.doesNotMatch(
    dinlemeBlogu,
    /startsWith\("https/,
    `Uyarı URL şemasına göre susturulmuş. Blok "does not fall silent even when PUBLIC_URL is ` +
      `https" diyor: dinleyicinin kendisi düz HTTP olduğu için https bir PUBLIC_URL uyarıyı ` +
      `geçersiz kılmaz.`
  );
});
