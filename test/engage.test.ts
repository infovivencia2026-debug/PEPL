/**
 * Engagement (B3). Policies: draft → publish tells the audience and retires
 * the previous version; acknowledging is once; compliance names who has not.
 * Surveys: anonymity is in the policy — HR's session cannot select a single
 * response row, the aggregate withholds groups under min_group, a
 * non-anonymous author sees only their own row; nobody answers twice.
 * Celebrations: birthdays and anniversaries in a window, opt-out respected.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { draftPolicy, publishPolicy, listPolicies, acknowledgePolicy, policyCompliance, remindPolicies, createSurvey, openSurvey, closeSurvey, respondSurvey, surveyResults, listSurveys, celebrations } from '../src/comms/engage.ts'

let A: Tenant
let hrUser: string
const people: Array<{ id: string; user: string }> = []
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    hrUser = await createUser(tx, { tenantId: A.id, email: 'ehr@acme.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin'] })
    people.push({ id: A.employeeId, user: await createUser(tx, { tenantId: A.id, email: 'e0@acme.test', fullName: 'E0', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId }) })
    for (let i = 1; i <= 5; i++) {
      const id = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining, date_of_birth) VALUES ($1,$2,$3,DATE '2024-10-10',DATE '1990-10-15') RETURNING id`, [A.id, `A-E${i}`, `E${i}`])).rows[0]!.id
      await tx.query(`INSERT INTO employee_assignments (tenant_id, employee_id, department, designation, effective_from) VALUES ($1,$2,$3,'Staff',DATE '2024-10-10')`, [A.id, id, i <= 3 ? 'Sales' : 'Ops'])
      people.push({ id, user: await createUser(tx, { tenantId: A.id, email: `e${i}@acme.test`, fullName: `E${i}`, password: 'a-long-password-1', roles: ['employee'], employeeId: id }) })
    }
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('policies', () => {
  it('publishes to the audience, retires the old version, tracks acknowledgements and reminds the rest', async () => {
    await withTenant(A.id, async (tx) => {
      const v1 = await draftPolicy(tx, { code: 'posh', title: 'POSH Policy', body: 'v1', actorUserId: hrUser })
      expect(v1).toMatchObject({ code: 'POSH', version: 1, status: 'draft' })
      const pub = await publishPolicy(tx, v1.id)
      expect(pub.notified).toBe(6)
      await expect(publishPolicy(tx, v1.id)).rejects.toMatchObject({ code: 'POLICY_STATE' })
      await acknowledgePolicy(tx, { policyId: v1.id, employeeId: people[0]!.id })
      await acknowledgePolicy(tx, { policyId: v1.id, employeeId: people[0]!.id })               // idempotent
      const mine = await listPolicies(tx, { status: 'published', forEmployeeId: people[0]!.id })
      expect(mine[0]!.acknowledged_at).toBeTruthy()
      const c = await policyCompliance(tx, v1.id)
      expect(c).toMatchObject({ audience: 6, acknowledged: 1 })
      expect(c.pending.map((p) => p.name).sort()).toEqual(['E1', 'E2', 'E3', 'E4', 'E5'])
      expect(await remindPolicies(tx)).toBe(5)
      expect(await remindPolicies(tx)).toBe(0)                                                    // same day: deduped
      const v2 = await draftPolicy(tx, { code: 'POSH', title: 'POSH Policy', body: 'v2', actorUserId: hrUser })
      expect(v2.version).toBe(2)
      await publishPolicy(tx, v2.id)
      const status = (await tx.query<{ version: number; status: string }>(`SELECT version, status FROM policies WHERE code = 'POSH' ORDER BY version`)).rows
      expect(status).toEqual([{ version: 1, status: 'retired' }, { version: 2, status: 'published' }])
      await expect(acknowledgePolicy(tx, { policyId: v1.id, employeeId: people[1]!.id })).rejects.toMatchObject({ code: 'POLICY_STATE' })
      await expect(tx.query(`DELETE FROM policy_acknowledgements WHERE policy_id = $1`, [v1.id])).rejects.toThrow(/permission denied/)
    })
  })
})

describe('surveys', () => {
  it('anonymous: no session can read a response row; aggregates withhold small groups; eNPS computes; one answer each', async () => {
    let surveyId = ''
    await withTenant(A.id, async (tx) => {
      await expect(createSurvey(tx, { title: 'x', questions: [{ id: 'q', text: 'q', type: 'scale' }], minGroup: 2, actorUserId: hrUser })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })   // anonymous needs ≥3
      const s = await createSurvey(tx, { title: 'October pulse', kind: 'enps', questions: [{ id: 'nps', text: 'Recommend?', type: 'nps' }, { id: 'why', text: 'One thing', type: 'text' }, { id: 'mood', text: 'Mood', type: 'choice', options: ['good', 'ok', 'bad'] }], minGroup: 3, actorUserId: hrUser })
      surveyId = s.id
      await expect(respondSurvey(tx, { surveyId, employeeId: people[0]!.id, userId: people[0]!.user, answers: { nps: 9 } })).rejects.toMatchObject({ code: 'SURVEY_STATE' })
      expect((await openSurvey(tx, surveyId)).invited).toBe(6)
    })
    // six answers, each in its own session: 3 Sales (10, 9, 3), 2 Ops (7, 8), and E0 with no department (6)
    const answers: Array<[number, number, string]> = [[0, 6, 'ok'], [1, 10, 'good'], [2, 9, 'good'], [3, 3, 'bad'], [4, 7, 'ok'], [5, 8, 'ok']]
    for (const [i, nps, mood] of answers) {
      await withTenant(A.id, (tx) => respondSurvey(tx, { surveyId, employeeId: people[i]!.id, userId: people[i]!.user, answers: { nps, mood, why: i === 1 ? 'Faster laptops' : '' } }), { userId: people[i]!.user })
    }
    await withTenant(A.id, async (tx) => {
      await expect(respondSurvey(tx, { surveyId, employeeId: people[0]!.id, userId: people[0]!.user, answers: { nps: 1 } })).rejects.toMatchObject({ code: 'ALREADY_RESPONDED' })
    }, { userId: people[0]!.user })
    // HR's session: zero rows, six participations — by policy, with no WHERE clause in play
    await withTenant(A.id, async (tx) => {
      expect((await tx.query(`SELECT * FROM survey_responses`)).rowCount).toBe(0)
      expect((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM survey_participation`)).rows[0]!.n).toBe('6')
      const all = await surveyResults(tx, surveyId, null)
      expect(all).toMatchObject({ invited: 6, responded: 6 })
      const nps = all.rows.find((r) => r.question_id === 'nps' && r.segment === 'all')!
      expect(nps.responses).toBe(6)
      expect(nps.distribution).toEqual({ '3': 1, '6': 1, '7': 1, '8': 1, '9': 1, '10': 1 })
      expect(all.enps).toBe(Math.round(((2 - 2) / 6) * 100))       // promoters 9,10 · detractors 3,6
      expect(all.rows.find((r) => r.question_id === 'why')).toBeUndefined()   // ONE free-text answer would identify its author: withheld below min_group
      // by department: Sales (3) shows; Ops (2) and the unknown department (1) are withheld
      const byDept = await surveyResults(tx, surveyId, 'department')
      expect([...new Set(byDept.rows.map((r) => r.segment))]).toEqual(['Sales'])
      expect(byDept.rows.find((r) => r.question_id === 'nps')!.avg_value).toBe('7.33')
      expect((await listSurveys(tx, { forEmployeeId: people[0]!.id }))[0]).toMatchObject({ responded: true, responses: 6 })
      await closeSurvey(tx, surveyId)
      await expect(closeSurvey(tx, surveyId)).rejects.toMatchObject({ code: 'SURVEY_STATE' })
    }, { userId: hrUser })
    // the author of an anonymous answer cannot find their own row either
    await withTenant(A.id, async (tx) => { expect((await tx.query(`SELECT * FROM survey_responses`)).rowCount).toBe(0) }, { userId: people[1]!.user })
  })

  it('non-anonymous: an author sees exactly their own row and nobody else\'s', async () => {
    let surveyId = ''
    await withTenant(A.id, async (tx) => {
      surveyId = (await createSurvey(tx, { title: 'Named feedback', questions: [{ id: 'q', text: 'Rate', type: 'scale' }], anonymous: false, minGroup: 1, actorUserId: hrUser })).id
      await openSurvey(tx, surveyId)
    })
    for (const i of [0, 1]) await withTenant(A.id, (tx) => respondSurvey(tx, { surveyId, employeeId: people[i]!.id, userId: people[i]!.user, answers: { q: i + 3 } }), { userId: people[i]!.user })
    await withTenant(A.id, async (tx) => {
      const mine = (await tx.query<{ answers: { q: number } }>(`SELECT answers FROM survey_responses WHERE survey_id = $1`, [surveyId])).rows
      expect(mine.map((r) => r.answers.q)).toEqual([4])
    }, { userId: people[1]!.user })
    await withTenant(A.id, async (tx) => { expect((await tx.query(`SELECT 1 FROM survey_responses WHERE survey_id = $1`, [surveyId])).rowCount).toBe(0) }, { userId: hrUser })
  })
})

describe('celebrations', () => {
  it('lists birthdays and anniversaries in a window and honours opt-out', async () => {
    await withTenant(A.id, async (tx) => {
      await tx.query(`UPDATE employees SET custom_fields = custom_fields || '{"celebrations_opt_out": true}'::jsonb WHERE id = $1`, [people[5]!.id])
      const items = await celebrations(tx, { from: '2026-10-08', to: '2026-10-16' })
      const anniv = items.filter((i) => i.kind === 'work_anniversary')
      expect(anniv.map((i) => i.name).sort()).toEqual(['E1', 'E2', 'E3', 'E4'])           // E5 opted out; Rahul joined in January
      expect(anniv[0]).toMatchObject({ on: '2026-10-10', years: 2 })
      expect(items.filter((i) => i.kind === 'birthday').map((i) => i.on)).toEqual(Array(4).fill('2026-10-15'))
      expect((await celebrations(tx, { from: '2026-11-01', to: '2026-11-30' })).length).toBe(0)
    })
  })
})
