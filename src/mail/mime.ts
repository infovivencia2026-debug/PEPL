/**
 * Builds an RFC 5322 message.
 *
 * Base64 for every body part rather than quoted-printable: the encoder is three
 * lines instead of thirty, it cannot produce a line over 998 octets, and it is
 * immune to the trailing-whitespace and bare-CR mangling that makes
 * quoted-printable bugs so hard to see.
 */
import { randomUUID } from 'node:crypto'

export interface Attachment {
  fileName: string
  contentType: string
  bytes: Buffer
}

export interface MessageInput {
  from: { name?: string | null; address: string }
  to: readonly string[]
  cc?: readonly string[]
  /** Never a Bcc header: those recipients exist only in the SMTP envelope. */
  replyTo?: string | null
  subject: string
  bodyHtml: string
  bodyText?: string
  messageId: string
  inReplyTo?: string | null
  attachments?: readonly Attachment[]
  date?: Date
}

/** Folds base64 to 76 characters, as the MIME spec requires. */
function base64Lines(input: Buffer | string): string {
  const encoded = Buffer.isBuffer(input)
    ? input.toString('base64')
    : Buffer.from(input, 'utf8').toString('base64')
  return (encoded.match(/.{1,76}/g) ?? []).join('\r\n')
}

/**
 * Encodes a header value that is not plain ASCII.
 *
 * A subject with a rupee sign or a name with an accent is otherwise silently
 * corrupted somewhere between here and the recipient.
 */
export function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function address(entry: { name?: string | null; address: string }): string {
  return entry.name ? `${encodeHeader(entry.name)} <${entry.address}>` : entry.address
}

/** Strips tags for the plain-text alternative, so a text-only client sees words. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The full message.
 *
 * Structure follows what mail clients expect: `multipart/mixed` only when there
 * are attachments, wrapping a `multipart/alternative` of text and HTML. A single
 * unnecessary layer of multipart is enough to make some clients show an empty
 * body with a paperclip.
 */
export function buildMessage(input: MessageInput): string {
  const boundaryAlt = `alt-${randomUUID()}`
  const boundaryMixed = `mix-${randomUUID()}`
  const text = input.bodyText ?? htmlToText(input.bodyHtml)
  const attachments = input.attachments ?? []

  const headers: string[] = [
    `From: ${address(input.from)}`,
    `To: ${input.to.join(', ')}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(', ')}`] : []),
    ...(input.replyTo ? [`Reply-To: ${input.replyTo}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${(input.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${input.messageId}>`,
    ...(input.inReplyTo
      ? [`In-Reply-To: <${input.inReplyTo}>`, `References: <${input.inReplyTo}>`]
      : []),
    'MIME-Version: 1.0',
  ]

  const alternative = [
    `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
    '',
    `--${boundaryAlt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
    '',
    `--${boundaryAlt}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(input.bodyHtml),
    '',
    `--${boundaryAlt}--`,
  ]

  if (attachments.length === 0) {
    return [...headers, ...alternative].join('\r\n')
  }

  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
    '',
    `--${boundaryMixed}`,
    ...alternative,
    '',
  ]
  for (const file of attachments) {
    parts.push(
      `--${boundaryMixed}`,
      `Content-Type: ${file.contentType}; name="${encodeHeader(file.fileName)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${encodeHeader(file.fileName)}"`,
      '',
      base64Lines(file.bytes),
      '',
    )
  }
  parts.push(`--${boundaryMixed}--`)
  return parts.join('\r\n')
}
