#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { getEnvContext } from "./adsClient.js";
import { missingCredentials } from "./config.js";

const server = buildServer(getEnvContext);

const missing = missingCredentials();
if (missing.length) {
  // Sunucu yine de ayağa kalkar; araçlar çağrıldığında anlaşılır hata döner.
  console.error(
    `[adspilot] Uyarı: eksik kimlik bilgileri: ${missing.join(", ")} — araçlar kimlik doğrulanana kadar hata dönecek.`
  );
}

// Beklenmeyen hatalar stdout'a değil stderr'e — stdout MCP JSON-RPC kanalıdır
process.on("uncaughtException", (e) => console.error("[adspilot] uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("[adspilot] unhandledRejection:", e));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[adspilot] MCP sunucusu stdio üzerinde hazır.");
