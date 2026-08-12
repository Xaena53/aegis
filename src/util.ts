/** Yardımcılar — birim testleri test/ altında. */
import { errors as adsErrors } from "google-ads-api";

/** customerId: tireli/tiresiz kabul eder ("123-456-7890" → "1234567890") */
export function normalizeCustomerId(id: string): string {
  return id.replace(/[^0-9]/g, "");
}

/** ID alanları sadece rakam olmalı (GAQL'e ve kaynak adlarına gömüldükleri için). */
export function invalidId(label: string, v: string): string | null {
  return /^\d+$/.test(v.trim()) ? null : `Geçersiz ${label}: '${v}' — sadece rakamlardan oluşmalı.`;
}

/**
 * Doğrulanmış ID'yi temizlenmiş haliyle döner. invalidId trim'lenmiş değeri
 * doğruladığı için kaynak adlarında da AYNI temiz değer kullanılmalı — aksi
 * halde " 123" doğrulamayı geçip "adGroups/ 123" gibi bozuk kaynak adı üretir.
 */
export function cleanId(v: string): string {
  return v.trim();
}

/**
 * Büyük/küçük harf duyarsız tekilleştirme; sıra korunur, boşlar atılır.
 * Türkçe İ/i sorunu: "ÜCRETSİZ".toLowerCase() → "ücretsi̇z" (birleşik nokta) olduğundan
 * "ücretsiz" ile eşleşmez — iki lowercase varyantı (genel + tr-TR) birden anahtarlanır.
 */
export function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((s) => {
    const t = s.trim();
    if (!t) return false;
    const keys = [t.toLowerCase(), t.toLocaleLowerCase("tr-TR")];
    if (keys.some((k) => seen.has(k))) return false;
    for (const k of keys) seen.add(k);
    return true;
  });
}

/**
 * Ülke geo hedef ID'leri: Google'ın ülke geoTargetConstant ID'si = 2000 + ISO 3166 sayısal kod.
 * (Örn. TR=792→2792, US=840→2840 — Google'ın kendi listesiyle birebir doğrulanmış kalıp.)
 */
export const ISO_NUMERIC: Record<string, number> = {
  TR: 792, US: 840, GB: 826, DE: 276, FR: 250, ES: 724, IT: 380, NL: 528,
  BE: 56, AT: 40, CH: 756, SE: 752, NO: 578, DK: 208, FI: 246, PL: 616,
  PT: 620, GR: 300, RO: 642, BG: 100, CZ: 203, HU: 348, UA: 804, RU: 643,
  CA: 124, MX: 484, BR: 76, AR: 32, AU: 36, NZ: 554, JP: 392, KR: 410,
  CN: 156, IN: 356, ID: 360, SA: 682, AE: 784, EG: 818, ZA: 710, IL: 376,
  AZ: 31, KZ: 398, QA: 634, KW: 414, IE: 372, MY: 458, SG: 702, TH: 764,
};

export function geoTargetId(countryCode: string): number | null {
  const iso = ISO_NUMERIC[countryCode.toUpperCase()];
  return iso ? 2000 + iso : null;
}

/** Para birimi → micros: float çarpım artıkları olmadan (Google int64 bekler). */
export function toMicrosInt(amount: number): number {
  return Math.round(amount * 1_000_000);
}

/**
 * GAQL normalizasyonu — TÜM sorgular API'ye gitmeden buradan geçmeli.
 *
 * KRİTİK: google-ads-api istemcisi sorguyu regex ile ayrıştırıp hangi alanların
 * satırlara yazılacağını belirler ve tek `\n` karakterlerini sıkıştırmaz. Çok
 * satırlı bir sorguda SELECT listesinin SON alanı "cost_microsfromcampaign..."
 * gibi bozuk bir isme dönüşür ve değeri SESSİZCE null gelir. Bir ajan bunu
 * "harcama yok" sanıp bütçe artırabilir. Tüm boşlukları tek boşluğa indirmek
 * bu sınıf hatayı kökünden keser.
 */
export function normalizeGaql(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

/** Metin sabitlerinin İÇİNİ maskeler (uzunluk korunur) — anahtar sözcük araması yanılmasın. */
function maskGaqlStrings(q: string): string {
  return q.replace(/'(?:[^'\\]|\\.)*'/g, (m) => `'${"x".repeat(Math.max(0, m.length - 2))}'`);
}

/**
 * LIMIT'i garanti eder VE tavanı dayatır. LIMIT'siz sorgu tüm sayfaları belleğe
 * çeker; kullanıcının verdiği devasa LIMIT de aynı sonucu doğurur (paylaşılan
 * süreçte OOM → tüm kiracılar düşer), bu yüzden mevcut LIMIT de kırpılır.
 * PARAMETERS yan tümcesi GAQL'de LIMIT'ten SONRA gelmek zorundadır.
 */
export function ensureGaqlLimit(query: string, limit: number): string {
  const q = normalizeGaql(query);
  const masked = maskGaqlStrings(q); // aynı uzunlukta
  const pIdx = masked.search(/\bPARAMETERS\b/i);
  const bodyEnd = pIdx >= 0 ? pIdx : q.length;
  const body = q.slice(0, bodyEnd).trimEnd();
  const maskedBody = masked.slice(0, bodyEnd).trimEnd();
  const tail = pIdx >= 0 ? ` ${q.slice(pIdx).trim()}` : "";

  const m = /\bLIMIT\s+(\d+)$/i.exec(maskedBody);
  if (m) {
    if (Number(m[1]) <= limit) return body + tail;
    return `${body.slice(0, m.index).trimEnd()} LIMIT ${limit}${tail}`;
  }
  return `${body} LIMIT ${limit}${tail}`;
}

/** Bütçe kelepçesi: tavanı aşan/geçersiz istekler için ret mesajı, geçerliyse null. */
export function budgetGuard(amount: number, cap: number): string | null {
  // Kemer-pantolon askısı: tavan bozuksa (NaN/<=0) sessiz geçirme, reddet
  if (!Number.isFinite(cap) || cap <= 0) {
    return "Reddedildi: bütçe tavanı yapılandırması geçersiz (ADSPILOT_MAX_DAILY_BUDGET) — düzeltilmeden bütçe işlemi yapılmaz.";
  }
  if (amount > cap) {
    return (
      `Reddedildi: istenen günlük bütçe (${amount}) hesabın güvenlik tavanının (${cap}) üzerinde. ` +
      `Tavanı yalnızca hesap sahibi yükseltebilir; kendi başına aşmaya çalışma, kullanıcıya bildir.`
    );
  }
  if (amount <= 0 || !Number.isFinite(amount)) return "Reddedildi: bütçe 0'dan büyük olmalı.";
  return null;
}

/**
 * Son N günü kapsayan GAQL tarih koşulu (bugün hariç dünden geriye).
 * Yerel saat kullanılır — UTC gece yarısı kaymasıyla gün-kayması yaşanmasın.
 */
export function dateRange(days: number, now: Date = new Date()): string {
  const fmt = (t: Date) =>
    `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  const end = new Date(now);
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return `segments.date BETWEEN '${fmt(start)}' AND '${fmt(end)}'`;
}

/**
 * Çalışma modu — hata ipuçlarının doğru talimatı vermesi için.
 * stdio: kullanıcı sunucuyu kendi makinesinde .env ile çalıştırır.
 * hosted: kullanıcı uzak sunucuya bağlıdır, .env'i ya da terminali YOKTUR.
 */
export type RuntimeMode = "stdio" | "hosted";
let runtimeMode: RuntimeMode = "stdio";
let reconnectUrl = "";

export function setRuntimeMode(mode: RuntimeMode, connectUrl = ""): void {
  runtimeMode = mode;
  reconnectUrl = connectUrl;
}

function reauthHint(): string {
  return runtimeMode === "hosted"
    ? `İpucu: Google erişimi iptal edilmiş ya da süresi dolmuş — ${reconnectUrl || "/connect"} adresinden hesabını yeniden bağla.`
    : "İpucu: refresh token geçersiz ya da iptal edilmiş — `npm run auth` ile yeniden üret.";
}

function mccHint(): string {
  return runtimeMode === "hosted"
    ? "İpucu: MCC (yönetici) hesabı üzerinden erişiyorsan yönetici hesabının bu müşteriye erişim izni olmalı; alt hesabı list_accounts ile doğrula."
    : "İpucu: MCC (yönetici) üzerinden erişiyorsan .env'de GOOGLE_ADS_LOGIN_CUSTOMER_ID (MCC'nin 10 haneli ID'si) dolu olmalı.";
}

function clientHint(): string {
  return runtimeMode === "hosted"
    ? "İpucu: sunucunun OAuth yapılandırması hatalı — bu bir sunucu tarafı sorunu, yöneticiye bildir."
    : "İpucu: GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET hatalı ya da OAuth istemcisi silinmiş.";
}

/** Sık karşılaşılan hatalara moda uygun Türkçe çözüm ipuçları. */
const ERROR_HINTS: Array<[RegExp, () => string]> = [
  [/DEVELOPER_TOKEN_NOT_APPROVED|DEVELOPER_TOKEN_PROHIBITED/i, () =>
    "İpucu: kullanılan developer token henüz Test Access seviyesinde — gerçek (test olmayan) hesaplar için Basic Access onayı gerekiyor."],
  [/USER_PERMISSION_DENIED|login.customer.id/i, mccHint],
  [/invalid_grant/i, reauthHint],
  [/invalid_client|unauthorized_client/i, clientHint],
  [/CUSTOMER_NOT_FOUND|CUSTOMER_NOT_ENABLED/i, () =>
    "İpucu: müşteri ID yanlış ya da hesap etkin değil — list_accounts ile doğrula."],
];

/**
 * Sayısal hata kodunu okunur enum adına çevirir.
 * Google gRPC yolunda `error_code: { authorization_error: 24 }` gibi SAYI döner;
 * ham sayı hem kullanıcıya anlamsızdır hem de ad tabanlı ipucu eşleşmesini
 * tamamen ölü bırakır. `authorization_error` → AuthorizationErrorEnum.AuthorizationError[24].
 */
function resolveErrorCodeName(key: string, value: unknown): string {
  if (typeof value !== "number") return String(value);
  const pascal = key.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
  const table = (adsErrors as any)?.[`${pascal}Enum`]?.[pascal];
  const name = table && typeof table === "object" ? table[value] : undefined;
  return typeof name === "string" ? name : String(value);
}

/** Google Ads API hatalarını okunur tek satıra indirger (hata kodu adı + mesaj + ipucu). */
export function formatAdsError(err: unknown): string {
  const e = err as any;
  const fromList = e?.errors
    ?.map((x: any) => {
      const code = x?.error_code ? Object.keys(x.error_code).filter((k) => x.error_code[k])[0] : null;
      const codeVal = code ? `${code}=${resolveErrorCodeName(code, x.error_code[code])}` : null;
      // Hangi alan? (örn. REQUIRED hatasında suçlu alanın yolu)
      const path = x?.location?.field_path_elements
        ?.map((p: any) => (p.index != null ? `${p.field_name}[${p.index}]` : p.field_name))
        .join(".");
      return [codeVal, x?.message, path && `alan: ${path}`].filter(Boolean).join(" | ");
    })
    .filter(Boolean)
    .join("; ");
  const base = `Google Ads API hatası: ${fromList || e?.message || String(err)}`;
  const hint = ERROR_HINTS.find(([re]) => re.test(base))?.[1];
  return hint ? `${base}\n${hint()}` : base;
}

/** Geçici (retry edilebilir) hata mı? gRPC 4/8/14 veya kota/uygunluk mesajları. */
export function isTransientAdsError(e: unknown): boolean {
  const err = e as any;
  if (err?.code === 4 || err?.code === 8 || err?.code === 14) return true;
  const msg = String(err?.message ?? "");
  return /UNAVAILABLE|DEADLINE_EXCEEDED|RESOURCE_EXHAUSTED|QuotaError|INTERNAL_ERROR|too many requests/i.test(msg);
}

/**
 * CONCURRENT_MODIFICATION tespiti: Google bu hatada isteği AÇIKÇA reddeder
 * (yazma uygulanmaz) ve resmen "retry the request" der — mutasyonlar için
 * güvenle tekrar denenebilen TEK hata sınıfı budur.
 */
export function isConcurrentModificationError(e: unknown): boolean {
  const err = e as any;
  if (err?.errors?.some((x: any) => {
    const de = x?.error_code?.database_error;
    return de === 2 || de === "CONCURRENT_MODIFICATION";
  })) return true;
  return /CONCURRENT_MODIFICATION|modify the same resource/i.test(String(err?.message ?? ""));
}

export interface RetryOptions {
  tries?: number;
  baseMs?: number;
  isTransient?: (e: unknown) => boolean;
}

/**
 * Üstel geri çekilmeli tekrar deneme. YALNIZ okuma/idempotent işlemler için —
 * mutasyonlarda tekrar deneme çift kayıt oluşturabilir, orada kullanma.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const tries = opts.tries ?? 3;
  const baseMs = opts.baseMs ?? 400;
  const transient = opts.isTransient ?? isTransientAdsError;
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!transient(e) || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i + Math.random() * baseMs * 0.5));
    }
  }
  throw lastErr;
}
