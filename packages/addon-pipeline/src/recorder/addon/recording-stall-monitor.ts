/**
 * RecordingStallMonitor — "this camera should be recording and is not writing".
 *
 * The idle-writer watchdog re-pins a silent ffmpeg in ~90 s–a few minutes and
 * logs a warn. That is recovery machinery, not an operator alert. This monitor
 * owns the Notification Center edge: recording intent is ON, the camera is not
 * switched off, and no segment has finalized for {@link RECORDING_STALL_THRESHOLD_MS}.
 *
 * One transition per stall episode. Recovery fires when a segment lands after
 * a reported stall. Pure, injected clock.
 */

/** Default stall window — longer than the writer idle re-pin bound so NC does
 *  not fire on every brief recover-and-retry. Five minutes catches a gap the
 *  operator cares about without crying wolf on a first-segment attach. */
export const RECORDING_STALL_THRESHOLD_MS = 5 * 60_000

/** Min gap between degraded (restart-storm) notifications for one camera. */
export const RECORDING_DEGRADED_COOLDOWN_MS = 30 * 60_000

export interface RecordingStallConfig {
  readonly thresholdMs: number
  readonly degradedCooldownMs: number
}

export const DEFAULT_RECORDING_STALL_CONFIG: RecordingStallConfig = {
  thresholdMs: RECORDING_STALL_THRESHOLD_MS,
  degradedCooldownMs: RECORDING_DEGRADED_COOLDOWN_MS,
}

export interface RecordingStallEvent {
  readonly deviceId: number
  readonly idleMs: number
  readonly thresholdMs: number
}

export interface RecordingHealthyEvent {
  readonly deviceId: number
}

export interface RecordingDegradedEvent {
  readonly deviceId: number
  readonly message: string
}

interface DeviceState {
  /** Recording should be writing (enabled, not switched off, attached intent). */
  readonly expected: boolean
  readonly lastSegmentAt: number | null
  readonly stalledReported: boolean
  readonly lastDegradedAt: number | null
}

export class RecordingStallMonitor {
  private readonly config: RecordingStallConfig
  private readonly state = new Map<number, DeviceState>()

  constructor(config: RecordingStallConfig = DEFAULT_RECORDING_STALL_CONFIG) {
    this.config = config
  }

  /**
   * Declare whether this camera is expected to produce segments. When
   * `expected` becomes false, any open stall episode is cleared without a
   * healthy event (switched-off must not look like recovery).
   */
  setExpected(deviceId: number, expected: boolean, now: number): void {
    const prev = this.state.get(deviceId)
    if (!expected) {
      this.state.set(deviceId, {
        expected: false,
        lastSegmentAt: prev?.lastSegmentAt ?? null,
        stalledReported: false,
        lastDegradedAt: prev?.lastDegradedAt ?? null,
      })
      return
    }
    // An off→on edge (first sight, or recording asked for again after an
    // intentional idle such as an events-mode post-buffer closing) restarts the
    // clock now: the gap since the last segment was not a stall. A repeated
    // expected=true keeps the running clock, so a continuous camera still alerts.
    const edge = prev?.expected !== true
    this.state.set(deviceId, {
      expected: true,
      lastSegmentAt: edge ? now : (prev?.lastSegmentAt ?? now),
      stalledReported: edge ? false : (prev?.stalledReported ?? false),
      lastDegradedAt: prev?.lastDegradedAt ?? null,
    })
  }

  /** A segment finalized for this camera (any profile). */
  noteSegment(deviceId: number, now: number): RecordingHealthyEvent | null {
    const prev = this.state.get(deviceId)
    const wasStalled = prev?.stalledReported === true
    this.state.set(deviceId, {
      expected: prev?.expected ?? false,
      lastSegmentAt: now,
      stalledReported: false,
      lastDegradedAt: prev?.lastDegradedAt ?? null,
    })
    if (wasStalled && (prev?.expected ?? false)) {
      return { deviceId }
    }
    return null
  }

  /**
   * Devices that have JUST crossed into stalled. Call from a periodic sweep.
   */
  sweep(now: number): readonly RecordingStallEvent[] {
    const out: RecordingStallEvent[] = []
    for (const [deviceId, s] of this.state) {
      if (!s.expected || s.stalledReported) continue
      if (s.lastSegmentAt === null) continue
      const idleMs = now - s.lastSegmentAt
      if (idleMs < this.config.thresholdMs) continue
      this.state.set(deviceId, { ...s, stalledReported: true })
      out.push({ deviceId, idleMs, thresholdMs: this.config.thresholdMs })
    }
    return out
  }

  /**
   * Writer restart budget exhausted. Cooldown per camera so a storm is one
   * notification, not one per give-up.
   */
  noteDegraded(deviceId: number, message: string, now: number): RecordingDegradedEvent | null {
    const prev = this.state.get(deviceId)
    const last = prev?.lastDegradedAt ?? null
    if (last !== null && now - last < this.config.degradedCooldownMs) {
      return null
    }
    this.state.set(deviceId, {
      expected: prev?.expected ?? false,
      lastSegmentAt: prev?.lastSegmentAt ?? null,
      stalledReported: prev?.stalledReported ?? false,
      lastDegradedAt: now,
    })
    return { deviceId, message }
  }
}
