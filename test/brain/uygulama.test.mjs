// SPDX-License-Identifier: AGPL-3.0-only
/**
 * uygulama.mjs testleri — AĞSIZ: cagir sahtedir, gerçek MCP/Anthropic bağlantısı yoktur.
 *
 * Kanıtlanan güvenlik değişmezleri:
 *  - set_campaign_status / update_campaign_budget kurulum yolundan (uygula) HİÇBİR
 *    koşulda çağrılmaz (kara liste); yayına alma YALNIZ ayrı yayinaAl() yolundan
 *    çıkar ve o yolun testleri test/brain/yayin.test.mjs dosyasındadır,
 *  - hiçbir çağrıda `confirm` anahtarı yoktur,
 *  - negatif kelimeler yalnız create sonucundan ayrıştırılan campaignId'ye gider,
 *  - plan/kreatif içinde kimlik/hedef alanı varsa baştan hata,
 *  - ID ayrıştırılamayan ya da kırpılmış sonuçta kalan adımlar iptal edilir,
 *  - 'Reddedildi'/'devre dışı'/'bulunamadı' yanıtları başarısız adım sayılır.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  uygula,
  yayinaAl,
  guvenliCagirici,
  sonucBasarisizMi,
  sonucDurumu,
  kimlikAyikla,
  YAZMA_IZINLI,
  KARA_LISTE,
} from "../../scripts/brain/uygulama.mjs";

/* write.ts'in BUGÜNKÜ gerçek çıktı biçimi (create_search_campaign) — fixture. */
const CREATE_OK = [
  "Kampanya PAUSED olarak oluşturuldu (4 anahtar kelime, günlük bütçe 40, hedef: TR).",
  "Oluşan kaynaklar:",
  "customers/1234567890/campaignBudgets/9001",
  "customers/1234567890/campaigns/9002",
  "customers/1234567890/adGroups/9003",
  "customers/1234567890/campaignCriteria/9002~9004",
  "customers/1234567890/adGroupCriteria/9003~9005",
  "",
  "SONRAKİ ADIM: Reklam metni ekle (create_responsive_search_ad), kullanıcı onayını al, sonra set_campaign_status ile yayına al.",
].join("\n");

const KIRPMA = "[... sonuç kırpıldı ...]";

/** Sahte cagir: tüm çağrıları (araç adı + args) kaydeder, araç başına yanıt ezilebilir. */
function sahteCagir(cevaplar = {}) {
  const cagrilar = [];
  const fn = async (arac, args) => {
    cagrilar.push({ arac, args });
    const ozel = cevaplar[arac];
    if (typeof ozel === "function") return ozel(args);
    if (ozel !== undefined) return ozel;
    if (arac === "run_gaql") return "0 satır (0 gösteriliyor):\n[]";
    if (arac === "create_search_campaign") return CREATE_OK;
    if (arac === "add_keywords") return "2 anahtar kelime eklendi [EXACT].";
    if (arac === "add_campaign_negative_keywords")
      return "2 negatif anahtar kelime KAMPANYA seviyesinde eklendi [PHRASE].";
    if (arac === "create_responsive_search_ad")
      return (
        "RSA oluşturuldu: customers/1234567890/adGroupAds/9003~7001\n" +
        "Not: Kampanya PAUSED ise reklam yayınlanmaz; onay sonrası set_campaign_status ile açılır."
      );
    return "(boş yanıt)";
  };
  fn.cagrilar = cagrilar;
  return fn;
}

function ornekGirdi(degisiklik = {}) {
  return {
    plan: {
      kampanyaAdi: "Deneme Kampanyası",
      hedefUlke: "TR",
      dil: "tr",
      butceGunlukTL: 40,
      adGruplari: [
        { ad: "Grup 1", anahtarKelimeler: ["koşu ayakkabısı", "spor ayakkabı"], eslesmeTipi: "PHRASE" },
      ],
      negatifKelimeler: ["ücretsiz", "ikinci el"],
      basariMetrikleri: ["CTR"],
      ...(degisiklik.plan ?? {}),
    },
    kreatif: {
      basliklar: ["Koşu Ayakkabısı", "Hızlı Kargo", "Uygun Fiyat"],
      aciklamalar: ["Yeni sezon koşu ayakkabıları burada.", "Bugün sipariş ver, yarın kapında."],
      ...(degisiklik.kreatif ?? {}),
    },
    musteriId: "1234567890",
    finalUrl: "https://ornek-magaza.example/kosu",
    ...(degisiklik.kok ?? {}),
  };
}

/* ── Mutlu yol ───────────────────────────────────────────────────────────────── */

test("mutlu yol: doğru sıra, kimlikler create sonucundan, tüm adımlar tamam", async () => {
  const cagir = sahteCagir();
  const sonuc = await uygula(ornekGirdi(), { cagir });

  assert.equal(sonuc.basari, true);
  assert.equal(sonuc.kampanyaId, "9002");
  assert.equal(sonuc.adGrubuId, "9003");
  assert.deepEqual(sonuc.eksikAdimlar, []);
  assert.deepEqual(
    cagir.cagrilar.map((c) => c.arac),
    ["run_gaql", "create_search_campaign", "add_campaign_negative_keywords", "create_responsive_search_ad"]
  );
  for (const adim of sonuc.adimlar) assert.equal(adim.durum, "tamam");

  // negatifler YALNIZ yeni oluşturulan kampanyaya
  const negatif = cagir.cagrilar.find((c) => c.arac === "add_campaign_negative_keywords");
  assert.equal(negatif.args.campaignId, "9002");
  assert.deepEqual(negatif.args.keywords, ["ücretsiz", "ikinci el"]);

  // RSA operatörün finalUrl'i ve yeni adGroupId ile
  const rsa = cagir.cagrilar.find((c) => c.arac === "create_responsive_search_ad");
  assert.equal(rsa.args.adGroupId, "9003");
  assert.equal(rsa.args.finalUrl, "https://ornek-magaza.example/kosu");

  // kampanya adı çalıştırma damgalı
  const create = cagir.cagrilar.find((c) => c.arac === "create_search_campaign");
  assert.match(create.args.name, /^GB-\d{8}-\d{4} — Deneme Kampanyası$/);
});

test("GÜVENLİK: set_campaign_status ve update_campaign_budget hiçbir çağrıda yok", async () => {
  const cagir = sahteCagir();
  await uygula(ornekGirdi(), { cagir });
  for (const { arac } of cagir.cagrilar) {
    assert.ok(!KARA_LISTE.includes(arac), `${arac} çağrılmamalıydı`);
  }
});

test("GÜVENLİK: hiçbir çağrıda confirm anahtarı gönderilmez", async () => {
  const cagir = sahteCagir();
  await uygula(ornekGirdi(), { cagir });
  assert.ok(cagir.cagrilar.length >= 4);
  for (const { arac, args } of cagir.cagrilar) {
    assert.ok(!("confirm" in (args ?? {})), `${arac} çağrısında confirm olmamalı`);
  }
});

test("GÜVENLİK: kurulum yolu hiçbir çağrıda status='ENABLED' taşımaz", async () => {
  const cagir = sahteCagir();
  await uygula(ornekGirdi(), { cagir });
  for (const { arac, args } of cagir.cagrilar) {
    assert.notEqual(args?.status, "ENABLED", `${arac} çağrısı ENABLED taşımamalı`);
  }
  // Yayına alma yolu AYRI bir dışa aktarımdır; uygula() onu asla kullanmaz.
  assert.equal(typeof yayinaAl, "function");
  assert.ok(!YAZMA_IZINLI.includes("set_campaign_status"));
});

/* ── Sarmalayıcı (guvenliCagirici) ───────────────────────────────────────────── */

test("sarmalayıcı: kara listedeki araçlar Türkçe hatayla reddedilir", async () => {
  const cagir = sahteCagir();
  const guvenli = guvenliCagirici(cagir);
  await assert.rejects(() => guvenli("set_campaign_status", { status: "ENABLED" }), /kalıcı olarak yasak/);
  await assert.rejects(() => guvenli("update_campaign_budget", { newDailyBudget: 10000 }), /kalıcı olarak yasak/);
  assert.equal(cagir.cagrilar.length, 0); // alttaki cagir'a hiç ulaşmadı
});

test("sarmalayıcı: izinli liste dışındaki araç adı reddedilir", async () => {
  const guvenli = guvenliCagirici(sahteCagir());
  await assert.rejects(() => guvenli("analyze_site", { url: "https://a.example" }), /izinli araç listesinde yok/);
  await assert.rejects(() => guvenli("list_accounts", {}), /izinli araç listesinde yok/);
});

test("sarmalayıcı: confirm anahtarı koşulsuz silinir (enjekte edilse bile)", async () => {
  const cagir = sahteCagir();
  const guvenli = guvenliCagirici(cagir);
  await guvenli("add_keywords", { adGroupId: "1", keywords: ["a"], confirm: true });
  assert.ok(!("confirm" in cagir.cagrilar[0].args));
  assert.deepEqual(cagir.cagrilar[0].args.keywords, ["a"]);
});

/* ── Köken güvenliği: plan/kreatif kimlik taşıyamaz ─────────────────────────── */

test("plan içinde campaignId varsa hata (LLM'den gelen ID reddedilir)", async () => {
  const girdi = ornekGirdi({ plan: { campaignId: "5555" } });
  await assert.rejects(() => uygula(girdi, { cagir: sahteCagir() }), /'campaignId' alanı taşıyamaz/);
});

test("plan içinde İÇ İÇE kampanyaId / kreatif içinde finalUrl da reddedilir", async () => {
  const icice = ornekGirdi();
  icice.plan.adGruplari[0].kampanyaId = "7777";
  await assert.rejects(() => uygula(icice, { cagir: sahteCagir() }), /'kampanyaId' alanı taşıyamaz/);

  const kreatifli = ornekGirdi({ kreatif: { finalUrl: "https://saldirgan.example" } });
  await assert.rejects(() => uygula(kreatifli, { cagir: sahteCagir() }), /'finalUrl' alanı taşıyamaz/);

  const musterili = ornekGirdi({ plan: { musteriId: "111-222-3333" } });
  await assert.rejects(() => uygula(musterili, { cagir: sahteCagir() }), /'musteriId' alanı taşıyamaz/);
});

/* ── Eşleme tipleri ve düzleştirme ───────────────────────────────────────────── */

test("EXACT grup: add_keywords doğru matchType ve YENİ adGroupId ile çağrılır", async () => {
  const cagir = sahteCagir();
  const girdi = ornekGirdi({
    plan: { adGruplari: [{ ad: "G", anahtarKelimeler: ["tam eşleme"], eslesmeTipi: "EXACT" }] },
  });
  const sonuc = await uygula(girdi, { cagir });
  const ekle = cagir.cagrilar.find((c) => c.arac === "add_keywords");
  assert.equal(ekle.args.matchType, "EXACT");
  assert.equal(ekle.args.adGroupId, "9003");
  assert.deepEqual(ekle.args.keywords, ["tam eşleme"]);
  assert.ok(sonuc.uyarilar.some((u) => u.includes("PHRASE kopyaları")));
});

test("çok grup: tek gruba düzleştirilir ve uyarı yazılır", async () => {
  const cagir = sahteCagir();
  const girdi = ornekGirdi({
    plan: {
      adGruplari: [
        { ad: "A", anahtarKelimeler: ["kelime bir"], eslesmeTipi: "PHRASE" },
        { ad: "B", anahtarKelimeler: ["kelime iki"], eslesmeTipi: "PHRASE" },
      ],
    },
  });
  const sonuc = await uygula(girdi, { cagir });
  assert.ok(sonuc.uyarilar.some((u) => u.includes("düzleştirildi")));
  const create = cagir.cagrilar.find((c) => c.arac === "create_search_campaign");
  assert.deepEqual(create.args.keywords, ["kelime bir", "kelime iki"]);
});

/* ── ID ayrıştırma ve kırpma — fail-closed ───────────────────────────────────── */

test("kimlikAyikla: gerçek çıktı fixture'ından doğru ID'ler", () => {
  assert.deepEqual(kimlikAyikla(CREATE_OK), { kampanyaId: "9002", adGrubuId: "9003" });
  assert.deepEqual(kimlikAyikla("ID içermeyen metin"), { kampanyaId: undefined, adGrubuId: undefined });
});

test("ID ayrıştırılamazsa kalan TÜM adımlar iptal (tahmin yok)", async () => {
  const cagir = sahteCagir({ create_search_campaign: "Kampanya PAUSED olarak oluşturuldu ama kaynak listesi yok." });
  const sonuc = await uygula(ornekGirdi(), { cagir });
  assert.equal(sonuc.basari, false);
  assert.equal(sonuc.kampanyaId, undefined);
  assert.ok(sonuc.uyarilar.some((u) => u.includes("ayrıştırılamadı")));
  // create'ten sonra hiçbir yazma çağrısı yapılmadı
  assert.deepEqual(cagir.cagrilar.map((c) => c.arac), ["run_gaql", "create_search_campaign"]);
  const atlananlar = sonuc.adimlar.filter((a) => a.durum === "atlandi").map((a) => a.arac);
  assert.deepEqual(atlananlar, ["add_campaign_negative_keywords", "create_responsive_search_ad"]);
});

test("kırpma işaretli sonuç: ID'ler görünse bile kalan adımlar iptal", async () => {
  const cagir = sahteCagir({ create_search_campaign: CREATE_OK + "\n" + KIRPMA });
  const sonuc = await uygula(ornekGirdi(), { cagir });
  assert.equal(sonuc.basari, false);
  assert.ok(sonuc.uyarilar.some((u) => u.includes("kırpılmış")));
  assert.deepEqual(cagir.cagrilar.map((c) => c.arac), ["run_gaql", "create_search_campaign"]);
});

/* ── Sessiz başarısızlık sınıflandırması ─────────────────────────────────────── */

test("'Reddedildi' yanıtı başarısız adım sayılır, sonrakiler atlanır, rapor dürüst", async () => {
  const cagir = sahteCagir({
    add_campaign_negative_keywords: "Reddedildi: geçerli anahtar kelime kalmadı (hepsi boş/tekrar).",
  });
  const sonuc = await uygula(ornekGirdi(), { cagir });
  assert.equal(sonuc.basari, false);
  assert.equal(sonuc.kampanyaId, "9002"); // kurulan kısım dürüstçe raporlanır
  const negatifAdim = sonuc.adimlar.find((a) => a.arac === "add_campaign_negative_keywords");
  assert.equal(negatifAdim.durum, "basarisiz");
  const rsaAdim = sonuc.adimlar.find((a) => a.arac === "create_responsive_search_ad");
  assert.equal(rsaAdim.durum, "atlandi");
  assert.deepEqual(sonuc.eksikAdimlar, ["add_campaign_negative_keywords", "create_responsive_search_ad"]);
});

test("'Yazma araçları devre dışı' yanıtı da başarısız sayılır", async () => {
  const cagir = sahteCagir({
    create_search_campaign:
      "Yazma araçları bu hesap için devre dışı. Yalnız hesap sahibi açabilir — kullanıcıya bildir, kendi başına aşmaya çalışma.",
  });
  const sonuc = await uygula(ornekGirdi(), { cagir });
  assert.equal(sonuc.basari, false);
  assert.equal(sonuc.adimlar.find((a) => a.arac === "create_search_campaign").durum, "basarisiz");
  assert.equal(cagir.cagrilar.filter((c) => YAZMA_IZINLI.includes(c.arac)).length, 1);
});

/* ── KAPALI ARIZA: tanınmayan yanıt başarı DEĞİLDİR ──────────────────────────── */

test("KRİTİK: tanınmayan araç yanıtı 'tamam' damgalanmaz — belirsizdir", () => {
  /**
   * Eskiden sınıflandırıcı yalnız BİLİNEN ret desenlerine bakıyor, eşleşme yoksa
   * adımı 'tamam' damgalıyordu. Yani sunucunun tanımadığımız her cevabı — yani
   * yapılmamış bir yazma — denetim izine TAMAM diye giriyordu: süreç 0 ile çıkıyor,
   * rapor "tüm adımlar tamamlandı" diyor ve yarım kalmış bir kampanya için
   * --yayinla kapısı açılıyordu.
   */
  for (const yanit of [
    "429 RESOURCE_EXHAUSTED",
    "PERMISSION_DENIED",
    "Geçersiz kampanya ID",
    "İşlem yapılmadı: kullanıcı onayı alınamadı (declined). Güvenlik gereği onaysız işlem uygulanmaz.",
    "{}",
  ]) {
    assert.notEqual(
      sonucDurumu(yanit),
      "tamam",
      `'${yanit}' başarı ilan edilemez: yazmanın gerçekleştiğini yalnız sunucunun POZİTİF imzası söyler`
    );
  }
  // Gerçek başarı metinleri 'tamam' kalmalı — kural sertleşirken meşru yol kapanmamalı.
  assert.equal(sonucDurumu(CREATE_OK), "tamam");
  assert.equal(sonucDurumu("5 anahtar kelime eklendi [PHRASE]."), "tamam");
  assert.equal(sonucDurumu("RSA oluşturuldu: customers/1/adGroupAds/2~3"), "tamam");
  assert.equal(sonucDurumu("2 negatif anahtar kelime KAMPANYA seviyesinde eklendi [PHRASE]."), "tamam");
  assert.equal(sonucDurumu("Kampanya 42 YAYINDA (ENABLED). Harcama başladı."), "tamam");
  assert.equal(sonucDurumu("0 satır (0 gösteriliyor):\n[]"), "tamam");
  // Bilinen ret 'basarisiz'dir — 'belirsiz'e karışmaz.
  assert.equal(sonucDurumu("Reddedildi: bütçe tavan üstü."), "basarisiz");
});

test("KRİTİK: tanınmayan yanıt kalan adımları İPTAL eder, kurulum başarılı sayılmaz", async () => {
  const cagir = sahteCagir({
    // İnsan onayı kapısının kullanıcı reddi metni: hiçbir ret desenine uymuyordu.
    add_campaign_negative_keywords: "İşlem yapılmadı: kullanıcı onayı vermedi.",
  });
  const sonuc = await uygula(ornekGirdi(), { cagir });

  assert.equal(sonuc.basari, false, "yapılmamış bir yazma TAMAM raporlanamaz");
  const adim = sonuc.adimlar.find((a) => a.arac === "add_campaign_negative_keywords");
  assert.notEqual(adim.durum, "tamam");
  const rsa = sonuc.adimlar.find((a) => a.arac === "create_responsive_search_ad");
  assert.equal(rsa.durum, "atlandi", "doğrulanamayan adımdan sonrası koşmaz (kapalı arıza)");
  assert.ok(sonuc.eksikAdimlar.includes("create_responsive_search_ad"));
});

test("KRİTİK: ne ret ne başarı olan yanıt 'belirsiz' damgalanır ve uyarı yazılır", async () => {
  const cagir = sahteCagir({ add_campaign_negative_keywords: "429 RESOURCE_EXHAUSTED" });
  const sonuc = await uygula(ornekGirdi(), { cagir });

  const adim = sonuc.adimlar.find((a) => a.arac === "add_campaign_negative_keywords");
  assert.equal(
    adim.durum,
    "belirsiz",
    "'olmadığını biliyorum' ile 'olup olmadığını bilmiyorum' aynı damgayı taşıyamaz"
  );
  assert.ok(
    sonuc.uyarilar.some((u) => u.includes("DOĞRULANAMADI")),
    "operatör, adımın neden durduğunu uyarılardan okuyabilmeli"
  );
});

test("kırpılmış adım dönüşte kirpik:true taşır (rapor damgasının okuduğu alan)", async () => {
  /**
   * rapor.mjs `uygulamaSonucu?.kirpik` okuyup "⚠ YARIM OLABİLİR" damgasını basıyordu;
   * üreten taraf o alanı HİÇ yazmıyordu. Yani belgelenen değişmez üretim yolunda hiç
   * ateşlenemiyor, damgayı yalnız elle kurulmuş bir test şekli görebiliyordu.
   */
  const cagir = sahteCagir({ create_search_campaign: CREATE_OK + "\n" + KIRPMA });
  const sonuc = await uygula(ornekGirdi(), { cagir });

  assert.equal(sonuc.kirpik, true, "kırpma bilgisi özet metnine değil dönüş nesnesine bağlı olmalı");
  assert.equal(sonuc.adimlar.find((a) => a.arac === "create_search_campaign").durum, "belirsiz");

  // Kırpma yokken bayrak açılmaz: her koşuda basılan bir damga hiçbir şey söylemez.
  const temiz = await uygula(ornekGirdi(), { cagir: sahteCagir() });
  assert.equal(temiz.kirpik, false);
});

test("sonucBasarisizMi: sınıflandırıcı desenleri", () => {
  assert.equal(sonucBasarisizMi("Reddedildi: bütçe tavan üstü."), true);
  assert.equal(sonucBasarisizMi("Kampanya bulunamadı: 123"), true);
  assert.equal(sonucBasarisizMi("Yazma araçları bu hesap için devre dışı."), true);
  assert.equal(sonucBasarisizMi("Araç hatası: bağlantı koptu"), true);
  assert.equal(sonucBasarisizMi(""), true);
  assert.equal(sonucBasarisizMi(CREATE_OK), false);
  assert.equal(sonucBasarisizMi("5 anahtar kelime eklendi [PHRASE]."), false);
});

test("cagir fırlatırsa adım başarısız olur, kalanlar atlanır (yarım devam yok)", async () => {
  const cagir = sahteCagir({
    create_responsive_search_ad: () => {
      throw new Error("bağlantı koptu");
    },
  });
  const sonuc = await uygula(ornekGirdi(), { cagir });
  assert.equal(sonuc.basari, false);
  const rsa = sonuc.adimlar.find((a) => a.arac === "create_responsive_search_ad");
  assert.equal(rsa.durum, "basarisiz");
  assert.match(rsa.sonucOzeti, /Araç hatası/);
});

/* ── İdempotenlik ────────────────────────────────────────────────────────────── */

test("aynı adlı kampanya varsa hiçbir yazma çağrısı yapılmaz", async () => {
  const cagir = sahteCagir({
    run_gaql: '1 satır (1 gösteriliyor):\n[{"campaign":{"id":9002,"name":"GB-... — Deneme Kampanyası"}}]',
  });
  const sonuc = await uygula(ornekGirdi(), { cagir });
  assert.equal(sonuc.basari, false);
  assert.ok(sonuc.uyarilar.some((u) => u.includes("zaten var")));
  assert.deepEqual(cagir.cagrilar.map((c) => c.arac), ["run_gaql"]);
  assert.ok(sonuc.adimlar.every((a) => a.arac === "run_gaql" || a.durum === "atlandi"));
});

test("idempotenlik kontrolü çökerse uyarıyla devam edilir (kurulumu engellemez)", async () => {
  const cagir = sahteCagir({
    run_gaql: () => {
      throw new Error("GAQL kullanılamıyor");
    },
  });
  const sonuc = await uygula(ornekGirdi(), { cagir });
  assert.equal(sonuc.basari, true);
  assert.ok(sonuc.uyarilar.some((u) => u.includes("İdempotenlik kontrolü yapılamadı")));
  assert.ok(cagir.cagrilar.some((c) => c.arac === "create_search_campaign"));
});

/* ── Girdi doğrulama — fail-closed sınır durumları ───────────────────────────── */

test("bütçe: string '40' ve NaN reddedilir (koersiyon yok)", async () => {
  await assert.rejects(
    () => uygula(ornekGirdi({ plan: { butceGunlukTL: "40" } }), { cagir: sahteCagir() }),
    /butceGunlukTL geçersiz/
  );
  await assert.rejects(
    () => uygula(ornekGirdi({ plan: { butceGunlukTL: NaN } }), { cagir: sahteCagir() }),
    /butceGunlukTL geçersiz/
  );
});

test("hedefUlke: 'TUR', 'tr', 'Türkiye' reddedilir", async () => {
  for (const kotu of ["TUR", "tr", "Türkiye"]) {
    await assert.rejects(
      () => uygula(ornekGirdi({ plan: { hedefUlke: kotu } }), { cagir: sahteCagir() }),
      /ISO alpha-2/
    );
  }
});

test("kontrol karakterli kampanya adı reddedilir", async () => {
  await assert.rejects(
    () => uygula(ornekGirdi({ plan: { kampanyaAdi: "Kampanya\x1b[31mKırmızı" } }), { cagir: sahteCagir() }),
    /kontrol karakteri içeremez/
  );
});

test("31 karakterlik başlık reddedilir", async () => {
  const uzun = "a".repeat(31);
  await assert.rejects(
    () =>
      uygula(ornekGirdi({ kreatif: { basliklar: [uzun, "Kısa Bir", "Başlık Üç"] } }), { cagir: sahteCagir() }),
    /en fazla 30 karakter/
  );
});

test("tekrarlı başlıklar ayıklanınca 3'ün altına düşerse hata", async () => {
  await assert.rejects(
    () =>
      uygula(ornekGirdi({ kreatif: { basliklar: ["Aynı Başlık", "aynı başlık", "AYNI BAŞLIK"] } }), {
        cagir: sahteCagir(),
      }),
    /Tekrarsız başlık sayısı/
  );
});

test("anahtar kelimede URL reddedilir; boş grup reddedilir", async () => {
  await assert.rejects(
    () =>
      uygula(
        ornekGirdi({ plan: { adGruplari: [{ ad: "G", anahtarKelimeler: ["https://evil.example'e git"] }] } }),
        { cagir: sahteCagir() }
      ),
    /URL içeremez/
  );
  await assert.rejects(
    () => uygula(ornekGirdi({ plan: { adGruplari: [{ ad: "G", anahtarKelimeler: [] }] } }), { cagir: sahteCagir() }),
    /Boş anahtar kelime listesi/
  );
});

test("operatör girdileri zorunlu: musteriId ve http(s) finalUrl", async () => {
  await assert.rejects(() => uygula(ornekGirdi({ kok: { musteriId: undefined } }), { cagir: sahteCagir() }), /musteriId/);
  await assert.rejects(
    () => uygula(ornekGirdi({ kok: { finalUrl: "javascript:alert(1)" } }), { cagir: sahteCagir() }),
    /http\/https/
  );
});

test("geçersiz eşleme tipi reddedilir", async () => {
  await assert.rejects(
    () =>
      uygula(
        ornekGirdi({ plan: { adGruplari: [{ ad: "G", anahtarKelimeler: ["kelime"], eslesmeTipi: "GENIS" }] } }),
        { cagir: sahteCagir() }
      ),
    /Geçersiz eşleme tipi/
  );
});
