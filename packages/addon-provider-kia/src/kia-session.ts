/**
 * Kia session health: the standard cloud-connection-lost alert. A rejected sign-in is a lost
 * session, and so is an account that now asks for a one-time code (the worker cannot answer
 * it); transport churn and an asleep car are not.
 */

import { IntegrationSessionReporter, type SessionLossReason } from '@dominevo/types'
import { KiaBridgeError } from './kia-bridge.js'

export function classifyKiaSessionError(err: unknown): SessionLossReason | null {
  if (!(err instanceof KiaBridgeError)) return null
  return err.code === 'auth' || err.code === 'otp-required' ? 'auth-rejected' : null
}

/** Process-wide reporter the integration manager reports to; the addon binds it once. */
export const kiaSession = new IntegrationSessionReporter({
  kind: 'kia',
  providerName: 'Kia Connect',
  classify: classifyKiaSessionError,
})
