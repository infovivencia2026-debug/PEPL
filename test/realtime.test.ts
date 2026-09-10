import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'
import { closePools } from '../src/db/pool.ts'
import { controlDb, provisionTenant } from '../src/control-plane/index.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { createUser } from '../src/auth/index.ts'
import { setSetting } from '../src/config/write.ts'
import {
  connectionCount, publish, replay, resetBus, subscribe, type DeliveredEvent,
} from '../src/realtime/bus.ts'
import { handleEvents } from '../src/realtime/sse.ts'

const A = 'aaaaaaaa-0000-0000-0000-00000000aaaa'
const B = 'bbbbbbbb-0000-0000-0000-00000000bbbb'
const ALICE = 'e0000000-0000-0000-0000-00000000000e'
const BOB = 'f0000000-0000-0000-0000-00000000000f'

beforeEach(() => resetBus())

describe('the bus never crosses a tenant', () => {
  it('delivers to subscribers of that tenant only', () => {
    const seen: DeliveredEvent[] = []
    const other: DeliveredEvent[] = []
    subscribe(A, ALICE, (e) => seen.push(e))
    subscribe(B, ALICE, (e) => other.push(e))

    publish(A, { type: 'chat.message', data: { conversationId: 'c1' } })

    expect(seen).toHaveLength(1)
    expect(other).toHaveLength(0)
  })

  it('refuses to publish without a tenant', () => {
    expect(() => publish('', { type: 'x', data: {} })).toThrow(/tenantId is required/)
  })
})

describe('an event addressed to some people reaches only them', () => {
  it('skips a subscriber who is not in userIds', () => {
    const alice: DeliveredEvent[] = []
    const bob: DeliveredEvent[] = []
    subscribe(A, ALICE, (e) => alice.push(e))
    subscribe(A, BOB, (e) => bob.push(e))

    publish(A, { type: 'chat.message', userIds: [BOB], data: { conversationId: 'c1' } })

    expect(alice).toHaveLength(0)
    expect(bob).toHaveLength(1)
  })

  it('reaches everyone in the tenant when userIds is omitted', () => {
    let count = 0
    subscribe(A, ALICE, () => count++)
    subscribe(A, BOB, () => count++)
    expect(publish(A, { type: 'config.changed', data: {} })).toBe(2)
    expect(count).toBe(2)
  })
})

describe('a dropped connection can catch up', () => {
  it('replays what this user missed, and nothing else', () => {
    publish(A, { type: 'a', data: {} })                       // id 1, everyone
    publish(A, { type: 'b', userIds: [BOB], data: {} })        // id 2, Bob only
    publish(A, { type: 'c', data: {} })                       // id 3, everyone

    expect(replay(A, ALICE, 0).map((e) => e.type)).toEqual(['a', 'c'])
    expect(replay(A, BOB, 0).map((e) => e.type)).toEqual(['a', 'b', 'c'])
    expect(replay(A, ALICE, 1).map((e) => e.type)).toEqual(['c'])
    expect(replay(A, ALICE, 99)).toEqual([])
  })

  it('keeps ids monotonic across tenants so a client can trust them', () => {
    publish(A, { type: 'a', data: {} })
    publish(B, { type: 'b', data: {} })
    publish(A, { type: 'c', data: {} })
    expect(replay(A, ALICE, 0).map((e) => e.id)).toEqual([1, 3])
  })

  it('caps its memory rather than growing forever', () => {
    for (let i = 0; i < 250; i++) publish(A, { type: 'x', data: { i } })
    const kept = replay(A, ALICE, 0)
    expect(kept).toHaveLength(200)
    expect(kept[0]!.data.i).toBe(50)
  })
})

describe('one broken connection does not stop the others', () => {
  it('keeps delivering after a listener throws', () => {
    const good: DeliveredEvent[] = []
    subscribe(A, ALICE, () => { throw new Error('socket already closed') })
    subscribe(A, BOB, (e) => good.push(e))
    expect(publish(A, { type: 'x', data: {} })).toBe(1)
    expect(good).toHaveLength(1)
  })

  it('forgets a subscriber that unsubscribes', () => {
    const off = subscribe(A, ALICE, () => {})
    expect(connectionCount(A)).toBe(1)
    off()
    expect(connectionCount(A)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The stream, over real HTTP
// ---------------------------------------------------------------------------

let server: Server
let base: string
let tenantId: string
let token: string
let adminUserId: string
let adminEmail: string
let bobEmail: string
let carolEmail: string

beforeAll(async () => {
  // Emails are unique GLOBALLY in the login lookup, so a reused address would
  // resolve to a tenant left over from an earlier run.
  const stamp = Date.now()
  adminEmail = `rt-admin-${stamp}@example.test`
  bobEmail = `rt-bob-${stamp}@example.test`
  carolEmail = `rt-carol-${stamp}@example.test`

  // No global DELETE here. This suite once cleared control_plane.subscriptions,
  // which is shared state every other suite's tenants sit in — a side effect
  // that belongs to no test and makes failures depend on file order.
  const provisioned = await provisionTenant({
    legalName: `Realtime Test ${stamp}`, displayName: 'Realtime', planCode: 'growth',
    adminEmail, adminName: 'RT Admin',
  })
  tenantId = provisioned.tenantId

  // Assert the precondition rather than discovering it three statements later
  // as a foreign-key violation that names neither the tenant nor the cause.
  const { rows: exists } = await controlDb.query<{ n: string }>(
    `SELECT count(*) AS n FROM tenants WHERE id = $1`, [tenantId])
  if (exists[0]?.n !== '1') {
    throw new Error(
      `provisioned tenant ${tenantId} is not in the database — another suite truncated ` +
      'tenants while this one was setting up',
    )
  }

  // The provisioner creates the tenant, not a password; the test owns its login.
  adminUserId = await withTenant(tenantId, (tx) =>
    createUser(tx, {
      tenantId, email: adminEmail, fullName: 'RT Admin',
      password: 'realtime-pass-2026', roles: ['org_admin'],
    }))

  // The plan decides what exists at all; a tenant setting can never widen it.
  await controlDb.query(
    `UPDATE tenant_entitlements SET features = features || '{"chat":true}'::jsonb
      WHERE tenant_id = $1`, [tenantId])

  await withTenant(tenantId, async (tx) => {
    await setSetting(tx, {
      key: 'chat.enabled', value: true,
      actorUserId: adminUserId, reason: 'test',
    })
  })

  const handler = createHandler(buildRouter())
  server = createServer(async (req, res) => {
    if (req.url?.split('?')[0] === '/api/v1/events') return handleEvents(req, res)
    return handler(req, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  base = `http://127.0.0.1:${port}`

  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: 'realtime-pass-2026' }),
  })
  const loginBody = (await login.json()) as { token?: string; error?: unknown }
  if (!loginBody.token) throw new Error('login failed: ' + JSON.stringify(loginBody))
  token = loginBody.token
})

afterAll(async () => {
  server?.close()
  await closePools()
  await controlDb.end()
})

/** Reads frames off the stream until `count` events arrive or it times out. */
async function readEvents(
  response: Response,
  count: number,
  timeoutMs = 4000,
): Promise<{ event: string; data: Record<string, unknown>; id: string }[]> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const events: { event: string; data: Record<string, unknown>; id: string }[] = []
  let buffer = ''
  const deadline = Date.now() + timeoutMs

  while (events.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let split: number
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      const id = /^id: (.*)$/m.exec(block)?.[1] ?? ''
      const event = /^event: (.*)$/m.exec(block)?.[1]
      const data = /^data: (.*)$/m.exec(block)?.[1]
      if (event && data) events.push({ event, data: JSON.parse(data), id })
    }
  }
  await reader.cancel()
  return events
}

describe('GET /api/v1/events', () => {
  it('refuses a connection with no session', async () => {
    const r = await fetch(`${base}/api/v1/events`)
    expect(r.status).toBe(401)
    expect((await r.json() as { error: { code: string } }).error.code).toBe('MISSING_TOKEN')
  })

  it('refuses a session that is not valid', async () => {
    const r = await fetch(`${base}/api/v1/events`, {
      headers: { authorization: 'Bearer not-a-real-token' },
    })
    expect(r.status).toBe(401)
    await r.json()
  })

  it('opens an event stream and tells the client how to reconnect', async () => {
    const r = await fetch(`${base}/api/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/event-stream')
    // nginx buffers by default, which for a live stream looks like a hang
    expect(r.headers.get('x-accel-buffering')).toBe('no')

    const reader = r.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('retry: ')
    await reader.cancel()
  })

  it('delivers an event published while the client is connected', async () => {
    const r = await fetch(`${base}/api/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
    })
    // Give the handler a moment to register the subscriber before publishing.
    await new Promise((resolve) => setTimeout(resolve, 150))
    publish(tenantId, { type: 'chat.message', data: { conversationId: 'live-1' } })

    const [event] = await readEvents(r, 1)
    expect(event!.event).toBe('chat.message')
    expect(event!.data.conversationId).toBe('live-1')
    expect(Number(event!.id)).toBeGreaterThan(0)
  })

  it('replays what was missed when the client reconnects with Last-Event-ID', async () => {
    resetBus()
    publish(tenantId, { type: 'chat.message', data: { conversationId: 'missed-1' } })
    publish(tenantId, { type: 'chat.message', data: { conversationId: 'missed-2' } })

    const r = await fetch(`${base}/api/v1/events`, {
      headers: { authorization: `Bearer ${token}`, 'last-event-id': '1' },
    })
    const events = await readEvents(r, 1)
    expect(events.map((e) => e.data.conversationId)).toEqual(['missed-2'])
  })

  it('drops the subscriber when the client goes away', async () => {
    const before = connectionCount(tenantId)
    const controller = new AbortController()
    const r = await fetch(`${base}/api/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(connectionCount(tenantId)).toBe(before + 1)

    controller.abort()
    await r.body?.cancel().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(connectionCount(tenantId)).toBe(before)
  })
})

describe('events describe things that actually happened', () => {
  it('a chat message reaches the other member, after the commit', async () => {
    const otherUserId = await withTenant(tenantId, (tx) =>
      createUser(tx, {
        tenantId, email: bobEmail, fullName: 'RT Bob',
        password: 'realtime-pass-2026', roles: ['employee'],
      }))

    const stream = await fetch(`${base}/api/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
    })
    await new Promise((resolve) => setTimeout(resolve, 150))

    const created = await fetch(`${base}/api/v1/chat/conversations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'dm', participantUserIds: [otherUserId] }),
    })
    const { id } = (await created.json()) as { id: string }

    await fetch(`${base}/api/v1/chat/conversations/${id}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clientMessageId: 'rt-1', body: 'live from the API' }),
    })

    const events = await readEvents(stream, 2)
    expect(events.map((e) => e.event)).toEqual(['chat.conversation', 'chat.message'])
    expect(events[1]!.data.conversationId).toBe(id)
  })

  it('a retried send publishes once, like it logs once', async () => {
    const otherUserId = await withTenant(tenantId, (tx) =>
      createUser(tx, {
        tenantId, email: carolEmail, fullName: 'RT Carol',
        password: 'realtime-pass-2026', roles: ['employee'],
      }))
    const created = await fetch(`${base}/api/v1/chat/conversations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'dm', participantUserIds: [otherUserId] }),
    })
    const { id } = (await created.json()) as { id: string }

    resetBus()
    const send = () => fetch(`${base}/api/v1/chat/conversations/${id}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clientMessageId: 'rt-idem', body: 'only once' }),
    })
    await send()
    await send()

    expect(replay(tenantId, adminUserId, 0).filter((e) => e.type === 'chat.message')).toHaveLength(1)
  })
})
