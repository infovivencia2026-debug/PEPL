/**
 * The RLS gate must read a policy, not grep it.
 *
 * gate:rls joined USING and WITH CHECK and looked for `current_tenant()` anywhere, so
 * `WITH CHECK (true)` beside a tenant-scoped USING, or `... OR true`, passed the build
 * while letting a company write (or read) every other company's rows. Found by an audit.
 *
 * The passing cases are the shapes the real schema uses, copied from pg_policies.
 */
import { describe, it, expect } from 'vitest'
import { isTenantGuarded, lintPolicy } from '../src/db/policy-lint.ts'

const policy = (qual: string | null, withCheck: string | null, cmd = 'ALL') =>
  ({ table: 't', name: 'tenant_isolation', cmd, qual, withCheck })

describe('what counts as tenant-guarded', () => {
  const ok = [
    '(tenant_id = current_tenant())',
    'tenant_id = current_tenant()',
    '(id = current_tenant())',
    // tenant AND narrowing conditions (tickets, pips, survey_responses, ...)
    '((tenant_id = current_tenant()) AND ((NOT is_confidential) OR (raised_by_user_id = current_app_user())))',
    // the reviewed owner-role exemption (app_users, sessions, api_keys, ...)
    "((tenant_id = current_tenant()) OR (CURRENT_USER = 'pepl_owner'::name))",
    // narrowing conditions may themselves contain an OR, as long as the tenant guard is ANDed on
    "((tenant_id = current_tenant()) AND ((a = 1) OR (b = 2) OR (CURRENT_USER = 'pepl_owner'::name)))",
    // the thread policy: tenant AND the parent must be visible
    '((tenant_id = current_tenant()) AND (EXISTS ( SELECT 1 FROM tickets k WHERE ((k.tenant_id = m.tenant_id)))))',
  ]
  for (const e of ok) it(`accepts ${e.slice(0, 70)}`, () => expect(isTenantGuarded(e)).toBe(true))

  const bad = [
    'true',
    '(true)',
    '(1 = 1)',
    '(tenant_id = current_tenant()) OR true',
    '((tenant_id = current_tenant()) OR (1 = 1))',
    '((tenant_id = current_tenant()) OR (is_public))',
    "((tenant_id = current_tenant()) OR (CURRENT_USER = 'postgres'::name))",
    "((tenant_id = current_tenant()) OR (CURRENT_USER = 'pepl_owner'::name) OR true)",
    '(owner_id = current_app_user())',
    '(tenant_id <> current_tenant())',
    '(NOT (tenant_id = current_tenant()))',
    '(tenant_id IS NOT NULL)',
    // a mention that is not a comparison
    "(note = 'current_tenant()')",
  ]
  for (const e of bad) it(`rejects ${e.slice(0, 70)}`, () => expect(isTenantGuarded(e)).toBe(false))

  it('is not fooled by an OR hidden in a quoted string or a nested paren', () => {
    expect(isTenantGuarded("(tenant_id = current_tenant() AND note <> ' OR true ')")).toBe(true)
    expect(isTenantGuarded('((a OR b) AND c)')).toBe(false)
  })
})

describe('the two clauses are judged separately', () => {
  it('accepts a well-formed policy', () => {
    expect(lintPolicy(policy('(tenant_id = current_tenant())', '(tenant_id = current_tenant())'))).toEqual([])
  })

  it('rejects WITH CHECK (true) even though USING is fine -- the old gate passed this', () => {
    const p = lintPolicy(policy('(tenant_id = current_tenant())', 'true'))
    expect(p).toHaveLength(1)
    expect(p[0]).toMatch(/WITH CHECK does not confine writes/)
  })

  it('rejects USING (true) even though WITH CHECK is fine', () => {
    const p = lintPolicy(policy('true', '(tenant_id = current_tenant())'))
    expect(p[0]).toMatch(/USING does not confine reads/)
  })

  it('rejects an OR true tail on either clause', () => {
    expect(lintPolicy(policy('(tenant_id = current_tenant()) OR true', '(tenant_id = current_tenant())'))).toHaveLength(1)
    expect(lintPolicy(policy('(tenant_id = current_tenant())', '(tenant_id = current_tenant()) OR true'))).toHaveLength(1)
  })

  it('rejects a missing clause on ALL', () => {
    expect(lintPolicy(policy(null, '(tenant_id = current_tenant())'))[0]).toMatch(/no USING/)
    expect(lintPolicy(policy('(tenant_id = current_tenant())', null))[0]).toMatch(/no WITH CHECK/)
  })

  it('a SELECT-only policy needs USING only; an INSERT-only one needs WITH CHECK only', () => {
    expect(lintPolicy(policy('(tenant_id = current_tenant())', null, 'SELECT'))).toEqual([])
    expect(lintPolicy(policy(null, '(tenant_id = current_tenant())', 'INSERT'))).toEqual([])
    expect(lintPolicy(policy('true', null, 'SELECT'))).toHaveLength(1)
  })
})
