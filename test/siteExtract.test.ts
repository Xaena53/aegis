import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPageFacts, isPrivateHostname, validateAnalyzeUrl } from "../src/siteExtract.js";

const SAMPLE = `<!doctype html>
<html lang="tr">
<head>
  <title>Gül Gelinlik &amp; Moda — Isparta</title>
  <meta name="description" content="Isparta'da gelinlik, nişanlık ve abiye modelleri.">
  <meta content="gelinlik, abiye" name="keywords">
  <meta property="og:title" content="Gül Gelinlik">
  <script type="application/ld+json">
    {"@type":"LocalBusiness","name":"Gül Gelinlik","description":"Gelinlik mağazası","offers":{"price":"5000","priceCurrency":"TRY"}}
  </script>
  <style>.x{color:red}</style>
  <script>var gizli = "asla görünmemeli";</script>
</head>
<body>
  <nav><a href="/gelinlik"><span>Gelinlik Modelleri</span></a><a href="/abiye">Abiye</a><a href="/abiye">Abiye</a></nav>
  <h1>Isparta Gelinlik Mağazası</h1>
  <h2>2026 Koleksiyonu</h2>
  <h2>Özel Dikim</h2>
  <p>Hayalinizdeki gelinliği birlikte tasarlayalım. &#304;letişime geçin.</p>
</body></html>`;

test("extractPageFacts temel alanları çıkarır", () => {
  const f = extractPageFacts(SAMPLE);
  assert.equal(f.title, "Gül Gelinlik & Moda — Isparta");
  assert.equal(f.lang, "tr");
  assert.match(f.metaDescription!, /gelinlik, nişanlık/);
  assert.equal(f.metaKeywords, "gelinlik, abiye"); // content-önce sırası da yakalanmalı
  assert.equal(f.ogTitle, "Gül Gelinlik");
  assert.deepEqual(f.h1, ["Isparta Gelinlik Mağazası"]);
  assert.deepEqual(f.h2, ["2026 Koleksiyonu", "Özel Dikim"]);
});

test("extractPageFacts JSON-LD ve nav'ı özetler", () => {
  const f = extractPageFacts(SAMPLE);
  assert.equal(f.jsonLd.length, 1);
  assert.match(f.jsonLd[0], /LocalBusiness/);
  assert.match(f.jsonLd[0], /5000/);
  assert.deepEqual(f.navTexts, ["Gelinlik Modelleri", "Abiye"]); // iç etiket sökülür, tekrar ayıklanır
});

test("extractPageFacts script/style görünür metne sızmaz", () => {
  const f = extractPageFacts(SAMPLE);
  assert.doesNotMatch(f.visibleText, /gizli|color:red/);
  assert.match(f.visibleText, /Hayalinizdeki gelinliği/);
  assert.match(f.visibleText, /İletişime/); // &#304; entity çözümü
});

test("extractPageFacts textChars sınırı", () => {
  const f = extractPageFacts(SAMPLE, { textChars: 500 });
  assert.ok(f.visibleText.length <= 500);
});

test("isPrivateHostname özel ağları yakalar", () => {
  for (const h of ["localhost", "foo.localhost", "printer.local", "db.internal",
                   "127.0.0.1", "127.9.9.9", "10.0.0.5", "172.16.0.1", "172.31.255.255",
                   "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
                   "::1", "fc00::1", "fe80::1", "::ffff:192.168.1.1"]) {
    assert.equal(isPrivateHostname(h), true, h);
  }
  for (const h of ["example.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "animerank.com.tr", "2606:4700::1"]) {
    assert.equal(isPrivateHostname(h), false, h);
  }
});

test("validateAnalyzeUrl şema ve host kontrolü", () => {
  assert.equal(validateAnalyzeUrl("https://example.com/x"), null);
  assert.match(validateAnalyzeUrl("ftp://example.com")!, /yalnız http/);
  assert.match(validateAnalyzeUrl("http://192.168.1.1/admin")!, /SSRF/);
  assert.match(validateAnalyzeUrl("http://169.254.169.254/latest/meta-data")!, /SSRF/);
  assert.match(validateAnalyzeUrl("garbage")!, /Geçersiz URL/);
});
