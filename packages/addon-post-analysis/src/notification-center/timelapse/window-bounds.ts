/**
 * Window BOUNDARIES for the post-hoc timelapse scheduler.
 *
 * `window-machine.ts` answers "am I inside?", which is the question a LIVE
 * sampler asks. The post-hoc producer asks a different one — "which window
 * just closed, and when did it open?" — because it renders footage that
 * already exists, from a range it has to name.
 *
 * Derived by SCANNING `isScheduleActive`, deliberately, rather than by
 * re-deriving boundaries from `windows[]`. `isScheduleActive` is the authority
 * on what a window means (midnight crossing, `invert`, IANA timezone), and a
 * second implementation of that vocabulary is exactly the drift this repo has
 * already paid for once. The scan runs at MINUTE resolution because that is
 * the resolution the schedule is authored in, and it is bounded by an explicit
 * lookback — never an open-ended walk back through time.
 *
 * Pure: `nowMs` is always supplied by the caller.
 */
import type { NcSchedule } from '@camstack/types'
import { isScheduleActive } from '../rule-engine.js'

/** The scan grid. The schedule's own resolution — a finer step would find the
 *  same boundaries at a higher cost. */
const WINDOW_SCAN_STEP_MS = 60_000

/** A window that has already closed, in absolute epoch ms. */
export interface ClosedWindow {
  readonly startMs: number
  readonly endMs: number
}

export interface FindClosedWindowInput {
  readonly schedule: NcSchedule
  readonly nowMs: number
  /** How far back the scan may look. A close older than this is not reported. */
  readonly lookbackMs: number
  /** Grid resolution. Defaults to {@link WINDOW_SCAN_STEP_MS}. */
  readonly stepMs?: number
}

/**
 * The most recent window that had already CLOSED at `nowMs`.
 *
 * Standing INSIDE a window returns the PREVIOUS one — a scheduler that
 * answered "the one I am in" would render half a night and burn the guard on
 * it.
 *
 * @returns `null` when no close falls inside `lookbackMs`, when the schedule
 *   never closes (always active), OR when the close was found but its OPEN
 *   predates the lookback floor. The last case is null and not a clamped
 *   window on purpose: reporting the scan floor as the start ships a video
 *   that silently begins hours late.
 */
export function findLastClosedWindow(input: FindClosedWindowInput): ClosedWindow | null {
  const step = Math.max(1000, input.stepMs ?? WINDOW_SCAN_STEP_MS)
  // Snap to the grid so a boundary lands ON a scanned point rather than
  // between two of them.
  const from = Math.floor(input.nowMs / step) * step
  const floor = input.nowMs - input.lookbackMs

  const active = (t: number): boolean => isScheduleActive(input.schedule, t)

  // Walk back to the first active→inactive transition: the close.
  let endMs: number | null = null
  for (let t = from; t - step >= floor; t -= step) {
    if (!active(t) && active(t - step)) {
      endMs = t
      break
    }
  }
  if (endMs === null) return null

  // Keep walking while the window is open; the first inactive point before it
  // is the minute BEFORE the open.
  for (let t = endMs - step; t - step >= floor; t -= step) {
    if (!active(t - step)) return { startMs: t, endMs }
  }
  return null
}

export interface FindNextWindowInput {
  readonly schedule: NcSchedule
  readonly nowMs: number
  /** How far ahead the scan may look. Absent openings beyond it are not
   *  reported — a schedule with one yearly window is not worth a year of scan. */
  readonly lookaheadMs: number
  readonly stepMs?: number
}

/**
 * The next window that will OPEN after `nowMs`, and when it closes.
 *
 * The forward twin of {@link findLastClosedWindow}, and the answer to the only
 * question an operator has about a timelapse rule that produced nothing yet:
 * "when is it going to run?". Standing INSIDE a window reports the NEXT one,
 * not the current one — the current one's boundaries are already answerable
 * from the last close, and reporting "next: now" would read as a render that is
 * owed.
 *
 * Derived by scanning `isScheduleActive` for the same reason the backwards scan
 * is: that function is the authority on what a window means (midnight crossing,
 * `invert`, IANA timezone), and a second implementation of it is drift this
 * repo has already paid for.
 *
 * @returns `null` for an always-active schedule (it never opens — it never
 *   closed either), and for one with no opening inside the lookahead. A window
 *   whose CLOSE falls beyond the horizon is reported with `endMs: null`: the
 *   opening is the fact the operator asked for, and clamping the close to the
 *   scan floor would report a window that ends when the scan gave up.
 */
export function findNextWindowOpen(
  input: FindNextWindowInput,
): { readonly startMs: number; readonly endMs: number | null } | null {
  const step = Math.max(1000, input.stepMs ?? WINDOW_SCAN_STEP_MS)
  const from = Math.floor(input.nowMs / step) * step
  const ceiling = input.nowMs + input.lookaheadMs
  const active = (t: number): boolean => isScheduleActive(input.schedule, t)

  let startMs: number | null = null
  for (let t = from; t + step <= ceiling; t += step) {
    if (!active(t) && active(t + step)) {
      startMs = t + step
      break
    }
  }
  if (startMs === null) return null
  for (let t = startMs; t + step <= ceiling; t += step) {
    if (!active(t + step)) return { startMs, endMs: t + step }
  }
  return { startMs, endMs: null }
}
