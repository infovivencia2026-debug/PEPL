/** Only a dead SESSION signs the user out; a wrong password (also a 401) must not (UI error handling). */
import { describe, it, expect } from 'vitest'
import { isSessionExpired } from '../web/src/session.ts'

describe('isSessionExpired', () => {
  it('is true for the two session codes on a 401', () => {
    expect(isSessionExpired(401, 'INVALID_SESSION')).toBe(true)
    expect(isSessionExpired(401, 'MISSING_TOKEN')).toBe(true)
  })
  it('is false for a bad password, an MFA code, a 403, or a 200', () => {
    expect(isSessionExpired(401, 'INVALID_CREDENTIALS')).toBe(false)
    expect(isSessionExpired(422, 'INVALID_SESSION')).toBe(false)
    expect(isSessionExpired(403, 'PERMISSION_DENIED')).toBe(false)
    expect(isSessionExpired(200)).toBe(false)
  })
})
