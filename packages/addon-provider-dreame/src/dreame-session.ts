/**
 * Dreame session health — the standard cloud-connection-lost alert. A rejected
 * Dreamehome sign-in (or a token the library can no longer refresh) is a lost
 * session; transport churn and offline robots are not.
 */

import { DreameAuthError } from '@apocaliss92/nodedreame'
import { IntegrationSessionReporter, type SessionLossReason } from '@camstack/types'

export function classifyDreameSessionError(err: unknown): SessionLossReason | null {
  return err instanceof DreameAuthError ? 'auth-rejected' : null
}

/** Process-wide reporter the integration manager reports to; the addon binds it once. */
export const dreameSession = new IntegrationSessionReporter({
  kind: 'dreame',
  providerName: 'Dreame',
  classify: classifyDreameSessionError,
})
