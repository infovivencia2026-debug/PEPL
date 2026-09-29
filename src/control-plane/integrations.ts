/**
 * Integrations hub: API keys, webhooks, connections.
 *
 * API key = a service user + a secret. The key is shown once; only its hash
 * is kept. Requests with it are ordinary authed requests as that user, so
 * permissions, scope, module gates and audit all apply and the key can be
 * revoked like a session.
 *
 * Webhooks subscribe to the closed audit vocabulary. A job walks new audit
 * rows past each webhook's cursor, queues one delivery per matching event,
 * and POSTs it with an HMAC-SHA256 signature (t=<unix>,v1=<hex>) over
 * `${t}.${body}`; a receiver verifies with its secret and ignores stale t.
 * Five attempts with backoff; twenty consecutive failures disable the hook.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { parseOutboundUrl, assertResolvesPublic } from '../net/outbound-url.ts'
import type { PoolClient } from 'pg'
import { encryptSecret, decryptSecret } from '../comms/index.ts'
import { ACTIONS } from '../audit/index.ts'

export class IntegrationError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'IntegrationError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
export const hashKey = (k: string): string => createHash('sha256').update(k).digest('hex')

// ── API keys ─────────────────────────────────────────────────────────────────

export interface ApiKey { id: string; user_id: string; name: string; prefix: string; role: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null; created_at: string }
const K_COLS = `k.id, k.user_id, k.name, k.prefix, (SELECT string_agg(role, ',') FROM user_roles r WHERE r.user_id = k.user_id) AS role, k.last_used_at::text, k.expires_at::text, k.revoked_at::text, k.created_at::text`

export async function createApiKey(tx: PoolClient, args: { name: string; role: string; expiresAt?: string | null; createdByUserId: string; allowedRoles: readonly string[] }): Promise<{ key: ApiKey; secret: string }> {
  const tid = await tenantId(tx)
  if (!args.name?.trim()) throw new IntegrationError('VALIDATION_FAILED', 'name is required')
  if (!args.allowedRoles.includes(args.role)) throw new IntegrationError('VALIDATION_FAILED', `role must be one of ${args.allowedRoles.join(', ')}`)
  if (['org_admin'].includes(args.role)) throw new IntegrationError('VALIDATION_FAILED', 'an API key cannot be an org admin; give it the narrowest role that works')
  const slug = args.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)
  const { rows: u } = await tx.query<{ id: string }>(
    `INSERT INTO app_users (tenant_id, email, full_name, status, is_service) VALUES ($1, $2, $3, 'active', true) RETURNING id`,
    [tid, `svc+${slug}-${randomBytes(3).toString('hex')}@${tid.slice(0, 8)}.pepl.local`, `API key: ${args.name.trim()}`])
  await tx.query(`INSERT INTO user_roles (tenant_id, user_id, role) VALUES ($1,$2,$3)`, [tid, u[0]!.id, args.role])
  const secret = `pk_${randomBytes(24).toString('base64url')}`
  const prefix = secret.slice(0, 12)
  const { rows } = await tx.query<{ id: string }>(`INSERT INTO api_keys (tenant_id, user_id, name, prefix, key_hash, expires_at, created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [tid, u[0]!.id, args.name.trim(), prefix, hashKey(secret), args.expiresAt ?? null, args.createdByUserId])
  const key = (await tx.query<ApiKey>(`SELECT ${K_COLS} FROM api_keys k WHERE k.id = $1`, [rows[0]!.id])).rows[0]!
  return { key, secret }
}
export async function listApiKeys(tx: PoolClient): Promise<ApiKey[]> {
  return (await tx.query<ApiKey>(`SELECT ${K_COLS} FROM api_keys k ORDER BY k.created_at DESC`)).rows
}
export async function revokeApiKey(tx: PoolClient, id: string): Promise<void> {
  const { rows } = await tx.query<{ user_id: string }>(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING user_id`, [id])
  if (!rows[0]) throw new IntegrationError('NOT_FOUND', 'no such active key')
  await tx.query(`UPDATE app_users SET status = 'disabled' WHERE id = $1 AND is_service`, [rows[0].user_id])
}
export async function touchApiKey(tx: PoolClient, id: string): Promise<void> { await tx.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [id]) }

// ── webhooks ─────────────────────────────────────────────────────────────────

export interface Webhook { id: string; name: string; url: string; events: string[]; status: string; last_audit_id: string; consecutive_failures: number; created_at: string }
const W_COLS = `id, name, url, events, status, last_audit_id::text, consecutive_failures, created_at::text`
const matches = (patterns: string[], action: string): boolean => patterns.some((p) => p === action || p === '*' || (p.endsWith('.*') && action.startsWith(p.slice(0, -1))))

export async function createWebhook(tx: PoolClient, args: { name: string; url: string; events: string[]; master: string | undefined; createdByUserId: string }): Promise<{ webhook: Webhook; secret: string }> {
  const tid = await tenantId(tx)
  if (!args.name?.trim()) throw new IntegrationError('VALIDATION_FAILED', 'name is required')
  // Not a regex: this URL comes from a CUSTOMER'S ADMIN and the server then
  // calls it. The old check allowed loopback outright and allowed https:// to
  // any address at all -- including 10.0.0.0/8 and 169.254.169.254 -- on a box
  // that hosts thirteen other applications.
  try {
    parseOutboundUrl(args.url)
  } catch (e) {
    throw new IntegrationError('VALIDATION_FAILED', (e as Error).message)
  }
  if (!Array.isArray(args.events) || !args.events.length) throw new IntegrationError('VALIDATION_FAILED', 'subscribe to at least one event')
  const known = Object.keys(ACTIONS)
  const bad = args.events.filter((e) => e !== '*' && !known.includes(e) && !(e.endsWith('.*') && known.some((k) => k.startsWith(e.slice(0, -1)))))
  if (bad.length) throw new IntegrationError('VALIDATION_FAILED', `unknown event(s): ${bad.join(', ')}`)
  if (!args.master) throw new IntegrationError('MAIL_KEY_MISSING', 'this server cannot store secrets (PEPL_MAIL_KEY is not set)')
  const secret = `whsec_${randomBytes(24).toString('base64url')}`
  // start the cursor at the newest audit row: a new hook does not replay history
  const { rows: cur } = await tx.query<{ m: string }>(`SELECT coalesce(max(id), 0)::text AS m FROM audit_events`)
  const { rows } = await tx.query<{ id: string }>(`INSERT INTO webhooks (tenant_id, name, url, secret_ciphertext, events, last_audit_id, created_by_user_id) VALUES ($1,$2,$3,$4,$5::text[],$6,$7) RETURNING id`,
    [tid, args.name.trim(), args.url, encryptSecret(secret, tid, args.master), args.events, cur[0]!.m, args.createdByUserId])
  return { webhook: (await tx.query<Webhook>(`SELECT ${W_COLS} FROM webhooks WHERE id = $1`, [rows[0]!.id])).rows[0]!, secret }
}
export async function listWebhooks(tx: PoolClient): Promise<Webhook[]> { return (await tx.query<Webhook>(`SELECT ${W_COLS} FROM webhooks ORDER BY created_at DESC`)).rows }
export async function setWebhookStatus(tx: PoolClient, id: string, status: 'active' | 'paused' | 'disabled'): Promise<void> {
  const r = await tx.query(`UPDATE webhooks SET status = $2, consecutive_failures = CASE WHEN $2 = 'active' THEN 0 ELSE consecutive_failures END WHERE id = $1`, [id, status])
  if (!r.rowCount) throw new IntegrationError('NOT_FOUND', 'no such webhook')
}
export async function recentDeliveries(tx: PoolClient, webhookId: string, limit = 50): Promise<Array<{ id: string; event_type: string; status: string; attempts: number; response_status: number | null; last_error: string | null; created_at: string; delivered_at: string | null }>> {
  return (await tx.query(`SELECT id, event_type, status, attempts, response_status, last_error, created_at::text, delivered_at::text FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT $2`, [webhookId, limit])).rows
}

export function sign(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
}
/** For receivers (and our test): verify a signature header within a tolerance window. */
export function verifySignature(secret: string, body: string, header: string, toleranceSeconds = 300, now = Math.floor(Date.now() / 1000)): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '')
  if (!m) return false
  const t = Number(m[1])
  if (Math.abs(now - t) > toleranceSeconds) return false
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]!))
}

/** Queue deliveries for audit rows newer than each active webhook's cursor. */
export async function enqueueWebhookEvents(tx: PoolClient): Promise<number> {
  const tid = await tenantId(tx)
  const hooks = (await tx.query<Webhook>(`SELECT ${W_COLS} FROM webhooks WHERE status = 'active'`)).rows
  let queued = 0
  for (const h of hooks) {
    const { rows } = await tx.query<{ id: string; action: string; occurred_at: string; entity_type: string | null; entity_id: string | null; subject_employee_id: string | null; actor_user_id: string | null; metadata: unknown }>(
      `SELECT id::text, action, occurred_at::text, entity_type, entity_id::text, subject_employee_id::text, actor_user_id::text, metadata FROM audit_events WHERE id > $1 ORDER BY id LIMIT 500`, [h.last_audit_id])
    if (!rows.length) continue
    for (const e of rows) {
      if (!matches(h.events, e.action)) continue
      const payload = { id: e.id, type: e.action, occurredAt: e.occurred_at, entityType: e.entity_type, entityId: e.entity_id, subjectEmployeeId: e.subject_employee_id, actorUserId: e.actor_user_id, metadata: e.metadata ?? {} }
      await tx.query(`INSERT INTO webhook_deliveries (tenant_id, webhook_id, audit_id, event_type, payload) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`, [tid, h.id, e.id, e.action, JSON.stringify(payload)])
      queued++
    }
    await tx.query(`UPDATE webhooks SET last_audit_id = $2 WHERE id = $1`, [h.id, rows[rows.length - 1]!.id])
  }
  return queued
}

export type Poster = (url: string, body: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number; error?: string }>
export const httpPoster: Poster = async (url, body, headers) => {
  // Re-checked HERE as well as on save: what a hostname resolves to is not
  // fixed, and a customer who owns the name can repoint it after we accepted
  // it. This is the check that actually protects the network.
  try {
    await assertResolvesPublic(parseOutboundUrl(url))
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message }
  }
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, signal: AbortSignal.timeout(10_000) })
    return { ok: r.ok, status: r.status, error: r.ok ? undefined : (await r.text()).slice(0, 300) }
  } catch (e) { return { ok: false, status: 0, error: (e as Error).message.slice(0, 300) } }
}
const BACKOFF_MINUTES = [1, 5, 30, 120, 720]
export const MAX_DELIVERY_ATTEMPTS = BACKOFF_MINUTES.length

/** Deliver due rows; backoff on failure; disable a hook after 20 consecutive failures. */
export async function deliverWebhooks(tx: PoolClient, args: { master: string | undefined; post?: Poster; now?: Date; limit?: number }): Promise<{ delivered: number; failed: number }> {
  const tid = await tenantId(tx)
  const now = args.now ?? new Date()
  const post = args.post ?? httpPoster
  const { rows } = await tx.query<{ id: string; webhook_id: string; url: string; secret_ciphertext: Buffer; payload: unknown; attempts: number; status: string }>(
    `SELECT d.id, d.webhook_id, w.url, w.secret_ciphertext, d.payload, d.attempts, w.status FROM webhook_deliveries d JOIN webhooks w ON (w.tenant_id, w.id) = (d.tenant_id, d.webhook_id)
      WHERE d.status = 'pending' AND d.next_attempt_at <= $1 AND w.status = 'active' ORDER BY d.created_at LIMIT $2`, [now.toISOString(), args.limit ?? 100])
  let delivered = 0, failed = 0
  for (const d of rows) {
    let secret: string
    try { if (!args.master) throw new Error('no key'); secret = decryptSecret(d.secret_ciphertext, tid, args.master) } catch { continue }   // unreadable secret: leave it pending, say nothing
    const body = JSON.stringify(d.payload)
    const r = await post(d.url, body, { 'x-pepl-signature': sign(secret, body, Math.floor(now.getTime() / 1000)), 'x-pepl-event': (d.payload as { type: string }).type, 'x-pepl-delivery': d.id })
    if (r.ok) {
      await tx.query(`UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, response_status = $2, delivered_at = $3 WHERE id = $1`, [d.id, r.status, now.toISOString()])
      await tx.query(`UPDATE webhooks SET consecutive_failures = 0 WHERE id = $1`, [d.webhook_id])
      delivered++
    } else {
      const attempts = d.attempts + 1
      const done = attempts >= MAX_DELIVERY_ATTEMPTS
      const next = new Date(now.getTime() + (BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)] ?? 720) * 60_000)
      await tx.query(`UPDATE webhook_deliveries SET status = $2, attempts = $3, next_attempt_at = $4, response_status = $5, last_error = $6 WHERE id = $1`,
        [d.id, done ? 'failed' : 'pending', attempts, next.toISOString(), r.status || null, (r.error ?? '').slice(0, 300)])
      await tx.query(`UPDATE webhooks SET consecutive_failures = consecutive_failures + 1, status = CASE WHEN consecutive_failures + 1 >= 20 THEN 'disabled' ELSE status END WHERE id = $1`, [d.webhook_id])
      failed++
    }
  }
  return { delivered, failed }
}

// ── connections ──────────────────────────────────────────────────────────────

export interface Connection { id: string; kind: string; name: string; config: Record<string, unknown>; status: string; has_secret: boolean; last_checked_at: string | null; last_error: string | null }
const C_COLS = `id, kind, name, config, status, secret_ciphertext IS NOT NULL AS has_secret, last_checked_at::text, last_error`
export const CONNECTION_KINDS = ['tally', 'zoho_books', 'razorpayx', 'google', 'microsoft', 'sms', 'biometric', 'esign', 'slack', 'teams', 'custom'] as const

export async function upsertConnection(tx: PoolClient, args: { kind: string; name: string; config?: Record<string, unknown>; secret?: string | null; master: string | undefined }): Promise<Connection> {
  const tid = await tenantId(tx)
  if (!(CONNECTION_KINDS as readonly string[]).includes(args.kind)) throw new IntegrationError('VALIDATION_FAILED', `kind is one of ${CONNECTION_KINDS.join(', ')}`)
  if (!args.name?.trim()) throw new IntegrationError('VALIDATION_FAILED', 'name is required')
  if (args.secret && !args.master) throw new IntegrationError('MAIL_KEY_MISSING', 'this server cannot store secrets (PEPL_MAIL_KEY is not set)')
  const cipher = args.secret && args.master ? encryptSecret(args.secret, tid, args.master) : null
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO integration_connections (tenant_id, kind, name, config, secret_ciphertext) VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT (tenant_id, kind, name) DO UPDATE SET config = EXCLUDED.config, secret_ciphertext = coalesce(EXCLUDED.secret_ciphertext, integration_connections.secret_ciphertext), status = 'active', last_error = NULL RETURNING id`,
    [tid, args.kind, args.name.trim(), JSON.stringify(args.config ?? {}), cipher])
  return (await tx.query<Connection>(`SELECT ${C_COLS} FROM integration_connections WHERE id = $1`, [rows[0]!.id])).rows[0]!
}
export async function listConnections(tx: PoolClient): Promise<Connection[]> { return (await tx.query<Connection>(`SELECT ${C_COLS} FROM integration_connections ORDER BY kind, name`)).rows }
export async function removeConnection(tx: PoolClient, id: string): Promise<void> {
  const r = await tx.query(`DELETE FROM integration_connections WHERE id = $1`, [id])
  if (!r.rowCount) throw new IntegrationError('NOT_FOUND', 'no such connection')
}
/** Adapters read their secret through this so the master key never leaves one place. */
export async function connectionSecret(tx: PoolClient, id: string, master: string | undefined): Promise<string | null> {
  const tid = await tenantId(tx)
  const r = (await tx.query<{ secret_ciphertext: Buffer | null }>(`SELECT secret_ciphertext FROM integration_connections WHERE id = $1 AND status = 'active'`, [id])).rows[0]
  if (!r?.secret_ciphertext || !master) return null
  try { return decryptSecret(r.secret_ciphertext, tid, master) } catch { return null }
}
