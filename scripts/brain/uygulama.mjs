// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Growth Brain — uygulama (yürütme) adımı.
 *
 * Onaylı planı MCP yazma araçlarıyla gerçek hesaba işler. Sıra:
 *   create_search_campaign (PAUSED doğar) → add_keywords (yalnız EXACT/BROAD)
 *   → add_campaign_negative_keywords → create_responsive_search_ad
 *
 * Güvenlik değişmezleri:
 *  - set_campaign_status ve update_campaign_budget KALICI kara listededir; bu modül
 *    hiçbir koşulda kampanyayı yayına almaz ve bütçe değiştirmez.
 *  - Hiçbir araca `confirm` anahtarı gönderilmez (sarmalayıcı koşulsuz siler) —
 *    onay gerektiren her işlem sunucu tarafında tasarım gereği reddedilir.
 *  - Araç argümanları alan alan elle kurulur; plan/kreatif nesneleri asla spread edilmez.
 *  - Negatif kelimeler YALNIZ bu çalıştırmada oluşturulan kampanyaya bağlanır:
 *    campaignId sadece create_search_campaign sonucundan regex ile ayrıştırılır,
 *    plan/kreatif içinde ID/URL/müşteri alanı görülürse baştan hata verilir.
 *  - ID ayrıştırılamazsa ya da sonuçta kırpma işareti varsa kalan TÜM adımlar iptal
 *    edilir; asla "en yeni kampanyayı bul" tahmini yapılmaz.
 */

/** mcpBaglan'ın sonuç tavanında bıraktığı işaret (demo-agent.mjs deseni). */
const KIRPMA_ISARETI = "[... sonuç kırpıldı ...]";

/** Bu modülün çağırabileceği yazma araçları — sabit izinli liste. */
export const YAZMA_IZINLI = Object.freeze([
  "create_search_campaign",
  "add_keywords",
  "add_campaign_negative_keywords",
  "create_responsive_search_ad",
]);

/** Yalnız idempotenlik ön-kontrolü için izinli okuma aracı. */
export const OKUMA_IZINLI = Object.freeze(["run_gaql"]);

/**
 * Kalıcı kara liste: harcama başlatan/artıran araçlar. İzinli listeye ileride
 * yanlışlıkla eklense bile sarmalayıcı önce burayı kontrol eder ve reddeder.
 */
export const KARA_LISTE = Object.freeze(["set_campaign_status", "update_campaign_budget"]);

/** Kontrol karakterleri + C1 aralığı (ANSI/terminal enjeksiyonuna karşı). */
const KONTROL_KARAKTERI = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Operatör girdisi olmayan nesnelerde (plan/kreatif) bulunması yasak alan adları:
 * kimlik ve hedef değerleri YALNIZ operatörden gelir, LLM çıktısından asla.
 */
const YASAK_ALANLAR = new Set([
  "finalurl",
  "musteriid",
  "customerid",
  "campaignid",
  "kampanyaid",
  "adgroupid",
  "confirm",
]);

/* ── Yardımcılar ─────────────────────────────────────────────────────────────── */

/** Rapor/terminale gidecek özet: ANSI ve kontrol karakterleri sökülür, uzunluk kırpılır. */
function gorunurOzet(metin, tavan = 400) {
  const temiz = String(metin ?? "")
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") // ANSI kaçış dizileri
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "") // \n ve \t kalsın
    .trim();
  return temiz.length > tavan ? temiz.slice(0, tavan) + "…" : temiz;
}

/**
 * Araç yanıtı sınıflandırıcısı: yazma araçları reddi isError OLMADAN düz metin
 * döndürür — bu desenler başarısız adım sayılır, rapor yalan söylemesin.
 */
export function sonucBasarisizMi(metin) {
  const m = String(metin ?? "").trim();
  if (!m || m === "(boş yanıt)") return true;
  if (/^(Reddedildi|Araç hatası|Yazma araçları)/i.test(m)) return true;
  if (/devre dışı|bulunamadı/i.test(m)) return true;
  return false;
}

/** Kimlikler yalnız create_search_campaign sonuç metninden, tam yol regex'iyle ayrıştırılır. */
export function kimlikAyikla(metin) {
  const m = String(metin ?? "");
  return {
    kampanyaId: /customers\/\d+\/campaigns\/(\d+)/.exec(m)?.[1],
    adGrubuId: /customers\/\d+\/adGroups\/(\d+)/.exec(m)?.[1],
  };
}

/**
 * cagir sarmalayıcısı — savunma derinliği:
 *  - kara listedeki araçlar her koşulda Türkçe hatayla reddedilir,
 *  - izinli liste dışındaki her araç adı reddedilir,
 *  - `confirm` anahtarı koşulsuz silinir (insan onayı bayrağı istemciden gönderilmez),
 *  - dönüş her zaman string'e çevrilir.
 */
export function guvenliCagirici(cagir) {
  if (typeof cagir !== "function") {
    throw new Error("uygula: 'cagir' fonksiyonu zorunlu — mcpBaglan() ile alınır.");
  }
  return async function guvenliCagir(arac, args) {
    if (KARA_LISTE.includes(arac)) {
      throw new Error(
        `Güvenlik: '${arac}' Growth Brain için kalıcı olarak yasak — yayına alma ve bütçe artışı yalnız insan onaylı ayrı akışta yapılır.`
      );
    }
    if (!YAZMA_IZINLI.includes(arac) && !OKUMA_IZINLI.includes(arac)) {
      throw new Error(`Güvenlik: '${arac}' izinli araç listesinde yok — çağrı reddedildi.`);
    }
    const temiz = {};
    for (const [anahtar, deger] of Object.entries(args ?? {})) {
      if (anahtar === "confirm") continue;
      temiz[anahtar] = deger;
    }
    return String((await cagir(arac, temiz)) ?? "");
  };
}

/** plan/kreatif içinde yasak alan taraması (iç içe nesneler dahil, sınırlı derinlik). */
function yasakAlanTara(deger, kaynak, derinlik = 0) {
  if (derinlik > 6 || deger === null || typeof deger !== "object") return;
  for (const [anahtar, alt] of Object.entries(deger)) {
    if (YASAK_ALANLAR.has(anahtar.toLowerCase())) {
      throw new Error(
        `Güvenlik: '${kaynak}' nesnesi '${anahtar}' alanı taşıyamaz — kimlik/hedef değerleri yalnız operatör girdisinden gelir.`
      );
    }
    yasakAlanTara(alt, kaynak, derinlik + 1);
  }
}

/** Zorunlu, kontrol karakterinden arınmış metin alanı; kırpılmış (trim) halini döndürür. */
function guvenliDize(deger, alanAdi, { max } = {}) {
  if (typeof deger !== "string") throw new Error(`${alanAdi} metin (string) olmalı.`);
  if (KONTROL_KARAKTERI.test(deger)) throw new Error(`${alanAdi} kontrol karakteri içeremez.`);
  const d = deger.trim();
  if (!d) throw new Error(`${alanAdi} boş olamaz.`);
  if (max && d.length > max) {
    throw new Error(`${alanAdi} en fazla ${max} karakter olabilir (${d.length} verildi).`);
  }
  return d;
}

/** Anahtar kelime doğrulama: metin, ≤80 karakter, URL ve kontrol karakteri yok. */
function kelimeDogrula(kelime, kaynak) {
  const k = guvenliDize(kelime, `${kaynak} anahtar kelimesi`, { max: 80 });
  if (/https?:\/\//i.test(k)) throw new Error(`${kaynak} anahtar kelimesi URL içeremez: '${gorunurOzet(k, 60)}'`);
  return k;
}

function tekrarsiz(liste) {
  const gorulen = new Set();
  const sonuc = [];
  for (const eleman of liste) {
    const anahtar = eleman.toLowerCase();
    if (gorulen.has(anahtar)) continue;
    gorulen.add(anahtar);
    sonuc.push(eleman);
  }
  return sonuc;
}

/** GAQL string sabiti kaçışı (idempotenlik sorgusu için). */
function gaqlKacir(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Çalıştırma damgası: aynı planın tekrar koşulması yeni ad üretir, çakışma erken yakalanır. */
function calistirmaDamgasi(simdi = new Date()) {
  const p = (n, hane = 2) => String(n).padStart(hane, "0");
  return `GB-${simdi.getFullYear()}${p(simdi.getMonth() + 1)}${p(simdi.getDate())}-${p(simdi.getHours())}${p(simdi.getMinutes())}`;
}

/* ── Ana akış ────────────────────────────────────────────────────────────────── */

/**
 * Planı ve kreatifi gerçek hesaba uygular.
 * Dönüş: { kampanyaId?, adGrubuId?, basari, adimlar:[{arac, ozet, sonucOzeti, durum}],
 *          uyarilar:[..], eksikAdimlar:[..] }
 * Hiçbir koşulda set_campaign_status(ENABLED) veya update_campaign_budget çağırmaz.
 */
export async function uygula({ plan, kreatif, musteriId, finalUrl }, { cagir }) {
  const guvenliCagir = guvenliCagirici(cagir);
  const uyarilar = [];
  const adimlar = [];
  const eksikAdimlar = [];

  /* 1) Operatör girdisi doğrulaması — finalUrl ve musteriId YALNIZ buradan gelir. */
  const musteri = guvenliDize(musteriId, "musteriId", { max: 20 });
  if (!/^[0-9-]+$/.test(musteri)) {
    throw new Error("musteriId yalnız rakam ve tire içerebilir (örn. 1234567890).");
  }
  const hedefUrl = guvenliDize(finalUrl, "finalUrl", { max: 2048 });
  if (!/^https?:\/\//i.test(hedefUrl)) {
    throw new Error("finalUrl yalnız http/https ile başlayabilir.");
  }

  /* 2) Köken güvenliği: plan/kreatif kimlik veya hedef alanı taşıyamaz. */
  if (!plan || typeof plan !== "object") throw new Error("plan nesnesi zorunlu.");
  if (!kreatif || typeof kreatif !== "object") throw new Error("kreatif nesnesi zorunlu.");
  yasakAlanTara(plan, "plan");
  yasakAlanTara(kreatif, "kreatif");

  /* 3) Plan içerik doğrulaması (planDogrula'nın üstüne ikinci kemer, fail-closed). */
  const planAdi = guvenliDize(plan.kampanyaAdi, "plan.kampanyaAdi", { max: 200 });
  const butce = plan.butceGunlukTL;
  if (!(typeof butce === "number" && Number.isFinite(butce) && butce > 0)) {
    throw new Error("plan.butceGunlukTL geçersiz: 0'dan büyük sonlu bir sayı olmalı (metin/NaN kabul edilmez).");
  }
  if (typeof plan.hedefUlke !== "string" || !/^[A-Z]{2}$/.test(plan.hedefUlke)) {
    throw new Error("plan.hedefUlke tam 2 büyük harfli ISO alpha-2 kod olmalı (örn. 'TR').");
  }
  const hedefUlke = plan.hedefUlke;
  if (!Array.isArray(plan.adGruplari) || plan.adGruplari.length === 0) {
    throw new Error("plan.adGruplari boş olamaz.");
  }

  const gruplar = plan.adGruplari;
  if (gruplar.length > 1) {
    uyarilar.push("Çok reklam grubu desteklenmiyor — tüm gruplar tek reklam grubunda düzleştirildi.");
  }

  const GECERLI_ESLESME = new Set(["PHRASE", "EXACT", "BROAD"]);
  const tumKelimeler = [];
  const ekstraEslesmeler = new Map(); // matchType -> kelime listesi (EXACT/BROAD)
  for (const grup of gruplar) {
    if (!grup || typeof grup !== "object") throw new Error("plan.adGruplari içindeki her grup nesne olmalı.");
    const tip = grup.eslesmeTipi ?? "PHRASE";
    if (!GECERLI_ESLESME.has(tip)) {
      throw new Error(`Geçersiz eşleme tipi: '${gorunurOzet(String(tip), 30)}' — yalnız PHRASE/EXACT/BROAD.`);
    }
    if (!Array.isArray(grup.anahtarKelimeler) || grup.anahtarKelimeler.length === 0) {
      throw new Error("Boş anahtar kelime listesi olan reklam grubu kabul edilmez.");
    }
    const kelimeListesi = grup.anahtarKelimeler.map((k) => kelimeDogrula(k, "plan"));
    tumKelimeler.push(...kelimeListesi);
    if (tip !== "PHRASE") {
      const eldeki = ekstraEslesmeler.get(tip) ?? [];
      ekstraEslesmeler.set(tip, eldeki.concat(kelimeListesi));
    }
  }
  const kelimeler = tekrarsiz(tumKelimeler);
  if (kelimeler.length > 50) {
    throw new Error(`Toplam ${kelimeler.length} anahtar kelime — create_search_campaign sınırı 50.`);
  }
  if (ekstraEslesmeler.size > 0) {
    uyarilar.push(
      "create_search_campaign kelimeleri PHRASE ekler; EXACT/BROAD kelimeler ayrıca kendi eşleme türüyle eklendi — yayına almadan önce PAUSED taslaktaki PHRASE kopyalarını gözden geçirin."
    );
  }

  let negatifler = [];
  if (plan.negatifKelimeler !== undefined) {
    if (!Array.isArray(plan.negatifKelimeler)) throw new Error("plan.negatifKelimeler bir dizi olmalı.");
    negatifler = tekrarsiz(plan.negatifKelimeler.map((k) => kelimeDogrula(k, "negatif")));
    if (negatifler.length > 100) {
      throw new Error(`Toplam ${negatifler.length} negatif kelime — add_campaign_negative_keywords sınırı 100.`);
    }
  }

  /* 4) Kreatif doğrulaması (kreatifDogrula'nın üstüne ikinci kemer). */
  if (!Array.isArray(kreatif.basliklar)) throw new Error("kreatif.basliklar bir dizi olmalı.");
  const basliklar = tekrarsiz(kreatif.basliklar.map((b, i) => guvenliDize(b, `kreatif.basliklar[${i}]`, { max: 30 })));
  if (basliklar.length < 3 || basliklar.length > 15) {
    throw new Error(`Tekrarsız başlık sayısı ${basliklar.length} — 3 ile 15 arasında olmalı.`);
  }
  if (!Array.isArray(kreatif.aciklamalar)) throw new Error("kreatif.aciklamalar bir dizi olmalı.");
  const aciklamalar = tekrarsiz(
    kreatif.aciklamalar.map((a, i) => guvenliDize(a, `kreatif.aciklamalar[${i}]`, { max: 90 }))
  );
  if (aciklamalar.length < 2 || aciklamalar.length > 4) {
    throw new Error(`Tekrarsız açıklama sayısı ${aciklamalar.length} — 2 ile 4 arasında olmalı.`);
  }
  for (const metin of [...basliklar, ...aciklamalar]) {
    if (/https?:\/\//i.test(metin)) throw new Error("Başlık/açıklama içinde URL olamaz.");
  }

  /* 5) İdempotenlik: damgalı kampanya adı + aynı adlı kampanya ön-kontrolü. */
  const kampanyaAdi = `${calistirmaDamgasi()} — ${planAdi}`.slice(0, 255);
  let kampanyaId;
  let adGrubuId;
  let basari = true;
  let devam = true;

  try {
    const sorgu =
      `SELECT campaign.id, campaign.name FROM campaign ` +
      `WHERE campaign.name = '${gaqlKacir(kampanyaAdi)}' AND campaign.status != 'REMOVED' LIMIT 1`;
    const metin = await guvenliCagir("run_gaql", { customerId: musteri, query: sorgu, limit: 1 });
    const satirSayisi = Number(/^(\d+)\s+satır/.exec(metin.trim())?.[1]);
    if (Number.isFinite(satirSayisi) && satirSayisi > 0) {
      adimlar.push({ arac: "run_gaql", ozet: "idempotenlik kontrolü", sonucOzeti: gorunurOzet(metin), durum: "tamam" });
      uyarilar.push(`"${kampanyaAdi}" adlı kampanya zaten var — tekrar kurulum yapılmadı, tüm adımlar iptal edildi.`);
      devam = false;
      basari = false;
    } else {
      adimlar.push({
        arac: "run_gaql",
        ozet: "idempotenlik kontrolü",
        sonucOzeti: Number.isFinite(satirSayisi) ? "aynı adlı kampanya yok" : gorunurOzet(metin),
        durum: "tamam",
      });
      if (!Number.isFinite(satirSayisi)) {
        uyarilar.push("İdempotenlik kontrolü sonucu çözümlenemedi — damgalı ad benzersiz varsayılarak devam edildi.");
      }
    }
  } catch (e) {
    adimlar.push({
      arac: "run_gaql",
      ozet: "idempotenlik kontrolü",
      sonucOzeti: `Araç hatası: ${gorunurOzet(e?.message ?? "bilinmeyen hata")}`,
      durum: "basarisiz",
    });
    uyarilar.push("İdempotenlik kontrolü yapılamadı — damgalı ad benzersiz varsayılarak devam edildi.");
  }

  /* 6) Yazma adımları — argümanlar alan alan elle kurulur, asla spread edilmez. */
  const grupAdi =
    typeof gruplar[0]?.ad === "string" && gruplar[0].ad.trim() && !KONTROL_KARAKTERI.test(gruplar[0].ad)
      ? gruplar[0].ad.trim().slice(0, 255)
      : undefined;

  const kuyruk = [];
  kuyruk.push({
    arac: "create_search_campaign",
    ozet: `kampanya taslağı (PAUSED): "${gorunurOzet(kampanyaAdi, 120)}", günlük ${butce}, hedef ${hedefUlke}, ${kelimeler.length} kelime`,
    args: () => {
      const a = {
        customerId: musteri,
        name: kampanyaAdi,
        dailyBudget: butce,
        keywords: kelimeler,
        countryCodes: [hedefUlke],
      };
      if (grupAdi) a.adGroupName = grupAdi;
      return a;
    },
    sonra: (metin) => {
      const kimlikler = kimlikAyikla(metin);
      if (!kimlikler.kampanyaId || !kimlikler.adGrubuId) {
        uyarilar.push(
          "Kampanya/reklam grubu ID'si sonuç metninden ayrıştırılamadı — kalan adımlar iptal edildi (tahmin yapılmaz)."
        );
        return false;
      }
      kampanyaId = kimlikler.kampanyaId;
      adGrubuId = kimlikler.adGrubuId;
      return true;
    },
  });
  for (const [tip, ham] of ekstraEslesmeler) {
    const liste = tekrarsiz(ham);
    kuyruk.push({
      arac: "add_keywords",
      ozet: `${liste.length} anahtar kelime [${tip}] yeni reklam grubuna`,
      args: () => ({ customerId: musteri, adGroupId: adGrubuId, keywords: liste, matchType: tip }),
    });
  }
  if (negatifler.length > 0) {
    kuyruk.push({
      arac: "add_campaign_negative_keywords",
      ozet: `${negatifler.length} negatif kelime (kampanya seviyesi)`,
      // campaignId YALNIZ create_search_campaign sonucundan ayrıştırılan değerdir.
      args: () => ({ customerId: musteri, campaignId: kampanyaId, keywords: negatifler, matchType: "PHRASE" }),
    });
  }
  kuyruk.push({
    arac: "create_responsive_search_ad",
    ozet: `RSA: ${basliklar.length} başlık / ${aciklamalar.length} açıklama → ${gorunurOzet(hedefUrl, 80)}`,
    args: () => ({
      customerId: musteri,
      adGroupId: adGrubuId,
      finalUrl: hedefUrl,
      headlines: basliklar,
      descriptions: aciklamalar,
    }),
  });

  for (const adim of kuyruk) {
    if (!devam) {
      adimlar.push({ arac: adim.arac, ozet: adim.ozet, sonucOzeti: "atlandı (önceki adım başarısız)", durum: "atlandi" });
      eksikAdimlar.push(adim.arac);
      continue;
    }
    let metin;
    try {
      metin = await guvenliCagir(adim.arac, adim.args());
    } catch (e) {
      adimlar.push({
        arac: adim.arac,
        ozet: adim.ozet,
        sonucOzeti: `Araç hatası: ${gorunurOzet(e?.message ?? "bilinmeyen hata")}`,
        durum: "basarisiz",
      });
      eksikAdimlar.push(adim.arac);
      devam = false;
      basari = false;
      continue;
    }
    const kirpik = metin.includes(KIRPMA_ISARETI);
    const basarisiz = sonucBasarisizMi(metin);
    adimlar.push({
      arac: adim.arac,
      ozet: adim.ozet,
      sonucOzeti: gorunurOzet(metin),
      durum: basarisiz ? "basarisiz" : kirpik ? "belirsiz" : "tamam",
    });
    if (basarisiz) {
      eksikAdimlar.push(adim.arac);
      devam = false;
      basari = false;
      continue;
    }
    if (kirpik) {
      // Kırpılmış sonuç doğrulanamaz: ID listesi kesilmiş olabilir — fail-closed.
      uyarilar.push(`'${adim.arac}' sonucu kırpılmış — doğrulanamadığı için kalan adımlar iptal edildi.`);
      devam = false;
      basari = false;
      continue;
    }
    if (adim.sonra && !adim.sonra(metin)) {
      devam = false;
      basari = false;
    }
  }

  return { kampanyaId, adGrubuId, basari, adimlar, uyarilar, eksikAdimlar };
}
