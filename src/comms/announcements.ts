/**
 * Announcements live in chat.
 *
 * Every company has one read-only conversation called "Announcements" that
 * every active person is in. Posting an announcement writes the announcement
 * row (the record: audience, acknowledgement, expiry), a receipt per reader,
 * and one message in that conversation carrying the announcement id in
 * `hrms_ref` — so it appears where people already look, with the unread
 * badge, live updates and search chat already has, and "acknowledge" is a
 * button on the message rather than a screen nobody visits.
 *
 * Only holders of `announcement.create` can post there; the conversation's
 * `is_readonly` flag is enforced in the chat route, not left to the UI.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { CommsError, tenantId } from './base.ts'
import { sanitizeHtml } from '../mail/sanitize.ts'
import { htmlToText } from '../mail/mime.ts'

export const CHANNEL_TITLE = 'Announcements'

/** The company's announcement channel, created on first use, membership topped up. */
export async function ensureAnnouncementChannel(tx: PoolClient, createdBy: string | null): Promise<string> {
  const tid = await tenantId(tx)
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM conversations WHERE kind = 'announcement' AND status = 'active' ORDER BY created_at LIMIT 1`)
  let id = rows[0]?.id
  if (!id) {
    id = randomUUID()
    await tx.query(
      `INSERT INTO conversations (tenant_id, id, kind, title, created_by_user_id, is_readonly)
       VALUES ($1,$2,'announcement',$3,$4,true)`, [tid, id, CHANNEL_TITLE, createdBy])
  }
  // Everyone active is a member; someone who joined the company since is added here.
  await tx.query(
    `INSERT INTO conversation_participants (tenant_id, conversation_id, user_id)
     SELECT $1, $2, u.id FROM app_users u WHERE u.status = 'active'
     ON CONFLICT DO NOTHING`, [tid, id])
  await tx.query(
    `UPDATE conversation_participants SET left_at = NULL
      WHERE conversation_id = $1 AND left_at IS NOT NULL
        AND user_id IN (SELECT id FROM app_users WHERE status = 'active')`, [id])
  return id
}

export interface Announcement {
  id: string
  title: string
  body_html: string
  author_user_id: string | null
  requires_acknowledgement: boolean
  publish_at: string | null
  expires_at: string | null
  status: string
  audience: Record<string, unknown>
  /** From the caller's own receipt; null when they are not in the audience. */
  acknowledged_at: string | null
  viewed_at: string | null
  in_audience: boolean
  /** Audience size and how many have acknowledged — for the author's view. */
  delivered: number
  acknowledged: number
  message_id: number | null
  conversation_id: string | null
}

const COLUMNS = `a.id, a.title, a.body_html, a.author_user_id, a.requires_acknowledgement,
  a.publish_at::text, a.expires_at::text, a.status, a.audience,
  me.acknowledged_at::text, me.viewed_at::text, (me.user_id IS NOT NULL) AS in_audience,
  (SELECT count(*)::int FROM announcement_receipts r WHERE r.announcement_id = a.id) AS delivered,
  (SELECT count(*)::int FROM announcement_receipts r WHERE r.announcement_id = a.id AND r.acknowledged_at IS NOT NULL) AS acknowledged,
  (SELECT m.id::int FROM messages m WHERE m.hrms_ref->>'announcementId' = a.id::text AND m.deleted_at IS NULL LIMIT 1) AS message_id,
  (SELECT m.conversation_id FROM messages m WHERE m.hrms_ref->>'announcementId' = a.id::text AND m.deleted_at IS NULL LIMIT 1) AS conversation_id`

/**
 * Creates and publishes in one step. Audience: everyone active (default), or
 * an explicit user list. Returns the announcement as the author sees it.
 */
export async function postAnnouncement(
  tx: PoolClient,
  args: {
    authorUserId: string
    title: string
    bodyHtml: string
    requiresAcknowledgement?: boolean
    expiresAt?: string | null
    audienceUserIds?: readonly string[]
    channels?: readonly string[]
  },
): Promise<Announcement> {
  const title = args.title.trim().slice(0, 200)
  if (!title) throw new CommsError('VALIDATION_FAILED', 'an announcement needs a title')
  const bodyHtml = sanitizeHtml(args.bodyHtml)
  if (!htmlToText(bodyHtml)) throw new CommsError('VALIDATION_FAILED', 'an announcement needs a body')

  const tid = await tenantId(tx)
  const id = randomUUID()
  const audience = args.audienceUserIds?.length ? { userIds: args.audienceUserIds } : { all: true }
  await tx.query(
    `INSERT INTO announcements
       (tenant_id, id, title, body_html, author_user_id, audience, channels, requires_acknowledgement,
        publish_at, expires_at, status)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8, now(), $9, 'published')`,
    [tid, id, title, bodyHtml, args.authorUserId, JSON.stringify(audience),
     args.channels ?? ['in_app'], args.requiresAcknowledgement ?? false, args.expiresAt ?? null])

  if (args.audienceUserIds?.length) {
    await tx.query(
      `INSERT INTO announcement_receipts (tenant_id, announcement_id, user_id, delivered_at)
       SELECT $1, $2, u.id, now() FROM app_users u WHERE u.id = ANY($3::uuid[]) AND u.status = 'active'
       ON CONFLICT DO NOTHING`, [tid, id, args.audienceUserIds])
  } else {
    await tx.query(
      `INSERT INTO announcement_receipts (tenant_id, announcement_id, user_id, delivered_at)
       SELECT $1, $2, u.id, now() FROM app_users u WHERE u.status = 'active'
       ON CONFLICT DO NOTHING`, [tid, id])
  }

  // The message everyone sees. Body is the plain text; the HTML is on the record.
  const conversationId = await ensureAnnouncementChannel(tx, args.authorUserId)
  await tx.query(
    `INSERT INTO messages (tenant_id, conversation_id, client_message_id, sender_user_id, body, content_type, hrms_ref)
     VALUES ($1,$2,$3,$4,$5,'announcement',$6::jsonb)`,
    [tid, conversationId, `announcement:${id}`, args.authorUserId,
     `${title}\n\n${htmlToText(bodyHtml)}`,
     JSON.stringify({ announcementId: id, title, requiresAcknowledgement: args.requiresAcknowledgement ?? false,
       audience: audience.all ? 'all' : 'selected' })])
  await tx.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [conversationId])

  return (await getAnnouncement(tx, id, args.authorUserId))!
}

export async function getAnnouncement(tx: PoolClient, id: string, userId: string): Promise<Announcement | null> {
  const { rows } = await tx.query<Announcement>(
    `SELECT ${COLUMNS} FROM announcements a
       LEFT JOIN announcement_receipts me ON me.announcement_id = a.id AND me.user_id = $2
      WHERE a.id = $1`, [id, userId])
  return rows[0] ?? null
}

/**
 * What this person can see: everything published to them (with their receipt),
 * plus — for an author — their own, whoever the audience was.
 */
export async function listAnnouncements(
  tx: PoolClient, args: { userId: string; canManage: boolean; includeExpired?: boolean; limit?: number },
): Promise<Announcement[]> {
  const { rows } = await tx.query<Announcement>(
    `SELECT ${COLUMNS} FROM announcements a
       LEFT JOIN announcement_receipts me ON me.announcement_id = a.id AND me.user_id = $1
      WHERE a.status = 'published'
        AND (me.user_id IS NOT NULL OR $2)
        AND ($3 OR a.expires_at IS NULL OR a.expires_at > now())
      ORDER BY a.publish_at DESC
      LIMIT $4`,
    [args.userId, args.canManage, args.includeExpired ?? false, Math.min(args.limit ?? 50, 200)])
  return rows
}

/** Marks the caller's receipt viewed; the dashboard and chat both call this on open. */
export async function markViewed(tx: PoolClient, id: string, userId: string): Promise<void> {
  await tx.query(
    `UPDATE announcement_receipts SET viewed_at = coalesce(viewed_at, now())
      WHERE announcement_id = $1 AND user_id = $2`, [id, userId])
}

/** Withdrawn: gone from every list, and the chat message is soft-deleted with it. */
export async function withdrawAnnouncement(tx: PoolClient, id: string): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE announcements SET status = 'withdrawn' WHERE id = $1 AND status = 'published'`, [id])
  if (!rowCount) throw new CommsError('NOT_FOUND', 'no such published announcement')
  await tx.query(
    `UPDATE messages SET deleted_at = now(), body = NULL
      WHERE hrms_ref->>'announcementId' = $1::text AND deleted_at IS NULL`, [id])
}

/** Who has not acknowledged yet — the author's chase list. */
export async function pendingAcknowledgements(
  tx: PoolClient, id: string,
): Promise<{ user_id: string; full_name: string | null; email: string; viewed_at: string | null }[]> {
  const { rows } = await tx.query<{ user_id: string; full_name: string | null; email: string; viewed_at: string | null }>(
    `SELECT r.user_id, u.full_name, u.email, r.viewed_at::text
       FROM announcement_receipts r JOIN app_users u ON u.id = r.user_id
      WHERE r.announcement_id = $1 AND r.acknowledged_at IS NULL
      ORDER BY u.full_name NULLS LAST, u.email`, [id])
  return rows
}
