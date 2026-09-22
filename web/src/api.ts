/**
 * The API client.
 *
 * The server returns a STABLE MACHINE CODE on every error. Carry it: `message`
 * is for the human, `code` is what the UI branches on, and `requestId` is the
 * only thing that correlates a user's complaint with the server log.
 */
export class ApiError extends Error {
  status: number
  /** Stable machine code, e.g. PERIOD_CLOSED. Branch on this, never the message. */
  code: string
  /** Correlates with the server log — show it in support-facing copy. */
  requestId?: string
  /** Field-level detail, e.g. { missing: ['employeeNumber'] }. */
  details?: Record<string, unknown>

  constructor(
    message: string,
    status: number,
    code = 'UNKNOWN',
    requestId?: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
    this.details = details
  }

  /** The module is off for this company, or not on its plan: hide the feature. */
  get isModuleUnavailable() {
    return this.code === 'MODULE_NOT_AVAILABLE'
  }

  /**
   * The request conflicts with the state of the world rather than being wrong —
   * a closed period, a locked run. Worth explaining, not just reporting.
   */
  get isConflict() {
    return this.status === 409
  }

  /** Which fields to highlight, when the server said the request was incomplete. */
  get missingFields(): string[] {
    const missing = this.details?.missing
    return Array.isArray(missing) ? missing.map(String) : []
  }
}

interface ErrorEnvelope {
  error?: {
    code?: string
    message?: string
    requestId?: string
    details?: Record<string, unknown>
  }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/ui${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const result: ErrorEnvelope & Record<string, unknown> = await response
    .json()
    .catch(() => ({
      error: {
        code: 'UNREADABLE_RESPONSE',
        message:
          'The server returned an unexpected response. Please try again.',
      },
    }))
  if (!response.ok)
    throw new ApiError(
      result.error?.message ?? 'Unable to complete this request',
      response.status,
      result.error?.code ?? 'UNKNOWN',
      result.error?.requestId,
      result.error?.details,
    )
  return result as T
}
export interface ErrorView {
  message: string
  code: string
  requestId?: string
  missingFields: string[]
}

/**
 * Normalises anything thrown into what an error surface needs. Server messages
 * are written to be shown to a user as-is; the code and reference travel with
 * them so the UI can branch and support can trace.
 */
export function toErrorView(e: unknown): ErrorView {
  if (e instanceof ApiError) {
    return {
      message: e.message,
      code: e.code,
      requestId: e.requestId,
      missingFields: e.missingFields,
    }
  }
  return {
    message: e instanceof Error ? e.message : 'Something went wrong.',
    code: 'UNKNOWN',
    missingFields: [],
  }
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
export const money = (s: string | number | null | undefined) =>
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
    '﻿' +
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
