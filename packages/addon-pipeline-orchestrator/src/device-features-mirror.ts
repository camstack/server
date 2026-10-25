/**
 * Last-known device features, so a FALLIBLE read cannot destroy a device
 * profile.
 *
 * Why this exists (measured on the live hub, 2026-08-07, deviceId 106 — the
 * Reolink "Baby monitor", a battery camera that is asleep ~99.9% of the time):
 * `lookupDeviceFeatures` collapsed "the read threw" and "the device is not in
 * the registry yet" into the same answer as "this device genuinely has no
 * features" — an empty array. An empty array makes `resolveDeviceProfile`
 * return `null`, so `BATTERY_DEVICE_PROFILE` never applies and `audioMode`
 * falls back to `'always-on'`. The audio-analyzer then subscribes, the
 * subscription is demand on `native:sub`, the broker dials it — and the dial
 * WAKES the camera.
 *
 * Counted over 24 h on the live hub: 12 `Starting detection` passes for 640
 * produced 3 audio subscriptions. Not a misconfiguration — a 25% flake, each
 * instance landing right after a `provider-reolink` restart, which is exactly
 * the window in which the device is briefly absent from the registry while
 * this process keeps running.
 *
 * The discipline is [D49](../../../docs/decisions/adr-0049.md): the gate is
 * mirrored in-memory state refreshed off the read path; a read that FAILS
 * changes nothing, and a read that contradicts the mirror in the direction
 * that DESTROYS work needs a SECOND read to agree.
 *
 * ## The cold-boot hole, and what closes it (2026-08-13)
 *
 * The paragraph that used to be here said: *"what this deliberately does NOT do
 * is persist — a cold orchestrator boot whose very first read fails still
 * resolves `[]`. That residual hole is not papered over, it is logged at
 * `warn`."* The census (§1.1 #18) counted that as one of two open cold-start
 * holes, and it is the one with a physical cost: the log line does not stop the
 * dial, and the dial wakes a battery camera.
 *
 * So the last-known features are now persisted, as a **MIRROR** and nothing
 * more. The distinction is the whole design:
 *
 *  - **The DEVICE remains the authority.** The persisted copy is never the
 *    answer to "what features does this device have" — it is only ever the
 *    answer to "what did we last see, while the authority is unreachable".
 *  - **It is seeded at boot and reconciled by the first real read.** A read
 *    that succeeds overwrites it immediately; the restored copy exists purely
 *    to cover the window between boot and that read, which is exactly the
 *    window in which `provider-reolink` is restarting.
 *  - **A restored copy is still subject to the D49 second-read rule.** Two
 *    reads that agree the device genuinely has no features clear it, restored
 *    or not: a mirror that outlives the truth is its own bug.
 *  - **Serving a restored copy is logged**, so "this decision came from before
 *    the restart" is never something a reader has to infer.
 *
 * Without a store the class behaves exactly as it did — process-local, and the
 * residual hole logged at `warn`. That is the shape the unit tests exercise.
 */

import type { IScopedLogger } from '@camstack/types'

/** One mirrored device. `restored` is DERIVED, never persisted: every row that
 *  comes back from {@link DeviceFeaturesMirror.hydrate} is restored by
 *  definition, and the flag is cleared by the first read that confirms it. */
interface DeviceFeaturesRow {
  readonly deviceId: number
  readonly features: readonly string[]
  readonly updatedAt: number
  readonly restored: boolean
}

/**
 * One attempt at reading a device's features.
 *
 * `null` means **unknown** — the read threw, or the device is not in the
 * registry. It does NOT mean "no features"; an empty array does.
 */
export type DeviceFeaturesRead = () => Promise<readonly string[] | null>

/** The slice of `ctx.settings` the mirror persists through (D865). */
export interface DeviceFeaturesSettings {
  readDeviceStore(deviceId: number): Promise<Record<string, unknown>>
  writeDeviceStore(deviceId: number, patch: Record<string, unknown>): Promise<void>
  readDeviceStoreBatch(
    deviceIds: readonly number[],
  ): Promise<ReadonlyMap<number, Record<string, unknown>>>
  listDeviceStoreIds(): Promise<readonly number[]>
}

/** The per-device settings key a device's mirrored features live under. */
export const DEVICE_FEATURES_KEY = 'deviceFeatures'

export interface DeviceFeaturesMirrorDeps {
  readonly logger: IScopedLogger
  /** Absent ⇒ process-local, exactly as before the persistence landed. */
  readonly settings?: DeviceFeaturesSettings
  /** Clock seam for tests. */
  readonly now?: () => number
}

export class DeviceFeaturesMirror {
  /** Process-local fallback, used only when no store was supplied. */
  private readonly local = new Map<number, DeviceFeaturesRow>()
  private readonly settings: DeviceFeaturesSettings | null
  private readonly logger: IScopedLogger
  private readonly now: () => number

  constructor(deps: DeviceFeaturesMirrorDeps) {
    this.logger = deps.logger
    this.now = deps.now ?? ((): number => Date.now())
    this.settings = deps.settings ?? null
  }

  /**
   * Seed the mirror from the last session. Call once at boot, after `declare`
   * and BEFORE the first `resolve` — the whole value of the row is that it is
   * already there when the first read fails.
   */
  async hydrate(): Promise<number> {
    const settings = this.settings
    if (settings === null) return 0
    const ids = await settings.listDeviceStoreIds()
    for (const [deviceId, blob] of await settings.readDeviceStoreBatch(ids)) {
      const row = rowOf(deviceId, blob[DEVICE_FEATURES_KEY])
      if (row !== null) this.local.set(deviceId, row)
    }
    this.logger.info('device-features mirror restored', {
      meta: { devices: this.local.size },
    })
    return this.local.size
  }

  private held(deviceId: number): DeviceFeaturesRow | undefined {
    return this.local.get(deviceId)
  }

  private async persist(
    deviceId: number,
    features: readonly string[],
    updatedAt: number,
  ): Promise<void> {
    await this.settings?.writeDeviceStore(deviceId, {
      [DEVICE_FEATURES_KEY]: { features: [...features], updatedAt },
    })
  }

  private remember(deviceId: number, features: readonly string[]): void {
    const row: DeviceFeaturesRow = {
      deviceId,
      features: [...features],
      updatedAt: this.now(),
      restored: false,
    }
    const held = this.local.get(deviceId)
    this.local.set(deviceId, row)
    // Only write when the FACT moved. A feature list that has not changed
    // rewriting its row every read is the clock-churn the runtime-state census
    // measured at ~50% of all cold-half writes (§2.7.2); it is not repeated
    // here.
    if (held !== undefined && !held.restored && sameFeatures(held.features, features)) return
    void this.persist(deviceId, features, row.updatedAt).catch((err: unknown) => {
      this.logger.warn('device-features mirror not persisted', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })
  }

  private drop(deviceId: number): void {
    this.local.delete(deviceId)
    void this.settings?.writeDeviceStore(deviceId, { [DEVICE_FEATURES_KEY]: undefined })
  }

  /**
   * Resolve a device's features, preferring a fresh read but never letting a
   * failed or contradicting one erase what we already knew.
   */
  async resolve(deviceId: number, read: DeviceFeaturesRead): Promise<readonly string[]> {
    const first = await read()

    if (first !== null && first.length > 0) {
      // The authority answered. It wins over anything restored, always.
      this.remember(deviceId, first)
      return first
    }

    const heldRow = this.held(deviceId)
    const mirrored = heldRow?.features

    // The read FAILED (or the device is absent). Believe nothing it implies.
    if (first === null) {
      if (mirrored !== undefined) {
        this.logger.warn('device features unavailable — serving last-known mirror', {
          tags: { deviceId },
          // `restored` says the copy predates this process — the difference
          // between "we saw it this session" and "this is what we remembered
          // across the restart", which is the whole point of persisting it.
          meta: { mirrored: mirrored.length, restored: heldRow?.restored === true },
        })
        return mirrored
      }
      this.logger.warn(
        'device features unavailable and no last-known mirror — profile defaults will NOT apply this pass',
        { tags: { deviceId } },
      )
      return []
    }

    // An EMPTY read. Harmless when we never knew better; destructive when it
    // contradicts a device we have seen carry features. D49: make it agree
    // with itself before acting on it.
    if (mirrored === undefined || mirrored.length === 0) return []

    const second = await read()
    if (second !== null && second.length > 0) {
      this.logger.debug('empty device-features read contradicted by a re-read — mirror kept', {
        tags: { deviceId },
        meta: { features: second.length },
      })
      this.remember(deviceId, second)
      return second
    }
    if (second === null) {
      this.logger.warn('device features read empty, re-read failed — keeping last-known mirror', {
        tags: { deviceId },
      })
      return mirrored
    }

    // Both reads agree the device has no features. Accept it, and stop
    // claiming otherwise — a mirror that outlives the truth is its own bug.
    this.logger.info(
      'device features are genuinely empty (confirmed by a re-read) — mirror cleared',
      {
        tags: { deviceId },
        meta: { previously: mirrored.length },
      },
    )
    this.drop(deviceId)
    return []
  }

  /** Drop a device's mirror. (A removed device's settings are cleared centrally, D865.) */
  forget(deviceId: number): void {
    this.drop(deviceId)
  }
}

/** Order-insensitive feature-set equality — the read's order is not a fact. */
function sameFeatures(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const held = new Set(a)
  return b.every((f) => held.has(f))
}

function rowOf(deviceId: number, raw: unknown): DeviceFeaturesRow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const features = Reflect.get(raw, 'features')
  if (!Array.isArray(features)) return null
  const kept = features.filter((f): f is string => typeof f === 'string')
  if (kept.length === 0) return null
  const updatedAt = Number(Reflect.get(raw, 'updatedAt'))
  return {
    deviceId,
    features: kept,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    restored: true,
  }
}
