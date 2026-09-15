const api = '/api/v1/push/subscriptions'

function decodeKey(value) {
  const padded = value.padEnd(value.length + (4 - value.length % 4) % 4, '=')
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

self.addEventListener('push', event => {
  const payload = event.data?.json()
  if (!payload) return
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (windows.some(windowClient => windowClient.focused)) return
    await self.registration.showNotification(payload.title, { body: payload.body, data: payload })
  })())
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const payload = event.notification.data || {}
  const routes = {
    employee: 'people', payslip: 'payroll', payroll_run: 'payroll', leave_request: 'leave',
    approval_request: 'approvals', announcement: 'announcements', mail: 'mail', conversation: 'chat',
  }
  const section = routes[payload.entityType] || 'dashboard'
  const suffix = payload.entityType === 'employee' && payload.entityId ? `/${payload.entityId}` : ''
  const target = new URL(`/#/${section}${suffix}`, self.location.origin).href
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows[0]
    if (existing) { await existing.focus(); return existing.navigate(target) }
    return clients.openWindow(target)
  })())
})

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    let key = event.oldSubscription?.options?.applicationServerKey
    if (!key) {
      const response = await fetch('/api/v1/push/vapid-public-key', { credentials: 'include' })
      if (!response.ok) return
      key = decodeKey((await response.json()).publicKey)
    }
    const subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    await fetch(api, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    })
  })())
})
