import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import {
  deleteDocument, getDocument, listDocuments, putDocument, readDocument,
  DocumentError, MAX_BYTES,
} from '../src/documents/index.ts'

let A: Tenant
let B: Tenant
const UPLOADER = 'd0000000-0000-0000-0000-00000000000d'

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})
beforeEach(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})
afterAll(async () => {
  await closePools()
  await controlPool.end()
})

const put = (tenantId: string, bytes: Buffer, fileName = 'offer.pdf') =>
  withTenant(tenantId, (tx) =>
    putDocument(tx, {
      ownerType: 'tenant',
      fileName,
      contentType: 'application/pdf',
      bytes,
      uploadedByUserId: UPLOADER,
    }))

describe('a document round-trips byte for byte', () => {
  it('returns exactly what was stored', async () => {
    const bytes = Buffer.from('%PDF-1.4 offer letter \u0000\u00ff binary', 'utf8')
    const meta = await put(A.id, bytes)
    const found = await withTenant(A.id, (tx) => readDocument(tx, meta.id))
    expect(found?.bytes.equals(bytes)).toBe(true)
    expect(found?.meta.size_bytes).toBe(bytes.length)
  })

  it('records a checksum of the content', async () => {
    const meta = await put(A.id, Buffer.from('abc'))
    // sha256("abc")
    expect(meta.sha256).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('limits are enforced before anything is written', () => {
  it('rejects an empty file', async () => {
    await expect(put(A.id, Buffer.alloc(0))).rejects.toMatchObject({ code: 'EMPTY_FILE' })
  })

  it('rejects a file over the size limit', async () => {
    await expect(put(A.id, Buffer.alloc(MAX_BYTES + 1)))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
  })

  it('rejects a blank file name', async () => {
    await expect(put(A.id, Buffer.from('x'), '   '))
      .rejects.toMatchObject({ code: 'INVALID_FILE_NAME' })
  })

  it('writes nothing when the size check fails', async () => {
    await put(A.id, Buffer.from('kept')).catch(() => {})
    await put(A.id, Buffer.alloc(MAX_BYTES + 1)).catch(() => {})
    const list = await withTenant(A.id, (tx) => listDocuments(tx, {}))
    expect(list).toHaveLength(1)
  })
})

describe('deletion destroys the bytes and keeps the trail', () => {
  it('removes the content but leaves a tombstone', async () => {
    const meta = await put(A.id, Buffer.from('sensitive'))
    await withTenant(A.id, (tx) => deleteDocument(tx, meta.id, 'employee erasure request'))

    expect(await withTenant(A.id, (tx) => getDocument(tx, meta.id))).toBeNull()
    expect(await withTenant(A.id, (tx) => listDocuments(tx, {}))).toHaveLength(0)

    const rows = await withTenant(A.id, async (tx) => {
      const r = await tx.query(
        `SELECT d.deleted_reason, b.document_id AS blob
           FROM documents d LEFT JOIN document_blobs b ON b.document_id = d.id
          WHERE d.id = $1`, [meta.id])
      return r.rows as { deleted_reason: string; blob: string | null }[]
    })
    expect(rows[0]!.deleted_reason).toBe('employee erasure request')
    expect(rows[0]!.blob).toBeNull()
  })

  it('refuses to delete something that is not there', async () => {
    await expect(
      withTenant(A.id, (tx) => deleteDocument(tx, A.id, 'nothing to delete')),
    ).rejects.toBeInstanceOf(DocumentError)
  })
})

describe('documents are tenant-isolated', () => {
  it('another company cannot list, read or delete them', async () => {
    const meta = await put(A.id, Buffer.from('acme confidential'))

    expect(await withTenant(B.id, (tx) => listDocuments(tx, {}))).toHaveLength(0)
    expect(await withTenant(B.id, (tx) => getDocument(tx, meta.id))).toBeNull()
    expect(await withTenant(B.id, (tx) => readDocument(tx, meta.id))).toBeNull()
    await expect(
      withTenant(B.id, (tx) => deleteDocument(tx, meta.id, 'not mine')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // and A still has it, untouched
    expect(await withTenant(A.id, (tx) => getDocument(tx, meta.id))).not.toBeNull()
  })

  it('cannot be written into another tenant', async () => {
    await expect(
      withTenant(B.id, (tx) =>
        tx.query(
          `INSERT INTO documents (tenant_id, owner_type, file_name, content_type, size_bytes, sha256)
           VALUES ($1, 'tenant', 'planted.pdf', 'application/pdf', 1, 'x')`, [A.id])),
    ).rejects.toThrow(/row-level security/i)
  })
})

describe('the storage allowance a plan sells', () => {
  /** Sets this tenant's entitlement limits directly, as the control plane would. */
  const setStorageGb = (tenantId: string, gb: number | null) =>
    controlPool.query(
      `UPDATE tenant_entitlements SET limits = jsonb_set(coalesce(limits, '{}'::jsonb), '{storage_gb}', $2::jsonb) WHERE tenant_id = $1`,
      [tenantId, JSON.stringify(gb)])

  it('refuses an upload that would take the company past its limit', async () => {
    // A limit small enough to cross with a file the size cap still allows: the
    // point is the ACCOUNT being full, which is a different answer from the
    // file being too big, and a client has to be able to tell them apart.
    const oneMb = 1 / 1024
    await setStorageGb(A.id, oneMb)
    await put(A.id, Buffer.alloc(900 * 1024, 7), 'first.pdf')

    await expect(put(A.id, Buffer.alloc(500 * 1024, 9), 'second.pdf'))
      .rejects.toMatchObject({ code: 'STORAGE_LIMIT_REACHED' })
  })

  it('does not count documents belonging to another company', async () => {
    // The sum runs under RLS, so it can only ever see this tenant's rows —
    // but a quota that leaked across tenants would be a billing bug AND a
    // disclosure, so it is worth pinning.
    const oneMb = 1 / 1024
    await setStorageGb(A.id, oneMb)
    await setStorageGb(B.id, oneMb)
    await put(B.id, Buffer.alloc(900 * 1024, 3), 'theirs.pdf')

    await expect(put(A.id, Buffer.alloc(900 * 1024, 4), 'mine.pdf')).resolves.toBeTruthy()
  })

  it('a plan with no storage_gb sells unlimited storage', async () => {
    await setStorageGb(A.id, null)
    await expect(put(A.id, Buffer.alloc(64 * 1024, 1), 'unbounded.pdf')).resolves.toBeTruthy()
  })
})
