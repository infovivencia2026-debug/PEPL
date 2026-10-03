/**
 * Shared by the browser scripts: where they point, and how they sign in.
 *
 * WHERE. Four scripts defaulted to https://pepl.onrol.in -- production -- and two of them create
 * companies and change data. A script that mutates now defaults to the LOCAL server and refuses any
 * other host unless E2E_ALLOW_REMOTE=yes is set deliberately; a read-only script may be pointed
 * anywhere, but must be pointed (it never defaults to a remote host either).
 *
 * HOW. The sign-in selectors were `input[type="email"]` / `button[type="submit"]`: they match the first
 * such element on the page, so the day a second form or button appears they fill or click the wrong one.
 * The form's labels and its button text are what a person sees and what assistive technology reads.
 */
import type { Page } from 'playwright-core'

export const LOCAL_BASE = 'http://127.0.0.1:3100'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function e2eBase(envVar: string, opts: { mutates: boolean }, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env[envVar] ?? LOCAL_BASE).replace(/\/+$/, '')
  let host: string
  try { host = new URL(base).hostname } catch { throw new Error(`${envVar} is not a URL: ${base}`) }
  if (opts.mutates && !LOOPBACK.has(host) && env.E2E_ALLOW_REMOTE !== 'yes') {
    throw new Error(
      `Refusing to run a script that CHANGES DATA against ${host}. It defaults to ${LOCAL_BASE}; ` +
      `to point it elsewhere deliberately set E2E_ALLOW_REMOTE=yes (never for production).`)
  }
  return base
}

/** Fill the one sign-in form by its labels and submit it by its button. */
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Work email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: /enter your workspace/i }).click()
}
