import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerSiteTools } from "./tools/site.js";
import { registerPrompts } from "./prompts.js";
import type { ContextProvider } from "./adsClient.js";

/**
 * Bir MCP sunucu örneği kurar. Hosted modda HER OTURUM için ayrı örnek üretilir
 * ve getCtx o oturumun kullanıcısının context'ini döner — kullanıcı izolasyonu
 * buradan gelir (araçlar global duruma asla bakmaz).
 */
export function buildServer(getCtx: ContextProvider): McpServer {
  const server = new McpServer({ name: "adspilot", version: "0.2.0" });
  registerReadTools(server, getCtx);
  registerWriteTools(server, getCtx);
  registerSiteTools(server);
  registerPrompts(server, getCtx);
  return server;
}
