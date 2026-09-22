/**
 * Trust page and security posture.
 *
 * The public page states what the platform does — as facts the code enforces,
 * not marketing — and shows uptime derived from the scheduler's own heartbeat
 * samples plus the incidents operators post. The tenant posture is the
 * company's own numbers: MFA adoption, admins, live API keys, the audit chain
 * verified, retention settings, open anomaly findings.
 */
import type { PoolClient } from 'pg'
import { controlDb } from './index.ts'
import { appPool } from '../db/pool.ts'
import { verifyChain } from '../audit/index.ts'
import type { ResolvedConfig } from '../config/resolver.ts'

export const COMMITMENTS = [
  { key: 'tenant_isolation', title: 'Every table is tenant-isolated by Postgres row-level security', detail: 'FORCE ROW LEVEL SECURITY on every tenant table; the runtime role cannot bypass it; a missing tenant context yields zero rows, never all rows. A structural gate fails the build on any unprotected table.' },
  { key: 'least_privilege', title: 'The application connects as a role that owns nothing', detail: 'Migrations run as the owner; every request runs as a role with DML only, NOBYPASSRLS, and column-level grants where a table is otherwise immutable.' },
  { key: 'audit_chain', title: 'Audit events are hash-chained and sealed daily', detail: 'Each event hashes its predecessor; a nightly seal records the chain tip in the control plane, so a deleted or altered event is detectable.' },
  { key: 'secrets', title: 'Stored credentials are encrypted per tenant', detail: 'Mailbox passwords, integration secrets and webhook signing keys are encrypted with a per-tenant derivation of a master key that never sits in the database.' },
  { key: 'mfa', title: 'Two-factor authentication, enforceable for admins', detail: 'TOTP with recovery codes; a company can require it for every administrator, and sensitive actions ask for a recent second factor.' },
  { key: 'payroll_immutability', title: 'A locked payroll cannot be changed in the database', detail: 'Triggers, not application checks, refuse writes to locked runs; a correction is a new revision that supersedes, never an edit.' },
  { key: 'confidentiality', title: 'Confidential records are hidden by policy, not by filter', detail: 'Grievance tickets, survey answers and 360° feedback are invisible to anyone not on them at the database layer — absent from every list, count, search and export.' },
  { key: 'erasure', title: 'Right to erasure, with the ledger kept', detail: 'After the retention period a person can be erased; payroll ledger rows stay as numbers without a name, as the income-tax record period requires.' },
  { key: 'residency', title: 'Data stays in India', detail: 'Primary and replica databases and backups are hosted in Indian regions.' },
  { key: 'sandbox', title: 'Sandboxes never send', detail: 'A sandbox tenant is excluded from every outbound job — email, WhatsApp, webhooks, scheduled reports.' },
] as const

export const SUBPROCESSORS = [
  { name: 'Cloud hosting (India region)', purpose: 'Compute, managed Postgres, object storage, backups', data: 'All customer data, encrypted at rest' },
  { name: 'Transactional email provider', purpose: 'Only when a company does not bring its own mailbox', data: 'Recipient address, subject, notification body' },
  { name: 'WhatsApp Business API (Meta) or the company\'s own provider', purpose: 'Notifications a person opted into', data: 'Phone number, template parameters' },
  { name: 'Web push (browser vendors)', purpose: 'Browser notifications', data: 'An opaque endpoint; the payload is an id and a badge count' },
]

export interface Uptime { days: number; samples: number; readyPct: number | null; p95LatencyMs: number | null; daily: Array<{ day: string; readyPct: number | null; samples: number }> }

export async function recordUptimeSample(): Promise<void> {
  const started = Date.now()
  let ready = false, detail: Record<string, unknown> = {}
  try {
    const { rows } = await appPool.query<{ migrations: string }>(`SELECT count(*)::text AS migrations FROM _migrations`)
    ready = Number(rows[0]?.migrations ?? 0) > 0
    detail = { migrations: Number(rows[0]?.migrations ?? 0) }
  } catch (err) { detail = { error: (err as Error).message } }
  await controlDb.query(`INSERT INTO control_plane.uptime_samples (ready, latency_ms, detail) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`, [ready, Date.now() - started, JSON.stringify(detail)])
  await controlDb.query(`DELETE FROM control_plane.uptime_samples WHERE sampled_at < now() - interval '400 days'`)
}

export async function uptime(days = 30): Promise<Uptime> {
  const { rows } = await controlDb.query<{ day: string; samples: string; ready: string }>(
    `SELECT sampled_at::date::text AS day, count(*)::text AS samples, count(*) FILTER (WHERE ready)::text AS ready FROM control_plane.uptime_samples WHERE sampled_at >= now() - ($1 || ' days')::interval GROUP BY 1 ORDER BY 1`, [String(days)])
  const total = rows.reduce((s, r) => s + Number(r.samples), 0), readyN = rows.reduce((s, r) => s + Number(r.ready), 0)
  const p95 = (await controlDb.query<{ p: string | null }>(`SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::text AS p FROM control_plane.uptime_samples WHERE ready AND sampled_at >= now() - ($1 || ' days')::interval`, [String(days)])).rows[0]?.p
  return { days, samples: total, readyPct: total ? Math.round(readyN / total * 10000) / 100 : null, p95LatencyMs: p95 ? Math.round(Number(p95)) : null, daily: rows.map((r) => ({ day: r.day, samples: Number(r.samples), readyPct: Number(r.samples) ? Math.round(Number(r.ready) / Number(r.samples) * 10000) / 100 : null })) }
}
export async function incidents(limit = 20): Promise<Array<{ id: string; started_at: string; resolved_at: string | null; severity: string; title: string; updates: Array<{ at: string; note: string }> }>> {
  return (await controlDb.query(`SELECT id, started_at::text, resolved_at::text, severity, title, updates FROM control_plane.incidents ORDER BY started_at DESC LIMIT $1`, [limit])).rows
}
/** Operators post incidents through the job runner, never through a tenant route. */
export async function postIncident(args: { title: string; severity: 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance'; startedAt?: string; note?: string }): Promise<string> {
  const { rows } = await controlDb.query<{ id: string }>(`INSERT INTO control_plane.incidents (started_at, severity, title, updates) VALUES (coalesce($1::timestamptz, now()), $2, $3, $4::jsonb) RETURNING id`,
    [args.startedAt ?? null, args.severity, args.title, JSON.stringify(args.note ? [{ at: new Date().toISOString(), note: args.note }] : [])])
  return rows[0]!.id
}
export async function updateIncident(args: { id: string; note: string; resolved?: boolean }): Promise<void> {
  await controlDb.query(`UPDATE control_plane.incidents SET updates = updates || $2::jsonb, resolved_at = CASE WHEN $3 THEN now() ELSE resolved_at END WHERE id = $1`, [args.id, JSON.stringify([{ at: new Date().toISOString(), note: args.note }]), args.resolved ?? false])
}

export async function trustPage(): Promise<{ commitments: typeof COMMITMENTS; subprocessors: typeof SUBPROCESSORS; uptime: Uptime; incidents: Awaited<ReturnType<typeof incidents>>; status: 'operational' | 'degraded' | 'outage' | 'maintenance' }> {
  const [u, inc] = await Promise.all([uptime(30), incidents(20)])
  const open = inc.find((i) => !i.resolved_at)
  const status = !open ? 'operational' : open.severity === 'maintenance' ? 'maintenance' : open.severity === 'degraded' ? 'degraded' : 'outage'
  return { commitments: COMMITMENTS, subprocessors: SUBPROCESSORS, uptime: u, incidents: inc, status }
}

export interface Posture {
  mfa: { admins: number; adminsWithMfa: number; users: number; usersWithMfa: number; requiredForAdmins: boolean }
  admins: Array<{ name: string; email: string; roles: string[]; mfa: boolean; lastLoginAt: string | null }>
  apiKeys: { live: number; expiringIn30Days: number }
  webhooks: { active: number; failingLast7Days: number }
  audit: { chainOk: boolean; eventsChecked: number; lastSealedDate: string | null }
  retention: { erasureAfterDays: number | null; chatHistoryDays: number | null }
  anomalies: { openBlocking: number; openWarnings: number }
  sessions: { active: number }
  score: number
  advice: string[]
}
/** The company's own security posture, for its org admin. */
export async function securityPosture(tx: PoolClient, cfg: ResolvedConfig, tenantId: string): Promise<Posture> {
  const admins = (await tx.query<{ name: string; email: string; roles: string[]; mfa: boolean; last_login_at: string | null }>(
    `SELECT u.full_name AS name, u.email, array_agg(r.role ORDER BY r.role) AS roles, EXISTS (SELECT 1 FROM user_mfa m WHERE (m.tenant_id, m.user_id) = (u.tenant_id, u.id) AND m.enabled_at IS NOT NULL) AS mfa,
            (SELECT max(issued_at)::text FROM sessions s WHERE (s.tenant_id, s.user_id) = (u.tenant_id, u.id)) AS last_login_at
       FROM app_users u JOIN user_roles r ON (r.tenant_id, r.user_id) = (u.tenant_id, u.id) WHERE u.status = 'active' AND r.role IN ('org_admin','hr_admin','payroll_admin','finance') GROUP BY u.id, u.full_name, u.email, u.tenant_id ORDER BY u.full_name`)).rows
  const users = (await tx.query<{ n: string; m: string }>(`SELECT count(*)::text AS n, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM user_mfa m WHERE (m.tenant_id, m.user_id) = (u.tenant_id, u.id) AND m.enabled_at IS NOT NULL))::text AS m FROM app_users u WHERE u.status = 'active'`)).rows[0]!
  const keys = (await tx.query<{ live: string; soon: string }>(`SELECT count(*) FILTER (WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()))::text AS live, count(*) FILTER (WHERE revoked_at IS NULL AND expires_at BETWEEN now() AND now() + interval '30 days')::text AS soon FROM api_keys`)).rows[0]!
  const hooks = (await tx.query<{ active: string; failing: string }>(`SELECT (SELECT count(*) FROM webhooks WHERE status = 'active')::text AS active, (SELECT count(DISTINCT webhook_id) FROM webhook_deliveries WHERE status = 'failed' AND created_at > now() - interval '7 days')::text AS failing`)).rows[0]!
  const chain = await verifyChain(tx)
  const seal = (await controlDb.query<{ d: string | null }>(`SELECT max(sealed_date)::text AS d FROM control_plane.audit_seals WHERE tenant_id = $1`, [tenantId])).rows[0]?.d ?? null
  const anomalies = (await tx.query<{ b: string; w: string }>(`SELECT count(*) FILTER (WHERE severity = 'blocking')::text AS b, count(*) FILTER (WHERE severity = 'warning')::text AS w FROM anomaly_findings WHERE status = 'open'`)).rows[0]!
  const sessions = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > now()`)).rows[0]!
  const get = (k: string): number | null => { try { return cfg.get<number>(k) } catch { return null } }
  const p: Posture = {
    mfa: { admins: admins.length, adminsWithMfa: admins.filter((a) => a.mfa).length, users: Number(users.n), usersWithMfa: Number(users.m), requiredForAdmins: Boolean(cfg.get<boolean>('security.mfa_required_for_admins')) },
    admins: admins.map((a) => ({ name: a.name, email: a.email, roles: a.roles, mfa: a.mfa, lastLoginAt: a.last_login_at })),
    apiKeys: { live: Number(keys.live), expiringIn30Days: Number(keys.soon) },
    webhooks: { active: Number(hooks.active), failingLast7Days: Number(hooks.failing) },
    audit: { chainOk: chain.ok, eventsChecked: chain.checked, lastSealedDate: seal },
    retention: { erasureAfterDays: get('privacy.erasure_after_days'), chatHistoryDays: get('chat.history_retention_days') },
    anomalies: { openBlocking: Number(anomalies.b), openWarnings: Number(anomalies.w) },
    sessions: { active: Number(sessions.n) },
    score: 0, advice: [],
  }
  let score = 100
  if (!p.mfa.requiredForAdmins) { score -= 20; p.advice.push('Require two-factor authentication for administrators (Company → Security).') }
  if (p.mfa.admins && p.mfa.adminsWithMfa < p.mfa.admins) { score -= 15; p.advice.push(`${p.mfa.admins - p.mfa.adminsWithMfa} administrator(s) have not enrolled a second factor.`) }
  if (p.admins.filter((a) => a.roles.includes('org_admin')).length > 3) { score -= 10; p.advice.push('More than three org admins; fewer people should hold every permission.') }
  if (!p.audit.chainOk) { score -= 30; p.advice.push('The audit chain does not verify — contact support; this is what the seal exists to catch.') }
  if (p.apiKeys.expiringIn30Days) p.advice.push(`${p.apiKeys.expiringIn30Days} API key(s) expire within 30 days.`)
  if (p.webhooks.failingLast7Days) { score -= 5; p.advice.push(`${p.webhooks.failingLast7Days} webhook(s) failed deliveries this week.`) }
  if (p.anomalies.openBlocking) { score -= 10; p.advice.push(`${p.anomalies.openBlocking} blocking payroll finding(s) are open.`) }
  p.score = Math.max(0, score)
  return p
}
