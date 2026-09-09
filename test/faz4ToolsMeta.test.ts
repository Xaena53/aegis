// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 4 — src/tools/meta.ts: the node-type allow list stands in front of a budget DECREASE
 * too, and until this round the only reason it gave for that was one that does not hold.
 *
 * THE FINDING, AND THE MEASUREMENT THAT ANSWERS IT. `kampanyaDegilseRet` refuses every money
 * path on a node the channel did not vouch for as a campaign, and the sentence it prints
 * named exactly one harm: "hesap güvenlik tavanı kampanyanın değil tek bir setin bütçesiyle
 * karşılaştırılırdı" — the ACCOUNT CEILING would have been measured against one ad set's
 * budget instead of the campaign's. That harm belongs to the CEILING COMPARISON, and a
 * decrease is never compared against the ceiling. Measured through the real MCP surface with
 * the channel injected, a campaign-level read of 400 and a request for 100:
 *
 *   dugumTuru: "kampanya"      → butceGuncelle:100, 0 prompts   (free, as intended)
 *   dugumTuru: "dogrulanmadi"  → REFUSED, 0 writes, 0 prompts
 *   dugumTuru: absent          → REFUSED, 0 writes, 0 prompts
 *
 * So the gate does stand in front of a decrease, and read against the sentence it printed it
 * looked arbitrary — which invites exactly one "repair": exempt the decrease from the
 * identity question, since the repository makes the cheap direction free everywhere else.
 *
 * THAT REPAIR WAS WRITTEN, MEASURED AND REJECTED. Implemented as a strictly-lower carve-out
 * (`dugumTuru` present, `butceKaynagi === "kampanya"`, `dailyBudget < eski`) it did let
 * `dogrulanmadi` + 400 → 100 through — and it turned test/onarim2ToolsMeta.test.ts's KRİTİK
 * "reklam seti kimliğiyle bütçe yazması REDDEDİLİR" red, because that test drives an ad-set
 * response through the REAL client on the DECREASE path and there is no observable that
 * separates the two cases. The round-2 assertion is right, and the missing thing was the
 * reason:
 *
 *   A BUDGET WRITE ASSERTS A NUMBER ABOUT AN OBJECT; A PAUSE ASSERTS NOTHING. "Unknown is
 *   not lower" is applied to the NUMBER (`eskiBilinmiyor`) and to its SCALE
 *   (`kiyaslanamaz`); this gate applies it to the OBJECT. On a node nobody identified,
 *   "400 → 300" is not known to lower the spending the caller meant — `reklamSetiButcesi`
 *   in meta/client.ts exists precisely because a campaign's real daily total can sit in
 *   several sibling ad sets, so lowering ONE node's own budget leaves the siblings unread
 *   and untouched while the tool reports that spending fell.
 *
 * The PAUSE exception does not reach it, and that is measured here rather than asserted: a
 * pause writes no number, its report claims nothing beyond the status, and it goes out even
 * when the read THROWS — because the read is the very thing that may be missing in the
 * emergency a pause exists for. A budget write has none of those properties.
 *
 * WHAT THIS FILE LOCKS. Three behaviour tests measure the refusal (decrease, silent channel,
 * and the reason text), two counter-checks keep the gate from becoming "refuse everything",
 * one measures the pause asymmetry the rationale leans on, and three source watchers tie the
 * new sentences to the code they describe. Each watcher is two-way by construction: it
 * asserts a sentence AND the mechanism the sentence names, so a stale comment and a
 * rewritten mechanism are both red.
 *
 * No network is touched: the channel is injected through the test seam.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { __setMetaKanalForTests, type MetaKampanya } from "../src/meta/client.js";

const TOKEN = "TEST-ONLY-meta-jetonu-1234567890";
const HESAP = "act_1";
const KIMLIK = "9998887776";

/** Writes that really reached the channel — so "nothing was written" is measurable. */
let yazmalar: string[] = [];
/** Approval prompts actually shown — so "the human was never asked" is measurable. */
let istemSayisi = 0;

afterEach(() => {
  __setMetaKanalForTests(undefined);
  yazmalar = [];
  istemSayisi = 0;
});

const metin = (r: any) => String(r.content?.[0]?.text ?? "");

/**
 * The node is flawless EXCEPT for the field under test: the id is digits, the status is
 * known, the budget is readable, campaign-level and under the ceiling. No other refusal can
 * fire, so what is measured is the node gate alone.
 */
function kanalKur(k: Partial<MetaKampanya>, opts: { okumaPatlasin?: boolean } = {}): void {
  const kampanya = {
    id: KIMLIK,
    ad: "Test Kampanyası",
    durum: "PAUSED",
    gunlukButce: 400,
    butceKaynagi: "kampanya",
    ...k,
  } as MetaKampanya;
  __setMetaKanalForTests({
    async kampanyaOlustur() {
      throw new Error("bu testlerde kullanılmıyor");
    },
    async kampanyaOku() {
      if (opts.okumaPatlasin) throw new Error("Meta 500 — okuma yapılamadı");
      return kampanya;
    },
    async butceGuncelle(_id, yeni) {
      yazmalar.push(`butceGuncelle:${yeni}`);
    },
    async durumDegistir(_id, durum) {
      yazmalar.push(`durumDegistir:${durum}`);
    },
  });
}

/** MCP server + client. The network layer is off: the TOOL layer is what is measured. */
async function sunucuKur() {
  const config: any = {
    developerToken: "x",
    clientId: "x",
    clientSecret: "x",
    refreshToken: "x",
    writeEnabled: true,
    maxDailyBudget: 500,
    metaToken: TOKEN,
    metaAdAccountId: HESAP,
    simSwapWindowHours: 72,
    reachCheck: false,
    stepUp: false,
    devSwapCheck: false,
    callFwdCheck: false,
    nacToken: undefined,
    approverPhone: undefined,
  };
  const server = buildServer(() => ({ config }) as any);
  const istemci = new Client(
    { name: "faz4-tools-meta", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } }
  );
  istemci.setRequestHandler(ElicitRequestSchema, async () => {
    istemSayisi++;
    return { action: "accept" as const, content: { onay: true } };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), istemci.connect(b)]);
  return istemci;
}

async function butceCagir(yeni: number) {
  const c = await sunucuKur();
  return (await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: KIMLIK, dailyBudget: yeni },
  })) as any;
}

/* ── THE SCOPE: the gate covers the DECREASE, deliberately ────────────────────── */

test("KRİTİK: kefil olunmamış düğümde AZALTMA da reddedilir — kimlik sorusu ucuz yönde de sorulur", async () => {
  /**
   * The exact call the "obvious repair" would have exempted, and the reason it may not be:
   * on a node nobody identified, 400 → 100 is not known to lower the spending the caller
   * meant. Nothing is written and nobody is asked.
   */
  kanalKur({ dugumTuru: "dogrulanmadi", dugumNotu: "objective alanı yanıtta yok" });
  const r = await butceCagir(100);

  assert.match(metin(r), /Reddedildi/u, "tanınmayan düğüme sayı yazılmaz");
  assert.deepEqual(yazmalar, [], "KRİTİK: hiçbir yazma yapılmamalı");
  assert.equal(istemSayisi, 0, "kapı insana sormadan ÖNCE kapanmalı");
  assert.doesNotMatch(metin(r), /güncellendi/u, "yapılmamış bir güncelleme bildirilmemeli");
});

test("KRİTİK: ret metni AZALTMAYI ADIYLA gerekçelendirir — tavan cümlesi tek başına kalmaz", async () => {
  /**
   * The finding this round answers: the refusal rested only on the ceiling comparison, a
   * reason that is false on this path, so the operator (and a reader of the public repo) saw
   * a gate arguing something that did not apply to their request. Both halves are asserted:
   * the ceiling clause is the ORIGINAL harm and must stay on the record, the decrease clause
   * is the reason that survives the cheap direction.
   */
  kanalKur({ dugumTuru: "dogrulanmadi", dugumNotu: "objective alanı yanıtta yok" });
  const t = metin(await butceCagir(100));

  assert.match(t, /tek bir setin bütçesiyle karşılaştırılırdı/u, "asıl zarar kayıtta kalmalı");
  assert.match(t, /bütçeyi DÜŞÜREN istek için de geçerlidir/u, "azaltma açıkça kapsanmalı");
  assert.match(
    t,
    /kampanyanın diğer setleri okunmadan, dokunulmadan harcamaya devam eder/u,
    "KRİTİK: 'azaltma neden serbest değil' sorusunun cevabı metinde durmalı"
  );
  assert.match(t, /Sebep: objective alanı yanıtta yok/u, "kanalın kendi notu da taşınmalı");
});

test("KRİTİK: SESSİZ kanalda azaltma da reddedilir — sessizlik gözlem sayılmaz", async () => {
  /**
   * `kampanyaOlustur` builds a MetaKampanya from a POST response and vouches for nothing, so
   * this shape is production-reachable. A figure that never came back from a read of the
   * target node cannot make "400 → 100" a decrease of anything.
   */
  kanalKur({ dugumTuru: undefined });
  const r = await butceCagir(100);

  assert.match(metin(r), /Reddedildi/u);
  assert.match(metin(r), /sessizlik gözlem sayılmaz/u, "susan kanalın kendi sebebi verilmeli");
  assert.match(metin(r), /bütçeyi DÜŞÜREN istek için de geçerlidir/u);
  assert.deepEqual(yazmalar, [], "KRİTİK: gözlenmemiş düğüme azaltma da yazılmaz");
});

/* ── COUNTER-CHECKS: the gate is not "refuse everything" ──────────────────────── */

test("KARŞI KONTROL: kefil olunan kampanyada AZALTMA serbest kalır — onay istenmez", async () => {
  /**
   * Without this the three tests above would also pass with the gate closed on every path,
   * and the repository's "spend-lowering is always free" rule would have been quietly lost
   * where it genuinely applies: a node the read DID observe to be a campaign.
   */
  kanalKur({ dugumTuru: "kampanya" });
  const r = await butceCagir(100);

  assert.deepEqual(yazmalar, ["butceGuncelle:100"], "KRİTİK: gerçek azaltma geçmeli");
  assert.equal(istemSayisi, 0, "azaltma onay istemez");
  assert.match(metin(r), /400 → 100/u, "aynı nesnenin iki sayısı bildirilebilir");
});

test("KARŞI KONTROL: kefil olunan kampanyada ARTIŞ hâlâ insana sorulur", async () => {
  kanalKur({ dugumTuru: "kampanya" });
  const r = await butceCagir(450);

  assert.equal(istemSayisi, 1, "artış onay ister");
  assert.deepEqual(yazmalar, ["butceGuncelle:450"]);
  assert.match(metin(r), /güncellendi/u);
});

/* ── THE ASYMMETRY THE RATIONALE LEANS ON, MEASURED ───────────────────────────── */

test("KRİTİK: DURAKLATMA okuma PATLASA bile geçer ve hiçbir sayı iddia etmez", async () => {
  /**
   * The rationale says the pause exception cannot be extended to a budget decrease because a
   * pause writes no number and does not depend on the read. Asserting that in a comment is
   * worth nothing; this measures it. test/onarim3ToolsMeta.test.ts covers the silent-channel
   * case — this one kills the read outright, which is the emergency the exception exists for.
   */
  kanalKur({ dugumTuru: undefined }, { okumaPatlasin: true });
  const c = await sunucuKur();
  const r: any = await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: KIMLIK, status: "PAUSED" },
  });

  assert.deepEqual(
    yazmalar,
    ["durumDegistir:PAUSED"],
    "KRİTİK: harcamayı DURDURAN yazma bir okumaya bağlanmamalı"
  );
  assert.match(metin(r), /durumu: PAUSED/u);
  assert.doesNotMatch(metin(r), /\d+ → \d+|bütçe/u, "duraklatma hiçbir SAYI iddia etmez");
  assert.equal(istemSayisi, 0, "duraklatma onay istemez");
});

/* ── SOURCE WATCHERS: each asserts a sentence AND the mechanism it names ───────── */

const KAYNAK = () => readFileSync(new URL("../src/tools/meta.ts", import.meta.url), "utf8");

/**
 * The gate's OWN doc comment: from its headline to the function it documents. This is the
 * narrowest slice that holds the rationale and nothing else — searching the whole file would
 * let a sentence anywhere in it (a test fixture's prose, another gate's comment) satisfy the
 * assertions and the watcher would never be able to go red.
 */
function kapiYorumu(): string {
  const kaynak = KAYNAK();
  const bas = kaynak.indexOf("THE CEILING IS AN ACCOUNT-WIDE PROMISE");
  assert.ok(bas > 0, "kapı yorumu bulunamadı — başlık değiştiyse gözcü tazelensin");
  const son = kaynak.indexOf("function kampanyaDegilseRet");
  assert.ok(son > bas, "kapı fonksiyonu bulunamadı");
  return kaynak.slice(bas, son);
}

/** The gate's BODY, deliberately without the comment above it. */
function kapiGovdesi(): string {
  const kaynak = KAYNAK();
  const bas = kaynak.indexOf("function kampanyaDegilseRet");
  assert.ok(bas > 0, "kapı fonksiyonu bulunamadı");
  const son = kaynak.indexOf("\n}\n", bas);
  assert.ok(son > bas, "kapı fonksiyonunun sonu bulunamadı");
  return kaynak.slice(bas, son);
}

test("KRİTİK: kapı yorumu AZALTMA kapsamını anlatıyor VE ret metni onu taşıyor (çift yönlü)", () => {
  /**
   * Two-way: the first half goes red if the paragraph is deleted or rewritten away from the
   * decrease, the second if the sentence disappears from the refusal the operator reads.
   * Neither half can stay green while the other is wrong, and the behaviour tests above go
   * red if the code stops refusing at all.
   */
  const yorum = kapiYorumu();
  assert.match(
    yorum,
    /IT STANDS IN FRONT OF A DECREASE TOO/u,
    "kapının azaltmayı da kapsadığı yorumda YAZILI olmalı"
  );
  assert.match(
    yorum,
    /A BUDGET WRITE ASSERTS A NUMBER ABOUT AN OBJECT/u,
    "azaltmanın neden muaf olmadığı gerekçesiyle durmalı"
  );

  const govde = kapiGovdesi();
  assert.match(
    govde,
    /bütçeyi DÜŞÜREN istek için de geçerlidir/u,
    "KRİTİK: yorum azaltmayı gerekçelendiriyor, operatörün okuduğu metinde karşılığı yok"
  );
  assert.match(
    govde,
    /tek bir setin bütçesiyle karşılaştırılırdı/u,
    "asıl zararın kaydı ret metninden düşmemeli"
  );
});

test("KRİTİK: yorumun dayandığı MEKANİZMA gerçekten var — reklamSetiButcesi", () => {
  /**
   * The paragraph's whole weight rests on one fact about the neighbouring module: a
   * campaign's real daily total can sit in several sibling ad sets, which is what
   * `reklamSetiButcesi` computes. If that function is renamed or removed the argument becomes
   * a claim about code that no longer exists, so the watcher reads the other file rather than
   * trusting the sentence.
   */
  const yorum = kapiYorumu();
  assert.match(yorum, /reklamSetiButcesi/u, "gerekçe dayandığı mekanizmayı ADIYLA göstermeli");

  const istemci = readFileSync(new URL("../src/meta/client.ts", import.meta.url), "utf8");
  assert.match(
    istemci,
    /function reklamSetiButcesi\b/u,
    "KRİTİK: yorum var olmayan bir fonksiyona dayanıyor"
  );
});

test("KRİTİK: dosya başlığı 'aynı nesne' kuralını KİMLİK sorusuna kadar götürüyor", () => {
  /**
   * The header is the first thing a reader (or a juror) sees, and it already carried half the
   * rule — "a decrease is only a decrease when both numbers describe THE SAME OBJECT". The
   * other half was missing: the object also has to have been identified. The assertion on the
   * gate's name keeps the sentence tied to the code, so a rename without a header edit is red.
   */
  const kaynak = KAYNAK();
  const baslik = kaynak.slice(0, kaynak.indexOf('import { z } from "zod";'));
  assert.match(baslik, /THE SAME OBJECT/u, "kuralın ilk yarısı durmalı");
  assert.match(baslik, /never IDENTIFIED/u, "kuralın ikinci yarısı da yazılı olmalı");
  assert.match(baslik, /kampanyaDegilseRet/u, "başlık kuralı uygulayan kapıyı adıyla göstermeli");
  assert.match(
    kaynak,
    /function kampanyaDegilseRet\b/u,
    "KRİTİK: başlık var olmayan bir kapıyı gösteriyor"
  );
});
