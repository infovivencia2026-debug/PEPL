/**
 * A very small PDF writer.
 *
 * PEPL needs one thing from PDF: a single-page A4 document with text, rules and
 * boxes, in the two Helvetica faces every reader has built in. That is about a
 * hundred lines of PDF 1.4, so it is written here rather than pulling in a
 * rendering library whose licence, transitive dependencies and CVE history
 * would all have to be tracked for the life of a payroll product.
 *
 * Deliberately not supported: images, embedded fonts, multiple pages, and any
 * character outside WinAnsi. If a payslip ever needs those, that is the moment
 * to reach for a library — not before.
 */

/** A4 at 72dpi, the unit PDF measures in. Origin is bottom-left. */
export const PAGE_WIDTH = 595.28
export const PAGE_HEIGHT = 841.89

export type Font = 'regular' | 'bold'

/** PDF strings are parenthesised, so the delimiters have to be escaped. */
function escapeText(value: string): string {
  return value.replace(/[\\()]/g, (c) => '\\' + c)
}

/**
 * Anything outside WinAnsi would need an embedded font, so it is transliterated
 * rather than silently emitted as a wrong glyph. The rupee sign is the one that
 * matters here, and "Rs." is what Indian payslips printed for decades anyway.
 */
function toWinAnsi(value: string): string {
  return value
    .replace(/₹/g, 'Rs.')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
}

export class PdfPage {
  private readonly ops: string[] = []

  text(
    value: string,
    x: number,
    y: number,
    opts: { font?: Font; size?: number; grey?: number } = {},
  ): this {
    const font = opts.font === 'bold' ? '/F2' : '/F1'
    const size = opts.size ?? 10
    const grey = opts.grey ?? 0
    this.ops.push(
      `BT ${grey} g ${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ` +
      `(${escapeText(toWinAnsi(value))}) Tj ET`,
    )
    return this
  }

  /** Right-aligns using Helvetica's average width — good enough for money columns. */
  textRight(
    value: string,
    right: number,
    y: number,
    opts: { font?: Font; size?: number; grey?: number } = {},
  ): this {
    const size = opts.size ?? 10
    const width = measure(toWinAnsi(value), size, opts.font ?? 'regular')
    return this.text(value, right - width, y, opts)
  }

  line(x1: number, y1: number, x2: number, y2: number, grey = 0.8, width = 0.5): this {
    this.ops.push(
      `${grey} G ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ` +
      `${x2.toFixed(2)} ${y2.toFixed(2)} l S`,
    )
    return this
  }

  rect(x: number, y: number, w: number, h: number, grey = 0.95): this {
    this.ops.push(`${grey} g ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`)
    return this
  }

  content(): string {
    return this.ops.join('\n')
  }
}

/**
 * Helvetica advance widths, in 1/1000 em, for the printable ASCII range.
 *
 * Only the characters a payslip uses are measured precisely; anything else
 * falls back to the average. Right-aligned money is the only thing depending on
 * this, and money is digits.
 */
const WIDTHS: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015, '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556, '`': 333,
}

const UPPER = 667
const LOWER = 528

export function measure(value: string, size: number, font: Font = 'regular'): number {
  let units = 0
  for (const ch of value) {
    const known = WIDTHS[ch]
    units += known ?? (ch >= 'A' && ch <= 'Z' ? UPPER : LOWER)
  }
  // Bold Helvetica runs a few percent wider; close enough for column alignment.
  return (units / 1000) * size * (font === 'bold' ? 1.04 : 1)
}

/** Assembles the objects, the cross-reference table and the trailer. */
export function renderPdf(page: PdfPage, title: string): Buffer {
  const stream = page.content()
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title (${escapeText(toWinAnsi(title))}) /Producer (PEPL) >>`,
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })

  const xrefAt = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\n` +
         `startxref\n${xrefAt}\n%%EOF\n`

  return Buffer.from(pdf, 'latin1')
}
