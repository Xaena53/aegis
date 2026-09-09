// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-user sliding-window rate limiter.
 *
 * All hosted users share one Google developer token, and the daily operation quota is
 * enforced per token rather than per account (15,000/day on Basic Access). Without this
 * limiter a single heavy user can exhaust the quota for everyone else.
 *
 * THE WINDOW SLIDES; IT IS NOT CLEARED WHOLESALE. Measured on the earlier form, which
 * pinned a window to its first request and zeroed the counter when the span elapsed: with
 * perMinute=120 a caller spent 120 operations 100 ms before the turnover and 120 more the
 * instant it happened — 240 operations inside a 100 ms span, twice the published ceiling,
 * and the same doubling at the day boundary. A ceiling that doubles by waiting for the
 * clock is not the ceiling this module claims to hold, and that burst is exactly the shape
 * the shared quota cannot absorb: the upstream RESOURCE_EXHAUSTED lands on every OTHER
 * tenant. So the individual hits are what is kept, and a hit stays charged until it is
 * genuinely `spanMs` old — no instant may carry more than the configured allowance.
 *
 * Counters live in process memory and reset on restart, which is sufficient for a
 * single-instance deployment. Scaling horizontally requires moving them to shared
 * storage such as Redis.
 *
 * The hit list needs no cap of its own: an entry is appended only when a call is ALLOWED,
 * every entry carries at least one token, hits are dropped once they leave the widest
 * window, and the tokens inside that window can never exceed `perDay`.
 */
export interface RateLimitConfig {
  perMinute: number;
  perDay: number;
}

/** One allowed call: when it happened, and how many tokens it spent. */
interface Vurus {
  t: number;
  adet: number;
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfterSec?: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

export class RateLimiter {
  private vuruslar = new Map<number, Vurus[]>();

  constructor(
    private cfg: RateLimitConfig,
    private now: () => number = Date.now
  ) {}

  /**
   * The user's hits that are still inside the widest window, pruned in place. Returns a
   * detached empty list for an unknown user rather than creating one: only an allowed call
   * may put a user in the map.
   *
   * A clock that jumps BACKWARDS keeps hits instead of expiring them — the wrong direction
   * for the caller, the right one for the ceiling.
   */
  private canli(userId: number, t: number): Vurus[] {
    const liste = this.vuruslar.get(userId);
    if (!liste) return [];
    let i = 0;
    while (i < liste.length && t - liste[i].t >= DAY_MS) i++;
    if (i > 0) liste.splice(0, i);
    return liste;
  }

  /** Tokens spent inside the last `spanMs`. */
  private sayim(liste: readonly Vurus[], t: number, spanMs: number): number {
    let n = 0;
    for (const v of liste) if (t - v.t < spanMs) n += v.adet;
    return n;
  }

  /**
   * Seconds until enough tokens age out of `spanMs` for `dusulecek` more to fit. Hits leave
   * oldest first, so the deadline is the moment the oldest hit that frees enough turns
   * `spanMs` old — waiting exactly this long really does let the same call through.
   *
   * A batch bigger than the whole allowance can never fit; it is told to wait a full window
   * rather than handed a deadline that would not hold.
   */
  private bekleme(liste: readonly Vurus[], t: number, spanMs: number, dusulecek: number): number {
    let serbest = 0;
    for (const v of liste) {
      if (t - v.t >= spanMs) continue;
      serbest += v.adet;
      if (serbest >= dusulecek) return Math.max(1, Math.ceil((v.t + spanMs - t) / 1000));
    }
    return Math.max(1, Math.ceil(spanMs / 1000));
  }

  /**
   * Limit check. A rejected request does NOT increment the counters — otherwise a
   * client over the limit would keep extending its own penalty.
   *
   * @param adet How many TOKENS this call spends — that is, how many OPERATIONS it performs.
   *
   * WHAT IS COUNTED IS THE OPERATION, NOT THE HTTP REQUEST. While the counter rose once
   * per request, a JSON-RPC array of N elements in a single POST bought N tool calls for
   * one token: the shared Google/Meta quota, the operator's CAMARA quota and this process
   * itself could all be drained by a multiplier the limit never saw. The measure has to be
   * "how many operations will run", not "how many requests arrived".
   *
   * A batch that exceeds the ceiling on its own is refused outright rather than run part
   * way and cut off: a half-applied batch of spending changes is far harder to undo than
   * one that never ran.
   */
  check(userId: number, adet = 1): RateLimitResult {
    const t = this.now();
    const istenen = Math.max(1, Math.floor(adet));
    const liste = this.canli(userId, t);

    const dakika = this.sayim(liste, t, MINUTE_MS);
    if (dakika + istenen > this.cfg.perMinute) {
      return {
        allowed: false,
        reason: `Dakikalık istek sınırı aşıldı (${this.cfg.perMinute}/dk; bu istek ${istenen} işlem içeriyor).`,
        retryAfterSec: this.bekleme(liste, t, MINUTE_MS, dakika + istenen - this.cfg.perMinute),
      };
    }
    const gun = this.sayim(liste, t, DAY_MS);
    if (gun + istenen > this.cfg.perDay) {
      return {
        allowed: false,
        reason: `Günlük istek kotası doldu (${this.cfg.perDay}/gün). Paylaşılan Google Ads API kotasını korumak için uygulanır.`,
        retryAfterSec: this.bekleme(liste, t, DAY_MS, gun + istenen - this.cfg.perDay),
      };
    }
    // Calls landing on the same instant share one entry, so a burst cannot grow the list
    // faster than the clock ticks.
    const son = liste[liste.length - 1];
    if (son !== undefined && son.t === t) son.adet += istenen;
    else {
      liste.push({ t, adet: istenen });
      this.vuruslar.set(userId, liste);
    }
    return { allowed: true };
  }

  /** Drops expired hits, and users left with none (memory-leak guard). */
  sweep(): void {
    const t = this.now();
    for (const [id, liste] of this.vuruslar) {
      let i = 0;
      while (i < liste.length && t - liste[i].t >= DAY_MS) i++;
      if (i > 0) liste.splice(0, i);
      if (liste.length === 0) this.vuruslar.delete(id);
    }
  }

  /** Diagnostics: the user's remaining allowance. */
  remaining(userId: number): { minute: number; day: number } {
    const t = this.now();
    const liste = this.canli(userId, t);
    return {
      minute: Math.max(0, this.cfg.perMinute - this.sayim(liste, t, MINUTE_MS)),
      day: Math.max(0, this.cfg.perDay - this.sayim(liste, t, DAY_MS)),
    };
  }
}
