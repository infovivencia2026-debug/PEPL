/**
 * A search term for `ILIKE '%' || $n || '%'`, with the pattern characters made literal.
 *
 * Typed as-is, "%" matched everybody and "_" matched any single character, so searching for
 * "100%" or "a_b" returned rows that did not contain them. Backslash is the default LIKE escape.
 */
export const likeTerm = (term: string | null | undefined): string | null => {
  const t = term?.trim()
  return t ? t.replace(/[\\%_]/g, '\\$&') : null
}
