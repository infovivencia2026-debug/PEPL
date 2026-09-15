/**
 * The rate limiter for more than one API instance.
 *
 * Same contract as the in-process one — `check(key)` → a verdict — backed by
 * one UPSERT on an UNLOGGED table, so every instance sees the same count. It
 * costs a round-trip per request, which is why it is opt-in
 * (`PEPL_RATE_LIMIT_STORE=postgres`): one instance does not need it.
 *
 * Fails OPEN. If the counter table is unreachable the request proceeds and the
 * failure is counted; the database being down is a bigger problem than a
 * missed 429, and the request is about to find out anyway.
 */
import { appPool } from '../db/pool.ts'
import type { Limit, Verdict } from './rate-limit.ts'

export class PgRateLimiter {
  private readonly limit: Limit
  /** Test seam: a pool other than the app's. */
  private readonly pool: { query: typeof appPool.query }
  failures = 0

  constructor(limit: Limit, pool: { query: typeof appPool.query } = appPool) {
    this.limit = limit
    this.pool = pool
  }

  async check(key: string, now = Date.now()): Promise<Verdict> {
    const at = new Date(now)
    try {
      const { rows } = await this.pool.query<{ count: number; window_start: string }>(
        `INSERT INTO rate_limit_buckets (key, window_start, count) VALUES ($1, $2, 1)
         ON CONFLICT (key) DO UPDATE
           SET count = CASE WHEN rate_limit_buckets.window_start <= $2::timestamptz - ($3 || ' milliseconds')::interval
                            THEN 1 ELSE rate_limit_buckets.count + 1 END,
               window_start = CASE WHEN rate_limit_buckets.window_start <= $2::timestamptz - ($3 || ' milliseconds')::interval
                                   THEN $2::timestamptz ELSE rate_limit_buckets.window_start END
         RETURNING count, window_start::text`,
        [key, at.toISOString(), String(this.limit.windowMs)],
      )
      const r = rows[0]!
      const resetAt = new Date(r.window_start).getTime() + this.limit.windowMs
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000))
      if (r.count > this.limit.max) return { allowed: false, retryAfterSeconds, remaining: 0 }
      return { allowed: true, retryAfterSeconds, remaining: this.limit.max - r.count }
    } catch {
      this.failures++
      return { allowed: true, retryAfterSeconds: 1, remaining: this.limit.max }
    }
  }

  /** Rows whose window ended more than a window ago. Called by the retention job. */
  static async sweep(pool: { query: typeof appPool.query } = appPool, olderThanMs = 3_600_000): Promise<number> {
    const r = await pool.query(
      `DELETE FROM rate_limit_buckets WHERE window_start < now() - ($1 || ' milliseconds')::interval`,
      [String(olderThanMs)])
    return r.rowCount ?? 0
  }
}
