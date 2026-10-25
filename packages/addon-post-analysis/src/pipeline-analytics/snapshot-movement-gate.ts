/**
 * Movement gate for the periodic per-track `snapshot` (timeline filmstrip +
 * rolling `lastFrame`). The pure decision that turns a PURE-TIME cadence
 * (`snapshotIntervalMs`) into a MOVEMENT-aware one: once the interval has
 * elapsed, a fresh snapshot is only worth capturing when the object actually
 * MOVED since the last captured snapshot — a long-lived or stationary track
 * would otherwise accumulate many near-identical frames (one every interval
 * regardless of motion).
 *
 * A genuinely stationary but still-present track (a loiterer) still gets an
 * OCCASIONAL frame via the `maxIdleMs` fallback so its filmstrip is never empty.
 *
 * Movement is measured as centroid displacement normalized to the frame
 * diagonal, so the threshold is a scale-invariant fraction of the frame
 * (independent of resolution) and can be tuned by a single operator setting.
 */

export interface SnapshotBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface SnapshotGateInput {
  /** Wall-clock of the last ACTUALLY-captured snapshot (0 = clock unseeded). */
  readonly lastSnapshotAt: number
  /** Bbox of the last captured snapshot (or the seed/first-frame bbox).
   *  Undefined when no reference exists yet → always capture. */
  readonly lastSnapshotBbox: SnapshotBox | undefined
  /** The track's bbox on the current frame (pixel-space). */
  readonly currentBbox: SnapshotBox
  /** Current frame timestamp. */
  readonly now: number
  readonly frameWidth: number
  readonly frameHeight: number
  /** Periodic cadence (ms) — a snapshot is only considered after this elapses. */
  readonly intervalMs: number
  /** Minimum centroid movement, as a fraction of the frame diagonal, required
   *  to capture once the interval elapsed. */
  readonly movementThreshold: number
  /** Force a capture after this much wall-clock without one, even if the track
   *  never moved (loiterer fallback). Clamped to be ≥ intervalMs. */
  readonly maxIdleMs: number
}

export type SnapshotGateReason =
  | 'interval-not-elapsed'
  | 'no-reference'
  | 'moved'
  | 'fast-mover'
  | 'idle-forced'
  | 'stationary-skip'

/** A FAST mover may capture BEFORE `intervalMs` elapses: once the centroid
 *  moved at least this fraction of the frame diagonal since the last
 *  snapshot, waiting the full interval would leave visible gaps along the
 *  path (live case: a person crossing the scene in ~12s got 2 snapshots on a
 *  5s cadence). */
export const FAST_MOVER_FRACTION = 0.08
/** Hard floor between two snapshots even for a fast mover — bounds the
 *  worst-case capture rate at ~1/1.5s. */
export const FAST_MOVER_MIN_GAP_MS = 1_500

export interface SnapshotGateDecision {
  readonly capture: boolean
  readonly reason: SnapshotGateReason
  /** The measured centroid movement as a fraction of the frame diagonal
   *  (0 when no reference / degenerate frame). Useful for debug logging. */
  readonly movedFraction: number
}

export function centroidOf(b: SnapshotBox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

/** Centroid displacement between two boxes as a fraction of the frame diagonal.
 *  Returns 0 for a degenerate (≤0) frame diagonal so the caller can fall back
 *  to pure-time behaviour instead of dividing by zero. */
export function centroidMovedFraction(
  a: SnapshotBox,
  b: SnapshotBox,
  frameWidth: number,
  frameHeight: number,
): number {
  const diag = Math.hypot(frameWidth, frameHeight)
  if (diag <= 0) return 0
  const ca = centroidOf(a)
  const cb = centroidOf(b)
  return Math.hypot(cb.x - ca.x, cb.y - ca.y) / diag
}

/**
 * Decide whether the periodic `snapshot` should be captured for a track THIS
 * frame. Pure: no side effects. The caller keeps the `debugMediaEnabled` master
 * switch and advances `lastSnapshotAt`/`lastSnapshotBbox` only when a capture
 * actually lands — so a skipped (stationary) frame leaves the clock untouched,
 * which naturally lets `maxIdleMs` fire and re-evaluates movement every frame
 * until the object moves.
 */
export function evaluatePeriodicSnapshot(input: SnapshotGateInput): SnapshotGateDecision {
  const {
    lastSnapshotAt,
    lastSnapshotBbox,
    currentBbox,
    now,
    frameWidth,
    frameHeight,
    intervalMs,
    movementThreshold,
    maxIdleMs,
  } = input

  // Clock unseeded, or the periodic interval has not elapsed yet. A FAST
  // mover is the one exception: once it has traveled ≥ FAST_MOVER_FRACTION
  // of the diagonal since the last snapshot it may capture early (bounded
  // by FAST_MOVER_MIN_GAP_MS) so a quick transit still leaves a usable
  // filmstrip instead of 2 frames.
  if (lastSnapshotAt <= 0 || now - lastSnapshotAt < intervalMs) {
    if (
      lastSnapshotAt > 0 &&
      lastSnapshotBbox !== undefined &&
      now - lastSnapshotAt >= FAST_MOVER_MIN_GAP_MS
    ) {
      const fastMoved = centroidMovedFraction(
        lastSnapshotBbox,
        currentBbox,
        frameWidth,
        frameHeight,
      )
      if (fastMoved >= FAST_MOVER_FRACTION) {
        return { capture: true, reason: 'fast-mover', movedFraction: fastMoved }
      }
    }
    return { capture: false, reason: 'interval-not-elapsed', movedFraction: 0 }
  }

  // No reference box to compare against → capture (can't judge movement).
  if (lastSnapshotBbox === undefined) {
    return { capture: true, reason: 'no-reference', movedFraction: 0 }
  }

  const movedFraction = centroidMovedFraction(
    lastSnapshotBbox,
    currentBbox,
    frameWidth,
    frameHeight,
  )

  if (movedFraction >= movementThreshold) {
    return { capture: true, reason: 'moved', movedFraction }
  }

  // Loiterer fallback: force an occasional frame even when stationary.
  const idleLimit = Math.max(maxIdleMs, intervalMs)
  if (now - lastSnapshotAt >= idleLimit) {
    return { capture: true, reason: 'idle-forced', movedFraction }
  }

  return { capture: false, reason: 'stationary-skip', movedFraction }
}
