// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AdsContext — hesap keşfi ve önbellek davranışı.
 *
 * Buradaki mantık sessizce yanlış olabilir ve yanlışlığı ajanın ağzından kullanıcıya
 * "hesabınız yok" diye çıkar. Üç davranış özellikle önemli:
 *
 *   1) MCC alt hesapları listeye GİRMELİ — kampanyalar orada yaşar; üst düzey hesap
 *      listesi tek başına çoğu kullanıcı için boştur.
 *   2) Eşzamanlı istekler TEK hasat paylaşmalı — tamamlama her tuş vuruşunda çağrılır
 *      ve paylaşılmayan bir hasat, Google kotasını tuş başına bir tur harcar.
 *   3) EKSİK sonuç önbelleğe ALINMAMALI — geçici bir hata önbelleğe girerse, API
 *      düzeldikten sonra da TTL boyunca yanlış cevap servis edilir.
 *
 * Dal kapsamı bu dosyadan önce %61, fonksiyon kapsamı %50 idi.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AdsContext } from "../src/adsClient.js";

const AYAR = {
  developerToken: "t",
  clientId: "c",
  clientSecret: "s",
  refreshToken: "r",
  writeEnabled: true,
  maxDailyBudget: 500,
  simSwapWindowHours: 72,
  reachCheck: false,
  devSwapCheck: false,
  callFwdCheck: false,
} as any;

interface SahteHesap {
  id: string;
  ad: string;
  yonetici: boolean;
  cocuklar?: Array<{ id: string; ad: string; yonetici?: boolean }>;
  /** Bu hesap sorgulanınca hata fırlatsın mı? */
  patlasin?: boolean;
}

/** Sorgu sayacı taşıyan bir AdsContext üretir; gerçek API'ye hiç dokunulmaz. */
function baglam(hesaplar: SahteHesap[]) {
  const sayac = { hasat: 0, sorgu: 0 };
  const ctx = new AdsContext(AYAR);

  (ctx as any).api = {
    async listAccessibleCustomers() {
      sayac.hasat += 1;
      return { resource_names: hesaplar.map((h) => `customers/${h.id}`) };
    },
    Customer({ customer_id }: { customer_id: string }) {
      return {
        async query(q: string) {
          sayac.sorgu += 1;
          const h = hesaplar.find((x) => x.id === customer_id);
          if (!h) return [];
          if (h.patlasin) throw new Error("hesap okunamadı");
          if (q.includes("FROM customer_client")) {
            return (h.cocuklar ?? []).map((c) => ({
              customer_client: { id: c.id, descriptive_name: c.ad, manager: c.yonetici ?? false },
            }));
          }
          return [{ customer: { descriptive_name: h.ad, manager: h.yonetici } }];
        },
      };
    },
  };
  return { ctx, sayac };
}

/* ── müşteri kimliği kapısı ───────────────────────────────────────────────────── */

test("10 haneli olmayan müşteri ID'si reddedilir ve çıkış yolu gösterilir", () => {
  const { ctx } = baglam([]);
  assert.throws(() => ctx.getCustomer("123"), /10 hanelidir/);
  assert.throws(() => ctx.getCustomer("123"), /list_accounts/, "kullanıcıya ne yapacağı söylenmeli");
  assert.throws(() => ctx.getCustomer(""), /Geçersiz müşteri ID/);
});

test("tire ve boşluklu ID normalize edilir (kapı bir duvar değil)", () => {
  const { ctx } = baglam([]);
  assert.doesNotThrow(() => ctx.getCustomer("123-456-7890"));
  assert.doesNotThrow(() => ctx.getCustomer(" 1234567890 "));
});

/* ── hesap keşfi ──────────────────────────────────────────────────────────────── */

test("KRİTİK: MCC alt hesapları listeye girer — kampanyalar orada yaşar", () => {
  return (async () => {
    const { ctx } = baglam([
      {
        id: "1111111111",
        ad: "Ajans MCC",
        yonetici: true,
        cocuklar: [
          { id: "2222222222", ad: "Müşteri A" },
          { id: "3333333333", ad: "Müşteri B" },
        ],
      },
    ]);
    const liste = await ctx.tumHesaplar();
    assert.deepEqual(
      liste.map((h) => h.id).sort(),
      ["1111111111", "2222222222", "3333333333"],
      "yalnız üst hesabı döndürmek çoğu kullanıcı için boş liste demektir"
    );
    assert.equal(liste.find((h) => h.id === "1111111111")?.yonetici, true);
    assert.equal(liste.find((h) => h.id === "2222222222")?.yonetici, false);
  })();
});

test("yönetici olmayan hesap için alt hesap sorgusu yapılmaz", async () => {
  const { ctx, sayac } = baglam([{ id: "1111111111", ad: "Tek hesap", yonetici: false }]);
  await ctx.tumHesaplar();
  assert.equal(sayac.sorgu, 1, "gereksiz ikinci sorgu kotayı boşa harcar");
});

test("aynı hesap iki yoldan görünse de listeye BİR kez girer", async () => {
  /**
   * Bir hesap hem üst düzeyde erişilebilir hem de bir MCC'nin çocuğu olabilir. Tekrar,
   * kullanıcıya aynı hesabı iki kez gösterir ve hangisini seçeceğini belirsizleştirir.
   */
  const { ctx } = baglam([
    { id: "1111111111", ad: "MCC", yonetici: true, cocuklar: [{ id: "2222222222", ad: "A" }] },
    { id: "2222222222", ad: "A", yonetici: false },
  ]);
  const liste = await ctx.tumHesaplar();
  assert.equal(liste.filter((h) => h.id === "2222222222").length, 1);
});

test("KRİTİK: aynı hesap İKİ MCC'nin altındaysa da bir kez görünür", async () => {
  /**
   * Bu vaka mutasyonla ortaya çıktı: üstteki test yalnız ÜST DÜZEY tekrar elemesini
   * zorluyordu, çünkü çocuk listeye girmeden önce üst düzey kontrolü devreye giriyordu.
   * Çocuk döngüsündeki eleme kapatıldığında hiçbir test kızarmıyordu.
   *
   * Gerçek hayatta olağan bir kurulum: bir reklam hesabı hem ajansın hem müşterinin
   * MCC'sine bağlıdır. Tekrar, kullanıcıya aynı hesabı iki kez gösterir.
   */
  const { ctx } = baglam([
    { id: "1111111111", ad: "Ajans MCC", yonetici: true, cocuklar: [{ id: "3333333333", ad: "Ortak" }] },
    { id: "2222222222", ad: "Müşteri MCC", yonetici: true, cocuklar: [{ id: "3333333333", ad: "Ortak" }] },
  ]);
  const liste = await ctx.tumHesaplar();
  assert.equal(
    liste.filter((h) => h.id === "3333333333").length,
    1,
    "iki farklı MCC'nin çocuğu olan hesap listeye bir kez girmeli"
  );
  assert.equal(liste.length, 3, "iki MCC + bir ortak hesap");
});

test("isimsiz hesap listeden düşmez, '(isimsiz)' olarak görünür", async () => {
  const { ctx } = baglam([{ id: "1111111111", ad: undefined as any, yonetici: false }]);
  const liste = await ctx.tumHesaplar();
  assert.equal(liste[0].ad, "(isimsiz)", "adı okunamayan hesap gizlenmemeli");
});

/* ── önbellek davranışı ───────────────────────────────────────────────────────── */

test("ikinci çağrı önbellekten gelir — her tamamlama bir API turu değildir", async () => {
  const { ctx, sayac } = baglam([{ id: "1111111111", ad: "A", yonetici: false }]);
  await ctx.tumHesaplar();
  await ctx.tumHesaplar();
  assert.equal(sayac.hasat, 1, "TTL içindeki ikinci çağrı yeniden hasat etmemeli");
});

test("KRİTİK: eşzamanlı çağrılar TEK hasat paylaşır", async () => {
  /**
   * Tamamlama her tuş vuruşunda çağrılır. Uçuştaki istek paylaşılmazsa, "1466…" yazan
   * bir kullanıcı dört ayrı hasat başlatır ve paylaşılan Google kotası tuş başına
   * tükenir.
   */
  const { ctx, sayac } = baglam([{ id: "1111111111", ad: "A", yonetici: false }]);
  const [a, b, c] = await Promise.all([ctx.tumHesaplar(), ctx.tumHesaplar(), ctx.tumHesaplar()]);
  assert.equal(sayac.hasat, 1, "üç eşzamanlı çağrı tek hasat yapmalı");
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test("KRİTİK: EKSİK sonuç önbelleğe alınmaz", async () => {
  /**
   * Bu davranışın yokluğu somut bir arıza üretir: geçici bir API hatası sırasında
   * oluşan boş/eksik liste TTL boyunca sabitlenir ve ajan, API çoktan düzelmişken
   * kullanıcıya "Google Ads hesabınız yok" demeye devam eder.
   */
  const hesaplar: SahteHesap[] = [
    { id: "1111111111", ad: "A", yonetici: false, patlasin: true },
    { id: "2222222222", ad: "B", yonetici: false },
  ];
  const { ctx, sayac } = baglam(hesaplar);

  const ilk = await ctx.tumHesaplar();
  assert.deepEqual(ilk.map((h) => h.id), ["2222222222"], "okunabilen hesap yine de dönmeli");
  assert.equal(sayac.hasat, 1);

  // Hata geçti: ikinci çağrı önbellekten DEĞİL, yeniden hasattan gelmeli.
  hesaplar[0].patlasin = false;
  const ikinci = await ctx.tumHesaplar();
  assert.equal(sayac.hasat, 2, "KRİTİK: eksik sonuç önbelleğe alınmış olmamalı");
  assert.deepEqual(
    ikinci.map((h) => h.id).sort(),
    ["1111111111", "2222222222"],
    "API düzelince tam liste dönmeli"
  );
});

test("tek okunamayan hesap TÜM listeyi düşürmez", async () => {
  const { ctx } = baglam([
    { id: "1111111111", ad: "Bozuk", yonetici: false, patlasin: true },
    { id: "2222222222", ad: "Sağlam", yonetici: false },
  ]);
  const liste = await ctx.tumHesaplar();
  assert.equal(liste.length, 1);
  assert.equal(liste[0].ad, "Sağlam");
});

test("üst hesap sayısı sınırlıdır — tek tamamlama yüzlerce sorguya açılmaz", async () => {
  const cok: SahteHesap[] = Array.from({ length: 50 }, (_, i) => ({
    id: String(1000000000 + i),
    ad: `H${i}`,
    yonetici: false,
  }));
  const { ctx, sayac } = baglam(cok);
  const liste = await ctx.tumHesaplar();
  assert.equal(liste.length, 30, "üst hesaplar 30 ile sınırlı olmalı");
  assert.equal(sayac.sorgu, 30, "sorgu sayısı da sınırla birlikte kapanmalı");
});
