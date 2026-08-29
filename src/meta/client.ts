// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Meta (Facebook/Instagram) Marketing API — the second spend domain.
 *
 * WHY THIS EXISTS: the trust gate's central claim is that it is *domain-general* — that
 * "ask the network before a human is prompted" is not a Google Ads feature but a property
 * of any path that moves money. A claim like that is cheap until a second domain sits
 * behind the same gate. This module is that second domain.
 *
 * Deliberately thin. It is a transport, not a strategy layer: create a campaign (always
 * paused), read a budget, change a budget, change a status. Every safety decision — the
 * ceiling, the approval, the network chain — lives in the tool layer and the approval gate,
 * exactly where it lives for Google Ads. Duplicating a guard here would mean two places to
 * get it right and one place to forget.
 *
 * HONESTY: no call in this file has ever reached Meta's servers. There is no access token,
 * no app review, no ad account. The request shapes come from the Marketing API reference.
 * Tests reach this code two ways — the tool tests inject a fake channel, and the budget
 * tests stub `fetch` to drive the real client — but both feed it responses we wrote
 * ourselves. That covers our parsing and our refusals; it says nothing about whether Meta
 * actually answers in these shapes. Green tests are evidence about our decision logic, not
 * about the wire — the same sentence that stood over the CAMARA links until a token arrived.
 */

/** The Graph API version this module is written against. Pinned deliberately: Meta ships
 * breaking changes per version and an unpinned call silently follows the newest one. */
export const GRAPH_SURUM = "v21.0";

/** Meta's campaign objectives, as the Marketing API spells them (OUTCOME_* since v13). */
export type MetaHedef =
  | "OUTCOME_TRAFFIC"
  | "OUTCOME_SALES"
  | "OUTCOME_LEADS"
  | "OUTCOME_AWARENESS"
  | "OUTCOME_ENGAGEMENT"
  | "OUTCOME_APP_PROMOTION";

export type MetaDurum = "ACTIVE" | "PAUSED";

export interface MetaKampanya {
  id: string;
  ad: string;
  durum: MetaDurum;
  /** Günlük bütçe, hesabın para biriminde (minor unit DEĞİL — çeviri istemcide yapılır). */
  gunlukButce?: number;
  /**
   * Rakamın NEREDEN geldiği. Meta bütçeyi iki yerden birinde tutar ve ikisi aynı şey
   * değildir: kampanya düzeyi (CBO) tek bir sayıdır, reklam seti düzeyi ise toplamdır.
   * Onay özetine bunu yazmak, operatörün gördüğü rakamı Ads Manager'da nerede
   * arayacağını bilmesini sağlar.
   */
  butceKaynagi?: "kampanya" | "reklam-setleri";
  /**
   * Bütçe okunamadıysa SEBEBİ — "okunamadı" tek başına operatöre ne yapacağını
   * söylemez. Ret mesajı bu notu aynen taşır.
   */
  butceNotu?: string;
}

/** The capability surface the tools need; the HTTP client is adapted to it. */
export interface MetaKanali {
  kampanyaOlustur(girdi: { ad: string; hedef: MetaHedef; gunlukButce: number }): Promise<MetaKampanya>;
  kampanyaOku(kampanyaId: string): Promise<MetaKampanya>;
  butceGuncelle(kampanyaId: string, gunlukButce: number): Promise<void>;
  durumDegistir(kampanyaId: string, durum: MetaDurum): Promise<void>;
}

/** The config slice this module reads (kept narrow, like AgAyar). */
export interface MetaAyar {
  metaToken?: string;
  /** act_<id> biçiminde ya da çıplak rakam; istemci normalize eder. */
  metaAdAccountId?: string;
}

/**
 * Test seam. Production builds the channel from fetch; tests inject a fake so every
 * refusal path can be exercised (and mutation-tested) without a network or a token.
 */
let kanalOverride: MetaKanali | "reset" | undefined;
export function __setMetaKanalForTests(k: MetaKanali | undefined): void {
  kanalOverride = k ?? "reset";
  gercekKanal = undefined;
  gercekKanalAnahtari = undefined;
}

let gercekKanal: MetaKanali | undefined;
let gercekKanalAnahtari: string | undefined;

/** "act_123" ve "123" aynı hesaba işaret eder; Graph yolu act_ öneki ister. */
export function hesapYolu(ham: string): string {
  const temiz = ham.trim();
  return temiz.startsWith("act_") ? temiz : `act_${temiz.replace(/\D/g, "")}`;
}

/**
 * Meta bütçeleri MINOR UNIT ister (kuruş/cent) ve TAM SAYI bekler.
 *
 * Bu, Google Ads'in micros'una benzeyen ama ölçeği farklı olan ikinci bir tuzak: aynı
 * sayıyı iki API'ye göndermek, birinde 100 kat sapma demektir. Yuvarlama bilerek
 * Math.round: kesme (trunc) her seferinde müşterinin lehine değil ALEYHİNE sapardı ve
 * "1.005 istedim, 1.00 oldu" gibi sessiz bir eksiltme üretirdi.
 */
export function minorUnit(tutar: number): number {
  /**
   * toFixed ARADA DURUYOR ve gerekli: `1.005 * 100` ikili gösterimde 100.49999999999999
   * olur, dolayısıyla düz `Math.round(tutar * 100)` bunu 100'e indirirdi — yani tam da
   * kaçınmak istediğimiz sessiz, müşteri aleyhine eksiltme. Önce sabit basamağa
   * yuvarlayıp sonra tam sayıya çekmek bu sapmayı kapatır.
   */
  return Math.round(Number((tutar * 100).toFixed(4)));
}

/** minorUnit'in tersi — okuma yolunda kullanılır. */
export function minorUnitTers(minor: number): number {
  return minor / 100;
}

/**
 * Upstream hata metnini ajana göstermeden önce temizler.
 *
 * Meta'nın hata gövdeleri istek URL'sini yankılayabilir ve access_token bir SORGU
 * PARAMETRESİDİR — yani ham gövdeyi olduğu gibi göstermek token'ı ajana (ve çalınmış bir
 * oturuma) vermek olurdu. Aynı ders CAMARA tarafında da yaşandı; burada baştan uygulanır.
 */
export function hataTemizle(ham: string, token?: string): string {
  let s = ham.replace(/access_token=[^&\s"']+/gi, "access_token=***");
  if (token && token.length >= 8) s = s.split(token).join("***");
  return s.replace(/\s+/g, " ").slice(0, 300);
}

/** Graph API çağrısı — zaman aşımı sınırlı, token yalnız POST gövdesinde. */
async function graf(
  ayar: MetaAyar,
  yol: string,
  govde: Record<string, string>,
  yontem: "POST" | "GET" = "POST"
): Promise<any> {
  const token = ayar.metaToken!;
  const url = `https://graph.facebook.com/${GRAPH_SURUM}/${yol}`;
  const kontrol = new AbortController();
  /**
   * 15 saniye: onay akışının önünde duran bir çağrı dakikalarca asılı kalamaz. Google
   * tarafındaki CAMARA çağrılarıyla aynı gerekçe — kapalı arıza HIZLI olmalı.
   */
  const zamanlayici = setTimeout(() => kontrol.abort(), 15_000);
  try {
    const istek: RequestInit = { method: yontem, signal: kontrol.signal };
    if (yontem === "POST") {
      istek.headers = { "Content-Type": "application/x-www-form-urlencoded" };
      istek.body = new URLSearchParams({ ...govde, access_token: token }).toString();
    }
    const hedefUrl = yontem === "GET" ? `${url}?${new URLSearchParams({ ...govde, access_token: token })}` : url;
    const cevap = await fetch(hedefUrl, istek);
    const metin = await cevap.text();
    if (!cevap.ok) {
      throw new Error(`Meta API ${cevap.status}: ${hataTemizle(metin, token)}`);
    }
    return metin ? JSON.parse(metin) : {};
  } finally {
    clearTimeout(zamanlayici);
  }
}

/**
 * Tek çağrıda okunacak en fazla reklam seti. Aşılırsa toplam EKSİK olurdu ve eksik bir
 * toplam tavanı yanlışlıkla geçirir — bu yüzden sayfa taşması sessizce kırpılmaz, RET olur.
 */
const REKLAM_SETI_TAVANI = 200;

/**
 * KAMPANYA DÜZEYİNDE BÜTÇE YOKSA REKLAM SETLERİNDEN TOPLA.
 *
 * Meta'da bütçe ya kampanyadadır (CBO) ya da reklam setlerinde. Yalnız `daily_budget`
 * alanına bakmak, CBO olmayan her kampanyayı "bütçesi okunamıyor" durumuna düşürüyordu;
 * o kampanyalar bu araçla yayına alınamıyordu. Doğru çözüm reddi gevşetmek değil,
 * GÖZLEMİ tamamlamaktı: burası o gözlem.
 *
 * Her belirsizlik RET tarafına düşer, çünkü buradan çıkan sayı doğrudan harcama tavanına
 * karşı ölçülüyor: eksik bir toplam, tavanın altında görünen bir aşımdır.
 */
async function reklamSetiButcesi(
  ayar: MetaAyar,
  kampanyaId: string
): Promise<{ gunlukButce?: number; not?: string }> {
  let yanit: any;
  try {
    yanit = await graf(
      ayar,
      `${kampanyaId}/adsets`,
      { fields: "id,name,status,daily_budget,lifetime_budget", limit: String(REKLAM_SETI_TAVANI) },
      "GET"
    );
  } catch (e) {
    return { not: `reklam setleri okunamadı (${e instanceof Error ? e.message : String(e)})` };
  }

  const setler = Array.isArray(yanit?.data) ? yanit.data : undefined;
  if (!setler) return { not: "Meta reklam seti listesi beklenen biçimde gelmedi" };

  /**
   * SAYFA TAŞMASI RET. `paging.next` varsa elimizdeki liste eksiktir ve eksik listeden
   * çıkan toplam GERÇEĞİNDEN KÜÇÜKTÜR — yani tavanı aşan bir kampanya tavanın altında
   * görünür. Sessizce ilk sayfayla yetinmek, kapının en tehlikeli biçimde yanılmasıdır.
   */
  if (yanit?.paging?.next) {
    return {
      not:
        `kampanyada ${REKLAM_SETI_TAVANI}'den fazla reklam seti var; toplam bütçe eksik ` +
        `hesaplanacağı için doğrulanamıyor`,
    };
  }

  /**
   * Yalnız ACTIVE setler harcar. Duraklatılmış bir setin bütçesini toplama katmak,
   * kampanyayı olmadığı kadar pahalı gösterip meşru bir yayına almayı engellerdi.
   * Setin KENDİ `status` alanı doğru olandır: kampanya ACTIVE olduğunda yayına girecek
   * olanlar bunlardır (`effective_status` üst nesnenin bugünkü hâlini de katar).
   */
  const aktif = setler.filter((r: any) => String(r?.status) === "ACTIVE");
  if (!aktif.length) {
    return {
      not:
        "kampanyada ACTIVE reklam seti yok — yayına alınsa da gösterim yapamaz " +
        "(Google tarafındaki 'yayınlanabilir reklam yok' kuralının Meta karşılığı)",
    };
  }

  let toplamMinor = 0;
  for (const r of aktif) {
    const ad = String(r?.name ?? r?.id ?? "adsız");
    const gunluk = r?.daily_budget;
    if (gunluk !== undefined && gunluk !== null && Number.isFinite(Number(gunluk))) {
      toplamMinor += Number(gunluk);
      continue;
    }
    /**
     * ÖMÜRLÜK BÜTÇE GÜNLÜK TAVANA ÇEVRİLEMEZ. Toplam tutarı süreye bölmek bir tahmindir
     * ve Meta teslimatı gün içinde öne yükleyebilir; tahmini gerçek bir tavanmış gibi
     * ölçmek, kapının doğruladığını sandığı ama doğrulamadığı bir sayı üretir.
     */
    if (r?.lifetime_budget !== undefined && r?.lifetime_budget !== null) {
      return { not: `"${ad}" reklam seti ömürlük bütçe kullanıyor; günlük tavana çevrilemez` };
    }
    return { not: `"${ad}" reklam setinin günlük bütçesi okunamadı` };
  }

  // Minor unit'ler ÖNCE tam sayı olarak toplanır: her set için ayrı ayrı bölmek
  // kayan nokta artığı biriktirirdi.
  return { gunlukButce: minorUnitTers(toplamMinor) };
}

/**
 * Gerçek kanal. Önbellek token + hesap kimliğine göre anahtarlanır — anahtarsız bir
 * singleton ilk çağıranın hesabını sonsuza dek kapatırdı (CAMARA tarafında yaşanan
 * hatanın aynısı).
 */
export function metaKanali(ayar: MetaAyar): MetaKanali {
  if (kanalOverride && kanalOverride !== "reset") return kanalOverride;
  const anahtar = `${ayar.metaToken}\u0000${ayar.metaAdAccountId}`;
  if (gercekKanal && gercekKanalAnahtari === anahtar) return gercekKanal;

  const hesap = hesapYolu(ayar.metaAdAccountId!);
  gercekKanal = {
    async kampanyaOlustur({ ad, hedef, gunlukButce }) {
      /**
       * status: "PAUSED" BURADA SABİTTİR ve parametre DEĞİLDİR.
       *
       * Google tarafındaki söz ("kampanyalar her zaman duraklatılmış oluşur") bu alanda da
       * geçerli olmalı; çağıranın onu geçebilmesi, sözü çağrı yerine bırakmak demekti.
       * Yayına alma ayrı bir araçtır ve insan onayı + ağ zinciri ister.
       */
      const cevap = await graf(ayar, `${hesap}/campaigns`, {
        name: ad,
        objective: hedef,
        status: "PAUSED",
        special_ad_categories: "[]",
        daily_budget: String(minorUnit(gunlukButce)),
      });
      return { id: String(cevap.id), ad, durum: "PAUSED", gunlukButce };
    },
    async kampanyaOku(kampanyaId) {
      const c = await graf(ayar, kampanyaId, { fields: "id,name,status,daily_budget" }, "GET");
      const temel = {
        id: String(c.id),
        ad: String(c.name ?? ""),
        durum: (c.status === "ACTIVE" ? "ACTIVE" : "PAUSED") as MetaDurum,
      };

      const kampanyaDuzeyi = c.daily_budget;
      if (kampanyaDuzeyi !== undefined && kampanyaDuzeyi !== null && Number.isFinite(Number(kampanyaDuzeyi))) {
        return { ...temel, gunlukButce: minorUnitTers(Number(kampanyaDuzeyi)), butceKaynagi: "kampanya" };
      }

      // CBO değil: bütçe reklam setlerinde. Tek bir alana bakıp "okunamadı" demek yerine
      // ikinci katmana inilir.
      const setler = await reklamSetiButcesi(ayar, kampanyaId);
      return {
        ...temel,
        gunlukButce: setler.gunlukButce,
        butceKaynagi: "reklam-setleri",
        butceNotu: setler.not,
      };
    },
    async butceGuncelle(kampanyaId, gunlukButce) {
      await graf(ayar, kampanyaId, { daily_budget: String(minorUnit(gunlukButce)) });
    },
    async durumDegistir(kampanyaId, durum) {
      await graf(ayar, kampanyaId, { status: durum });
    },
  };
  gercekKanalAnahtari = anahtar;
  return gercekKanal;
}
