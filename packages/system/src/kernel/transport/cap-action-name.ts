/**
 * cap-action-name.ts — single source of truth for Moleculer cap
 * action/service naming conventions.
 *
 * Moleculer service / action naming rules
 * ─────────────────────────────────────────────────────────────────────────────
 * System (manifest) cap:
 *   service  : `${addonId}.${capName}`             (service `name` field)
 *   action   : `${capName}.${method}`              (registered INSIDE the service)
 *   full key : `${addonId}.${capName}.${method}`   (broker.call key)
 *
 * Native (device-scoped) cap:
 *   service  : `${addonId}${NATIVE_PROVIDER_SERVICE_INFIX}.${capName}`
 *   action   : `${method}`                         (registered INSIDE the service)
 *              also aliased as `${capName}.${method}` for bridge discovery
 *   full key : `${addonId}${NATIVE_PROVIDER_SERVICE_INFIX}.${capName}.${method}`
 *
 * Registry-scan helpers:
 *   suffix   : `.${capName}.${method}`  — trailing match against a full action key
 *   bare     : `${capName}.${method}`   — the action key as registered by
 *               addon-service-factory (without the service-name prefix)
 *
 * Parse helper:
 *   parseCapAction(action) → { addonId, capName, method, native }
 *   Inverse of capActionName / capServiceName + ".${method}".
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * All five construction sites that previously built these strings inline now
 * import from here instead:
 *   1. packages/kernel/src/transport/cap-route-resolver.ts (remote dispatch)
 *   2. packages/kernel/src/moleculer/trpc-links.ts (findServiceCandidates + brokerTransportLink)
 *   3. packages/kernel/src/moleculer/addon-service-factory.ts (service action registration)
 *   4. packages/kernel/src/moleculer/device-cap-proxy.ts (native service/proxy)
 *   5. server/backend/src/core/moleculer/moleculer.service.ts (legacy callFn fallback)
 */

// ── Canonical infix constant ──────────────────────────────────────────────────

/**
 * Infix segment that separates the addonId from the capName in the Moleculer
 * service name for device-scoped NATIVE capability providers.
 *
 * Native service name  : `${addonId}${NATIVE_PROVIDER_SERVICE_INFIX}.${capName}`
 * System service name  : `${addonId}.${capName}`  (no infix)
 */
export const NATIVE_PROVIDER_SERVICE_INFIX = '.native-provider' as const

// ── Service / action builders ─────────────────────────────────────────────────

/**
 * Build the Moleculer SERVICE name for a cap provider.
 *
 * System cap : `${addonId}.${capName}`
 * Native cap : `${addonId}${NATIVE_PROVIDER_SERVICE_INFIX}.${capName}`
 */
export function capServiceName(addonId: string, capName: string, native: boolean): string {
  return native ? `${addonId}${NATIVE_PROVIDER_SERVICE_INFIX}.${capName}` : `${addonId}.${capName}`
}

/**
 * Build the full Moleculer ACTION key (broker.call key) for a cap method.
 *
 * System cap : `${addonId}.${capName}.${method}`
 * Native cap : `${addonId}${NATIVE_PROVIDER_SERVICE_INFIX}.${capName}.${method}`
 */
export function capActionName(
  addonId: string,
  capName: string,
  method: string,
  native: boolean,
): string {
  return `${capServiceName(addonId, capName, native)}.${method}`
}

// ── Registry-scan helpers ────────────────────────────────────────────────────

/**
 * Build the trailing SUFFIX used to scan the Moleculer service registry for
 * any service that exposes a given (capName, method) pair.
 *
 * The suffix `.${capName}.${method}` is compared against full action keys via
 * `action.endsWith(suffix)` in `findServiceCandidates` (trpc-links.ts).
 */
export function capActionSuffix(capName: string, method: string): string {
  return `.${capName}.${method}`
}

/**
 * Build the BARE action name — the key under which addon-service-factory
 * registers the action WITHIN a service (i.e. without the addonId prefix).
 *
 * The full broker key is `${addonId}.${bareAction}` for system caps, but the
 * registry scan checks for `bareAction` directly (`a === bareAction`) to catch
 * the case where the service name itself IS the capName (e.g. stream-broker
 * registering `camera-streams.getRtspEntries`).
 */
export function capBareAction(capName: string, method: string): string {
  return `${capName}.${method}`
}

// ── Parse helper ─────────────────────────────────────────────────────────────

/** Result of parsing a full Moleculer action key. */
export interface ParsedCapAction {
  readonly addonId: string
  readonly capName: string
  readonly method: string
  readonly native: boolean
}

/**
 * Parse a full Moleculer action key back into its constituent parts.
 *
 * Handles both forms:
 *   system : `${addonId}.${capName}.${method}`
 *            (splits on first and last dot; 3 segments minimum)
 *   native : `${addonId}${NATIVE_PROVIDER_SERVICE_INFIX}.${capName}.${method}`
 *            (NATIVE_PROVIDER_SERVICE_INFIX = `.native-provider`, so the raw
 *             action has the form `${addonId}.native-provider.${capName}.${method}`)
 *
 * Returns `null` when the action string cannot be parsed into at least 3
 * dot-separated segments.
 *
 * **Parse semantics** — exact inverse of `capActionName`:
 *   capActionName(a, c, m, native)  →  action
 *   parseCapAction(action)          →  { addonId: a, capName: c, method: m, native }
 */
export function parseCapAction(action: string): ParsedCapAction | null {
  // Split into segments on '.'
  const segments = action.split('.')
  // Minimum: addonId, capName, method → 3 segments
  if (segments.length < 3) return null

  // Check for native form: the INFIX is `.native-provider`, so in a split
  // string it appears as a standalone `native-provider` segment.
  // System form: addonId . capName . method
  // Native form: addonId . native-provider . capName . method
  const INFIX_SEGMENT = 'native-provider'

  if (segments[1] === INFIX_SEGMENT && segments.length >= 4) {
    // Native: `${addonId}.native-provider.${capName}.${method}`
    // segments[0] = addonId, segments[1] = 'native-provider',
    // segments[2] = capName, segments[3..] = method (last segment)
    const addonId = segments[0]!
    // capName is segments[2], method is the LAST segment.
    // Everything between [2] and the last segment (exclusive) is part of
    // capName in case capName itself contained dots (not current convention
    // but defensive). Per current convention capName has no dots.
    const method = segments[segments.length - 1]!
    const capName = segments.slice(2, segments.length - 1).join('.')
    if (!addonId || !capName || !method) return null
    return { addonId, capName, method, native: true }
  }

  // System form: `${addonId}.${capName}.${method}`
  // addonId = segments[0], capName = segments[1..n-2], method = segments[n-1]
  const addonId = segments[0]!
  const method = segments[segments.length - 1]!
  const capName = segments.slice(1, segments.length - 1).join('.')
  if (!addonId || !capName || !method) return null
  return { addonId, capName, method, native: false }
}
