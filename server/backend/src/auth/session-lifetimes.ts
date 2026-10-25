/**
 * The two lifetimes of a login (System → Authentication):
 *
 *  - `auth.tokenExpiry` — how long a SESSION lives without being used
 *    (sliding: every refresh or renewal moves it), default 30 days;
 *  - `auth.accessTokenExpiry` — how long one ACCESS token lives before a
 *    refreshing client swaps it, default 2 hours, bounded to [5 min, 24 h]
 *    and never past the session.
 *
 * Read per mint (the hub's ConfigService answers from memory), so a change
 * applies to the next login or refresh. A value that does not parse falls
 * back to the default — never to something longer.
 */
import { parseTokenExpiry } from '@camstack/system'

export const ACCESS_TOKEN_EXPIRY_KEY = 'auth.accessTokenExpiry'
export const SESSION_LIFETIME_KEY = 'auth.tokenExpiry'
export const DEFAULT_ACCESS_TOKEN_EXPIRY = '2h'

const DEFAULT_ACCESS_SEC = 2 * 3600
const MIN_ACCESS_SEC = 5 * 60
const MAX_ACCESS_SEC = 24 * 3600

export interface SessionLifetimes {
  /** Session lifetime (sliding), milliseconds. */
  readonly sessionMs: number
  /** Access-token lifetime for a refreshing client, seconds (≤ the session). */
  readonly accessSec: number
}

export type LifetimeReader = (key: string) => unknown

function safeRead(read: LifetimeReader, key: string): unknown {
  try {
    return read(key)
  } catch {
    return undefined
  }
}

export function readSessionLifetimes(read: LifetimeReader): SessionLifetimes {
  const session = parseTokenExpiry(safeRead(read, SESSION_LIFETIME_KEY))
  const configuredAccess = safeRead(read, ACCESS_TOKEN_EXPIRY_KEY)
  const access =
    configuredAccess === undefined || configuredAccess === null || configuredAccess === ''
      ? null
      : parseTokenExpiry(configuredAccess)
  const accessSec =
    access !== null && access.ok
      ? Math.min(MAX_ACCESS_SEC, Math.max(MIN_ACCESS_SEC, access.seconds))
      : DEFAULT_ACCESS_SEC
  return {
    sessionMs: session.seconds * 1000,
    accessSec: Math.min(accessSec, session.seconds),
  }
}
