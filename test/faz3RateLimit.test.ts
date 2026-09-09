// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 3 — src/rateLimit.ts regression watchers.
 *
 * The audited defect: the module called itself a "sliding-window" limiter while peek()
 * implemented a fixed window pinned to the first request and cleared wholesale when the
 * span elapsed. Measured on the shipped code (perMinute=120, controlled clock): 240
 * operations passed inside a 100 ms span straddling the turnover — twice the published
 * ceiling, on the very counter whose stated job is protecting a quota shared by every
 * tenant. These tests hold the ceiling at the boundary, in both windows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RateLimiter } from "../src/rateLimit.js";

/** Controlled clock: exercises window behaviour without depending on real time. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const GUN_MS = 24 * 60 * 60_000;

/** How many of `deneme` back-to-back single-token calls the limiter lets through. */
function gecen(rl: RateLimiter, userId: number, deneme: number): number {
  let n = 0;
  for (let i = 0; i < deneme; i++) if (rl.check(userId).allowed) n++;
  return n;
}

test("dakikalık pencere sınırında 2x patlama YOK", () => {
  /**
   * The audited scenario, reproduced exactly. Under the fixed window the whole allowance
   * came back at the turnover, so the last 100 ms of one window plus the first instant of
   * the next carried 2 x perMinute. Under a sliding window only the tokens that genuinely
   * aged out are released.
   */
  const c = clock();
  const rl = new RateLimiter({ perMinute: 120, perDay: 1_000_000 }, c.now);

  assert.equal(rl.check(1).allowed, true, "ilk işlem pencereyi açar");
  c.advance(59_900); // 100 ms before a fixed window would turn over
  const doldur = gecen(rl, 1, 500);
  assert.equal(doldur, 119, "tavan tam dolmalı (1 + 119 = 120)");

  c.advance(100); // the exact instant the old implementation zeroed the counter
  const sinirOtesi = gecen(rl, 1, 500);
  assert.equal(
    sinirOtesi,
    1,
    `sınırın ötesinde YALNIZ yaşlanan jeton kadar hak açılmalı (geçen: ${sinirOtesi})`
  );

  const yuzMsIcinde = doldur + sinirOtesi;
  assert.ok(
    yuzMsIcinde <= 120,
    `100 ms içinde ${yuzMsIcinde} işlem geçti; ilan edilen tavan 120/dk — pencere kayıyor değil dönüyor`
  );
});

test("günlük kota sınırında ikinci bir TAM kota açılmaz", () => {
  /**
   * The same doubling at the day boundary, and the one that actually reaches the shared
   * Google developer-token quota (15,000/day, per token): 2 x perDay operations inside a
   * second is what drops every OTHER tenant into RESOURCE_EXHAUSTED.
   */
  const c = clock();
  const rl = new RateLimiter({ perMinute: 1000, perDay: 10 }, c.now);

  assert.equal(rl.check(1).allowed, true, "ilk işlem günlük pencereyi açar");
  c.advance(GUN_MS - 1000); // 1 s before a fixed window would turn over
  assert.equal(gecen(rl, 1, 50), 9, "günlük kota dolmalı (1 + 9 = 10)");

  c.advance(1000);
  const sinirOtesi = gecen(rl, 1, 50);
  assert.equal(
    sinirOtesi,
    1,
    `gün sınırında yalnız yaşlanan jeton kadar hak açılmalı, yeni bir tam kota değil (geçen: ${sinirOtesi})`
  );
});

test("bir vuruş penceresinin TAMAMI boyunca sayılır (erken yaşlanma yok)", () => {
  /**
   * The other direction, so the fix cannot be "corrected" into a bucketed window that
   * expires a hit early: dropping a hit before it is `spanMs` old raises the real ceiling
   * again, just more quietly.
   */
  const c = clock();
  const rl = new RateLimiter({ perMinute: 2, perDay: 1_000_000 }, c.now);
  assert.equal(rl.check(1, 2).allowed, true);

  c.advance(59_999);
  assert.equal(rl.check(1).allowed, false, "59.999 s sonra vuruş HÂLÂ pencerede sayılmalı");
  assert.equal(rl.remaining(1).minute, 0, "remaining de aynı vuruşu görmeli");

  c.advance(1);
  assert.equal(rl.check(1).allowed, true, "tam 60 s dolunca hak serbest kalmalı");
});

test("retryAfterSec bir SÖZ: söylenen süre gerçekten yetiyor, öncesi yetmiyor", () => {
  /**
   * With a sliding window "wait until the window ends" is no longer the answer; the answer
   * is "wait until enough hits are `spanMs` old". A deadline that is too early turns a 429
   * into a retry loop, one that is too late throws away allowance the caller has.
   */
  const c = clock();
  const rl = new RateLimiter({ perMinute: 10, perDay: 1_000_000 }, c.now);
  assert.equal(rl.check(1, 4).allowed, true);
  c.advance(30_000);
  assert.equal(rl.check(1, 6).allowed, true, "pencere tam dolar");

  const red = rl.check(1, 4);
  assert.equal(red.allowed, false);
  const bekle = red.retryAfterSec!;
  assert.ok(bekle > 0 && bekle <= 60, `retryAfterSec makul olmalı (gelen: ${bekle})`);

  c.advance((bekle - 1) * 1000);
  assert.equal(rl.check(1, 4).allowed, false, "söylenen süreden önce geçmemeli");
  c.advance(1000);
  assert.equal(rl.check(1, 4).allowed, true, "söylenen süre dolunca geçmeli");
});

test("başlıktaki 'sliding window' vaadi ile davranış aynı yönde (çift yönlü gözcü)", () => {
  /**
   * ARCHITECTURE.md repeats this module's own word for itself ("per-user sliding-window
   * limiter"), so the sentence and the behaviour have to move together.
   *
   * (a) Sentence goes stale -> red: if the header stops claiming a sliding window (someone
   *     reverts the algorithm and honestly relabels it), the match below fails.
   * (b) Code changes -> red: if the header keeps the claim while the window goes back to
   *     turning over, the boundary measurement below fails.
   */
  const kaynak = readFileSync(new URL("../src/rateLimit.ts", import.meta.url), "utf8");
  const kes = kaynak.indexOf("export interface RateLimitConfig");
  assert.notEqual(
    kes,
    -1,
    "src/rateLimit.ts'in ilk export'u bulunamadı — gözcü SESSİZCE boşa düşmesin diye burada durur"
  );
  const baslik = kaynak.slice(0, kes);
  assert.ok(baslik.length > 200, "dosya başlığı beklenenden kısa — gözcü boş metne bakıp yeşil kalmasın");

  assert.match(
    baslik,
    /sliding[- ]window/i,
    "src/rateLimit.ts başlığı artık 'sliding window' demiyor; ARCHITECTURE.md hâlâ diyor — " +
      "ya kod kayan pencereyi bırakmış ya da cümle bayatlamış"
  );

  // The behaviour that sentence promises, measured rather than read.
  const c = clock();
  const rl = new RateLimiter({ perMinute: 4, perDay: 1_000_000 }, c.now);
  rl.check(1);
  c.advance(59_990);
  assert.equal(gecen(rl, 1, 20), 3, "tavan dolmalı");
  c.advance(10);
  assert.equal(
    gecen(rl, 1, 20),
    1,
    "başlık kayan pencere diyor ama sınırda tavan kadar hak birden açılıyor — pencere dönüyor"
  );
});
