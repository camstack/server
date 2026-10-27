/**
 * Dreo session health — the standard cloud-connection-lost alert. A rejected
 * Dreo sign-in is a lost session; transport churn and offline devices are not.
 */

import { DreoAuthError } from '@apocaliss92/nodedreo'
import { IntegrationSessionReporter, type SessionLossReason } from '@camstack/types'

export function classifyDreoSessionError(err: unknown): SessionLossReason | null {
  return err instanceof DreoAuthError ? 'auth-rejected' : null
}

/** Process-wide reporter the integration manager reports to; the addon binds it once. */
export const dreoSession = new IntegrationSessionReporter({
  kind: 'dreo',
  providerName: 'Dreo',
  classify: classifyDreoSessionError,
})
