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
import { register as push } from './routes/push.ts'
import { register as filings } from './routes/filings.ts'
import { register as exits } from './routes/exit.ts'
import { register as account } from './routes/account.ts'
import { register as privacy } from './routes/privacy.ts'
import { register as org } from './routes/org.ts'
import { register as geofences } from './routes/geofences.ts'
import { register as shifts } from './routes/shifts.ts'
import { register as structures } from './routes/structures.ts'
import { register as incentiveAdmin } from './routes/incentive-admin.ts'
import { register as approvalPolicy } from './routes/approval-policy.ts'
import { register as loans } from './routes/loans.ts'
import { register as reports } from './routes/reports.ts'
import { register as datasetImports } from './routes/dataset-imports.ts'
import { register as billing } from './routes/billing.ts'
import { register as expenses } from './routes/expenses.ts'
import { register as timesheets } from './routes/timesheets.ts'
import { register as exitWorkflow } from './routes/exit-workflow.ts'
import { register as recruitment } from './routes/recruitment.ts'
import { register as performance } from './routes/performance.ts'
import { register as letters } from './routes/letters.ts'
import { register as roster } from './routes/roster.ts'
import { register as assets } from './routes/assets.ts'
import { register as engage } from './routes/engage.ts'
import { register as structure } from './routes/structure.ts'
import { register as engageOps } from './routes/engage-ops.ts'
import { register as integrations } from './routes/integrations.ts'
import { register as compliance } from './routes/compliance.ts'
import { register as learning } from './routes/learning.ts'
import { register as feedback } from './routes/feedback.ts'
import { register as contractors } from './routes/contractors.ts'
import { register as groups } from './routes/groups.ts'
import { register as reportBuilder } from './routes/report-builder.ts'
import { register as anomalies } from './routes/anomalies.ts'
import { register as sandbox } from './routes/sandbox.ts'
import { register as trust } from './routes/trust.ts'
import { register as benchmarks } from './routes/benchmarks.ts'
import { register as assistant } from './routes/assistant.ts'

export const router = new Router()

for (const register of [
  system, config, people, attendance, leave, inbox,
  payroll, helpdesk, incentives, comms, activity, roles, documents, chat, mail, imports, payments, holidays, leavePolicy, taxDeclarations, push, filings, exits, account, privacy, org, geofences, shifts, structures, incentiveAdmin, approvalPolicy, loans, reports, datasetImports, billing, expenses, timesheets, exitWorkflow, recruitment, performance, letters, roster, assets, engage, structure, engageOps, integrations, compliance, learning, feedback, contractors, groups, reportBuilder, anomalies, sandbox, trust, benchmarks, assistant,
]) {
  register(router)
}

export { resolveSession }
