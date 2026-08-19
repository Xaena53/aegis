// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Network-verified approval (CAMARA SIM Swap via Nokia NaC).
 *
 * The central assertions: a recently swapped approver SIM refuses the action BEFORE any
 * human prompt is shown — on the elicitation path and the confirm fallback alike — and
 * an unreachable network API also refuses (fail closed). A clean signal must not block
 * anything, and its evidence must appear inside the human prompt.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { sahteContext, agKanaliniSifirla } from "./helpers/harness.js";
import { agDogrula, __setSimSwapKanalForTests } from "../src/networkTrust.js";

const MUSTERI = "1234567890";
const KAMPANYA = "24120539226";

// Safety net: the channel override is module-global state. Every test also resets in
// its own finally, but a future test written without one must not poison the file.
afterEach(() => agKanaliniSifirla());

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

test("ağ: yapılandırılan pencere 24'ten KÜÇÜKSE medium de onu kullanır (dar olan kazanır)", async () => {
  try {
    const pencereler: number[] = [];
    kanal(false, pencereler);
    const dar = { ...AYAR, simSwapWindowHours: 12 };
    await agDogrula(dar, "medium");
    await agDogrula(dar, "high");
    assert.deepEqual(pencereler, [12, 12]);
  } finally {
    agKanaliniSifirla();
  }
});

test("ağ: bozuk pencere değerleri CAMARA aralığına kelepçelenir (0.01 sızdırmaz, 5000 kalıcı reddetmez)", async () => {
  try {
    const pencereler: number[] = [];
    kanal(false, pencereler);
    // 0.01h would wave a 2-hour-old swap through; NaN/undefined must not reach the API;
    // 5000h would 400 on every call and turn into a permanent opaque refusal.
    await agDogrula({ ...AYAR, simSwapWindowHours: 0.01 }, "high");
    await agDogrula({ ...AYAR, simSwapWindowHours: Number.NaN }, "high");
    await agDogrula({ ...AYAR, simSwapWindowHours: undefined as any }, "high");
    await agDogrula({ ...AYAR, simSwapWindowHours: 5000 }, "high");
    assert.deepEqual(pencereler, [72, 72, 72, 2400]);
  } finally {
    agKanaliniSifirla();
  }
});

test("ağ: API hata mesajı ret metnine SIZMAZ (upstream gövde telefon numarası içerebilir)", async () => {
  try {
    __setSimSwapKanalForTests({
      verifySimSwap: async () => {
        // The NaC SDK inlines the full server response body into error.message,
        // and CAMARA 4xx bodies echo the phoneNumber verbatim.
        throw new Error('Status 400. Body: {"message":"invalid phoneNumber +905551112233"}');
      },
    });
    const k = await agDogrula(AYAR, "high");
    assert.ok(k.engel, "hata kapalı arızaya gitmeli");
    assert.doesNotMatch(k.engel!, /5551112233/, "tam numara ret metnine sızmamalı");
    assert.doesNotMatch(k.engel!, /Body:/, "upstream gövde ret metnine sızmamalı");
  } finally {
    agKanaliniSifirla();
  }
});

test("ağ: risk etiketi var ama agAyar YOKSA kapı fail-open olmaz — reddedilir", async () => {
  const { onayAl } = await import("../src/approval.js");
  const sonuc = await onayAl(
    { server: { getClientCapabilities: () => ({}) } } as any,
    { eylem: "test", satirlar: [], risk: "high" }, // agAyar deliberately missing
    true // even with the agent asserting consent
  );
  assert.equal(sonuc.onaylandi, false);
  assert.equal(sonuc.kanal, "ag");
  assert.match(sonuc.mesaj!, /agAyar eksik/);
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

test("bütçe ARTIŞI medium katmandan geçer (24 saat penceresi) — SIM değişmişse reddedilir", async () => {
  try {
    const butce: Array<[RegExp, any[]]> = [
      [/campaign_budget\.amount_micros/, [{ campaign: { name: "B" }, campaign_budget: { amount_micros: 10_000_000, resource_name: "customers/1/campaignBudgets/9" } }]],
    ];
    const pencereler: number[] = [];
    const { ctx, rec } = sahteContext({ queries: butce, agDurumu: "degisti", agPencereKaydi: pencereler });
    const { client } = await elicitationliIstemci(ctx);

    const out = await cagir(client, "update_campaign_budget", {
      customerId: MUSTERI,
      campaignId: KAMPANYA,
      newDailyBudget: 20,
    });

    assert.match(out, /AĞ DOĞRULAMASI BAŞARISIZ/);
    assert.equal(rec.mutations.length, 0);
    // Pins the tier end-to-end: swapping "medium" for "high" at the call site would
    // change this to 72 and nothing else any test observes.
    assert.deepEqual(pencereler, [24], "bütçe artışı MEDIUM katmandan (24s) geçmeli");
  } finally {
    agKanaliniSifirla();
  }
});

test("KRİTİK: CANLI kampanyaya kelime eklemek de ağ kapısından geçer — SIM değişmişse reddedilir", async () => {
  try {
    // liveCampaignGuard path: the campaign is ENABLED, so adding positive keywords
    // starts real spend immediately — the exact scenario the feature exists for.
    const canli: Array<[RegExp, any[]]> = [
      [/FROM ad_group/, [{ campaign: { id: 1, name: "Canlı", status: 2 }, ad_group: { status: 2 } }]],
    ];
    const pencereler: number[] = [];
    const { ctx, rec } = sahteContext({ queries: canli, agDurumu: "degisti", agPencereKaydi: pencereler });
    const { client, sorulanlar } = await elicitationliIstemci(ctx);

    const out = await cagir(client, "add_keywords", {
      customerId: MUSTERI,
      adGroupId: "555",
      keywords: ["acil satın al"],
      confirm: true,
    });

    assert.match(out, /AĞ DOĞRULAMASI BAŞARISIZ/);
    assert.equal(rec.mutations.length, 0, "hiçbir yazma gitmemeli");
    assert.equal(sorulanlar.length, 0, "onay istemi hiç gösterilmemeli");
    assert.deepEqual(pencereler, [72], "canlı kampanya değişikliği HIGH katmandan (72s) geçmeli");
  } finally {
    agKanaliniSifirla();
  }
});

test("yayına alma HIGH katmandan geçer (72 saat penceresi) — uçtan uca sabitlenir", async () => {
  try {
    const pencereler: number[] = [];
    const { ctx } = sahteContext({ queries: YAYINA_HAZIR, agDurumu: "temiz", agPencereKaydi: pencereler });
    const { client } = await elicitationliIstemci(ctx, "accept");

    await cagir(client, "set_campaign_status", {
      customerId: MUSTERI,
      campaignId: KAMPANYA,
      status: "ENABLED",
    });

    assert.deepEqual(pencereler, [72], "yayına alma HIGH katmandan (72s) geçmeli");
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
