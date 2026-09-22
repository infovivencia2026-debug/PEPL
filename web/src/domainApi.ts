import { ApiError } from './api'

/**
 * Installed by the shell: opens the authenticator prompt and resolves true once
 * a fresh code is verified (false if dismissed). Every domainApi call then
 * retries itself once, so no screen needs its own recheck handling.
 */
export let requestRecheck: (() => Promise<boolean>) | null = null
export function installRecheck(fn: (() => Promise<boolean>) | null): void { requestRecheck = fn }

export async function domainApi<T>(path: string, body?: unknown, method?: 'GET' | 'POST' | 'PATCH' | 'DELETE', retried = false): Promise<T> {
  const verb = method ?? (body === undefined ? 'GET' : 'POST')
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'same-origin',
    method: verb,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const result = response.status === 204 ? {} : await response.json().catch(() => ({}))
  if (!response.ok && response.status === 403 && result.error?.code === 'MFA_RECHECK_REQUIRED' && !retried && requestRecheck) {
    if (await requestRecheck()) return domainApi<T>(path, body, method, true)
  }
  if (!response.ok) throw new ApiError(result.error?.message ?? 'Unable to complete this request', response.status, result.error?.code, result.error?.requestId, { ...result.error?.details, ...(response.headers.get('retry-after') ? { retryAfter: response.headers.get('retry-after') } : {}) })
  return result as T
}

export function downloadFile(fileName: string, contentType: string, content: BlobPart) {
  const url = URL.createObjectURL(new Blob([content], { type: contentType }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}
