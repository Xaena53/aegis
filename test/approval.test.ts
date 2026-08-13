import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { sahteContext } from "./helpers/harness.js";

/**
 * Human-in-the-loop approval.
 *
 * The central assertion: with an elicitation-capable client, a human decline must
 * override the agent — even when the agent sends confirm: true. Consent has to be
 * something the server observes, not something the agent claims.
 */

const MUSTERI = "1234567890";
const KAMPANYA = "24120539226";

const YAYINA_HAZIR: Array<[RegExp, any[]]> = [
  [/campaign_budget\.amount_micros/, [{ campaign: { name: "Hazır" }, campaign_budget: { amount_micros: 50_000_000 } }]],
  [/FROM ad_group_ad/, [{ ad_group_ad: { ad: { id: 1 } } }]],
  [/FROM campaign_criterion/, []],
];

type InsanKarari = "accept" | "decline" | "cancel" | "hata";

/** A client that advertises the elicitation capability and plays back a human decision. */
async function elicitationliIstemci(ctx: any, karar: InsanKarari, onayDegeri = true) {
  const sorulanlar: string[] = [];
  const client = new Client(
    { name: "elicitation-testi", version: "0" },
    { capabilities: { elicitation: {} } }
  );

  client.setRequestHandler(ElicitRequestSchema, async (req: any) => {
    sorulanlar.push(String(req.params.message));
    if (karar === "hata") throw new Error("istemci onay penceresini açamadı");
    if (karar === "accept") return { action: "accept", content: { onay: onayDegeri } };
    return { action: karar };
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

test("KRİTİK: insan REDDEDERSE ajan confirm=true göndermiş olsa bile yayına ALINMAZ", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR });
  const { client, sorulanlar } = await elicitationliIstemci(ctx, "decline");

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true, // the agent is fabricating consent
  });

  assert.match(out, /İşlem yapılmadı/);
  assert.match(out, /reddetti/);
  assert.equal(rec.mutations.length, 0, "insan reddettiyse HİÇBİR yazma gitmemeli");
  assert.equal(sorulanlar.length, 1, "insana gerçekten sorulmuş olmalı");
  assert.match(sorulanlar[0], /YAYINA ALINACAK/);
  assert.match(sorulanlar[0], /Günlük bütçe: 50/, "karar için özet gösterilmeli");
});

test("insan İPTAL ederse de işlem yapılmaz", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR });
  const { client } = await elicitationliIstemci(ctx, "cancel");
  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true,
  });
  assert.match(out, /iptal etti/);
  assert.equal(rec.mutations.length, 0);
});

test("insan 'onay: false' derse işlem yapılmaz", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR });
  const { client } = await elicitationliIstemci(ctx, "accept", false);
  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true,
  });
  assert.match(out, /İşlem yapılmadı/);
  assert.equal(rec.mutations.length, 0);
});

test("onay penceresi AÇILAMAZSA kapalı arıza: işlem yapılmaz", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR });
  const { client } = await elicitationliIstemci(ctx, "hata");
  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true,
  });
  assert.match(out, /onayı alınamadı/);
  assert.equal(rec.mutations.length, 0, "onay alınamadıysa güvenli tarafa düşülmeli");
});

test("insan ONAYLARSA ajan confirm GÖNDERMESE BİLE yayına alınır", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR });
  const { client, sorulanlar } = await elicitationliIstemci(ctx, "accept");
  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    // no confirm — human approval on its own is enough
  });
  assert.match(out, /YAYINDA/);
  assert.equal(rec.mutations.filter((m) => m.kind === "campaigns").length, 1);
  assert.equal(sorulanlar.length, 1);
});

test("bütçe ARTIŞINDA insana sorulur ve reddi bağlayıcıdır", async () => {
  const butce: Array<[RegExp, any[]]> = [
    [
      /campaign_budget\.explicitly_shared/,
      [{ campaign: { name: "K" }, campaign_budget: { resource_name: "r", amount_micros: 50_000_000, explicitly_shared: false } }],
    ],
  ];
  const { ctx, rec } = sahteContext({ queries: butce });
  const { client, sorulanlar } = await elicitationliIstemci(ctx, "decline");
  const out = await cagir(client, "update_campaign_budget", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    newDailyBudget: 400,
    confirm: true,
  });
  assert.match(out, /İşlem yapılmadı/);
  assert.equal(rec.mutations.length, 0);
  assert.match(sorulanlar[0], /Mevcut: 50 → Yeni: 400/, "artış insana gösterilmeli");
  assert.match(sorulanlar[0], /\+350/, "artış miktarı açıkça yazılmalı");
});

test("CANLI kampanyaya reklam eklemede insan onayı bağlayıcıdır", async () => {
  const canli: Array<[RegExp, any[]]> = [
    [/FROM ad_group\b/, [{ campaign: { id: 1, name: "Canlı", status: 2 /* ENABLED */ } }]],
  ];
  const { ctx, rec } = sahteContext({ queries: canli });
  const { client, sorulanlar } = await elicitationliIstemci(ctx, "decline");
  const out = await cagir(client, "create_responsive_search_ad", {
    customerId: MUSTERI,
    adGroupId: "200057393038",
    finalUrl: "https://ornek.com",
    headlines: ["Bir", "Iki", "Uc"],
    descriptions: ["Aciklama bir", "Aciklama iki"],
    confirm: true,
  });
  assert.match(out, /İşlem yapılmadı/);
  assert.equal(rec.mutations.length, 0);
  assert.match(sorulanlar[0], /ornek\.com/, "hangi sayfaya reklam verileceği gösterilmeli");
});

test("PAUSED kampanyada insana HİÇ sorulmaz (taslak akışı akıcı kalmalı)", async () => {
  const paused: Array<[RegExp, any[]]> = [
    [/FROM ad_group\b/, [{ campaign: { id: 1, name: "Taslak", status: 3 /* PAUSED */ } }]],
  ];
  const { ctx, rec } = sahteContext({ queries: paused });
  const { client, sorulanlar } = await elicitationliIstemci(ctx, "decline");
  const out = await cagir(client, "create_responsive_search_ad", {
    customerId: MUSTERI,
    adGroupId: "200057393038",
    finalUrl: "https://ornek.com",
    headlines: ["Bir", "Iki", "Uc"],
    descriptions: ["Aciklama bir", "Aciklama iki"],
  });
  assert.match(out, /RSA oluşturuldu/);
  assert.equal(sorulanlar.length, 0, "taslağa reklam eklemek onay istememeli");
  assert.equal(rec.mutations.length, 1);
});
