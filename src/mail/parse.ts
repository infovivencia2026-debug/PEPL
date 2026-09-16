/**
 * Parses an RFC 5322 message into what a mailbox shows: an HTML body, a text
 * body and the attachments, with inline images identified by Content-ID.
 *
 * Hand-rolled on purpose. A mail from Gmail or Outlook is multipart/mixed
 * around multipart/alternative around multipart/related, each part encoded
 * base64 or quoted-printable in some charset; that is a few well-specified
 * rules (RFC 2045/2046/2047/2231), not a dependency's worth of behaviour.
 * Anything this does not understand degrades to "a text part", never to a
 * thrown error — a malformed message must still appear in the inbox.
 */

export interface ParsedAttachment {
  fileName: string
  contentType: string
  bytes: Buffer
  /** Set for `Content-Disposition: inline` parts referenced as `cid:` images. */
  contentId: string | null
  inline: boolean
}

export interface ParsedMessage {
  html: string | null
  text: string | null
  attachments: ParsedAttachment[]
}

type Headers = Map<string, string>

/** Unfolds continuation lines and lower-cases names. Last duplicate wins. */
export function parseHeaders(block: string): Headers {
  const headers: Headers = new Map()
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }
  return headers
}

/** `text/html; charset="utf-8"; boundary=abc` -> type + lower-cased params. */
export function parseParams(value: string | undefined): { type: string; params: Record<string, string> } {
  if (!value) return { type: '', params: {} }
  const [type, ...rest] = value.split(';')
  const params: Record<string, string> = {}
  const continued: Record<string, string[]> = {}
  for (const piece of rest) {
    const eq = piece.indexOf('=')
    if (eq < 0) continue
    const name = piece.slice(0, eq).trim().toLowerCase()
    let val = piece.slice(eq + 1).trim().replace(/^"(.*)"$/s, '$1')
    // RFC 2231: filename*=utf-8''caf%C3%A9.pdf, or split as filename*0*=... filename*1*=...
    const cont = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(name)
    if (cont && (cont[2] !== undefined || cont[3])) {
      if (cont[3]) val = safeDecodeUri(val.replace(/^[^']*'[^']*'/, ''))
      ;(continued[cont[1]!] ??= [])[Number(cont[2] ?? 0)] = val
      continue
    }
    params[name] = decodeEncodedWords(val)
  }
  for (const [name, parts] of Object.entries(continued)) params[name] = parts.join('')
  return { type: (type ?? '').trim().toLowerCase(), params }
}

function safeDecodeUri(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

/** RFC 2047 `=?charset?B|Q?...?=` words, anywhere in a header value. */
export function decodeEncodedWords(value: string): string {
  return value
    // adjacent encoded words are joined without the whitespace between them
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset: string, enc: string, data: string) => {
      const bytes = enc.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64')
        : decodeQuotedPrintable(data.replace(/_/g, ' '))
      return decodeCharset(bytes, charset)
    })
}

export function decodeQuotedPrintable(input: string): Buffer {
  const out: number[] = []
  const s = input.replace(/=\r?\n/g, '')          // soft line breaks
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      // headers/bodies are ASCII at this point; anything else is passed through as UTF-8
      for (const b of Buffer.from(c, 'utf8')) out.push(b)
    }
  }
  return Buffer.from(out)
}

/** Decodes bytes in a named charset; unknown names fall back to UTF-8 (lossy, never throwing). */
export function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  const name = (charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '')
  try {
    return new TextDecoder(name === 'us-ascii' || name === 'ascii' ? 'utf-8' : name).decode(bytes)
  } catch {
    return bytes.toString('utf8')
  }
}

function decodeBody(raw: string, encoding: string | undefined): Buffer {
  switch ((encoding ?? '7bit').trim().toLowerCase()) {
    case 'base64': return Buffer.from(raw.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
    case 'quoted-printable': return decodeQuotedPrintable(raw)
    default: return Buffer.from(raw, 'latin1')   // 7bit / 8bit / binary: bytes as they came
  }
}

/** Splits a message or part into its header block and its raw body. */
function splitHeadBody(source: string): { headers: Headers; body: string } {
  const m = /\r?\n\r?\n/.exec(source)
  // no header block at all (a bare text body): everything is body
  if (!/^[A-Za-z][\w-]*:/.test(source)) return { headers: new Map(), body: source }
  if (!m) return { headers: parseHeaders(source), body: '' }
  return { headers: parseHeaders(source.slice(0, m.index)), body: source.slice(m.index + m[0].length) }
}

/** The parts between `--boundary` lines, preamble and epilogue dropped. */
function splitMultipart(body: string, boundary: string): string[] {
  const pieces = body.split(new RegExp(`(?:^|\\r?\\n)--${escapeRegExp(boundary)}(?:--)?[ \\t]*(?=\\r?\\n|$)`))
  // pieces[0] is the preamble; the last is the epilogue after `--boundary--`
  return pieces.slice(1, -1).map((p) => p.replace(/^\r?\n/, ''))
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function walk(source: string, out: ParsedMessage, depth = 0): void {
  if (depth > 20) return
  const { headers, body } = splitHeadBody(source)
  const ct = parseParams(headers.get('content-type') ?? 'text/plain')
  const cd = parseParams(headers.get('content-disposition'))
  const type = ct.type || 'text/plain'

  if (type.startsWith('multipart/')) {
    const boundary = ct.params.boundary
    if (!boundary) return
    // alternative, mixed, related: all walk the same way — text and html
    // parts fill their slot, everything else becomes an attachment
    for (const part of splitMultipart(body, boundary)) walk(part, out, depth + 1)
    return
  }

  if (type === 'message/rfc822' && cd.type !== 'attachment') {
    walk(body, out, depth + 1)
    return
  }

  const bytes = decodeBody(body, headers.get('content-transfer-encoding'))
  const fileName = cd.params.filename ?? ct.params.name
  const isAttachment = cd.type === 'attachment' || (!!fileName && !type.startsWith('text/'))
  const contentId = headers.get('content-id')?.replace(/^<|>$/g, '') ?? null

  if (!isAttachment && type === 'text/html') {
    const html = decodeCharset(bytes, ct.params.charset)
    if (out.html === null || html.length > 0) out.html = html
    return
  }
  if (!isAttachment && type === 'text/plain') {
    const text = decodeCharset(bytes, ct.params.charset)
    out.text = out.text === null ? text : out.text + '\n' + text
    return
  }
  if (!isAttachment && !fileName && !contentId) {
    // an unnamed non-text part with no disposition: nothing a mailbox can show
    return
  }
  out.attachments.push({
    fileName: fileName || (contentId ? `inline-${out.attachments.length + 1}` : `attachment-${out.attachments.length + 1}`),
    contentType: type || 'application/octet-stream',
    bytes,
    contentId,
    inline: cd.type === 'inline' || (!!contentId && cd.type !== 'attachment'),
  })
}

/** The whole message, from its raw source. Never throws. */
export function parseMessage(source: string | Buffer): ParsedMessage {
  const out: ParsedMessage = { html: null, text: null, attachments: [] }
  try {
    walk(Buffer.isBuffer(source) ? source.toString('latin1') : source, out)
  } catch {
    // fall through: whatever was collected before the failure is still shown
  }
  return out
}
