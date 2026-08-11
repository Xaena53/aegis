/** Saf yardımcılar — dış bağımlılık yok, birim testleri test/ altında. */

/** customerId: tireli/tiresiz kabul eder ("123-456-7890" → "1234567890") */
export function normalizeCustomerId(id: string): string {
  return id.replace(/[^0-9]/g, "");
}

/** ID alanları sadece rakam olmalı (GAQL'e ham gömüldükleri için). */
export function invalidId(label: string, v: string): string | null {
  return /^\d+$/.test(v.trim()) ? null : `Geçersiz ${label}: '${v}' — sadece rakamlardan oluşmalı.`;
}

/** Büyük/küçük harf duyarsız tekilleştirme; sıra korunur, boşlar atılır. */
export function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((s) => {
    const k = s.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
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

/** LIMIT'siz GAQL tüm sayfaları belleğe çeker — yoksa sona LIMIT ekle. */
export function ensureGaqlLimit(query: string, limit: number): string {
  return /\bLIMIT\s+\d+/i.test(query) ? query : `${query.trim()} LIMIT ${limit}`;
}

/** Bütçe kelepçesi: tavanı aşan/geçersiz istekler için ret mesajı, geçerliyse null. */
export function budgetGuard(amount: number, cap: number): string | null {
  // Kemer-pantolon askısı: tavan bozuksa (NaN/<=0) sessiz geçirme, reddet
  if (!Number.isFinite(cap) || cap <= 0) {
    return "Reddedildi: bütçe tavanı yapılandırması geçersiz (ADSPILOT_MAX_DAILY_BUDGET) — düzeltilmeden bütçe işlemi yapılmaz.";
  }
  if (amount > cap) {
    return (
      `Reddedildi: istenen günlük bütçe (${amount}) güvenlik tavanının (${cap}) üzerinde. ` +
      `Tavan .env'de ADSPILOT_MAX_DAILY_BUDGET ile yönetilir; kullanıcı onayı olmadan yükseltme.`
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

/** Google Ads API hatalarını okunur tek satıra indirger (hata kodu adı + mesaj). */
export function formatAdsError(err: unknown): string {
  const e = err as any;
  const fromList = e?.errors
    ?.map((x: any) => {
      const code = x?.error_code ? Object.keys(x.error_code).filter((k) => x.error_code[k])[0] : null;
      const codeVal = code ? `${code}=${x.error_code[code]}` : null;
      return [codeVal, x?.message].filter(Boolean).join(": ");
    })
    .filter(Boolean)
    .join("; ");
  return `Google Ads API hatası: ${fromList || e?.message || String(err)}`;
}

/** Geçici (retry edilebilir) hata mı? gRPC 4/8/14 veya kota/uygunluk mesajları. */
export function isTransientAdsError(e: unknown): boolean {
  const err = e as any;
  if (err?.code === 4 || err?.code === 8 || err?.code === 14) return true;
  const msg = String(err?.message ?? "");
  return /UNAVAILABLE|DEADLINE_EXCEEDED|RESOURCE_EXHAUSTED|QuotaError|INTERNAL_ERROR|too many requests/i.test(msg);
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
