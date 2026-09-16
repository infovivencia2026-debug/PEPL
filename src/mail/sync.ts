/**
 * The inbound sync.
 *
 * Pulls folders and envelopes from a tenant's own IMAP server into the local
 * cache the list views read. Three properties matter more than speed:
 *
 *   1. **Envelopes, not bodies, by default.** `mail.store_bodies` is off out of
 *      the box: PEPL keeps enough to render a list and fetches the body when
 *      someone opens the message. A company that has not asked us to hold their
 *      correspondence should not find a copy of it in our database.
 *   2. **UID watermark per folder.** Each pass asks only for what arrived after
 *      the highest UID seen. A resync is therefore cheap and a missed run costs
 *      nothing but latency.
 *   3. **UIDVALIDITY is checked.** When a server renumbers a mailbox every
 *      cached UID becomes a lie pointing at someone else's message. That is the
 *      one condition where the cache is dropped and rebuilt rather than merged.
 */
import { randomUUID } from 'node:crypto'
import { publish } from '../realtime/bus.ts'
import type { PoolClient } from 'pg'
import { withTenant } from '../db/tenant-tx.ts'
import { decryptSecret } from '../comms/index.ts'
import { connectImap, ImapError, type Connection, type ImapConfig } from './imap.ts'
import { MailError } from './accounts.ts'
import { parseMessage } from './parse.ts'
import { storeParsedBody } from './attachments.ts'

/** One pass will not pull more than this per folder, so a first sync ends. */
export const PAGE_SIZE = 200

export interface SyncResult {
  account: string
  foldersSeen: number
  messagesAdded: number
  rebuilt: string[]
  errors: string[]
}

export interface AccountRow {
  id: string
  user_id: string
  email: string
  imap_host: string | null
  imap_port: number | null
  imap_secure: boolean | null
  username: string | null
  secret_ciphertext: Buffer | null
}

/** Injectable so tests drive a local server instead of a real mailbox. */
export type Connector = (config: ImapConfig) => Promise<Connection>

/** Accounts with somewhere to sync from. */
export async function syncableAccounts(tx: PoolClient): Promise<AccountRow[]> {
  const { rows } = await tx.query<AccountRow>(
    `SELECT id, user_id, email, imap_host, imap_port, imap_secure, username, secret_ciphertext
       FROM mail_accounts
      WHERE status = 'connected'
        AND provider <> 'internal'
        AND imap_host IS NOT NULL
        AND secret_ciphertext IS NOT NULL
        AND (quarantined_until IS NULL OR quarantined_until < now())
      ORDER BY created_at`,
  )
  return rows
}

/**
 * Records a failure against the account.
 *
 * After three consecutive failures the account is quarantined for an hour.
 * Hammering a server that is rejecting us is how an IP ends up blocklisted, and
 * the person needs to be told their mailbox is disconnected rather than left
 * wondering why nothing arrives.
 */
export async function recordFailure(
  tx: PoolClient,
  accountId: string,
  error: string,
  permanent: boolean,
): Promise<void> {
  await tx.query(
    `UPDATE mail_accounts
        SET consecutive_failures = consecutive_failures + 1,
            last_error = $2,
            status = CASE WHEN $3 THEN 'auth_failed' ELSE status END,
            quarantined_until = CASE
              WHEN $3 OR consecutive_failures + 1 >= 3 THEN now() + interval '1 hour'
              ELSE quarantined_until END
      WHERE id = $1`,
    [accountId, error.slice(0, 500), permanent],
  )
}

export async function recordSuccess(tx: PoolClient, accountId: string): Promise<void> {
  await tx.query(
    `UPDATE mail_accounts
        SET consecutive_failures = 0, last_error = NULL, quarantined_until = NULL,
            status = 'connected'
      WHERE id = $1`,
    [accountId],
  )
}

/** The watermark: nothing at or below this uid needs fetching again. */
async function highestUidIn(tx: PoolClient, folderId: string): Promise<number> {
  const { rows } = await tx.query<{ max: string | null }>(
    `SELECT max(uid)::text AS max FROM mail_envelopes WHERE folder_id = $1`, [folderId],
  )
  return Number(rows[0]?.max ?? 0)
}

/** Upserts the folder and returns its id plus the sync state we hold. */
async function upsertFolder(
  tx: PoolClient,
  args: { tenantId: string; accountId: string; path: string; name: string; role: string },
): Promise<{ id: string; uidValidity: number | null; highestUid: number }> {
  const existing = await tx.query<{ id: string; uid_validity: string | null }>(
    `SELECT id, uid_validity::text FROM mail_folders WHERE account_id = $1 AND path = $2`,
    [args.accountId, args.path],
  )

  let id = existing.rows[0]?.id

  // A mailbox is provisioned locally with the five standard folders, and the
  // server has its own names for them — "Sent Items", "Deleted Items". Adopting
  // the existing row rather than inserting a second one is what keeps a person
  // from seeing two Sent folders, and is required by the one-folder-per-role
  // index besides.
  if (!id && args.role !== 'custom') {
    const byRole = await tx.query<{ id: string; uid_validity: string | null }>(
      `UPDATE mail_folders SET path = $3, name = $4
        WHERE account_id = $1 AND role = $2
        RETURNING id, uid_validity::text`,
      [args.accountId, args.role, args.path, args.name],
    )
    if (byRole.rows[0]) {
      return {
        id: byRole.rows[0].id,
        // The path just changed under it, so any cached uid is not comparable.
        uidValidity: existing.rows[0]?.uid_validity ? Number(existing.rows[0].uid_validity) : null,
        highestUid: await highestUidIn(tx, byRole.rows[0].id),
      }
    }
  }

  if (!id) {
    id = randomUUID()
    await tx.query(
      `INSERT INTO mail_folders (tenant_id, id, account_id, path, name, role)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, account_id, path) DO NOTHING`,
      [args.tenantId, id, args.accountId, args.path, args.name, args.role],
    )
    const created = await tx.query<{ id: string }>(
      `SELECT id FROM mail_folders WHERE account_id = $1 AND path = $2`,
      [args.accountId, args.path],
    )
    const createdId = created.rows[0]?.id
    if (!createdId) {
      throw new MailError('FOLDER_NOT_FOUND', `could not create the folder "${args.path}"`)
    }
    id = createdId
  }

  return {
    id,
    uidValidity: existing.rows[0]?.uid_validity ? Number(existing.rows[0].uid_validity) : null,
    highestUid: await highestUidIn(tx, id),
  }
}

/**
 * Syncs one account.
 *
 * Each folder is its own transaction: a mailbox with fifty folders should not
 * lose forty-nine of them because the fiftieth had a malformed header.
 */
export async function syncAccount(
  tenantId: string,
  account: AccountRow,
  opts: { master: string; storeBodies: boolean; connect?: Connector; pageSize?: number },
): Promise<SyncResult> {
  const result: SyncResult = {
    account: account.email, foldersSeen: 0, messagesAdded: 0, rebuilt: [], errors: [],
  }
  const connect = opts.connect ?? connectImap
  const pageSize = opts.pageSize ?? PAGE_SIZE

  if (!account.secret_ciphertext || !account.imap_host) {
    throw new MailError('MAILBOX_NOT_FOUND', `${account.email} has no incoming server configured`)
  }
  const password = decryptSecret(account.secret_ciphertext, tenantId, opts.master)

  const connection = await connect({
    host: account.imap_host,
    port: account.imap_port ?? 993,
    secure: account.imap_secure ?? true,
    username: account.username ?? account.email,
    password,
  })

  try {
    const folders = await connection.listFolders()
    result.foldersSeen = folders.length

    for (const folder of folders) {
      if (!folder.selectable) continue
      try {
        const state = await withTenant(tenantId, (tx) =>
          upsertFolder(tx, {
            tenantId, accountId: account.id, path: folder.path,
            name: folder.name, role: folder.role,
          }))

        const selected = await connection.select(folder.path)

        // The server renumbered: every cached uid now points somewhere else.
        if (state.uidValidity !== null && state.uidValidity !== selected.uidValidity) {
          await withTenant(tenantId, async (tx) => {
            await tx.query(`DELETE FROM mail_envelopes WHERE folder_id = $1`, [state.id])
          })
          result.rebuilt.push(folder.path)
          state.highestUid = 0
        }

        const envelopes = await connection.fetchSince(state.highestUid, pageSize)
        let addedHere = 0

        for (const envelope of envelopes) {
          const fetched = opts.storeBodies ? await connection.fetchBody(envelope.uid) : null
          const parsed = fetched?.source ? parseMessage(fetched.source) : null
          await withTenant(tenantId, async (tx) => {
            const id = randomUUID()
            const inserted = await tx.query(
              `INSERT INTO mail_envelopes
                 (tenant_id, id, account_id, folder_id, source, uid, message_id, thread_key,
                  in_reply_to, from_name, from_address, to_addresses, cc_addresses,
                  subject, preview, sent_at, received_at, size_bytes,
                  is_seen, is_flagged, is_answered, has_attachment)
               VALUES ($1,$2,$3,$4,'imap',$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,
                       $13,$14,$15,now(),$16,$17,$18,$19,$20)
               ON CONFLICT DO NOTHING`,
              [
                tenantId, id, account.id, state.id, envelope.uid, envelope.messageId,
                envelope.inReplyTo ?? envelope.messageId, envelope.inReplyTo,
                envelope.fromName, envelope.fromAddress,
                JSON.stringify(envelope.to), JSON.stringify(envelope.cc),
                envelope.subject, null,
                envelope.date ? new Date(envelope.date).toISOString() : null,
                envelope.size, envelope.seen, envelope.flagged, envelope.answered,
                envelope.hasAttachment || (parsed?.attachments.some((a) => !a.inline) ?? false),
              ],
            )
            if (inserted.rowCount && parsed) {
              await storeParsedBody(tx, { tenantId, envelopeId: id, accountId: account.id, parsed })
            }
            if (inserted.rowCount) { result.messagesAdded++; addedHere++ }
          })
        }

        // After the commits above, never before: the browser must be able to
        // refetch what it was just told about. One event per folder pass, not
        // per message — the client refetches the list either way.
        if (addedHere > 0) {
          publish(tenantId, {
            type: 'mail.received',
            userIds: [account.user_id],
            data: { accountId: account.id, folderId: state.id, folder: folder.role, added: addedHere },
          })
        }

        await withTenant(tenantId, async (tx) => {
          await tx.query(
            `UPDATE mail_folders
                SET uid_validity = $2, uid_next = $3, last_synced_at = now()
              WHERE id = $1`,
            [state.id, selected.uidValidity, selected.uidNext],
          )
        })
      } catch (err) {
        result.errors.push(`${folder.path}: ${(err as Error).message}`)
      }
    }

    await withTenant(tenantId, (tx) => recordSuccess(tx, account.id))
  } finally {
    await connection.close().catch(() => { /* closing a broken socket is not news */ })
  }

  return result
}

/** Syncs every connected mailbox in one tenant. */
export async function syncTenant(
  tenantId: string,
  opts: { master: string; storeBodies: boolean; connect?: Connector; pageSize?: number },
): Promise<SyncResult[]> {
  const accounts = await withTenant(tenantId, (tx) => syncableAccounts(tx))
  const results: SyncResult[] = []

  for (const account of accounts) {
    try {
      results.push(await syncAccount(tenantId, account, opts))
    } catch (err) {
      const permanent = err instanceof ImapError &&
        (err.code === 'AUTH_FAILED' || err.code === 'INSECURE_AUTH')
      await withTenant(tenantId, (tx) =>
        recordFailure(tx, account.id, (err as Error).message, permanent))
      results.push({
        account: account.email, foldersSeen: 0, messagesAdded: 0, rebuilt: [],
        errors: [(err as Error).message],
      })
    }
  }

  return results
}
