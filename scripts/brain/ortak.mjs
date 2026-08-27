// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Growth Brain — ortak altyapı.
 *
 * Anthropic istemcisi, LLM yardımcıları (metinUret/jsonUret) ve AdsPilot MCP
 * sunucusuna stdio bağlantısı (mcpBaglan). Desenler scripts/demo-agent.mjs'ten
 * uyarlanmıştır (fallback sınırı filtresi ve 30000 karakter sonuç kırpma dahil).
 *
 * GÜVENLİK DEĞİŞMEZLERİ (bu dosyada protokol seviyesinde kilitlenir):
 *  - mcpBaglan elicitation yeteneği İLAN ETMEZ: onay isteyen her sunucu işlemi
 *    (yayına alma, bütçe artışı) confirm'siz istekte tasarım gereği REDDEDİLİR.
 *  - cagir() sarmalayıcısı 'confirm' anahtarını argümanlardan KOŞULSUZ siler —
 *    insan onayı bayrağı bu istemciden asla gönderilemez.
 *  - Hata metinleri hiçbir zaman API anahtarı / env değeri içermez; model
 *    çıktısından en fazla ilk 200 karakter alıntılanır.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const KOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Kullanılacak model — ortam değişkeniyle geçersiz kılınabilir. */
export const BRAIN_MODEL = process.env.ADSPILOT_BRAIN_MODEL || "claude-sonnet-5";

/** Araç sonucu başına karakter tavanı (demo-agent.mjs SONUC_TAVANI deseni). */
export const SONUC_TAVANI = 30_000;

/** Kırpılmış araç sonucunun makine-okur işareti — uygulama.mjs bunu arar. */
export const KIRPMA_ISARETI = "[... sonuç kırpıldı ...]";

/* ── Anthropic ──────────────────────────────────────────────────────────────── */

/**
 * Anthropic istemcisi. ANTHROPIC_API_KEY yoksa Türkçe açıklayıcı hata fırlatır.
 * Sır hijyeni: hata metni anahtarın hiçbir parçasını içermez ve düzeltmeyi
 * YALNIZ ortam değişkeni olarak tarif eder (CLI argümanı önerilmez).
 */
export function anthropicIstemci() {
  const anahtar = process.env.ANTHROPIC_API_KEY?.trim();
  if (!anahtar) {
    throw new Error(
      "ANTHROPIC_API_KEY ortam değişkeni tanımlı değil. console.anthropic.com üzerinden bir API " +
        "anahtarı oluştur ve onu kabuk profilinde ya da projenin .env dosyasında ANTHROPIC_API_KEY " +
        "ortam değişkeni olarak tanımla. Anahtarı komut satırı argümanı olarak verme — kabuk " +
        "geçmişine sızar."
    );
  }
  return new Anthropic({ apiKey: anahtar });
}

/**
 * ORTA-ÇIKTI sunucu-tarafı fallback'ten sonra, son `fallback` işaretinden önceki
 * thinking/redacted_thinking/tool_use blokları atılmış sayılmalıdır: reddedilen
 * denemenin araç çağrılarını çalıştırmak, servis eden modelin hiç yapmadığı
 * çağrılara sonuç döndürmek olur. Ön-çıktı fallback (işaret ilk blok) etkilenmez.
 * (scripts/demo-agent.mjs'ten uyarlandı.)
 */
export function fallbackSiniriUygula(content) {
  const sinir = content.map((b) => b.type).lastIndexOf("fallback");
  if (sinir <= 0) return content; // fallback yok, ya da ön-çıktı (öncesinde blok yok)
  return content.filter(
    (b, i) => i > sinir || !["thinking", "redacted_thinking", "tool_use"].includes(b.type)
  );
}

/** İçerik bloklarından metin bloklarını tek dizeye birleştirir. */
function metinBirlestir(icerik) {
  return (icerik ?? [])
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Tek atımlık metin üretimi (basit sarmalayıcı — araç döngüsü YOK).
 * string döner. stop_reason 'max_tokens' ise stderr'e uyarı loglar VE dönen
 * değere makine-okur bir işaret ekler: bu durumda dönüş `new String(metin)`
 * olup `.kirpik === true` taşır — rapor katmanı 'YARIM OLABİLİR' damgası
 * basabilsin diye. Normal durumda ilkel string döner.
 */
export async function metinUret(anthropic, { sistem, kullanici, maxTokens }) {
  const yanit = await anthropic.messages.create({
    model: BRAIN_MODEL,
    max_tokens: maxTokens ?? 4096,
    system: sistem,
    messages: [{ role: "user", content: kullanici }],
  });
  const metin = metinBirlestir(fallbackSiniriUygula(yanit?.content ?? []));
  if (yanit?.stop_reason === "max_tokens") {
    console.error("[brain] Uyarı: yanıt max_tokens sınırına takıldı — metin YARIM olabilir.");
    const isaretli = new String(metin);
    isaretli.kirpik = true;
    return isaretli;
  }
  return metin;
}

/**
 * Kaba şema doğrulaması (~15 satır — genel şema motoru DEĞİL).
 * sema: { alanAdi: 'string'|'number'|'boolean'|'array'|'object' } — tür adının
 * sonuna '?' eklenirse alan isteğe bağlıdır. Hata varsa Türkçe açıklama dizesi,
 * yoksa null döner. Sayılar için Number.isFinite de aranır (NaN/Infinity düşer).
 */
export function semaDogrula(nesne, sema) {
  if (typeof nesne !== "object" || nesne === null || Array.isArray(nesne)) {
    return "kök değer bir JSON nesnesi değil";
  }
  if (!sema) return null;
  for (const [alan, tanim] of Object.entries(sema)) {
    const istegeBagli = tanim.endsWith("?");
    const tur = istegeBagli ? tanim.slice(0, -1) : tanim;
    const deger = nesne[alan];
    if (deger === undefined || deger === null) {
      if (istegeBagli) continue;
      return `'${alan}' alanı eksik`;
    }
    const gercekTur = Array.isArray(deger) ? "array" : typeof deger;
    if (gercekTur !== tur) return `'${alan}' alanı '${tur}' olmalı, '${gercekTur}' geldi`;
    if (tur === "number" && !Number.isFinite(deger)) return `'${alan}' sonlu bir sayı değil`;
  }
  return null;
}

/**
 * Tek atımlık JSON üretimi — FAIL-CLOSED:
 *  - stop_reason 'end_turn' değilse (özellikle max_tokens) çıktı parse bile
 *    edilmeden geçersiz sayılır: kırpılmış-ama-parse-olabilen JSON (son öğeleri
 *    düşmüş dizi) sessizce geçemez.
 *  - Çit sıyırma: ilk '{' ile son '}' arası alınır (```json çiti / açıklama
 *    cümlesi en yaygın kırılmadır).
 *  - Geçersiz çıktıda 1 yeniden deneme yapılır; deneme istemine parse hatası ve
 *    bozuk çıktının kısaltılmış hâli eklenir. Yine olmazsa Türkçe hata fırlatır.
 *  - Hata mesajı model çıktısının en fazla ilk 200 karakterini içerir; istek
 *    nesnesi, başlıklar ya da env değerleri ASLA dökülmez.
 */
export async function jsonUret(anthropic, { sistem, kullanici, sema, maxTokens }) {
  let sonHata = "";
  let sonCikti = "";
  for (let deneme = 0; deneme < 2; deneme++) {
    const istem =
      deneme === 0
        ? kullanici
        : kullanici +
          "\n\n--- DÜZELTME ---\nÖnceki yanıtın geçersizdi. Hata: " +
          sonHata +
          "\nGeçersiz çıktın (kısaltılmış):\n" +
          sonCikti.slice(0, 2000) +
          "\nYALNIZCA geçerli tek bir JSON nesnesi döndür; kod çiti, açıklama cümlesi, ek metin ekleme.";
    const yanit = await anthropic.messages.create({
      model: BRAIN_MODEL,
      max_tokens: maxTokens ?? 4096,
      system: sistem,
      messages: [{ role: "user", content: istem }],
    });
    sonCikti = metinBirlestir(fallbackSiniriUygula(yanit?.content ?? []));
    if (yanit?.stop_reason !== "end_turn") {
      sonHata = `stop_reason '${yanit?.stop_reason}' — çıktı tam sayılamaz (max_tokens kırpması fail-closed)`;
      continue;
    }
    const ilk = sonCikti.indexOf("{");
    const son = sonCikti.lastIndexOf("}");
    if (ilk === -1 || son <= ilk) {
      sonHata = "çıktıda JSON nesnesi bulunamadı";
      continue;
    }
    let nesne;
    try {
      nesne = JSON.parse(sonCikti.slice(ilk, son + 1));
    } catch (e) {
      sonHata = `JSON.parse hatası: ${e?.message ?? e}`;
      continue;
    }
    const semaHatasi = semaDogrula(nesne, sema);
    if (semaHatasi) {
      sonHata = `şema ihlali: ${semaHatasi}`;
      continue;
    }
    return nesne;
  }
  throw new Error(
    `Modelden geçerli JSON alınamadı (2 deneme). Son hata: ${sonHata}. ` +
      `Model çıktısının başı: ${sonCikti.slice(0, 200)}`
  );
}

/* ── MCP ────────────────────────────────────────────────────────────────────── */

/** Araç sonucunu SONUC_TAVANI karakterde kırpar ve kırpmayı işaretler. */
export function sonucKirp(metin) {
  if (typeof metin !== "string") return "";
  if (metin.length <= SONUC_TAVANI) return metin;
  return metin.slice(0, SONUC_TAVANI) + "\n" + KIRPMA_ISARETI;
}

/**
 * Bir MCP istemcisini {cagir, kaynakOku, kapat} arayüzüne sarar. mcpBaglan bunu
 * gerçek bağlantıyla kullanır; testler sahte istemci enjekte eder (ağsız).
 *
 *  - 'confirm' anahtarı argümanlardan KOŞULSUZ silinir (girdi nesnesi mutasyona
 *    uğratılmaz, sığ kopya alınır) — insan onayı bayrağı buradan geçemez.
 *  - Sonuç SONUC_TAVANI'nda kırpılır; kırpma KIRPMA_ISARETI ile işaretlenir ki
 *    uygulama.mjs kırpılmış yazma sonucundan ID ayrıştırmayı reddedebilsin.
 *  - isError'lu yanıt HATA olarak fırlatılır (metniyle birlikte): çağıranlar
 *    başarısız aracı asla başarılı adım sanmaz.
 */
export function cagirSarmala(mcp) {
  return {
    async cagir(aracAdi, args) {
      if (typeof aracAdi !== "string" || !aracAdi.trim()) {
        throw new Error("Geçersiz araç adı: boş olmayan bir dize gerekir.");
      }
      const guvenliArgs = { ...(args ?? {}) };
      delete guvenliArgs.confirm; // güvenlik değişmezi: onay bayrağı asla gönderilmez
      const out = await mcp.callTool({ name: aracAdi, arguments: guvenliArgs });
      const metin = sonucKirp(
        (out?.content ?? [])
          .map((c) => (c?.type === "text" ? c.text : ""))
          .filter((s) => s !== "")
          .join("\n")
      );
      if (out?.isError === true) {
        throw new Error(metin || "Araç hatası (sunucu ayrıntı vermedi).");
      }
      return metin || "(boş yanıt)";
    },
    /**
     * Salt-okunur MCP kaynağı okur (ör. adspilot://accounts/{id}/limits).
     * Orkestratör bununla sunucu bütçe tavanını öğrenip efektif tavanı
     * min(CLI tavanı, sunucu tavanı) olarak tekleştirir. Sonuç SONUC_TAVANI'nda
     * kırpılır; içerik güvenilmez veri sayılır (çağıran doğrulamak zorundadır).
     */
    async kaynakOku(uri) {
      if (typeof uri !== "string" || !uri.trim()) {
        throw new Error("Geçersiz kaynak URI'si: boş olmayan bir dize gerekir.");
      }
      const out = await mcp.readResource({ uri });
      return sonucKirp(
        (out?.contents ?? [])
          .map((c) => (typeof c?.text === "string" ? c.text : ""))
          .filter((s) => s !== "")
          .join("\n")
      );
    },
    async kapat() {
      await mcp.close().catch(() => {}); // kapanış hatası yutulur (demo-agent deseni)
    },
  };
}

/**
 * AdsPilot MCP sunucusuna stdio üzerinden bağlanır (dist/index.js).
 * Elicitation yeteneği BİLEREK İLAN EDİLMEZ: sunucunun onay kapıları (approval.ts)
 * elicitation'sız istemcide ajanın confirm bayrağına düşer; cagir() confirm'i
 * her koşulda sildiği için onay gerektiren her işlem tasarım gereği REDDEDİLİR —
 * 'Growth Brain kendiliğinden yayına almaz' değişmezi protokol seviyesinde
 * garanti olur. (Açık onay akışı isteyen 'onaylı mod' demo-agent.mjs'in terminal
 * elicitation handler'ını AYRI kurar; bu fonksiyon o modu içermez.)
 */
export async function mcpBaglan() {
  const distYolu = join(KOK, "dist", "index.js");
  if (!existsSync(distYolu)) {
    throw new Error("dist/index.js bulunamadı — önce `npm run build` çalıştır.");
  }
  const mcp = new Client(
    { name: "adspilot-growth-brain", version: "1.0.0" },
    { capabilities: {} } // elicitation YOK — yukarıdaki nota bak
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distYolu],
    cwd: KOK,
  });
  await mcp.connect(transport);
  return cagirSarmala(mcp);
}
