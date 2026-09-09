/** Mail — mailbox, folders, messages, compose. */
import type { Router } from '../router.ts'
import {
  HttpError, authed, ok, created, noContent, requireBody, requireModule, asUuid, asInt, emit,
} from './deps.ts'
import {
  deleteMessage, ensureAccount, findAccountByUser, folderByRole, getEnvelope,
  listEnvelopes, listFolders, listThread, moveToFolder, openMessage, saveDraft,
  sendMail, setFlag, type Flag, type MailAccount,
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
      return ok(message)
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

      const result = await sendMail(ctx.tx, {
        account,
        userId: ctx.session.userId,
        idempotencyKey: b.idempotencyKey,
        allowExternal: ctx.config.isEnabled('mail.allow_external_recipients'),
        draft: {
          to: b.to, cc: b.cc, bcc: b.bcc, subject: b.subject, bodyHtml: b.bodyHtml,
          inReplyTo: b.inReplyTo ?? null, threadKey: b.threadKey ?? null,
          attachmentDocumentIds: b.attachmentDocumentIds?.map((id) => asUuid(id, 'attachmentDocumentIds')),
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
      return created(result)
    }))

  router.post('/api/v1/mail/drafts',
    { summary: 'Save a draft (pass draftId to replace one)', tag: 'mail',
      requestExample: { to: [], subject: 'Notes', bodyHtml: '<p>…</p>' } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'mail.enabled')
      const account = await myAccount(ctx)
      const b = requireBody<{
        to?: string[]; cc?: string[]; subject: string; bodyHtml: string; draftId?: string
      }>(ctx.req, ['subject', 'bodyHtml'])
      const id = await saveDraft(ctx.tx, {
        account,
        draftId: b.draftId ? asUuid(b.draftId, 'draftId') : undefined,
        draft: { to: b.to ?? [], cc: b.cc, subject: b.subject, bodyHtml: b.bodyHtml },
      })
      return created({ id })
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
