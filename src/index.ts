#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Aegis — Google Ads MCP server
 * Copyright (C) 2026 Xaena53 (github.com/Xaena53) and the Aegis contributors
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
import { missingCredentials, nacConfigFromEnv } from "./config.js";
import { operatorMetniTemizle } from "./networkTrust.js";
import { formatAdsError, setRuntimeMode } from "./util.js";

setRuntimeMode("stdio");

const server = buildServer(getEnvContext);

const missing = missingCredentials();
if (missing.length) {
  // The server still starts; the tools return a clear error when they are called.
  console.error(
    `[aegis] Uyarı: eksik kimlik bilgileri: ${missing.join(", ")} — araçlar kimlik doğrulanana kadar hata dönecek.`
  );
}

/**
 * ONE CLEANED LINE OUT OF AN UNEXPECTED ERROR — the error OBJECT never reaches the terminal.
 *
 * WHY IT EXISTS (measured on this entry point, not argued): both handlers below used to hand
 * the exception itself to console.error, which prints it with util.inspect and walks its own
 * enumerable properties. Spawned with `AEGIS_NAC_TOKEN` and `AEGIS_APPROVER_PHONE` set and a
 * rejection shaped the way the NaC / google-ads clients really shape one, stderr carried:
 *
 *     uncaughtException: Error: NaC 400: invalid phoneNumber %2B905551112233
 *       response: { body: 'Bearer TEST-ONLY-… for +90 555 111 22 33', status: 400 }
 *       config: { headers: { authorization: 'Bearer TEST-ONLY-…' } }
 *
 * — the application key verbatim, the approver's full number in two spellings, and the raw
 * upstream body, none of which any masking layer ever saw. On a stdio MCP server stderr IS the
 * operator's terminal and, under Claude Desktop, a PERSISTENT log file; the contract's "raw
 * upstream text, tokens, the full phone number and PII never reach the agent, the log or the
 * terminal" covers this line exactly as it covers the agent's.
 *
 * THE CLEANER IS THE SHARED ONE (networkTrust.ts, operatorMetniTemizle) — the same function
 * src/approval.ts and networkTrust.ts's own CAMARA catch branches write their stderr lines
 * through. A private third copy of the same doctrine is exactly how the first two drifted
 * apart; this file is the function's third CALLER, not a fourth rule. It neutralises control
 * bytes first (so no refusal can
 * repaint the operator's terminal), redacts the secrets this server HOLDS by value in any
 * spelling, then masks credential-shaped and E.164-shaped runs, then caps the line.
 *
 * WHAT IS FED TO IT is a string built from the error's own summary — `name: message`, or
 * formatAdsError() when the exception carries a Google Ads `errors` array, where the useful
 * code name lives in that array rather than in `message`. Never the object: an unknown object
 * goes through String(), so a rejection carrying a credential in a FIELD prints as
 * "[object Object]" instead of being walked.
 *
 * The try/catch is not decoration: this runs inside a crash handler, and a getter or a
 * toString() on an upstream object that throws would raise a SECOND uncaught exception from
 * inside the handler for the first one. Under ambiguity the detail is dropped, never printed.
 */
function operatorOzeti(e: unknown): string {
  try {
    const { approverPhone, nacToken } = nacConfigFromEnv();
    const ham = Array.isArray((e as { errors?: unknown } | null)?.errors)
      ? formatAdsError(e)
      : e instanceof Error
        ? `${e.name}: ${e.message}`
        : String(e);
    return operatorMetniTemizle(ham, { approverPhone, nacToken });
  } catch {
    return "(ayrıntı okunamadı — sır sızdırmamak için gösterilmiyor)";
  }
}

/**
 * Unexpected errors go to stderr, never stdout — stdout is the MCP JSON-RPC channel. Only the
 * cleaned summary goes out; see operatorOzeti above for what used to go out instead.
 *
 * A REJECTION NOBODY AWAITED CLOSES THE DOOR TOO. The two handlers behave alike; the text that
 * stood here used to call that asymmetry deliberate ("an unawaited side promise says nothing
 * about the state of the mutation path") and both halves of the excuse were wrong.
 *
 * MEASURED, NOT ARGUED (Node v26.7.0, this entry point): with NO handler installed an unhandled
 * rejection is FATAL — the process dies with exit 1. A handler that only logs therefore does not
 * preserve a status quo, it DOWNGRADES Node's own fail-closed default into fail-open, and it was
 * this file that did the downgrading while calling it a design.
 *
 * NOR IS WHAT ARRIVES HERE ONLY A SIDE PROMISE. src/http.ts writes the counter-example itself,
 * about a mutation path: "a rejection from an async function that is returned without being
 * awaited never reaches this try/catch. It escapes to the top level." A forgotten `await` on a
 * tool path lands exactly here, with the mutation half-applied and nothing knowing how far it
 * got — the same undefined state the block below refuses to keep serving on. FAIL-CLOSED does
 * not get weaker one event name over.
 *
 * The exit is right for THIS entry point and wrong for the hosted one, for the reason spelled
 * out in the next block; the diagnostic is written before the exit for the reason spelled out
 * there too.
 */
process.on("unhandledRejection", (e) => {
  console.error(`[aegis] unhandledRejection: ${operatorOzeti(e)}`);
  process.exit(1);
});
/**
 * AN UNCAUGHT EXCEPTION CLOSES THE DOOR — it does not become a warning we keep serving after.
 *
 * Catching this event overrides Node's own default, which is to terminate. Without the exit
 * the process kept speaking MCP with its invariants already broken: the exception escaped
 * every tool wrapper, so nothing knows how far a half-applied mutation got, whether the
 * approval that was in flight completed, or what the network gate decided — and the very next
 * tool call moves money on that undefined state. FAIL-CLOSED says an unreadable or
 * contradictory state goes to refusal; here the whole process is that state, so it goes down.
 * The leak had the same shape: a surviving process rewrites the line on every repeat.
 *
 * WHY IT IS RIGHT HERE AND NOT IN src/http.ts: hosted mode holds every client's MCP session in
 * memory and one dying request would evict all of them, so that entry point logs and stays up
 * deliberately. Stdio serves exactly ONE client, holds no session for anyone else, and its
 * supervisor — the MCP client that spawned it, or systemd Restart=on-failure — starts a clean
 * process. Exiting costs one restart there and costs a shared service nothing.
 *
 * The line is written BEFORE the exit and stderr is a pipe under every MCP client (Node writes
 * pipes synchronously), so the summary is out before the process goes.
 */
process.on("uncaughtException", (e) => {
  console.error(`[aegis] uncaughtException: ${operatorOzeti(e)}`);
  process.exit(1);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[aegis] MCP sunucusu stdio üzerinde hazır.");
