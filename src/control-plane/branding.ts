/**
 * Per-tenant branding: what the company's people see as "the app".
 *
 * Product name, colours and logo on the login page and the shell; a header
 * and footer line on payslips and letters; a footer on every email; a custom
 * domain that resolves to the tenant before anyone signs in (owner-run lookup,
 * like auth_user_by_email). White-label for resellers is this table with the
 * product name changed.
 */
import type { PoolClient } from 'pg'
import { appPool } from '../db/pool.ts'

export class BrandingError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'BrandingError' }
}
export interface Branding { product_name: string | null; logo_document_id: string | null; primary_color: string | null; accent_color: string | null; payslip_header: string | null; payslip_footer: string | null; email_footer: string | null; custom_domain: string | null }
const COLS = `product_name, logo_document_id, primary_color, accent_color, payslip_header, payslip_footer, email_footer, custom_domain`
const HEX = /^#[0-9a-fA-F]{6}$/
const DOMAIN = /^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i

export async function getBranding(tx: PoolClient): Promise<Branding> {
  return (await tx.query<Branding>(`SELECT ${COLS} FROM tenant_branding`)).rows[0] ?? { product_name: null, logo_document_id: null, primary_color: null, accent_color: null, payslip_header: null, payslip_footer: null, email_footer: null, custom_domain: null }
}
export async function setBranding(tx: PoolClient, b: Partial<Branding> & { productName?: string | null; logoDocumentId?: string | null; primaryColor?: string | null; accentColor?: string | null; payslipHeader?: string | null; payslipFooter?: string | null; emailFooter?: string | null; customDomain?: string | null }): Promise<Branding> {
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  const cur = await getBranding(tx)
  const next: Branding = {
    product_name: b.productName === undefined ? cur.product_name : (b.productName?.trim().slice(0, 40) || null),
    logo_document_id: b.logoDocumentId === undefined ? cur.logo_document_id : b.logoDocumentId,
    primary_color: b.primaryColor === undefined ? cur.primary_color : b.primaryColor,
    accent_color: b.accentColor === undefined ? cur.accent_color : b.accentColor,
    payslip_header: b.payslipHeader === undefined ? cur.payslip_header : (b.payslipHeader?.trim().slice(0, 200) || null),
    payslip_footer: b.payslipFooter === undefined ? cur.payslip_footer : (b.payslipFooter?.trim().slice(0, 300) || null),
    email_footer: b.emailFooter === undefined ? cur.email_footer : (b.emailFooter?.trim().slice(0, 500) || null),
    custom_domain: b.customDomain === undefined ? cur.custom_domain : (b.customDomain?.trim().toLowerCase() || null),
  }
  for (const c of [next.primary_color, next.accent_color]) if (c && !HEX.test(c)) throw new BrandingError('VALIDATION_FAILED', 'colours are #rrggbb')
  if (next.custom_domain && !DOMAIN.test(next.custom_domain)) throw new BrandingError('VALIDATION_FAILED', 'customDomain must be a hostname like hr.acme.in')
  if (next.logo_document_id && !(await tx.query(`SELECT 1 FROM documents WHERE id = $1 AND owner_type = 'tenant' AND content_type LIKE 'image/%'`, [next.logo_document_id])).rowCount) throw new BrandingError('VALIDATION_FAILED', 'logoDocumentId must be an image uploaded as a company document')
  // Pre-check through the owner lookup: a unique violation would abort the caller's transaction.
  if (next.custom_domain) {
    const taken = (await tx.query<{ tenant_id: string }>(`SELECT tenant_id FROM branding_by_domain($1)`, [next.custom_domain])).rows[0]
    if (taken && taken.tenant_id !== tid) throw new BrandingError('DOMAIN_TAKEN', 'that domain is already used by another company')
  }
  {
    await tx.query(
      `INSERT INTO tenant_branding (tenant_id, ${COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id) DO UPDATE SET product_name = EXCLUDED.product_name, logo_document_id = EXCLUDED.logo_document_id, primary_color = EXCLUDED.primary_color, accent_color = EXCLUDED.accent_color,
         payslip_header = EXCLUDED.payslip_header, payslip_footer = EXCLUDED.payslip_footer, email_footer = EXCLUDED.email_footer, custom_domain = EXCLUDED.custom_domain, updated_at = now()`,
      [tid, next.product_name, next.logo_document_id, next.primary_color, next.accent_color, next.payslip_header, next.payslip_footer, next.email_footer, next.custom_domain])
  }
  return getBranding(tx)
}

/** Pre-login: the branding for the host the browser came from. Nothing else about the tenant is revealed. */
export async function brandingForHost(host: string): Promise<{ tenantId: string; productName: string | null; primaryColor: string | null; accentColor: string | null; logoDocumentId: string | null } | null> {
  const domain = host.split(':')[0]!.toLowerCase()
  if (!DOMAIN.test(domain)) return null
  const client = await appPool.connect()
  try {
    const { rows } = await client.query<{ tenant_id: string; product_name: string | null; primary_color: string | null; accent_color: string | null; logo_document_id: string | null }>(`SELECT * FROM branding_by_domain($1)`, [domain])
    const r = rows[0]
    return r ? { tenantId: r.tenant_id, productName: r.product_name, primaryColor: r.primary_color, accentColor: r.accent_color, logoDocumentId: r.logo_document_id } : null
  } finally { client.release() }
}
