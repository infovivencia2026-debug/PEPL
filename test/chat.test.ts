import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import {
  addParticipants, attachDocuments, createConversation, deleteMessage, editMessage,
  leaveConversation, listConversations, listMessages, markRead, sendMessage,
} from '../src/comms/chat.ts'
import { putDocument } from '../src/documents/index.ts'

let A: Tenant
let B: Tenant

const ALICE = 'e0000000-0000-0000-0000-00000000000e'
const BOB = 'f0000000-0000-0000-0000-00000000000f'
const CAROL = '11111111-2222-3333-4444-555555555555'

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

const dm = (tenantId: string, people = [ALICE, BOB]) =>
  withTenant(tenantId, (tx) =>
    createConversation(tx, { kind: 'dm', createdBy: people[0]!, participants: people }))

const say = (tenantId: string, conversationId: string, from: string, body: string, key = body) =>
  withTenant(tenantId, (tx) =>
    sendMessage(tx, { conversationId, senderUserId: from, body, clientMessageId: key }))

describe('the conversation list is what a chat screen renders', () => {
  it('carries the unread count, the last line and the members', async () => {
    const id = await dm(A.id)
    await say(A.id, id, BOB, 'Can you approve my leave?')
    await say(A.id, id, BOB, 'It is for Friday.')

    const [conv] = await withTenant(A.id, (tx) => listConversations(tx, ALICE))
    expect(conv!.unread).toBe(2)
    expect(conv!.last_message_body).toBe('It is for Friday.')
    expect([...conv!.participant_ids].sort()).toEqual([ALICE, BOB].sort())
  })

  it('does not count your own messages as unread', async () => {
    const id = await dm(A.id)
    await say(A.id, id, ALICE, 'hello')
    const [conv] = await withTenant(A.id, (tx) => listConversations(tx, ALICE))
    expect(conv!.unread).toBe(0)
  })

  it('clears the count once the watermark moves', async () => {
    const id = await dm(A.id)
    const sent = await say(A.id, id, BOB, 'ping')
    await withTenant(A.id, (tx) =>
      markRead(tx, { conversationId: id, userId: ALICE, upToMessageId: sent.id }))
    const [conv] = await withTenant(A.id, (tx) => listConversations(tx, ALICE))
    expect(conv!.unread).toBe(0)
  })

  it('shows nothing to somebody who is not in it', async () => {
    await dm(A.id)
    expect(await withTenant(A.id, (tx) => listConversations(tx, CAROL))).toHaveLength(0)
  })
})

describe('message paging is stable while messages arrive', () => {
  it('pages backwards by id and reports whether more remain', async () => {
    const id = await dm(A.id)
    for (let i = 1; i <= 5; i++) await say(A.id, id, BOB, `m${i}`)

    const first = await withTenant(A.id, (tx) =>
      listMessages(tx, { conversationId: id, userId: ALICE, limit: 2 }))
    expect(first.messages.map((m) => m.body)).toEqual(['m4', 'm5'])
    expect(first.hasMore).toBe(true)

    const older = await withTenant(A.id, (tx) =>
      listMessages(tx, {
        conversationId: id, userId: ALICE, limit: 2, beforeId: first.messages[0]!.id,
      }))
    expect(older.messages.map((m) => m.body)).toEqual(['m2', 'm3'])
  })

  it('refuses a non-participant', async () => {
    const id = await dm(A.id)
    await expect(
      withTenant(A.id, (tx) => listMessages(tx, { conversationId: id, userId: CAROL })),
    ).rejects.toMatchObject({ code: 'NOT_A_PARTICIPANT' })
  })
})

describe('editing and deleting your own message', () => {
  it('stamps an edit rather than changing it silently', async () => {
    const id = await dm(A.id)
    const sent = await say(A.id, id, ALICE, 'teh cutoff is 6pm')
    await withTenant(A.id, (tx) =>
      editMessage(tx, { conversationId: id, messageId: sent.id, userId: ALICE, body: 'the cutoff is 6pm' }))

    const { messages } = await withTenant(A.id, (tx) =>
      listMessages(tx, { conversationId: id, userId: ALICE }))
    expect(messages[0]!.body).toBe('the cutoff is 6pm')
    expect(messages[0]!.edited_at).not.toBeNull()
  })

  it('will not let you edit somebody else’s message', async () => {
    const id = await dm(A.id)
    const sent = await say(A.id, id, BOB, 'mine')
    await expect(
      withTenant(A.id, (tx) =>
        editMessage(tx, { conversationId: id, messageId: sent.id, userId: ALICE, body: 'not yours' })),
    ).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' })
  })

  it('keeps the row on delete and hides the body', async () => {
    const id = await dm(A.id)
    const sent = await say(A.id, id, ALICE, 'sent in error')
    await withTenant(A.id, (tx) =>
      deleteMessage(tx, { conversationId: id, messageId: sent.id, userId: ALICE }))

    const { messages } = await withTenant(A.id, (tx) =>
      listMessages(tx, { conversationId: id, userId: ALICE }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.body).toBeNull()
    expect(messages[0]!.deleted_at).not.toBeNull()
  })
})

describe('membership rules', () => {
  it('a direct message never grows a third person', async () => {
    const id = await dm(A.id)
    await expect(
      withTenant(A.id, (tx) =>
        addParticipants(tx, { conversationId: id, userIds: [CAROL], actorUserId: ALICE })),
    ).rejects.toMatchObject({ code: 'CONVERSATION_READONLY' })
  })

  it('a group takes new members, and adding twice adds once', async () => {
    const id = await withTenant(A.id, (tx) =>
      createConversation(tx, {
        kind: 'group', title: 'Payroll', createdBy: ALICE, participants: [ALICE, BOB],
      }))
    expect(await withTenant(A.id, (tx) =>
      addParticipants(tx, { conversationId: id, userIds: [CAROL], actorUserId: ALICE }))).toBe(1)
    expect(await withTenant(A.id, (tx) =>
      addParticipants(tx, { conversationId: id, userIds: [CAROL], actorUserId: ALICE }))).toBe(0)
  })

  it('leaving stops delivery but keeps the history', async () => {
    const id = await dm(A.id)
    await say(A.id, id, BOB, 'before you left')
    await withTenant(A.id, (tx) => leaveConversation(tx, id, ALICE))

    expect(await withTenant(A.id, (tx) => listConversations(tx, ALICE))).toHaveLength(0)
    const { messages } = await withTenant(A.id, (tx) =>
      listMessages(tx, { conversationId: id, userId: BOB }))
    expect(messages).toHaveLength(1)
  })
})

describe('attachments point at stored documents', () => {
  it('records the document ids on the message', async () => {
    const id = await dm(A.id)
    const sent = await say(A.id, id, ALICE, 'policy attached')
    const doc = await withTenant(A.id, (tx) =>
      putDocument(tx, {
        ownerType: 'conversation', ownerId: id, fileName: 'policy.pdf',
        contentType: 'application/pdf', bytes: Buffer.from('%PDF'), uploadedByUserId: ALICE,
      }))
    await withTenant(A.id, (tx) =>
      attachDocuments(tx, {
        conversationId: id, messageId: sent.id, userId: ALICE, documentIds: [doc.id],
      }))

    const { messages } = await withTenant(A.id, (tx) =>
      listMessages(tx, { conversationId: id, userId: ALICE }))
    expect(messages[0]!.attachment_document_ids).toEqual([doc.id])
  })
})

describe('chat is tenant-isolated', () => {
  it('another company sees no conversations and cannot post into one', async () => {
    const id = await dm(A.id)
    await say(A.id, id, ALICE, 'internal')

    expect(await withTenant(B.id, (tx) => listConversations(tx, ALICE))).toHaveLength(0)
    await expect(
      withTenant(B.id, (tx) =>
        sendMessage(tx, {
          conversationId: id, senderUserId: ALICE, body: 'planted', clientMessageId: 'x',
        })),
    ).rejects.toMatchObject({ code: 'NOT_A_PARTICIPANT' })
  })
})
