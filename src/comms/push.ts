/**
 * Push subscriptions and the delivery pass.
 *
 * Same shape as email delivery: a notification row is the fact, `pushed_at`
 * is whether it reached a device. A notification the person has already read
 * is skipped — pushing what they have seen is how people turn notifications
 * off for good.
 */
import type { PoolClient } from 'pg'
import { tenantId } from './base.ts'
import { sendWebPush, WebPushError, type PushSubscription, type VapidKeys } from './web-push.ts'

export class PushError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'PushError'
  }
}

/** A subscription dead this many times in a row is dropped even without a 410. */
export const MAX_PUSH_FAILURES = 5

export interface SubscriptionRow {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
  user_agent: string | null
  created_at: string
  last_used_at: string | null
}

const COLUMNS = 'id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_used_at'

export async function saveSubscription(
  tx: PoolClient,
  args: { userId: string; endpoint: string; p256dh: string; auth: string; userAgent?: string | null },
): Promise<SubscriptionRow> {
  const tid = await tenantId(tx)
  let url: URL
  try { url = new URL(args.endpoint) } catch { throw new PushError('VALIDATION_FAILED', 'endpoint must be a URL') }
  // Every real push service is https. Plain http is allowed for loopback only,
  // so a local fake can stand in during tests without weakening production.
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new PushError('VALIDATION_FAILED', 'endpoint must be https')
  }
  if (Buffer.from(args.p256dh, 'base64url').length !== 65 || Buffer.from(args.auth, 'base64url').length !== 16) {
    throw new PushError('VALIDATION_FAILED', 'keys.p256dh must decode to 65 bytes and keys.auth to 16')
  }
  const { rows } = await tx.query<SubscriptionRow>(
    `INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent, failures = 0
     RETURNING ${COLUMNS}`,
    [tid, args.userId, args.endpoint, args.p256dh, args.auth, args.userAgent?.slice(0, 300) ?? null],
  )
  return rows[0]!
}

/** Only the owner can remove their own device. */
export async function removeSubscription(tx: PoolClient, userId: string, endpoint: string): Promise<boolean> {
  const r = await tx.query(
    `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [userId, endpoint])
  return (r.rowCount ?? 0) > 0
}

export async function listSubscriptions(tx: PoolClient, userId: string): Promise<SubscriptionRow[]> {
  const { rows } = await tx.query<SubscriptionRow>(
    `SELECT ${COLUMNS} FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at`, [userId])
  return rows
}

interface Pending {
  id: string
  user_id: string
  event_type: string
  title: string
  body: string | null
  entity_type: string | null
  entity_id: string | null
}

export interface PushPassResult {
  notifications: number
  sent: number
  dropped: number
  errors: string[]
}

/**
 * One delivery pass for a tenant.
 *
 * A notification is marked pushed once ANY of the person's devices accepted
 * it; a dead device (404/410, or too many failures) is deleted on the spot.
 * A notification for a person with no devices is marked pushed too, so the
 * queue does not grow forever with rows nobody can receive.
 */
export async function deliverPush(
  tx: PoolClient,
  keys: VapidKeys,
  opts: { limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<PushPassResult> {
  const result: PushPassResult = { notifications: 0, sent: 0, dropped: 0, errors: [] }
  const { rows: pending } = await tx.query<Pending>(
    `SELECT n.id::text, n.user_id, n.event_type, n.title, n.body, n.entity_type, n.entity_id::text
       FROM notifications n
       JOIN app_users u ON (u.tenant_id, u.id) = (n.tenant_id, n.user_id)
      WHERE n.pushed_at IS NULL AND n.read_at IS NULL AND u.status = 'active'
      ORDER BY n.created_at
      LIMIT $1`,
    [opts.limit ?? 200])

  for (const n of pending) {
    result.notifications++
    const { rows: devices } = await tx.query<SubscriptionRow & { failures: number }>(
      `SELECT ${COLUMNS}, failures FROM push_subscriptions WHERE user_id = $1`, [n.user_id])

    let delivered = 0
    for (const d of devices) {
      const sub: PushSubscription = { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }
      try {
        const r = await sendWebPush(sub, {
          id: n.id, type: n.event_type, title: n.title, body: n.body,
          entityType: n.entity_type, entityId: n.entity_id,
        }, keys, { fetchImpl: opts.fetchImpl, ttlSeconds: 24 * 3600 })
        if (r.gone) {
          await tx.query(`DELETE FROM push_subscriptions WHERE id = $1`, [d.id])
          result.dropped++
          continue
        }
        delivered++
        await tx.query(`UPDATE push_subscriptions SET last_used_at = now(), failures = 0 WHERE id = $1`, [d.id])
      } catch (err) {
        const e = err as WebPushError
        result.errors.push(`${d.endpoint.slice(0, 60)}: ${e.message}`)
        if (d.failures + 1 >= MAX_PUSH_FAILURES) {
          await tx.query(`DELETE FROM push_subscriptions WHERE id = $1`, [d.id])
          result.dropped++
        } else {
          await tx.query(`UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1`, [d.id])
        }
      }
    }

    // Delivered, or nowhere to deliver: either way this row is done. A device
    // that failed transiently gets the NEXT notification; replaying this one
    // later would arrive stale.
    if (delivered > 0 || devices.length === 0) {
      await tx.query(`UPDATE notifications SET pushed_at = now() WHERE id = $1`, [n.id])
      if (delivered > 0) result.sent++
    }
  }
  return result
}
