import type { ChildCapDescriptor } from '../transport/child-cap-protocol.js'

/** One hosted addon's contribution to the runner UNION manifest. */
export interface RunnerManifestEntry {
  readonly addonId: string
  readonly capabilities: readonly string[]
}

/** One native-cap snapshot row — a device-scoped cap and the devices it covers. */
export interface NativeCapSnapshotEntry {
  readonly capName: string
  readonly addonId: string
  readonly deviceIds: readonly number[]
}

/**
 * Builds the {@link ChildCapDescriptor} array that the UDS child transport
 * sends to the parent on registration.
 *
 * - Singleton caps come from the runner UNION manifest (all caps registered by
 *   every addon in this runner). One descriptor per unique (addonId, capName)
 *   pair, mode `'singleton'` and no `deviceId`. The `addonId` stamp lets the
 *   parent's manifest builder register each hosted addon's caps under the
 *   REAL addon id — a GROUPED runner (`execution.group`) hosts several addons,
 *   and deduplicating by capName alone would collapse two co-located providers
 *   of the same collection cap (e.g. `network-access` from cloudflare-tunnel
 *   AND tailscale-ingress) into one descriptor registered under a synthetic
 *   `addonId = childId` (the group name) — the "@camstack/addon-net-access"
 *   admin-UI bug.
 * - Device-scoped caps come from the native-cap snapshot — one descriptor per
 *   (capName, deviceId) pair, mode `'collection'`, stamped with the owning
 *   addon's id.
 *
 * Pure module — extracted from `addon-runner.ts` (whose `main()` runs at
 * import time) so it is unit-testable.
 */
export function buildChildCapDescriptors(
  manifest: readonly RunnerManifestEntry[],
  nativeCapSnapshot: readonly NativeCapSnapshotEntry[],
): ChildCapDescriptor[] {
  const descriptors: ChildCapDescriptor[] = []

  // Singleton caps — deduplicate per (addonId, capName)
  const seen = new Set<string>()
  for (const entry of manifest) {
    for (const capName of entry.capabilities) {
      const key = `${entry.addonId}::${capName}`
      if (!seen.has(key)) {
        seen.add(key)
        descriptors.push({ capName, mode: 'singleton', addonId: entry.addonId })
      }
    }
  }

  // Device-scoped caps — one descriptor per (capName, deviceId)
  for (const { capName, addonId, deviceIds } of nativeCapSnapshot) {
    for (const deviceId of deviceIds) {
      descriptors.push({ capName, mode: 'collection', deviceId, addonId })
    }
  }

  return descriptors
}
