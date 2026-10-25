/**
 * The robot camera's `recording-signal` — the pure facts.
 *
 * The camera device already recomputes its slices on every vacuum push
 * (`DreameCameraDevice.recomputeSlice`) from the SAME lifecycle state the
 * vacuum device publishes. The signal is a projection of that state: the robot
 * is "in function" while it cleans or drives back to the dock, and not while
 * it sits on the dock, waits for a task, is paused, dries its mop or has
 * failed. The recorder follows this LEVEL (`RecordingTriggers.deviceSignal`),
 * so this mapping IS where a cleaning's clip begins and ends.
 *
 * `returning` is active on purpose: the robot is still moving through the
 * house with its camera, and the footage of the drive back belongs to the
 * same job. `paused` is not: a pause can last an hour with the robot parked
 * mid-room, and an operator who resumes gets a second clip rather than an
 * hour of a skirting board.
 */
import type { RecordingSignalRuntimeState, VacuumState } from '@camstack/types'

/** Vacuum lifecycle states during which the camera asks to be recorded. */
const ACTIVE_STATES: ReadonlySet<VacuumState> = new Set<VacuumState>(['cleaning', 'returning'])

/** The level, from the shared vacuum state. */
export function recordingSignalActive(state: VacuumState): boolean {
  return ACTIVE_STATES.has(state)
}

/**
 * The slice as first written at activation — the cap's RUNTIME shape
 * (status + `lastFetchedAt`), not just the status: a status-only cold start
 * throws in `setCapState` and registers nothing (the navigation lesson).
 */
export const RECORDING_SIGNAL_COLD_START: RecordingSignalRuntimeState = {
  active: false,
  reason: 'unknown',
  lastChangedAt: 0,
  lastFetchedAt: 0,
}

/**
 * The next slice for a vacuum state read at `now`. `lastChangedAt` moves only
 * on a LEVEL transition — the kernel emits `DeviceStateChanged` on any field
 * change and the recorder anchors its keep span to this clock, so a reason
 * moving from `cleaning` to `returning` must not look like a new rise.
 */
export function recordingSignalSlice(
  prev: RecordingSignalRuntimeState,
  state: VacuumState,
  now: number,
): RecordingSignalRuntimeState {
  const active = recordingSignalActive(state)
  return {
    active,
    reason: state,
    lastChangedAt: active === prev.active ? prev.lastChangedAt : now,
    lastFetchedAt: now,
  }
}
