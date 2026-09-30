/**
 * The app ships with a Content-Security-Policy.
 *
 * There was none, so any script injection -- through an HR-authored announcement, an imported
 * name, a dependency -- ran with the full authority of the signed-in user, and the operator
 * console keeps its bearer token in sessionStorage where that script can read it. A CSP does
 * not fix the injection; it stops the injected script from running or phoning home.
 *
 * The policy is written for what the app actually loads (no inline scripts; Google Fonts and an
 * OpenStreetMap preview are the only third parties), and scripts/e2e-csp.ts drives a real
 * browser over every screen to prove nothing the app needs is blocked.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { CONTENT_SECURITY_POLICY, directives } from '../src/http/csp.ts'

describe('the policy', () => {
  const d = directives()

  it('allows scripts from this origin only: no inline, no eval, no third party', () => {
    expect(d['script-src']).toEqual(["'self'"])
  })

  it('forbids plugins, framing of the app, and rebasing or redirecting forms', () => {
    expect(d['object-src']).toEqual(["'none'"])
    expect(d['frame-ancestors']).toEqual(["'none'"])
    expect(d['base-uri']).toEqual(["'self'"])
    expect(d['form-action']).toEqual(["'self'"])
  })

  it('limits network calls to this origin, so injected script cannot send data elsewhere', () => {
    expect(d['connect-src']).toEqual(["'self'"])
    expect(d['default-src']).toEqual(["'self'"])
  })

  it('names the two third parties the app really uses, and nothing else', () => {
    expect(d['style-src']).toContain('https://fonts.googleapis.com')
    expect(d['font-src']).toContain('https://fonts.gstatic.com')
    expect(d['frame-src']).toContain('https://www.openstreetmap.org')
    const hosts = CONTENT_SECURITY_POLICY.match(/https?:\/\/[^\s;]+/g) ?? []
    expect(hosts.sort()).toEqual([
      'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://www.openstreetmap.org',
    ])
  })

  it('never widens scripts with unsafe-inline or unsafe-eval', () => {
    expect(d['script-src']!.join(' ')).not.toMatch(/unsafe-/)
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-eval|\*(?=[\s;]|$)/)
  })
})

describe('what it has to be compatible with', () => {
  it.skipIf(!existsSync('dist/index.html'))('the built pages carry no inline script', () => {
    for (const page of ['dist/index.html', 'dist/admin.html']) {
      const scripts = readFileSync(page, 'utf8').match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? []
      for (const s of scripts) expect(s, `${page}: ${s.slice(0, 80)}`).toMatch(/\bsrc=/)      // external only
      for (const s of scripts) expect(s.replace(/<script\b[^>]*>|<\/script>/g, '').trim(), page).toBe('')
    }
  })

  it('is sent on every response by server.ts', () => {
    const src = readFileSync('src/http/server.ts', 'utf8')
    expect(src).toContain("'Content-Security-Policy'")
    expect(src).toContain('CONTENT_SECURITY_POLICY')
  })
})

describe('permissions the app really uses', () => {
  it('leaves camera (QR punch) and geolocation (punch, geofence) to this origin, and turns off the rest', () => {
    // A blanket camera=() would have silently broken the QR punch screen.
    const src = readFileSync('src/http/server.ts', 'utf8')
    const line = src.split('\n').find((l) => l.includes('Permissions-Policy'))!
    expect(line).toContain('camera=(self)')
    expect(line).toContain('geolocation=(self)')
    for (const off of ['microphone=()', 'payment=()', 'usb=()']) expect(line).toContain(off)
  })
})
