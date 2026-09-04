// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared guards, GAQL hygiene and error formatting.
 *
 * GAQL text is normalised before it reaches the client library, which parses queries
 * itself and mis-handles multi-line input. String literals are preserved during that
 * normalisation because collapsing whitespace inside them changes what a query matches.
 *
 * Every export here is directly unit-tested in test/util.test.ts.
 */
import { errors as adsErrors } from "google-ads-api";

/** Accepts a customer ID with or without dashes ("123-456-7890" → "1234567890"). */
export function normalizeCustomerId(id: string): string {
  return id.replace(/[^0-9]/g, "");
}

/** ID fields must be digits only, since they are interpolated into GAQL and resource names. */
export function invalidId(label: string, v: string): string | null {
  return /^\d+$/.test(v.trim()) ? null : `Geçersiz ${label}: '${v}' — sadece rakamlardan oluşmalı.`;
}

/**
 * Returns the trimmed form of an already-validated ID.
 *
 * `invalidId` validates the trimmed value, so resource names must use that SAME trimmed
 * value. Otherwise " 123" passes validation and then produces a malformed resource name
 * such as "adGroups/ 123", which the API rejects with an opaque error.
 */
export function cleanId(v: string): string {
  return v.trim();
}

/**
 * Case-insensitive de-duplication; input order is kept and blanks are dropped.
 *
 * Turkish dotted-I: "ÜCRETSİZ".toLowerCase() yields "ücretsi̇z" with a combining dot, which
 * does not equal "ücretsiz". Keying on both the invariant and the tr-TR lowercase variant
 * catches the pair either way round.
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
 * Country geo target IDs. Google's country geoTargetConstant ID is 2000 + the ISO 3166
 * numeric code (TR 792 → 2792, US 840 → 2840). The pattern was checked against Google's
 * own published list rather than assumed.
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

/** Currency amount → micros, rounded so float multiplication cannot leak a remainder. */
export function toMicrosInt(amount: number): number {
  return Math.round(amount * 1_000_000);
}

/**
 * FAIL-CLOSED NUMBER READING: only a value that genuinely becomes a number counts as one.
 *
 * `Number(null)` and `Number("")` produce zero, `Number(undefined)` produces NaN — so the
 * common `Number(x ?? 0)` idiom erases the difference between "the field never arrived" and
 * "the value was zero". In this repository that difference is monetary: reporting a cost
 * that could not be read as 0 tells the agent "nothing was spent", and the agent raises the
 * budget. When the value cannot be read this returns undefined, and the caller either omits
 * the field entirely or admits it in the text as "OKUNAMADI" (unreadable).
 */
export function sayiOku(ham: unknown): number | undefined {
  if (typeof ham !== "number" && typeof ham !== "string") return undefined;
  const sayi = typeof ham === "string" ? (ham.trim() === "" ? NaN : Number(ham)) : ham;
  return Number.isFinite(sayi) ? sayi : undefined;
}

/**
 * Google Ads `amount_micros` -> an amount in the account's currency.
 *
 * This contract was born in write.ts (an unreadable budget counted as 0, and 0 clears every
 * ceiling, so a campaign could quietly go live), then repeated in the Meta client — while
 * the read surfaces (read.ts, resources.ts) still used `?? 0` and wrote the same mistake
 * into their reports without a word. It moved into one helper so that "unknown is not 0"
 * has a single definition.
 *
 * A negative value is REFUSED too: Google does not send negative micros, so a negative
 * reading means the read itself is broken. It returns the currency amount, NOT micros: the
 * number that lands in the record is the number a person reads.
 */
export function mikrodanTutar(ham: unknown): number | undefined {
  const sayi = sayiOku(ham);
  if (sayi === undefined || sayi < 0) return undefined;
  return sayi / 1e6;
}

/** In report text an unreadable number does NOT stay silent: instead of "0.00" it prints an
 * explicit admission. */
export function sayiMetni(v: number | undefined, basamak = 0): string {
  return v === undefined ? "OKUNAMADI" : v.toFixed(basamak);
}

/**
 * GAQL string literal: single OR double quoted.
 *
 * Matching only single quotes caused two distinct failures — the keyword scan could land
 * inside a double-quoted literal and inject LIMIT into the middle of the text, and an
 * oversized user LIMIT survived the clamp entirely.
 */
const GAQL_METIN_SABITI = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;

/**
 * Normalises GAQL whitespace. Every query must pass through here before it reaches the API.
 *
 * The google-ads-api client parses the query with its own regex to decide which fields to
 * write onto result rows, and it does not collapse single newlines. In a multi-line query
 * the LAST field of the SELECT list becomes a mangled name like "cost_microsfromcampaign"
 * and its value arrives as null — silently. An agent reading that as "no spend" could then
 * raise a budget. Collapsing all whitespace to single spaces removes the entire class.
 *
 * Collapsing must skip string literals: naive collapsing rewrote a campaign name like
 * 'Yaz  İndirimi' to 'Yaz İndirimi', so the query matched nothing — the same silent
 * data-loss failure this function exists to prevent.
 */
export function normalizeGaql(query: string): string {
  const sabitler: string[] = [];
  const maskeli = query.replace(GAQL_METIN_SABITI, (m) => {
    sabitler.push(m);
    return `\u0000${sabitler.length - 1}\u0000`;
  });
  const sikistirilmis = maskeli.replace(/\s+/g, " ").trim();
  return sikistirilmis.replace(/\u0000(\d+)\u0000/g, (_, i) => satirSonuKacir(sabitler[Number(i)]!));
}

/**
 * Converts a raw newline INSIDE a string literal into its GAQL escape sequence.
 *
 * Putting the literals back untouched reinstated the very fault this function exists to
 * prevent, this time from INSIDE the literal: the client's field parser (parser.js, whose
 * `( from .*)` regex runs WITHOUT the `s` flag) stops the dot at a newline. In a request
 * querying a campaign whose name contains a newline, the LAST field of the SELECT list
 * (metrics.clicks, when measured) turns into a malformed name and is never written to the
 * rows — and the agent reads that as "no clicks". The escape does not change the text the
 * literal MATCHES; it only takes the raw control character out of the query.
 */
function satirSonuKacir(sabit: string): string {
  return sabit.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

/** Blanks the INSIDE of string literals, preserving length, so keyword scans cannot match there. */
function maskGaqlStrings(q: string): string {
  return q.replace(GAQL_METIN_SABITI, (m) => m[0] + "x".repeat(Math.max(0, m.length - 2)) + m[0]);
}

/**
 * Guarantees a LIMIT and enforces the ceiling.
 *
 * A query without LIMIT pulls every page into memory, and a huge user-supplied LIMIT does
 * the same — in a shared hosted process that is an OOM that takes every tenant down with
 * it, so an existing LIMIT is clamped rather than trusted. The PARAMETERS clause must stay
 * after LIMIT, which is where GAQL requires it.
 *
 * THE TRAILING SEMICOLON IS DROPPED HERE. GAQL has no statement terminator, but on a
 * query written out of SQL habit as "... LIMIT 500000;" the `LIMIT\s+(\d+)$` anchor does not
 * match, the clamp never runs, and the query goes out as "LIMIT 500000; LIMIT 100": the
 * ceiling is bypassed and an unintelligible QueryError is produced on top. The trim is done
 * against the text with literals MASKED, so that a ";" ending inside a literal is not
 * removed by accident and the body and the mask stay the same length (m.index depends on
 * that equality).
 */
export function ensureGaqlLimit(query: string, limit: number): string {
  const q = normalizeGaql(query);
  const masked = maskGaqlStrings(q); // same length as q, so indices stay valid
  const pIdx = masked.search(/\bPARAMETERS\b/i);
  const bodyEnd = pIdx >= 0 ? pIdx : q.length;
  const govdeKesim = masked.slice(0, bodyEnd).replace(/[\s;]+$/, "").length;
  const body = q.slice(0, govdeKesim);
  const maskedBody = masked.slice(0, govdeKesim);
  const kuyrukKesim = pIdx >= 0 ? masked.slice(pIdx).replace(/[\s;]+$/, "").length : 0;
  const tail = pIdx >= 0 ? ` ${q.slice(pIdx, pIdx + kuyrukKesim).trim()}` : "";

  const m = /\bLIMIT\s+(\d+)$/i.exec(maskedBody);
  if (m) {
    if (Number(m[1]) <= limit) return body + tail;
    return `${body.slice(0, m.index).trimEnd()} LIMIT ${limit}${tail}`;
  }
  return `${body} LIMIT ${limit}${tail}`;
}

/** Budget clamp: returns a refusal message for an over-ceiling or invalid request, null if allowed. */
export function budgetGuard(amount: number, cap: number): string | null {
  // Belt and braces: a broken ceiling (NaN or <= 0) is refused, never waved through
  if (!Number.isFinite(cap) || cap <= 0) {
    return "Reddedildi: bütçe tavanı yapılandırması geçersiz (AEGIS_MAX_DAILY_BUDGET) — düzeltilmeden bütçe işlemi yapılmaz.";
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
 * GAQL date predicate covering the last N days, ending yesterday so today's partial data is
 * excluded. Local time is used deliberately: deriving the range from UTC midnight shifts the
 * window by a day for users far from UTC.
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
 * Runtime mode, so error hints tell the user something they can actually act on.
 *
 * stdio: the user runs the server on their own machine and owns the .env file.
 * hosted: the user is connected to a remote server and has NO .env and no terminal, so a
 * hint like "edit your .env" is worse than no hint at all.
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

/** Actionable, mode-aware hints for the errors users actually hit. */
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
 * Resolves a numeric error code to its enum name.
 *
 * On the gRPC path Google returns a NUMBER, e.g. `error_code: { authorization_error: 24 }`.
 * The raw number means nothing to the user and it also kills name-based hint matching
 * outright. `authorization_error` maps to AuthorizationErrorEnum.AuthorizationError[24].
 */
function resolveErrorCodeName(key: string, value: unknown): string {
  if (typeof value !== "number") return String(value);
  const pascal = key.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
  const table = (adsErrors as any)?.[`${pascal}Enum`]?.[pascal];
  const name = table && typeof table === "object" ? table[value] : undefined;
  return typeof name === "string" ? name : String(value);
}

/** Reduces a Google Ads API error to one readable line: code name, message and a hint. */
export function formatAdsError(err: unknown): string {
  const e = err as any;
  const fromList = e?.errors
    ?.map((x: any) => {
      // `!= null` rather than a truthy filter: a truthy test drops the code whose enum
      // value is 0 (UNSPECIFIED) and the error name disappears from the message.
      const code = x?.error_code ? Object.keys(x.error_code).filter((k) => x.error_code[k] != null)[0] : null;
      const codeVal = code ? `${code}=${resolveErrorCodeName(code, x.error_code[code])}` : null;
      // Which field? On a REQUIRED error this is the path of the offending field.
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

/** Transient (safely retryable) error? gRPC codes 4/8/14, or a quota/availability message. */
export function isTransientAdsError(e: unknown): boolean {
  const err = e as any;
  if (err?.code === 4 || err?.code === 8 || err?.code === 14) return true;
  const msg = String(err?.message ?? "");
  return /UNAVAILABLE|DEADLINE_EXCEEDED|RESOURCE_EXHAUSTED|QuotaError|INTERNAL_ERROR|too many requests/i.test(msg);
}

/**
 * Detects CONCURRENT_MODIFICATION.
 *
 * Google EXPLICITLY rejects the request on this error — the write is not applied — and the
 * documentation says to retry it. That makes it the only error class a mutation can be
 * retried on without risking a duplicate.
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
 * Retry with exponential backoff and jitter.
 *
 * For reads and idempotent calls ONLY. Retrying a mutation can create a duplicate campaign
 * or keyword, so write paths pass a narrower `isTransient` (see isConcurrentModificationError).
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

/**
 * Brings a Map down to its ceiling by EVICTING THE LEAST RECENTLY USED — and names what it
 * dropped.
 *
 * A Map preserves insertion order, so the first key is the oldest; as long as the caller
 * deletes and re-inserts an entry on every ACCESS, "oldest" really does mean "least
 * recently used".
 *
 * WHY IT IS A SEPARATE FUNCTION: written in place, it had no guard. http.ts is an entry
 * point and cannot be imported from a test; while the ceiling lived there, turning
 * `while (ctxCache.size >= 500)` into `while (false)` — that is, removing the bound
 * entirely — left the suite green (measured with a mutation). As a pure function it can be
 * tested behaviourally here.
 *
 * Its earlier form was `cache.clear()`, which spread one tenant's behaviour across every
 * tenant: a tenant producing 500 distinct keys could drop everybody's context, and the
 * short-lived account cache hanging off it.
 */
export function lruYerAc<K, V>(cache: Map<K, V>, tavan: number): K[] {
  const dusenler: K[] = [];
  while (cache.size >= tavan) {
    const enEski = cache.keys().next();
    if (enEski.done) break;
    cache.delete(enEski.value);
    dusenler.push(enEski.value);
  }
  return dusenler;
}
