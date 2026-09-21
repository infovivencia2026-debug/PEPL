/**
 * Web Push, from the standards, in node:crypto.
 *
 *   RFC 8030  the protocol: POST the ciphertext to the subscription endpoint
 *   RFC 8291  message encryption: ECDH P-256 + HKDF + AES-128-GCM
 *   RFC 8188  the `aes128gcm` content coding that frames it
 *   RFC 8292  VAPID: an ES256 JWT that tells the push service who we are
 *
 * No SDK and no vendor account. The server proves itself with a keypair from
 * the environment; the browser vendor's push service relays bytes it cannot
 * read. Generate a keypair once with `npm run job push.keygen` and keep the
 * private key like a password — a leaked key lets someone push as PEPL.
 */
import { createECDH, createHmac, createPrivateKey, createSign, randomBytes, createCipheriv } from 'node:crypto'

export interface VapidKeys {
  /** base64url, 65-byte uncompressed P-256 point. What the browser is given. */
  publicKey: string
  /** base64url, 32-byte scalar. */
  privateKey: string
  /** mailto: or https: — whom the push service may contact about abuse. */
  subject: string
}

export interface PushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export class WebPushError extends Error {
  readonly code: string
  readonly status: number | undefined
  constructor(code: string, message: string, status?: number) {
    super(message)
    this.code = code
    this.status = status
    this.name = 'WebPushError'
  }
}

export const b64url = {
  encode: (b: Buffer): string => b.toString('base64url'),
  decode: (s: string): Buffer => Buffer.from(s, 'base64url'),
}

/** A fresh VAPID keypair. Run once per deployment, not per process. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    publicKey: b64url.encode(ecdh.getPublicKey()),
    // getPrivateKey() drops leading zero bytes, so 1 key in 256 comes back 31
    // bytes long and fails the 32-byte check at start-up. Left-pad it.
    privateKey: b64url.encode(Buffer.concat([Buffer.alloc(32 - ecdh.getPrivateKey().length), ecdh.getPrivateKey()])),
  }
}

/** Turns the raw 32-byte scalar + 65-byte point into a KeyObject for signing. */
function privateKeyObject(privateKey: string, publicKey: string) {
  const d = b64url.decode(privateKey)
  const pub = b64url.decode(publicKey)
  if (d.length !== 32 || pub.length !== 65 || pub[0] !== 0x04) {
    throw new WebPushError('VAPID_KEYS_INVALID', 'VAPID keys must be a 32-byte scalar and a 65-byte uncompressed point')
  }
  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC', crv: 'P-256',
      x: b64url.encode(pub.subarray(1, 33)),
      y: b64url.encode(pub.subarray(33, 65)),
      d: privateKey,
    },
  })
}

/**
 * The VAPID Authorization header for one push service origin.
 * `aud` is the ORIGIN of the endpoint, never the endpoint itself.
 */
export function vapidAuthorization(keys: VapidKeys, endpoint: string, now = new Date()): string {
  const aud = new URL(endpoint).origin
  const header = b64url.encode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url.encode(Buffer.from(JSON.stringify({
    aud, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: keys.subject,
  })))
  const signer = createSign('SHA256')
  signer.update(`${header}.${claims}`)
  // JWS wants r||s, not the DER that createSign emits by default.
  const signature = signer.sign({ key: privateKeyObject(keys.privateKey, keys.publicKey), dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${claims}.${b64url.encode(signature)}, k=${keys.publicKey}`
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest()
  return createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length)
}

/**
 * RFC 8291 §3 + RFC 8188: encrypts one payload to a subscription.
 *
 * Returns the aes128gcm body: salt(16) | rs(4) | idlen(1) | our public key(65) | ciphertext.
 * The record ends with the 0x02 delimiter and no padding; a payload is a few
 * hundred bytes of JSON and the ciphertext length hides nothing the service
 * could not infer from the notification's timing anyway.
 */
export function encryptPayload(subscription: PushSubscription, plaintext: Buffer): Buffer {
  const uaPublic = b64url.decode(subscription.keys.p256dh)
  const authSecret = b64url.decode(subscription.keys.auth)
  if (uaPublic.length !== 65 || authSecret.length !== 16) {
    throw new WebPushError('SUBSCRIPTION_KEYS_INVALID', 'p256dh must be 65 bytes and auth 16 bytes')
  }
  if (plaintext.length > 3993) {
    throw new WebPushError('PAYLOAD_TOO_LARGE', 'push payloads are limited to 4 KB after framing')
  }

  const local = createECDH('prime256v1')
  local.generateKeys()
  const asPublic = local.getPublicKey()
  const ecdhSecret = local.computeSecret(uaPublic)
  const salt = randomBytes(16)

  // key_info = "WebPush: info" || 0x00 || ua_public || as_public
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32)
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12)

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const record = Buffer.concat([plaintext, Buffer.from([2])])   // 0x02 = last record
  const body = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()])

  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(4096)
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body])
}

export interface PushResult {
  status: number
  /** The subscription is dead and should be deleted (404 / 410). */
  gone: boolean
}

/**
 * Sends one notification. TTL is how long the push service holds it for an
 * offline device; `urgency` lets a battery-saving device defer it.
 */
export async function sendWebPush(
  subscription: PushSubscription,
  payload: Record<string, unknown>,
  keys: VapidKeys,
  opts: { ttlSeconds?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; fetchImpl?: typeof fetch } = {},
): Promise<PushResult> {
  const body = encryptPayload(subscription, Buffer.from(JSON.stringify(payload)))
  const doFetch = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidAuthorization(keys, subscription.endpoint),
        'content-type': 'application/octet-stream',
        'content-encoding': 'aes128gcm',
        'content-length': String(body.length),
        ttl: String(opts.ttlSeconds ?? 24 * 3600),
        urgency: opts.urgency ?? 'normal',
      },
      body: new Uint8Array(body),
    })
  } catch (err) {
    throw new WebPushError('PUSH_SERVICE_UNREACHABLE', (err as Error).message)
  }
  await res.arrayBuffer().catch(() => undefined)
  const gone = res.status === 404 || res.status === 410
  if (!res.ok && !gone) {
    throw new WebPushError('PUSH_REJECTED', `push service answered ${res.status}`, res.status)
  }
  return { status: res.status, gone }
}

export function vapidFromEnv(env: NodeJS.ProcessEnv = process.env): VapidKeys | null {
  const publicKey = env.PEPL_VAPID_PUBLIC_KEY
  const privateKey = env.PEPL_VAPID_PRIVATE_KEY
  const subject = env.PEPL_VAPID_SUBJECT
  if (!publicKey && !privateKey) return null
  if (!publicKey || !privateKey || !subject) {
    throw new WebPushError('VAPID_MISCONFIGURED',
      'PEPL_VAPID_PUBLIC_KEY, PEPL_VAPID_PRIVATE_KEY and PEPL_VAPID_SUBJECT (mailto:…) must all be set, or none')
  }
  if (!/^(mailto:|https:)/.test(subject)) {
    throw new WebPushError('VAPID_MISCONFIGURED', 'PEPL_VAPID_SUBJECT must be a mailto: or https: URL')
  }
  privateKeyObject(privateKey, publicKey)   // fail at start-up, not at the first push
  return { publicKey, privateKey, subject }
}

