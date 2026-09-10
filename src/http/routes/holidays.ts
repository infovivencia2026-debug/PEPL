/**
 * The holiday calendar.
 *
 * Leave counting needs it, and until now there was no way for a company to
 * enter one — which is why leave days arrived from the browser and the sandwich
 * rule could not be honoured.
 *
 * Reading is open to anyone who can read leave: an employee planning time off
 * needs to know when the office is shut. Writing is `leave.policy.write`,
 * because a holiday changes what leave costs and therefore what people are paid.
 */
import type { Router } from '../router.ts'
import {
  HttpError, authed, ok, created, noContent, requireBody, requireModule,
  asUuid, asDate, emit,
} from './deps.ts'

export function register(router: Router): void {
  router.get('/api/v1/holidays',
    { summary: 'The holiday calendar for a year', tag: 'leave', permission: 'leave.read' },
    authed('leave.read', async (ctx) => {
      const year = Number(ctx.req.query.get('year') ?? new Date().getFullYear())
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'year must be a four-digit year')
      }
      const { rows } = await ctx.tx.query(
        `SELECT id, holiday_on::text, name, location, is_optional
           FROM holidays
          WHERE holiday_on >= make_date($1, 1, 1) AND holiday_on <= make_date($1, 12, 31)
          ORDER BY holiday_on`,
        [year])
      return ok({ year, holidays: rows })
    }))

  router.post('/api/v1/holidays',
    { summary: 'Add a company holiday', tag: 'leave', permission: 'leave.policy.write',
      requestExample: { holidayOn: '2026-10-02', name: 'Gandhi Jayanti' } },
    authed('leave.policy.write', async (ctx) => {
      requireModule(ctx, 'leave.enabled')
      const b = requireBody<{
        holidayOn: string; name: string; location?: string; isOptional?: boolean
      }>(ctx.req, ['holidayOn', 'name'])

      const holidayOn = asDate(b.holidayOn, 'holidayOn')
      const name = b.name.trim()
      if (!name || name.length > 120) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'a holiday needs a name of 1-120 characters')
      }

      const { rows } = await ctx.tx.query<{ id: string }>(
        `INSERT INTO holidays (tenant_id, holiday_on, name, location, is_optional)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, holiday_on, location) DO NOTHING
         RETURNING id`,
        [ctx.auth.tenantId, holidayOn, name, b.location ?? null, b.isOptional ?? false])

      if (!rows[0]) {
        throw new HttpError(409, 'HOLIDAY_EXISTS',
          `${holidayOn} is already a holiday${b.location ? ` for ${b.location}` : ''}`)
      }

      // A holiday changes what leave costs, so it belongs in the trail beside
      // the settings that do the same.
      await emit(ctx.tx, {
        action: 'config.setting.changed', entityType: 'holiday', entityId: rows[0].id,
        actorUserId: ctx.session.userId,
        metadata: { holidayOn, name, location: b.location ?? null },
      })
      return created({ id: rows[0].id })
    }))

  router.del('/api/v1/holidays/:id',
    { summary: 'Remove a holiday (reason required)', tag: 'leave',
      permission: 'leave.policy.write', requestExample: { reason: 'declared in error' } },
    authed('leave.policy.write', async (ctx) => {
      requireModule(ctx, 'leave.enabled')
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ reason: string }>(ctx.req, ['reason'])

      const { rows } = await ctx.tx.query<{ holiday_on: string; name: string }>(
        `DELETE FROM holidays WHERE id = $1 RETURNING holiday_on::text, name`, [id])
      if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'no such holiday')

      await emit(ctx.tx, {
        action: 'config.setting.changed', entityType: 'holiday', entityId: id,
        actorUserId: ctx.session.userId, reason: b.reason,
        metadata: { removed: rows[0].holiday_on, name: rows[0].name },
      })
      return noContent()
    }))

  /**
   * What a leave request would cost, before applying for it.
   *
   * The form needs the number the server will compute — otherwise the applicant
   * sees one figure, the server stores another, and the mismatch surfaces as a
   * rejection they cannot act on.
   */
  router.get('/api/v1/leave/day-count',
    { summary: 'What a date range costs in leave days', tag: 'leave', permission: 'leave.read' },
    authed('leave.read', async (ctx) => {
      const { countLeaveDays, holidaysBetween } = await import('../../leave/days.ts')
      const startDate = asDate(ctx.req.query.get('startDate'), 'startDate')
      const endDate = asDate(ctx.req.query.get('endDate'), 'endDate')
      const parts = ctx.req.query.get('dayParts')

      return ok(countLeaveDays({
        startDate,
        endDate,
        dayParts: parts ? (JSON.parse(parts) as Record<string, string>) : undefined,
        weekPattern: ctx.config.get<'five_day' | 'six_day' | 'alternate_saturday' | 'roster'>(
          'attendance.week_pattern'),
        holidays: await holidaysBetween(ctx.tx, { startDate, endDate }),
        sandwich: ctx.config.get<boolean>('leave.sandwich_holidays'),
      }))
    }))
}
