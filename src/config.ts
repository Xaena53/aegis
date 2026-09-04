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
   * KADEMELİ DOĞRULAMA (AEGIS_STEPUP) — varsayılan KAPALI.
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
    // Bilerek ham geçirilir; "temiz"/"degisti" doğrulaması karar anında yapılır.
    nacSimulate: process.env.AEGIS_NAC_SIMULATE?.trim() || undefined,
    // Aynı gerekçe: "dogrulandi"/"uyusmadi" doğrulaması karar anında yapılır.
    nvSimulate: process.env.AEGIS_NV_SIMULATE?.trim() || undefined,
    // Aynı gerekçe: "erisilebilir"/"anormal" doğrulaması karar anında yapılır.
    reachSimulate: process.env.AEGIS_REACH_SIMULATE?.trim() || undefined,
    /**
     * Varsayılan KAPALI. parseBool anlaşılamayan değeri de güvenli tarafa (kapalı)
     * aldığı için bozuk bir değer halkayı açık bırakmaz — açmak açık bir niyet ister.
     */
    reachCheck: parseBool(process.env.AEGIS_REACH_CHECK, false, "AEGIS_REACH_CHECK"),
    // Aynı gerekçe: "beklenen"/"beklenmedik" doğrulaması karar anında yapılır.
    locSimulate: process.env.AEGIS_LOC_SIMULATE?.trim() || undefined,
    /**
     * Ham geçirilir: iki-harf (ISO 3166-1 alpha-2) doğrulaması karar anındadır. Boş/eksik
     * değer burada undefined olur ve konum halkası HİÇ KOŞMAZ (beklenti uydurulmaz).
     */
    expectedCountry: process.env.AEGIS_EXPECTED_COUNTRY?.trim() || undefined,
    // Aynı gerekçe: "temiz"/"degisti" doğrulaması karar anında yapılır.
    devSwapSimulate: process.env.AEGIS_DEVICESWAP_SIMULATE?.trim() || undefined,
    /**
     * Varsayılan KAPALI — reachCheck ile aynı gerekçe, artı gecikme: açık her gerçek
     * halka HIGH katmandaki onaya bir CAMARA gidiş-dönüşü ekler. parseBool anlaşılamayan
     * değeri de güvenli tarafa (kapalı) aldığı için bozuk bir değer halkayı açmaz.
     */
    devSwapCheck: parseBool(process.env.AEGIS_DEVICESWAP_CHECK, false, "AEGIS_DEVICESWAP_CHECK"),
    // Aynı gerekçe: "kapali"/"acik" doğrulaması karar anında yapılır.
    callFwdSimulate: process.env.AEGIS_CALLFWD_SIMULATE?.trim() || undefined,
    callFwdCheck: parseBool(process.env.AEGIS_CALLFWD_CHECK, false, "AEGIS_CALLFWD_CHECK"),
    simSwapWindowHours: parseNumEnv(
      "AEGIS_SIMSWAP_WINDOW_HOURS",
      process.env.AEGIS_SIMSWAP_WINDOW_HOURS,
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

/**
 * KİRACI DİLİMİ — bağlam önbelleği anahtarının kimlik ve kelepçe yarısı.
 *
 * `nacAnahtarDilimi` ile aynı gerekçeyle burada: http.ts test edilemediği için anahtarın
 * bu yarısı da bekçisizdi ve eksikliği ölçüldü — `user.writeEnabled` ya da
 * `user.maxDailyBudget` anahtardan tek tek veya topluca silindiğinde takım YEŞİL kalıyordu.
 *
 * Her alanın anahtarda olmasının ayrı bir sebebi var ve hiçbiri süs değil:
 *   id / refreshToken / loginCustomerId → KİRACI KİMLİĞİ. Düşerse iki kiracı aynı
 *     AdsContext'i paylaşır: birinin jetonuyla ötekinin hesabına yazılır.
 *   writeEnabled → yazma kelepçesi. Düşerse, yazmayı KAPATAN operatör açıkken üretilmiş
 *     bağlamı almaya devam eder; ayarlar sayfasının "anında geçerli" sözü sessizce ölür.
 *   maxDailyBudget → harcama tavanı. Düşerse tavanı İNDİREN operatör eski, yüksek tavanla
 *     hizmet görmeye devam eder.
 *
 * Not: eksiklik hep GEVŞEME yönünde ısırır — sıkılaştırma uygulanmaz, gevşeklik kalır.
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
   * DEĞER YAZILMAZ, DEĞİŞKEN ADI YAZILIR.
   *
   * Bu uyarı stderr'e gider; stderr ise MCP günlük dosyasına, `docker logs`a ve
   * prova/smoke terminal çıktısına akar. Yanlış slota yapıştırılmış bir jeton ya da
   * onaylayıcı telefon numarası — ki bunlar tam da yazım hatasıyla yanlış değişkene
   * düşen şeylerdir — eskiden buradan tamamıyla loglanırdı. networkTrust.ts yedi ayrı
   * yerde "değer sır ihtimaline karşı gösterilmez" diyor; burası aynı kuralın tersini
   * yapıyordu. Operatörün neyi düzelteceğini bilmesi için değişken adı + beklenen biçim
   * yeter; hangi yanlış değeri yazdığını zaten kendisi biliyor.
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
    // parseBool ile aynı gerekçe: ham değer loga akmaz, yalnız değişken adı + beklenen biçim.
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
    // parseBool ile aynı gerekçe: ham değer loga akmaz.
    console.error(
      `[aegis] Uyarı: AEGIS_MAX_DAILY_BUDGET geçersiz (beklenen: 0'dan büyük bir sayı) — ` +
        `bütçe tavanı ${DEFAULT} olarak zorlandı. Değer sır ihtimaline karşı gösterilmiyor.`
    );
    return DEFAULT;
  }
  return n;
}

/**
 * DÜZ METİN (TLS'siz) DİNLEME KARARI — yayın biçiminden BAĞIMSIZ.
 *
 * NEDEN VAR: hosted sunucu her zaman düz HTTP konuşur; şifrelemeyi önündeki nginx/Caddy
 * sonlandırır. Eski uyarı yalnız AEGIS_PUBLIC_URL'e bakıyordu, dolayısıyla TLS'in
 * gerçekten atlanabildiği iki durumda SUSUYORDU:
 *   1) PUBLIC_URL https:// ama süreç 0.0.0.0'a bağlı — 443'ün yanında şifresiz bir port
 *      açık kalır; /connect ve /settings düz HTTP yanıtlar, /mcp için doğru Host başlığı
 *      yeter. Ters vekil, saldırgan için isteğe bağlı hâle gelir.
 *   2) PUBLIC_URL http:// ama makine "localhost" değil bir iç ad — kimlik bilgileri
 *      açık metin taşınır.
 * Karar bu yüzden İKİ girdiye birden bakar: nereye bağlandık ve kullanıcılar bize hangi
 * şemayla ulaşıyor. Düz metin bir genel adres artık sessiz bir uyarı değil, AÇIK ONAY
 * (AEGIS_ALLOW_PLAINTEXT) isteyen bir engeldir — "bilinmiyor" ile "güvenli" aynı şey
 * değildir ve varsayılan RET olmalıdır.
 */
const YEREL_ADLAR = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

/** Yalnız bu makineden erişilebilen bir bağlanma adresi mi? */
export function yerelAdres(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (YEREL_ADLAR.has(h) || YEREL_ADLAR.has(`[${h}]`)) return true;
  // 127.0.0.0/8'in tamamı loopback'tir (127.0.0.1 dışındaki adresler de dahil).
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
    // Okunamayan URL "temiz" sayılmaz: doğrulanamayan yapılandırma uyarıyı hak eder.
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

  // Dinleyicinin kendisi her hâlükârda düz HTTP: loopback dışına bağlıysa bunu SÖYLE.
  // https bir PUBLIC_URL bu portu kapatmaz; yalnız vekilin önerilen yolunu anlatır.
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
