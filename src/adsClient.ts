import { GoogleAdsApi, Customer } from "google-ads-api";
import { loadConfig, AdsPilotConfig } from "./config.js";
import { normalizeCustomerId, withRetry, isConcurrentModificationError, normalizeGaql } from "./util.js";

export { normalizeCustomerId, formatAdsError } from "./util.js";
export type { AdsPilotConfig } from "./config.js";

/**
 * Kullanıcıya bağlı Google Ads bağlamı. Çok-kullanıcılı (hosted) modda her
 * kullanıcının kendi context'i olur; stdio modda env'den tek context üretilir.
 * Araçlar global config'e DEĞİL, kendilerine verilen context'e konuşur.
 */
export class AdsContext {
  private api: GoogleAdsApi;

  constructor(public readonly config: AdsPilotConfig) {
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
   * Erişilebilir TÜM hesaplar (MCC alt hesapları dahil), kısa süreli önbellekli.
   *
   * `listAccessibleCustomers` yalnız üst düzey hesapları döner; kullanıcının
   * fiilen kampanya kurduğu alt hesaplar orada YOKTUR. Otomatik tamamlama ve
   * kaynak listeleri bu düzleştirilmiş listeye ihtiyaç duyar. Önbellek, her
   * tuş vuruşunda API'ye çıkılmasını engeller.
   */
  async tumHesaplar(): Promise<Array<{ id: string; ad: string; yonetici: boolean }>> {
    const now = Date.now();
    if (this.hesapCache && now - this.hesapCache.zaman < 60_000) return this.hesapCache.liste;
    // Uçuştaki isteği paylaş: eşzamanlı tamamlamalar (her tuş vuruşu bir istek)
    // aynı hasadı defalarca yapıp paylaşılan Google kotasını tüketmesin.
    if (this.hesapBekleyen) return this.hesapBekleyen;
    this.hesapBekleyen = this.hesaplariTopla(now).finally(() => {
      this.hesapBekleyen = undefined;
    });
    return this.hesapBekleyen;
  }

  private async hesaplariTopla(now: number): Promise<Array<{ id: string; ad: string; yonetici: boolean }>> {
    const liste: Array<{ id: string; ad: string; yonetici: boolean }> = [];
    const gorulen = new Set<string>();
    let hataOldu = false;
    // Üst hesap tavanı: tavansız döngü tek tamamlamada yüzlerce sorgu üretebiliyordu
    const ustHesaplar = (await this.listAccessibleCustomers()).slice(0, 30);
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
          const cocuklar: any[] = await this.queryWithRetry(
            id,
            `SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager
             FROM customer_client WHERE customer_client.level = 1 LIMIT 100`
          );
          for (const c of cocuklar) {
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
        // Tek hesap okunamazsa listeyi tamamen düşürme, ama EKSİK olduğunu işaretle
        hataOldu = true;
      }
    }
    /**
     * NEGATİF ÖNBELLEKLEME YASAK. Eskiden hata durumunda da yazılıyordu:
     * geçici bir Google 5xx sırasında oluşan BOŞ/EKSİK liste 60 saniye
     * boyunca sunuluyor, API düzelse bile ajan "hiç hesabın yok" diyordu.
     * Eksik sonuç önbelleğe alınmaz — sonraki çağrı yeniden dener.
     */
    if (!hataOldu) this.hesapCache = { zaman: now, liste };
    return liste;
  }

  private hesapCache?: { zaman: number; liste: Array<{ id: string; ad: string; yonetici: boolean }> };
  private hesapBekleyen?: Promise<Array<{ id: string; ad: string; yonetici: boolean }>>;

  /**
   * Retry'lı GAQL sorgusu — tüm OKUMA yolları bunu kullanmalı.
   * normalizeGaql ZORUNLU: çok satırlı sorgularda istemci ayrıştırıcısı
   * SELECT listesinin son alanını bozar ve değeri sessizce null döner.
   */
  async queryWithRetry(customerId: string, gaql: string): Promise<any[]> {
    const q = normalizeGaql(gaql);
    return withRetry(() => this.getCustomer(customerId).query(q));
  }

  /**
   * Mutasyon sarmalayıcısı: genel ağ hatalarında RETRY YOK (çift kayıt riski),
   * yalnız CONCURRENT_MODIFICATION'da tekrar dener — o hatada istek açıkça
   * reddedilmiştir, yazma uygulanmamıştır.
   */
  async mutateWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, { tries: 4, baseMs: 600, isTransient: isConcurrentModificationError });
  }
}

/** Araç kayıtları çağrı anında context ister — hata mesajları çağrıda üretilsin diye. */
export type ContextProvider = () => AdsContext;

let envCtx: AdsContext | undefined;

/** stdio modu: .env'den tek kullanıcılı context (tembel — sunucu kimliksiz de ayağa kalkar). */
export function getEnvContext(): AdsContext {
  if (!envCtx) envCtx = new AdsContext(loadConfig());
  return envCtx;
}
