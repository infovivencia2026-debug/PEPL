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
  /** Shown in the account switcher: "Work", "Recruiting", "Support desk". */
  label: string | null
  is_default: boolean
  imap_host: string | null
  smtp_host: string | null
  created_at: string
}

const LIVE = `status NOT IN ('disconnected', 'removed')`

/** Every live mailbox a person has, the default first. */
export async function listAccounts(tx: PoolClient, userId: string): Promise<MailAccount[]> {
  const { rows } = await tx.query<MailAccount>(
    `SELECT id, user_id, email, display_name, provider, status, last_error, label, is_default,
            imap_host, smtp_host, created_at::text
       FROM mail_accounts WHERE user_id = $1 AND ${LIVE}
      ORDER BY is_default DESC, created_at`, [userId])
  return rows
}

/**
 * One of the person's mailboxes by id — or, with no id, the default one.
 * An id that is not theirs is "not found", never someone else's mailbox.
 */
export async function accountForUser(
  tx: PoolClient, userId: string, accountId?: string | null,
): Promise<MailAccount | null> {
  const { rows } = await tx.query<MailAccount>(
    `SELECT id, user_id, email, display_name, provider, status, last_error, label, is_default,
            imap_host, smtp_host, created_at::text
       FROM mail_accounts
      WHERE user_id = $1 AND ${LIVE} AND ($2::uuid IS NULL OR id = $2)
      ORDER BY is_default DESC, created_at LIMIT 1`, [userId, accountId ?? null])
  return rows[0] ?? null
}

/** Makes one mailbox the default; the previous default steps down in the same statement. */
export async function setDefaultAccount(tx: PoolClient, userId: string, accountId: string): Promise<void> {
  const owned = await accountForUser(tx, userId, accountId)
  if (!owned) throw new MailError('MAILBOX_NOT_FOUND', 'no such mailbox')
  // Two statements: the one-default-per-person index is checked row by row, so
  // a single UPDATE would briefly hold two defaults and fail.
  await tx.query(`UPDATE mail_accounts SET is_default = false WHERE user_id = $1 AND is_default`, [userId])
  await tx.query(`UPDATE mail_accounts SET is_default = true WHERE id = $1`, [accountId])
}

export async function updateAccount(
  tx: PoolClient, userId: string, accountId: string, patch: { label?: string | null; displayName?: string | null },
): Promise<MailAccount> {
  const owned = await accountForUser(tx, userId, accountId)
  if (!owned) throw new MailError('MAILBOX_NOT_FOUND', 'no such mailbox')
  await tx.query(
    `UPDATE mail_accounts
        SET label        = CASE WHEN $2::boolean THEN $3 ELSE label END,
            display_name = CASE WHEN $4::boolean THEN $5 ELSE display_name END
      WHERE id = $1`,
    [accountId, 'label' in patch, patch.label?.trim().slice(0, 60) || null,
     'displayName' in patch, patch.displayName?.trim().slice(0, 120) || null])
  return (await accountForUser(tx, userId, accountId))!
}

/**
 * Removing a mailbox destroys its credential at once and takes it out of every
 * list, but keeps its mail for retention. A person always keeps at least one.
 */
export async function removeAccount(tx: PoolClient, userId: string, accountId: string): Promise<void> {
  const all = await listAccounts(tx, userId)
  const target = all.find((a) => a.id === accountId)
  if (!target) throw new MailError('MAILBOX_NOT_FOUND', 'no such mailbox')
  if (all.length === 1) throw new MailError('LAST_MAILBOX', 'you cannot remove your only mailbox')
  await tx.query(
    `UPDATE mail_accounts SET status = 'removed', secret_ciphertext = NULL, is_default = false WHERE id = $1`,
    [accountId])
  if (target.is_default) {
    const next = all.find((a) => a.id !== accountId)!
    await tx.query(`UPDATE mail_accounts SET is_default = true WHERE id = $1`, [next.id])
  }
}

/**
 * A second (third…) address with no server behind it: an alias such as
 * hr@ or careers@ that colleagues can write to. One owner per address across
 * the company, or internal delivery would have to guess.
 */
export async function addInternalAddress(
  tx: PoolClient, args: { userId: string; email: string; label?: string | null; displayName?: string | null },
): Promise<MailAccount> {
  const email = args.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new MailError('VALIDATION_FAILED', 'email must be an address')
  const taken = await findAccountByEmail(tx, email)
  if (taken) throw new MailError('EMAIL_TAKEN', `${email} already belongs to a mailbox in this company`)
  const tid = await tenantId(tx)
  const id = randomUUID()
  await tx.query(
    `INSERT INTO mail_accounts (tenant_id, id, user_id, email, display_name, label, provider, auth_type)
     VALUES ($1,$2,$3,$4,$5,$6,'internal','password')`,
    [tid, id, args.userId, email, args.displayName ?? null, args.label ?? null])
  await provisionFolders(tx, tid, id)
  return (await accountForUser(tx, args.userId, id))!
}

export async function provisionFolders(tx: PoolClient, tid: string, accountId: string): Promise<void> {
  for (const f of STANDARD) {
    await tx.query(
      `INSERT INTO mail_folders (tenant_id, account_id, path, name, role)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [tid, accountId, f.path, f.name, f.role],
    )
  }
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
    `INSERT INTO mail_accounts (tenant_id, id, user_id, email, display_name, provider, auth_type, is_default)
     VALUES ($1,$2,$3,$4,$5,'internal','password',true)`,
    [tid, id, args.userId, args.email.toLowerCase(), args.displayName ?? null],
  )
  await provisionFolders(tx, tid, id)
  const created = await findAccountByUser(tx, args.userId)
  if (!created) throw new MailError('MAILBOX_NOT_FOUND', 'the mailbox vanished after creation')
  return created
}

export async function findAccountByUser(
  tx: PoolClient,
  userId: string,
): Promise<MailAccount | null> {
  return accountForUser(tx, userId)
}

export async function findAccountByEmail(
  tx: PoolClient,
  email: string,
): Promise<MailAccount | null> {
  const { rows } = await tx.query<MailAccount>(
    `SELECT id, user_id, email, display_name, provider, status, last_error, label, is_default,
            imap_host, smtp_host, created_at::text
       FROM mail_accounts WHERE lower(email) = lower($1) AND ${LIVE}
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
