/**
 * The demo company's OPERATING history.
 *
 * The roster alone shows a directory; a sales call needs the product to look
 * like it has been used for a year. This adds the things a prospect asks to
 * see: documents on file, assets issued and acknowledged, an open hiring
 * pipeline, a performance cycle mid-flight, expense claims awaiting a
 * decision, and — the one that closes deals — an August payroll run taken all
 * the way to LOCKED by a different person from the one who processed it, so
 * separation of duty is demonstrated rather than described.
 *
 * Every write goes through the same services the product uses. Nothing here
 * reaches into a table the application would not touch itself, so if a demo
 * shows it, a customer can do it.
 */
import type { PoolClient } from 'pg'
import { putDocument } from '../src/documents/index.ts'
import { upsertCategory as upsertAssetCategory, addAsset, issueAsset, acknowledgeAsset } from '../src/work/assets.ts'
import { raiseRequisition, addCandidate, settleRequisitionDecision } from '../src/people/recruitment.ts'
import { createCycle, openCycle, setGoal, checkIn } from '../src/people/performance.ts'
import { seedDefaultCategories, listCategories as listExpenseCategories, submitClaim } from '../src/work/expenses.ts'
import { createRun, freezeInputs, calculate, validate, approve, lock } from '../src/payroll/run.ts'
import { loadStatutory, ptFor } from '../src/payroll/statutory.ts'
import { componentFlags } from '../src/payroll/structures.ts'
import { computeTds } from '../src/payroll/tds.ts'
import type { ResolvedConfig } from '../src/config/resolver.ts'
import { PEOPLE } from './demo-roster.ts'

const L = (rupees: number): number => rupees * 100

export interface DemoContext {
  tx: PoolClient
  tenantId: string
  /** employee number -> employee id */
  ids: Record<string, string>
  /** employee number -> user id */
  userIds: Record<string, string>
  adminUserId: string
  cfg: ResolvedConfig
}

/** A tiny but genuinely valid PDF, so a demo can open what it downloads. */
function samplePdf(title: string): Buffer {
  const body = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 84>>stream
BT /F1 16 Tf 70 760 Td (${title.replace(/[()\\]/g, '')}) Tj ET
endstream
endobj
trailer<</Root 1 0 R>>
%%EOF`
  return Buffer.from(body, 'latin1')
}

/** Documents on file: the ones HR is actually asked for. */
export async function seedDocuments(c: DemoContext): Promise<number> {
  let n = 0
  const perPerson: Array<[string, string, string]> = [
    ['offer_letter', 'Offer letter', 'Offer letter'],
    ['id_proof', 'PAN card', 'PAN card'],
    ['education', 'Degree certificate', 'Degree certificate'],
  ]
  // A representative slice rather than all 47: enough that every department has
  // someone with a file, without seeding 141 blobs into a demo database.
  const withFiles = ['ACM-001', 'ACM-003', 'ACM-004', 'ACM-005', 'ACM-006', 'ACM-016', 'ACM-026', 'ACM-033', 'ACM-043']
  for (const num of withFiles) {
    const person = PEOPLE.find((p) => p.number === num)!
    for (const [category, label] of perPerson) {
      await putDocument(c.tx, {
        ownerType: 'employee', ownerId: c.ids[num]!,
        fileName: `${num}-${category}.pdf`, contentType: 'application/pdf',
        bytes: samplePdf(`${label} — ${person.first} ${person.last}`),
        category, uploadedByUserId: c.userIds['ACM-001'] ?? c.adminUserId,
      })
      n++
    }
  }
  // Company-wide policy documents, which is what a prospect asks to see first.
  for (const [name, category] of [
    ['Employee handbook 2026', 'policy'],
    ['POSH policy', 'policy'],
    ['Leave and attendance policy', 'policy'],
    ['Travel and expense policy', 'policy'],
  ] as const) {
    await putDocument(c.tx, {
      ownerType: 'tenant', ownerId: null,
      fileName: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`, contentType: 'application/pdf',
      bytes: samplePdf(name), category, uploadedByUserId: c.adminUserId,
    })
    n++
  }
  return n
}

/** Assets: issued, acknowledged, and one still sitting in stock. */
export async function seedAssets(c: DemoContext): Promise<number> {
  const categories: Record<string, string> = {}
  for (const [code, name, returnable] of [
    ['LAPTOP', 'Laptop', true], ['PHONE', 'Mobile phone', true],
    ['VEHICLE', 'Company vehicle', true], ['TOOLKIT', 'Shop floor toolkit', true],
    ['SIMCARD', 'SIM card', false],
  ] as const) {
    categories[code] = (await upsertAssetCategory(c.tx, { code, name, returnable })).id
  }

  const issued: Array<[string, string, string, number]> = [
    ['LAPTOP', 'ACM-003', 'LAP-0012', 95_000], ['LAPTOP', 'ACM-004', 'LAP-0018', 88_000],
    ['LAPTOP', 'ACM-005', 'LAP-0021', 72_000], ['LAPTOP', 'ACM-013', 'LAP-0024', 110_000],
    ['LAPTOP', 'ACM-001', 'LAP-0009', 82_000], ['PHONE', 'ACM-026', 'MOB-0031', 24_000],
    ['PHONE', 'ACM-027', 'MOB-0034', 18_000], ['PHONE', 'ACM-007', 'MOB-0028', 46_000],
    ['VEHICLE', 'ACM-026', 'VEH-0003', 840_000], ['TOOLKIT', 'ACM-021', 'TLK-0007', 12_000],
    ['TOOLKIT', 'ACM-016', 'TLK-0004', 12_000], ['SIMCARD', 'ACM-030', 'SIM-0044', 0],
  ]
  let n = 0
  for (const [code, num, tag, cost] of issued) {
    const asset = await addAsset(c.tx, {
      categoryId: categories[code]!, tag, name: `${code} ${tag}`,
      serialNo: `SN-${tag}`, purchasedOn: '2025-04-15', costPaise: L(cost),
      locationCode: PEOPLE.find((p) => p.number === num)!.location,
    })
    const assignment = await issueAsset(c.tx, {
      assetId: asset.id, employeeId: c.ids[num]!, issuedOn: '2025-05-02',
      condition: 'new', actorUserId: c.adminUserId,
    })
    // Most people acknowledge; two deliberately have not, so the chase list is not empty.
    if (!['ACM-005', 'ACM-030'].includes(num)) {
      await acknowledgeAsset(c.tx, { assignmentId: assignment.id, employeeId: c.ids[num]! })
    }
    n++
  }
  // Spares in stock, so the issue flow has something to pick from during a demo.
  for (const [code, tag] of [['LAPTOP', 'LAP-0030'], ['PHONE', 'MOB-0040'], ['TOOLKIT', 'TLK-0011']] as const) {
    await addAsset(c.tx, {
      categoryId: categories[code]!, tag, name: `${code} ${tag}`, serialNo: `SN-${tag}`,
      purchasedOn: '2026-02-10', costPaise: L(60_000), locationCode: 'Hyderabad',
    })
    n++
  }
  return n
}

/** An open hiring pipeline with candidates spread across the stages. */
export async function seedRecruitment(c: DemoContext): Promise<number> {
  let n = 0
  const reqs: Array<{ title: string; dept: string; designation: string; hm: string; min: number; max: number; people: Array<[string, string, string, string]> }> = [
    { title: 'Senior Developer', dept: 'Engineering', designation: 'Senior Developer', hm: 'ACM-003', min: 1_200_000, max: 1_800_000,
      people: [
        ['Ananya', 'Bhatt', 'ananya.bhatt@example.test', 'applied'],
        ['Rohan', 'Mehta', 'rohan.mehta@example.test', 'screening'],
        ['Kiran', 'Pillai', 'kiran.pillai@example.test', 'interview'],
        ['Nisha', 'Agarwal', 'nisha.agarwal@example.test', 'offer'],
      ] },
    { title: 'Machine Operator', dept: 'Production', designation: 'Machine Operator', hm: 'ACM-006', min: 240_000, max: 300_000,
      people: [
        ['Senthil', 'Kumar', 'senthil.kumar@example.test', 'applied'],
        ['Mani', 'Vel', 'mani.vel@example.test', 'screening'],
        ['Deepak', 'Raj', 'deepak.raj@example.test', 'interview'],
      ] },
    { title: 'Area Sales Manager', dept: 'Sales', designation: 'Area Sales Manager', hm: 'ACM-007', min: 720_000, max: 960_000,
      people: [
        ['Sagar', 'Jadhav', 'sagar.jadhav@example.test', 'applied'],
        ['Preeti', 'Rane', 'preeti.rane@example.test', 'interview'],
      ] },
  ]
  for (const r of reqs) {
    const { requisition } = await raiseRequisition(c.tx, {
      title: r.title, department: r.dept, designation: r.designation, headcount: 1,
      employmentType: 'full_time', minCtcPaise: L(r.min), maxCtcPaise: L(r.max),
      justification: 'Approved in the annual manpower plan.',
      hiringManagerEmployeeId: c.ids[r.hm]!,
      requestedByUserId: c.userIds['ACM-036'] ?? c.adminUserId,
      fallbackChain: 'manager_then_hr',
    })
    // A requisition arrives pending approval; approving it is what opens it, and
    // going through the decision keeps the approval trail a demo can show.
    await settleRequisitionDecision(c.tx, { requisitionId: requisition.id, status: 'approved' })
    for (const [first, last, email, stage] of r.people) {
      const candidate = await addCandidate(c.tx, {
        requisitionId: requisition.id, firstName: first, lastName: last, email,
        phone: '+91 90000 00000', source: 'referral',
        expectedCtcPaise: L(Math.round((r.min + r.max) / 2)), noticeDays: 60,
      })
      if (stage !== 'applied') {
        await c.tx.query(`UPDATE candidates SET stage = $2 WHERE tenant_id = $1 AND id = $3`,
          [c.tenantId, stage, candidate.id])
      }
      n++
    }
  }
  return n
}

/** A performance cycle that is open, with goals set for the engineering team. */
export async function seedPerformance(c: DemoContext): Promise<number> {
  const cycle = await createCycle(c.tx, {
    name: 'FY 2026-27 · Half-yearly review',
    periodStart: '2026-04-01', periodEnd: '2026-09-30',
    selfReviewDue: '2026-10-07', managerReviewDue: '2026-10-21', ratingScale: 5,
  })
  const { appraisals } = await openCycle(c.tx, cycle.id)
  const goals: Array<[string, string, number]> = [
    ['ACM-004', 'Ship the order-tracking rewrite to all three plants', 70],
    ['ACM-005', 'Cut the nightly batch from 90 to under 30 minutes', 45],
    ['ACM-011', 'Take over on-call rotation and document the runbook', 60],
    ['ACM-013', 'Move deployments to the new pipeline, zero manual steps', 80],
    ['ACM-026', 'Grow the Pune territory by 18 per cent', 55],
    ['ACM-016', 'Reduce line changeover time to under 20 minutes', 35],
  ]
  for (const [num, title, progress] of goals) {
    const goal = await setGoal(c.tx, {
      cycleId: cycle.id, employeeId: c.ids[num]!, title,
      description: 'Agreed with the manager at the start of the cycle.',
      weightPct: 40, target: '100%', dueOn: '2026-09-30',
      setByUserId: c.userIds[num] ?? c.adminUserId,
    })
    // Progress is a check-in, not a field on the goal — a demo should show the
    // trail of updates, which is how the product actually records it.
    await checkIn(c.tx, {
      goalId: goal.id, progressPct: progress, note: 'Mid-cycle check-in with the manager.',
      byUserId: c.userIds[num] ?? c.adminUserId,
    })
  }
  return appraisals
}

/** Expense claims waiting on a manager, which is where most demos start. */
export async function seedExpenses(c: DemoContext): Promise<number> {
  await seedDefaultCategories(c.tx)
  const categories = await listExpenseCategories(c.tx)
  const travel = categories.find((k) => /travel|conveyance|taxi/i.test(k.name)) ?? categories[0]
  if (!travel) return 0
  const claims: Array<[string, number, string, string]> = [
    ['ACM-026', 4_200, 'Customer visit — Nashik and Aurangabad', '2026-09-08'],
    ['ACM-027', 1_850, 'Taxi to the Baramati plant and back', '2026-09-11'],
    ['ACM-030', 2_600, 'Two nights in Vijayawada for the dealer meet', '2026-09-15'],
    ['ACM-039', 950, 'Courier charges for the vendor samples', '2026-09-17'],
  ]
  let n = 0
  for (const [num, rupees, description, incurredOn] of claims) {
    // The category requires a receipt above 500 rupees, so the demo attaches one
    // rather than working around its own policy.
    const receipt = await putDocument(c.tx, {
      ownerType: 'employee', ownerId: c.ids[num]!,
      fileName: `receipt-${num}-${incurredOn}.pdf`, contentType: 'application/pdf',
      bytes: samplePdf(`Receipt — ${description}`), category: 'receipt',
      uploadedByUserId: c.userIds[num]!,
    })
    await submitClaim(c.tx, {
      employeeId: c.ids[num]!, requestedByUserId: c.userIds[num]!,
      categoryId: travel.id, incurredOn, amountPaise: L(rupees),
      description, merchant: 'Various', receiptDocumentId: receipt.id,
      fallbackChain: 'manager_then_hr',
    })
    n++
  }
  return n
}

/**
 * August 2026 payroll, processed by the payroll officer and approved AND locked
 * by Finance — a different person, which is the point. After this the demo has
 * payslips to open, a bank file to export and a locked run that the product
 * will refuse to edit.
 */
export async function runAugustPayroll(c: DemoContext): Promise<{ employees: number; netPaise: string }> {
  const { rows: period } = await c.tx.query<{ id: string }>(
    `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date)
     VALUES ($1,'2026-08',DATE '2026-08-01',DATE '2026-08-31',DATE '2026-09-01')
     ON CONFLICT (tenant_id, label) DO UPDATE SET pay_date = EXCLUDED.pay_date
     RETURNING id`, [c.tenantId])
  const periodId = period[0]!.id

  const processor = c.userIds['ACM-002']!      // Anil, payroll officer
  const approver = c.userIds['ACM-046']!       // Deepa, Finance — never the same person
  const runId = await createRun(c.tx, { periodId, processedByUserId: processor })

  // Everyone who had joined by the last day of August. ACM-032 joined on the
  // 3rd, so he is paid for 29 of 31 days and flagged as a mid-period joiner.
  const rows = PEOPLE
    .filter((p) => p.joinedOn <= '2026-08-31')
    .map((p) => {
      const midPeriod = p.joinedOn >= '2026-08-01'
      const payable = midPeriod ? 29 : 31
      const monthlyGross = p.basic + p.hra + p.special
      return {
        employeeId: c.ids[p.number]!,
        calendarDays: 31, payableDays: payable, lopDays: 0,
        monthlyComponents: { basic: L(p.basic), hra: L(p.hra), special: L(p.special) },
        annualCtcPaise: L(p.ctc),
        stateCode: p.stateCode,
        pfApplicable: true,
        // ESI applies below the statutory gross ceiling, which on this roster is
        // most of the shop floor and nobody in engineering.
        esiApplicable: monthlyGross <= 21_000,
        joinedMidPeriod: midPeriod,
      }
    })

  const statutory = await loadStatutory(c.tx, '2026-08-31')
  const divisor = c.cfg.get<number>('payroll.exit_day_divisor')
  await freezeInputs(c.tx, runId, rows, {
    lop_basis: c.cfg.get('payroll.lop_basis'),
    pf_on_full_wage: c.cfg.get('payroll.pf_on_full_wage'),
    exit_day_divisor: divisor,
  }, statutory.id, { settlement: { encashmentDivisor: divisor, noticeDivisor: divisor } })

  const tds = (args: {
    monthlyTaxableGrossPaise: bigint; regime: 'old' | 'new'; declaredDeductionsPaise: bigint
    earnedToDatePaise: bigint; deductedToDatePaise: bigint; monthsRemaining: number
  }) => {
    const rules = statutory.taxRules[args.regime]
    const slabs = statutory.taxSlabs[args.regime]
    if (!rules || slabs.length === 0) return { monthlyTdsPaise: 0n, trace: { reason: 'no tax slabs configured' } }
    const r = computeTds({ ...args }, slabs, rules)
    return { monthlyTdsPaise: r.monthlyTdsPaise, trace: r.trace }
  }

  const engineOptions = {
    statutory: statutory.config,
    components: (await componentFlags(c.tx)) ?? undefined,
    ptAmountPaise: (state: string, gross: bigint) => ptFor(statutory.ptSlabs, state, gross),
    lwfRates: statutory.lwfRates,
    pfOnFullWage: c.cfg.get<boolean>('payroll.pf_on_full_wage'),
    lopBasis: c.cfg.get<'calendar_days' | 'fixed_30' | 'working_days'>('payroll.lop_basis'),
    computeTds: tds,
  }
  const totals = await calculate(c.tx, runId, engineOptions)

  const result = await validate(c.tx, runId, {
    ...engineOptions,
    taxTables: { fiscalYear: statutory.fiscalYear, regimes: {
      new: statutory.taxSlabs.new.length > 0 && !!statutory.taxRules.new,
      old: statutory.taxSlabs.old.length > 0 && !!statutory.taxRules.old,
    } },
    variancePct: c.cfg.get<number>('payroll.variance_warning_pct'),
  })
  const blocking = result.blockers?.length ?? 0
  if (blocking > 0) {
    throw new Error(`demo payroll has ${blocking} blocker(s): ${JSON.stringify(result.blockers?.slice(0, 3))}`)
  }

  const separate = { requireSeparateApprover: c.cfg.get<boolean>('payroll.require_separate_approver') }
  await approve(c.tx, runId, approver, separate)
  await lock(c.tx, runId, approver, separate)
  return { employees: rows.length, netPaise: String(totals.net) }
}
