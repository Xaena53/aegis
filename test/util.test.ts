import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCustomerId,
  invalidId,
  dedupe,
  geoTargetId,
  budgetGuard,
  dateRange,
  formatAdsError,
  isTransientAdsError,
  withRetry,
  toMicrosInt,
  ensureGaqlLimit,
  normalizeGaql,
  cleanId,
  isConcurrentModificationError,
} from "../src/util.js";

test("normalizeCustomerId tireleri ve harfleri temizler", () => {
  assert.equal(normalizeCustomerId("123-456-7890"), "1234567890");
  assert.equal(normalizeCustomerId("1234567890"), "1234567890");
  assert.equal(normalizeCustomerId("customers/123"), "123");
});

test("invalidId sadece rakamı kabul eder", () => {
  assert.equal(invalidId("x", "12345"), null);
  assert.equal(invalidId("x", " 12345 "), null);
  assert.match(invalidId("kampanya ID", "abc; DROP")!, /Geçersiz kampanya ID/);
  assert.notEqual(invalidId("x", ""), null);
  assert.notEqual(invalidId("x", "12.5"), null);
});

test("dedupe harf duyarsız, sıra korur, boşları atar", () => {
  assert.deepEqual(dedupe(["Anime", "anime", "  ", "manga", "ANIME "]), ["Anime", "manga"]);
  assert.deepEqual(dedupe([]), []);
});

test("dedupe Türkçe İ/ı varyantlarını yakalar", () => {
  assert.deepEqual(dedupe(["ÜCRETSİZ", "ücretsiz"]), ["ÜCRETSİZ"]); // a plain toLowerCase misses this pair
  assert.deepEqual(dedupe(["ISPARTA", "ısparta"]), ["ISPARTA"]);
  assert.deepEqual(dedupe(["İzmir", "izmir"]), ["İzmir"]);
});

test("geoTargetId bilinen ülkeler ve bilinmeyen", () => {
  assert.equal(geoTargetId("TR"), 2792);
  assert.equal(geoTargetId("tr"), 2792);
  assert.equal(geoTargetId("US"), 2840);
  assert.equal(geoTargetId("DE"), 2276);
  assert.equal(geoTargetId("XX"), null);
});

test("budgetGuard tavan ve geçersiz değerler", () => {
  assert.equal(budgetGuard(100, 500), null);
  assert.match(budgetGuard(501, 500)!, /tavanının .* üzerinde/);
  assert.notEqual(budgetGuard(0, 500), null);
  assert.notEqual(budgetGuard(-5, 500), null);
  assert.notEqual(budgetGuard(NaN, 500), null);
});

test("budgetGuard bozuk tavanda sessizce geçirmez", () => {
  assert.match(budgetGuard(10, NaN)!, /tavanı yapılandırması geçersiz/);
  assert.match(budgetGuard(10, 0)!, /tavanı yapılandırması geçersiz/);
  assert.match(budgetGuard(10, -1)!, /tavanı yapılandırması geçersiz/);
});

test("toMicrosInt float artığı bırakmaz", () => {
  assert.equal(toMicrosInt(0.07), 70000); // 0.07*1e6 would land on 70000.00000000001
  assert.equal(toMicrosInt(50), 50_000_000);
  assert.equal(toMicrosInt(10.5555555), 10_555_556);
  assert.ok(Number.isInteger(toMicrosInt(123.456789)));
});

test("ensureGaqlLimit: yoksa ekler, küçük LIMIT'e dokunmaz, büyüğünü KIRPAR", () => {
  assert.equal(
    ensureGaqlLimit("SELECT campaign.name FROM campaign", 100),
    "SELECT campaign.name FROM campaign LIMIT 100"
  );
  assert.equal(ensureGaqlLimit("SELECT x FROM y LIMIT 5", 100), "SELECT x FROM y LIMIT 5");
  // A huge caller-supplied LIMIT can exhaust process memory, so it is clamped to the cap
  assert.equal(ensureGaqlLimit("SELECT x FROM y LIMIT 500000", 100), "SELECT x FROM y LIMIT 100");
  assert.equal(
    ensureGaqlLimit("SELECT x FROM y ORDER BY x LIMIT 250", 100),
    "SELECT x FROM y ORDER BY x LIMIT 100"
  );
});

test("ensureGaqlLimit: PARAMETERS yan tümcesi LIMIT'ten SONRA kalmalı", () => {
  assert.equal(
    ensureGaqlLimit("SELECT x FROM y PARAMETERS include_drafts=true", 100),
    "SELECT x FROM y LIMIT 100 PARAMETERS include_drafts=true"
  );
  assert.equal(
    ensureGaqlLimit("SELECT x FROM y LIMIT 900 PARAMETERS include_drafts=true", 100),
    "SELECT x FROM y LIMIT 100 PARAMETERS include_drafts=true"
  );
});

test("ensureGaqlLimit: metin sabiti içindeki LIMIT yanıltmaz", () => {
  // Mistaking the quoted "LIMIT 5" for a real clause would leave the query unbounded
  const q = "SELECT x FROM y WHERE campaign.name LIKE '%LIMIT 5%'";
  assert.equal(ensureGaqlLimit(q, 100), `${q} LIMIT 100`);
});

test("normalizeGaql çok satırlı sorguyu tek satıra indirir (sessiz veri kaybı fix'i)", () => {
  const multi = "SELECT campaign.name,\n  metrics.cost_micros\nFROM campaign\nWHERE x = 1";
  assert.equal(normalizeGaql(multi), "SELECT campaign.name, metrics.cost_micros FROM campaign WHERE x = 1");
  assert.doesNotMatch(normalizeGaql(multi), /\n/);
  // ensureGaqlLimit normalizes as well, so there is a single entry point
  assert.doesNotMatch(ensureGaqlLimit(multi, 10), /\n/);
});

test("cleanId doğrulanan değerle kaynak adında kullanılan değeri eşitler", () => {
  assert.equal(invalidId("x", " 123 "), null);
  assert.equal(cleanId(" 123 "), "123"); // without the trim this would build "adGroups/ 123"
});

test("dateRange bugünü dışlar, N gün kapsar", () => {
  // Fixed local date: 2026-08-11
  const now = new Date(2026, 7, 11, 15, 30);
  assert.equal(
    dateRange(7, now),
    "segments.date BETWEEN '2026-08-04' AND '2026-08-10'"
  );
  assert.equal(
    dateRange(1, now),
    "segments.date BETWEEN '2026-08-10' AND '2026-08-10'"
  );
  // Crossing a month boundary
  assert.equal(
    dateRange(30, new Date(2026, 2, 5)),
    "segments.date BETWEEN '2026-02-03' AND '2026-03-04'"
  );
});

test("formatAdsError kod adı + mesaj birleştirir", () => {
  const e = {
    errors: [
      { error_code: { query_error: "UNRECOGNIZED_FIELD" }, message: "alan yok" },
      { message: "ikinci" },
    ],
  };
  const s = formatAdsError(e);
  assert.match(s, /query_error=UNRECOGNIZED_FIELD \| alan yok/);
  assert.match(s, /ikinci/);
  // when field_path is present the offending field is surfaced
  const withPath = formatAdsError({
    errors: [{ error_code: { field_error: "REQUIRED" }, message: "eksik",
      location: { field_path_elements: [{ field_name: "mutate_operations", index: 1 }, { field_name: "create" }] } }],
  });
  assert.match(withPath, /alan: mutate_operations\[1\]\.create/);
  assert.match(formatAdsError(new Error("düz hata")), /düz hata/);
  assert.match(formatAdsError("string"), /string/);
});

test("formatAdsError sık hatalara Türkçe ipucu ekler", () => {
  assert.match(formatAdsError(new Error("invalid_grant")), /npm run auth/);
  assert.match(
    formatAdsError({ errors: [{ error_code: { authorization_error: "USER_PERMISSION_DENIED" }, message: "x" }] }),
    /GOOGLE_ADS_LOGIN_CUSTOMER_ID/
  );
  assert.match(formatAdsError(new Error("DEVELOPER_TOKEN_NOT_APPROVED")), /Basic Access/);
  assert.doesNotMatch(formatAdsError(new Error("alakasız hata")), /İpucu/);
});

test("isTransientAdsError gRPC kodları ve mesaj kalıpları", () => {
  assert.equal(isTransientAdsError({ code: 14 }), true);
  assert.equal(isTransientAdsError({ code: 4 }), true);
  assert.equal(isTransientAdsError({ code: 8 }), true);
  assert.equal(isTransientAdsError({ message: "503 UNAVAILABLE" }), true);
  assert.equal(isTransientAdsError({ message: "QuotaError.RESOURCE_EXHAUSTED" }), true);
  assert.equal(isTransientAdsError({ code: 3, message: "INVALID_ARGUMENT" }), false);
  assert.equal(isTransientAdsError(new Error("kimlik hatası")), false);
});

test("isConcurrentModificationError yalnız o hata sınıfını yakalar", () => {
  assert.equal(isConcurrentModificationError({ errors: [{ error_code: { database_error: 2 } }] }), true);
  assert.equal(isConcurrentModificationError({ errors: [{ error_code: { database_error: "CONCURRENT_MODIFICATION" } }] }), true);
  assert.equal(
    isConcurrentModificationError(new Error("Multiple requests were attempting to modify the same resource at once.")),
    true
  );
  assert.equal(isConcurrentModificationError({ errors: [{ error_code: { field_error: 2 } }] }), false);
  assert.equal(isConcurrentModificationError(new Error("UNAVAILABLE")), false); // network errors are not retried on mutations
});

test("withRetry geçici hatada tekrar dener, kalıcıda denemez", async () => {
  let calls = 0;
  const ok = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw { code: 14, message: "UNAVAILABLE" };
      return "tamam";
    },
    { baseMs: 1 }
  );
  assert.equal(ok, "tamam");
  assert.equal(calls, 3);

  let calls2 = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls2++;
        throw new Error("PERMISSION_DENIED");
      },
      { baseMs: 1 }
    ),
    /PERMISSION_DENIED/
  );
  assert.equal(calls2, 1, "kalıcı hata tek denemede fırlatılmalı");

  let calls3 = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls3++;
        throw { code: 14, message: "UNAVAILABLE" };
      },
      { baseMs: 1, tries: 3 }
    )
  );
  assert.equal(calls3, 3, "geçici hata tries kadar denenmeli");
});
