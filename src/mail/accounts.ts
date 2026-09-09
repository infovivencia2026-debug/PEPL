/**
 * Mailboxes and their folders.
 *
 * A mailbox belongs to a person, not to the company: the tenant owns the
 * configuration, the individual owns the messages. Every account gets the five
 * standard folders on creation so the UI never has to cope with a mailbox that
 * has no Inbox.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'

export class MailError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'MailError'
  }
}

export async function tenantId(tx: PoolClient): Promise<string> {
  const { rows } = await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')
  const t = rows[0]?.t
  if (!t) throw new MailError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive'

const STANDARD: { role: FolderRole; name: string; path: string }[] = [
  { role: 'inbox', name: 'Inbox', path: 'INBOX' },
  { role: 'sent', name: 'Sent', path: 'Sent' },
  { role: 'drafts', name: 'Drafts', path: 'Drafts' },
  { role: 'trash', name: 'Trash', path: 'Trash' },
  { role: 'archive', name: 'Archive', path: 'Archive' },
]

export interface MailAccount {
  id: string
  user_id: string
  email: string
  display_name: string | null
  provider: string
  status: string
  last_error: string | null
}

/**
 * The account for a person, created on first use.
 *
 * `provider: 'internal'` is a mailbox with no server behind it — colleague mail
 * only. Connecting a real IMAP account later changes the provider and the
 * folders sync; the messages already delivered stay where they are.
 */
export async function ensureAccount(
  tx: PoolClient,
  args: { userId: string; email: string; displayName?: string | null },
): Promise<MailAccount> {
  const tid = await tenantId(tx)
  const existing = await findAccountByUser(tx, args.userId)
  if (existing) return existing

  const id = randomUUID()
  await tx.query(
    `INSERT INTO mail_accounts (tenant_id, id, user_id, email, display_name, provider, auth_type)
     VALUES ($1,$2,$3,$4,$5,'internal','password')`,
    [tid, id, args.userId, args.email.toLowerCase(), args.displayName ?? null],
  )
  for (const f of STANDARD) {
    await tx.query(
      `INSERT INTO mail_folders (tenant_id, account_id, path, name, role)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [tid, id, f.path, f.name, f.role],
    )
  }
  const created = await findAccountByUser(tx, args.userId)
  if (!created) throw new MailError('MAILBOX_NOT_FOUND', 'the mailbox vanished after creation')
  return created
}

export async function findAccountByUser(
  tx: PoolClient,
  userId: string,
): Promise<MailAccount | null> {
  const { rows } = await tx.query<MailAccount>(
    `SELECT id, user_id, email, display_name, provider, status, last_error
       FROM mail_accounts WHERE user_id = $1 AND status <> 'disconnected'
       ORDER BY created_at LIMIT 1`,
    [userId],
  )
  return rows[0] ?? null
}

export async function findAccountByEmail(
  tx: PoolClient,
  email: string,
): Promise<MailAccount | null> {
  const { rows } = await tx.query<MailAccount>(
    `SELECT id, user_id, email, display_name, provider, status, last_error
       FROM mail_accounts WHERE lower(email) = lower($1) AND status <> 'disconnected'
       ORDER BY created_at LIMIT 1`,
    [email],
  )
  return rows[0] ?? null
}

export interface MailFolder {
  id: string
  name: string
  path: string
  role: string | null
  total: number
  unread: number
}

/** Folders with their counts, which is the whole left-hand rail of a mail client. */
export async function listFolders(tx: PoolClient, accountId: string): Promise<MailFolder[]> {
  const { rows } = await tx.query<MailFolder>(
    `SELECT f.id, f.name, f.path, f.role,
            count(e.id) FILTER (WHERE e.deleted_at IS NULL)::int AS total,
            count(e.id) FILTER (WHERE e.deleted_at IS NULL AND NOT e.is_seen)::int AS unread
       FROM mail_folders f
       LEFT JOIN mail_envelopes e
         ON (e.tenant_id, e.folder_id) = (f.tenant_id, f.id)
      WHERE f.account_id = $1 AND f.subscribed
      GROUP BY f.id, f.name, f.path, f.role
      ORDER BY CASE f.role
                 WHEN 'inbox' THEN 0 WHEN 'drafts' THEN 1 WHEN 'sent' THEN 2
                 WHEN 'archive' THEN 3 WHEN 'junk' THEN 4 WHEN 'trash' THEN 5 ELSE 6 END,
               f.name`,
    [accountId],
  )
  return rows
}

export async function folderByRole(
  tx: PoolClient,
  accountId: string,
  role: FolderRole,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM mail_folders WHERE account_id = $1 AND role = $2`, [accountId, role],
  )
  const id = rows[0]?.id
  if (!id) throw new MailError('FOLDER_NOT_FOUND', `this mailbox has no ${role} folder`)
  return id
}
