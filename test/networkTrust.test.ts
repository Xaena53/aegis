// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Network-verified approval (CAMARA SIM Swap via Nokia NaC).
 *
 * The central assertions: a recently swapped approver SIM refuses the action BEFORE any
 * human prompt is shown — on the elicitation path and the confirm fallback alike — and
 * an unreachable network API also refuses (fail closed). A clean signal must not block
 * anything, and its evidence must appear inside the human prompt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { sahteContext, agKanaliniSifirla } from "./helpers/harness.js";
import { agDogrula, __setSimSwapKanalForTests } from "../src/networkTrust.js";

const MUSTERI = "1234567890";
const KAMPANYA = "24120539226";

const YAYINA_HAZIR: Array<[RegExp, any[]]> = [
  [/campaign_budget\.amount_micros/, [{ campaign: { name: "Hazır" }, campaign_budget: { amount_micros: 50_000_000 } }]],
  [/FROM ad_group_ad/, [{ ad_group_ad: { ad: { id: 1 } } }]],
  [/FROM campaign_criterion/, []],
];

/* ── unit: decision logic ─────────────────────────────────────────────────────── */

const AYAR = { nacToken: "t", approverPhone: "+905551112233", simSwapWindowHours: 72 };

function kanal(cevap: boolean | "hata", kayit?: number[]) {
  __setSimSwapKanalForTests({
    verifySimSwap: async (saat) => {
      kayit?.push(saat);
      if (cevap === "hata") throw new Error("sandbox unreachable");
      return cevap;
    },
  });
}

test("ağ: token yoksa kapı devre dışı — engel yok, durumu söyleyen kanıt satırı var", async () => {
  const k = await agDogrula({ simSwapWindowHours: 72 }, "high");
  assert.equal(k.engel, undefined);
  assert.match(k.kanit[0], /kapalı/);
});

test("ağ: token var ama onaylayıcı numarası yoksa KAPALI ARIZA", async () => {
  const k = await agDogrula({ nacToken: "t", simSwapWindowHours: 72 }, "high");
  assert.match(k.engel!, /ADSPILOT_APPROVER_PHONE/);
});

test("ağ: SIM değişmişse REDDET ve numarayı maskele", async () => {
  try {
    kanal(true);
    const k = await agDogrula(AYAR, "high");
    assert.match(k.engel!, /SIM/);
    assert.match(k.engel!, /\+905\*+33/, "tam numara sızmamalı");
    assert.doesNotMatch(k.engel!, /5551112233/, "tam numara sızmamalı");
  } finally {
    agKanaliniSifirla();
  }
});

test("ağ: temiz sinyalde engel yok, kanıt satırı pencereyi söylüyor", async () => {
  try {
    kanal(false);
    const k = await agDogrula(AYAR, "high");
    assert.equal(k.engel, undefined);
    assert.match(k.kanit[0], /72 saat/);
  } finally {
    agKanaliniSifirla();
  }
});

test("ağ: API hatasında KAPALI ARIZA — cevap alınamıyorsa harcama yok", async () => {
  try {
    kanal("hata");
    const k = await agDogrula(AYAR, "high");
    assert.match(k.engel!, /tamamlanamadı/);
  } finally {
    agKanaliniSifirla();
  }
});

test("ağ: risk katmanı pencereyi belirler — medium 24 saat, high yapılandırılan pencere", async () => {
  try {
    const pencereler: number[] = [];
    kanal(false, pencereler);
    await agDogrula(AYAR, "medium");
    await agDogrula(AYAR, "high");
    assert.deepEqual(pencereler, [24, 72]);
  } finally {
    agKanaliniSifirla();
  }
});

/* ── integration: through the real MCP protocol ───────────────────────────────── */

type Karar = "accept" | "decline";

async function elicitationliIstemci(ctx: any, karar: Karar = "accept") {
  const sorulanlar: string[] = [];
  const client = new Client({ name: "ag-testi", version: "0" }, { capabilities: { elicitation: {} } });
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

test("KRİTİK: SIM değişmişse yayına alma İNSANA SORULMADAN reddedilir", async () => {
  try {
    const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agDurumu: "degisti" });
    const { client, sorulanlar } = await elicitationliIstemci(ctx);

    const out = await cagir(client, "set_campaign_status", {
      customerId: MUSTERI,
      campaignId: KAMPANYA,
      status: "ENABLED",
      confirm: true,
    });

    assert.match(out, /AĞ DOĞRULAMASI BAŞARISIZ/);
    assert.equal(rec.mutations.length, 0, "hiçbir yazma gitmemeli");
    assert.equal(sorulanlar.length, 0, "onay istemi HİÇ gösterilmemeli — cevaplayan saldırgan olabilir");
  } finally {
    agKanaliniSifirla();
  }
});

test("KRİTİK: SIM değişmişse confirm=true fallback yolu da reddeder (elicitation'sız istemci)", async () => {
  try {
    const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agDurumu: "degisti" });
    const client = new Client({ name: "eski-istemci", version: "0" }); // no elicitation capability
    const server = buildServer(() => ctx);
    const [ist, sun] = InMemoryTransport.createLinkedPair();
    await server.connect(sun);
    await client.connect(ist);

    const out = await cagir(client, "set_campaign_status", {
      customerId: MUSTERI,
      campaignId: KAMPANYA,
      status: "ENABLED",
      confirm: true, // a stolen session asserting consent
    });

    assert.match(out, /AĞ DOĞRULAMASI BAŞARISIZ/);
    assert.equal(rec.mutations.length, 0);
  } finally {
    agKanaliniSifirla();
  }
});

test("temiz sinyalde akış bozulmaz ve İNSAN KANITI GÖRÜR", async () => {
  try {
    const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agDurumu: "temiz" });
    const { client, sorulanlar } = await elicitationliIstemci(ctx, "accept");

    const out = await cagir(client, "set_campaign_status", {
      customerId: MUSTERI,
      campaignId: KAMPANYA,
      status: "ENABLED",
    });

    assert.match(out, /YAYINDA/);
    assert.equal(rec.mutations.length, 1, "temiz sinyal + insan onayı → işlem gitmeli");
    assert.match(sorulanlar[0], /SIM değişimi yok/, "ağ kanıtı onay istemine eklenmeli");
  } finally {
    agKanaliniSifirla();
  }
});

test("ağ API'si çökerse yayına alma reddedilir (kapalı arıza, uçtan uca)", async () => {
  try {
    const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agDurumu: "hata" });
    const { client, sorulanlar } = await elicitationliIstemci(ctx);

    const out = await cagir(client, "set_campaign_status", {
      customerId: MUSTERI,
      campaignId: KAMPANYA,
      status: "ENABLED",
    });

    assert.match(out, /tamamlanamadı/);
    assert.equal(rec.mutations.length, 0);
    assert.equal(sorulanlar.length, 0);
  } finally {
    agKanaliniSifirla();
  }
});

test("bütçe ARTIŞI medium katmandan geçer — SIM değişmişse reddedilir", async () => {
  try {
    const butce: Array<[RegExp, any[]]> = [
      [/campaign_budget\.amount_micros/, [{ campaign: { name: "B" }, campaign_budget: { amount_micros: 10_000_000, resource_name: "customers/1/campaignBudgets/9" } }]],
    ];
    const { ctx, rec } = sahteContext({ queries: butce, agDurumu: "degisti" });
    const { client } = await elicitationliIstemci(ctx);

    const out = await cagir(client, "update_campaign_budget", {
      customerId: MUSTERI,
      campaignId: KAMPANYA,
      newDailyBudget: 20,
    });

    assert.match(out, /AĞ DOĞRULAMASI BAŞARISIZ/);
    assert.equal(rec.mutations.length, 0);
  } finally {
    agKanaliniSifirla();
  }
});

test("network verification kapalıyken (token yok) mevcut davranış birebir korunur", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR }); // no agDurumu → no token
  const { client, sorulanlar } = await elicitationliIstemci(ctx, "accept");

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
  });

  assert.match(out, /YAYINDA/);
  assert.equal(rec.mutations.length, 1);
  assert.match(sorulanlar[0], /Ağ doğrulaması: kapalı/, "kapalı olduğu dürüstçe gösterilmeli");
});
