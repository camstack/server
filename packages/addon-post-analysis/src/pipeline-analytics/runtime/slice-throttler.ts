/**
 * SliceThrottler — coalesce per-device slice writes.
 *
 * The runtime-state slice for `zone-analytics` and `audio-metrics`
 * is updated on every inference frame / audio chunk respectively.
 * That can hit 5-30 Hz per camera and saturates the
 * `DeviceStateChanged` event bus, the StateValuesStream UI, and the
 * kernel's runtime-state mirror — without giving operators any extra
 * useful information past 1 Hz.
 *
 * Two gates per device:
 *   1. Content diff ignoring `ts` — skip when the slice payload
 *      shape didn't actually change (steady-state idle camera).
 *   2. Trailing-edge throttle — write at most once per
 *      `intervalMs`, but always flush the LAST queued snapshot
 *      after the interval so the UI can't get stuck on a stale
 *      value when motion stops.
 */

interface PendingState<T> {
  snapshot: T
  scheduledTimer: ReturnType<typeof setTimeout> | null
}

export interface SliceThrottlerOptions<T> {
  readonly intervalMs: number
  /** Performs the slice write. Throws are caught upstream. */
  readonly write: (deviceId: number, snapshot: T) => Promise<void>
  /**
   * Equality check: returns true when `next` represents the same
   * meaningful state as `prev` and the write should be skipped.
   * Implementations typically clone-without-`ts` and JSON.stringify
   * compare. Falsey return value forces a write.
   */
  readonly equalsIgnoringTs: (prev: T | undefined, next: T) => boolean
}

export class SliceThrottler<T> {
  private readonly opts: SliceThrottlerOptions<T>
  private readonly lastWrittenAt = new Map<number, number>()
  private readonly lastWritten = new Map<number, T>()
  private readonly pending = new Map<number, PendingState<T>>()

  constructor(opts: SliceThrottlerOptions<T>) {
    this.opts = opts
  }

  /**
   * Record a fresh snapshot for the given device. Triggers an
   * immediate write when the throttle window has elapsed AND the
   * content changed; otherwise queues a trailing flush.
   */
  push(deviceId: number, snapshot: T): void {
    const last = this.lastWritten.get(deviceId)
    if (this.opts.equalsIgnoringTs(last, snapshot)) {
      // No meaningful change — skip and clear any pending so we don't
      // flush a stale duplicate later.
      const queued = this.pending.get(deviceId)
      if (queued?.scheduledTimer) clearTimeout(queued.scheduledTimer)
      this.pending.delete(deviceId)
      return
    }

    const now = Date.now()
    const lastTs = this.lastWrittenAt.get(deviceId) ?? 0
    const elapsed = now - lastTs
    if (elapsed >= this.opts.intervalMs) {
      void this.flushNow(deviceId, snapshot)
      return
    }

    // Inside the throttle window — queue the latest snapshot. If a
    // timer is already scheduled, replacing the snapshot is enough;
    // it will fire at the originally scheduled instant. Otherwise
    // schedule one for the remaining window.
    const queued = this.pending.get(deviceId)
    const remainingMs = this.opts.intervalMs - elapsed
    if (queued) {
      queued.snapshot = snapshot
    } else {
      const slot: PendingState<T> = { snapshot, scheduledTimer: null }
      slot.scheduledTimer = setTimeout(() => {
        slot.scheduledTimer = null
        const current = this.pending.get(deviceId)
        if (!current) return
        this.pending.delete(deviceId)
        void this.flushNow(deviceId, current.snapshot)
      }, remainingMs)
      this.pending.set(deviceId, slot)
    }
  }

  forgetDevice(deviceId: number): void {
    const queued = this.pending.get(deviceId)
    if (queued?.scheduledTimer) clearTimeout(queued.scheduledTimer)
    this.pending.delete(deviceId)
    this.lastWritten.delete(deviceId)
    this.lastWrittenAt.delete(deviceId)
  }

  /** Drop all pending timers — call from `onShutdown`. */
  destroy(): void {
    for (const queued of this.pending.values()) {
      if (queued.scheduledTimer) clearTimeout(queued.scheduledTimer)
    }
    this.pending.clear()
    this.lastWritten.clear()
    this.lastWrittenAt.clear()
  }

  private async flushNow(deviceId: number, snapshot: T): Promise<void> {
    this.lastWrittenAt.set(deviceId, Date.now())
    this.lastWritten.set(deviceId, snapshot)
    await this.opts.write(deviceId, snapshot)
  }
}

/**
 * Reusable equality helper: serialises both snapshots to JSON after
 * stripping the top-level `ts` field. Cheap for the small snapshot
 * objects (zone-analytics, audio-metrics) that ship through here.
 * Returns `false` when the previous value is undefined so the very
 * first sample always writes.
 */
export function snapshotEqualsIgnoringTs<T extends { ts?: unknown }>(
  prev: T | undefined,
  next: T,
): boolean {
  if (!prev) return false
  const { ts: _prevTs, ...prevRest } = prev as T & { ts?: unknown }
  const { ts: _nextTs, ...nextRest } = next as T & { ts?: unknown }
  return JSON.stringify(prevRest) === JSON.stringify(nextRest)
}
