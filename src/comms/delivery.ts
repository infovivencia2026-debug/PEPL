/**
 * Notification delivery by email.
 *
 * A notification row is what the bell shows; this turns the ones a company has
 * asked to be emailed into actual messages, using the mailbox that company
 * nominated as its sender.
 *
 * Nominating a sender is deliberate rather than automatic. Mail sent as
 * "no-reply@pepl" from a domain PEPL does not own fails SPF and lands in spam,
 * teaching everyone to ignore it. Mail from hr@theircompany.com, through their
 * own server, arrives — and that is the only arrangement worth building.
 */
import type { PoolClient } from 'pg'
import { tenantId } from './base.ts'
import { findAccountByEmail, sendMail, type MailAccount } from '../mail/index.ts'

/** After this many failures a notification stops being retried. */
export const MAX_EMAIL_ATTEMPTS = 3

export interface PendingNotification {
  id: string
  user_id: string
  event_type: string
  title: string
  body: string | null
  entity_type: string | null
  entity_id: string | null
  created_at: string
  recipient_email: string | null
  recipient_name: string | null
  attachment_document_ids?: string[]
}

/**
 * Notifications asking to be emailed, oldest first.
 *
 * A notification the person has already read in the app is skipped: an email
 * about something they have seen is noise, and noise is what makes people
 * filter the sender.
 */
export async function pendingEmails(
  tx: PoolClient,
  limit = 100,
): Promise<PendingNotification[]> {
  const { rows } = await tx.query<PendingNotification>(
    `SELECT n.id::text, n.user_id, n.event_type, n.title, n.body,
            n.entity_type, n.entity_id::text, n.created_at::text, n.attachment_document_ids,
            u.email AS recipient_email, u.full_name AS recipient_name
       FROM notifications n
       JOIN app_users u ON (u.tenant_id, u.id) = (n.tenant_id, n.user_id)
      WHERE n.emailed_at IS NULL
        AND 'email' = ANY(n.channels)
        AND n.read_at IS NULL
        AND n.email_attempts < $2
        AND u.status = 'active'
      ORDER BY n.created_at
      LIMIT $1`,
    [limit, MAX_EMAIL_ATTEMPTS],
  )
  return rows
}

export async function markEmailed(tx: PoolClient, id: string): Promise<void> {
  await tx.query(
    `UPDATE notifications SET emailed_at = now(), email_error = NULL WHERE id = $1`, [id],
  )
}

export async function markEmailFailed(
  tx: PoolClient,
  id: string,
  error: string,
): Promise<void> {
  await tx.query(
    `UPDATE notifications
        SET email_attempts = email_attempts + 1, email_error = $2
      WHERE id = $1`,
    [id, error.slice(0, 500)],
  )
}

/** The mailbox a company sends notifications from, or null if none is set. */
export async function senderAccount(
  tx: PoolClient,
  email: string | null,
): Promise<MailAccount | null> {
  if (!email) return null
  return findAccountByEmail(tx, email)
}

/**
 * The message body.
 *
 * Plain, short, and it says what happened and where to look. A notification
 * email that tries to be a newsletter gets treated like one.
 */
export function renderNotificationEmail(
  notification: PendingNotification,
  companyName: string,
): { subject: string; bodyHtml: string } {
  const detail = notification.body
    ? `<p style="margin:0 0 16px">${escapeHtml(notification.body)}</p>`
    : ''
  return {
    subject: notification.title,
    bodyHtml:
      `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1c2b24">` +
      `<p style="margin:0 0 8px;font-size:13px;color:#6b7a72">${escapeHtml(companyName)}</p>` +
      `<h2 style="margin:0 0 12px;font-size:18px;font-weight:600">${escapeHtml(notification.title)}</h2>` +
      detail +
      `<p style="margin:0;font-size:13px;color:#6b7a72">` +
      `You are receiving this because your company sends ${escapeHtml(readable(notification.event_type))} ` +
      `updates by email. Change this in your notification settings.</p>` +
      `</div>`,
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function readable(eventType: string): string {
  return eventType.replace(/[._]/g, ' ')
}

export interface DeliveryResult {
  sent: number
  failed: number
  skipped: string[]
}

/**
 * Emails every pending notification for one tenant.
 *
 * Each message is queued through the ordinary mail path, so it inherits the
 * outbox's retry, backoff and idempotency rather than growing a second delivery
 * mechanism that behaves differently under failure.
 */
export async function deliverEmails(
  tx: PoolClient,
  args: { senderEmail: string | null; companyName: string; limit?: number },
): Promise<DeliveryResult> {
  await tenantId(tx)
  const result: DeliveryResult = { sent: 0, failed: 0, skipped: [] }

  const sender = await senderAccount(tx, args.senderEmail)
  if (!sender) {
    result.skipped.push(
      args.senderEmail
        ? `no mailbox is connected for ${args.senderEmail}, so notifications cannot be emailed`
        : 'no sender mailbox is nominated, so notifications are not emailed',
    )
    return result
  }

  const footer = (await tx.query<{ f: string | null }>(`SELECT email_footer AS f FROM tenant_branding`)).rows[0]?.f ?? null
  for (const notification of await pendingEmails(tx, args.limit ?? 100)) {
    if (!notification.recipient_email) {
      await markEmailFailed(tx, notification.id, 'the recipient has no email address')
      result.failed++
      continue
    }
    try {
      const { subject, bodyHtml: rendered } = renderNotificationEmail(notification, args.companyName)
      const bodyHtml = footer ? rendered.replace(/<\/body>/i, `<p style="color:#6b7280;font-size:12px;margin-top:24px">${escapeHtml(footer)}</p></body>`) : rendered
      await sendMail(tx, {
        account: sender,
        userId: sender.user_id,
        // One email per notification, ever, however often the job runs.
        idempotencyKey: `notification:${notification.id}`,
        allowExternal: true,
        draft: {
          to: [notification.recipient_email], subject, bodyHtml,
          attachmentDocumentIds: notification.attachment_document_ids ?? [],
        },
      })
      await markEmailed(tx, notification.id)
      result.sent++
    } catch (err) {
      await markEmailFailed(tx, notification.id, (err as Error).message)
      result.failed++
    }
  }

  return result
}
