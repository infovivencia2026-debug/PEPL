/** Mail — mailbox, folders, messages, compose. */
import type { Router } from '../router.ts'
import {
  HttpError, authed, ok, created, noContent, requireBody, requireModule, asUuid, asInt, emit,
} from './deps.ts'
import {
  deleteMessage, ensureAccount, findAccountByUser, folderByRole, getEnvelope,
  listEnvelopes, listFolders, listThread, moveToFolder, openMessage, saveDraft,
  sendMail, setFlag, type Flag, type MailAccount,
  listAttachments, readAttachment, uploadAttachment, assertAttachmentsUsable, MAX_ATTACHMENT_BYTES,
  createFolder, renameFolder, deleteFolder, getSettings, updateSettings, bulk, suggestRecipients,
  type BulkAction,
} from '../../mail/index.ts'
import type { Ctx } from '../context.ts'

/**
 * The caller's own mailbox, created on first visit.
 *
 * Provisioning lazily means a company that never turns mail on carries no rows
 * for it, and turning it on needs no migration of existing people.
 */
async function myAccount(ctx: Ctx): Promise<MailAccount> {
  const existing = await findAccountByUser(ctx.tx, ctx.session.userId)
  if (existing) return existing
  const { rows } = await ctx.tx.query<{ email: string; full_name: string | null }>(
    `SELECT email, full_name FROM app_users WHERE id = $1`, [ctx.session.userId],
  )
  const user = rows[0]
  if (!user) throw new HttpError(404, 'MAILBOX_NOT_FOUND', 'this account has no user record')
  return ensureAccount(ctx.tx, {
    userId: ctx.session.userId, email: user.email, displayName: user.full_name,
  })
}

/** A message must belong to the caller's own mailbox to be touched at all. */
async function assertOwnMessage(ctx: Ctx, accountId: string, envelopeId: string): Promise<void> {
  const { rowCount } = await ctx.tx.query(
    `SELECT 1 FROM mail_envelopes WHERE id = $1 AND account_id = $2`, [envelopeId, accountId],
  )
  if (!rowCount) throw new HttpError(404, 'NOT_FOUND', 'no such message')
}

const FLAGS: readonly Flag[] = ['seen', 'unseen', 'flagged', 'unflagged']

export function register(router: Router): void {
  router.get('/api/v1/mail/folders',
    { summary: 'Your mailbox and its folders, with unread counts', tag: 'mail' },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      return ok({ account, folders: await listFolders(ctx.tx, account.id) })
    }))

  router.get('/api/v1/mail/messages',
    { summary: 'A page of one folder, newest first', tag: 'mail' },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      const folder = ctx.req.query.get('folderId')
      const folderId = folder
        ? asUuid(folder, 'folderId')
        : await folderByRole(ctx.tx, account.id, 'inbox')
      const before = ctx.req.query.get('before')
      return ok(await listEnvelopes(ctx.tx, {
        folderId,
        before: before ?? undefined,
        search: ctx.req.query.get('q') ?? undefined,
        limit: asInt(ctx.req.query.get('limit') ?? 50, 'limit', { min: 1, max: 200 }),
      }))
    }))

  router.get('/api/v1/mail/messages/:id',
    { summary: 'Open a message: body included, marked read', tag: 'mail' },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      const id = asUuid(ctx.req.params.id, 'id')
      await assertOwnMessage(ctx, account.id, id)
      const message = await openMessage(ctx.tx, id)
      if (!message) throw new HttpError(404, 'NOT_FOUND', 'no such message')
      return ok({ ...message, attachments: await listAttachments(ctx.tx, id) })
    }))

  router.get('/api/v1/mail/threads/:threadKey',
    { summary: 'Every message in one conversation', tag: 'mail' },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      return ok({
        messages: await listThread(ctx.tx, {
          accountId: account.id, threadKey: ctx.req.params.threadKey ?? '',
        }),
      })
    }))

  router.post('/api/v1/mail/messages',
    { summary: 'Send a message (idempotent on idempotencyKey)', tag: 'mail',
      requestExample: {
        to: ['priya@acme.com'], subject: 'Payroll cutoff',
        bodyHtml: '<p>Inputs freeze on the 25th.</p>', idempotencyKey: 'a1b2',
      } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      const b = requireBody<{
        to: string[]; cc?: string[]; bcc?: string[]; subject: string; bodyHtml: string
        idempotencyKey: string; inReplyTo?: string; threadKey?: string
        attachmentDocumentIds?: string[]; draftId?: string
      }>(ctx.req, ['to', 'subject', 'bodyHtml', 'idempotencyKey'])

      if (!Array.isArray(b.to) || b.to.length === 0) {
        throw new HttpError(422, 'NO_RECIPIENTS', 'a message needs at least one recipient')
      }
      const attachmentIds = (b.attachmentDocumentIds ?? []).map((id) => asUuid(id, 'attachmentDocumentIds'))
      await assertAttachmentsUsable(ctx.tx, { accountId: account.id, documentIds: attachmentIds })

      const result = await sendMail(ctx.tx, {
        account,
        userId: ctx.session.userId,
        idempotencyKey: b.idempotencyKey,
        allowExternal: ctx.config.isEnabled('mail.allow_external_recipients'),
        draft: {
          to: b.to, cc: b.cc, bcc: b.bcc, subject: b.subject, bodyHtml: b.bodyHtml,
          inReplyTo: b.inReplyTo ?? null, threadKey: b.threadKey ?? null,
          attachmentDocumentIds: attachmentIds,
        },
      })

      // The draft that became this message stops existing.
      if (b.draftId) {
        const draft = await getEnvelope(ctx.tx, asUuid(b.draftId, 'draftId'))
        if (draft?.is_draft) {
          await ctx.tx.query(`DELETE FROM mail_envelopes WHERE id = $1`, [b.draftId])
        }
      }

      await emit(ctx.tx, {
        action: 'mail.message.sent', entityType: 'mail_message', entityId: result.sentEnvelopeId,
        actorUserId: ctx.session.userId,
        metadata: { delivered: result.deliveredTo.length, queued: result.queuedFor.length },
      })
      if (result.deliveredTo.length) {
        const recipients = await ctx.tx.query<{ user_id: string }>(
          `SELECT user_id FROM mail_accounts WHERE lower(email) = ANY($1)`,
          [result.deliveredTo])
        ctx.publish({
          type: 'mail.delivered',
          userIds: recipients.rows.map((r) => r.user_id),
          data: { subject: b.subject, from: account.email },
        })
      }
      return created(result)
    }))

  router.post('/api/v1/mail/drafts',
    { summary: 'Save a draft (pass draftId to replace one)', tag: 'mail',
      requestExample: { to: [], subject: 'Notes', bodyHtml: '<p>…</p>' } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      const b = requireBody<{
        to?: string[]; cc?: string[]; bcc?: string[]; subject: string; bodyHtml: string; draftId?: string
        attachmentDocumentIds?: string[]; inReplyTo?: string; threadKey?: string
      }>(ctx.req, ['subject', 'bodyHtml'])
      const attachmentIds = (b.attachmentDocumentIds ?? []).map((id) => asUuid(id, 'attachmentDocumentIds'))
      await assertAttachmentsUsable(ctx.tx, { accountId: account.id, documentIds: attachmentIds })
      const id = await saveDraft(ctx.tx, {
        account,
        draftId: b.draftId ? asUuid(b.draftId, 'draftId') : undefined,
        draft: {
          to: b.to ?? [], cc: b.cc, bcc: b.bcc, subject: b.subject, bodyHtml: b.bodyHtml,
          attachmentDocumentIds: attachmentIds, inReplyTo: b.inReplyTo ?? null, threadKey: b.threadKey ?? null,
        },
      })
      return created({ id })
    }))

  router.post('/api/v1/mail/attachments',
    { summary: 'Upload a file to attach to a message you are writing (base64)', tag: 'mail',
      requestExample: { fileName: 'quote.pdf', contentType: 'application/pdf', contentBase64: 'JVBERi0…' } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      const b = requireBody<{ fileName: string; contentType: string; contentBase64: string }>(
        ctx.req, ['fileName', 'contentType', 'contentBase64'])
      if (b.contentBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 16) {
        throw new HttpError(413, 'ATTACHMENT_TOO_LARGE',
          `an attachment may be at most ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`)
      }
      const meta = await uploadAttachment(ctx.tx, {
        accountId: account.id, userId: ctx.session.userId,
        fileName: b.fileName, contentType: b.contentType, bytes: Buffer.from(b.contentBase64, 'base64'),
      })
      return created({ documentId: meta.id, fileName: meta.file_name, contentType: meta.content_type, sizeBytes: meta.size_bytes })
    }))

  router.get('/api/v1/mail/messages/:id/attachments/:documentId/content',
    { summary: 'Download one attachment of a message in your mailbox (base64)', tag: 'mail' },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      const id = asUuid(ctx.req.params.id, 'id')
      await assertOwnMessage(ctx, account.id, id)
      const found = await readAttachment(ctx.tx, { envelopeId: id, documentId: asUuid(ctx.req.params.documentId, 'documentId') })
      if (!found) throw new HttpError(404, 'NOT_FOUND', 'no such attachment on this message')
      return ok({ fileName: found.meta.file_name, contentType: found.meta.content_type,
        sizeBytes: found.meta.size_bytes, contentBase64: found.bytes.toString('base64') })
    }))

  router.get('/api/v1/mail/settings',
    { summary: 'Your mailbox settings: display name, signature, reply-to', tag: 'mail' },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      return ok(await getSettings(ctx.tx, account.id))
    }))

  router.patch('/api/v1/mail/settings',
    { summary: 'Change your signature (HTML, sanitised), reply-to or display name', tag: 'mail',
      requestExample: { signature_html: '<p>Priya Nair<br>HR, Acme</p>' } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      const b = requireBody<{ signature_html?: string | null; reply_to?: string | null; display_name?: string | null }>(ctx.req, [])
      return ok(await updateSettings(ctx.tx, account.id, b))
    }))

  router.get('/api/v1/mail/recipients',
    { summary: 'Recipient suggestions while typing: colleagues, then people you have written to', tag: 'mail' },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      return ok({ suggestions: await suggestRecipients(ctx.tx, { accountId: account.id, q: ctx.req.query.get('q') ?? '' }) })
    }))

  router.post('/api/v1/mail/folders',
    { summary: 'Create a folder', tag: 'mail', requestExample: { name: 'Vendors' } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      const b = requireBody<{ name: string }>(ctx.req, ['name'])
      return created(await createFolder(ctx.tx, { accountId: account.id, name: b.name }))
    }))

  router.patch('/api/v1/mail/folders/:id',
    { summary: 'Rename a folder you created', tag: 'mail', requestExample: { name: 'Suppliers' } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      const b = requireBody<{ name: string }>(ctx.req, ['name'])
      await renameFolder(ctx.tx, { accountId: account.id, folderId: asUuid(ctx.req.params.id, 'id'), name: b.name })
      return noContent()
    }))

  router.del('/api/v1/mail/folders/:id',
    { summary: 'Delete a folder you created; its messages go to Trash', tag: 'mail' },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      return ok(await deleteFolder(ctx.tx, { accountId: account.id, folderId: asUuid(ctx.req.params.id, 'id') }))
    }))

  router.post('/api/v1/mail/messages/bulk',
    { summary: 'Mark, move or delete many messages at once', tag: 'mail',
      requestExample: { ids: ['…', '…'], action: 'flag', flag: 'seen' } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      const b = requireBody<{ ids: string[]; action: string; flag?: Flag; folderId?: string }>(ctx.req, ['ids', 'action'])
      if (!Array.isArray(b.ids)) throw new HttpError(422, 'VALIDATION_FAILED', 'ids must be an array')
      const ids = b.ids.map((id) => asUuid(id, 'ids'))
      let op: BulkAction
      if (b.action === 'flag') {
        if (!b.flag || !FLAGS.includes(b.flag)) throw new HttpError(422, 'VALIDATION_FAILED', `flag must be one of: ${FLAGS.join(', ')}`)
        op = { action: 'flag', flag: b.flag }
      } else if (b.action === 'move') {
        if (!b.folderId) throw new HttpError(422, 'VALIDATION_FAILED', 'folderId is required to move')
        op = { action: 'move', folderId: asUuid(b.folderId, 'folderId') }
      } else if (b.action === 'delete') {
        op = { action: 'delete' }
      } else {
        throw new HttpError(422, 'VALIDATION_FAILED', 'action must be flag, move or delete')
      }
      return ok(await bulk(ctx.tx, { account, envelopeIds: ids, op }))
    }))

  router.post('/api/v1/mail/messages/:id/flag',
    { summary: 'Mark read, unread, flagged or unflagged', tag: 'mail',
      requestExample: { flag: 'flagged' } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      const id = asUuid(ctx.req.params.id, 'id')
      await assertOwnMessage(ctx, account.id, id)
      const b = requireBody<{ flag: Flag }>(ctx.req, ['flag'])
      if (!FLAGS.includes(b.flag)) {
        throw new HttpError(422, 'VALIDATION_FAILED', `flag must be one of: ${FLAGS.join(', ')}`)
      }
      await setFlag(ctx.tx, id, b.flag)
      return noContent()
    }))

  router.post('/api/v1/mail/messages/:id/move',
    { summary: 'Move a message to another folder', tag: 'mail',
      requestExample: { folderId: '…' } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      const id = asUuid(ctx.req.params.id, 'id')
      await assertOwnMessage(ctx, account.id, id)
      const b = requireBody<{ folderId: string }>(ctx.req, ['folderId'])
      await moveToFolder(ctx.tx, { envelopeId: id, folderId: asUuid(b.folderId, 'folderId') })
      return noContent()
    }))

  router.del('/api/v1/mail/messages/:id',
    { summary: 'Move to Trash, or purge if already there', tag: 'mail' },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      const id = asUuid(ctx.req.params.id, 'id')
      await assertOwnMessage(ctx, account.id, id)
      return ok(await deleteMessage(ctx.tx, { envelopeId: id, accountId: account.id }))
    }))
}
