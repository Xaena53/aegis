import { test } from "node:test";
import assert from "node:assert/strict";
import { enums } from "google-ads-api";
import { sahteContext, baglanti } from "./helpers/harness.js";

/**
 * Q4 — Resources. İstemcinin araç çağırmadan veri okumasını sağlar.
 * `.../limits` kaynağı denetimde bulunan boşluğu kapatır: kullanıcı hangi
 * kelepçelerle çalıştığını hiçbir yerden göremiyordu.
 */

const HESAPLI: Array<[RegExp, any[]]> = [
  [/FROM customer\b/, [{ customer: { descriptive_name: "Yönetici", manager: true } }]],
  [
    /FROM customer_client/,
    [{ customer_client: { id: 1466231519, descriptive_name: "Reklam Hesabı", manager: false } }],
  ],
];

async function oku(c: any, uri: string) {
  const res: any = await c.readResource({ uri });
  return { ham: res.contents[0].text, mime: res.contents[0].mimeType };
}

test("dört kaynak kayıtlı (2 sabit + 2 şablon)", async () => {
  const { ctx } = sahteContext();
  const c = await baglanti(ctx);

  const sabit: any = await c.listResources();
  assert.deepEqual(
    sabit.resources.map((r: any) => r.uri).sort(),
    ["adspilot://accounts", "adspilot://gaql-sema"]
  );

  const sablon: any = await c.listResourceTemplates();
  assert.deepEqual(
    sablon.resourceTemplates.map((t: any) => t.uriTemplate).sort(),
    ["adspilot://accounts/{customerId}/campaigns", "adspilot://accounts/{customerId}/limits"]
  );
  for (const r of [...sabit.resources, ...sablon.resourceTemplates]) {
    assert.ok(r.title && r.description, `${r.uri ?? r.uriTemplate} başlık/açıklama eksik`);
  }
});

test("adspilot://accounts alt hesapları düzleştirir ve MCC'yi işaretler", async () => {
  const { ctx } = sahteContext({ queries: HESAPLI });
  const c = await baglanti(ctx);
  const { ham, mime } = await oku(c, "adspilot://accounts");
  assert.equal(mime, "application/json");
  const veri = JSON.parse(ham);
  assert.equal(veri.toplam, 2);
  assert.match(veri.hesaplar.find((h: any) => h.id === "1234567890").tur, /yönetici/);
  assert.equal(veri.hesaplar.find((h: any) => h.id === "1466231519").tur, "reklam hesabı");
});

test("limits kaynağı kullanıcının GERÇEK kelepçelerini yansıtır", async () => {
  const { ctx } = sahteContext({ writeEnabled: false, maxDailyBudget: 42 });
  const c = await baglanti(ctx);
  const { ham } = await oku(c, "adspilot://accounts/1466231519/limits");
  const veri = JSON.parse(ham);
  assert.equal(veri.yazmaIzni, false, "context'ten okunmalı, sabit değer olmamalı");
  assert.equal(veri.gunlukButceTavani, 42);
  assert.ok(veri.kurallar.some((k: string) => /PAUSED/.test(k)));
  assert.ok(veri.kurallar.some((k: string) => /ajan kendi limitini değiştiremez/.test(k)));
});

test("campaigns kaynağı enum'ları ada çevirir ve micros'u böler", async () => {
  const { ctx, rec } = sahteContext({
    queries: [
      [
        /FROM campaign\b/,
        [
          {
            campaign: {
              id: 24120539226,
              name: "Kampanyam",
              status: enums.CampaignStatus.ENABLED,
              advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
            },
            campaign_budget: { amount_micros: 60_000_000 },
          },
        ],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const { ham } = await oku(c, "adspilot://accounts/1466231519/campaigns");
  const veri = JSON.parse(ham);
  assert.equal(veri.kampanyalar[0].durum, "ENABLED");
  assert.equal(veri.kampanyalar[0].kanal, "SEARCH");
  assert.equal(veri.kampanyalar[0].gunlukButce, 60);
  assert.match(rec.queries.at(-1)!, /LIMIT 200/, "sorgu sınırsız olmamalı");
  // Katalog kaynağı TARİH FİLTRESİ İÇERMEMELİ: istatistiği olmayan yeni
  // taslaklar listeden düşüyor ve ajan "kampanya oluşmadı" sanıyordu.
  assert.doesNotMatch(rec.queries.at(-1)!, /segments\.date/, "katalog dönemsel filtre kullanmamalı");
});

test("campaigns kaynağı URI'den gelen customerId'yi TEMİZLEYEREK kullanır", async () => {
  const { ctx, rec } = sahteContext({ queries: [[/FROM campaign\b/, []]] });
  const c = await baglanti(ctx);
  await oku(c, "adspilot://accounts/14662abc31519/campaigns");
  // URI serbest metindir; API'ye giden hesap kimliği yalnız rakamlardan oluşmalı
  assert.equal(rec.customerIds.at(-1), "1466231519");
});

test("gaql-sema ajanın alan uydurmasını engelleyecek bilgiyi taşır", async () => {
  const { ctx } = sahteContext();
  const c = await baglanti(ctx);
  const { ham, mime } = await oku(c, "adspilot://gaql-sema");
  assert.equal(mime, "text/markdown");
  assert.match(ham, /search_term_view/);
  assert.match(ham, /metrics\.cost_micros/);
  assert.match(ham, /micros/i, "para biriminin micros olduğu anlatılmalı");
  assert.match(ham, /TEK SATIR/, "çok satırlı sorgu tuzağı uyarısı bulunmalı");
  assert.match(ham, /yalnız okumadır/i, "GAQL ile yazma yapılamayacağı belirtilmeli");
});

test("kaynak okuma hiçbir yazma üretmez", async () => {
  const { ctx, rec } = sahteContext({ queries: HESAPLI });
  const c = await baglanti(ctx);
  for (const uri of [
    "adspilot://accounts",
    "adspilot://gaql-sema",
    "adspilot://accounts/1466231519/limits",
    "adspilot://accounts/1466231519/campaigns",
  ]) {
    await oku(c, uri);
  }
  assert.equal(rec.mutations.length, 0);
});

test("customerId şablon değişkeni için otomatik tamamlama çalışır", async () => {
  const { ctx } = sahteContext({ queries: HESAPLI });
  const c = await baglanti(ctx);
  const res: any = await c.complete({
    ref: { type: "ref/resource", uri: "adspilot://accounts/{customerId}/campaigns" },
    argument: { name: "customerId", value: "14" },
  });
  assert.deepEqual(res.completion.values, ["1466231519"], "MCC elenmiş, alt hesap önerilmiş olmalı");
});
