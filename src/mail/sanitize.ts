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

/** Removes anything in a style attribute that could load a URL or run. */
function cleanStyle(style: string): string {
  return style
    // to the end of the declaration, so nested parentheses cannot leave a tail behind
    .replace(/url\s*\([^;]*/gi, '')
    .replace(/expression\s*\([^;]*/gi, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/behavior\s*:[^;]*;?/gi, '')
    .replace(/-moz-binding\s*:[^;]*;?/gi, '')
    .replace(/position\s*:\s*fixed/gi, 'position:static')
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

function cleanAttributes(raw: string, tag: string): string {
  const out: string[] = []
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = m[1]!.toLowerCase()
    if (!ALLOWED_ATTRS.has(name) || name.startsWith('on')) continue
    let value = (m[2] ?? m[3] ?? m[4] ?? '').replace(/[\x00-\x1f]/g, '')
    if (name === 'href' || name === 'src') {
      if (!SAFE_URL.test(value.trim())) continue
      if (name === 'src' && tag !== 'img') continue
    }
    if (name === 'style') value = cleanStyle(value)
    if (name === 'target') value = '_blank'
    out.push(`${name}="${value.replace(/&(?!#?\w+;)/g, '&amp;').replace(/"/g, '&quot;')}"`)
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
