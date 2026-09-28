/**
 * The checks that run before this process serves a real customer.
 *
 * Each case here is a mistake that was previously possible to make and which
 * said nothing at the time: the server started, answered /health, and then did
 * the wrong thing quietly.
 */
import { describe, it, expect, vi } from 'vitest'
import { inspect, preflight } from '../src/http/preflight.ts'

const production = (extra: Record<string, string> = {}) => ({
  NODE_ENV: 'production',
  PEPL_DB: 'pepl_prod',
  SUPER_PASSWORD: 'a-real-secret',
  OWNER_PASSWORD: 'another-real-secret',
  APP_PASSWORD: 'a-third-real-secret',
  PEPL_MAIL_KEY: 'k',
  PEPL_PUBLIC_URL: 'https://pepl.example',
  PEPL_OBJECT_STORE_BUCKET: 'pepl-docs',
  PEPL_GSTIN: '36AAAAA0000A1Z5',
  PEPL_BANK_ACCOUNT_NUMBER: '50200012345678',
  PEPL_BANK_IFSC: 'HDFC0001234',
  ...extra,
}) as NodeJS.ProcessEnv

describe('what it refuses to start with', () => {
  it('rejects the development passwords from .env.example', () => {
    // The one that ends a company. Anyone who has read the repository knows it.
    const f = inspect(production({ OWNER_PASSWORD: 'pepl_owner_dev' }))
    expect(f).toContainEqual(expect.objectContaining({ level: 'refuse', key: 'OWNER_PASSWORD' }))
  })

  it('rejects every one of them, not just the first', () => {
    const f = inspect(production({
      SUPER_PASSWORD: 'postgres', OWNER_PASSWORD: 'pepl_owner_dev', APP_PASSWORD: 'pepl_app_dev',
    })).filter((x) => x.level === 'refuse')
    expect(f.map((x) => x.key).sort()).toEqual(['APP_PASSWORD', 'OWNER_PASSWORD', 'SUPER_PASSWORD'])
  })

  it('exits rather than serving traffic', () => {
    const exit = vi.fn() as unknown as (code: number) => never
    preflight(production({ OWNER_PASSWORD: 'pepl_owner_dev' }), exit)
    expect(exit).toHaveBeenCalledWith(1)
  })
})

describe('what it warns about but starts anyway', () => {
  it('names each degraded feature', () => {
    // These break a feature; they do not endanger the data, so refusing to
    // start would cost more than it saves.
    const keys = inspect(production({
      PEPL_MAIL_KEY: '', PEPL_GSTIN: '', PEPL_BANK_ACCOUNT_NUMBER: '',
    })).filter((f) => f.level === 'warn').map((f) => f.key)
    expect(keys).toContain('PEPL_MAIL_KEY')
    expect(keys).toContain('PEPL_GSTIN')
    expect(keys).toContain('PEPL_BANK_ACCOUNT_NUMBER')
  })

  it('does not exit for them', () => {
    const exit = vi.fn() as unknown as (code: number) => never
    preflight(production({ PEPL_MAIL_KEY: '', PEPL_GSTIN: '' }), exit)
    expect(exit).not.toHaveBeenCalled()
  })
})

describe('outside production', () => {
  it('says nothing at all', () => {
    // A developer on a laptop is not misconfigured, and a preflight that cries
    // wolf in development is one people learn to skip.
    const exit = vi.fn() as unknown as (code: number) => never
    const findings = preflight({ NODE_ENV: 'development', OWNER_PASSWORD: 'pepl_owner_dev' } as NodeJS.ProcessEnv, exit)
    expect(findings).toEqual([])
    expect(exit).not.toHaveBeenCalled()
  })
})

describe('a correctly configured production server', () => {
  it('has nothing to say', () => {
    expect(inspect(production())).toEqual([])
  })
})
