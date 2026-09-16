/**
 * The mailbox features a mail client has: attachments end to end (upload,
 * send, receive, download — and only by someone whose message carries them),
 * inbound MIME stored as safe HTML with its parts, drafts that keep bcc and
 * attachments, custom folders, bulk actions, a sanitised signature, and
 * recipient suggestions that never leak another mailbox's contacts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import {
  ensureAccount, folderByRole, listEnvelopes, listFolders, openMessage, saveDraft, sendMail, getEnvelope,
  uploadAttachment, listAttachments, readAttachment, assertAttachmentsUsable, storeParsedBody, parseMessage,
  createFolder, renameFolder, deleteFolder, bulk, getSettings, updateSettings, suggestRecipients,
} from '../src/mail/index.ts'
import { createUser } from '../src/auth/index.ts'

let A: Tenant
const ALICE = 'e0000000-0000-0000-0000-00000000000e'
const BOB = 'f0000000-0000-0000-0000-00000000000f'
const CAROL = 'a0000000-0000-0000-0000-00000000000a'

beforeAll(async () => { A = (await resetAndSeed()).a })
beforeEach(async () => { A = (await resetAndSeed()).a })
afterAll(async () => { await closePools(); await controlPool.end() })

const mailbox = (userId: string, email: string) =>
  withTenant(A.id, (tx) => ensureAccount(tx, { userId, email, displayName: email }))

describe('attachments', () => {
  it('travel with the message and are readable only through a message that carries them', async () => {
    const alice = await mailbox(ALICE, 'alice@acme.test')
    const bob = await mailbox(BOB, 'bob@acme.test')
    const carol = await mailbox(CAROL, 'carol@acme.test')

    await withTenant(A.id, async (tx) => {
      const up = await uploadAttachment(tx, {
        accountId: alice.id, userId: ALICE, fileName: 'quote.pdf', contentType: 'application/pdf',
        bytes: Buffer.from('%PDF-1.4 quote'),
      })
      // only the uploader (or a mailbox holding a message with it) may use it
      await assertAttachmentsUsable(tx, { accountId: alice.id, documentIds: [up.id] })
      await expect(assertAttachmentsUsable(tx, { accountId: bob.id, documentIds: [up.id] }))
        .rejects.toMatchObject({ code: 'ATTACHMENT_NOT_YOURS' })

      const sent = await sendMail(tx, {
        account: alice, userId: ALICE, idempotencyKey: 'k1', allowExternal: false,
        draft: { to: ['bob@acme.test'], cc: [], bcc: ['carol@acme.test'], subject: 'Quote',
          bodyHtml: '<p>See attached<script>x()</script></p>', attachmentDocumentIds: [up.id] },
      })
      expect(sent.deliveredTo.sort()).toEqual(['bob@acme.test', 'carol@acme.test'])

      // bob's copy lists the attachment, and the body arrived sanitised
      const inbox = await folderByRole(tx, bob.id, 'inbox')
      const [env] = (await listEnvelopes(tx, { folderId: inbox })).envelopes
      expect(env!.has_attachment).toBe(true)
      expect(env!.bcc_addresses).toEqual([])                 // the recipient never learns who was bcc'd
      expect(env!.message_id).toBe((await getEnvelope(tx, sent.sentEnvelopeId))!.message_id)
      const opened = await openMessage(tx, env!.id)
      expect(opened!.body_html).toBe('<p>See attached</p>')
      const atts = await listAttachments(tx, env!.id)
      expect(atts).toHaveLength(1)
      expect(atts[0]).toMatchObject({ file_name: 'quote.pdf', content_type: 'application/pdf', is_inline: false })
      expect(atts[0]!.url).toBe(`/api/v1/mail/messages/${env!.id}/attachments/${up.id}/content`)
      const file = await readAttachment(tx, { envelopeId: env!.id, documentId: up.id })
      expect(file!.bytes.toString()).toBe('%PDF-1.4 quote')

      // bob can now forward it: the attachment is usable from his mailbox
      await assertAttachmentsUsable(tx, { accountId: bob.id, documentIds: [up.id] })

      // a message that does not carry it gives nothing, whoever asks
      const other = await sendMail(tx, {
        account: carol, userId: CAROL, idempotencyKey: 'k2', allowExternal: false,
        draft: { to: ['bob@acme.test'], subject: 'Plain', bodyHtml: '<p>hi</p>' },
      })
      expect(await readAttachment(tx, { envelopeId: other.sentEnvelopeId, documentId: up.id })).toBeNull()
    })
  })

  it('stores an inbound multipart message as safe HTML with its parts and inline images resolved', async () => {
    const alice = await mailbox(ALICE, 'alice@acme.test')
    await withTenant(A.id, async (tx) => {
      const inbox = await folderByRole(tx, alice.id, 'inbox')
      const envelopeId = (await tx.query<{ id: string }>(
        `INSERT INTO mail_envelopes (tenant_id, account_id, folder_id, source, uid, subject)
         VALUES ($1,$2,$3,'imap',7,'Logo') RETURNING id`, [A.id, alice.id, inbox])).rows[0]!.id
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      const source = [
        'Content-Type: multipart/mixed; boundary="m"', '', '--m',
        'Content-Type: multipart/related; boundary="r"', '', '--r',
        'Content-Type: text/html; charset=utf-8', '',
        '<p onclick="x()">Logo <img src="cid:logo@x"></p><script>steal()</script>',
        '--r', 'Content-Type: image/png', 'Content-ID: <logo@x>', 'Content-Disposition: inline; filename="logo.png"',
        'Content-Transfer-Encoding: base64', '', png.toString('base64'), '--r--',
        '--m', 'Content-Type: text/csv; name="data.csv"', 'Content-Disposition: attachment; filename="data.csv"', '',
        'a,b', '--m--',
      ].join('\r\n')
      await storeParsedBody(tx, { tenantId: A.id, envelopeId, accountId: alice.id, parsed: parseMessage(source) })

      const opened = await openMessage(tx, envelopeId)
      const atts = await listAttachments(tx, envelopeId)
      const logo = atts.find((a) => a.file_name === 'logo.png')!
      expect(opened!.body_html).toBe(`<p>Logo <img src="${logo.url}" /></p>`)
      expect(opened!.body_text).toBe('Logo')
      expect(atts.map((a) => [a.file_name, a.is_inline])).toEqual([['data.csv', false], ['logo.png', true]])
      expect((await getEnvelope(tx, envelopeId))!.has_attachment).toBe(true)
      expect((await readAttachment(tx, { envelopeId, documentId: logo.document_id }))!.bytes.equals(png)).toBe(true)
    })
  })
})

describe('drafts keep everything', () => {
  it('bcc and attachments survive a save and come back on open', async () => {
    const alice = await mailbox(ALICE, 'alice@acme.test')
    await withTenant(A.id, async (tx) => {
      const up = await uploadAttachment(tx, { accountId: alice.id, userId: ALICE, fileName: 'a.txt', contentType: 'text/plain', bytes: Buffer.from('x') })
      const id = await saveDraft(tx, { account: alice, draft: {
        to: ['bob@acme.test'], cc: ['c@acme.test'], bcc: ['secret@acme.test'], subject: 'D', bodyHtml: '<p>d</p>',
        attachmentDocumentIds: [up.id] } })
      const env = (await getEnvelope(tx, id))!
      expect(env.bcc_addresses).toEqual(['secret@acme.test'])
      expect(env.attachment_document_ids).toEqual([up.id])
      expect(await listAttachments(tx, id)).toHaveLength(1)
    })
  })
})

describe('folders, bulk actions, settings, suggestions', () => {
  it('custom folders are created, renamed and deleted with their mail going to Trash', async () => {
    const alice = await mailbox(ALICE, 'alice@acme.test')
    await withTenant(A.id, async (tx) => {
      const { id } = await createFolder(tx, { accountId: alice.id, name: ' Vendors/2026 ' })
      await expect(createFolder(tx, { accountId: alice.id, name: 'Vendors 2026' })).rejects.toMatchObject({ code: 'FOLDER_EXISTS' })
      await renameFolder(tx, { accountId: alice.id, folderId: id, name: 'Suppliers' })
      const inboxId = await folderByRole(tx, alice.id, 'inbox')
      await expect(renameFolder(tx, { accountId: alice.id, folderId: inboxId, name: 'X' })).rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND' })
      expect((await listFolders(tx, alice.id)).map((f) => f.name)).toContain('Suppliers')

      // a message in the folder is not lost when the folder goes
      const sent = await sendMail(tx, { account: alice, userId: ALICE, idempotencyKey: 'k', allowExternal: true,
        draft: { to: ['x@ext.example'], subject: 'S', bodyHtml: '<p>s</p>' } })
      await bulk(tx, { account: alice, envelopeIds: [sent.sentEnvelopeId], op: { action: 'move', folderId: id } })
      expect(await deleteFolder(tx, { accountId: alice.id, folderId: id })).toEqual({ moved: 1 })
      const trash = await folderByRole(tx, alice.id, 'trash')
      expect((await getEnvelope(tx, sent.sentEnvelopeId))!.folder_id).toBe(trash)
      await expect(deleteFolder(tx, { accountId: alice.id, folderId: inboxId })).rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND' })
    })
  })

  it('bulk refuses to touch a message in someone else\'s mailbox, and flags many at once', async () => {
    const alice = await mailbox(ALICE, 'alice@acme.test')
    const bob = await mailbox(BOB, 'bob@acme.test')
    await withTenant(A.id, async (tx) => {
      const ids: string[] = []
      for (const s of ['one', 'two']) {
        await sendMail(tx, { account: alice, userId: ALICE, idempotencyKey: s, allowExternal: false,
          draft: { to: ['bob@acme.test'], subject: s, bodyHtml: '<p>x</p>' } })
      }
      const inbox = await folderByRole(tx, bob.id, 'inbox')
      for (const e of (await listEnvelopes(tx, { folderId: inbox })).envelopes) ids.push(e.id)
      expect(ids).toHaveLength(2)
      expect(await bulk(tx, { account: bob, envelopeIds: ids, op: { action: 'flag', flag: 'seen' } })).toEqual({ affected: 2 })
      expect((await listFolders(tx, bob.id)).find((f) => f.role === 'inbox')!.unread).toBe(0)
      await expect(bulk(tx, { account: alice, envelopeIds: ids, op: { action: 'delete' } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await bulk(tx, { account: bob, envelopeIds: ids, op: { action: 'delete' } })
      expect((await listFolders(tx, bob.id)).find((f) => f.role === 'trash')!.total).toBe(2)
    })
  })

  it('the signature is sanitised and reply-to validated', async () => {
    const alice = await mailbox(ALICE, 'alice@acme.test')
    await withTenant(A.id, async (tx) => {
      const s = await updateSettings(tx, alice.id, { signature_html: '<p>Alice<br><script>x()</script><a href="javascript:x()">HR</a></p>', reply_to: 'HR@Acme.test' })
      expect(s.signature_html).toBe('<p>Alice<br /><a>HR</a></p>')
      expect(s.reply_to).toBe('hr@acme.test')
      await expect(updateSettings(tx, alice.id, { reply_to: 'nope' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      expect(await getSettings(tx, alice.id)).toMatchObject({ reply_to: 'hr@acme.test', display_name: 'alice@acme.test' })
    })
  })

  it('suggests colleagues and your own recent recipients, never another mailbox\'s', async () => {
    const alice = await mailbox(ALICE, 'alice@acme.test')
    const bob = await mailbox(BOB, 'bob@acme.test')
    await withTenant(A.id, async (tx) => {
      await createUser(tx, { tenantId: A.id, email: 'priya.nair@acme.test', fullName: 'Priya Nair', password: 'a-long-password-1', roles: ['employee'] })
      await sendMail(tx, { account: alice, userId: ALICE, idempotencyKey: 'v', allowExternal: true,
        draft: { to: ['vendor@outside.example'], subject: 'V', bodyHtml: '<p>v</p>' } })
      expect(await suggestRecipients(tx, { accountId: alice.id, q: 'priya' })).toEqual([{ email: 'priya.nair@acme.test', name: 'Priya Nair', source: 'colleague' }])
      expect(await suggestRecipients(tx, { accountId: alice.id, q: 'vend' })).toEqual([{ email: 'vendor@outside.example', name: null, source: 'recent' }])
      expect(await suggestRecipients(tx, { accountId: bob.id, q: 'vend' })).toEqual([])
      expect(await suggestRecipients(tx, { accountId: alice.id, q: 'p' })).toEqual([])
    })
  })
})
