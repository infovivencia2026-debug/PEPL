/**
 * The restore drill, automated: a backup nobody has restored is a hope.
 *
 *   npm run drill:restore
 *
 * 1. pg_dump the configured database (custom format, --no-owner) to a temp file
 * 2. create a scratch database and pg_restore into it
 * 3. compare row counts table by table with the source
 * 4. check every tenant table still has RLS and FORCE (a dump made with the
 *    wrong flags silently drops policies)
 * 5. re-walk the audit hash chain in the restored copy as the RUNTIME role
 * 6. drop the scratch database, keep the dump
 *
 * Exits non-zero on any difference. Uses the same pg_dump/pg_restore an
 * operator would, from PATH, so what passes here is what the runbook says.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { config } from '../src/config.ts'
import { verifyChain } from '../src/audit/index.ts'
import { isGlobal, isTenantRoot } from '../src/db/table-classification.ts'

const superEnv = { ...process.env, PGPASSWORD: config.superPassword }
const run = (cmd: string, args: string[]): void => {
  const r = spawnSync(cmd, args, { env: superEnv, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr || r.stdout}`)
}
const conn = (database: string, user = config.superUser, password = config.superPassword) =>
  new pg.Client({ host: config.host, port: config.port, database, user, password })

async function tableCounts(c: pg.Client): Promise<Map<string, number>> {
  const { rows } = await c.query<{ t: string }>(
    `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)
  const out = new Map<string, number>()
  for (const { t } of rows) {
    const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${JSON.stringify(t)}`)
    out.set(t, Number(r.rows[0]!.n))
  }
  return out
}

export async function restoreDrill(): Promise<{ tables: number; rows: number; dumpBytes: number; chainChecked: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'pepl-drill-'))
  const dump = join(dir, `${config.db}-${new Date().toISOString().replace(/[:.]/g, '')}.dump`)
  const scratch = `${config.db}_drill_${Date.now().toString(36)}`
  const src = conn(config.db)
  const admin = conn('postgres')
  await src.connect(); await admin.connect()
  // A hang here is a lock somebody else holds; say so instead of waiting forever.
  await admin.query(`SET statement_timeout = '60s'`); await src.query(`SET statement_timeout = '60s'`)
  // An interrupted run (a crash, a Ctrl-C) leaves its scratch database behind.
  // Sweep anything older than an hour before making a new one.
  const { rows: stale } = await admin.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname LIKE $1 AND (pg_stat_file('base/' || oid || '/PG_VERSION')).modification < now() - interval '1 hour'", [config.db + '_drill_%']).catch(() => ({ rows: [] }))
  for (const d of stale) await admin.query(`DROP DATABASE IF EXISTS ${d.datname} WITH (FORCE)`).catch(() => undefined)

  let scratchClient: pg.Client | null = null
  let appClient: pg.Client | null = null
  try {
    // 1. dump
    run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--lock-wait-timeout=20000', '-h', config.host, '-p', String(config.port), '-U', config.superUser, '-d', config.db, '-f', dump])
    const dumpBytes = statSync(dump).size

    // 2. restore into a fresh database
    await admin.query(`CREATE DATABASE ${scratch}`)
    run('pg_restore', ['--no-owner', '--no-privileges', '-h', config.host, '-p', String(config.port), '-U', config.superUser, '-d', scratch, dump])

    // 3. counts
    scratchClient = conn(scratch)
    await scratchClient.connect()
    const before = await tableCounts(src)
    const after = await tableCounts(scratchClient)
    const diffs: string[] = []
    for (const [t, n] of before) if (after.get(t) !== n) diffs.push(`${t}: ${n} → ${after.get(t) ?? 'missing'}`)
    for (const t of after.keys()) if (!before.has(t)) diffs.push(`${t}: not in source`)
    if (diffs.length) throw new Error(`row counts differ after restore:\n  ${diffs.join('\n  ')}`)

    // 4. RLS and FORCE survived
    const { rows: rls } = await scratchClient.query<{ t: string; enabled: boolean; forced: boolean; policies: string }>(
      `SELECT c.relname AS t, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname)::text AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`)
    const unprotected = rls.filter((r) => !isGlobal(r.t) && !isTenantRoot(r.t) && !(r.enabled && r.forced && Number(r.policies) > 0))
    if (unprotected.length) throw new Error(`RLS lost in restore on: ${unprotected.map((u) => u.t).join(', ')}`)

    // 5. the audit chain, as the runtime role would read it. --no-privileges
    // dropped the grants, so re-grant what the app role holds in production.
    await scratchClient.query(`GRANT USAGE ON SCHEMA public TO ${config.appUser}`)
    await scratchClient.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${config.appUser}`)
    appClient = conn(scratch, config.appUser, config.appPassword)
    await appClient.connect()
    const { rows: tenants } = await scratchClient.query<{ id: string }>(`SELECT id FROM tenants`)
    let chainChecked = 0
    for (const t of tenants) {
      await appClient.query('BEGIN')
      await appClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [t.id])
      const check = await verifyChain(appClient as unknown as pg.PoolClient)
      await appClient.query('COMMIT')
      if (!check.ok) throw new Error(`audit chain broken in restored copy for tenant ${t.id} at ${check.brokenAtId}`)
      chainChecked += check.checked
    }
    return { tables: before.size, rows: [...before.values()].reduce((a, b) => a + b, 0), dumpBytes, chainChecked }
  } finally {
    await appClient?.end().catch(() => undefined)
    await scratchClient?.end().catch(() => undefined)
    await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch(() => undefined)
    await admin.end(); await src.end()
    console.log(`dump kept at ${dump}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  restoreDrill().then((r) => {
    console.log(`restore drill PASSED: ${r.tables} tables, ${r.rows} rows, ${(r.dumpBytes / 1024).toFixed(0)} KB dump, ${r.chainChecked} audit events re-verified`)
  }).catch((err) => {
    console.error(`restore drill FAILED: ${(err as Error).message}`)
    process.exit(1)
  })
}
