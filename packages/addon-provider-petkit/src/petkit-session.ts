/**
 * PetKit session health — turns the client's "your session is gone" responses
 * into the standard cloud-connection-lost alert (`SessionHealthTracker`).
 *
 * PetKit's cloud keeps ONE session per account: signing the same account in on
 * the phone app (or another install) invalidates ours. The client is a plain
 * REST client holding a fixed session id, so every later call fails until the
 * operator re-saves the integration. Those failures are what we classify here;
 * network errors and per-device errors are deliberately NOT a session loss.
 */

import { PetkitApiError, PetkitAuthError } from '@apocaliss92/nodepetkit'
import {
  IntegrationSessionReporter,
  type IntegrationSessionSink,
  type SessionLossReason,
} from '@camstack/types'

/** PetKit application code for "session expired / not logged in". */
const SESSION_EXPIRED_CODE = 5
const OTHER_DEVICE_PATTERN = /another|other device|elsewhere|kick|replaced/i
const SESSION_PATTERN = /session|not logged|log(?:ged)? ?in|token|unauthori[sz]ed|expired/i
const HTTP_AUTH_PATTERN = /returned (?:401|403)\b/

/**
 * Is `err` PetKit saying our session is over? `null` for everything else
 * (transport failures, an offline feeder, a server error): those retry.
 */
export function classifyPetkitSessionError(err: unknown): SessionLossReason | null {
  if (err instanceof PetkitAuthError) return 'auth-rejected'
  if (!(err instanceof PetkitApiError)) return null
  if (OTHER_DEVICE_PATTERN.test(err.message) && SESSION_PATTERN.test(err.message)) return 'kicked'
  if (err.code === SESSION_EXPIRED_CODE) return 'token-expired'
  if (HTTP_AUTH_PATTERN.test(err.message)) return 'token-expired'
  if (SESSION_PATTERN.test(err.message)) return 'token-expired'
  return null
}

/** Process-wide entry the manager and the feeder devices report to; the addon binds it once. */
export const petkitSession = new IntegrationSessionReporter({
  kind: 'petkit',
  providerName: 'PetKit',
  classify: classifyPetkitSessionError,
})

export type PetkitSessionSink = IntegrationSessionSink
