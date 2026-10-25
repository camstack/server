/**
 * MediaCaptureLogAggregator — per-device windowed aggregation for the
 * "media capture" diagnostic of the detail-media pipeline.
 *
 * The per-capture line fires on every frame where a media producer has work;
 * with always-active detection sessions (two-plane) the §5 snapshot cadence
 * alone guarantees a line every few seconds per live track, forever — a flood
 * at INFO (~700/hour measured). The diagnostic value of the line, though, is a
 * RATIO over time (`faceCrops` staying 0 while person events flow points at
 * the event→detection join), so a windowed per-counter SUM preserves it at a
 * fraction of the volume: the per-capture line drops to debug and the caller
 * logs the aggregate this class returns (~1 line/min/device).
 *
 * Pure + timer-free: the caller passes `nowMs` and flushes opportunistically
 * from the same per-frame handler (no new interval), plus a final `flush`
 * when a device's last track ends so short bursts aren't silently absorbed.
 */

export interface MediaCaptureCounts {
  readonly events: number
  readonly trackFrames: number
  readonly snapshots: number
  readonly faceCrops: number
  readonly plateCrops: number
}

export interface MediaCaptureAggregate {
  /** Frames that produced at least one media target in the window. */
  readonly frames: number
  /** Actual elapsed window (first note → flush), ms. */
  readonly windowMs: number
  /** Per-counter sums over the window. */
  readonly sums: MediaCaptureCounts
}

interface DeviceWindow {
  sinceMs: number
  frames: number
  events: number
  trackFrames: number
  snapshots: number
  faceCrops: number
  plateCrops: number
}

const DEFAULT_FLUSH_INTERVAL_MS = 60_000

export class MediaCaptureLogAggregator {
  private readonly byDevice = new Map<number, DeviceWindow>()

  constructor(private readonly flushIntervalMs: number = DEFAULT_FLUSH_INTERVAL_MS) {}

  /**
   * Record one frame's capture counts. Returns the window aggregate (and
   * resets the window) once `flushIntervalMs` has elapsed since the window
   * opened; `null` while still accumulating.
   */
  note(deviceId: number, counts: MediaCaptureCounts, nowMs: number): MediaCaptureAggregate | null {
    const w = this.byDevice.get(deviceId)
    if (w === undefined) {
      this.byDevice.set(deviceId, {
        sinceMs: nowMs,
        frames: 1,
        events: counts.events,
        trackFrames: counts.trackFrames,
        snapshots: counts.snapshots,
        faceCrops: counts.faceCrops,
        plateCrops: counts.plateCrops,
      })
      return null
    }

    w.frames += 1
    w.events += counts.events
    w.trackFrames += counts.trackFrames
    w.snapshots += counts.snapshots
    w.faceCrops += counts.faceCrops
    w.plateCrops += counts.plateCrops

    if (nowMs - w.sinceMs < this.flushIntervalMs) return null
    return this.drain(deviceId, w, nowMs)
  }

  /**
   * Drain a device's pending window (e.g. when its last live track ends),
   * so short activity bursts still surface an aggregate. Returns `null`
   * when nothing is pending.
   */
  flush(deviceId: number, nowMs: number): MediaCaptureAggregate | null {
    const w = this.byDevice.get(deviceId)
    if (w === undefined) return null
    return this.drain(deviceId, w, nowMs)
  }

  private drain(deviceId: number, w: DeviceWindow, nowMs: number): MediaCaptureAggregate {
    this.byDevice.delete(deviceId)
    return {
      frames: w.frames,
      windowMs: nowMs - w.sinceMs,
      sums: {
        events: w.events,
        trackFrames: w.trackFrames,
        snapshots: w.snapshots,
        faceCrops: w.faceCrops,
        plateCrops: w.plateCrops,
      },
    }
  }
}
