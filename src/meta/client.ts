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
 * HONESTY: this file reached Meta's servers for the first time on 2 September 2026, and the
 * distinction it used to disclaim is now settled by evidence rather than by promise.
 *
 * The offline tests still only prove our side: the tool tests inject a fake channel and the
 * budget tests stub `fetch`, so both feed this code responses we wrote ourselves. They cover
 * our parsing and our refusals and say nothing about whether Meta answers in these shapes.
 * What closes that gap is `npm run metatest`, which drives the real client against the live
 * Marketing API — including a real campaign creation that confirms the campaign is born
 * PAUSED, is read back from Meta as PAUSED, and survives the minor-unit round trip intact.
 *
 * Keep both. Green unit tests are evidence about decision logic; only the live run is
 * evidence about the wire, and conflating the two is how a suite starts lying.
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

/**
 * OKUMADA görülebilen durumlar. Yazarken yalnız ACTIVE/PAUSED gönderilir (MetaDurum),
 * ama Meta okurken ARCHIVED ve DELETED de döndürür. Bunları PAUSED'a katlamak
 * "arşivlenmiş" ile "duraklatılmış"ı aynı şey saymaktı; ikisi aynı şey değildir.
 */
export type MetaOkunanDurum = MetaDurum | "ARCHIVED" | "DELETED";

export interface MetaKampanya {
  id: string;
  ad: string;
  /**
   * Meta'nın bildirdiği durum — YALNIZ kesin okunduysa.
   *
   * Eskiden bu alan `status === "ACTIVE" ? ACTIVE : PAUSED` ile üretiliyordu: alan hiç
   * gelmediğinde, tipi beklenmedik olduğunda ya da Meta yeni bir enum eklediğinde sonuç
   * "PAUSED" oluyordu — yani "bilinmiyor", "harcamıyor" diye raporlanıyordu. Bu alana
   * bakacak İLK kapı o gün sessizce fail-open olurdu. undefined artık "bilinmiyor"
   * demektir ve tüketici onu temiz sayamaz.
   */
  durum?: MetaOkunanDurum;
  /** Durum okunamadıysa SEBEBİ — ret/rapor metinleri bunu aynen taşıyabilsin diye. */
  durumNotu?: string;
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
 * Bir Meta minor-unit alanını TAM SAYIYA çevirir — ya da okunamadığını söyler.
 *
 * `Number.isFinite(Number(x))` yetmez ve tam da bu yüzden değiştirildi: `Number("")`,
 * `Number(" ")` ve `Number([])` sıfırdır, `Number(true)` birdir. O kısayolla okunamayan
 * bir bütçe sessizce 0 sayılıyor, toplam gerçeğinden küçük çıkıyor ve harcama tavanı
 * yeşil yanıyordu. write.ts'teki `mikrodanTutar` sözleşmesinin aynısı burada da geçerli:
 * ÖNCE tip, SONRA sayı.
 *
 * Meta minor unit'leri her zaman negatif olmayan TAM SAYIDIR; "1e3", "12.5", "-100" gibi
 * değerler Meta'nın göndermediği biçimlerdir ve "belki de şudur" diye yorumlanmaz — kapalı
 * arıza tarafına düşer.
 */
export function minorTutar(ham: unknown): number | undefined {
  if (typeof ham === "number") return Number.isSafeInteger(ham) && ham >= 0 ? ham : undefined;
  if (typeof ham !== "string") return undefined;
  const s = ham.trim();
  if (!/^\d+$/.test(s)) return undefined;
  const sayi = Number(s);
  return Number.isSafeInteger(sayi) ? sayi : undefined;
}

/**
 * Hesabın para birimi ve minor-unit ÇARPANI.
 *
 * Çarpan para birimine göre DEĞİŞİR: USD'de 1 birim = 100 cent, JPY'de 1 birim = 1 yen.
 * Bu yüzden çarpan tahmin edilmez, hesaptan okunur (bkz. paraBirimiCoz).
 */
export interface MetaParaBirimi {
  kod: string;
  carpan: number;
}

/**
 * `/act_<id>?fields=currency,currency_offset` gövdesinden para birimi çözümü — KAPALI ARIZA.
 *
 * Alan yoksa, tipi beklenmedikse ya da çarpan pozitif tam sayı değilse undefined döner.
 * Varsayılan olarak 100'e düşmek, işin en tehlikeli hâlini ("hesap JPY ama biz USD
 * sanıyoruz") normal gibi gösterirdi: yazarken 100 kat fazla harcatır, okurken gerçek
 * bütçeyi yüzde birine indirip tavan kapısını kör eder.
 */
export function paraBirimiCoz(govde: any): MetaParaBirimi | undefined {
  const kod = govde?.currency;
  if (typeof kod !== "string" || !/^[A-Za-z]{3}$/.test(kod.trim())) return undefined;
  const carpan = minorTutar(govde?.currency_offset);
  // 0 çarpan sıfıra bölme, saçma büyüklükteki çarpan da okunmuş bir değer değil bir arızadır.
  if (carpan === undefined || carpan < 1 || carpan > 1_000_000) return undefined;
  return { kod: kod.trim().toUpperCase(), carpan };
}

/**
 * Meta bütçeleri MINOR UNIT ister (kuruş/cent/yen) ve TAM SAYI bekler.
 *
 * Bu, Google Ads'in micros'una benzeyen ama ölçeği farklı olan ikinci bir tuzak: aynı
 * sayıyı iki API'ye göndermek, birinde 100 kat sapma demektir. Yuvarlama bilerek
 * Math.round: kesme (trunc) her seferinde müşterinin lehine değil ALEYHİNE sapardı ve
 * "1.005 istedim, 1.00 oldu" gibi sessiz bir eksiltme üretirdi.
 *
 * ÇARPAN ZORUNLU PARAMETRE, varsayılanı YOK: varsayılan 100 olsaydı çağrı yerlerinden
 * birinin onu geçmeyi unutması JPY bir hesapta 100 katlık sessiz sapma demek olurdu.
 * Unutulduğunda derleme durur; sessizce yanlış para gitmez.
 */
export function minorUnit(tutar: number, carpan: number): number {
  carpanDogrula(carpan);
  /**
   * toFixed ARADA DURUYOR ve gerekli: `1.005 * 100` ikili gösterimde 100.49999999999999
   * olur, dolayısıyla düz `Math.round(tutar * 100)` bunu 100'e indirirdi — yani tam da
   * kaçınmak istediğimiz sessiz, müşteri aleyhine eksiltme. Önce sabit basamağa
   * yuvarlayıp sonra tam sayıya çekmek bu sapmayı kapatır.
   */
  return Math.round(Number((tutar * carpan).toFixed(4)));
}

/** minorUnit'in tersi — okuma yolunda kullanılır. */
export function minorUnitTers(minor: number, carpan: number): number {
  carpanDogrula(carpan);
  return minor / carpan;
}

/**
 * Çarpan doğrulaması. Fırlatmak bilerek: okunamamış bir çarpanla üretilen sayı tavan
 * kapısına yanlış bir rakam sokardı — sessizce NaN/Infinity üretmektense hiç üretmemek.
 */
function carpanDogrula(carpan: number): void {
  if (!Number.isInteger(carpan) || carpan < 1) {
    throw new Error("Meta para birimi çarpanı okunmadan bütçe çevrilemez (kapalı arıza)");
  }
}

/**
 * Beklenmedik bir alan değerini nota koymadan ÖNCE zararsızlaştırır.
 *
 * Operatör "neyi düzelteceğini" ancak gördüğümüz değeri söylersek bilir; ama ham upstream
 * içeriğini olduğu gibi taşımak bu deponun her yerinde yasak (jeton/PII riski). Ortası:
 * tip adı, ya da yalnız harf-rakam bırakılmış kısa bir örnek.
 */
export function gorunurDeger(x: unknown): string {
  if (x === undefined) return "alan yok";
  if (x === null) return "null";
  if (typeof x === "string") return `"${x.replace(/[^A-Za-z0-9_\- ]/g, "?").slice(0, 32)}"`;
  if (Array.isArray(x)) return "dizi";
  return typeof x;
}

/**
 * Reklam setinin durumu — BEYAZ LİSTE. Tanınmayan her şey undefined'dır.
 *
 * Eskiden burada `String(r?.status) === "ACTIVE"` filtresi vardı ve tanınmayan durum
 * sessizce "harcamıyor" tarafına düşüyordu: `"active"`, alan yok, `["ACTIVE"]`,
 * `"ACTIVE_LEARNING"` gibi her değer seti toplamdan DÜŞÜRÜYORDU. Eksik toplam ise
 * tavanın altında görünen bir aşımdır — kapının en tehlikeli biçimde yanılması.
 */
export function setDurumu(ham: unknown): "ACTIVE" | "PASIF" | undefined {
  if (ham === "ACTIVE") return "ACTIVE";
  if (ham === "PAUSED" || ham === "ARCHIVED" || ham === "DELETED") return "PASIF";
  return undefined;
}

/** Kampanya durumunun KESİN okunması — beyaz liste; tanınmayan değer "bilinmiyor"dur. */
export function kampanyaDurumu(ham: unknown): { durum?: MetaOkunanDurum; not?: string } {
  if (ham === "ACTIVE" || ham === "PAUSED" || ham === "ARCHIVED" || ham === "DELETED") {
    return { durum: ham };
  }
  return {
    not:
      `Meta kampanya durumu okunamadı (status: ${gorunurDeger(ham)}); ` +
      `"duraklatılmış" varsayılmadı — bilinmeyen durum harcamıyor demek değildir`,
  };
}

/**
 * Upstream hata metnini ajana göstermeden önce temizler.
 *
 * Meta'nın hata gövdeleri istek URL'sini yankılayabilir ve access_token bir SORGU
 * PARAMETRESİDİR — yani ham gövdeyi olduğu gibi göstermek token'ı ajana (ve çalınmış bir
 * oturuma) vermek olurdu. Aynı ders CAMARA tarafında da yaşandı; burada baştan uygulanır.
 */
/** Bir istisnadan metin çıkarır — `String(e)` ile aynı, ama tek yerde. */
function hataMetni(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
  kampanyaId: string,
  carpan: number
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
    /**
     * SEBEP AJANA GİDER, AMA HAM GİTMEZ.
     *
     * Bu not `butceNotu` olarak set_meta_campaign_status'ün ret metnine giriyor, yani
     * doğrudan ajanın gördüğü yüzeye. `graf` yalnız HTTP hatalarını temizliyordu; 200 +
     * JSON olmayan gövdede atılan SyntaxError'ın mesajı UPSTREAM GÖVDENİN ÖNEKİNİ taşır
     * ve buradan maskesiz, tavansız geçerdi. hataTemizle hem access_token'ı hem jetonun
     * kendisini siler, hem de 300 karakterde keser.
     */
    return { not: `reklam setleri okunamadı (${hataTemizle(hataMetni(e), ayar.metaToken)})` };
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
   *
   * DURUMU OKUNAMAYAN SET TOPLAMI GEÇERSİZ KILAR — atlanmaz. Eski filtre bir beyaz liste
   * gibi görünüyordu ama sessiz bir ELEME idi: tanınmayan durum "harcamıyor" sayılıyor ve
   * o setin bütçesi toplamdan düşüyordu. Karışık bir listede (biri tanınır, biri tanınmaz)
   * bu, tavanın altında görünen bir aşım üretir. Bilinmeyen durum, bilinmeyen bütçeyle
   * aynı disipline tabidir: RET + sebebi söyleyen not.
   */
  const aktif: any[] = [];
  for (const r of setler) {
    const durum = setDurumu(r?.status);
    if (durum === undefined) {
      return {
        not:
          `"${setAdi(r)}" reklam setinin durumu okunamadı (status: ${gorunurDeger(r?.status)}); ` +
          `harcayıp harcamadığı bilinmeden toplam bütçe güvenilir değil`,
      };
    }
    if (durum === "ACTIVE") aktif.push(r);
  }
  if (!aktif.length) {
    return {
      not:
        "kampanyada ACTIVE reklam seti yok — yayına alınsa da gösterim yapamaz " +
        "(Google tarafındaki 'yayınlanabilir reklam yok' kuralının Meta karşılığı)",
    };
  }

  let toplamMinor = 0;
  for (const r of aktif) {
    const ad = setAdi(r);
    const gunluk = minorTutar(r?.daily_budget);
    if (gunluk !== undefined) {
      toplamMinor += gunluk;
      continue;
    }
    /**
     * ALAN VAR AMA OKUNAMIYOR ile ALAN YOK farklı şeylerdir; ikisi de RET, ama sebepleri
     * ayrı yazılır. `""`, `" "`, `[]`, `true` gibi değerler eski kodda `Number()` ile
     * sıfıra/bire çevrilip toplama giriyordu — bu, tavanı yeşil yakan sessiz eksiltmeydi.
     */
    if (r?.daily_budget !== undefined && r?.daily_budget !== null) {
      return {
        not:
          `"${ad}" reklam setinin günlük bütçesi okunamadı ` +
          `(beklenmedik değer: ${gorunurDeger(r.daily_budget)})`,
      };
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
  return { gunlukButce: minorUnitTers(toplamMinor, carpan) };
}

/**
 * Ret mesajında setin ANILACAĞI ad. Yalnız gerçekten dize/sayı olan alanlar kullanılır:
 * `String(nesne)` "[object Object]" üretip operatöre hiçbir şey söylemezdi.
 */
function setAdi(r: any): string {
  const ham = typeof r?.name === "string" && r.name.trim() !== "" ? r.name : r?.id;
  if (typeof ham === "string" || typeof ham === "number") return String(ham).slice(0, 80);
  return "adsız";
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

  /**
   * PARA BİRİMİ HESAPTAN OKUNUR, VARSAYILMAZ.
   *
   * Minor-unit çarpanı hesabın para birimine bağlıdır (USD 100, JPY 1). Sabit ×100,
   * JPY bir hesapta yazarken 100 KAT fazla harcatır, okurken de gerçek bütçeyi yüzde
   * birine indirip tavan kapısını kör eder — üstelik insana onaylattığımız rakam da
   * yanlış olurdu. Çarpan okunamazsa hiçbir bütçe yazılmaz ve hiçbir bütçe "doğrulandı"
   * sayılmaz.
   *
   * Değer hesap başına sabittir ve kanal zaten jeton+hesap anahtarıyla önbelleklendiği
   * için burada tutmak güvenli. HATA ÖNBELLEKLENMEZ: geçici bir ağ arızası hesabı
   * oturum boyunca kilitlememeli.
   */
  let paraBirimi: MetaParaBirimi | undefined;
  const paraBirimiAl = async (): Promise<MetaParaBirimi> => {
    if (paraBirimi) return paraBirimi;
    let govde: any;
    try {
      govde = await graf(ayar, hesap, { fields: "currency,currency_offset" }, "GET");
    } catch (e) {
      /**
       * Ağ arızası ile "alan gelmedi" AYNI SONUCU doğurur (çarpan bilinmiyor), bu yüzden
       * aynı cümleyle bildirilir: ret mesajını okuyan operatör tek bir sebep arar.
       */
      // Bu mesaj da `butceNotu` üzerinden ajana ulaşıyor: ham upstream metni
      // hataTemizle'siz taşımak jetonu ve gövde önekini ajana vermek olurdu.
      throw new Error(
        `Meta hesabının para birimi okunamadı (${hataTemizle(hataMetni(e), ayar.metaToken)})`
      );
    }
    const cozum = paraBirimiCoz(govde);
    if (!cozum) {
      throw new Error(
        "Meta hesabının para birimi okunamadı (currency/currency_offset alanları " +
          "beklenen biçimde gelmedi); minor-unit çarpanı bilinmeden bütçe ne yazılabilir " +
          "ne doğrulanabilir"
      );
    }
    paraBirimi = cozum;
    return cozum;
  };

  gercekKanal = {
    async kampanyaOlustur({ ad, hedef, gunlukButce }) {
      /**
       * status: "PAUSED" BURADA SABİTTİR ve parametre DEĞİLDİR.
       *
       * Google tarafındaki söz ("kampanyalar her zaman duraklatılmış oluşur") bu alanda da
       * geçerli olmalı; çağıranın onu geçebilmesi, sözü çağrı yerine bırakmak demekti.
       * Yayına alma ayrı bir araçtır ve insan onayı + ağ zinciri ister.
       */
      // Para birimi ÖNCE okunur: okunamıyorsa kampanya hiç oluşturulmaz (yanlış ölçekli
      // bir bütçeyle kampanya doğurmaktansa hiç doğurmamak).
      const { carpan } = await paraBirimiAl();
      const cevap = await graf(ayar, `${hesap}/campaigns`, {
        name: ad,
        objective: hedef,
        status: "PAUSED",
        special_ad_categories: "[]",
        daily_budget: String(minorUnit(gunlukButce, carpan)),
      });
      return { id: String(cevap.id), ad, durum: "PAUSED", gunlukButce };
    },
    async kampanyaOku(kampanyaId) {
      const c = await graf(ayar, kampanyaId, { fields: "id,name,status,daily_budget" }, "GET");
      const durum = kampanyaDurumu(c?.status);
      const temel: MetaKampanya = {
        id: String(c.id),
        ad: String(c.name ?? ""),
        durum: durum.durum,
        durumNotu: durum.not,
      };

      /**
       * Para birimi okunamadıysa BÜTÇE RAKAMI ÜRETİLMEZ. Fırlatmak yerine notla dönmek
       * bilerek: tüketici kapı (set_meta_campaign_status) "bütçe doğrulanamadı" retini
       * zaten sebebiyle birlikte basıyor; operatör böylece neyi düzelteceğini öğrenir.
       */
      let carpan: number;
      try {
        carpan = (await paraBirimiAl()).carpan;
      } catch (e) {
        // Savunma derinliği: kaynaktaki metin zaten temizlenmiş olsa da bu sınır
        // ajana bakıyor, dolayısıyla temizlik burada da uygulanır.
        return { ...temel, butceNotu: hataTemizle(hataMetni(e), ayar.metaToken) };
      }

      const kampanyaDuzeyi = minorTutar(c?.daily_budget);
      if (kampanyaDuzeyi !== undefined) {
        return { ...temel, gunlukButce: minorUnitTers(kampanyaDuzeyi, carpan), butceKaynagi: "kampanya" };
      }
      /**
       * ALAN VAR AMA OKUNAMIYORSA reklam setlerine İNİLMEZ: alanın varlığı kampanyanın
       * CBO olduğunu söyler, okunamaması ise bir belirsizliktir. Set toplamına düşmek,
       * kampanya düzeyindeki gerçek bütçeyi hiç saymadan bir rakam üretirdi.
       */
      if (c?.daily_budget !== undefined && c?.daily_budget !== null) {
        return {
          ...temel,
          butceKaynagi: "kampanya",
          butceNotu:
            `kampanya düzeyi günlük bütçe okunamadı ` +
            `(beklenmedik değer: ${gorunurDeger(c.daily_budget)})`,
        };
      }

      // CBO değil: bütçe reklam setlerinde. Tek bir alana bakıp "okunamadı" demek yerine
      // ikinci katmana inilir.
      const setler = await reklamSetiButcesi(ayar, kampanyaId, carpan);
      return {
        ...temel,
        gunlukButce: setler.gunlukButce,
        butceKaynagi: "reklam-setleri",
        butceNotu: setler.not,
      };
    },
    async butceGuncelle(kampanyaId, gunlukButce) {
      // Yazma yolunda da çarpan önce okunur; okunamazsa istek HİÇ gitmez.
      const { carpan } = await paraBirimiAl();
      await graf(ayar, kampanyaId, { daily_budget: String(minorUnit(gunlukButce, carpan)) });
    },
    async durumDegistir(kampanyaId, durum) {
      await graf(ayar, kampanyaId, { status: durum });
    },
  };
  gercekKanalAnahtari = anahtar;
  return gercekKanal;
}
