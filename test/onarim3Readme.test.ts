// SPDX-License-Identifier: AGPL-3.0-only
/**
 * REPAIR ROUND 3 — the two READMEs, pinned to the step-up doctrine the CODE actually
 * enforces.
 *
 * Rounds 1-3 tightened the network gate three times, and each time docs/CAMARA.md was
 * rewritten while both READMEs kept the pre-round-1 story:
 *
 *   1) "Call forwarding ACTIVE never escalates" — only half the rule. A forwarding check
 *      that falls SILENT is refused too (YANITSIZ_KEFIL_ESLEMESI.callFwd is empty), so the
 *      unknown is never treated more leniently than the known.
 *   2) "one visible table (KEFIL_ESLEMESI)" — there are TWO, and the "ag-yanitsiz" step-up
 *      reads the SECOND one. A reader following the README would open the first table and
 *      conclude that three links vouch for a silent forwarding check: the exact opposite of
 *      the code.
 *   3) The round-3 rule — a link that came back clean WITHOUT OBSERVING ANYTHING vouches for
 *      nothing — was in neither README, so the repo's most-read files described a policy
 *      LOOSER than the gate's.
 *   4) README.tr.md was missing the vouching principle outright ("a link can only vouch for
 *      a signal it could have contradicted"), i.e. the Turkish reader — this product's
 *      primary reader — never saw the gate's central rule. test/belgeTutarliligi.test.ts
 *      compares SECTION HEADINGS only, so a whole missing bullet was invisible to it.
 *
 * WHY THE WATCHERS ARE PAIRED. A text-only assertion rots in one direction: the doc keeps
 * its sentence while the code loosens underneath it. So every doctrine claim checked here in
 * text is also measured in BEHAVIOUR through a real agDogrula run with injected channels —
 * remove the sentence from the README and the test goes red; loosen the gate and the same
 * test goes red. The list itself is checked in BOTH languages, so the two READMEs cannot
 * drift apart again.
 *
 * No test here reaches the network: the chain's channels are injected.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  agDogrula,
  KEFIL_ESLEMESI,
  YANITSIZ_KEFIL_ESLEMESI,
  __setCagriYonlendirmeKanalForTests,
  __setCihazDegisimKanalForTests,
  __setErisimKanalForTests,
  __setKonumKanalForTests,
  __setSimSwapKanalForTests,
  type AgAyar,
} from "../src/networkTrust.js";

/* ── Belgeler ve okunacak bölüm ───────────────────────────────────────────────── */

/** One README: its file name, the step-up section and that section's bullet list. */
interface Belge {
  readonly ad: string;
  readonly bolum: string;
  readonly maddeler: readonly string[];
}

/**
 * The step-up section only — a claim is looked for WHERE IT BELONGS, not anywhere in a
 * 35 KB file. Whole-file matching is how a stale watcher stays green: the words of the rule
 * occur in half a dozen unrelated paragraphs.
 */
function bolumOku(ad: string, baslikAnahtari: string): string {
  const satirlar = readFileSync(new URL(`../${ad}`, import.meta.url), "utf8").split(/\r?\n/);
  const bas = satirlar.findIndex((s) => s.startsWith("### ") && s.includes(baslikAnahtari));
  assert.notEqual(
    bas,
    -1,
    `${ad}: "${baslikAnahtari}" başlıklı bölüm bulunamadı — gözcünün yolu bayatlamış`
  );
  const kalan = satirlar.slice(bas + 1);
  const son = kalan.findIndex((s) => s.startsWith("### ") || s.startsWith("## "));
  return (son === -1 ? kalan : kalan.slice(0, son)).join("\n");
}

/**
 * The bullet list as ONE STRING PER BULLET (continuation lines folded in).
 *
 * The scope matters: a rule counts as written down only when a SINGLE bullet carries all of
 * its parts. Section-wide matching would let the words of one rule be satisfied by the
 * neighbouring rule's sentence — the sham a sibling watcher was measured falling into.
 */
function maddeler(bolum: string): string[] {
  const cikti: string[] = [];
  for (const satir of bolum.split(/\r?\n/)) {
    if (/^- \*\*/.test(satir)) cikti.push(satir.trim());
    else if (cikti.length && /^\s+\S/.test(satir)) cikti[cikti.length - 1] += " " + satir.trim();
    else if (cikti.length && satir.trim().length) break; // the list ended, a paragraph follows
  }
  return cikti;
}

const EN: Belge = (() => {
  const bolum = bolumOku("README.md", "When the signal breaks but nothing is wrong");
  return { ad: "README.md", bolum, maddeler: maddeler(bolum) };
})();

const TR: Belge = (() => {
  const bolum = bolumOku("README.tr.md", "Sinyal bozuk ama ortada bir kötülük yok");
  return { ad: "README.tr.md", bolum, maddeler: maddeler(bolum) };
})();

const BELGELER: readonly Belge[] = [EN, TR];

/* ── 1) İki README de doktrinin AYNI sınırlarını sayıyor ──────────────────────── */

/**
 * One rule of the step-up doctrine, with the patterns that recognise it in each language.
 * ALL of a rule's patterns have to hit the SAME bullet.
 *
 * The Turkish patterns spell dotted/dotless i and the umlauts as character classes on
 * purpose: JavaScript's case-insensitive matching does not fold "İ" onto "i", so /sessiz/i
 * silently misses the doc's "SESSİZKEN".
 */
interface Kural {
  readonly ad: string;
  readonly neden: string;
  readonly en: readonly RegExp[];
  readonly tr: readonly RegExp[];
}

const KURALLAR: readonly Kural[] = [
  {
    ad: "çağrı yönlendirme ne AÇIKKEN ne de SESSİZKEN yükseltilir",
    neden:
      "yalnız AKTİF hâli yazılırsa okuyucu, sessiz kalan yönlendirme kontrolünün " +
      "yükseltilebildiğini sanır — kod bunun tam tersini yapıyor",
    en: [/forward/i, /silent/i, /never escalates|refused|refuses/i],
    tr: [/y[oö]nlendirme/i, /sess[iİ]z/i, /y[uü]kseltil|reddedil/i],
  },
  {
    ad: "simüle halka gerçek sinyale kefil olamaz",
    neden: "demo kipi, kapıdan geçmenin en ucuz yolu olamaz",
    en: [/simulated/i, /vouch/i],
    tr: [/sim[uü]le/i, /kefil/i],
  },
  {
    ad: "doğrulayan gerçek halka yoksa yükseltme de yoktur",
    neden: "yükseltme ikinci bir kanıta dayanır; kanıtsız yükseltme kapıyı açar",
    en: [/no\s+corroborating\s+real\s+link/i, /escalation/i],
    tr: [/gerçek\s+halka\s+yoksa/i, /y[uü]kseltme/i],
  },
  {
    ad: "KEFALET İLKESİ: bir halka ancak ÇÜRÜTEBİLECEĞİ sinyale kefil olabilir",
    neden:
      "tur-1 onarımının ana kuralı; Türkçe README'de hiç yoktu, yani ürünün kendi dilinde " +
      "kapının en önemli kuralı yazılı değildi",
    en: [/vouch/i, /contradict/i],
    tr: [/kefil/i, /[çÇ][uü]r[uü]t|[çÇ]eli[şŞ]/i],
  },
  {
    ad: "iki kefil tablosu (KEFIL_ESLEMESI + YANITSIZ_KEFIL_ESLEMESI)",
    neden:
      "'ag-yanitsiz' yükseltmesi İKİNCİ tablodan okunuyor; tek tablo diyen okuyucu, sessiz " +
      "yönlendirmeye üç halkanın kefil olduğu sonucuna varır",
    en: [/(?<!YANITSIZ_)KEFIL_ESLEMESI/, /YANITSIZ_KEFIL_ESLEMESI/, /\btwo\b/i],
    // No \b anywhere on the Turkish numeral, and both letters spelled as a class: "İ" is
    // outside ASCII \w, so a \b next to it is not a boundary at all and /\biki\b/i cannot see
    // "İKİ" — the very trap this file's own note warns about, one entry above. Measured: with
    // \b the word written in caps for emphasis turned this watcher red on a correct doc. The
    // lookahead is what keeps "ikinci" from counting as the numeral.
    tr: [
      /(?<!YANITSIZ_)KEFIL_ESLEMESI/,
      /YANITSIZ_KEFIL_ESLEMESI/,
      /[iİ]k[iİ](?![a-zçğıöşü])/i,
    ],
  },
  {
    ad: "hiçbir şey GÖZLEMEDEN temiz dönen halka kefil sayılmaz",
    neden: "tur-3'te koda giren kural; iki README'de de hiç yazılı değildi",
    en: [/observ/i, /vouches\s+for\s+nothing|carries\s+no\s+escalation|not\s+evidence|cannot\s+vouch/i],
    tr: [/g[öÖ]zlem/i, /kefil\s+sayılmaz|kefil\s+olamaz|kanıt\s+değildir|taşımaz/i],
  },
  {
    ad: "ikinci bozuk sinyal işi bitirir",
    neden: "yükseltme yalnız BİR bozuk sinyalin hesabını verir",
    en: [/second\s+broken\s+signal/i],
    tr: [/[iİ]kinci\s+bozuk\s+sinyal/i],
  },
  {
    ad: "yapılandırma hataları yükseltilmez",
    neden: "çelişkili kurulum operatörün sorunudur; kimlik kanıtı onu düzeltmez",
    en: [/configuration\s+fault/i],
    tr: [/yapılandırma\s+hatalar/i],
  },
];

test("iki README de yükseltme doktrininin HER sınırını sayıyor (TR/EN parite)", () => {
  /**
   * The measured drift: README.md carried six bullets and README.tr.md five, and the missing
   * Turkish one was the vouching principle itself. Two of the six were also stale.
   */
  for (const belge of BELGELER) {
    const desenSecici = (k: Kural): readonly RegExp[] => (belge.ad === "README.md" ? k.en : k.tr);
    for (const kural of KURALLAR) {
      const desenler = desenSecici(kural);
      const uyan = belge.maddeler.filter((m) => desenler.every((d) => d.test(m)));
      assert.ok(
        uyan.length > 0,
        `${belge.ad} · yükseltme sınırları listesinde şu kural YOK: "${kural.ad}". ` +
          `Neden önemli: ${kural.neden}. Aranan (tek bir maddede birlikte): ` +
          `${desenler.map(String).join(" + ")}`
      );
    }
  }
});

/**
 * The smallest bullet list that can carry the doctrine. It is not KURALLAR.length: the
 * vouching principle and the two-table pairing share one bullet, because the second is the
 * first one's implementation and splitting them would read as two unrelated rules.
 */
const ASGARI_MADDE = 7;

test("iki README'nin sınır listesi AYNI uzunlukta — biri güncellenip diğeri unutulmasın", () => {
  assert.ok(
    EN.maddeler.length >= ASGARI_MADDE,
    `README.md yükseltme sınırları listesinde ${EN.maddeler.length} madde var, en az ` +
      `${ASGARI_MADDE} bekleniyor — bir kural sessizce düşmüş olabilir`
  );
  assert.equal(
    TR.maddeler.length,
    EN.maddeler.length,
    `Sınır listesi iki dilde ayrışmış (EN ${EN.maddeler.length}, TR ${TR.maddeler.length}) — ` +
      `Türkçe okuyan, kapının kurallarından birini hiç görmüyor demektir`
  );
});

/* ── 2) "Tek tablo" iddiası geri gelmesin — ve kod gerçekten iki tablo tutsun ─── */

test("hiçbir README kefil eşlemesini 'TEK tablo' diye anlatmıyor — kodda İKİ tablo var", () => {
  /**
   * BIDIRECTIONAL. The claim's stale wording going back into either README turns this red;
   * so does the code collapsing the two tables into one, because the pinned difference below
   * (the silent forwarding link's empty voucher set versus the reason's non-empty row)
   * disappears with it.
   */
  assert.doesNotMatch(
    EN.bolum,
    /one\s+visible\s+table|a\s+single\s+(visible\s+)?table/i,
    "README.md yeniden 'tek tablo' diyor — 'ag-yanitsiz' eşlemesi ikinci tablodan okunuyor"
  );
  assert.doesNotMatch(
    TR.bolum,
    /tek\s+(görünür\s+)?tablo/i,
    "README.tr.md yeniden 'tek tablo' diyor — 'ag-yanitsiz' eşlemesi ikinci tablodan okunuyor"
  );

  assert.ok(
    (KEFIL_ESLEMESI["ag-yanitsiz"] ?? []).length > 0,
    "KEFIL_ESLEMESI'nin 'ag-yanitsiz' satırı boşalmış — gözcünün dayandığı ayrım kalmadı"
  );
  assert.deepEqual(
    [...(YANITSIZ_KEFIL_ESLEMESI["callFwd"] ?? [])],
    [],
    "İki tablo aynı şeyi söylüyor: sessiz çağrı yönlendirmeye kefil bulunuyor. README'ler " +
      "'ikinci tablo daha dar' diyor, kod artık demiyor — biri bayat"
  );
});

/* ── 3) Davranış: belgedeki üç kural GERÇEK zincir koşusunda ölçülüyor ────────── */

const TEMEL: AgAyar = {
  nacToken: "TEST-ONLY-token",
  approverPhone: "+905550000000",
  simSwapWindowHours: 72,
  reachCheck: true,
  expectedCountry: "TR",
  stepUp: true,
};

afterEach(() => {
  // Dikişler modül-global: sıfırlanmazsa sonraki teste sızar.
  __setSimSwapKanalForTests(undefined);
  __setErisimKanalForTests(undefined);
  __setKonumKanalForTests(undefined);
  __setCihazDegisimKanalForTests(undefined);
  __setCagriYonlendirmeKanalForTests(undefined);
});

test("BELGE↔KOD: sessiz çağrı yönlendirme, diğer halkalar temizken bile yükseltilmiyor", async () => {
  /**
   * The case README.md:199 used to promise the opposite of: five links answer clean over a
   * real channel, only the forwarding check cannot be read. The old sentence ("call
   * forwarding ACTIVE never escalates") tells the reader this escalates. It does not.
   */
  __setSimSwapKanalForTests({ verifySimSwap: async () => false });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: ["TR"] }) });
  __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => false });
  __setCagriYonlendirmeKanalForTests({ kosulsuzYonlendirmeAcikMi: async () => undefined });

  const k = await agDogrula(
    { ...TEMEL, devSwapCheck: true, callFwdCheck: true },
    "high"
  );

  assert.equal(k.kademe, undefined, "sessiz yönlendirme yükseltmeyi taşımamalı");
  assert.equal(k.iz.kademe, undefined, "iz de yükseltme göstermemeli");
  assert.ok(k.engel, "işlem reddedilmeli");
  assert.equal(k.iz.retNedeni, "ag-yanitsiz", "bozulan sinyal 'ag-yanitsiz' olarak kayda geçmeli");
});

test("BELGE↔KOD: hiçbir ülke gözlememiş konum halkası SIM değişimine kefil olmuyor", async () => {
  /**
   * The round-3 rule both READMEs now state. The location link answers clean when the
   * network says "not roaming" and names no country: nothing was contradicted, and nothing
   * was observed either.
   */
  __setSimSwapKanalForTests({ verifySimSwap: async () => true });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: [] }) });

  const k = await agDogrula(TEMEL, "high");

  assert.equal(k.kademe, undefined, "gözlemsiz halka yükseltmeyi taşımamalı");
  assert.ok(k.engel, "işlem reddedilmeli");
  assert.ok(
    !(k.iz.kademeDogrulayan ?? []).includes("loc"),
    `hiçbir ülke gözlememiş konum halkası kefil yazılmamalı (gelen: ${JSON.stringify(
      k.iz.kademeDogrulayan
    )})`
  );
});

test("BELGE↔KOD: sıkılaştırma DAR — ülkeyi gerçekten gören halka yükseltmeyi taşımayı sürdürüyor", async () => {
  /**
   * The READMEs promise a path forward for the honest user, so the watchers must fail if the
   * gate quietly stops offering one: "may escalate" has to stay true.
   */
  __setSimSwapKanalForTests({ verifySimSwap: async () => true });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: ["TR"] }) });

  const k = await agDogrula(TEMEL, "high");

  assert.equal(k.engel, undefined, "gerçek gözlem yükseltmeyi taşımalı");
  assert.equal(k.kademe?.neden, "sim-degisti");
  assert.deepEqual(k.kademe?.dogrulayan, ["loc"], "kefil, ülkeyi gerçekten gören halka olmalı");
});

/* ── 4) Giriş paragrafı YETER koşul vaat etmiyor ──────────────────────────────── */

test("iki README de 'temiz dönen halkalar YETER' vaadini taşımıyor", () => {
  /**
   * The old opening sentence promised a SUFFICIENT condition — "if every one of them answers
   * clean on a real channel, the action proceeds" — while the code requires three more things
   * of the voucher (real channel, able to contradict, actually observed something). The three
   * behaviour tests above measure that gap; this one keeps the sentence honest.
   */
  assert.doesNotMatch(
    EN.bolum,
    /if\s+every\s+one\s+of\s+them\s+answers\s+clean/i,
    "README.md yeniden 'hepsi temiz dönerse geçer' diyor — kod kefilden üç şey daha istiyor"
  );
  assert.match(
    EN.bolum,
    /not\s+sufficient/i,
    "README.md temiz dönmenin YETMEDİĞİNİ hiçbir yerde söylemiyor"
  );
  assert.doesNotMatch(
    TR.bolum,
    /temiz\s+cevap\s+verirse/,
    "README.tr.md yeniden 'hepsi temiz dönerse geçer' diyor — kod kefilden üç şey daha istiyor"
  );
  assert.match(
    TR.bolum,
    /yeterli\s+koşul\s+değil/,
    "README.tr.md temiz dönmenin YETMEDİĞİNİ hiçbir yerde söylemiyor"
  );
});
