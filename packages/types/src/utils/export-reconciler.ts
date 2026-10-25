import { canonicalHash } from './canonical-hash.js'

/**
 * Pure, stateless primitives shared by the camera export addons (Alexa, HAP)
 * to advertise devices to external ecosystems without re-discovery storms.
 *
 * Spec: docs/superpowers/specs/2026-06-01-alexa-hap-export-reconciler-design.md
 *
 * Two functions, both pure (no I/O, no clock, no randomness, no event
 * subscriptions) so they are exhaustively unit-testable in isolation:
 *
 *   1) `canonicalDeviceFingerprint(shape)` — a stable hash of the
 *      EXPORT-RELEVANT device shape (coarse type + the persisted
 *      `DeviceFeature` set). Order-independent and de-duplicated, so an
 *      unchanged device produces an identical fingerprint across restarts.
 *      Identity (`deviceId`) and volatile runtime values (online, battery%,
 *      name, location) are deliberately excluded.
 *
 *   2) `diffExportTargets(desired, lastAdvertised)` — a 3-way set diff keyed
 *      by `deviceId`: what to add, what to update (fingerprint changed), what
 *      to remove (no longer desired). Each exporter feeds its own persisted
 *      per-target sync state in and applies the resulting delta to its
 *      platform.
 *
 * The wiring — event subscription, boot scan, platform apply, persistence —
 * stays in each exporter; only the fingerprint + diff are shared.
 */

/** The export-relevant projection of a device, fed into the fingerprint. */
export interface DeviceExportShape {
  /** Numeric device id. Identity only — NOT part of the fingerprint. */
  readonly deviceId: number
  /**
   * Coarse driver classification (e.g. `'camera' | 'battery-camera' | 'nvr'`),
   * sourced from the `feature-probe` slice's `deviceType`. Part of the shape:
   * the same feature set on a different device class can map to a different
   * export surface.
   */
  readonly deviceType: string
  /**
   * Export-relevant `DeviceFeature` values (e.g. `'pan-tilt-zoom'`,
   * `'two-way-audio'`, `'doorbell-button'`, `'motion-trigger'`,
   * `'battery-operated'`, `'ptz-autotrack'`). Sourced from the PERSISTED
   * `PersistedDeviceMeta.features`, so it survives restart and is stable
   * without a re-probe. Hashed order-independently + de-duplicated.
   */
  readonly features: readonly string[]
}

/**
 * Compute the stable 64-char lowercase-hex fingerprint of a device's
 * export-relevant shape. Two structurally-equal shapes (any feature order,
 * any duplicates, any deviceId) hash identically.
 */
export function canonicalDeviceFingerprint(shape: DeviceExportShape): string {
  const features = [...new Set(shape.features)].toSorted()
  return canonicalHash({ deviceType: shape.deviceType, features })
}

/** Per-export-target sync state for one device, persisted addon-side. */
export interface ExportTargetEntry {
  /** Fingerprint last advertised to this target for this device. */
  readonly fingerprint: string
  /**
   * Platform-specific external ids (Alexa endpoint ids, HAP accessory UUIDs).
   * Opaque to the diff — carried so the exporter can address what to update or
   * delete on its platform.
   */
  readonly externalIds: readonly string[]
}

/** The 3-way delta produced by `diffExportTargets`. */
export interface ExportDelta<T> {
  /** Desired devices with no last-advertised entry — publish fresh. */
  readonly toAdd: readonly T[]
  /** Desired devices whose fingerprint differs from last-advertised — re-advertise. */
  readonly toUpdate: readonly T[]
  /** `deviceId`s present in last-advertised but absent from desired — retract. */
  readonly toRemove: readonly number[]
}

/**
 * Pure 3-way diff of desired export state against the persisted
 * last-advertised state, keyed by `deviceId`.
 *
 * - `desired` — one entry per device to advertise this cycle, each carrying
 *   the freshly-computed `fingerprint`.
 * - `lastAdvertised` — the exporter's persisted per-target sync state.
 *
 * Neither input is mutated.
 */
export function diffExportTargets<T extends { deviceId: number; fingerprint: string }>(
  desired: readonly T[],
  lastAdvertised: ReadonlyMap<number, ExportTargetEntry>,
): ExportDelta<T> {
  const toAdd: T[] = []
  const toUpdate: T[] = []
  const desiredIds = new Set<number>()

  for (const entry of desired) {
    desiredIds.add(entry.deviceId)
    const previous = lastAdvertised.get(entry.deviceId)
    if (previous === undefined) {
      toAdd.push(entry)
    } else if (previous.fingerprint !== entry.fingerprint) {
      toUpdate.push(entry)
    }
    // unchanged fingerprint → no delta
  }

  const toRemove: number[] = []
  for (const deviceId of lastAdvertised.keys()) {
    if (!desiredIds.has(deviceId)) toRemove.push(deviceId)
  }

  return { toAdd, toUpdate, toRemove }
}

/**
 * Resolve the fingerprint an exporter should feed into `diffExportTargets`
 * for one device this cycle.
 *
 * When a device is NOT yet probe-ready, carry forward its last-advertised
 * (persisted) fingerprint so it nets to NO CHANGE in `diffExportTargets`
 * (neither update nor remove) — never advertise a partial mid-probe shape. A
 * brand-new un-probed device with no persisted entry falls back to `fresh` so
 * it can advertise once.
 */
export function resolveExportFingerprint(input: {
  ready: boolean
  fresh: string
  persisted: string | undefined
}): string {
  if (input.ready) return input.fresh
  return input.persisted ?? input.fresh
}
