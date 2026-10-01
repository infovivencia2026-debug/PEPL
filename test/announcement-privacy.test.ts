/**
 * An announcement to five people is not readable by five hundred.
 *
 * Announcements are delivered as a message in ONE company-wide conversation that every active
 * user belongs to. A targeted announcement -- a performance-improvement notice, a layoff list --
 * wrote its whole text into that shared channel with nothing recording who it was for, so it was
 * readable by every participant through the message list, through the preview line on the
 * conversation list, and through the unread badge. Reported by an audit; each reader is checked
 * here, not just the one the report named.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { postAnnouncement, ensureAnnouncementChannel } from '../src/comms/announcements.ts'
import { listMessages, listConversations, unreadInConversation } from '../src/comms/chat.ts'

let A: Tenant
let author: string, target1: string, target2: string, bystander: string
let channel: string

const SECRET = 'You are placed on a performance improvement plan effective Monday'

const mk = (name: string) => withTenant(A.id, (tx) => createUser(tx, {
  tenantId: A.id, email: `${name}@announce.test`, fullName: name, password: 'a-long-test-passphrase', roles: ['employee'],
}))
const messagesFor = (userId: string) => withTenant(A.id, (tx) => listMessages(tx, { conversationId: channel, userId }))
const bodies = async (userId: string) => (await messagesFor(userId)).messages.map((m) => m.body ?? '')

beforeAll(async () => {
  ;({ a: A } = await resetAndSeed())
  await controlPool.query(
    `INSERT INTO tenant_entitlements(tenant_id,plan_code,features,limits) VALUES($1,'test','{"chat":true}','{"employees":100}')
     ON CONFLICT (tenant_id) DO UPDATE SET features = EXCLUDED.features, limits = EXCLUDED.limits`, [A.id])
  author = await mk('author'); target1 = await mk('target1'); target2 = await mk('target2'); bystander = await mk('bystander')
  channel = await withTenant(A.id, (tx) => ensureAnnouncementChannel(tx, author))
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('a targeted announcement', () => {
  beforeAll(async () => {
    await withTenant(A.id, (tx) => postAnnouncement(tx, {
      authorUserId: author, title: 'Performance plan', bodyHtml: `<p>${SECRET}</p>`, audienceUserIds: [target1, target2],
    }))
  })

  it('is in the message list of those it was sent to, and of its author', async () => {
    for (const who of [target1, target2, author]) {
      expect((await bodies(who)).join('\n'), who).toContain(SECRET)
    }
  })

  it('is NOT in the message list of anyone else in the company', async () => {
    const seen = (await bodies(bystander)).join('\n')
    expect(seen).not.toContain(SECRET)
    expect(seen).not.toContain('Performance plan')
  })

  it('does not leak through the preview line on the conversation list', async () => {
    const list = await withTenant(A.id, (tx) => listConversations(tx, bystander))
    const previews = list.map((c) => c.last_message_body ?? '').join('\n')
    expect(previews).not.toContain(SECRET)
    // ...while the people it was for still see it as the latest line.
    const forTarget = await withTenant(A.id, (tx) => listConversations(tx, target1))
    expect(forTarget.map((c) => c.last_message_body ?? '').join('\n')).toContain(SECRET)
  })

  it('does not raise an unread badge for someone who cannot read it', async () => {
    expect(await withTenant(A.id, (tx) => unreadInConversation(tx, channel, bystander))).toBe(0)
    expect(await withTenant(A.id, (tx) => unreadInConversation(tx, channel, target1))).toBe(1)
    const summary = await withTenant(A.id, (tx) => listConversations(tx, bystander))
    expect(summary.find((c) => c.id === channel)?.unread ?? 0).toBe(0)
  })
})

describe('a company-wide announcement', () => {
  it('is still visible to everyone, including someone who joined after it was posted', async () => {
    await withTenant(A.id, (tx) => postAnnouncement(tx, {
      authorUserId: author, title: 'Holiday', bodyHtml: '<p>The office is closed on Friday</p>',
    }))
    const late = await mk('latecomer')                                       // no receipt: they did not exist yet
    await withTenant(A.id, (tx) => ensureAnnouncementChannel(tx, author))    // tops membership up
    for (const who of [target1, bystander, late]) {
      expect((await bodies(who)).join('\n'), who).toContain('The office is closed on Friday')
    }
  })
})
