// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Network-verified approval: CAMARA signals as a trust anchor for spending consent.
 *
 * MCP elicitation proves a human clicked "approve"; it cannot prove the human is the
 * account owner. A stolen session answers the prompt just as convincingly. The mobile
 * network holds evidence no application layer can fake: the operator knows whether the
 * owner's SIM was swapped recently — the signature move of account-takeover fraud.
 *
 * Before a spend-increasing action reaches the human prompt, this module consults the
 * GSMA Open Gateway SIM Swap API (CAMARA, via the Nokia Network-as-Code platform) for
 * the configured approver number. A recent swap refuses the action outright — the
 * prompt is never shown, because the person who would answer it may be the attacker.
 *
 * Fail-closed contract, same as every money gate in this codebase:
 *   - Feature unconfigured (no ADSPILOT_NAC_TOKEN): pass-through, evidence line says so.
 *   - Configured but incomplete (token without approver phone): refuse with a config error.
 *   - Network API unreachable or throws: refuse. If the trust anchor cannot answer,
 *     the spend does not happen.
 *
 * Risk tiers widen the lookback window rather than change the decision logic:
 * "medium" (budget increases) checks the last 24h; "high" (go-live, changes to a
 * serving campaign) checks the configured window, 72h by default.
 */

/** The single network capability this gate needs; the SDK client is adapted to it. */
export interface SimSwapKanali {
  /** True when the SIM changed within the last `maxAgeHours` hours. */
  verifySimSwap(maxAgeHours: number): Promise<boolean>;
}

export type AgRisk = "medium" | "high";

export interface AgKarar {
  /** Refusal text for the agent; undefined when the action may proceed. */
  engel?: string;
  /** Evidence lines appended to the human approval prompt. */
  kanit: string[];
}

/** The subset of AdsPilotConfig this module reads (kept narrow for testability). */
export interface AgAyar {
  nacToken?: string;
  approverPhone?: string;
  simSwapWindowHours: number;
}

const MEDIUM_WINDOW_HOURS = 24;

/**
 * Test seam. Production builds the channel from the Nokia SDK; tests inject a fake so
 * the refusal paths can be exercised (and mutation-tested) without network access.
 */
let kanalOverride: SimSwapKanali | "reset" | undefined;
export function __setSimSwapKanalForTests(k: SimSwapKanali | undefined): void {
  kanalOverride = k ?? "reset";
  gercekKanal = undefined;
}

let gercekKanal: SimSwapKanali | undefined;

/**
 * The SDK is imported lazily: deployments without a NaC token never load it, and a
 * broken optional dependency cannot take down the stdio server at startup.
 */
async function kanalGetir(ayar: AgAyar): Promise<SimSwapKanali> {
  if (kanalOverride && kanalOverride !== "reset") return kanalOverride;
  if (gercekKanal) return gercekKanal;
  const { NetworkAsCodeApiClient } = await import("network-as-code");
  const client = new NetworkAsCodeApiClient({ apiKey: ayar.nacToken! });
  const phoneNumber = ayar.approverPhone!;
  gercekKanal = {
    verifySimSwap: async (maxAgeHours: number) => {
      // CAMARA sim-swap check: maxAge is in hours (1–2400)
      const res = await client.simSwap.check({ phoneNumber, maxAge: maxAgeHours });
      return res.swapped === true;
    },
  };
  return gercekKanal;
}

/** Masks all but the last two digits, so prompts never leak the full approver number. */
function maskele(phone: string): string {
  return phone.length <= 4 ? "***" : phone.slice(0, 4) + "*".repeat(Math.max(0, phone.length - 6)) + phone.slice(-2);
}

/**
 * Consults the network before a spend-increasing approval. Called by the approval gate
 * for every risk-tagged action; the caller treats `engel` as a hard refusal.
 */
export async function agDogrula(ayar: AgAyar, risk: AgRisk): Promise<AgKarar> {
  if (!ayar.nacToken) {
    return { kanit: ["Ağ doğrulaması: kapalı (ADSPILOT_NAC_TOKEN tanımlı değil)"] };
  }
  if (!ayar.approverPhone) {
    return {
      engel:
        "Reddedildi: ağ doğrulaması yapılandırması eksik — ADSPILOT_NAC_TOKEN tanımlı ama " +
        "ADSPILOT_APPROVER_PHONE boş. Onaylayıcının numarası olmadan ağ kontrolü yapılamaz; " +
        "güvenlik gereği harcama artışı uygulanmaz.",
      kanit: [],
    };
  }

  const pencere = risk === "medium" ? Math.min(MEDIUM_WINDOW_HOURS, ayar.simSwapWindowHours) : ayar.simSwapWindowHours;

  try {
    const kanal = await kanalGetir(ayar);
    const degisti = await kanal.verifySimSwap(pencere);
    if (degisti) {
      return {
        engel:
          `Reddedildi: AĞ DOĞRULAMASI BAŞARISIZ — onaylayıcının (${maskele(ayar.approverPhone)}) SIM kartı ` +
          `son ${pencere} saat içinde değişmiş (GSMA Open Gateway SIM Swap). Bu, hesap ele geçirme ` +
          `saldırılarının tipik işaretidir; onay istemi hiç gösterilmedi. Hesap sahibi durumu doğrulayana ` +
          `kadar harcama artışı uygulanmaz. Kullanıcıya bu durumu MUTLAKA bildir.`,
        kanit: [],
      };
    }
    return {
      kanit: [`Ağ doğrulaması: SIM değişimi yok (son ${pencere} saat, ${maskele(ayar.approverPhone)}) — GSMA Open Gateway`],
    };
  } catch (e: any) {
    // The trust anchor is unreachable: refusing is the entire point of having one.
    return {
      engel:
        `Reddedildi: ağ doğrulaması tamamlanamadı (${e?.message ?? e}). SIM Swap kontrolü ` +
        `yanıt vermeden harcama artışı uygulanmaz; daha sonra tekrar dene ya da yapılandırmayı kontrol et.`,
      kanit: [],
    };
  }
}
