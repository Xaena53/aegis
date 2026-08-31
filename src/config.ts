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

export interface AdsPilotConfig {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  loginCustomerId?: string;
  /**
   * Meta (Facebook/Instagram) Marketing API erişim jetonu; yoksa Meta araçları hiçbir
   * işlem yapmaz ve bunu AÇIKÇA söyler (sessizce "yapacak bir şey yok" demez).
   */
  metaToken?: string;
  /** Meta reklam hesabı: "act_123456" ya da çıplak rakam — istemci normalize eder. */
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
   * KADEMELİ DOĞRULAMA (ADSPILOT_STEPUP) — varsayılan KAPALI.
   *
   * Açıkken, olağan bir kullanıcı durumundan doğan bozuk ağ sinyali (SIM/cihaz
   * değişimi, seyahat, kapalı telefon, cevapsız ağ) düz retle bitmez: kalan halkalar
   * gerçek kanaldan temiz dönerse işlem, bozulan sinyali adıyla söyleyen daha güçlü
   * bir insan doğrulamasına bağlanır. Kapalı varsayılan bilinçlidir — yükseltme bir
   * gevşemedir ve operatör onu açıkça seçmelidir.
   */
  stepUp: boolean;
  /**
   * SİMÜLASYON kanalı ("temiz" | "degisti"): tanımlıysa gerçek NaC SDK'sı yerine simüle
   * kanal kullanılır (jüri demosu token'sız çalışır). Değer burada DOĞRULANMAZ: bozuk
   * bir env değeri sunucuyu başlangıçta düşürmemeli, doğrulama anında Türkçe hatayla
   * reddedilmelidir (bkz. networkTrust.ts, fail-closed).
   */
  nacSimulate?: string;
  /**
   * Number Verification SİMÜLASYON kanalı ("dogrulandi" | "uyusmadi"): güven zincirinin
   * 2. halkası, YALNIZ high risk katmanında koşar. Gerçek CAMARA Number Verification
   * cihaz-taraflı OIDC akışı ister ve sunucudan tek başına çağrılamaz; bu yüzden şimdilik
   * yalnız simülasyon vardır (bkz. networkTrust.ts dosya başı). Değer burada DOĞRULANMAZ —
   * nacSimulate ile aynı gerekçe: karar anında Türkçe hatayla reddedilir.
   */
  nvSimulate?: string;
  /**
   * Device Reachability SİMÜLASYON kanalı ("erisilebilir" | "anormal"): güven zincirinin
   * 3. halkası, YALNIZ high risk katmanında koşar. Değer burada DOĞRULANMAZ — karar anında
   * Türkçe hatayla reddedilir (bkz. networkTrust.ts, kapalı arıza).
   */
  reachSimulate?: string;
  /**
   * 3. halkanın GERÇEK CAMARA sorgusunun açma/kapama anahtarı. Bilerek varsayılan KAPALI:
   * erişilebilirlik meşru olarak dalgalanır (uçak modu, kapsama boşluğu), bu yüzden
   * yalnızca NaC token'ının varlığına bakıp sorguyu açmak, SIM-Swap için token tanımlamış
   * bir operatöre istemediği yanlış-pozitif retleri dayatırdı.
   */
  reachCheck: boolean;
  /**
   * Location SİMÜLASYON kanalı ("beklenen" | "beklenmedik"): güven zincirinin 4. halkası,
   * YALNIZ high risk katmanında koşar. Aynı gerekçeyle değer burada DOĞRULANMAZ.
   */
  locSimulate?: string;
  /**
   * 4. halkanın beklentisi: onaylayıcının hattının bulunmasını beklediğimiz ülke
   * (ISO 3166-1 alpha-2). TANIMSIZSA HALKA HİÇ KOŞMAZ — beklenen ülke uydurulmaz.
   * Biçim doğrulaması (iki harf) karar anında yapılır; geçersiz değer kapalı arızadır.
   */
  expectedCountry?: string;
  /**
   * Device Swap SİMÜLASYON kanalı ("temiz" | "degisti"): güven zincirinin 5. halkası,
   * YALNIZ high risk katmanında koşar. Değer burada DOĞRULANMAZ — karar anında Türkçe
   * hatayla reddedilir (bkz. networkTrust.ts, kapalı arıza).
   */
  devSwapSimulate?: string;
  /**
   * 5. halkanın GERÇEK CAMARA sorgusunun açma/kapama anahtarı. Varsayılan KAPALI:
   * her açık halka HIGH katmandaki onaya bir CAMARA gidiş-dönüşü daha ekler, bu yüzden
   * hiçbir halka token'ın varlığıyla kendiliğinden açılmaz.
   */
  devSwapCheck: boolean;
  /**
   * Call Forwarding SİMÜLASYON kanalı ("kapali" | "acik"): güven zincirinin 6. halkası,
   * YALNIZ high risk katmanında koşar. Aynı gerekçeyle değer burada DOĞRULANMAZ.
   */
  callFwdSimulate?: string;
  /** 6. halkanın GERÇEK sorgu anahtarı. Varsayılan KAPALI (devSwapCheck ile aynı gerekçe). */
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
  AdsPilotConfig,
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
    stepUp: parseBool(process.env.ADSPILOT_STEPUP, false),
    nacToken: process.env.ADSPILOT_NAC_TOKEN?.trim() || undefined,
    approverPhone: process.env.ADSPILOT_APPROVER_PHONE?.trim() || undefined,
    // Bilerek ham geçirilir; "temiz"/"degisti" doğrulaması karar anında yapılır.
    nacSimulate: process.env.ADSPILOT_NAC_SIMULATE?.trim() || undefined,
    // Aynı gerekçe: "dogrulandi"/"uyusmadi" doğrulaması karar anında yapılır.
    nvSimulate: process.env.ADSPILOT_NV_SIMULATE?.trim() || undefined,
    // Aynı gerekçe: "erisilebilir"/"anormal" doğrulaması karar anında yapılır.
    reachSimulate: process.env.ADSPILOT_REACH_SIMULATE?.trim() || undefined,
    /**
     * Varsayılan KAPALI. parseBool anlaşılamayan değeri de güvenli tarafa (kapalı)
     * aldığı için bozuk bir değer halkayı açık bırakmaz — açmak açık bir niyet ister.
     */
    reachCheck: parseBool(process.env.ADSPILOT_REACH_CHECK, false),
    // Aynı gerekçe: "beklenen"/"beklenmedik" doğrulaması karar anında yapılır.
    locSimulate: process.env.ADSPILOT_LOC_SIMULATE?.trim() || undefined,
    /**
     * Ham geçirilir: iki-harf (ISO 3166-1 alpha-2) doğrulaması karar anındadır. Boş/eksik
     * değer burada undefined olur ve konum halkası HİÇ KOŞMAZ (beklenti uydurulmaz).
     */
    expectedCountry: process.env.ADSPILOT_EXPECTED_COUNTRY?.trim() || undefined,
    // Aynı gerekçe: "temiz"/"degisti" doğrulaması karar anında yapılır.
    devSwapSimulate: process.env.ADSPILOT_DEVICESWAP_SIMULATE?.trim() || undefined,
    /**
     * Varsayılan KAPALI — reachCheck ile aynı gerekçe, artı gecikme: açık her gerçek
     * halka HIGH katmandaki onaya bir CAMARA gidiş-dönüşü ekler. parseBool anlaşılamayan
     * değeri de güvenli tarafa (kapalı) aldığı için bozuk bir değer halkayı açmaz.
     */
    devSwapCheck: parseBool(process.env.ADSPILOT_DEVICESWAP_CHECK, false),
    // Aynı gerekçe: "kapali"/"acik" doğrulaması karar anında yapılır.
    callFwdSimulate: process.env.ADSPILOT_CALLFWD_SIMULATE?.trim() || undefined,
    callFwdCheck: parseBool(process.env.ADSPILOT_CALLFWD_CHECK, false),
    simSwapWindowHours: parseNumEnv(
      "ADSPILOT_SIMSWAP_WINDOW_HOURS",
      process.env.ADSPILOT_SIMSWAP_WINDOW_HOURS,
      72
    ),
  };
}

/** nacConfigFromEnv()'in döndürdüğü dilimin tipi — anahtar üreticisi bunu alır. */
export type NacDilimi = ReturnType<typeof nacConfigFromEnv>;

/**
 * Ağ-doğrulama ayarlarının bağlam önbelleği anahtarına giren parçası.
 *
 * Burada durmasının sebebi sınanabilirlik: http.ts başlangıçta hosted ortamı doğrulayıp
 * eksik yapılandırmada process.exit çağırdığı için testten import EDİLEMEZ. Anahtar orada
 * kaldığı sürece ancak kaynak METNİ taranarak sınanabiliyordu — ve metin taraması, bir
 * alanı yorum satırına almayı fark etmiyordu (mutasyonla kanıtlandı: satırı `//` ile
 * kapatınca 6. halkanın iki ayarı anahtardan düşüyor, hiçbir test kızarmıyordu).
 * Saf fonksiyon olarak burada, "şu alan değişince anahtar gerçekten değişiyor mu" diye
 * DAVRANIŞSAL olarak sınanır.
 *
 * Zincire halka eklemek, alanlarını buraya eklemek demektir. Eksiklik sessiz ve tek
 * yönlüdür: halkayı AÇAN operatör, halka KAPALIYKEN üretilmiş bağlamı önbellekten almaya
 * devam eder ve hiç koşmayan bir korumanın koştuğuna inanır.
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
    // Kademe bir GEVŞEMEDİR: anahtara girmezse, yükseltmeyi açan operatör kapalıyken
    // üretilmiş bağlamı almaya devam eder ve açtığını sandığı yol hiç koşmaz.
    String(nac.stepUp ?? ""),
  ];
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
    metaToken: process.env.ADSPILOT_META_TOKEN?.trim() || undefined,
    metaAdAccountId: process.env.ADSPILOT_META_AD_ACCOUNT_ID?.trim() || undefined,
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!.trim(),
    clientId: process.env.GOOGLE_ADS_CLIENT_ID!.trim(),
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET!.trim(),
    refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN!.trim(),
    loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.trim() || undefined,
    writeEnabled: parseBool(process.env.ADSPILOT_WRITE_ENABLED, true),
    maxDailyBudget: parseBudgetCap(process.env.ADSPILOT_MAX_DAILY_BUDGET),
    ...nacConfigFromEnv(),
  };
}

/**
 * Flag parsing that errs on the SAFE side.
 * Accepting only a literal "0" as off is not enough: a user who writes `=false`,
 * `=no` or `=off` believes writes are disabled while the tools that spend real
 * money stay enabled. Any unrecognised value is treated as off as well.
 */
export function parseBool(raw: string | undefined, varsayilan: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return varsayilan;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on", "evet", "acik", "açık"].includes(v)) return true;
  if (["0", "false", "no", "off", "hayir", "hayır", "kapali", "kapalı"].includes(v)) return false;
  console.error(`[adspilot] Uyarı: anlaşılamayan bayrak değeri '${raw}' — güvenli tarafa (kapalı) alındı.`);
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
    console.error(`[adspilot] Uyarı: ${name}='${raw}' geçersiz — varsayılan ${varsayilan} kullanılıyor.`);
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
    console.error(
      `[adspilot] Uyarı: ADSPILOT_MAX_DAILY_BUDGET='${raw}' geçersiz — bütçe tavanı ${DEFAULT} olarak zorlandı.`
    );
    return DEFAULT;
  }
  return n;
}
