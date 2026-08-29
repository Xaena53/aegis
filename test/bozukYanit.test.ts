// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BOZUK CAMARA YANITI — "bilmiyorum" ile "temiz" asla aynı şey değildir.
 *
 * NEDEN VAR: zincirin en kritik ve TEK CANLI KOŞAN halkası (SIM Swap) fail-OPEN kaldı.
 * Gerçek kanalın uyarlayıcısı `res.swapped === true` diyordu; {"swapped":"true"} (string),
 * {} (alan yok), {"swapped":null}, {"swapped":1} gibi okunamayan her gövde bu kısayoldan
 * sessizce `false` çıkıyor, yani "SIM DEĞİŞMEMİŞ" sayılıyor ve HARCAMA GEÇİYORDU.
 * Halka 3/4/5/6 aynı tuzağı `typeof x === "boolean" ? x : undefined` deseniyle çoktan
 * kapatmıştı; fark fark edilmiş ama eski halka DÜZELTİLMEK yerine sapma BELGELENMİŞTİ.
 *
 * NEDEN MEVCUT TESTLER YAKALAMADI: hepsi sahte KANAL enjekte ediyor
 * (`__set*KanalForTests`), yani gövdeyi boolean'a çeviren asıl kodu ATLIYOR. Bu dosya iki
 * katmanı da sınar:
 *   1) UYARLAYICI katmanı — sahte bir SDK istemcisi (`__setNacIstemciFabrikasiForTests`)
 *      üzerinden ÜRETİMDEKİ kapanışlar koşar, bozuk gövde matrisi oradan geçer.
 *   2) ÇAĞIRAN katmanı — sahte kanal boolean olmayan bir değer döndürdüğünde kapının
 *      onu RET'e çevirdiği ayrıca kanıtlanır.
 * Hiçbir testte ağa çıkılmaz; SDK yalnız tip düzeyinde vardır.
 *
 * Merkezi iddia (her vaka için): okunamayan yanıt RET üretir, ret nedeni "ag-yanitsiz"
 * kalır (yanlış suçlamaya çevrilmez), onay istemi HİÇ gösterilmez ve ajanın confirm
 * iddiası bile bunu aşamaz.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { sahteContext } from "./helpers/harness.js";
import { onayAl } from "../src/approval.js";
import {
  agDogrula,
  AgAyar,
  AgIz,
  __setCagriYonlendirmeKanalForTests,
  __setCihazDegisimKanalForTests,
  __setErisimKanalForTests,
  __setKonumKanalForTests,
  __setNacIstemciFabrikasiForTests,
  __setSimSwapKanalForTests,
} from "../src/networkTrust.js";

const MUSTERI = "1234567890";
const KAMPANYA = "24120539226";
const TELEFON = "+905551112233";
const MASKELI = "+905*******33";

/** Zincirin ALTI halkasını da açan yapılandırma: her gerçek kanal gerçekten sorgulanır. */
const TAM_ZINCIR: AgAyar = {
  nacToken: "gercek-token",
  approverPhone: TELEFON,
  simSwapWindowHours: 72,
  reachCheck: true,
  devSwapCheck: true,
  callFwdCheck: true,
  expectedCountry: "TR",
};

/** Yalnız 1. halkayı açan yapılandırma (çağıran-katmanı testleri için). */
const YALNIZ_SIMSWAP: AgAyar = {
  nacToken: "gercek-token",
  approverPhone: TELEFON,
  simSwapWindowHours: 72,
};

/* ── sahte SDK istemcisi (ağa ÇIKILMAZ) ───────────────────────────────────────── */

interface Govdeler {
  simSwap?: unknown;
  reach?: unknown;
  roaming?: unknown;
  devSwap?: unknown;
  callFwd?: unknown;
}

/**
 * Sağlıklı varsayılanlar bilerek TEMİZ: bir halkanın bozuk gövdesi sınanırken diğer beşi
 * geçer, böylece reti üretenin gerçekten o halka olduğu görülür (zincir ilk rette durur).
 */
function sahteIstemci(g: Govdeler): any {
  const don = (v: unknown) => async () => v;
  return {
    simSwap: { check: don(g.simSwap ?? { swapped: false }) },
    deviceStatus: {
      retrieveReachabilityStatus: don(g.reach ?? { reachable: true }),
      checkRoaming: don(g.roaming ?? { roaming: false }),
    },
    deviceSwap: { check: don(g.devSwap ?? { swapped: false }) },
    callForwardingSignal: { retrieveUnconditionalCallForwarding: don(g.callFwd ?? { active: false }) },
  };
}

function istemciKur(g: Govdeler): void {
  __setNacIstemciFabrikasiForTests(async () => sahteIstemci(g) as any);
}

/** Onay kapısına elicitation yeteneği olan sahte sunucu; sorulan istemleri kaydeder. */
function istemKaydedenSunucu(sorulanlar: string[]): any {
  return {
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async (istek: any) => {
        sorulanlar.push(String(istek.message));
        return { action: "accept", content: { onay: true } };
      },
    },
  };
}

// Dikişlerin HEPSİ modül-global: biri sıfırlanmazsa sonraki teste sızar.
afterEach(() => {
  __setNacIstemciFabrikasiForTests(undefined);
  __setSimSwapKanalForTests(undefined);
  __setErisimKanalForTests(undefined);
  __setKonumKanalForTests(undefined);
  __setCihazDegisimKanalForTests(undefined);
  __setCagriYonlendirmeKanalForTests(undefined);
});

/* ── bozuk gövde matrisi ──────────────────────────────────────────────────────── */

/**
 * Hepsi `=== true` kısayolundan `false` çıkardı — yani "temiz" sayılırdı. Doğru cevap
 * yedisinde de aynı: "yanıt okunamadı" → kapalı arıza.
 */
const BOZUK_GOVDELER: ReadonlyArray<readonly [string, (alan: string) => unknown]> = [
  ["alan yok ({})", () => ({})],
  ['string "true"', (alan) => ({ [alan]: "true" })],
  ["null", (alan) => ({ [alan]: null })],
  ["sayi 1", (alan) => ({ [alan]: 1 })],
  ["ic ice yanlis tip", (alan) => ({ [alan]: { value: true } })],
  ["bos dizi", () => []],
  ["bos nesne dizisi", () => [{}]],
];

interface KanalTanimi {
  /** Halkanın adı (test başlığı için). */
  ad: string;
  /** Sahte istemcide bozulacak gövde. */
  govdeAnahtari: keyof Govdeler;
  /** CAMARA yanıtındaki boolean alan adı. */
  alan: string;
  /** Halkanın KENDİ iz alanı — ret başka halkadan gelirse test kızarsın. */
  izAlani: keyof AgIz;
  /** Halkaya ÖZGÜ ret ifadesi: karışan halka sessizce geçemesin. */
  retIsareti: RegExp;
}

const KANALLAR: readonly KanalTanimi[] = [
  {
    ad: "simSwap",
    govdeAnahtari: "simSwap",
    alan: "swapped",
    izAlani: "simSwap",
    retIsareti: /SIM Swap kontrolünden okunabilir yanıt alınamadı/,
  },
  {
    ad: "reachability",
    govdeAnahtari: "reach",
    alan: "reachable",
    izAlani: "reach",
    retIsareti: /cihaz erişilebilirlik kontrolünden okunabilir yanıt alınamadı/,
  },
  {
    ad: "roaming",
    govdeAnahtari: "roaming",
    alan: "roaming",
    izAlani: "loc",
    retIsareti: /konum kontrolünden okunabilir yanıt alınamadı/,
  },
  {
    ad: "deviceSwap",
    govdeAnahtari: "devSwap",
    alan: "swapped",
    izAlani: "devSwap",
    retIsareti: /cihaz değişimi kontrolünden okunabilir yanıt alınamadı/,
  },
  {
    ad: "callForwarding",
    govdeAnahtari: "callFwd",
    alan: "active",
    izAlani: "callFwd",
    retIsareti: /çağrı yönlendirme kontrolünden okunabilir yanıt alınamadı/,
  },
];

/* ── POZİTİF KONTROL: düzeneğin kendisi ret üretmiyor ─────────────────────────── */

test("pozitif kontrol: SAĞLIKLI gövdelerle altı halkanın hepsi GERÇEK sorguyla geçer", async () => {
  istemciKur({});
  const k = await agDogrula(TAM_ZINCIR, "high");
  assert.equal(k.engel, undefined, "sağlıklı gövde reddedilirse aşağıdaki retler düzenekten gelir");
  assert.equal(k.kanit.length, 5, "koşan her gerçek halka kendi kanıt satırını yazmalı");
  assert.equal(k.iz.simSwap, "gercek");
  assert.equal(k.iz.reach, "gercek");
  assert.equal(k.iz.loc, "gercek");
  assert.equal(k.iz.devSwap, "gercek");
  assert.equal(k.iz.callFwd, "gercek");
  assert.equal(k.iz.retNedeni, undefined);
  assert.equal(k.iz.maskeliNumara, MASKELI);
});

/* ── UYARLAYICI KATMANI: gerçek kapanışlar, bozuk gövde matrisi ───────────────── */

for (const kanal of KANALLAR) {
  for (const [vakaAdi, govdeYap] of BOZUK_GOVDELER) {
    test(`bozuk yanıt · ${kanal.ad} · ${vakaAdi}: RET — "temiz" SAYILMAZ`, async () => {
      istemciKur({ [kanal.govdeAnahtari]: govdeYap(kanal.alan) });

      const k = await agDogrula(TAM_ZINCIR, "high");
      assert.ok(k.engel, `${kanal.ad}: okunamayan yanıt fail-OPEN olamaz — harcama geçerdi`);
      assert.match(k.engel!, /ağ doğrulaması tamamlanamadı/, "ret, ağ kapısının reti olarak tanınmalı");
      assert.match(k.engel!, kanal.retIsareti, "reti üreten halka doğru adlandırılmalı");
      assert.equal(k.iz.retNedeni, "ag-yanitsiz", "bilinmeyen, bir suçlamaya (ör. sim-degisti) çevrilemez");
      assert.equal(k.iz[kanal.izAlani], "gercek", "sorgu gerçekten denendi: 'calismadi' değil");
      assert.equal(k.kanit.length, 0, "ret hâlinde önceki halkaların temiz kanıtı bile taşınmaz");
      assert.equal(k.iz.maskeliNumara, MASKELI);
      assert.doesNotMatch(k.engel!, /5551112233/, "tam numara ret metnine sızmamalı");

      // Onay kapısı uçtan uca: istem HİÇ gösterilmez, ajanın confirm iddiası da aşamaz.
      const sorulanlar: string[] = [];
      const sonuc = await onayAl(
        istemKaydedenSunucu(sorulanlar),
        {
          eylem: "kampanya yayına alınacak",
          satirlar: ["Günlük bütçe: 50"],
          risk: "high",
          agAyar: TAM_ZINCIR,
        },
        true
      );
      assert.equal(sonuc.onaylandi, false, "bozuk yanıt onaya dönüşemez");
      assert.equal(sonuc.kanal, "ag", "reti veren ağ kapısı olmalı");
      assert.match(sonuc.mesaj!, kanal.retIsareti);
      assert.equal(sorulanlar.length, 0, "onay istemi HİÇ gösterilmemeli");
    });
  }
}

test("bozuk yanıt · simSwap: MEDIUM katmanda da RET (1. halka her iki katmanda koşar)", async () => {
  istemciKur({ simSwap: { swapped: "true" } });
  const k = await agDogrula(TAM_ZINCIR, "medium");
  assert.ok(k.engel, "medium katmanda da fail-open olamaz");
  assert.match(k.engel!, /SIM Swap kontrolünden okunabilir yanıt alınamadı/);
  assert.equal(k.iz.retNedeni, "ag-yanitsiz");
  assert.equal(k.iz.simSwap, "gercek");
  assert.equal(k.iz.pencereSaat, 24, "medium katman penceresi 24 saate daralır");
  assert.equal(k.iz.reach, undefined, "sonraki halkalar medium'da hiç koşmaz");
});

test("bozuk yanıt · simSwap: GERÇEK boolean'lar hâlâ ayırt edilir (aşırı düzeltme yok)", async () => {
  istemciKur({ simSwap: { swapped: true } });
  const degisti = await agDogrula(TAM_ZINCIR, "high");
  assert.match(degisti.engel!, /AĞ DOĞRULAMASI BAŞARISIZ/, "gerçek true hâlâ SIM değişimi retidir");
  assert.equal(degisti.iz.retNedeni, "sim-degisti", "'ag-yanitsiz' gerçek saptamanın yerini almamalı");

  istemciKur({ simSwap: { swapped: false } });
  const temiz = await agDogrula(TAM_ZINCIR, "high");
  assert.equal(temiz.engel, undefined, "gerçek false hâlâ geçmeli — kapı kilitlenmiş olmaz");
  assert.match(temiz.kanit[0], /SIM değişimi yok/);
});

/* ── ÇAĞIRAN KATMANI: kanal boolean olmayan değer döndürürse ──────────────────── */

/** Uyarlayıcı atlansa bile kapı gevşemez: boolean olmayan her dönüş RET olmalı. */
const BOOLEAN_OLMAYANLAR: readonly unknown[] = [undefined, "true", null, 1, {}, [{}]];

test("çağıran katmanı · simSwap kanalı boolean dışında ne dönerse dönsün RET", async () => {
  for (const deger of BOOLEAN_OLMAYANLAR) {
    __setSimSwapKanalForTests({ verifySimSwap: async () => deger as any });
    const k = await agDogrula(YALNIZ_SIMSWAP, "high");
    assert.ok(k.engel, `kanal ${String(deger)} döndürdü ama kapı GEÇİRDİ — fail-open`);
    assert.match(k.engel!, /SIM Swap kontrolünden okunabilir yanıt alınamadı/);
    assert.equal(k.iz.retNedeni, "ag-yanitsiz");
    assert.equal(k.iz.simSwap, "gercek");
  }
});

test("çağıran katmanı · halka 3/5/6 kanalları boolean dışında ne dönerse dönsün RET", async () => {
  const temizSimSwap = () => __setSimSwapKanalForTests({ verifySimSwap: async () => false });
  for (const deger of BOOLEAN_OLMAYANLAR) {
    temizSimSwap();
    __setErisimKanalForTests({ cihazErisilebilirMi: async () => deger as any });
    const reach = await agDogrula({ ...YALNIZ_SIMSWAP, reachCheck: true }, "high");
    assert.ok(reach.engel, "erişilebilirlik halkası fail-open olamaz");
    assert.match(reach.engel!, /cihaz erişilebilirlik kontrolünden okunabilir yanıt alınamadı/);
    assert.equal(reach.iz.retNedeni, "ag-yanitsiz");
    __setErisimKanalForTests(undefined);

    temizSimSwap();
    __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => deger as any });
    const devSwap = await agDogrula({ ...YALNIZ_SIMSWAP, devSwapCheck: true }, "high");
    assert.ok(devSwap.engel, "cihaz değişimi halkası fail-open olamaz");
    assert.match(devSwap.engel!, /cihaz değişimi kontrolünden okunabilir yanıt alınamadı/);
    assert.equal(devSwap.iz.retNedeni, "ag-yanitsiz");
    __setCihazDegisimKanalForTests(undefined);

    temizSimSwap();
    __setCagriYonlendirmeKanalForTests({ kosulsuzYonlendirmeAcikMi: async () => deger as any });
    const callFwd = await agDogrula({ ...YALNIZ_SIMSWAP, callFwdCheck: true }, "high");
    assert.ok(callFwd.engel, "çağrı yönlendirme halkası fail-open olamaz");
    assert.match(callFwd.engel!, /çağrı yönlendirme kontrolünden okunabilir yanıt alınamadı/);
    assert.equal(callFwd.iz.retNedeni, "ag-yanitsiz");
    __setCagriYonlendirmeKanalForTests(undefined);
  }
});

test("çağıran katmanı · konum kanalı okunamaz roaming döndürürse RET (ülke listesi kurtarmaz)", async () => {
  __setSimSwapKanalForTests({ verifySimSwap: async () => false });
  for (const deger of BOOLEAN_OLMAYANLAR) {
    __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: deger as any, ulkeler: ["TR"] }) });
    const k = await agDogrula({ ...YALNIZ_SIMSWAP, expectedCountry: "TR" }, "high");
    assert.ok(k.engel, "konum halkası fail-open olamaz");
    assert.match(k.engel!, /konum kontrolünden okunabilir yanıt alınamadı/);
    assert.equal(k.iz.retNedeni, "ag-yanitsiz");
    assert.equal(k.iz.loc, "gercek");
  }
});

/* ── uçtan uca: MCP protokolü üzerinden hiçbir yazma gitmez ───────────────────── */

const YAYINA_HAZIR: Array<[RegExp, any[]]> = [
  [/campaign_budget\.amount_micros/, [{ campaign: { name: "Hazır" }, campaign_budget: { amount_micros: 50_000_000 } }]],
  [/FROM ad_group_ad/, [{ ad_group_ad: { ad: { id: 1 } } }]],
  [/FROM campaign_criterion/, []],
];

test("KRİTİK: string 'true' gövdesi yayına almayı reddeder — yazma yok, istem yok", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR });
  ctx.config.nacToken = "gercek-token";
  ctx.config.approverPhone = TELEFON;
  ctx.config.simSwapWindowHours = 72;
  istemciKur({ simSwap: { swapped: "true" } });

  const sorulanlar: string[] = [];
  const client = new Client({ name: "bozuk-yanit-testi", version: "0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (req: any) => {
    sorulanlar.push(String(req.params.message));
    return { action: "accept", content: { onay: true } };
  });
  const server = buildServer(() => ctx);
  const [ist, sun] = InMemoryTransport.createLinkedPair();
  await server.connect(sun);
  await client.connect(ist);

  const res: any = await client.callTool({
    name: "set_campaign_status",
    arguments: { customerId: MUSTERI, campaignId: KAMPANYA, status: "ENABLED", confirm: true },
  });
  const out = String(res.content?.[0]?.text ?? "");

  assert.match(out, /ağ doğrulaması tamamlanamadı/, "ajan reti ağ kapısının reti olarak görmeli");
  assert.match(out, /SIM Swap kontrolünden okunabilir yanıt alınamadı/);
  assert.equal(rec.mutations.length, 0, "okunamayan yanıtta hiçbir yazma gitmemeli");
  assert.equal(sorulanlar.length, 0, "onay istemi HİÇ gösterilmemeli");
});
