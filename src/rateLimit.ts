// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-user sliding-window rate limiter.
 *
 * All hosted users share one Google developer token, and the daily operation quota is
 * enforced per token rather than per account (15,000/day on Basic Access). Without this
 * limiter a single heavy user can exhaust the quota for everyone else.
 *
 * Counters live in process memory and reset on restart, which is sufficient for a
 * single-instance deployment. Scaling horizontally requires moving them to shared
 * storage such as Redis.
 */
export interface RateLimitConfig {
  perMinute: number;
  perDay: number;
}

interface Window {
  start: number;
  count: number;
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfterSec?: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

export class RateLimiter {
  private minute = new Map<number, Window>();
  private day = new Map<number, Window>();

  constructor(
    private cfg: RateLimitConfig,
    private now: () => number = Date.now
  ) {}

  /** Refreshes the window and returns the current count (does not increment it). */
  private peek(map: Map<number, Window>, userId: number, spanMs: number): Window {
    const t = this.now();
    let w = map.get(userId);
    if (!w || t - w.start >= spanMs) {
      w = { start: t, count: 0 };
      map.set(userId, w);
    }
    return w;
  }

  /**
   * Limit check. A rejected request does NOT increment the counters — otherwise a
   * client over the limit would keep extending its own penalty.
   *
   * @param adet Bu çağrının kaç JETON düşeceği — yani kaç İŞLEM yapacağı.
   *
   * SAYILAN ŞEY HTTP İSTEĞİ DEĞİL, İŞLEMDİR. Sayaç istek başına bir kez arttığı sürece
   * tek bir POST'a konan N elemanlı bir JSON-RPC dizisi N araç çağrısını tek jetona
   * satın alıyordu: paylaşılan Google/Meta kotası, operatörün CAMARA kotası ve bu
   * sürecin kendisi, limitin hiç görmediği bir çarpanla tüketilebiliyordu. Ölçüt bu
   * yüzden "kaç istek geldi" değil "kaç işlem yapılacak" olmalıdır.
   *
   * Tavanı tek başına aşan bir toplu istek de reddedilir (kısmen koşup yarıda kesmek
   * yerine): yarısı uygulanmış bir toplu harcama isteği, hiç uygulanmamış olandan çok
   * daha zor geri alınır.
   */
  check(userId: number, adet = 1): RateLimitResult {
    const t = this.now();
    const istenen = Math.max(1, Math.floor(adet));
    const m = this.peek(this.minute, userId, MINUTE_MS);
    if (m.count + istenen > this.cfg.perMinute) {
      return {
        allowed: false,
        reason: `Dakikalık istek sınırı aşıldı (${this.cfg.perMinute}/dk; bu istek ${istenen} işlem içeriyor).`,
        retryAfterSec: Math.max(1, Math.ceil((m.start + MINUTE_MS - t) / 1000)),
      };
    }
    const d = this.peek(this.day, userId, DAY_MS);
    if (d.count + istenen > this.cfg.perDay) {
      return {
        allowed: false,
        reason: `Günlük istek kotası doldu (${this.cfg.perDay}/gün). Paylaşılan Google Ads API kotasını korumak için uygulanır.`,
        retryAfterSec: Math.max(1, Math.ceil((d.start + DAY_MS - t) / 1000)),
      };
    }
    m.count += istenen;
    d.count += istenen;
    return { allowed: true };
  }

  /** Drops expired windows (memory-leak guard). */
  sweep(): void {
    const t = this.now();
    for (const [id, w] of this.minute) if (t - w.start >= MINUTE_MS) this.minute.delete(id);
    for (const [id, w] of this.day) if (t - w.start >= DAY_MS) this.day.delete(id);
  }

  /** Diagnostics: the user's remaining allowance. */
  remaining(userId: number): { minute: number; day: number } {
    return {
      minute: Math.max(0, this.cfg.perMinute - this.peek(this.minute, userId, MINUTE_MS).count),
      day: Math.max(0, this.cfg.perDay - this.peek(this.day, userId, DAY_MS).count),
    };
  }
}
