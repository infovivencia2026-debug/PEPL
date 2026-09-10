import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { notify } from '../src/comms/index.ts'
import {
  deliverEmails, pendingEmails, renderNotificationEmail, MAX_EMAIL_ATTEMPTS,
} from '../src/comms/delivery.ts'
import { ensureAccount, folderByRole, listEnvelopes } from '../src/mail/index.ts'

let A: Tenant
let B: Tenant

const HR = 'd0000000-0000-0000-0000-00000000000d'
const ALICE = 'e0000000-0000-0000-0000-00000000000e'

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

/** A recipient with a mailbox, and a nominated sender with one too. */
async function setUpSender(tenantId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO app_users (tenant_id, id, email, full_name, password_hash)
       VALUES ($1,$2,'alice@acme.test','Alice Recipient','x'),
              ($1,$3,'hr@acme.test','HR Desk','x')
       ON CONFLICT (tenant_id, email) DO NOTHING`,
      [tenantId, ALICE, HR])
    await ensureAccount(tx, { userId: HR, email: 'hr@acme.test', displayName: 'HR Desk' })
    await ensureAccount(tx, { userId: ALICE, email: 'alice@acme.test', displayName: 'Alice' })
  })
}

const queue = (tenantId: string, title: string, channels = ['in_app', 'email']) =>
  withTenant(tenantId, (tx) =>
    notify(tx, {
      userId: ALICE, eventType: 'leave.approved', title,
      body: 'Your leave for 12 October was approved.',
      channels, dedupeKey: title,
    }))

const deliver = (tenantId: string, senderEmail: string | null = 'hr@acme.test') =>
  withTenant(tenantId, (tx) =>
    deliverEmails(tx, { senderEmail, companyName: 'Acme Ltd' }))

describe('what the email says', () => {
  it('states the company, the headline and why it arrived', () => {
    const { subject, bodyHtml } = renderNotificationEmail({
      id: '1', user_id: ALICE, event_type: 'leave.approved',
      title: 'Leave approved', body: 'Your leave for 12 October was approved.',
      entity_type: 'leave', entity_id: null, created_at: '2026-10-01',
      recipient_email: 'alice@acme.test', recipient_name: 'Alice',
    }, 'Acme Ltd')

    expect(subject).toBe('Leave approved')
    expect(bodyHtml).toContain('Acme Ltd')
    expect(bodyHtml).toContain('Your leave for 12 October was approved.')
    expect(bodyHtml).toContain('leave approved')
    expect(bodyHtml).toContain('notification settings')
  })

  it('escapes anything a user typed', () => {
    const { bodyHtml } = renderNotificationEmail({
      id: '1', user_id: ALICE, event_type: 'ticket.replied',
      title: '<script>alert(1)</script>', body: 'a & b',
      entity_type: null, entity_id: null, created_at: '2026-10-01',
      recipient_email: 'alice@acme.test', recipient_name: 'Alice',
    }, 'Acme & Co')

    expect(bodyHtml).not.toContain('<script>')
    expect(bodyHtml).toContain('&lt;script&gt;')
    expect(bodyHtml).toContain('a &amp; b')
    expect(bodyHtml).toContain('Acme &amp; Co')
  })
})

describe('which notifications are due an email', () => {
  it('takes only the ones asking for email', async () => {
    await setUpSender(A.id)
    await queue(A.id, 'Emailed one')
    await queue(A.id, 'In-app only', ['in_app'])

    const pending = await withTenant(A.id, (tx) => pendingEmails(tx))
    expect(pending.map((p) => p.title)).toEqual(['Emailed one'])
    expect(pending[0]!.recipient_email).toBe('alice@acme.test')
  })

  it('skips one the person has already read in the app', async () => {
    await setUpSender(A.id)
    await queue(A.id, 'Already seen')
    await withTenant(A.id, (tx) =>
      tx.query(`UPDATE notifications SET read_at = now()`))

    expect(await withTenant(A.id, (tx) => pendingEmails(tx))).toHaveLength(0)
  })

  it('gives up on one that has failed too often', async () => {
    await setUpSender(A.id)
    await queue(A.id, 'Cursed')
    await withTenant(A.id, (tx) =>
      tx.query(`UPDATE notifications SET email_attempts = $1`, [MAX_EMAIL_ATTEMPTS]))

    expect(await withTenant(A.id, (tx) => pendingEmails(tx))).toHaveLength(0)
  })
})

describe('delivery', () => {
  it('sends the message and records that it went', async () => {
    await setUpSender(A.id)
    await queue(A.id, 'Leave approved')

    const result = await deliver(A.id)
    expect(result).toMatchObject({ sent: 1, failed: 0 })

    const inbox = await withTenant(A.id, async (tx) => {
      const account = await ensureAccount(tx, {
        userId: ALICE, email: 'alice@acme.test', displayName: 'Alice',
      })
      return listEnvelopes(tx, { folderId: await folderByRole(tx, account.id, 'inbox') })
    })
    expect(inbox.envelopes[0]!.subject).toBe('Leave approved')
    expect(inbox.envelopes[0]!.from_address).toBe('hr@acme.test')

    const rows = await withTenant(A.id, async (tx) => {
      const r = await tx.query(`SELECT emailed_at, email_error FROM notifications`)
      return r.rows as { emailed_at: string | null; email_error: string | null }[]
    })
    expect(rows[0]!.emailed_at).not.toBeNull()
  })

  it('emails a notification once, however often the job runs', async () => {
    await setUpSender(A.id)
    await queue(A.id, 'Only once')

    await deliver(A.id)
    const second = await deliver(A.id)

    expect(second.sent).toBe(0)
    const inbox = await withTenant(A.id, async (tx) => {
      const account = await ensureAccount(tx, {
        userId: ALICE, email: 'alice@acme.test', displayName: 'Alice',
      })
      return listEnvelopes(tx, { folderId: await folderByRole(tx, account.id, 'inbox') })
    })
    expect(inbox.envelopes).toHaveLength(1)
  })

  it('does nothing, and says why, when no sender is nominated', async () => {
    await setUpSender(A.id)
    await queue(A.id, 'Nowhere to send from')

    const result = await deliver(A.id, null)
    expect(result.sent).toBe(0)
    expect(result.skipped[0]).toContain('no sender mailbox is nominated')

    const pending = await withTenant(A.id, (tx) => pendingEmails(tx))
    expect(pending).toHaveLength(1) // still queued, not consumed
  })

  it('says so when the nominated address has no mailbox', async () => {
    await setUpSender(A.id)
    await queue(A.id, 'Bad sender')

    const result = await deliver(A.id, 'nobody@acme.test')
    expect(result.skipped[0]).toContain('no mailbox is connected for nobody@acme.test')
  })

  it('stays inside the company', async () => {
    await setUpSender(A.id)
    await setUpSender(B.id)
    await queue(A.id, 'Company A only')

    const inB = await deliver(B.id)
    expect(inB.sent).toBe(0)
    expect(await withTenant(A.id, (tx) => pendingEmails(tx))).toHaveLength(1)
  })
})
