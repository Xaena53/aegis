// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-user sliding-window rate limiter.
 *
 * All hosted users share one Google developer token, and the daily operation quota is
 * enforced per token rather than per account. Without this limiter a single heavy user
 * can exhaust the quota for everyone.
 */
/**
 * Kullanıcı başına kayan pencere sayacı.
 *
 * Neden gerekli: hosted modda TÜM kullanıcılar TEK developer token'ı paylaşır.
 * Google'ın günlük işlem kotası (Basic Access'te 15.000) hesap başına değil
 * TOKEN başına uygulanır — tek bir aşırı kullanıcı diğer herkesin servisini
 * durdurabilir. Bu sınırlayıcı o paylaşılan kaynağı korur.
 *
 * Bellekte tutulur: süreç yeniden başlarsa sayaçlar sıfırlanır. Tek sunuculu
 * dağıtım için yeterli; yatay ölçeklemede Redis'e taşınmalı.
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

  /** Pencereyi tazeler ve mevcut sayımı döner (artırmaz). */
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
   * Sınır kontrolü. Reddedilen istek sayaçları ARTIRMAZ — aksi halde sınırı
   * aşan bir istemci kendi cezasını sürekli uzatırdı.
   */
  check(userId: number): RateLimitResult {
    const t = this.now();
    const m = this.peek(this.minute, userId, MINUTE_MS);
    if (m.count >= this.cfg.perMinute) {
      return {
        allowed: false,
        reason: `Dakikalık istek sınırı aşıldı (${this.cfg.perMinute}/dk).`,
        retryAfterSec: Math.max(1, Math.ceil((m.start + MINUTE_MS - t) / 1000)),
      };
    }
    const d = this.peek(this.day, userId, DAY_MS);
    if (d.count >= this.cfg.perDay) {
      return {
        allowed: false,
        reason: `Günlük istek kotası doldu (${this.cfg.perDay}/gün). Paylaşılan Google Ads API kotasını korumak için uygulanır.`,
        retryAfterSec: Math.max(1, Math.ceil((d.start + DAY_MS - t) / 1000)),
      };
    }
    m.count++;
    d.count++;
    return { allowed: true };
  }

  /** Süresi geçmiş pencereleri atar (bellek sızıntısı koruması). */
  sweep(): void {
    const t = this.now();
    for (const [id, w] of this.minute) if (t - w.start >= MINUTE_MS) this.minute.delete(id);
    for (const [id, w] of this.day) if (t - w.start >= DAY_MS) this.day.delete(id);
  }

  /** Tanılama: kullanıcının kalan hakkı. */
  remaining(userId: number): { minute: number; day: number } {
    return {
      minute: Math.max(0, this.cfg.perMinute - this.peek(this.minute, userId, MINUTE_MS).count),
      day: Math.max(0, this.cfg.perDay - this.peek(this.day, userId, DAY_MS).count),
    };
  }
}
