/**
 * Four ways the mailbox feature could be turned against the company.
 *
 *  COM-02  Any employee could claim an unowned company address (payroll@..., a colleague's) as an
 *          "internal alias" -- and if that address was then set as the system sender, payslips and
 *          notifications went out through the squatter's mailbox. Nothing in the database stopped
 *          two live mailboxes sharing an address either.
 *  COM-04  An employee could point IMAP/SMTP at ANY host and port: loopback, the other applications
 *          on the box, the cloud metadata address. The server's own reply text was then stored in
 *          `last_error` and shown back, which turns a connection attempt into a port scanner.
 *  COM-05  After STARTTLS the client decided "is this encrypted?" from the capability list that
 *          came AFTER the upgrade. RFC 3207 says a server must not advertise STARTTLS once TLS is
 *          on, so a correctly upgraded connection looked unencrypted and authentication was refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { addInternalAddress } from '../src/mail/accounts.ts'
import { assertMailEndpoint, publicMailError, smtpMayAuthenticate } from '../src/mail/hosts.ts'

let A: Tenant
let me: string
beforeAll(async () => {
  ;({ a: A } = await resetAndSeed())
  me = await withTenant(A.id, (tx) => createUser(tx, {
    tenantId: A.id, email: 'priya@acme.test', fullName: 'Priya', password: 'a-long-test-passphrase', roles: ['employee'],
  }))
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('who may claim an address', () => {
  const add = (email: string, allowAnyAddress: boolean) =>
    withTenant(A.id, (tx) => addInternalAddress(tx, { userId: me, email, allowAnyAddress }))

  it('a person may add an alias at their OWN address, but not payroll@ or a colleague\'s', async () => {
    await expect(add('payroll@acme.test', false)).rejects.toMatchObject({ code: 'ADDRESS_NOT_YOURS' })
    await expect(add('rahul@acme.test', false)).rejects.toMatchObject({ code: 'ADDRESS_NOT_YOURS' })
    expect((await add('priya@acme.test', false)).email).toBe('priya@acme.test')
  })

  it('someone who administers the company may create a shared address', async () => {
    expect((await add('careers@acme.test', true)).email).toBe('careers@acme.test')
  })

  it('the database refuses two live mailboxes on one address, whatever the code does', async () => {
    await expect(withTenant(A.id, (tx) => tx.query(
      `INSERT INTO mail_accounts (tenant_id, id, user_id, email, provider, auth_type)
       VALUES ($1, gen_random_uuid(), $2, 'CAREERS@acme.test', 'internal', 'password')`, [A.id, me]))).rejects.toThrow(/unique|duplicate/i)
  })
})

describe('where a mailbox may connect', () => {
  const ok = (kind: 'imap' | 'smtp', host: string, port: number) => assertMailEndpoint(kind, host, port)

  it('refuses private, loopback and metadata addresses', async () => {
    for (const host of ['10.0.0.5', '192.168.1.10', '169.254.169.254', '172.16.0.1']) {
      await expect(ok('imap', host, 993), host).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    }
  })

  it('refuses a host that is not a hostname', async () => {
    for (const host of ['a.com/../x', 'user@host.com', 'host with space', '', 'a'.repeat(300)]) {
      await expect(ok('smtp', host, 587), host).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    }
  })

  it('allows only the ports mail actually uses', async () => {
    await expect(ok('imap', '93.184.216.34', 993)).resolves.toBeUndefined()
    await expect(ok('imap', '93.184.216.34', 143)).resolves.toBeUndefined()
    await expect(ok('smtp', '93.184.216.34', 587)).resolves.toBeUndefined()
    await expect(ok('smtp', '93.184.216.34', 465)).resolves.toBeUndefined()
    for (const port of [22, 80, 6379, 5432, 11211, 3306]) {
      await expect(ok('imap', '93.184.216.34', port), String(port)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(ok('smtp', '93.184.216.34', port), String(port)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    }
  })
})

describe('what a failure says', () => {
  it('never repeats the server\'s own words', () => {
    const banner = '550 5.7.1 SSH-2.0-OpenSSH_9.6 redis_version:7.0.11 secret-internal-hostname.corp'
    const shown = publicMailError(banner)
    expect(shown).not.toContain('redis')
    expect(shown).not.toContain('OpenSSH')
    expect(shown.length).toBeLessThan(120)
  })

  it('still tells the person what kind of problem it was', () => {
    expect(publicMailError('Invalid credentials (Failure)')).toMatch(/sign-in|password/i)
    expect(publicMailError('connect ECONNREFUSED 10.1.1.1:993')).toMatch(/reach/i)
    expect(publicMailError('the TLS handshake stalled')).toMatch(/secure|timed|respond/i)
    expect(publicMailError('smtp.acme.com is configured without TLS; PEPL will not risk sending a password')).toMatch(/TLS/)
  })
})

describe('authenticating after STARTTLS', () => {
  it('is allowed once the connection has actually been upgraded', () => {
    expect(smtpMayAuthenticate({ secure: false, upgraded: true })).toBe(true)     // the bug: this was false
  })
  it('is allowed on an implicit-TLS connection', () => {
    expect(smtpMayAuthenticate({ secure: true, upgraded: false })).toBe(true)
  })
  it('is refused on a plain connection, even one whose server ADVERTISES STARTTLS', () => {
    expect(smtpMayAuthenticate({ secure: false, upgraded: false })).toBe(false)
  })
  it('the explicit insecure opt-in still works, for a local relay', () => {
    expect(smtpMayAuthenticate({ secure: false, upgraded: false, allowInsecureAuth: true })).toBe(true)
  })
})
