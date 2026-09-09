// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 5 — src/tools/meta.ts: THE TOOL DESCRIPTION IS THE SURFACE THE MODEL ACTUALLY READS,
 * so the contract it states has to be the contract the code enforces.
 *
 * THE FINDING. `update_meta_campaign_budget`'s description said "azaltma onay istemez"
 * without qualification, enumerated the ad-set-total case (`kiyaslanamaz`) as the ONE
 * exception to that shortcut, and named exactly one refusal — "Tavan üstü değer reddedilir".
 * It never mentioned the node-identity gate. Measured through the real MCP surface with the
 * channel injected (campaign-level read of 400, request for 100):
 *
 *   dugumTuru: "kampanya"      → butceGuncelle:100, 0 prompts   (free, as documented)
 *   dugumTuru: "dogrulanmadi"  → "Reddedildi", 0 writes, 0 prompts
 *   dugumTuru: absent          → "Reddedildi", 0 writes, 0 prompts
 *
 * So a planning agent that read the description concluded "a decrease always goes through,
 * the only refusal is the ceiling" — and got a refusal the description gave it no way to
 * anticipate. The gate's own doc comment and the operator-facing refusal text had already
 * been corrected in the previous round; the LLM-facing surface had not. Correcting the
 * comment while leaving the description is the same defect one layer out.
 *
 * WHAT THIS FILE LOCKS, AND WHY IT IS NOT A SPELLING TEST. Every claim here is derived from
 * a measurement taken in the same run: the description is read from `listTools` (what the
 * model receives, not what the source file happens to contain) and is checked AGAINST the
 * two behaviours measured above. Concretely:
 *
 *   1. A decrease on a VOUCHED node is free — so the description must keep saying so.
 *   2. A decrease on an UNVOUCHED node is refused before any write and before any prompt —
 *      so every sentence granting the decrease shortcut must carry the condition, and some
 *      sentence must name the refusal and say it reaches a decrease.
 *
 * WHY THE SENTENCE SCAN CANNOT PASS BY BLINDNESS. `cumleler()` splits on sentence and clause
 * boundaries and keeps every segment; the assertions then require a MINIMUM number of
 * segments and require the shortcut segment to EXIST before judging it. A parser that
 * returned nothing — the usual way an "assert the absence" watcher rots into a vacuum — fails
 * on those existence checks instead of passing silently. Measured: with the old description
 * restored verbatim, the shortcut segment is found and goes red for the missing condition;
 * with the refusal sentence deleted, the second assertion goes red.
 *
 * LIMITS, so a green run is not read as more than it is. This measures the description
 * against the node gate and the decrease shortcut only: it does not enumerate the tool's
 * other refusals (write disabled, missing configuration, malformed id, a human's "no", a
 * clamp that moved) and it does not claim the description is exhaustive — a description that
 * omits some OTHER refusal stays green here. And the check is LEXICAL: it catches the shape
 * the finding actually had (an unconditional shortcut, an unmentioned refusal), not a
 * fluent sentence that names the condition and then misstates it.
 *
 * No network is touched: the channel is injected through the test seam.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { __setMetaKanalForTests, type MetaKampanya } from "../src/meta/client.js";

/** The `TEST-ONLY-` prefix is mandatory here: without it CI's secret scanner reads it as real. */
const TOKEN = "TEST-ONLY-meta-jetonu-faz5-0123456789";
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
 * The node is flawless EXCEPT for the field under test: digits for an id, a known status, and
 * a readable campaign-level budget under the ceiling. No other refusal can fire, so what is
 * measured is the identity gate alone.
 */
function kanalKur(k: Partial<MetaKampanya>): void {
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

/** MCP server + client. The network layer is off: the TOOL surface is what is measured. */
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
    { name: "faz5-tools-meta", version: "1.0.0" },
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

async function butceCagir(c: any, yeni: number) {
  return (await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: KIMLIK, dailyBudget: yeni },
  })) as any;
}

/**
 * THE DESCRIPTION AS THE MODEL RECEIVES IT — read from `listTools`, not from the source file.
 * A source read would also pass on a description that never reaches registration.
 */
async function aciklama(c: any): Promise<string> {
  const { tools }: any = await c.listTools();
  const arac = tools.find((t: any) => t.name === "update_meta_campaign_budget");
  assert.ok(arac, "update_meta_campaign_budget artık kayıtlı değil — gözcü tazelensin");
  return String(arac.description ?? "");
}

/**
 * Sentence/clause segments of the description.
 *
 * Splitting on `.` alone would glue "ARTIŞ … ister (orta risk); azaltma onay istemez." into
 * ONE segment, and the condition demanded of the shortcut clause could then be satisfied by
 * a word belonging to the sentence next to it — the watcher would be judging a paragraph
 * while claiming to judge a clause. `;` and `:` are therefore boundaries too. Nothing is
 * DISCARDED here: every non-empty piece is kept, so the scan cannot go green by dropping
 * the very text it is supposed to read.
 */
function cumleler(s: string): string[] {
  return s
    .split(/(?<=[.;:])\s+/u)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/* ── THE TWO BEHAVIOURS THE DESCRIPTION IS JUDGED AGAINST ─────────────────────── */

test("ÖLÇÜM: kefil olunan kampanyada AZALTMA serbest — yazma var, istem yok", async () => {
  /**
   * The half the description already documented. Without it the assertions below could be
   * satisfied by a description that simply refuses everything, and the repository's
   * "spend-lowering is free" rule would be lost where it genuinely applies.
   */
  kanalKur({ dugumTuru: "kampanya" });
  const c = await sunucuKur();
  const r = await butceCagir(c, 100);

  assert.deepEqual(yazmalar, ["butceGuncelle:100"], "gerçek azaltma geçmeli");
  assert.equal(istemSayisi, 0, "azaltma kefil olunan düğümde onay istemez");
  assert.match(metin(r), /400 → 100/u, "aynı nesnenin iki sayısı bildirilebilir");
});

test("ÖLÇÜM: kefil olunmamış düğümde AZALTMA reddedilir — yazma yok, istem yok", async () => {
  kanalKur({ dugumTuru: "dogrulanmadi", dugumNotu: "objective alanı yanıtta yok" });
  const c = await sunucuKur();
  const r = await butceCagir(c, 100);

  assert.match(metin(r), /Reddedildi/u, "tanınmayan düğüme sayı yazılmaz");
  assert.deepEqual(yazmalar, [], "KRİTİK: hiçbir yazma yapılmamalı");
  assert.equal(istemSayisi, 0, "kapı insana sormadan ÖNCE kapanmalı");
});

/* ── THE SURFACE THE MODEL READS, TIED TO THOSE MEASUREMENTS ──────────────────── */

test("KRİTİK: araç AÇIKLAMASI azaltma kısayolunu KOŞULSUZ vaat edemez — ölçülen ret koşullu", async () => {
  /**
   * Measured first, asserted second: the same call is refused on an unvouched node, so a
   * description that hands the model an unconditional "azaltma onay istemez" is teaching it
   * a contract the gate does not honour. Each shortcut clause must carry the condition
   * IN ITSELF — the node has to have been observed to be a campaign.
   */
  kanalKur({ dugumTuru: "dogrulanmadi", dugumNotu: "objective alanı yanıtta yok" });
  const c = await sunucuKur();
  const r = await butceCagir(c, 100);
  assert.match(metin(r), /Reddedildi/u, "ön koşul: bu düğümde azaltma gerçekten reddediliyor");
  assert.deepEqual(yazmalar, [], "ön koşul: ret sırasında yazma olmamalı");

  const parcalar = cumleler(await aciklama(c));
  assert.ok(
    parcalar.length >= 5,
    `Ayrıştırıcı bayat: açıklama ${parcalar.length} parçaya bölündü. Bu gözcü parça başına ` +
      `hüküm veriyor; parçalar kaybolursa aşağıdaki iddialar hiçbir şey ölçmez.`
  );

  const kisayol = parcalar.filter((p) => /azaltma/iu.test(p) && /onay iste(?:n)?mez/iu.test(p));
  assert.ok(
    kisayol.length >= 1,
    "Açıklama azaltma kısayolundan hiç söz etmiyor: harcamayı AZALTAN işlemin serbest olduğu " +
      "modele söylenmeli (ölçüldü: kefil olunan kampanyada azaltma yazılıyor, onay istenmiyor)."
  );
  for (const p of kisayol) {
    assert.match(
      p,
      /düğüm|KAMPANYA ol/u,
      `KRİTİK: "${p}" azaltmayı KOŞULSUZ serbest ilan ediyor; oysa ölçüldü — düğümün kampanya ` +
        `olduğu gözlenmezse azaltma da reddediliyor. Kısayol cümlesi koşulunu kendi içinde taşımalı.`
    );
    assert.match(
      p,
      /doğrula|gözlen|kefil/u,
      `KRİTİK: "${p}" düğümden söz ediyor ama koşulun OKUMAYA dayandığını söylemiyor; kısayol ` +
        `ancak kanal düğümü kampanya olarak doğruladığında geçerli.`
    );
  }
});

test("KRİTİK: araç AÇIKLAMASI düğüm-kimliği reddini ADIYLA anıyor ve azaltmayı kapsadığını söylüyor", async () => {
  /**
   * The finding's core: the description named the ceiling as the only refusal. The refusal
   * measured above has to be findable in it — and it has to say the refusal reaches a
   * DECREASE, because that is the case a reader would otherwise assume is exempt.
   */
  kanalKur({ dugumTuru: undefined });
  const c = await sunucuKur();
  const r = await butceCagir(c, 100);
  assert.match(metin(r), /Reddedildi/u, "ön koşul: SESSİZ kanalda da azaltma reddediliyor");
  assert.equal(istemSayisi, 0, "ön koşul: ret insana sorulmadan önce geliyor");

  /**
   * The OTHER refusal, measured in the same run rather than assumed: without it the "at least
   * two refusals" assertion below would be vouching for a ceiling refusal this file never
   * observed — the thing a ring that observed nothing may not do.
   */
  kanalKur({ dugumTuru: "kampanya" });
  const tavanRet = await butceCagir(c, 900);
  assert.match(metin(tavanRet), /güvenlik tavanının/u, "ön koşul: tavan üstü değer reddediliyor");
  assert.deepEqual(yazmalar, [], "ön koşul: iki retten hiçbiri yazma yapmamalı");

  const parcalar = cumleler(await aciklama(c));
  const retler = parcalar.filter((p) => /reddedil/iu.test(p));
  assert.ok(
    retler.length >= 2,
    `Açıklamada yalnız ${retler.length} ret cümlesi var. Bu koşumda İKİ ret ÖLÇÜLDÜ (tavan üstü ` +
      `değer ve kefil olunmamış düğüm); biri yazılmazsa model 'tek ret sebebi tavandır' der.`
  );

  const kimlikRedleri = retler.filter((p) => /KAMPANYA ol|düğüm/u.test(p));
  assert.ok(
    kimlikRedleri.length >= 1,
    "KRİTİK: açıklama düğüm-kimliği reddinden hiç söz etmiyor — ölçüldü: kimliğin kampanya " +
      "olduğu gözlenmezse istek reddediliyor, ama modelin okuduğu yüzeyde bunun izi yok."
  );
  assert.ok(
    kimlikRedleri.some((p) => /azaltma|düşür/iu.test(p)),
    "KRİTİK: kimlik reddi anılıyor ama AZALTMAYI da kapsadığı söylenmiyor; azaltmanın her " +
      "zaman serbest olduğunu okuyan model bu reddi öngöremez."
  );
});
