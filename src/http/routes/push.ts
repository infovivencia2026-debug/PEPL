/**
 * Web Push subscriptions.
 *
 * Any signed-in person may register their own device; there is no permission
 * because there is nothing to protect — a subscription only lets PEPL send
 * notifications the person would see in the bell anyway. Ownership is the
 * check: you register and remove YOUR devices.
 */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, noContent, requireBody, requireModule } from './deps.ts'
import { listSubscriptions, removeSubscription, saveSubscription } from '../../comms/push.ts'
import { vapidFromEnv } from '../../comms/web-push.ts'

export function register(router: Router): void {
  router.get('/api/v1/push/vapid-public-key',
    { summary: 'The server key a browser needs to subscribe; 503 when push is not configured',
      tag: 'comms' },
    authed(null, async (ctx) => {
      requireModule(ctx, 'notifications.enabled')
      const keys = vapidFromEnv()
      if (!keys || !ctx.config.get<boolean>('notifications.push_enabled')) {
        throw new HttpError(503, 'PUSH_NOT_CONFIGURED', 'push notifications are not available here')
      }
      return ok({ publicKey: keys.publicKey })
    }))

  router.get('/api/v1/push/subscriptions',
    { summary: 'My registered devices', tag: 'comms' },
    authed(null, async (ctx) => ok({ subscriptions: await listSubscriptions(ctx.tx, ctx.auth.userId) })))

  router.post('/api/v1/push/subscriptions',
    { summary: 'Register this browser (the PushSubscription.toJSON() shape)', tag: 'comms',
      requestExample: { endpoint: 'https://fcm.googleapis.com/fcm/send/…', keys: { p256dh: '…', auth: '…' } } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'notifications.enabled')
      const b = requireBody<{ endpoint: string; keys: { p256dh: string; auth: string } }>(ctx.req, ['endpoint', 'keys'])
      if (typeof b.keys?.p256dh !== 'string' || typeof b.keys?.auth !== 'string') {
        throw new HttpError(422, 'VALIDATION_FAILED', 'keys.p256dh and keys.auth are required')
      }
      const subscription = await saveSubscription(ctx.tx, {
        userId: ctx.auth.userId, endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth,
        userAgent: typeof ctx.req.headers['user-agent'] === 'string' ? ctx.req.headers['user-agent'] : null,
      })
      return ok({ subscription })
    }))

  router.del('/api/v1/push/subscriptions',
    { summary: 'Unregister this browser', tag: 'comms', requestExample: { endpoint: 'https://…' } },
    authed(null, async (ctx) => {
      const b = requireBody<{ endpoint: string }>(ctx.req, ['endpoint'])
      await removeSubscription(ctx.tx, ctx.auth.userId, b.endpoint)
      return noContent()
    }))
}
