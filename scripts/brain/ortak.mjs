// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Growth Brain — ortak altyapı.
 *
 * Anthropic istemcisi, LLM yardımcıları (metinUret/jsonUret) ve Aegis MCP
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

/**
 * MODELİ SAĞLAYAN SERVİS — `AEGIS_BRAIN_PROVIDER` ile seçilir.
 *
 * NEDEN SEÇİLEBİLİR: MENA Ignite'ın Resource & Tooling Guide'ında ajanın MODELİ, 3.
 * bölümde ("LLMs and Model APIs — Agents need a brain") listelenen sağlayıcılardan
 * gelmelidir; o listede Google AI Studio var, Anthropic yok (Anthropic 6. bölümde,
 * kodlama asistanı olarak geçiyor). Varsayılan bu yüzden Gemini: teslim edilen ürün,
 * hiçbir ayar yapılmadan listedeki bir sağlayıcıyla koşar.
 *
 * Anthropic yolu SİLİNMEDİ, tek ortam değişkeni uzakta duruyor: kural yorumu netleşirse
 * ya da karşılaştırma gerekirse geri dönmek bir satır.
 *
 * DEĞİŞMEZ: sağlayıcı yalnız BAYTLARI getirir. Fallback sınırı, `stop_reason` kapalı
 * arızası, şema doğrulaması ve ayraç nötrlemesi sağlayıcıdan BAĞIMSIZDIR ve her ikisinde
 * de aynı kodla koşar — uyarlayıcı, Anthropic'in yanıt ŞEKLİNİ taklit ettiği için
 * (bkz. geminiIstemcisi). Böylece sağlayıcı değiştirmek hiçbir kapıyı zayıflatmaz.
 */
export const BRAIN_SAGLAYICI = (process.env.AEGIS_BRAIN_PROVIDER || "gemini").trim().toLowerCase();

/** Sağlayıcı başına varsayılan model. `AEGIS_BRAIN_MODEL` ikisini de geçersiz kılar. */
const VARSAYILAN_MODELLER = Object.freeze({
  gemini: "gemini-2.5-flash",
  anthropic: "claude-sonnet-5",
});

/** Kullanılacak model — ortam değişkeniyle geçersiz kılınabilir. */
export const BRAIN_MODEL =
  process.env.AEGIS_BRAIN_MODEL || VARSAYILAN_MODELLER[BRAIN_SAGLAYICI] || VARSAYILAN_MODELLER.gemini;

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

/* ── Gemini (Google AI Studio) ──────────────────────────────────────────────── */

/**
 * Gemini'nin `finishReason`'ını Anthropic'in `stop_reason`'ına çevirir.
 *
 * KRİTİK EŞLEME: yalnız `STOP` "end_turn" olur. `MAX_TOKENS` "max_tokens"a düşer ve
 * jsonUret onu zaten reddeder. Geri kalan her şey (SAFETY, RECITATION, OTHER, boş,
 * tanınmayan) OLDUĞU GİBİ geçirilir — "end_turn" olmadığı için kapalı arızaya düşer.
 * Tanınmayan bir sebebi "end_turn" saymak, kesilmiş bir yanıtı tam sayardı.
 */
function bitisSebebiCevir(sebep) {
  if (sebep === "STOP") return "end_turn";
  if (sebep === "MAX_TOKENS") return "max_tokens";
  return typeof sebep === "string" && sebep !== "" ? sebep.toLowerCase() : "bilinmiyor";
}

/**
 * Google AI Studio (Gemini) için Anthropic ŞEKLİNDE bir istemci.
 *
 * Uyarlayıcı bilerek ince: yalnız `messages.create` sunar ve `{content:[{type,text}],
 * stop_reason}` döndürür. Böylece metinUret/jsonUret ve içindeki bütün kapılar TEK
 * kod yolundan koşar; sağlayıcıya özel bir dal yoktur, dolayısıyla bir sağlayıcıda
 * unutulmuş bir kontrol de olamaz.
 */
export function geminiIstemcisi() {
  const anahtar = (process.env.AEGIS_GEMINI_API_KEY || process.env.GEMINI_API_KEY || "").trim();
  if (!anahtar) {
    throw new Error(
      "AEGIS_GEMINI_API_KEY ortam değişkeni tanımlı değil. aistudio.google.com üzerinden " +
        "ücretsiz bir API anahtarı oluştur ve onu kabuk profilinde ya da projenin .env dosyasında " +
        "AEGIS_GEMINI_API_KEY olarak tanımla. Anahtarı komut satırı argümanı olarak verme — " +
        "kabuk geçmişine sızar. (Anthropic ile koşmak için: AEGIS_BRAIN_PROVIDER=anthropic)"
    );
  }
  return {
    messages: {
      async create({ model, max_tokens, system, messages }) {
        const url =
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        const kontrol = new AbortController();
        // Beyin çağrıları kullanıcıyı bekletir; süresiz asılı kalmamalı.
        const zamanlayici = setTimeout(() => kontrol.abort(), 120_000);
        let cevap;
        try {
          cevap = await fetch(url, {
            method: "POST",
            signal: kontrol.signal,
            /**
             * Anahtar BAŞLIKTA taşınır, sorgu dizesinde değil: URL'ler günlüklere,
             * proxy kayıtlarına ve hata izlerine düşer.
             */
            headers: { "Content-Type": "application/json", "x-goog-api-key": anahtar },
            body: JSON.stringify({
              systemInstruction: system ? { parts: [{ text: String(system) }] } : undefined,
              contents: (messages ?? []).map((m) => ({
                role: m.role === "assistant" ? "model" : "user",
                parts: [{ text: String(m.content ?? "") }],
              })),
              generationConfig: { maxOutputTokens: max_tokens ?? 4096, temperature: 0.7 },
            }),
          });
        } finally {
          clearTimeout(zamanlayici);
        }
        const metin = await cevap.text();
        if (!cevap.ok) {
          /**
           * Gövde ajana/kullanıcıya AYNEN verilmez: Google'ın hata gövdesi isteği
           * yankılayabilir. İlk 200 karakter, dosyanın geri kalanıyla aynı kural.
           */
          throw new Error(`Gemini API ${cevap.status}: ${metin.slice(0, 200)}`);
        }
        let govde;
        try {
          govde = JSON.parse(metin);
        } catch {
          throw new Error(`Gemini yanıtı JSON değil: ${metin.slice(0, 200)}`);
        }
        const aday = govde?.candidates?.[0];
        const parcalar = Array.isArray(aday?.content?.parts) ? aday.content.parts : [];
        /**
         * `promptFeedback.blockReason` istem düzeyinde engellemedir: aday HİÇ üretilmez.
         * Bunu boş metin + "bilinmiyor" olarak geçirmek, çağıranın kapalı arızasına
         * doğru düşer ama sebebi kaybederdi.
         */
        const engel = govde?.promptFeedback?.blockReason;
        return {
          content: parcalar
            .filter((p) => typeof p?.text === "string")
            .map((p) => ({ type: "text", text: p.text })),
          stop_reason: engel ? `engellendi:${String(engel).toLowerCase()}` : bitisSebebiCevir(aday?.finishReason),
        };
      },
    },
  };
}

/* ── Sağlayıcı seçimi ───────────────────────────────────────────────────────── */

/**
 * Yapılandırılan sağlayıcının istemcisini döndürür.
 *
 * Tanınmayan bir sağlayıcı adı SESSİZCE varsayılana düşmez: yazım hatası yapan operatör,
 * kullandığını sandığından başka bir modelle koşmamalı.
 */
export function beyinIstemcisi() {
  if (BRAIN_SAGLAYICI === "anthropic") return anthropicIstemci();
  if (BRAIN_SAGLAYICI === "gemini") return geminiIstemcisi();
  throw new Error(
    `AEGIS_BRAIN_PROVIDER değeri tanınmadı: '${BRAIN_SAGLAYICI}'. ` +
      `Geçerli değerler: gemini (varsayılan) | anthropic.`
  );
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
     * Salt-okunur MCP kaynağı okur (ör. aegis://accounts/{id}/limits).
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
 * Aegis MCP sunucusuna stdio üzerinden bağlanır (dist/index.js).
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
    { name: "aegis-growth-brain", version: "1.0.0" },
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

/**
 * AYRAÇ ADINI NÖTRLER — güvenilmez içeriğin, kendisini saran bloğu kapatmasını engeller.
 *
 * NEDEN DESEN DEĞİL LİTERAL: eski hâli `<\s*\/?\s*<ad>[^>]{0,200}>` idi ve o 200 sınırı
 * bir KAPIYDI. `</arastirma-verisi` + 201 karakter dolgu + `>` yükü desenin dışına düşer,
 * temizlenmeden geçer ve blok erkenden kapanır: o noktadan sonrası model için "veri"
 * değil, sistemin kendi talimatı gibi görünür. Sınırı büyütmek aynı yarışı bir tur daha
 * oynamaktır; onun yerine ayracın ADI nötrleniyor, geriye onu yazmanın hiçbir varyantı
 * kalmıyor — boşluklu, eğik çizgili, öznitelikli, hiçbiri.
 *
 * Aynı açık src/siteExtract.ts'te kapatılmıştı; buradaki iki .mjs ikizi (strateji ve
 * kreatif istemleri) açık kalmıştı. Tek uygulama, üç çağrı yeri.
 *
 * toLowerCase() KULLANILMAZ: Türkçe 'İ' iki kod noktasına açılır, dize uzar ve indeksler
 * ham metinle hizasını kaybeder. ASCII'ye özel küçültme hizayı korur. indexOf ile
 * doğrusal tarama — geri izleme yok, dolayısıyla ReDoS da yok.
 */
export function ayracNotrle(metin, ayracAdi) {
  const kaynak = String(metin ?? "");
  const kucuk = kaynak.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  const aranan = String(ayracAdi).toLowerCase();
  let cikti = "";
  let i = 0;
  for (;;) {
    const s = kucuk.indexOf(aranan, i);
    if (s < 0) {
      cikti += kaynak.slice(i);
      break;
    }
    cikti += kaynak.slice(i, s) + "[etiket-temizlendi]";
    i = s + aranan.length;
  }
  return cikti;
}
