// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HTML extraction and network-safety predicates.
 *
 * All scanning is linear (indexOf, not backtracking regular expressions) so a hostile
 * page cannot stall the process. Case-insensitive matching uses ASCII-only lowering to
 * keep string indices aligned for non-ASCII text.
 */
/** Saf HTML çıkarım yardımcıları — bağımlılıksız, birim testli. */

export interface PageFacts {
  title?: string;
  metaDescription?: string;
  metaKeywords?: string;
  ogTitle?: string;
  ogDescription?: string;
  lang?: string;
  h1: string[];
  h2: string[];
  h3: string[];
  jsonLd: string[];
  navTexts: string[];
  visibleText: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : "";
    });
}

function clean(s: string | undefined): string | undefined {
  const t = s && decodeEntities(s).replace(/\s+/g, " ").trim();
  return t || undefined;
}

/** Etiket içinden öznitelik değeri — açan tırnağın AYNISIYLA kapanır (içteki ' veya " değeri bölmez). */
function attrValue(tag: string, attr: string): string | undefined {
  const m = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] ?? m[3]) : undefined;
}

/**
 * ── DOĞRUSAL TARAYICILAR ────────────────────────────────────────────────
 * Buradaki hiçbir işlev regex geri izlemesine dayanmaz.
 *
 * NEDEN: `<[^>]+>` / `<x[^>]*>([\s\S]*?)</x>` kalıpları, sonlandırıcı hiç
 * gelmediğinde her başlangıç konumundan sona kadar tarayıp geri izler → O(n²).
 * Ölçüldü: 80 KB'lık `"<"` yığını 2 saniye, 1.5 MB (gövde tavanı) dakikalar
 * sürüyordu. Node tek iş parçacıklı olduğu için bu, TEK bir istekle tüm
 * kiracıların servisini dondurmak demekti. indexOf tabanlı tarama doğrusaldır.
 */

const MAX_TAG_LEN = 8192; // aşırı uzun tek etiket (kötü niyetli) atlanır

/**
 * SADECE ASCII küçültme — uzunluğu korur.
 * `toLowerCase()` KULLANILAMAZ: Türkçe 'İ' (U+0130) iki koda ("i" + birleşik
 * nokta) açılır ve dizge uzar; indeksler ham HTML ile hizasını kaybeder,
 * dilimleme bir karakter kayar (canlıda başlığın sonuna '<' sızmasıyla yakalandı).
 * HTML etiket adları zaten ASCII olduğu için bu dönüşüm yeterlidir.
 */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function isTagBoundary(code: number): boolean {
  // '>' | ' ' | '\t' | '\n' | '\r' | '/'
  return code === 62 || code === 32 || code === 9 || code === 10 || code === 13 || code === 47;
}

/** Açılış etiketlerini (ör. `<meta ...>`) doğrusal olarak toplar. */
function findTags(html: string, tag: string, max: number): string[] {
  const lower = asciiLower(html);
  const open = `<${tag}`;
  const out: string[] = [];
  let i = 0;
  while (out.length < max) {
    const s = lower.indexOf(open, i);
    if (s < 0) break;
    if (!isTagBoundary(lower.charCodeAt(s + open.length))) {
      i = s + open.length;
      continue;
    }
    const gt = lower.indexOf(">", s);
    if (gt < 0) break;
    if (gt - s <= MAX_TAG_LEN) out.push(html.slice(s, gt + 1));
    i = gt + 1;
  }
  return out;
}

/** `<tag ...>iç</tag>` bloklarını doğrusal olarak toplar. */
function findElements(html: string, tag: string, max: number): Array<{ openTag: string; inner: string }> {
  const lower = asciiLower(html);
  const open = `<${tag}`;
  const close = `</${tag}`;
  const out: Array<{ openTag: string; inner: string }> = [];
  let i = 0;
  while (out.length < max) {
    const s = lower.indexOf(open, i);
    if (s < 0) break;
    if (!isTagBoundary(lower.charCodeAt(s + open.length))) {
      i = s + open.length;
      continue;
    }
    const gt = lower.indexOf(">", s);
    if (gt < 0) break;
    const e = lower.indexOf(close, gt + 1);
    if (e < 0) {
      i = gt + 1;
      continue;
    }
    out.push({ openTag: html.slice(s, gt + 1), inner: html.slice(gt + 1, e) });
    i = e + close.length;
  }
  return out;
}

/** Başlangıç/bitiş belirteçleri arasını doğrusal olarak siler (script/style/yorum). */
function removeBetween(html: string, startTok: string, endTok: string): string {
  const lower = asciiLower(html);
  let out = "";
  let i = 0;
  for (;;) {
    const s = lower.indexOf(startTok, i);
    if (s < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, s) + " ";
    const e = lower.indexOf(endTok, s + startTok.length);
    if (e < 0) break; // kapanmayan blok: gerisi atılır
    i = e + endTok.length;
  }
  return out;
}

/** Etiketleri doğrusal olarak söker. */
function stripTags(s: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt) + " ";
    const gt = s.indexOf(">", lt + 1);
    if (gt < 0) break; // kapanmayan etiket: gerisi atılır
    i = gt + 1;
  }
  return out;
}

function metaContent(html: string, attr: "name" | "property", key: string): string | undefined {
  for (const tag of findTags(html, "meta", 200)) {
    if (attrValue(tag, attr)?.toLowerCase() === key.toLowerCase()) {
      return cap(clean(attrValue(tag, "content")));
    }
  }
  return undefined;
}

/** Alan uzunluk tavanı — tek bir sayfa ajanın bağlamını şişiremesin. */
const FIELD_MAX = 300;
function cap(s: string | undefined, n = FIELD_MAX): string | undefined {
  return s === undefined ? undefined : s.length > n ? s.slice(0, n) + "…" : s;
}

function headings(html: string, tag: string, max: number): string[] {
  const out: string[] = [];
  for (const el of findElements(html, tag, max)) {
    const t = clean(stripTags(el.inner));
    if (t) out.push(t.slice(0, 200));
  }
  return out;
}

export function extractPageFacts(rawHtml: string, opts: { textChars?: number } = {}): PageFacts {
  const textChars = opts.textChars ?? 2500;
  // Yorumlar her çıkarımdan önce sökülür — yorum içi başlık/link/metin sinyal değildir
  const html = removeBetween(rawHtml, "<!--", "-->");

  const title = cap(clean(findElements(html, "title", 1)[0]?.inner));
  const htmlTag = findTags(html, "html", 1)[0];
  const lang = htmlTag ? cap(clean(attrValue(htmlTag, "lang")), 20) : undefined;

  // JSON-LD blokları (schema.org — ürün/hizmet/fiyat sinyali)
  const jsonLd: string[] = [];
  const JSONLD_MAX = 20; // tek sayfa binlerce @graph öğesiyle bağlamı şişiremesin
  for (const el of findElements(html, "script", 20)) {
    if (jsonLd.length >= JSONLD_MAX) break;
    const type = attrValue(el.openTag, "type") ?? "";
    if (!/application\/ld\+json/i.test(type)) continue;
    try {
      // CDATA sarmalayıcıları ve JS yorum önekleri yaygın
      const raw = el.inner.replace(/^\s*(?:\/\/)?\s*<!\[CDATA\[/i, "").replace(/\]\]>\s*(?:\/\/)?\s*$/i, "").trim();
      const parsed = JSON.parse(raw);
      const top = Array.isArray(parsed) ? parsed : [parsed];
      const items = top.flatMap((p: any) => (Array.isArray(p?.["@graph"]) ? p["@graph"] : [p]));
      for (const it of items) {
        if (jsonLd.length >= JSONLD_MAX) break;
        if (!it || typeof it !== "object") continue; // dizide null tüm bloğu düşürmesin
        const offer = Array.isArray(it.offers) ? it.offers[0] : it.offers;
        const summary = {
          type: it["@type"],
          name: typeof it.name === "string" ? it.name.slice(0, 200) : undefined,
          description: typeof it.description === "string" ? it.description.slice(0, 200) : undefined,
          price: offer?.price ?? offer?.lowPrice,
          currency: offer?.priceCurrency,
        };
        if (summary.type || summary.name) jsonLd.push(JSON.stringify(summary).slice(0, 500));
      }
    } catch {
      /* bozuk JSON-LD atla */
    }
  }

  // nav/menü link metinleri — hizmet/kategori sinyali
  const navTexts: string[] = [];
  const navBlock = findElements(html, "nav", 1)[0]?.inner ?? html;
  const seen = new Set<string>();
  for (const link of findElements(navBlock, "a", 200)) {
    if (navTexts.length >= 30) break;
    const t = clean(stripTags(link.inner));
    if (t && t.length >= 2 && t.length <= 60 && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      navTexts.push(t);
    }
  }

  // Görünür metin: script/style/noscript dışı, etiketler sökülür (hepsi doğrusal)
  let body = removeBetween(html, "<script", "</script>");
  body = removeBetween(body, "<style", "</style>");
  body = removeBetween(body, "<noscript", "</noscript>");
  const visible = clean(stripTags(body));

  return {
    title,
    metaDescription: metaContent(html, "name", "description"),
    metaKeywords: metaContent(html, "name", "keywords"),
    ogTitle: metaContent(html, "property", "og:title"),
    ogDescription: metaContent(html, "property", "og:description"),
    lang,
    h1: headings(html, "h1", 5),
    h2: headings(html, "h2", 15),
    h3: headings(html, "h3", 10),
    jsonLd,
    navTexts,
    visibleText: (visible ?? "").slice(0, textChars),
  };
}

/**
 * Charset tespiti: önce Content-Type başlığı, sonra gövde başındaki <meta charset>
 * / http-equiv. Bulunamazsa utf-8. (Türkçe legacy siteler windows-1254/iso-8859-9 kullanır.)
 */
export function sniffCharset(contentTypeHeader: string | null, bodyPrefix: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentTypeHeader ?? "")?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const metaCharset = /<meta\s+charset=["']?([\w-]+)/i.exec(bodyPrefix)?.[1];
  if (metaCharset) return metaCharset.toLowerCase();
  const httpEquiv = /<meta[^>]+http-equiv=["']?content-type["']?[^>]*charset=([\w-]+)/i.exec(bodyPrefix)?.[1];
  if (httpEquiv) return httpEquiv.toLowerCase();
  return "utf-8";
}

/** SSRF koruması: localhost / özel IP / iç ağ isimlerini reddet (hostname bazlı). */
export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "0.0.0.0" || h === "::" ) return true;

  // IPv6
  if (h.includes(":")) {
    const v6 = h.replace(/^\[|\]$/g, "");
    if (v6 === "::1") return true;
    if (/^f[cd]/i.test(v6)) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/i.test(v6)) return true; // fe80::/10 link-local
    if (v6.startsWith("::ffff:")) return isPrivateHostname(v6.slice(7)); // v4-mapped
    return false;
  }

  // IPv4 literal
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

/** URL'i analiz için doğrula: yalnız http(s) + özel olmayan host. Hata mesajı ya da null döner. */
export function validateAnalyzeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `Geçersiz URL: ${raw}`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return `Reddedildi: yalnız http/https desteklenir (${u.protocol}).`;
  }
  if (isPrivateHostname(u.hostname)) {
    return `Reddedildi: '${u.hostname}' yerel/özel ağ adresi — SSRF koruması.`;
  }
  // Ayrıcalıklı portlara (SMTP/SSH vb.) çapraz-protokol isteği engelle
  if (u.port) {
    const p = Number(u.port);
    if (p < 1024 && p !== 80 && p !== 443) {
      return `Reddedildi: ${p} portu — yalnız 80/443 ya da 1024+ portlar desteklenir.`;
    }
  }
  return null;
}
