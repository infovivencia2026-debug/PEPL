/**
 * A document is as private as the thing it is attached to.
 *
 * The scope check on documents ran only for an EMPLOYEE-owned document when the caller also
 * named the owner. So any employee -- who holds document.read and document.write so they can
 * keep their own paperwork -- could:
 *   - list the newest 100 documents in the company by omitting the owner filter,
 *   - download a ticket's attachments (a grievance's evidence), a conversation's files
 *     (someone else's DMs) or a confidential company document,
 *   - and permanently delete any tenant, ticket or conversation document -- or an HR letter
 *     about themselves.
 * `is_confidential` was stored and never consulted. Reported by an audit; each case here was
 * reproduced against the running routes first.
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser, login } from '../src/auth/index.ts'
import { putDocument } from '../src/documents/index.ts'
import { raiseTicket } from '../src/work/helpdesk.ts'

const PASSWORD = 'document-access-test-password'
let server: Server, base: string, A: Tenant, otherEmp: string
const token: Record<string, string> = {}
const user: Record<string, string> = {}
const doc: Record<string, string> = {}

const call = async (method: string, path: string, who: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> & { error?: { code: string }; documents?: { id: string }[] } }
}
const listed = async (who: string, query: string) => (await call('GET', `/api/v1/documents?${query}`, who))
const ids = (r: { body: { documents?: { id: string }[] } }) => (r.body.documents ?? []).map((d) => d.id)

/** A stored document, written by `uploader` (a user id), owned by whatever the case needs. */
const store = (name: string, o: {
  ownerType: 'employee' | 'ticket' | 'conversation' | 'tenant'; ownerId: string | null; confidential?: boolean; uploader: string
}) => withTenant(A.id, (tx) => putDocument(tx, {
  ownerType: o.ownerType, ownerId: o.ownerId, fileName: `${name}.txt`, contentType: 'text/plain',
  bytes: Buffer.from(`secret contents of ${name}`), category: 'other', isConfidential: o.confidential ?? false,
  uploadedByUserId: o.uploader,
})).then((m) => { doc[name] = m.id; return m.id })

beforeAll(async () => {
  ;({ a: A } = await resetAndSeed())
  await controlPool.query(
    `INSERT INTO tenant_entitlements(tenant_id,plan_code,features,limits) VALUES($1,'test','{"documents":true,"chat":true,"helpdesk":true}','{"employees":100}')
     ON CONFLICT (tenant_id) DO UPDATE SET features = EXCLUDED.features, limits = EXCLUDED.limits`, [A.id])

  otherEmp = await withTenant(A.id, async (tx) => (await tx.query<{ id: string }>(
    `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-002','Meera',DATE '2026-01-01') RETURNING id`, [A.id])).rows[0]!.id)

  for (const [name, roles, employeeId] of [
    ['hr', ['hr_admin'], undefined],
    ['emp', ['employee'], A.employeeId],
    ['other', ['employee'], otherEmp],
  ] as const) {
    user[name] = await withTenant(A.id, (tx) => createUser(tx, {
      tenantId: A.id, email: `${name}@docs.test`, fullName: name, password: PASSWORD, roles: [...roles], employeeId,
    }))
    const s = await login({ email: `${name}@docs.test`, password: PASSWORD })
    if ('choose' in s) throw new Error('fixture address is in more than one company')
    token[name] = s.token
  }

  // A conversation between emp and hr; `other` is not in it.
  const conv = await withTenant(A.id, async (tx) => {
    const id = (await tx.query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, kind, title, created_by_user_id) VALUES ($1,'dm','emp and hr',$2) RETURNING id`, [A.id, user.emp])).rows[0]!.id
    for (const u of [user.emp, user.hr]) {
      await tx.query(`INSERT INTO conversation_participants (tenant_id, conversation_id, user_id) VALUES ($1,$2,$3)`, [A.id, id, u])
    }
    return id
  })

  // Tickets: one raised by emp (ordinary), one raised by emp in a CONFIDENTIAL category.
  const { ordinary, grievance } = await withTenant(A.id, async (tx) => {
    const cat = async (name: string, confidential: boolean) => (await tx.query<{ id: string }>(
      `INSERT INTO ticket_categories (tenant_id, name, is_confidential, sla_response_minutes, sla_resolution_minutes) VALUES ($1,$2,$3,60,240) RETURNING id`,
      [A.id, name, confidential])).rows[0]!.id
    const c1 = await cat('IT', false)
    const c2 = await cat('Grievance', true)
    return {
      ordinary: await raiseTicket(tx, { categoryId: c1, raisedByUserId: user.emp!, title: 'Laptop', description: 'slow' }),
      grievance: await raiseTicket(tx, { categoryId: c2, raisedByUserId: user.emp!, title: 'Complaint', description: 'private' }),
    }
  }, { userId: user.emp })

  await store('policy', { ownerType: 'tenant', ownerId: null, uploader: user.hr! })
  await store('salary-bands', { ownerType: 'tenant', ownerId: null, confidential: true, uploader: user.hr! })
  await store('emp-own-proof', { ownerType: 'employee', ownerId: A.employeeId, uploader: user.emp! })
  await store('emp-hr-letter', { ownerType: 'employee', ownerId: A.employeeId, uploader: user.hr! })
  await store('emp-warning', { ownerType: 'employee', ownerId: A.employeeId, confidential: true, uploader: user.hr! })
  await store('other-proof', { ownerType: 'employee', ownerId: otherEmp, uploader: user.other! })
  await store('ticket-ordinary', { ownerType: 'ticket', ownerId: ordinary, uploader: user.emp! })
  await store('ticket-grievance', { ownerType: 'ticket', ownerId: grievance, uploader: user.emp! })
  await store('dm-file', { ownerType: 'conversation', ownerId: conv, uploader: user.emp! })
  doc.ordinary = ordinary; doc.grievance = grievance; doc.conv = conv

  server = createServer(createHandler(buildRouter()))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => { server?.closeAllConnections(); server?.close(); await closePools(); await controlPool.end() })

describe('listing', () => {
  it('needs an owner: an employee cannot list the company by leaving the filter out', async () => {
    const r = await listed('emp', '')
    expect(r.status).toBe(422)
    expect(ids(r)).toEqual([])
  })

  it('a company-wide role still can', async () => {
    const r = await listed('hr', '')
    expect(r.status).toBe(200)
    expect(ids(r).length).toBeGreaterThan(5)
  })

  it('an employee sees their own folder, and not a colleague\'s', async () => {
    expect(ids(await listed('emp', `ownerType=employee&ownerId=${A.employeeId}`))).toContain(doc['emp-own-proof'])
    expect((await listed('emp', `ownerType=employee&ownerId=${otherEmp}`)).status).toBe(404)
  })

  it('hides confidential documents from a listing that is not company-wide', async () => {
    const tenant = ids(await listed('emp', 'ownerType=tenant'))
    expect(tenant).toContain(doc['policy'])
    expect(tenant).not.toContain(doc['salary-bands'])
    // ...but the subject of a confidential personnel document may see it, and HR always can.
    expect(ids(await listed('emp', `ownerType=employee&ownerId=${A.employeeId}`))).toContain(doc['emp-warning'])
    expect(ids(await listed('hr', 'ownerType=tenant'))).toContain(doc['salary-bands'])
  })

  it('lists a ticket\'s or conversation\'s documents only to those who may see them', async () => {
    expect(ids(await listed('emp', `ownerType=ticket&ownerId=${doc.ordinary}`))).toContain(doc['ticket-ordinary'])
    expect((await listed('other', `ownerType=ticket&ownerId=${doc.ordinary}`)).status).toBe(404)
    expect((await listed('other', `ownerType=conversation&ownerId=${doc.conv}`)).status).toBe(404)
    expect(ids(await listed('emp', `ownerType=conversation&ownerId=${doc.conv}`))).toContain(doc['dm-file'])
  })
})

describe('reading', () => {
  const get = (who: string, name: string) => call('GET', `/api/v1/documents/${doc[name]}/content`, who)

  it('an employee can read what they are meant to', async () => {
    for (const name of ['policy', 'emp-own-proof', 'emp-hr-letter', 'emp-warning', 'ticket-ordinary', 'ticket-grievance', 'dm-file']) {
      expect((await get('emp', name)).status, name).toBe(200)
    }
  })

  it('and cannot read what belongs to someone else or is confidential', async () => {
    for (const name of ['salary-bands', 'ticket-ordinary', 'ticket-grievance', 'dm-file', 'emp-warning', 'emp-hr-letter']) {
      expect((await get('other', name)).status, `other reading ${name}`).toBe(404)
    }
    // A colleague's own paperwork, from the other side.
    expect((await get('emp', 'other-proof')).status).toBe(404)
    expect((await get('other', 'other-proof')).status).toBe(200)
  })

  it('a grievance attachment is invisible to general HR, like the ticket itself', async () => {
    // hr holds document.read for the whole company, but the ticket policy hides a confidential
    // ticket from them -- and what is attached to it is as hidden as the ticket.
    expect((await get('hr', 'ticket-grievance')).status).toBe(404)
  })

  it('a direct message\'s file is for its participants only -- not even HR', async () => {
    const outsider = await withTenant(A.id, async (tx) => createUser(tx, {
      tenantId: A.id, email: 'admin2@docs.test', fullName: 'Admin', password: PASSWORD, roles: ['org_admin'],
    }))
    void outsider
    const s = await login({ email: 'admin2@docs.test', password: PASSWORD })
    if ('choose' in s) throw new Error('unexpected')
    token.admin = s.token
    expect((await get('admin', 'dm-file')).status).toBe(404)
    expect((await get('hr', 'dm-file')).status).toBe(200)            // hr IS a participant
  })

  it('HR reads a confidential personnel file', async () => {
    expect((await get('hr', 'emp-warning')).status).toBe(200)
    expect((await get('hr', 'salary-bands')).status).toBe(200)
  })

  it('metadata follows the same rule as content', async () => {
    expect((await call('GET', `/api/v1/documents/${doc['salary-bands']}`, 'emp')).status).toBe(404)
    expect((await call('GET', `/api/v1/documents/${doc['dm-file']}`, 'other')).status).toBe(404)
  })
})

describe('deleting', () => {
  const del = (who: string, name: string) => call('DELETE', `/api/v1/documents/${doc[name]}`, who, { reason: 'test' })

  it('an employee cannot delete a company document, or an HR letter about themselves', async () => {
    expect((await del('emp', 'policy')).status).toBe(403)
    expect((await del('emp', 'emp-hr-letter')).status).toBe(403)
    expect((await del('emp', 'emp-warning')).status).toBe(403)
    expect((await del('other', 'ticket-ordinary')).status).toBe(404)      // cannot even see it
  })

  it('a document survives all of those', async () => {
    for (const name of ['policy', 'emp-hr-letter', 'emp-warning', 'ticket-ordinary']) {
      expect((await call('GET', `/api/v1/documents/${doc[name]}/content`, 'hr')).status, name).toBe(name === 'ticket-ordinary' ? 200 : 200)
    }
  })

  it('a person can delete what they uploaded themselves', async () => {
    expect((await del('emp', 'emp-own-proof')).status).toBe(204)
  })

  it('and can retract their own attachment on a ticket they raised', async () => {
    expect((await del('emp', 'ticket-ordinary')).status).toBe(204)
  })

  it('HR can delete a document they are responsible for', async () => {
    expect((await del('hr', 'emp-hr-letter')).status).toBe(204)
    expect((await del('hr', 'policy')).status).toBe(204)
  })
})

describe('uploading onto something you cannot see', () => {
  it('is refused for a ticket and a conversation you have no part in', async () => {
    const body = (ownerType: string, ownerId: string) => ({ ownerType, ownerId, fileName: 'x.txt', contentType: 'text/plain', contentBase64: Buffer.from('x').toString('base64'), category: 'attachment' })
    expect((await call('POST', '/api/v1/documents', 'other', body('ticket', doc.ordinary!))).status).toBe(404)
    expect((await call('POST', '/api/v1/documents', 'other', body('conversation', doc.conv!))).status).toBe(404)
    expect((await call('POST', '/api/v1/documents', 'emp', body('conversation', doc.conv!))).status).toBe(201)
  })
})
