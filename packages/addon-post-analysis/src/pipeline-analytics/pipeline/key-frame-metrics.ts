/**
 * `KeyFrameCaptureLog` — the per-device hit/miss window for the native
 * `keyFrame` path.
 *
 * ## Why it did not exist, and what that cost
 *
 * The addon has exactly one native-fetch metric, `bumpCropMetric` in
 * `runtime/native-frame-transport.ts`. It is bumped from `getNativeCropJpeg`
 * and `captureCrop` only — the by-handle key-frame fetch of the time never
 * touched it (that fetch is gone since D422: the key frame is a parked parcel).
 * It is also process-global, with no `deviceId`, so
 * even if it did it could not answer the question anyone ever asks ("why is 102
 * worse than 101?").
 *
 * The consequence: on 2026-08-06 the only way to establish that 21.7% of tracks
 * had no key frame was to correlate raw Loki lines against the media store by
 * hand. A fix shipped without this would be unverifiable — the next session
 * would guess again.
 *
 * ## Shape
 *
 * One aggregated INFO line per device per window, `MediaCaptureLogAggregator`
 * idiom: pure, timer-free, flushed opportunistically from the same per-frame
 * handler that bumps it. The counters are chosen so a single line answers:
 *
 *  - is the retry landing key frames that would otherwise be lost
 *    (`retryLanded` > 0 — this is the number that says fix 2 worked);
 *  - how much it is costing (`retryAttempts` against `attempts`);
 *  - and WHY the misses miss — a parcel that was never parked or was let go
 *    (`parcelMissing` — the park's own refusal line, per camera, says which),
 *    a routing problem (`error`) and a node that is simply gone
 *    (`skippedNodeOffline`) each want a different person.
 *
 * Since D422 the write reads a PARKED parcel by track, so the two by-handle
 * causes this window used to separate (a native miss and a RAM-tier reply)
 * no longer exist on this path; they collapsed into `parcelMissing`.
 */

/** How one key-frame capture attempt ended (mirrors `KeyFrameCaptureOutcome`). */
export type KeyFrameAttemptOutcome = 'landed' | 'parcel-missing' | 'error'

/** Why a capture was never dispatched at all. */
export type KeyFrameSkipReason = 'node-offline'

/** One observation folded into the window. */
export type KeyFrameCaptureSample =
  | {
      readonly kind: 'attempt'
      /** Fired from the bounded retry path rather than a new-best peak. */
      readonly retry: boolean
      readonly outcome: KeyFrameAttemptOutcome
    }
  | { readonly kind: 'skipped'; readonly reason: KeyFrameSkipReason }

/** A drained window for one device. */
export interface KeyFrameCaptureWindow {
  /** Actual elapsed window (first note → flush), ms. */
  readonly windowMs: number
  readonly attempts: number
  readonly landed: number
  readonly retryAttempts: number
  /** Key frames that exist ONLY because of the retry path. */
  readonly retryLanded: number
  readonly parcelMissing: number
  readonly error: number
  readonly skippedNodeOffline: number
}

interface DeviceWindow {
  sinceMs: number
  attempts: number
  landed: number
  retryAttempts: number
  retryLanded: number
  parcelMissing: number
  error: number
  skippedNodeOffline: number
}

const DEFAULT_FLUSH_INTERVAL_MS = 60_000

export class KeyFrameCaptureLog {
  private readonly byDevice = new Map<number, DeviceWindow>()

  constructor(private readonly flushIntervalMs: number = DEFAULT_FLUSH_INTERVAL_MS) {}

  /**
   * Fold one sample in. Returns the drained window (and opens a fresh one) once
   * `flushIntervalMs` has elapsed since this device's window opened; `null`
   * while still accumulating.
   */
  note(
    deviceId: number,
    sample: KeyFrameCaptureSample,
    nowMs: number,
  ): KeyFrameCaptureWindow | null {
    const w = this.window(deviceId, nowMs)
    if (sample.kind === 'skipped') {
      w.skippedNodeOffline += 1
    } else {
      w.attempts += 1
      if (sample.retry) w.retryAttempts += 1
      switch (sample.outcome) {
        case 'landed':
          w.landed += 1
          if (sample.retry) w.retryLanded += 1
          break
        case 'parcel-missing':
          w.parcelMissing += 1
          break
        case 'error':
          w.error += 1
          break
      }
    }
    if (nowMs - w.sinceMs < this.flushIntervalMs) return null
    return this.drain(deviceId, w, nowMs)
  }

  /** Drain a device's pending window (e.g. its last track ended). */
  flush(deviceId: number, nowMs: number): KeyFrameCaptureWindow | null {
    const w = this.byDevice.get(deviceId)
    if (w === undefined) return null
    return this.drain(deviceId, w, nowMs)
  }

  /** Drop everything (addon dispose). */
  clear(): void {
    this.byDevice.clear()
  }

  private window(deviceId: number, nowMs: number): DeviceWindow {
    const existing = this.byDevice.get(deviceId)
    if (existing !== undefined) return existing
    const created: DeviceWindow = {
      sinceMs: nowMs,
      attempts: 0,
      landed: 0,
      retryAttempts: 0,
      retryLanded: 0,
      parcelMissing: 0,
      error: 0,
      skippedNodeOffline: 0,
    }
    this.byDevice.set(deviceId, created)
    return created
  }

  private drain(deviceId: number, w: DeviceWindow, nowMs: number): KeyFrameCaptureWindow {
    this.byDevice.delete(deviceId)
    return {
      windowMs: nowMs - w.sinceMs,
      attempts: w.attempts,
      landed: w.landed,
      retryAttempts: w.retryAttempts,
      retryLanded: w.retryLanded,
      parcelMissing: w.parcelMissing,
      error: w.error,
      skippedNodeOffline: w.skippedNodeOffline,
    }
  }
}
