// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SIM-Swap SİMÜLASYON kanalı (AEGIS_NAC_SIMULATE) — jüri demosu NaC token'sız çalışır.
 *
 * Merkezi iddialar: simülasyonun ürettiği HER metin "SİMÜLASYON" ibaresi taşır (gerçek ağ
 * doğrulaması gibi sunulamaz); "degisti" insan istemi HİÇ gösterilmeden SERT reddeder;
 * geçersiz değer sunucuyu düşürmez ama karar anında Türkçe hatayla kapalı arızaya gider;
 * onaylayıcı numarası simülasyonda da zorunludur ve her yerde maskeli görünür; gerçek
 * token'la birlikte tanımlandığında simülasyon kazanır ama operatör stderr'den uyarılır.
 *
 * Fail-closed değişmezi: bu dosyadaki hiçbir senaryo gerçek akıştan daha gevşek değildir.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { sahteContext, agKanaliniSifirla } from "./helpers/harness.js";
import { agDogrula } from "../src/networkTrust.js";

const MUSTERI = "1234567890";
const KAMPANYA = "24120539226";
const TELEFON = "+905551112233";

// nacToken YOK: simülasyonun token'sız çalışması bu dosyanın varlık sebebi.
const SIM_AYAR = { approverPhone: TELEFON, simSwapWindowHours: 72 };

// Safety net (aynı gerekçe networkTrust.test.ts'teki gibi): kanal override modül-global.
afterEach(() => agKanaliniSifirla());

const YAYINA_HAZIR: Array<[RegExp, any[]]> = [
  [/campaign_budget\.amount_micros/, [{ campaign: { name: "Hazır" }, campaign_budget: { amount_micros: 50_000_000 } }]],
  [/FROM ad_group_ad/, [{ ad_group_ad: { ad: { id: 1 } } }]],
  [/FROM campaign_criterion/, []],
];

/* ── unit: simüle karar mantığı ───────────────────────────────────────────────── */

test("sim: 'temiz' token'sız GEÇER — kanıt satırı SİMÜLASYON ibareli ve numara maskeli", async () => {
  const k = await agDogrula({ ...SIM_AYAR, nacSimulate: "temiz" }, "high");
  assert.equal(k.engel, undefined);
  assert.match(k.kanit[0], /SİMÜLASYON/, "her simüle metin SİMÜLASYON ibaresi taşımalı");
  assert.match(k.kanit[0], /gerçek ağ sorgusu YAPILMADI/, "gerçek doğrulama gibi sunulamaz");
  assert.match(k.kanit[0], /72 saat/);
  assert.match(k.kanit[0], /\+905\*+33/, "maskeleme gerçek akışla birebir çalışmalı");
  assert.doesNotMatch(k.kanit[0], /5551112233/, "tam numara sızmamalı");
});

test("sim: 'degisti' SERT RET — ret metni SİMÜLASYON ibareli, numara maskeli", async () => {
  const k = await agDogrula({ ...SIM_AYAR, nacSimulate: "degisti" }, "high");
  assert.match(k.engel!, /SİMÜLASYON/);
  assert.match(k.engel!, /AĞ DOĞRULAMASI BAŞARISIZ/);
  assert.match(k.engel!, /gerçek ağ sorgusu YAPILMADI/);
  assert.match(k.engel!, /\+905\*+33/);
  assert.doesNotMatch(k.engel!, /5551112233/, "tam numara ret metnine sızmamalı");
});

test("sim: geçersiz değer karar anında Türkçe RET (kapalı arıza — sunucu başlangıçta düşmez)", async () => {
  const k = await agDogrula({ ...SIM_AYAR, nacSimulate: "belki" }, "high");
  assert.ok(k.engel, "tanınmayan değer fail-open olamaz");
  assert.match(k.engel!, /SİMÜLASYON/);
  assert.match(k.engel!, /tanınmadı/);
  assert.match(k.engel!, /"temiz" \| "degisti"/, "geçerli değerler operatöre söylenmeli");
  assert.doesNotMatch(k.engel!, /belki/, "ham env değeri (sır olabilir) ret metnine yankılanmaz");
  assert.equal(k.kanit.length, 0);
});

test("sim: approverPhone yoksa simülasyonda da KAPALI ARIZA (nacToken gerekmez, telefon şart)", async () => {
  const k = await agDogrula({ simSwapWindowHours: 72, nacSimulate: "temiz" }, "high");
  assert.match(k.engel!, /AEGIS_APPROVER_PHONE/);
  assert.match(k.engel!, /SİMÜLASYON/);
});

test("sim: nacToken VE simülasyon birlikte → çelişkili yapılandırma SERT RET (fail-closed)", async () => {
  /**
   * Belirsizlikte gevşek kanal seçilmez: demodan kalan bir AEGIS_NAC_SIMULATE
   * kalıntısı, gerçek token'lı bir kurulumun ağ doğrulamasını sessizce tiyatroya
   * çeviremez — iki dünya aynı anda istenirse cevap RET'tir.
   */
  const k = await agDogrula({ ...SIM_AYAR, nacToken: "gercek-token", nacSimulate: "temiz" }, "high");
  assert.ok(k.engel, "çelişkili yapılandırma fail-open olamaz");
  assert.match(k.engel!, /SİMÜLASYON/);
  assert.match(k.engel!, /çelişkili yapılandırma/);
  assert.match(k.engel!, /AEGIS_NAC_TOKEN/);
  assert.equal(k.kanit.length, 0);
});

test("sim: pencere metinleri katmanı söyler — medium 24 saat, high yapılandırılan, dar olan kazanır", async () => {
  const m = await agDogrula({ ...SIM_AYAR, nacSimulate: "temiz" }, "medium");
  assert.match(m.kanit[0], /24 saat/, "medium simülasyonda da 24 saatlik pencereyi göstermeli");
  const h = await agDogrula({ ...SIM_AYAR, nacSimulate: "temiz" }, "high");
  assert.match(h.kanit[0], /72 saat/, "high yapılandırılan pencereyi göstermeli");
  const dar = await agDogrula({ ...SIM_AYAR, simSwapWindowHours: 12, nacSimulate: "degisti" }, "medium");
  assert.match(dar.engel!, /12 saat/, "yapılandırılan 24'ten darsa medium onu kullanmalı");
});

test("sim: iz 'simulasyon' der — simüle karar gerçek sorgu gibi izlenemez", async () => {
  const temiz = await agDogrula({ ...SIM_AYAR, nacSimulate: "temiz" }, "high");
  assert.deepEqual(temiz.iz, { simSwap: "simulasyon", pencereSaat: 72, maskeliNumara: "+905*******33" });

  const degisti = await agDogrula({ ...SIM_AYAR, nacSimulate: "degisti" }, "medium");
  assert.equal(degisti.iz.simSwap, "simulasyon");
  assert.equal(degisti.iz.pencereSaat, 24, "iz, kararın verildiği pencereyi taşır");
  assert.equal(degisti.iz.retNedeni, "sim-degisti");
});

test("sim: yapılandırma hatalarında iz 'calismadi' + sabit kod, pencere/numara YAZILMAZ", async () => {
  const celiski = await agDogrula({ ...SIM_AYAR, nacToken: "gercek-token", nacSimulate: "temiz" }, "high");
  assert.deepEqual(celiski.iz, { simSwap: "calismadi", retNedeni: "yapilandirma-celiskili", retNedenleri: ["yapilandirma-celiskili"] });

  const tanimsiz = await agDogrula({ ...SIM_AYAR, nacSimulate: "belki" }, "high");
  assert.deepEqual(tanimsiz.iz, { simSwap: "calismadi", retNedeni: "simulasyon-degeri-tanimsiz", retNedenleri: ["simulasyon-degeri-tanimsiz"] });

  const numarasiz = await agDogrula({ simSwapWindowHours: 72, nacSimulate: "temiz" }, "high");
  assert.deepEqual(numarasiz.iz, { simSwap: "calismadi", retNedeni: "onaylayici-numarasi-yok", retNedenleri: ["onaylayici-numarasi-yok"] });
});

/* ── integration: gerçek MCP protokolü üzerinden, token'sız ve SDK'sız ────────── */

async function elicitationliIstemci(ctx: any, karar: "accept" | "decline" = "accept") {
  const sorulanlar: string[] = [];
  const client = new Client({ name: "sim-testi", version: "0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (req: any) => {
    sorulanlar.push(String(req.params.message));
    return karar === "accept" ? { action: "accept", content: { onay: true } } : { action: "decline" };
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

test("KRİTİK sim: 'degisti' yayına almayı İNSANA SORULMADAN reddeder — token'sız uçtan uca", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agSimulasyon: "degisti" });
  const { client, sorulanlar } = await elicitationliIstemci(ctx);

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true, // ajanın onay iddiası simülasyon retini de aşamamalı
  });

  assert.match(out, /SİMÜLASYON/, "ajanın gördüğü ret açıkça simülasyon olmalı");
  assert.match(out, /AĞ DOĞRULAMASI BAŞARISIZ/);
  assert.equal(rec.mutations.length, 0, "hiçbir yazma gitmemeli");
  assert.equal(sorulanlar.length, 0, "onay istemi HİÇ gösterilmemeli");
});

test("sim: 'temiz' akışı bozmaz — insan SİMÜLASYON ibareli kanıtı görür, işlem gider", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agSimulasyon: "temiz" });
  const { client, sorulanlar } = await elicitationliIstemci(ctx, "accept");

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
  });

  assert.match(out, /YAYINDA/);
  assert.equal(rec.mutations.length, 1, "temiz simülasyon + insan onayı → işlem gitmeli");
  assert.match(sorulanlar[0], /SİMÜLASYON/, "insan, kanıtın simüle olduğunu görmeli");
  assert.match(sorulanlar[0], /SIM değişimi yok/);
});
