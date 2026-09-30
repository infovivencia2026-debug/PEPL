/**
 * Structural check of a row-level-security policy, used by `gate:rls`.
 *
 * The gate used to join USING and WITH CHECK into one string and look for
 * `current_tenant()` anywhere in it. That accepts, among others:
 *
 *   USING (tenant_id = current_tenant())  WITH CHECK (true)        -- write any tenant's row
 *   USING (tenant_id = current_tenant() OR true)                   -- read every tenant's row
 *
 * The rule here is per clause, and it reads the boolean structure of the expression
 * (as Postgres deparses it in pg_policies) instead of searching for a substring:
 *
 *   - an AND is safe when AT LEAST ONE conjunct is tenant-guarded (the others narrow);
 *   - an OR is safe only when EVERY disjunct is tenant-guarded, or is the one reviewed
 *     exemption for the owner role (`CURRENT_USER = 'pepl_owner'`, which is what lets a
 *     SECURITY DEFINER identity lookup read across companies);
 *   - anything else -- `true`, `1 = 1`, an unrelated column test -- is not a guard.
 */

export interface PolicyRow {
  table: string
  name: string
  /** pg_policies.cmd: ALL | SELECT | INSERT | UPDATE | DELETE */
  cmd: string
  qual: string | null
  withCheck: string | null
}

/** The only disjunct allowed beside a tenant guard. It is a reviewed decision, not a pattern. */
const OWNER_EXEMPTION = /^current_user\s*=\s*'pepl_owner'(::name)?$/i

type Op = 'AND' | 'OR'

/** Remove any number of redundant outer parentheses: "((a))" -> "a", but not "(a) OR (b)". */
function unwrap(expr: string): string {
  let s = expr.trim()
  while (s.startsWith('(') && s.endsWith(')') && closesAtEnd(s)) s = s.slice(1, -1).trim()
  return s
}

/** True when the paren opened at index 0 is the one closed at the very end. */
function closesAtEnd(s: string): boolean {
  let depth = 0
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === "'") quoted = !quoted
    if (quoted) continue
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0 && i < s.length - 1) return false
    }
  }
  return depth === 0
}

/** Split on a top-level AND / OR only, ignoring anything inside parentheses or quotes. */
function splitTop(expr: string, op: Op): string[] {
  const parts: string[] = []
  const word = ` ${op} `
  let depth = 0
  let quoted = false
  let start = 0
  const upper = expr.toUpperCase()
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]
    if (ch === "'") quoted = !quoted
    if (quoted) continue
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && upper.startsWith(word, i)) {
      parts.push(expr.slice(start, i))
      i += word.length - 1
      start = i + 1
    }
  }
  parts.push(expr.slice(start))
  return parts.map((p) => p.trim())
}

/** True when the expression can only be satisfied inside the caller's own tenant. */
export function isTenantGuarded(expression: string): boolean {
  const e = unwrap(expression.replace(/\s+/g, ' '))
  const ors = splitTop(e, 'OR')
  if (ors.length > 1) {
    // Every way to satisfy an OR must be safe; one open branch opens the whole thing.
    return ors.every((d) => OWNER_EXEMPTION.test(unwrap(d)) || isTenantGuarded(d))
  }
  const ands = splitTop(e, 'AND')
  if (ands.length > 1) return ands.some((c) => isTenantGuarded(c))
  // An atom. It must actually compare against the caller's tenant.
  // (`<>` and `!=` contain no `=` directly before the call, so they do not qualify.)
  return /(=\s*current_tenant\(\))|(current_tenant\(\)\s*=)/i.test(e) && !/^not\b/i.test(e)
}

/** Every reason this policy does not isolate tenants. Empty when it does. */
export function lintPolicy(p: PolicyRow): string[] {
  const problems: string[] = []
  const at = `policy "${p.name}" on "${p.table}"`
  const needsUsing = ['ALL', 'SELECT', 'UPDATE', 'DELETE'].includes(p.cmd)
  const needsCheck = ['ALL', 'INSERT'].includes(p.cmd)

  if (needsUsing) {
    if (!p.qual) problems.push(`${at} has no USING clause`)
    else if (!isTenantGuarded(p.qual)) {
      problems.push(`${at}: USING does not confine reads to current_tenant() (${brief(p.qual)})`)
    }
  }
  if (needsCheck) {
    if (!p.withCheck) problems.push(`${at} has no WITH CHECK clause - a tenant could write another tenant's row`)
    else if (!isTenantGuarded(p.withCheck)) {
      problems.push(`${at}: WITH CHECK does not confine writes to current_tenant() (${brief(p.withCheck)})`)
    }
  }
  return problems
}

const brief = (s: string): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > 90 ? `${one.slice(0, 87)}...` : one
}
