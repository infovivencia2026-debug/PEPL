/**
 * Attachments on mail: stored once as documents owned by the mailbox, listed
 * per message, and served only to the mailbox owner of a message that carries
 * them. Inline images are the same thing with a Content-ID, and the stored
 * HTML is rewritten to point at them so a signature logo shows.
 */
import type { PoolClient } from 'pg'
import { MAX_BYTES, putDocument, readDocument, type DocumentMeta } from '../documents/index.ts'
import { sanitizeHtml, resolveInlineImages } from './sanitize.ts'
import { htmlToText } from './mime.ts'
import type { ParsedMessage } from './parse.ts'
import { MailError } from './accounts.ts'

/** Anything larger is left on the server; the UI says so. */
export const MAX_ATTACHMENT_BYTES = MAX_BYTES

export const attachmentUrl = (envelopeId: string, documentId: string): string =>
  `/api/v1/mail/messages/${envelopeId}/attachments/${documentId}/content`

/** Stores a parsed inbound message: body (sanitised, cid: resolved) and every part. */
export async function storeParsedBody(
  tx: PoolClient,
  args: { tenantId: string; envelopeId: string; accountId: string; parsed: ParsedMessage },
): Promise<void> {
  const byCid = new Map<string, string>()
  const ids: string[] = []
  for (const part of args.parsed.attachments) {
    if (part.bytes.length > MAX_ATTACHMENT_BYTES) continue
    const doc = await putDocument(tx, {
      ownerType: 'mail', ownerId: args.accountId, fileName: part.fileName,
      contentType: part.contentType, bytes: part.bytes, category: part.inline ? 'inline' : 'attachment',
      isConfidential: true,
    })
    ids.push(doc.id)
    await tx.query(
      `INSERT INTO mail_attachments (tenant_id, envelope_id, document_id, content_id, is_inline)
       VALUES ($1,$2,$3,$4,$5)`,
      [args.tenantId, args.envelopeId, doc.id, part.contentId, part.inline],
    )
    if (part.contentId) byCid.set(part.contentId, attachmentUrl(args.envelopeId, doc.id))
  }
  const html = args.parsed.html ? resolveInlineImages(sanitizeHtml(args.parsed.html), byCid) : null
  const text = args.parsed.text ?? (html ? htmlToText(html) : null)
  await tx.query(
    `INSERT INTO mail_bodies (tenant_id, envelope_id, body_html, body_text)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [args.tenantId, args.envelopeId, html, text],
  )
  if (ids.length) {
    await tx.query(
      `UPDATE mail_envelopes SET attachment_document_ids = $2::uuid[],
              has_attachment = has_attachment OR $3
        WHERE id = $1`,
      [args.envelopeId, ids, args.parsed.attachments.some((a) => !a.inline)],
    )
  }
}

export interface AttachmentMeta {
  document_id: string
  file_name: string
  content_type: string
  size_bytes: number
  is_inline: boolean
  content_id: string | null
  url: string
}

/** What a message carries, inline parts included (the UI hides those). */
export async function listAttachments(tx: PoolClient, envelopeId: string): Promise<AttachmentMeta[]> {
  const { rows } = await tx.query<Omit<AttachmentMeta, 'url'>>(
    `SELECT d.id AS document_id, d.file_name, d.content_type, d.size_bytes,
            coalesce(ma.is_inline, false) AS is_inline, ma.content_id
       FROM mail_envelopes e
       JOIN documents d ON d.tenant_id = e.tenant_id AND d.id = ANY(e.attachment_document_ids)
       LEFT JOIN mail_attachments ma ON (ma.tenant_id, ma.envelope_id, ma.document_id) = (d.tenant_id, e.id, d.id)
      WHERE e.id = $1 AND d.deleted_at IS NULL
      ORDER BY is_inline, d.file_name`, [envelopeId])
  return rows.map((r) => ({ ...r, url: attachmentUrl(envelopeId, r.document_id) }))
}

/**
 * The bytes of one attachment, but only through a message that carries it.
 * The envelope check is the whole access model: a recipient's copy lists the
 * sender's document ids, so the recipient may read them; nobody else may.
 */
export async function readAttachment(
  tx: PoolClient, args: { envelopeId: string; documentId: string },
): Promise<{ meta: DocumentMeta; bytes: Buffer } | null> {
  const { rowCount } = await tx.query(
    `SELECT 1 FROM mail_envelopes WHERE id = $1 AND $2 = ANY(attachment_document_ids)`,
    [args.envelopeId, args.documentId])
  if (!rowCount) return null
  return readDocument(tx, args.documentId)
}

/** A file uploaded for a compose, before it is attached to anything. */
export async function uploadAttachment(
  tx: PoolClient,
  args: { accountId: string; userId: string; fileName: string; contentType: string; bytes: Buffer },
): Promise<DocumentMeta> {
  if (args.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new MailError('ATTACHMENT_TOO_LARGE', `an attachment may be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`)
  }
  return putDocument(tx, {
    ownerType: 'mail', ownerId: args.accountId, fileName: args.fileName,
    contentType: args.contentType, bytes: args.bytes, category: 'attachment',
    isConfidential: true, uploadedByUserId: args.userId,
  })
}

/**
 * Every attachment id a compose names must be one the sender may use: an
 * upload of their own, or a part of a message in their own mailbox (forward).
 */
export async function assertAttachmentsUsable(
  tx: PoolClient, args: { accountId: string; documentIds: readonly string[] },
): Promise<void> {
  if (!args.documentIds.length) return
  const { rows } = await tx.query<{ id: string }>(
    `SELECT d.id FROM documents d
      WHERE d.id = ANY($2::uuid[]) AND d.deleted_at IS NULL AND d.owner_type = 'mail'
        AND (d.owner_id = $1
             OR EXISTS (SELECT 1 FROM mail_envelopes e
                         WHERE e.account_id = $1 AND d.id = ANY(e.attachment_document_ids)))`,
    [args.accountId, args.documentIds])
  const ok = new Set(rows.map((r) => r.id))
  const missing = args.documentIds.filter((id) => !ok.has(id))
  if (missing.length) throw new MailError('ATTACHMENT_NOT_YOURS', 'an attachment is not in your mailbox: ' + missing.join(', '))
}
