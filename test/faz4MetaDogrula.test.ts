// SPDX-License-Identifier: AGPL-3.0-only
/**
 * scripts/metaDogrula.mts — THE COMMENT MUST BE READABLE, AND WHAT IT PROMISES MUST BE
 * MEASURED.
 *
 * NEDEN VAR: the Turkish→English translation pass over the comments cut one sentence in half
 * in this file. What stood above the status check was:
 *
 *   DURUM ARTIK "OKUNDU MU" SORUSUNU DA SORUYOR. Eskiden istemci `status !== "ACTIVE"`
 *   turned every body that was not ACTIVE into PAUSED; …
 *
 * — a Turkish subject welded onto an English verb phrase, valid in neither language. A second
 * leftover sat on line 59 (`// gerçek kanal kullanılsın`). The repository is public and goes
 * to an international jury on 13 September; the block that explains WHY an unreadable Meta
 * status must stay red was the half nobody could read.
 *
 * The sentence is the cheap part. The expensive part is that a comment like this one is a
 * CLAIM ABOUT BEHAVIOUR — "an unreadable status is now undefined and this check STAYS red" —
 * and a claim nobody measures rots without a sound. So this file guards both halves:
 *
 *   1. THE BEHAVIOUR (kostur): the script is run for real against a stubbed transport whose
 *      read-back body carries NO `status` field, and the terminal must say KALDI. The old
 *      client shape (`status !== "ACTIVE"` → PAUSED) printed GEÇTİ for exactly this body, so
 *      a regression to it turns this red. A second run WITH `status: "PAUSED"` must print
 *      GEÇTİ — without that, "stays red" could be a check that is red no matter what, which
 *      measures nothing.
 *   2. THE SENTENCE: the block above that check must still make the claim in English, and no
 *      comment in the file may carry Turkish prose again. The word list is the ASCII-folded
 *      vocabulary of the half-translated tails this pass left across the repository, and it
 *      is locked with known-bad and known-good samples so it cannot quietly stop matching.
 *
 * WHY THE COMMENT SCAN CANNOT PASS BY BLINDNESS: `yorumKismi` keeps comment characters and
 * blanks everything else. Too NARROW (it returns nothing) and the extractor test fails on the
 * two sentences it demands. Too WIDE (string literals survive) and the file's own Turkish
 * product strings — "Meta kimlik bilgileri eksik", "kampanya oluşturuldu" — walk straight
 * into the word list and the scan goes loudly red. Both directions of a broken extractor end
 * in a failure, never in a green run.
 *
 * LIMITS, so a green run is not read as more than it is: the word list is a lexicon, not a
 * language detector — a Turkish leftover made only of words outside it, or glued into a
 * camelCase identifier, passes. It catches the shape this pass actually produced, in the one
 * file this test owns.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const KOK = join(import.meta.dirname, "..");
const BETIK = join(KOK, "scripts", "metaDogrula.mts");
const ISTEMCI = join(KOK, "src", "meta", "client.ts");
const KAYNAK = readFileSync(BETIK, "utf8");

/** The label of the check under test — the anchor for both the run and the comment block. */
const KONTROL = "geri okuma Meta'dan PAUSED doğruluyor (durum GERÇEKTEN okundu)";

/**
 * The fake credential the harness feeds the copy. The `TEST-ONLY-` prefix is mandatory in
 * this repository: without it the secret scanner in CI reads a token-shaped literal as real.
 */
const JETON = "TEST-ONLY-EAAB-faz4-durum-kalibi-0123456789";
const KAMPANYA_ID = "120000000000009";

/**
 * THE COPY LIVES INSIDE THE REPOSITORY — and one level below its root.
 *
 * Inside, because Node resolves a bare specifier (`dotenv`) by walking UP from the importing
 * file looking for `node_modules`; from the system temp directory there is no such ancestor
 * and Linux CI dies with ERR_MODULE_NOT_FOUND. One level BELOW the .tmp root, because the
 * script resolves its `.env` as `<own dir>/../.env`: a copy sitting directly in `.tmp-…/`
 * would resolve that to the repository's REAL `.env`. The nested directory makes the run
 * hermetic — the only credentials the child ever sees are the fake ones in the prologue.
 * `.tmp*` is in .gitignore, and `after()` removes the directory either way.
 */
const gecici = mkdtempSync(join(KOK, ".tmp-faz4meta-"));
const kopyaDizin = join(gecici, "kopya");
mkdirSync(kopyaDizin);
after(() => rmSync(gecici, { recursive: true, force: true }));

/**
 * The stubbed `fetch`. Three shapes and a fail-closed default: the account currency read, the
 * campaign POST, and the read-back GET whose body is what each case is really about. Anything
 * else throws, so a harness that stops steering the read-back cannot pass unnoticed.
 */
function onyukleme(geriGovde: Record<string, unknown>): string {
  return [
    `process.env.AEGIS_META_TOKEN = ${JSON.stringify(JETON)};`,
    `process.env.AEGIS_META_AD_ACCOUNT_ID = "act_TEST-ONLY-0";`,
    `const GERI = ${JSON.stringify(geriGovde)};`,
    `const govde = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });`,
    `globalThis.fetch = async (u, i) => {`,
    `  const adres = String(u);`,
    `  const yontem = (i && i.method) || "GET";`,
    `  if (adres.includes("currency")) return govde({ currency: "USD", currency_offset: 100 });`,
    `  if (yontem === "POST") return govde({ id: ${JSON.stringify(KAMPANYA_ID)} });`,
    `  if (adres.includes("objective")) return govde(GERI);`,
    `  throw new TypeError("duzenek: beklenmedik istek " + yontem);`,
    `};`,
    ``,
  ].join("\n");
}

/** Runs the script's own bytes with that read-back body and returns terminal + exit code. */
function kostur(geriGovde: Record<string, unknown>): { cikti: string; kod: number | null } {
  const eski = '"../src/meta/client.js"';
  const parcalar = KAYNAK.split(eski);
  assert.equal(
    parcalar.length,
    2,
    `Koşum düzeneği bayat: scripts/metaDogrula.mts artık ${eski} ifadesini tam olarak bir kez ` +
      `geçirmiyor (${parcalar.length - 1} kez). Yönlendirme yapılmadan bu dosyadaki her iddia ` +
      `ölçmediği bir şeyi onaylar; önce düzeneği tazele.`
  );
  const yol = join(kopyaDizin, "metaDogrulaKopya.mts");
  writeFileSync(
    yol,
    onyukleme(geriGovde) + parcalar.join(JSON.stringify(pathToFileURL(ISTEMCI).href)),
    { encoding: "utf8" }
  );

  const ortam: NodeJS.ProcessEnv = { ...process.env };
  // No real Aegis credential is handed to the child; the prologue supplies its own.
  for (const anahtar of Object.keys(ortam)) if (anahtar.startsWith("AEGIS_")) delete ortam[anahtar];
  const s = spawnSync(process.execPath, ["--import", "tsx", yol, "--write"], {
    cwd: KOK,
    env: ortam,
    encoding: "utf8",
  });
  const cikti = `${s.stdout ?? ""}${s.stderr ?? ""}`;
  assert.ok(
    cikti.includes("Aegis — Meta canlı doğrulaması"),
    `Betik hiç çalışmadı; ölçülecek çıktı yok:\n${cikti.slice(0, 800)}`
  );
  assert.ok(
    !cikti.includes(JETON),
    `Sahte jeton terminale sızdı — bu koşum bir sızıntı da gösteriyor:\n${cikti}`
  );
  return { cikti, kod: s.status };
}

/** The body Meta really answers with, minus the one field each case is about. */
const GERI_TEMEL = {
  id: KAMPANYA_ID,
  name: "Aegis-dogrulama",
  objective: "OUTCOME_TRAFFIC",
  daily_budget: "10000",
};

test("status alanı hiç gelmezse kontrol KIRMIZI kalır — okunamayan durum teyit değildir", () => {
  const { cikti, kod } = kostur(GERI_TEMEL);

  assert.match(
    cikti,
    new RegExp(`KALDI\\s+${KONTROL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    `Meta "status" alanını HİÇ göndermediği hâlde durum kontrolü yeşil yandı. Eski istemci ` +
      `şekli (status !== "ACTIVE" → PAUSED) tam olarak bunu yapıyordu: bilinmeyen bir durumu ` +
      `"duraklatılmış" sayıp teyit diye yazıyordu. Bilinmiyor 0 değildir; okunamayan durum ` +
      `kırmızı kalmalı.\nÇıktı:\n${cikti}`
  );
  assert.ok(
    cikti.includes("okunamadı"),
    `Not satırı durumun okunamadığını söylemiyor; rapor sessiz kalıyor.\nÇıktı:\n${cikti}`
  );
  assert.ok(
    cikti.includes("bilinmeyen durum harcamıyor demek değildir"),
    `kampanyaDurumu'nun gerekçesi rapora taşınmıyor — yani okunamayan durum bir allowlist ` +
      `tarafından değil, başka bir yolla üretilmiş olabilir.\nÇıktı:\n${cikti}`
  );
  assert.equal(
    kod,
    1,
    `Kontrol kırmızıyken betik yine de 0 ile çıktı; CI/operatör başarısızlığı göremez.` +
      `\nÇıktı:\n${cikti}`
  );
});

test("aynı kontrol PAUSED gerçekten okunduğunda YEŞİL olur (yukarıdaki kırmızı bir ölçümdür)", () => {
  const { cikti, kod } = kostur({ ...GERI_TEMEL, status: "PAUSED" });

  assert.match(
    cikti,
    new RegExp(`GEÇTİ\\s+${KONTROL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    `Meta PAUSED döndürdüğü hâlde kontrol kırmızı. Her koşulda kırmızı kalan bir kontrol ` +
      `hiçbir şey ölçmez ve yukarıdaki "kırmızı kalır" iddiası da boşa düşer.\nÇıktı:\n${cikti}`
  );
  assert.equal(kod, 0, `Her kontrol geçtiği hâlde çıkış kodu 0 değil.\nÇıktı:\n${cikti}`);
});

/* ── The sentence itself ─────────────────────────────────────────────────────── */

/**
 * Comment characters only: line and block comments survive, everything else (code, string and
 * template literals, regex literals) is blanked with spaces. Newlines are kept so a finding
 * can still name its line.
 */
function yorumKismi(kaynak: string): string {
  const c = kaynak.split("");
  const sil = (a: number, b: number) => {
    for (let i = a; i < b && i < c.length; i++) if (c[i] !== "\n") c[i] = " ";
  };
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
        sil(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === "`") {
        sil(i, i + 1);
        sablon.pop();
        i++;
        sonAnlamli = "x";
        sonKelime = "";
        continue;
      }
      if (ch === "$" && kaynak[i + 1] === "{") {
        sil(i, i + 2);
        sablon[sablon.length - 1] = 1;
        i += 2;
        sonAnlamli = "{";
        sonKelime = "";
        continue;
      }
      sil(i, i + 1);
      i++;
      continue;
    }
    if (ch === "/" && kaynak[i + 1] === "/") {
      const s = kaynak.indexOf("\n", i);
      i = s < 0 ? kaynak.length : s; // kept: this is a comment
      continue;
    }
    if (ch === "/" && kaynak[i + 1] === "*") {
      const s = kaynak.indexOf("*/", i + 2);
      i = s < 0 ? kaynak.length : s + 2; // kept: this is a comment
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
      sil(i, j);
      i = j;
      sonAnlamli = "x";
      sonKelime = "";
      continue;
    }
    if (ch === "`") {
      sil(i, i + 1);
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
      sil(i, j);
      i = j;
      sonAnlamli = "x";
      sonKelime = "";
      continue;
    }
    if (derinlik > 0) {
      // Brace depth inside a `${…}`; at zero we are back in the literal's text.
      if (ch === "{") sablon[sablon.length - 1] = derinlik + 1;
      else if (ch === "}") {
        sablon[sablon.length - 1] = derinlik - 1;
        if (derinlik - 1 === 0) {
          sil(i, i + 1);
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
    sil(i, i + 1);
    i++;
  }
  return c.join("");
}

/** Turkish letters folded to ASCII. `İ` is folded BEFORE lowercasing: `"İ".toLowerCase()`
 * yields `i` plus a combining dot in JS, which would split the word in two. */
const KATLAMA: Record<string, string> = {
  ç: "c",
  Ç: "c",
  ğ: "g",
  Ğ: "g",
  ı: "i",
  İ: "i",
  ö: "o",
  Ö: "o",
  ş: "s",
  Ş: "s",
  ü: "u",
  Ü: "u",
  â: "a",
  î: "i",
  û: "u",
};

function asciiKatla(metin: string): string {
  return metin.replace(/[çÇğĞıİöÖşŞüÜâîû]/g, (k) => KATLAMA[k]).toLowerCase();
}

/**
 * Turkish words that cannot be an English word as well, ASCII-folded. Deliberately WIDER than
 * the two lines this file was written for: the tails the same translation pass left elsewhere
 * in the repository ("…etmez", "…dokunulmaz", "…kalamaz", "…sorulmaz", "…atlanabilir",
 * "…reddedilmelidir") are in here too, so if that shape lands in THIS file it is caught the
 * first time rather than after another audit.
 *
 * What is deliberately NOT here: words this file legitimately quotes from its own Turkish
 * terminal output ("GEÇTİ", "KALDI", "jeton kabul ediliyor", "hata metni") and Turkish
 * IDENTIFIERS an English sentence may name (`kayit`, `kanal`, `durum`, `hataTemizle`).
 * Matching is whole-word on the folded text, so a camelCase identifier is one token and
 * never collides with a word in this list.
 */
const TURKCE_SOZCUKLER = new Set([
  "eskiden", "istemci", "gercek", "soruyor", "sorusunu", "okundu", "kullanilsin", "kullanilir",
  "artik", "ancak", "cunku", "boylece", "yalniz", "yalnizca", "sadece", "asla", "hicbir",
  "zaten", "hala", "ayrica", "veya", "yerine", "uzere", "iken", "ise", "bunu", "bunun", "bir",
  "sonra", "kadar", "gibi", "icin", "olarak", "daha", "cok", "gerek", "gerekir", "gerekmez",
  "degil", "degildi", "degildir", "yoktur", "vardir", "olur", "olmaz", "olmadan", "eder",
  "etmez", "edilir", "edilmez", "dokunulmaz", "kalamaz", "durur", "gelir", "girmez",
  "sorulmaz", "okunur", "okunmaz", "yapilir", "yapilmaz", "reddedilir", "reddedilmelidir",
  "atlanabilir", "altinda", "uzerinde", "bkz",
]);

/** Every listed Turkish word occurring in `metin`, folded and de-duplicated. */
function turkceKelimeler(metin: string): string[] {
  const bulunan = new Set<string>();
  for (const kelime of asciiKatla(metin).split(/[^a-z]+/)) {
    if (TURKCE_SOZCUKLER.has(kelime)) bulunan.add(kelime);
  }
  return [...bulunan].sort();
}

test("yorum ayıklayıcı yalnız yorumları alır — ne daha azını ne daha fazlasını", () => {
  const yorumlar = yorumKismi(KAYNAK);

  // Too narrow would make every scan below vacuously green, so the sentences are demanded.
  for (const cumle of [
    "LIVE VERIFICATION OF THE META PATH",
    "THE CANARY SINGS BEFORE THE BIRD IS LET OUT",
    "the REAL channel is the one under verification here",
  ]) {
    assert.ok(
      yorumlar.includes(cumle),
      `Yorum ayıklayıcı "${cumle}" cümlesini kaybetti — ayıklama ÇOK DAR. Bu hâlde ` +
        `aşağıdaki taramalar hiçbir şey ölçmeden yeşil yanardı.`
    );
  }
  // Too wide would drag the file's Turkish product strings into the word scan.
  for (const dize of [
    "Meta kimlik bilgileri eksik",
    "kampanya oluşturuldu",
    "Aegis silme aracı sunmuyor",
  ]) {
    assert.ok(
      !yorumlar.includes(dize),
      `Yorum ayıklayıcı "${dize}" DİZESİNİ de aldı — ayıklama ÇOK GENİŞ. Ürünün Türkçe ` +
        `metinleri yorum sayılırsa aşağıdaki tarama yanlış yerde alarm verir.`
    );
  }
  assert.ok(
    yorumlar.replace(/\s+/g, " ").trim().length > 2000,
    `Ayıklanan yorum metni beklenenden çok kısa — ayıklayıcı bozulmuş olabilir.`
  );
});

/** Known-bad: the two lines this file fixed, plus the sibling tails of the same pass. */
const KOTU_ORNEKLER: Array<[string, string]> = [
  [
    "bu dosyanın kendi kırık cümlesi",
    ' * DURUM ARTIK "OKUNDU MU" SORUSUNU DA SORUYOR. Eskiden istemci `status !== "ACTIVE"`',
  ],
  ["bu dosyanın ikinci artığı", "// gerçek kanal kullanılsın"],
  ["kararGunlugu kuyruğu", " * etmez, denetim izi sessizce durur."],
  ["networkTrust kuyruğu", " * dokunulmaz (import bile edilmez)."],
  ["networkTrust ikinci kuyruğu", " * kalamaz."],
  ["dagitim kuyruğu", " *    OKUNUR, modele sorulmaz."],
  ["arastirma kuyruğu", " *     sistem istemine asla girmez."],
  ["http kuyruğu", " * ters vekil atlanabilir hâle gelir."],
  ["config kuyruğu", " * reddedilmelidir (bkz. networkTrust.ts, fail-closed)."],
];

/** Known-good: what this file's English comments legitimately contain today. */
const TEMIZ_ORNEKLER: Array<[string, string]> = [
  [
    "Türkçe terminal çıktısının alıntısı",
    " *   GEÇTİ  jeton kabul ediliyor … proxy: access_token=<the live token> rejected upstream",
  ],
  ["ikinci alıntı satırı", " *   KALDI  hata metni erişim jetonunu SIZDIRMIYOR"],
  ["cümle içinde etiket alıntısı", " * our token back would be reported as GEÇTİ."],
  [
    "İngilizce cümlede Türkçe tanımlayıcı adları",
    " * see kampanyaDurumu, hataTemizle and kayit in src/meta/client.ts",
  ],
  [
    "düzeltilmiş cümlenin kendisi",
    " * THE STATUS CHECK NOW ALSO ASKS WHETHER THE STATUS WAS READ AT ALL. The client used to",
  ],
];

test("Türkçe sözcük tarayıcısı: kırık cümleleri yakalar, meşru alıntılara dokunmaz", () => {
  for (const [ad, ornek] of KOTU_ORNEKLER) {
    assert.ok(
      turkceKelimeler(ornek).length > 0,
      `yakalanmalıydı ama sessiz kaldı: ${ad} — "${ornek.trim()}". Sözcük listesi bu kalıbı ` +
        `görmüyorsa aşağıdaki dosya taraması da görmez.`
    );
  }
  for (const [ad, ornek] of TEMIZ_ORNEKLER) {
    assert.deepEqual(
      turkceKelimeler(ornek),
      [],
      `yanlış alarm: ${ad} — "${ornek.trim()}"`
    );
  }
});

test("scripts/metaDogrula.mts'in yorumlarında Türkçe düzyazı kalmadı", () => {
  const satirlar = yorumKismi(KAYNAK).split("\n");
  const suclular: string[] = [];
  satirlar.forEach((satir, i) => {
    const kelimeler = turkceKelimeler(satir);
    if (kelimeler.length) suclular.push(`${i + 1}: [${kelimeler.join(", ")}] ${satir.trim()}`);
  });
  assert.deepEqual(
    suclular,
    [],
    `Yorumlarda Türkçe düzyazı kalıntısı:\n  ${suclular.join("\n  ")}\n` +
      `Bu dosyanın yorumları İngilizce; yarım çevrilmiş bir cümle iki dilde de okunamaz ve ` +
      `depo halka açık. Cümleyi tamamla — kaldırma, çünkü taşıdığı gerekçe testlerin ölçtüğü ` +
      `davranışın ta kendisi.`
  );
});

test("durum kontrolünün üstündeki blok, testin ölçtüğü iddiayı hâlâ söylüyor", () => {
  const konum = KAYNAK.indexOf(KONTROL);
  assert.ok(konum > 0, `"${KONTROL}" kontrolü dosyada yok — çapa bayatlamış.`);

  const bas = KAYNAK.lastIndexOf("/**", konum);
  const son = KAYNAK.indexOf("*/", bas);
  assert.ok(
    bas > 0 && son > bas && son < konum,
    "Durum kontrolünün hemen üstünde bir blok yorum yok; gerekçe fonksiyondan kopmuş."
  );
  const blok = KAYNAK.slice(bas, son + 2);

  for (const [ad, desen] of [
    ["okunamayan durumun undefined olduğu", /unreadable status is now undefined/i],
    ["kontrolün kırmızı kaldığı", /stays red/i],
    ["gerekçenin dayandığı allowlist", /kampanyaDurumu/],
  ] as Array<[string, RegExp]>) {
    assert.match(
      blok,
      desen,
      `Blok artık ${ad} iddiasını söylemiyor. Bu dosyanın ilk iki testi tam olarak o iddiayı ` +
        `ölçüyor; cümle silinirse ölçüm gerekçesiz, gerekçe ölçümsüz kalır.\nBlok:\n${blok}`
    );
  }
  assert.deepEqual(
    turkceKelimeler(blok),
    [],
    `Durum kontrolünün gerekçesinde Türkçe düzyazı var — yarım çeviri geri gelmiş.\n${blok}`
  );

  const kod = KAYNAK.slice(son, konum + KONTROL.length + 200);
  assert.match(
    kod,
    /geri\.durum === "PAUSED"/,
    `Kontrolün koşulu değişmiş: blok "okunamayan durum kırmızı kalır" diyor ama kod artık ` +
      `geri.durum === "PAUSED" karşılaştırmasını yapmıyor. Yorum ile kod ayrışmış.`
  );
});
