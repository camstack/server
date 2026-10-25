/**
 * DetectionCoverageCache — fleet-seeded, event-invalidated mirror of WHICH
 * devices carry a WRAPPED `detection-pipeline` binding. This is the alarm's
 * coverage authority ("Away armed, 12 cameras" is false if three of them are
 * offline or no longer wrapped), read by the notification centre's device
 * directory (`listDeviceIdentities`).
 *
 * WHY a mirror, not a per-tick sweep. The directory refreshes on the NC's 30 s
 * rule-reload tick. Answering "who still has detection?" with a fleet-wide
 * `getAllBindings` on EVERY tick cost 903 ms / 373 KB / ~505 `getBindings:
 * default wrappers skipped` log lines on the live hub (524 devices), forever —
 * ~3% of hub-main's main thread plus a permanent log-spam baseline. Same defect
 * and fix as `SystemMirror.refreshBinding` (639073e8): ONE fleet read to warm,
 * then per-device updates driven by `DeviceBindingsChanged` events. A wrapper
 * toggle emits that event carrying the device's id and `capName`
 * (`detection-pipeline`), so a single `getBindings(deviceId)` — 21 ms / 613 B —
 * keeps the mirror current without ever touching the fleet again.
 *
 * ── Destructive-direction discipline (D49) ──────────────────────────────────
 *
 * `detectionActive: false` reports a camera as UNCOVERED / switched-off (D62) —
 * the destructive answer, and the one an operator reads as "my alarm is not
 * watching that door". A transient `getBindings` blip must never flip a
 * known-covered camera to uncovered:
 *   • a failed refresh KEEPS the previous value (a read that throws changes
 *     nothing), and
 *   • a single read that would flip a known `true → false` is confirmed by a
 *     concordant SECOND read before it lands — an empty binding list is not
 *     proof the wrapper is gone.
 * A COLD mirror (seed not yet landed, or a seed that failed) answers `undefined`
 * for every id — and unknown never reports a camera as excluded from coverage.
 */

import { DETECTION_PIPELINE_CAP_NAME, type AddonApi, type IScopedLogger } from '@camstack/types'

export interface DetectionCoverageCacheDeps {
  readonly api: AddonApi
  readonly logger: IScopedLogger
}

/** The `DeviceBindingsChanged` shape this cache consumes (a subset of the bus
 *  payload — same fields `BindingCache` reads). */
export interface DetectionBindingsChangedEvent {
  readonly deviceId: number
  readonly capName: string
  readonly reason:
    | 'native-registered'
    | 'native-unregistered'
    | 'wrapper-activated'
    | 'wrapper-deactivated'
}

export class DetectionCoverageCache {
  private readonly api: AddonApi
  private readonly logger: IScopedLogger
  /** deviceId → "has a WRAPPED detection-pipeline binding". Absent = unknown. */
  private readonly state = new Map<number, boolean>()
  private warm = false
  private seeding: Promise<void> | null = null

  constructor(deps: DetectionCoverageCacheDeps) {
    this.api = deps.api
    this.logger = deps.logger
  }

  /** Has the ONE fleet seed ever landed? A cold mirror knows nothing. */
  isWarm(): boolean {
    return this.warm
  }

  /** Do we have an answer for this id at all? (`false` ⇒ absent ⇒ unknown.) */
  has(deviceId: number): boolean {
    return this.state.has(deviceId)
  }

  /** The coverage answer, or `undefined` when this id is unknown. No I/O. */
  get(deviceId: number): boolean | undefined {
    return this.state.get(deviceId)
  }

  /**
   * Seed the whole fleet ONCE with a single `getAllBindings`. Idempotent: a
   * warm cache is a no-op, and concurrent callers coalesce onto one read. A
   * failed seed leaves the mirror COLD so the next tick retries — during that
   * window every id answers unknown, which never reports a camera as excluded.
   */
  async ensureWarm(): Promise<void> {
    if (this.warm) return
    if (this.seeding) return this.seeding
    this.seeding = this.seed()
    try {
      await this.seeding
    } finally {
      this.seeding = null
    }
  }

  private async seed(): Promise<void> {
    try {
      const rows = await this.api.deviceManager.getAllBindings.query({})
      for (const row of rows) {
        // A concurrent event is fresher than this snapshot — never clobber an
        // id an event already touched while the seed was in flight.
        if (this.state.has(row.deviceId)) continue
        this.state.set(row.deviceId, hasWrappedDetection(row.entries))
      }
      this.warm = true
      this.logger.info('detection-coverage mirror warm', {
        meta: { devices: this.state.size },
      })
    } catch (err) {
      this.logger.warn('detection-coverage seed failed — coverage unknown until it lands', {
        meta: { error: String(err) },
      })
    }
  }

  /**
   * A `DeviceBindingsChanged` for the detection cap re-reads THAT ONE device
   * (never the fleet). Fire-and-forget from the synchronous event handler.
   */
  onBindingsChanged(event: DetectionBindingsChangedEvent): Promise<void> {
    if (event.capName !== DETECTION_PIPELINE_CAP_NAME) return Promise.resolve()
    return this.refreshDevice(event.deviceId)
  }

  /** Drop a device the fleet no longer has (`device.unregistered`). */
  forget(deviceId: number): void {
    this.state.delete(deviceId)
  }

  /** Return to cold — used on addon shutdown. */
  clearAll(): void {
    this.state.clear()
    this.warm = false
    this.seeding = null
  }

  private async refreshDevice(deviceId: number): Promise<void> {
    try {
      const active = await this.readWrappedDetection(deviceId)
      const prev = this.state.get(deviceId)
      if (!active && prev === true) {
        // Destructive flip (covered → uncovered): an empty read is not proof
        // the wrapper is gone. Confirm with a concordant second read before
        // reporting the camera off (D49).
        const confirm = await this.readWrappedDetection(deviceId)
        if (confirm) {
          this.state.set(deviceId, true)
          return
        }
      }
      this.state.set(deviceId, active)
    } catch (err) {
      // A read that throws changes nothing — the previous value holds.
      this.logger.debug('detection-coverage refresh failed — keeping the previous value', {
        tags: { deviceId },
        meta: { error: String(err) },
      })
    }
  }

  private async readWrappedDetection(deviceId: number): Promise<boolean> {
    const res = await this.api.deviceManager.getBindings.query({ deviceId })
    return hasWrappedDetection(res.entries)
  }
}

/** The one authority: a WRAPPED `detection-pipeline` binding is present. A
 *  native binding of the same cap is NOT coverage (D62: absence of the WRAPPED
 *  binding is how a deactivated wrapper is represented). */
function hasWrappedDetection(
  entries: ReadonlyArray<{
    readonly capName: string
    readonly kind: 'native' | 'wrapped'
  }>,
): boolean {
  return entries.some((e) => e.capName === DETECTION_PIPELINE_CAP_NAME && e.kind === 'wrapped')
}
