/**
 * Last-resort process guards.
 *
 * An async 'error' event with no listener becomes an uncaught exception and
 * kills the process. Mail sockets are the usual source, and mail is auxiliary:
 * a slow IMAP handshake must never stop attendance, payroll or chat for
 * everyone. This is not theoretical — it happened in the sibling ONROL
 * deployment, where one mailbox took the whole HR system into a restart loop.
 *
 * The rule: an auxiliary or network fault is logged and the process keeps
 * serving. Anything else is a real bug in our own code, where continuing on
 * corrupted state is worse than restarting clean.
 */

/** Modules whose failures must never be fatal. */
const AUXILIARY = new RegExp(
  ['imapflow', 'nodemailer', 'mailparser', 'src[\\\\/]mail[\\\\/]', 'src[\\\\/]realtime[\\\\/]'].join('|'),
  'i',
)

/** Transport faults: the other end went away, which is not our bug. */
const NETWORK = new Set([
  'ETIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
  'EPIPE', 'EHOSTUNREACH', 'ENOTFOUND', 'ENETUNREACH', 'EAI_AGAIN',
])

export function isAuxiliary(error: unknown): boolean {
  const e = error as { stack?: string; code?: string } | null
  return AUXILIARY.test(e?.stack ?? '') || NETWORK.has(e?.code ?? '')
}

export function installProcessGuards(): void {
  process.on('unhandledRejection', (reason) => {
    console.error(JSON.stringify({
      t: new Date().toISOString(), level: 'error', msg: 'unhandledRejection',
      err: (reason as Error)?.message ?? String(reason),
    }))
  })

  process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
    const auxiliary = isAuxiliary(err)
    console.error(JSON.stringify({
      t: new Date().toISOString(), level: 'error', msg: 'uncaughtException',
      code: err?.code, err: err?.message, auxiliary,
    }))
    if (!auxiliary) {
      console.error(err)
      process.exit(1)
    }
  })
}
