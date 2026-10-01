/**
 * Announcements, notifications, chat and mail credentials.
 *
 * Announcements are first because they deliver most of what "we need internal
 * communication" means to an HR buyer — reach plus proof of acknowledgement —
 * with none of the real-time infrastructure chat requires.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import type { PoolClient } from 'pg'
import { CommsError, tenantId } from './base.ts'
import { MailError, assertMayClaim, findAccountByEmail, provisionFolders } from '../mail/accounts.ts'
import { assertMailEndpoint } from '../mail/hosts.ts'

export { CommsError, tenantId } from './base.ts'
export * from './chat.ts'
export * from './announcements.ts'

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
    /** Documents to attach when this notification goes out by email. */
    attachmentDocumentIds?: readonly string[]
  },
): Promise<boolean> {
  const tid = await tenantId(tx)
  const { rowCount } = await tx.query(
    `INSERT INTO notifications
       (tenant_id, user_id, event_type, title, body, entity_type, entity_id, channels, dedupe_key, attachment_document_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::uuid[])
     ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [tid, args.userId, args.eventType, args.title, args.body ?? null,
     args.entityType ?? null, args.entityId ?? null, args.channels ?? ['in_app'],
     args.dedupeKey ?? null, args.attachmentDocumentIds ?? []],
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
    imapPort?: number; imapSecure?: boolean; smtpPort?: number; smtpSecure?: boolean
    label?: string | null; displayName?: string | null
    allowAnyAddress?: boolean
  },
): Promise<string> {
  const tid = await tenantId(tx)
  const email = args.email.trim().toLowerCase()
  await assertMayClaim(tx, args.userId, email, args.allowAnyAddress === true, true)
  // Where the server will connect is validated when the mailbox is SAVED and again at every connection.
  await assertMailEndpoint('imap', args.imapHost, args.imapPort ?? 993)
  await assertMailEndpoint('smtp', args.smtpHost, args.smtpPort ?? 587)
  if (await findAccountByEmail(tx, email)) {
    throw new MailError('EMAIL_TAKEN', `${email} already belongs to a mailbox in this company`)
  }
  const id = crypto.randomUUID()
  await tx.query(
    `INSERT INTO mail_accounts
       (tenant_id, id, user_id, email, display_name, label, username, imap_host, imap_port, imap_secure,
        smtp_host, smtp_port, smtp_secure, secret_ciphertext,
        is_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
             NOT EXISTS (SELECT 1 FROM mail_accounts WHERE user_id = $3 AND status NOT IN ('disconnected','removed')))`,
    [tid, id, args.userId, email, args.displayName ?? null, args.label ?? null, args.username,
     args.imapHost, args.imapPort ?? 993, args.imapSecure ?? true,
     args.smtpHost, args.smtpPort ?? 587, args.smtpSecure ?? false,
     encryptSecret(args.password, tid, args.master)],
  )
  // Standard folders exist before the first sync, so Sent and Drafts work at once;
  // the sync adopts them under the server's own names.
  await provisionFolders(tx, tid, id)
  return id
}

/**
 * Disconnecting destroys the credential immediately. One click, and it
 * completes. The row stays (folders and mail hang off it, and retention owns
 * their lifetime); it just stops syncing, sending and receiving.
 */
export async function disconnectMailbox(tx: PoolClient, accountId: string): Promise<void> {
  const tid = await tenantId(tx)
  await tx.query(
    `UPDATE mail_accounts SET status = 'disconnected', secret_ciphertext = NULL, is_default = false
      WHERE tenant_id = $1 AND id = $2`, [tid, accountId])
}
