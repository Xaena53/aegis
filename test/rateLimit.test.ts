import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/rateLimit.js";

/** Controlled clock: exercises window behaviour without depending on real time. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("dakikalık sınır aşılınca 429 sinyali, pencere dönünce serbest", () => {
  const c = clock();
  const rl = new RateLimiter({ perMinute: 3, perDay: 100 }, c.now);
  for (let i = 0; i < 3; i++) assert.equal(rl.check(1).allowed, true, `istek ${i + 1}`);
  const blocked = rl.check(1);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason!, /Dakikalık istek sınırı/);
  assert.ok(blocked.retryAfterSec! > 0 && blocked.retryAfterSec! <= 60);

  c.advance(60_000);
  assert.equal(rl.check(1).allowed, true, "pencere dönünce yeniden izin verilmeli");
});

test("reddedilen istek sayacı ARTIRMAZ (ceza uzamaz)", () => {
  const c = clock();
  const rl = new RateLimiter({ perMinute: 2, perDay: 100 }, c.now);
  rl.check(1);
  rl.check(1);
  for (let i = 0; i < 50; i++) assert.equal(rl.check(1).allowed, false);
  c.advance(60_000);
  // Had the 50 rejected requests been counted, this would still be blocked
  assert.equal(rl.check(1).allowed, true);
});

test("kullanıcılar birbirini etkilemez (izolasyon)", () => {
  const c = clock();
  const rl = new RateLimiter({ perMinute: 2, perDay: 100 }, c.now);
  assert.equal(rl.check(1).allowed, true);
  assert.equal(rl.check(1).allowed, true);
  assert.equal(rl.check(1).allowed, false, "kullanıcı 1 sınırda");
  assert.equal(rl.check(2).allowed, true, "kullanıcı 2 etkilenmemeli");
  assert.equal(rl.check(2).allowed, true);
});

test("günlük kota dakikalık pencereden bağımsız uygulanır", () => {
  const c = clock();
  const rl = new RateLimiter({ perMinute: 10, perDay: 5 }, c.now);
  for (let i = 0; i < 5; i++) {
    assert.equal(rl.check(1).allowed, true);
    c.advance(61_000); // resets the per-minute window each time
  }
  const blocked = rl.check(1);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason!, /Günlük istek kotası/);
  assert.ok(blocked.retryAfterSec! > 60, "gün sonuna kadar beklemeli");
});

test("günlük pencere dolunca sıfırlanır", () => {
  const c = clock();
  const rl = new RateLimiter({ perMinute: 100, perDay: 2 }, c.now);
  rl.check(1);
  rl.check(1);
  assert.equal(rl.check(1).allowed, false);
  c.advance(24 * 60 * 60_000);
  assert.equal(rl.check(1).allowed, true);
});

test("remaining kalan hakkı doğru bildirir", () => {
  const c = clock();
  const rl = new RateLimiter({ perMinute: 5, perDay: 10 }, c.now);
  assert.deepEqual(rl.remaining(1), { minute: 5, day: 10 });
  rl.check(1);
  rl.check(1);
  assert.deepEqual(rl.remaining(1), { minute: 3, day: 8 });
});

test("sweep süresi geçmiş pencereleri temizler (bellek)", () => {
  const c = clock();
  const rl = new RateLimiter({ perMinute: 5, perDay: 10 }, c.now);
  for (let u = 1; u <= 100; u++) rl.check(u);
  c.advance(24 * 60 * 60_000 + 1);
  rl.sweep();
  // A fresh window after the sweep grants the full allowance
  assert.deepEqual(rl.remaining(1), { minute: 5, day: 10 });
});

/* ── JETON = İŞLEM, İSTEK DEĞİL ────────────────────────────────────────────────
 *
 * Sayaç istek başına bir kez arttığı sürece, tek bir POST'a konan N elemanlı JSON-RPC
 * dizisi N araç çağrısını tek jetona satın alıyordu. Ölçülen şey (istek) ile korunan
 * şey (paylaşılan upstream kotası, CAMARA sorguları, bu süreç) birbirinden kopmuştu.
 * ─────────────────────────────────────────────────────────────────────────────── */

test("toplu istek ADEDİ kadar jeton düşer (tek çağrı, N işlem)", () => {
  const c = clock();
  const rl = new RateLimiter({ perMinute: 10, perDay: 100 }, c.now);
  assert.equal(rl.check(1, 6).allowed, true, "6 işlem 10'luk tavana sığmalı");
  assert.deepEqual(rl.remaining(1), { minute: 4, day: 94 }, "altı jeton düşmeli, bir değil");
  assert.equal(rl.check(1, 5).allowed, false, "kalan 4 iken 5 işlem geçemez");
  assert.equal(rl.check(1, 4).allowed, true, "tam sığan istek geçmeli");
  assert.deepEqual(rl.remaining(1), { minute: 0, day: 90 });
});

test("tavanı tek başına aşan toplu istek KISMEN koşmaz, HİÇ koşmaz", () => {
  const c = clock();
  const rl = new RateLimiter({ perMinute: 5, perDay: 100 }, c.now);
  const red = rl.check(1, 50);
  assert.equal(red.allowed, false);
  assert.match(red.reason!, /50 işlem/, "kaç işlem istendiği söylenmeli");
  assert.deepEqual(rl.remaining(1), { minute: 5, day: 100 }, "reddedilen istek sayacı ARTIRMAZ");
});

test("günlük kota da işlem başına tükenir", () => {
  const c = clock();
  const rl = new RateLimiter({ perMinute: 100, perDay: 10 }, c.now);
  assert.equal(rl.check(1, 7).allowed, true);
  c.advance(61_000); // dakikalık pencere sıfırlanır, günlük sıfırlanmaz
  assert.equal(rl.check(1, 7).allowed, false, "günlük kota 10 iken 7+7 geçemez");
  assert.equal(rl.check(1, 3).allowed, true);
});

test("adet varsayılanı 1 (mevcut çağrı yerleri değişmeden çalışır)", () => {
  const c = clock();
  const rl = new RateLimiter({ perMinute: 3, perDay: 100 }, c.now);
  rl.check(1);
  assert.deepEqual(rl.remaining(1), { minute: 2, day: 99 });
});
