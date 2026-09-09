/**
 * Drops and recreates the development database, then re-applies every migration.
 * Pre-launch convenience only: once PEPL has a deployment, migrations are
 * forward-only and a schema change means a NEW numbered migration.
 */
import pg from 'pg'
import { config } from '../src/config.ts'

const admin = new pg.Client({
  host: config.host, port: config.port,
  user: config.superUser, password: config.superPassword, database: 'postgres',
})
await admin.connect()
await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [config.db])
await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(config.db)}`)
await admin.end()
console.log(`dropped ${config.db}`)
