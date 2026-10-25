/**
 * Derive the dominant integration / platform domain for an HA device from
 * its entities' HA `entity_registry.platform` values.
 *
 * HA's `entity_registry` entry carries a `platform` field naming the
 * integration that created the entity (e.g. `dreame_vacuum`, `unifi`,
 * `hacs`). A physical device often surfaces entities from BOTH its real
 * integration AND generic/helper integrations (UniFi presence trackers,
 * HACS update sensors, supervisor diagnostics, companion-app presence). The
 * device's identity for adoption search is its REAL integration, so the noise
 * platforms are excluded when at least one real platform is present. When ALL
 * platforms are noise, the function falls back to the first platform verbatim
 * (rather than returning `null`) so the device still carries a label.
 *
 * This is a pure helper so the derivation is unit-testable without a live
 * HA WebSocket. `fetchHaDiscoveredDevices` reads each entity's `platform`
 * off the raw registry entry and feeds the list here.
 */

/**
 * Known generic / helper platforms that should NOT win the integration
 * label when a real integration platform is also present on the device.
 */
const NOISE_PLATFORMS: ReadonlySet<string> = new Set(['unifi', 'hacs', 'hassio', 'mobile_app'])

/**
 * Pick the dominant REAL integration platform for a device.
 *
 * - Counts platforms, excluding the known-noise set.
 * - Returns the most common real platform (ties broken by first appearance).
 * - Falls back to the first platform of any kind when ALL are noise.
 * - Returns `null` when the device has no entities / no platforms.
 */
export function deriveIntegrationDomain(platforms: readonly (string | null)[]): string | null {
  const present = platforms.filter((p): p is string => typeof p === 'string' && p.length > 0)
  if (present.length === 0) return null

  const counts = new Map<string, number>()
  for (const platform of present) {
    counts.set(platform, (counts.get(platform) ?? 0) + 1)
  }

  let best: string | null = null
  let bestCount = 0
  // Iterate `present` (not `counts`) so ties resolve to first appearance.
  for (const platform of present) {
    if (NOISE_PLATFORMS.has(platform)) continue
    const count = counts.get(platform) ?? 0
    if (count > bestCount) {
      best = platform
      bestCount = count
    }
  }

  // All platforms were noise → fall back to the first one verbatim.
  // `present` is non-empty (guarded above), so `present[0]` is defined.
  return best ?? present[0] ?? null
}
