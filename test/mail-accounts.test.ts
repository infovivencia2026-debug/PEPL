/**
 * One person, several mailboxes: a default that opens first, internal aliases
 * with one owner per address, external accounts provisioned with folders, a
 * switcher that lists them, and — the part that matters — an accountId that is
 * not yours is a 404, never a peek into someone else's mail.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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
  ensureAccount, listAccounts, accountForUser, addInternalAddress, setDefaultAccount, removeAccount,
  sendMail, folderByRole, listEnvelopes, listFolders,
} from '../src/mail/index.ts'
import { connectMailbox, encryptSecret, decryptSecret } from '../src/comms/index.ts'

const MASTER = 'test-master-key-for-mailboxes'
let server: Server
let base: string
let tenantId: string
let priyaId: string
let rahulId: string
let priyaToken: string
let rahulToken: string
let stamp: string

const api = async (token: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, body: r.status === 204 ? null : await r.json() as Record<string, unknown> }
}

beforeAll(async () => {
  stamp = String(Date.now())
  const p = await provisionTenant({ legalName: `Mailboxes ${stamp}`, displayName: 'Mailboxes', planCode: 'growth',
    adminEmail: `mb-admin-${stamp}@example.test`, adminName: 'Admin' })
  tenantId = p.tenantId
  const { rows } = await controlDb.query<{ n: string }>(`SELECT count(*) AS n FROM tenants WHERE id = $1`, [tenantId])
  if (rows[0]?.n !== '1') throw new Error('provisioned tenant missing — another suite truncated tenants')
  await controlDb.query(`UPDATE tenant_entitlements SET features = features || '{"mail":true}'::jsonb WHERE tenant_id = $1`, [tenantId])
  await withTenant(tenantId, async (tx) => {
    priyaId = await createUser(tx, { tenantId, email: `priya-${stamp}@acme.test`, fullName: 'Priya', password: 'a-long-password-1', roles: ['org_admin'] })
    rahulId = await createUser(tx, { tenantId, email: `rahul-${stamp}@acme.test`, fullName: 'Rahul', password: 'a-long-password-1', roles: ['employee'] })
    await setSetting(tx, { key: 'mail.enabled', value: true, actorUserId: priyaId, reason: 'test' })
  })
  server = createServer(createHandler(buildRouter()))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const login = async (email: string) => {
    const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-long-password-1' }) })
    return ((await r.json()) as { token: string }).token
  }
  priyaToken = await login(`priya-${stamp}@acme.test`)
  rahulToken = await login(`rahul-${stamp}@acme.test`)
})
afterAll(async () => { server?.close(); await closePools(); await controlDb.end() })

describe('several mailboxes per person', () => {
  it('the first mailbox is the default; an alias joins it; the default can move', async () => {
    await withTenant(tenantId, async (tx) => {
      const first = await ensureAccount(tx, { userId: priyaId, email: `priya-${stamp}@acme.test` })
      expect(first.is_default).toBe(true)
      const hr = await addInternalAddress(tx, { userId: priyaId, email: `HR-${stamp}@Acme.test`, label: 'HR desk' })
      expect(hr).toMatchObject({ email: `hr-${stamp}@acme.test`, label: 'HR desk', is_default: false, provider: 'internal' })
      expect((await listFolders(tx, hr.id)).map((f) => f.role)).toEqual(['inbox', 'drafts', 'sent', 'archive', 'trash'])

      // one owner per address across the company
      await expect(addInternalAddress(tx, { userId: rahulId, email: `hr-${stamp}@acme.test` })).rejects.toMatchObject({ code: 'EMAIL_TAKEN' })

      expect((await listAccounts(tx, priyaId)).map((a) => a.id)).toEqual([first.id, hr.id])
      expect((await accountForUser(tx, priyaId))!.id).toBe(first.id)
      await setDefaultAccount(tx, priyaId, hr.id)
      expect((await accountForUser(tx, priyaId))!.id).toBe(hr.id)
      expect((await listAccounts(tx, priyaId)).map((a) => [a.id, a.is_default])).toEqual([[hr.id, true], [first.id, false]])

      // Rahul cannot resolve Priya's mailbox by id
      expect(await accountForUser(tx, rahulId, hr.id)).toBeNull()
      await expect(setDefaultAccount(tx, rahulId, hr.id)).rejects.toMatchObject({ code: 'MAILBOX_NOT_FOUND' })
    })
  })

  it('mail to the alias lands in the alias mailbox, not the person\'s main one', async () => {
    await withTenant(tenantId, async (tx) => {
      const rahul = await ensureAccount(tx, { userId: rahulId, email: `rahul-${stamp}@acme.test` })
      await sendMail(tx, { account: rahul, userId: rahulId, idempotencyKey: 'to-hr', allowExternal: false,
        draft: { to: [`hr-${stamp}@acme.test`], subject: 'Leave query', bodyHtml: '<p>?</p>' } })
      const all = await listAccounts(tx, priyaId)
      const hr = all.find((a) => a.email.startsWith('hr-'))
      const main = all.find((a) => a.email.startsWith('priya-'))
      const hrInbox = await listEnvelopes(tx, { folderId: await folderByRole(tx, hr!.id, 'inbox') })
      const mainInbox = await listEnvelopes(tx, { folderId: await folderByRole(tx, main!.id, 'inbox') })
      expect(hrInbox.envelopes.map((e) => e.subject)).toEqual(['Leave query'])
      expect(mainInbox.envelopes).toEqual([])
    })
  })

  it('an external account is stored encrypted, with folders, and becomes the default only when it is the first', async () => {
    await withTenant(tenantId, async (tx) => {
      const id = await connectMailbox(tx, { userId: priyaId, email: `priya.ext-${stamp}@gmail.test`, username: 'priya', password: 'hunter2',
        imapHost: 'imap.gmail.test', smtpHost: 'smtp.gmail.test', smtpPort: 465, smtpSecure: true, master: MASTER, label: 'Personal' })
      const acct = (await accountForUser(tx, priyaId, id))!
      expect(acct).toMatchObject({ label: 'Personal', is_default: false, imap_host: 'imap.gmail.test', provider: 'imap_generic' })
      expect((await listFolders(tx, id)).map((f) => f.role)).toContain('sent')
      const row = (await tx.query<{ secret_ciphertext: Buffer; smtp_port: number; smtp_secure: boolean }>(
        `SELECT secret_ciphertext, smtp_port, smtp_secure FROM mail_accounts WHERE id = $1`, [id])).rows[0]!
      expect(row.smtp_port).toBe(465)
      expect(row.smtp_secure).toBe(true)
      expect(decryptSecret(row.secret_ciphertext, tenantId, MASTER)).toBe('hunter2')
      const ct = encryptSecret('x', tenantId, MASTER)
      expect(ct.length).toBeGreaterThan(16)                        // nonce + tag + body: never the plaintext
      expect(ct.equals(Buffer.from('x'))).toBe(false)
      await expect(connectMailbox(tx, { userId: rahulId, email: `priya.ext-${stamp}@gmail.test`, username: 'r', password: 'p',
        imapHost: 'i', smtpHost: 's', master: MASTER })).rejects.toMatchObject({ code: 'EMAIL_TAKEN' })
    })
  })

  it('removing destroys the credential, keeps the mail, re-elects a default, and refuses the last one', async () => {
    await withTenant(tenantId, async (tx) => {
      const before = await listAccounts(tx, priyaId)
      expect(before).toHaveLength(3)
      const current = before.find((a) => a.is_default)!
      await removeAccount(tx, priyaId, current.id)
      const after = await listAccounts(tx, priyaId)
      expect(after).toHaveLength(2)
      expect(after.filter((a) => a.is_default)).toHaveLength(1)
      const gone = (await tx.query<{ status: string; secret_ciphertext: Buffer | null; n: string }>(
        `SELECT a.status, a.secret_ciphertext, (SELECT count(*)::text FROM mail_envelopes e WHERE e.account_id = a.id) AS n
           FROM mail_accounts a WHERE a.id = $1`, [current.id])).rows[0]!
      expect(gone.status).toBe('removed')
      expect(gone.secret_ciphertext).toBeNull()
      expect(Number(gone.n)).toBeGreaterThanOrEqual(1)          // the HR desk's mail is retained
      await expect(removeAccount(tx, rahulId, after[0]!.id)).rejects.toMatchObject({ code: 'MAILBOX_NOT_FOUND' })
      const rahulOnly = await listAccounts(tx, rahulId)
      await expect(removeAccount(tx, rahulId, rahulOnly[0]!.id)).rejects.toMatchObject({ code: 'LAST_MAILBOX' })
    })
  })

  it('over HTTP: the switcher lists mine, ?accountId= scopes every mail route, and another person\'s id is a 404', async () => {
    const mine = await api(priyaToken, 'GET', '/mail/accounts')
    expect(mine.status).toBe(200)
    const accounts = (mine.body!.accounts as { id: string; is_default: boolean }[])
    expect(accounts).toHaveLength(2)
    const nonDefault = accounts.find((a) => !a.is_default)!

    const scoped = await api(priyaToken, 'GET', `/mail/folders?accountId=${nonDefault.id}`)
    expect(scoped.status).toBe(200)
    expect((scoped.body!.account as { id: string }).id).toBe(nonDefault.id)
    const unscoped = await api(priyaToken, 'GET', '/mail/folders')
    expect((unscoped.body!.account as { id: string }).id).toBe(accounts.find((a) => a.is_default)!.id)

    expect((await api(rahulToken, 'GET', `/mail/folders?accountId=${nonDefault.id}`)).status).toBe(404)
    expect((await api(rahulToken, 'PATCH', `/mail/accounts/${nonDefault.id}`, { label: 'mine now' })).status).toBe(404)
    expect((await api(rahulToken, 'DELETE', `/mail/accounts/${nonDefault.id}`)).status).toBe(404)

    // adding an alias over HTTP, then a send from it names it as the sender
    const added = await api(priyaToken, 'POST', '/mail/accounts', { email: `payroll-${stamp}@acme.test`, label: 'Payroll' })
    expect(added.status).toBe(201)
    const payroll = added.body as { id: string; email: string }
    const sent = await api(priyaToken, 'POST', '/mail/messages', {
      accountId: payroll.id, to: [`rahul-${stamp}@acme.test`], subject: 'Payslip', bodyHtml: '<p>attached</p>', idempotencyKey: `ps-${stamp}` })
    expect(sent.status).toBe(201)
    const rahulInbox = await api(rahulToken, 'GET', '/mail/messages')
    const envs = rahulInbox.body!.envelopes as { subject: string; from_address: string }[]
    expect(envs.find((e) => e.subject === 'Payslip')!.from_address).toBe(`payroll-${stamp}@acme.test`)

    // external without a server key is refused honestly
    const saved = process.env.PEPL_MAIL_KEY
    delete process.env.PEPL_MAIL_KEY
    try {
      const ext = await api(priyaToken, 'POST', '/mail/accounts', { email: `x-${stamp}@ext.test`, imapHost: 'i', smtpHost: 's', username: 'u', password: 'p' })
      expect(ext.status).toBe(503)
    } finally { if (saved !== undefined) process.env.PEPL_MAIL_KEY = saved }
    expect((await api(priyaToken, 'POST', '/mail/accounts', { email: `y-${stamp}@ext.test`, imapHost: 'i' })).status).toBe(422)
  })
})
