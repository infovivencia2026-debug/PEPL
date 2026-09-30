/**
 * `npm run seed:demo` must not be runnable against a database that matters.
 *
 * It had no guard. Pointed at production it would have: purged any tenant named
 * "Acme Manufacturing Pvt Ltd", DELETEd the income-tax slabs and rules for 2026-27 --
 * global data every customer's payroll reads -- and replaced them with its own
 * "representative" figures, and planted an organisation administrator with a password
 * that is printed in docs/SELLING.md. Found by an audit.
 *
 * Two changes, both tested: it refuses anywhere that is not a development or demo
 * database, and it never deletes or overwrites the shared reference data.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { demoSeedRefusal } from '../src/control-plane/demo-guard.ts'

describe('where the demo seed may run', () => {
  const env = (o: Record<string, string>) => ({ ...o }) as NodeJS.ProcessEnv

  for (const db of ['pepl_dev', 'pepl_test', 'pepl_demo']) {
    it(`allows the ${db} database`, () => {
      expect(demoSeedRefusal(env({ PEPL_DB: db }))).toBeNull()
    })
  }

  it('refuses production, whatever the database is called', () => {
    expect(demoSeedRefusal(env({ NODE_ENV: 'production', PEPL_DB: 'pepl_dev' }))).toMatch(/production/)
    expect(demoSeedRefusal(env({ NODE_ENV: 'production', PEPL_DB: 'pepl_dev', PEPL_ALLOW_DEMO_SEED: 'pepl_dev' }))).toMatch(/production/)
  })

  it('refuses a database it does not recognise', () => {
    for (const db of ['pepl_prod', 'pepl', 'onrol_prod', 'postgres']) {
      expect(demoSeedRefusal(env({ PEPL_DB: db })), db).toMatch(/pepl_dev, pepl_test, pepl_demo/)
    }
  })

  it('refuses when PEPL_DB is unset rather than guessing', () => {
    expect(demoSeedRefusal(env({}))).not.toBeNull()
  })

  it('an unknown database needs the confirmation to NAME it, not just say yes', () => {
    expect(demoSeedRefusal(env({ PEPL_DB: 'sales_sandbox', PEPL_ALLOW_DEMO_SEED: '1' }))).not.toBeNull()
    expect(demoSeedRefusal(env({ PEPL_DB: 'sales_sandbox', PEPL_ALLOW_DEMO_SEED: 'yes' }))).not.toBeNull()
    expect(demoSeedRefusal(env({ PEPL_DB: 'sales_sandbox', PEPL_ALLOW_DEMO_SEED: 'other_db' }))).not.toBeNull()
    expect(demoSeedRefusal(env({ PEPL_DB: 'sales_sandbox', PEPL_ALLOW_DEMO_SEED: 'sales_sandbox' }))).toBeNull()
  })
})

describe('the script itself', () => {
  const run = (e: Record<string, string>) => spawnSync(
    process.execPath, ['--experimental-strip-types', 'scripts/seed-demo.ts'],
    { cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '', DOTENV_CONFIG_PATH: 'no-such-file.env', ...e }, timeout: 30_000 })

  it('exits non-zero, saying why, before touching any database, in production', () => {
    const r = run({ NODE_ENV: 'production', PEPL_DB: 'pepl_prod', SUPER_PASSWORD: 'x', OWNER_PASSWORD: 'x', APP_PASSWORD: 'x' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/refusing to seed the demo company/i)
    expect(r.stdout).not.toMatch(/tenant [0-9a-f-]{36}/)
  })

  it('refuses an unrecognised database', () => {
    const r = run({ PEPL_DB: 'pepl_prod' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/refusing to seed the demo company/i)
  })
})

describe('the shared reference data', () => {
  const source = readFileSync('scripts/seed-demo.ts', 'utf8')

  it('is never deleted', () => {
    // tax_slabs / tax_rules / pt_slabs / statutory_configs are read by every customer's payroll.
    expect(source).not.toMatch(/DELETE\s+FROM\s+(tax_slabs|tax_rules|pt_slabs|statutory_configs|pt_exemptions|lwf_rates)/i)
    expect(source).not.toMatch(/TRUNCATE/i)
  })

  it('runs the guard before anything else in main()', () => {
    const main = source.slice(source.indexOf('async function main'))
    expect(main.indexOf('demoSeedRefusal')).toBeGreaterThan(-1)
    expect(main.indexOf('demoSeedRefusal')).toBeLessThan(main.indexOf('controlDb.query'))
  })
})
