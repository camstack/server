/**
 * When a digest window is OVER, and when it is safe to render.
 *
 * Two different questions, deliberately kept apart, because they fail
 * differently:
 *
 *  1. **Is the window closed?** For a `schedule` rule this is the schedule's own
 *     answer (`findLastClosedWindow`). For a `motion` rule it is the operator's
 *     rule: opened by motion on any of the cameras, extended by further motion,
 *     closed by a quiet period — and hard-closed at a ceiling so a permanently
 *     busy driveway still delivers.
 *  2. **May it be RENDERED yet?** Only once the window's own tracks have closed.
 *
 * ## Why (2) exists at all — the track-close barrier
 *
 * A track's best shot is not written while the track lives. `keyFrameSmall` /
 * `thumbnail` are single-instance kinds written when the tracker CLOSES the
 * track, and the same close is what stamps `importance`. Render the instant the
 * window ends and the tiles that come out are the tracks that had already
 * finished — which is the opposite selection to the one the digest is for: the
 * subject still walking at 07:00 is the interesting one, and it would arrive
 * with no picture and no score.
 *
 * So the producer waits for every track the window opened to close. The wait is
 * BOUNDED, and the bound matters as much as the wait: a track that never closes
 * (a stationary car resident in the tracker, a crash between open and close)
 * would otherwise hold a window open forever, and a digest nobody receives is
 * indistinguishable from a feature nobody enabled. At the bound the window
 * renders with what it has and the log line NAMES the tracks it gave up on.
 *
 * Everything here is pure: the clock is always an argument.
 */

import type { ClosedWindow } from '../timelapse/window-bounds.js'

/** The motion window's two bounds, in ms. */
export interface MotionWindowBounds {
  /** Nothing on any of the rule's cameras for this long ⇒ the window closes. */
  readonly quietMs: number
  /** The window may never be longer than this, however busy the cameras are. */
  readonly maxWindowMs: number
}

/** A motion window that is currently open, as the collector holds it. */
export interface OpenMotionWindow {
  readonly openedAtMs: number
  /** The last instant motion was seen on ANY of the rule's cameras. */
  readonly lastMotionMs: number
}

/**
 * The instant an open motion window closes — computable BEFORE it happens,
 * which is what makes the barrier deadline derivable rather than stateful.
 *
 * `min(quiet, ceiling)`: whichever bound arrives first wins, and the ceiling is
 * the one that guarantees termination.
 */
export function motionWindowCloseAt(
  open: OpenMotionWindow,
  bounds: MotionWindowBounds,
): { readonly closeAtMs: number; readonly cappedByCeiling: boolean } {
  const quietCloseAt = open.lastMotionMs + bounds.quietMs
  const hardCloseAt = open.openedAtMs + bounds.maxWindowMs
  return hardCloseAt <= quietCloseAt
    ? { closeAtMs: hardCloseAt, cappedByCeiling: true }
    : { closeAtMs: quietCloseAt, cappedByCeiling: false }
}

/** What the producer should do with a window right now. */
export type SummaryWindowVerdict =
  /** Still gathering — the window has not closed. */
  | { readonly kind: 'collecting' }
  /**
   * Closed, but tracks it opened are still running. `openTracks` is how many,
   * and `deadlineMs` when the wait gives up.
   */
  | {
      readonly kind: 'barrier'
      readonly openTracks: number
      readonly deadlineMs: number
    }
  /**
   * Render it. `window` is the range to collect over; `barrierBroken` is the
   * number of tracks that were STILL OPEN when the bound expired — non-zero
   * means the digest may be missing their best shot, and it belongs on the log
   * line rather than in a comment.
   */
  | {
      readonly kind: 'ready'
      readonly window: ClosedWindow
      readonly barrierBroken: number
      readonly cappedByCeiling: boolean
    }

export interface SummaryWindowDecision {
  readonly openedAtMs: number
  readonly closeAtMs: number
  /** How many of the window's tracks have not closed yet. */
  readonly openTracks: number
  /** How long the render may wait for them. 0 disables the barrier. */
  readonly barrierMs: number
  readonly nowMs: number
  /** Only true for a motion window that hit its ceiling; reported, never acted on. */
  readonly cappedByCeiling?: boolean
}

/**
 * The one decision, shared by both window kinds.
 *
 * A `schedule` rule passes the schedule's close as `closeAtMs`; a `motion` rule
 * passes {@link motionWindowCloseAt}. From there the barrier logic is
 * identical, which is the point: the operator asked for the barrier on the
 * digest, not on one flavour of it.
 */
export function decideSummaryWindow(input: SummaryWindowDecision): SummaryWindowVerdict {
  if (input.nowMs < input.closeAtMs) return { kind: 'collecting' }
  const deadlineMs = input.closeAtMs + input.barrierMs
  if (input.openTracks > 0 && input.nowMs < deadlineMs) {
    return { kind: 'barrier', openTracks: input.openTracks, deadlineMs }
  }
  return {
    kind: 'ready',
    window: { startMs: input.openedAtMs, endMs: input.closeAtMs },
    barrierBroken: input.openTracks,
    cappedByCeiling: input.cappedByCeiling === true,
  }
}
