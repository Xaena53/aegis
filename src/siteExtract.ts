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

/** Adlandırılmış varlıklar. Listede olmayan bir ad OLDUĞU GİBİ bırakılır. */
const VARLIKLAR: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * HTML varlıklarını TEK GEÇİŞTE çözer.
 *
 * NEDEN tek geçiş: eski hâli zincirlenmiş replace'lerdi ve `&amp;` en başta duruyordu —
 * onun ürettiği `&` sonraki halkaların girdisi oluyordu. Ölçüldü: `Fiyat &amp;lt;b&amp;gt;`
 * → `Fiyat <b>`. Sayfada böyle bir etiket YOKTU; çözücü onu kendisi uydurdu. Aynı zincir,
 * `&amp;lt;/site-verisi&amp;gt;` yazan bir sayfaya metin olarak GERÇEK bir ayraç kapanışı
 * ürettiriyordu: savunma tek katmana (ayracTemizle) iniyor, çıkarımın kendisi saldırganın
 * tarafına geçiyordu. Tarayıcı da tek geçiş yapar — bir varlığın çözümünden çıkan `&`
 * yeni bir varlık başlatmaz.
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
 * CDATA sarmalayıcısını ve JS yorum önekini bir JSON-LD gövdesinden DOĞRUSAL sıyırır.
 *
 * NEDEN regex değil: eski hâli `/^\s*(?:\/\/)?\s*<!\[CDATA\[/i` idi ve baştaki `\s*`
 * her geri adımında ikinci `\s*` aynı boşluğu baştan tarıyordu → O(n²). Ölçüldü:
 * 25KB boşluk + geçerli JSON-LD = 178ms, 100KB = 2,9sn, 200KB = 11,6sn; 1,5MB'lık gövde
 * tavanında dakikalar. Hiçbir kapıya takılmayan, tamamen geçerli bir sayfa tek başına
 * tek iş parçacığını kilitliyordu. startsWith/endsWith + slice doğrusaldır.
 *
 * Semantik birebir korunur: `//` öneki yalnız `<![CDATA[`'dan ÖNCE, `//` eki yalnız
 * `]]>`'den SONRA kabul edilir; desen tam eşleşmezse hiçbir şey kırpılmaz.
 */
function cdataSiyir(inner: string): string {
  let s = inner.trim();
  // `//` öneki YALNIZ ardından `<![CDATA[` geliyorsa sıyrılır; tek başına bir JS yorumu
  // kırpılmaz. Aksi hâlde `//{"@type":…}` gibi bir gövde eskiden atlanırken şimdi
  // ayrıştırılırdı — doğrusallaştırma bir davranış genişlemesi olmamalı.
  const onektenSonra = s.startsWith("//") ? s.slice(2).trimStart() : s;
  if (onektenSonra.startsWith("<![CDATA[")) s = onektenSonra.slice("<![CDATA[".length);
  let e = s.trimEnd();
  if (e.endsWith("//")) e = e.slice(0, -2).trimEnd();
  // Yalnız TAM desen (`]]>` + boşluk + isteğe bağlı `//` + boşluk + son) eşleşirse kırp
  if (e.endsWith("]]>")) s = e.slice(0, -3);
  return s.trim();
}

/**
 * Ayraç kaçışı temizliği: sayfadan gelen metinde "site-verisi" dizisini nötrler.
 *
 * NEDEN literal arama, desen değil: eski hâli ayraç adını arayıp ardından en fazla 200
 * karakter (`[^>]{0,200}`) tolere eden bir regex'ti ve o sınır bir kapıydı — 201 dolgu
 * karakteri taşıyan `</site-verisi …>` yükü desenin
 * DIŞINA düşüyor, temizlenmeden çıktıya giriyordu. Sayfa bloğu sunucudan ÖNCE kapatınca
 * o noktadan sonraki her satır ajanın gözünde sunucunun kendi sözü oluyor. Sınırı
 * büyütmek aynı yarışı bir tur daha oynamaktır; onun yerine ayracın ADI nötrleniyor —
 * geriye ayracı yazmanın hiçbir varyantı kalmıyor.
 *
 * asciiLower kullanılır, toLowerCase() DEĞİL: Türkçe 'İ' iki kod noktasına açılır,
 * dize uzar ve indeksler ham metinle hizasını kaybeder.
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
       * Kapanış etiketi HİÇ yok — ve gt her turda ilerlediği için bundan SONRAKİ hiçbir
       * açılış da kapanış bulamaz. Eskiden burada `i = gt + 1; continue` vardı: her açılış
       * için dizinin sonuna kadar yeni bir tarama başlıyordu, yani O(n²).
       * Ölçüldü: kapanışsız "<a>" tekrarı 16KB=43ms, 64KB=644ms, 128KB=2,6sn, 256KB=10,4sn
       * → 1,5MB'lık gövde tavanında ~6 dakika. Node tek iş parçacıklı olduğu için TEK
       * istek /health dâhil bütün kiracıları dondurur. Aramayı burada bitirmek, sonucu
       * değiştirmeden taramayı doğrusal tutar.
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
   * script/style/noscript gövdeleri TÜM alanlardan silinir, yalnız görünür metinden değil.
   *
   * NEDEN: temizlik eskiden sadece visibleText hattındaydı; title, H1-H3 ve menü ham
   * html'den okunuyordu. Sayfa `<script>var x="<title>ELE GEÇİRİLDİ</title>"</script>`
   * yazarak — ya da script gövdesine `<h1>`/`<a>` gömerek — ajanın en itibarlı saydığı
   * alanları doldurabiliyordu. O metin tarayıcıda GÖRÜNMEDİĞİ için insan denetimi de
   * yakalamıyordu: kullanıcı sayfayı açıp bakar, öyle bir başlık yoktur.
   *
   * JSON-LD bilerek `yorumsuz` üzerinden okunur: verisi zaten bir <script> gövdesidir,
   * temizlenmiş kopyada hiç kalmaz.
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

/** SSRF guard: reject localhost, private IPs and internal network names (hostname-based). */
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
