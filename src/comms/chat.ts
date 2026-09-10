/**
 * Chat: conversations, messages, read state.
 *
 * Read state is a watermark per member rather than a receipt row per message
 * per member — the latter is 60k rows a day in a 300-person group and is the
 * first thing to fall over.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { CommsError, tenantId } from './base.ts'


export async function createConversation(
  tx: PoolClient,
  args: { kind: 'dm' | 'group'; title?: string; createdBy: string; participants: readonly string[] },
): Promise<string> {
  const tid = await tenantId(tx)
  const id = randomUUID()
  await tx.query(
    `INSERT INTO conversations (tenant_id, id, kind, title, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [tid, id, args.kind, args.title ?? null, args.createdBy],
  )
  for (const userId of args.participants) {
    await tx.query(
      `INSERT INTO conversation_participants (tenant_id, conversation_id, user_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [tid, id, userId],
    )
  }
  return id
}

/** Idempotent by client_message_id, so an offline send can retry safely. */
export async function sendMessage(
  tx: PoolClient,
  args: {
    conversationId: string; senderUserId: string; body: string
    clientMessageId: string; hrmsRef?: Record<string, unknown>
  },
): Promise<{ id: number; created: boolean }> {
  const tid = await tenantId(tx)

  const member = await tx.query(
    `SELECT 1 FROM conversation_participants
      WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [args.conversationId, args.senderUserId],
  )
  if (member.rowCount === 0) {
    throw new CommsError('NOT_A_PARTICIPANT', 'sender is not in this conversation')
  }

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, client_message_id, sender_user_id, body, hrms_ref)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (tenant_id, conversation_id, client_message_id) DO NOTHING
     RETURNING id`,
    [tid, args.conversationId, args.clientMessageId, args.senderUserId, args.body,
     args.hrmsRef ? JSON.stringify(args.hrmsRef) : null],
  )

  if (rows[0]) {
    await tx.query(
      `UPDATE conversations SET last_message_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tid, args.conversationId],
    )
    return { id: Number(rows[0].id), created: true }
  }

  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM messages WHERE conversation_id = $1 AND client_message_id = $2`,
    [args.conversationId, args.clientMessageId],
  )
  return { id: Number(existing.rows[0]!.id), created: false }
}

/** Read state is a watermark per member, not a receipt row per message. */
export async function markRead(
  tx: PoolClient,
  args: { conversationId: string; userId: string; upToMessageId: number },
): Promise<void> {
  const tid = await tenantId(tx)
  await tx.query(
    `UPDATE conversation_participants
        SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), $4)
      WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
    [tid, args.conversationId, args.userId, args.upToMessageId],
  )
}

export async function unreadInConversation(
  tx: PoolClient,
  conversationId: string,
  userId: string,
): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM messages m
       JOIN conversation_participants p
         ON (p.tenant_id, p.conversation_id) = (m.tenant_id, m.conversation_id)
        AND p.user_id = $2
      WHERE m.conversation_id = $1
        AND m.id > COALESCE(p.last_read_message_id, 0)
        AND m.sender_user_id <> $2
        AND m.deleted_at IS NULL`,
    [conversationId, userId],
  )
  return rows[0]!.n
}

/** Lifecycle: a leaver loses chat access automatically. */
export async function removeFromAllConversations(
  tx: PoolClient,
  userId: string,
): Promise<number> {
  const tid = await tenantId(tx)
  const { rowCount } = await tx.query(
    `UPDATE conversation_participants SET left_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [tid, userId],
  )
  return rowCount ?? 0
}
// ---------------------------------------------------------------------------
// Reads — what a chat screen actually renders
// ---------------------------------------------------------------------------

export interface ConversationSummary {
  id: string
  kind: string
  title: string | null
  is_readonly: boolean
  last_message_at: string | null
  unread: number
  participant_ids: string[]
  last_message_body: string | null
}

/**
 * Every conversation this person is in, most recent first, with the unread
 * count and last line already joined in.
 *
 * One query rather than one per row: a chat list is the most frequently
 * refreshed screen in the product, and N+1 there is the whole page budget.
 */
export async function listConversations(
  tx: PoolClient,
  userId: string,
  limit = 100,
): Promise<ConversationSummary[]> {
  const { rows } = await tx.query<ConversationSummary>(
    `SELECT c.id, c.kind, c.title, c.is_readonly, c.last_message_at,
            (SELECT count(*)::int FROM messages m
              WHERE m.conversation_id = c.id
                AND m.id > COALESCE(me.last_read_message_id, 0)
                AND m.sender_user_id <> $1
                AND m.deleted_at IS NULL) AS unread,
            (SELECT coalesce(array_agg(p.user_id), '{}')
               FROM conversation_participants p
              WHERE p.conversation_id = c.id AND p.left_at IS NULL) AS participant_ids,
            (SELECT m.body FROM messages m
              WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
              ORDER BY m.id DESC LIMIT 1) AS last_message_body
       FROM conversations c
       JOIN conversation_participants me
         ON (me.tenant_id, me.conversation_id) = (c.tenant_id, c.id)
        AND me.user_id = $1 AND me.left_at IS NULL
      WHERE c.status = 'active'
      ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
      LIMIT $2`,
    [userId, Math.min(limit, 200)],
  )
  return rows
}

export interface ChatMessage {
  id: number
  conversation_id: string
  sender_user_id: string | null
  body: string | null
  content_type: string
  reply_to_message_id: number | null
  attachment_document_ids: string[]
  hrms_ref: Record<string, unknown> | null
  edited_at: string | null
  deleted_at: string | null
  sent_at: string
}

/** Throws unless the caller is a current member — chat has no read-only lurker. */
export async function assertParticipant(
  tx: PoolClient,
  conversationId: string,
  userId: string,
): Promise<void> {
  const { rowCount } = await tx.query(
    `SELECT 1 FROM conversation_participants
      WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [conversationId, userId],
  )
  if (!rowCount) throw new CommsError('NOT_A_PARTICIPANT', 'you are not in this conversation')
}

/**
 * A page of messages, newest last.
 *
 * Paged by message id, not offset: ids are monotonic per conversation, so a
 * message arriving mid-scroll cannot shift the page and duplicate a row.
 */
export async function listMessages(
  tx: PoolClient,
  args: { conversationId: string; userId: string; beforeId?: number; limit?: number },
): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  await assertParticipant(tx, args.conversationId, args.userId)
  const limit = Math.min(args.limit ?? 50, 200)
  const { rows } = await tx.query<ChatMessage>(
    `SELECT id, conversation_id, sender_user_id,
            CASE WHEN deleted_at IS NULL THEN body END AS body,
            content_type, reply_to_message_id, attachment_document_ids, hrms_ref,
            edited_at, deleted_at, sent_at
       FROM messages
      WHERE conversation_id = $1
        AND ($2::bigint IS NULL OR id < $2)
      ORDER BY id DESC
      LIMIT $3`,
    [args.conversationId, args.beforeId ?? null, limit + 1],
  )
  const hasMore = rows.length > limit
  return { messages: rows.slice(0, limit).reverse(), hasMore }
}

/** Attaches already-stored documents to a message the sender owns. */
export async function attachDocuments(
  tx: PoolClient,
  args: { conversationId: string; messageId: number; userId: string; documentIds: readonly string[] },
): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE messages SET attachment_document_ids = $3::uuid[]
      WHERE conversation_id = $1 AND id = $2 AND sender_user_id = $4 AND deleted_at IS NULL`,
    [args.conversationId, args.messageId, args.documentIds, args.userId],
  )
  if (!rowCount) throw new CommsError('MESSAGE_NOT_FOUND', 'no such message of yours')
}

/** You may edit your own message; the edit is stamped, never silent. */
export async function editMessage(
  tx: PoolClient,
  args: { conversationId: string; messageId: number; userId: string; body: string },
): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE messages SET body = $3, edited_at = now()
      WHERE conversation_id = $1 AND id = $2 AND sender_user_id = $4 AND deleted_at IS NULL`,
    [args.conversationId, args.messageId, args.body, args.userId],
  )
  if (!rowCount) throw new CommsError('MESSAGE_NOT_FOUND', 'no such message of yours')
}

/**
 * Deleting hides the body and keeps the row.
 *
 * The row is what stops the thread renumbering under everyone else's scroll
 * position, and what lets a compliance export still show that something was
 * said and withdrawn.
 */
export async function deleteMessage(
  tx: PoolClient,
  args: { conversationId: string; messageId: number; userId: string },
): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE messages SET deleted_at = now()
      WHERE conversation_id = $1 AND id = $2 AND sender_user_id = $3 AND deleted_at IS NULL`,
    [args.conversationId, args.messageId, args.userId],
  )
  if (!rowCount) throw new CommsError('MESSAGE_NOT_FOUND', 'no such message of yours')
}

/** Adds members to a group. A DM stays a DM: it never grows a third person. */
export async function addParticipants(
  tx: PoolClient,
  args: { conversationId: string; userIds: readonly string[]; actorUserId: string },
): Promise<number> {
  const tid = await tenantId(tx)
  await assertParticipant(tx, args.conversationId, args.actorUserId)
  const { rows } = await tx.query<{ kind: string }>(
    `SELECT kind FROM conversations WHERE id = $1`, [args.conversationId])
  if (!rows[0]) throw new CommsError('CONVERSATION_NOT_FOUND', 'no such conversation')
  if (rows[0].kind === 'dm') {
    throw new CommsError('CONVERSATION_READONLY', 'a direct message cannot take more people')
  }
  let added = 0
  for (const userId of args.userIds) {
    const r = await tx.query(
      `INSERT INTO conversation_participants (tenant_id, conversation_id, user_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, conversation_id, user_id)
       DO UPDATE SET left_at = NULL WHERE conversation_participants.left_at IS NOT NULL`,
      [tid, args.conversationId, userId],
    )
    added += r.rowCount ?? 0
  }
  return added
}

/** Leaving is not deleting: the history stays, the person stops receiving it. */
export async function leaveConversation(
  tx: PoolClient,
  conversationId: string,
  userId: string,
): Promise<void> {
  await tx.query(
    `UPDATE conversation_participants SET left_at = now()
      WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [conversationId, userId],
  )
}

/**
 * Deletes messages older than the retention window.
 *
 * The bodies and attachments go; the message rows stay as tombstones so a
 * thread does not renumber under everyone who still has it open, and a
 * compliance export can still show that something was said and aged out.
 *
 * Zero days means keep forever, which is the default: silently deleting a
 * company history because a field was left blank would be unforgivable.
 */
export async function purgeOldMessages(
  tx: PoolClient,
  retentionDays: number,
): Promise<number> {
  if (!retentionDays || retentionDays <= 0) return 0

  const { rows } = await tx.query<{ id: string }>(
    `UPDATE messages
        SET body = NULL,
            attachment_document_ids = '{}'::uuid[],
            deleted_at = COALESCE(deleted_at, now())
      WHERE sent_at < now() - make_interval(days => $1)
        AND (body IS NOT NULL OR cardinality(attachment_document_ids) > 0)
      RETURNING id::text`,
    [retentionDays],
  )
  return rows.length
}
