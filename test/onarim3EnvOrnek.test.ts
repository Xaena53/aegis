// SPDX-License-Identifier: AGPL-3.0-only
/**
 * REPAIR ROUND 3 — .env.example, the ONE surface an operator reads before switching a flag
 * on, pinned to what the code actually does.
 *
 * TWO MEASURED DRIFTS ARE CLOSED HERE:
 *
 *   1) THE STEP-UP BLOCK CARRIED A DOCTRINE THE GATE HAD ABANDONED. It named exactly TWO
 *      deliberate exclusions — "call forwarding while ACTIVE" and "configuration faults" —
 *      and opened with "if the REMAINING links come back clean over a real channel the
 *      operation is not refused". The gate is far narrower than that sentence: a SILENT
 *      forwarding check is never escalated either (YANITSIZ_KEFIL_ESLEMESI.callFwd is empty),
 *      only a link that could CONTRADICT the degraded signal counts as a voucher
 *      (KEFIL_ESLEMESI), and a link that came back clean having OBSERVED NOTHING counts for
 *      nothing (HalkaSonuc.gozlemsiz). The operator was reading a LOOSER gate than the one
 *      that runs — and this file is what they read before setting AEGIS_STEPUP=1.
 *
 *   2) THE DECISION LOG'S FIELD LIST WAS MISSING `tutar`. The code writes the amount at risk
 *      (kararGunlugu.ts · tutarDogrula), docs/DEMO.md and PRIVACY.md both describe it — only
 *      the operator's own list of "what lands on disk" left it out, so the person switching
 *      AEGIS_DECISION_LOG on could not see that the size of the money is recorded. Nothing
 *      pinned that list to the code.
 *
 * WHY THESE WATCHERS ARE NOT WORD MATCHES. A text-only assertion rots in one direction: the
 * sentence survives while the code moves underneath it, and a neighbouring paragraph keeps
 * the keyword green (a sibling watcher was measured doing exactly that). So:
 *   - the field list is compared to THE KEYS OF A LINE REALLY WRITTEN TO DISK by kararYaz,
 *     as a set, in BOTH directions: drop a field from the doc and it goes red; add or remove
 *     a field in the code and it goes red;
 *   - every step-up limit claimed in the block is measured in BEHAVIOUR, through a real
 *     agDogrula run with injected channels. Delete the rule from .env.example and the test
 *     goes red; loosen the gate and the same test goes red.
 *
 * No test here reaches the network or reads a real .env: the chain's channels are injected
 * and the log is written into a temporary directory.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  agDogrula,
  HALKA_SAPTAMA_NEDENI,
  KADEME_UYGUN,
  KEFIL_ESLEMESI,
  YANITSIZ_KEFIL_ESLEMESI,
  __setCagriYonlendirmeKanalForTests,
  __setCihazDegisimKanalForTests,
  __setErisimKanalForTests,
  __setKonumKanalForTests,
  __setSimSwapKanalForTests,
  type AgAyar,
  type AgKarar,
  type RetNedeni,
} from "../src/networkTrust.js";
import { kararYaz, type KararKaydi } from "../src/kararGunlugu.js";
import { mikrodanTutar } from "../src/util.js";

/* ── Okunacak bloklar ─────────────────────────────────────────────────────────── */

const ENV_ORNEK = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

/**
 * ONE block of the file, never the whole file. Whole-file matching is how a stale watcher
 * stays green: "kefil", "yükseltme" and "tutar" all occur in half a dozen unrelated blocks,
 * so a rule deleted from the step-up block would still be "found" elsewhere.
 */
function blokOku(basAnahtar: string, sonAnahtar: string): string {
  const bas = ENV_ORNEK.indexOf(basAnahtar);
  assert.notEqual(bas, -1, `.env.example: "${basAnahtar}" bloğu yok — gözcünün yolu bayatlamış`);
  const son = ENV_ORNEK.indexOf(sonAnahtar, bas);
  assert.notEqual(son, -1, `.env.example: "${sonAnahtar}" satırı bulunamadı — blok bitişi bayat`);
  return ENV_ORNEK.slice(bas, son);
}

const GUNLUK_BLOGU = blokOku("# ── Ağ kapısı KARAR GÜNLÜĞÜ", "\nAEGIS_DECISION_LOG=");
const KADEME_BLOGU = blokOku("# ── Kademeli doğrulama (step-up)", "\nAEGIS_STEPUP=");

/* ── 1) KARAR GÜNLÜĞÜ: alan listesi diske düşen satıra çivili ─────────────────── */

/** One entry of the documented field list: the names it declares, and its own text. */
interface Girdi {
  readonly adlar: string[];
  govde: string;
}

/**
 * Parses the documented field list into entries.
 *
 * The shape is load-bearing and comes from the file itself: an ENTRY line is indented by
 * exactly three spaces after the '#', a CONTINUATION line by five. Depth of parentheses is
 * tracked across lines, so the commas inside a field's explanation (`tutar (… , hesabın …)`)
 * never look like the separator between two fields — and a continuation that happens to
 * begin with an ASCII word ("daha güçlü …") is never mistaken for a field name.
 */
function gunlukGirdileri(): Girdi[] {
  const satirlar = GUNLUK_BLOGU.split(/\r?\n/);
  const bas = satirlar.findIndex((s) => /JSON nesnesi:/.test(s));
  assert.notEqual(bas, -1, ".env.example: alan listesinin başlangıç satırı yok — desen bayat");

  const girdiler: Girdi[] = [];
  let derinlik = 0;
  for (const satir of satirlar.slice(bas + 1)) {
    const m = /^#(\s*)(.*)$/.exec(satir);
    if (!m) break; // the comment block ended
    const girinti = m[1].length;
    const govde = m[2];
    const girisSatiri = derinlik === 0 && girinti === 3 && govde.length > 0;

    if (girisSatiri) {
      // Split at commas OUTSIDE parentheses; the first token of each piece is the field name.
      const parcalar: string[] = [];
      let d = 0;
      let parca = "";
      for (const ch of govde) {
        if (ch === "(") d++;
        else if (ch === ")") d = Math.max(0, d - 1);
        if (ch === "," && d === 0) {
          parcalar.push(parca);
          parca = "";
          continue;
        }
        parca += ch;
      }
      parcalar.push(parca);
      const adlar: string[] = [];
      for (const p of parcalar) {
        const ad = /^\s*([A-Za-z][A-Za-z0-9]*)\s*(\(|$)/.exec(p);
        if (ad) adlar.push(ad[1]!);
      }
      girdiler.push({ adlar, govde });
    } else if (girdiler.length) {
      girdiler[girdiler.length - 1]!.govde += " " + govde.trim();
    }

    for (const ch of govde) {
      if (ch === "(") derinlik++;
      else if (ch === ")") derinlik = Math.max(0, derinlik - 1);
    }
    // Back at depth 0 and no longer indented as a list item: the enumeration is over.
    if (derinlik === 0 && girinti <= 1 && !girisSatiri) break;
  }
  return girdiler;
}

/**
 * A record with EVERY field populated.
 *
 * `Required<KararKaydi>` is the exhaustiveness lock, and it is the reason this is typed
 * rather than a loose object: add a field to the record and this literal STOPS COMPILING
 * under tsconfig.check.json, so the field cannot reach disk without passing through this
 * file — and therefore without being documented.
 */
const TAM_KAYIT: Required<KararKaydi> = {
  zaman: "2026-09-07T10:00:00.000Z",
  eylem: "Günlük bütçe 50 TRY'ye çıkarılıyor",
  hesapId: "1234567890",
  risk: "high",
  karar: "kademeli",
  kademeDogrulayan: ["devSwap", "loc"],
  simSwapKanali: "gercek",
  nvKanali: "simulasyon",
  reachKanali: "gercek",
  locKanali: "gercek",
  devSwapKanali: "gercek",
  callFwdKanali: "gercek",
  pencereSaat: 72,
  devSwapPencereSaat: 72,
  tutar: 50,
  maskeliNumara: "+905*****33",
  retNedeniKisa: "sim-degisti",
  retNedenleri: ["sim-degisti"],
};

/** Writes ONE record through the real kararYaz and returns the JSON object that hit disk. */
function diskeYaz(kayit: KararKaydi): Record<string, unknown> {
  const kok = mkdtempSync(path.join(tmpdir(), "aegis-envornek-"));
  const hedef = path.join(kok, "kararlar.jsonl");
  const onceki = process.env.AEGIS_DECISION_LOG;
  process.env.AEGIS_DECISION_LOG = hedef;
  try {
    kararYaz(kayit);
    const satirlar = readFileSync(hedef, "utf8").trim().split(/\r?\n/);
    assert.equal(satirlar.length, 1, "tek kayıt bekleniyordu");
    return JSON.parse(satirlar[0]!) as Record<string, unknown>;
  } finally {
    if (onceki === undefined) delete process.env.AEGIS_DECISION_LOG;
    else process.env.AEGIS_DECISION_LOG = onceki;
    rmSync(kok, { recursive: true, force: true });
  }
}

test("karar günlüğü: .env.example'ın ALAN LİSTESİ diske düşen satırla BİREBİR aynı", () => {
  /**
   * THE MEASURED DEFECT: `tutar` was written by the code and absent from this list, so the
   * operator switching the log on could not see that the size of the money lands on disk.
   *
   * BOTH DIRECTIONS. A field dropped from the documentation fails here, and so does a field
   * the documentation invents but kararYaz never writes — the second half matters just as
   * much on a public repo: a promised-but-absent audit field is a claim about evidence that
   * does not exist.
   */
  const girdiler = gunlukGirdileri();
  const belgedeki = girdiler.flatMap((g) => g.adlar);
  assert.ok(
    belgedeki.length >= 10,
    `.env.example alan listesinden yalnız ${belgedeki.length} ad okunabildi — ayrıştırıcı ` +
      `bayatlamış olabilir; gözcü sessizce boşa düşmemeli`
  );
  assert.deepEqual(
    [...new Set(belgedeki)].sort(),
    [...belgedeki].sort(),
    ".env.example alan listesinde aynı alan iki kez sayılıyor"
  );

  const diskteki = Object.keys(diskeYaz(TAM_KAYIT));
  assert.deepEqual(
    belgedeki.slice().sort(),
    diskteki.slice().sort(),
    `.env.example'ın karar günlüğü ALAN LİSTESİ, kararYaz'ın diske yazdığı satırla ` +
      `uyuşmuyor.\n  belgede: ${belgedeki.slice().sort().join(", ")}\n  diskte : ${diskteki
        .slice()
        .sort()
        .join(", ")}\nOperatör diske hangi verinin düştüğünü BURADAN okuyor.`
  );
});

test("karar günlüğü: 'tutar' belgenin söylediği gibi davranıyor (okunamayan tutar YAZILMAZ)", () => {
  /**
   * The doc entry makes three promises; each is measured against the code rather than
   * trusted: the amount is written, an unreadable amount is NOT written (0 is not a stand-in
   * for "unknown"), 0 as a real reading IS written, and the number is the account's currency
   * amount, not micros.
   */
  const girdi = gunlukGirdileri().find((g) => g.adlar.includes("tutar"));
  assert.ok(girdi, ".env.example karar günlüğü listesi 'tutar' alanını hiç anmıyor");

  assert.equal(diskeYaz(TAM_KAYIT).tutar, 50, "okunabilen tutar kayda düşmeli");
  assert.equal(
    "tutar" in diskeYaz({ ...TAM_KAYIT, tutar: undefined }),
    false,
    "okunamayan tutar 0 diye YAZILMAMALI: 'bilmiyorum', 'sıfır harcama' değildir"
  );
  assert.equal(diskeYaz({ ...TAM_KAYIT, tutar: 0 }).tutar, 0, "0 gerçek bir ölçümdür, düşmeli");
  assert.match(
    girdi.govde,
    /yazılmaz/,
    "belge, okunamayan tutarın hiç yazılmadığını söylemiyor — operatör 0'ı ölçüm sanır"
  );

  // "micros DEĞİL: 50 TRY '50' olarak yazılır" — the claim, and the helper that keeps it.
  assert.equal(mikrodanTutar(50_000_000), 50, "kayda giren sayı hesabın para birimindedir");
  assert.equal(mikrodanTutar(undefined), undefined, "okunamayan micros bir tutar üretmez");
  assert.match(girdi.govde, /micros/i, "belge micros ayrımını yazmıyor");

  // "Ayrı bir para birimi alanı YOKTUR": no field may claim a unit the gate never measured.
  const paraAlanlari = Object.keys(diskeYaz(TAM_KAYIT)).filter((a) =>
    /para|currency|micros/i.test(a)
  );
  assert.deepEqual(paraAlanlari, [], "kayıtta belgenin YOK dediği bir para birimi alanı var");
});

/* ── 2) KADEME BLOĞU: dört sınır, hem yazılı hem koşuyor ──────────────────────── */

/** The step-up block's numbered items, continuation lines folded into their own item. */
function kademeMaddeleri(): string[] {
  const cikti: string[] = [];
  for (const satir of KADEME_BLOGU.split(/\r?\n/)) {
    const bas = /^#\s{2}(\d)\)\s+(\S.*)$/.exec(satir);
    if (bas) {
      cikti.push(`${bas[1]}) ${bas[2]}`);
      continue;
    }
    const devam = /^#\s{5}(\S.*)$/.exec(satir);
    if (devam && cikti.length) cikti[cikti.length - 1] += " " + devam[1];
  }
  return cikti;
}

const TEMEL: AgAyar = {
  nacToken: "TEST-ONLY-token",
  approverPhone: "+905550000000",
  simSwapWindowHours: 72,
  reachCheck: true,
  devSwapCheck: false,
  callFwdCheck: false,
  expectedCountry: "TR",
  stepUp: true,
};

/**
 * Injects all five channels at once. Every default is the CLEAN, OBSERVING body, so each
 * test changes exactly the one thing it is about — and a refusal can never be blamed on a
 * link nobody configured.
 */
function kanallar(o: {
  simDegisti?: boolean | undefined;
  erisilebilir?: boolean | undefined;
  konum?: { yurtDisinda?: boolean; ulkeler?: string[] };
  cihazDegisti?: boolean | undefined;
  yonlendirme?: boolean | undefined;
}): void {
  __setSimSwapKanalForTests({ verifySimSwap: async () => o.simDegisti ?? false });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => o.erisilebilir ?? true });
  __setKonumKanalForTests({
    ulkeDurumu: async () => o.konum ?? { yurtDisinda: false, ulkeler: ["TR"] },
  });
  __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => o.cihazDegisti ?? false });
  __setCagriYonlendirmeKanalForTests({ kosulsuzYonlendirmeAcikMi: async () => o.yonlendirme });
}

// The seams are module-global: without a reset they leak into the next test.
afterEach(() => {
  __setSimSwapKanalForTests(undefined);
  __setErisimKanalForTests(undefined);
  __setKonumKanalForTests(undefined);
  __setCihazDegisimKanalForTests(undefined);
  __setCagriYonlendirmeKanalForTests(undefined);
});

function reddedildiMi(k: AgKarar, mesaj: string): void {
  assert.match(String(k.engel), /Reddedildi/, mesaj);
  assert.equal(k.kademe, undefined, `${mesaj} — yükseltme yapılmamalıydı`);
  assert.notEqual(k.iz.kademe, "yukseltildi", `${mesaj} — iz yükseltme taşımamalı`);
}

/** The configuration faults — none of them is escalatable, and the type keeps the list honest. */
const YAPILANDIRMA_NEDENLERI: readonly RetNedeni[] = [
  "beklenen-ulke-gecersiz",
  "yapilandirma-celiskili",
  "simulasyon-degeri-tanimsiz",
  "onaylayici-numarasi-yok",
  "ag-ayari-kapiya-ulasmadi",
];

/**
 * ONE limit of the step-up doctrine: how it is recognised in the .env.example block, and
 * what it MEANS when the gate runs.
 *
 * `belge` patterns must ALL hit the SAME numbered item — section-wide matching would let one
 * rule's words satisfy another rule's absence, the sham this round exists to remove. The
 * Turkish patterns spell the dotted/dotless i and the umlauts as character classes: JS
 * case-insensitive matching does not fold "İ" onto "i", so /sessiz/i silently misses
 * "SESSİZKEN".
 */
interface Sinir {
  readonly ad: string;
  readonly neden: string;
  readonly belge: readonly RegExp[];
  readonly davranis: () => Promise<void>;
}

const SINIRLAR: readonly Sinir[] = [
  {
    ad: "çağrı yönlendirme ASLA yükseltilmez — ne açıkken ne sessizken",
    neden:
      "belge yalnız AÇIK hâli sayıyordu; oysa SUSAN yönlendirme halkası da yükseltilmiyor " +
      "(YANITSIZ_KEFIL_ESLEMESI.callFwd boş). Bilinmeyen, bilinenden hoşgörülü ele alınamaz",
    belge: [
      /y[oö]nlendirme/i,
      /[aA][çÇ][ıiİI]k/,
      /[sS][eE][sS][sS][iİ][zZ]|[sS][uU][sS][tT]/,
      /cagri-yonlendirme-acik/,
      /ag-yanitsiz/,
    ],
    davranis: async () => {
      // The table halves, straight from the code.
      assert.equal(
        KADEME_UYGUN.has(HALKA_SAPTAMA_NEDENI.callFwd!),
        false,
        "AKTİF yönlendirme yükseltilebilir hâle gelmiş — belge tersini söylüyor"
      );
      assert.deepEqual(
        [...(YANITSIZ_KEFIL_ESLEMESI.callFwd ?? [])],
        [],
        "SESSİZ yönlendirmeye kefil bulunmuş — belge 'kimse kefil olamaz' diyor"
      );

      /**
       * And the run itself: the forwarding link answers nothing while simSwap, devSwap and
       * loc all come back clean OVER A REAL CHANNEL — and all three sit in
       * KEFIL_ESLEMESI["ag-yanitsiz"]. So this is NOT the "no real link ran" case; the
       * refusal has to come from the silence being unvouchable.
       */
      kanallar({ yonlendirme: undefined });
      const k = await agDogrula(
        { ...TEMEL, callFwdCheck: true, devSwapCheck: true },
        "high"
      );
      assert.equal(k.iz.retNedeni, "ag-yanitsiz", "sessiz halka 'ag-yanitsiz' üretmeli");
      reddedildiMi(k, "sessiz çağrı yönlendirme");
      for (const aday of ["simSwap", "devSwap", "loc"]) {
        assert.ok(
          KEFIL_ESLEMESI["ag-yanitsiz"]!.includes(aday),
          `${aday} birinci tabloda 'ag-yanitsiz' kefili — düzenek, "kefil adayı yoktu" ` +
            `vakasına düşmemeli, yoksa test kuralı ölçmez`
        );
      }
    },
  },
  {
    ad: "yapılandırma hataları yükseltilmez",
    neden: "çelişkili kurulum operatörün sorunudur; kimlik doğrulaması onu düzeltmez",
    belge: [/[yY]apılandırma hata/, /y[uü]kseltil/i],
    davranis: async () => {
      for (const neden of YAPILANDIRMA_NEDENLERI) {
        assert.equal(
          KADEME_UYGUN.has(neden),
          false,
          `yapılandırma kodu "${neden}" yükseltilebilir olmuş — belge tersini söylüyor`
        );
      }
      // A real run: real query AND simulation set together on link 6 is a contradiction.
      kanallar({});
      const k = await agDogrula(
        { ...TEMEL, callFwdCheck: true, callFwdSimulate: "kapali" },
        "high"
      );
      assert.equal(k.iz.retNedeni, "yapilandirma-celiskili");
      reddedildiMi(k, "çelişkili yapılandırma");
    },
  },
  {
    ad: "bir halka ancak ÇÜRÜTEBİLECEĞİ sinyale kefil olabilir",
    neden:
      "erişilebilirlik bir CANLILIK sinyalidir: değişmiş SIM de erişilebilir bir telefondadır, " +
      "yani iki sinyal hiç çelişmez ve çelişemeyen halka kefil de olamaz",
    belge: [/kefil/i, /[çÇ][uü]r[uü]t|[çÇ]eli[şŞ]/, /eri[şŞ]ilebilir/i],
    davranis: async () => {
      for (const halka of ["reach", "nv"]) {
        for (const [neden, kefiller] of Object.entries(KEFIL_ESLEMESI)) {
          assert.equal(
            kefiller.includes(halka),
            false,
            `"${halka}" ${neden} kefilleri arasına girmiş — çürütemediği sinyale kefil olamaz`
          );
        }
        for (const [sessiz, kefiller] of Object.entries(YANITSIZ_KEFIL_ESLEMESI)) {
          assert.equal(
            kefiller.includes(halka),
            false,
            `"${halka}" sessiz ${sessiz} halkasının kefili olmuş — aynı ilke ikinci tabloda kırık`
          );
        }
      }
      /**
       * The run: the SIM really changed and the ONLY clean real link is reachability
       * (location off, device swap and forwarding off). Under "at least one remaining link
       * came back clean" — the sentence .env.example used to open with — this passed.
       */
      kanallar({ simDegisti: true });
      const k = await agDogrula({ ...TEMEL, expectedCountry: undefined }, "high");
      assert.equal(k.iz.retNedeni, "sim-degisti");
      reddedildiMi(k, "tek temiz halka erişilebilirlikken saptanmış SIM değişimi");
    },
  },
  {
    ad: "hiçbir şey GÖZLEMEDEN temiz dönen halka kefil olmaz",
    neden:
      "ağ 'yurt dışında değil' deyip hiçbir ülke bildirmediğinde konum halkası temiz döner " +
      "ama hattı beklenen ülkeye YERLEŞTİRMİŞ değildir; gözlenmemiş olan kanıt değildir",
    belge: [/[gG][ÖÖö][zZ][lL][eE][mM]|[gG][ÖÖö][zZ][lL][eE][nN]/, /kefil/i],
    davranis: async () => {
      /**
       * BOTH DIRECTIONS IN ONE PLACE. The control run matters as much as the refusal: with
       * the network reporting TR the very same setup ESCALATES, so the refusal below is
       * caused by the missing observation and by nothing else. Without the control a broken
       * harness would keep this test green while measuring nothing.
       */
      kanallar({ simDegisti: true, konum: { yurtDisinda: false, ulkeler: ["TR"] } });
      const gozlemli = await agDogrula(TEMEL, "high");
      assert.equal(gozlemli.engel, undefined, "gözlem yapan konum halkası kefil OLABİLMELİ");
      assert.deepEqual(gozlemli.kademe?.dogrulayan, ["loc"]);

      kanallar({ simDegisti: true, konum: { yurtDisinda: false, ulkeler: [] } });
      const gozlemsiz = await agDogrula(TEMEL, "high");
      assert.equal(gozlemsiz.iz.retNedeni, "sim-degisti");
      reddedildiMi(gozlemsiz, "hiçbir ülke gözlememiş konum halkası");
    },
  },
];

test("kademe bloğu: DÖRT sınırın hepsi hem YAZILI hem de kodda geçerli", async () => {
  const maddeler = kademeMaddeleri();
  assert.equal(
    maddeler.length,
    SINIRLAR.length,
    `.env.example kademe bloğu ${maddeler.length} sınır sayıyor, doktrin ${SINIRLAR.length}. ` +
      `Bloğun kendi cümlesi de "DÖRT SINIR" diyor — sayı ile liste birlikte değişmeli.`
  );
  assert.match(
    KADEME_BLOGU,
    /D[ÖÖ]RT SINIR/,
    "kademe bloğu artık kaç sınır olduğunu söylemiyor — okuyucu listenin tam olduğunu bilemez"
  );

  for (const sinir of SINIRLAR) {
    const uyan = maddeler.filter((m) => sinir.belge.every((d) => d.test(m)));
    assert.equal(
      uyan.length,
      1,
      `.env.example kademe bloğunda şu sınır TEK bir maddede yazılı değil: "${sinir.ad}" ` +
        `(eşleşen madde: ${uyan.length}). Neden önemli: ${sinir.neden}. Aranan desenler: ` +
        `${sinir.belge.map(String).join(" + ")}`
    );
    await sinir.davranis();
  }
});

test("kademe bloğu: açılış cümlesi kapının GERÇEK darlığını söylüyor", () => {
  /**
   * The old opening — "if the REMAINING links come back clean over a real channel the
   * operation is not refused" — was the loosest sentence in the repository: it promised a
   * pass on any clean link, while the gate demands a link that could CONTRADICT the degraded
   * signal AND observed something. The refusal text the gate actually prints in that case is
   * pinned here too, so the doc and the gate cannot drift apart silently.
   */
  const giris = KADEME_BLOGU.split(/^#\s{2}1\)/m)[0]!;
  assert.match(
    giris,
    /KEF[İIı]L OLAB[İIı]LECEK|kefil olabilecek/i,
    "açılış, kefil OLABİLECEK halkadan söz etmiyor: 'kalan halkalar temiz dönerse geçer' " +
      "cümlesi kapıdan çok daha geniştir"
  );
  assert.match(
    giris,
    /TEM[İIı]Z D[ÖÖ]NMEK TEK BA[ŞŞ]INA YETMEZ/,
    "açılış, temiz dönmenin tek başına yetmediğini söylemiyor"
  );
  assert.match(giris, /docs\/CAMARA\.md/, "aynı doktrinin kanonik yerini göstermiyor");
  assert.match(giris, /src\/networkTrust\.ts/, "kuralın koştuğu dosyayı göstermiyor");
});

test("kademe bloğu: terk edilmiş İKİ SINIRLI doktrin geri gelemez", () => {
  /**
   * The stale sentences by name. A watcher that only asks "is the new rule written" goes
   * green on a file that says BOTH things; this one fails the moment the abandoned doctrine
   * is pasted back — which is exactly how the drift happened the first time.
   */
  const bayat: [RegExp, string][] = [
    [
      /Y[uü]kseltilemeyenler bilerek d[ıi][şs]ar[ıi]da/i,
      "iki sınırlı eski liste geri gelmiş (sessiz yönlendirme ve kefalet ilkesi yok)",
    ],
    [
      /kalan halkalar GER[ÇÇ]EK kanaldan temiz d[öö]nerse/i,
      "kapıdan çok geniş olan eski açılış cümlesi geri gelmiş",
    ],
    [
      /[çÇ]a[ğg]r[ıi] y[öö]nlendirme A[ÇÇ]IKKEN y[üu]kseltme yap[ıi]lmaz/i,
      "yalnız AKTİF yönlendirmeyi anan eski cümle geri gelmiş",
    ],
  ];
  const suclular = bayat.filter(([d]) => d.test(KADEME_BLOGU)).map(([, n]) => n);
  assert.deepEqual(suclular, [], `.env.example kademe bloğu bayat doktrine dönmüş: ${suclular}`);
});
