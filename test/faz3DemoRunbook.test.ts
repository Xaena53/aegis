// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 3 — docs/DEMO.md: does the runbook's audit-trail prose name the decision log's REAL
 * fields?
 *
 * MEASURED DRIFT (§3.3, the "In the audit trail this outcome is..." sentence): the document
 * promised a `kademeNedeni` field beside `kademeDogrulayan` on a `"karar":"kademeli"` line.
 * No such field exists anywhere in this repository — the escalation's reason is written as
 * `retNedeniKisa` (src/kararGunlugu.ts), and the SAME document names it correctly two
 * hundred lines further down, in its own field dictionary. One concept, two names in one
 * file, one of them invented. An operator or a juror following runbook 3.3 with
 * `jq 'select(.kademeNedeni)' kararlar.jsonl` gets ZERO rows and concludes the escalation's
 * reason was never recorded — a false "missing record" impression in the one feature the
 * whole demo is built around.
 *
 * Neither guard below is a text matcher. Both derive the expected field names by CALLING
 * agKararKaydiOlustur and reading the keys off the record it produces, so each is
 * BIDIRECTIONAL:
 *   - the document drifts back (or invents another field) -> RED,
 *   - the code renames a field, or adds one and leaves the dictionary behind -> RED.
 *
 * No network: the record is built from a hand-written trace, exactly as the gate would have
 * filled it in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agKararKaydiOlustur, KARAR_SONUCLARI } from "../src/kararGunlugu.js";
import type { AgKarar, RetNedeni } from "../src/networkTrust.js";

const KOK = fileURLToPath(new URL("..", import.meta.url));
/**
 * CRLF is normalised: a checkout with `core.autocrlf=true` would otherwise make every
 * pattern below miss, and the guard would go green for the wrong reason.
 */
const DEMO = readFileSync(join(KOK, "docs/DEMO.md"), "utf8").replace(/\r\n/g, "\n");

/** The degraded signal that carries the escalation in the record built below. */
const BOZUK_SINYAL: RetNedeni = "cihaz-erisilemez";
/** The links that vouch for it. */
const KEFILLER = ["simSwap", "devSwap"];

/**
 * A step-up decision as the gate itself would hand it to the log: every optional field of
 * the trace filled in, so the produced record opens EVERY field the format has. A record
 * with fields missing would let the dictionary guard pass over a name it never checked.
 */
const TAM_AG: AgKarar = {
  kanit: [],
  iz: {
    simSwap: "gercek",
    nv: "simulasyon",
    reach: "simulasyon",
    loc: "gercek",
    devSwap: "gercek",
    callFwd: "gercek",
    pencereSaat: 72,
    devSwapPencereSaat: 72,
    maskeliNumara: "+905*******22",
    retNedeni: BOZUK_SINYAL,
    retNedenleri: [BOZUK_SINYAL],
    kademe: "yukseltildi",
    kademeDogrulayan: [...KEFILLER],
  },
};

/** The record the code actually writes — the single source of truth for both guards. */
function kademeliKayit(): Record<string, unknown> {
  const kayit = agKararKaydiOlustur(
    '"Demo Kampanya" YAYINA ALINACAK.',
    "high",
    TAM_AG,
    "1234567890",
    51
  ) as unknown as Record<string, unknown>;
  const yazilan: Record<string, unknown> = {};
  // Absent fields are omitted rather than written as null — mirror that here, because an
  // `undefined` key never reaches a JSONL line and must not count as documented either.
  for (const [ad, deger] of Object.entries(kayit)) if (deger !== undefined) yazilan[ad] = deger;
  return yazilan;
}

test("docs/DEMO.md denetim izi cümlesi yalnız GERÇEKTEN yazılan alan adlarını anıyor", () => {
  const kayit = kademeliKayit();
  const alanlar = Object.entries(kayit);

  assert.equal(kayit.karar, "kademeli", "kurgu bir kademeli karar üretmiyor — gözcünün konusu kayboldu");

  /**
   * The two names the sentence must carry are READ OFF THE RECORD, never typed here: the
   * field whose value IS the degraded signal, and the field whose value IS the voucher
   * list. Rename either in kararGunlugu.ts and the derived name changes, so the sentence —
   * untouched — goes red.
   */
  const nedenAlanlari = alanlar.filter(([, d]) => d === BOZUK_SINYAL).map(([a]) => a);
  assert.equal(
    nedenAlanlari.length,
    1,
    `bozuk sinyali taşıyan alan tek değil (${nedenAlanlari.join(", ") || "hiç"}) — gözcü hangi adı arayacağını türetemez`
  );
  const kefilAlanlari = alanlar
    .filter(
      ([, d]) =>
        Array.isArray(d) && d.length === KEFILLER.length && d.every((x, i) => x === KEFILLER[i])
    )
    .map(([a]) => a);
  assert.equal(
    kefilAlanlari.length,
    1,
    `kefil listesini taşıyan alan tek değil (${kefilAlanlari.join(", ") || "hiç"})`
  );

  const paragraflar = DEMO.split("\n\n").filter((p) => p.includes('`"karar":"kademeli"`'));
  assert.equal(
    paragraflar.length,
    1,
    'docs/DEMO.md\'de `"karar":"kademeli"` denetim izi paragrafı bulunamadı — paragraf yeniden yazıldıysa gözcü sessizce boşa düşmesin diye burada durur'
  );
  const metin = paragraflar[0];

  /**
   * EVERY backticked bare identifier in that paragraph must be either a real field of the
   * record or a value from the verdict vocabulary. `kademeNedeni` was neither.
   */
  const izinli = new Set<string>([...Object.keys(kayit), ...KARAR_SONUCLARI]);
  const anilanlar = [...metin.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)].map((m) => m[1]);
  assert.ok(anilanlar.length > 0, "paragrafta hiç alan adı anılmıyor — gözcü boşa dönüyor");
  for (const ad of anilanlar) {
    assert.ok(
      izinli.has(ad),
      `docs/DEMO.md denetim izi paragrafı '${ad}' diye bir alan/değer anıyor; karar kaydında böyle bir ad YOK ` +
        `(yazılanlar: ${[...izinli].join(", ")}). Runbook'u izleyen denetçi bu adı JSONL'de arar ve sıfır satır bulur.`
    );
  }

  /** `"alan":"deger"` fragments are checked on both halves. */
  for (const eslesme of metin.matchAll(/`"([A-Za-z][A-Za-z0-9]*)":"([a-z]+)"`/g)) {
    const alan = eslesme[1];
    const deger = eslesme[2];
    assert.ok(
      Object.hasOwn(kayit, alan),
      `paragraftaki \`"${alan}":...\` kayıtta olmayan bir alanı gösteriyor`
    );
    assert.ok(
      (KARAR_SONUCLARI as readonly string[]).includes(deger),
      `paragraftaki '${deger}' karar sözcüğü KARAR_SONUCLARI'nda yok`
    );
  }

  assert.ok(
    metin.includes(`\`${nedenAlanlari[0]}\``),
    `denetim izi paragrafı yükseltmenin gerekçesini taşıyan alanı ('${nedenAlanlari[0]}') hiç anmıyor — ` +
      "kod alanı yeniden adlandırdıysa önce belgeyi düzelt"
  );
  assert.ok(
    metin.includes(`\`${kefilAlanlari[0]}\``),
    `denetim izi paragrafı kefil alanını ('${kefilAlanlari[0]}') hiç anmıyor`
  );
});

test("docs/DEMO.md alan sözlüğü: karar kaydının yazdığı HER alanın tam olarak bir satırı var", () => {
  const kayit = kademeliKayit();
  const yazilan = Object.keys(kayit);
  /**
   * Anti-vacuum floor: if the builder ever returned an (almost) empty record the loop below
   * would iterate over nothing and pass. The full trace above opens every field the format
   * has, so a collapse here is a real defect, not a threshold to relax.
   */
  assert.ok(
    yazilan.length >= 15,
    `kademeli kayıt yalnız ${yazilan.length} alan yazdı — sözlük gözcüsü boşa dönerdi`
  );

  const bas = DEMO.indexOf("Fields (absent fields are omitted");
  assert.notEqual(bas, -1, "docs/DEMO.md'de karar günlüğü alan sözlüğünün girişi bulunamadı");
  const son = DEMO.indexOf("\n### ", bas);
  const sozluk = DEMO.slice(bas, son === -1 ? undefined : son);

  for (const ad of yazilan) {
    const satirlar = sozluk.split("\n").filter((s) => s.startsWith(`| \`${ad}\` |`));
    assert.equal(
      satirlar.length,
      1,
      `karar günlüğü '${ad}' alanını yazıyor ama docs/DEMO.md'nin alan sözlüğünde ${satirlar.length} satırı var. ` +
        "Kapıya ulaşıp sözlüğe ulaşmayan bir alan, denetçinin okuyamadığı bir alandır."
    );
  }
});
