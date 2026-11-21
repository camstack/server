/**
 * Dreo session health — the standard cloud-connection-lost alert. A rejected
 * Dreo sign-in is a lost session; transport churn and offline devices are not.
 */

import { IntegrationSessionReporter, type SessionLossReason } from '@camstack/types'
import { DreoBridgeError } from './dreo-bridge.js'

export function classifyDreoSessionError(err: unknown): SessionLossReason | null {
  return err instanceof DreoBridgeError && err.code === 'auth' ? 'auth-rejected' : null
}

/** Process-wide reporter the integration manager reports to; the addon binds it once. */
export const dreoSession = new IntegrationSessionReporter({
  kind: 'dreo',
  providerName: 'Dreo',
  classify: classifyDreoSessionError,
})
