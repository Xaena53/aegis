// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Google Ads access, scoped to one user.
 *
 * AdsContext carries a single user credentials and guardrails. Reads retry on
 * transient errors; mutations deliberately do not, except for CONCURRENT_MODIFICATION
 * where the API rejects the write outright and asks for a retry.
 */
import { GoogleAdsApi, Customer } from "google-ads-api";
import { loadConfig, AdsPilotConfig } from "./config.js";
import { normalizeCustomerId, withRetry, isConcurrentModificationError, normalizeGaql } from "./util.js";

export { normalizeCustomerId, formatAdsError } from "./util.js";
export type { AdsPilotConfig } from "./config.js";

/**
 * Per-user Google Ads context. In hosted (multi-user) mode every user gets their
 * own context; in stdio mode a single context is built from the environment.
 * Tools talk to the context they are handed, never to global config.
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
   * Every accessible account (MCC sub-accounts included), briefly cached.
   *
   * `listAccessibleCustomers` returns top-level accounts only, so the sub-accounts
   * where campaigns actually live are missing from it. Completions and resource
   * listings need this flattened view, and the cache keeps a keystroke from
   * turning into an API round trip.
   */
  async tumHesaplar(): Promise<Array<{ id: string; ad: string; yonetici: boolean }>> {
    const now = Date.now();
    if (this.hesapCache && now - this.hesapCache.zaman < 60_000) return this.hesapCache.liste;
    // Share the in-flight request: concurrent completions (one per keystroke) must
    // not repeat the same harvest and drain the shared Google quota.
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
    // Cap the parent accounts: uncapped, a single completion fans out into hundreds of queries
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
        // One unreadable account must not sink the whole list, but mark the result INCOMPLETE
        hataOldu = true;
      }
    }
    /**
     * Never cache a partial result. A transient API failure would otherwise pin an
     * empty account list for the full TTL, and the agent would keep telling the user
     * they have no Google Ads accounts long after the API recovered.
     */
    if (!hataOldu) this.hesapCache = { zaman: now, liste };
    return liste;
  }

  private hesapCache?: { zaman: number; liste: Array<{ id: string; ad: string; yonetici: boolean }> };
  private hesapBekleyen?: Promise<Array<{ id: string; ad: string; yonetici: boolean }>>;

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
