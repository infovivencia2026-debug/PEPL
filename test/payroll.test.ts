import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { computePayroll, toRupee, validateRun, type EngineOptions, type PayrollInput } from '../src/payroll/engine.ts'
import {
  approve, calculate, createRun, delta, freezeInputs, getRun, lock, revise,
  unfreezeInputs, validate, PayrollError, type FreezeRow,
} from '../src/payroll/run.ts'

let A: Tenant
let B: Tenant
let periodId: string
let statutoryId: string

const PROCESSOR = '50000000-0000-0000-0000-000000000005'
const APPROVER = '60000000-0000-0000-0000-000000000006'

const L = (rupees: number): number => rupees * 100

/** Baseline statutory values used by the golden cases. */
const STATUTORY = {
  pf_employee_rate: 0.12,
  pf_employer_rate: 0.12,
  pf_wage_ceiling_paise: BigInt(L(15_000)),
  esi_employee_rate: 0.0075,
  esi_employer_rate: 0.0325,
  esi_gross_threshold_paise: BigInt(L(21_000)),
}

const PT = (state: string, gross: bigint): bigint => {
  if (state !== 'TS') return 0n
  const g = Number(gross)
  if (g < L(15_000)) return 0n
  if (g < L(20_000)) return BigInt(L(150))
  return BigInt(L(200))
}

const OPTS: EngineOptions = {
  statutory: STATUTORY,
  ptAmountPaise: PT,
  pfOnFullWage: false,
  lopBasis: 'calendar_days',
}

const input = (over: Partial<PayrollInput> = {}): PayrollInput => ({
  employeeId: 'e1',
  calendarDays: 30,
  payableDays: 30,
  lopDays: 0,
  monthlyComponents: { basic: L(20_000), hra: L(8_000), special: L(12_000) },
  stateCode: 'TS',
  pfApplicable: true,
  esiApplicable: false,
  taxRegime: 'new',
  adhoc: [],
  ...over,
})

const lineOf = (c: ReturnType<typeof computePayroll>, code: string): number =>
  Number(c.lines.find((l) => l.code === code)?.amountPaise ?? 0n)

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})

beforeEach(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
  await controlPool.query('TRUNCATE statutory_configs, pt_slabs CASCADE')
  const { rows } = await controlPool.query<{ id: string }>(
    `INSERT INTO statutory_configs
       (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise,
        esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2) RETURNING id`,
    [String(STATUTORY.pf_wage_ceiling_paise), String(STATUTORY.esi_gross_threshold_paise)],
  )
  statutoryId = rows[0]!.id

  periodId = await withTenant(A.id, async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date)
       VALUES ($1, '2026-09', DATE '2026-09-01', DATE '2026-09-30', DATE '2026-10-01')
       RETURNING id`,
      [A.id],
    )
    return r.rows[0]!.id
  })
})

afterAll(async () => {
  await closePools()
  await controlPool.end()
})

// ---------------------------------------------------------------------------
// Engine — golden cases
// ---------------------------------------------------------------------------
describe('golden: a plain full-month salaried employee', () => {
  it('computes gross, PF, PT and net', async () => {
    const c = computePayroll(input(), OPTS)
    expect(Number(c.grossPaise)).toBe(L(40_000))
    // PF wage is basic only (20,000) but the ceiling caps it at 15,000
    expect(lineOf(c, 'PF_EE')).toBe(L(1_800))
    expect(lineOf(c, 'PF_ER')).toBe(L(1_800))
    expect(lineOf(c, 'PT')).toBe(L(200))
    expect(lineOf(c, 'ESI_EE')).toBe(0)
    expect(Number(c.netPaise)).toBe(L(40_000) - L(1_800) - L(200))
  })

  it('employer contributions are never deducted from the employee', () => {
    const c = computePayroll(input(), OPTS)
    expect(Number(c.deductionsPaise)).toBe(L(1_800) + L(200))
  })
})

describe('golden: provident fund at, above and beyond the ceiling', () => {
  it('caps PF wages at the statutory ceiling by default', () => {
    const c = computePayroll(input({ monthlyComponents: { basic: L(50_000) } }), OPTS)
    expect(lineOf(c, 'PF_EE')).toBe(L(1_800))
    expect(c.lines.find((l) => l.code === 'PF_EE')?.note?.capped).toBe(true)
  })

  it('contributes on full wages when the tenant elects to', () => {
    const c = computePayroll(
      input({ monthlyComponents: { basic: L(50_000) } }),
      { ...OPTS, pfOnFullWage: true },
    )
    expect(lineOf(c, 'PF_EE')).toBe(L(6_000))
  })

  it('is omitted entirely when PF does not apply', () => {
    const c = computePayroll(input({ pfApplicable: false }), OPTS)
    expect(lineOf(c, 'PF_EE')).toBe(0)
  })

  it('uses basic + DA as the PF wage, not gross', () => {
    const c = computePayroll(
      input({ monthlyComponents: { basic: L(10_000), da: L(2_000), hra: L(30_000) } }),
      OPTS,
    )
    // PF wage = 12,000 (under the ceiling) -> 12% = 1,440
    expect(lineOf(c, 'PF_EE')).toBe(L(1_440))
  })
})

describe('golden: ESI threshold', () => {
  it('applies below the threshold', () => {
    const c = computePayroll(
      input({ esiApplicable: true, monthlyComponents: { basic: L(10_000), hra: L(5_000) } }),
      OPTS,
    )
    expect(Number(c.grossPaise)).toBe(L(15_000))
    expect(lineOf(c, 'ESI_EE')).toBe(L(113)) // 0.75% of 15,000 = 112.5, rounded
  })

  it('does not apply above the threshold', () => {
    const c = computePayroll(input({ esiApplicable: true }), OPTS) // gross 40,000
    expect(lineOf(c, 'ESI_EE')).toBe(0)
  })

  it('applies exactly AT the threshold', () => {
    const c = computePayroll(
      input({ esiApplicable: true, monthlyComponents: { basic: L(21_000) } }),
      OPTS,
    )
    expect(Number(c.grossPaise)).toBe(L(21_000))
    expect(lineOf(c, 'ESI_EE')).toBeGreaterThan(0)
  })
})

describe('golden: loss of pay', () => {
  it('prorates on calendar days', () => {
    const c = computePayroll(input({ lopDays: 3, payableDays: 27 }), OPTS)
    // 40,000 * 3/30 = 4,000
    expect(lineOf(c, 'LOP')).toBe(L(4_000))
    expect(Number(c.grossPaise)).toBe(L(36_000))
  })

  it('honours a fixed-30 basis in a 31-day month', () => {
    const c = computePayroll(
      input({ calendarDays: 31, lopDays: 1, payableDays: 30 }),
      { ...OPTS, lopBasis: 'fixed_30' },
    )
    expect(lineOf(c, 'LOP')).toBe(Math.round(L(40_000) / 30 / 100) * 100)
  })

  it('a half-day of LOP is half the deduction, rounded to the rupee', () => {
    const c = computePayroll(input({ lopDays: 0.5, payableDays: 29.5 }), OPTS)
    // 40,000 * 0.5/30 = 666.666..., and every component rounds to the rupee
    expect(lineOf(c, 'LOP')).toBe(L(667))
  })

  it('reduces PF along with the wage', () => {
    const full = computePayroll(input(), OPTS)
    const withLop = computePayroll(input({ lopDays: 15, payableDays: 15 }), OPTS)
    expect(lineOf(withLop, 'PF_EE')).toBeLessThan(lineOf(full, 'PF_EE'))
  })
})

describe('golden: joiners, leavers and ad-hoc pay', () => {
  it('prorates a mid-month joiner', () => {
    const c = computePayroll(
      input({ joinedMidPeriod: true, payableDays: 15, calendarDays: 30 }),
      OPTS,
    )
    expect(Number(c.grossPaise)).toBe(L(20_000))
  })

  it('adds ad-hoc earnings such as an incentive or arrear', () => {
    const c = computePayroll(
      input({ adhoc: [{ code: 'INCENTIVE', amountPaise: L(5_000) }, { code: 'ARREAR', amountPaise: L(1_200) }] }),
      OPTS,
    )
    expect(Number(c.grossPaise)).toBe(L(46_200))
    expect(lineOf(c, 'INCENTIVE')).toBe(L(5_000))
  })
})

describe('golden: professional tax slabs', () => {
  it('picks the slab for the gross', () => {
    expect(lineOf(computePayroll(input({ monthlyComponents: { basic: L(10_000) } }), OPTS), 'PT')).toBe(0)
    expect(lineOf(computePayroll(input({ monthlyComponents: { basic: L(16_000) } }), OPTS), 'PT')).toBe(L(150))
    expect(lineOf(computePayroll(input(), OPTS), 'PT')).toBe(L(200))
  })

  it('is zero in a state with no professional tax', () => {
    expect(lineOf(computePayroll(input({ stateCode: 'XX' }), OPTS), 'PT')).toBe(0)
  })
})

describe('rounding', () => {
  it('rounds every component to the rupee', () => {
    expect(toRupee(12_345)).toBe(12_300n)
    expect(toRupee(12_355)).toBe(12_400n)
  })

  it('gross is the sum of rounded lines, so the payslip adds up', () => {
    const c = computePayroll(
      input({ monthlyComponents: { basic: 3_333_33, hra: 1_111_11, special: 777_77 } }),
      OPTS,
    )
    const earnings = c.lines.filter((l) => l.type === 'earning').reduce((s, l) => s + l.amountPaise, 0n)
    expect(c.grossPaise).toBe(earnings)
    expect(Number(c.grossPaise) % 100).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Run orchestration
// ---------------------------------------------------------------------------
const freezeRow = (employeeId: string, over: Partial<FreezeRow> = {}): FreezeRow => ({
  employeeId,
  calendarDays: 30,
  payableDays: 30,
  lopDays: 0,
  monthlyComponents: { basic: L(20_000), hra: L(8_000), special: L(12_000) },
  annualCtcPaise: L(480_000),
  stateCode: 'TS',
  pfApplicable: true,
  ...over,
})

async function runToLocked(tenant: Tenant, rows?: FreezeRow[]): Promise<string> {
  return withTenant(tenant.id, async (tx) => {
    const runId = await createRun(tx, { periodId, processedByUserId: PROCESSOR })
    await freezeInputs(tx, runId, rows ?? [freezeRow(tenant.employeeId)], { lop_basis: 'calendar_days' }, statutoryId)
    await calculate(tx, runId, OPTS)
    await validate(tx, runId, { ...OPTS, variancePct: 25 })
    await approve(tx, runId, APPROVER, { requireSeparateApprover: true })
    await lock(tx, runId, APPROVER, { requireSeparateApprover: true })
    return runId
  })
}

/** An open run in a DIFFERENT period (a second run in the same period collides on revision). */
async function openRunElsewhere(withInputs: boolean): Promise<string> {
  return withTenant(A.id, async (tx) => {
    const p = await tx.query<{ id: string }>(
      `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date)
       VALUES ($1, '2026-10', DATE '2026-10-01', DATE '2026-10-31', DATE '2026-11-01') RETURNING id`, [A.id])
    const id = await createRun(tx, { periodId: p.rows[0]!.id, processedByUserId: PROCESSOR })
    if (withInputs) await freezeInputs(tx, id, [freezeRow(A.employeeId)], { lop_basis: 'calendar_days' }, statutoryId)
    return id
  })
}

describe('the run lifecycle', () => {
  it('walks draft -> frozen -> calculated -> validated -> approved -> locked', async () => {
    const runId = await runToLocked(A)
    const run = await withTenant(A.id, (tx) => getRun(tx, runId))
    expect(run.status).toBe('locked')
  })

  it('refuses to calculate before inputs are frozen', async () => {
    await expect(
      withTenant(A.id, async (tx) => {
        const runId = await createRun(tx, { periodId, processedByUserId: PROCESSOR })
        return calculate(tx, runId, OPTS)
      }),
    ).rejects.toThrow(/requires inputs_frozen/)
  })

  it('allows unfreezing before calculation and refuses after', async () => {
    await withTenant(A.id, async (tx) => {
      const runId = await createRun(tx, { periodId, processedByUserId: PROCESSOR })
      await freezeInputs(tx, runId, [freezeRow(A.employeeId)], {}, statutoryId)
      await unfreezeInputs(tx, runId)
      expect((await getRun(tx, runId)).status).toBe('draft')

      await freezeInputs(tx, runId, [freezeRow(A.employeeId)], {}, statutoryId)
      await calculate(tx, runId, OPTS)
      await expect(unfreezeInputs(tx, runId)).rejects.toThrow(/cannot unfreeze/)
    })
  })

  it('enforces separation of duty on approve and lock', async () => {
    await withTenant(A.id, async (tx) => {
      const runId = await createRun(tx, { periodId, processedByUserId: PROCESSOR })
      await freezeInputs(tx, runId, [freezeRow(A.employeeId)], {}, statutoryId)
      await calculate(tx, runId, OPTS)
      await validate(tx, runId, { ...OPTS, variancePct: 25 })

      const err = await approve(tx, runId, PROCESSOR, { requireSeparateApprover: true })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PayrollError)
      expect((err as PayrollError).code).toBe('SEPARATION_OF_DUTY')
    })
  })

  it('writes one payslip and a full line set per employee', async () => {
    const runId = await runToLocked(A)
    const { slips, lines } = await withTenant(A.id, async (tx) => ({
      slips: (await tx.query('SELECT * FROM payslips WHERE run_id = $1', [runId])).rows,
      lines: (await tx.query('SELECT component_code FROM payroll_lines WHERE run_id = $1', [runId])).rows,
    }))
    expect(slips).toHaveLength(1)
    expect(Number(slips[0].net_paise)).toBe(L(40_000) - L(1_800) - L(200))
    expect(lines.map((l) => l.component_code).sort())
      .toEqual(['BASIC', 'HRA', 'PF_EE', 'PF_ER', 'PT', 'SPECIAL'])
  })
})

describe('validation gates the run', () => {
  it('blocks on negative net pay and does not advance', async () => {
    const result = await withTenant(A.id, async (tx) => {
      const runId = await createRun(tx, { periodId, processedByUserId: PROCESSOR })
      await freezeInputs(tx, runId, [freezeRow(A.employeeId, {
        monthlyComponents: { basic: L(1_000) },
        adhoc: [{ code: 'RECOVERY', amountPaise: -L(50_000) }],
      })], {}, statutoryId)
      await calculate(tx, runId, OPTS)
      const v = await validate(tx, runId, { ...OPTS, variancePct: 25 })
      return { v, status: (await getRun(tx, runId)).status }
    })
    expect(result.v.blockers.map((b) => b.code)).toContain('NEGATIVE_NET_PAY')
    expect(result.status).toBe('calculated')
  })

  it('warns on a large variance without blocking', () => {
    const rows = [{
      input: input(),
      computed: computePayroll(input(), OPTS),
      previousNetPaise: BigInt(L(10_000)),
    }]
    const r = validateRun(rows, { variancePct: 25 })
    expect(r.blockers).toHaveLength(0)
    expect(r.warnings.map((w) => w.code)).toContain('NET_PAY_VARIANCE')
  })

  it('blocks an employee with no frozen compensation', () => {
    const bad = input({ monthlyComponents: {} })
    const r = validateRun([{ input: bad, computed: computePayroll(bad, OPTS) }], { variancePct: 25 })
    expect(r.blockers.map((b) => b.code)).toContain('NO_SALARY_STRUCTURE')
  })
})

describe('a locked run is immutable in the DATABASE, not just the service', () => {
  it('rejects a direct UPDATE of its payroll lines', async () => {
    const runId = await runToLocked(A)
    await expect(
      withTenant(A.id, async (tx) =>
        tx.query('UPDATE payroll_lines SET amount_paise = 1 WHERE run_id = $1', [runId]),
      ),
    ).rejects.toThrow(/is locked; create a revision/)
  })

  it('rejects a direct DELETE of its payslips', async () => {
    const runId = await runToLocked(A)
    await expect(
      withTenant(A.id, async (tx) => tx.query('DELETE FROM payslips WHERE run_id = $1', [runId])),
    ).rejects.toThrow(/is locked; create a revision/)
  })

  it('rejects a raw INSERT of an input row, bypassing the service entirely', async () => {
    const runId = await runToLocked(A)
    // Deliberately NOT through freezeInputs: the service guard would catch this
    // first, and the point of the trigger is to stop the paths that skip it —
    // background jobs, consoles, and anything written later.
    await expect(
      withTenant(A.id, async (tx) =>
        tx.query(
          `INSERT INTO payroll_inputs
             (tenant_id, run_id, employee_id, calendar_days, payable_days, lop_days,
              monthly_components, annual_ctc_paise, state_code)
           VALUES ($1, $2, $3, 30, 30, 0, '{}'::jsonb, 0, 'TS')`,
          [A.id, runId, A.employeeId],
        ),
      ),
    ).rejects.toThrow(/is locked; create a revision/)
  })

  // The trigger looked up the run from NEW.run_id, so an UPDATE that changed run_id was
  // judged by where the row was GOING, not where it lived. Moving a line, input or
  // payslip out of a locked run into an open one passed, and rewrote a locked run.
  for (const table of ['payroll_lines', 'payroll_inputs', 'payslips']) {
    it(`rejects moving a ${table} row OUT of a locked run into an open one`, async () => {
      const lockedId = await runToLocked(A)
      const openId = await openRunElsewhere(false)
      await expect(
        withTenant(A.id, async (tx) =>
          tx.query(`UPDATE ${table} SET run_id = $2 WHERE run_id = $1`, [lockedId, openId]),
        ),
      ).rejects.toThrow(/is locked/)
      const left = await withTenant(A.id, (tx) =>
        tx.query(`SELECT count(*)::int AS n FROM ${table} WHERE run_id = $1`, [lockedId]))
      expect(left.rows[0].n).toBeGreaterThan(0)
    })
  }

  it('rejects moving a row INTO a locked run from an open one', async () => {
    const lockedId = await runToLocked(A)
    const openId = await openRunElsewhere(true)
    await expect(
      withTenant(A.id, async (tx) =>
        tx.query(`UPDATE payroll_inputs SET run_id = $2 WHERE run_id = $1`, [openId, lockedId]),
      ),
    ).rejects.toThrow(/is locked/)
  })

  it('rejects a status change on the run itself', async () => {
    const runId = await runToLocked(A)
    await expect(
      withTenant(A.id, async (tx) =>
        tx.query(`UPDATE payroll_runs SET status = 'draft' WHERE id = $1`, [runId]),
      ),
    ).rejects.toThrow(/is locked and cannot be modified/)
  })
})

describe('corrections are revisions, and the delta is derived', () => {
  it('creates revision 2 pointing at what it supersedes', async () => {
    const first = await runToLocked(A)
    const second = await withTenant(A.id, (tx) =>
      revise(tx, first, { reason: 'regularization approved late for 1 employee', processedByUserId: PROCESSOR }),
    )
    const run = await withTenant(A.id, (tx) => getRun(tx, second))
    expect(run.revision).toBe(2)
    expect(run.supersedes_run_id).toBe(first)
  })

  it('requires a reason', async () => {
    const first = await runToLocked(A)
    await expect(
      withTenant(A.id, (tx) => revise(tx, first, { reason: '  ', processedByUserId: PROCESSOR })),
    ).rejects.toThrow(/must record why/)
  })

  it('refuses to revise a run that is not locked', async () => {
    await expect(
      withTenant(A.id, async (tx) => {
        const runId = await createRun(tx, { periodId, processedByUserId: PROCESSOR })
        return revise(tx, runId, { reason: 'x', processedByUserId: PROCESSOR })
      }),
    ).rejects.toThrow(/only a locked run is revised/)
  })

  it('reports only what changed between the two runs', async () => {
    const first = await runToLocked(A)
    const changed = await withTenant(A.id, async (tx) => {
      const second = await revise(tx, first, { reason: 'LOP correction', processedByUserId: PROCESSOR })
      await freezeInputs(tx, second, [freezeRow(A.employeeId, { lopDays: 3, payableDays: 27 })], {}, statutoryId)
      await calculate(tx, second, OPTS)
      return delta(tx, second)
    })

    const codes = changed.map((d) => d.component_code)
    expect(codes).toContain('LOP')
    // Unchanged earnings do not appear in the delta.
    expect(codes).not.toContain('HRA')
    const lop = changed.find((d) => d.component_code === 'LOP')
    expect(Number(lop!.delta_paise)).toBe(L(4_000))
  })
})

describe('payroll stays tenant-isolated', () => {
  it('another company sees no runs, inputs, lines or payslips', async () => {
    await runToLocked(A)
    const counts = await withTenant(B.id, async (tx) => ({
      runs: (await tx.query('SELECT * FROM payroll_runs')).rows.length,
      inputs: (await tx.query('SELECT * FROM payroll_inputs')).rows.length,
      lines: (await tx.query('SELECT * FROM payroll_lines')).rows.length,
      slips: (await tx.query('SELECT * FROM payslips')).rows.length,
    }))
    expect(counts).toEqual({ runs: 0, inputs: 0, lines: 0, slips: 0 })
  })

  it('the app role cannot edit statutory rates', async () => {
    await expect(
      withTenant(A.id, async (tx) => tx.query('UPDATE statutory_configs SET pf_employee_rate = 0')),
    ).rejects.toThrow(/permission denied/i)
  })
})
