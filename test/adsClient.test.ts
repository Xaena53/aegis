// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AdsContext — hesap keşfi, EKSİKLİK bildirimi ve önbellek davranışı.
 *
 * Buradaki mantık sessizce yanlış olabilir ve yanlışlığı ajanın ağzından kullanıcıya
 * "hesabınız yok" diye çıkar. Beş davranış özellikle önemli:
 *
 *   1) MCC alt hesapları (TORUNLAR DAHİL) listeye GİRMELİ — kampanyalar orada yaşar;
 *      üst düzey hesap listesi tek başına çoğu kullanıcı için boştur.
 *   2) Eşzamanlı istekler TEK hasat paylaşmalı — tamamlama her tuş vuruşunda çağrılır
 *      ve paylaşılmayan bir hasat, Google kotasını tuş başına bir tur harcar.
 *   3) EKSİK sonuç TAM diye sunulmamalı — ne kırpma ne de okunamayan hesap sessiz
 *      kalabilir; çağıran "liste tam mı" sorusunu zarftan cevaplayabilmeli.
 *   4) EKSİK sonuç TTL boyunca sabitlenmemeli, ama her çağrıda yeniden hasat da
 *      edilmemeli: kalıcı arıza her tuş vuruşunu 30-60 sorguya çevirir.
 *   5) Önbellek damgası hasadın BİTİŞİNDEN alınmalı — başlangıç damgası uzun hasadı
 *      doğduğu anda bayat yapar.
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
  /** Doğrudan çocuklar; kendileri de yönetici olup çocuk taşıyabilir (iki katmanlı MCC). */
  cocuklar?: SahteHesap[];
  /** Bu hesap sorgulanınca hata fırlatsın mı? */
  patlasin?: boolean;
}

/** Bir yöneticinin TÜM torunları — gerçek customer_client'ın döndürdüğü küme. */
function torunlar(h: SahteHesap): SahteHesap[] {
  return (h.cocuklar ?? []).flatMap((c) => [c, ...torunlar(c)]);
}

interface BaglamSecenek {
  /** Enjekte edilebilir saat; verilmezse gerçek zaman kullanılır. */
  saat?: () => number;
  /** Her sorguda saatin kaç ms ilerlediği (uzun hasat benzetimi). */
  sorguSuresiMs?: number;
}

/** Sorgu sayacı taşıyan bir AdsContext üretir; gerçek API'ye hiç dokunulmaz. */
function baglam(hesaplar: SahteHesap[], secenek: BaglamSecenek = {}) {
  const sayac = { hasat: 0, sorgu: 0 };
  const saat = { simdi: 0 };
  const ctx = new AdsContext(AYAR);
  if (secenek.saat || secenek.sorguSuresiMs) {
    (ctx as any).simdi = secenek.saat ?? (() => saat.simdi);
  }

  /** Hem üst düzey hem torun hesaplarda kimlikle arama (torun da sorgulanabilir). */
  const bul = (id: string): SahteHesap | undefined =>
    hesaplar.flatMap((h) => [h, ...torunlar(h)]).find((x) => x.id === id);

  (ctx as any).api = {
    async listAccessibleCustomers() {
      sayac.hasat += 1;
      return { resource_names: hesaplar.map((h) => `customers/${h.id}`) };
    },
    Customer({ customer_id }: { customer_id: string }) {
      return {
        async query(q: string) {
          sayac.sorgu += 1;
          saat.simdi += secenek.sorguSuresiMs ?? 0;
          const h = bul(customer_id);
          if (!h) return [];
          if (h.patlasin) throw new Error("hesap okunamadı");
          if (q.includes("FROM customer_client")) {
            /**
             * Gerçek API gibi: yöneticinin KENDİSİ de (level 0) satır olarak döner ve
             * torunların hepsi listelenir. LIMIT'e uyulur, yoksa kırpma ölçülemez.
             * `level = 1` yan tümcesine de UYULUR: sahte API bu filtreyi yok sayarsa,
             * filtre koda geri gelse bile hiçbir test kızarmaz — ölçtüğümüz şey
             * torunların gerçekten sorgulanması olur.
             */
            const dogrudan = /customer_client\.level\s*=\s*1/.test(q);
            const kapsam = dogrudan ? (h.cocuklar ?? []) : [h, ...torunlar(h)];
            const satirlar = kapsam.map((c) => ({
              customer_client: { id: c.id, descriptive_name: c.ad, manager: c.yonetici },
            }));
            const limit = Number(/LIMIT (\d+)/.exec(q)?.[1] ?? satirlar.length);
            return satirlar.slice(0, limit);
          }
          return [{ customer: { descriptive_name: h.ad, manager: h.yonetici } }];
        },
      };
    },
  };
  return { ctx, sayac, saat };
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

test("KRİTİK: MCC alt hesapları listeye girer — kampanyalar orada yaşar", async () => {
  const { ctx } = baglam([
    {
      id: "1111111111",
      ad: "Ajans MCC",
      yonetici: true,
      cocuklar: [
        { id: "2222222222", ad: "Müşteri A", yonetici: false },
        { id: "3333333333", ad: "Müşteri B", yonetici: false },
      ],
    },
  ]);
  const { liste, eksik } = await ctx.tumHesaplar();
  assert.deepEqual(
    liste.map((h) => h.id).sort(),
    ["1111111111", "2222222222", "3333333333"],
    "yalnız üst hesabı döndürmek çoğu kullanıcı için boş liste demektir"
  );
  assert.equal(liste.find((h) => h.id === "1111111111")?.yonetici, true);
  assert.equal(liste.find((h) => h.id === "2222222222")?.yonetici, false);
  assert.equal(eksik.var, false, "her şey okunduysa liste TAM işaretlenmeli");
});

test("KRİTİK: iki katmanlı MCC'de TORUN reklam hesapları da görünür", async () => {
  /**
   * `customer_client.level = 1` yan tümcesi yalnız doğrudan çocukları getiriyordu.
   * Ajans kurulumunda gerçek reklam hesapları alt-MCC'nin altındadır: liste yalnız
   * MCC'lerden oluşuyor, ajan ya "erişilebilir hesabınız yok" diyor ya da MCC seçip
   * USER_PERMISSION_DENIED alıyordu.
   */
  const { ctx } = baglam([
    {
      id: "1111111111",
      ad: "Ajans MCC",
      yonetici: true,
      cocuklar: [
        {
          id: "2222222222",
          ad: "Alt MCC",
          yonetici: true,
          cocuklar: [{ id: "3333333333", ad: "Gerçek reklam hesabı", yonetici: false }],
        },
      ],
    },
  ]);
  const { liste } = await ctx.tumHesaplar();
  const torun = liste.find((h) => h.id === "3333333333");
  assert.ok(torun, "torun reklam hesabı listede olmalı");
  assert.equal(torun!.yonetici, false);
  assert.ok(
    liste.some((h) => h.id === "2222222222" && h.yonetici),
    "alt-MCC de görünmeli (kampanya kurulamaz diye işaretli)"
  );
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
    { id: "1111111111", ad: "MCC", yonetici: true, cocuklar: [{ id: "2222222222", ad: "A", yonetici: false }] },
    { id: "2222222222", ad: "A", yonetici: false },
  ]);
  const { liste } = await ctx.tumHesaplar();
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
    { id: "1111111111", ad: "Ajans MCC", yonetici: true, cocuklar: [{ id: "3333333333", ad: "Ortak", yonetici: false }] },
    { id: "2222222222", ad: "Müşteri MCC", yonetici: true, cocuklar: [{ id: "3333333333", ad: "Ortak", yonetici: false }] },
  ]);
  const { liste } = await ctx.tumHesaplar();
  assert.equal(
    liste.filter((h) => h.id === "3333333333").length,
    1,
    "iki farklı MCC'nin çocuğu olan hesap listeye bir kez girmeli"
  );
  assert.equal(liste.length, 3, "iki MCC + bir ortak hesap");
});

test("isimsiz hesap listeden düşmez, '(isimsiz)' olarak görünür", async () => {
  const { ctx } = baglam([{ id: "1111111111", ad: undefined as any, yonetici: false }]);
  const { liste } = await ctx.tumHesaplar();
  assert.equal(liste[0].ad, "(isimsiz)", "adı okunamayan hesap gizlenmemeli");
});

/* ── eksiklik bildirimi ───────────────────────────────────────────────────────── */

test("KRİTİK: okunamayan hesap listeden DÜŞMEZ, erisilemedi ile taşınır", async () => {
  /**
   * "okunamadı" ile "yok" aynı şey değildir. Hesabı sessizce düşürmek, aynı sunucunun
   * list_accounts aracı "ERİŞİLEMEDİ" derken kaynak tarafında hesabın hiç yokmuş gibi
   * görünmesine yol açıyordu; kullanıcı ID'yi yanlış yazdığını sanıyordu.
   */
  const { ctx } = baglam([
    { id: "1111111111", ad: "Bozuk", yonetici: false, patlasin: true },
    { id: "2222222222", ad: "Sağlam", yonetici: false },
  ]);
  const { liste, eksik } = await ctx.tumHesaplar();
  const bozuk = liste.find((h) => h.id === "1111111111");
  assert.equal(bozuk?.erisilemedi, true, "okunamayan hesap listede ve işaretli olmalı");
  assert.deepEqual(eksik.okunamayan, ["1111111111"]);
  assert.equal(eksik.var, true, "bir hesap okunamadıysa sonuç EKSİK'tir");
  assert.equal(liste.find((h) => h.id === "2222222222")?.erisilemedi, undefined);
});

test("üst hesap kırpması SESSİZ değildir", async () => {
  const cok: SahteHesap[] = Array.from({ length: 50 }, (_, i) => ({
    id: String(1000000000 + i),
    ad: `H${i}`,
    yonetici: false,
  }));
  const { ctx, sayac } = baglam(cok);
  const { liste, eksik } = await ctx.tumHesaplar();
  assert.equal(liste.length, 30, "üst hesaplar 30 ile sınırlı olmalı");
  assert.equal(sayac.sorgu, 30, "sorgu sayısı da sınırla birlikte kapanmalı");
  assert.equal(eksik.ustHesapKirpildi, true, "kırpılmış liste TAM diye sunulamaz");
  assert.equal(eksik.var, true);
});

test("KRİTİK: alt hesap kırpması ölçülür ve bildirilir (tavan+1 ile doyma testi)", async () => {
  /**
   * 101 alt hesaplı MCC: LIMIT 100 ile tam 100 satır döner ve kod kırpıldığını
   * ÖĞRENEMEZ — kaynak "toplam 101" der, kullanıcının aradığı hesap bulunamayınca ajan
   * "böyle bir hesabınız yok" sonucuna varır.
   */
  const cocuklar: SahteHesap[] = Array.from({ length: 101 }, (_, i) => ({
    id: String(2000000000 + i),
    ad: `Alt ${i}`,
    yonetici: false,
  }));
  const { ctx } = baglam([{ id: "1111111111", ad: "Büyük MCC", yonetici: true, cocuklar }]);
  const { liste, eksik } = await ctx.tumHesaplar();
  assert.deepEqual(eksik.altHesabiKirpilan, ["1111111111"], "kırpılan MCC bildirilmeli");
  assert.equal(eksik.var, true);
  assert.equal(liste.length, 101, "MCC + tavan kadar alt hesap");
});

test("tam tavan kadar alt hesap kırpma DEĞİLDİR (yanlış alarm yok)", async () => {
  const cocuklar: SahteHesap[] = Array.from({ length: 100 }, (_, i) => ({
    id: String(2000000000 + i),
    ad: `Alt ${i}`,
    yonetici: false,
  }));
  const { ctx } = baglam([{ id: "1111111111", ad: "MCC", yonetici: true, cocuklar }]);
  const { eksik } = await ctx.tumHesaplar();
  assert.deepEqual(eksik.altHesabiKirpilan, []);
  assert.equal(eksik.var, false, "tam sığan liste EKSİK sayılmamalı");
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

test("KRİTİK: EKSİK sonuç TAM TTL boyunca sabitlenmez", async () => {
  /**
   * Bu davranışın yokluğu somut bir arıza üretir: geçici bir API hatası sırasında
   * oluşan eksik liste TTL boyunca sabitlenir ve ajan, API çoktan düzelmişken
   * kullanıcıya "Google Ads hesabınız yok" demeye devam eder.
   */
  const hesaplar: SahteHesap[] = [
    { id: "1111111111", ad: "A", yonetici: false, patlasin: true },
    { id: "2222222222", ad: "B", yonetici: false },
  ];
  const saat = { t: 0 };
  const { ctx, sayac } = baglam(hesaplar, { saat: () => saat.t });

  const ilk = await ctx.tumHesaplar();
  assert.equal(ilk.eksik.var, true);
  assert.equal(sayac.hasat, 1);

  // Hata geçti ve soğuma penceresi doldu: ikinci çağrı önbellekten DEĞİL, yeniden hasattan gelmeli.
  hesaplar[0].patlasin = false;
  saat.t += 11_000;
  const ikinci = await ctx.tumHesaplar();
  assert.equal(sayac.hasat, 2, "KRİTİK: eksik sonuç tam TTL boyunca sabitlenmiş olmamalı");
  assert.deepEqual(
    ikinci.liste.map((h) => h.id).sort(),
    ["1111111111", "2222222222"],
    "API düzelince tam liste dönmeli"
  );
  assert.equal(ikinci.eksik.var, false);
});

test("KRİTİK: kalıcı arıza her tuş vuruşunu yeni bir hasata çevirmez (soğuma)", async () => {
  /**
   * Kalıcı olarak okunamayan TEK hesap, eksik sonuç hiç önbelleklenmediğinde her
   * tamamlama tuşunu 30-60 sorguya çeviriyordu: 8 karakterlik bir tamamlama ~240-480
   * Google işlemi üretiyor, kota dolunca sisteme daha çok yükleniliyordu.
   */
  const saat = { t: 0 };
  const { ctx, sayac } = baglam(
    [
      { id: "1111111111", ad: "Bozuk", yonetici: false, patlasin: true },
      { id: "2222222222", ad: "Sağlam", yonetici: false },
    ],
    { saat: () => saat.t }
  );
  for (let i = 0; i < 5; i++) {
    saat.t += 500; // tuş vuruşları yarım saniye arayla
    await ctx.tumHesaplar();
  }
  assert.equal(sayac.hasat, 1, "soğuma penceresi içindeki 5 çağrı 5 hasat yapmamalı");
});

test("KRİTİK: önbellek damgası hasadın BİTİŞİNDEN alınır", async () => {
  /**
   * Damga başlangıçta alınırsa, 75 saniye süren bir hasat DOĞDUĞU AN bayat olur:
   * önbellek hiç isabet etmez ve koruma tam da en çok sorgu üreten kurulumda kalkar.
   * Burada her sorgu saati 40 sn ilerletiyor; hasat TTL'den (60 sn) uzun sürüyor.
   */
  const { ctx, sayac } = baglam(
    [
      { id: "1111111111", ad: "A", yonetici: false },
      { id: "2222222222", ad: "B", yonetici: false },
    ],
    { sorguSuresiMs: 40_000 }
  );
  await ctx.tumHesaplar();
  assert.equal(sayac.hasat, 1);
  await ctx.tumHesaplar();
  assert.equal(sayac.hasat, 1, "hasat 80 sn sürse de hemen ardından gelen çağrı önbellekten gelmeli");
});
