// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HTML extraction and network-safety predicates.
 *
 * All scanning is linear (indexOf, not backtracking regular expressions) so a hostile
 * page cannot stall the process. Case-insensitive matching uses ASCII-only lowering to
 * keep string indices aligned for non-ASCII text.
 *
 * Dependency-free and directly unit-tested.
 */

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

/** Named entities. A name that is not in the list is left AS IS. */
const VARLIKLAR: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decodes HTML entities in a SINGLE PASS.
 *
 * WHY one pass: it used to be a chain of replaces with `&amp;` first — and the `&` that
 * produced became the input of the links after it. Measured: `Fiyat &amp;lt;b&amp;gt;`
 * turned into `Fiyat <b>`. There was NO such tag on the page; the decoder invented it. The
 * same chain let a page that wrote `&amp;lt;/site-verisi&amp;gt;` as text produce a REAL
 * closing delimiter: the defence collapsed to a single layer (ayracTemizle) and the
 * extraction itself changed sides. A browser makes one pass too — an `&` that comes out of
 * decoding an entity does not start a new one.
 */
function decodeEntities(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (tam, hex, ondalik, ad) => {
    if (hex !== undefined) {
      const code = parseInt(hex, 16);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : "";
    }
    if (ondalik !== undefined) {
      const code = Number(ondalik);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return VARLIKLAR[String(ad).toLowerCase()] ?? tam;
  });
}

function clean(s: string | undefined): string | undefined {
  const t = s && decodeEntities(s).replace(/\s+/g, " ").trim();
  return t || undefined;
}

/**
 * Strips a CDATA wrapper and a JS comment prefix from a JSON-LD body, LINEARLY.
 *
 * WHY not a regex: it used to be `/^\s*(?:\/\/)?\s*<!\[CDATA\[/i`, and on every backtrack of
 * the leading `\s*` the second `\s*` rescanned the same whitespace from the start -> O(n²).
 * Measured: 25KB of whitespace plus valid JSON-LD took 178ms, 100KB took 2.9s, 200KB took
 * 11.6s; at the 1.5MB body ceiling, minutes. A perfectly valid page that tripped no gate at
 * all could lock the single thread on its own. startsWith/endsWith plus slice is linear.
 *
 * The semantics are preserved exactly: a `//` prefix is accepted only BEFORE `<![CDATA[`,
 * and a `//` suffix only AFTER `]]>`; if the pattern does not match in full, nothing is
 * trimmed.
 */
function cdataSiyir(inner: string): string {
  let s = inner.trim();
  // The `//` prefix is stripped ONLY when `<![CDATA[` follows it; a bare JS comment is not
  // trimmed. Otherwise a body like `//{"@type":…}`, which used to be skipped, would now be
  // parsed — making a linearisation into a behavioural expansion, which it must not be.
  const onektenSonra = s.startsWith("//") ? s.slice(2).trimStart() : s;
  if (onektenSonra.startsWith("<![CDATA[")) s = onektenSonra.slice("<![CDATA[".length);
  let e = s.trimEnd();
  if (e.endsWith("//")) e = e.slice(0, -2).trimEnd();
  // Trim only when the FULL pattern matches: `]]>` + whitespace + an optional `//` +
  // whitespace + end of input.
  if (e.endsWith("]]>")) s = e.slice(0, -3);
  return s.trim();
}

/**
 * Delimiter-escape cleaning: neutralises the sequence "site-verisi" in text coming from a
 * page.
 *
 * WHY a literal search rather than a pattern: it used to be a regex that looked for the
 * delimiter name and then tolerated up to 200 characters (`[^>]{0,200}`), and that bound was
 * a gate — a `</site-verisi …>` payload carrying 201 characters of padding fell OUTSIDE the
 * pattern and reached the output uncleaned. Once the page closes the block BEFORE the server
 * does, every line after that point reads to the agent as the server's own words. Raising
 * the bound is playing the same race one more round; instead, the delimiter's NAME is
 * neutralised — leaving no variant of writing it at all.
 *
 * asciiLower is used, NOT toLowerCase(): Turkish 'İ' expands into two code points, the string
 * grows, and the indices lose their alignment with the raw text.
 */
const AYRAC_ADI = "site-verisi";
export function ayracTemizle(metin: string): string {
  const lower = asciiLower(metin);
  let out = "";
  let i = 0;
  for (;;) {
    const s = lower.indexOf(AYRAC_ADI, i);
    if (s < 0) {
      out += metin.slice(i);
      break;
    }
    out += metin.slice(i, s) + "[etiket-temizlendi]";
    i = s + AYRAC_ADI.length;
  }
  return out;
}

/** Attribute value from a tag — closed by the SAME quote that opened it, so a nested ' or " does not split the value. */
function attrValue(tag: string, attr: string): string | undefined {
  const m = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] ?? m[3]) : undefined;
}

/**
 * ── LINEAR SCANNERS ─────────────────────────────────────────────────────
 * None of the functions below rely on regex backtracking.
 *
 * WHY: patterns such as `<[^>]+>` and `<x[^>]*>([\s\S]*?)</x>` scan to the end of the
 * input from every start position and backtrack whenever the terminator never arrives
 * → O(n²). Measured: 80 KB of `"<"` takes 2 seconds, 1.5 MB (the body ceiling) takes
 * minutes. Node is single-threaded, so ONE such request freezes the service for every
 * tenant. indexOf-based scanning stays linear.
 */

const MAX_TAG_LEN = 8192; // skip a single absurdly long (hostile) tag

/**
 * ASCII-ONLY lowering — preserves length.
 * `toLowerCase()` MUST NOT be used here: Turkish 'İ' (U+0130) expands to two code
 * points ("i" plus a combining dot) and the string grows, so indices drift out of
 * alignment with the raw HTML and every slice shifts by one character, leaking a
 * stray '<' into the title. HTML tag names are ASCII anyway, so this is enough.
 */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function isTagBoundary(code: number): boolean {
  // '>' | ' ' | '\t' | '\n' | '\r' | '/'
  return code === 62 || code === 32 || code === 9 || code === 10 || code === 13 || code === 47;
}

/** Collects opening tags (e.g. `<meta ...>`) in a linear scan. */
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

/** Collects `<tag ...>inner</tag>` blocks in a linear scan. */
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
      /**
       * There is NO closing tag at all — and because gt advances on every turn, no opening
       * tag AFTER this one will find a closing tag either. This used to be
       * `i = gt + 1; continue`, which started a fresh scan to the end of the string for
       * every opening tag: O(n²).
       * Measured on repeated unclosed "<a>": 16KB took 43ms, 64KB 644ms, 128KB 2.6s, 256KB
       * 10.4s -> roughly 6 minutes at the 1.5MB body ceiling. Since Node is single
       * threaded, ONE request freezes every tenant, /health included. Ending the search
       * here keeps the scan linear without changing the result.
       */
      break;
    }
    out.push({ openTag: html.slice(s, gt + 1), inner: html.slice(gt + 1, e) });
    i = e + close.length;
  }
  return out;
}

/** Deletes everything between a start and end token in a linear scan (script/style/comment). */
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
    if (e < 0) break; // unclosed block: the remainder is dropped
    i = e + endTok.length;
  }
  return out;
}

/** Strips tags in a linear scan. */
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
    if (gt < 0) break; // unclosed tag: the remainder is dropped
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

/** Per-field length ceiling — one page must not be able to bloat the agent's context. */
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
  // Comments are stripped before any extraction — headings, links and text inside a comment are not signal
  const yorumsuz = removeBetween(rawHtml, "<!--", "-->");

  /**
   * script, style and noscript bodies are removed from ALL fields, not just from the
   * visible text.
   *
   * WHY: the cleaning used to sit only on the visibleText path, while the title, H1-H3 and
   * the menu were read from the raw HTML. A page could fill the fields the agent treats as
   * most authoritative by writing
   * `<script>var x="<title>ELE GEÇİRİLDİ</title>"</script>` — or by burying `<h1>` and `<a>`
   * inside a script body. Because that text is INVISIBLE in a browser, human review did not
   * catch it either: the user opens the page and finds no such heading.
   *
   * JSON-LD is deliberately read from `yorumsuz`: its data is a <script> body by definition
   * and would not survive in the cleaned copy at all.
   */
  const html = removeBetween(
    removeBetween(removeBetween(yorumsuz, "<script", "</script>"), "<style", "</style>"),
    "<noscript",
    "</noscript>"
  );

  const title = cap(clean(findElements(html, "title", 1)[0]?.inner));
  const htmlTag = findTags(html, "html", 1)[0];
  const lang = htmlTag ? cap(clean(attrValue(htmlTag, "lang")), 20) : undefined;

  // JSON-LD blocks (schema.org — product/service/price signal)
  const jsonLd: string[] = [];
  const JSONLD_MAX = 20; // one page must not bloat the context with thousands of @graph items
  for (const el of findElements(yorumsuz, "script", 20)) {
    if (jsonLd.length >= JSONLD_MAX) break;
    const type = attrValue(el.openTag, "type") ?? "";
    if (!/application\/ld\+json/i.test(type)) continue;
    try {
      // CDATA wrappers and JS comment prefixes are common here
      const raw = cdataSiyir(el.inner);
      const parsed = JSON.parse(raw);
      const top = Array.isArray(parsed) ? parsed : [parsed];
      const items = top.flatMap((p: any) => (Array.isArray(p?.["@graph"]) ? p["@graph"] : [p]));
      for (const it of items) {
        if (jsonLd.length >= JSONLD_MAX) break;
        if (!it || typeof it !== "object") continue; // a null in the array must not discard the whole block
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
      /* skip malformed JSON-LD */
    }
  }

  // nav/menu link text — service/category signal
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

  // Visible text: script/style/noscript are already gone from `html`, only tags remain
  const visible = clean(stripTags(html));

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
 * Charset detection: the Content-Type header first, then <meta charset> / http-equiv
 * near the start of the body. Falls back to utf-8 when neither is present. (Legacy
 * Turkish sites use windows-1254 / iso-8859-9.)
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

/**
 * EXPANDS an IPv6 string with its brackets already stripped into 8 hextets — or undefined
 * when it is not IPv6.
 *
 * Expanding is required because the embedded-IPv4 recognitions below cannot be found by
 * character comparison in compressed notation ("::ffff:7f00:1"). `::` may appear at most
 * once; a string containing it twice is not valid IPv6 and counts as unrecognised (fail
 * closed: an unrecognised address is not passed as "public" — the caller sends it to DNS,
 * and if it does not resolve there the request is refused).
 */
function hextetleriAc(ham: string): number[] | undefined {
  /**
   * A dotted TAIL is normalised into two hextets first: `::ffff:192.168.1.1` and
   * `::ffff:c0a8:101` are the same address and both have to travel the same path. Skip this
   * step and the dotted form becomes unrecognisable as "not a hextet" — measured: the
   * existing `::ffff:192.168.1.1` guard went red for exactly this reason.
   */
  let v6 = ham;
  const nokta = /:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v6);
  if (nokta) {
    const o = [Number(nokta[1]), Number(nokta[2]), Number(nokta[3]), Number(nokta[4])];
    if (o.some((x) => x > 255)) return undefined;
    const ust = ((o[0]! << 8) | o[1]!).toString(16);
    const alt = ((o[2]! << 8) | o[3]!).toString(16);
    v6 = `${v6.slice(0, nokta.index)}:${ust}:${alt}`;
  }
  const parcalar = v6.split("::");
  if (parcalar.length > 2) return undefined;
  const say = (grup: string): number[] =>
    grup === "" ? [] : grup.split(":").map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  const bas = say(parcalar[0] ?? "");
  const son = parcalar.length === 2 ? say(parcalar[1] ?? "") : [];
  if ([...bas, ...son].some(Number.isNaN)) return undefined;
  if (parcalar.length === 1) return bas.length === 8 ? bas : undefined;
  const bosluk = 8 - bas.length - son.length;
  if (bosluk < 0) return undefined;
  return [...bas, ...Array(bosluk).fill(0), ...son];
}

/**
 * Converts an IPv4 address EMBEDDED INSIDE an IPv6 address into dotted notation — or
 * undefined when there is none.
 *
 * WHY: IPv6 can carry an IPv4 address in three distinct standard shapes, and all three go to
 * the same place. The old code recognised only the `::ffff:` prefix, and even then only with
 * a DOTTED tail (`::ffff:192.168.1.1`). The HEX spelling of the same address
 * (`::ffff:c0a8:101`) escaped that branch and was then treated as PUBLIC in the "it has
 * colons, therefore IPv6" branch, because it matched neither the fc nor the fe8 pattern. So
 * 127.0.0.1 was reachable by writing `::ffff:7f00:1`.
 *
 * All three shapes are decoded here in one place and the result is handed back to the IPv4
 * rules:
 *   ::ffff:a.b.c.d / ::ffff:XXXX:XXXX  → IPv4-mapped (RFC 4291)
 *   2002:XXXX:XXXX::/16                → 6to4 (RFC 3056) — 2002:7f00:1:: = 127.0.0.1
 *   64:ff9b::XXXX:XXXX                 → NAT64 (RFC 6052) — 64:ff9b::7f00:1 = 127.0.0.1
 */
function gomuluIPv4(v6: string): string | undefined {
  const h = hextetleriAc(v6);
  if (!h) return undefined;
  const noktali = (ust: number, alt: number): string =>
    `${(ust >> 8) & 0xff}.${ust & 0xff}.${(alt >> 8) & 0xff}.${alt & 0xff}`;
  const sifirBas = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;
  if (sifirBas && h[5] === 0xffff) return noktali(h[6]!, h[7]!); // IPv4-mapped
  if (h[0] === 0x2002) return noktali(h[1]!, h[2]!); // 6to4
  if (h[0] === 0x64 && h[1] === 0xff9b) return noktali(h[6]!, h[7]!); // NAT64
  return undefined;
}

/**
 * The SSRF gate: localhost, private and reserved IPs, and internal network names are
 * refused.
 *
 * The scope reaches DELIBERATELY beyond RFC 1918. "Private" is not only 10/172.16/192.168;
 * cloud providers' metadata endpoints sit in reserved blocks OUTSIDE RFC1918 and hand out
 * durable access tokens without asking for credentials. A concrete example: Oracle Cloud's
 * IMDS lives at 192.0.0.192 — inside 192.0.0.0/24 (IETF protocol assignments), which was not
 * on the old list. Multicast (224/4) and reserved space (240/4, including 255.255.255.255)
 * host no legitimate page from outside either; letting them through widens the gate for
 * nothing in return.
 */
export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "0.0.0.0" || h === "::") return true;

  // IPv6
  if (h.includes(":")) {
    const v6 = h.replace(/^\[|\]$/g, "");
    if (v6 === "::1") return true;
    if (/^f[cd]/i.test(v6)) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/i.test(v6)) return true; // fe80::/10 link-local
    const gomulu = gomuluIPv4(v6);
    if (gomulu) return isPrivateHostname(gomulu); // mapped / 6to4 / NAT64
    return false;
  }

  // IPv4 literal
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (a > 255 || b > 255 || c > 255 || Number(m[4]) > 255) return true; // 999.1.1.1 adres değil
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local / AWS-GCP-Azure IMDS
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 — Oracle Cloud IMDS 192.0.0.192
    if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
    if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 kıyaslama
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
    if (a >= 224) return true; // 224/4 çokluyayın + 240/4 ayrılmış + 255.255.255.255
  }
  return false;
}

/** Validates a URL for analysis: http(s) only, non-private host. Returns an error message, or null when the URL is acceptable. */
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
  // Block cross-protocol requests to privileged ports (SMTP, SSH, ...)
  if (u.port) {
    const p = Number(u.port);
    if (p < 1024 && p !== 80 && p !== 443) {
      return `Reddedildi: ${p} portu — yalnız 80/443 ya da 1024+ portlar desteklenir.`;
    }
  }
  return null;
}
