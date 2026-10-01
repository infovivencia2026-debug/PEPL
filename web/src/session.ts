/**
 * What a 401 means. INVALID_SESSION / MISSING_TOKEN say the session is gone; any other 401 (a wrong
 * password at sign-in, say) is not that and must not throw the user out. When the session has expired
 * every screen used to show its own opaque error and the app stayed up on a dead session until a
 * manual reload.
 */
export const isSessionExpired = (status: number, code?: string): boolean =>
  status === 401 && (code === 'INVALID_SESSION' || code === 'MISSING_TOKEN')

let announced = false
/** Tells the shell once; it shows the sign-in again. Safe to call from any request helper. */
export function announceSessionExpired(): void {
  if (announced || typeof window === 'undefined') return
  announced = true
  window.dispatchEvent(new CustomEvent('pepl:session-expired'))
}
