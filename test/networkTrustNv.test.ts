// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Number Verification SİMÜLASYON kanalı (AEGIS_NV_SIMULATE) — güven zincirinin 2. halkası.
 *
 * SIM Swap "hat son zamanlarda ele geçirildi mi?" sorusunu cevaplar; bu halka bir sonrakini:
 * "onay isteği hat sahibinin KENDİ cihazından mı geliyor?". Gerçek CAMARA Number Verification
 * cihaz-taraflı OIDC akışı istediği ve sunucudan tek başına çağrılamadığı için burada YALNIZ
 * simülasyon vardır — bu dosya, o dürüstlüğün (her metin "SİMÜLASYON" ibareli, "gerçek sorgu
 * YAPILMADI") kod tarafından korunduğunu sabitler.
 *
 * Merkezi iddialar: "uyusmadi" SIM temizken bile insan istemi HİÇ gösterilmeden SERT reddeder;
 * halka YALNIZ high katmanda koşar (medium'da hiç yok); tanınmayan değer kapalı arızaya gider
 * ve ham değeri yankılamaz; zincir sırası tek yönlüdür — SIM reti NV "dogrulandi" ile
 * yumuşatılamaz; halka AEGIS_NAC_SIMULATE'ten bağımsızdır ve gerçek SIM-Swap kanalıyla da
 * birleşir.
 *
 * Fail-closed değişmezi: buradaki hiçbir senaryo mevcut kapıyı gevşetmez.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { sahteContext, agKanaliniSifirla } from "./helpers/harness.js";
import { agDogrula, __setSimSwapKanalForTests } from "../src/networkTrust.js";
import { onayAl } from "../src/approval.js";

const MUSTERI = "1234567890";
const KAMPANYA = "24120539226";
const TELEFON = "+905551112233";

/**
 * Bilerek ne nacToken ne nacSimulate: NV halkasının SIM-Swap katmanından BAĞIMSIZ
 * çalıştığını (kapalı SIM-Swap katmanının üstünde bile koştuğunu) testin kendisi kanıtlar.
 */
const NV_AYAR = { approverPhone: TELEFON, simSwapWindowHours: 72 };

// Safety net: kanal override modül-global; testler kendi finally'siyle de temizler.
afterEach(() => agKanaliniSifirla());

const YAYINA_HAZIR: Array<[RegExp, any[]]> = [
  [/campaign_budget\.amount_micros/, [{ campaign: { name: "Hazır" }, campaign_budget: { amount_micros: 50_000_000 } }]],
  [/FROM ad_group_ad/, [{ ad_group_ad: { ad: { id: 1 } } }]],
  [/FROM campaign_criterion/, []],
];

/* ── unit: 2. halkanın karar mantığı ──────────────────────────────────────────── */

test("nv: 'dogrulandi' kanıt satırı ekler — SİMÜLASYON ibareli, maskeli, SIM katmanından bağımsız", async () => {
  const k = await agDogrula({ ...NV_AYAR, nvSimulate: "dogrulandi" }, "high");
  assert.equal(k.engel, undefined);
  // 1. halka kapalı (token yok) → kendi dürüst satırını yazar; 2. halka onun ÜSTÜNE eklenir.
  assert.equal(k.kanit.length, 2, "NV halkası SIM-Swap kapalıyken de koşmalı");
  assert.match(k.kanit[0], /Ağ doğrulaması: kapalı/);
  assert.match(k.kanit[1], /Numara doğrulaması/);
  assert.match(k.kanit[1], /SİMÜLASYON/, "her simüle metin SİMÜLASYON ibaresi taşımalı");
  assert.match(k.kanit[1], /YAPILMADI/, "gerçek NV sorgusu gibi sunulamaz");
  assert.match(k.kanit[1], /cihaz-taraflı OIDC/, "sınırın kendisi kanıt satırında yazmalı");
  assert.match(k.kanit[1], /\+905\*+33/, "numara maskeli görünmeli");
  assert.doesNotMatch(k.kanit[1], /5551112233/, "tam numara sızmamalı");
});

test("nv: 'uyusmadi' SERT RET — SIM temiz olsa bile onay isteği sahibin cihazından gelmiyor SAYILIR", async () => {
  const k = await agDogrula({ ...NV_AYAR, nacSimulate: "temiz", nvSimulate: "uyusmadi" }, "high");
  assert.ok(k.engel, "2. halka fail-open olamaz");
  assert.match(k.engel!, /SİMÜLASYON/);
  assert.match(k.engel!, /NUMARA DOĞRULAMASI BAŞARISIZ/);
  assert.match(k.engel!, /gerçek cihazından gelmiyor SAYILDI/);
  assert.match(k.engel!, /gerçek ağ sorgusu YAPILMADI/);
  assert.match(k.engel!, /\+905\*+33/);
  assert.doesNotMatch(k.engel!, /5551112233/, "tam numara ret metnine sızmamalı");
  assert.equal(k.kanit.length, 0, "ret hâlinde temiz SIM kanıtı bile taşınmaz");
});

test("nv: halka YALNIZ high katmanda koşar — medium'da (bütçe artışı) hiç devreye girmez", async () => {
  const m = await agDogrula({ ...NV_AYAR, nacSimulate: "temiz", nvSimulate: "uyusmadi" }, "medium");
  assert.equal(m.engel, undefined, "medium'da 2. halka koşmadığı için reddedemez");
  assert.equal(m.kanit.length, 1, "medium'da yalnız SIM-Swap kanıtı olmalı");
  assert.doesNotMatch(m.kanit[0], /Numara doğrulaması/);
  // Aynı katmanda bozuk bir değer de karar üretmez: halka orada YOK, gevşemiş değil.
  const bozuk = await agDogrula({ ...NV_AYAR, nvSimulate: "her ne ise" }, "medium");
  assert.equal(bozuk.engel, undefined);
  // Kontrol: aynı yapılandırma high'a çıkınca halka koşar ve reddeder.
  const h = await agDogrula({ ...NV_AYAR, nacSimulate: "temiz", nvSimulate: "uyusmadi" }, "high");
  assert.match(h.engel!, /NUMARA DOĞRULAMASI BAŞARISIZ/);
});

test("nv: tanınmayan değer karar anında RET — ham değer (sır olabilir) metne YANKILANMAZ", async () => {
  const k = await agDogrula({ ...NV_AYAR, nvSimulate: "sanirim-oldu" }, "high");
  assert.ok(k.engel, "tanınmayan değer fail-open olamaz");
  assert.match(k.engel!, /SİMÜLASYON/);
  assert.match(k.engel!, /AEGIS_NV_SIMULATE/);
  assert.match(k.engel!, /tanınmadı/);
  assert.match(k.engel!, /"dogrulandi" \| "uyusmadi"/, "geçerli değerler operatöre söylenmeli");
  assert.doesNotMatch(k.engel!, /sanirim-oldu/, "ham env değeri ret metnine yankılanmaz");
  assert.equal(k.kanit.length, 0);
});

test("nv: approverPhone yoksa 2. halka da KAPALI ARIZA (doğrulanacak numara olmadan çalışmaz)", async () => {
  const k = await agDogrula({ simSwapWindowHours: 72, nvSimulate: "dogrulandi" }, "high");
  assert.ok(k.engel);
  assert.match(k.engel!, /SİMÜLASYON/);
  assert.match(k.engel!, /AEGIS_APPROVER_PHONE/);
  assert.equal(k.kanit.length, 0);
});

test("nv: ZİNCİR SIRASI — SIM 'degisti' + NV 'dogrulandi' → yine SIM reti (2. halka yumuşatamaz)", async () => {
  const k = await agDogrula({ ...NV_AYAR, nacSimulate: "degisti", nvSimulate: "dogrulandi" }, "high");
  assert.ok(k.engel);
  assert.match(k.engel!, /SIM kartı son 72 saat içinde değişmiş SAYILDI/, "karar 1. halkanın olmalı");
  assert.doesNotMatch(k.engel!, /Numara doğrulaması/, "2. halka kararı ezemez veya sulandıramaz");
  assert.equal(k.kanit.length, 0, "temiz NV kanıtı bir SIM retinin yanına ASLA eklenmez");
});

test("nv: gerçek SIM-Swap kanalıyla birleşir — çelişki kuralı yalnız NAC token + NAC_SIMULATE ikilisi içindir", async () => {
  try {
    const pencereler: number[] = [];
    __setSimSwapKanalForTests({
      verifySimSwap: async (saat) => {
        pencereler.push(saat);
        return false; // gerçek kanal: SIM temiz
      },
    });
    const k = await agDogrula({ ...NV_AYAR, nacToken: "gercek-token", nvSimulate: "dogrulandi" }, "high");
    assert.equal(k.engel, undefined, "gerçek token + NV simülasyonu çelişki SAYILMAZ");
    assert.deepEqual(pencereler, [72], "gerçek SIM-Swap sorgusu gerçekten yapılmalı");
    assert.equal(k.kanit.length, 2);
    assert.match(k.kanit[0], /GSMA Open Gateway/, "1. halka kanıtı gerçek sorgudan gelmeli");
    assert.doesNotMatch(k.kanit[0], /SİMÜLASYON/, "gerçek halka simüle gibi etiketlenmemeli");
    assert.match(k.kanit[1], /Numara doğrulaması \[SİMÜLASYON\]/, "2. halka dürüstçe simüle etiketli");
  } finally {
    agKanaliniSifirla();
  }
});

/* ── yapısal denetim izi: iki halka AYRI alanlarda ────────────────────────────── */

test("iz: SIM-Swap kapalı + NV simülasyonu → iki halka ayrı alanlarda, tek boolean'a ezilmez", async () => {
  const k = await agDogrula({ ...NV_AYAR, nvSimulate: "dogrulandi" }, "high");
  assert.equal(k.iz.simSwap, "kapali", "1. halka kapalı olduğunu kendi alanında söyler");
  assert.equal(k.iz.nv, "simulasyon", "2. halka 1. halkanın kapalılığını gizleyemez");
  // Numara YALNIZ NV halkasında değerlendirildi; hiçbir pencere sorgulanmadı.
  assert.equal(k.iz.pencereSaat, undefined);
  assert.equal(k.iz.maskeliNumara, "+905*******33");
  assert.equal(k.iz.retNedeni, undefined);
});

test("iz: GERÇEK SIM-Swap sorgusu + NV simülasyonu → 'gercek' ile 'simulasyon' bir arada durur", async () => {
  try {
    __setSimSwapKanalForTests({ verifySimSwap: async () => false });
    const k = await agDogrula({ ...NV_AYAR, nacToken: "gercek-token", nvSimulate: "dogrulandi" }, "high");
    assert.equal(k.iz.simSwap, "gercek", "gerçek sorgu, simüle halka yüzünden simülasyona indirgenemez");
    assert.equal(k.iz.nv, "simulasyon");
    assert.equal(k.iz.pencereSaat, 72, "pencere yalnız gerçekten sorgulanan katmanındır");
  } finally {
    agKanaliniSifirla();
  }
});

test("iz: NV reti sabit sözlükten 'nv-uyusmadi' üretir (SIM halkası temiz ve simüle kalır)", async () => {
  const k = await agDogrula({ ...NV_AYAR, nacSimulate: "temiz", nvSimulate: "uyusmadi" }, "high");
  assert.equal(k.iz.retNedeni, "nv-uyusmadi", "hangi halkanın reddettiği izden okunmalı");
  assert.equal(k.iz.simSwap, "simulasyon");
  assert.equal(k.iz.nv, "simulasyon");
});

test("iz: halka koşmadıysa nv alanı HİÇ yoktur; SIM reti 2. halkayı zaten çalıştırmaz", async () => {
  const m = await agDogrula({ ...NV_AYAR, nacSimulate: "temiz", nvSimulate: "uyusmadi" }, "medium");
  assert.equal(m.iz.nv, undefined, "medium katmanda 2. halka yoktur");

  const simReti = await agDogrula({ ...NV_AYAR, nacSimulate: "degisti", nvSimulate: "dogrulandi" }, "high");
  assert.equal(simReti.iz.retNedeni, "sim-degisti", "karar 1. halkanın");
  assert.equal(simReti.iz.nv, undefined, "1. halka reddettiyse 2. halka hiç koşmaz — iz de öyle der");
});

test("iz: NV yapılandırma hatasında nv 'calismadi' olur ve sabit kodunu taşır", async () => {
  const tanimsiz = await agDogrula({ ...NV_AYAR, nvSimulate: "sanirim-oldu" }, "high");
  assert.equal(tanimsiz.iz.nv, "calismadi");
  assert.equal(tanimsiz.iz.retNedeni, "simulasyon-degeri-tanimsiz");

  const numarasiz = await agDogrula({ simSwapWindowHours: 72, nvSimulate: "dogrulandi" }, "high");
  assert.equal(numarasiz.iz.nv, "calismadi");
  assert.equal(numarasiz.iz.retNedeni, "onaylayici-numarasi-yok");
  assert.equal(numarasiz.iz.maskeliNumara, undefined);
});

/* ── integration: onay kapısı ve gerçek MCP protokolü üzerinden ───────────────── */

/** Onay kapısına elicitation yeteneği olan sahte bir sunucu; sorulan istemleri kaydeder. */
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

test("KRİTİK nv: 'uyusmadi' onay kapısında İSTEM GÖSTERİLMEDEN reddeder (approval.ts uçtan uca)", async () => {
  const sorulanlar: string[] = [];
  const sonuc = await onayAl(
    istemKaydedenSunucu(sorulanlar),
    {
      eylem: "kampanya yayına alınacak",
      satirlar: ["Günlük bütçe: 50"],
      risk: "high",
      agAyar: { ...NV_AYAR, nacSimulate: "temiz", nvSimulate: "uyusmadi" },
    },
    true // ajanın onay iddiası 2. halkanın retini de aşamamalı
  );
  assert.equal(sonuc.onaylandi, false);
  assert.equal(sonuc.kanal, "ag");
  assert.match(sonuc.mesaj!, /NUMARA DOĞRULAMASI BAŞARISIZ/);
  assert.equal(sorulanlar.length, 0, "onay istemi HİÇ gösterilmemeli — cevaplayan hattın sahibi olmayabilir");

  // Pozitif kontrol: tek fark NV değeri olduğunda istem gerçekten gösteriliyor.
  const kontrol: string[] = [];
  const gecen = await onayAl(
    istemKaydedenSunucu(kontrol),
    {
      eylem: "kampanya yayına alınacak",
      satirlar: ["Günlük bütçe: 50"],
      risk: "high",
      agAyar: { ...NV_AYAR, nacSimulate: "temiz", nvSimulate: "dogrulandi" },
    },
    undefined
  );
  assert.equal(gecen.onaylandi, true);
  assert.equal(kontrol.length, 1, "reti üreten şey istemin bastırılması değil, NV kararı olmalı");
  assert.match(kontrol[0], /Numara doğrulaması \[SİMÜLASYON\]/, "insan 2. halkanın kanıtını görmeli");
});

async function elicitationliIstemci(ctx: any) {
  const sorulanlar: string[] = [];
  const client = new Client({ name: "nv-testi", version: "0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (req: any) => {
    sorulanlar.push(String(req.params.message));
    return { action: "accept", content: { onay: true } };
  });
  const server = buildServer(() => ctx);
  const [ist, sun] = InMemoryTransport.createLinkedPair();
  await server.connect(sun);
  await client.connect(ist);
  return { client, sorulanlar };
}

async function cagir(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const res: any = await client.callTool({ name, arguments: args });
  return String(res.content?.[0]?.text ?? "");
}

test("KRİTİK nv: 'uyusmadi' yayına almayı reddeder — MCP protokolü üzerinden, hiçbir yazma gitmez", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agSimulasyon: "temiz" });
  ctx.config.nvSimulate = "uyusmadi";
  const { client, sorulanlar } = await elicitationliIstemci(ctx);

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true,
  });

  assert.match(out, /SİMÜLASYON/, "ajanın gördüğü ret açıkça simülasyon olmalı");
  assert.match(out, /NUMARA DOĞRULAMASI BAŞARISIZ/);
  assert.equal(rec.mutations.length, 0, "hiçbir yazma gitmemeli");
  assert.equal(sorulanlar.length, 0, "onay istemi HİÇ gösterilmemeli");
});

test("nv: 'dogrulandi' akışı bozmaz — insan zincirin İKİ kanıtını da görür, işlem gider", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agSimulasyon: "temiz" });
  ctx.config.nvSimulate = "dogrulandi";
  const { client, sorulanlar } = await elicitationliIstemci(ctx);

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
  });

  assert.match(out, /YAYINDA/);
  assert.equal(rec.mutations.length, 1, "temiz zincir + insan onayı → işlem gitmeli");
  assert.match(sorulanlar[0], /SIM değişimi yok/, "1. halka kanıtı istemde olmalı");
  assert.match(sorulanlar[0], /Numara doğrulaması/, "2. halka kanıtı istemde olmalı");
  assert.match(sorulanlar[0], /YAPILMADI/, "her iki kanıt da gerçek sorgu yapılmadığını söylemeli");
});
