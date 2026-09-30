export const PLATFORM_TOKEN = 'pepl.platform.token'

export class PlatformApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'PlatformApiError'
  }
}

type ErrorEnvelope = { error?: { message?: string; code?: string; requestId?: string } }

export async function platformApi<T>(path: string, options: { method?: string; body?: unknown; token?: string | null } = {}): Promise<T> {
  const token = options.token === undefined ? sessionStorage.getItem(PLATFORM_TOKEN) : options.token
  const response = await fetch(`/api/platform${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const result = await response.json().catch(() => ({ error: { code: 'UNREADABLE_RESPONSE', message: 'The server returned an unreadable response.' } })) as T & ErrorEnvelope
  if (!response.ok) {
    // A 401 only ends the session when the SERVER says the session is what is
    // wrong. Treating every 401 as "signed out" sent people back to the login
    // page on a mistyped code, and signing in again meant a new secret and a
    // stale QR: an unwinnable loop. The server no longer answers a wrong code
    // with 401, but the console should not depend on that staying true.
    const sessionIsGone = result.error?.code === 'INVALID_SESSION' || result.error?.code === 'MISSING_TOKEN'
    if (response.status === 401 && path !== '/login' && sessionIsGone) {
      sessionStorage.removeItem(PLATFORM_TOKEN)
      window.dispatchEvent(new Event('pepl-platform-auth-expired'))
    } else if (result.error?.code === 'MFA_REQUIRED') {
      window.dispatchEvent(new Event('pepl-platform-mfa-required'))
    }
    throw new PlatformApiError(result.error?.message ?? 'Unable to complete this request.', response.status, result.error?.code ?? 'UNKNOWN', result.error?.requestId)
  }
  return result
}
