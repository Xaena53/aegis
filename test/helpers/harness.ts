import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.js";
import { AdsContext } from "../../src/adsClient.js";
import { __setSimSwapKanalForTests } from "../../src/networkTrust.js";

/** Removes the injected fake CAMARA channel; call in a finally after agDurumu tests. */
export function agKanaliniSifirla(): void {
  __setSimSwapKanalForTests(undefined);
}

/**
 * Integration test harness.
 *
 * Wires a real MCP client↔server pair over InMemoryTransport and injects a fake
 * AdsContext into the tools. The safety gates — approval, budget ceiling,
 * PAUSED-by-default, live-campaign protection — are therefore exercised across the
 * whole protocol without a single request reaching the Google API.
 *
 * `buildServer(getCtx)` already takes a context provider, so no extra refactor is needed.
 */

export interface SahteAyar {
  writeEnabled?: boolean;
  maxDailyBudget?: number;
  /** Canned response keyed by GAQL text; the first matching pattern wins. */
  queries?: Array<[RegExp, any[]]>;
  /** Top-level accounts that listAccessibleCustomers will return. */
  hesaplar?: string[];
  /**
   * Accounts whose queries throw, modelling an account Google lists as accessible but
   * whose details cannot actually be read (the usual cause is a missing login-customer-id).
   * Without this the fake API can never fail, and the code paths that handle a partially
   * readable account list would go untested.
   */
  okunamayanHesaplar?: string[];
  /**
   * Enables network verification with a fake CAMARA channel: "temiz" answers no swap,
   * "degisti" answers swapped, "hata" throws. The caller must reset the injected channel
   * after the test (see agKanaliniSifirla), or the override leaks into later tests.
   */
  agDurumu?: "temiz" | "degisti" | "hata";
}

export interface Kayit {
  /** Every mutation (write) that was issued — stays empty when no write is expected. */
  mutations: Array<{ kind: string; payload: any }>;
  /** GAQL statements that were executed. */
  queries: string[];
  /** Which account each query ran against, in the same order as `queries`. */
  customerIds: string[];
}

export function sahteContext(opts: SahteAyar = {}): { ctx: any; rec: Kayit } {
  const rec: Kayit = { mutations: [], queries: [], customerIds: [] };

  const yanit = (gaql: string): any[] => {
    for (const [re, rows] of opts.queries ?? []) if (re.test(gaql)) return rows;
    return [];
  };

  const kaydet = (kind: string) => (payload: any) => {
    rec.mutations.push({ kind, payload });
    if (kind === "mutateResources") {
      return { mutate_operation_responses: [{ campaign_result: { resource_name: "customers/1/campaigns/9" } }] };
    }
    return { results: [{ resource_name: `customers/1/${kind}/9` }] };
  };

  const customer = {
    adGroupAds: { create: kaydet("adGroupAds") },
    adGroupCriteria: { create: kaydet("adGroupCriteria") },
    campaignCriteria: { create: kaydet("campaignCriteria") },
    campaignBudgets: { update: kaydet("campaignBudgets") },
    campaigns: { update: kaydet("campaigns") },
    mutateResources: kaydet("mutateResources"),
  };

  /**
   * Derived from the real AdsContext prototype: only the methods that reach the
   * network are replaced. Pure logic such as `tumHesaplar` (sub-account flattening,
   * caching) is therefore exercised as production code rather than a stand-in copy.
   */
  const ctx: any = Object.create(AdsContext.prototype);
  ctx.config = {
    writeEnabled: opts.writeEnabled ?? true,
    maxDailyBudget: opts.maxDailyBudget ?? 500,
  };
  if (opts.agDurumu) {
    ctx.config.nacToken = "test-nac-token";
    ctx.config.approverPhone = "+905551112233";
    ctx.config.simSwapWindowHours = 72;
    const durum = opts.agDurumu;
    __setSimSwapKanalForTests({
      verifySimSwap: async () => {
        if (durum === "hata") throw new Error("NaC sandbox unreachable");
        return durum === "degisti";
      },
    });
  }
  ctx.getCustomer = () => customer;
  ctx.queryWithRetry = async (cid: string, gaql: string) => {
    rec.queries.push(gaql);
    rec.customerIds.push(cid);
    if ((opts.okunamayanHesaplar ?? []).includes(cid)) {
      throw new Error("USER_PERMISSION_DENIED: User doesn't have permission to access customer.");
    }
    return yanit(gaql);
  };
  ctx.mutateWithRetry = async (fn: () => any) => fn();
  ctx.listAccessibleCustomers = async () => opts.hesaplar ?? ["1234567890"];

  return { ctx, rec };
}

/** An MCP client bound to the fake context, speaking over the real protocol. */
export async function baglanti(ctx: any): Promise<Client> {
  const server = buildServer(() => ctx);
  const [istemciTasima, sunucuTasima] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "entegrasyon-testi", version: "0" });
  await server.connect(sunucuTasima);
  await client.connect(istemciTasima);
  return client;
}

/** Calls a tool and returns its text output, which keeps the tests readable. */
export async function cagir(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const res: any = await client.callTool({ name, arguments: args });
  return String(res.content?.[0]?.text ?? "");
}
