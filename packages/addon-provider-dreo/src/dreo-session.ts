/**
 * Dreo session health — the standard cloud-connection-lost alert. A rejected
 * Dreo sign-in is a lost session; transport churn and offline devices are not.
 */

import { IntegrationSessionReporter, type SessionLossReason } from '@dominevo/types'
import { DreoBridgeError } from './dreo-bridge.js'

/** The worker kept crashing and its respawn budget is spent: the account is offline for good. */
export class DreoWorkerGaveUpError extends Error {
  constructor(readonly attempts: number) {
    super(`the Dreo worker stopped ${attempts} times and was not restarted again`)
    this.name = 'DreoWorkerGaveUpError'
  }
}

export function classifyDreoSessionError(err: unknown): SessionLossReason | null {
  if (err instanceof DreoWorkerGaveUpError) return 'connection-lost'
  return err instanceof DreoBridgeError && err.code === 'auth' ? 'auth-rejected' : null
}

/** Process-wide reporter the integration manager reports to; the addon binds it once. */
export const dreoSession = new IntegrationSessionReporter({
  kind: 'dreo',
  providerName: 'Dreo',
  classify: classifyDreoSessionError,
})
