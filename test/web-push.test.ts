/**
 * Web Push: the browser side of RFC 8291 is re-implemented HERE, independently,
 * so the server's ciphertext is proven decryptable by a real receiver, and the
 * VAPID JWT is verified with the public key the way a push service would.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createDecipheriv, createECDH, createHmac, createPublicKey, createVerify } from 'node:crypto'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import {
  b64url, encryptPayload, generateVapidKeys, sendWebPush, vapidAuthorization, vapidFromEnv,
  type VapidKeys,
} from '../src/comms/web-push.ts'
import { deliverPush, saveSubscription, removeSubscription, listSubscriptions, MAX_PUSH_FAILURES } from '../src/comms/push.ts'
import { notify } from '../src/comms/index.ts'

const VAPID: VapidKeys = { ...generateVapidKeys(), subject: 'mailto:ops@pepl.test' }

/** What a browser holds: its ECDH keypair and a 16-byte auth secret. */
function browser() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = Buffer.from(Array.from({ length: 16 }, (_, i) => i * 7 + 1))
  return {
    keys: { p256dh: b64url.encode(ecdh.getPublicKey()), auth: b64url.encode(auth) },
    /** RFC 8291 §3.4 receiver side, written from the spec, not from the server code. */
    decrypt(body: Buffer): string {
      const salt = body.subarray(0, 16)
      const rs = body.readUInt32BE(16)
      const idlen = body[20]!
      const asPublic = body.subarray(21, 21 + idlen)
      const ciphertext = body.subarray(21 + idlen)
      expect(rs).toBe(4096)
      const shared = ecdh.computeSecret(asPublic)
      const hk = (salt: Buffer, ikm: Buffer, info: string, len: number) => {
        const prk = createHmac('sha256', salt).update(ikm).digest()
        return createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest().subarray(0, len)
      }
      const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic])
      const ikm = createHmac('sha256', createHmac('sha256', auth).update(shared).digest())
        .update(Buffer.concat([info, Buffer.from([1])])).digest()
      const cek = hk(salt, ikm, 'Content-Encoding: aes128gcm\0', 16)
      const nonce = hk(salt, ikm, 'Content-Encoding: nonce\0', 12)
      const d = createDecipheriv('aes-128-gcm', cek, nonce)
      d.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
      const record = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()])
      // strip the delimiter and any padding after it
      let end = record.length - 1
      while (end >= 0 && record[end] === 0) end--
      expect(record[end]).toBe(2)
      return record.subarray(0, end).toString()
    },
  }
}

/** Verifies a `vapid t=…, k=…` header the way a push service does. */
function verifyVapid(header: string, expectedAud: string): Record<string, unknown> {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header)
  expect(m).not.toBeNull()
  const [, jwt, k] = m!
  const [h, c, sig] = jwt!.split('.')
  const pub = b64url.decode(k!)
  const key = createPublicKey({ format: 'jwk', key: {
    kty: 'EC', crv: 'P-256', x: b64url.encode(pub.subarray(1, 33)), y: b64url.encode(pub.subarray(33)),
  } })
  const v = createVerify('SHA256')
  v.update(`${h}.${c}`)
  expect(v.verify({ key, dsaEncoding: 'ieee-p1363' }, b64url.decode(sig!))).toBe(true)
  expect(JSON.parse(b64url.decode(h!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
  const claims = JSON.parse(b64url.decode(c!).toString())
  expect(claims.aud).toBe(expectedAud)
  expect(claims.sub).toBe(VAPID.subject)
  expect(claims.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(24 * 3600)
  return claims
}

// A fake push service: verifies VAPID, records the bodies, answers per path.
let server: Server
let origin: string
const inbox: { path: string; body: Buffer; headers: Record<string, string | string[] | undefined> }[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      try { verifyVapid(String(req.headers.authorization), origin) } catch { res.writeHead(403); res.end(); return }
      inbox.push({ path: req.url!, body, headers: req.headers })
      if (req.url!.startsWith('/gone')) { res.writeHead(410); res.end(); return }
      if (req.url!.startsWith('/flaky')) { res.writeHead(500); res.end(); return }
      res.writeHead(201); res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await closePools()
  await controlPool.end()
})

describe('RFC 8291 encryption', () => {
  it('a browser decrypts what the server encrypted, and every message uses fresh keys', () => {
    const b = browser()
    const sub = { endpoint: `${origin}/ok/1`, keys: b.keys }
    const one = encryptPayload(sub, Buffer.from('{"title":"Leave approved"}'))
    const two = encryptPayload(sub, Buffer.from('{"title":"Leave approved"}'))
    expect(b.decrypt(one)).toBe('{"title":"Leave approved"}')
    expect(b.decrypt(two)).toBe('{"title":"Leave approved"}')
    expect(one.equals(two)).toBe(false)                       // new salt + ephemeral key each time
    expect(one.subarray(21, 86)[0]).toBe(0x04)                // uncompressed point
  })

  it('a different browser cannot decrypt it', () => {
    const a = browser(), b = browser()
    const body = encryptPayload({ endpoint: `${origin}/x`, keys: a.keys }, Buffer.from('secret'))
    expect(() => b.decrypt(body)).toThrow()
  })

  it('refuses malformed subscription keys and oversized payloads', () => {
    const b = browser()
    expect(() => encryptPayload({ endpoint: 'x', keys: { ...b.keys, auth: 'short' } }, Buffer.from('x')))
      .toThrow(/16 bytes/)
    expect(() => encryptPayload({ endpoint: 'x', keys: b.keys }, Buffer.alloc(5000)))
      .toThrow(/4 KB/)
  })
})

describe('VAPID', () => {
  it('signs an ES256 JWT for the endpoint ORIGIN that verifies with the public key', () => {
    const header = vapidAuthorization(VAPID, 'https://fcm.googleapis.com/fcm/send/abc/def?x=1')
    const claims = verifyVapid(header, 'https://fcm.googleapis.com')
    expect(claims.aud).not.toContain('/fcm/send')
  })

  it('env: none is off, half is an error, a bad subject is an error, bad keys are caught at start-up', () => {
    expect(vapidFromEnv({})).toBeNull()
    expect(() => vapidFromEnv({ PEPL_VAPID_PUBLIC_KEY: VAPID.publicKey })).toThrow(/must all be set/)
    expect(() => vapidFromEnv({
      PEPL_VAPID_PUBLIC_KEY: VAPID.publicKey, PEPL_VAPID_PRIVATE_KEY: VAPID.privateKey, PEPL_VAPID_SUBJECT: 'ops@x',
    })).toThrow(/mailto/)
    expect(() => vapidFromEnv({
      PEPL_VAPID_PUBLIC_KEY: 'AAAA', PEPL_VAPID_PRIVATE_KEY: VAPID.privateKey, PEPL_VAPID_SUBJECT: 'mailto:a@b',
    })).toThrow(/65-byte/)
    expect(vapidFromEnv({
      PEPL_VAPID_PUBLIC_KEY: VAPID.publicKey, PEPL_VAPID_PRIVATE_KEY: VAPID.privateKey, PEPL_VAPID_SUBJECT: 'mailto:a@b',
    })).toMatchObject({ subject: 'mailto:a@b' })
  })
})

describe('sending', () => {
  it('POSTs aes128gcm with TTL and urgency; 410 means gone; 5xx is an error', async () => {
    const b = browser()
    inbox.length = 0
    const ok = await sendWebPush({ endpoint: `${origin}/ok/2`, keys: b.keys }, { title: 'Hi' }, VAPID, { urgency: 'high' })
    expect(ok).toEqual({ status: 201, gone: false })
    const got = inbox[0]!
    expect(got.headers['content-encoding']).toBe('aes128gcm')
    expect(got.headers.ttl).toBe('86400')
    expect(got.headers.urgency).toBe('high')
    expect(JSON.parse(b.decrypt(got.body))).toEqual({ title: 'Hi' })

    expect(await sendWebPush({ endpoint: `${origin}/gone/1`, keys: b.keys }, {}, VAPID)).toMatchObject({ gone: true })
    await expect(sendWebPush({ endpoint: `${origin}/flaky/1`, keys: b.keys }, {}, VAPID))
      .rejects.toMatchObject({ code: 'PUSH_REJECTED', status: 500 })
    await expect(sendWebPush({ endpoint: 'http://127.0.0.1:1/', keys: b.keys }, {}, VAPID))
      .rejects.toMatchObject({ code: 'PUSH_SERVICE_UNREACHABLE' })
  })
})

// ---------------------------------------------------------------------------
// Delivery against the database
// ---------------------------------------------------------------------------
let A: Tenant
let B: Tenant
const ALICE = 'e0000000-0000-0000-0000-00000000000e'
const BOB = 'e0000000-0000-0000-0000-00000000000f'

beforeEach(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
  inbox.length = 0
})

async function user(tenantId: string, id: string, email: string): Promise<void> {
  await withTenant(tenantId, (tx) => tx.query(
    `INSERT INTO app_users (tenant_id, id, email, full_name, status) VALUES ($1,$2,$3,$4,'active')
     ON CONFLICT DO NOTHING`, [tenantId, id, email, email]))
}

describe('subscriptions', () => {
  it('validates, upserts by endpoint, lists and removes only the owner\'s', async () => {
    await user(A.id, ALICE, 'alice@a.test')
    await user(A.id, BOB, 'bob@a.test')
    const b = browser()
    await withTenant(A.id, async (tx) => {
      await expect(saveSubscription(tx, { userId: ALICE, endpoint: 'http://insecure/x', ...b.keys }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(saveSubscription(tx, { userId: ALICE, endpoint: 'https://p.test/x', p256dh: 'AA', auth: b.keys.auth }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })

      const first = await saveSubscription(tx, { userId: ALICE, endpoint: 'https://p.test/x', ...b.keys, userAgent: 'UA' })
      const again = await saveSubscription(tx, { userId: ALICE, endpoint: 'https://p.test/x', ...browser().keys })
      expect(again.id).toBe(first.id)                         // same browser, rotated keys
      expect((await listSubscriptions(tx, ALICE))).toHaveLength(1)

      expect(await removeSubscription(tx, BOB, 'https://p.test/x')).toBe(false)   // not Bob's
      expect(await removeSubscription(tx, ALICE, 'https://p.test/x')).toBe(true)
      expect(await listSubscriptions(tx, ALICE)).toHaveLength(0)
    })
  })

  it('is invisible across tenants', async () => {
    await user(A.id, ALICE, 'alice@a.test')
    await withTenant(A.id, (tx) => saveSubscription(tx, { userId: ALICE, endpoint: 'https://p.test/a', ...browser().keys }))
    await withTenant(B.id, async (tx) => {
      const { rows } = await tx.query(`SELECT 1 FROM push_subscriptions`)
      expect(rows).toHaveLength(0)
    })
  })
})

describe('the delivery pass', () => {
  it('pushes unread notifications to every device, marks them, drops dead devices, skips read ones', async () => {
    await user(A.id, ALICE, 'alice@a.test')
    await user(A.id, BOB, 'bob@a.test')
    const phone = browser(), laptop = browser(), dead = browser()
    await withTenant(A.id, async (tx) => {
      await saveSubscription(tx, { userId: ALICE, endpoint: `${origin}/ok/phone`, ...phone.keys })
      await saveSubscription(tx, { userId: ALICE, endpoint: `${origin}/ok/laptop`, ...laptop.keys })
      await saveSubscription(tx, { userId: ALICE, endpoint: `${origin}/gone/old-phone`, ...dead.keys })
      await notify(tx, { userId: ALICE, eventType: 'leave.approved', title: 'Leave approved', body: '2 days' })
      await notify(tx, { userId: ALICE, eventType: 'chat.message', title: 'Already seen' })
      await tx.query(`UPDATE notifications SET read_at = now() WHERE title = 'Already seen'`)
      await notify(tx, { userId: BOB, eventType: 'leave.approved', title: 'Bob has no device' })
    })

    const r = await withTenant(A.id, (tx) => deliverPush(tx, VAPID))
    expect(r).toMatchObject({ notifications: 2, sent: 1, dropped: 1, errors: [] })

    const paths = inbox.map((m) => m.path).sort()
    expect(paths).toEqual(['/gone/old-phone', '/ok/laptop', '/ok/phone'])
    const onPhone = JSON.parse(phone.decrypt(inbox.find((m) => m.path === '/ok/phone')!.body))
    expect(onPhone).toMatchObject({ type: 'leave.approved', title: 'Leave approved', body: '2 days' })

    await withTenant(A.id, async (tx) => {
      const { rows } = await tx.query<{ title: string; pushed: boolean }>(
        `SELECT title, pushed_at IS NOT NULL AS pushed FROM notifications ORDER BY title`)
      expect(rows).toEqual([
        { title: 'Already seen', pushed: false },       // read: never pushed, never queued
        { title: 'Bob has no device', pushed: true },   // nowhere to go: closed out
        { title: 'Leave approved', pushed: true },
      ])
      expect((await listSubscriptions(tx, ALICE)).map((s) => s.endpoint)).toEqual([
        `${origin}/ok/phone`, `${origin}/ok/laptop`,
      ])
    })

    // second pass: nothing left
    inbox.length = 0
    expect(await withTenant(A.id, (tx) => deliverPush(tx, VAPID))).toMatchObject({ notifications: 0 })
    expect(inbox).toHaveLength(0)
  })

  it('a device that keeps failing is dropped after the limit, and a failing device does not block others', async () => {
    await user(A.id, ALICE, 'alice@a.test')
    const flaky = browser(), fine = browser()
    await withTenant(A.id, async (tx) => {
      await saveSubscription(tx, { userId: ALICE, endpoint: `${origin}/flaky/1`, ...flaky.keys })
      await saveSubscription(tx, { userId: ALICE, endpoint: `${origin}/ok/fine`, ...fine.keys })
    })
    for (let i = 0; i < MAX_PUSH_FAILURES; i++) {
      await withTenant(A.id, (tx) => notify(tx, { userId: ALICE, eventType: 'x', title: `n${i}`, dedupeKey: `n${i}` }))
      const r = await withTenant(A.id, (tx) => deliverPush(tx, VAPID))
      expect(r.sent).toBe(1)
      expect(r.errors).toHaveLength(1)
    }
    await withTenant(A.id, async (tx) => {
      expect((await listSubscriptions(tx, ALICE)).map((s) => s.endpoint)).toEqual([`${origin}/ok/fine`])
    })
  })
})
