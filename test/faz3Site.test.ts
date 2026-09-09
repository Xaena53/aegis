// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 3 — analyze_site media-type gate: "unknown" is not "clean".
 *
 * The media-type check used to be guarded by `if (mediaType && ...)`. That leading truth
 * test short-circuits the WHOLE gate whenever the media type is an empty string, which
 * happens in two ways an upstream server fully controls:
 *
 *   1) no Content-Type header at all  → `(null ?? "")` → ""
 *   2) a header with an EMPTY type but real parameters, e.g. `; charset=utf-8`
 *      → `split(";")[0].trim()` → ""
 *
 * In both cases the body was decoded, run through extractPageFacts and written into the
 * <site-verisi> block — so a tool whose own description says "yalnız web sayfası analiz
 * eder" became a general-purpose reader for any 1.5MB blob, purely by OMITTING a header.
 * That is the inverse of the fail-closed contract, and it contradicted the comment eight
 * lines above the check ("'unknown' and 'clean' are not the same thing").
 *
 * The last test here is the counterweight: a real text/html page must STILL be analysed.
 * Without it, "reject everything" would satisfy the first three assertions, and the
 * watcher would be pinning the wrong shape of the fix.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sahteContext, baglanti } from "./helpers/harness.js";
import { __setSiteCozumleyiciForTests } from "../src/tools/site.js";

/** Public IP literal: no DNS query is made, so the test stays offline. */
const URL_GENEL = "http://93.184.216.34/";

const gercekFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = gercekFetch;
  __setSiteCozumleyiciForTests(undefined);
});

/** Serves one canned response; `tip: null` means the header is absent entirely. */
function sayfaVer(govde: string, tip: string | null): void {
  const bas = new Map<string, string>();
  if (tip !== null) bas.set("content-type", tip);
  const bayt = Buffer.from(govde, "utf8");
  globalThis.fetch = (async () =>
    ({
      status: 200,
      headers: { get: (k: string) => bas.get(k.toLowerCase()) ?? null },
      body: {
        getReader() {
          let verildi = false;
          return {
            async read() {
              if (verildi) return { done: true, value: undefined };
              verildi = true;
              return { done: false, value: new Uint8Array(bayt) };
            },
          };
        },
        cancel: async () => {},
      },
    }) as any) as typeof fetch;
}

async function analiz(url: string): Promise<{ metin: string; hata: boolean }> {
  const { ctx } = sahteContext({});
  const c = await baglanti(ctx);
  const res: any = await c.callTool({ name: "analyze_site", arguments: { url } });
  return { metin: String(res.content?.[0]?.text ?? ""), hata: res.isError === true };
}

/** The payload every negative case serves: if it reaches the agent, the gate leaked. */
const YUK = "<html><title>SIZAN-GOVDE</title><body>gizli yuk</body></html>";

test("FAZ3 site: Content-Type başlığı HİÇ yoksa gövde işlenmez", async () => {
  sayfaVer(YUK, null);
  const { metin, hata } = await analiz(URL_GENEL);
  assert.equal(hata, true, "başlıksız yanıt RET olmalı, isError ile");
  assert.match(metin, /HTML değil/, "ret gerekçesi medya tipi kapısı olmalı");
  assert.match(metin, /bilinmeyen tip/, "boş tip açıkça 'bilinmeyen' denmeli");
  assert.doesNotMatch(metin, /SIZAN-GOVDE/, "KRİTİK: gövde ajana ulaşmamalı");
  assert.doesNotMatch(metin, /site-verisi/, "KRİTİK: blok hiç kurulmamalı");
});

test("FAZ3 site: medya tipi boş ama parametreli ('; charset=utf-8') kapıyı geçemez", async () => {
  // split(";")[0] is the empty string here, exactly like a missing header.
  sayfaVer(YUK, "; charset=utf-8");
  const { metin, hata } = await analiz(URL_GENEL);
  assert.equal(hata, true, "boş medya tipi RET olmalı");
  assert.match(metin, /HTML değil/);
  assert.match(metin, /bilinmeyen tip/);
  assert.doesNotMatch(metin, /SIZAN-GOVDE/, "KRİTİK: gövde ajana ulaşmamalı");
});

test("FAZ3 site: yalnız boşluktan ibaret Content-Type de reddedilir", async () => {
  sayfaVer(YUK, "   ");
  const { metin, hata } = await analiz(URL_GENEL);
  assert.equal(hata, true, "boşluk bir medya tipi değildir");
  assert.match(metin, /HTML değil/);
  assert.doesNotMatch(metin, /SIZAN-GOVDE/, "KRİTİK: gövde ajana ulaşmamalı");
});

test("FAZ3 site: MEŞRU text/html hâlâ analiz edilir (kapı her şeyi reddetmiyor)", async () => {
  /**
   * Counterweight. A gate that refuses everything would pass the three tests above while
   * killing the tool; this one fails in that direction, so the watcher can go red BOTH ways.
   */
  sayfaVer("<html><title>Gecerli Sayfa</title><body>merhaba</body></html>", "text/html; charset=utf-8");
  const { metin, hata } = await analiz(URL_GENEL);
  assert.equal(hata, false, "geçerli HTML reddedilmemeli");
  assert.match(metin, /Gecerli Sayfa/, "başlık çıkarılmalı");
  assert.match(metin, /<site-verisi>/, "blok kurulmalı");
});
