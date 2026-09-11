/**
 * Object storage: the signature is deterministic and well-formed, the fake
 * bucket accepts it, and documents written while a store is configured read
 * back through it — while rows written before still read from Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, createHmac } from 'node:crypto'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import {
  createObjectStore, objectStoreFromEnv, signRequest, ObjectStoreError, type ObjectStoreConfig,
} from '../src/documents/object-store.ts'
import { deleteDocument, putDocument, readDocument, setObjectStore } from '../src/documents/index.ts'

const CFG: ObjectStoreConfig = {
  endpoint: '', bucket: 'pepl-docs', region: 'ap-south-1',
  accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
}

/**
 * A bucket in forty lines. It verifies the signature INDEPENDENTLY of the
 * client: re-derives the signing key from the credential scope in the header
 * and recomputes the string to sign from what actually arrived on the wire.
 */
const objects = new Map<string, { bytes: Buffer; type: string }>()
let server: Server
let seenAuth: string[] = []

function verify(req: { method?: string; url?: string; headers: Record<string, string | string[] | undefined> }, body: Buffer): boolean {
  const auth = String(req.headers.authorization ?? '')
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth)
  if (!m) return false
  const [, access, day, region, signedHeaders, signature] = m
  if (access !== CFG.accessKey || region !== CFG.region) return false
  const names = signedHeaders!.split(';')
  const canonicalHeaders = names.map((h) => `${h}:${String(req.headers[h] ?? '').trim()}\n`).join('')
  const payloadHash = createHash('sha256').update(body).digest('hex')
  if (req.headers['x-amz-content-sha256'] !== payloadHash) return false
  const canonical = [req.method, req.url, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${day}/${region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], scope,
    createHash('sha256').update(canonical).digest('hex')].join('\n')
  const h = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest()
  const kSigning = h(h(h(h(`AWS4${CFG.secretKey}`, day!), region!), 's3'), 'aws4_request')
  return h(kSigning, toSign).toString('hex') === signature
}

let A: Tenant
let B: Tenant

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seenAuth.push(String(req.headers.authorization))
      if (!verify(req as never, body)) { res.writeHead(403); res.end('SignatureDoesNotMatch'); return }
      const key = req.url!.replace(`/${CFG.bucket}/`, '')
      if (req.method === 'PUT') { objects.set(key, { bytes: body, type: String(req.headers['content-type']) }); res.writeHead(200); res.end(); return }
      if (req.method === 'GET') {
        const o = objects.get(key)
        if (!o) { res.writeHead(404); res.end(); return }
        res.writeHead(200, { 'content-type': o.type }); res.end(o.bytes); return
      }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); res.end(); return }
      res.writeHead(405); res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  CFG.endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})

afterAll(async () => {
  setObjectStore(undefined)
  await new Promise<void>((r) => server.close(() => r()))
  await closePools()
  await controlPool.end()
})

describe('signature v4', () => {
  it('is deterministic for the same inputs and changes with the secret', () => {
    const now = new Date('2026-09-11T10:00:00Z')
    const a = signRequest(CFG, { method: 'GET', key: 'tenants/t/documents/d', now })
    const b = signRequest(CFG, { method: 'GET', key: 'tenants/t/documents/d', now })
    const c = signRequest({ ...CFG, secretKey: 'other' }, { method: 'GET', key: 'tenants/t/documents/d', now })
    expect(a.headers.authorization).toBe(b.headers.authorization)
    expect(a.headers.authorization).not.toBe(c.headers.authorization)
    expect(a.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260911\/ap-south-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/)
    expect(a.headers['x-amz-date']).toBe('20260911T100000Z')
    expect(a.headers).not.toHaveProperty('host')
  })

  it('percent-encodes keys the strict RFC 3986 way', () => {
    const r = signRequest(CFG, { method: 'GET', key: "odd name (1)'*.pdf" })
    expect(r.url.endsWith("/pepl-docs/odd%20name%20%281%29%27%2A.pdf")).toBe(true)
  })

  it('a bucket that re-derives the signature accepts put, get and delete', async () => {
    const store = createObjectStore(CFG)
    await store.put('k/one', Buffer.from('hello'), 'text/plain')
    expect((await store.get('k/one'))?.toString()).toBe('hello')
    await store.delete('k/one')
    expect(await store.get('k/one')).toBeNull()
    expect(seenAuth.length).toBeGreaterThanOrEqual(4)
  })

  it('a wrong secret is refused by the bucket and surfaces as a typed error', async () => {
    const store = createObjectStore({ ...CFG, secretKey: 'nope' })
    await expect(store.put('k/two', Buffer.from('x'), 'text/plain'))
      .rejects.toMatchObject({ code: 'OBJECT_STORE_WRITE_FAILED', status: 403 })
  })

  it('an unreachable endpoint is a 503-class error, not a crash', async () => {
    const store = createObjectStore({ ...CFG, endpoint: 'http://127.0.0.1:1' })
    await expect(store.get('k')).rejects.toBeInstanceOf(ObjectStoreError)
    await expect(store.get('k')).rejects.toMatchObject({ code: 'OBJECT_STORE_UNREACHABLE' })
  })

  it('half an environment is a misconfiguration; none is Postgres', () => {
    expect(objectStoreFromEnv({})).toBeNull()
    expect(() => objectStoreFromEnv({ PEPL_OBJECT_STORE_BUCKET: 'b' }))
      .toThrow(/must all be set/)
    expect(objectStoreFromEnv({
      PEPL_OBJECT_STORE_ENDPOINT: 'http://x', PEPL_OBJECT_STORE_BUCKET: 'b',
      PEPL_OBJECT_STORE_ACCESS_KEY: 'a', PEPL_OBJECT_STORE_SECRET_KEY: 's',
    })).not.toBeNull()
  })
})

describe('documents through the store', () => {
  it('a row written before the switch still reads from Postgres; new rows read from the bucket', async () => {
    setObjectStore(null)
    const before = await withTenant(A.id, (tx) => putDocument(tx, {
      ownerType: 'tenant', fileName: 'old.txt', contentType: 'text/plain', bytes: Buffer.from('old bytes'),
    }))

    setObjectStore(createObjectStore(CFG))
    const after = await withTenant(A.id, (tx) => putDocument(tx, {
      ownerType: 'tenant', fileName: 'new.txt', contentType: 'text/plain', bytes: Buffer.from('new bytes'),
    }))

    await withTenant(A.id, async (tx) => {
      const { rows } = await tx.query<{ id: string; storage: string; storage_key: string | null }>(
        `SELECT id, storage, storage_key FROM documents WHERE id = ANY($1)`, [[before.id, after.id]])
      const by = Object.fromEntries(rows.map((r) => [r.id, r]))
      expect(by[before.id]!.storage).toBe('db')
      expect(by[after.id]!.storage).toBe('object')
      expect(by[after.id]!.storage_key).toBe(`tenants/${A.id}/documents/${after.id}`)
      expect(objects.has(by[after.id]!.storage_key!)).toBe(true)
      // no blob row for the object-stored document
      const blobs = await tx.query(`SELECT 1 FROM document_blobs WHERE document_id = $1`, [after.id])
      expect(blobs.rowCount).toBe(0)

      expect((await readDocument(tx, before.id))!.bytes.toString()).toBe('old bytes')
      expect((await readDocument(tx, after.id))!.bytes.toString()).toBe('new bytes')
    })
  })

  it('the object key is tenant-prefixed and another tenant cannot reach the row anyway', async () => {
    const doc = await withTenant(A.id, (tx) => putDocument(tx, {
      ownerType: 'tenant', fileName: 'a.txt', contentType: 'text/plain', bytes: Buffer.from('A only'),
    }))
    await withTenant(B.id, async (tx) => {
      expect(await readDocument(tx, doc.id)).toBeNull()
    })
  })

  it('a tampered object fails the hash check instead of being served', async () => {
    const doc = await withTenant(A.id, (tx) => putDocument(tx, {
      ownerType: 'tenant', fileName: 't.txt', contentType: 'text/plain', bytes: Buffer.from('genuine'),
    }))
    const key = `tenants/${A.id}/documents/${doc.id}`
    objects.set(key, { bytes: Buffer.from('forged'), type: 'text/plain' })
    await withTenant(A.id, async (tx) => {
      await expect(readDocument(tx, doc.id)).rejects.toMatchObject({ code: 'CONTENT_CORRUPT' })
    })
  })

  it('deleting destroys the object as well as the row content', async () => {
    const doc = await withTenant(A.id, (tx) => putDocument(tx, {
      ownerType: 'tenant', fileName: 'd.txt', contentType: 'text/plain', bytes: Buffer.from('gone soon'),
    }))
    const key = `tenants/${A.id}/documents/${doc.id}`
    expect(objects.has(key)).toBe(true)
    await withTenant(A.id, (tx) => deleteDocument(tx, doc.id, 'test'))
    expect(objects.has(key)).toBe(false)
  })

  it('reading an object-stored row where no store is configured names the problem', async () => {
    const doc = await withTenant(A.id, (tx) => putDocument(tx, {
      ownerType: 'tenant', fileName: 'x.txt', contentType: 'text/plain', bytes: Buffer.from('x'),
    }))
    setObjectStore(null)
    await withTenant(A.id, async (tx) => {
      await expect(readDocument(tx, doc.id)).rejects.toMatchObject({ code: 'OBJECT_STORE_MISCONFIGURED' })
    })
  })
})
