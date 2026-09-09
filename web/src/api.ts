export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/ui${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const result = await response
    .json()
    .catch(() => ({
      error: {
        message:
          'The server returned an unexpected response. Please try again.',
      },
    }))
  if (!response.ok)
    throw new ApiError(
      result.error?.message ?? 'Unable to complete this request',
      response.status,
    )
  return result as T
}
export const fullName = (p: { first_name: string; last_name: string | null }) =>
  `${p.first_name} ${p.last_name ?? ''}`.trim()
export const pretty = (s: string) =>
  s.replace(/[_.]/g, ' ').replace(/^./, (c) => c.toUpperCase())
export const dateLabel = (
  s: string | null | undefined,
  options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  },
) =>
  s
    ? new Date(s.length === 10 ? s + 'T12:00:00' : s).toLocaleDateString(
        'en-IN',
        options,
      )
    : '—'
export const money = (s: string | null | undefined) =>
  s === null || s === undefined
    ? '—'
    : new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0,
      }).format(Number(s) / 100)
export function exportCsv(name: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return
  const keys = Object.keys(rows[0])
  const escape = (v: unknown) =>
    '"' +
    String(v ?? '')
      .replace(/^[=+@\-\t\r]/, "'$&")
      .replaceAll('"', '""') +
    '"'
  const csv =
    '\ufeff' +
    [
      keys.map(escape).join(','),
      ...rows.map((row) => keys.map((k) => escape(row[k])).join(',')),
    ].join('\r\n')
  const url = URL.createObjectURL(
    new Blob([csv], { type: 'text/csv;charset=utf-8' }),
  )
  const a = document.createElement('a')
  a.href = url
  a.download = name + '.csv'
  a.click()
  URL.revokeObjectURL(url)
}
