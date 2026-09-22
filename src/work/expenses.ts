/**
 * Expense claims and travel.
 *
 * A claim goes: submitted → (approval engine) → approved → in_payroll →
 * reimbursed. The policy lives on the category (per-claim and monthly limits,
 * receipt threshold, mileage rate); a claim over a limit is refused at
 * submission with the limit named, not silently trimmed. A claim identical
 * to one already filed (same person, category, day, amount) is refused as a
 * duplicate unless the caller says it is not. Reimbursement rides the next
 * payroll run as a REIMBURSEMENT line (non-taxable unless the category says
 * otherwise), through the same freeze / unfreeze / lock hooks as exit
 * settlements — paid once, released if the run is unfrozen.
 */
import type { PoolClient } from 'pg'
import { currentPosting } from '../people/profile.ts'
import { raiseWithPolicy } from '../approvals/policy.ts'
import type { ChainCode } from '../approvals/index.ts'
import { notify } from '../comms/index.ts'

export class ExpenseError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ExpenseError' }
}

const tenantId = async (tx: PoolClient): Promise<string> => {
  const t = (await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')).rows[0]?.t
  if (!t) throw new ExpenseError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}

// ── categories ───────────────────────────────────────────────────────────────

export interface Category {
  id: string; code: string; name: string
  per_claim_limit_paise: string | null; monthly_limit_paise: string | null; receipt_required_above_paise: string
  mileage_rate_paise_per_km: string | null; taxable: boolean; status: string
}
const CAT_COLS = `id, code, name, per_claim_limit_paise::text, monthly_limit_paise::text, receipt_required_above_paise::text, mileage_rate_paise_per_km::text, taxable, status`

export async function listCategories(tx: PoolClient, includeRetired = false): Promise<Category[]> {
  const { rows } = await tx.query<Category>(`SELECT ${CAT_COLS} FROM expense_categories WHERE $1 OR status = 'active' ORDER BY name`, [includeRetired])
  return rows
}

export async function upsertCategory(
  tx: PoolClient,
  args: { code: string; name: string; perClaimLimitPaise?: number | null; monthlyLimitPaise?: number | null; receiptRequiredAbovePaise?: number; mileageRatePaisePerKm?: number | null; taxable?: boolean },
): Promise<Category> {
  const tid = await tenantId(tx)
  const code = args.code.trim().toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9_-]{0,23}$/.test(code)) throw new ExpenseError('VALIDATION_FAILED', 'code must be letters, digits, _ or -, up to 24 characters')
  if (!args.name.trim()) throw new ExpenseError('VALIDATION_FAILED', 'a category needs a name')
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO expense_categories (tenant_id, code, name, per_claim_limit_paise, monthly_limit_paise, receipt_required_above_paise, mileage_rate_paise_per_km, taxable)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name, per_claim_limit_paise = EXCLUDED.per_claim_limit_paise,
       monthly_limit_paise = EXCLUDED.monthly_limit_paise, receipt_required_above_paise = EXCLUDED.receipt_required_above_paise,
       mileage_rate_paise_per_km = EXCLUDED.mileage_rate_paise_per_km, taxable = EXCLUDED.taxable, status = 'active'
     RETURNING id`,
    [tid, code, args.name.trim().slice(0, 80), args.perClaimLimitPaise ?? null, args.monthlyLimitPaise ?? null,
     args.receiptRequiredAbovePaise ?? 0, args.mileageRatePaisePerKm ?? null, args.taxable ?? false])
  return (await listCategories(tx, true)).find((c) => c.id === rows[0]!.id)!
}

export async function retireCategory(tx: PoolClient, id: string): Promise<void> {
  const { rowCount } = await tx.query(`UPDATE expense_categories SET status = 'retired' WHERE id = $1 AND status = 'active'`, [id])
  if (!rowCount) throw new ExpenseError('NOT_FOUND', 'no such active category')
}

/** The standard set a company gets on first use. Idempotent. */
export async function seedDefaultCategories(tx: PoolClient): Promise<void> {
  if ((await listCategories(tx, true)).length) return
  for (const c of [
    { code: 'TRAVEL', name: 'Travel (tickets, cabs)', receiptRequiredAbovePaise: 50_000 },
    { code: 'LODGING', name: 'Hotel / lodging', receiptRequiredAbovePaise: 1, perClaimLimitPaise: 1_000_000 },
    { code: 'MEALS', name: 'Meals on duty', perClaimLimitPaise: 200_000, monthlyLimitPaise: 1_500_000, receiptRequiredAbovePaise: 50_000 },
    { code: 'MILEAGE', name: 'Own vehicle (per km)', mileageRatePaisePerKm: 1_200 },
    { code: 'PHONE', name: 'Phone / internet', monthlyLimitPaise: 300_000, receiptRequiredAbovePaise: 0 },
    { code: 'SUPPLIES', name: 'Office supplies', receiptRequiredAbovePaise: 1 },
    { code: 'OTHER', name: 'Other', receiptRequiredAbovePaise: 1 },
  ]) await upsertCategory(tx, c)
}

// ── claims ───────────────────────────────────────────────────────────────────

export interface Claim {
  id: string; employee_id: string; employee_number: string; employee_name: string
  category_id: string; category_code: string; category_name: string
  travel_request_id: string | null; incurred_on: string; amount_paise: string; distance_km: string | null
  description: string; merchant: string | null; receipt_document_id: string | null; cost_centre: string | null
  status: string; approval_request_id: string | null; reimbursement_run_id: string | null; reimbursed_at: string | null
  created_at: string; decided_at: string | null
  per_diem: { cityClass: string; days: number; halfDays: number; ratePaise: number; halfDayPct: number } | null
}
const CLAIM_COLS = `c.id, c.employee_id, e.employee_number, concat_ws(' ', e.first_name, e.last_name) AS employee_name,
  c.category_id, k.code AS category_code, k.name AS category_name,
  c.travel_request_id, c.incurred_on::text, c.amount_paise::text, c.distance_km::text,
  c.description, c.merchant, c.receipt_document_id, c.cost_centre, c.per_diem,
  c.status, c.approval_request_id, c.reimbursement_run_id, c.reimbursed_at::text, c.created_at::text, c.decided_at::text`
const CLAIM_FROM = `FROM expense_claims c
  JOIN employees e ON (e.tenant_id, e.id) = (c.tenant_id, c.employee_id)
  JOIN expense_categories k ON (k.tenant_id, k.id) = (c.tenant_id, c.category_id)`

export async function getClaim(tx: PoolClient, id: string): Promise<Claim | null> {
  const { rows } = await tx.query<Claim>(`SELECT ${CLAIM_COLS} ${CLAIM_FROM} WHERE c.id = $1`, [id])
  return rows[0] ?? null
}

export async function listClaims(
  tx: PoolClient,
  args: { employeeIds?: string[] | null; employeeId?: string; status?: string; from?: string; to?: string; limit?: number; offset?: number },
): Promise<{ claims: Claim[]; hasMore: boolean }> {
  const limit = Math.min(args.limit ?? 50, 200)
  const { rows } = await tx.query<Claim>(
    `SELECT ${CLAIM_COLS} ${CLAIM_FROM}
      WHERE ($1::uuid[] IS NULL OR c.employee_id = ANY($1))
        AND ($2::uuid IS NULL OR c.employee_id = $2)
        AND ($3::text IS NULL OR c.status = $3)
        AND ($4::date IS NULL OR c.incurred_on >= $4) AND ($5::date IS NULL OR c.incurred_on <= $5)
      ORDER BY c.created_at DESC LIMIT $6 OFFSET $7`,
    [args.employeeIds ?? null, args.employeeId ?? null, args.status ?? null, args.from ?? null, args.to ?? null, limit + 1, args.offset ?? 0])
  return { claims: rows.slice(0, limit), hasMore: rows.length > limit }
}

export interface PerDiemRate { id: string; city_class: string; grade_code: string | null; rate_paise: string; half_day_pct: number; effective_from: string }
export async function listPerDiemRates(tx: PoolClient): Promise<PerDiemRate[]> {
  return (await tx.query<PerDiemRate>(`SELECT id, city_class, grade_code, rate_paise::text, half_day_pct, effective_from::text FROM per_diem_rates ORDER BY city_class, grade_code NULLS FIRST, effective_from DESC`)).rows
}
export async function upsertPerDiemRate(tx: PoolClient, r: { cityClass: string; gradeCode?: string | null; ratePaise: number; halfDayPct?: number; effectiveFrom?: string }): Promise<PerDiemRate> {
  const tid = await tenantId(tx)
  if (!['metro', 'tier1', 'tier2', 'other', 'international'].includes(r.cityClass)) throw new ExpenseError('VALIDATION_FAILED', 'cityClass is metro, tier1, tier2, other or international')
  if (!Number.isInteger(r.ratePaise) || r.ratePaise < 0) throw new ExpenseError('VALIDATION_FAILED', 'ratePaise is a whole number')
  const { rows } = await tx.query<PerDiemRate>(
    `INSERT INTO per_diem_rates (tenant_id, city_class, grade_code, rate_paise, half_day_pct, effective_from) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, city_class, grade_code, effective_from) DO UPDATE SET rate_paise = EXCLUDED.rate_paise, half_day_pct = EXCLUDED.half_day_pct
     RETURNING id, city_class, grade_code, rate_paise::text, half_day_pct, effective_from::text`,
    [tid, r.cityClass, r.gradeCode ?? null, r.ratePaise, r.halfDayPct ?? 50, r.effectiveFrom ?? new Date().toISOString().slice(0, 10)])
  return rows[0]!
}
/** The rate for a person's grade (else the all-grades rate) in force on a date. */
export async function perDiemRateFor(tx: PoolClient, args: { employeeId: string; cityClass: string; on: string }): Promise<PerDiemRate | null> {
  const posting = await currentPosting(tx, args.employeeId, args.on)
  const { rows } = await tx.query<PerDiemRate>(
    `SELECT id, city_class, grade_code, rate_paise::text, half_day_pct, effective_from::text FROM per_diem_rates
      WHERE city_class = $1 AND (grade_code = $2 OR grade_code IS NULL) AND effective_from <= $3::date
      ORDER BY grade_code NULLS LAST, effective_from DESC LIMIT 1`, [args.cityClass, posting?.grade_code ?? null, args.on])
  return rows[0] ?? null
}

export interface SubmitClaim {
  employeeId: string
  requestedByUserId: string
  categoryId: string
  incurredOn: string
  amountPaise?: number
  distanceKm?: number
  description: string
  merchant?: string | null
  receiptDocumentId?: string | null
  travelRequestId?: string | null
  costCentre?: string | null
  /** The person has looked at the earlier claim and says this one is different. */
  notADuplicate?: boolean
  /** A per-diem claim: priced from the rate table, no receipt, amount ignored. */
  perDiem?: { cityClass: string; days: number; halfDays?: number }
  fallbackChain: ChainCode
}

export async function submitClaim(tx: PoolClient, input: SubmitClaim): Promise<{ claim: Claim; approvalRequestId: string; chain: ChainCode }> {
  const tid = await tenantId(tx)
  const cat = (await tx.query<Category>(`SELECT ${CAT_COLS} FROM expense_categories WHERE id = $1 AND status = 'active'`, [input.categoryId])).rows[0]
  if (!cat) throw new ExpenseError('EXPENSE_CATEGORY_NOT_FOUND', 'choose an active expense category')
  if (!input.description?.trim()) throw new ExpenseError('VALIDATION_FAILED', 'say what the expense was for')
  const today = (await tx.query<{ d: string }>('SELECT CURRENT_DATE::text AS d')).rows[0]!.d
  if (input.incurredOn > today) throw new ExpenseError('VALIDATION_FAILED', 'an expense cannot be dated in the future')
  if ((Date.parse(today) - Date.parse(input.incurredOn)) / 86_400_000 > 90) throw new ExpenseError('CLAIM_TOO_OLD', 'expenses must be claimed within 90 days')

  // Mileage is priced by the category, never by the claimant; per-diem by the rate table.
  let amount = input.amountPaise ?? 0
  let perDiem: Record<string, unknown> | null = null
  if (input.perDiem) {
    const d = input.perDiem
    if (!Number.isInteger(d.days) || d.days < 0 || d.days > 90 || (d.halfDays !== undefined && (!Number.isInteger(d.halfDays) || d.halfDays < 0)) || d.days + (d.halfDays ?? 0) === 0) throw new ExpenseError('VALIDATION_FAILED', 'per-diem needs whole days and/or half days')
    const rate = await perDiemRateFor(tx, { employeeId: input.employeeId, cityClass: d.cityClass, on: input.incurredOn })
    if (!rate) throw new ExpenseError('PER_DIEM_RATE_MISSING', `no per-diem rate for ${d.cityClass}; ask HR to set one`)
    amount = d.days * Number(rate.rate_paise) + Math.round((d.halfDays ?? 0) * Number(rate.rate_paise) * rate.half_day_pct / 100)
    perDiem = { cityClass: d.cityClass, days: d.days, halfDays: d.halfDays ?? 0, ratePaise: Number(rate.rate_paise), halfDayPct: rate.half_day_pct }
  } else if (cat.mileage_rate_paise_per_km) {
    if (!input.distanceKm || input.distanceKm <= 0) throw new ExpenseError('VALIDATION_FAILED', 'a mileage claim needs the distance in km')
    amount = Math.round(input.distanceKm * Number(cat.mileage_rate_paise_per_km))
  }
  if (!Number.isInteger(amount) || amount <= 0) throw new ExpenseError('VALIDATION_FAILED', 'amount must be a positive whole number of paise')

  if (cat.per_claim_limit_paise && amount > Number(cat.per_claim_limit_paise)) {
    throw new ExpenseError('OVER_CLAIM_LIMIT', `${cat.name} is limited to ₹${(Number(cat.per_claim_limit_paise) / 100).toLocaleString('en-IN')} per claim`)
  }
  if (cat.monthly_limit_paise) {
    const { rows } = await tx.query<{ used: string }>(
      `SELECT coalesce(sum(amount_paise),0)::text AS used FROM expense_claims
        WHERE employee_id = $1 AND category_id = $2 AND status NOT IN ('rejected','cancelled')
          AND date_trunc('month', incurred_on) = date_trunc('month', $3::date)`,
      [input.employeeId, input.categoryId, input.incurredOn])
    if (Number(rows[0]!.used) + amount > Number(cat.monthly_limit_paise)) {
      throw new ExpenseError('OVER_MONTHLY_LIMIT', `${cat.name} is limited to ₹${(Number(cat.monthly_limit_paise) / 100).toLocaleString('en-IN')} a month; ₹${(Number(rows[0]!.used) / 100).toLocaleString('en-IN')} already claimed`)
    }
  }
  // 0 = a receipt is never required (mileage, small allowances); otherwise above the threshold.
  const receiptAbove = Number(cat.receipt_required_above_paise)
  if (receiptAbove > 0 && amount > receiptAbove && !input.receiptDocumentId && !cat.mileage_rate_paise_per_km && !perDiem) {
    throw new ExpenseError('RECEIPT_REQUIRED', `a receipt is required for ${cat.name} above ₹${(Number(cat.receipt_required_above_paise) / 100).toLocaleString('en-IN')}`)
  }
  if (!input.notADuplicate) {
    const dup = await tx.query<{ id: string }>(
      `SELECT id FROM expense_claims WHERE employee_id = $1 AND category_id = $2 AND incurred_on = $3 AND amount_paise = $4
         AND status NOT IN ('rejected','cancelled') LIMIT 1`, [input.employeeId, input.categoryId, input.incurredOn, amount])
    if (dup.rows[0]) throw new ExpenseError('DUPLICATE_CLAIM', `this looks like claim ${dup.rows[0].id} again (same day, category and amount); confirm it is a different expense`)
  }
  if (input.travelRequestId) {
    const trip = await tx.query(`SELECT 1 FROM travel_requests WHERE id = $1 AND employee_id = $2 AND status IN ('approved','advance_paid')`, [input.travelRequestId, input.employeeId])
    if (!trip.rowCount) throw new ExpenseError('TRAVEL_NOT_APPROVED', 'claims can only be filed against an approved trip of yours')
  }

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO expense_claims (tenant_id, employee_id, category_id, travel_request_id, incurred_on, amount_paise, distance_km,
        description, merchant, receipt_document_id, cost_centre, requested_by_user_id, per_diem)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING id`,
    [tid, input.employeeId, input.categoryId, input.travelRequestId ?? null, input.incurredOn, amount, input.distanceKm ?? null,
     input.description.trim().slice(0, 1000), input.merchant?.trim() || null, input.receiptDocumentId ?? null, input.costCentre ?? null, input.requestedByUserId, perDiem ? JSON.stringify(perDiem) : null])
  const id = rows[0]!.id
  const approval = await raiseWithPolicy(tx, {
    entityType: 'expense', entityId: id, requestedByUserId: input.requestedByUserId, subjectEmployeeId: input.employeeId,
    magnitude: amount / 100, fallback: input.fallbackChain,
    title: `Expense · ${cat.name} · ₹${(amount / 100).toLocaleString('en-IN')}`,
  })
  await tx.query(`UPDATE expense_claims SET approval_request_id = $2 WHERE id = $1`, [id, approval.requestId])
  // A chain with nobody to approve is approved on the spot.
  const st = (await tx.query<{ status: string }>(`SELECT status FROM approval_requests WHERE id = $1`, [approval.requestId])).rows[0]
  if (st?.status === 'approved') await settleClaimDecision(tx, { claimId: id, status: 'approved', actorUserId: input.requestedByUserId })
  return { claim: (await getClaim(tx, id))!, approvalRequestId: approval.requestId, chain: approval.chainCode }
}

/** After the approval engine decides. Idempotent: only a submitted claim moves. */
export async function settleClaimDecision(
  tx: PoolClient, args: { claimId: string; status: 'approved' | 'rejected'; actorUserId: string },
): Promise<{ changed: boolean }> {
  const { rowCount } = await tx.query(
    `UPDATE expense_claims SET status = $2, decided_at = now() WHERE id = $1 AND status = 'submitted'`, [args.claimId, args.status])
  if (!rowCount) return { changed: false }
  const c = (await getClaim(tx, args.claimId))!
  const applicant = (await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [c.employee_id])).rows[0]?.id
  if (applicant) {
    await notify(tx, {
      userId: applicant, eventType: `expense.${args.status}`,
      title: args.status === 'approved' ? 'Expense approved' : 'Expense not approved',
      body: `${c.category_name} · ₹${(Number(c.amount_paise) / 100).toLocaleString('en-IN')} on ${c.incurred_on}${args.status === 'approved' ? ' — paid with your next salary' : ''}`,
      entityType: 'expense', entityId: c.id, dedupeKey: `expense-${args.status}:${c.id}`,
    })
  }
  return { changed: true }
}

export async function cancelClaim(tx: PoolClient, claimId: string, employeeId: string): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE expense_claims SET status = 'cancelled', decided_at = now() WHERE id = $1 AND employee_id = $2 AND status IN ('submitted','approved')`,
    [claimId, employeeId])
  if (!rowCount) throw new ExpenseError('CLAIM_NOT_CANCELLABLE', 'only a submitted or approved (not yet paid) claim of yours can be cancelled')
  await tx.query(`UPDATE approval_requests SET status = 'withdrawn' WHERE id = (SELECT approval_request_id FROM expense_claims WHERE id = $1) AND status = 'pending'`, [claimId])
}

// ── payroll hooks ────────────────────────────────────────────────────────────

/**
 * At freeze: every approved claim (and approved travel advance) for this
 * person becomes lines on the run and is marked in_payroll. Returns the
 * ad-hoc lines to add to the row.
 */
export async function reimbursementsForFreeze(
  tx: PoolClient, args: { employeeId: string; runId: string },
): Promise<{ code: string; amountPaise: number; taxable: boolean; type?: 'earning' | 'deduction' }[]> {
  const lines: { code: string; amountPaise: number; taxable: boolean; type?: 'earning' | 'deduction' }[] = []
  const { rows } = await tx.query<{ taxable: boolean; total: string }>(
    `UPDATE expense_claims c SET status = 'in_payroll', reimbursement_run_id = $2
       FROM expense_categories k
      WHERE k.tenant_id = c.tenant_id AND k.id = c.category_id AND c.employee_id = $1 AND c.status = 'approved'
      RETURNING k.taxable, c.amount_paise::text AS total`, [args.employeeId, args.runId])
  const taxable = rows.filter((r) => r.taxable).reduce((s, r) => s + Number(r.total), 0)
  const exempt = rows.filter((r) => !r.taxable).reduce((s, r) => s + Number(r.total), 0)
  if (exempt > 0) lines.push({ code: 'REIMBURSEMENT', amountPaise: exempt, taxable: false })
  if (taxable > 0) lines.push({ code: 'REIMBURSEMENT_TAXABLE', amountPaise: taxable, taxable: true })

  const adv = await tx.query<{ total: string }>(
    `UPDATE travel_requests SET status = 'advance_paid', advance_run_id = $2
      WHERE employee_id = $1 AND status = 'approved' AND advance_paise > 0 AND advance_run_id IS NULL
      RETURNING advance_paise::text AS total`, [args.employeeId, args.runId])
  const advance = adv.rows.reduce((s, r) => s + Number(r.total), 0)
  if (advance > 0) lines.push({ code: 'TRAVEL_ADVANCE', amountPaise: advance, taxable: false })

  const rec = await tx.query<{ total: string }>(
    `UPDATE travel_requests SET recovery_run_id = $2
      WHERE employee_id = $1 AND status = 'settled' AND recovery_paise > 0 AND recovery_run_id IS NULL
      RETURNING recovery_paise::text AS total`, [args.employeeId, args.runId])
  const recovery = rec.rows.reduce((s, r) => s + Number(r.total), 0)
  if (recovery > 0) lines.push({ code: 'TRAVEL_ADVANCE_RECOVERY', amountPaise: recovery, taxable: false, type: 'deduction' })
  return lines
}

/** Unfreeze: the claims go back to approved so the next freeze picks them up. */
export async function releaseReimbursements(tx: PoolClient, runId: string): Promise<void> {
  await tx.query(`UPDATE expense_claims SET status = 'approved', reimbursement_run_id = NULL WHERE reimbursement_run_id = $1 AND status = 'in_payroll'`, [runId])
  await tx.query(`UPDATE travel_requests SET status = 'approved', advance_run_id = NULL WHERE advance_run_id = $1 AND status = 'advance_paid'`, [runId])
  await tx.query(`UPDATE travel_requests SET recovery_run_id = NULL WHERE recovery_run_id = $1`, [runId])
}

/** Lock: paid. */
export async function finalizeReimbursements(tx: PoolClient, runId: string): Promise<number> {
  const { rowCount } = await tx.query(
    `UPDATE expense_claims SET status = 'reimbursed', reimbursed_at = now() WHERE reimbursement_run_id = $1 AND status = 'in_payroll'`, [runId])
  return rowCount ?? 0
}

// ── travel ───────────────────────────────────────────────────────────────────

export interface Trip {
  id: string; employee_id: string; purpose: string; destination: string; starts_on: string; ends_on: string
  estimated_paise: string; advance_paise: string; status: string; approval_request_id: string | null; advance_run_id: string | null
  created_at: string; decided_at: string | null
  /** Derived: claims filed against the trip, and the balance against the advance. */
  claimed_paise: string; balance_paise: string
}
const TRIP_COLS = `t.id, t.employee_id, t.purpose, t.destination, t.starts_on::text, t.ends_on::text, t.estimated_paise::text, t.advance_paise::text,
  t.status, t.approval_request_id, t.advance_run_id, t.created_at::text, t.decided_at::text,
  coalesce((SELECT sum(amount_paise) FROM expense_claims c WHERE c.travel_request_id = t.id AND c.status IN ('approved','in_payroll','reimbursed')), 0)::text AS claimed_paise,
  (coalesce((SELECT sum(amount_paise) FROM expense_claims c WHERE c.travel_request_id = t.id AND c.status IN ('approved','in_payroll','reimbursed')), 0) - t.advance_paise)::text AS balance_paise`

export async function listTrips(tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; status?: string; limit?: number }): Promise<Trip[]> {
  const { rows } = await tx.query<Trip>(
    `SELECT ${TRIP_COLS} FROM travel_requests t
      WHERE ($1::uuid[] IS NULL OR t.employee_id = ANY($1)) AND ($2::uuid IS NULL OR t.employee_id = $2) AND ($3::text IS NULL OR t.status = $3)
      ORDER BY t.starts_on DESC LIMIT $4`, [args.employeeIds ?? null, args.employeeId ?? null, args.status ?? null, Math.min(args.limit ?? 50, 200)])
  return rows
}

export async function getTrip(tx: PoolClient, id: string): Promise<Trip | null> {
  const { rows } = await tx.query<Trip>(`SELECT ${TRIP_COLS} FROM travel_requests t WHERE t.id = $1`, [id])
  return rows[0] ?? null
}

export async function requestTravel(
  tx: PoolClient,
  input: { employeeId: string; requestedByUserId: string; purpose: string; destination: string; startsOn: string; endsOn: string; estimatedPaise?: number; advancePaise?: number; fallbackChain: ChainCode },
): Promise<{ trip: Trip; approvalRequestId: string }> {
  const tid = await tenantId(tx)
  if (!input.purpose?.trim() || !input.destination?.trim()) throw new ExpenseError('VALIDATION_FAILED', 'purpose and destination are required')
  if (input.endsOn < input.startsOn) throw new ExpenseError('VALIDATION_FAILED', 'the trip ends before it starts')
  const estimated = input.estimatedPaise ?? 0, advance = input.advancePaise ?? 0
  if (advance > estimated) throw new ExpenseError('VALIDATION_FAILED', 'an advance cannot exceed the estimate')
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO travel_requests (tenant_id, employee_id, purpose, destination, starts_on, ends_on, estimated_paise, advance_paise, requested_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [tid, input.employeeId, input.purpose.trim().slice(0, 500), input.destination.trim().slice(0, 200), input.startsOn, input.endsOn, estimated, advance, input.requestedByUserId])
  const id = rows[0]!.id
  const approval = await raiseWithPolicy(tx, {
    entityType: 'travel', entityId: id, requestedByUserId: input.requestedByUserId, subjectEmployeeId: input.employeeId,
    magnitude: estimated / 100, fallback: input.fallbackChain,
    title: `Travel · ${input.destination.trim()} · ${input.startsOn}`,
  })
  await tx.query(`UPDATE travel_requests SET approval_request_id = $2 WHERE id = $1`, [id, approval.requestId])
  const st = (await tx.query<{ status: string }>(`SELECT status FROM approval_requests WHERE id = $1`, [approval.requestId])).rows[0]
  if (st?.status === 'approved') await settleTravelDecision(tx, { tripId: id, status: 'approved' })
  return { trip: (await getTrip(tx, id))!, approvalRequestId: approval.requestId }
}

export async function settleTravelDecision(tx: PoolClient, args: { tripId: string; status: 'approved' | 'rejected' }): Promise<{ changed: boolean }> {
  const { rowCount } = await tx.query(
    `UPDATE travel_requests SET status = $2, decided_at = now() WHERE id = $1 AND status = 'pending'`, [args.tripId, args.status])
  return { changed: (rowCount ?? 0) > 0 }
}

/**
 * Once the trip's claims are in, the advance is settled. Claims above the
 * advance were already reimbursed as they were approved; an UNSPENT advance
 * is recovered as a deduction on the next payroll run.
 */
export async function settleTrip(tx: PoolClient, tripId: string, employeeId: string): Promise<Trip> {
  const trip = await getTrip(tx, tripId)
  if (!trip || trip.employee_id !== employeeId) throw new ExpenseError('NOT_FOUND', 'no such trip of yours')
  if (!['approved', 'advance_paid'].includes(trip.status)) throw new ExpenseError('TRIP_NOT_SETTLEABLE', `a ${trip.status} trip cannot be settled`)
  const open = await tx.query(`SELECT 1 FROM expense_claims WHERE travel_request_id = $1 AND status = 'submitted'`, [tripId])
  if (open.rowCount) throw new ExpenseError('TRIP_HAS_OPEN_CLAIMS', 'claims on this trip are still awaiting approval')
  const unspent = trip.status === 'advance_paid' ? Math.max(0, -Number(trip.balance_paise)) : 0
  await tx.query(`UPDATE travel_requests SET status = 'settled', recovery_paise = $2 WHERE id = $1`, [tripId, unspent])
  return (await getTrip(tx, tripId))!
}
