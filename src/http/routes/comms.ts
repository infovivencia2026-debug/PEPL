/** Announcements and notifications. */
import type { Router } from '../router.ts'
import {
  authed,
  ok,
  requireBody,
  asUuid,
  acknowledge,
  acknowledgementStats,
  publishAnnouncement,
  unreadCount,
} from './deps.ts'

export function register(router: Router): void {
  router.post('/api/v1/announcements/:id/publish',
    { summary: 'Publish to an audience and start tracking acknowledgement', tag: 'comms',
      permission: 'announcement.create', requestExample: { audienceUserIds: ['…'] } },
    authed('announcement.create', async (ctx) => {
      const b = requireBody<{ audienceUserIds: string[] }>(ctx.req, ['audienceUserIds'])
      const n = await publishAnnouncement(ctx.tx, {
        announcementId: asUuid(ctx.req.params.id, 'id'), audienceUserIds: b.audienceUserIds,
      })
      return ok({ delivered: n })
    }))

  router.post('/api/v1/announcements/:id/acknowledge',
    { summary: 'Acknowledge an announcement', tag: 'comms', permission: 'announcement.read' },
    authed('announcement.read', async (ctx) => {
      await acknowledge(ctx.tx, asUuid(ctx.req.params.id, 'id'), ctx.auth.userId)
      return ok({ acknowledged: true })
    }))

  router.get('/api/v1/announcements/:id/acknowledgements',
    { summary: 'Who has acknowledged, and who has not', tag: 'comms', permission: 'announcement.create' },
    authed('announcement.create', async (ctx) =>
      ok(await acknowledgementStats(ctx.tx, asUuid(ctx.req.params.id, 'id')))))

  router.get('/api/v1/notifications',
    { summary: 'In-app notifications for the current user', tag: 'comms' },
    authed(null, async (ctx) => {
      const { rows } = await ctx.tx.query(
        `SELECT id, event_type, title, body, entity_type, entity_id, read_at, created_at
           FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 100`,
        [ctx.auth.userId])
      return ok({ notifications: rows, unread: await unreadCount(ctx.tx, ctx.auth.userId) })
    }))
}
