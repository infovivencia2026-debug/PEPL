/**
 * Four suspected holes, each reproduced here before it was changed (security review).
 *
 *  A. Salary bank-account changes: hr_admin holds employee.write but is deliberately NOT given bank.* or
 *     compensation.* -- yet POST /employees/:id/bank-accounts only asked for employee.write, so HR could
 *     redirect anyone's salary to an account of their choosing.
 *  B. API keys: createApiKey accepted any role except org_admin, whatever the CREATOR held, so a user
 *     with only integration.manage (a narrow custom role) could mint a payroll_admin key.
 *  C. HTML sanitiser: attribute values were checked raw, but a browser decodes entities and CSS escapes
 *     BEFORE it interprets them -- `&#117;rl(...)` / `u\72l(...)` fetch a URL from `style`, and
 *     `/&#47;evil.com` is a protocol-relative link that passed as "relative".
 *  D. Company-wide templates: task.assign is held by `manager` (scope reports), so any manager could
 *     define, rewrite or retire the company's onboarding/offboarding checklists.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser, login } from '../src/auth/index.ts'
import { sanitizeHtml } from '../src/mail/sanitize.ts'

const PW = 'security-review-password'
let server: Server, base: string, A: Tenant, other: string
const token: Record<string, string> = {}
const call = async (who: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> }
}

beforeAll(async () => {
  ;({ a: A } = await resetAndSeed())
  await controlPool.query(
    `INSERT INTO tenant_entitlements(tenant_id,plan_code,features,limits) VALUES($1,'test','{"integrations":true,"payroll":true}','{"employees":100}')
     ON CONFLICT (tenant_id) DO UPDATE SET features = EXCLUDED.features, limits = EXCLUDED.limits`, [A.id])
  other = await withTenant(A.id, async (tx) => (await tx.query<{ id: string }>(
    `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-2','Other',DATE '2026-01-01') RETURNING id`, [A.id])).rows[0]!.id)
  const mgrEmp = await withTenant(A.id, async (tx) => (await tx.query<{ id: string }>(
    `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-3','Mgr',DATE '2025-01-01') RETURNING id`, [A.id])).rows[0]!.id)
  await withTenant(A.id, async (tx) => {
    // a custom role with ONLY integration.manage (+ read of employees)
    await tx.query(`INSERT INTO custom_roles (tenant_id, name, permissions, data_scope) VALUES ($1,'integrator','{integration.manage,employee.read}','self')`, [A.id])
    const users: Array<[string, string[], string | undefined]> = [
      ['hr', ['hr_admin'], undefined], ['payroll', ['payroll_admin'], undefined], ['admin', ['org_admin'], undefined],
      ['mgr', ['manager'], mgrEmp], ['integrator', ['integrator'], undefined],
    ]
    for (const [name, roles, employeeId] of users) await createUser(tx, { tenantId: A.id, email: `${name}@sec.test`, fullName: name, password: PW, roles, employeeId })
  })
  for (const name of ['hr', 'payroll', 'admin', 'mgr', 'integrator']) {
    const s = await login({ email: `${name}@sec.test`, password: PW })
    if ('choose' in s) throw new Error('duplicate address')
    token[name] = s.token
  }
  server = createServer(createHandler(buildRouter()))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => { server?.closeAllConnections(); server?.close(); await closePools(); await controlPool.end() })

describe('A. who may change where a salary is paid', () => {
  const acct = { beneficiaryName: 'Other', accountNumber: '50100123456789', ifsc: 'HDFC0001234', bankName: 'HDFC' }
  it('general HR cannot', async () => {
    expect((await call('hr', 'POST', `/api/v1/employees/${other}/bank-accounts`, acct)).status).toBe(403)
    const rows = await withTenant(A.id, async (tx) => (await tx.query(`SELECT 1 FROM employee_bank_accounts WHERE employee_id = $1`, [other])).rowCount)
    expect(rows).toBe(0)
  })
  it('a manager cannot', async () => {
    expect((await call('mgr', 'POST', `/api/v1/employees/${other}/bank-accounts`, acct)).status).toBe(403)
  })
  it('payroll can, and it is audited', async () => {
    expect((await call('payroll', 'POST', `/api/v1/employees/${other}/bank-accounts`, acct)).status).toBe(201)
  })
  it('an org admin can', async () => {
    expect((await call('admin', 'POST', `/api/v1/employees/${other}/bank-accounts`, { ...acct, accountNumber: '50100999999999' })).status).toBe(201)
  })
})

describe('B. an API key cannot out-rank the person who made it', () => {
  const mint = (who: string, role: string) => call(who, 'POST', '/api/v1/integrations/api-keys', { name: `k-${role}`, role })
  it('a user with only integration.manage cannot mint a payroll_admin or finance key', async () => {
    for (const role of ['payroll_admin', 'finance', 'hr_admin', 'auditor']) {
      expect((await mint('integrator', role)).status, role).toBe(422)
    }
  })
  it('...and the refusal creates nothing', async () => {
    const n = await withTenant(A.id, async (tx) => Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM api_keys`)).rows[0]!.n))
    expect(n).toBe(0)
  })
  it('an org admin can still mint any key except another org admin', async () => {
    expect((await mint('admin', 'payroll_admin')).status).toBe(201)
    expect((await mint('admin', 'org_admin')).status).toBe(422)
  })
  it('the role list offered is only what the caller may grant', async () => {
    const r = await call('integrator', 'GET', '/api/v1/integrations/api-keys')
    expect(r.body.roles).not.toContain('payroll_admin')
  })
})

describe('C. HTML that a browser reads differently from the sanitiser', () => {
  const clean = (html: string) => sanitizeHtml(html)
  it('style: no entity-encoded or CSS-escaped url(), image-set() or other fetching functions survive', () => {
    for (const style of [
      'background:&#117;rl(http://evil/x)', 'background:&#x75;rl(http://evil/x)', 'background:u\\72l(http://evil/x)',
      'background:\\75 rl(http://evil/x)', 'background:image-set("http://evil/x" 1x)', 'background:-webkit-image-set(url(http://evil/x) 1x)',
      'content:url(http://evil/x)', 'background:cross-fade(url(x),url(y))', 'background:ima/**/ge-set("http://evil/x" 1x)',
    ]) {
      const out = clean(`<div style="${style}">x</div>`)
      expect(out, style).not.toMatch(/evil/)
    }
  })
  it('href/src: an entity-encoded second slash is not a "relative" link', () => {
    for (const href of ['/&#47;evil.com', '/&#x2f;evil.com', '&#47;/evil.com', 'java&#115;cript:alert(1)', '&#106;avascript:alert(1)', ' \tjavascript:alert(1)']) {
      expect(clean(`<a href="${href}">x</a>`), href).not.toMatch(/href=/)
    }
  })
  it('still keeps ordinary safe markup, links and styles', () => {
    expect(clean('<p style="color:#333;font-weight:bold">hi</p>')).toContain('color:#333')
    expect(clean('<a href="https://example.com/a?b=1&amp;c=2">x</a>')).toContain('href="https://example.com/a?b=1&amp;c=2"')
    expect(clean('<a href="/path/page">x</a>')).toContain('href="/path/page"')
    expect(clean('<a href="mailto:a@b.co">x</a>')).toContain('mailto:a@b.co')
  })
  it('never lets a script, handler or javascript: url through', () => {
    const out = clean('<img src=x onerror=alert(1)><script>alert(1)</script><a href="javascript:alert(1)" onclick="x()">a</a><iframe src="//e"></iframe>')
    expect(out).not.toMatch(/onerror|onclick|<script|javascript:|<iframe/i)
  })
})

describe('D. company-wide checklists are not a manager\'s to rewrite', () => {
  const tpl = { name: 'Checklist', trigger: 'manual', items: [{ title: 'Do a thing', assigneeRule: 'hr' }] }
  let id: string
  it('HR and an org admin can define and change them', async () => {
    const r = await call('hr', 'POST', '/api/v1/task-templates', tpl)
    expect(r.status).toBe(201)
    id = r.body.id
    expect((await call('hr', 'PATCH', `/api/v1/task-templates/${id}`, { name: 'Renamed' })).status).toBe(200)
  })
  it('a manager cannot create, change or retire one', async () => {
    expect((await call('mgr', 'POST', '/api/v1/task-templates', tpl)).status).toBe(403)
    expect((await call('mgr', 'PATCH', `/api/v1/task-templates/${id}`, { name: 'Hijacked' })).status).toBe(403)
    expect((await call('mgr', 'POST', `/api/v1/task-templates/${id}/retire`, {})).status).toBe(403)
    const name = await withTenant(A.id, async (tx) => (await tx.query<{ name: string }>(`SELECT name FROM task_templates WHERE id = $1`, [id])).rows[0]!.name)
    expect(name).toBe('Renamed')
  })
  it('a manager can still assign individual tasks (that is what the permission is for)', async () => {
    expect((await call('mgr', 'GET', '/api/v1/task-templates')).status).toBe(200)
  })
})
