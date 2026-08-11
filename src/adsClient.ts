import { GoogleAdsApi, Customer } from "google-ads-api";
import { loadConfig, AdsPilotConfig } from "./config.js";

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

/** customerId: tireli/tiresiz kabul eder ("123-456-7890" → "1234567890") */
export function normalizeCustomerId(id: string): string {
  return id.replace(/[^0-9]/g, "");
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
  const res = await getApi().listAccessibleCustomers(c.refreshToken);
  return res.resource_names.map((rn: string) => rn.replace("customers/", ""));
}

/** Google Ads API hatalarını okunur tek satıra indirger. */
export function formatAdsError(err: unknown): string {
  const e = err as any;
  const details =
    e?.errors?.map((x: any) => x?.message).filter(Boolean).join("; ") ||
    e?.message ||
    String(err);
  return `Google Ads API hatası: ${details}`;
}
