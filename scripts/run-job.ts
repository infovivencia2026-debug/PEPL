/**
 * Job runner. Cron calls this; it is not a long-lived scheduler process, so a
 * crashed job cannot silently stop firing.
 *
 *   npm run job leave.accrual
 */
import { JOBS, type JobName } from '../src/jobs/index.ts'
import { closePools } from '../src/db/pool.ts'
import { controlDb } from '../src/control-plane/index.ts'

const name = process.argv[2] as JobName | undefined
if (!name || !(name in JOBS)) {
  console.error(`usage: npm run job <${Object.keys(JOBS).join('|')}>`)
  process.exit(1)
}

const result = await JOBS[name]()
console.log(JSON.stringify(result, null, 2))
await closePools()
await controlDb.end()
process.exit(result.errors.length ? 1 : 0)
