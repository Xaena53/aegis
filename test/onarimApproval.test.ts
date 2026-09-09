// SPDX-License-Identifier: AGPL-3.0-only
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { onayAl } from "../src/approval.js";
import {
  __setSimSwapKanalForTests,
  __setErisimKanalForTests,
  __setCihazDegisimKanalForTests,
  type AgAyar,
} from "../src/networkTrust.js";

/**
 * Repair regressions for src/approval.ts.
 *
 * Two defects, both in TEXT rather than in the decision:
 *
 *  1. On a client without elicitation a step-up refusal said "Reddedildi:" and, two lines
 *     later, "işlem reddedilmedi" — one message claiming both. The decision was correct;
 *     the sentence that framed the escalation as "bound to your approval" is only true on
 *     the channel where a prompt is actually SHOWN, so it must not travel to the weak one.
 *
 *  2. The elicitation failure path inlined the raw upstream exception message into the
 *     agent-facing refusal: no sanitising, no cap, no secret masking. ANSI escapes,
 *     bearer tokens and a multi-megabyte body all went straight into the agent's context.
 *     The repo's own rule (networkTrust.ts: "The upstream error is NEVER inlined into the
 *     refusal") was broken at exactly the gate that guards spend.
 */

const KADEME_AYARI: AgAyar = {
  nacToken: "TEST-ONLY-token",
  approverPhone: "+905551112277",
  simSwapWindowHours: 137,
  reachCheck: true,
  devSwapCheck: true,
  callFwdCheck: false,
  stepUp: true,
};

/** SIM moved, device unchanged over a real channel → a link that can vouch exists. */
function kademeKosullari(): void {
  __setSimSwapKanalForTests({ verifySimSwap: async () => true });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => false });
}

/** Fake MCP server. `yetenek === undefined` models a client with NO elicitation. */
function sahteSunucu(sorulanlar: string[], yetenek: unknown, firlat?: unknown): any {
  return {
    server: {
      getClientCapabilities: () => (yetenek === undefined ? {} : { elicitation: yetenek }),
      elicitInput: async (istek: any) => {
        sorulanlar.push(String(istek.message));
        if (firlat !== undefined) throw firlat;
        return { action: "accept", content: { onay: true } };
      },
    },
  };
}

afterEach(() => {
  __setSimSwapKanalForTests(undefined);
  __setErisimKanalForTests(undefined);
  __setCihazDegisimKanalForTests(undefined);
});

/* ── Bulgu 1: tek mesaj hem "Reddedildi" hem "reddedilmedi" diyordu ───────────── */

test("KADEME/zayıf kanal: ret metni kendi kendisiyle ÇELİŞMEZ ('reddedilmedi' geçmez)", async () => {
  kademeKosullari();
  const sorulanlar: string[] = [];
  const sonuc = await onayAl(
    sahteSunucu(sorulanlar, undefined),
    {
      eylem: "kampanya YAYINA ALINACAK",
      satirlar: ["Günlük bütçe: 50"],
      risk: "high",
      agAyar: KADEME_AYARI,
    },
    true // ajan rızayı UYDURUYOR
  );

  assert.equal(sonuc.onaylandi, false, "yükseltme zayıf kanalda geçemez");
  assert.equal(sonuc.kanal, "ag");
  assert.equal(sorulanlar.length, 0, "gösterilecek istem yoktu");
  assert.match(sonuc.mesaj!, /^Reddedildi:/, "ret, ret olduğunu söylemeli");
  assert.match(sonuc.mesaj!, /AĞ SİNYALİ BOZUK/, "bozuk sinyal ajana ADIYLA söylenmeli");
  assert.match(sonuc.mesaj!, /SIM kartı yakın zamanda değişmiş/);
  assert.doesNotMatch(
    sonuc.mesaj!,
    /reddedilmedi/,
    "aynı mesaj hem reddedildiğini hem reddedilmediğini söyleyemez"
  );
  assert.doesNotMatch(
    sonuc.mesaj!,
    /ONAYINA bağlandı/,
    "onaya bağlanma, istem GÖSTERİLEN kanalın cümlesidir"
  );
});

test("KADEME/güçlü kanal: 'reddedilmedi, ONAYINA bağlandı' çerçevesi İSTEMDE DURUR", async () => {
  kademeKosullari();
  const sorulanlar: string[] = [];
  const sonuc = await onayAl(
    sahteSunucu(sorulanlar, { form: {} }),
    {
      eylem: "kampanya YAYINA ALINACAK",
      satirlar: ["Günlük bütçe: 50"],
      risk: "high",
      agAyar: KADEME_AYARI,
    },
    undefined
  );

  assert.equal(sonuc.onaylandi, true, "güçlü kanalda yükseltme yolu AÇIK kalmalı");
  assert.equal(sorulanlar.length, 1, "insana gerçekten sorulmalı");
  assert.match(sorulanlar[0], /AĞ SİNYALİ BOZUK/, "uyarı istemin BAŞINDA durmalı");
  assert.match(
    sorulanlar[0],
    /işlem reddedilmedi, ONAYINA bağlandı/,
    "insan neye rıza verdiğini bilmeli — cümle silinmemeli, taşınmalı"
  );
  assert.match(sorulanlar[0], /kampanya YAYINA ALINACAK/, "asıl eylem istemde kalmalı");
});

/* ── Bulgu 2: ham upstream hata metni ajana sızıyordu ─────────────────────────── */

const HAM_HATA =
  "MCP error -32001: Request timed out \u001b[31m<<HAM>>\u001b[0m Bearer sk-live-ABC123";

test("SIZINTI: elicitInput hatası ajana HAM upstream metnini vermez", async () => {
  const sonuc = await onayAl(
    sahteSunucu([], { form: {} }, new Error(HAM_HATA)),
    { eylem: "kampanya YAYINA ALINACAK", satirlar: ["Günlük bütçe: 50"] },
    undefined
  );

  assert.equal(sonuc.onaylandi, false, "onay alınamadıysa işlem KOŞMAZ");
  assert.equal(sonuc.kanal, "insan");
  assert.match(sonuc.mesaj!, /onayı alınamadı/, "ajan neden koşmadığını anlamalı");
  const m = sonuc.mesaj!;
  assert.ok(!m.includes("sk-live-ABC123"), "token görünümlü metin ajana sızmamalı");
  assert.ok(!m.includes("Bearer"), "kimlik bilgisi öneki ajana sızmamalı");
  assert.ok(!m.includes("\u001b"), "ANSI kaçış dizileri ajana/terminale sızmamalı");
  assert.ok(!m.includes("MCP error"), "ham upstream metni satır içine gömülmemeli");
  assert.ok(!m.includes("<<HAM>>"), "ham gövde ajana sızmamalı");
});

test("SIZINTI: dev boyutlu hata gövdesi ret metnini şişirmez (tavan var)", async () => {
  const dev = "A".repeat(200_000);
  const sonuc = await onayAl(
    sahteSunucu([], { form: {} }, new Error(dev)),
    { eylem: "kampanya YAYINA ALINACAK", satirlar: ["Günlük bütçe: 50"] },
    undefined
  );

  assert.equal(sonuc.onaylandi, false);
  assert.ok(
    sonuc.mesaj!.length < 500,
    `ret metni sabit sözlük olmalı, upstream gövdesini taşımamalı (uzunluk: ${sonuc.mesaj!.length})`
  );
});

test("OPERATÖR KANALI: ayrıntı stderr'e TEMİZLENMİŞ ve SINIRLI yazılır", async () => {
  const yakalanan: string[] = [];
  const asil = console.error;
  console.error = (...a: unknown[]) => {
    yakalanan.push(a.map(String).join(" "));
  };
  try {
    await onayAl(
      sahteSunucu([], { form: {} }, new Error(HAM_HATA + " " + "B".repeat(5_000))),
      { eylem: "kampanya YAYINA ALINACAK", satirlar: ["Günlük bütçe: 50"] },
      undefined
    );
  } finally {
    console.error = asil;
  }

  assert.equal(yakalanan.length, 1, "operatör körleşmemeli: ayrıntı bir kez yazılmalı");
  const g = yakalanan[0];
  assert.ok(!g.includes("\u001b"), "ANSI dizileri terminale yazılmamalı");
  assert.ok(!g.includes("sk-live-ABC123"), "token günlüğe/terminale yazılmamalı");
  assert.ok(g.length < 600, `stderr ayrıntısı da sınırlı olmalı (uzunluk: ${g.length})`);
});
