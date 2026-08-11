import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { extractPageFacts, validateAnalyzeUrl, isPrivateHostname } from "../siteExtract.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

const FETCH_TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 1_500_000; // 1.5MB — dev sayfalara karşı tavan

async function fetchPage(url: string): Promise<{ finalUrl: string; html: string; status: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AdsPilotBot/0.1; +https://github.com/Xaena53/google-ads-mcp)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "tr,en;q=0.8",
      },
    });
    // Redirect sonrası varılan host da özel ağ olmamalı (açık redirect → SSRF)
    const finalUrl = res.url || url;
    if (isPrivateHostname(new URL(finalUrl).hostname)) {
      throw new Error(`Yönlendirme özel ağ adresine gitti (${finalUrl}) — SSRF koruması.`);
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
    const html = Buffer.concat(chunks).toString("utf8");
    return { finalUrl, html, status: res.status };
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
