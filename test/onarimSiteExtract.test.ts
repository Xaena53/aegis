// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateHostname, validateAnalyzeUrl } from "../src/siteExtract.js";

/**
 * Regression cover for the SSRF gate's unspecified-address hole.
 *
 * WHAT WAS BROKEN: `isPrivateHostname` compared the raw hostname against the bare literal
 * "::" but only stripped the surrounding brackets LATER, inside the IPv6 branch. Node's
 * `new URL("http://[::]/").hostname` keeps the brackets, so for every host that arrived
 * through a URL the guard was dead code: "[::]" matched no literal, matched none of the
 * IPv6 patterns (::1, fc00::/7, fe80::/10), carried no embedded IPv4, and came back PUBLIC.
 *
 * WHY IT MATTERS: connect() to the unspecified address goes to loopback. `analyze_site` with
 * url="http://[::]:8787/settings" therefore reached Aegis' own local HTTP surface (and any
 * other service bound with the default dual-stack `listen(PORT)`) and returned its body to
 * the agent. The IPv4 twin, 0.0.0.0, was refused by two separate rules the whole time; only
 * the IPv6 spelling was open.
 *
 * The gate that follows in tools/site.ts cannot catch it either: `net.isIP("::") !== 0`, so
 * assertPublicHost returns early and the DNS check never runs. isPrivateHostname is the only
 * thing standing there.
 */
test("SSRF: belirtilmemiş adres (::) köşeli parantezli hâliyle de REDDEDİLİR", () => {
  // The exact shape the URL parser produces — the one that used to pass.
  assert.equal(isPrivateHostname("[::]"), true, "[::] — URL ayrıştırıcısının ürettiği biçim");
  // The bare form was already refused; it must stay refused.
  assert.equal(isPrivateHostname("::"), true, "çıplak ::");

  /**
   * Same address, other legal spellings. "Unknown" must not become "public" just because of
   * how the address happened to be written — the same reasoning the file applies to 0.0.0.0,
   * which it refuses both as a literal and via `a === 0`.
   */
  for (const h of ["[0:0:0:0:0:0:0:0]", "0:0:0:0:0:0:0:0", "[::0.0.0.0]", "::0.0.0.0", "[0::0]"]) {
    assert.equal(isPrivateHostname(h), true, `belirtilmemiş adres yazımı: ${h}`);
  }
});

test("SSRF: validateAnalyzeUrl http://[::]/ adresini REDDEDER", () => {
  /**
   * The end-to-end assertion: a null return here means ALLOWED, and that is what the gate
   * used to say. Ports are included because the attack needs one — a local admin surface
   * does not sit on 80.
   */
  for (const u of [
    "http://[::]/",
    "http://[::]:43117/",
    "http://[::]:8787/settings",
    "http://[0:0:0:0:0:0:0:0]/",
    "http://[::0.0.0.0]/",
  ]) {
    const sonuc = validateAnalyzeUrl(u);
    assert.notEqual(sonuc, null, `${u} KABUL edildi — SSRF kapısı açık`);
    assert.match(String(sonuc), /SSRF koruması/, u);
  }
});

test("SSRF düzeltmesi meşru genel IPv6'yı kapatmaz", () => {
  /**
   * The counterweight: the bracket strip moved to the top of the function runs for every
   * host, so this locks in that it did not turn the gate into a blanket IPv6 refusal. A fix
   * that refuses everything would pass the two tests above and kill the feature.
   */
  assert.equal(isPrivateHostname("[2606:4700::1111]"), false, "Cloudflare DNS — genel");
  assert.equal(isPrivateHostname("2606:4700::1111"), false, "parantezsiz de genel");
  assert.equal(isPrivateHostname("[2001:db8::1]"), false, "belge aralığı, gömülü IPv4 yok");
  assert.equal(validateAnalyzeUrl("http://[2606:4700::1111]/"), null, "genel IPv6 URL geçmeli");
  assert.equal(validateAnalyzeUrl("https://example.com/"), null, "sıradan alan adı geçmeli");

  // Trailing-dot FQDN still normalises correctly now that two strips run in sequence.
  assert.equal(isPrivateHostname("example.com."), false, "kök noktalı FQDN — genel");
  assert.equal(isPrivateHostname("localhost."), true, "kök noktalı localhost — özel");
});
