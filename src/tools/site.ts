import { z } from "zod";
import { lookup } from "node:dns/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  extractPageFacts,
  validateAnalyzeUrl,
  isPrivateHostname,
  sniffCharset,
} from "../siteExtract.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

const FETCH_TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 1_500_000; // 1.5MB — dev sayfalara karşı tavan
const MAX_REDIRECTS = 5;

/**
 * DNS-rebinding/decimal-IP guard'ı: hostname'in ÇÖZÜMLENDİĞİ adresler de özel olamaz.
 * (örn. http://2130706433/ → 127.0.0.1, ya da evil.com A-kaydı 192.168.1.1)
 * Not: çözüm ile bağlantı arasında TOCTOU penceresi kalır (undici IP sabitlemeye izin
 * vermiyor); self-hosted yerel kullanım için kabul edilen kalıntı risk.
 */
async function assertPublicHost(hostname: string): Promise<void> {
  if (isPrivateHostname(hostname)) {
    throw new Error(`'${hostname}' yerel/özel ağ adresi — SSRF koruması.`);
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`DNS çözümlenemedi: ${hostname}`);
  }
  for (const a of addrs) {
    if (isPrivateHostname(a.address)) {
      throw new Error(`'${hostname}' özel ağ adresine çözümleniyor (${a.address}) — SSRF koruması.`);
    }
  }
}

async function fetchPage(url: string): Promise<{ finalUrl: string; html: string; status: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Her durak (ilk URL + tüm yönlendirmeler) hem isim hem DNS düzeyinde doğrulanır
      const invalid = validateAnalyzeUrl(current);
      if (invalid) throw new Error(invalid);
      await assertPublicHost(new URL(current).hostname);

      const res = await fetch(current, {
        signal: ctrl.signal,
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; AdsPilotBot/0.1; +https://github.com/Xaena53/google-ads-mcp)",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "tr,en;q=0.8",
        },
      });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error(`Yönlendirme (${res.status}) location başlıksız.`);
        res.body?.cancel().catch(() => {});
        current = new URL(loc, current).toString();
        continue;
      }

      const contentType = res.headers.get("content-type");
      if (contentType && !/text\/html|application\/xhtml|text\/plain|xml/i.test(contentType)) {
        throw new Error(`HTML değil (${contentType.split(";")[0]}) — bu araç yalnız web sayfası analiz eder.`);
      }

      const reader = res.body?.getReader();
      let received = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          chunks.push(value);
          if (received >= MAX_BODY_BYTES) {
            ctrl.abort();
            break;
          }
        }
      }
      const buf = Buffer.concat(chunks);
      // Charset: başlık > meta sniff > utf-8 (Türkçe legacy: windows-1254/iso-8859-9)
      const charset = sniffCharset(contentType, buf.subarray(0, 4096).toString("latin1"));
      let html: string;
      try {
        html = new TextDecoder(charset).decode(buf);
      } catch {
        html = buf.toString("utf8");
      }
      return { finalUrl: current, html, status: res.status };
    }
    throw new Error(`Çok fazla yönlendirme (>${MAX_REDIRECTS}).`);
  } finally {
    clearTimeout(timer);
  }
}

export function registerSiteTools(server: McpServer) {
  server.registerTool(
    "analyze_site",
    {
      description:
        "Bir web sitesini reklam kampanyası için analiz eder: sayfayı çeker, başlık/meta/başlıklar/JSON-LD/menü/görünür metinden yapılandırılmış gerçekleri çıkarır. ÇIKTIYI SEN yorumlarsın: ürün-hizmeti anla, anahtar kelimeler + RSA başlık/açıklamaları üret, kullanıcıyla netleştir, sonra create_search_campaign + create_responsive_search_ad ile taslak kur. Kimlik bilgisi gerektirmez.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        url: z.string().url().describe("Analiz edilecek sayfa (örn. https://ornek.com — ana sayfa ya da ürün/hizmet sayfası)"),
        textChars: z
          .number()
          .int()
          .min(500)
          .max(10_000)
          .optional()
          .describe("Görünür metinden alınacak karakter (varsayılan 2500)"),
      },
    },
    async ({ url, textChars }) => {
      const invalid = validateAnalyzeUrl(url);
      if (invalid) return text(invalid);
      try {
        const { finalUrl, html, status } = await fetchPage(url);
        if (status >= 400) return text(`Sayfa alınamadı: HTTP ${status} (${finalUrl})`);
        if (!html.trim()) return text(`Sayfa boş döndü (${finalUrl}).`);
        const f = extractPageFacts(html, { textChars });

        const lines: string[] = [`# Site analizi: ${finalUrl}`, ""];
        if (f.title) lines.push(`**Başlık:** ${f.title}`);
        if (f.lang) lines.push(`**Dil:** ${f.lang}`);
        if (f.metaDescription) lines.push(`**Meta açıklama:** ${f.metaDescription}`);
        if (f.ogTitle && f.ogTitle !== f.title) lines.push(`**OG başlık:** ${f.ogTitle}`);
        if (f.ogDescription && f.ogDescription !== f.metaDescription)
          lines.push(`**OG açıklama:** ${f.ogDescription}`);
        if (f.metaKeywords) lines.push(`**Meta keywords:** ${f.metaKeywords}`);
        if (f.h1.length) lines.push(`**H1:** ${f.h1.join(" | ")}`);
        if (f.h2.length) lines.push(`**H2:** ${f.h2.join(" | ")}`);
        if (f.h3.length) lines.push(`**H3:** ${f.h3.join(" | ")}`);
        if (f.jsonLd.length) lines.push(`**Yapılandırılmış veri (JSON-LD):**\n${f.jsonLd.map((j) => `- ${j}`).join("\n")}`);
        if (f.navTexts.length) lines.push(`**Menü/linkler:** ${f.navTexts.join(" · ")}`);
        if (f.visibleText) lines.push("", "**Görünür metin (kısaltılmış):**", f.visibleText);

        lines.push(
          "",
          "---",
          "SONRAKİ ADIM (sen yapacaksın):",
          "1. Yukarıdaki gerçeklerden ürünü/hizmeti ve hedef kitleyi çıkar; emin değilsen kullanıcıya sor.",
          "2. Sitenin dilinde 10-20 anahtar kelime öner (satın alma niyetli olanlara öncelik) + 5-10 negatif kelime (ör. 'ücretsiz', 'iş ilanı').",
          "3. RSA için ≥5 başlık (her biri ≤30 karakter) ve ≥3 açıklama (≤90 karakter) yaz — karakter sınırını SAYARAK doğrula.",
          "4. Ülke hedefini dil/adres ipuçlarından öner (örn. lang=tr → ['TR']), bütçeyle birlikte kullanıcıya onaylat.",
          "5. Onay sonrası: create_search_campaign (PAUSED taslak) → create_responsive_search_ad → kullanıcı son onayı → set_campaign_status."
        );
        return text(lines.join("\n"));
      } catch (e: any) {
        const msg = e?.name === "AbortError" ? `Zaman aşımı/boyut sınırı (${FETCH_TIMEOUT_MS / 1000}s / ${MAX_BODY_BYTES} bayt)` : e?.message ?? String(e);
        return { content: [{ type: "text" as const, text: `Site analizi başarısız: ${msg}` }], isError: true };
      }
    }
  );
}
