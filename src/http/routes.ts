/**
 * The PEPL HTTP API — assembly point.
 *
 * Conventions, applied everywhere:
 *   - the tenant comes from the session, never from the path, a header or the body
 *   - a record outside the caller's scope returns 404, never 403
 *   - errors carry a stable machine code, not just a status
 *   - every mutating route takes an optional `reason`, required where the domain
 *     demands one
 *
 * Each domain owns a file in ./routes/ and registers itself here. This file is
 * the table of contents: adding a domain is one import and one call, and no
 * route file can grow into the others.
 */
import { Router } from './router.ts'
import { resolveSession } from '../auth/index.ts'
import { register as system } from './routes/system.ts'
import { register as config } from './routes/config.ts'
import { register as people } from './routes/people.ts'
import { register as attendance } from './routes/attendance.ts'
import { register as leave } from './routes/leave.ts'
import { register as inbox } from './routes/inbox.ts'
import { register as payroll } from './routes/payroll.ts'
import { register as helpdesk } from './routes/helpdesk.ts'
import { register as incentives } from './routes/incentives.ts'
import { register as comms } from './routes/comms.ts'
import { register as activity } from './routes/activity.ts'
import { register as roles } from './routes/roles.ts'
import { register as documents } from './routes/documents.ts'
import { register as chat } from './routes/chat.ts'
import { register as mail } from './routes/mail.ts'
import { register as imports } from './routes/imports.ts'
import { register as payments } from './routes/payments.ts'
import { register as holidays } from './routes/holidays.ts'
import { register as leavePolicy } from './routes/leave-policy.ts'
import { register as taxDeclarations } from './routes/tax-declarations.ts'

export const router = new Router()

for (const register of [
  system, config, people, attendance, leave, inbox,
  payroll, helpdesk, incentives, comms, activity, roles, documents, chat, mail, imports, payments, holidays, leavePolicy, taxDeclarations,
]) {
  register(router)
}

export { resolveSession }
