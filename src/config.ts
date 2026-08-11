import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// .env'i CWD'den değil, her zaman proje kökünden (dist/../.env) yükle:
// MCP istemcileri sunucuyu rastgele bir çalışma dizininden başlatabilir.
// quiet: dotenv'in stdout'a log basması MCP stdio (JSON-RPC) akışını bozar.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotenv({ path: path.join(projectRoot, ".env"), quiet: true });

export interface AdsPilotConfig {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  loginCustomerId?: string;
  writeEnabled: boolean;
  maxDailyBudget: number;
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

export function loadConfig(): AdsPilotConfig {
  const missing = missingCredentials();
  if (missing.length) {
    throw new Error(
      `Google Ads kimlik bilgileri eksik: ${missing.join(", ")}. ` +
        `.env dosyasını doldurun (bkz. .env.example) — refresh token için: npm run auth`
    );
  }
  return {
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!.trim(),
    clientId: process.env.GOOGLE_ADS_CLIENT_ID!.trim(),
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET!.trim(),
    refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN!.trim(),
    loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.trim() || undefined,
    writeEnabled: process.env.ADSPILOT_WRITE_ENABLED !== "0",
    maxDailyBudget: parseBudgetCap(process.env.ADSPILOT_MAX_DAILY_BUDGET),
  };
}

/**
 * Tavan değeri doğrulanır: NaN/negatif/sıfır girilirse guard SESSİZCE devre dışı
 * kalmasın diye varsayılana (500) düşülür ve stderr'e uyarı yazılır.
 */
function parseBudgetCap(raw: string | undefined): number {
  const DEFAULT = 500;
  if (!raw?.trim()) return DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(
      `[adspilot] Uyarı: ADSPILOT_MAX_DAILY_BUDGET='${raw}' geçersiz — bütçe tavanı ${DEFAULT} olarak zorlandı.`
    );
    return DEFAULT;
  }
  return n;
}
