import { test } from "node:test";
import assert from "node:assert/strict";
import { enums } from "google-ads-api";
import { sahteContext, baglanti } from "./helpers/harness.js";

/**
 * Resources: data a client can read without spending a tool call.
 *
 * The limits resource is the guardrail report — it must reflect the caller's live
 * settings, never hard-coded defaults, and must stay read-only.
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
  assert.equal(veri.gosterilen, 2);
  assert.equal(veri.tamListeMi, true, "her şey okunduysa liste TAM ilan edilmeli");
  assert.match(veri.hesaplar.find((h: any) => h.id === "1234567890").tur, /yönetici/);
  assert.equal(veri.hesaplar.find((h: any) => h.id === "1466231519").tur, "reklam hesabı");
  assert.equal(veri.toplam, undefined, "kesin sayı iddiası taşıyan 'toplam' alanı kalkmalı");
});

test("KRİTİK: kaynak okunamayan hesabı GİZLEMEZ, liste EKSİK ilan edilir", async () => {
  /**
   * Aynı sunucunun list_accounts aracı bu hesap için "ERİŞİLEMEDİ" derken kaynak onu
   * hiç yokmuş gibi gösteriyor ve kalan tek hesabı "toplam: 1" diye kesin sayı olarak
   * sunuyordu. Ajan bunu "kullanıcının tek hesabı var" diye okur ve aranan hesap için
   * "öyle bir hesabınız yok" der.
   */
  const { ctx } = sahteContext({
    hesaplar: ["5346956094", "1466231519"],
    okunamayanHesaplar: ["5346956094"],
    queries: [[/FROM customer\b/, [{ customer: { descriptive_name: "Reklam Hesabı", manager: false } }]]],
  });
  const c = await baglanti(ctx);
  const veri = JSON.parse((await oku(c, "adspilot://accounts")).ham);

  const okunamayan = veri.hesaplar.find((h: any) => h.id === "5346956094");
  assert.ok(okunamayan, "okunamayan hesap listeden düşmemeli");
  assert.equal(okunamayan.erisilemedi, true);
  assert.match(okunamayan.tur, /bilinmiyor/, "yöneticiliği bilinmiyorken 'reklam hesabı' denemez");
  assert.equal(veri.tamListeMi, false, "eksik liste TAM diye sunulamaz");
  assert.match(veri.not, /LİSTE EKSİK/);
  assert.match(veri.not, /okunamadı/);
});

test("KRİTİK: kırpılmış alt hesap listesi kaynakta EKSİK olarak duyurulur", async () => {
  /**
   * 101 alt hesaplı MCC'de kaynak "toplam 101" diyordu; kullanıcının aradığı hesap
   * listede olmadığında ajan "böyle bir hesabınız yok" sonucuna varıyordu.
   */
  const cocuklar = Array.from({ length: 102 }, (_, i) => ({
    customer_client: { id: 2000000000 + i, descriptive_name: `Alt ${i}`, manager: false },
  }));
  const { ctx } = sahteContext({
    queries: [
      [/FROM customer\b/, [{ customer: { descriptive_name: "Büyük MCC", manager: true } }]],
      [/FROM customer_client/, cocuklar],
    ],
  });
  const c = await baglanti(ctx);
  const veri = JSON.parse((await oku(c, "adspilot://accounts")).ham);
  assert.equal(veri.tamListeMi, false, "kırpma da bir eksikliktir");
  assert.match(veri.not, /kırpıldı/);
  assert.match(veri.not, /1234567890/, "hangi MCC'nin listesi kesildiği yazmalı");
});

test("limits kaynağı kullanıcının GERÇEK kelepçelerini yansıtır", async () => {
  const { ctx } = sahteContext({
    writeEnabled: false,
    maxDailyBudget: 42,
    // Kelepçe raporu artık hesabın okunabildiğini KANITLAMADAN yayınlanmıyor.
    queries: [[/FROM customer\b/, [{ customer: { id: 1466231519 } }]]],
  });
  const c = await baglanti(ctx);
  const { ham } = await oku(c, "adspilot://accounts/1466231519/limits");
  const veri = JSON.parse(ham);
  assert.equal(veri.yazmaIzni, false, "context'ten okunmalı, sabit değer olmamalı");
  assert.equal(veri.gunlukButceTavani, 42);
  assert.ok(veri.kurallar.some((k: string) => /PAUSED/.test(k)));
  assert.ok(veri.kurallar.some((k: string) => /ajan kendi limitini değiştiremez/.test(k)));
});

test("KRİTİK: limits kaynağı 10 haneli olmayan kimliği REDDEDER", async () => {
  /**
   * Şablon gelen metni hiç sormadan geri yazıyordu: 'bu-hesap-yok' ile gerçek bir hesap
   * AYNI gövdeyi alıyordu. /guvenlik-durumu istemi ajana "tahmin etme, kaynağa bak"
   * derken kaynak, var olmayan bir hesap için yazma izni ve tavan beyan ediyordu.
   */
  const { ctx, rec } = sahteContext({ queries: [[/FROM customer\b/, [{ customer: { id: 1 } }]]] });
  const c = await baglanti(ctx);
  for (const kotu of ["bu-hesap-yok", "123", "146623151900"]) {
    await assert.rejects(
      () => oku(c, `adspilot://accounts/${kotu}/limits`),
      /10 hanelidir/,
      `'${kotu}' kelepçe raporu üretmemeli`
    );
  }
  assert.equal(rec.queries.length, 0, "biçim reddi API'ye hiç çıkmamalı");
});

test("KRİTİK: erişimi doğrulanamayan hesap için kelepçe alanları HİÇ yazılmaz", async () => {
  /**
   * Bilinmeyen = RET. Hesap okunamıyorsa "yazmaIzni" ve "gunlukButceTavani" alanlarını
   * yazmak, ajanın o hesap üzerinde yazma yetkisi olduğunu sanmasına yol açar.
   */
  const { ctx } = sahteContext({ okunamayanHesaplar: ["1466231519"] });
  const c = await baglanti(ctx);
  await assert.rejects(() => oku(c, "adspilot://accounts/1466231519/limits"), (e: any) => {
    const m = String(e?.message ?? "");
    assert.doesNotMatch(m, /yazmaIzni|gunlukButceTavani/, "ret metninde bile kelepçe beyanı olmamalı");
    return /okunamadı|erişim|izin|permission/i.test(m);
  });

  // Sorgusu patlamayan ama satır DÖNDÜRMEYEN hesap da "bilinmiyor"dur, "temiz" değil.
  const { ctx: bos } = sahteContext({ queries: [[/FROM customer\b/, []]] });
  const c2 = await baglanti(bos);
  await assert.rejects(() => oku(c2, "adspilot://accounts/1466231519/limits"), /doğrulanamadı/);
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
  // The catalog must not carry a date filter: fresh drafts have no stats yet, so they
  // would drop out of the list and the agent would conclude the campaign was never created.
  assert.doesNotMatch(rec.queries.at(-1)!, /segments\.date/, "katalog dönemsel filtre kullanmamalı");
});

test("campaigns kaynağı URI'den gelen customerId'yi TEMİZLEYEREK kullanır", async () => {
  const { ctx, rec } = sahteContext({ queries: [[/FROM campaign\b/, []]] });
  const c = await baglanti(ctx);
  await oku(c, "adspilot://accounts/14662abc31519/campaigns");
  // The URI is free text; the customer id that reaches the API must be digits only
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

test("kaynak tamamlaması API hatasında sessizce boş döner (kullanıcıyı bloklamaz)", async () => {
  /**
   * prompts.test.ts'teki bekçinin kaynak tarafındaki eşi. Tamamlama yolu yalnız sağlıklı
   * bağlamda test edildiğinde, catch bloğu kaldırılsa bile hiçbir test kızarmıyordu:
   * tamamlama artık boş dizi yerine PROTOKOL HATASI döndürürdü ve istemci arayüzü
   * kullanıcıya hata basardı.
   */
  const ctx: any = {
    config: { writeEnabled: true, maxDailyBudget: 500 },
    listAccessibleCustomers: async () => {
      throw new Error("kimlik yok");
    },
    tumHesaplar: async () => {
      throw new Error("kimlik yok");
    },
    queryWithRetry: async () => [],
    mutateWithRetry: async (fn: any) => fn(),
    getCustomer: () => ({}),
  };
  const c = await baglanti(ctx);
  for (const uri of ["adspilot://accounts/{customerId}/campaigns", "adspilot://accounts/{customerId}/limits"]) {
    const res: any = await c.complete({
      ref: { type: "ref/resource", uri },
      argument: { name: "customerId", value: "1" },
    });
    assert.deepEqual(res.completion.values, [], `${uri} tamamlaması hata fırlatmamalı`);
  }
});

test("KRİTİK: tamamlama detayı OKUNAMAYAN hesabı önermez", async () => {
  /**
   * Okunamayan hesabın yönetici olup olmadığı BİLİNMİYOR. Öneri listesine koymak,
   * ajanı her çağrısı USER_PERMISSION_DENIED ile dönecek bir hesaba yönlendirir —
   * "bilinmiyor" ile "kullanılabilir" aynı şey değildir.
   */
  const { ctx } = sahteContext({
    hesaplar: ["5346956094", "1466231519"],
    okunamayanHesaplar: ["5346956094"],
    queries: [[/FROM customer\b/, [{ customer: { descriptive_name: "Reklam Hesabı", manager: false } }]]],
  });
  const c = await baglanti(ctx);
  const res: any = await c.complete({
    ref: { type: "ref/resource", uri: "adspilot://accounts/{customerId}/campaigns" },
    argument: { name: "customerId", value: "" },
  });
  assert.deepEqual(res.completion.values, ["1466231519"], "yalnız okunabilen reklam hesabı önerilmeli");
});

test("kampanyalar kaynağı: okunamayan günlük bütçe 0 diye KATALOGA GİRMEZ", async () => {
  /**
   * Kaynak `Number(amount_micros ?? 0) / 1e6` yazıyordu: bütçesi okunamayan YAYINDAKİ bir
   * kampanya kataloğa "gunlukButce: 0" diye giriyor, /kampanya-denetle ajanı bunu
   * "bütçesiz kalmış" diye okuyor ve hesap toplamlarını eksik çıkarıyordu. Aynı sözleşme
   * write.ts'te para hareketini durduruyor; okuma yüzeyinde de bilinmiyor ≠ 0.
   */
  const { ctx } = sahteContext({
    queries: [
      [
        /FROM campaign/,
        [
          {
            campaign: {
              id: 7,
              name: "Bütçesi Okunamayan",
              status: enums.CampaignStatus.ENABLED,
              advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
            },
            campaign_budget: { amount_micros: null },
          },
          {
            campaign: {
              id: 8,
              name: "Alanı Hiç Gelmeyen",
              status: enums.CampaignStatus.PAUSED,
              advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
            },
          },
          {
            campaign: {
              id: 9,
              name: "Sağlam",
              status: enums.CampaignStatus.ENABLED,
              advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
            },
            campaign_budget: { amount_micros: 50_000_000 },
          },
        ],
      ],
    ],
  });
  const c = await baglanti(ctx);
  const veri = JSON.parse((await oku(c, "adspilot://accounts/1234567890/campaigns")).ham);
  const [bosDeger, alanYok, saglam] = veri.kampanyalar;

  for (const k of [bosDeger, alanYok]) {
    assert.equal(k.gunlukButce, undefined, "okunamayan bütçe JSON'a hiç yazılmamalı");
    assert.equal(k.butceOkunamadi, true, "okur bilinmediğini görebilmeli");
  }
  assert.equal(saglam.gunlukButce, 50, "okunabilen bütçe eskisi gibi yazılır");
  assert.equal(saglam.butceOkunamadi, undefined, "sağlam satıra gereksiz bayrak konmaz");
  assert.doesNotMatch(
    JSON.stringify(veri.kampanyalar.slice(0, 2)),
    /"gunlukButce": ?0/,
    "sıfır bütçe iddiası kataloga giremez"
  );
});
