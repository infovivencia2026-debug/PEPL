/** Announcements (posted into the Announcements chat channel) and notifications. */
import type { Router } from '../router.ts'
import {
  authed, ok, created, noContent, requireBody, asUuid, can, emit, HttpError,
  acknowledge, acknowledgementStats, publishAnnouncement, unreadCount,
} from './deps.ts'
import {
  postAnnouncement, listAnnouncements, getAnnouncement, markViewed, withdrawAnnouncement,
  pendingAcknowledgements, ensureAnnouncementChannel,
} from '../../comms/index.ts'

export function register(router: Router): void {
  router.get('/api/v1/announcements',
    { summary: 'Announcements published to you (authors also see their own), newest first', tag: 'comms',
      permission: 'announcement.read' },
    authed('announcement.read', async (ctx) => {
      const canManage = can(ctx.auth, 'announcement.create')
      return ok({
        channelId: canManage ? await ensureAnnouncementChannel(ctx.tx, ctx.session.userId) : undefined,
        announcements: await listAnnouncements(ctx.tx, {
          userId: ctx.session.userId, canManage,
          includeExpired: ctx.req.query.get('includeExpired') === 'true',
        }),
      })
    }))

  router.post('/api/v1/announcements',
    { summary: 'Post an announcement: it is published at once into the Announcements channel', tag: 'comms',
      permission: 'announcement.create',
      requestExample: { title: 'Diwali holiday', bodyHtml: '<p>Office closed on 20 Oct.</p>', requiresAcknowledgement: false } },
    authed('announcement.create', async (ctx) => {
      const b = requireBody<{
        title: string; bodyHtml: string; requiresAcknowledgement?: boolean; expiresAt?: string | null
        audienceUserIds?: string[]
      }>(ctx.req, ['title', 'bodyHtml'])
      const a = await postAnnouncement(ctx.tx, {
        authorUserId: ctx.session.userId, title: b.title, bodyHtml: b.bodyHtml,
        requiresAcknowledgement: b.requiresAcknowledgement, expiresAt: b.expiresAt ?? null,
        audienceUserIds: b.audienceUserIds?.map((id) => asUuid(id, 'audienceUserIds')),
      })
      await emit(ctx.tx, { action: 'comms.announcement.posted', entityType: 'announcement', entityId: a.id,
        actorUserId: ctx.session.userId, metadata: { title: a.title, delivered: a.delivered, requiresAcknowledgement: a.requires_acknowledgement } })
      // The chat channel gets the same event a normal message would, so open clients refresh.
      ctx.publish({ type: 'chat.message', data: { conversationId: a.conversation_id, messageId: a.message_id, announcementId: a.id } })
      ctx.publish({ type: 'announcement.published', data: { announcementId: a.id } })
      return created(a)
    }))

  router.get('/api/v1/announcements/:id',
    { summary: 'One announcement with your receipt; opening it marks it viewed', tag: 'comms',
      permission: 'announcement.read' },
    authed('announcement.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const a = await getAnnouncement(ctx.tx, id, ctx.session.userId)
      if (!a || a.status !== 'published' || (!a.in_audience && !can(ctx.auth, 'announcement.create'))) {
        throw new HttpError(404, 'NOT_FOUND', 'no such announcement')
      }
      await markViewed(ctx.tx, id, ctx.session.userId)
      return ok({ ...a, viewed_at: a.viewed_at ?? new Date().toISOString() })
    }))

  router.post('/api/v1/announcements/:id/withdraw',
    { summary: 'Withdraw a published announcement (reason required); its chat message is removed', tag: 'comms',
      permission: 'announcement.create', requestExample: { reason: 'superseded by the revised dates' } },
    authed('announcement.create', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ reason: string }>(ctx.req, ['reason'])
      await withdrawAnnouncement(ctx.tx, id)
      await emit(ctx.tx, { action: 'comms.announcement.withdrawn', entityType: 'announcement', entityId: id,
        actorUserId: ctx.session.userId, reason: b.reason })
      ctx.publish({ type: 'announcement.withdrawn', data: { announcementId: id } })
      return noContent()
    }))

  router.get('/api/v1/announcements/:id/pending',
    { summary: 'Who has not acknowledged yet', tag: 'comms', permission: 'announcement.create' },
    authed('announcement.create', async (ctx) => {
      return ok({ pending: await pendingAcknowledgements(ctx.tx, asUuid(ctx.req.params.id, 'id')) })
    }))

  router.post('/api/v1/announcements/:id/publish',
    { summary: 'Publish to an audience and start tracking acknowledgement', tag: 'comms',
      permission: 'announcement.create', requestExample: { audienceUserIds: ['…'] } },
    authed('announcement.create', async (ctx) => {
      const b = requireBody<{ audienceUserIds: string[] }>(ctx.req, ['audienceUserIds'])
      const n = await publishAnnouncement(ctx.tx, {
        announcementId: asUuid(ctx.req.params.id, 'id'), audienceUserIds: b.audienceUserIds,
      })
      ctx.publish({
        type: 'announcement.published',
        userIds: b.audienceUserIds,
        data: { announcementId: ctx.req.params.id },
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
