import 'dotenv/config'

const need = (k: string, fallback?: string): string => {
  const v = process.env[k] ?? fallback
  if (v === undefined) throw new Error(`missing env ${k}`)
  return v
}

export const config = {
  host: need('PGHOST', 'localhost'),
  port: Number(need('PGPORT', '5432')),
  superUser: need('SUPER_USER', 'postgres'),
  superPassword: need('SUPER_PASSWORD', 'postgres'),
  db: need('PEPL_DB', 'pepl_test'),
  ownerUser: need('OWNER_USER', 'pepl_owner'),
  ownerPassword: need('OWNER_PASSWORD', 'pepl_owner_dev'),
  appUser: need('APP_USER', 'pepl_app'),
  appPassword: need('APP_PASSWORD', 'pepl_app_dev'),
} as const
