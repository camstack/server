import type { IScopedLogger, MotionSources } from '@camstack/types'
import { MOTION_CLOSE_AFTER_MS } from '@camstack/types'

/**
 * The `device-activity` motion source: a device that says it is DOING ITS JOB
 * drives the detection pipeline.
 *
 * The fact already exists — `recording-signal`, the LEVEL a provider raises
 * while the device is working and the recorder records against (D380). This
 * republishes that same level as a motion source, so the robot vacuum whose
 * camera only exists while it cleans gets analysed while it cleans, and
 * nothing else has to be invented for it.
 *
 * **A level is not an edge, and that is the whole design.** A cleaning run is
 * forty minutes of "still happening"; the session dispatcher tears a session
 * down after `motionCooldownMs` of quiet. So the level is MIRRORED here —
 * refreshed off the event path, never read back from the device (D224) — and a
 * sustain tick re-emits it while it is up. The mirror keeps tracking even while
 * emission is suppressed, so an operator who ticks the source on mid-run gets
 * the next tick rather than waiting for the robot to dock and start again.
 *
 * What it attaches: **nothing**. No regions, no class. The only fact is that
 * the device is active, and a robot that is itself the moving object has no
 * region worth sending (D392).
 */
export interface DeviceActivitySourceDeps {
  readonly logger: IScopedLogger
  /** Emit `MotionOnMotionChanged` with `source: 'device-activity'`. */
  readonly emitMotion: (deviceId: number, detected: boolean, timestamp: number) => void
  /**
   * The camera's currently resolved motion sources, or `null` when the device
   * has no active detection config. An in-memory read (`activeDetections`) —
   * never I/O, so it cannot fail in the direction that destroys work (D49).
   */
  readonly motionSourcesFor: (deviceId: number) => MotionSources | null
  /**
   * How long a sustain tick may wait. The caller derives it from the camera's
   * own `motionCooldownMs` so a tick always lands before the dispatcher's
   * teardown clock does.
   */
  readonly sustainMsFor: (deviceId: number) => number
}

/**
 * How often a sustained LEVEL is re-emitted: half the camera's cooldown, the
 * widest interval that cannot lose the session to a rounding edge (D392),
 * CAPPED at half of `MOTION_CLOSE_AFTER_MS` so a tick also lands before the
 * post-analysis episode tracker closes the `(camera, source)` row on its quiet
 * timer (D475) — a level held high is ONE episode, not a row every 15 s
 * (D672). 7.5 s at the default cooldown. Shared by every level source, so no
 * two sources ever disagree about it.
 */
export function sustainIntervalMs(cooldownMs: number | undefined): number {
  return Math.min(
    Math.max(1_000, Math.floor((cooldownMs ?? DEFAULT_MOTION_COOLDOWN_MS) / 2)),
    Math.floor(MOTION_CLOSE_AFTER_MS / 2),
  )
}

/** A camera's `motionCooldownMs` when its config does not say (the dispatcher's own fallback). */
export const DEFAULT_MOTION_COOLDOWN_MS = 30_000

/** The source's own name on the wire. One constant, used by every emit + gate. */
export const DEVICE_ACTIVITY_SOURCE = 'device-activity'

/** What we hold per device: the mirrored level and its sustain timer. */
interface ActivityEntry {
  active: boolean
  timer: NodeJS.Timeout | null
}

export class DeviceActivitySource {
  readonly #deps: DeviceActivitySourceDeps
  readonly #devices: Map<number, ActivityEntry> = new Map()

  constructor(deps: DeviceActivitySourceDeps) {
    this.#deps = deps
  }

  /**
   * A `recording-signal` level landed for a device. Idempotent in the level:
   * only a CHANGE emits an edge, and the sustain tick — not a repeated push —
   * is what keeps the session open.
   */
  onSignalLevel(deviceId: number, active: boolean, reason: string, atMs: number): void {
    const entry = this.#devices.get(deviceId) ?? { active: false, timer: null }
    const wasActive = entry.active
    entry.active = active
    this.#devices.set(deviceId, entry)
    if (active === wasActive) return

    if (active) {
      this.#deps.logger.info('device-activity: the device reports it is working', {
        tags: { deviceId },
        meta: { reason },
      })
      this.#emit(deviceId, true, atMs)
      this.#arm(deviceId, entry)
      return
    }

    this.#clear(entry)
    this.#deps.logger.info('device-activity: the device reports it has stopped', {
      tags: { deviceId },
      meta: { reason },
    })
    // A real falling edge — the thing `onboard` motion never sends. The
    // dispatcher tears the session down on it instead of waiting out a
    // cooldown after a run that may have lasted an hour.
    this.#emit(deviceId, false, atMs)
  }

  /** Drop every timer (addon teardown). The mirror goes with the instance. */
  stop(): void {
    for (const entry of this.#devices.values()) this.#clear(entry)
    this.#devices.clear()
  }

  #arm(deviceId: number, entry: ActivityEntry): void {
    this.#clear(entry)
    const sustainMs = this.#deps.sustainMsFor(deviceId)
    const timer = setInterval(() => {
      const current = this.#devices.get(deviceId)
      if (!current || !current.active) {
        this.#clear(current ?? entry)
        return
      }
      this.#emit(deviceId, true, Date.now())
    }, sustainMs)
    timer.unref?.()
    entry.timer = timer
  }

  #clear(entry: ActivityEntry): void {
    if (entry.timer === null) return
    clearInterval(entry.timer)
    entry.timer = null
  }

  /**
   * Emit, unless this camera does not carry the source. A suppressed emit is
   * SAID — an operator who never ticked the box and an addon that is quietly
   * broken look identical from the outside otherwise.
   */
  #emit(deviceId: number, detected: boolean, timestamp: number): void {
    const sources = this.#deps.motionSourcesFor(deviceId)
    if (sources === null || !sources.includes(DEVICE_ACTIVITY_SOURCE)) {
      this.#deps.logger.debug(
        'device-activity: level not forwarded — the camera does not list `device-activity`',
        { tags: { deviceId }, meta: { detected, sources: sources ?? 'no-active-detection' } },
      )
      return
    }
    this.#deps.emitMotion(deviceId, detected, timestamp)
  }
}
