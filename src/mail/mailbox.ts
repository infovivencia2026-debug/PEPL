/**
 * Mailbox housekeeping: custom folders, the signature, bulk actions and
 * recipient suggestions. Everything a mail client has around the message list
 * that is not the message itself.
 */
import type { PoolClient } from 'pg'
import { MailError, folderByRole, tenantId, type MailAccount } from './accounts.ts'
import { sanitizeHtml } from './sanitize.ts'
import { deleteMessage, moveToFolder, setFlag, type Flag } from './messages.ts'

/** A folder someone creates. Standard folders are fixed and never renamed here. */
export async function createFolder(
  tx: PoolClient, args: { accountId: string; name: string },
): Promise<{ id: string }> {
  const name = args.name.trim().replace(/[/\\]/g, ' ').slice(0, 80)
  if (!name) throw new MailError('VALIDATION_FAILED', 'a folder needs a name')
  const tid = await tenantId(tx)
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO mail_folders (tenant_id, account_id, path, name, role)
     VALUES ($1,$2,$3,$3,'custom')
     ON CONFLICT (tenant_id, account_id, path) DO NOTHING
     RETURNING id`,
    [tid, args.accountId, name])
  if (!rows[0]) throw new MailError('FOLDER_EXISTS', `a folder called "${name}" already exists`)
  return rows[0]
}

export async function renameFolder(
  tx: PoolClient, args: { accountId: string; folderId: string; name: string },
): Promise<void> {
  const name = args.name.trim().replace(/[/\\]/g, ' ').slice(0, 80)
  if (!name) throw new MailError('VALIDATION_FAILED', 'a folder needs a name')
  const { rowCount } = await tx.query(
    `UPDATE mail_folders SET name = $3, path = $3
      WHERE id = $1 AND account_id = $2 AND role = 'custom'`,
    [args.folderId, args.accountId, name])
  if (!rowCount) throw new MailError('FOLDER_NOT_FOUND', 'no such custom folder (standard folders cannot be renamed)')
}

/** Deleting a folder moves its messages to Trash first; nothing is lost. */
export async function deleteFolder(
  tx: PoolClient, args: { accountId: string; folderId: string },
): Promise<{ moved: number }> {
  const trash = await folderByRole(tx, args.accountId, 'trash')
  const { rows } = await tx.query<{ role: string }>(
    `SELECT role FROM mail_folders WHERE id = $1 AND account_id = $2`, [args.folderId, args.accountId])
  if (!rows[0]) throw new MailError('FOLDER_NOT_FOUND', 'no such folder')
  if (rows[0].role !== 'custom') throw new MailError('FOLDER_NOT_FOUND', 'standard folders cannot be deleted')
  const moved = await tx.query(
    `UPDATE mail_envelopes SET folder_id = $2 WHERE folder_id = $1`, [args.folderId, trash])
  await tx.query(`DELETE FROM mail_folders WHERE id = $1`, [args.folderId])
  return { moved: moved.rowCount ?? 0 }
}

export interface MailboxSettings {
  signature_html: string | null
  reply_to: string | null
  display_name: string | null
}

export async function getSettings(tx: PoolClient, accountId: string): Promise<MailboxSettings> {
  const { rows } = await tx.query<MailboxSettings>(
    `SELECT signature_html, reply_to, display_name FROM mail_accounts WHERE id = $1`, [accountId])
  return rows[0] ?? { signature_html: null, reply_to: null, display_name: null }
}

export async function updateSettings(
  tx: PoolClient, accountId: string, patch: Partial<MailboxSettings>,
): Promise<MailboxSettings> {
  if (patch.reply_to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.reply_to)) {
    throw new MailError('VALIDATION_FAILED', 'reply_to must be an email address')
  }
  await tx.query(
    `UPDATE mail_accounts
        SET signature_html = CASE WHEN $2::boolean THEN $3 ELSE signature_html END,
            reply_to       = CASE WHEN $4::boolean THEN $5 ELSE reply_to END,
            display_name   = CASE WHEN $6::boolean THEN $7 ELSE display_name END
      WHERE id = $1`,
    [accountId,
     'signature_html' in patch, patch.signature_html ? sanitizeHtml(patch.signature_html).slice(0, 10_000) : null,
     'reply_to' in patch, patch.reply_to?.trim().toLowerCase() || null,
     'display_name' in patch, patch.display_name?.trim().slice(0, 120) || null])
  return getSettings(tx, accountId)
}

export type BulkAction =
  | { action: 'flag'; flag: Flag }
  | { action: 'move'; folderId: string }
  | { action: 'delete' }

/** The same three operations, over many messages. Fails whole if any id is not the caller's. */
export async function bulk(
  tx: PoolClient, args: { account: MailAccount; envelopeIds: readonly string[]; op: BulkAction },
): Promise<{ affected: number }> {
  if (args.envelopeIds.length === 0) return { affected: 0 }
  if (args.envelopeIds.length > 500) throw new MailError('VALIDATION_FAILED', 'at most 500 messages at a time')
  const { rows } = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM mail_envelopes WHERE account_id = $1 AND id = ANY($2::uuid[])`,
    [args.account.id, args.envelopeIds])
  if (Number(rows[0]!.n) !== new Set(args.envelopeIds).size) {
    throw new MailError('NOT_FOUND', 'a message is not in your mailbox')
  }
  for (const id of new Set(args.envelopeIds)) {
    if (args.op.action === 'flag') await setFlag(tx, id, args.op.flag)
    else if (args.op.action === 'move') await moveToFolder(tx, { envelopeId: id, folderId: args.op.folderId })
    else await deleteMessage(tx, { envelopeId: id, accountId: args.account.id })
  }
  return { affected: new Set(args.envelopeIds).size }
}

export interface Suggestion { email: string; name: string | null; source: 'colleague' | 'recent' }

/**
 * Who to offer while typing a recipient: colleagues from the directory first,
 * then people this mailbox has written to. Nothing from anyone else's mail.
 */
export async function suggestRecipients(
  tx: PoolClient, args: { accountId: string; q: string; limit?: number },
): Promise<Suggestion[]> {
  const q = args.q.trim().toLowerCase()
  if (q.length < 2) return []
  const limit = Math.min(args.limit ?? 10, 25)
  const { rows } = await tx.query<Suggestion>(
    `WITH colleagues AS (
       SELECT lower(u.email) AS email, u.full_name AS name, 'colleague'::text AS source, 0 AS rank
         FROM app_users u
        WHERE u.status = 'active' AND (lower(u.email) LIKE $2 OR lower(u.full_name) LIKE $2)
     ), recent AS (
       -- addresses are stored as plain strings in both the to and cc arrays
       SELECT lower(a) AS email, NULL::text AS name, 'recent'::text AS source, 1 AS rank
         FROM mail_envelopes e,
              LATERAL jsonb_array_elements_text(e.to_addresses || e.cc_addresses) AS a
        WHERE e.account_id = $1 AND NOT e.is_draft
          AND e.from_address = (SELECT email FROM mail_accounts WHERE id = $1)
          AND lower(a) LIKE $2
     )
     SELECT DISTINCT ON (email) email, name, source
       FROM (SELECT * FROM colleagues UNION ALL SELECT * FROM recent) s
      WHERE email IS NOT NULL
      ORDER BY email, rank
      LIMIT $3`,
    [args.accountId, `%${q.replace(/[%_]/g, '')}%`, limit])
  return rows
}
