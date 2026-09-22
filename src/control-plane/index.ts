/**
 * The control plane. Runs on its OWN connection and role — cross-tenant by
 * design — and reaches the application schema only to write the entitlement
 * projection and seed a new tenant's defaults.
 *
 * The application role can neither read nor write anything here, so an
 * application bug cannot grant a module nobody paid for.
 */
import pg from 'pg'
import { config } from '../config.ts'
import { REGISTRY } from '../config-registry/index.ts'
import { applyPresetAtProvisioning } from './presets.ts'

export class ControlPlaneError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ControlPlaneError'
  }
}

/** Control-plane connections use the superuser role; never a request path. */
export const controlDb = new pg.Pool({
  host: config.host,
  port: config.port,
  database: config.db,
  user: config.superUser,
  password: config.superPassword,
})

const STEPS = [
  'tenant',
  'subscription',
  'entitlements',
  'admin_user',
  'defaults',
  'preset',
  'config_version',
] as const
export type ProvisioningStep = (typeof STEPS)[number]

export interface ProvisionInput {
  legalName: string
  displayName: string
  planCode: string
  adminEmail: string
  adminName: string
  stateCode?: string
  /** Organisation-type preset code (db/reference/presets.ts); omitted = plain Indian-SME defaults. */
  organisationType?: string
}

export interface ProvisionResult {
  tenantId: string
  jobId: string
  stepsRun: ProvisioningStep[]
  resumed: boolean
}

/**
 * ONE orchestrator, not seven callers. Every step is idempotent and the job is
 * resumable, because a failure part-way must not leave a tenant that can log in
 * but has no leave types.
 */
export async function provisionTenant(
  input: ProvisionInput,
  opts: { failAfter?: ProvisioningStep; resumeJobId?: string } = {},
): Promise<ProvisionResult> {
  const client = await controlDb.connect()
  const stepsRun: ProvisioningStep[] = []
  let tenantId = ''
  let jobId = ''
  let done: string[] = []

  try {
    if (opts.resumeJobId) {
      const { rows } = await client.query<{ tenant_id: string; completed_steps: string[] }>(
        `SELECT tenant_id, completed_steps FROM control_plane.provisioning_jobs WHERE id = $1`,
        [opts.resumeJobId],
      )
      const job = rows[0]
      if (!job) throw new ControlPlaneError('JOB_NOT_FOUND', 'no such provisioning job')
      jobId = opts.resumeJobId
      tenantId = job.tenant_id
      done = job.completed_steps
      await client.query(
        `UPDATE control_plane.provisioning_jobs
            SET status = 'running', attempts = attempts + 1 WHERE id = $1`,
        [jobId],
      )
    }

    for (const step of STEPS) {
      if (done.includes(step)) continue

      if (opts.failAfter && stepsRun.includes(opts.failAfter)) {
        await client.query(
          `UPDATE control_plane.provisioning_jobs SET status = 'failed', last_error = $2 WHERE id = $1`,
          [jobId, `injected failure after ${opts.failAfter}`],
        )
        throw new ControlPlaneError('PROVISIONING_FAILED', `injected failure after ${opts.failAfter}`)
      }

      switch (step) {
        case 'tenant': {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO tenants (legal_name, display_name) VALUES ($1,$2) RETURNING id`,
            [input.legalName, input.displayName],
          )
          tenantId = rows[0]!.id
          const job = await client.query<{ id: string }>(
            `INSERT INTO control_plane.provisioning_jobs (tenant_id, status)
             VALUES ($1, 'running') RETURNING id`,
            [tenantId],
          )
          jobId = job.rows[0]!.id
          break
        }
        case 'subscription':
          await client.query(
            `INSERT INTO control_plane.subscriptions (tenant_id, plan_code, trial_ends_on)
             VALUES ($1, $2, CURRENT_DATE + 14)
             ON CONFLICT (tenant_id) DO NOTHING`,
            [tenantId, input.planCode],
          )
          break
        case 'entitlements':
          await projectEntitlements(client, tenantId)
          break
        case 'admin_user':
          await client.query(
            `INSERT INTO app_users (tenant_id, email, full_name) VALUES ($1,$2,$3)
             ON CONFLICT (tenant_id, email) DO NOTHING`,
            [tenantId, input.adminEmail, input.adminName],
          )
          break
        case 'defaults':
          await seedDefaults(client, tenantId)
          break
        case 'preset':
          if (input.organisationType) await applyPresetAtProvisioning(client, tenantId, input.organisationType)
          break
        case 'config_version':
          await client.query(
            `INSERT INTO tenant_config_versions (tenant_id, version) VALUES ($1, 1)
             ON CONFLICT (tenant_id) DO NOTHING`,
            [tenantId],
          )
          break
      }

      stepsRun.push(step)
      await client.query(
        `UPDATE control_plane.provisioning_jobs
            SET completed_steps = array_append(completed_steps, $2) WHERE id = $1`,
        [jobId, step],
      )
    }

    await client.query(
      `UPDATE control_plane.provisioning_jobs
          SET status = 'completed', completed_at = now(), last_error = NULL WHERE id = $1`,
      [jobId],
    )
    return { tenantId, jobId, stepsRun, resumed: Boolean(opts.resumeJobId) }
  } finally {
    client.release()
  }
}

/**
 * tenant_entitlements is a PROJECTION of plan + subscription + addons, rewritten
 * whenever any input changes — and the config version is bumped in the SAME
 * statement batch. This is the fix for the classic failure where billing, flags
 * and access drift apart and a tenant keeps a feature after downgrading.
 */
export async function projectEntitlements(
  client: pg.PoolClient | pg.Pool,
  tenantId: string,
): Promise<void> {
  await client.query(
    `WITH s AS (
       SELECT sub.tenant_id, sub.plan_code, sub.status, sub.feature_addons, sub.limit_overrides,
              sub.current_period_start, sub.current_period_end,
              p.features, p.limits
         FROM control_plane.subscriptions sub
         JOIN control_plane.plans p ON p.code = sub.plan_code
        WHERE sub.tenant_id = $1
     )
     INSERT INTO tenant_entitlements
       (tenant_id, plan_code, features, limits, valid_from, valid_until, status, updated_at)
     SELECT s.tenant_id, s.plan_code,
            s.features || s.feature_addons,
            s.limits   || s.limit_overrides,
            s.current_period_start, s.current_period_end, s.status, now()
       FROM s
     ON CONFLICT (tenant_id) DO UPDATE SET
       plan_code = EXCLUDED.plan_code,
       features  = EXCLUDED.features,
       limits    = EXCLUDED.limits,
       valid_from = EXCLUDED.valid_from,
       valid_until = EXCLUDED.valid_until,
       status = EXCLUDED.status,
       updated_at = now()`,
    [tenantId],
  )
  await client.query(
    `INSERT INTO tenant_config_versions (tenant_id, version) VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO UPDATE SET version = tenant_config_versions.version + 1, updated_at = now()`,
    [tenantId],
  )
}

export async function changePlan(tenantId: string, planCode: string): Promise<void> {
  await controlDb.query(
    `UPDATE control_plane.subscriptions SET plan_code = $2 WHERE tenant_id = $1`,
    [tenantId, planCode],
  )
  await projectEntitlements(controlDb, tenantId)
}

export async function setSubscriptionStatus(tenantId: string, status: string): Promise<void> {
  await controlDb.query(
    `UPDATE control_plane.subscriptions SET status = $2 WHERE tenant_id = $1`,
    [tenantId, status],
  )
  await projectEntitlements(controlDb, tenantId)
}

/**
 * A brand-new tenant must run payroll with ZERO configuration. Configurability is
 * about letting customers change things, not forcing them to.
 */
async function seedDefaults(client: pg.PoolClient, tenantId: string): Promise<void> {
  for (const [code, name] of [
    ['EL', 'Earned Leave'], ['CL', 'Casual Leave'], ['SL', 'Sick Leave'],
    ['ML', 'Maternity Leave'], ['CO', 'Compensatory Off'], ['LOP', 'Loss of Pay'],
  ]) {
    await client.query(
      `INSERT INTO leave_types (tenant_id, code, name, is_paid, affects_lop)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, code) DO NOTHING`,
      [tenantId, code, name, code !== 'LOP', code === 'LOP'],
    )
  }

  // Policies, not just types: without an accrual policy the monthly job credits
  // nothing, and a tenant that "configured nothing" would silently never accrue.
  // Defaults follow the common Indian baseline (standard-company-model.md §5).
  const ACCRUAL: Record<string, { monthly: number; carry: number; encashable: boolean }> = {
    EL: { monthly: 1.5, carry: 15, encashable: true },   // ~18/year
    CL: { monthly: 0.583, carry: 0, encashable: false }, // ~7/year, lapses
    SL: { monthly: 1.0, carry: 0, encashable: false },   // 12/year, lapses
  }
  for (const [code, rule] of Object.entries(ACCRUAL)) {
    await client.query(
      `INSERT INTO leave_policies
         (tenant_id, leave_type_id, version, accrual_method, accrual_units_per_period,
          carry_forward_limit, encashable, effective_from)
       SELECT $1, lt.id, 1, 'monthly', $3, $4, $5, DATE '2025-04-01'
         FROM leave_types lt WHERE lt.tenant_id = $1 AND lt.code = $2
       ON CONFLICT (tenant_id, leave_type_id, version) DO NOTHING`,
      [tenantId, code, rule.monthly, rule.carry, rule.encashable],
    )
  }

  for (const [name, confidential] of [
    ['Payroll', false], ['Leave', false], ['Attendance', false],
    ['IT', false], ['Facilities', false], ['Grievance', true],
  ] as const) {
    await client.query(
      `INSERT INTO ticket_categories (tenant_id, name, is_confidential) VALUES ($1,$2,$3)`,
      [tenantId, name, confidential],
    )
  }

  await client.query(
    `INSERT INTO ticket_counters (tenant_id, next_number) VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  )
}

// ---------------------------------------------------------------------------
// Support access
// ---------------------------------------------------------------------------

export async function grantSupportAccess(args: {
  tenantId: string
  agentId: string
  reason: string
  grantedByUserId?: string
  breakGlass?: boolean
  approver2AgentId?: string
  hours?: number
}): Promise<string> {
  if (!args.reason?.trim()) {
    throw new ControlPlaneError('REASON_REQUIRED', 'a support session must record why it was needed')
  }
  if (args.breakGlass && !args.approver2AgentId) {
    throw new ControlPlaneError('SECOND_APPROVER_REQUIRED', 'break-glass access needs a second approver')
  }
  if (!args.breakGlass && !args.grantedByUserId) {
    throw new ControlPlaneError('TENANT_APPROVAL_REQUIRED', 'the tenant must approve a support session')
  }

  const { rows } = await controlDb.query<{ id: string }>(
    `INSERT INTO control_plane.support_access_grants
       (tenant_id, agent_id, granted_by_user_id, break_glass, approver_2_agent_id, reason, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' hours')::interval)
     RETURNING id`,
    [args.tenantId, args.agentId, args.grantedByUserId ?? null,
     args.breakGlass ?? false, args.approver2AgentId ?? null, args.reason, args.hours ?? 4],
  )

  await controlDb.query(
    `INSERT INTO control_plane.platform_audit (tenant_id, agent_id, action, detail)
     VALUES ($1,$2,'support.access.granted',$3::jsonb)`,
    [args.tenantId, args.agentId,
     JSON.stringify({ reason: args.reason, breakGlass: args.breakGlass ?? false })],
  )
  return rows[0]!.id
}

export async function supportAccessActive(grantId: string): Promise<boolean> {
  const { rows } = await controlDb.query<{ active: boolean }>(
    `SELECT (revoked_at IS NULL AND now() BETWEEN starts_at AND expires_at) AS active
       FROM control_plane.support_access_grants WHERE id = $1`,
    [grantId],
  )
  return rows[0]?.active ?? false
}

export async function revokeSupportAccess(grantId: string): Promise<void> {
  await controlDb.query(
    `UPDATE control_plane.support_access_grants SET revoked_at = now() WHERE id = $1`,
    [grantId],
  )
}

/** Registry keys, used by the launch gate to assert the seeded tenant is complete. */
export const REGISTRY_KEY_COUNT = Object.keys(REGISTRY).length
