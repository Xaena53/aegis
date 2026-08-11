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

function metaContent(html: string, attr: "name" | "property", key: string): string | undefined {
  const tagRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    if (attrValue(m[0], attr)?.toLowerCase() === key.toLowerCase()) {
      return clean(attrValue(m[0], "content"));
    }
  }
  return undefined;
}

function headings(html: string, tag: string, max: number): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < max) {
    const t = clean(m[1].replace(/<[^>]+>/g, " "));
    if (t) out.push(t.slice(0, 200));
  }
  return out;
}

export function extractPageFacts(rawHtml: string, opts: { textChars?: number } = {}): PageFacts {
  const textChars = opts.textChars ?? 2500;
  // Yorumlar her çıkarımdan önce sökülür — yorum içi başlık/link/metin sinyal değildir
  const html = rawHtml.replace(/<!--[\s\S]*?-->/g, " ");

  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]);
  const htmlTag = /<html\b[^>]*>/i.exec(html)?.[0];
  const lang = htmlTag ? clean(attrValue(htmlTag, "lang")) : undefined;

  // JSON-LD blokları (schema.org — ürün/hizmet/fiyat sinyali)
  const jsonLd: string[] = [];
  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ld: RegExpExecArray | null;
  while ((ld = ldRe.exec(html)) && jsonLd.length < 5) {
    try {
      const parsed = JSON.parse(ld[1].trim());
      // @graph sarmalayıcısı yaygın: {"@context":..., "@graph":[...]}
      const top = Array.isArray(parsed) ? parsed : [parsed];
      const items = top.flatMap((p: any) => (Array.isArray(p?.["@graph"]) ? p["@graph"] : [p]));
      for (const it of items) {
        const summary = {
          type: it["@type"],
          name: it.name,
          description: typeof it.description === "string" ? it.description.slice(0, 200) : undefined,
          price: it.offers?.price ?? it.offers?.lowPrice,
          currency: it.offers?.priceCurrency,
        };
        if (summary.type || summary.name) jsonLd.push(JSON.stringify(summary));
      }
    } catch {
      /* bozuk JSON-LD atla */
    }
  }

  // nav/menü link metinleri — hizmet/kategori sinyali
  const navTexts: string[] = [];
  const navBlock = /<nav\b[\s\S]*?<\/nav>/i.exec(html)?.[0] ?? html;
  const aRe = /<a[^>]*>([\s\S]*?)<\/a>/gi;
  let a: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((a = aRe.exec(navBlock)) && navTexts.length < 30) {
    const t = clean(a[1].replace(/<[^>]+>/g, " "));
    if (t && t.length >= 2 && t.length <= 60 && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      navTexts.push(t);
    }
  }

  // Görünür metin: script/style/nav dışı, etiketler sökülür
  const visible = clean(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );

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
