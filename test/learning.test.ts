/**
 * Learning & recognition (C3). A mandatory course reaches its audience once
 * (a re-run nominates nobody twice, a new joiner is picked up); completion of
 * an expiring course sets valid_until and the compliance view counts
 * completed / open / overdue / expiring; a lapsed certification is
 * re-nominated. Recognition: manager-only badges are refused to peers, the
 * same badge to the same person within a week is refused, points accrue in
 * an append-only ledger and cannot be redeemed below zero; a private
 * recognition is off the wall; the app role cannot rewrite the ledger.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { upsertCourse, nominate, nominateMandatory, startCourse, completeCourse, listNominations, trainingCompliance, remindTraining, listBadges, recognise, recognitionFeed, pointsBalance, redeemPoints, leaderboard } from '../src/people/learning.ts'

let A: Tenant; let hrUser: string
const people: Array<{ id: string; user: string }> = []
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    hrUser = await createUser(tx, { tenantId: A.id, email: 'lhr@acme.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin'] })
    people.push({ id: A.employeeId, user: await createUser(tx, { tenantId: A.id, email: 'l0@acme.test', fullName: 'L0', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId }) })
    for (let i = 1; i <= 3; i++) {
      const id = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,$2,$3,DATE '2025-01-10') RETURNING id`, [A.id, `A-L${i}`, `L${i}`])).rows[0]!.id
      await tx.query(`INSERT INTO employee_assignments (tenant_id, employee_id, department, designation, effective_from) VALUES ($1,$2,'Ops','Staff',DATE '2025-01-10')`, [A.id, id])
      people.push({ id, user: await createUser(tx, { tenantId: A.id, email: `l${i}@acme.test`, fullName: `L${i}`, password: 'a-long-password-1', roles: ['employee'], employeeId: id }) })
    }
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('courses and mandatory training', () => {
  it('nominates the audience once, picks up joiners, tracks expiry and compliance', async () => {
    await withTenant(A.id, async (tx) => {
      const c = await upsertCourse(tx, { code: 'posh', title: 'POSH awareness', mandatory: true, validityMonths: 12, dueDays: 30 })
      expect(c.code).toBe('POSH')
      expect(await nominateMandatory(tx)).toBe(4)
      expect(await nominateMandatory(tx)).toBe(0)                                    // idempotent
      // a new joiner is picked up on the next sweep
      const joiner = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-L9','L9',current_date) RETURNING id`, [A.id])).rows[0]!.id
      expect(await nominateMandatory(tx)).toBe(1)
      // audience filter: an Ops-only optional course
      await upsertCourse(tx, { code: 'FORKLIFT', title: 'Forklift', mandatory: true, audience: { departments: ['Ops'] }, dueDays: 10 })
      expect(await nominateMandatory(tx)).toBe(3)

      const mine = await listNominations(tx, { employeeId: people[1]!.id })
      expect(mine.map((n) => n.course_code).sort()).toEqual(['FORKLIFT', 'POSH'])
      const posh = mine.find((n) => n.course_code === 'POSH')!
      await expect(startCourse(tx, { nominationId: posh.id, employeeId: people[2]!.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })   // not theirs
      await startCourse(tx, { nominationId: posh.id, employeeId: people[1]!.id })
      await expect(completeCourse(tx, { nominationId: posh.id, employeeId: people[2]!.id, actorUserId: people[2]!.user })).rejects.toMatchObject({ code: 'NOT_YOURS' })
      const done = await completeCourse(tx, { nominationId: posh.id, employeeId: people[1]!.id, score: 90, actorUserId: people[1]!.user })
      expect(done.status).toBe('completed')
      expect(done.valid_until).toBe(new Date(new Date().setUTCFullYear(new Date().getUTCFullYear() + 1)).toISOString().slice(0, 10))
      await expect(completeCourse(tx, { nominationId: posh.id, employeeId: people[1]!.id, actorUserId: people[1]!.user })).rejects.toMatchObject({ code: 'NOMINATION_STATE' })
      // a trainer fails someone
      const l2 = (await listNominations(tx, { employeeId: people[2]!.id, courseCode: 'POSH' }))[0]!
      await completeCourse(tx, { nominationId: l2.id, byTrainer: true, passed: false, score: 40, actorUserId: hrUser })

      // compliance today: POSH audience 5 → 1 completed, 4 open (incl. failed), none overdue
      let comp = await trainingCompliance(tx)
      expect(comp.find((x) => x.course === 'POSH')).toMatchObject({ audience: 5, completed: 1, open: 4, overdue: 0, expiring: 0 })
      // 40 days on: open ones are overdue and named; 11.5 months on: the certification is expiring
      const plus = (d: number): string => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)
      comp = await trainingCompliance(tx, plus(40))
      const p = comp.find((x) => x.course === 'POSH')!
      expect(p.overdue).toBe(4); expect(p.overdueNames).toContain('L2')
      comp = await trainingCompliance(tx, plus(350))
      expect(comp.find((x) => x.course === 'POSH')).toMatchObject({ completed: 1, expiring: 1 })
      // once lapsed, L1 is nominated again, and so is L2 who failed (a retake); the still-open ones are not duplicated
      await tx.query(`UPDATE course_nominations SET valid_until = current_date - 1 WHERE id = $1`, [posh.id])
      expect(await nominate(tx, { courseCode: 'POSH', employeeIds: people.map((x) => x.id).concat(joiner) })).toBe(2)
      expect(comp.find((x) => x.course === 'FORKLIFT')!.audience).toBe(3)

      // reminders: due within 3 days → nudge once per day
      await tx.query(`UPDATE course_nominations SET due_on = current_date + 1 WHERE employee_id = $1 AND status = 'assigned'`, [people[3]!.id])
      expect(await remindTraining(tx)).toBe(2)     // POSH and FORKLIFT for L3
      expect(await remindTraining(tx)).toBe(0)
    })
  })
})

describe('recognition', () => {
  it('badges, weekly throttle, manager-only, points ledger and the wall', async () => {
    await withTenant(A.id, async (tx) => {
      const badges = await listBadges(tx)
      expect(badges.map((b) => b.code)).toContain('STAR_OF_MONTH')
      const [me, l1, l2] = people as [typeof people[0], typeof people[0], typeof people[0]]
      await expect(recognise(tx, { badgeCode: 'TEAM_PLAYER', toEmployeeId: l1.id, fromUserId: me.user, fromEmployeeId: me.id, isManager: false, message: 'meh' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(recognise(tx, { badgeCode: 'STAR_OF_MONTH', toEmployeeId: l1.id, fromUserId: me.user, fromEmployeeId: me.id, isManager: false, message: 'Great month' })).rejects.toMatchObject({ code: 'BADGE_MANAGER_ONLY' })
      await expect(recognise(tx, { badgeCode: 'TEAM_PLAYER', toEmployeeId: me.id, fromUserId: me.user, fromEmployeeId: me.id, isManager: false, message: 'I am great' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const r = await recognise(tx, { badgeCode: 'TEAM_PLAYER', toEmployeeId: l1.id, fromUserId: me.user, fromEmployeeId: me.id, isManager: false, message: 'Covered my shift' })
      expect(r).toMatchObject({ badge_code: 'TEAM_PLAYER', points: 10, to_name: 'L1' })
      await expect(recognise(tx, { badgeCode: 'TEAM_PLAYER', toEmployeeId: l1.id, fromUserId: me.user, fromEmployeeId: me.id, isManager: false, message: 'Again!' })).rejects.toMatchObject({ code: 'RECOGNITION_TOO_SOON' })
      await recognise(tx, { badgeCode: 'STAR_OF_MONTH', toEmployeeId: l1.id, fromUserId: hrUser, fromEmployeeId: null, isManager: true, message: 'Star of September' })
      await recognise(tx, { badgeCode: 'THANK_YOU', toEmployeeId: l2.id, fromUserId: l1.user, fromEmployeeId: l1.id, isManager: false, message: 'Thanks for the help', visibility: 'private' })
      expect(await pointsBalance(tx, l1.id)).toEqual({ balance: 110, earned: 110, redeemed: 0 })
      // the wall: the private one is absent for a bystander, present for its recipient
      const wall = await recognitionFeed(tx, { viewerEmployeeId: me.id, viewerScopeIds: [me.id] })
      expect(wall.map((x) => x.badge_code).sort()).toEqual(['STAR_OF_MONTH', 'TEAM_PLAYER'])
      expect((await recognitionFeed(tx, { viewerEmployeeId: l2.id, viewerScopeIds: [l2.id] })).map((x) => x.badge_code)).toContain('THANK_YOU')
      const today = new Date().toISOString().slice(0, 10)
      expect((await leaderboard(tx, { from: today, to: today }))[0]).toMatchObject({ name: 'L1', points: 110, badges: 2 })
      // points: cannot go negative, ledger is append-only for the app role
      await expect(redeemPoints(tx, { employeeId: l1.id, points: 200, kind: 'redemption', note: 'voucher' })).rejects.toMatchObject({ code: 'INSUFFICIENT_POINTS' })
      expect(await redeemPoints(tx, { employeeId: l1.id, points: 100, kind: 'payout', note: 'Sept payroll' })).toEqual({ balance: 10 })
      expect(await pointsBalance(tx, l1.id)).toEqual({ balance: 10, earned: 110, redeemed: 100 })
    })
    await expect(withTenant(A.id, (tx) => tx.query(`UPDATE points_ledger SET delta = 1000`))).rejects.toThrow(/permission denied/i)
  })
})
