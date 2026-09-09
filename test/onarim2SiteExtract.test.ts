// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPrivateHostname, validateAnalyzeUrl } from "../src/siteExtract.js";

const KAYNAK = fileURLToPath(new URL("../src/siteExtract.ts", import.meta.url));
const SITE_KAYNAK = fileURLToPath(new URL("../src/tools/site.ts", import.meta.url));

/**
 * Round-2 cover for src/siteExtract.ts — three findings a review raised against the round-1
 * repair of the SSRF gate.
 *
 * Round 1 moved the bracket strip to the top of isPrivateHostname and added the
 * all-zero-hextet rule, which closed "[::]". Two halves of that work were left undone and a
 * third was documented WRONGLY; this file locks all three.
 */

/**
 * FINDING 1 (high) — the IPv6 branch still ended in `return false`.
 *
 * The recommended fix had two sentences and only the first was applied. The second — "turn
 * the IPv6 branch's default fail-closed ... allow 2000::/3 and refuse the rest" — was not
 * done, and the audit record said "SKIPPED: (none)".
 *
 * Measured on the pre-fix file, validateAnalyzeUrl returned null (ACCEPTED) for every host
 * below. The IPv4 branch closes the same classes with `a >= 224` plus its reserved-range
 * rules; there was no IPv6 counterpart at all.
 */
test("SSRF: IPv6 dalinin varsayilani FAIL-CLOSED — 2000::/3 disi REDDEDILIR", () => {
  const kapali: Array<[string, string]> = [
    ["fec0::1", "site-local (RFC 3879) — LAN'larda hala yonlendiriliyor"],
    ["ff02::1", "cokluyayin: bag-yerel tum-dugumler"],
    ["ff01::1", "cokluyayin: dugum-yerel"],
    ["ff05::c", "cokluyayin: site-yerel"],
    ["ff00::", "cokluyayin taban adresi"],
    ["::7f00:1", "IPv4-UYUMLU ::127.0.0.1 — connect() geridonguye iner"],
    ["::ffff:0:7f00:1", "IPv4-cevrilmis (::ffff:0:0/96) 127.0.0.1"],
    ["::2", "0000::/8 ayrilmis"],
    ["100::1", "RFC 6666 yalniz-cope-at"],
    ["0100::1", "ayni blok, sifir dolgulu yazim"],
    ["5f00::1", "atanmamis alan"],
    ["1fff::1", "2000::/3 araliginin hemen ALTI"],
    ["4000::1", "2000::/3 araliginin hemen USTU"],
  ];
  for (const [h, neden] of kapali) {
    assert.equal(isPrivateHostname(h), true, `${h} GENEL sayildi — ${neden}`);
    assert.equal(isPrivateHostname(`[${h}]`), true, `[${h}] GENEL sayildi — ${neden}`);
    const sonuc = validateAnalyzeUrl(`http://[${h}]:8787/settings`);
    assert.notEqual(sonuc, null, `http://[${h}]/ KABUL edildi — SSRF kapisi acik (${neden})`);
    assert.match(String(sonuc), /SSRF koruması/, h);
  }
});

/**
 * The same default, from the other side: a string that is not valid IPv6 AT ALL must not come
 * back "public" either. hextetleriAc returns undefined for these, and undefined means
 * UNRECOGNISED — which under the project's contract is a refusal, not a zero.
 */
test("SSRF: taninmayan IPv6 dizesi 'genel' DEGIL, REDDEDILIR", () => {
  for (const h of ["gg::1", "::::1", "2606:4700::1111:extra", "1:2:3:4:5:6:7:8:9", "::ffff:999.1.1.1"]) {
    assert.equal(isPrivateHostname(h), true, `taninmayan '${h}' GENEL sayildi — bilinmiyor 0 degildir`);
  }
});

/**
 * The counterweight for finding 1. A fix that refused all IPv6 would pass both tests above
 * and silently kill the feature, so the allowlist itself is pinned here: everything globally
 * routable is assigned out of 2000::/3, and the embedded-IPv4 forms must still be decoded
 * BEFORE the allowlist runs — 64:ff9b::808:808 is outside 2000::/3 as written but goes to
 * 8.8.8.8, and where an address goes is what decides.
 */
test("Fail-closed varsayilan MESRU IPv6'yi kapatmaz (2000::/3 + gomulu IPv4)", () => {
  for (const h of [
    "2606:4700::1111", // Cloudflare
    "2a00:1450:4001::1", // Google EU
    "2404:6800:4003::1", // Google APAC
    "2001:db8::1", // belge araligi, gomulu IPv4 yok
    "2000::", // araligin ilk adresi
    "3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", // araligin son adresi
    "64:ff9b::0808:0808", // NAT64 -> 8.8.8.8 (2000::/3 DISINDA yaziliyor)
    "2002:0808:0808::", // 6to4 -> 8.8.8.8
    "::ffff:0808:0808", // IPv4-mapped -> 8.8.8.8
  ]) {
    assert.equal(isPrivateHostname(h), false, `mesru '${h}' reddedildi — ozellik oldu`);
  }
  assert.equal(validateAnalyzeUrl("http://[2606:4700::1111]/"), null, "genel IPv6 URL gecmeli");

  // The private embedded-IPv4 spellings stay refused — the decode order did not flip.
  for (const h of ["64:ff9b::7f00:1", "2002:7f00:1::", "::ffff:a9fe:a9fe"]) {
    assert.equal(isPrivateHostname(h), true, `gomulu ozel IPv4 '${h}' kacti`);
  }
});

/**
 * FINDING 2 (medium) — the bracket-move half of the round-1 fix was locked by NO test.
 *
 * The review re-ran the mutation itself: put the bracket strip back inside the IPv6 branch,
 * leave the zero-hextet rule in place, and all three round-1 tests stayed GREEN. The reason is
 * that "[::]" carries a colon, so it enters the IPv6 branch and gets its brackets stripped
 * there anyway — the zero-hextet rule catches it either way.
 *
 * What ONLY the moved strip catches is a bracketed host WITHOUT a colon: it never enters the
 * IPv6 branch, so the brackets survive to the IPv4 regex and to the literal name comparisons,
 * both of which then fail to match and the host is returned PUBLIC. These are the assertions
 * that go red when the strip moves back inside the branch.
 */
test("Parantez siyirma FONKSIYONUN BASINDA — iki nokta tasimayan parantezli host da cozulur", () => {
  assert.equal(isPrivateHostname("[127.0.0.1]"), true, "[127.0.0.1] — parantez IPv4 kuralina ulasmali");
  assert.equal(isPrivateHostname("[0.0.0.0]"), true, "[0.0.0.0]");
  assert.equal(isPrivateHostname("[10.1.1.1]"), true, "[10.1.1.1] — RFC1918");
  assert.equal(isPrivateHostname("[169.254.169.254]"), true, "[169.254.169.254] — IMDS");
  assert.equal(isPrivateHostname("[localhost]"), true, "[localhost] — ad karsilastirmasi");
  assert.equal(isPrivateHostname("[999.1.1.1]"), true, "[999.1.1.1] — adres bile degil, fail-closed");

  // The counterweight: stripping brackets must not turn a public name private.
  assert.equal(isPrivateHostname("[example.com]"), false, "[example.com] — mesru ad");
  assert.equal(isPrivateHostname("[8.8.8.8]"), false, "[8.8.8.8] — mesru IPv4");
});

/**
 * FINDING 3 (medium) — the docblock over hextetleriAc justified the fail-open default with a
 * claim that is measurably false, and it was the ONLY written justification for it.
 *
 * It said: "an unrecognised address is not passed as 'public' — the caller sends it to DNS,
 * and if it does not resolve there the request is refused."
 *
 * The caller does no such thing for an IP literal. assertPublicHost computes
 * `net.isIP(cozulecek)` and RETURNS EARLY for every literal, so the DNS step never runs.
 * (site.test.ts pins that early return from the other side: it wires the resolver to throw and
 * fetches a legitimate IPv6 page.) This test binds the two files together — if that early
 * return is ever removed, the corrected comment becomes stale in the other direction and this
 * goes red.
 */
test("Belge gozcusu: 'cagiran DNS'e gonderir' gerekcesi kaynakta YOK ve olgusal temeli duruyor", () => {
  /**
   * The comment leaders and every line break are collapsed FIRST. A first cut of this
   * watchdog matched the raw file and a re-run of the mutation slipped straight past it: the
   * reinstated sentence had simply wrapped as "the caller sends it to\n * DNS", and the
   * pattern was looking for one line. A doc guard that only catches one line wrapping is not
   * a guard.
   */
  const kaynak = readFileSync(KAYNAK, "utf8")
    .replace(/\n\s*\*/g, " ")
    .replace(/\s+/g, " ");
  assert.ok(
    !/caller sends it to DNS/i.test(kaynak),
    "YANLIS gerekce geri geldi: IP degismezi DNS'e HIC gitmiyor (tools/site.ts erken donuyor)"
  );

  // The fact the corrected comment now rests on: the caller short-circuits IP literals.
  const siteKaynak = readFileSync(SITE_KAYNAK, "utf8");
  assert.match(
    siteKaynak,
    /net\.isIP\(cozulecek\)\s*!==\s*0\)\s*return;/,
    "assertPublicHost'un erken donusu kayboldu — siteExtract.ts'teki yorum artik bayat"
  );

  // And every address at issue really is an IP literal, so that early return really fires.
  for (const h of ["fec0::1", "ff02::1", "::7f00:1", "100::1", "3fff::1"]) {
    assert.notEqual(net.isIP(h), 0, `${h} IP degismezi sayilmiyor — erken donus varsayimi yanlis`);
  }
});
