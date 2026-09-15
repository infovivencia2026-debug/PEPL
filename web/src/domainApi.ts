import { ApiError } from './api'

export async function domainApi<T>(path: string, body?: unknown, method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'): Promise<T> {
  const verb = method ?? (body === undefined ? 'GET' : 'POST')
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'same-origin',
    method: verb,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const result = response.status === 204 ? {} : await response.json().catch(() => ({}))
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
