/**
 * Inbound MIME becomes a readable message; foreign HTML becomes safe HTML.
 * No database — these are pure functions and the tests are the specification.
 */
import { describe, it, expect } from 'vitest'
import { parseMessage, decodeEncodedWords, parseParams, decodeQuotedPrintable } from '../src/mail/parse.ts'
import { sanitizeHtml, resolveInlineImages } from '../src/mail/sanitize.ts'
import { buildMessage } from '../src/mail/mime.ts'

const CRLF = (s: string): string => s.replace(/\n/g, '\r\n')

describe('MIME parsing', () => {
  it('reads a Gmail-shaped message: mixed > alternative + attachment, base64 and quoted-printable', () => {
    const pdf = Buffer.from('%PDF-1.4 fake')
    const src = CRLF(`From: Priya <priya@acme.com>
To: rahul@acme.com
Subject: =?UTF-8?B?4oK5IDUwLDAwMCBjcmVkaXRlZA==?=
Content-Type: multipart/mixed; boundary="mixed1"

preamble to ignore
--mixed1
Content-Type: multipart/alternative; boundary="alt1"

--alt1
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

Salary =E2=82=B950,000 credited.=
 Regards
--alt1
Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: base64

${Buffer.from('<p>Salary <b>₹50,000</b> credited.</p>').toString('base64')}
--alt1--
--mixed1
Content-Type: application/pdf; name="slip.pdf"
Content-Disposition: attachment; filename="slip.pdf"
Content-Transfer-Encoding: base64

${pdf.toString('base64')}
--mixed1--
epilogue`)
    const m = parseMessage(src)
    expect(m.html).toBe('<p>Salary <b>₹50,000</b> credited.</p>')
    expect(m.text).toBe('Salary ₹50,000 credited. Regards')
    expect(m.attachments).toHaveLength(1)
    expect(m.attachments[0]).toMatchObject({ fileName: 'slip.pdf', contentType: 'application/pdf', inline: false, contentId: null })
    expect(m.attachments[0]!.bytes.equals(pdf)).toBe(true)
  })

  it('finds inline images by Content-ID inside multipart/related (Outlook shape)', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const src = CRLF(`Content-Type: multipart/related; boundary="rel"

--rel
Content-Type: text/html; charset=us-ascii

<p>Logo: <img src="cid:logo@outlook"></p>
--rel
Content-Type: image/png
Content-ID: <logo@outlook>
Content-Disposition: inline; filename="logo.png"
Content-Transfer-Encoding: base64

${png.toString('base64')}
--rel--`)
    const m = parseMessage(src)
    expect(m.html).toContain('cid:logo@outlook')
    expect(m.attachments[0]).toMatchObject({ fileName: 'logo.png', contentId: 'logo@outlook', inline: true })
    expect(m.attachments[0]!.bytes.equals(png)).toBe(true)
  })

  it('decodes other charsets and encoded filenames', () => {
    const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9])       // "café" in ISO-8859-1
    const src = CRLF(`Content-Type: text/plain; charset="iso-8859-1"
Content-Transfer-Encoding: 8bit

`) + latin.toString('latin1')
    expect(parseMessage(Buffer.from(src, 'latin1')).text).toBe('café')

    expect(decodeEncodedWords('=?UTF-8?Q?Caf=C3=A9_menu?= =?UTF-8?B?4oK5?=')).toBe('Café menu₹')
    expect(parseParams(`attachment; filename*=utf-8''caf%C3%A9%20menu.pdf`).params.filename).toBe('café menu.pdf')
    expect(parseParams(`attachment; filename*0*=utf-8''caf%C3%A9; filename*1*=.pdf`).params.filename).toBe('café.pdf')
    expect(parseParams('attachment; filename="=?UTF-8?B?4oK5LnBkZg==?="').params.filename).toBe('₹.pdf')
    expect(decodeQuotedPrintable('a=3Db=\r\nc').toString()).toBe('a=bc')
  })

  it('degrades, never throws: plain text with no headers, and an unknown charset', () => {
    expect(parseMessage('just words')).toEqual({ html: null, text: 'just words', attachments: [] })
    const src = CRLF(`Content-Type: text/plain; charset="x-no-such"

hello`)
    expect(parseMessage(src).text).toBe('hello')
    expect(parseMessage(CRLF('Content-Type: multipart/mixed\n\nno boundary'))).toMatchObject({ html: null, text: null })
  })

  it('round-trips what our own builder produces', () => {
    const raw = buildMessage({
      from: { name: 'HR', address: 'hr@acme.com' }, to: ['a@acme.com'], subject: 'Hi',
      bodyHtml: '<p>Hello <i>there</i></p>', messageId: 'x@pepl.internal',
      attachments: [{ fileName: 'a.txt', contentType: 'text/plain', bytes: Buffer.from('attached') }],
    })
    const m = parseMessage(raw)
    expect(m.html).toBe('<p>Hello <i>there</i></p>')
    expect(m.text).toBe('Hello there')
    expect(m.attachments.map((a) => [a.fileName, a.bytes.toString()])).toEqual([['a.txt', 'attached']])
  })
})

describe('HTML sanitising', () => {
  it('drops scripts, handlers, frames, forms and javascript: URLs; keeps formatting', () => {
    const dirty = `<html><head><title>x</title><style>body{}</style></head><body>
<script>steal()</script><iframe src="https://evil"></iframe>
<p onclick="steal()" style="color:red;background:url(https://t.example/pix.gif)">Hello <b>bold</b>
<a href="javascript:steal()">bad</a> <a href="https://acme.com/x">good</a>
<img src="https://acme.com/logo.png" onerror="steal()" alt="logo">
<form action="/x"><input name="pw"></form>
<table><tr><td bgcolor="#eee">cell</td></tr></table></p></body></html>`
    const clean = sanitizeHtml(dirty)
    expect(clean).not.toMatch(/script|iframe|onclick|onerror|javascript:|url\(|<form|<input|<title|<style/i)
    expect(clean).toContain('<b>bold</b>')
    expect(clean).toContain('style="color:red;background:"')
    expect(clean).toContain('<a href="https://acme.com/x" rel="noopener noreferrer" target="_blank">good</a>')
    expect(clean).toContain('<img src="https://acme.com/logo.png" alt="logo" />')
    expect(clean).toContain('<td bgcolor="#eee">cell</td>')
    expect(clean).not.toContain('bad</a>'.replace('bad', 'javascript'))
  })

  it('keeps cid: and data:image sources, refuses data:text/html', () => {
    expect(sanitizeHtml('<img src="cid:logo@x">')).toBe('<img src="cid:logo@x" />')
    expect(sanitizeHtml('<img src="data:image/png;base64,AAAA">')).toContain('data:image/png')
    expect(sanitizeHtml('<img src="data:text/html;base64,AAAA">')).toBe('<img />')
    expect(sanitizeHtml('<a href="mailto:a@b.c">m</a>')).toContain('href="mailto:a@b.c"')
  })

  it('handles the classic bypasses', () => {
    expect(sanitizeHtml('<img src="java&#115;cript:alert(1)">')).toBe('<img />')
    expect(sanitizeHtml('<a href="  JavaScript:alert(1)">x</a>')).toBe('<a>x</a>')
    expect(sanitizeHtml('<p style="width:expression(alert(1))">x</p>')).toBe('<p style="width:">x</p>')
    expect(sanitizeHtml('<svg onload="alert(1)"><circle/></svg><b>ok</b>')).toBe('<b>ok</b>')
    expect(sanitizeHtml('<scr<script>ipt>alert(1)</script>')).not.toContain('<script')
    expect(sanitizeHtml(null)).toBe('')
  })

  it('rewrites cid: references to the stored attachment URLs', () => {
    const out = resolveInlineImages('<img src="cid:logo@x" /><img src="cid:missing" />', new Map([['logo@x', '/api/v1/mail/attachments/abc/content']]))
    expect(out).toBe('<img src="/api/v1/mail/attachments/abc/content" /><img src="cid:missing" />')
  })
})
