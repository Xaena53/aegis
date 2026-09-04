// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Environment parsing that fails safe.
 *
 * Flags and numbers are validated rather than coerced: an unrecognised flag value is
 * treated as off, and an empty numeric variable falls back to its default instead of
 * becoming zero.
 */
import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Always load .env from the project root (dist/../.env), never from the CWD:
// MCP clients may start the server from an arbitrary working directory.
// quiet: dotenv logging to stdout would corrupt the MCP stdio (JSON-RPC) stream.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotenv({ path: path.join(projectRoot, ".env"), quiet: true });

export interface AegisConfig {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  loginCustomerId?: string;
  /**
   * The Meta (Facebook/Instagram) Marketing API access token. Without it the Meta tools do
   * nothing and say so EXPLICITLY — they do not fall silent as if there were nothing to
   * do.
   */
  metaToken?: string;
  /** The Meta ad account: "act_123456" or bare digits — the client normalises it. */
  metaAdAccountId?: string;
  writeEnabled: boolean;
  maxDailyBudget: number;
  /** Nokia Network-as-Code application key; absent = network verification off. */
  nacToken?: string;
  /** E.164 number of the human whose approval the network verifies. */
  approverPhone?: string;
  /** SIM-swap lookback window for high-risk actions (hours). */
  simSwapWindowHours: number;
  /**
   * STEP-UP VERIFICATION (AEGIS_STEPUP) — OFF by default.
   *
   * When it is on, a degraded network signal that comes from an ordinary human situation —
   * a changed SIM or handset, travel, a phone that is switched off, a silent network — no
   * longer ends in a flat refusal: if the remaining links come back clean over a real
   * channel, the action is bound to a stronger human verification that names the degraded
   * signal. The default is off on purpose: an escalation is a loosening, and the operator
   * has to choose it explicitly.
   */
  stepUp: boolean;
  /**
   * The SIMULATION channel ("temiz" | "degisti"): when it is set, a simulated channel is
   * used instead of the real NaC SDK, so a demo runs without a token. The value is NOT
   * validated here: a malformed environment value must not bring the server down at
   * startup, and is refused at decision time with a
   * reddedilmelidir (bkz. networkTrust.ts, fail-closed).
   */
  nacSimulate?: string;
  /**
   * The Number Verification SIMULATION channel ("dogrulandi" | "uyusmadi"): link 2 of the
   * trust chain, which runs ONLY on the high risk tier. Real CAMARA Number Verification
   * requires a device-side OIDC flow and cannot be called from a server on its own, so for
   * now only the simulation exists (see the header of networkTrust.ts). The value is NOT
   * validated here — same reasoning as nacSimulate: it is refused at decision time.
   */
  nvSimulate?: string;
  /**
   * The Device Reachability SIMULATION channel ("erisilebilir" | "anormal"): link 3 of the
   * trust chain, which runs ONLY on the high risk tier. The value is NOT validated here —
   * it is refused at decision time (see networkTrust.ts, fail closed).
   */
  reachSimulate?: string;
  /**
   * The on/off switch for link 3's REAL CAMARA query. Deliberately OFF by default:
   * reachability fluctuates legitimately (flight mode, a coverage gap), so switching the
   * query on merely because a NaC token exists would impose unwanted false-positive
   * refusals on an operator who configured that token for SIM Swap.
   */
  reachCheck: boolean;
  /**
   * The Location SIMULATION channel ("beklenen" | "beklenmedik"): link 4 of the trust
   * chain, which runs ONLY on the high risk tier. For the same reason, the value is NOT
   * validated here.
   */
  locSimulate?: string;
  /**
   * Link 4's expectation: the country where we expect the approver's line to be
   * (ISO 3166-1 alpha-2). IF IT IS UNSET THE LINK DOES NOT RUN AT ALL — an expected country
   * is never invented. The format check (two letters) happens at decision time; an invalid
   * value fails closed.
   */
  expectedCountry?: string;
  /**
   * The Device Swap SIMULATION channel ("temiz" | "degisti"): link 5 of the trust chain,
   * which runs ONLY on the high risk tier. The value is NOT validated here — it is refused
   * at decision time (see networkTrust.ts, fail closed).
   */
  devSwapSimulate?: string;
  /**
   * The on/off switch for link 5's REAL CAMARA query. OFF by default: every enabled link
   * adds another CAMARA round trip to an approval on the high tier, so no link switches
   * itself on merely because a token exists.
   */
  devSwapCheck: boolean;
  /**
   * The Call Forwarding SIMULATION channel ("kapali" | "acik"): link 6 of the trust chain,
   * which runs ONLY on the high risk tier. For the same reason, the value is NOT validated
   * here.
   */
  callFwdSimulate?: string;
  /** The switch for link 6's REAL query. OFF by default, for the same reason as
   * devSwapCheck. */
  callFwdCheck: boolean;
}

const REQUIRED = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
] as const;

export function missingCredentials(): string[] {
  return REQUIRED.filter((k) => !process.env[k]?.trim());
}

/**
 * Network-verification settings are process-wide, not per-tenant: the NaC key belongs
 * to the operator, and hosted mode reuses this helper so both entry points read the
 * same variables the same way.
 */
export function nacConfigFromEnv(): Pick<
  AegisConfig,
  | "nacToken"
  | "approverPhone"
  | "simSwapWindowHours"
  | "nacSimulate"
  | "nvSimulate"
  | "reachSimulate"
  | "reachCheck"
  | "locSimulate"
  | "expectedCountry"
  | "devSwapSimulate"
  | "devSwapCheck"
  | "callFwdSimulate"
  | "callFwdCheck"
  | "stepUp"
> {
  return {
    stepUp: parseBool(process.env.AEGIS_STEPUP, false, "AEGIS_STEPUP"),
    nacToken: process.env.AEGIS_NAC_TOKEN?.trim() || undefined,
    approverPhone: process.env.AEGIS_APPROVER_PHONE?.trim() || undefined,
    // Passed through raw on purpose; "temiz"/"degisti" is validated at decision time.
    nacSimulate: process.env.AEGIS_NAC_SIMULATE?.trim() || undefined,
    // Same reasoning: "dogrulandi"/"uyusmadi" is validated at decision time.
    nvSimulate: process.env.AEGIS_NV_SIMULATE?.trim() || undefined,
    // Same reasoning: "erisilebilir"/"anormal" is validated at decision time.
    reachSimulate: process.env.AEGIS_REACH_SIMULATE?.trim() || undefined,
    /**
     * OFF by default. Because parseBool also takes an unintelligible value to the safe side
     * (off), a malformed value cannot leave the link enabled — switching it on requires an
     * explicit intent.
     */
    reachCheck: parseBool(process.env.AEGIS_REACH_CHECK, false, "AEGIS_REACH_CHECK"),
    // Same reasoning: "beklenen"/"beklenmedik" is validated at decision time.
    locSimulate: process.env.AEGIS_LOC_SIMULATE?.trim() || undefined,
    /**
     * Passed through raw: the two-letter (ISO 3166-1 alpha-2) check happens at decision
     * time. An empty or missing value becomes undefined here and the location link DOES NOT
     * RUN AT ALL — the expectation is never invented.
     */
    expectedCountry: process.env.AEGIS_EXPECTED_COUNTRY?.trim() || undefined,
    // Same reasoning: "temiz"/"degisti" is validated at decision time.
    devSwapSimulate: process.env.AEGIS_DEVICESWAP_SIMULATE?.trim() || undefined,
    /**
     * OFF by default — the same reasoning as reachCheck, plus latency: every enabled real
     * link adds a CAMARA round trip to an approval on the high tier. Because parseBool takes
     * an unintelligible value to the safe side (off), a malformed value cannot enable the
     * link.
     */
    devSwapCheck: parseBool(process.env.AEGIS_DEVICESWAP_CHECK, false, "AEGIS_DEVICESWAP_CHECK"),
    // Same reasoning: "kapali"/"acik" is validated at decision time.
    callFwdSimulate: process.env.AEGIS_CALLFWD_SIMULATE?.trim() || undefined,
    callFwdCheck: parseBool(process.env.AEGIS_CALLFWD_CHECK, false, "AEGIS_CALLFWD_CHECK"),
    simSwapWindowHours: parseNumEnv(
      "AEGIS_SIMSWAP_WINDOW_HOURS",
      process.env.AEGIS_SIMSWAP_WINDOW_HOURS,
      72
    ),
  };
}

/** The type of the slice nacConfigFromEnv() returns — the key builder takes this. */
export type NacDilimi = ReturnType<typeof nacConfigFromEnv>;

/**
 * The part of the network-verification settings that goes into the context cache key.
 *
 * It lives here for testability: http.ts validates the hosted environment at startup and
 * calls process.exit on missing configuration, so it CANNOT be imported from a test. While
 * the key stayed there, it could only be checked by scanning the source TEXT — and a text
 * scan does not notice a field being commented out (proven with a mutation: commenting the
 * line with `//` dropped two of link 6's settings from the key, and no test went red). As a
 * pure function here it can be checked BEHAVIOURALLY: does changing this field really change
 * the key?
 *
 * Adding a link to the chain means adding its fields here. The omission is silent and
 * one-directional: the operator who ENABLES a link keeps being served a context built while
 * it was DISABLED, and believes a protection is running that never runs.
 */
export function nacAnahtarDilimi(nac: NacDilimi): string[] {
  return [
    nac.nacToken ?? "",
    nac.approverPhone ?? "",
    String(nac.simSwapWindowHours),
    nac.nacSimulate ?? "",
    nac.nvSimulate ?? "",
    String(nac.reachCheck ?? ""),
    nac.reachSimulate ?? "",
    nac.locSimulate ?? "",
    nac.expectedCountry ?? "",
    String(nac.devSwapCheck ?? ""),
    nac.devSwapSimulate ?? "",
    String(nac.callFwdCheck ?? ""),
    nac.callFwdSimulate ?? "",
    // Step-up is a LOOSENING: if it is not in the key, the operator who enables the
    // escalation keeps receiving a context built while it was off, and the path they believe
    // they enabled never runs.
    String(nac.stepUp ?? ""),
  ];
}

/**
 * THE TENANT SLICE — the identity and clamp half of the context cache key.
 *
 * It is here for the same reason as `nacAnahtarDilimi`: because http.ts cannot be tested,
 * this half of the key had no guard either, and the gap was measured — deleting
 * `user.writeEnabled` or `user.maxDailyBudget` from the key, one at a time or together, left
 * the suite GREEN.
 *
 * Every field is in the key for its own reason, and none of them is decoration:
 *   id / refreshToken / loginCustomerId -> TENANT IDENTITY. Drop one and two tenants share
 *     the same AdsContext: one tenant's token writes into the other's account.
 *   writeEnabled -> the write clamp. Drop it and the operator who switches writes OFF keeps
 *     being served the context built while they were on; the settings page's promise of
 *     "takes effect immediately" dies quietly.
 *   maxDailyBudget -> the spending ceiling. Drop it and the operator who LOWERS the ceiling
 *     keeps being served under the old, higher one.
 *
 * Note that the gap always bites towards LOOSENING: a tightening is not applied, while
 * slack persists.
 */
export function kiraciAnahtarDilimi(user: {
  id: number;
  refreshToken: string;
  loginCustomerId?: string | null | undefined;
  writeEnabled: boolean;
  maxDailyBudget: number;
}): string[] {
  return [
    String(user.id),
    user.refreshToken,
    user.loginCustomerId ?? "",
    String(user.writeEnabled),
    String(user.maxDailyBudget),
  ];
}

export function loadConfig(): AegisConfig {
  const missing = missingCredentials();
  if (missing.length) {
    throw new Error(
      `Google Ads kimlik bilgileri eksik: ${missing.join(", ")}. ` +
        `.env dosyasını doldurun (bkz. .env.example) — refresh token için: npm run auth`
    );
  }
  return {
    metaToken: process.env.AEGIS_META_TOKEN?.trim() || undefined,
    metaAdAccountId: process.env.AEGIS_META_AD_ACCOUNT_ID?.trim() || undefined,
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!.trim(),
    clientId: process.env.GOOGLE_ADS_CLIENT_ID!.trim(),
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET!.trim(),
    refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN!.trim(),
    loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.trim() || undefined,
    writeEnabled: parseBool(process.env.AEGIS_WRITE_ENABLED, true, "AEGIS_WRITE_ENABLED"),
    maxDailyBudget: parseBudgetCap(process.env.AEGIS_MAX_DAILY_BUDGET),
    ...nacConfigFromEnv(),
  };
}

/**
 * Flag parsing that errs on the SAFE side.
 * Accepting only a literal "0" as off is not enough: a user who writes `=false`,
 * `=no` or `=off` believes writes are disabled while the tools that spend real
 * money stay enabled. Any unrecognised value is treated as off as well.
 */
export function parseBool(raw: string | undefined, varsayilan: boolean, ad = "bayrak"): boolean {
  if (raw === undefined || raw.trim() === "") return varsayilan;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on", "evet", "acik", "açık"].includes(v)) return true;
  if (["0", "false", "no", "off", "hayir", "hayır", "kapali", "kapalı"].includes(v)) return false;
  /**
   * THE NAME OF THE VARIABLE IS LOGGED, NOT ITS VALUE.
   *
   * This warning goes to stderr, and stderr flows into the MCP log file, into `docker logs`
   * and into the terminal output of the rehearsal and smoke runs. A token pasted into the
   * wrong slot, or an approver's phone number — precisely the things that end up in the
   * wrong variable through a typo — used to be logged here in full. networkTrust.ts says in
   * seven different places that "the value is not shown, in case it is a secret"; this was
   * doing the opposite of that same rule. The variable's name and the expected format are
   * enough for the operator to know what to fix; they already know which wrong value they
   * typed.
   */
  console.error(
    `[aegis] Uyarı: ${ad} değeri anlaşılamadı (beklenen: 1/0, true/false, evet/hayır) — ` +
      `güvenli tarafa (kapalı) alındı. Değer sır ihtimaline karşı gösterilmiyor.`
  );
  return false;
}

/**
 * Numeric environment variable. An empty string must never fall through
 * `Number("") === 0`, which in the rate limiter means "every request is a 429".
 */
export function parseNumEnv(name: string, raw: string | undefined, varsayilan: number): number {
  if (raw === undefined || raw.trim() === "") return varsayilan;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    // Same reasoning as parseBool: the raw value never reaches the log, only the variable's
    // name and the expected format.
    console.error(
      `[aegis] Uyarı: ${name} geçersiz (beklenen: 0'dan büyük bir sayı) — ` +
        `varsayılan ${varsayilan} kullanılıyor. Değer sır ihtimaline karşı gösterilmiyor.`
    );
    return varsayilan;
  }
  return n;
}

/**
 * The cap is validated: NaN, a negative value or zero must not disable the guard
 * SILENTLY, so it falls back to the default (500) and warns on stderr.
 */
function parseBudgetCap(raw: string | undefined): number {
  const DEFAULT = 500;
  if (!raw?.trim()) return DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    // Same reasoning as parseBool: the raw value never reaches the log.
    console.error(
      `[aegis] Uyarı: AEGIS_MAX_DAILY_BUDGET geçersiz (beklenen: 0'dan büyük bir sayı) — ` +
        `bütçe tavanı ${DEFAULT} olarak zorlandı. Değer sır ihtimaline karşı gösterilmiyor.`
    );
    return DEFAULT;
  }
  return n;
}

/**
 * THE DECISION TO LISTEN IN PLAINTEXT (WITHOUT TLS) — INDEPENDENT of how it is published.
 *
 * WHY IT EXISTS: the hosted server always speaks plain HTTP; the nginx or Caddy in front of
 * it terminates the encryption. The old warning looked only at AEGIS_PUBLIC_URL, and so
 * FELL SILENT in the two cases where TLS can genuinely be bypassed:
 *   1) PUBLIC_URL is https:// but the process is bound to 0.0.0.0 — an unencrypted port
 *      stays open beside 443; /connect and /settings answer over plain HTTP, and /mcp needs
 *      only the right Host header. The reverse proxy becomes optional for an attacker.
 *   2) PUBLIC_URL is http:// but the machine is an internal name rather than "localhost" —
 *      credentials travel in the clear.
 * The decision therefore looks at BOTH inputs: where we bound, and which scheme users reach
 * us through. A plaintext public address is no longer a silent warning but a block that
 * requires EXPLICIT approval (AEGIS_ALLOW_PLAINTEXT) — "unknown" and "safe" are not the same
 * thing, and the default has to be refusal.
 */
const YEREL_ADLAR = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

/** Is this a bind address reachable only from this machine? */
export function yerelAdres(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (YEREL_ADLAR.has(h) || YEREL_ADLAR.has(`[${h}]`)) return true;
  // The whole of 127.0.0.0/8 is loopback, not just 127.0.0.1.
  return /^127\./.test(h);
}

export function duzMetinKarari(girdi: {
  bind: string;
  publicUrl: string;
  izinVerildi: boolean;
}): { engel?: string; uyari?: string } {
  let sema = "";
  let konak = "";
  try {
    const u = new URL(girdi.publicUrl);
    sema = u.protocol;
    konak = u.hostname;
  } catch {
    // An unparseable URL does not count as "clean": configuration that cannot be verified
    // deserves the warning.
    return { uyari: `AEGIS_PUBLIC_URL çözümlenemedi ('${girdi.publicUrl}') — TLS durumu DOĞRULANAMADI.` };
  }

  const genelDuzMetin = sema === "http:" && !yerelAdres(konak);
  if (genelDuzMetin && !girdi.izinVerildi) {
    return {
      engel:
        `AEGIS_PUBLIC_URL düz http:// ve '${konak}' yerel değil — API anahtarları ve OAuth ` +
        "kodları AÇIK METİN taşınır. TLS (nginx/Caddy) arkasına al ve URL'i https:// yap. " +
        "Bilerek şifresiz koşuyorsan AEGIS_ALLOW_PLAINTEXT=1 ile açıkça onayla.",
    };
  }

  // The listener itself is plain HTTP in every case: if it is bound outside loopback, SAY
  // so. An https PUBLIC_URL does not close this port; it only describes the intended path
  // through the proxy.
  if (!yerelAdres(girdi.bind)) {
    return {
      uyari:
        `düz HTTP dinleyicisi ${girdi.bind}:PORT üzerinde — bu portu doğrudan dışarı YAYINLAMA. ` +
        "Konteynerde yayın adresini 127.0.0.1'e sabitle (\"127.0.0.1:8787:8787\"), dışarıya yalnız " +
        "TLS sonlandırıcıyı aç; aksi hâlde şifreli 443'ün yanında şifresiz bir kapı açık kalır." +
        (genelDuzMetin ? " (AEGIS_ALLOW_PLAINTEXT ile şifresiz genel adres ONAYLANDI.)" : ""),
    };
  }
  return {};
}
