/**
 * The TERMINAL retention roots — motion events, audio events, sensor events —
 * swept on the SAME per-device window as the track (D62).
 *
 * ## What governs these, and why it is one decision
 *
 * [D61](../../../../../docs/decisions/adr-0061.md) made the track the only
 * cascading retention root: everything a track owns has no clock and leaves
 * with it. But motion, audio and sensor events are not owned by a track. They
 * carry no `trackId` and are referenced by nothing, so the track cascade can
 * never reach them — a clock is the only thing that can, and
 * without one they would grow forever (motion alone was measured at ~7,200
 * rows/day per camera). Motion visit stills are event-owned media of those
 * rows and leave in lockstep inside `evictTracklessBefore`, not as a second
 * clock.
 *
 * The clock they get is the **device's own retention window** — the identical
 * `DeviceRetentionCutoffs.cutoffMs` the track sweep uses, for the same device,
 * resolved once. Not a second setting, not the fleet minimum, not a constant.
 * So the operator reads ONE sentence:
 *
 *   > A device has one retention window. Everything scoped to that device is
 *   > deleted on it.
 *
 * The only thing outside that sentence is the ops log, which is global and
 * longer than any device window because it records what retention DID,
 * including for devices that no longer exist (`RETENTION_ROOTS`).
 *
 * ## Why "retention off" is announced
 *
 * `trackRetentionDays: 0` means keep forever, and one window means it applies
 * here too — a device with retention off ages out nothing at all. That is the
 * operator's choice, but it must not be inferred from silence: a sweep that
 * deletes nothing and logs nothing is indistinguishable from a sweep that never
 * ran, and the terminal roots are precisely the rows that grow unbounded when
 * it does not. So the caller is handed `onRetentionDisabled` and says so.
 *
 * Extracted from `index.ts` so the SELECTION is testable without booting the
 * addon: `__tests__/one-window-governs.spec.ts` drives this function and
 * asserts that changing an operator value changes which rows are deleted.
 * Logging and the ops-log rows stay with the caller, where the device tags are.
 */
import type { DeviceRetentionCutoffs } from '../retention-policy.js'

/** What one device's pass removed. */
export interface TracklessEviction {
  readonly motion: readonly string[]
  readonly audio: readonly string[]
  readonly sensor: number
}

export interface TracklessRootSweepDeps {
  /** The device set to sweep — the same set the track sweep covers. */
  readonly deviceIds: readonly number[]
  readonly nowMs: number
  /** The device's ONE window. The same call the track sweep makes. */
  readonly resolveCutoffs: (deviceId: number, nowMs: number) => Promise<DeviceRetentionCutoffs>
  /** Age-evict motion + audio for one device. */
  readonly evictTracklessEvents: (params: {
    readonly deviceId: number
    readonly cutoffMs: number
  }) => Promise<{ readonly motion: readonly string[]; readonly audio: readonly string[] }>
  /** Age-evict sensor events for one device. `null` when the store is absent. */
  readonly evictSensorEvents: ((deviceId: number, cutoffMs: number) => Promise<number>) | null

  /** Something was removed — the caller logs it and writes the ops-log row. */
  readonly onEvicted: (
    deviceId: number,
    evicted: TracklessEviction,
    cutoffs: DeviceRetentionCutoffs,
  ) => void | Promise<void>
  /** This device ages out NOTHING (window = keep forever). Never silent. */
  readonly onRetentionDisabled: (deviceId: number) => void
  readonly onError: (deviceId: number, err: unknown) => void
  /** Shutdown latch — the pass abandons cleanly mid-device-list. */
  readonly shouldStop: () => boolean
}

/**
 * Sweep the terminal roots for every device on that device's own window.
 * Per-device ISOLATED — one bad device never aborts the pass.
 */
export async function sweepTracklessRoots(deps: TracklessRootSweepDeps): Promise<void> {
  for (const deviceId of deps.deviceIds) {
    if (deps.shouldStop()) return
    try {
      const cutoffs = await deps.resolveCutoffs(deviceId, deps.nowMs)
      const cutoffMs = cutoffs.cutoffMs
      if (cutoffMs === null) {
        // An unreadable follow floor is NOT the operator's keep-forever: its
        // owner already said so, per episode (D674). Reporting it here would
        // latch "trackRetentionDays = 0" as the cause for the process's life.
        if (cutoffs.floorUnreadable !== true) deps.onRetentionDisabled(deviceId)
        continue
      }
      const events = await deps.evictTracklessEvents({ deviceId, cutoffMs })
      const sensor = deps.evictSensorEvents ? await deps.evictSensorEvents(deviceId, cutoffMs) : 0
      const evicted: TracklessEviction = {
        motion: events.motion,
        audio: events.audio,
        sensor,
      }
      if (evicted.motion.length + evicted.audio.length + evicted.sensor > 0) {
        await deps.onEvicted(deviceId, evicted, cutoffs)
      }
    } catch (err) {
      deps.onError(deviceId, err)
    }
  }
}
