/**
 * Trust page and security posture (D3). Uptime is derived from heartbeat
 * samples; status follows the open incident; the tenant posture counts MFA
 * adoption among admins, verifies the audit chain and turns the gaps into
 * advice and a score.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { resolveConfig } from '../src/config/resolver.ts'
import { setSetting } from '../src/config/write.ts'
import { controlDb } from '../src/control-plane/index.ts'
import { recordUptimeSample, uptime, postIncident, updateIncident, trustPage, securityPosture, COMMITMENTS } from '../src/control-plane/trust.ts'

let A: Tenant; let admin: string
beforeAll(async () => {
  A = (await resetAndSeed()).a
  admin = await withTenant(A.id, (tx) => createUser(tx, { tenantId: A.id, email: 'tadmin@alpha.test', fullName: 'Alpha Admin', password: 'a-long-password-1', roles: ['org_admin'] }))
  await withTenant(A.id, (tx) => createUser(tx, { tenantId: A.id, email: 'thr@alpha.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin'] }))
  await controlDb.query(`DELETE FROM control_plane.incidents`)
  await controlDb.query(`DELETE FROM control_plane.uptime_samples`)
})
afterAll(async () => { await closePools(); await controlPool.end(); await controlDb.end() })

describe('trust page', () => {
  it('uptime from samples, status from incidents, commitments listed', async () => {
    await recordUptimeSample()
    await controlDb.query(`INSERT INTO control_plane.uptime_samples (sampled_at, ready, latency_ms) VALUES (now() - interval '1 hour', true, 12), (now() - interval '2 hours', false, NULL), (now() - interval '3 hours', true, 40)`)
    const u = await uptime(30)
    expect(u.samples).toBe(4)
    expect(u.readyPct).toBe(75)
    expect(u.p95LatencyMs).toBeGreaterThan(0)
    let page = await trustPage()
    expect(page.status).toBe('operational')
    expect(page.commitments.length).toBe(COMMITMENTS.length)
    expect(page.commitments.map((c) => c.key)).toContain('tenant_isolation')
    const id = await postIncident({ severity: 'degraded', title: 'Slow payslip PDFs', note: 'Investigating' })
    page = await trustPage()
    expect(page.status).toBe('degraded')
    expect(page.incidents[0]).toMatchObject({ title: 'Slow payslip PDFs', resolved_at: null })
    await updateIncident({ id, note: 'Fixed: renderer pool resized', resolved: true })
    page = await trustPage()
    expect(page.status).toBe('operational')
    expect(page.incidents[0]!.updates).toHaveLength(2)
  })
})

describe('security posture', () => {
  it('counts admins and MFA, verifies the chain, advises', async () => {
    await withTenant(A.id, async (tx) => {
      const cfg = await resolveConfig(tx, A.id)
      const p = await securityPosture(tx, cfg, A.id)
      expect(p.mfa).toMatchObject({ admins: 2, adminsWithMfa: 0, requiredForAdmins: false })
      expect(p.admins.map((a) => a.email).sort()).toEqual(['tadmin@alpha.test', 'thr@alpha.test'])
      expect(p.audit.chainOk).toBe(true)
      expect(p.anomalies).toEqual({ openBlocking: 0, openWarnings: 0 })
      expect(p.advice.join(' ')).toMatch(/Require two-factor/)
      expect(p.advice.join(' ')).toMatch(/2 administrator\(s\) have not enrolled/)
      expect(p.score).toBe(65)
      // requiring MFA for admins lifts the score
      await setSetting(tx, { key: 'security.mfa_required_for_admins', value: true, actorUserId: admin, reason: 'test' })
      const p2 = await securityPosture(tx, await resolveConfig(tx, A.id), A.id)
      expect(p2.mfa.requiredForAdmins).toBe(true)
      expect(p2.score).toBe(85)
    })
  })
})
