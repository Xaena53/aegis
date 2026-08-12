import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.js";
import { AdsContext } from "../../src/adsClient.js";

/**
 * Entegrasyon test koşum takımı.
 *
 * Gerçek bir MCP istemci↔sunucu çifti kurar (InMemoryTransport) ve araçlara
 * SAHTE bir AdsContext enjekte eder. Böylece güvenlik kapıları — onay, bütçe
 * tavanı, PAUSED-varsayılan, canlı kampanya koruması — Google API'ye tek istek
 * atmadan, protokolün tamamı üzerinden test edilir.
 *
 * `buildServer(getCtx)` zaten context sağlayıcı aldığı için ek refactor gerekmez.
 */

export interface SahteAyar {
  writeEnabled?: boolean;
  maxDailyBudget?: number;
  /** GAQL metnine göre yanıt; ilk eşleşen desen kazanır. */
  queries?: Array<[RegExp, any[]]>;
  /** listAccessibleCustomers'ın döneceği üst düzey hesaplar. */
  hesaplar?: string[];
}

export interface Kayit {
  /** Yapılan tüm mutasyonlar (yazma) — hiç yazma olmamalıysa boş kalmalı. */
  mutations: Array<{ kind: string; payload: any }>;
  /** Çalıştırılan GAQL metinleri. */
  queries: string[];
}

export function sahteContext(opts: SahteAyar = {}): { ctx: any; rec: Kayit } {
  const rec: Kayit = { mutations: [], queries: [] };

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
   * Gerçek AdsContext prototipinden türetilir: yalnız AĞA ÇIKAN yöntemler
   * değiştirilir. Böylece `tumHesaplar` gibi saf iş mantığı (alt hesap
   * düzleştirme, önbellek) SAHTE bir kopya değil, ÜRETİMDEKİ kod olarak
   * test edilir.
   */
  const ctx: any = Object.create(AdsContext.prototype);
  ctx.config = {
    writeEnabled: opts.writeEnabled ?? true,
    maxDailyBudget: opts.maxDailyBudget ?? 500,
  };
  ctx.getCustomer = () => customer;
  ctx.queryWithRetry = async (_cid: string, gaql: string) => {
    rec.queries.push(gaql);
    return yanit(gaql);
  };
  ctx.mutateWithRetry = async (fn: () => any) => fn();
  ctx.listAccessibleCustomers = async () => opts.hesaplar ?? ["1234567890"];

  return { ctx, rec };
}

/** Sahte context'e bağlı, gerçek protokol üzerinden konuşan bir MCP istemcisi. */
export async function baglanti(ctx: any): Promise<Client> {
  const server = buildServer(() => ctx);
  const [istemciTasima, sunucuTasima] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "entegrasyon-testi", version: "0" });
  await server.connect(sunucuTasima);
  await client.connect(istemciTasima);
  return client;
}

/** Araç çağırır ve metin çıktısını döner (test okunabilirliği için). */
export async function cagir(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const res: any = await client.callTool({ name, arguments: args });
  return String(res.content?.[0]?.text ?? "");
}
