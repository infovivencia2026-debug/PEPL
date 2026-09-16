import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import {
  acknowledge, acknowledgementStats, connectMailbox, createConversation,
  decryptSecret, disconnectMailbox, encryptSecret, markRead, notify,
  publishAnnouncement, removeFromAllConversations, sendMessage,
  unreadCount, unreadInConversation, CommsError,
} from '../src/comms/index.ts'

let A: Tenant
let B: Tenant

const HR = 'd0000000-0000-0000-0000-00000000000d'
const ALICE = 'e0000000-0000-0000-0000-00000000000e'
const BOB = 'f0000000-0000-0000-0000-00000000000f'
const CAROL = '11111111-2222-3333-4444-555555555555'
const MASTER = 'test-master-key-not-a-real-secret'

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

const newAnnouncement = (tenantId: string, requiresAck = true) =>
  withTenant(tenantId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO announcements (tenant_id, title, body_html, author_user_id, requires_acknowledgement)
       VALUES ($1, 'Updated leave policy', '<p>From 1 Oct...</p>', $2, $3) RETURNING id`,
      [tenantId, HR, requiresAck],
    )
    return rows[0]!.id
  })

describe('announcements: reach plus proof', () => {
  it('publishing creates a receipt per person in the audience', async () => {
    const id = await newAnnouncement(A.id)
    const n = await withTenant(A.id, (tx) =>
      publishAnnouncement(tx, { announcementId: id, audienceUserIds: [ALICE, BOB, CAROL] }),
    )
    expect(n).toBe(3)

    const stats = await withTenant(A.id, (tx) => acknowledgementStats(tx, id))
    expect(stats).toMatchObject({ audience: 3, viewed: 0, acknowledged: 0 })
    expect(stats.outstanding.sort()).toEqual([ALICE, BOB, CAROL].sort())
  })

  it('tracks who has acknowledged and who has not', async () => {
    const id = await newAnnouncement(A.id)
    await withTenant(A.id, async (tx) => {
      await publishAnnouncement(tx, { announcementId: id, audienceUserIds: [ALICE, BOB, CAROL] })
      await acknowledge(tx, id, ALICE)
      await acknowledge(tx, id, BOB)
    })
    const stats = await withTenant(A.id, (tx) => acknowledgementStats(tx, id))
    expect(stats.acknowledged).toBe(2)
    expect(stats.outstanding).toEqual([CAROL])
  })

  it('acknowledging twice does not double-count', async () => {
    const id = await newAnnouncement(A.id)
    await withTenant(A.id, async (tx) => {
      await publishAnnouncement(tx, { announcementId: id, audienceUserIds: [ALICE] })
      await acknowledge(tx, id, ALICE)
      await acknowledge(tx, id, ALICE)
    })
    expect((await withTenant(A.id, (tx) => acknowledgementStats(tx, id))).acknowledged).toBe(1)
  })

  it('someone outside the audience cannot acknowledge', async () => {
    const id = await newAnnouncement(A.id)
    await withTenant(A.id, (tx) =>
      publishAnnouncement(tx, { announcementId: id, audienceUserIds: [ALICE] }),
    )
    const err = await withTenant(A.id, async (tx) =>
      acknowledge(tx, id, BOB).catch((e: unknown) => e),
    )
    expect(err).toBeInstanceOf(CommsError)
    expect((err as CommsError).code).toBe('NOT_IN_AUDIENCE')
  })

  it('refuses to publish the same announcement twice', async () => {
    const id = await newAnnouncement(A.id)
    await withTenant(A.id, (tx) => publishAnnouncement(tx, { announcementId: id, audienceUserIds: [ALICE] }))
    await expect(
      withTenant(A.id, (tx) => publishAnnouncement(tx, { announcementId: id, audienceUserIds: [ALICE] })),
    ).rejects.toThrow(/already published/)
  })
})

describe('notifications', () => {
  it('dedupes a retried job', async () => {
    const results = await withTenant(A.id, async (tx) => [
      await notify(tx, { userId: ALICE, eventType: 'leave.approved', title: 'Leave approved', dedupeKey: 'leave:1' }),
      await notify(tx, { userId: ALICE, eventType: 'leave.approved', title: 'Leave approved', dedupeKey: 'leave:1' }),
      await notify(tx, { userId: ALICE, eventType: 'leave.approved', title: 'Leave approved', dedupeKey: 'leave:2' }),
    ])
    expect(results).toEqual([true, false, true])
    expect(await withTenant(A.id, (tx) => unreadCount(tx, ALICE))).toBe(2)
  })

  it('the same key for a different user still notifies', async () => {
    await withTenant(A.id, async (tx) => {
      await notify(tx, { userId: ALICE, eventType: 'x', title: 'x', dedupeKey: 'shared' })
      await notify(tx, { userId: BOB, eventType: 'x', title: 'x', dedupeKey: 'shared' })
    })
    expect(await withTenant(A.id, (tx) => unreadCount(tx, BOB))).toBe(1)
  })
})

describe('chat', () => {
  it('delivers a message and tracks unread by watermark', async () => {
    const { convId, msgId } = await withTenant(A.id, async (tx) => {
      const convId = await createConversation(tx, {
        kind: 'group', title: 'Engineering', createdBy: ALICE, participants: [ALICE, BOB],
      })
      const a = await sendMessage(tx, { conversationId: convId, senderUserId: ALICE, body: 'standup at 10', clientMessageId: 'm1' })
      await sendMessage(tx, { conversationId: convId, senderUserId: ALICE, body: 'and again', clientMessageId: 'm2' })
      return { convId, msgId: a.id }
    })

    expect(await withTenant(A.id, (tx) => unreadInConversation(tx, convId, BOB))).toBe(2)
    // the sender's own messages are not unread for them
    expect(await withTenant(A.id, (tx) => unreadInConversation(tx, convId, ALICE))).toBe(0)

    await withTenant(A.id, (tx) => markRead(tx, { conversationId: convId, userId: BOB, upToMessageId: msgId }))
    expect(await withTenant(A.id, (tx) => unreadInConversation(tx, convId, BOB))).toBe(1)
  })

  it('a retried send is idempotent', async () => {
    const results = await withTenant(A.id, async (tx) => {
      const convId = await createConversation(tx, { kind: 'dm', createdBy: ALICE, participants: [ALICE, BOB] })
      const first = await sendMessage(tx, { conversationId: convId, senderUserId: ALICE, body: 'hi', clientMessageId: 'offline-1' })
      const retry = await sendMessage(tx, { conversationId: convId, senderUserId: ALICE, body: 'hi', clientMessageId: 'offline-1' })
      return { first, retry }
    })
    expect(results.first.created).toBe(true)
    expect(results.retry.created).toBe(false)
    expect(results.retry.id).toBe(results.first.id)
  })

  it('a non-participant cannot post', async () => {
    const convId = await withTenant(A.id, (tx) =>
      createConversation(tx, { kind: 'dm', createdBy: ALICE, participants: [ALICE, BOB] }),
    )
    await expect(
      withTenant(A.id, (tx) =>
        sendMessage(tx, { conversationId: convId, senderUserId: CAROL, body: 'sneaking in', clientMessageId: 'x' }),
      ),
    ).rejects.toThrow(/not in this conversation/)
  })

  it('an exiting employee loses access automatically', async () => {
    const convId = await withTenant(A.id, (tx) =>
      createConversation(tx, { kind: 'group', createdBy: ALICE, participants: [ALICE, BOB] }),
    )
    const removed = await withTenant(A.id, (tx) => removeFromAllConversations(tx, BOB))
    expect(removed).toBe(1)
    await expect(
      withTenant(A.id, (tx) =>
        sendMessage(tx, { conversationId: convId, senderUserId: BOB, body: 'still here?', clientMessageId: 'y' }),
      ),
    ).rejects.toThrow(/not in this conversation/)
  })

  it('messages cannot be deleted, only tombstoned', async () => {
    await withTenant(A.id, async (tx) => {
      const convId = await createConversation(tx, { kind: 'dm', createdBy: ALICE, participants: [ALICE, BOB] })
      await sendMessage(tx, { conversationId: convId, senderUserId: ALICE, body: 'x', clientMessageId: 'z' })
    })
    await expect(
      withTenant(A.id, async (tx) => tx.query('DELETE FROM messages')),
    ).rejects.toThrow(/permission denied/i)
  })

  it('a conversation cannot span two tenants', async () => {
    const convId = await withTenant(A.id, (tx) =>
      createConversation(tx, { kind: 'dm', createdBy: ALICE, participants: [ALICE] }),
    )
    // Tenant B stamping its own row against A's conversation: the composite FK
    // has no matching parent inside B, so it cannot be written.
    await expect(
      withTenant(B.id, async (tx) =>
        tx.query(
          `INSERT INTO conversation_participants (tenant_id, conversation_id, user_id) VALUES ($1,$2,$3)`,
          [B.id, convId, BOB],
        ),
      ),
    ).rejects.toThrow(/foreign key/i)
  })

  it('another company sees no conversations or messages', async () => {
    await withTenant(A.id, async (tx) => {
      const convId = await createConversation(tx, { kind: 'dm', createdBy: ALICE, participants: [ALICE, BOB] })
      await sendMessage(tx, { conversationId: convId, senderUserId: ALICE, body: 'private', clientMessageId: 'p' })
    })
    const counts = await withTenant(B.id, async (tx) => ({
      convs: (await tx.query('SELECT * FROM conversations')).rows.length,
      msgs: (await tx.query('SELECT * FROM messages')).rows.length,
    }))
    expect(counts).toEqual({ convs: 0, msgs: 0 })
  })
})

describe('mail credential custody', () => {
  it('round-trips a secret under the tenant key', () => {
    const blob = encryptSecret('hunter2', A.id, MASTER)
    expect(decryptSecret(blob, A.id, MASTER)).toBe('hunter2')
  })

  it('a secret encrypted for one tenant cannot be read with another tenant key', () => {
    const blob = encryptSecret('hunter2', A.id, MASTER)
    expect(() => decryptSecret(blob, B.id, MASTER)).toThrow()
  })

  it('tampering with the ciphertext is detected', () => {
    const blob = encryptSecret('hunter2', A.id, MASTER)
    const tampered = Buffer.from(blob)
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 0xff, tampered.length - 1)
    expect(() => decryptSecret(tampered, A.id, MASTER)).toThrow()
  })

  it('the stored credential is never plaintext', async () => {
    await withTenant(A.id, (tx) =>
      connectMailbox(tx, {
        userId: ALICE, email: 'alice@acme.com', username: 'alice@acme.com',
        password: 'hunter2', imapHost: 'mail.acme.com', smtpHost: 'mail.acme.com', master: MASTER,
      }),
    )
    const row = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT secret_ciphertext FROM mail_accounts')).rows[0],
    )
    expect(Buffer.isBuffer(row.secret_ciphertext)).toBe(true)
    expect(row.secret_ciphertext.toString('utf8')).not.toContain('hunter2')
    expect(decryptSecret(row.secret_ciphertext, A.id, MASTER)).toBe('hunter2')
  })

  it('disconnecting destroys the credential immediately', async () => {
    const id = await withTenant(A.id, (tx) =>
      connectMailbox(tx, {
        userId: ALICE, email: 'alice@acme.com', username: 'alice@acme.com',
        password: 'hunter2', imapHost: 'mail.acme.com', smtpHost: 'mail.acme.com', master: MASTER,
      }),
    )
    await withTenant(A.id, (tx) => disconnectMailbox(tx, id))
    const rows = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT status, secret_ciphertext FROM mail_accounts WHERE id = $1', [id])).rows,
    )
    expect(rows).toEqual([{ status: 'disconnected', secret_ciphertext: null }])
  })

  it('another company cannot see a mailbox connection', async () => {
    await withTenant(A.id, (tx) =>
      connectMailbox(tx, {
        userId: ALICE, email: 'alice@acme.com', username: 'alice@acme.com',
        password: 'hunter2', imapHost: 'mail.acme.com', smtpHost: 'mail.acme.com', master: MASTER,
      }),
    )
    const rows = await withTenant(B.id, async (tx) =>
      (await tx.query('SELECT * FROM mail_accounts')).rows,
    )
    expect(rows).toHaveLength(0)
  })
})
