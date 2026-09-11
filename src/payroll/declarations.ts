/**
 * Tax declarations: the lifecycle around chapter-via.ts.
 *
 *   draft ──submit──▶ submitted ──verify──▶ verified   (freeze reads this)
 *                        │
 *                        └──reject──▶ rejected ──(employee edits)──▶ draft
 *
 * An employee owns the draft. Payroll owns verification, because a deduction
 * without a proof is an under-deduction the employer answers for. Freeze reads
 * ONLY verified declarations; a submitted-but-unverified one deducts nothing,
 * which errs on the side of the tax authority rather than the employee — the
 * refund route exists, the penalty route is worse.
 */
import type { PoolClient } from 'pg'
import {
  allowableDeductions, type Allowance, type Declaration, type Regime, type SalaryFacts,
} from './chapter-via.ts'

export class DeclarationError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'DeclarationError'
  }
}

export interface TaxDeclaration {
  id: string
  employee_id: string
  fiscal_year: string
  regime: Regime
  declared: Declaration
  status: 'draft' | 'submitted' | 'verified' | 'rejected'
  proof_document_ids: string[]
  submitted_at: string | null
  verified_at: string | null
  verified_by_user_id: string | null
  rejection_reason: string | null
  updated_at: string
}

const COLUMNS = `id, employee_id, fiscal_year, regime, declared, status, proof_document_ids,
  submitted_at, verified_at, verified_by_user_id, rejection_reason, updated_at`

async function tenantId(tx: PoolClient): Promise<string> {
  const { rows } = await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')
  const t = rows[0]?.t
  if (!t) throw new DeclarationError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}

const FY = /^\d{4}-\d{2}$/

/** Only non-negative paise integers survive; anything else is dropped. */
function sanitise(input: Record<string, unknown>): Declaration {
  const out: Declaration = {}
  const numeric: (keyof Declaration)[] = [
    'section80cPaise', 'section80ccd1bPaise', 'section80dSelfPaise', 'section80dParentsPaise',
    'section80ePaise', 'section24bPaise', 'section80gPaise', 'rentPaidAnnualPaise',
  ]
  for (const key of numeric) {
    const value = Number(input[key])
    if (Number.isFinite(value) && value >= 0 && value <= 1_000_000_000_00) {
      ;(out as Record<string, unknown>)[key] = Math.round(value)
    }
  }
  if (typeof input.metro === 'boolean') out.metro = input.metro
  if (typeof input.parentsSenior === 'boolean') out.parentsSenior = input.parentsSenior
  return out
}

export async function getDeclaration(
  tx: PoolClient,
  employeeId: string,
  fiscalYear: string,
): Promise<TaxDeclaration | null> {
  const { rows } = await tx.query<TaxDeclaration>(
    `SELECT ${COLUMNS} FROM tax_declarations WHERE employee_id = $1 AND fiscal_year = $2`,
    [employeeId, fiscalYear],
  )
  return rows[0] ?? null
}

/**
 * Creates or updates the employee's own declaration.
 *
 * Editing a verified declaration returns it to draft: whatever payroll checked
 * is no longer what is on file, so it has to be checked again.
 */
export async function saveDeclaration(
  tx: PoolClient,
  args: {
    employeeId: string
    fiscalYear: string
    regime: Regime
    declared: Record<string, unknown>
    proofDocumentIds?: readonly string[]
  },
): Promise<TaxDeclaration> {
  const tid = await tenantId(tx)
  if (!FY.test(args.fiscalYear)) {
    throw new DeclarationError('VALIDATION_FAILED', 'fiscalYear must look like 2026-27')
  }
  if (args.regime !== 'old' && args.regime !== 'new') {
    throw new DeclarationError('VALIDATION_FAILED', 'regime must be "old" or "new"')
  }
  const declared = sanitise(args.declared)

  const { rows } = await tx.query<TaxDeclaration>(
    `INSERT INTO tax_declarations
       (tenant_id, employee_id, fiscal_year, regime, declared, proof_document_ids, status)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::uuid[],'draft')
     ON CONFLICT (tenant_id, employee_id, fiscal_year) DO UPDATE
       SET regime = EXCLUDED.regime,
           declared = EXCLUDED.declared,
           proof_document_ids = EXCLUDED.proof_document_ids,
           status = 'draft',
           submitted_at = NULL, verified_at = NULL, verified_by_user_id = NULL,
           rejection_reason = NULL,
           updated_at = now()
     RETURNING ${COLUMNS}`,
    [tid, args.employeeId, args.fiscalYear, args.regime, JSON.stringify(declared),
     args.proofDocumentIds ?? []],
  )
  return rows[0]!
}

/** The employee says they are done editing. */
export async function submitDeclaration(
  tx: PoolClient,
  employeeId: string,
  fiscalYear: string,
): Promise<TaxDeclaration> {
  const { rows } = await tx.query<TaxDeclaration>(
    `UPDATE tax_declarations
        SET status = 'submitted', submitted_at = now(), updated_at = now()
      WHERE employee_id = $1 AND fiscal_year = $2 AND status IN ('draft', 'rejected')
      RETURNING ${COLUMNS}`,
    [employeeId, fiscalYear],
  )
  if (!rows[0]) {
    throw new DeclarationError('DECLARATION_NOT_EDITABLE',
      'there is no draft declaration for this year to submit')
  }
  return rows[0]
}

/** Payroll has seen the proofs. From here, freeze will use it. */
export async function verifyDeclaration(
  tx: PoolClient,
  args: { id: string; verifiedByUserId: string },
): Promise<TaxDeclaration> {
  const { rows } = await tx.query<TaxDeclaration>(
    `UPDATE tax_declarations
        SET status = 'verified', verified_at = now(), verified_by_user_id = $2, updated_at = now()
      WHERE id = $1 AND status = 'submitted'
      RETURNING ${COLUMNS}`,
    [args.id, args.verifiedByUserId],
  )
  if (!rows[0]) {
    throw new DeclarationError('DECLARATION_NOT_SUBMITTED',
      'only a submitted declaration can be verified')
  }
  return rows[0]
}

export async function rejectDeclaration(
  tx: PoolClient,
  args: { id: string; reason: string },
): Promise<TaxDeclaration> {
  if (!args.reason.trim()) {
    throw new DeclarationError('REASON_REQUIRED', 'a rejection needs a reason the employee can act on')
  }
  const { rows } = await tx.query<TaxDeclaration>(
    `UPDATE tax_declarations
        SET status = 'rejected', rejection_reason = $2, updated_at = now()
      WHERE id = $1 AND status = 'submitted'
      RETURNING ${COLUMNS}`,
    [args.id, args.reason.trim()],
  )
  if (!rows[0]) {
    throw new DeclarationError('DECLARATION_NOT_SUBMITTED',
      'only a submitted declaration can be rejected')
  }
  return rows[0]
}

/** Payroll's queue for a year. */
export async function listDeclarations(
  tx: PoolClient,
  fiscalYear: string,
  status?: TaxDeclaration['status'],
): Promise<TaxDeclaration[]> {
  const { rows } = await tx.query<TaxDeclaration>(
    `SELECT ${COLUMNS} FROM tax_declarations
      WHERE fiscal_year = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY status, updated_at DESC`,
    [fiscalYear, status ?? null],
  )
  return rows
}

/**
 * What freeze should subtract for this employee.
 *
 * Verified declarations only. A missing or unverified declaration is zero
 * deductions on the regime the employee chose (or the new regime, which is the
 * statutory default), so payroll never under-deducts on an unproven claim.
 */
export async function allowanceFor(
  tx: PoolClient,
  args: { employeeId: string; fiscalYear: string; salary: SalaryFacts },
): Promise<{ regime: Regime; allowance: Allowance; declarationId: string | null }> {
  const declaration = await getDeclaration(tx, args.employeeId, args.fiscalYear)
  const regime: Regime = declaration?.regime ?? 'new'

  if (!declaration || declaration.status !== 'verified') {
    return {
      regime,
      declarationId: declaration?.id ?? null,
      allowance: {
        regime, totalPaise: 0, hraExemptionPaise: 0, lines: [],
        notes: [declaration
          ? `declaration is ${declaration.status}; deductions apply once payroll verifies it`
          : 'no declaration on file for this year'],
      },
    }
  }

  return {
    regime,
    declarationId: declaration.id,
    allowance: allowableDeductions(declaration.declared, args.salary, args.fiscalYear, regime),
  }
}
