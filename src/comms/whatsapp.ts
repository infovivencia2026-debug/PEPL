/**
 * WhatsApp as a notification channel.
 *
 * Half the workforce PEPL is for will never install an app; WhatsApp is the
 * phone they already have. This is deliberately a CHANNEL, not a product: a
 * notification row with 'whatsapp' in its channels is delivered to a person
 * who opted in, through the provider the company configured, by a job that
 * retries like email does. Two adapters: Meta Cloud API (approved templates,
 * bearer token) and a generic webhook (any BSP or an internal relay).
 *
 * Nothing is sent without the person's opt-in and the company's provider.
 */
import type { PoolClient } from 'pg'
import { encryptSecret, decryptSecret } from './index.ts'

export class WhatsAppError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'WhatsAppError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
export const MAX_WHATSAPP_ATTEMPTS = 3

/** Events that go to WhatsApp when the company turns the channel on (the rest stay in-app/email). */
export const WHATSAPP_EVENTS: ReadonlySet<string> = new Set([
  'approval.requested', 'approval.reminder', 'leave.decided', 'payslip.published', 'attendance.reminder', 'policy.published', 'policy.reminder',
  'roster.swap.proposed', 'roster.swap.decided', 'letter.issued', 'people.transferred', 'probation.decided', 'survey.opened', 'asset.issued',
])

export interface Provider { id: string; provider: 'meta_cloud' | 'generic_webhook'; endpoint: string; from_number: string | null; templates: Record<string, string>; status: string; has_secret: boolean }
export async function getProvider(tx: PoolClient): Promise<Provider | null> {
  return (await tx.query<Provider>(`SELECT id, provider, endpoint, from_number, templates, status, secret_ciphertext IS NOT NULL AS has_secret FROM whatsapp_providers`)).rows[0] ?? null
}
export async function setProvider(tx: PoolClient, args: { provider: Provider['provider']; endpoint: string; fromNumber?: string | null; secret?: string | null; templates?: Record<string, string>; master: string | undefined }): Promise<Provider> {
  const tid = await tenantId(tx)
  if (!['meta_cloud', 'generic_webhook'].includes(args.provider)) throw new WhatsAppError('VALIDATION_FAILED', 'provider is meta_cloud or generic_webhook')
  if (!/^https:\/\//.test(args.endpoint) && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(args.endpoint)) throw new WhatsAppError('VALIDATION_FAILED', 'endpoint must be https')
  if (args.secret && !args.master) throw new WhatsAppError('MAIL_KEY_MISSING', 'this server cannot store credentials (PEPL_MAIL_KEY is not set)')
  const cipher = args.secret && args.master ? encryptSecret(args.secret, tid, args.master) : null
  await tx.query(
    `INSERT INTO whatsapp_providers (tenant_id, provider, endpoint, from_number, secret_ciphertext, templates) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (tenant_id) DO UPDATE SET provider = EXCLUDED.provider, endpoint = EXCLUDED.endpoint, from_number = EXCLUDED.from_number,
       secret_ciphertext = coalesce(EXCLUDED.secret_ciphertext, whatsapp_providers.secret_ciphertext), templates = EXCLUDED.templates, status = 'active', updated_at = now()`,
    [tid, args.provider, args.endpoint, args.fromNumber ?? null, cipher, JSON.stringify(args.templates ?? {})])
  return (await getProvider(tx))!
}
export async function disableProvider(tx: PoolClient): Promise<void> { await tx.query(`UPDATE whatsapp_providers SET status = 'disabled', updated_at = now()`) }

export async function optIn(tx: PoolClient, args: { userId: string; phone: string }): Promise<void> {
  const tid = await tenantId(tx)
  const phone = args.phone.replace(/[\s-]/g, '')
  if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) throw new WhatsAppError('VALIDATION_FAILED', 'phone must be in international form, e.g. +919876543210')
  await tx.query(`INSERT INTO user_whatsapp (tenant_id, user_id, phone_e164) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, user_id) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164, opted_in_at = now(), opted_out_at = NULL`, [tid, args.userId, phone])
}
export async function optOut(tx: PoolClient, userId: string): Promise<void> { await tx.query(`UPDATE user_whatsapp SET opted_out_at = now() WHERE user_id = $1`, [userId]) }
export async function status(tx: PoolClient, userId: string): Promise<{ optedIn: boolean; phone: string | null; companyEnabled: boolean }> {
  const r = (await tx.query<{ phone_e164: string; opted_out_at: string | null }>(`SELECT phone_e164, opted_out_at FROM user_whatsapp WHERE user_id = $1`, [userId])).rows[0]
  const p = await getProvider(tx)
  return { optedIn: Boolean(r && !r.opted_out_at), phone: r?.phone_e164 ?? null, companyEnabled: Boolean(p && p.status === 'active') }
}

export interface Outbound { to: string; text: string; template?: string; params: string[] }
/** Provider payloads. Meta wants an approved template (or free text inside a 24 h window); the generic webhook gets both. */
export function buildPayload(p: Provider, m: Outbound): { url: string; body: unknown } {
  if (p.provider === 'meta_cloud') {
    const body = m.template
      ? { messaging_product: 'whatsapp', to: m.to.replace('+', ''), type: 'template', template: { name: m.template, language: { code: 'en' }, components: [{ type: 'body', parameters: m.params.map((t) => ({ type: 'text', text: t })) }] } }
      : { messaging_product: 'whatsapp', to: m.to.replace('+', ''), type: 'text', text: { body: m.text } }
    return { url: p.endpoint, body }
  }
  return { url: p.endpoint, body: { to: m.to, from: p.from_number, text: m.text, template: m.template ?? null, params: m.params } }
}

export type Sender = (url: string, body: unknown, bearer: string | null) => Promise<{ ok: boolean; status: number; error?: string }>
export const httpSender: Sender = async (url, body, bearer) => {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
    return { ok: r.ok, status: r.status, error: r.ok ? undefined : (await r.text()).slice(0, 300) }
  } catch (e) { return { ok: false, status: 0, error: (e as Error).message.slice(0, 300) } }
}

/** The delivery pass: pending notifications for opted-in people, through the company's provider. */
export async function deliverWhatsApp(tx: PoolClient, args: { master: string | undefined; send?: Sender; limit?: number }): Promise<{ sent: number; failed: number; skipped: number }> {
  const tid = await tenantId(tx)
  const p = await getProvider(tx)
  if (!p || p.status !== 'active') return { sent: 0, failed: 0, skipped: 0 }
  const secretRow = (await tx.query<{ secret_ciphertext: Buffer | null }>(`SELECT secret_ciphertext FROM whatsapp_providers`)).rows[0]
  let bearer: string | null = null
  if (secretRow?.secret_ciphertext) {
    // A key this server cannot read (no PEPL_MAIL_KEY, or a rotated one): say nothing, send nothing.
    try { bearer = args.master ? decryptSecret(secretRow.secret_ciphertext, tid, args.master) : null } catch { bearer = null }
    if (!bearer) return { sent: 0, failed: 0, skipped: 0 }
  }
  const { rows } = await tx.query<{ id: string; event_type: string; title: string; body: string | null; phone: string }>(
    `SELECT n.id::text, n.event_type, n.title, n.body, w.phone_e164 AS phone
       FROM notifications n JOIN user_whatsapp w ON (w.tenant_id, w.user_id) = (n.tenant_id, n.user_id) AND w.opted_out_at IS NULL
      WHERE n.whatsapp_sent_at IS NULL AND n.whatsapp_attempts < $2 AND n.read_at IS NULL
        AND ('whatsapp' = ANY(n.channels) OR n.event_type = ANY($3::text[]))
      ORDER BY n.created_at LIMIT $1`, [args.limit ?? 100, MAX_WHATSAPP_ATTEMPTS, [...WHATSAPP_EVENTS]])
  const send = args.send ?? httpSender
  let sent = 0, failed = 0
  for (const n of rows) {
    const text = n.body ? `${n.title}\n${n.body}` : n.title
    const { url, body } = buildPayload(p, { to: n.phone, text, template: p.templates[n.event_type], params: [n.title, n.body ?? ''] })
    const r = await send(url, body, bearer)
    if (r.ok) { await tx.query(`UPDATE notifications SET whatsapp_sent_at = now(), whatsapp_error = NULL WHERE id = $1`, [n.id]); sent++ }
    else { await tx.query(`UPDATE notifications SET whatsapp_attempts = whatsapp_attempts + 1, whatsapp_error = $2 WHERE id = $1`, [n.id, `${r.status}: ${r.error ?? ''}`.slice(0, 300)]); failed++ }
  }
  return { sent, failed, skipped: 0 }
}
