/**
 * Live events across instances. This process is "instance A"; a raw LISTEN
 * client and a raw pg_notify stand in for instance B, so the test proves both
 * directions of the relay without a second Node process.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { appPool, closePools } from '../src/db/pool.ts'
import { config } from '../src/config.ts'
import { publish, subscribe, replay, resetBus, type DeliveredEvent } from '../src/realtime/bus.ts'
import { startRelay, encode, decode, CHANNEL, INSTANCE_ID } from '../src/realtime/relay.ts'

const T1 = '11111111-1111-1111-1111-111111111111'
const T2 = '22222222-2222-2222-2222-222222222222'
let relay: { stop: () => Promise<void> }
let other: pg.Client

const waitFor = async (pred: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeAll(async () => {
  resetBus()
  relay = startRelay(appPool)
  other = new pg.Client({ host: config.host, port: config.port, database: config.db, user: config.appUser, password: config.appPassword })
  await other.connect()
  await other.query(`LISTEN ${CHANNEL}`)
  // give our own listener time to be armed before anything is sent
  await new Promise((r) => setTimeout(r, 300))
})
afterAll(async () => {
  await relay.stop()
  await other.end()
  await closePools()
})

describe('relay across instances', () => {
  it('forwards a local publish through Postgres, tagged with this instance', async () => {
    const got: string[] = []
    other.on('notification', (n) => { if (n.payload) got.push(n.payload) })
    publish(T1, { type: 'chat.message', data: { id: 'm1' } })
    await waitFor(() => got.length === 1)
    const env = JSON.parse(got[0]!)
    expect(env).toMatchObject({ origin: INSTANCE_ID, tenantId: T1, event: { type: 'chat.message', data: { id: 'm1' } } })
    expect(typeof env.event.id).toBe('number')
  })

  it('delivers an event from another instance to local subscribers of that tenant only', async () => {
    const t1: DeliveredEvent[] = []
    const t2: DeliveredEvent[] = []
    const off1 = subscribe(T1, 'u1', (e) => t1.push(e))
    const off2 = subscribe(T2, 'u2', (e) => t2.push(e))
    const foreign: DeliveredEvent = { id: Date.now() + 5_000, at: new Date().toISOString(), type: 'approval.raised', data: { id: 'a1' } }
    await other.query('SELECT pg_notify($1, $2)', [CHANNEL, encode(T1, foreign, 'instance-B')])
    await waitFor(() => t1.length === 1)
    expect(t1[0]).toEqual(foreign)
    expect(t2).toEqual([])
    // and it is replayable here with the id it was given there
    expect(replay(T1, 'u1', foreign.id - 1)).toEqual([foreign])
    // a later local publish gets a higher id than the foreign one, so Last-Event-ID stays meaningful
    publish(T1, { type: 'chat.message', data: { id: 'm2' } })
    expect(t1[1]!.id).toBeGreaterThan(foreign.id)
    off1(); off2()
  })

  it('ignores its own echo and anything malformed', () => {
    const own: DeliveredEvent = { id: 1, at: 'x', type: 't', data: {} }
    expect(decode(encode(T1, own)!)).toBeNull()                       // our own origin
    expect(decode(encode(T1, own, 'B')!, INSTANCE_ID)).not.toBeNull()
    expect(decode('not json')).toBeNull()
    expect(decode(JSON.stringify({ origin: 'B', tenantId: '', event: own }))).toBeNull()
    expect(decode(JSON.stringify({ origin: 'B', tenantId: T1, event: { type: 't' } }))).toBeNull()
    expect(encode(T1, { ...own, data: { blob: 'x'.repeat(9000) } }, 'B')).toBeNull()   // over the pg_notify cap
  })
})
