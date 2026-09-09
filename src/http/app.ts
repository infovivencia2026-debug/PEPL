/**
 * Builds the API router.
 *
 * Kept separate from server.ts so tests can mount the same routes on an
 * ephemeral port without the module starting a listener as a side effect.
 */
import type { Router } from './router.ts'
import { router } from './routes.ts'

export function buildRouter(): Router {
  return router
}

