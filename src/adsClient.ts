// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Google Ads access, scoped to one user.
 *
 * AdsContext carries a single user credentials and guardrails. Reads retry on
 * transient errors; mutations deliberately do not, except for CONCURRENT_MODIFICATION
 * where the API rejects the write outright and asks for a retry.
 */
import { GoogleAdsApi, Customer } from "google-ads-api";
import { loadConfig, AegisConfig } from "./config.js";
import { normalizeCustomerId, withRetry, isConcurrentModificationError, normalizeGaql } from "./util.js";

export { normalizeCustomerId, formatAdsError } from "./util.js";
export type { AegisConfig } from "./config.js";

/**
 * Tek hesap kaydı. `erisilemedi` ⇒ hesabın detayları okunamadı: yönetici olup olmadığı
 * BİLİNMİYOR, kampanya için kullanılamaz. `yonetici: false` burada "bilinmiyor" demektir,
 * "reklam hesabı" demek DEĞİLDİR.
 */
export interface HesapKaydi {
  id: string;
  ad: string;
  yonetici: boolean;
  erisilemedi?: boolean;
}

/**
 * Hesap listesi + listenin neyi kaçırdığı.
 *
 * `eksik.var` true iken liste TAM DEĞİLDİR ve çağıran bunu kullanıcıya taşımak
 * zorundadır: kırpılmış listeyi "hesabın tamamı" diye sunmak, aranan hesap listede
 * olmadığında ajanı "öyle bir hesabınız yok" sonucuna götürür.
 */
export interface HesapSonucu {
  liste: HesapKaydi[];
  eksik: {
    var: boolean;
    /** Erişilebilir görünen ama detayı okunamayan üst hesaplar. */
    okunamayan: string[];
    /** Üst hesap sayısı tavanı aştı: listede hiç görünmeyen üst hesaplar var. */
    ustHesapKirpildi: boolean;
    /** Alt hesap listesi tavana dayanan MCC'ler. */
    altHesabiKirpilan: string[];
  };
}

/**
 * Per-user Google Ads context. In hosted (multi-user) mode every user gets their
 * own context; in stdio mode a single context is built from the environment.
 * Tools talk to the context they are handed, never to global config.
 */
export class AdsContext {
  private api: GoogleAdsApi;

  constructor(public readonly config: AegisConfig) {
    this.api = new GoogleAdsApi({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      developer_token: config.developerToken,
    });
  }

  getCustomer(customerId: string): Customer {
    const nid = normalizeCustomerId(customerId);
    if (nid.length !== 10) {
      throw new Error(
        `Geçersiz müşteri ID: '${customerId}' — Google Ads müşteri ID'si 10 hanelidir (örn. 1234567890). list_accounts ile doğru ID'yi bul.`
      );
    }
    return this.api.Customer({
      customer_id: nid,
      refresh_token: this.config.refreshToken,
      login_customer_id: this.config.loginCustomerId
        ? normalizeCustomerId(this.config.loginCustomerId)
        : undefined,
    });
  }

  async listAccessibleCustomers(): Promise<string[]> {
    const res = await withRetry(() => this.api.listAccessibleCustomers(this.config.refreshToken));
    return res.resource_names.map((rn: string) => rn.replace("customers/", ""));
  }

  /**
   * Every accessible account (MCC sub-accounts included), briefly cached.
   *
   * `listAccessibleCustomers` returns top-level accounts only, so the sub-accounts
   * where campaigns actually live are missing from it. Completions and resource
   * listings need this flattened view, and the cache keeps a keystroke from
   * turning into an API round trip.
   *
   * Dönüş bir ZARFTIR: liste + listenin NEYİ KAÇIRDIĞI. Çıplak dizi dönmek, çağıranın
   * `liste.length`i "hesabın tamamı" sanmasına yol açıyordu; kırpılmış ya da bir hesabı
   * okunamamış liste ile tam liste birbirinden ayırt edilemiyordu.
   */
  async tumHesaplar(): Promise<HesapSonucu> {
    const now = this.simdi();
    if (this.hesapCache) {
      /**
       * EKSİK sonuç da önbelleğe girer, ama kısa bir SOĞUMA penceresiyle. İki ayrı
       * arıza var ve ikisi de gerçek:
       *   - Eksik listeyi tam TTL boyunca sabitlemek: API düzeldikten sonra da ajan
       *     "hesabınız yok" demeye devam eder.
       *   - Eksik sonucu hiç önbelleklememek: kalıcı olarak okunamayan TEK hesap,
       *     her tamamlama tuşunu 30-60 sorguluk yeni bir hasata çevirir ve kota
       *     tükenince arıza daha da büyür.
       * Soğuma penceresi ikisinin arasındaki tek doğru yer.
       */
      const ttl = this.hesapCache.sonuc.eksik.var ? AdsContext.EKSIK_SOGUMA_MS : AdsContext.HESAP_TTL_MS;
      if (now - this.hesapCache.zaman < ttl) return this.hesapCache.sonuc;
    }
    // Share the in-flight request: concurrent completions (one per keystroke) must
    // not repeat the same harvest and drain the shared Google quota.
    if (this.hesapBekleyen) return this.hesapBekleyen;
    this.hesapBekleyen = this.hesaplariTopla().finally(() => {
      this.hesapBekleyen = undefined;
    });
    return this.hesapBekleyen;
  }

  private async hesaplariTopla(): Promise<HesapSonucu> {
    const liste: HesapKaydi[] = [];
    const gorulen = new Set<string>();
    const okunamayan: string[] = [];
    const altHesabiKirpilan: string[] = [];
    const tumUst = await this.listAccessibleCustomers();
    // Cap the parent accounts: uncapped, a single completion fans out into hundreds of queries.
    // Kırpma artık SESSİZ değil: tavanı aşan hesap sayısı eksiklik olarak zarfa yazılır.
    const ustHesaplar = tumUst.slice(0, AdsContext.UST_HESAP_TAVANI);
    const ustHesapKirpildi = tumUst.length > AdsContext.UST_HESAP_TAVANI;
    for (const id of ustHesaplar) {
      try {
        const [row]: any[] = await this.queryWithRetry(
          id,
          `SELECT customer.descriptive_name, customer.manager FROM customer LIMIT 1`
        );
        const yonetici = Boolean(row?.customer?.manager);
        if (!gorulen.has(id)) {
          gorulen.add(id);
          liste.push({ id, ad: String(row?.customer?.descriptive_name ?? "(isimsiz)"), yonetici });
        }
        if (yonetici) {
          /**
           * `customer_client.level = 1` YOK — bilerek. O yan tümce yalnız DOĞRUDAN
           * çocukları getirir; iki katmanlı bir ajans MCC'sinde gerçek reklam hesapları
           * alt-MCC'lerin altındadır ve listede HİÇ görünmezdi: ajan "erişilebilir
           * hesabınız yok" der ya da MCC seçip USER_PERMISSION_DENIED alırdı.
           * Filtresiz sorgu tüm torunları (alt-MCC'ler dahil) verir; MCC'nin kendi
           * satırı `gorulen` ile elenir.
           *
           * LIMIT tavan+2: tam tavan kadar satır dönerse kırpılıp kırpılmadığını
           * ANLAYAMAYIZ, o yüzden bir kırpma probu; bir de MCC'nin KENDİ satırı için
           * (customer_client sorgusu yöneticinin kendisini de level 0 olarak döndürür).
           */
          const cocuklar: any[] = await this.queryWithRetry(
            id,
            `SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager
             FROM customer_client LIMIT ${AdsContext.ALT_HESAP_TAVANI + 2}`
          );
          // MCC'nin kendi satırı kırpma ölçümüne KATILMAZ; yoksa tam tavan kadar alt
          // hesabı olan MCC yanlışlıkla "kırpıldı" diye işaretlenirdi.
          const cocukSatirlari = cocuklar.filter((c: any) => String(c.customer_client?.id ?? "") !== id);
          if (cocukSatirlari.length > AdsContext.ALT_HESAP_TAVANI) altHesabiKirpilan.push(id);
          for (const c of cocukSatirlari.slice(0, AdsContext.ALT_HESAP_TAVANI)) {
            const cid = String(c.customer_client?.id ?? "");
            if (!cid || gorulen.has(cid)) continue;
            gorulen.add(cid);
            liste.push({
              id: cid,
              ad: String(c.customer_client?.descriptive_name ?? "(isimsiz)"),
              yonetici: Boolean(c.customer_client?.manager),
            });
          }
        }
      } catch {
        /**
         * One unreadable account must not sink the whole list. Hesap listeden DÜŞMEZ:
         * "okunamadı" ile "yok" aynı şey değildir — düşürmek, ajanın kullanıcıya
         * "öyle bir hesabınız yok" demesine yol açıyordu. `erisilemedi` ile yayılır ve
         * sonuç EKSİK işaretlenir.
         */
        okunamayan.push(id);
        if (!gorulen.has(id)) {
          gorulen.add(id);
          liste.push({ id, ad: "(detay okunamadı)", yonetici: false, erisilemedi: true });
        }
      }
    }
    const sonuc: HesapSonucu = {
      liste,
      eksik: {
        var: okunamayan.length > 0 || ustHesapKirpildi || altHesabiKirpilan.length > 0,
        okunamayan,
        ustHesapKirpildi,
        altHesabiKirpilan,
      },
    };
    /**
     * Damga hasadın BİTİŞİNDE alınır. Başlangıç damgasıyla, 30 yönetici hesabı gezen
     * ve withRetry uykularıyla dakikaya yaklaşan bir hasat DOĞDUĞU AN bayat oluyordu:
     * önbellek hiç isabet etmiyor, koruma tam da en çok sorgu üreten kurulumda kalkıyordu.
     */
    this.hesapCache = { zaman: this.simdi(), sonuc };
    return sonuc;
  }

  /** Enjekte edilebilir saat: testler TTL/soğuma sınırlarını gerçek zaman beklemeden geçer. */
  protected simdi(): number {
    return Date.now();
  }

  private static readonly HESAP_TTL_MS = 60_000;
  /** Eksik sonucun ömrü: yeniden denemeyi geciktirecek kadar uzun, arızayı sabitlemeyecek kadar kısa. */
  private static readonly EKSIK_SOGUMA_MS = 10_000;
  private static readonly UST_HESAP_TAVANI = 30;
  private static readonly ALT_HESAP_TAVANI = 100;

  private hesapCache?: { zaman: number; sonuc: HesapSonucu };
  private hesapBekleyen?: Promise<HesapSonucu>;

  /**
   * GAQL read with retry — every READ path must go through here.
   * normalizeGaql is mandatory: on multi-line queries the client parser mangles the
   * last field of the SELECT list and silently returns null for it.
   */
  async queryWithRetry(customerId: string, gaql: string): Promise<any[]> {
    const q = normalizeGaql(gaql);
    return withRetry(() => this.getCustomer(customerId).query(q));
  }

  /**
   * Mutation wrapper: NO retry on generic network errors (risk of duplicate writes),
   * only on CONCURRENT_MODIFICATION — there the API rejected the request outright,
   * so the write was never applied.
   */
  async mutateWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, { tries: 4, baseMs: 600, isTransient: isConcurrentModificationError });
  }
}

/** Tool registrations resolve the context at call time, so errors surface per call. */
export type ContextProvider = () => AdsContext;

let envCtx: AdsContext | undefined;

/** stdio mode: single-user context from .env (lazy — the server starts without credentials too). */
export function getEnvContext(): AdsContext {
  if (!envCtx) envCtx = new AdsContext(loadConfig());
  return envCtx;
}
