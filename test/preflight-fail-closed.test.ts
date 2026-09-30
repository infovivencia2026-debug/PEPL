/**
 * The preflight must refuse what is MISSING, not only what is WRONG.
 *
 * It checked `env[key] === devValue`. An UNSET variable is not equal to the dev
 * value, so a production deploy with no database passwords at all sailed through --
 * while config.ts, reading the same variables, quietly substituted the development
 * passwords as its fallback, and `bootstrap` then set the database roles to them on
 * deploy. The check that exists to stop the dev credentials reaching production
 * was blind to the case where they arrive by default.
 *
 * Found by an audit; each case here is reproduced before it is fixed.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { inspect } from '../src/http/preflight.ts'

const valid = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'production', PEPL_DB: 'pepl_prod',
    SUPER_PASSWORD: 'super-secret-value-1', OWNER_PASSWORD: 'owner-secret-value-2', APP_PASSWORD: 'app-secret-value-3',
    PEPL_BENCHMARK_SALT: 'a-long-random-benchmark-salt-value',
    PEPL_MAIL_KEY: 'k', PEPL_PUBLIC_URL: 'https://pepl.example', PEPL_OBJECT_STORE_BUCKET: 'b',
    PEPL_GSTIN: '36AAAAA0000A1Z5', PEPL_BANK_ACCOUNT_NUMBER: '1', PEPL_BANK_IFSC: 'HDFC0001234',
    ...extra,
  }
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]
  return env as NodeJS.ProcessEnv
}
const refused = (env: NodeJS.ProcessEnv) => inspect(env).filter((f) => f.level === 'refuse').map((f) => f.key)

describe('a database password that is missing', () => {
  for (const key of ['SUPER_PASSWORD', 'OWNER_PASSWORD', 'APP_PASSWORD']) {
    it(`refuses ${key} when unset`, () => {
      expect(refused(valid({ [key]: undefined }))).toContain(key)
    })

    it(`refuses ${key} when blank or only whitespace`, () => {
      expect(refused(valid({ [key]: '' }))).toContain(key)
      expect(refused(valid({ [key]: '    ' }))).toContain(key)
    })
  }

  it('refuses all three at once when none is set', () => {
    const env = valid({ SUPER_PASSWORD: undefined, OWNER_PASSWORD: undefined, APP_PASSWORD: undefined })
    expect(refused(env)).toEqual(expect.arrayContaining(['SUPER_PASSWORD', 'OWNER_PASSWORD', 'APP_PASSWORD']))
  })
})

describe('a database password that is a placeholder', () => {
  for (const value of ['change-me', 'CHANGE_ME_PLEASE', 'changeme123456', 'Change-Me-Before-Deploy']) {
    it(`refuses "${value}"`, () => {
      expect(refused(valid({ OWNER_PASSWORD: value }))).toContain('OWNER_PASSWORD')
    })
  }

  it('refuses one too short to be a secret', () => {
    expect(refused(valid({ APP_PASSWORD: 'short-pw' }))).toContain('APP_PASSWORD')
  })

  it('refuses the same password for two different roles', () => {
    // The owner runs DDL and the app runs every customer query. One password for both
    // undoes the separation the two roles exist to provide.
    const f = inspect(valid({ OWNER_PASSWORD: 'shared-secret-value-9', APP_PASSWORD: 'shared-secret-value-9' }))
    expect(f).toContainEqual(expect.objectContaining({ level: 'refuse' }))
    expect(f.some((x) => /same|distinct|share/i.test(x.message))).toBe(true)
  })
})

describe('the benchmark salt', () => {
  // Salary benchmarks hash each company's id with this so the published bands cannot be
  // walked back to a named company. Unset, the code falls back to a constant that is in
  // the repository -- and then anyone with the source can do exactly that walk.
  it('is required in production', () => {
    expect(refused(valid({ PEPL_BENCHMARK_SALT: undefined }))).toContain('PEPL_BENCHMARK_SALT')
  })

  it('may not be the value that ships in the source or the example file', () => {
    expect(refused(valid({ PEPL_BENCHMARK_SALT: 'pepl-benchmarks' }))).toContain('PEPL_BENCHMARK_SALT')
    expect(refused(valid({ PEPL_BENCHMARK_SALT: 'dev-benchmark-salt-not-for-production' }))).toContain('PEPL_BENCHMARK_SALT')
  })
})

describe('a correctly configured production', () => {
  it('is refused for nothing', () => {
    // The control. A check that refuses everything protects nothing.
    expect(refused(valid())).toEqual([])
  })
})

describe('config.ts fails closed too', () => {
  const load = (env: Record<string, string>) => spawnSync(
    process.execPath,
    ['--experimental-strip-types', '-e', "import('./src/config.ts').then((m) => console.log('LOADED ' + m.config.ownerPassword))"],
    {
      cwd: process.cwd(), encoding: 'utf8',
      // No .env: the repository's own would supply the development passwords.
      env: { PATH: process.env.PATH ?? '', DOTENV_CONFIG_PATH: 'no-such-file.env', ...env },
    },
  )

  it('refuses to start in production without a password, instead of using the dev one', () => {
    const r = load({ NODE_ENV: 'production', PEPL_DB: 'pepl_prod' })
    expect(r.stdout).not.toContain('LOADED')
    expect(r.stderr).toMatch(/missing env (SUPER|OWNER|APP)_PASSWORD/)
  })

  it('still falls back on a developer machine, so `npm run api` works out of the box', () => {
    const r = load({})
    expect(r.stdout).toContain('LOADED pepl_owner_dev')
  })

  it('uses what it is given in production', () => {
    const r = load({ NODE_ENV: 'production', PEPL_DB: 'pepl_prod', SUPER_PASSWORD: 'a', OWNER_PASSWORD: 'b-owner-secret', APP_PASSWORD: 'c' })
    expect(r.stdout).toContain('LOADED b-owner-secret')
  })
})

describe('the scheduler', () => {
  it('runs the preflight, as the API does', () => {
    // It is a separate process with the same database credentials. It never ran the
    // checks, so a scheduler could start on a configuration the API would have refused.
    const source = readFileSync('src/jobs/scheduler.ts', 'utf8')
    const main = source.slice(source.indexOf('if (import.meta.url === pathToFileURL'))
    expect(main).toContain('preflight()')
  })
})
