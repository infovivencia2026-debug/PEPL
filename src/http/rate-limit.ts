/**
 * Request rate limiting.
 *
 * Two limits, because they defend against two different things:
 *
 *   - **per IP, on public routes** — login above all. The per-email lockout
 *     stops a brute force against one account and does nothing against a
 *     password spray: one IP, one common password, five hundred addresses.
 *   - **per session, on everything else** — a leaked token or a runaway client
 *     should degrade to 429s, not take the database with it.
 *
 * In-process, like the event bus, for the same reason: one Node process serves
 * this today and a Redis counter is infrastructure to run before anything needs
 * it. The interface — `check(key)` → allowed or not, plus a retry hint — is all
 * a distributed version would have to reimplement.
 *
 * Fixed windows rather than a sliding log. A fixed window lets exactly 2x the
 * limit through across a boundary in the worst case, which for these numbers
 * is fine and buys a Map<string, number> instead of an array per key.
 */

import { createHash } from 'node:crypto'

export interface Limit {
  /** Requests allowed per window. */
  max: number
  /** Window length. */
  windowMs: number
}

export interface Verdict {
  allowed: boolean
  /** Seconds until the window resets — what Retry-After should say. */
  retryAfterSeconds: number
  remaining: number
}

interface Bucket {
  count: number
  resetAt: number
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly limit: Limit
  /** Set on the first call, so the limiter never reads the clock itself. */
  private sweepAt: number | null = null

  /**
   * `maxKeys` bounds memory. Every distinct key holds a bucket for a full window,
   * and a stream of junk bearer tokens makes a new key each time, so without a cap
   * the map grows for as long as the flood lasts.
   */
  private readonly maxKeys: number

  constructor(limit: Limit, maxKeys = 100_000) {
    this.limit = limit
    this.maxKeys = maxKeys
  }

  check(key: string, now = Date.now()): Verdict {
    this.sweep(now)

    let bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      if (this.buckets.size >= this.maxKeys) this.makeRoom(now)
      bucket = { count: 0, resetAt: now + this.limit.windowMs }
      this.buckets.set(key, bucket)
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    if (bucket.count >= this.limit.max) {
      return { allowed: false, retryAfterSeconds, remaining: 0 }
    }
    bucket.count++
    return { allowed: true, retryAfterSeconds, remaining: this.limit.max - bucket.count }
  }

  /**
   * Drops expired buckets once per window rather than on every call, so memory
   * is bounded by distinct keys seen in a window, not keys seen ever.
   */
  private sweep(now: number): void {
    if (this.sweepAt === null) {
      this.sweepAt = now + this.limit.windowMs
      return
    }
    if (now < this.sweepAt) return
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
    this.sweepAt = now + this.limit.windowMs
  }

  /**
   * At the cap: drop what has expired, and if that is not enough drop the OLDEST
   * key. Under a flood the oldest bucket is the likeliest to be junk that has
   * already had its say, and the alternative to losing it is running out of memory.
   */
  private makeRoom(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value
      if (oldest === undefined) break
      this.buckets.delete(oldest)
    }
  }

  /** Test seam. */
  reset(): void {
    this.buckets.clear()
  }

  size(): number {
    return this.buckets.size
  }
}

/**
 * Defaults, deliberately generous.
 *
 * A limiter that a real user can hit by working quickly is a bug that presents
 * as an outage. These stop abuse; they do not ration ordinary use.
 */
// 120/min per IP, not 30: an office of two hundred behind one NAT address at
// nine in the morning is legitimately dozens of logins a minute, and a limiter
// a real user can hit presents as an outage. A spray is thousands, and the
// per-email lockout in auth/ covers the account side of that.
export const PUBLIC_LIMIT: Limit = { max: 120, windowMs: 60_000 }
export const SESSION_LIMIT: Limit = { max: 600, windowMs: 60_000 }    // 10 req/s sustained

/** A stable key for a bearer token that never puts the token itself in a Map. */
export function sessionKey(token: string): string {
  // 128 bits of SHA-256, not a 32-bit hash. FNV-1a into 32 bits collides once tens
  // of thousands of sessions are live: two people then share one allowance and
  // one spends the other's. This is a bucket key, not a secret, but a collision
  // is a real bug all the same.
  return `s:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`
}
