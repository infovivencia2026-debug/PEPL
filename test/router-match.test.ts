/**
 * Route matching: a literal segment beats a parameter at the same position,
 * whatever the registration order. /org/:kind (masters) used to swallow
 * /org/chart because it was registered first.
 */
import { describe, it, expect } from 'vitest'
import { Router } from '../src/http/router.ts'

const noop = async () => ({ status: 200, body: {} }) as never

describe('router matching', () => {
  it('prefers the most literal route regardless of order', () => {
    const r = new Router()
    r.get('/api/v1/org/:kind', { summary: 'masters', tag: 't' }, noop)
    r.get('/api/v1/org/chart', { summary: 'chart', tag: 't' }, noop)
    r.get('/api/v1/org/:kind/:id', { summary: 'one master', tag: 't' }, noop)
    r.get('/api/v1/org/chart/:id', { summary: 'sub chart', tag: 't' }, noop)
    expect(r.match('GET', '/api/v1/org/chart')?.route.meta.summary).toBe('chart')
    expect(r.match('GET', '/api/v1/org/department')?.route.meta.summary).toBe('masters')
    expect(r.match('GET', '/api/v1/org/department')?.params).toEqual({ kind: 'department' })
    expect(r.match('GET', '/api/v1/org/chart/abc')?.route.meta.summary).toBe('sub chart')
    expect(r.match('GET', '/api/v1/org/grade/abc')?.route.meta.summary).toBe('one master')
    expect(r.match('POST', '/api/v1/org/chart')).toBeUndefined()
  })
  it('the real router resolves the chart and the masters to different handlers', async () => {
    const { buildRouter } = await import('../src/http/app.ts')
    const router = buildRouter()
    expect(router.match('GET', '/api/v1/org/chart')?.route.meta.summary).toMatch(/chart/i)
    expect(router.match('GET', '/api/v1/org/department')?.route.meta.summary).not.toMatch(/chart/i)
  })
})
