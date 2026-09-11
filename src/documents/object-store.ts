/**
 * S3-compatible object storage, hand-rolled.
 *
 * AWS Signature v4 over fetch and node:crypto — no SDK, because the SDK is
 * forty megabytes to sign a header. Works against S3, R2, MinIO and anything
 * else that speaks the protocol with path-style addressing.
 *
 * Configured from the environment; absent, `objectStoreFromEnv()` returns null
 * and documents stay in Postgres. The choice is recorded per row in
 * `documents.storage`, so switching backends never orphans what was written
 * before — old rows read from the database, new rows from the bucket.
 */
import { createHash, createHmac } from 'node:crypto'

export interface ObjectStoreConfig {
  endpoint: string      // https://s3.ap-south-1.amazonaws.com or http://localhost:9000
  bucket: string
  region: string
  accessKey: string
  secretKey: string
}

export class ObjectStoreError extends Error {
  readonly code: string
  readonly status: number | undefined
  constructor(code: string, message: string, status?: number) {
    super(message)
    this.code = code
    this.status = status
    this.name = 'ObjectStoreError'
  }
}

const sha256hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest()

/** RFC 3986, which is stricter than encodeURIComponent about `!'()*`. */
const uriEncode = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

const amzDate = (d: Date): string => d.toISOString().replace(/[-:]|\.\d{3}/g, '')

export interface SignedRequest {
  url: string
  headers: Record<string, string>
}

/**
 * Signs one request. Exported so the wire format can be tested without a
 * network: the same inputs must always produce the same Authorization header.
 */
export function signRequest(
  cfg: ObjectStoreConfig,
  args: { method: string; key: string; body?: Buffer; contentType?: string; now?: Date },
): SignedRequest {
  const now = args.now ?? new Date()
  const stamp = amzDate(now)
  const day = stamp.slice(0, 8)
  const base = new URL(cfg.endpoint)
  const path = `/${uriEncode(cfg.bucket)}/${args.key.split('/').map(uriEncode).join('/')}`
  const payloadHash = sha256hex(args.body ?? '')

  const headers: Record<string, string> = {
    host: base.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
  }
  if (args.contentType) headers['content-type'] = args.contentType
  if (args.body) headers['content-length'] = String(args.body.length)

  const signedNames = Object.keys(headers).sort()
  const canonicalHeaders = signedNames.map((h) => `${h}:${headers[h]!.trim()}\n`).join('')
  const signedHeaders = signedNames.join(';')
  const canonical = [args.method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')

  const scope = `${day}/${cfg.region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256hex(canonical)].join('\n')
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${cfg.secretKey}`, day), cfg.region), 's3'), 'aws4_request')
  const signature = hmac(kSigning, toSign).toString('hex')

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  // `host` is set by fetch itself; sending it explicitly is rejected by undici.
  const { host: _host, ...sendable } = headers
  return { url: `${base.origin}${path}`, headers: sendable }
}

export interface ObjectStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<Buffer | null>
  delete(key: string): Promise<void>
}

export function createObjectStore(cfg: ObjectStoreConfig, fetchImpl: typeof fetch = fetch): ObjectStore {
  const send = async (args: { method: string; key: string; body?: Buffer; contentType?: string }) => {
    const signed = signRequest(cfg, args)
    let res: Response
    try {
      res = await fetchImpl(signed.url, {
        method: args.method, headers: signed.headers,
        body: args.body ? new Uint8Array(args.body) : undefined,
      })
    } catch (err) {
      throw new ObjectStoreError('OBJECT_STORE_UNREACHABLE', `object store: ${(err as Error).message}`)
    }
    return res
  }

  return {
    async put(key, bytes, contentType) {
      const res = await send({ method: 'PUT', key, body: bytes, contentType })
      if (!res.ok) throw new ObjectStoreError('OBJECT_STORE_WRITE_FAILED', `PUT ${key}: ${res.status}`, res.status)
      await res.arrayBuffer()
    },
    async get(key) {
      const res = await send({ method: 'GET', key })
      if (res.status === 404) return null
      if (!res.ok) throw new ObjectStoreError('OBJECT_STORE_READ_FAILED', `GET ${key}: ${res.status}`, res.status)
      return Buffer.from(await res.arrayBuffer())
    },
    async delete(key) {
      const res = await send({ method: 'DELETE', key })
      // 404 on delete is the outcome we wanted.
      if (!res.ok && res.status !== 404) {
        throw new ObjectStoreError('OBJECT_STORE_DELETE_FAILED', `DELETE ${key}: ${res.status}`, res.status)
      }
      await res.arrayBuffer()
    },
  }
}

export function objectStoreFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectStore | null {
  const endpoint = env.PEPL_OBJECT_STORE_ENDPOINT
  const bucket = env.PEPL_OBJECT_STORE_BUCKET
  const accessKey = env.PEPL_OBJECT_STORE_ACCESS_KEY
  const secretKey = env.PEPL_OBJECT_STORE_SECRET_KEY
  if (!endpoint && !bucket && !accessKey && !secretKey) return null
  if (!endpoint || !bucket || !accessKey || !secretKey) {
    // Half a configuration is a misconfiguration, not a preference for Postgres.
    throw new ObjectStoreError('OBJECT_STORE_MISCONFIGURED',
      'PEPL_OBJECT_STORE_ENDPOINT, _BUCKET, _ACCESS_KEY and _SECRET_KEY must all be set, or none')
  }
  return createObjectStore({
    endpoint, bucket, accessKey, secretKey, region: env.PEPL_OBJECT_STORE_REGION ?? 'us-east-1',
  })
}
