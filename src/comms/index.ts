/**
 * Announcements, notifications, chat and mail credentials.
 *
 * Announcements are first because they deliver most of what "we need internal
 * communication" means to an HR buyer — reach plus proof of acknowledgement —
 * with none of the real-time infrastructure chat requires.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import type { PoolClient } from 'pg'

export class CommsError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'CommsError'
  }
}

async function tenantId(tx: PoolClient): Promise<string> {
  const { rows } = await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')
  const t = rows[0]?.t
  if (!t) throw new CommsError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

export async function publishAnnouncement(
  tx: PoolClient,
  args: {
    announcementId: string
    audienceUserIds: readonly string[]
  },
): Promise<number> {
  const tid = await tenantId(tx)

  const { rows } = await tx.query<{ status: string }>(
    `SELECT status FROM announcements WHERE id = $1`, [args.announcementId],
  )
  if (!rows[0]) throw new CommsError('NOT_FOUND', 'no such announcement')
  if (rows[0].status === 'published') {
    throw new CommsError('ALREADY_PUBLISHED', 'this announcement is already published')
  }

  for (const userId of args.audienceUserIds) {
    await tx.query(
      `INSERT INTO announcement_receipts (tenant_id, announcement_id, user_id, delivered_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (tenant_id, announcement_id, user_id) DO NOTHING`,
      [tid, args.announcementId, userId],
    )
  }

  await tx.query(
    `UPDATE announcements SET status = 'published', publish_at = COALESCE(publish_at, now())
      WHERE tenant_id = $1 AND id = $2`,
    [tid, args.announcementId],
  )
  return args.audienceUserIds.length
}

/** Acknowledgement is evidence: a name, a timestamp and the version acknowledged. */
export async function acknowledge(
  tx: PoolClient,
  announcementId: string,
  userId: string,
): Promise<void> {
  const tid = await tenantId(tx)
  const { rowCount } = await tx.query(
    `UPDATE announcement_receipts
        SET viewed_at = COALESCE(viewed_at, now()), acknowledged_at = COALESCE(acknowledged_at, now())
      WHERE tenant_id = $1 AND announcement_id = $2 AND user_id = $3`,
    [tid, announcementId, userId],
  )
  if (rowCount === 0) {
    throw new CommsError('NOT_IN_AUDIENCE', 'this announcement was not addressed to that user')
  }
}

export interface AckStats {
  audience: number
  viewed: number
  acknowledged: number
  outstanding: string[]
}

/** "Did everyone read the new leave policy?" — the reason this module exists. */
export async function acknowledgementStats(
  tx: PoolClient,
  announcementId: string,
): Promise<AckStats> {
  const { rows } = await tx.query<{ user_id: string; viewed_at: Date | null; acknowledged_at: Date | null }>(
    `SELECT user_id, viewed_at, acknowledged_at FROM announcement_receipts WHERE announcement_id = $1`,
    [announcementId],
  )
  return {
    audience: rows.length,
    viewed: rows.filter((r) => r.viewed_at).length,
    acknowledged: rows.filter((r) => r.acknowledged_at).length,
    outstanding: rows.filter((r) => !r.acknowledged_at).map((r) => r.user_id),
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Deduped per (user, key) so a retried job notifies once, not five times. */
export async function notify(
  tx: PoolClient,
  args: {
    userId: string; eventType: string; title: string; body?: string
    entityType?: string; entityId?: string; channels?: string[]; dedupeKey?: string
  },
): Promise<boolean> {
  const tid = await tenantId(tx)
  const { rowCount } = await tx.query(
    `INSERT INTO notifications
       (tenant_id, user_id, event_type, title, body, entity_type, entity_id, channels, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [tid, args.userId, args.eventType, args.title, args.body ?? null,
     args.entityType ?? null, args.entityId ?? null, args.channels ?? ['in_app'],
     args.dedupeKey ?? null],
  )
  return rowCount === 1
}

export async function unreadCount(tx: PoolClient, userId: string): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
  )
  return rows[0]!.n
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function createConversation(
  tx: PoolClient,
  args: { kind: 'dm' | 'group'; title?: string; createdBy: string; participants: readonly string[] },
): Promise<string> {
  const tid = await tenantId(tx)
  const id = crypto.randomUUID()
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
// Mail credential custody
// ---------------------------------------------------------------------------

/**
 * Envelope encryption, per tenant. A compromise is bounded to one tenant, and
 * destroying a tenant's key makes its stored credentials unrecoverable.
 *
 * The key is NEVER derived from the app signing secret: rotating that would
 * silently brick every stored mailbox.
 */
function tenantKey(tenantIdValue: string, master: string, version = 1): Buffer {
  return scryptSync(`${master}:${tenantIdValue}`, `pepl.mail.dek.v${version}`, 32)
}

export function encryptSecret(plain: string, tenantIdValue: string, master: string): Buffer {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', tenantKey(tenantIdValue, master), iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct])
}

export function decryptSecret(blob: Buffer, tenantIdValue: string, master: string): string {
  const iv = blob.subarray(0, 12)
  const tag = blob.subarray(12, 28)
  const ct = blob.subarray(28)
  const d = createDecipheriv('aes-256-gcm', tenantKey(tenantIdValue, master), iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

export async function connectMailbox(
  tx: PoolClient,
  args: {
    userId: string; email: string; username: string; password: string
    imapHost: string; smtpHost: string; master: string
  },
): Promise<string> {
  const tid = await tenantId(tx)
  const id = crypto.randomUUID()
  await tx.query(
    `INSERT INTO mail_accounts
       (tenant_id, id, user_id, email, username, imap_host, imap_port, imap_secure,
        smtp_host, smtp_port, smtp_secure, secret_ciphertext)
     VALUES ($1,$2,$3,$4,$5,$6,993,true,$7,587,false,$8)`,
    [tid, id, args.userId, args.email, args.username, args.imapHost, args.smtpHost,
     encryptSecret(args.password, tid, args.master)],
  )
  return id
}

/** Disconnecting destroys the credential immediately. One click, and it completes. */
export async function disconnectMailbox(tx: PoolClient, accountId: string): Promise<void> {
  const tid = await tenantId(tx)
  await tx.query('DELETE FROM mail_accounts WHERE tenant_id = $1 AND id = $2', [tid, accountId])
}
