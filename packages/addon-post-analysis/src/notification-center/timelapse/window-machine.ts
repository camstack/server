/**
 * The timelapse window state machine — pure, no timers, no I/O.
 *
 * A timelapse is the one NC behaviour that fires on a SCHEDULE BOUNDARY rather
 * than on a persisted pipeline record: it opens when its weekly window starts,
 * samples frames while inside, and assembles + delivers when the window closes.
 * Keeping that decision pure is what makes it testable — the alternative (a
 * timer that inspects `Date.now()` inside the scheduler) is how midnight-crossing
 * and restart-in-the-middle bugs get shipped.
 *
 * Reuses `isScheduleActive` (the same weekly-window evaluator the rules use), so
 * a window means the same thing everywhere — including `invert` and spans that
 * cross midnight.
 */
import type { NcSchedule } from '@camstack/types'
import { isScheduleActive } from '../rule-engine.js'

/** What the scheduler must do for one (rule, device) pair at this tick. */
export type TimelapseAction =
  /** Window just opened: wipe the scratch and start sampling. */
  | { readonly kind: 'open' }
  /** Inside the window and the cadence elapsed: capture one frame. */
  | { readonly kind: 'sample' }
  /** Window just closed and the guard allows it: assemble + deliver. */
  | { readonly kind: 'close' }
  /** Window closed but the 1-hour guard is still holding: drop the scratch. */
  | { readonly kind: 'close-suppressed' }
  /** Nothing to do. */
  | { readonly kind: 'idle' }

/** Per (rule, device) state the scheduler carries between ticks. */
export interface TimelapseWindowState {
  /** Were we inside the window at the previous tick? */
  readonly open: boolean
  /** When the last frame was captured (0 = never). */
  readonly lastSampleAt: number
  /** When this pair last produced a timelapse (0 = never) — the guard. */
  readonly lastGeneratedAt: number
}

export const INITIAL_WINDOW_STATE: TimelapseWindowState = {
  open: false,
  lastSampleAt: 0,
  lastGeneratedAt: 0,
}

/**
 * Minimum gap between two generations for the same pair. Parity with the
 * reference implementation's 1-hour guard: without it, a window that flaps (an
 * operator editing the schedule, a clock correction) would re-render and
 * re-notify repeatedly.
 */
export const GENERATE_GUARD_MS = 3600_000

export interface TimelapseTickInput {
  readonly schedule: NcSchedule | undefined
  readonly cadenceSec: number
  readonly state: TimelapseWindowState
  readonly nowMs: number
}

/**
 * Decide this tick's action and the state that follows it.
 *
 * A rule with NO schedule is ALWAYS inside its window (the same convention
 * `isScheduleActive` uses for rules) — it samples continuously and only
 * generates on a manual trigger, never on a boundary that will not come.
 */
export function timelapseTick(input: TimelapseTickInput): {
  readonly action: TimelapseAction
  readonly next: TimelapseWindowState
} {
  const inside = isScheduleActive(input.schedule, input.nowMs)
  const { state } = input

  if (inside && !state.open) {
    // OPEN: the sample clock is reset so the first frame lands immediately —
    // a window that opens and captures nothing for a full cadence loses its
    // beginning, which is the part that shows the change starting.
    return {
      action: { kind: 'open' },
      next: { ...state, open: true, lastSampleAt: 0 },
    }
  }

  if (!inside && state.open) {
    const guarded = input.nowMs - state.lastGeneratedAt < GENERATE_GUARD_MS
    return {
      action: { kind: guarded ? 'close-suppressed' : 'close' },
      next: {
        open: false,
        lastSampleAt: 0,
        lastGeneratedAt: guarded ? state.lastGeneratedAt : input.nowMs,
      },
    }
  }

  if (inside) {
    const dueAt = state.lastSampleAt + Math.max(1, input.cadenceSec) * 1000
    if (state.lastSampleAt === 0 || input.nowMs >= dueAt) {
      return { action: { kind: 'sample' }, next: { ...state, lastSampleAt: input.nowMs } }
    }
  }

  return { action: { kind: 'idle' }, next: state }
}
