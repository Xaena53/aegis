import { GoogleAdsApi, Customer } from "google-ads-api";
import { loadConfig, AdsPilotConfig } from "./config.js";
import { normalizeCustomerId, withRetry } from "./util.js";

export { normalizeCustomerId, formatAdsError } from "./util.js";

let api: GoogleAdsApi | undefined;
let cfg: AdsPilotConfig | undefined;

export function getConfig(): AdsPilotConfig {
  if (!cfg) cfg = loadConfig();
  return cfg;
}

function getApi(): GoogleAdsApi {
  if (!api) {
    const c = getConfig();
    api = new GoogleAdsApi({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      developer_token: c.developerToken,
    });
  }
  return api;
}

export function getCustomer(customerId: string): Customer {
  const c = getConfig();
  return getApi().Customer({
    customer_id: normalizeCustomerId(customerId),
    refresh_token: c.refreshToken,
    login_customer_id: c.loginCustomerId
      ? normalizeCustomerId(c.loginCustomerId)
      : undefined,
  });
}

export async function listAccessibleCustomers(): Promise<string[]> {
  const c = getConfig();
  const res = await withRetry(() => getApi().listAccessibleCustomers(c.refreshToken));
  return res.resource_names.map((rn: string) => rn.replace("customers/", ""));
}

/**
 * Retry'lı GAQL sorgusu — tüm OKUMA yolları bunu kullanmalı.
 * (Mutasyonlar bilerek retry'sız: tekrar deneme çift kayıt oluşturabilir.)
 */
export async function queryWithRetry(customerId: string, gaql: string): Promise<any[]> {
  return withRetry(() => getCustomer(customerId).query(gaql));
}
