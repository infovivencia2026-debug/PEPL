import 'dotenv/config'

const need = (k: string, fallback?: string): string => {
  const v = process.env[k] ?? fallback
  if (v === undefined) throw new Error(`missing env ${k}`)
  return v
}

// A PASSWORD's development default is convenient on a laptop and catastrophic anywhere
// else: in production a missing one used to be silently replaced by the value that is
// printed in .env.example, and bootstrap then set the database roles to it. Production
// therefore has no fallback -- it stops, naming the variable.
const secret = (k: string, devDefault: string): string =>
  process.env.NODE_ENV === 'production' ? need(k) : need(k, devDefault)

export const config = {
  host: need('PGHOST', 'localhost'),
  port: Number(need('PGPORT', '5432')),
  superUser: need('SUPER_USER', 'postgres'),
  superPassword: secret('SUPER_PASSWORD', 'postgres'),
  db: need('PEPL_DB', 'pepl_test'),
  ownerUser: need('OWNER_USER', 'pepl_owner'),
  ownerPassword: secret('OWNER_PASSWORD', 'pepl_owner_dev'),
  appUser: need('APP_USER', 'pepl_app'),
  appPassword: secret('APP_PASSWORD', 'pepl_app_dev'),
} as const
