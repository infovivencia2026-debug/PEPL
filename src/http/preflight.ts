/**
 * What has to be true before this process serves a real customer.
 *
 * Every one of these was already possible to get wrong, and none of them
 * announced itself: the server started, answered /health, and then quietly did
 * the wrong thing. A missing PEPL_MAIL_KEY means mailboxes and integrations
 * cannot store a credential — the outbox runs nightly and sends nothing. A
 * missing GSTIN means every invoice prints "not a tax invoice". A dev password
 * that reached production means the database is open to anyone who has read
 * the repository.
 *
 * Two severities, and the line between them is whether the mistake is
 * recoverable once noticed:
 *
 *   REFUSE — the process exits. Shipping the development credentials, or
 *            pointing production at the test database, cannot be walked back
 *            after it has served traffic.
 *   WARN   — the process starts and says what is degraded. A missing mail key
 *            breaks a feature; it does not endanger the data.
 *
 * Only in production. A developer running `npm run api` against a local
 * Postgres is not misconfigured, and a preflight that cries wolf in
 * development is one people learn to skip.
 */
export interface Finding {
  level: 'refuse' | 'warn'
  key: string
  message: string
}

/** Defaults from .env.example. Fine on a laptop, catastrophic in production. */
const DEV_SECRETS: ReadonlyArray<[string, string]> = [
  ['SUPER_PASSWORD', 'postgres'],
  ['OWNER_PASSWORD', 'pepl_owner_dev'],
  ['APP_PASSWORD', 'pepl_app_dev'],
]

export function inspect(env: NodeJS.ProcessEnv = process.env): Finding[] {
  const findings: Finding[] = []
  const has = (k: string) => (env[k] ?? '').trim().length > 0

  for (const [key, devValue] of DEV_SECRETS) {
    if ((env[key] ?? '') === devValue) {
      findings.push({
        level: 'refuse', key,
        message: `is still the development value from .env.example — anyone who has read the repository knows it`,
      })
    }
  }

  // Read from the env passed in, not from `config`: that module snapshots the
  // real process environment once at import, so mixing the two makes this
  // untestable and — worse — makes it answer about the wrong environment.
  if ((env.PEPL_DB ?? 'pepl_test') === 'pepl_test') {
    findings.push({
      level: 'refuse', key: 'PEPL_DB',
      message: 'points at the test database, which the suites TRUNCATE on every run',
    })
  }

  if (!has('PEPL_MAIL_KEY')) {
    findings.push({
      level: 'warn', key: 'PEPL_MAIL_KEY',
      message: 'is not set: mailboxes and integrations cannot store a credential, so the outbox will send nothing',
    })
  }

  if (!has('PEPL_PUBLIC_URL')) {
    findings.push({
      level: 'warn', key: 'PEPL_PUBLIC_URL',
      message: 'is not set: links in invitations and password resets will not point anywhere useful',
    })
  }

  if (!has('PEPL_OBJECT_STORE_BUCKET')) {
    findings.push({
      level: 'warn', key: 'PEPL_OBJECT_STORE_BUCKET',
      message: 'is not set: uploaded documents are stored in Postgres, which does not scale and bloats every backup',
    })
  }

  if (!has('PEPL_GSTIN')) {
    findings.push({
      level: 'warn', key: 'PEPL_GSTIN',
      message: 'is not set: every invoice will print "not a tax invoice" and no customer can claim input credit',
    })
  }

  if (!has('PEPL_BANK_ACCOUNT_NUMBER') || !has('PEPL_BANK_IFSC')) {
    findings.push({
      level: 'warn', key: 'PEPL_BANK_ACCOUNT_NUMBER',
      message: 'is not set: invoices ask for a transfer and name no account to transfer to',
    })
  }

  return findings
}

/**
 * Runs the checks and, in production, refuses to continue on anything fatal.
 * Returns the findings so a caller (or a test) can read them.
 */
export function preflight(
  env: NodeJS.ProcessEnv = process.env,
  exit: (code: number) => never = process.exit,
): Finding[] {
  if (env.NODE_ENV !== 'production') return []

  const findings = inspect(env)
  for (const f of findings) {
    console.error(JSON.stringify({
      t: new Date().toISOString(),
      level: f.level === 'refuse' ? 'error' : 'warn',
      msg: 'preflight',
      key: f.key,
      detail: `${f.key} ${f.message}`,
    }))
  }

  const fatal = findings.filter((f) => f.level === 'refuse')
  if (fatal.length) {
    console.error(JSON.stringify({
      t: new Date().toISOString(), level: 'error', msg: 'preflight failed',
      detail: `${fatal.length} setting(s) must be corrected before this server can serve a customer`,
    }))
    exit(1)
  }
  return findings
}
