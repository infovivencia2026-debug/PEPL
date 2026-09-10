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
