// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Growth Brain — the shared infrastructure.
 *
 * The model client, the LLM helpers metinUret and jsonUret, and the stdio connection to the
 * Aegis MCP server in mcpBaglan. The patterns are adapted from scripts/demo-agent.mjs,
 * including the fallback-boundary filter and the 30,000-character result truncation.
 *
 * SECURITY INVARIANTS, locked in at the protocol level by this file:
 *  - mcpBaglan DOES NOT ADVERTISE the elicitation capability: every server operation that
 *    wants approval — going live, raising a budget — is REFUSED by design when the request
 *    carries no confirm.
 *  - The cagir() wrapper deletes the 'confirm' key from the arguments UNCONDITIONALLY: the
 *    human-approval flag can never be sent from this client.
 *  - Error text never contains an API key or an environment value; at most the first 200
 *    characters of the model's output are quoted.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const KOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * THE SERVICE THAT SUPPLIES THE MODEL — selected with `AEGIS_BRAIN_PROVIDER`.
 *
 * WHY IT IS SELECTABLE: in the MENA Ignite Resource & Tooling Guide, the agent's MODEL has to
 * come from a provider listed in section 3, "LLMs and Model APIs — Agents need a brain". That
 * list has Google AI Studio and not Anthropic, which appears in section 6 as a coding
 * assistant. Hence the default is Gemini: the product as delivered runs on a provider from
 * the list with no configuration at all.
 *
 * The Anthropic path was NOT DELETED, and sits one environment variable away: if the reading
 * of the rule becomes clearer, or a comparison is needed, coming back is a single line.
 *
 * INVARIANT: the provider only fetches the BYTES. The fallback boundary, the `stop_reason`
 * fail-closed check, schema validation and delimiter neutralisation are INDEPENDENT of the
 * provider and run through the same code for both — because the adapter imitates Anthropic's
 * response SHAPE (see geminiIstemcisi). Switching provider therefore weakens no gate.
 */
/** The default model per provider. `AEGIS_BRAIN_MODEL` overrides both. */
const VARSAYILAN_MODELLER = Object.freeze({
  gemini: "gemini-2.5-flash",
  anthropic: "claude-sonnet-5",
});

/**
 * The selection is derived FROM THE ENVIRONMENT BY PURE FUNCTIONS, not in the module body.
 *
 * When the constants were computed straight from `process.env`, the only way to exercise them
 * was to load the module FRESH for each case with `import("...?v=" + random)`. That made the
 * coverage tool treat every copy as a separate file: coverage of ortak.mjs fell to 54%, and
 * the repository as a whole from 89.95% to 77% — with no change to the code, purely by
 * breaking the measurement. A pure function removes that artifice and makes the actual rule —
 * which environment produces which result — directly testable.
 */
export function saglayiciSec(env = process.env) {
  return (env.AEGIS_BRAIN_PROVIDER || "gemini").trim().toLowerCase();
}

export function modelSec(env = process.env) {
  return env.AEGIS_BRAIN_MODEL || VARSAYILAN_MODELLER[saglayiciSec(env)] || VARSAYILAN_MODELLER.gemini;
}

export const BRAIN_SAGLAYICI = saglayiciSec();

/** The model to use — overridable through the environment variable. */
export const BRAIN_MODEL = modelSec();

/** The character cap per tool result, following the SONUC_TAVANI pattern from
 * demo-agent.mjs. */
export const SONUC_TAVANI = 30_000;

/** The machine-readable marker for a truncated tool result — uygulama.mjs looks for
 * it. */
export const KIRPMA_ISARETI = "[... sonuç kırpıldı ...]";

/* ── Anthropic ──────────────────────────────────────────────────────────────── */

/**
 * The Anthropic client. Without ANTHROPIC_API_KEY it throws an explanatory error.
 * Secret hygiene: the error text contains no part of the key, and it describes the fix ONLY
 * as an environment variable — a CLI argument is never suggested.
 */
export function anthropicIstemci(env = process.env) {
  const anahtar = env.ANTHROPIC_API_KEY?.trim();
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
 * Translates Gemini's `finishReason` into Anthropic's `stop_reason`.
 *
 * THE CRITICAL MAPPING: only `STOP` becomes "end_turn". `MAX_TOKENS` maps to "max_tokens",
 * which jsonUret already refuses. Everything else — SAFETY, RECITATION, OTHER, empty,
 * unrecognised — is passed through AS IS, and because it is not "end_turn" it falls closed.
 * Counting an unrecognised reason as "end_turn" would treat a cut-off response as
 * complete.
 */
function bitisSebebiCevir(sebep) {
  if (sebep === "STOP") return "end_turn";
  if (sebep === "MAX_TOKENS") return "max_tokens";
  return typeof sebep === "string" && sebep !== "" ? sebep.toLowerCase() : "bilinmiyor";
}

/**
 * A client for Google AI Studio (Gemini) in Anthropic's SHAPE.
 *
 * The adapter is deliberately thin: it exposes only `messages.create` and returns
 * `{content:[{type,text}], stop_reason}`. That way metinUret, jsonUret and every gate inside
 * them run through a SINGLE code path; there is no provider-specific branch, and therefore no
 * way for a check to be forgotten on one provider.
 */
export function geminiIstemcisi(env = process.env) {
  const anahtar = (env.AEGIS_GEMINI_API_KEY || env.GEMINI_API_KEY || "").trim();
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
        // Brain calls keep the user waiting, so they must not hang indefinitely.
        const zamanlayici = setTimeout(() => kontrol.abort(), 120_000);
        let cevap;
        try {
          cevap = await fetch(url, {
            method: "POST",
            signal: kontrol.signal,
            /**
             * The key travels in a HEADER, not in the query string: URLs end up in logs,
             * proxy records and stack traces.
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
           * The body is not handed to the agent or the user VERBATIM: Google's error body
           * can echo the request back. The first 200 characters, the same rule as the rest
           * of this file.
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
         * `promptFeedback.blockReason` is a block at the prompt level: NO candidate is
         * produced at all. Passing that through as empty text plus "bilinmiyor" would fall
         * correctly into the caller's fail-closed path, but would lose the reason.
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

/* ── Provider selection ─────────────────────────────────────────────────────── */

/**
 * Returns the client for the configured provider.
 *
 * An unrecognised provider name does NOT fall back to the default SILENTLY: an operator who
 * made a typo must not end up running on a model other than the one they think they chose.
 */
export function beyinIstemcisi(env = process.env) {
  const saglayici = saglayiciSec(env);
  if (saglayici === "anthropic") return anthropicIstemci(env);
  if (saglayici === "gemini") return geminiIstemcisi(env);
  throw new Error(
    `AEGIS_BRAIN_PROVIDER değeri tanınmadı: '${saglayici}'. ` +
      `Geçerli değerler: gemini (varsayılan) | anthropic.`
  );
}

/**
 * After a MID-OUTPUT server-side fallback, the thinking, redacted_thinking and tool_use
 * blocks before the last `fallback` marker must be treated as discarded: running the tool
 * calls of the rejected attempt would mean returning results for calls the serving model
 * never made. A pre-output fallback — the marker as the first block — is unaffected.
 * (Adapted from scripts/demo-agent.mjs.)
 */
export function fallbackSiniriUygula(content) {
  const sinir = content.map((b) => b.type).lastIndexOf("fallback");
  if (sinir <= 0) return content; // fallback yok, ya da ön-çıktı (öncesinde blok yok)
  return content.filter(
    (b, i) => i > sinir || !["thinking", "redacted_thinking", "tool_use"].includes(b.type)
  );
}

/** Joins the text blocks out of the content blocks into a single string. */
function metinBirlestir(icerik) {
  return (icerik ?? [])
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Single-shot text generation — a plain wrapper, with NO tool loop.
 * It returns a string. When stop_reason is 'max_tokens' it logs a warning to stderr AND adds
 * a machine-readable marker to the returned value: in that case the return is
 * `new String(metin)` carrying `.kirpik === true`, so the reporting layer can stamp the run
 * as possibly incomplete. In the normal case a primitive string is returned.
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
 * Coarse schema validation — about 15 lines, and NOT a general schema engine.
 * sema: { fieldName: 'string'|'number'|'boolean'|'array'|'object' } — a '?' appended to the
 * type name makes the field optional. It returns an explanatory string on a violation and
 * null otherwise. Numbers are also checked with Number.isFinite, so NaN and Infinity fall.
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
 * Single-shot JSON generation — FAIL-CLOSED:
 *  - If stop_reason is not 'end_turn', and max_tokens in particular, the output is treated as
 *    invalid without even being parsed: JSON that was truncated but still parses — an array
 *    that lost its last elements — cannot slip through silently.
 *  - Fence stripping: everything between the first '{' and the last '}' is taken, since a
 *    ```json fence or an explanatory sentence is the most common breakage.
 *  - Invalid output gets one retry, with the parse error and a shortened form of the bad
 *    output appended to the retry prompt. If that fails too, it throws.
 *  - The error message contains at most the first 200 characters of the model's output; the
 *    request object, the headers and environment values are NEVER dumped.
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

/** Truncates a tool result at SONUC_TAVANI characters and marks the truncation. */
export function sonucKirp(metin) {
  if (typeof metin !== "string") return "";
  if (metin.length <= SONUC_TAVANI) return metin;
  return metin.slice(0, SONUC_TAVANI) + "\n" + KIRPMA_ISARETI;
}

/**
 * Wraps an MCP client in the {cagir, kaynakOku, kapat} interface. mcpBaglan uses it with a
 * real connection; the tests inject a fake client and touch no network.
 *
 *  - The 'confirm' key is deleted from the arguments UNCONDITIONALLY — the input object is
 *    not mutated, a shallow copy is taken — so the human-approval flag cannot pass here.
 *  - The result is truncated at SONUC_TAVANI and the truncation is marked with
 *    KIRPMA_ISARETI, so uygulama.mjs can refuse to parse an ID out of a truncated write
 *    result.
 *  - A response with isError is thrown as an ERROR, along with its text: callers never
 *    mistake a failed tool for a successful step.
 */
export function cagirSarmala(mcp) {
  return {
    async cagir(aracAdi, args) {
      if (typeof aracAdi !== "string" || !aracAdi.trim()) {
        throw new Error("Geçersiz araç adı: boş olmayan bir dize gerekir.");
      }
      const guvenliArgs = { ...(args ?? {}) };
      delete guvenliArgs.confirm; // security invariant: the approval flag is never sent
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
     * Reads a read-only MCP resource, such as aegis://accounts/{id}/limits.
     * The orchestrator uses it to learn the server's budget ceiling and to collapse the
     * effective ceiling to min(the CLI ceiling, the server's ceiling). The result is
     * truncated at SONUC_TAVANI, and its content counts as untrusted data that the caller
     * is obliged to validate.
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
 * Connects to the Aegis MCP server over stdio, at dist/index.js.
 * The elicitation capability is DELIBERATELY NOT ADVERTISED: on a client without elicitation,
 * the server's approval gates in approval.ts fall back to the agent's confirm flag, and since
 * cagir() deletes confirm under every condition, every operation requiring approval is
 * REFUSED by design — which turns "the Growth Brain never goes live on its own" into a
 * guarantee at the protocol level. (The "approved mode" that wants an explicit approval flow
 * sets up demo-agent.mjs's terminal elicitation handler SEPARATELY; this function does not
 * include that mode.)
 */
export async function mcpBaglan() {
  const distYolu = join(KOK, "dist", "index.js");
  if (!existsSync(distYolu)) {
    throw new Error("dist/index.js bulunamadı — önce `npm run build` çalıştır.");
  }
  const mcp = new Client(
    { name: "aegis-growth-brain", version: "1.0.0" },
    { capabilities: {} } // NO elicitation — see the note above
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
 * NEUTRALISES THE DELIMITER'S NAME — it stops untrusted content from closing the block that
 * wraps it.
 *
 * WHY A LITERAL RATHER THAN A PATTERN: it used to be `<\s*\/?\s*<name>[^>]{0,200}>`, and that
 * bound of 200 was a GATE. A payload of `</arastirma-verisi` plus 201 characters of padding
 * plus `>` falls outside the pattern, passes uncleaned, and closes the block early: from that
 * point on, what follows looks to the model not like "data" but like the system's own
 * instructions. Raising the bound is playing the same race one more round; instead the
 * delimiter's NAME is neutralised, leaving no variant of writing it — not with spaces, not
 * with a slash, not with attributes, none.
 *
 * The same hole had been closed in src/siteExtract.ts; the two .mjs twins here, the strategy
 * and creative prompts, had been left open. One implementation, three call sites.
 *
 * toLowerCase() is NOT used: Turkish 'İ' expands into two code points, the string grows, and
 * the indices lose their alignment with the raw text. An ASCII-only lowering preserves that
 * alignment. The scan is linear via indexOf — no backtracking, and therefore no ReDoS.
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
