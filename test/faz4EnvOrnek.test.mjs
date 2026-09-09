// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PHASE 4 — .env.example measured as the operator's ONLY entry point.
 *
 * THE MEASURED DEFECT. The Growth Brain block documents TWO providers
 * ("gemini (varsayılan) | anthropic") and even the default model of each
 * ("anthropic → claude-sonnet-5"), and it lists AEGIS_GEMINI_API_KEY for the gemini path —
 * but the variable the anthropic path REQUIRES, ANTHROPIC_API_KEY, had no line in the file.
 * An operator who copied .env.example to .env and set AEGIS_BRAIN_PROVIDER=anthropic — the
 * value this very file offers — got "ANTHROPIC_API_KEY ortam değişkeni tanımlı değil", an
 * error whose own text sends them to the .env file that never names the variable.
 *
 * WHY THE EXISTING WATCHER DID NOT SEE IT. test/ayarAdlari.test.ts asks the same question
 * through TWO narrowings: it only considers names matching AEGIS_*, and it accepts a bare
 * `ornek.includes(ad)` — a mention anywhere in the file, a comment included.
 * ANTHROPIC_API_KEY escapes on the first, GEMINI_API_KEY on the second. An "extract, then
 * assert absence" watcher is punched through exactly there: extract too widely, or test
 * membership too loosely, and the hole is invisible. For the .env.example surface this file
 * removes both narrowings: reads are collected with NO prefix filter — `env.X`, `env["X"]`
 * and destructuring alike — and documentation is a real assignment LINE, not a mention.
 *
 * PHASE 5 — the same trap was then measured INSIDE this file, and both halves stayed green
 * while doing harm:
 *   - a name that appears only in a code COMMENT counted as "read", so a dead button could be
 *     kept alive by prose. MEASURED: `AEGIS_SAHTE_DUGME=` added to .env.example plus a single
 *     comment naming it → 8/8 green, the dead button was not caught.
 *   - a destructured read was invisible, so an undocumented MANDATORY key could hide inside
 *     `const { OPENAI_API_KEY } = process.env`. MEASURED: 8/8 green.
 * The scan is therefore kept as TWO sets, and each drives the direction in which its way of
 * being wrong is the SAFE way:
 *   - RAW text (comments included) drives "read but undocumented": counting a comment as a
 *     read can only DEMAND more documentation, it can never hide a live variable.
 *   - COMMENT-FREE text drives "documented but dead" and the exception liveness check: the
 *     stripper can only take too much, and a read it loses turns a live setting into a LOUD
 *     failure rather than into silence.
 * The extractor itself is pinned by a literal fixture (first test), so neither direction can
 * rot as quietly as both just did.
 *
 * WHAT MAKES EACH TEST TWO-WAY — a documentation watcher that can only rot in one direction
 * is a vacuum watcher:
 *   - the operator scenario RUNS the real provider selector over an environment BUILT FROM
 *     .env.example. Delete a key line → red. Make the code demand a new variable → red.
 *   - the provider list written in the comment is compared as a SET with the providers
 *     beyinIstemcisi actually accepts, in both directions.
 *   - the doc↔code variable sets are compared in both directions, so a documented-but-dead
 *     setting fails as loudly as an undocumented live one.
 *   - each exception carries a MEASURED justification, and a stale exception is itself red.
 *
 * No network and no real .env is read: every environment here is a literal object, and the
 * only value ever placed in one is the TEST-ONLY- placeholder below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beyinIstemcisi } from "../scripts/brain/ortak.mjs";

const KOK = path.join(import.meta.dirname, "..");
const ENV_ORNEK = readFileSync(path.join(KOK, ".env.example"), "utf8");
const ORTAK_KAYNAK = readFileSync(path.join(KOK, "scripts", "brain", "ortak.mjs"), "utf8");

/** Never a real credential: the value only has to be non-empty to clear an "is it set" gate. */
const DOLGU = "TEST-ONLY-ornek-deger";

/* ── .env.example okuma yardımcıları ─────────────────────────────────────────── */

/**
 * The variables the file actually OFFERS: a `NAME=` line, not a mention. The difference is
 * the whole point — a name that appears only inside a comment cannot be filled in by copying
 * the file, and that is the state ANTHROPIC_API_KEY was in.
 */
function belgeliDegiskenler() {
  return new Set([...ENV_ORNEK.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
}

/**
 * The comment block that belongs to ONE variable: the lines directly above its assignment,
 * up to the bare "#" that separates entries. Whole-file matching is how a stale watcher stays
 * green — "ZORUNLU" occurs in half a dozen unrelated blocks of this file.
 */
function yorumBlogu(ad) {
  const satirlar = ENV_ORNEK.split("\n");
  const i = satirlar.findIndex((s) => s.startsWith(`${ad}=`));
  assert.notEqual(i, -1, `.env.example'da "${ad}=" satırı yok`);
  const blok = [];
  for (let j = i - 1; j >= 0 && satirlar[j].startsWith("#"); j--) {
    if (/^#\s*$/.test(satirlar[j])) break; // boş "#" satırı girdileri ayırır
    blok.unshift(satirlar[j]);
  }
  return blok.join("\n");
}

/** The providers the FILE claims, from its own header line. */
function belgedekiSaglayicilar() {
  const m = /^#\s*MODEL[İI]\s+SA[ĞG]LAYAN\s+SERV[İI]S:(.*)$/m.exec(ENV_ORNEK);
  assert.ok(m, ".env.example artık sağlayıcı listesini yazmıyor — gözcünün yolu bayatlamış");
  const adlar = m[1]
    .split("|")
    .map((p) => p.replace(/\(.*?\)/g, "").trim().toLowerCase())
    .filter((p) => p.length > 0);
  assert.ok(adlar.length >= 2, `sağlayıcı listesinden yalnız ${adlar.length} ad okunabildi`);
  return adlar;
}

/**
 * The providers the CODE accepts, read out of beyinIstemcisi's own body.
 *
 * Source-scanned on purpose: probing with guessed names could only ever confirm the names
 * already written in the documentation, which is the very thing being checked. The `\n}\n`
 * anchor is safe because .gitattributes pins the working tree to LF.
 */
function koddakiSaglayicilar() {
  const govde = /export function beyinIstemcisi\([^)]*\)\s*\{([\s\S]*?)\n\}\n/.exec(ORTAK_KAYNAK);
  assert.ok(govde, "ortak.mjs'de beyinIstemcisi gövdesi bulunamadı — ayrıştırıcı bayatlamış");
  const adlar = [...govde[1].matchAll(/saglayici === "([a-z0-9._-]+)"/g)].map((m) => m[1]);
  assert.ok(
    adlar.length >= 2,
    `beyinIstemcisi gövdesinden yalnız ${adlar.length} sağlayıcı okunabildi — gözcü boşa düşmüş`
  );
  return adlar;
}

/* ── Kod tarama ──────────────────────────────────────────────────────────────── */

const KOD_DIZINLERI = ["src", "scripts"];

function dosyalar(dizin) {
  const cikti = [];
  for (const ad of readdirSync(dizin)) {
    const tam = path.join(dizin, ad);
    if (statSync(tam).isDirectory()) cikti.push(...dosyalar(tam));
    else if (/\.(ts|mts|mjs|js)$/.test(ad)) cikti.push(tam);
  }
  return cikti;
}

/**
 * Source with its comments removed. JavaScript accepts a comment only when it is CLOSED, so
 * every comment a compiling file in this repo can contain is matched here: this cannot leave
 * one behind. It can take too much — a `//` inside a string or a regex (`"https://…"`)
 * swallows the rest of that line — and that is the direction this set is allowed to be wrong
 * in, because the two places it is used turn a lost read into a loud red, not into silence.
 */
function yorumsuz(kaynak) {
  return kaynak.replace(/\/\*[\s\S]*?\*\//g, "\n").replace(/\/\/[^\n]*/g, "");
}

/**
 * The environment names ONE piece of text reads, in the three shapes source code uses:
 * `env.X`, `env["X"]`, and destructuring — `const { X } = process.env`, the shape a measured
 * mutation walked straight through. `process.env` and an injected `env` share the patterns,
 * because "is this name read" does not depend on where the object came from.
 *
 * One shape is out of reach of any text scan and is therefore NOT claimed: a fully computed
 * name — `process.env[k]` walking a list of names, as missingCredentials() does over REQUIRED
 * in src/config.ts and validateHostedEnv() does over an inline list in src/http.ts. Those
 * names stay covered only because each of them is ALSO read directly somewhere, and that is
 * precisely what the dead-button comparison below measures for every documented line.
 */
function metindekiOkumalar(metin) {
  const adlar = new Set();
  for (const m of metin.matchAll(
    /\benv(?:\.([A-Z][A-Z0-9_]*)|\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\])/g
  )) {
    adlar.add(m[1] ?? m[2]);
  }
  for (const m of metin.matchAll(/\{([^{}]*)\}\s*=\s*(?:process\s*\.\s*)?env\b/g)) {
    for (const parca of m[1].split(",")) {
      const ad = parca.replace(/^\s*\.\.\./, "").split(/[:=]/)[0].trim();
      if (/^[A-Z][A-Z0-9_]*$/.test(ad)) adlar.add(ad);
    }
  }
  return adlar;
}

/** Every environment read in src/ and scripts/, WITHOUT the AEGIS_ prefix filter. */
function tara(hazirla) {
  const okunan = new Map();
  for (const f of KOD_DIZINLERI.flatMap((d) => dosyalar(path.join(KOK, d)))) {
    const metin = hazirla(readFileSync(f, "utf8"));
    for (const ad of metindekiOkumalar(metin)) {
      if (!okunan.has(ad)) okunan.set(ad, new Set());
      okunan.get(ad).add(path.relative(KOK, f).split(path.sep).join("/"));
    }
  }
  assert.ok(
    okunan.size >= 30,
    `kod taramasından yalnız ${okunan.size} ortam değişkeni çıktı — tarayıcı bayatlamış ` +
      `olabilir ve bir gözcü sessizce boşa düşmemeli`
  );
  return okunan;
}

/** RAW — a comment counts as a read on purpose; over-counting here only demands more docs. */
const okunanDegiskenler = () => tara((kaynak) => kaynak);

/** COMMENT-FREE — prose cannot keep a setting alive: a sentence is not a read. */
const gercekOkumalar = () => tara(yorumsuz);

/**
 * Names that are read but deliberately have NO line of their own. Each carries a condition
 * that is MEASURED, not asserted by hand — an exception nobody can falsify is a second
 * vacuum.
 */
const ISTISNALAR = [
  {
    ad: "GEMINI_API_KEY",
    gerekce:
      "AEGIS_GEMINI_API_KEY'in takma adı (aynı okuma, ikinci sıra). Kendi satırı olsaydı " +
      "operatör aynı anahtar için iki kutu görürdü; yeri, asıl değişkenin yorum bloğudur",
    dogrula: () =>
      assert.match(
        yorumBlogu("AEGIS_GEMINI_API_KEY"),
        /GEMINI_API_KEY/,
        "takma ad, AEGIS_GEMINI_API_KEY'in yorum bloğunda anılmıyor — istisnanın gerekçesi düştü"
      ),
  },
  {
    ad: "NO_COLOR",
    gerekce:
      "Aegis ayarı değil, ekosistem çapında bir terminal geleneği (no-color.org). Yalnız " +
      "konsola yazan gösteri betikleri okur; sunucunun davranışını değiştirmez",
    dogrula: () => {
      const src = dosyalar(path.join(KOK, "src")).filter((f) =>
        metindekiOkumalar(readFileSync(f, "utf8")).has("NO_COLOR")
      );
      assert.deepEqual(
        src,
        [],
        "NO_COLOR artık src/ içinde okunuyor: sunucu davranışını etkileyen bir değişken " +
          "belgelenmeden kalamaz"
      );
    },
  },
];

/* ── 0) TARAYICININ KENDİSİ ölçülüyor ────────────────────────────────────────── */

/**
 * Every shape the two scans have to agree — or deliberately disagree — on, as ONE literal.
 * No file is read here, so this test measures the extractor and nothing else.
 */
const TARAYICI_NUMUNESI = [
  "const a = env.AL_UYE;",
  'const b = env["AL_KOSE"];',
  "const c = process.env.AL_SUREC;",
  "const { AL_YIKIM } = process.env;",
  'const { AL_TAKMA: x = "d" } = env;',
  "// yorum: process.env.YALNIZ_SATIR_YORUMU",
  "/* yorum: env.YALNIZ_BLOK_YORUMU */",
  'const u = "https://ornek.test/yol"; const d = env.AL_URL_SONRASI;',
].join("\n");

test("tarayıcı üç okuma biçimini de görüyor; yorumlar YALNIZ ham kümede sayılıyor", () => {
  /**
   * The anti-vacuum guard for this file's own extractor: both measured holes are pinned here
   * as data, so a future rewrite of the patterns cannot reopen either one silently.
   *   - drop the destructuring pattern → AL_YIKIM / AL_TAKMA vanish from both sets → red;
   *   - stop stripping comments → YALNIZ_* appear in the comment-free set → red;
   *   - teach the extractor itself to skip comments → YALNIZ_* leave the raw set → red.
   * What it does NOT pin is the wiring above — which of the two sets each test is handed.
   * That is one line each, and it is the real files that were mutated to prove it.
   *
   * AL_URL_SONRASI is the tolerated over-reach, pinned rather than hidden: it sits after a
   * `://` on its line, so the stripper takes it along with the "comment" it thinks it found.
   * That costs a false "dead button" red, never a silent pass — the safe way to be wrong.
   */
  const dogrudan = ["AL_UYE", "AL_KOSE", "AL_SUREC"];
  const yikim = ["AL_YIKIM", "AL_TAKMA"];
  const yorumdakiler = ["YALNIZ_SATIR_YORUMU", "YALNIZ_BLOK_YORUMU"];

  assert.deepEqual(
    [...metindekiOkumalar(TARAYICI_NUMUNESI)].sort(),
    [...dogrudan, ...yikim, ...yorumdakiler, "AL_URL_SONRASI"].sort(),
    "ham tarayıcı üç okuma biçiminden birini ya da yorumdaki anmayı görmüyor"
  );
  assert.deepEqual(
    [...metindekiOkumalar(yorumsuz(TARAYICI_NUMUNESI))].sort(),
    [...dogrudan, ...yikim].sort(),
    "yorumsuz küme ya bir yorumu içeri alıyor ya da gerçek bir okumayı kaybediyor"
  );
});

/* ── 1) OPERATÖR SENARYOSU: dosyayı kopyala, doldur, sağlayıcıyı seç ──────────── */

/** The environment an operator gets by copying .env.example and filling in every blank. */
function ornektenOrtam(saglayici) {
  const env = {};
  for (const satir of ENV_ORNEK.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(satir);
    if (m) env[m[1]] = m[2].trim() === "" ? DOLGU : m[2].trim();
  }
  env.AEGIS_BRAIN_PROVIDER = saglayici;
  return env;
}

test(".env.example'ı doldurup BELGELENEN her sağlayıcıyı seçen operatör istemci alabiliyor", () => {
  /**
   * THE DEFECT, AS BEHAVIOUR. The file offers AEGIS_BRAIN_PROVIDER=anthropic; filling in
   * everything the file offers therefore has to be enough to get an anthropic client. It was
   * not: the required key had no line, so nothing filled it in and the real selector threw.
   *
   * Both directions live in this one assertion: remove a key line from .env.example and it
   * goes red; make the code require a variable the file does not offer and it goes red too.
   */
  for (const s of belgedekiSaglayicilar()) {
    let istemci;
    let hata;
    try {
      istemci = beyinIstemcisi(ornektenOrtam(s));
    } catch (e) {
      hata = e;
    }
    assert.equal(
      hata?.message,
      undefined,
      `.env.example'ı olduğu gibi doldurup AEGIS_BRAIN_PROVIDER=${s} seçen operatör ` +
        `istemci alamıyor: "${hata?.message}". Dosya bu sağlayıcıyı öneriyorsa, onun ` +
        `ZORUNLU değişkeninin de bu dosyada bir satırı olmalı.`
    );
    assert.equal(
      typeof istemci?.messages?.create,
      "function",
      `${s} yolu istemci döndürmedi — senaryo ölçtüğünü sandığı şeyi ölçmüyor`
    );
  }
});

test("anahtarsız ortamda hata metninin işaret ettiği HER değişkenin .env.example'da satırı var", () => {
  /**
   * The error text is the operator's only instruction, and it says "define it in the
   * project's .env file". Every name it prints must therefore be a line that exists in
   * .env.example — otherwise the instruction points at nothing.
   *
   * Driven by the providers THE CODE accepts, not by the ones the file lists, so a provider
   * added to the code is covered before anybody documents it.
   */
  const belgeli = belgeliDegiskenler();
  for (const s of koddakiSaglayicilar()) {
    let uretildi = false;
    let mesaj = "";
    try {
      beyinIstemcisi({ AEGIS_BRAIN_PROVIDER: s });
      uretildi = true;
    } catch (e) {
      mesaj = String(e?.message ?? e);
    }
    assert.equal(uretildi, false, `${s}: anahtarsız ortamda istemci üretildi — kapalı arıza yok`);

    const istenen = [...new Set(mesaj.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])];
    assert.ok(
      istenen.length >= 1,
      `${s}: hata metni hangi ortam değişkeninin eksik olduğunu SÖYLEMİYOR: "${mesaj}"`
    );
    const eksik = istenen.filter((a) => !belgeli.has(a));
    assert.deepEqual(
      eksik,
      [],
      `${s} yolunun hata metni operatörü .env dosyasına yönlendiriyor ama şu değişkenlerin ` +
        `.env.example'da satırı yok: ${eksik.join(", ")}`
    );
  }
});

/* ── 2) SAĞLAYICI LİSTESİ: belge ile kod aynı kümeyi söylüyor ─────────────────── */

test("belgelenen sağlayıcı listesi, kodun KABUL ETTİĞİ listeyle birebir aynı", () => {
  /**
   * A provider written in the file but rejected by the code sends the operator into
   * "AEGIS_BRAIN_PROVIDER değeri tanınmadı"; a provider accepted by the code but missing from
   * the file is a hidden path with an undocumented key — the shape of the defect this file
   * closes. Both are the same drift, so both are one assertion.
   */
  assert.deepEqual(
    [...belgedekiSaglayicilar()].sort(),
    [...koddakiSaglayicilar()].sort(),
    ".env.example'ın sağlayıcı listesi ile beyinIstemcisi'nin kabul ettiği liste ayrışmış"
  );
});

test("her sağlayıcının ZORUNLU anahtarı, hangi sağlayıcıda zorunlu olduğunu KENDİ bloğunda söylüyor", () => {
  /**
   * A bare `ANTHROPIC_API_KEY=` line would satisfy every set comparison above and still leave
   * the operator guessing when it is needed and where to get it. The block belonging to the
   * key — not the file at large — has to name its provider and say it is mandatory.
   */
  for (const s of koddakiSaglayicilar()) {
    let mesaj = "";
    try {
      beyinIstemcisi({ AEGIS_BRAIN_PROVIDER: s });
    } catch (e) {
      mesaj = String(e?.message ?? e);
    }
    const anahtar = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/.exec(mesaj)?.[1];
    assert.ok(anahtar, `${s}: hata metni bir değişken adı vermiyor`);

    const blok = yorumBlogu(anahtar);
    assert.match(
      blok,
      new RegExp(`AEGIS_BRAIN_PROVIDER=${s}\\b`),
      `${anahtar} bloğu, hangi sağlayıcıda gerektiğini söylemiyor (AEGIS_BRAIN_PROVIDER=${s})`
    );
    assert.match(blok, /ZORUNLU/, `${anahtar} bloğu bu anahtarın zorunlu olduğunu söylemiyor`);
  }
});

test("ANTHROPIC_API_KEY bloğunun `npm run agent` hakkında söyledikleri kodda da doğru", () => {
  /**
   * The block warns that scripts/demo-agent.mjs does NOT load .env — it reads the key from
   * the shell. That sentence is only worth writing if something keeps it true: the moment the
   * script starts loading dotenv the warning becomes a lie, and this test turns red. The
   * matching claim for `npm run brain` — that .env DOES reach it — is pinned the same way.
   */
  const blok = yorumBlogu("ANTHROPIC_API_KEY");
  assert.match(blok, /demo-agent\.mjs/, "blok, aynı anahtarı isteyen ikinci betiği anmıyor");
  assert.match(blok, /Y[ÜU]KLEMEZ/, "blok, demo-agent'ın .env yüklemediğini söylemiyor");

  const ajan = readFileSync(path.join(KOK, "scripts", "demo-agent.mjs"), "utf8");
  assert.equal(
    /^import .*dotenv/m.test(ajan),
    false,
    "demo-agent.mjs artık dotenv yüklüyor — .env.example'daki 'YÜKLEMEZ' uyarısı yalan oldu"
  );
  const beyin = readFileSync(path.join(KOK, "scripts", "growth-brain.mjs"), "utf8");
  assert.equal(
    /^import "dotenv\/config"/m.test(beyin),
    true,
    "growth-brain.mjs dotenv'i bıraktı — blok .env'e yönlendirmeye devam edemez"
  );
});

/* ── 3) DEĞİŞKEN KÜMELERİ: iki yönde de eşit ─────────────────────────────────── */

test("kodun okuduğu HER ortam değişkeninin .env.example'da kendi satırı var", () => {
  /**
   * The wide direction, without the AEGIS_ prefix filter that let this defect through and
   * without accepting a mere mention. What counts is a line the operator can fill in.
   *
   * Measured on RAW source — comments included — because here over-counting is the safe way
   * to be wrong: a name that turns out to live only in a comment merely gets documented, while
   * a live read the scan lost would leave an operator at a wall with no line to fill in.
   */
  const okunan = okunanDegiskenler();
  const belgeli = belgeliDegiskenler();
  const istisnaAdlari = new Set(ISTISNALAR.map((i) => i.ad));

  const belgesiz = [...okunan.keys()]
    .filter((a) => !belgeli.has(a) && !istisnaAdlari.has(a))
    .sort()
    .map((a) => `${a} (${[...okunan.get(a)].join(", ")})`);
  assert.deepEqual(
    belgesiz,
    [],
    `Kod bu değişkenleri okuyor ama .env.example onları DOLDURULABİLİR bir satır olarak ` +
      `sunmuyor. Yalnız yorumda anılmak yetmez: operatör dosyayı kopyalayıp doldurur.\n  ` +
      belgesiz.join("\n  ")
  );
});

test(".env.example'ın sunduğu her satır GERÇEKTEN okunuyor (ölü düğme yok)", () => {
  /**
   * The other direction. A settable line nothing reads is a button wired to nothing — the
   * same harm as a missing line, from the opposite side.
   *
   * Measured on COMMENT-FREE source, because a sentence is not a read: one comment naming
   * `process.env.AEGIS_SAHTE_DUGME` used to be enough to keep an offered-but-dead line green.
   */
  const okunan = gercekOkumalar();
  const olu = [...belgeliDegiskenler()].filter((a) => !okunan.has(a)).sort();
  assert.deepEqual(
    olu,
    [],
    `.env.example bu ayarları sunuyor ama kod hiçbirini okumuyor: ${olu.join(", ")}. ` +
      `Adın bir YORUMDA geçmesi sayılmaz; düğmenin ucunda gerçek bir okuma olmalı. ` +
      `(Okuma, aynı satırda "://" geçen bir dizeden SONRA geliyorsa yorum ayıklayıcısı onu da ` +
      `düşürür — bu yön, sessiz kalmaktansa kırmızı olsun diye bilerek seçildi.)`
  );
});

test("her istisna hâlâ GEÇERLİ: okunuyor, kendi satırı yok ve gerekçesi ölçülüyor", () => {
  /**
   * The exception list is the only hole in the two set comparisons, so it is held to a higher
   * standard than the rules it excuses: an entry nothing reads any more, or one that has
   * since gained its own line, is itself a defect — a stale exception silently widens the
   * hole. Each `dogrula` re-measures the reason the exception was granted.
   *
   * Liveness is read off the COMMENT-FREE set for the same reason as the dead-button test: an
   * exception whose last remaining "read" is a sentence has expired.
   */
  const okunan = gercekOkumalar();
  const belgeli = belgeliDegiskenler();
  for (const istisna of ISTISNALAR) {
    assert.ok(
      okunan.has(istisna.ad),
      `${istisna.ad} artık hiçbir yerde okunmuyor — istisna bayatlamış, listeden çıkarılmalı`
    );
    assert.equal(
      belgeli.has(istisna.ad),
      false,
      `${istisna.ad} artık kendi satırına kavuşmuş — istisna gereksiz, listeden çıkarılmalı`
    );
    istisna.dogrula();
  }
});
