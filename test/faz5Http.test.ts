// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ROUND-5 COVER — src/http.ts.
 *
 * Round 5 measured the round-3/4 repairs on this file rather than the file itself, and what
 * it found was one shape repeated: a WATCHER THAT PASSES FOR THE WRONG REASON. Two of them
 * were proven hollow by mutation (a sweep added with `.clear()` instead of `.delete(`, and the
 * plaintext warning silenced ABOVE server.listen instead of below it), a price table vouched
 * for a cost nothing compared against the code, and two comments described a design the code
 * had stopped having. So every watcher here states what it can turn red on, and each one was
 * measured red by putting the thing it forbids into the source.
 *
 * WHAT EACH WATCHER COVERS:
 *
 *   1) SWEEP: DOC <-> CODE, BOTH WAYS, EVERY SPELLING. The predecessor
 *      (test/faz4Http.test.ts) matched a BARE identifier followed by `.delete(` or `.sweep(`.
 *      MEASURED: adding `pendingSessions.clear();` to sweep()'s body and writing nothing in
 *      its docblock left the whole suite green — the promise "adding one silently fails
 *      there" held for one spelling out of several. This one reads delete, clear and sweep,
 *      on a bare name or on a member path, off a source scan that ignores strings and
 *      comments.
 *
 *   2) THE WINDOWS ARE SLIDING, AND THAT IS MEASURED RATHER THAN READ. The two ceilings this
 *      file adds for the surfaces `limiter` does not reach were TUMBLING windows: the counter
 *      was zeroed once the span had elapsed. MEASURED on the shipped form with a controlled
 *      clock: 119 requests inside 101 ms against a ceiling published as 60 a minute. Rather
 *      than pin the shape of the source, this watcher EXTRACTS the window functions out of
 *      src/http.ts, transpiles them and RUNS them against a fake clock — src/http.ts is an
 *      entry point and cannot be imported, but its text can still be executed.
 *
 *   3) THE HARVEST PRICE LIST IS NAILED TO THE CODE. mesajIslemBedeli charges 1 for anything
 *      it does not recognise, so a harvesting surface missing from HASAT_ARACLARI /
 *      HASAT_KAYNAKLARI is a silent discount rather than a failure. src/ is walked for every
 *      MCP registration whose handler reaches AdsContext.tumHesaplar or
 *      listAccessibleCustomers — directly or through a helper — and each one has to appear in
 *      the price list.
 *
 *   4) THE DEFAULT RATE CEILING CARRIES AN ORDINARY TURN. Charging the harvest at 61
 *      operations while leaving the ceiling at the 120 chosen for a one-token message meant
 *      list_accounts followed by a read of aegis://accounts cost 122 and met a 429. The
 *      shipped default is read out of the source and run through the real RateLimiter.
 *
 *   5) THE PLAINTEXT WARNING CANNOT BE SILENCED, WHEREVER THE SILENCING IS WRITTEN. The
 *      predecessor only scanned BELOW server.listen, so deriving a muted decision ABOVE it
 *      passed. This one pins the decision to a single unmodified binding instead of scanning
 *      one slice of the file.
 *
 *   6) META TOOLS ARE ACTUALLY GONE IN HOSTED MODE. The startup warning used to say they were
 *      switched off while buildServer registered all three and every call answered by naming
 *      AEGIS_META_TOKEN undefined — two surfaces contradicting each other. The removal
 *      function is extracted from src/http.ts and run against a real buildServer instance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { RateLimiter } from "../src/rateLimit.js";
import { lruYerAc } from "../src/util.js";
import { buildServer } from "../src/server.js";

const KOK = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTTP = readFileSync(join(KOK, "src", "http.ts"), "utf8");
const ORNEK_ENV = readFileSync(join(KOK, ".env.example"), "utf8");

// ── A source scanner that does not mistake text for code ──────────────────

interface Dize {
  bas: number;
  son: number;
  deger: string;
}

interface Tarama {
  /** Strings, template text, regex bodies and comments blanked; code and offsets intact. */
  maske: string;
  /** Only comments blanked — for claims about what the CODE says, quotes included. */
  yorumsuz: string;
  /** Every plain string literal, with its span. */
  dizeler: Dize[];
}

/**
 * Masks a TypeScript source so structural scans cannot be fooled by text.
 *
 * A plain `indexOf(".delete(")` reads the one inside a comment, and a quote counter is broken
 * by this repository's own `/[&<>"']/g`. String, template, regex and comment states are
 * therefore tracked; newlines survive masking so offsets and line numbers stay usable.
 */
function tara(kaynak: string): Tarama {
  const maske = kaynak.split("");
  const yorumsuz = kaynak.split("");
  const dizeler: Dize[] = [];
  const bosalt = (dizi: string[], a: number, b: number) => {
    for (let i = a; i < b && i < dizi.length; i++) if (dizi[i] !== "\n") dizi[i] = " ";
  };
  const sablon: number[] = [];
  const ANAHTAR = /(?:return|typeof|case|await|yield|new|throw|delete|void|in|of|do|else)$/;
  let sonAnlamli = "";
  let sonKelime = "";
  let i = 0;
  while (i < kaynak.length) {
    const ch = kaynak[i];
    const derinlik = sablon.length ? sablon[sablon.length - 1] : -1;
    if (derinlik === 0) {
      if (ch === "\\") {
        bosalt(maske, i, i + 2);
        i += 2;
        continue;
      }
      if (ch === "`") {
        sablon.pop();
        bosalt(maske, i, i + 1);
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
      bosalt(maske, i, i + 1);
      i++;
      continue;
    }
    if (ch === "/" && kaynak[i + 1] === "/") {
      const s = kaynak.indexOf("\n", i);
      const son = s < 0 ? kaynak.length : s;
      bosalt(maske, i, son);
      bosalt(yorumsuz, i, son);
      i = son;
      continue;
    }
    if (ch === "/" && kaynak[i + 1] === "*") {
      const s = kaynak.indexOf("*/", i + 2);
      const son = s < 0 ? kaynak.length : s + 2;
      bosalt(maske, i, son);
      bosalt(yorumsuz, i, son);
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
      dizeler.push({ bas: i, son: j, deger: kaynak.slice(i + 1, Math.max(i + 1, j - 1)) });
      bosalt(maske, i, j);
      i = j;
      sonAnlamli = "x";
      sonKelime = "";
      continue;
    }
    if (ch === "`") {
      sablon.push(0);
      bosalt(maske, i, i + 1);
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
      bosalt(maske, i, j);
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
  return { maske: maske.join(""), yorumsuz: yorumsuz.join(""), dizeler };
}

/** Index of the delimiter closing the one at `acikIdx`, or -1. */
function dengeli(maske: string, acikIdx: number, acik: string, kapa: string): number {
  let d = 0;
  for (let i = acikIdx; i < maske.length; i++) {
    if (maske[i] === acik) d++;
    else if (maske[i] === kapa) {
      d--;
      if (d === 0) return i;
    }
  }
  return -1;
}

/** The [open, close] brace span of the function whose signature text is `imza`. */
function govdeAraligi(t: Tarama, imza: string): [number, number] {
  const bas = t.maske.indexOf(imza);
  assert.notEqual(bas, -1, `'${imza}' bulunamadı — gözcünün yolu bayatlamış`);
  const acik = t.maske.indexOf("{", bas);
  const kapa = dengeli(t.maske, acik, "{", "}");
  assert.ok(kapa > acik, `'${imza}' gövdesi kapanmıyor — kaynak ayrıştırılamadı`);
  return [acik, kapa];
}

/**
 * The JSDoc block immediately above `imza`. "Immediately" is enforced: only whitespace may
 * sit between the block's closing delimiter and the signature, so a block that has drifted off
 * its declaration fails rather than being silently returned as the wrong block.
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

// ── 1) sweep(): the docblock is a list, checked both ways, every spelling ──

const SWEEP_IMZA = "function sweep(): void {";

/**
 * Collections this body empties, or delegates a sweep to.
 *
 * THE METHOD LIST AND THE MEMBER FORM ARE THE POINT. The predecessor's pattern read a bare
 * identifier followed by `.delete(` or `.sweep(`; `.clear()` — the most ordinary way to empty
 * a Map — was not in it, and a negative lookbehind made `a.b.delete(` invisible as well.
 * Both spellings were measured green. A member path is reported WHOLE (`a.b`), because that
 * is the collection being emptied and that is what the docblock has to name.
 */
function supurulenler(maskeliGovde: string): string[] {
  const adlar = new Set<string>();
  const desen = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*(?:delete|clear|sweep)\s*\(/g;
  for (const m of maskeliGovde.matchAll(desen)) adlar.add(m[1].replace(/\s+/g, ""));
  return [...adlar].sort();
}

/** Names the docblock backticks — read as its claim about what gets swept. */
function belgedeAdlar(belge: string): string[] {
  const adlar = new Set<string>();
  for (const m of belge.matchAll(/`([A-Za-z_$][\w$.]*)[^`]*`/g)) adlar.add(m[1]);
  return [...adlar].sort();
}

test("sweep(): belgesinin saydığı koleksiyonlarla süpürdükleri BİREBİR aynı", () => {
  const t = tara(HTTP);
  const [acik, kapa] = govdeAraligi(t, SWEEP_IMZA);
  const supurulen = supurulenler(t.maske.slice(acik + 1, kapa));
  const belgede = belgedeAdlar(ustBelgeAl(HTTP, SWEEP_IMZA));

  assert.ok(
    supurulen.length >= 5,
    `sweep() gövdesinde süpürülen koleksiyon sayısı ${supurulen.length} — desen bayatlamış ` +
      `olabilir. Sıfıra yakın bir sayı "temiz" değil, "kör" demektir.`
  );
  assert.deepEqual(
    supurulen,
    belgede,
    `sweep()'in belgesi ile gövdesi ayrışmış.\n` +
      `  gövde süpürüyor: ${supurulen.join(", ")}\n` +
      `  belge sayıyor  : ${belgede.join(", ")}\n` +
      `Blokta ters tırnaklı her ad "bu süpürülüyor" iddiasıdır — başka bir şeye atıf ` +
      `yapacaksan tırnaksız yaz. Bir koleksiyonun süpürmesini kaldırıyorsan cümleden de ` +
      `çıkar; yenisini süpürüyorsan belgeye ADINI ters tırnak içinde ekle.`
  );
});

test("süpürme tarayıcısı: clear/delete/sweep ve üye ifadesi — hepsi görünür", () => {
  const ornek = (govde: string) => supurulenler(tara(`function x() {${govde}}`).maske);
  assert.deepEqual(ornek("a.delete(k);"), ["a"], "çıplak delete kaçtı");
  assert.deepEqual(ornek("a.clear();"), ["a"], "clear() kaçtı — ölçülen deliğin tam şekli bu");
  assert.deepEqual(ornek("a.sweep();"), ["a"], "sweep() devri kaçtı");
  assert.deepEqual(
    ornek("oauthDurum.havuz.delete(k);"),
    ["oauthDurum.havuz"],
    "üye ifadesindeki koleksiyon kaçtı — ölçülen ikinci deliğin şekli bu"
  );
  assert.deepEqual(ornek("yeniHavuz . clear ( );"), ["yeniHavuz"], "boşluklu yazım kaçtı");
  assert.deepEqual(ornek('const s = "a.clear();";'), [], "DİZE içindeki metin süpürme sayıldı");
  assert.deepEqual(ornek("// a.clear();"), [], "YORUM içindeki metin süpürme sayıldı");
  assert.deepEqual(ornek("s.transport.close();"), [], "close() süpürme değildir");
});

test("sweep() bloğunun 'tavan başka yerde' cümlesi kodda karşılığı olan bir iddia", () => {
  const t = tara(HTTP);
  const belge = ustBelgeAl(HTTP, SWEEP_IMZA);
  assert.ok(
    /MAX_SESSIONS/.test(belge) && /lruYerAc/.test(belge) && /limiter/.test(belge),
    `sweep() bloğu artık tavanların NEREDE olduğunu söylemiyor. Bu blok bir tur boyunca ` +
      `"süpürme hepsinin tavanıdır" dedi; ölçüldü, bu yalnız limiter için doğruydu. Cümle ` +
      `silinecekse yerine ölçülebilir bir başkası gelmeli.`
  );
  // The three guards the sentence rests on. Remove one and the sentence becomes false again.
  for (const [kanit, aciklama] of [
    ["lruYerAc(pencereler, kovaTavani);", "iki pencere haritasının kova tavanı"],
    ["lruYerAc(harcananState, HARCANAN_STATE_TAVANI);", "harcanmış state haritasının tavanı"],
    ["if (sessions.size >= MAX_SESSIONS)", "oturum havuzunun tavanı"],
  ] as const) {
    assert.ok(
      t.maske.includes(kanit),
      `${aciklama} kaybolmuş ('${kanit}'). sweep() bloğu bu tavanların süpürmeden BAĞIMSIZ ` +
        `var olduğunu söylüyor; biri gidince o cümle karşılıksız kalır ve süpürme gerçekten ` +
        `o koleksiyonun tek sınırı hâline gelir.`
    );
  }
});

// ── 2) The two windows SLIDE — measured, not read ─────────────────────────

/**
 * The window machinery of src/http.ts, extracted and executed.
 *
 * src/http.ts is an entry point: importing it starts a server, so behaviour there is normally
 * pinned by reading the text. Reading the text is exactly what let a tumbling window sit under
 * a heading that says SLIDING. The declarations below are therefore cut out of the shipped
 * source, transpiled, and run with `Date` replaced by a clock this test moves — the real
 * lruYerAc included, so the bucket ceiling is measured too rather than mocked away.
 */
const PENCERE_PARCALARI = [
  "const PENCERE_MS =",
  "type Pencere =",
  "const OAUTH_DK_TAVANI =",
  "const OAUTH_KOVA_TAVANI =",
  "const oauthPencereleri =",
  "const KOTU_ISTEK_DK_TAVANI =",
  "const KOTU_ISTEK_KOVA_TAVANI =",
  "const kotuIstekPencereleri =",
  "function pencereBuda(",
  "function pencereAl<",
  "function kalanBekleme(",
  "function istemciKovasi(",
  "function oauthKotasi(",
  "function kotuIstekKaydet(",
  "function kotuIstekCezasi(",
];

/** One top-level declaration, verbatim: a function with its body, or a statement to its `;`. */
function bildirimAl(t: Tarama, kaynak: string, imza: string): string {
  const bas = t.maske.indexOf(imza);
  assert.notEqual(bas, -1, `'${imza}' src/http.ts içinde yok — gözcünün yolu bayatlamış`);
  if (imza.startsWith("function ")) {
    const acik = t.maske.indexOf("{", bas);
    const kapa = dengeli(t.maske, acik, "{", "}");
    assert.ok(kapa > acik, `'${imza}' gövdesi kapanmıyor`);
    return kaynak.slice(bas, kapa + 1);
  }
  let d = 0;
  for (let i = bas; i < t.maske.length; i++) {
    const c = t.maske[i];
    if ("([{".includes(c)) d++;
    else if (")]}".includes(c)) d--;
    else if (c === ";" && d === 0) return kaynak.slice(bas, i + 1);
  }
  assert.fail(`'${imza}' bildirimi kapanmıyor`);
}

interface PencereDuzenegi {
  oauthKotasi: (req: unknown) => number | undefined;
  kotuIstekKaydet: (userId: number) => void;
  kotuIstekCezasi: (userId: number) => number | undefined;
  oauthPencereleri: Map<string, number[]>;
  kotuIstekPencereleri: Map<number, number[]>;
  OAUTH_DK_TAVANI: number;
  OAUTH_KOVA_TAVANI: number;
  KOTU_ISTEK_DK_TAVANI: number;
}

function pencereDuzenegi(kaynak: string, saat: { ms: number }): PencereDuzenegi {
  const t = tara(kaynak);
  const parcalar = PENCERE_PARCALARI.map((imza) => bildirimAl(t, kaynak, imza)).join("\n\n");
  const js = ts.transpileModule(parcalar, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const govde =
    `${js}\nreturn { oauthKotasi, kotuIstekKaydet, kotuIstekCezasi, oauthPencereleri, ` +
    `kotuIstekPencereleri, OAUTH_DK_TAVANI, OAUTH_KOVA_TAVANI, KOTU_ISTEK_DK_TAVANI };`;
  const sahteZaman = { now: () => saat.ms };
  return new Function("Date", "lruYerAc", govde)(sahteZaman, lruYerAc) as PencereDuzenegi;
}

/** A socket whose address is what istemciKovasi reads. */
const sahteIstek = (adres: string) => ({ socket: { remoteAddress: adres } });

test("OAuth penceresi KAYAR: dönüm noktasında tavan ikiye katlanmaz", () => {
  const saat = { ms: 1_000_000 };
  const d = pencereDuzenegi(HTTP, saat);
  const req = sahteIstek("1.2.3.4");
  const damgalar: number[] = [];
  const patlat = (n: number) => {
    for (let i = 0; i < n; i++) if (d.oauthKotasi(req) === undefined) damgalar.push(saat.ms);
  };

  const T = saat.ms;
  patlat(1); // the window opens here
  saat.ms = T + 59_900;
  patlat(200); // filled to the ceiling just before the turnover
  saat.ms = T + 60_001;
  patlat(200); // 101 ms later: a tumbling window would hand out a whole new allowance

  let enFazla = 0;
  for (const bas of damgalar) {
    let n = 0;
    for (const dg of damgalar) if (dg >= bas && dg - bas < 60_000) n++;
    enFazla = Math.max(enFazla, n);
  }
  assert.ok(damgalar.length > 0, "hiç istek geçmedi — düzenek kurulmamış, ölçüm anlamsız");
  assert.ok(
    enFazla <= d.OAUTH_DK_TAVANI,
    `Herhangi bir 60 sn penceresinde ${enFazla} istek geçti; ilan edilen tavan ` +
      `${d.OAUTH_DK_TAVANI}/dk. SABİT (tumbling) pencere tam bu şekilde ölçüldü: sayaç süre ` +
      `dolunca sıfırlanınca dönüm noktasında 101 ms içinde 119 istek geçiyordu. Bu yüzey ` +
      `kimlik doğrulaması istemez ve her isteği Google'ın token uç noktasına giden GERÇEK bir ` +
      `POST'a çevirebilir; saatin dönmesini bekleyerek ikiye katlanan bir tavan, bu dosyanın ` +
      `ilan ettiği tavan değildir.`
  );
});

test("reddedilen-istek penceresi KAYAR: dönümde ceza düşmez", () => {
  const saat = { ms: 5_000_000 };
  const d = pencereDuzenegi(HTTP, saat);
  const T = saat.ms;

  // The window is OPENED here, then filled just before the turnover: a tumbling window is
  // discarded when its FIRST hit ages out, so a burst that also opens the window would never
  // show the doubling.
  d.kotuIstekKaydet(7);
  saat.ms = T + 59_900;
  for (let i = 0; i < 50; i++) d.kotuIstekKaydet(7);
  assert.notEqual(d.kotuIstekCezasi(7), undefined, "tavana ulaşıldığı hâlde ceza verilmedi");

  // 101 ms past the turnover exactly ONE hit has genuinely aged out, so exactly one more
  // refusal should bring the ceiling back. A tumbling window throws the whole list away and
  // hands out a fresh allowance — twenty more 4 MB body reads inside a tenth of a second.
  saat.ms = T + 60_001;
  let ekstra = 0;
  while (d.kotuIstekCezasi(7) === undefined && ekstra < 100) {
    d.kotuIstekKaydet(7);
    ekstra++;
  }
  assert.ok(
    ekstra <= 2,
    `Dönümden 101 ms sonra ceza geri gelene kadar ${ekstra} reddedilen istek daha geçti. ` +
      `Kayan pencerede bu sayı 1'dir (yalnız bir vuruş gerçekten eskidi); ${d.KOTU_ISTEK_DK_TAVANI} ` +
      `civarı bir sayı sayacın toptan sıfırlandığını, yani pencerenin SABİT olduğunu gösterir.`
  );

  saat.ms = T + 120_500;
  assert.equal(
    d.kotuIstekCezasi(7),
    undefined,
    "vuruşlar tamamen eskidiği hâlde ceza sürüyor — pencere kaymıyor, kilitleniyor"
  );
});

test("ceza sorgusu kova AÇMAZ; kova sayısı lruYerAc tavanına bağlı", () => {
  const saat = { ms: 9_000_000 };
  const d = pencereDuzenegi(HTTP, saat);

  for (let i = 0; i < 500; i++) d.kotuIstekCezasi(1000 + i);
  assert.equal(
    d.kotuIstekPencereleri.size,
    0,
    `Yalnız SORGU bile kova açıyor. Bu sorgu her kimlik doğrulanmış istekte koşar; kova ` +
      `açması, haritayı olağan yolun doldurması demektir.`
  );

  for (let i = 0; i < d.OAUTH_KOVA_TAVANI + 500; i++) d.oauthKotasi(sahteIstek(`10.0.${i >> 8}.${i & 255}`));
  assert.ok(
    d.oauthPencereleri.size <= d.OAUTH_KOVA_TAVANI,
    `Kova sayısı ${d.oauthPencereleri.size} — tavan ${d.OAUTH_KOVA_TAVANI}. Bu harita kimlik ` +
      `doğrulamamış çağıranlarca besleniyor; tavansız kalması bellek tükenmesi demektir.`
  );
});

// ── 3) The harvest price list is nailed to the code ───────────────────────

const HASAT_KOKLERI = ["tumHesaplar", "listAccessibleCustomers"];

/** Every .ts file under src/, by repository-relative path. */
function kaynakDosyalari(): Map<string, string> {
  const cikti = new Map<string, string>();
  const gez = (dizin: string, onek: string) => {
    for (const girdi of readdirSync(dizin, { withFileTypes: true })) {
      const yol = join(dizin, girdi.name);
      if (girdi.isDirectory()) gez(yol, `${onek}${girdi.name}/`);
      else if (girdi.name.endsWith(".ts")) cikti.set(`${onek}${girdi.name}`, readFileSync(yol, "utf8"));
    }
  };
  gez(join(KOK, "src"), "src/");
  return cikti;
}

interface Bildirim {
  ad: string;
  govde: string;
}

/** Top-level and nested named declarations, with their masked bodies. */
function bildirimler(t: Tarama): Bildirim[] {
  const cikti: Bildirim[] = [];
  for (const m of t.maske.matchAll(/(?:^|\n)[ \t]*(?:export[ \t]+)?(?:async[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)[ \t]*[<(]/g)) {
    const acik = t.maske.indexOf("{", m.index + m[0].length - 1);
    const kapa = dengeli(t.maske, acik, "{", "}");
    if (kapa > acik) cikti.push({ ad: m[1], govde: t.maske.slice(acik, kapa) });
  }
  for (const m of t.maske.matchAll(/(?:^|\n)[ \t]*(?:export[ \t]+)?const[ \t]+([A-Za-z_$][\w$]*)[ \t]*=/g)) {
    let d = 0;
    for (let i = m.index + m[0].length; i < t.maske.length; i++) {
      const c = t.maske[i];
      if ("([{".includes(c)) d++;
      else if (")]}".includes(c)) d--;
      else if (c === ";" && d === 0) {
        cikti.push({ ad: m[1], govde: t.maske.slice(m.index, i) });
        break;
      }
      if (d < 0) break;
    }
  }
  return cikti;
}

/**
 * Names that reach a harvest, directly or through other names. Without the transitive step a
 * helper is all it takes to hide one: reklamHesaplari() calls tumHesaplar() and every
 * completion goes through it.
 */
function hasatciAdlar(dosyalar: Map<string, string>): Set<string> {
  const set = new Set(HASAT_KOKLERI);
  const hepsi: Bildirim[] = [];
  for (const [yol, kaynak] of dosyalar) {
    // adsClient.ts is where the harvest is DEFINED; its internals are not call sites.
    if (yol.endsWith("adsClient.ts")) continue;
    hepsi.push(...bildirimler(tara(kaynak)));
  }
  for (let tur = 0; tur < 10; tur++) {
    let degisti = false;
    for (const b of hepsi) {
      if (set.has(b.ad)) continue;
      for (const h of set) {
        if (new RegExp(`\\b${h}\\s*\\(`).test(b.govde)) {
          set.add(b.ad);
          degisti = true;
          break;
        }
      }
    }
    if (!degisti) break;
  }
  return set;
}

interface Kayit {
  tur: "tool" | "resource" | "prompt";
  dosya: string;
  ad: string;
  uri?: string;
  /** The span with the completion regions taken out — the read/call path alone. */
  okumaYolu: string;
  /** What the completion regions of this registration contain. */
  tamamlama: string;
}

/**
 * Every MCP registration in src/, split into the path a call runs and the path a COMPLETION
 * runs.
 *
 * THE SPLIT IS NAMED, NOT A CLASS. Only two constructs are lifted out — a ResourceTemplate's
 * `complete:` object and a prompt's `argsSchema:` object — because those two run on
 * completion/complete, which mesajIslemBedeli already prices at the full harvest. Everything
 * else stays in. The lifted text is kept and asserted to REALLY contain a harvest, so the
 * exemption cannot quietly become a hole: if completions stop harvesting, this test fails
 * rather than forgiving whatever else hides there.
 */
function kayitlar(dosyalar: Map<string, string>): Kayit[] {
  const cikti: Kayit[] = [];
  for (const [dosya, kaynak] of dosyalar) {
    const t = tara(kaynak);
    for (const m of t.maske.matchAll(/server\s*\.\s*register(Tool|Resource|Prompt)\s*\(/g)) {
      const acik = t.maske.indexOf("(", m.index);
      const kapa = dengeli(t.maske, acik, "(", ")");
      if (kapa < 0) continue;
      const icDizeler = t.dizeler.filter((s) => s.bas > acik && s.son <= kapa);
      const ad = icDizeler[0]?.deger ?? "";
      const uri = icDizeler.find((s) => s.deger.startsWith("aegis://"))?.deger;
      let okumaYolu = t.maske.slice(acik, kapa);
      let tamamlama = "";
      for (const alan of ["complete", "argsSchema"]) {
        const desen = new RegExp(`\\b${alan}\\s*:\\s*\\{`, "g");
        for (const a of [...okumaYolu.matchAll(desen)]) {
          const ic = okumaYolu.indexOf("{", a.index);
          const son = dengeli(okumaYolu, ic, "{", "}");
          if (son > ic) {
            tamamlama += okumaYolu.slice(ic, son);
            okumaYolu = okumaYolu.slice(0, ic) + " ".repeat(son - ic) + okumaYolu.slice(son);
          }
        }
      }
      cikti.push({
        tur: m[1].toLowerCase() as Kayit["tur"],
        dosya,
        ad,
        uri,
        okumaYolu,
        tamamlama,
      });
    }
  }
  return cikti;
}

function hasatEdiyorMu(metin: string, hasatcilar: Set<string>): boolean {
  for (const h of hasatcilar) if (new RegExp(`\\b${h}\\s*\\(`).test(metin)) return true;
  return false;
}

/** The names a `new Set([...])` literal in src/http.ts holds. */
function kumeDegerleri(imza: string): string[] {
  const t = tara(HTTP);
  const bas = t.maske.indexOf(imza);
  assert.notEqual(bas, -1, `'${imza}' src/http.ts içinde yok — fiyat tablosu yeniden adlandırılmış`);
  const acik = t.maske.indexOf("[", bas);
  const kapa = dengeli(t.maske, acik, "[", "]");
  assert.ok(kapa > acik, `'${imza}' küme değişmezi kapanmıyor`);
  return t.dizeler.filter((s) => s.bas > acik && s.son <= kapa).map((s) => s.deger);
}

test("hasat fiyat tablosu kod tabanıyla ÖRTÜŞÜYOR (sessiz 1-jeton indirimi yok)", () => {
  const dosyalar = kaynakDosyalari();
  const hasatcilar = hasatciAdlar(dosyalar);
  const kayit = kayitlar(dosyalar);
  const araclar = new Set(kumeDegerleri("const HASAT_ARACLARI = new Set("));
  const kaynaklar = new Set(kumeDegerleri("const HASAT_KAYNAKLARI = new Set("));

  // The scanner must actually see the surface it is judging. A silent scanner reports
  // nothing and reads as "clean".
  assert.ok(
    kayit.filter((k) => k.tur === "tool").length >= 10,
    `src/ içinde yalnız ${kayit.filter((k) => k.tur === "tool").length} araç kaydı bulundu — ` +
      `tarayıcı kör, "temiz" değil.`
  );
  assert.ok(
    kayit.filter((k) => k.tur === "resource").length >= 3,
    "kaynak kaydı bulunamadı — tarayıcı bayatlamış"
  );
  assert.ok(hasatcilar.has("reklamHesaplari"), "geçişli hasatçı çözümlemesi çalışmıyor");

  const bulgular: string[] = [];
  let hasatEdenArac = 0;
  let hasatEdenKaynak = 0;
  let tamamlamaHasadi = 0;
  for (const k of kayit) {
    if (hasatEdiyorMu(k.tamamlama, hasatcilar)) tamamlamaHasadi++;
    if (!hasatEdiyorMu(k.okumaYolu, hasatcilar)) continue;
    if (k.tur === "tool") {
      hasatEdenArac++;
      if (!araclar.has(k.ad)) bulgular.push(`${k.dosya}: '${k.ad}' aracı HASAT_ARACLARI'nda yok`);
    } else if (k.tur === "resource") {
      hasatEdenKaynak++;
      if (!k.uri) bulgular.push(`${k.dosya}: '${k.ad}' kaynağının URI'si okunamadı`);
      else if (k.uri.includes("{")) {
        bulgular.push(
          `${k.dosya}: '${k.uri}' bir ŞABLON ve okuma yolunda hasat yapıyor — HASAT_KAYNAKLARI ` +
            `birebir eşleşen bir küme, şablonu fiyatlayamaz; mesajIslemBedeli'ne şablon şekli eklenmeli`
        );
      } else if (!kaynaklar.has(k.uri)) {
        bulgular.push(`${k.dosya}: '${k.uri}' kaynağı HASAT_KAYNAKLARI'nda yok`);
      }
    } else {
      bulgular.push(
        `${k.dosya}: '${k.ad}' prompt'unun GÖVDESİ hasat yapıyor; mesajIslemBedeli'nde ` +
          `prompts/get için fiyat şekli yok — 61 işlem 1 jetona gidiyor`
      );
    }
  }

  assert.deepEqual(
    bulgular,
    [],
    `Hasat eden bir yüzey fiyat tablosunda yok. mesajIslemBedeli tanımadığı her şeye 1 biçer, ` +
      `yani eksik bir giriş gürültülü bir arıza değil SESSİZ bir indirimdir: araç çalışır, süit ` +
      `yeşil kalır ve paylaşılan Google kotası yine sayacın göremediği bir çarpanla boşalır.\n` +
      bulgular.map((b) => `  - ${b}`).join("\n")
  );

  // Vacuity guards: each branch above must have judged something real.
  assert.ok(hasatEdenArac >= 1, "hiçbir araç hasat ediyor görünmedi — tarayıcı hasadı tanımıyor");
  assert.ok(hasatEdenKaynak >= 1, "hiçbir kaynak hasat ediyor görünmedi — tarayıcı hasadı tanımıyor");
  assert.ok(
    tamamlamaHasadi >= 1,
    `Ayıklanan tamamlama bölgelerinde hasat KALMAMIŞ. Bu ayıklama, "completion/complete zaten ` +
      `tam fiyattan ücretlendiriliyor" gerekçesine dayanıyor; gerekçe boşa düşerse ayıklama ` +
      `sessiz bir izne dönüşür.`
  );
  assert.match(
    HTTP,
    /if \(method === "completion\/complete"\) return HASAT_ISLEM_BEDELI;/,
    "completion/complete artık tam hasat fiyatından ücretlendirilmiyor — tamamlama ayıklaması karşılıksız kaldı"
  );
});

test("hasat tarayıcısı: yarın eklenen hasatçı bir aracı YAKALAR", () => {
  const dosyalar = new Map<string, string>([
    [
      "src/tools/sahte.ts",
      `export function registerX(server: McpServer, getCtx: ContextProvider): void {
         async function hepsiniTopla() { const { liste } = await getCtx().tumHesaplar(); return liste; }
         server.registerTool("yeni_hasatci", { title: "x" }, async () => hepsiniTopla());
         server.registerTool("ucuz_arac", { title: "y" }, async () => "ok");
       }`,
    ],
  ]);
  const hasatcilar = hasatciAdlar(dosyalar);
  const kayit = kayitlar(dosyalar);
  const hasatEden = kayit.filter((k) => hasatEdiyorMu(k.okumaYolu, hasatcilar)).map((k) => k.ad);
  assert.deepEqual(
    hasatEden,
    ["yeni_hasatci"],
    "yardımcı üzerinden hasat eden yeni araç görülmedi (ya da hasat etmeyen araç yanlışlıkla sayıldı)"
  );
});

// ── 4) The default ceiling carries an ordinary turn ───────────────────────

/** A number literal declared in src/http.ts, underscores and all. */
function sayiSabiti(ad: string): number {
  const m = HTTP.match(new RegExp(`const ${ad} = ([0-9_]+);`));
  assert.ok(m, `src/http.ts içinde '${ad}' sayı sabiti yok — gözcünün yolu bayatlamış`);
  return Number(m[1].replace(/_/g, ""));
}

test("varsayılan hız tavanı SIRADAN bir turu taşır (list_accounts + aegis://accounts)", () => {
  const hasat = sayiSabiti("HASAT_ISLEM_BEDELI");
  const dakika = sayiSabiti("VARSAYILAN_DK_ISLEM");
  const gun = sayiSabiti("VARSAYILAN_GUN_ISLEM");

  assert.match(
    HTTP,
    /perMinute: parseNumEnv\("AEGIS_RATE_PER_MINUTE", process\.env\.AEGIS_RATE_PER_MINUTE, VARSAYILAN_DK_ISLEM\)/,
    "dakikalık varsayılan artık VARSAYILAN_DK_ISLEM'den gelmiyor — ölçülen sayı ile koşan sayı ayrışmış"
  );

  const rl = new RateLimiter({ perMinute: dakika, perDay: gun });
  const ilk = rl.check(1, hasat); // tools/call list_accounts
  const ikinci = rl.check(1, hasat); // resources/read aegis://accounts
  const ucuncu = rl.check(1, hasat); // completion/complete (bir tuş vuruşu)
  assert.ok(
    ilk.allowed && ikinci.allowed && ucuncu.allowed,
    `Varsayılan ayarda sıradan bir tur reddediliyor: hasat ${hasat} işlem, tavan ${dakika}/dk. ` +
      `ÖLÇÜLDÜ (120/dk ile): "hesapları listele, sonra hesap kaynağını oku" ikinci adımda 429 ` +
      `alıyordu; 61'lik fiyat, MESAJ birimi için seçilmiş bir tavanla çarpışıyor. Yön fail-closed ` +
      `olduğu için tehlikeli değil, ama olağan turu reddeden bir tavan operatöre "körlemesine ` +
      `yükselt" dedirtir. ilk=${JSON.stringify(ilk)} ikinci=${JSON.stringify(ikinci)} ` +
      `ucuncu=${JSON.stringify(ucuncu)}`
  );

  const ornekDk = ORNEK_ENV.match(/^AEGIS_RATE_PER_MINUTE=(\d+)$/m);
  const ornekGun = ORNEK_ENV.match(/^AEGIS_RATE_PER_DAY=(\d+)$/m);
  assert.ok(ornekDk && ornekGun, ".env.example hız satırları okunamadı");
  assert.equal(
    Number(ornekDk[1]),
    dakika,
    `.env.example dakikalık tavanı ${ornekDk[1]} veriyor, kod varsayılanı ${dakika}. Operatör ` +
      `şablonu kopyalar: kodda düzeltilip şablonda bırakılan bir sayı, kusuru operatörün ` +
      `makinesinde aynen geri açar.`
  );
  assert.equal(Number(ornekGun[1]), gun, ".env.example günlük tavanı kod varsayılanıyla ayrışmış");
});

// ── 5) The plaintext warning cannot be silenced ───────────────────────────

const BIND_IMZA = "const BIND = process.env.AEGIS_BIND";

/**
 * The plaintext decision, checked as a STRUCTURE rather than as a slice of the file.
 *
 * The predecessor scanned only the text BELOW server.listen for a scheme test, so N5 —
 * deriving a muted copy of the decision ABOVE the listen — passed. The claims are therefore
 * pinned where they are made: the decision is ONE const bound directly to duzMetinKarari, it
 * is never reassigned, and the warning hangs on that binding alone.
 */
function duzMetinBulgulari(kaynak: string): string[] {
  const t = tara(kaynak);
  const bulgular: string[] = [];

  const dogrudan = [...t.maske.matchAll(/const duzMetin\s*=\s*duzMetinKarari\s*\(\s*\{/g)];
  if (dogrudan.length !== 1) {
    bulgular.push(
      `'const duzMetin = duzMetinKarari({' ${dogrudan.length} kez geçiyor. Karar TEK bir ` +
        `bağlamada, doğrudan duzMetinKarari'den gelmeli: ara bir değişkenden türetilen kopya ` +
        `(duzMetinHam gibi) uyarıyı server.listen'DAN ÖNCE susturmanın yoludur.`
    );
  }
  const cagri = [...t.maske.matchAll(/\bduzMetinKarari\s*\(/g)];
  if (cagri.length !== 1) bulgular.push(`duzMetinKarari ${cagri.length} kez çağrılıyor; tek çağrı olmalı`);

  const atamalar = [...t.maske.matchAll(/\bduzMetin(?![\w$])\s*(?:\.\s*[A-Za-z_$][\w$]*\s*)*=(?![=>])/g)];
  for (const a of atamalar) {
    if (!/const\s+$/.test(t.maske.slice(Math.max(0, a.index - 8), a.index))) {
      bulgular.push(
        `duzMetin (ya da bir alanı) yeniden atanıyor: '${a[0].replace(/\s+/g, " ")}'. ` +
          `'duzMetin.uyari = undefined' tam olarak bu şekildedir ve uyarıyı sessizce yok eder.`
      );
    }
  }

  if (!/if \(duzMetin\.uyari\) console\.error\(/.test(t.maske)) {
    bulgular.push(
      "Uyarı artık 'if (duzMetin.uyari) console.error(' biçiminde ve yalnız kararın kendisine " +
        "bağlı değil — koşula eklenen her şey bloğun 'https bile susturmaz' cümlesini yalanlar."
    );
  }

  const engelIdx = t.maske.indexOf("if (duzMetin.engel)");
  const listenIdx = t.maske.indexOf("server.listen(");
  if (engelIdx < 0 || listenIdx < 0) bulgular.push("düz metin kararı ya da server.listen bulunamadı");
  else {
    if (engelIdx > listenIdx) bulgular.push("Karar server.listen'dan SONRA sınanıyor — 'hiç dinlemez' yalan olur");
    if (!/process\.exit\(1\)/.test(t.maske.slice(engelIdx, listenIdx)))
      bulgular.push("Engellenen karar süreci sonlandırmıyor — 'hiç dinlemez' karşılıksız");
  }

  /**
   * The scheme test, banned across the WHOLE decision region rather than one slice of it.
   * Comments are dropped first because a comment cannot silence a warning — and the block's
   * own prose legitimately contains the word. Strings are kept, which is what makes
   * `startsWith("https")` visible.
   */
  const bindIdx = t.maske.indexOf(BIND_IMZA);
  if (bindIdx < 0) bulgular.push("BIND bildirimi bulunamadı — gözcünün yolu bayatlamış");
  else {
    const bolge = t.yorumsuz.slice(bindIdx);
    if (!/duzMetinKarari/.test(bolge)) bulgular.push("karar bölgesi boş çıktı — gözcü kör");
    if (/https/.test(bolge)) {
      bulgular.push(
        `Karar bölgesinde 'https' geçiyor: uyarı URL şemasına göre susturulmuş olabilir. Blok ` +
          `"does not fall silent even when PUBLIC_URL is https" diyor — dinleyicinin kendisi düz ` +
          `HTTP olduğu için https bir PUBLIC_URL uyarıyı geçersiz kılmaz.`
      );
    }
  }
  return bulgular;
}

test("düz metin uyarısı susturulamaz (karar tek bağlamada, yeniden atanmıyor)", () => {
  assert.deepEqual(duzMetinBulgulari(HTTP), []);

  const belge = ustBelgeAl(HTTP, BIND_IMZA);
  for (const anahtar of ["AEGIS_ALLOW_PLAINTEXT", "duzMetinKarari", "0.0.0.0", "reverse proxy"]) {
    assert.ok(
      belge.includes(anahtar),
      `Düz metin bloğu '${anahtar}' ifadesini artık taşımıyor; tehdidi söylemeyen bir gerekçe gerekçe değildir.`
    );
  }
  assert.match(
    HTTP,
    /const BIND = process\.env\.AEGIS_BIND\?\.trim\(\) \|\| "0\.0\.0\.0";/,
    "Varsayılan bağlanma adresi 0.0.0.0 değilse bloktaki '0.0.0.0' cümlesi yanlıştır"
  );
});

test("düz metin gözcüsü: ölçülen iki mutasyonu da KIRMIZI görür", () => {
  const N1 = HTTP.replace(
    "if (duzMetin.engel) {",
    "duzMetin.uyari = undefined;\nif (duzMetin.engel) {"
  );
  assert.notEqual(N1, HTTP, "N1 mutasyonu uygulanamadı — gözcünün dayandığı metin değişmiş");
  assert.ok(duzMetinBulgulari(N1).length > 0, "N1 (duzMetin.uyari = undefined) yakalanmadı");

  const N5 = HTTP.replace("const duzMetin = duzMetinKarari({", "const duzMetinHam = duzMetinKarari({").replace(
    'izinVerildi: parseBool(process.env.AEGIS_ALLOW_PLAINTEXT, false, "AEGIS_ALLOW_PLAINTEXT"),\n});',
    'izinVerildi: parseBool(process.env.AEGIS_ALLOW_PLAINTEXT, false, "AEGIS_ALLOW_PLAINTEXT"),\n});\n' +
      'const duzMetin = PUBLIC_URL.startsWith("https") ? { ...duzMetinHam, uyari: undefined } : duzMetinHam;'
  );
  assert.notEqual(N5, HTTP, "N5 mutasyonu uygulanamadı — gözcünün dayandığı metin değişmiş");
  assert.ok(
    duzMetinBulgulari(N5).length > 0,
    "N5 (server.listen'DAN ÖNCE https'e göre susturma) yakalanmadı — eski gözcünün tam deliği bu"
  );

  // And it must not fire on an innocent rewrite of the same decision.
  const temiz = HTTP.replace("if (duzMetin.engel) {", "if (duzMetin.engel) {\n  // note\n");
  assert.deepEqual(duzMetinBulgulari(temiz), [], "zararsız düzenleme yanlış alarm üretti");
});

// ── 6) Meta tools are not offered in hosted mode ──────────────────────────

/** Tool names src/tools/meta.ts registers. */
function metaAracAdlari(): string[] {
  const kaynak = readFileSync(join(KOK, "src", "tools", "meta.ts"), "utf8");
  const t = tara(kaynak);
  const adlar: string[] = [];
  for (const m of t.maske.matchAll(/server\s*\.\s*registerTool\s*\(/g)) {
    const acik = t.maske.indexOf("(", m.index);
    const kapa = dengeli(t.maske, acik, "(", ")");
    const ilk = t.dizeler.find((s) => s.bas > acik && s.son <= kapa);
    if (ilk) adlar.push(ilk.deger);
  }
  return adlar.sort();
}

test("HOSTED_KAPALI_ARACLAR listesi meta.ts'in kaydettiği araçların TAMAMI", () => {
  const listelenen = kumeDegerleri("const HOSTED_KAPALI_ARACLAR = [").sort();
  assert.ok(listelenen.length >= 3, "hosted modda kapatılan araç listesi boşalmış");
  assert.deepEqual(
    listelenen,
    metaAracAdlari(),
    `Hosted modda kaldırılan araçlarla src/tools/meta.ts'in kaydettikleri ayrışmış. Yeni bir ` +
      `Meta aracı eklenip bu listeye yazılmazsa, hosted sunucu onu listeler ve ajana ` +
      `AEGIS_META_TOKEN'ı tanımsız ilan eden — operatör değişkeni doldurmuşken YANLIŞ olan — ` +
      `bir yanıt döndürür.`
  );
});

test("hosted kaldırma GERÇEKTEN çalışıyor: buildServer kaydediyor, kaldırma silip DOĞRULUYOR", () => {
  const t = tara(HTTP);
  const parcalar = [
    bildirimAl(t, HTTP, "const HOSTED_KAPALI_ARACLAR = ["),
    bildirimAl(t, HTTP, "function hostedKapaliAraclariKaldir("),
  ].join("\n\n");
  const js = ts.transpileModule(parcalar, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const kaldir = new Function(`${js}\nreturn hostedKapaliAraclariKaldir;`)() as (mcp: unknown) => void;

  const sunucu = buildServer(() => {
    throw new Error("bu sunucu örneği hiçbir isteği karşılamaz");
  });
  const kayit = (sunucu as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  const meta = metaAracAdlari();
  for (const ad of meta) {
    assert.ok(kayit[ad], `buildServer '${ad}' aracını kaydetmiyor — kaldırma boşa düşmüş olabilir`);
  }

  kaldir(sunucu);
  for (const ad of meta) {
    assert.equal(
      kayit[ad],
      undefined,
      `'${ad}' kaldırma sonrası hâlâ kayıtlı. Hosted modda kiracı başına Meta kimlik bilgisi ` +
        `yoktur; araç listede kalırsa ajan onu çağırır ve olgusal olarak yanlış bir gerekçe alır.`
    );
  }

  // The verification inside the function must be real: a registry it cannot clean must throw.
  assert.throws(
    () => kaldir({ _registeredTools: { [meta[0]]: {} } }),
    /kaldırılamadı/,
    "kaldıramadığı bir kayıt için sessizce başarılı dönüyor — fail-closed değil"
  );
  assert.throws(() => kaldir({}), /kaldırılamadı/, "araç kaydı hiç bulunamadığında da hata vermeli");
});

test("kaldırma hem AÇILIŞTA hem her oturumda, transport bağlanmadan ÖNCE koşuyor", () => {
  const t = tara(HTTP);
  const cagrilar = [...t.maske.matchAll(/hostedKapaliAraclariKaldir\s*\(/g)];
  assert.ok(
    cagrilar.length >= 3,
    `hostedKapaliAraclariKaldir yalnız ${cagrilar.length} yerde geçiyor (tanım + açılış + oturum ` +
      `beklenir). Açılış denetimi olmadan bir SDK değişikliği ilk kiracının ilk isteğinde ortaya çıkar.`
  );
  const kaldirIdx = t.maske.indexOf("hostedKapaliAraclariKaldir(server);");
  const connectIdx = t.maske.indexOf("await server.connect(transport);");
  assert.ok(kaldirIdx > 0 && connectIdx > 0, "oturum yolundaki kaldırma ya da connect bulunamadı");
  assert.ok(
    kaldirIdx < connectIdx,
    "Kaldırma transport bağlandıktan SONRA koşuyor: ilk tools/list araçları hâlâ görebilir."
  );
  assert.match(
    t.maske,
    /process\.exit\(1\);/,
    "açılış denetiminin fail-closed çıkışı kaybolmuş"
  );
});
