// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KANALLAR ARASI BÜTÇE DAĞITIMI — Growth Brain'in hedefi kanallara bölme adımı.
 *
 * Neden ayrı bir adım: "günlük 50 TL" bir hedefin cevabı değil, girdisidir. Arama
 * niyeti güçlü bir hedef (birinin aradığı bir şeyi satmak) ile keşif odaklı bir hedef
 * (kimsenin aramadığı bir şeyi tanıtmak) aynı bütçeyi aynı yere koymaz. Bu adım o kararı
 * modele verdirir ve GEREKÇESİNİ kayda geçirir.
 *
 * İKİ SERT KURAL — ikisi de "uydurmama" ilkesinin uygulaması:
 *
 * 1) YALNIZ YAPILANDIRILMIŞ KANALA PAY VERİLİR. Meta jetonu yoksa Meta bir seçenek
 *    değildir; modele "istersen Meta'ya da ayır" demek, çalışmayacak bir plan üretmek ve
 *    onu kullanıcıya öneri diye sunmak olurdu. Kullanılabilir kanal kümesi ortamdan
 *    OKUNUR, modele sorulmaz.
 *
 * 2) TOPLAM, OPERATÖRÜN VERDİĞİ SAYIYI AŞAMAZ. Bu göründüğünden önemli: sunucudaki
 *    bütçe tavanı KAMPANYA BAŞINADIR. 50 TL tavanlı bir hesapta 40 TL Google + 40 TL Meta
 *    dağıtımının her parçası tavanın altındadır ama toplam 80 TL eder — yani kelepçe,
 *    çok kanallı bir planda kendiliğinden toplamı korumaz. Onu burada korumak zorundayız.
 */

/** Bu depoda desteklenen harcama kanalları. Yeni platform buraya eklenir. */
export const KANALLAR = /** @type {const} */ (["google", "meta"]);

/**
 * Ortamda GERÇEKTEN yapılandırılmış kanalları döndürür.
 *
 * Google her zaman vardır: kimlik bilgileri olmadan CLI zaten başlamaz. Meta yalnız
 * jetonu VE reklam hesabı birlikte tanımlıysa sayılır — biri eksikken araç zaten kapalı
 * arızaya gider, dolayısıyla ona pay ayırmak boş bir vaat olurdu.
 */
export function kullanilabilirKanallar(env = process.env) {
  const kanallar = ["google"];
  if (env.ADSPILOT_META_TOKEN?.trim() && env.ADSPILOT_META_AD_ACCOUNT_ID?.trim()) {
    kanallar.push("meta");
  }
  return kanallar;
}

const DAGITIM_SEMA = {
  tur: "nesne",
  zorunlu: ["dagitim"],
  alanlar: {
    dagitim: "dizi",
  },
};

/**
 * Dağıtımı doğrular. İhlalde Türkçe Error fırlatır — sessiz düzeltme YOK.
 *
 * Sessiz düzeltmenin (payları normalize edip devam etmenin) cazibesi büyük ama yanlış:
 * modelin toplamı tutturamaması, planın geri kalanına da güvenilemeyeceğinin işaretidir.
 * Sayıyı biz düzeltirsek, kullanıcı modelin ürettiği plana bakıp bizim ürettiğimiz
 * bütçeyi görür.
 */
export function dagitimDogrula(dagitim, toplamButce, kanallar) {
  if (!Array.isArray(dagitim) || dagitim.length === 0) {
    throw new Error("Bütçe dağıtımı boş — en az bir kanala pay verilmeli.");
  }

  const gorulen = new Set();
  let toplam = 0;

  for (const pay of dagitim) {
    const kanal = String(pay?.kanal ?? "").trim().toLowerCase();
    if (!kanallar.includes(kanal)) {
      throw new Error(
        `Bütçe dağıtımında yapılandırılmamış kanal: "${kanal}". ` +
          `Kullanılabilir kanallar: ${kanallar.join(", ")}. ` +
          `Yapılandırılmamış bir kanala pay ayırmak, çalışmayacak bir planı öneri diye sunmaktır.`
      );
    }
    if (gorulen.has(kanal)) {
      throw new Error(`Bütçe dağıtımında "${kanal}" kanalı birden çok kez geçiyor.`);
    }
    gorulen.add(kanal);

    const tutar = Number(pay?.gunlukButce);
    if (!Number.isFinite(tutar) || tutar <= 0) {
      throw new Error(`"${kanal}" kanalının günlük bütçesi geçersiz: ${pay?.gunlukButce}`);
    }
    if (!String(pay?.gerekce ?? "").trim()) {
      throw new Error(
        `"${kanal}" kanalına pay verilmiş ama GEREKÇE yok. ` +
          `Gerekçesiz dağıtım denetlenemez: kullanıcı neden o kanala o parayı koyduğumuzu göremez.`
      );
    }
    toplam += tutar;
  }

  /**
   * Kuruş toleransı: model 33.33 + 33.33 + 33.34 gibi bölerse toplam kayan noktada
   * tam tutmayabilir. Tolerans DAR tutulur — 1 kuruş, yuvarlama payıdır; daha genişi
   * gerçek bir hatayı gizlemeye başlar.
   */
  const sapma = Math.abs(toplam - toplamButce);
  if (sapma > 0.01) {
    throw new Error(
      `Bütçe dağıtımının toplamı verilen bütçeyle uyuşmuyor: ${toplam.toFixed(2)} ≠ ${toplamButce}. ` +
        `Sunucudaki bütçe tavanı KAMPANYA BAŞINADIR, yani çok kanallı bir planda toplamı ` +
        `kendiliğinden korumaz — toplamı burada tutmak zorundayız.`
    );
  }

  return dagitim.map((p) => ({
    kanal: String(p.kanal).trim().toLowerCase(),
    gunlukButce: Number(p.gunlukButce),
    gerekce: String(p.gerekce).trim(),
  }));
}

/**
 * Bütçeyi kanallara böler.
 *
 * Tek kanal varsa modele HİÇ sorulmaz: sorulacak bir şey yoktur ve bir LLM çağrısını
 * cevabı belli bir soruya harcamak, hem para hem de hata yüzeyi eklemektir.
 */
export async function butceDagit({ hedef, toplamButce, kanallar, arastirma }, { jsonUret2 }) {
  if (kanallar.length === 1) {
    return [
      {
        kanal: kanallar[0],
        gunlukButce: toplamButce,
        gerekce: `Tek yapılandırılmış kanal (${kanallar[0]}) — bölünecek başka kanal yok.`,
      },
    ];
  }

  const sistem =
    "Sen bir dijital pazarlama bütçe stratejistisin. Verilen günlük bütçeyi, YALNIZ " +
    "kullanılabilir kanallar arasında böleceksin. Kurallar: (1) payların TOPLAMI verilen " +
    "bütçeye EŞİT olmalı; (2) yalnız listelenen kanalları kullan; (3) her pay için kısa ve " +
    "somut bir gerekçe yaz — 'daha iyi performans' gibi boş ifadeler değil, hedefe özgü bir " +
    "sebep. Arama niyeti yüksek hedeflerde arama ağırlığı, keşif/farkındalık hedeflerinde " +
    "sosyal ağırlık mantıklıdır. Yalnız JSON döndür.";

  const kullanici =
    `Hedef: ${hedef}\n` +
    `Günlük toplam bütçe: ${toplamButce}\n` +
    `Kullanılabilir kanallar: ${kanallar.join(", ")}\n` +
    `Pazar özeti: ${arastirma?.pazarOzeti ?? "(yok)"}\n` +
    `Hedef kitle: ${arastirma?.hedefKitle ?? "(yok)"}\n\n` +
    `Şu biçimde JSON döndür:\n` +
    `{"dagitim":[{"kanal":"google","gunlukButce":30,"gerekce":"..."}]}`;

  const cevap = await jsonUret2(sistem, kullanici, DAGITIM_SEMA);
  return dagitimDogrula(cevap?.dagitim, toplamButce, kanallar);
}

/** Rapor ve terminal için tek satırlık özet. */
export function dagitimOzeti(dagitim) {
  return dagitim.map((p) => `${p.kanal}: ${p.gunlukButce}`).join(" · ");
}
