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
 * removes both narrowings: EVERY environment variable whoever reads it, and a real
 * assignment LINE rather than a mention.
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
 * Every environment read in src/ and scripts/, WITHOUT the AEGIS_ prefix filter: the defect
 * being closed here is a variable that is not called AEGIS_anything. `process.env.X` is
 * covered by the same pattern as the injected `env.X`, because "is this name read" does not
 * depend on where the environment object came from.
 */
function okunanDegiskenler() {
  const okunan = new Map();
  for (const f of KOD_DIZINLERI.flatMap((d) => dosyalar(path.join(KOK, d)))) {
    const icerik = readFileSync(f, "utf8");
    for (const m of icerik.matchAll(
      /\benv(?:\.([A-Z][A-Z0-9_]*)|\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\])/g
    )) {
      const ad = m[1] ?? m[2];
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
        /\benv(\.NO_COLOR|\[\s*["']NO_COLOR["']\s*\])/.test(readFileSync(f, "utf8"))
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
   */
  const okunan = okunanDegiskenler();
  const olu = [...belgeliDegiskenler()].filter((a) => !okunan.has(a)).sort();
  assert.deepEqual(
    olu,
    [],
    `.env.example bu ayarları sunuyor ama kod hiçbirini okumuyor: ${olu.join(", ")}`
  );
});

test("her istisna hâlâ GEÇERLİ: okunuyor, kendi satırı yok ve gerekçesi ölçülüyor", () => {
  /**
   * The exception list is the only hole in the two set comparisons, so it is held to a higher
   * standard than the rules it excuses: an entry nothing reads any more, or one that has
   * since gained its own line, is itself a defect — a stale exception silently widens the
   * hole. Each `dogrula` re-measures the reason the exception was granted.
   */
  const okunan = okunanDegiskenler();
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
