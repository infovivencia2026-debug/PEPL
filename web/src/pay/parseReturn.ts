/**
 * Parses the CSV a bank sends back after a payment batch.
 *
 * A line is `settled` ONLY when its status says so in words a bank uses for success. It used to be
 * the other way round: anything that did not look like a failure -- a blank cell, "pending",
 * "processing", a file with no status column at all -- was marked settled, i.e. an employee was
 * recorded as PAID because the bank had not said otherwise. Unrecognised rows are now reported
 * back, never applied.
 */
export interface ReconLine {
  reference?: string
  accountNumber?: string
  amountPaise?: number
  status: 'settled' | 'failed' | 'returned'
  utr?: string
  reason?: string
}

export interface ParsedReturn {
  lines: ReconLine[]
  /** Rows whose status was missing or not understood: shown to the person, never sent. */
  unrecognised: Array<{ row: number; text: string }>
  /** The file has no status column, so nothing in it can be applied. */
  noStatusColumn: boolean
}

const SETTLED = /^(success|successful|settled|paid|processed|credited|completed|complete|executed)$/
const RETURNED = /return|rtn/
const FAILED = /fail|reject|declin|invalid|unpaid|error|cancel/

export function parseReturnDetailed(csv: string): ParsedReturn {
  const rows = csv.trim().split(/\r?\n/).map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')))
  if (!rows.length || !rows[0]?.length) return { lines: [], unrecognised: [], noStatusColumn: false }
  const head = rows[0].map((h) => h.toLowerCase())
  const col = (...names: string[]): number => head.findIndex((h) => names.some((n) => h.includes(n)))
  const iRef = col('reference', 'ref no', 'txn'), iAcc = col('account'), iAmt = col('amount'),
    iStat = col('status'), iUtr = col('utr', 'rrn'), iWhy = col('reason', 'remark', 'error')
  const hasHeader = iStat !== -1 || iRef !== -1 || iAcc !== -1 || iAmt !== -1
  if (iStat === -1) return { lines: [], unrecognised: [], noStatusColumn: true }
  const body = hasHeader ? rows.slice(1) : rows
  const lines: ReconLine[] = []
  const unrecognised: ParsedReturn['unrecognised'] = []
  body.forEach((r, n) => {
    if (r.length <= 1) return
    const raw = (r[iStat] ?? '').trim().toLowerCase()
    let status: ReconLine['status'] | null = null
    if (RETURNED.test(raw)) status = 'returned'
    else if (FAILED.test(raw)) status = 'failed'
    else if (SETTLED.test(raw)) status = 'settled'
    if (!status) { unrecognised.push({ row: n + 2, text: r.join(',').slice(0, 120) }); return }
    lines.push({
      reference: iRef === -1 ? undefined : r[iRef],
      accountNumber: iAcc === -1 ? undefined : r[iAcc],
      amountPaise: iAmt === -1 ? undefined : Math.round(Number((r[iAmt] ?? '0').replace(/[^\d.]/g, '')) * 100),
      status, utr: iUtr === -1 ? undefined : r[iUtr], reason: iWhy === -1 ? undefined : r[iWhy] || undefined,
    })
  })
  return { lines, unrecognised, noStatusColumn: false }
}

/** The recognised lines only (kept for callers that want just the list). */
export const parseReturn = (csv: string): ReconLine[] => parseReturnDetailed(csv).lines
