// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 5 — src/rateLimit.ts regression watchers.
 *
 * WHAT THE AUDIT ACTUALLY SAID, AND WHAT MEASURING IT FOUND. The item filed against this
 * module was an escalation to src/http.ts (the "SLIDING WINDOWS…" block there kept
 * `{ start, count }` + `pencereTazele`, i.e. a tumbling window under a heading that says
 * SLIDING). Re-measured here on the shipped RateLimiter: the window in THIS file genuinely
 * slides — 120 tokens is the most that fits in the 100 ms straddling a minute turnover with
 * perMinute=120, and test/faz3RateLimit.test.ts already turns red if that regresses.
 *
 * What the same measurement DID find here is the opposite failure of the same counter: a
 * count that is not a usable number silenced the ceiling instead of tripping it. Every limit
 * in the module is a `>` comparison, and NaN loses every comparison, so `check(user, NaN)`
 * was ALLOWED, stored a hit worth NaN tokens, and left that user unlimited for the life of
 * the process — measured: a 3/minute, 5/day user then took 8 of 8 further calls and
 * `remaining()` reported `{ minute: null, day: null }`. The clamp that produced it
 * (`Math.max(1, Math.floor(adet))`) was also silently wrong in the small: 0 and -5 were
 * charged as 1, and 2.9 operations were charged as 2.
 *
 * These watchers hold the fixed contract: an impossible count or an impossible ceiling is
 * REFUSED loudly, a legitimate one still passes, and no instant may carry more tokens than
 * the configured allowance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/rateLimit.js";

/** Controlled clock: exercises window behaviour without depending on real time. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const DAKIKA_MS = 60_000;

test("kullanılamaz bir işlem adedi sayacı SESSİZCE devre dışı bırakamaz", () => {
  /**
   * The measured fail-open, in the shape it had: one NaN got in, and from then on the user
   * was outside the shared-quota guard entirely. The demand is twofold — the call is refused
   * loudly, AND nothing of it is kept, so the ceiling still bites right after.
   */
  const c = clock();
  const rl = new RateLimiter({ perMinute: 3, perDay: 5 }, c.now);

  assert.throws(
    () => rl.check(7, Number.NaN),
    /adet/,
    "NaN bir işlem adedi kabul edilirse tavan bir daha asla karşılaştırmayı kazanamaz"
  );
  assert.deepEqual(
    rl.remaining(7),
    { minute: 3, day: 5 },
    "reddedilen çağrıdan geriye jeton da kalmamalı, NaN'lı bir vuruş da"
  );

  // The part that made it permanent: after the poisoned hit, EVERY later call passed.
  assert.equal(rl.check(7).allowed, true);
  assert.equal(rl.check(7).allowed, true);
  assert.equal(rl.check(7).allowed, true);
  assert.equal(rl.check(7).allowed, false, "tavan 3/dk hâlâ uygulanmalı — sayaç sağ olmalı");
  assert.deepEqual(rl.remaining(7), { minute: 0, day: 2 });
});

test("sessiz kırpma yok: sıfır, negatif ve kesirli adet hata fırlatır", () => {
  /**
   * Each of these used to be corrected without a word, and each correction moved the count
   * away from what the caller asked for — 2.9 operations charged as 2 is an undercount on
   * the one counter whose job is to stop undercounting. The legitimate value next to them
   * must still pass: a guard that refuses a class instead of the impossible member of it is
   * just a different way of being wrong.
   */
  const c = clock();
  const rl = new RateLimiter({ perMinute: 10, perDay: 10 }, c.now);

  for (const kotu of [0, -5, 2.9, Infinity, -Infinity]) {
    assert.throws(
      () => rl.check(11, kotu),
      /adet/,
      `adet=${kotu} sessizce düzeltilmemeli, reddedilmeli`
    );
  }
  assert.deepEqual(rl.remaining(11), { minute: 10, day: 10 }, "hiçbiri sayacı harcamamalı");

  assert.equal(rl.check(11, 3).allowed, true, "geçerli bir toplu istek hâlâ geçmeli");
  assert.equal(rl.check(11).allowed, true, "varsayılan adet (1) hâlâ çalışmalı");
  assert.deepEqual(rl.remaining(11), { minute: 6, day: 6 });
});

test("kullanılamaz bir TAVAN ile limiter hiç kurulamaz", () => {
  /**
   * The same hole from the other end: a ceiling of NaN is not a loose ceiling, it is no
   * ceiling — every `>` against it is false, so the limiter would answer "allowed" forever
   * and nothing would ever say so. Refusing at construction is where that is cheapest.
   *
   * The bound matches config.ts::parseNumEnv (finite, > 0) on purpose, so a value that
   * survives the env reader cannot be rejected here — including a fractional one.
   */
  for (const kotu of [Number.NaN, Infinity, 0, -1]) {
    assert.throws(
      () => new RateLimiter({ perMinute: kotu, perDay: 100 }),
      /perMinute/,
      `perMinute=${kotu} ile kurulan bir limiter tavan uygulayamaz`
    );
    assert.throws(
      () => new RateLimiter({ perMinute: 100, perDay: kotu }),
      /perDay/,
      `perDay=${kotu} ile kurulan bir limiter kota uygulayamaz`
    );
  }

  // Legitimate values are NOT swept up with them.
  const c = clock();
  const kesirli = new RateLimiter({ perMinute: 2.5, perDay: 10 }, c.now);
  assert.equal(kesirli.check(1, 2).allowed, true, "kesirli ama geçerli bir tavan kabul edilmeli");
  assert.equal(kesirli.check(1).allowed, false, "2.5'lik tavan 3. jetonu geçirmemeli");
});

test("HİÇBİR 60 saniyede tavandan fazla jeton geçmez (kayan pencere, bağımsız muhasebe)", () => {
  /**
   * The module's central sentence, checked as a rolling property rather than at the two
   * instants a boundary test can look at: for every allowed call, the tokens spent in the
   * 60 s ending at that call must fit under perMinute. The accounting here is the test's
   * own, so a window that turns over — at the minute mark or on any smaller bucket — is
   * caught by arithmetic that never consults the implementation.
   *
   * The schedule mixes batch sizes and step lengths (0 ms included: same-instant calls share
   * one hit inside the limiter, and that merge must not lose tokens).
   */
  const c = clock();
  const TAVAN = 12;
  const rl = new RateLimiter({ perMinute: TAVAN, perDay: 1_000_000 }, c.now);

  const gecenler: { t: number; adet: number }[] = [];
  const adetler = [1, 3, 1, 2, 5, 1, 1, 4];
  const adimlar = [0, 7_000, 100, 25_000, 0, 12_000, 59_900, 200, 1, 30_000];

  let izin = 0;
  for (let i = 0; i < 400; i++) {
    const adet = adetler[i % adetler.length];
    if (rl.check(1, adet).allowed) {
      izin++;
      const simdi = c.now();
      gecenler.push({ t: simdi, adet });
      const pencerede = gecenler.reduce((n, v) => (simdi - v.t < DAKIKA_MS ? n + v.adet : n), 0);
      assert.ok(
        pencerede <= TAVAN,
        `t=${simdi}: son 60 s içinde ${pencerede} jeton geçti, ilan edilen tavan ${TAVAN}/dk — pencere kayıyor değil dönüyor`
      );
    }
    c.advance(adimlar[i % adimlar.length]);
  }

  assert.ok(izin > 40, `gözcü boşa dönmesin: yalnız ${izin} çağrı geçti, ölçecek bir şey kalmamış`);
});
