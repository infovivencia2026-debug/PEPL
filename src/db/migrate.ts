/** Forward-only migration runner. Applies db/migrations/*.sql in filename order. */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { config } from '../config.ts'

const DIR = join(process.cwd(), 'db', 'migrations')

export async function migrate(): Promise<string[]> {
  const client = new pg.Client({
    host: config.host, port: config.port, database: config.db,
    user: config.ownerUser, password: config.ownerPassword,
  })
  await client.connect()
  const applied: string[] = []
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
    // The app role name is read by 003_grants.sql.
    await client.query(`SELECT set_config('pepl.app_role', $1, false)`, [config.appUser])

    const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort()
    for (const file of files) {
      const done = await client.query('SELECT 1 FROM _migrations WHERE name = $1', [file])
      if (done.rowCount) continue
      const sql = await readFile(join(DIR, file), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
        applied.push(file)
        console.log(`applied ${file}`)
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`migration ${file} failed: ${(err as Error).message}`)
      }
    }
  } finally {
    await client.end()
  }
  return applied
}

// Windows: process.argv[1] is a backslash path while import.meta.url is a
// percent-encoded file URL, so a string compare never matches. pathToFileURL
// normalises both sides.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().then((a) => console.log(a.length ? `${a.length} migration(s) applied` : 'up to date'))
    .catch((e) => { console.error(e.message); process.exit(1) })
}
