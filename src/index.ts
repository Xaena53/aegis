#!/usr/bin/env node
/*
 * AdsPilot — Google Ads MCP sunucusu
 * Copyright (C) 2026 AdsPilot katkıcıları
 *
 * Bu program özgür yazılımdır: Free Software Foundation tarafından yayımlanan
 * GNU Affero General Public License sürüm 3 koşulları altında yeniden
 * dağıtabilir ve/veya değiştirebilirsiniz. Ayrıntılar için LICENSE dosyasına bakın.
 *
 * AGPL §13: Bu programı değiştirip ağ üzerinden servis olarak sunuyorsanız,
 * kullanıcılarına Karşılık Gelen Kaynağı sunmakla yükümlüsünüz.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { getEnvContext } from "./adsClient.js";
import { missingCredentials } from "./config.js";
import { setRuntimeMode } from "./util.js";

setRuntimeMode("stdio");

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
