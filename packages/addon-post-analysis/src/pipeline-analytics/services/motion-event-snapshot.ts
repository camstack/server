/**
 * Motion-event stills — the marker a recording-clip visit uses when the camera
 * recorded on motion with no object detection.
 *
 * **This class is the gate as well as the writer.** The decision lives here,
 * in front of the snapshot fetch, rather than at the two call sites: a gate
 * that fetches a frame, downscales it and then discards it has stopped nothing
 * — it has moved the cost from the disk to the camera and the CPU. The test
 * that matters (`motion-event-snapshot.spec.ts`) asserts `getSnapshot` is never
 * CALLED, which is an assertion a discard-after-fetch implementation fails.
 *
 * Clip thumbnails are the main event's `getEventMedia kind: 'snapshot'`
 * (timeline-clips-library spec). Object events already get stills from the
 * track capture path; motion rows historically owned none, so the data-plane
 * 404'd and the videoclip tile was empty.
 *
 * Pixel source is the `snapshot` cap — the same still the synthetic-track
 * projector uses. Motion-analysis payloads carry regions, not JPEG, and
 * onboard VMD is a boolean. `force` is never set: this is a background
 * caller, and on a battery camera `force` walks past the sleep gate.
 *
 * Best-effort: a miss / timeout / put failure never blocks the motion row.
 */
import {
  downscaleFullFrameJpeg,
  SYNTHETIC_SNAPSHOT_MAX_HEIGHT,
  SYNTHETIC_SNAPSHOT_MAX_WIDTH,
} from '../../shared/frame/downscale-full-frame.js'
import type { IScopedLogger } from '@camstack/types'
import { decideMotionStill, type MotionStillReason } from './motion-marker-policy.js'
import type { SnapshotClient } from './synthetic-track.js'

/** How long the capturer may wait for the camera's snapshot. Matches the
 *  sensor-marker bound: the cap serves a ≤10 s cached frame, measured at
 *  ~0.6 s end-to-end; 2.5 s leaves four times that and still bounds the
 *  motion-handler await. */
const MOTION_EVENT_SNAPSHOT_TIMEOUT_MS = 2_500

export interface MotionEventSnapshotMediaSink {
  put(input: {
    deviceId: number
    // D476: motion events are their own owner kind, not `'event'`.
    ownerKind: 'motion'
    ownerId: string
    kind: 'snapshot'
    timestamp: number
    data: Buffer
  }): Promise<number>
}

export interface MotionEventSnapshotDeps {
  readonly snapshot: SnapshotClient
  readonly media: MotionEventSnapshotMediaSink
  readonly logger: IScopedLogger
  readonly snapshotTimeoutMs?: number
  readonly onError?: (scope: string, err: unknown, deviceId?: number) => void
}

/** The per-camera policy one {@link MotionEventSnapshotCapturer.capture} call
 *  is judged against — resolved by the caller from the device's media
 *  settings and its detection mirror, never read from a store here. */
export interface MotionStillPolicy {
  /** `MediaSettings.debugMediaEnabled`. */
  readonly debugMediaEnabled: boolean
  /** `MediaSettings.motionMarkerQuietMs`. */
  readonly quietMs: number
  /** Last ms a spatial track was alive on this camera; `undefined` = never. */
  readonly lastDetectionAtMs: number | undefined
}

/** What one capture call did. `null` reason = the still was written. */
export interface MotionStillOutcome {
  readonly captured: boolean
  readonly reason: MotionStillReason
}

class SnapshotTimeoutError extends Error {
  constructor(ms: number) {
    super(`snapshot cap timed out after ${ms}ms`)
    this.name = 'SnapshotTimeoutError'
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SnapshotTimeoutError(ms)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

export class MotionEventSnapshotCapturer {
  private readonly deps: MotionEventSnapshotDeps
  private readonly snapshotTimeoutMs: number
  /** Last ms a marker was written, per device. */
  private readonly lastMarkerAt = new Map<number, number>()
  /** Edges dropped since that device's last marker — reported on its line. */
  private readonly suppressed = new Map<number, number>()

  constructor(deps: MotionEventSnapshotDeps) {
    this.deps = deps
    this.snapshotTimeoutMs = deps.snapshotTimeoutMs ?? MOTION_EVENT_SNAPSHOT_TIMEOUT_MS
  }

  /**
   * Judge the edge, and only if it survives, fetch a still and persist it as
   * the motion event's snapshot. Never throws — the durable record is the
   * motion row, already inserted by the caller.
   *
   * The two clocks the decision reads live HERE, per device: `lastMarkerAt`
   * (so a drought yields one marker per window, not one per provider
   * keepalive) and `suppressed` (so the drop is reported ON the next marker's
   * line rather than 92 400 times a day).
   */
  async capture(input: {
    readonly deviceId: number
    readonly eventId: string
    readonly timestamp: number
    readonly policy: MotionStillPolicy
  }): Promise<MotionStillOutcome> {
    const decision = decideMotionStill({
      debugMediaEnabled: input.policy.debugMediaEnabled,
      now: input.timestamp,
      lastDetectionAtMs: input.policy.lastDetectionAtMs,
      lastMarkerAtMs: this.lastMarkerAt.get(input.deviceId),
      quietMs: input.policy.quietMs,
    })
    if (!decision.capture) {
      this.suppressed.set(input.deviceId, (this.suppressed.get(input.deviceId) ?? 0) + 1)
      return { captured: false, reason: decision.reason }
    }
    // Stamp BEFORE the await. The motion handlers are dispatched
    // fire-and-forget, so a second edge arriving during the ≤2.5 s fetch must
    // already see this window as marked or one drought produces two stills.
    this.lastMarkerAt.set(input.deviceId, input.timestamp)
    const suppressed = this.suppressed.get(input.deviceId) ?? 0
    this.suppressed.delete(input.deviceId)
    if (decision.reason === 'quiet-marker') {
      this.deps.logger.info('motion marker still: detection drought', {
        tags: { deviceId: input.deviceId },
        meta: {
          eventId: input.eventId,
          quietMs: input.policy.quietMs,
          suppressedSinceLastMarker: suppressed,
          lastDetectionAtMs: input.policy.lastDetectionAtMs ?? null,
        },
      })
    }
    let snap: { base64: string; contentType: string } | null
    try {
      snap = await withTimeout(
        this.deps.snapshot.getSnapshot({ deviceId: input.deviceId }),
        this.snapshotTimeoutMs,
      )
    } catch (err) {
      this.deps.onError?.(
        err instanceof SnapshotTimeoutError ? 'snapshotTimeout' : 'snapshotFetch',
        err,
        input.deviceId,
      )
      return { captured: false, reason: decision.reason }
    }
    if (snap === null) return { captured: false, reason: decision.reason }

    const raw = Buffer.from(snap.base64, 'base64')
    let data: Buffer = raw
    try {
      data = await downscaleFullFrameJpeg(
        raw,
        SYNTHETIC_SNAPSHOT_MAX_WIDTH,
        SYNTHETIC_SNAPSHOT_MAX_HEIGHT,
      )
    } catch (err) {
      this.deps.onError?.('downscaleSnapshot', err, input.deviceId)
    }

    try {
      await this.deps.media.put({
        deviceId: input.deviceId,
        ownerKind: 'motion',
        ownerId: input.eventId,
        kind: 'snapshot',
        timestamp: input.timestamp,
        data,
      })
    } catch (err) {
      this.deps.onError?.('snapshotMedia', err, input.deviceId)
      return { captured: false, reason: decision.reason }
    }
    return { captured: true, reason: decision.reason }
  }

  /** Drop a device's clocks when it unbinds — same lifetime as every other
   *  per-device mirror on the addon. */
  forgetDevice(deviceId: number): void {
    this.lastMarkerAt.delete(deviceId)
    this.suppressed.delete(deviceId)
  }
}
