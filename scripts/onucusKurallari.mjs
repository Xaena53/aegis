#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Aegis — Google Ads MCP server
 * Copyright (C) 2026 Xaena53 (github.com/Xaena53) and the Aegis contributors
 *
 * This program is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License version 3 as published by the Free
 * Software Foundation. See the LICENSE file for details.
 */

/**
 * PRE-FLIGHT RULES — the decision logic SHARED by the rehearsal and the smoke test.
 *
 * WHY A SEPARATE FILE: these two rules — build freshness and network-gate configuration —
 * used to be embedded inside `scripts/prova.mjs`. Being embedded made them a decision no test
 * could reach: the suite stayed green even when a rule was wrong, and the wrongness only
 * surfaced on stage. The decisions were pulled out into pure functions so they can be tested;
 * the scripts now only REPORT them.
 *
 * The second reason they are shared: `scripts/smoke.mjs` needs the same freshness
 * precondition. The smoke test exercises `dist/index.js`, and when a stale binary is
 * exercised, a receipt saying "verified live" is a receipt for code THAT NO LONGER EXISTS.
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/** The mtime of the newest file in the tree — the measure of whether `npm run build` is
 * needed. */
export function enYeniDosya(dizin, kabul) {
  let enYeni = { ms: 0, yol: "" };
  const gez = (d) => {
    let girdiler;
    try {
      girdiler = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const g of girdiler) {
      const tam = join(d, g.name);
      if (g.isDirectory()) {
        gez(tam);
        continue;
      }
      if (!kabul(g.name)) continue;
      try {
        const s = statSync(tam);
        if (s.mtimeMs > enYeni.ms) enYeni = { ms: s.mtimeMs, yol: tam };
      } catch {
        /* one unreadable file must not break the check — if the result still ends up
           without an mtime, the "mtime-okunamadi" branch below takes over and fails the
           decision closed */
      }
    }
  };
  gez(dizin);
  return enYeni;
}

export const saatMetni = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
export const kisaYol = (kok, yol) => (yol ? relative(kok, yol).replace(/\\/g, "/") : "");

/**
 * BUILD FRESHNESS — fails closed.
 *
 * WHY IT FAILS CLOSED: this rule used to produce a WARNING, and a warning did not affect the
 * exit code. So a developer who forgot to compile their fix to a gate got a GREEN report, and
 * the rehearsal ran the stale binary and declared "READY FOR THE STAGE" — the very failure
 * the script exists to prevent was happening with the script's own blessing. The same applies
 * to the branch where the mtime cannot be read: "I could not measure freshness" and "it is
 * fresh" are NOT THE SAME THING, and both mean REFUSE.
 *
 * @returns {{ taze: boolean, kod: "taze"|"dist-yok"|"mtime-okunamadi"|"bayat", not: string,
 *             kaynak: {ms:number,yol:string}, derleme: {ms:number,yol:string} }}
 */
export function derlemeTazeligi(kok) {
  const giris = join(kok, "dist", "index.js");
  const bos = { ms: 0, yol: "" };
  if (!existsSync(giris)) {
    return { taze: false, kod: "dist-yok", not: "dist/index.js yok — `npm run build` çalıştır", kaynak: bos, derleme: bos };
  }
  const kaynak = enYeniDosya(join(kok, "src"), (a) => a.endsWith(".ts"));
  const derleme = enYeniDosya(join(kok, "dist"), (a) => a.endsWith(".js"));
  if (!kaynak.ms || !derleme.ms) {
    return {
      taze: false,
      kod: "mtime-okunamadi",
      not: "mtime okunamadı — tazelik DOĞRULANAMADI; doğrulanamayan derleme sınanmaz, `npm run build` çalıştır",
      kaynak,
      derleme,
    };
  }
  if (kaynak.ms > derleme.ms) {
    return {
      taze: false,
      kod: "bayat",
      not:
        `${kisaYol(kok, kaynak.yol)} (${saatMetni(kaynak.ms)}) derlemeden yeni ` +
        `(${kisaYol(kok, derleme.yol)}, ${saatMetni(derleme.ms)}) — \`npm run build\` çalıştır`,
      kaynak,
      derleme,
    };
  }
  return {
    taze: true,
    kod: "taze",
    not: `en yeni kaynak ${saatMetni(kaynak.ms)} <= derleme ${saatMetni(derleme.ms)}`,
    kaynak,
    derleme,
  };
}

/**
 * NETWORK-GATE CONFIGURATION — a mirror of the server's own fail-closed rules.
 *
 * The server, in src/networkTrust.ts, lets no spend increase through without an approver's
 * number, and it does so on the SIMULATION channel too ("onaylayici-numarasi-yok"). The
 * rehearsal used to ask for the number only on the real-token branch: an operator who
 * uncommented only the simulation line of the two in docker-compose got "READY FOR THE
 * STAGE", and on stage every budget increase was refused without a prompt ever being shown.
 * The rule now measures the OUTCOME rather than the channel: if either channel is on, the
 * number is required.
 *
 * @returns {{ durum: "gecti"|"uyari"|"kaldi", kod: string }}
 */
export function agKapisiKarari({ simVar, tokenVar, telefonVar, simDeger }) {
  if (simVar && tokenVar) return { durum: "kaldi", kod: "yapilandirma-celiskili" };
  if ((tokenVar || simVar) && !telefonVar) return { durum: "kaldi", kod: "onaylayici-numarasi-yok" };
  if (simVar && simDeger !== "temiz" && simDeger !== "degisti") {
    return { durum: "uyari", kod: "simulasyon-degeri-tanimsiz" };
  }
  return { durum: "gecti", kod: "tamam" };
}
