/**
 * Shared capability-error utilities for the admin UI.
 *
 * The primary export `isAbsentProvider` lets UI components distinguish
 * "this device doesn't have this cap" (expected — hide the widget) from
 * "something went wrong while calling a present cap" (unexpected — surface
 * the error to the operator).
 *
 * Detection strategy (two-tier):
 *
 *   1. **Typed reason** (preferred): tRPC's errorFormatter augments the
 *      error shape with `data.capRouteReason` when the server throws a
 *      CapRouteError. Read it from `err.data?.capRouteReason` to avoid
 *      brittle string matching.
 *
 *   2. **Substring fallback** (transitional safety): older error paths
 *      that don't carry a typed reason still emit the human-readable
 *      message "provider not available". The fallback is ONLY engaged
 *      when `capRouteReason` is absent — future clean-up can drop it
 *      once every throw site has been migrated.
 */

/**
 * Extract the typed `capRouteReason` field from a serialized tRPC error.
 *
 * tRPC client errors typically look like:
 *   `{ data: { capRouteReason: 'no-provider', ... }, message: '...', ... }`
 *
 * We read it via Reflect.get without casts so TypeScript remains happy.
 * Returns `null` when the field is absent (non-CapRouteError paths).
 *
 * The return type is `string | null` — callers compare the plain string
 * to known literals, which compiles without any cast.
 */
function readCapRouteReason(err: unknown): string | null {
  if (err === null || err === undefined || typeof err !== 'object') return null

  // err.data?.capRouteReason — standard tRPC client error shape
  const data: unknown = Reflect.get(err, 'data')
  if (data !== null && data !== undefined && typeof data === 'object') {
    const reason: unknown = Reflect.get(data, 'capRouteReason')
    if (typeof reason === 'string') {
      return reason
    }
  }

  return null
}

/**
 * Returns `true` when `err` indicates that the requested capability has
 * no provider bound for the device — i.e. the device legitimately does
 * not expose this cap and the UI should stay hidden / show a friendly
 * "not supported" message.
 *
 * Returns `false` for real dispatch errors (`transport-failed`) — those
 * should be surfaced to the operator as unexpected failures.
 *
 * ## Absent-provider reasons
 * - `'no-provider'`  — no provider is registered for this cap/device pair.
 * - `'node-offline'` — the node that hosts the cap is not reachable; the
 *   device is effectively unavailable so we treat it as absent.
 *
 * ## Not-absent reasons
 * - `'transport-failed'` — a provider exists but the call failed in transit.
 * - `'cap-unknown'`      — the cap name isn't registered at all; treat as
 *   a real error (likely a programming mistake or version skew).
 */
export function isAbsentProvider(err: unknown): boolean {
  const reason = readCapRouteReason(err)

  if (reason !== null) {
    // Typed path — prefer over substring matching.
    // node-offline: device/cap is unreachable → treat as absent (hide widget).
    // transport-failed: something broke in transit → NOT absent, surface error.
    return reason === 'no-provider' || reason === 'node-offline'
  }

  // Substring fallback — engaged ONLY when capRouteReason is absent.
  // Covers legacy throw sites that haven't been migrated to CapRouteError yet.
  // TODO: remove once every absence throw carries a CapRouteError cause.
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('provider not available')
}
