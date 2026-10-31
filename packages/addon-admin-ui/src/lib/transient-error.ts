/**
 * A query that fails because the thing behind it is being respawned is not
 * broken, it is not-yet-known. Adopting a device or changing a setting restarts
 * the provider addon's runner, and for that window the hub answers a capability
 * call with "provider not available" (or the connection drops). The page renders
 * that as reconnecting and polls again; only an error that lasts, or one that is
 * not about availability at all, is shown as an error.
 */

/** Poll cadence while a failure looks transient. */
export const TRANSIENT_RETRY_MS = 3_000

/**
 * How many consecutive failed refetches still count as "restarting". At
 * `TRANSIENT_RETRY_MS` this is about half a minute — longer than a runner
 * respawn, short enough that a provider that never comes back is reported.
 */
export const TRANSIENT_MAX_FAILURES = 10

/** `capRouteReason` values that mean "the provider is away", not "the call is wrong". */
const TRANSIENT_REASONS: ReadonlySet<string> = new Set([
  'no-provider',
  'node-offline',
  'transport-failed',
])

const TRANSIENT_MESSAGES: readonly string[] = [
  'provider not available',
  'failed to fetch',
  'networkerror',
  'load failed',
]

function capRouteReasonOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const data: unknown = Reflect.get(err, 'data')
  if (typeof data !== 'object' || data === null) return null
  const reason: unknown = Reflect.get(data, 'capRouteReason')
  return typeof reason === 'string' ? reason : null
}

/**
 * Whether `err` (the `error` of a query) is an availability blip rather than a
 * real failure. `failures` is the query's `errorUpdateCount`; past the bound the
 * failure is no longer treated as a blip.
 */
export function isTransientQueryError(err: unknown, failures: number): boolean {
  if (err === null || err === undefined) return false
  if (failures > TRANSIENT_MAX_FAILURES) return false
  const reason = capRouteReasonOf(err)
  if (reason !== null) return TRANSIENT_REASONS.has(reason)
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return TRANSIENT_MESSAGES.some((needle) => message.includes(needle))
}

interface TransientQueryView {
  readonly state: {
    readonly error: unknown
    readonly errorUpdateCount: number
  }
}

/**
 * `refetchInterval` for a query: poll while it is failing transiently, stay
 * quiet otherwise (a healthy query keeps the caller's own cadence).
 */
export function transientRefetchInterval(query: TransientQueryView): number | false {
  return isTransientQueryError(query.state.error, query.state.errorUpdateCount)
    ? TRANSIENT_RETRY_MS
    : false
}
