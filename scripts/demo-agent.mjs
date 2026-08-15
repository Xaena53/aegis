#!/usr/bin/env node
/*
 * AdsPilot — Google Ads MCP server
 * Copyright (C) 2026 Xaena53 (github.com/Xaena53) and the AdsPilot contributors
 *
 * This program is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License version 3 as published by the Free
 * Software Foundation. See the LICENSE file for details.
 */

/**
 * Self-contained AI agent demo: Claude drives the AdsPilot tools end to end.
 *
 * The MCP server's usual client is a desktop assistant; this script removes that
 * dependency so the whole loop can be shown from one terminal:
 *
 *   Claude (agent) ──MCP──► AdsPilot server ──► Google Ads API
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

const rl = createInterface({ input: process.stdin, output: process.stdout });

/* ── MCP: connect to the AdsPilot server over stdio ─────────────────────────── */

const mcp = new Client(
  { name: "adspilot-demo-agent", version: "1.0.0" },
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
console.log(`AdsPilot bağlı — ${tools.length} araç yüklendi. Görev: ${GOREV}\n`);

/* ── Agent loop: Claude decides, the server guards ──────────────────────────── */

const anthropic = new Anthropic();
const messages = [{ role: "user", content: GOREV }];

const SISTEM =
  "Sen AdsPilot ajanısın: kullanıcının Google Ads hesabını AdsPilot araçlarıyla yönetirsin. " +
  "Araç açıklamalarındaki KULLAN/KULLANMA yönergelerine uy. Para harcayan işlemleri sunucu " +
  "zaten insana onaylatır; onay reddedilirse kararı sorgulamadan kabul et. Türkçe yanıt ver.";

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

  for (const block of response.content) {
    if (block.type === "text" && block.text.trim()) console.log(block.text);
  }

  if (response.stop_reason !== "tool_use") {
    devam = false;
    break;
  }

  messages.push({ role: "assistant", content: response.content });

  // Execute every requested tool, then return ALL results in a single user message
  const results = [];
  for (const block of response.content) {
    if (block.type !== "tool_use") continue;
    console.log(`\n→ araç: ${block.name}(${JSON.stringify(block.input).slice(0, 120)})`);
    try {
      const out = await mcp.callTool({ name: block.name, arguments: block.input });
      const metin = (out.content ?? [])
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n");
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

rl.close();
await mcp.close();
process.exit(0);
