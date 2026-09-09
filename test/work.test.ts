import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { blockingTasksOpen, completeTask, instantiateTemplate, taskInbox } from '../src/work/tasks.ts'
import { evaluateBreaches, raiseTicket, respond, setStatus, TicketError } from '../src/work/helpdesk.ts'

let A: Tenant
let B: Tenant

const HR = '70000000-0000-0000-0000-000000000007'
const IT = '80000000-0000-0000-0000-000000000008'
const MANAGER = '90000000-0000-0000-0000-000000000009'
const EMPLOYEE = 'a0000000-0000-0000-0000-00000000000a'
const COMMITTEE = 'b0000000-0000-0000-0000-00000000000b'

beforeEach(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})

afterAll(async () => {
  await closePools()
  await controlPool.end()
})

async function seedOnboardingTemplate(tenantId: string): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO task_templates (tenant_id, name, trigger_event)
       VALUES ($1, 'Onboarding', 'employee.hired') RETURNING id`,
      [tenantId],
    )
    const templateId = rows[0]!.id
    const items: [string, string, number, boolean][] = [
      ['Collect signed contract', 'hr', 0, true],
      ['Issue laptop', 'it', 1, true],
      ['Add to payroll', 'hr', 2, false],
      ['First-week check-in', 'manager', 7, false],
    ]
    for (const [title, rule, offset, blocks] of items) {
      await tx.query(
        `INSERT INTO task_template_items
           (tenant_id, template_id, title, assignee_rule, due_offset_days, sequence, blocks_completion)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [tenantId, templateId, title, rule, offset, items.indexOf([title, rule, offset, blocks] as never) + 1, blocks],
      )
    }
    return templateId
  })
}

const resolveAssignee = (rule: string): string | undefined =>
  ({ hr: HR, it: IT, manager: MANAGER, employee: EMPLOYEE } as Record<string, string>)[rule]

describe('tasks: onboarding is a template plus an event', () => {
  it('creates one task per item with due dates offset from joining', async () => {
    const templateId = await seedOnboardingTemplate(A.id)
    const ids = await withTenant(A.id, (tx) =>
      instantiateTemplate(tx, {
        templateId, subjectEmployeeId: A.employeeId, anchorDate: '2026-02-01',
        sourceType: 'onboarding', resolveAssignee,
      }),
    )
    expect(ids).toHaveLength(4)

    const rows = await withTenant(A.id, async (tx) =>
      (await tx.query(
        `SELECT title, due_date::text AS due, assignee_user_id FROM tasks ORDER BY due_date`,
      )).rows,
    )
    expect(rows[0]).toMatchObject({ title: 'Collect signed contract', due: '2026-02-01', assignee_user_id: HR })
    expect(rows[1]).toMatchObject({ title: 'Issue laptop', due: '2026-02-02', assignee_user_id: IT })
    expect(rows[3]).toMatchObject({ title: 'First-week check-in', due: '2026-02-08', assignee_user_id: MANAGER })
  })

  it('blocking items keep offboarding open until they are done', async () => {
    const templateId = await seedOnboardingTemplate(A.id)
    await withTenant(A.id, (tx) =>
      instantiateTemplate(tx, {
        templateId, subjectEmployeeId: A.employeeId, anchorDate: '2026-02-01',
        sourceType: 'offboarding', resolveAssignee,
      }),
    )

    const open = await withTenant(A.id, (tx) => blockingTasksOpen(tx, A.employeeId, 'offboarding'))
    expect(open.map((t) => t.title)).toEqual(['Collect signed contract', 'Issue laptop'])

    await withTenant(A.id, async (tx) => {
      for (const t of open) await completeTask(tx, t.id, HR)
    })
    expect(await withTenant(A.id, (tx) => blockingTasksOpen(tx, A.employeeId, 'offboarding'))).toHaveLength(0)
  })

  it('completing a task twice is idempotent', async () => {
    const templateId = await seedOnboardingTemplate(A.id)
    const [first] = await withTenant(A.id, (tx) =>
      instantiateTemplate(tx, {
        templateId, subjectEmployeeId: A.employeeId, anchorDate: '2026-02-01',
        sourceType: 'onboarding', resolveAssignee,
      }),
    )
    await withTenant(A.id, async (tx) => {
      await completeTask(tx, first!, HR)
      await completeTask(tx, first!, IT)
    })
    const row = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT completed_by_user_id FROM tasks WHERE id = $1', [first])).rows[0],
    )
    expect(row.completed_by_user_id).toBe(HR)
  })

  it('the task inbox is per assignee and flags overdue', async () => {
    const templateId = await seedOnboardingTemplate(A.id)
    await withTenant(A.id, (tx) =>
      instantiateTemplate(tx, {
        templateId, subjectEmployeeId: A.employeeId, anchorDate: '2020-01-01',
        sourceType: 'onboarding', resolveAssignee,
      }),
    )
    const hrQueue = await withTenant(A.id, (tx) => taskInbox(tx, HR))
    expect(hrQueue).toHaveLength(2)
    expect(hrQueue.every((t) => t.overdue)).toBe(true)
    expect(await withTenant(A.id, (tx) => taskInbox(tx, IT))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------

async function seedCategory(
  tenantId: string,
  opts: { name: string; confidential?: boolean; responseMins?: number; resolutionMins?: number },
): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO ticket_categories
         (tenant_id, name, is_confidential, sla_response_minutes, sla_resolution_minutes)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tenantId, opts.name, opts.confidential ?? false,
       opts.responseMins ?? 480, opts.resolutionMins ?? 2880],
    )
    return rows[0]!.id
  })
}

describe('helpdesk: SLA is stored, not derived', () => {
  it('computes due times at creation from the category', async () => {
    const cat = await seedCategory(A.id, { name: 'Payroll', responseMins: 60, resolutionMins: 240 })
    const now = new Date('2026-09-14T10:00:00Z')
    const id = await withTenant(A.id, (tx) =>
      raiseTicket(tx, {
        categoryId: cat, raisedByUserId: EMPLOYEE,
        title: 'Salary is short', description: 'August net looks wrong', now,
      }),
    )
    const t = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT sla_response_due_at, sla_resolution_due_at FROM tickets WHERE id = $1', [id])).rows[0],
    )
    expect(new Date(t.sla_response_due_at).toISOString()).toBe('2026-09-14T11:00:00.000Z')
    expect(new Date(t.sla_resolution_due_at).toISOString()).toBe('2026-09-14T14:00:00.000Z')
  })

  it('a later change to the category SLA does not rewrite an existing ticket', async () => {
    const cat = await seedCategory(A.id, { name: 'IT', responseMins: 60 })
    const now = new Date('2026-09-14T10:00:00Z')
    const id = await withTenant(A.id, (tx) =>
      raiseTicket(tx, { categoryId: cat, raisedByUserId: EMPLOYEE, title: 'Laptop', description: 'slow', now }),
    )
    await withTenant(A.id, async (tx) =>
      tx.query('UPDATE ticket_categories SET sla_response_minutes = 5 WHERE id = $1', [cat]),
    )
    const t = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT sla_response_due_at FROM tickets WHERE id = $1', [id])).rows[0],
    )
    expect(new Date(t.sla_response_due_at).toISOString()).toBe('2026-09-14T11:00:00.000Z')
  })

  it('the clock pauses while waiting on the employee', async () => {
    const cat = await seedCategory(A.id, { name: 'Leave', resolutionMins: 120 })
    const start = new Date('2026-09-14T10:00:00Z')
    const id = await withTenant(A.id, (tx) =>
      raiseTicket(tx, { categoryId: cat, raisedByUserId: EMPLOYEE, title: 'Balance', description: '?', now: start }),
    )

    await withTenant(A.id, async (tx) => {
      await setStatus(tx, id, 'waiting_on_employee', { actorUserId: HR, now: new Date('2026-09-14T10:30:00Z') })
      await setStatus(tx, id, 'in_progress', { actorUserId: HR, now: new Date('2026-09-14T13:30:00Z') })
    })

    const t = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT sla_resolution_due_at, paused_minutes FROM tickets WHERE id = $1', [id])).rows[0],
    )
    // 3 hours of waiting pushes the 12:00 deadline to 15:00
    expect(t.paused_minutes).toBe(180)
    expect(new Date(t.sla_resolution_due_at).toISOString()).toBe('2026-09-14T15:00:00.000Z')
  })

  it('marks breaches, and re-running changes nothing', async () => {
    const cat = await seedCategory(A.id, { name: 'Facilities', responseMins: 30, resolutionMins: 60 })
    const start = new Date('2026-09-14T10:00:00Z')
    await withTenant(A.id, (tx) =>
      raiseTicket(tx, { categoryId: cat, raisedByUserId: EMPLOYEE, title: 'AC', description: 'broken', now: start }),
    )
    const later = new Date('2026-09-14T13:00:00Z')

    const first = await withTenant(A.id, (tx) => evaluateBreaches(tx, later))
    const second = await withTenant(A.id, (tx) => evaluateBreaches(tx, later))
    expect(first).toBe(1)
    expect(second).toBe(0)

    const t = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT sla_response_breached, sla_resolution_breached FROM tickets')).rows[0],
    )
    expect(t).toMatchObject({ sla_response_breached: true, sla_resolution_breached: true })
  })

  it('a first response stops the response clock and does not restart it', async () => {
    const cat = await seedCategory(A.id, { name: 'Payroll', responseMins: 30 })
    const start = new Date('2026-09-14T10:00:00Z')
    const id = await withTenant(A.id, (tx) =>
      raiseTicket(tx, { categoryId: cat, raisedByUserId: EMPLOYEE, title: 'x', description: 'y', now: start }),
    )
    await withTenant(A.id, async (tx) => {
      await respond(tx, id, { authorUserId: HR, body: 'looking into it', now: new Date('2026-09-14T10:10:00Z') })
      await respond(tx, id, { authorUserId: HR, body: 'still looking', now: new Date('2026-09-14T12:00:00Z') })
    })
    const t = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT first_responded_at FROM tickets WHERE id = $1', [id])).rows[0],
    )
    expect(new Date(t.first_responded_at).toISOString()).toBe('2026-09-14T10:10:00.000Z')

    // Nothing breaches: the response clock stopped, and resolution is not due yet.
    expect(await withTenant(A.id, (tx) => evaluateBreaches(tx, new Date('2026-09-14T13:00:00Z')))).toBe(0)
    const after = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT sla_response_breached FROM tickets WHERE id = $1', [id])).rows[0],
    )
    expect(after.sla_response_breached).toBe(false)
  })
})

describe('helpdesk: confidential categories are enforced by RLS, not by a filter', () => {
  it('a grievance is invisible to general HR, in reads AND in counts', async () => {
    const grievance = await seedCategory(A.id, { name: 'Grievance', confidential: true })
    const payroll = await seedCategory(A.id, { name: 'Payroll' })

    await withTenant(A.id, async (tx) => {
      await raiseTicket(tx, {
        categoryId: grievance, raisedByUserId: EMPLOYEE,
        title: 'Complaint about my manager', description: 'sensitive',
      })
      await raiseTicket(tx, {
        categoryId: payroll, raisedByUserId: EMPLOYEE, title: 'Payslip query', description: 'ordinary',
      })
    }, { userId: EMPLOYEE })

    // General HR sees only the ordinary ticket.
    const asHr = await withTenant(A.id, async (tx) => ({
      rows: (await tx.query('SELECT title FROM tickets')).rows,
      count: Number((await tx.query('SELECT count(*)::int AS n FROM tickets')).rows[0].n),
    }), { userId: HR })
    expect(asHr.count).toBe(1)
    expect(asHr.rows.map((r) => r.title)).toEqual(['Payslip query'])

    // The person who raised it can see their own.
    const asRaiser = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT title FROM tickets')).rows.map((r) => r.title),
    { userId: EMPLOYEE })
    expect(asRaiser.sort()).toEqual(['Complaint about my manager', 'Payslip query'])
  })

  it('the named committee can see it; adding to hr_admin would not have helped', async () => {
    const grievance = await seedCategory(A.id, { name: 'POSH', confidential: true })
    await withTenant(A.id, async (tx) => {
      await tx.query(
        `INSERT INTO ticket_confidential_access (tenant_id, category_id, user_id) VALUES ($1,$2,$3)`,
        [A.id, grievance, COMMITTEE],
      )
      await raiseTicket(tx, {
        categoryId: grievance, raisedByUserId: EMPLOYEE, title: 'Formal complaint', description: 'x',
      })
    }, { userId: EMPLOYEE })

    const asCommittee = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT title FROM tickets')).rows,
    { userId: COMMITTEE })
    expect(asCommittee).toHaveLength(1)

    const asManager = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT title FROM tickets')).rows,
    { userId: MANAGER })
    expect(asManager).toHaveLength(0)
  })

  it('confidentiality survives with no user context at all', async () => {
    const grievance = await seedCategory(A.id, { name: 'Whistleblower', confidential: true })
    await withTenant(A.id, async (tx) => {
      await raiseTicket(tx, {
        categoryId: grievance, raisedByUserId: EMPLOYEE, title: 'Report', description: 'x',
      })
    }, { userId: EMPLOYEE })

    // No app.user_id pinned: the confidential row must not fall through.
    const rows = await withTenant(A.id, async (tx) => (await tx.query('SELECT * FROM tickets')).rows)
    expect(rows).toHaveLength(0)
  })

  it('rejects a ticket in an unknown category', async () => {
    const err = await withTenant(A.id, async (tx) =>
      raiseTicket(tx, {
        categoryId: crypto.randomUUID(), raisedByUserId: EMPLOYEE, title: 'x', description: 'y',
      }).catch((e: unknown) => e),
    )
    expect(err).toBeInstanceOf(TicketError)
    expect((err as TicketError).code).toBe('CATEGORY_NOT_FOUND')
  })

  it('one company tickets are invisible to another', async () => {
    const catA = await seedCategory(A.id, { name: 'Payroll' })
    await withTenant(A.id, (tx) =>
      raiseTicket(tx, { categoryId: catA, raisedByUserId: EMPLOYEE, title: 'A ticket', description: 'x' }),
    )
    const rows = await withTenant(B.id, async (tx) => (await tx.query('SELECT * FROM tickets')).rows)
    expect(rows).toHaveLength(0)
  })

  it('the ticket event trail cannot be rewritten', async () => {
    const cat = await seedCategory(A.id, { name: 'IT' })
    await withTenant(A.id, (tx) =>
      raiseTicket(tx, { categoryId: cat, raisedByUserId: EMPLOYEE, title: 'x', description: 'y' }),
    )
    await expect(
      withTenant(A.id, async (tx) => tx.query(`UPDATE ticket_events SET event_type = 'nope'`)),
    ).rejects.toThrow(/permission denied/i)
  })
})
