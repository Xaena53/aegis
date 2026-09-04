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
 * One account record. `erisilemedi` (unreadable) means the account's details could not be
 * read: whether it is a manager account is UNKNOWN, so it cannot be used for a campaign.
 * `yonetici: false` here means "unknown" — it does NOT mean "this is an ad account".
 */
export interface HesapKaydi {
  id: string;
  ad: string;
  yonetici: boolean;
  erisilemedi?: boolean;
}

/**
 * The account list, plus what the list is missing.
 *
 * When `eksik.var` is true the list is NOT COMPLETE, and the caller is obliged to carry
 * that to the user: presenting a truncated list as "all your accounts" leads the agent to
 * conclude "you have no such account" when the one being looked for is not in it.
 */
export interface HesapSonucu {
  liste: HesapKaydi[];
  eksik: {
    var: boolean;
    /** Parent accounts that look reachable but whose details could not be read. */
    okunamayan: string[];
    /** The parent-account count hit the cap: some parents never appear in the list at all. */
    ustHesapKirpildi: boolean;
    /** Manager accounts whose child-account listing reached the cap. */
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
   * The return value is an ENVELOPE: the list, plus WHAT THE LIST IS MISSING. Returning a
   * bare array led callers to read `liste.length` as "all the accounts"; a truncated list,
   * or one with an account that could not be read, was indistinguishable from a complete
   * one.
   */
  async tumHesaplar(): Promise<HesapSonucu> {
    const now = this.simdi();
    if (this.hesapCache) {
      /**
       * An INCOMPLETE result is cached too, but under a short COOL-DOWN window. There are
       * two distinct failures here and both are real:
       *   - Freezing an incomplete list for the full TTL: the agent keeps saying "you have
       *     no accounts" long after the API has recovered.
       *   - Not caching an incomplete result at all: a SINGLE permanently unreadable
       *     account turns every completion keystroke into a fresh harvest of 30-60
       *     queries, and once the quota runs out the failure gets worse.
       * The cool-down window is the only right place between the two.
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
    // Truncation is no longer SILENT: accounts beyond the cap are recorded in the
    // envelope as a gap.
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
           * There is deliberately NO `customer_client.level = 1`. That clause returns only
           * DIRECT children; in a two-tier agency manager account the real ad accounts sit
           * under sub-managers and would NEVER appear in the list — the agent would say
           * "you have no reachable accounts", or pick the manager account and get
           * USER_PERMISSION_DENIED. Unfiltered, the query returns every descendant
           * (sub-managers included); the manager's own row is filtered out via `gorulen`.
           *
           * LIMIT is cap+2: if exactly cap rows come back we CANNOT TELL whether the list
           * was truncated, so one row is a truncation probe — and one is for the manager's
           * OWN row, since a customer_client query returns the manager itself at level 0.
           */
          const cocuklar: any[] = await this.queryWithRetry(
            id,
            `SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager
             FROM customer_client LIMIT ${AdsContext.ALT_HESAP_TAVANI + 2}`
          );
          // The manager's own row does NOT count towards the truncation measurement;
          // otherwise a manager with exactly cap child accounts would be wrongly flagged
          // as truncated.
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
         * One unreadable account must not sink the whole list, and the account is NOT
         * dropped from it: "could not be read" and "does not exist" are not the same thing,
         * and dropping it led the agent to tell the user "you have no such account". It is
         * carried through marked `erisilemedi`, and the result is flagged INCOMPLETE.
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
     * The timestamp is taken when the harvest FINISHES. Stamped at the start, a harvest
     * that walks 30 manager accounts and approaches a minute with withRetry's sleeps was
     * stale THE MOMENT IT WAS BORN: the cache never hit, and the protection lifted in
     * exactly the installation that generates the most queries.
     */
    this.hesapCache = { zaman: this.simdi(), sonuc };
    return sonuc;
  }

  /** Injectable clock: tests cross the TTL and cool-down boundaries without waiting on
   * real time. */
  protected simdi(): number {
    return Date.now();
  }

  private static readonly HESAP_TTL_MS = 60_000;
  /** How long an incomplete result lives: long enough to delay a retry, short enough not
   * to freeze the failure in place. */
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
