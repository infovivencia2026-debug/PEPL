/**
 * The outbox worker.
 *
 * `mail_commands` rows with `status = 'queued'` are messages the API accepted
 * for external delivery. This drains them.
 *
 * Three rules keep a queue like this from doing damage:
 *
 *   1. A row is claimed with `FOR UPDATE SKIP LOCKED` and flipped to `running`
 *      in its own transaction, so two workers cannot send the same message.
 *   2. A 4xx from the server is temporary and retried with backoff; a 5xx is
 *      permanent and abandoned immediately. Retrying a permanent rejection
 *      forever is how an outbox turns into a spam incident.
 *   3. Attempts are capped. A message that cannot be delivered becomes a
 *      visible failure, not an invisible retry loop.
 */
import type { PoolClient } from 'pg'
import { withTenant } from '../db/tenant-tx.ts'
import { decryptSecret } from '../comms/index.ts'
import { buildMessage, type Attachment } from './mime.ts'
import { sendViaSmtp, SmtpError, type SmtpConfig } from './smtp.ts'
import { MailError } from './accounts.ts'

export const MAX_ATTEMPTS = 5

/** Exponential, capped: 1, 2, 4, 8, 16 minutes. */
export function backoffMinutes(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1), 16)
}

interface QueuedRow {
  id: string
  account_id: string
  user_id: string
  payload: {
    sentEnvelopeId?: string
    messageId?: string
    external?: string[]
  }
  attempts: number
}

interface AccountRow {
  email: string
  display_name: string | null
  username: string | null
  smtp_host: string | null
  smtp_port: number | null
  smtp_secure: boolean | null
  secret_ciphertext: Buffer | null
}

export interface OutboxResult {
  claimed: number
  sent: number
  retrying: number
  abandoned: number
  errors: string[]
}

/** Injectable so tests drive a local server instead of the internet. */
export type Sender = (config: SmtpConfig, args: {
  from: string
  to: readonly string[]
  raw: string
}) => Promise<void>

/**
 * Claims up to `limit` due commands for one tenant and attempts each.
 *
 * Every message gets its own transaction: one bad row must not roll back the
 * sends that already succeeded.
 */
export async function runOutbox(
  tenantId: string,
  opts: {
    master: string
    send?: Sender
    limit?: number
    now?: Date
  },
): Promise<OutboxResult> {
  const send = opts.send ?? sendViaSmtp
  const limit = opts.limit ?? 20
  const result: OutboxResult = { claimed: 0, sent: 0, retrying: 0, abandoned: 0, errors: [] }

  const due = await withTenant(tenantId, async (tx) => claimDue(tx, limit, opts.now ?? new Date()))
  result.claimed = due.length

  for (const row of due) {
    try {
      await deliver(tenantId, row, opts.master, send)
      await withTenant(tenantId, (tx) => markDone(tx, row.id))
      result.sent++
    } catch (err) {
      const permanent = err instanceof SmtpError
        ? err.replyCode >= 500 || err.code === 'INSECURE_AUTH' || err.code === 'NO_RECIPIENTS'
        : err instanceof MailError
      const attempts = row.attempts + 1
      const abandon = permanent || attempts >= MAX_ATTEMPTS
      const message = (err as Error).message

      await withTenant(tenantId, (tx) => markFailed(tx, row.id, message, abandon))
      result.errors.push(message)
      if (abandon) result.abandoned++
      else result.retrying++
    }
  }

  return result
}

/**
 * `SKIP LOCKED` is what makes a second worker safe: it takes the next row
 * rather than blocking on this one, and no row is ever claimed twice.
 */
async function claimDue(tx: PoolClient, limit: number, now: Date): Promise<QueuedRow[]> {
  const { rows } = await tx.query<QueuedRow>(
    `WITH due AS (
       SELECT id FROM mail_commands
        WHERE command = 'send'
          AND status = 'queued'
          AND created_at + (interval '1 minute' * LEAST(power(2, GREATEST(attempts - 1, 0)), 16)
                            * GREATEST(attempts, 0)) <= $2
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE mail_commands m
        SET status = 'running', attempts = m.attempts + 1
       FROM due
      WHERE m.id = due.id
      RETURNING m.id, m.account_id, m.user_id, m.payload, m.attempts - 1 AS attempts`,
    [limit, now.toISOString()],
  )
  return rows
}

async function markDone(tx: PoolClient, id: string): Promise<void> {
  await tx.query(
    `UPDATE mail_commands SET status = 'done', completed_at = now(), last_error = NULL
      WHERE id = $1`, [id],
  )
}

async function markFailed(
  tx: PoolClient,
  id: string,
  error: string,
  abandon: boolean,
): Promise<void> {
  await tx.query(
    `UPDATE mail_commands
        SET status = $2,
            last_error = $3,
            completed_at = CASE WHEN $2 = 'abandoned' THEN now() ELSE NULL END
      WHERE id = $1`,
    [id, abandon ? 'abandoned' : 'queued', error.slice(0, 500)],
  )
}

/** Loads everything the message needs and hands it to SMTP. */
async function deliver(
  tenantId: string,
  row: QueuedRow,
  master: string,
  send: Sender,
): Promise<void> {
  const prepared = await withTenant(tenantId, async (tx) => {
    const { rows: accounts } = await tx.query<AccountRow>(
      `SELECT email, display_name, username, smtp_host, smtp_port, smtp_secure, secret_ciphertext
         FROM mail_accounts WHERE id = $1`, [row.account_id],
    )
    const account = accounts[0]
    if (!account) throw new MailError('MAILBOX_NOT_FOUND', 'the sending mailbox is gone')
    if (!account.smtp_host) {
      throw new MailError(
        'MAILBOX_NOT_FOUND',
        `${account.email} has no outgoing server configured, so external mail cannot be sent`,
      )
    }

    const envelopeId = row.payload.sentEnvelopeId
    if (!envelopeId) throw new MailError('NOT_FOUND', 'the queued command names no message')

    const { rows: envelopes } = await tx.query<{
      subject: string | null
      in_reply_to: string | null
      message_id: string | null
      attachment_document_ids: string[]
    }>(
      `SELECT subject, in_reply_to, message_id, attachment_document_ids
         FROM mail_envelopes WHERE id = $1`, [envelopeId],
    )
    const envelope = envelopes[0]
    if (!envelope) throw new MailError('NOT_FOUND', 'the message it refers to no longer exists')

    const { rows: bodies } = await tx.query<{ body_html: string | null; body_text: string | null }>(
      `SELECT body_html, body_text FROM mail_bodies WHERE envelope_id = $1`, [envelopeId],
    )

    const attachments: Attachment[] = []
    for (const documentId of envelope.attachment_document_ids ?? []) {
      const { rows: files } = await tx.query<{
        file_name: string; content_type: string; bytes: Buffer
      }>(
        `SELECT d.file_name, d.content_type, b.bytes
           FROM documents d JOIN document_blobs b ON b.document_id = d.id
          WHERE d.id = $1 AND d.deleted_at IS NULL`, [documentId],
      )
      const file = files[0]
      if (file) {
        attachments.push({
          fileName: file.file_name, contentType: file.content_type, bytes: file.bytes,
        })
      }
    }

    return { account, envelope, body: bodies[0], attachments }
  })

  const { account } = prepared
  const password = account.secret_ciphertext
    ? decryptSecret(account.secret_ciphertext, tenantId, master)
    : undefined

  const raw = buildMessage({
    from: { name: account.display_name, address: account.email },
    to: row.payload.external ?? [],
    subject: prepared.envelope.subject ?? '(no subject)',
    bodyHtml: prepared.body?.body_html ?? '',
    bodyText: prepared.body?.body_text ?? undefined,
    messageId: prepared.envelope.message_id ?? row.payload.messageId ?? row.id,
    inReplyTo: prepared.envelope.in_reply_to,
    attachments: prepared.attachments,
  })

  await send(
    {
      host: account.smtp_host!,
      port: account.smtp_port ?? 587,
      secure: account.smtp_secure ?? false,
      username: account.username ?? undefined,
      password,
    },
    { from: account.email, to: row.payload.external ?? [], raw },
  )
}
