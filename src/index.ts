#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/*
 * AdsPilot — Google Ads MCP server
 * Copyright (C) 2026 Xaena53 (github.com/Xaena53) and the AdsPilot contributors
 *
 * This program is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License version 3 as published by the Free
 * Software Foundation. See the LICENSE file for details.
 *
 * AGPL §13: if you modify this program and offer it as a service over a network, you
 * must offer its users access to the Corresponding Source.
 */

/**
 * stdio entry point.
 *
 * Single-user mode: credentials come from .env and the process speaks MCP over
 * stdin/stdout. No sessions, no database, no auth layer — the operator owns the
 * machine and the credentials.
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
  // The server still starts; the tools return a clear error when they are called.
  console.error(
    `[adspilot] Uyarı: eksik kimlik bilgileri: ${missing.join(", ")} — araçlar kimlik doğrulanana kadar hata dönecek.`
  );
}

// Unexpected errors go to stderr, never stdout — stdout is the MCP JSON-RPC channel
process.on("uncaughtException", (e) => console.error("[adspilot] uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("[adspilot] unhandledRejection:", e));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[adspilot] MCP sunucusu stdio üzerinde hazır.");
