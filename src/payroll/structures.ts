/**
 * Salary components and structures — see 040_salary_structures.sql.
 *
 * `resolveStructure` is pure: a structure and an annual figure in, monthly
 * components in paise out. Lines evaluate in order, so a percentage of BASIC
 * needs BASIC above it; `balance` takes what is left and there is exactly one.
 * Every line rounds to the rupee as it is produced, and the balance absorbs
 * the rounding, so the components always add up to the monthly figure.
 */
import type { PoolClient } from 'pg'

export class StructureError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'StructureError'
  }
}

export interface Component {
  id: string
  code: string
  name: string
  kind: 'earning' | 'deduction'
  taxable: boolean
  pf_wage: boolean
  esi_wage: boolean
  bill_required: boolean
  sort_order: number
  status: 'active' | 'retired'
}

export type Formula =
  | { type: 'percent_of'; of: 'CTC' | string; pct: number }
  | { type: 'fixed'; paise: number }
  | { type: 'balance' }

export interface Line { component: string; formula: Formula }

export interface Structure {
  id: string
  code: string
  name: string
  lines: Line[]
  grade_codes: string[]
  /** Gross = CTC − employer PF; the balance line absorbs it. */
  ctc_includes_employer_pf: boolean
  status: 'active' | 'retired'
}

export interface EmployerPf {
  rate: number
  wageCeilingPaise: number
  /** Codes that are PF wages (from the component master; basic + DA by convention). */
  pfWageCodes: ReadonlySet<string>
  onFullWage?: boolean
}

const CODE = /^[A-Z][A-Z0-9_]{0,23}$/
const C_COLS = 'id, code, name, kind, taxable, pf_wage, esi_wage, bill_required, sort_order, status'
const S_COLS = 'id, code, name, lines, grade_codes, ctc_includes_employer_pf, status'

export async function listComponents(tx: PoolClient, opts: { includeRetired?: boolean } = {}): Promise<Component[]> {
  const { rows } = await tx.query<Component>(`SELECT ${C_COLS} FROM salary_components WHERE $1 OR status = 'active' ORDER BY sort_order, code`, [opts.includeRetired ?? false])
  return rows
}

export async function createComponent(
  tx: PoolClient,
  i: { code: string; name: string; kind: 'earning' | 'deduction'; taxable?: boolean; pfWage?: boolean; esiWage?: boolean; billRequired?: boolean; sortOrder?: number },
): Promise<Component> {
  const code = i.code.trim().toUpperCase()
  if (!CODE.test(code)) throw new StructureError('VALIDATION_FAILED', 'code starts with a letter: letters, digits, _ (max 24)')
  if (!i.name?.trim() || i.name.length > 120) throw new StructureError('VALIDATION_FAILED', 'name is 1–120 characters')
  if (i.kind !== 'earning' && i.kind !== 'deduction') throw new StructureError('VALIDATION_FAILED', 'kind is earning or deduction')
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  if ((await tx.query(`SELECT 1 FROM salary_components WHERE code = $1`, [code])).rowCount) throw new StructureError('COMPONENT_EXISTS', `component ${code} already exists`)
  const { rows } = await tx.query<Component>(
    `INSERT INTO salary_components (tenant_id, code, name, kind, taxable, pf_wage, esi_wage, bill_required, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${C_COLS}`,
    [tid, code, i.name.trim(), i.kind, i.taxable ?? true, i.pfWage ?? false, i.esiWage ?? true, i.billRequired ?? false, i.sortOrder ?? 0])
  return rows[0]!
}

/** Flags decide tax and PF for every payslip that names the code, so only the label moves. */
export async function updateComponent(tx: PoolClient, id: string, patch: { name?: string; billRequired?: boolean; sortOrder?: number }): Promise<Component> {
  const { rows } = await tx.query<Component>(
    `UPDATE salary_components SET name = coalesce($2, name), bill_required = coalesce($3, bill_required), sort_order = coalesce($4, sort_order)
      WHERE id = $1 AND status = 'active' RETURNING ${C_COLS}`, [id, patch.name?.trim() || null, patch.billRequired ?? null, patch.sortOrder ?? null])
  if (!rows[0]) throw new StructureError('NOT_FOUND', 'no active component with that id')
  return rows[0]
}

export async function retireComponent(tx: PoolClient, id: string): Promise<{ component: Component; usedByStructures: string[] }> {
  const { rows } = await tx.query<Component>(`SELECT ${C_COLS} FROM salary_components WHERE id = $1 AND status = 'active'`, [id])
  const c = rows[0]
  if (!c) throw new StructureError('NOT_FOUND', 'no active component with that id')
  const { rows: used } = await tx.query<{ code: string }>(
    `SELECT code FROM salary_structures WHERE status = 'active' AND lines @> $1::jsonb`, [JSON.stringify([{ component: c.code }])])
  if (used.length) throw new StructureError('COMPONENT_IN_USE', `retire the structures that use ${c.code} first: ${used.map((u) => u.code).join(', ')}`)
  await tx.query(`UPDATE salary_components SET status = 'retired', retired_at = now() WHERE id = $1`, [id])
  return { component: { ...c, status: 'retired' }, usedByStructures: [] }
}

/** Static checks a structure must pass before it exists: codes known, formulas sane, one balance, references above. */
export function validateLines(lines: unknown, known: Set<string>): Line[] {
  if (!Array.isArray(lines) || lines.length === 0) throw new StructureError('VALIDATION_FAILED', 'a structure needs at least one line')
  const seen = new Set<string>()
  let balances = 0
  const out: Line[] = []
  for (const raw of lines as { component?: unknown; formula?: Record<string, unknown> }[]) {
    const component = String(raw.component ?? '').toUpperCase()
    if (!known.has(component)) throw new StructureError('UNKNOWN_COMPONENT', `"${component}" is not a defined salary component`)
    if (seen.has(component)) throw new StructureError('VALIDATION_FAILED', `${component} appears twice`)
    const f = raw.formula ?? {}
    let formula: Formula
    if (f.type === 'percent_of') {
      const of = String(f.of ?? '').toUpperCase(), pct = Number(f.pct)
      if (!(pct > 0 && pct <= 100)) throw new StructureError('VALIDATION_FAILED', `${component}: pct must be between 0 and 100`)
      if (of !== 'CTC' && !seen.has(of)) throw new StructureError('VALIDATION_FAILED', `${component}: "${of}" must be CTC or a component listed above it`)
      formula = { type: 'percent_of', of, pct }
    } else if (f.type === 'fixed') {
      const paise = Number(f.paise)
      if (!Number.isSafeInteger(paise) || paise < 0) throw new StructureError('VALIDATION_FAILED', `${component}: fixed paise must be a non-negative integer`)
      formula = { type: 'fixed', paise }
    } else if (f.type === 'balance') {
      balances++
      formula = { type: 'balance' }
    } else {
      throw new StructureError('VALIDATION_FAILED', `${component}: formula type must be percent_of, fixed or balance`)
    }
    seen.add(component)
    out.push({ component, formula })
  }
  if (balances !== 1) throw new StructureError('VALIDATION_FAILED', 'exactly one line must be the balance')
  return out
}

/**
 * Monthly components in paise from an annual figure. Pure.
 *
 * With `employerPf`, the annual figure is CTC: percentages still read off it
 * (an offer's "basic 50% of CTC" means of CTC), the employer's PF on the PF
 * wages is computed, and the balance line hands out what is left AFTER it —
 * so components sum to gross, not CTC, and gross + employer PF = CTC.
 */
export function resolveStructure(lines: readonly Line[], annualPaise: number, employerPf?: EmployerPf): Record<string, number> {
  if (!Number.isSafeInteger(annualPaise) || annualPaise <= 0) throw new StructureError('VALIDATION_FAILED', 'annual pay must be a positive integer in paise')
  const monthly = Math.round(annualPaise / 12 / 100) * 100
  const out: Record<string, number> = {}
  let used = 0
  let balanceCode: string | null = null
  for (const l of lines) {
    let v = 0
    if (l.formula.type === 'percent_of') {
      const base = l.formula.of === 'CTC' ? monthly : (out[l.formula.of] ?? 0)
      v = Math.round(base * l.formula.pct / 100 / 100) * 100
    } else if (l.formula.type === 'fixed') {
      v = l.formula.paise
    } else {
      balanceCode = l.component
      continue
    }
    out[l.component] = v
    used += v
  }
  let employerPfPaise = 0
  if (employerPf) {
    const pfWage = Object.entries(out).filter(([code]) => employerPf.pfWageCodes.has(code)).reduce((n, [, v]) => n + v, 0)
    const base = employerPf.onFullWage ? pfWage : Math.min(pfWage, employerPf.wageCeilingPaise)
    employerPfPaise = Math.round(base * employerPf.rate / 100) * 100
  }
  const rest = monthly - used - employerPfPaise
  if (rest < 0) {
    throw new StructureError('STRUCTURE_EXCEEDS_PAY',
      `the fixed and percentage lines${employerPfPaise ? ' plus employer PF' : ''} come to ${((used + employerPfPaise) / 100).toFixed(0)} a month, above the ${(monthly / 100).toFixed(0)} available`)
  }
  out[balanceCode!] = rest
  return out
}

/** The employer PF a CTC-inclusive structure set aside, so a preview can show it. */
export function employerPfOf(components: Record<string, number>, ctcAnnualPaise: number): number {
  return Math.round(ctcAnnualPaise / 12 / 100) * 100 - Object.values(components).reduce((n, v) => n + v, 0)
}

export async function listStructures(tx: PoolClient, opts: { includeRetired?: boolean } = {}): Promise<Structure[]> {
  const { rows } = await tx.query<Structure>(`SELECT ${S_COLS} FROM salary_structures WHERE $1 OR status = 'active' ORDER BY code`, [opts.includeRetired ?? false])
  return rows
}

export async function createStructure(tx: PoolClient, i: { code: string; name: string; lines: unknown; gradeCodes?: string[]; ctcIncludesEmployerPf?: boolean }): Promise<Structure> {
  const code = i.code.trim().toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9_-]{0,23}$/.test(code)) throw new StructureError('VALIDATION_FAILED', 'code is 1–24 characters: letters, digits, _ or -')
  if (!i.name?.trim() || i.name.length > 120) throw new StructureError('VALIDATION_FAILED', 'name is 1–120 characters')
  const known = new Set((await listComponents(tx)).filter((c) => c.kind === 'earning').map((c) => c.code))
  const lines = validateLines(i.lines, known)
  resolveStructure(lines, 12_000_000)   // a smoke run: a structure that cannot resolve ₹1L a month is malformed
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  if ((await tx.query(`SELECT 1 FROM salary_structures WHERE code = $1`, [code])).rowCount) throw new StructureError('STRUCTURE_EXISTS', `structure ${code} already exists`)
  const { rows } = await tx.query<Structure>(
    `INSERT INTO salary_structures (tenant_id, code, name, lines, grade_codes, ctc_includes_employer_pf) VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING ${S_COLS}`,
    [tid, code, i.name.trim(), JSON.stringify(lines), (i.gradeCodes ?? []).map((g) => g.toUpperCase()), i.ctcIncludesEmployerPf ?? false])
  return rows[0]!
}

export async function retireStructure(tx: PoolClient, id: string): Promise<Structure> {
  const { rows } = await tx.query<Structure>(`UPDATE salary_structures SET status = 'retired', retired_at = now() WHERE id = $1 AND status = 'active' RETURNING ${S_COLS}`, [id])
  if (!rows[0]) throw new StructureError('NOT_FOUND', 'no active structure with that id')
  return rows[0]
}

/** The employer-PF inputs a CTC-inclusive structure needs, from the statutory config and the component master. */
export async function employerPfFor(tx: PoolClient, statutory: { pf_employer_rate: number; pf_wage_ceiling_paise: bigint }, onFullWage: boolean): Promise<EmployerPf> {
  const flags = await componentFlags(tx)
  return {
    rate: statutory.pf_employer_rate, wageCeilingPaise: Number(statutory.pf_wage_ceiling_paise),
    pfWageCodes: flags?.pfWageCodes ?? new Set(['BASIC', 'DA']), onFullWage,
  }
}

/** Resolves with employer PF when the structure is CTC-inclusive. */
export async function resolveForEmployee(
  tx: PoolClient, structure: Structure, annualPaise: number,
  statutory: { pf_employer_rate: number; pf_wage_ceiling_paise: bigint }, onFullWage: boolean,
): Promise<Record<string, number>> {
  return resolveStructure(structure.lines, annualPaise, structure.ctc_includes_employer_pf ? await employerPfFor(tx, statutory, onFullWage) : undefined)
}

export async function structureByCode(tx: PoolClient, code: string): Promise<Structure> {
  const { rows } = await tx.query<Structure>(`SELECT ${S_COLS} FROM salary_structures WHERE code = upper($1) AND status = 'active'`, [code])
  if (!rows[0]) throw new StructureError('NOT_FOUND', `no active structure ${code.toUpperCase()}`)
  return rows[0]
}

/**
 * The enforcement point for hand-entered components: once a company has
 * defined any earning component, every code must be one of them, upper-cased.
 * With none defined, free text stands (the engine's basic/da convention).
 */
export async function normaliseComponents(tx: PoolClient, components: Record<string, number>): Promise<Record<string, number>> {
  const known = await listComponents(tx)
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(components)) {
    if (!Number.isSafeInteger(v) || v < 0) throw new StructureError('VALIDATION_FAILED', `${k}: monthly paise must be a non-negative integer`)
    out[known.length ? k.toUpperCase() : k] = v
  }
  if (known.length) {
    const codes = new Set(known.filter((c) => c.kind === 'earning').map((c) => c.code))
    for (const k of Object.keys(out)) if (!codes.has(k)) throw new StructureError('UNKNOWN_COMPONENT', `"${k}" is not a defined salary component`)
  }
  return out
}

/** What the engine needs from the master: which codes are PF wages and which are tax-free. */
export async function componentFlags(tx: PoolClient): Promise<{ pfWageCodes: Set<string>; nonTaxableCodes: Set<string>; nonEsiCodes: Set<string> } | null> {
  const all = await listComponents(tx, { includeRetired: true })
  if (!all.length) return null
  return {
    pfWageCodes: new Set(all.filter((c) => c.pf_wage).map((c) => c.code)),
    nonTaxableCodes: new Set(all.filter((c) => !c.taxable).map((c) => c.code)),
    nonEsiCodes: new Set(all.filter((c) => !c.esi_wage).map((c) => c.code)),
  }
}
