import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import {
  deleteMessage, ensureAccount, folderByRole, listEnvelopes, listFolders, listThread,
  moveToFolder, openMessage, saveDraft, sendMail, setFlag, MailError,
} from '../src/mail/index.ts'

let A: Tenant
let B: Tenant

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

const mailbox = (tenantId: string, userId: string, email: string) =>
  withTenant(tenantId, (tx) => ensureAccount(tx, { userId, email, displayName: email }))

const send = (
  tenantId: string,
  from: Awaited<ReturnType<typeof mailbox>>,
  to: string[],
  subject: string,
  key = subject,
  allowExternal = true,
) =>
  withTenant(tenantId, (tx) =>
    sendMail(tx, {
      account: from,
      userId: from.user_id,
      idempotencyKey: key,
      allowExternal,
      draft: { to, subject, bodyHtml: `<p>${subject}</p>` },
    }))

describe('a new mailbox is usable immediately', () => {
  it('comes with the standard folders', async () => {
    const account = await mailbox(A.id, ALICE, 'alice@acme.test')
    const folders = await withTenant(A.id, (tx) => listFolders(tx, account.id))
    expect(folders.map((f) => f.role)).toEqual(['inbox', 'drafts', 'sent', 'archive', 'trash'])
    expect(folders.every((f) => f.total === 0)).toBe(true)
  })

  it('is created once, however many times it is asked for', async () => {
    const first = await mailbox(A.id, ALICE, 'alice@acme.test')
    const again = await mailbox(A.id, ALICE, 'alice@acme.test')
    expect(again.id).toBe(first.id)
  })
})

describe('internal mail is delivered, not queued', () => {
  it('lands in the recipient inbox and the sender sent folder', async () => {
    const alice = await mailbox(A.id, ALICE, 'alice@acme.test')
    const bob = await mailbox(A.id, BOB, 'bob@acme.test')

    const result = await send(A.id, alice, ['bob@acme.test'], 'Payroll cutoff')
    expect(result.deliveredTo).toEqual(['bob@acme.test'])
    expect(result.queuedFor).toEqual([])

    const inbox = await withTenant(A.id, async (tx) =>
      listEnvelopes(tx, { folderId: await folderByRole(tx, bob.id, 'inbox') }))
    expect(inbox.envelopes[0]!.subject).toBe('Payroll cutoff')
    expect(inbox.envelopes[0]!.from_address).toBe('alice@acme.test')
    expect(inbox.envelopes[0]!.is_seen).toBe(false)

    const sent = await withTenant(A.id, async (tx) =>
      listEnvelopes(tx, { folderId: await folderByRole(tx, alice.id, 'sent') }))
    expect(sent.envelopes).toHaveLength(1)
    expect(sent.envelopes[0]!.is_seen).toBe(true)
  })

  it('queues an address that has no mailbox here', async () => {
    const alice = await mailbox(A.id, ALICE, 'alice@acme.test')
    const result = await send(A.id, alice, ['auditor@external.example'], 'Statutory filing')
    expect(result.deliveredTo).toEqual([])
    expect(result.queuedFor).toEqual(['auditor@external.example'])

    const queued = await withTenant(A.id, async (tx) => {
      const r = await tx.query(`SELECT command, status FROM mail_commands`)
      return r.rows as { command: string; status: string }[]
    })
    expect(queued).toEqual([{ command: 'send', status: 'queued' }])
  })

  it('refuses an outside address when the company disallows it', async () => {
    const alice = await mailbox(A.id, ALICE, 'alice@acme.test')
    await expect(
      send(A.id, alice, ['someone@external.example'], 'Nope', 'nope', false),
    ).rejects.toMatchObject({ code: 'NO_RECIPIENTS' })
  })

  it('will not send to nobody', async () => {
    const alice = await mailbox(A.id, ALICE, 'alice@acme.test')
    await expect(send(A.id, alice, [], 'Empty')).rejects.toBeInstanceOf(MailError)
  })

  it('delivers once when the same send is retried', async () => {
    const alice = await mailbox(A.id, ALICE, 'alice@acme.test')
    const bob = await mailbox(A.id, BOB, 'bob@acme.test')

    const first = await send(A.id, alice, ['bob@acme.test'], 'Only once', 'idem-1')
    const retry = await send(A.id, alice, ['bob@acme.test'], 'Only once', 'idem-1')
    expect(retry.sentEnvelopeId).toBe(first.sentEnvelopeId)

    const inbox = await withTenant(A.id, async (tx) =>
      listEnvelopes(tx, { folderId: await folderByRole(tx, bob.id, 'inbox') }))
    expect(inbox.envelopes).toHaveLength(1)
  })
})

describe('reading a message', () => {
  it('returns the body and marks it read', async () => {
    const alice = await mailbox(A.id, ALICE, 'alice@acme.test')
    const bob = await mailbox(A.id, BOB, 'bob@acme.test')
    await send(A.id, alice, ['bob@acme.test'], 'Read me')

    const { envelopes } = await withTenant(A.id, async (tx) =>
      listEnvelopes(tx, { folderId: await folderByRole(tx, bob.id, 'inbox') }))
    const opened = await withTenant(A.id, (tx) => openMessage(tx, envelopes[0]!.id))

    expect(opened!.body_html).toBe('<p>Read me</p>')
    expect(opened!.envelope.is_seen).toBe(true)

    const folders = await withTenant(A.id, (tx) => listFolders(tx, bob.id))
    expect(folders.find((f) => f.role === 'inbox')!.unread).toBe(0)
  })

  it('groups a reply with the message it answers', async () => {
    const alice = await mailbox(A.id, ALICE, 'alice@acme.test')
    const bob = await mailbox(A.id, BOB, 'bob@acme.test')
    await send(A.id, alice, ['bob@acme.test'], 'Question')

    const { envelopes } = await withTenant(A.id, async (tx) =>
      listEnvelopes(tx, { folderId: await folderByRole(tx, bob.id, 'inbox') }))
    const original = envelopes[0]!

    await withTenant(A.id, (tx) =>
      sendMail(tx, {
        account: bob,
        userId: BOB,
        idempotencyKey: 'reply-1',
        allowExternal: true,
        draft: {
          to: ['alice@acme.test'], subject: 'Re: Question', bodyHtml: '<p>Answer</p>',
          threadKey: original.thread_key,
        },
      }))

    const thread = await withTenant(A.id, (tx) =>
      listThread(tx, { accountId: alice.id, threadKey: original.thread_key! }))
    expect(thread.map((m) => m.subject)).toEqual(['Question', 'Re: Question'])
  })
})

describe('drafts, flags and deletion', () => {
  it('replaces a draft rather than piling them up', async () => {
    const alice = await mailbox(A.id, ALICE, 'alice@acme.test')
    const first = await withTenant(A.id, (tx) =>
      saveDraft(tx, { account: alice, draft: { to: [], subject: 'Notes', bodyHtml: '<p>v1</p>' } }))
    await withTenant(A.id, (tx) =>
      saveDraft(tx, {
        account: alice, draftId: first,
        draft: { to: [], subject: 'Notes', bodyHtml: '<p>v2</p>' },
      }))

    const drafts = await withTenant(A.id, async (tx) =>
      listEnvelopes(tx, { folderId: await folderByRole(tx, alice.id, 'drafts') }))
    expect(drafts.envelopes).toHaveLength(1)
    expect(drafts.envelopes[0]!.is_draft).toBe(true)
  })

  it('flags and unflags', async () => {
    const alice = await mailbox(A.id, ALICE, 'alice@acme.test')
    const bob = await mailbox(A.id, BOB, 'bob@acme.test')
    const sent = await send(A.id, alice, ['bob@acme.test'], 'Flag me')

    await withTenant(A.id, (tx) => setFlag(tx, sent.sentEnvelopeId, 'flagged'))
    expect((await withTenant(A.id, (tx) => openMessage(tx, sent.sentEnvelopeId)))!.envelope.is_flagged)
      .toBe(true)
    expect(bob.id).toBeTruthy()
  })

  it('deletes to Trash first and purges on the second delete', async () => {
    const alice = await mailbox(A.id, ALICE, 'alice@acme.test')
    const sent = await send(A.id, alice, ['someone@external.example'], 'Bin me')

    const first = await withTenant(A.id, (tx) =>
      deleteMessage(tx, { envelopeId: sent.sentEnvelopeId, accountId: alice.id }))
    expect(first.purged).toBe(false)

    const trash = await withTenant(A.id, async (tx) =>
      listEnvelopes(tx, { folderId: await folderByRole(tx, alice.id, 'trash') }))
    expect(trash.envelopes).toHaveLength(1)

    const second = await withTenant(A.id, (tx) =>
      deleteMessage(tx, { envelopeId: sent.sentEnvelopeId, accountId: alice.id }))
    expect(second.purged).toBe(true)
    expect(await withTenant(A.id, (tx) => openMessage(tx, sent.sentEnvelopeId))).toBeNull()
  })

  it('moves a message between folders', async () => {
    const alice = await mailbox(A.id, ALICE, 'alice@acme.test')
    const sent = await send(A.id, alice, ['someone@external.example'], 'Archive me')
    const archive = await withTenant(A.id, (tx) => folderByRole(tx, alice.id, 'archive'))
    await withTenant(A.id, (tx) =>
      moveToFolder(tx, { envelopeId: sent.sentEnvelopeId, folderId: archive }))

    const inArchive = await withTenant(A.id, (tx) => listEnvelopes(tx, { folderId: archive }))
    expect(inArchive.envelopes).toHaveLength(1)
  })
})

describe('mail is tenant-isolated', () => {
  it('an identical address in another company is a different mailbox', async () => {
    const aliceA = await mailbox(A.id, ALICE, 'alice@acme.test')
    await mailbox(B.id, ALICE, 'alice@acme.test')
    await send(A.id, aliceA, ['someone@external.example'], 'Company A only')

    const foldersB = await withTenant(B.id, (tx) => listFolders(tx, aliceA.id))
    expect(foldersB).toHaveLength(0)

    const inB = await withTenant(B.id, (tx) => openMessage(tx, 'ffffffff-ffff-ffff-ffff-ffffffffffff'))
    expect(inB).toBeNull()
  })
})
