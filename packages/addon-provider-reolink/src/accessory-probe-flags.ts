/**
 * Pure helpers that decide which probe flags drive accessory-child
 * derivation, and whether a Reolink camera has *ever* been probed.
 *
 * Why this exists as its own module: the `feature-probe` runtime-state
 * slice is the live, in-session source of the camera's ability flags
 * (`hasSiren` / `hasFloodlight` / `hasPirSensor` / …). It is rehydrated
 * on restart, BUT a camera whose Baichuan `getDeviceCapabilities`
 * round-trip is slow or flaky (observed: a doorbell that times out the
 * kernel's 30s `onProbe` window on every boot) restores with an empty
 * slice (`lastProbedAt === 0`). The `deviceCache` config blob — written
 * alongside the slice on the LAST successful probe and preserved across
 * restarts by the camera schema's `.loose()` passthrough — still carries
 * that probe's flags plus a `probedAt` stamp.
 *
 * Deriving accessory specs from the `deviceCache` fallback lets the
 * kernel re-spawn the persisted accessory children (and therefore
 * re-mount their kernel-managed `device-ops` provider) even when this
 * session's live probe never completes. Without it, every accessory of
 * a slow-probing camera is left as a DB row with no live provider
 * ("device-ops not registered for device N").
 *
 * Kept pure (no `this`, no I/O) so the slice-vs-cache precedence is
 * unit-testable without standing up a full camera device.
 */

import { AccessoryKind, type AccessoryKindValue } from '@camstack/types'

/**
 * Reolink ability flags as stored in BOTH the `feature-probe` slice's
 * `flags` bag AND (historically + still, via `.loose()`) the
 * `deviceCache` config blob. Every field is optional — `undefined`
 * means "this probe didn't fill it".
 */
export interface ReolinkAccessoryProbeFlags {
  hasBattery?: boolean
  hasPtz?: boolean
  hasIntercom?: boolean
  hasDoorbell?: boolean
  hasFloodlight?: boolean
  hasSiren?: boolean
  hasPirSensor?: boolean
  hasAutotrack?: boolean
}

const FLAG_KEYS: ReadonlyArray<keyof ReolinkAccessoryProbeFlags> = [
  'hasBattery',
  'hasPtz',
  'hasIntercom',
  'hasDoorbell',
  'hasFloodlight',
  'hasSiren',
  'hasPirSensor',
  'hasAutotrack',
]

/**
 * Minimal read surface this module needs from the persisted
 * `deviceCache` config blob. `probedAt` is the completed-probe stamp;
 * the boolean ability flags are read by key (the blob is `.loose()`, so
 * the flags survive even though they're not declared on the schema).
 */
export interface DeviceCacheProbeView {
  readonly probedAt?: number
  readonly [key: string]: unknown
}

/**
 * True when EITHER the live `feature-probe` slice has completed a probe
 * this session (`sliceProbed`) OR a prior successful probe is persisted
 * in the `deviceCache` config blob (`probedAt` stamp). The latter
 * survives restarts, so a camera probed in an earlier session is still
 * "probed" for accessory-derivation purposes even if its live probe is
 * currently slow/failing.
 */
export function hasEverProbed(
  sliceProbed: boolean,
  deviceCache: DeviceCacheProbeView | undefined,
): boolean {
  return sliceProbed || deviceCache?.probedAt !== undefined
}

/**
 * Effective ability flags for accessory derivation: the live slice
 * flags when the slice has probed this session, otherwise the boolean
 * flags persisted in `deviceCache` from the last successful probe.
 * Returns an empty bag when neither source carries a completed probe.
 */
export function resolveAccessoryProbeFlags(
  sliceProbed: boolean,
  sliceFlags: ReolinkAccessoryProbeFlags,
  deviceCache: DeviceCacheProbeView | undefined,
): ReolinkAccessoryProbeFlags {
  if (sliceProbed) return sliceFlags
  if (deviceCache?.probedAt === undefined) return {}
  const out: ReolinkAccessoryProbeFlags = {}
  for (const key of FLAG_KEYS) {
    const value = deviceCache[key]
    if (typeof value === 'boolean') out[key] = value
  }
  return out
}

/**
 * The `deviceCache` blob a successful feature probe leaves behind: the
 * previous blob, plus the `probedAt` stamp and every boolean ability flag
 * the probe resolved. This is what lets {@link resolveAccessoryProbeFlags}
 * fall back on the next boot — a battery camera asleep at boot skips its
 * probe, and the `feature-probe` slice alone does not carry the flags
 * across a provider restart. Returns a new object; `previous` is untouched.
 */
export function withPersistedProbe(
  previous: Readonly<Record<string, unknown>>,
  flags: ReolinkAccessoryProbeFlags,
  probedAt: number,
): Record<string, unknown> {
  const persisted: Record<string, boolean> = {}
  for (const key of FLAG_KEYS) {
    const value = flags[key]
    if (typeof value === 'boolean') persisted[key] = value
  }
  return { ...previous, ...persisted, probedAt }
}

/** The accessory children a probe flag set spawns, in spawn order. */
const ACCESSORY_FLAGS: ReadonlyArray<
  readonly [keyof ReolinkAccessoryProbeFlags, AccessoryKindValue]
> = [
  ['hasSiren', AccessoryKind.Siren],
  ['hasFloodlight', AccessoryKind.Floodlight],
  ['hasPirSensor', AccessoryKind.PirSensor],
]

/**
 * Accessory kinds a camera should spawn: none until it has EVER probed
 * (live slice this session, or a persisted `probedAt`), then one per
 * ability flag that is exactly `true` — live slice first, persisted
 * `deviceCache` flags as the fallback.
 */
export function accessoryKindsFor(
  sliceProbed: boolean,
  sliceFlags: ReolinkAccessoryProbeFlags,
  deviceCache: DeviceCacheProbeView | undefined,
): AccessoryKindValue[] {
  if (!hasEverProbed(sliceProbed, deviceCache)) return []
  const flags = resolveAccessoryProbeFlags(sliceProbed, sliceFlags, deviceCache)
  return ACCESSORY_FLAGS.filter(([flag]) => flags[flag] === true).map(([, kind]) => kind)
}

/**
 * The probe flags every probe-gated decision should read (PTZ, intercom,
 * doorbell, autotrack caps, the device features, accessory children):
 * the live slice once this session has probed; otherwise the slice
 * overlaid with the flags persisted by the last successful probe. A
 * battery camera asleep at boot skips its probe, so without the overlay
 * its probe-gated caps vanish across every provider restart. With no
 * persisted probe stamp, the slice is returned unchanged.
 */
export function effectiveProbeFlags<F extends Record<string, unknown>>(
  sliceProbed: boolean,
  sliceFlags: F,
  deviceCache: DeviceCacheProbeView | undefined,
): F {
  if (sliceProbed || deviceCache?.probedAt === undefined) return sliceFlags
  return { ...sliceFlags, ...resolveAccessoryProbeFlags(false, {}, deviceCache) }
}
