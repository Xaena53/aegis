// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared guards, GAQL hygiene and error formatting.
 *
 * GAQL text is normalised before it reaches the client library, which parses queries
 * itself and mis-handles multi-line input. String literals are preserved during that
 * normalisation because collapsing whitespace inside them changes what a query matches.
 *
 * Every export here is covered by a direct unit test under test/ — the bulk in
 * test/util.test.ts, the round-3 additions in test/faz3Util.test.ts and the round-5
 * additions in test/faz5Util.test.ts, which together keep that sentence honest by walking
 * this file's exports.
 *
 * WHAT THAT SENTENCE BINDS: every VALUE export. `export const` and `export class` count
 * exactly as much as `export function`. The round-3 walker matched `^export (?:async )?function`
 * only, so ISO_NUMERIC — a value export, read at a refusal site in src/tools/write.ts — sat
 * with no test of its own while the suite stayed green and the sentence above claimed
 * otherwise. The round-5 walker PARSES this file instead of grepping it, so a new
 * `export const` is seen the moment it is written. Type-only exports (RuntimeMode,
 * RetryOptions) carry no runtime behaviour and are checked by the compiler, not by a test.
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
  const { body, maskedBody, tail } = gaqlBolumleri(query);
  const m = /\bLIMIT\s+(\d+)$/i.exec(maskedBody);
  if (m) {
    if (Number(m[1]) <= limit) return body + tail;
    return `${body.slice(0, m.index).trimEnd()} LIMIT ${limit}${tail}`;
  }
  return `${body} LIMIT ${limit}${tail}`;
}

/**
 * Splits a normalised query into its body, the length-matched mask of that body, and the
 * PARAMETERS tail. Shared by every rewrite below so the semicolon trim, the literal
 * masking and the PARAMETERS placement are decided in exactly ONE place: a second copy of
 * this parsing would be a second chance to disagree about where the body ends, and the
 * index arithmetic depends on `maskedBody` and `body` having the same length.
 */
function gaqlBolumleri(query: string): { body: string; maskedBody: string; tail: string } {
  const q = normalizeGaql(query);
  const masked = maskGaqlStrings(q); // same length as q, so indices stay valid
  const pIdx = masked.search(/\bPARAMETERS\b/i);
  const bodyEnd = pIdx >= 0 ? pIdx : q.length;
  const govdeKesim = masked.slice(0, bodyEnd).replace(/[\s;]+$/, "").length;
  const kuyrukKesim = pIdx >= 0 ? masked.slice(pIdx).replace(/[\s;]+$/, "").length : 0;
  return {
    body: q.slice(0, govdeKesim),
    maskedBody: masked.slice(0, govdeKesim),
    tail: pIdx >= 0 ? ` ${q.slice(pIdx, pIdx + kuyrukKesim).trim()}` : "",
  };
}

/**
 * SATURATION PROBE for a free-form query: the statement to send, and the row cap it can
 * actually measure.
 *
 * `ensureGaqlLimit` is a CLAMP — it leaves an existing LIMIT alone whenever that LIMIT is
 * at or below the ceiling. That is right for a ceiling and wrong for a probe: asking for
 * exactly as many rows as will be displayed makes `rows.length > cap` unreachable, so
 * "exactly cap rows exist" and "at least cap rows exist" become indistinguishable and
 * truncation is reported as `false` — not measured false, STRUCTURALLY false. A caller
 * writing its own `... LIMIT 100` therefore switched the probe off: on an account holding
 * 5000 negative keywords the tool answered "100 satır, kesildi:false" and the agent read
 * that as the account HAVING 100 of them.
 *
 * So the effective cap is the SMALLER of the two limits — the query's own LIMIT still
 * binds, it is never raised behind the caller's back — and the probe is that cap + 1. The
 * ceiling still holds, because the result can never exceed `goster`. A degenerate
 * `LIMIT 0` therefore still shows nothing: the single row fetched is the probe, and a probe
 * row is never displayed, only counted.
 *
 * `goster` is validated rather than clamped: an invalid ceiling throws instead of silently
 * becoming some other number (this repository does not silently correct values). The refusal
 * says exactly what this gate checks — an integer of at least 1 — and no more. There is no
 * upper bound HERE; the 1000-row ceiling lives in the caller's schema (tools/read.ts, zod
 * `.max(1000)`), and a message announcing a limit this function never applies would describe
 * a gate that does not exist.
 */
export function gaqlDoymaProbu(query: string, goster: number): { sorgu: string; tavan: number } {
  if (!Number.isInteger(goster) || goster < 1) {
    throw new Error(`Geçersiz satır tavanı: ${goster} — 1 veya daha büyük tam sayı olmalı.`);
  }
  const { body, maskedBody, tail } = gaqlBolumleri(query);
  const m = /\bLIMIT\s+(\d+)$/i.exec(maskedBody);
  const yazili = m ? Number(m[1]) : undefined;
  const tavan = yazili === undefined ? goster : Math.min(yazili, goster);
  // The written LIMIT is taken OFF and the probe is imposed through `ensureGaqlLimit`, so
  // a LIMIT still only ever gets written into a query in one place.
  const govde = m ? body.slice(0, m.index).trimEnd() : body;
  return { sorgu: ensureGaqlLimit(`${govde}${tail}`, tavan + 1), tavan };
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

/**
 * The ceiling on upstream error text.
 *
 * Larger than the 400 characters a terminal summary gets (scripts/brain/uygulama.mjs,
 * gorunurOzet) on purpose: this string is the agent's ONLY account of a failed call, and
 * Google returns one entry per failed operation, so a 400-character cut would hide which
 * field a mutate refused. The cap is here to stop a runaway or hostile upstream from
 * flooding the agent's context, not to summarise.
 */
const HATA_METNI_TAVANI = 1000;

/**
 * Characters that are INVISIBLE, that REORDER what is printed around them, or that OPEN A
 * NEW LINE without being a C0 control byte.
 *
 * Stripping ESC alone leaves the docblock's own threat standing. U+202E (RIGHT-TO-LEFT
 * OVERRIDE) reverses the render direction of everything after it, so upstream text can
 * repaint a refusal as an approval with no escape sequence at all; U+2028 and U+2029 are
 * line separators a terminal honours, which is exactly how a second line that looks like
 * ours gets forged; and the Unicode TAGS block (U+E0000–U+E007F) is the known channel for
 * smuggling instructions that a human reader cannot see but an agent reads.
 *
 * Written as Unicode property escapes rather than a hand-kept code-point list, because a
 * hand-kept list is a list that goes stale: `Cf` is every format character (bidi controls,
 * zero-widths, soft hyphen, the TAGS block), `Zl`/`Zp` are the two separators above, and
 * `Default_Ignorable_Code_Point` catches the invisible fillers and variation selectors that
 * are neither. Measured against the whole set this file must NOT touch — Turkish letters,
 * accented Latin, CJK, currency signs, space and tab all test false.
 */
const GORUNMEZ_VEYA_YONLENDIRICI = /[\p{Cf}\p{Zl}\p{Zp}]|\p{Default_Ignorable_Code_Point}/u;

/**
 * UPSTREAM TEXT MADE SAFE TO PRINT: ANSI removed, control bytes removed, invisible and
 * direction-reversing characters removed, length capped, and the cut ANNOUNCED.
 *
 * Text the remote side controls reaches an operator's terminal and the agent's context
 * verbatim. An escape sequence in it is not decoration: "ESC [ 2 J" clears the screen and
 * "ESC [ 3 1 m" colours a line, so an upstream message can wipe the gate's real verdict off
 * the screen and paint a fake "BAŞARILI" in its place — on a demo recording, the only record
 * of what the gate said. Whitespace collapsing does not help: ESC (0x1b) is not `\s`, so
 * every one of those sequences survives a `/\s+/` pass. They have to be removed by name.
 *
 * ESC IS ONLY HALF OF THAT ATTACK. The same fake line can be painted with no escape byte at
 * all — see GORUNMEZ_VEYA_YONLENDIRICI above. The output of this function is ONE line of
 * visible characters; that is the contract its callers' tests already state, and it is now
 * the contract the code keeps.
 *
 * The cap is NOT a silent trim. The tail is replaced by a visible marker that says how much
 * was dropped, because a truncated error that looks complete is exactly how a reader
 * concludes the upstream said less than it did. `tavan` is therefore VALIDATED rather than
 * clamped: with a negative or fractional ceiling the marker announced a number that was
 * simply wrong — `metinTemizle("abcdef", -3)` dropped three characters and reported nine,
 * and `metinTemizle("abc", 0)` erased the whole message and left only the marker. An
 * announcement that lies is worse than no announcement, so an unusable ceiling throws
 * instead of quietly becoming some other number (this repository does not silently correct
 * values). Callers that compute a ceiling — `tavan - onek.length` — get a refusal at the
 * moment the arithmetic goes negative, not a false report afterwards.
 *
 * IT IS NOT A REDACTOR AND IT CANNOT REPLACE `operatorMetniTemizle` (src/networkTrust.ts).
 * This function removes bytes that can PAINT a terminal; it does not remove SECRETS. A
 * token, a full E.164 number or a long opaque id passes through it character for character.
 * The CAMARA side writes to the operator's stderr through `operatorMetniTemizle`, which
 * masks the NaC token and the approver's number BY VALUE on top of this cleaning. A round-3
 * handoff note proposed closing networkTrust's catch blocks with
 * `console.error(... ${metinTemizle(detay)})` to avoid "a second copy"; following it would
 * have reopened the contract that no token, no full phone number and no PII ever reaches a
 * log or a terminal. The two functions are not duplicates: this one is the print guard, that
 * one is the print guard PLUS the redactor.
 */
export function metinTemizle(ham: unknown, tavan: number = HATA_METNI_TAVANI): string {
  if (!Number.isInteger(tavan) || tavan < 1) {
    throw new Error(`Geçersiz metin tavanı: ${tavan} — 1 veya daha büyük tam sayı olmalı.`);
  }
  // CSI ("ESC ["), OSC ("ESC ]" up to BEL or ST) and the single-character Fe escapes.
  const ansisiz = String(ham ?? "").replace(
    /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g,
    " "
  );
  // Whatever else can move a cursor, ring a bell or forge a log line becomes a space. Written
  // as a code-point test rather than a character class so this file carries no raw control
  // byte of its own (see test/kaynakHijyeni.test.ts). The second test covers the characters
  // that do the same job without being control bytes at all: invisible, or reordering.
  let temiz = "";
  for (const ch of ansisiz) {
    const kod = ch.codePointAt(0)!;
    const zararli =
      kod <= 0x1f || (kod >= 0x7f && kod <= 0x9f) || GORUNMEZ_VEYA_YONLENDIRICI.test(ch);
    temiz += zararli ? " " : ch;
  }
  temiz = temiz.replace(/ {2,}/g, " ").trim();
  if (temiz.length <= tavan) return temiz;
  return `${temiz.slice(0, tavan)}… [${temiz.length - tavan} karakter kırpıldı]`;
}

/**
 * Reduces a Google Ads API error to one readable line: code name, message and a hint.
 *
 * The upstream half is scrubbed and capped BEFORE it is framed as a sentence; everything
 * added after that point — the prefix and the hint — is text this repository wrote. Hint
 * matching runs on the scrubbed, capped text on purpose: a hint that explains a passage the
 * reader cannot see is worse than no hint, and the code name leads every list entry, so the
 * keywords the hints match on sit at the front rather than past the cap.
 */
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
  const base = `Google Ads API hatası: ${metinTemizle(fromList || e?.message || String(err))}`;
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
