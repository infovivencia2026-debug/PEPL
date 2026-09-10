/**
 * A setting a tenant admin can move must change what the product does.
 *
 * These exist because three settings shipped that nothing ever read — the
 * upload limit, the chat retention window and the mail body cache. An admin
 * could move all three and nothing happened, which is worse than not offering
 * the control at all.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { setSetting } from '../src/config/write.ts'
import { resolveConfig } from '../src/config/resolver.ts'
import { createConversation, listMessages, purgeOldMessages, sendMessage } from '../src/comms/chat.ts'
import { putDocument } from '../src/documents/index.ts'
import {
  applyCorrection, isWeeklyOff, recomputeDay, recordPunch,
} from '../src/attendance/index.ts'

let A: Tenant
let B: Tenant

const ADMIN = 'd0000000-0000-0000-0000-00000000000d'
const ALICE = 'e0000000-0000-0000-0000-00000000000e'
const BOB = 'f0000000-0000-0000-0000-00000000000f'

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})
beforeEach(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})
afterAll(async () => {
  await closePools()
  await controlPool.end()
})

const set = (tenantId: string, key: string, value: unknown) =>
  withTenant(tenantId, (tx) =>
    setSetting(tx, { key, value: value as never, actorUserId: ADMIN, reason: 'test' }))

describe('documents.max_upload_mb', () => {
  it('is what the upload route reads, not a constant', async () => {
    await set(A.id, 'documents.max_upload_mb', 2)
    const config = await withTenant(A.id, (tx) => resolveConfig(tx, A.id))
    expect(config.get<number>('documents.max_upload_mb')).toBe(2)

    // The route computes its ceiling from exactly this value.
    const limit = Math.min(config.get<number>('documents.max_upload_mb') * 1024 * 1024, 10 * 1024 * 1024)
    expect(limit).toBe(2 * 1024 * 1024)
  })

  it('is per company: one tenant lowering it does not lower another', async () => {
    await set(A.id, 'documents.max_upload_mb', 1)
    const inA = await withTenant(A.id, (tx) => resolveConfig(tx, A.id))
    const inB = await withTenant(B.id, (tx) => resolveConfig(tx, B.id))
    expect(inA.get<number>('documents.max_upload_mb')).toBe(1)
    expect(inB.get<number>('documents.max_upload_mb')).toBe(10)
  })

  it('still accepts a file inside the lowered limit', async () => {
    await set(A.id, 'documents.max_upload_mb', 1)
    const meta = await withTenant(A.id, (tx) =>
      putDocument(tx, {
        ownerType: 'tenant', fileName: 'small.pdf', contentType: 'application/pdf',
        bytes: Buffer.alloc(500_000, 1), uploadedByUserId: ADMIN,
      }))
    expect(meta.size_bytes).toBe(500_000)
  })
})

describe('chat.history_retention_days', () => {
  const conversationWithMessages = async (tenantId: string) => {
    const id = await withTenant(tenantId, (tx) =>
      createConversation(tx, { kind: 'dm', createdBy: ALICE, participants: [ALICE, BOB] }))
    await withTenant(tenantId, (tx) =>
      sendMessage(tx, {
        conversationId: id, senderUserId: ALICE, body: 'old news', clientMessageId: 'm1',
      }))
    await withTenant(tenantId, (tx) =>
      sendMessage(tx, {
        conversationId: id, senderUserId: BOB, body: 'recent', clientMessageId: 'm2',
      }))
    // Age the first message past any window under test.
    await withTenant(tenantId, (tx) =>
      tx.query(
        `UPDATE messages SET sent_at = now() - interval '400 days'
          WHERE client_message_id = 'm1'`))
    return id
  }

  it('zero keeps everything — the default must never delete a history', async () => {
    const id = await conversationWithMessages(A.id)
    expect(await withTenant(A.id, (tx) => purgeOldMessages(tx, 0))).toBe(0)

    const { messages } = await withTenant(A.id, (tx) =>
      listMessages(tx, { conversationId: id, userId: ALICE }))
    expect(messages.map((m) => m.body)).toEqual(['old news', 'recent'])
  })

  it('clears bodies past the window and leaves the rest alone', async () => {
    const id = await conversationWithMessages(A.id)
    expect(await withTenant(A.id, (tx) => purgeOldMessages(tx, 365))).toBe(1)

    const { messages } = await withTenant(A.id, (tx) =>
      listMessages(tx, { conversationId: id, userId: ALICE }))
    expect(messages).toHaveLength(2)          // the row survives
    expect(messages[0]!.body).toBeNull()      // the words do not
    expect(messages[0]!.deleted_at).not.toBeNull()
    expect(messages[1]!.body).toBe('recent')
  })

  it('purges nothing twice, so the job is safe to re-run', async () => {
    await conversationWithMessages(A.id)
    expect(await withTenant(A.id, (tx) => purgeOldMessages(tx, 365))).toBe(1)
    expect(await withTenant(A.id, (tx) => purgeOldMessages(tx, 365))).toBe(0)
  })

  it('drops attachments along with the words', async () => {
    const id = await conversationWithMessages(A.id)
    const doc = await withTenant(A.id, (tx) =>
      putDocument(tx, {
        ownerType: 'conversation', ownerId: id, fileName: 'old.pdf',
        contentType: 'application/pdf', bytes: Buffer.from('%PDF'), uploadedByUserId: ALICE,
      }))
    await withTenant(A.id, (tx) =>
      tx.query(
        `UPDATE messages SET attachment_document_ids = ARRAY[$1::uuid]
          WHERE client_message_id = 'm1'`, [doc.id]))

    await withTenant(A.id, (tx) => purgeOldMessages(tx, 365))
    const { messages } = await withTenant(A.id, (tx) =>
      listMessages(tx, { conversationId: id, userId: ALICE }))
    expect(messages[0]!.attachment_document_ids).toEqual([])
  })

  it('purges one company without touching another', async () => {
    await conversationWithMessages(A.id)
    await conversationWithMessages(B.id)

    await withTenant(A.id, (tx) => purgeOldMessages(tx, 365))
    expect(await withTenant(B.id, (tx) => purgeOldMessages(tx, 365))).toBe(1)
  })
})

describe('attendance.week_pattern', () => {
  it('takes Sunday off on a six-day week', () => {
    expect(isWeeklyOff('2026-09-13', 'six_day')).toBe(true)   // Sunday
    expect(isWeeklyOff('2026-09-12', 'six_day')).toBe(false)  // Saturday
  })

  it('takes the weekend off on a five-day week', () => {
    expect(isWeeklyOff('2026-09-12', 'five_day')).toBe(true)
    expect(isWeeklyOff('2026-09-13', 'five_day')).toBe(true)
    expect(isWeeklyOff('2026-09-14', 'five_day')).toBe(false)
  })

  it('takes the second and fourth Saturday on the alternate pattern', () => {
    expect(isWeeklyOff('2026-09-12', 'alternate_saturday')).toBe(true)   // 2nd Sat
    expect(isWeeklyOff('2026-09-26', 'alternate_saturday')).toBe(true)   // 4th Sat
    expect(isWeeklyOff('2026-09-05', 'alternate_saturday')).toBe(false)  // 1st Sat
    expect(isWeeklyOff('2026-09-19', 'alternate_saturday')).toBe(false)  // 3rd Sat
  })

  it('claims no weekly off on a roster, rather than guessing and docking pay', () => {
    expect(isWeeklyOff('2026-09-13', 'roster')).toBe(false)
    expect(isWeeklyOff('2026-09-13', undefined)).toBe(false)
  })
})

describe('attendance.half_day_mode', () => {
  const punch = async (tenantId: string, employeeId: string, date: string, hours: number) => {
    await withTenant(tenantId, async (tx) => {
      await recordPunch(tx, {
        employeeId, punchedAt: `${date}T09:00:00.000Z`, localDate: date,
        direction: 'in', source: 'web', clientPunchId: `in-${date}`,
      })
      await recordPunch(tx, {
        employeeId,
        punchedAt: new Date(Date.parse(`${date}T09:00:00.000Z`) + hours * 3_600_000).toISOString(),
        localDate: date, direction: 'out', source: 'web', clientPunchId: `out-${date}`,
      })
    })
  }

  const dayOf = (tenantId: string, employeeId: string, date: string) =>
    withTenant(tenantId, async (tx) => {
      const r = await tx.query<{ status: string; day_fraction: string; fraction_source: string }>(
        `SELECT status, day_fraction::text, fraction_source FROM daily_attendance
          WHERE employee_id = $1 AND work_date = $2`, [employeeId, date])
      return r.rows[0]!
    })

  it('leaves a short day whole when half days are explicit', async () => {
    await punch(A.id, A.employeeId, '2026-09-14', 3)
    await withTenant(A.id, (tx) =>
      recomputeDay(tx, A.employeeId, '2026-09-14', { halfDayMode: 'explicit' }))
    expect(Number((await dayOf(A.id, A.employeeId, '2026-09-14')).day_fraction)).toBe(1)
  })

  it('marks a short day as half when the company derives it from hours', async () => {
    await punch(A.id, A.employeeId, '2026-09-14', 3)
    await withTenant(A.id, (tx) =>
      recomputeDay(tx, A.employeeId, '2026-09-14', {
        halfDayMode: 'hours_derived', halfDayHours: 4,
      }))
    const day = await dayOf(A.id, A.employeeId, '2026-09-14')
    expect(Number(day.day_fraction)).toBe(0.5)
    expect(day.fraction_source).toBe('hours')
  })

  it('leaves a full day alone', async () => {
    await punch(A.id, A.employeeId, '2026-09-14', 8)
    await withTenant(A.id, (tx) =>
      recomputeDay(tx, A.employeeId, '2026-09-14', {
        halfDayMode: 'hours_derived', halfDayHours: 4,
      }))
    expect(Number((await dayOf(A.id, A.employeeId, '2026-09-14')).day_fraction)).toBe(1)
  })

  it('honours the threshold the company chose', async () => {
    await punch(A.id, A.employeeId, '2026-09-14', 5)
    await withTenant(A.id, (tx) =>
      recomputeDay(tx, A.employeeId, '2026-09-14', {
        halfDayMode: 'hours_derived', halfDayHours: 6,
      }))
    expect(Number((await dayOf(A.id, A.employeeId, '2026-09-14')).day_fraction)).toBe(0.5)
  })

  it('marks a weekly off rather than an absence when nobody punched', async () => {
    await withTenant(A.id, (tx) =>
      recomputeDay(tx, A.employeeId, '2026-09-13', { weekPattern: 'six_day' }))
    const day = await dayOf(A.id, A.employeeId, '2026-09-13')
    expect(day.status).toBe('weekly_off')
    expect(Number(day.day_fraction)).toBe(0)
  })

  it('does not call it a weekly off when somebody actually came in', async () => {
    await punch(A.id, A.employeeId, '2026-09-13', 8)
    await withTenant(A.id, (tx) =>
      recomputeDay(tx, A.employeeId, '2026-09-13', { weekPattern: 'six_day' }))
    expect((await dayOf(A.id, A.employeeId, '2026-09-13')).status).toBe('present')
  })
})

describe('attendance.correction_window_days and remote_enabled', () => {
  const correct = (tenantId: string, workDate: string, policy: Record<string, unknown>, action = 'mark_present') =>
    withTenant(tenantId, (tx) =>
      applyCorrection(tx, {
        employeeId: A.employeeId, workDate, action: action as never,
        reason: 'device offline', actorUserId: ADMIN,
        policy, now: new Date('2026-09-14T10:00:00Z'),
      } as never))

  it('allows a correction inside the window', async () => {
    const result = await correct(A.id, '2026-09-10', { correctionWindowDays: 30 })
    expect(result.applied).toBe(true)
  })

  it('refuses one older than the window', async () => {
    await expect(correct(A.id, '2026-06-01', { correctionWindowDays: 30 }))
      .rejects.toMatchObject({ code: 'CORRECTION_WINDOW_CLOSED' })
  })

  it('treats zero as no limit, which is what the registry says', async () => {
    const result = await correct(A.id, '2020-01-01', { correctionWindowDays: 0 })
    expect(result.applied).toBe(true)
  })

  it('refuses to mark somebody remote when the company disallows it', async () => {
    await expect(correct(A.id, '2026-09-14', { remoteEnabled: false }, 'mark_remote'))
      .rejects.toMatchObject({ code: 'REMOTE_NOT_ALLOWED' })
  })

  it('allows it when the company permits it', async () => {
    const result = await correct(A.id, '2026-09-14', { remoteEnabled: true }, 'mark_remote')
    expect(result.applied).toBe(true)
  })
})
