/**
 * Document storage.
 *
 * Offer letters, ID proofs, policy PDFs, chat and mail attachments all land
 * here. Metadata and bytes are separate tables so a folder listing never pulls
 * megabytes through the connection pool, and `storage` names the backend so
 * moving to object storage later is a new value, not a migration of every row.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { objectStoreFromEnv, type ObjectStore } from './object-store.ts'

/**
 * The backend for NEW documents. Existing rows carry their own `storage`, so
 * this can change between deploys without touching what was already written.
 * Resolved lazily so importing this module never throws on a half-set
 * environment; tests inject a fake through `setObjectStore`.
 */
let store: ObjectStore | null | undefined
export function setObjectStore(s: ObjectStore | null | undefined): void { store = s }
function objectStore(): ObjectStore | null {
  if (store === undefined) store = objectStoreFromEnv()
  return store
}

const objectKey = (tenantId: string, id: string): string => `tenants/${tenantId}/documents/${id}`

/** 10 MB. Larger than any policy PDF, smaller than anything that should stream. */
export const MAX_BYTES = 10 * 1024 * 1024

export type OwnerType = 'employee' | 'ticket' | 'conversation' | 'tenant' | 'mail'

export class DocumentError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'DocumentError'
  }
}

export interface DocumentMeta {
  id: string
  owner_type: OwnerType
  owner_id: string | null
  category: string | null
  file_name: string
  content_type: string
  size_bytes: number
  sha256: string
  is_confidential: boolean
  uploaded_by_user_id: string | null
  created_at: string
}

const META_COLUMNS = `id, owner_type, owner_id, category, file_name, content_type,
                      size_bytes, sha256, is_confidential, uploaded_by_user_id, created_at`

async function tenantId(tx: PoolClient): Promise<string> {
  const { rows } = await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')
  const t = rows[0]?.t
  if (!t) throw new DocumentError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}

/**
 * Stores a file and returns its metadata.
 *
 * The id is generated here rather than by `RETURNING`: a confidential document
 * can be hidden from its own uploader by a future policy, and `RETURNING` then
 * fails in a way that reads like a WITH CHECK violation and is not.
 */
const GB = 1024 ** 3

/**
 * Bytes this company may store, or Infinity when the plan sets no limit.
 * A plan with no storage_gb sells unlimited storage, which is a pricing
 * decision; a plan with 0 would sell none, so it is treated as unset.
 */
async function storageLimit(tx: PoolClient): Promise<number> {
  const { rows } = await tx.query<{ gb: string | null }>(
    `SELECT limits->>'storage_gb' AS gb FROM tenant_entitlements`)
  const gb = Number(rows[0]?.gb)
  return Number.isFinite(gb) && gb > 0 ? gb * GB : Number.POSITIVE_INFINITY
}

export async function putDocument(
  tx: PoolClient,
  args: {
    ownerType: OwnerType
    ownerId?: string | null
    fileName: string
    contentType: string
    bytes: Buffer
    category?: string | null
    isConfidential?: boolean
    uploadedByUserId?: string | null
  },
): Promise<DocumentMeta> {
  const tid = await tenantId(tx)
  if (args.bytes.length === 0) throw new DocumentError('EMPTY_FILE', 'the file is empty')
  if (args.bytes.length > MAX_BYTES) {
    throw new DocumentError(
      'FILE_TOO_LARGE',
      `the file is ${args.bytes.length} bytes; the limit is ${MAX_BYTES}`,
    )
  }
  const name = args.fileName.trim()
  if (!name || name.length > 255) {
    throw new DocumentError('INVALID_FILE_NAME', 'a file name of 1-255 characters is required')
  }

  // The plan's storage allowance. Checked HERE rather than in the route so no
  // caller can upload around it, and read from the same tenant_entitlements row
  // the config resolver uses, so the quota and the plan can never disagree.
  // The sum is a scan of one tenant's rows on every upload; at the size a
  // document library reaches that is cheaper than keeping a counter honest.
  const limitBytes = await storageLimit(tx)
  if (Number.isFinite(limitBytes)) {
    const { rows } = await tx.query<{ used: string }>(
      `SELECT coalesce(sum(size_bytes), 0)::text AS used FROM documents`)
    const used = Number(rows[0]!.used)
    if (used + args.bytes.length > limitBytes) {
      throw new DocumentError(
        'STORAGE_LIMIT_REACHED',
        `this plan includes ${(limitBytes / GB).toFixed(0)} GB of storage and ${(used / GB).toFixed(2)} GB is in use; ` +
        'delete something or move to a larger plan',
      )
    }
  }

  const id = randomUUID()
  const sha256 = createHash('sha256').update(args.bytes).digest('hex')

  // Upload BEFORE the row: if this transaction later rolls back the bucket
  // holds an orphan nobody references, which is cheap; a row whose bytes never
  // arrived is a document that fails to open.
  const os = objectStore()
  if (os) await os.put(objectKey(tid, id), args.bytes, args.contentType)

  await tx.query(
    `INSERT INTO documents (tenant_id, id, owner_type, owner_id, category, file_name,
                            content_type, size_bytes, sha256, is_confidential, uploaded_by_user_id,
                            storage, storage_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [tid, id, args.ownerType, args.ownerId ?? null, args.category ?? null, name,
     args.contentType, args.bytes.length, sha256, args.isConfidential ?? false,
     args.uploadedByUserId ?? null,
     os ? 'object' : 'db', os ? objectKey(tid, id) : null],
  )
  if (!os) {
    await tx.query(
      `INSERT INTO document_blobs (tenant_id, document_id, bytes) VALUES ($1,$2,$3)`,
      [tid, id, args.bytes],
    )
  }

  const meta = await getDocument(tx, id)
  if (!meta) throw new DocumentError('NOT_FOUND', 'the document vanished after writing')
  return meta
}

export async function getDocument(tx: PoolClient, id: string): Promise<DocumentMeta | null> {
  const { rows } = await tx.query<DocumentMeta>(
    `SELECT ${META_COLUMNS} FROM documents WHERE id = $1 AND deleted_at IS NULL`, [id],
  )
  return rows[0] ?? null
}

export async function listDocuments(
  tx: PoolClient,
  args: { ownerType?: OwnerType; ownerId?: string | null; category?: string | null; limit?: number; ownerTypes?: readonly OwnerType[] },
): Promise<DocumentMeta[]> {
  const { rows } = await tx.query<DocumentMeta>(
    `SELECT ${META_COLUMNS} FROM documents
      WHERE deleted_at IS NULL
        AND ($1::text IS NULL OR owner_type = $1)
        AND ($2::uuid IS NULL OR owner_id = $2)
        AND ($4::text IS NULL OR category = $4)
        AND ($5::text[] IS NULL OR owner_type = ANY($5))
      ORDER BY category, created_at DESC
      LIMIT $3`,
    [args.ownerType ?? null, args.ownerId ?? null, Math.min(args.limit ?? 100, 500), args.category ?? null, args.ownerTypes ? [...args.ownerTypes] : null],
  )
  return rows
}

/** Metadata plus bytes. Separate call so a listing never pays for content. */
export async function readDocument(
  tx: PoolClient,
  id: string,
): Promise<{ meta: DocumentMeta; bytes: Buffer } | null> {
  const meta = await getDocument(tx, id)
  if (!meta) return null
  const { rows } = await tx.query<{ storage: 'db' | 'object'; storage_key: string | null }>(
    `SELECT storage, storage_key FROM documents WHERE id = $1`, [id],
  )
  let bytes: Buffer | null | undefined
  if (rows[0]?.storage === 'object') {
    const os = objectStore()
    if (!os) throw new DocumentError('OBJECT_STORE_MISCONFIGURED',
      'this document lives in object storage, which is not configured here')
    bytes = await os.get(rows[0].storage_key!)
  } else {
    const blob = await tx.query<{ bytes: Buffer }>(
      `SELECT bytes FROM document_blobs WHERE document_id = $1`, [id],
    )
    bytes = blob.rows[0]?.bytes
  }
  if (!bytes) throw new DocumentError('CONTENT_MISSING', 'the document has no stored content')
  // Integrity is checked on every read, whichever backend: a bucket is a
  // different trust boundary from the database that holds the hash.
  if (createHash('sha256').update(bytes).digest('hex') !== meta.sha256) {
    throw new DocumentError('CONTENT_CORRUPT', 'the stored content does not match its recorded hash')
  }
  return { meta, bytes }
}

/**
 * Tombstones the metadata and destroys the bytes.
 *
 * The row survives so an audit trail still shows a file existed and who removed
 * it; the content does not, because a deletion request that leaves the bytes in
 * place is not a deletion.
 */
export async function deleteDocument(
  tx: PoolClient,
  id: string,
  reason: string,
): Promise<void> {
  const meta = await getDocument(tx, id)
  if (!meta) throw new DocumentError('NOT_FOUND', 'no such document')
  const { rows } = await tx.query<{ storage: string; storage_key: string | null }>(
    `SELECT storage, storage_key FROM documents WHERE id = $1`, [id],
  )
  await tx.query(
    `UPDATE documents SET deleted_at = now(), deleted_reason = $2 WHERE id = $1`, [id, reason],
  )
  await tx.query(`DELETE FROM document_blobs WHERE document_id = $1`, [id])
  if (rows[0]?.storage === 'object' && rows[0].storage_key) {
    const os = objectStore()
    if (!os) throw new DocumentError('OBJECT_STORE_MISCONFIGURED',
      'cannot destroy content in an object store that is not configured here')
    await os.delete(rows[0].storage_key)
  }
}
