import pg from 'pg'
import { config } from '../config.ts'

const base = { host: config.host, port: config.port, database: config.db }

/** Runtime role: non-owner, NOBYPASSRLS. Every application query uses this. */
export const appPool = new pg.Pool({ ...base, user: config.appUser, password: config.appPassword })

/** Migration/DDL role. Owns the tables. Never used to serve a request. */
export const ownerPool = new pg.Pool({ ...base, user: config.ownerUser, password: config.ownerPassword })

export async function closePools(): Promise<void> {
  await Promise.all([appPool.end(), ownerPool.end()])
}
