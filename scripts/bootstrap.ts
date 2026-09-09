/**
 * Control-plane bootstrap: creates the roles and the database.
 * Runs as a superuser; never used at runtime.
 * Idempotent — safe to re-run.
 */
import pg from 'pg'
import { config } from '../src/config.ts'

const superCfg = {
  host: config.host, port: config.port,
  user: config.superUser, password: config.superPassword,
}

async function main(): Promise<void> {
  const admin = new pg.Client({ ...superCfg, database: 'postgres' })
  await admin.connect()

  for (const [role, pass, opts] of [
    [config.ownerUser, config.ownerPassword, 'NOBYPASSRLS'],
    [config.appUser, config.appPassword, 'NOBYPASSRLS'],
  ] as const) {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])
    if (rowCount === 0) {
      await admin.query(`CREATE ROLE ${pg.escapeIdentifier(role)} LOGIN PASSWORD ${pg.escapeLiteral(pass)} ${opts}`)
      console.log(`created role ${role}`)
    } else {
      await admin.query(`ALTER ROLE ${pg.escapeIdentifier(role)} WITH LOGIN PASSWORD ${pg.escapeLiteral(pass)} ${opts}`)
      console.log(`role ${role} ok`)
    }
  }

  const db = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [config.db])
  if (db.rowCount === 0) {
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(config.db)} OWNER ${pg.escapeIdentifier(config.ownerUser)}`)
    console.log(`created database ${config.db}`)
  } else {
    console.log(`database ${config.db} ok`)
  }
  await admin.end()

  // Extensions require superuser; the owner cannot install them.
  const inDb = new pg.Client({ ...superCfg, database: config.db })
  await inDb.connect()
  await inDb.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await inDb.query('CREATE EXTENSION IF NOT EXISTS btree_gist')
  await inDb.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(config.db)} TO ${pg.escapeIdentifier(config.appUser)}`)
  await inDb.end()
  console.log('bootstrap complete')
}

main().catch((e) => { console.error(e); process.exit(1) })
