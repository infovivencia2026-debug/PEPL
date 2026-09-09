/**
 * Reading, composing and sending mail.
 *
 * Internal mail is delivered synchronously in the caller's transaction: the
 * sender's Sent copy and every recipient's Inbox copy commit together, so there
 * is no state where a message was sent to some people and not others.
 *
 * External mail is queued into mail_commands instead, because an SMTP hop is
 * not something a request should wait on and a failure must be retryable rather
 * than lost. The worker that drains that queue is the one piece not built yet.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  MailError, folderByRole, findAccountByEmail, tenantId, type MailAccount,
} from './accounts.ts'

export interface Envelope {
  id: string
  folder_id: string
  source: string
  thread_key: string | null
  from_name: string | null
  from_address: string | null
  to_addresses: string[]
  cc_addresses: string[]
  subject: string | null
  preview: string | null
  sent_at: string | null
  received_at: string
  is_seen: boolean
  is_flagged: boolean
  is_answered: boolean
  is_draft: boolean
  has_attachment: boolean
  attachment_document_ids: string[]
}

const ENVELOPE_COLUMNS = `id, folder_id, source, thread_key, from_name, from_address,
  to_addresses, cc_addresses, subject, preview, sent_at, received_at,
  is_seen, is_flagged, is_answered, is_draft, has_attachment, attachment_document_ids`

/** A page of a folder, newest first. Bodies are not read here. */
export async function listEnvelopes(
  tx: PoolClient,
  args: { folderId: string; limit?: number; before?: string; search?: string },
): Promise<{ envelopes: Envelope[]; hasMore: boolean }> {
  const limit = Math.min(args.limit ?? 50, 200)
  const { rows } = await tx.query<Envelope>(
    `SELECT ${ENVELOPE_COLUMNS}
       FROM mail_envelopes
      WHERE folder_id = $1
        AND deleted_at IS NULL
        AND ($2::timestamptz IS NULL OR received_at < $2)
        AND ($3::text IS NULL OR subject ILIKE '%' || $3 || '%'
                              OR from_address ILIKE '%' || $3 || '%'
                              OR preview ILIKE '%' || $3 || '%')
      ORDER BY received_at DESC, id DESC
      LIMIT $4`,
    [args.folderId, args.before ?? null, args.search ?? null, limit + 1],
  )
  return { envelopes: rows.slice(0, limit), hasMore: rows.length > limit }
}

export async function getEnvelope(tx: PoolClient, id: string): Promise<Envelope | null> {
  const { rows } = await tx.query<Envelope>(
    `SELECT ${ENVELOPE_COLUMNS} FROM mail_envelopes WHERE id = $1 AND deleted_at IS NULL`, [id],
  )
  return rows[0] ?? null
}

/**
 * A message with its body.
 *
 * Opening is what marks a message read — a list view that marks on render marks
 * everything the moment somebody scrolls.
 */
export async function openMessage(
  tx: PoolClient,
  id: string,
): Promise<{ envelope: Envelope; body_html: string | null; body_text: string | null } | null> {
  const envelope = await getEnvelope(tx, id)
  if (!envelope) return null
  const { rows } = await tx.query<{ body_html: string | null; body_text: string | null }>(
    `SELECT body_html, body_text FROM mail_bodies WHERE envelope_id = $1`, [id],
  )
  await tx.query(`UPDATE mail_envelopes SET is_seen = true WHERE id = $1`, [id])
  return {
    envelope: { ...envelope, is_seen: true },
    body_html: rows[0]?.body_html ?? null,
    body_text: rows[0]?.body_text ?? null,
  }
}

/** The conversation an envelope belongs to, oldest first. */
export async function listThread(
  tx: PoolClient,
  args: { accountId: string; threadKey: string },
): Promise<Envelope[]> {
  const { rows } = await tx.query<Envelope>(
    `SELECT ${ENVELOPE_COLUMNS} FROM mail_envelopes
      WHERE account_id = $1 AND thread_key = $2 AND deleted_at IS NULL
      ORDER BY received_at`,
    [args.accountId, args.threadKey],
  )
  return rows
}

function preview(text: string): string {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

interface Draft {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  bodyHtml: string
  attachmentDocumentIds?: readonly string[]
  inReplyTo?: string | null
  threadKey?: string | null
}

async function insertEnvelope(
  tx: PoolClient,
  args: {
    tid: string; accountId: string; folderId: string; messageId: string
    draft: Draft; from: MailAccount; isDraft: boolean; isSeen: boolean
  },
): Promise<string> {
  const id = randomUUID()
  await tx.query(
    `INSERT INTO mail_envelopes
       (tenant_id, id, account_id, folder_id, source, message_id, thread_key, in_reply_to,
        from_name, from_address, to_addresses, cc_addresses, bcc_addresses,
        subject, preview, sent_at, size_bytes, is_seen, is_draft,
        has_attachment, attachment_document_ids)
     VALUES ($1,$2,$3,$4,'internal',$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,
             $13,$14,$15,$16,$17,$18,$19,$20::uuid[])`,
    [
      args.tid, id, args.accountId, args.folderId, args.messageId,
      args.draft.threadKey ?? args.messageId, args.draft.inReplyTo ?? null,
      args.from.display_name, args.from.email,
      JSON.stringify(args.draft.to), JSON.stringify(args.draft.cc ?? []),
      JSON.stringify(args.draft.bcc ?? []),
      args.draft.subject, preview(args.draft.bodyHtml),
      args.isDraft ? null : new Date().toISOString(),
      Buffer.byteLength(args.draft.bodyHtml), args.isSeen, args.isDraft,
      (args.draft.attachmentDocumentIds?.length ?? 0) > 0,
      args.draft.attachmentDocumentIds ?? [],
    ],
  )
  await tx.query(
    `INSERT INTO mail_bodies (tenant_id, envelope_id, body_html, body_text)
     VALUES ($1,$2,$3,$4)`,
    [args.tid, id, args.draft.bodyHtml, preview(args.draft.bodyHtml)],
  )
  return id
}

export interface SendResult {
  sentEnvelopeId: string
  deliveredTo: string[]
  queuedFor: string[]
}

/**
 * Sends a message.
 *
 * Recipients split in two: colleagues with a mailbox here are delivered
 * immediately, and anyone else becomes a queued command for the SMTP worker.
 * The caller is told which is which rather than being led to believe an
 * external address has already been reached.
 */
export async function sendMail(
  tx: PoolClient,
  args: {
    account: MailAccount
    userId: string
    draft: Draft
    idempotencyKey: string
    allowExternal: boolean
  },
): Promise<SendResult> {
  const tid = await tenantId(tx)
  const recipients = [...new Set([...args.draft.to, ...(args.draft.cc ?? []), ...(args.draft.bcc ?? [])]
    .map((a) => a.trim().toLowerCase()).filter(Boolean))]
  if (recipients.length === 0) throw new MailError('NO_RECIPIENTS', 'a message needs a recipient')

  // A retry of the same send must not deliver twice.
  const prior = await tx.query<{ payload: { sentEnvelopeId?: string } }>(
    `SELECT payload FROM mail_commands
      WHERE account_id = $1 AND idempotency_key = $2 AND command = 'send'`,
    [args.account.id, args.idempotencyKey],
  )
  const priorId = prior.rows[0]?.payload?.sentEnvelopeId
  if (priorId) {
    return { sentEnvelopeId: priorId, deliveredTo: [], queuedFor: [] }
  }

  const messageId = `${randomUUID()}@pepl.internal`
  const sentFolder = await folderByRole(tx, args.account.id, 'sent')
  const sentEnvelopeId = await insertEnvelope(tx, {
    tid, accountId: args.account.id, folderId: sentFolder, messageId,
    draft: args.draft, from: args.account, isDraft: false, isSeen: true,
  })

  const deliveredTo: string[] = []
  const external: string[] = []
  for (const address of recipients) {
    const account = await findAccountByEmail(tx, address)
    if (!account) {
      external.push(address)
      continue
    }
    const inbox = await folderByRole(tx, account.id, 'inbox')
    await insertEnvelope(tx, {
      tid, accountId: account.id, folderId: inbox, messageId,
      // the recipient's copy keeps the sender's thread key, so replies group
      draft: { ...args.draft, threadKey: args.draft.threadKey ?? messageId },
      from: args.account, isDraft: false, isSeen: false,
    })
    deliveredTo.push(address)
  }

  if (external.length && !args.allowExternal) {
    throw new MailError('NO_RECIPIENTS',
      'this company allows mail to colleagues only: ' + external.join(', '))
  }

  await tx.query(
    `INSERT INTO mail_commands (tenant_id, account_id, user_id, command, payload, idempotency_key, status, completed_at)
     VALUES ($1,$2,$3,'send',$4::jsonb,$5,$6,$7)`,
    [tid, args.account.id, args.userId,
     JSON.stringify({ sentEnvelopeId, messageId, external, deliveredTo }),
     args.idempotencyKey,
     external.length ? 'queued' : 'done',
     external.length ? null : new Date().toISOString()],
  )

  if (args.draft.inReplyTo) {
    await tx.query(
      `UPDATE mail_envelopes SET is_answered = true
        WHERE account_id = $1 AND message_id = $2`,
      [args.account.id, args.draft.inReplyTo],
    )
  }

  return { sentEnvelopeId, deliveredTo, queuedFor: external }
}

/** Saves or replaces a draft. Drafts are envelopes in the Drafts folder. */
export async function saveDraft(
  tx: PoolClient,
  args: { account: MailAccount; draft: Draft; draftId?: string },
): Promise<string> {
  const tid = await tenantId(tx)
  if (args.draftId) {
    const existing = await getEnvelope(tx, args.draftId)
    if (!existing) throw new MailError('NOT_FOUND', 'no such draft')
    if (!existing.is_draft) throw new MailError('NOT_A_DRAFT', 'that message is not a draft')
    await tx.query(`DELETE FROM mail_envelopes WHERE id = $1`, [args.draftId])
  }
  const folderId = await folderByRole(tx, args.account.id, 'drafts')
  return insertEnvelope(tx, {
    tid, accountId: args.account.id, folderId, messageId: `${randomUUID()}@pepl.internal`,
    draft: args.draft, from: args.account, isDraft: true, isSeen: true,
  })
}

export type Flag = 'seen' | 'unseen' | 'flagged' | 'unflagged'

export async function setFlag(tx: PoolClient, id: string, flag: Flag): Promise<void> {
  const column = flag === 'seen' || flag === 'unseen' ? 'is_seen' : 'is_flagged'
  const value = flag === 'seen' || flag === 'flagged'
  const { rowCount } = await tx.query(
    `UPDATE mail_envelopes SET ${column} = $2 WHERE id = $1 AND deleted_at IS NULL`, [id, value],
  )
  if (!rowCount) throw new MailError('NOT_FOUND', 'no such message')
}

export async function moveToFolder(
  tx: PoolClient,
  args: { envelopeId: string; folderId: string },
): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE mail_envelopes SET folder_id = $2 WHERE id = $1 AND deleted_at IS NULL`,
    [args.envelopeId, args.folderId],
  )
  if (!rowCount) throw new MailError('NOT_FOUND', 'no such message')
}

/**
 * Deleting moves to Trash; deleting from Trash is final.
 *
 * This is what every mail client does, and the reason it does it is that the
 * undo people actually reach for is "look in Trash".
 */
export async function deleteMessage(
  tx: PoolClient,
  args: { envelopeId: string; accountId: string },
): Promise<{ purged: boolean }> {
  const envelope = await getEnvelope(tx, args.envelopeId)
  if (!envelope) throw new MailError('NOT_FOUND', 'no such message')
  const trash = await folderByRole(tx, args.accountId, 'trash')
  if (envelope.folder_id === trash) {
    await tx.query(`DELETE FROM mail_envelopes WHERE id = $1`, [args.envelopeId])
    return { purged: true }
  }
  await moveToFolder(tx, { envelopeId: args.envelopeId, folderId: trash })
  return { purged: false }
}
