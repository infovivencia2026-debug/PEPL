import { ApiError } from './api'
import { domainApi } from './domainApi'

export type PushDevice = {
  endpoint: string
  user_agent: string | null
  created_at: string
  last_used_at: string | null
}

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.padEnd(value.length + (4 - value.length % 4) % 4, '=')
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export async function registerPeplWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  return navigator.serviceWorker.register('/sw.js')
}

export async function pushAvailability(): Promise<{ registration: ServiceWorkerRegistration; publicKey: string } | null> {
  if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) return null
  try {
    const [{ publicKey }, registration] = await Promise.all([
      domainApi<{ publicKey: string }>('/push/vapid-public-key'),
      navigator.serviceWorker.ready,
    ])
    return { registration, publicKey }
  } catch (error) {
    if (error instanceof ApiError && (error.status === 503 || error.isModuleUnavailable)) return null
    throw error
  }
}

/** Must only be called from a click or other user gesture. */
export async function subscribeCurrentDevice(registration: ServiceWorkerRegistration, publicKey: string): Promise<PushSubscription> {
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notifications are blocked in this browser. You can allow them in the site settings.')
  const existing = await registration.pushManager.getSubscription()
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(publicKey),
  })
  await domainApi('/push/subscriptions', subscription.toJSON())
  return subscription
}

export async function removePushDevice(endpoint: string, current?: PushSubscription | null): Promise<void> {
  if (current?.endpoint === endpoint) await current.unsubscribe()
  await domainApi('/push/subscriptions', { endpoint }, 'DELETE')
}

export async function removeCurrentPushSubscription(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return
  await subscription.unsubscribe()
  await domainApi('/push/subscriptions', { endpoint: subscription.endpoint }, 'DELETE')
}
