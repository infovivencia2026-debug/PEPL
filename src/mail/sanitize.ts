/**
 * Makes someone else's HTML safe to put inside our page.
 *
 * Allowlist, not blocklist: a tag or attribute that is not named here is
 * dropped, so a new browser feature cannot become a new hole. Scripts, forms,
 * frames and `javascript:` URLs never survive; `style` survives with anything
 * that could fetch or execute removed, because mail without its styling is
 * unreadable and mail with unfiltered styling is a tracking pixel farm.
 *
 * This runs on every HTML body we store — inbound from IMAP and outbound from
 * our own composer — so nothing in `mail_bodies` is ever unsanitised, and the
 * frontend can still render it in a sandboxed iframe as a second layer.
 */

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
  'dd', 'del', 'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
  'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strike',
  'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
])

/** Whose whole content goes too, not just the tag. */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'head', 'title'])

const ALLOWED_ATTRS = new Set([
  'align', 'alt', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'class', 'color', 'colspan',
  'dir', 'face', 'height', 'href', 'lang', 'rowspan', 'size', 'src', 'style', 'target', 'title',
  'valign', 'width',
])

const SAFE_URL = /^(?:https?:|mailto:|tel:|cid:|data:image\/(?:png|jpe?g|gif|webp);base64,|#|\/(?!\/))/i

/**
 * Turns an attribute value into what the BROWSER will see: HTML character references decoded.
 *
 * A browser decodes entities in an attribute BEFORE it interprets the value, so checking the raw text
 * checks something the browser never sees: `&#117;rl(...)` is `url(...)` and `/&#47;evil.com` is
 * `//evil.com` (a protocol-relative link). Numeric references may omit their semicolon; the handful of
 * named ones that spell syntax characters are listed. Anything unlisted is left as it is.
 */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', sol: '/', bsol: '\\', lpar: '(', rpar: ')',
  tab: '\t', newline: '\n', semi: ';', comma: ',', period: '.', lowbar: '_', num: '#', percnt: '%',
}
export function decodeEntities(v: string): string {
  return v.replace(/&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([A-Za-z]{2,8});)/g, (whole, dec: string, hex: string, name: string) => {
    if (name) return NAMED[name.toLowerCase()] ?? whole
    const code = dec ? Number(dec) : parseInt(hex, 16)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  })
}

/** CSS escapes (`\72` / `\000072 ` / `\u`) resolved, and comments removed, as the CSS parser will. */
function cssUnescape(v: string): string {
  return v
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '')
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, h: string) => { const c = parseInt(h, 16); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : '' })
    .replace(/\\([\s\S])/g, '$1')
}

/** Anything in a declaration that can fetch a resource, run script or escape its box. */
const DANGEROUS_CSS = /url\s*\(|(?:-webkit-)?image-set\s*\(|(?<![a-z-])image\s*\(|cross-fade\s*\(|element\s*\(|paint\s*\(|(?<![a-z-])src\s*\(|attr\s*\(|expression\s*\(|@import|behavior\s*:|binding\s*:|javascript:/i

/**
 * Keeps only declarations that cannot load or run anything. Works on the DECODED, UNESCAPED text, so
 * `u\72l(` and `&#117;rl(` are seen as the `url(` they are; a declaration is dropped whole, not patched.
 */
function cleanStyle(style: string): string {
  return cssUnescape(style)
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !DANGEROUS_CSS.test(d))
    .map((d) => d.replace(/position\s*:\s*fixed/gi, 'position:static'))
    .join(';')
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

function cleanAttributes(raw: string, tag: string): string {
  const out: string[] = []
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = m[1]!.toLowerCase()
    if (!ALLOWED_ATTRS.has(name) || name.startsWith('on')) continue
    // What the browser will see: references decoded first, THEN checked, then re-encoded on output.
    let value = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '').replace(/[\x00-\x1f\x7f]/g, '')
    if (name === 'href' || name === 'src') {
      if (!SAFE_URL.test(value.trim())) continue
      if (name === 'src' && tag !== 'img') continue
    }
    if (name === 'style') {
      value = cleanStyle(value)
      if (!value) continue
    }
    if (name === 'target') value = '_blank'
    out.push(`${name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"`)
  }
  if (tag === 'a' && out.some((a) => a.startsWith('href='))) out.push('rel="noopener noreferrer"', 'target="_blank"')
  // de-duplicate (target may appear twice for an anchor)
  return [...new Set(out)].join(' ')
}

export function sanitizeHtml(input: string | null | undefined): string {
  if (!input) return ''
  let html = input
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')

  for (const tag of DROP_WITH_CONTENT) {
    html = html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '')
    html = html.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '')
  }

  return html.replace(/<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g, (_whole, slash: string, rawTag: string, attrs: string) => {
    const tag = rawTag.toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) return ''
    if (slash) return `</${tag}>`
    const cleaned = cleanAttributes(attrs.replace(/\/\s*$/, ''), tag)
    const selfClose = tag === 'br' || tag === 'hr' || tag === 'img' || tag === 'col'
    return `<${tag}${cleaned ? ' ' + cleaned : ''}${selfClose ? ' /' : ''}>`
  })
}

/** Rewrites `cid:` image references to the URL that serves the stored part. */
export function resolveInlineImages(html: string, byContentId: ReadonlyMap<string, string>): string {
  return html.replace(/src="cid:([^"]+)"/gi, (whole, cid: string) => {
    const url = byContentId.get(decodeURIComponent(cid))
    return url ? `src="${url}"` : whole
  })
}
