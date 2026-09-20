/** Chat — conversations, messages, read state. */
import type { Router } from '../router.ts'
import {
  HttpError, authed, ok, created, noContent, requireBody, requireModule,
  asUuid, asInt, emit,
} from './deps.ts'
import {
  addParticipants, assertParticipant, attachDocuments, createConversation,
  deleteMessage, editMessage, leaveConversation, listConversations, listMessages,
  markRead, sendMessage,
} from '../../comms/chat.ts'

/** Chat is per-person, so there is no scope check: membership IS the check. */
export function register(router: Router): void {
  router.get('/api/v1/chat/conversations',
    { summary: 'Conversations this person is in, newest first', tag: 'chat' },
    authed(null, async (ctx) => {
      requireModule(ctx, 'chat.enabled')
      // Someone who joined after the last announcement is added to the channel on their first look.
      await ctx.tx.query(
        `INSERT INTO conversation_participants (tenant_id, conversation_id, user_id)
         SELECT c.tenant_id, c.id, $1 FROM conversations c WHERE c.kind = 'announcement' AND c.status = 'active'
         ON CONFLICT DO NOTHING`, [ctx.session.userId])
      return ok({ conversations: await listConversations(ctx.tx, ctx.session.userId) })
    }))

  router.post('/api/v1/chat/conversations',
    { summary: 'Start a direct message or a group', tag: 'chat',
      requestExample: { kind: 'group', title: 'Payroll cutoff', participantUserIds: [] } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'chat.enabled')
      const b = requireBody<{ kind: 'dm' | 'group'; title?: string; participantUserIds: string[] }>(
        ctx.req, ['kind', 'participantUserIds'])
      if (b.kind !== 'dm' && b.kind !== 'group') {
        throw new HttpError(422, 'VALIDATION_FAILED', 'kind must be "dm" or "group"')
      }
      if (b.kind === 'group' && !ctx.config.isEnabled('chat.allow_groups')) {
        throw new HttpError(403, 'MODULE_NOT_AVAILABLE',
          'group conversations are switched off for this company', { key: 'chat.allow_groups' })
      }
      const others = b.participantUserIds.map((id) => asUuid(id, 'participantUserIds'))
      if (others.length === 0) {
        throw new HttpError(422, 'NO_PARTICIPANTS', 'a conversation needs at least one other person')
      }
      if (b.kind === 'dm' && others.length !== 1) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'a direct message has exactly one other person')
      }
      // The creator is always a member: a conversation you cannot read is a bug.
      const participants = [...new Set([ctx.session.userId, ...others])]
      const id = await createConversation(ctx.tx, {
        kind: b.kind, title: b.title, createdBy: ctx.session.userId, participants,
      })
      await emit(ctx.tx, {
        action: 'comms.conversation.created', entityType: 'conversation', entityId: id,
        actorUserId: ctx.session.userId,
        metadata: { kind: b.kind, participantCount: participants.length },
      })
      ctx.publish({ type: 'chat.conversation', userIds: participants, data: { conversationId: id } })
      return created({ id })
    }))

  router.get('/api/v1/chat/conversations/:id/messages',
    { summary: 'A page of messages, oldest first within the page', tag: 'chat' },
    authed(null, async (ctx) => {
      requireModule(ctx, 'chat.enabled')
      const before = ctx.req.query.get('beforeId')
      return ok(await listMessages(ctx.tx, {
        conversationId: asUuid(ctx.req.params.id, 'id'),
        userId: ctx.session.userId,
        beforeId: before ? asInt(before, 'beforeId', { min: 1 }) : undefined,
        limit: asInt(ctx.req.query.get('limit') ?? 50, 'limit', { min: 1, max: 200 }),
      }))
    }))

  router.post('/api/v1/chat/conversations/:id/messages',
    { summary: 'Send a message (idempotent on clientMessageId)', tag: 'chat',
      requestExample: { clientMessageId: 'c8f1', body: 'Payroll locks at 6pm.' } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'chat.enabled')
      const conversationId = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ clientMessageId: string; body: string; documentIds?: string[] }>(
        ctx.req, ['clientMessageId', 'body'])

      // The Announcements channel is read-only: use POST /announcements, which
      // records the audience and acknowledgements a plain message cannot.
      const { rows: conv } = await ctx.tx.query<{ is_readonly: boolean }>(
        `SELECT is_readonly FROM conversations WHERE id = $1`, [conversationId])
      if (conv[0]?.is_readonly) {
        throw new HttpError(409, 'CONVERSATION_READONLY',
          'this channel is read-only; post an announcement instead', { announcements: '/api/v1/announcements' })
      }

      const result = await sendMessage(ctx.tx, {
        conversationId,
        senderUserId: ctx.session.userId,
        body: b.body,
        clientMessageId: b.clientMessageId,
      })

      if (b.documentIds?.length) {
        if (!ctx.config.isEnabled('chat.allow_attachments')) {
          throw new HttpError(403, 'MODULE_NOT_AVAILABLE',
            'file sharing in chat is switched off for this company',
            { key: 'chat.allow_attachments' })
        }
        await attachDocuments(ctx.tx, {
          conversationId, messageId: result.id, userId: ctx.session.userId,
          documentIds: b.documentIds.map((id) => asUuid(id, 'documentIds')),
        })
      }

      // Only a genuinely new message is logged; a retry must not double the trail.
      if (result.created) {
        await emit(ctx.tx, {
          action: 'comms.message.sent', entityType: 'conversation', entityId: conversationId,
          actorUserId: ctx.session.userId, metadata: { messageId: result.id },
        })
        // Only the people in the conversation are told, and only once it is
        // actually committed.
        const members = await ctx.tx.query<{ user_id: string }>(
          `SELECT user_id FROM conversation_participants
            WHERE conversation_id = $1 AND left_at IS NULL`,
          [conversationId])
        ctx.publish({
          type: 'chat.message',
          userIds: members.rows.map((r) => r.user_id),
          data: { conversationId, messageId: result.id, senderUserId: ctx.session.userId },
        })
      }
      return created(result)
    }))

  router.patch('/api/v1/chat/conversations/:id/messages/:messageId',
    { summary: 'Edit your own message', tag: 'chat', requestExample: { body: 'corrected text' } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'chat.enabled')
      const b = requireBody<{ body: string }>(ctx.req, ['body'])
      await editMessage(ctx.tx, {
        conversationId: asUuid(ctx.req.params.id, 'id'),
        messageId: asInt(ctx.req.params.messageId, 'messageId', { min: 1 }),
        userId: ctx.session.userId,
        body: b.body,
      })
      return noContent()
    }))

  router.del('/api/v1/chat/conversations/:id/messages/:messageId',
    { summary: 'Delete your own message (the row stays, the body goes)', tag: 'chat' },
    authed(null, async (ctx) => {
      requireModule(ctx, 'chat.enabled')
      await deleteMessage(ctx.tx, {
        conversationId: asUuid(ctx.req.params.id, 'id'),
        messageId: asInt(ctx.req.params.messageId, 'messageId', { min: 1 }),
        userId: ctx.session.userId,
      })
      return noContent()
    }))

  router.post('/api/v1/chat/conversations/:id/read',
    { summary: 'Move your read watermark', tag: 'chat', requestExample: { upToMessageId: 412 } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'chat.enabled')
      const conversationId = asUuid(ctx.req.params.id, 'id')
      await assertParticipant(ctx.tx, conversationId, ctx.session.userId)
      const b = requireBody<{ upToMessageId: number }>(ctx.req, ['upToMessageId'])
      await markRead(ctx.tx, {
        conversationId,
        userId: ctx.session.userId,
        upToMessageId: asInt(b.upToMessageId, 'upToMessageId', { min: 1 }),
      })
      return noContent()
    }))

  router.post('/api/v1/chat/conversations/:id/participants',
    { summary: 'Add people to a group', tag: 'chat', requestExample: { userIds: [] } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'chat.enabled')
      const b = requireBody<{ userIds: string[] }>(ctx.req, ['userIds'])
      const added = await addParticipants(ctx.tx, {
        conversationId: asUuid(ctx.req.params.id, 'id'),
        userIds: b.userIds.map((id) => asUuid(id, 'userIds')),
        actorUserId: ctx.session.userId,
      })
      return ok({ added })
    }))

  router.post('/api/v1/chat/conversations/:id/leave',
    { summary: 'Leave a conversation', tag: 'chat' },
    authed(null, async (ctx) => {
      requireModule(ctx, 'chat.enabled')
      await leaveConversation(ctx.tx, asUuid(ctx.req.params.id, 'id'), ctx.session.userId)
      return noContent()
    }))
}
