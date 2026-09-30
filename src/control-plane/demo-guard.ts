/**
 * Where `npm run seed:demo` may run.
 *
 * The demo company is built for a laptop or a sales sandbox: it plants an organisation
 * administrator with a password that is printed in docs/SELLING.md, and it replaces any
 * tenant of the same name. Neither belongs anywhere that holds a customer.
 *
 * Returns the reason it must not run, or null when it may. A database outside the known
 * development names needs PEPL_ALLOW_DEMO_SEED set to that database's exact NAME: "1" or
 * "yes" would be a habit, and a name is a decision about one database.
 */
const DEMO_DATABASES: readonly string[] = ['pepl_dev', 'pepl_test', 'pepl_demo']

export function demoSeedRefusal(env: NodeJS.ProcessEnv): string | null {
  if (env.NODE_ENV === 'production') {
    return 'NODE_ENV is production: the demo company has a published password and is never seeded there'
  }
  const db = (env.PEPL_DB ?? '').trim()
  if (db === '') {
    return 'PEPL_DB is not set, so it is not known which database this would write to'
  }
  if (DEMO_DATABASES.includes(db)) return null
  if (env.PEPL_ALLOW_DEMO_SEED === db) return null
  return `database "${db}" is not one of ${DEMO_DATABASES.join(', ')}; ` +
    `to seed it deliberately, set PEPL_ALLOW_DEMO_SEED=${db}`
}
