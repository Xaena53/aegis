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
