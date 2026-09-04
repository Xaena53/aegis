#!/usr/bin/env node
/*
 * Aegis — Google Ads MCP server
 * Copyright (C) 2026 Xaena53 (github.com/Xaena53) and the Aegis contributors
 *
 * This program is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License version 3 as published by the Free
 * Software Foundation. See the LICENSE file for details.
 */

/**
 * Self-contained AI agent demo: Claude drives the Aegis tools end to end.
 *
 * The MCP server's usual client is a desktop assistant; this script removes that
 * dependency so the whole loop can be shown from one terminal:
 *
 *   Claude (agent) ──MCP──► Aegis server ──► Google Ads API
 *                              │
 *                              └─ network trust: CAMARA SIM Swap via Nokia NaC
 *                              └─ approval: elicitation ► THIS terminal (a human)
 *
 * The agent decides which tools to call; the server consults the mobile network
 * before any spend-increasing approval; the human answers in the terminal. The
 * agent's own confirm flag is ignored throughout — this script deliberately
 * advertises the elicitation capability so the strong consent path is exercised.
 *
 * Usage:
 *   node scripts/demo-agent.mjs "Hesabımı incele ve israf var mı söyle"
 *   (requires ANTHROPIC_API_KEY or an `ant auth login` profile)
 */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOREV =
  process.argv.slice(2).join(" ") ||
  "Reklam hesaplarımı listele, ilk reklam hesabının son 30 günlük kampanya performansını çıkar ve tek paragraf değerlendir.";

if (!existsSync(join(ROOT, "dist", "index.js"))) {
  console.error("dist/index.js bulunamadı — önce `npm run build` çalıştır.");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

/* ── MCP: connect to the Aegis server over stdio ─────────────────────────── */

const mcp = new Client(
  { name: "aegis-demo-agent", version: "1.0.0" },
  { capabilities: { elicitation: {} } } // strong consent path: the human is asked here
);

/**
 * The approval prompt. The server has already consulted the network by the time
 * this fires — a swapped SIM never reaches this handler — so what the human sees
 * includes the network evidence lines the gate appended.
 */
mcp.setRequestHandler(ElicitRequestSchema, async (req) => {
  console.log("\n┌─ ONAY GEREKİYOR ─────────────────────────────────");
  for (const satir of String(req.params.message).split("\n")) console.log("│ " + satir);
  console.log("└──────────────────────────────────────────────────");
  const cevap = (await rl.question("Onaylıyor musun? [e/H] ")).trim().toLowerCase();
  if (cevap === "e" || cevap === "evet" || cevap === "y") {
    return { action: "accept", content: { onay: true } };
  }
  return { action: "decline" };
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "dist", "index.js")],
  cwd: ROOT,
});
await mcp.connect(transport);

const { tools: mcpTools } = await mcp.listTools();
const tools = mcpTools.map((t) => ({
  name: t.name,
  description: t.description ?? "",
  input_schema: t.inputSchema,
}));
console.log(`Aegis bağlı — ${tools.length} araç yüklendi. Görev: ${GOREV}\n`);

/* ── Agent loop: Claude decides, the server guards ──────────────────────────── */

const anthropic = new Anthropic();
const messages = [{ role: "user", content: GOREV }];

const SISTEM =
  "Sen Aegis ajanısın: kullanıcının Google Ads hesabını Aegis araçlarıyla yönetirsin. " +
  "Araç açıklamalarındaki KULLAN/KULLANMA yönergelerine uy. Para harcayan işlemleri sunucu " +
  "zaten insana onaylatır; onay reddedilirse kararı sorgulamadan kabul et. Türkçe yanıt ver.";

/**
 * After a MID-OUTPUT server-side fallback, blocks before the final `fallback` marker
 * must be treated as discarded: thinking/tool_use from the declined attempt may not be
 * echoed back, and executing those tool calls would return results for calls the
 * serving model never made. Pre-output fallbacks (marker first) are unaffected.
 */
function fallbackSiniriUygula(content) {
  const sinir = content.map((b) => b.type).lastIndexOf("fallback");
  if (sinir <= 0) return content; // no fallback, or pre-output (nothing before it)
  return content.filter(
    (b, i) => i > sinir || !["thinking", "redacted_thinking", "tool_use"].includes(b.type)
  );
}

const SONUC_TAVANI = 30_000; // chars per tool result — a demo doesn't need more context

try {
  let devam = true;
  while (devam) {
    const response = await anthropic.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SISTEM,
      tools,
      messages,
    });

    if (response.stop_reason === "refusal") {
      console.log("\nModel güvenlik gerekçesiyle yanıtı reddetti; görev sonlandırıldı.");
      break;
    }

    const icerik = fallbackSiniriUygula(response.content);

    for (const block of icerik) {
      if (block.type === "text" && block.text.trim()) console.log(block.text);
    }

    if (response.stop_reason === "max_tokens") {
      console.log("\n⚠ Yanıt uzunluk sınırına takıldı — yukarıdaki metin YARIM olabilir, son cümleye güvenme.");
      break;
    }

    if (response.stop_reason === "pause_turn") {
      // Server paused mid-turn: append the partial turn and re-request to resume
      messages.push({ role: "assistant", content: icerik });
      continue;
    }

    if (response.stop_reason !== "tool_use") {
      devam = false;
      break;
    }

    messages.push({ role: "assistant", content: icerik });

    // Execute every requested tool, then return ALL results in a single user message
    const results = [];
    for (const block of icerik) {
      if (block.type !== "tool_use") continue;
      console.log(`\n→ araç: ${block.name}(${JSON.stringify(block.input).slice(0, 120)})`);
      try {
        const out = await mcp.callTool({ name: block.name, arguments: block.input });
        let metin = (out.content ?? [])
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("\n");
        if (metin.length > SONUC_TAVANI) {
          metin = metin.slice(0, SONUC_TAVANI) + "\n[... sonuç kırpıldı ...]";
        }
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: metin || "(boş yanıt)",
          is_error: out.isError === true,
        });
      } catch (e) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Araç hatası: ${e?.message ?? e}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }
} catch (e) {
  if (e?.status === 401 || /authentication|api.?key/i.test(String(e?.message))) {
    console.error(
      "\nAnthropic kimliği çözülemedi. ANTHROPIC_API_KEY ortam değişkenini tanımla " +
        "(console.anthropic.com) ya da `ant auth login` ile giriş yap, sonra tekrar dene."
    );
  } else {
    console.error(`\nBeklenmeyen hata: ${e?.message ?? e}`);
  }
  process.exitCode = 1;
} finally {
  rl.close();
  await mcp.close().catch(() => {});
}
process.exit(process.exitCode ?? 0);
