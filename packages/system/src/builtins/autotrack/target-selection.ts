/**
 * Sticky target choice: pick ONE track, then stay on it.
 *
 * Re-picking "the best candidate" every frame is oscillation on another axis —
 * two people a metre apart trade the top score frame to frame and the head
 * saws between them, having centred neither. So the target is chosen ONCE and
 * held by `trackId` until it has been gone for the disappear delay. While it
 * is merely MISSING from a frame nothing is switched and nothing is released:
 * `present: false` is reported and the decision layer decides what a gap means.
 *
 * Pure: state in, state out, no clock read inside — `nowMs` is passed. A new
 * state object is returned every call; the input is never mutated.
 */

/** One candidate of the configured class on this frame. */
export interface TargetCandidate {
  readonly trackId: string
  /** Pixel area of the box. Used ONLY to break the first choice; it never
   *  unseats a target that is still alive. */
  readonly areaPx: number
}

export interface TargetSelectionState {
  /** The track being followed, or `null` when nothing is held. */
  readonly trackId: string | null
  /** When that track was last OBSERVED on a frame. `null` while nothing is
   *  held. Never advanced by a frame the track was absent from. */
  readonly lastSeenAtMs: number | null
}

export const INITIAL_TARGET_SELECTION_STATE: TargetSelectionState = {
  trackId: null,
  lastSeenAtMs: null,
}

/** Why the selection came out the way it did — logged on every frame so a
 *  loop that chooses nothing is distinguishable from a loop that is dead. */
export type TargetSelectionReason =
  /** The held track was observed on this frame. */
  | 'held'
  /** The held track was absent from this frame but is still within its
   *  disappear delay — nothing is switched, nothing is released. */
  | 'held-absent'
  /** The held track exceeded its disappear delay and was released; no
   *  candidate was available to take its place. */
  | 'released'
  /** The held track was released and a new one was picked on the same frame. */
  | 'switched'
  /** Nothing was held and a candidate was picked. */
  | 'acquired'
  /** Nothing was held and no candidate was available. */
  | 'idle'

export interface TargetSelectionResult {
  readonly state: TargetSelectionState
  /** The held track, after this frame. `null` when nothing is held. */
  readonly trackId: string | null
  /** Whether the held track was OBSERVED on this frame. This is the boolean
   *  the absence measurement counts. */
  readonly present: boolean
  readonly reason: TargetSelectionReason
}

export interface TargetSelectionInput {
  readonly nowMs: number
  readonly candidates: readonly TargetCandidate[]
  readonly disappearDelayMs: number
}

/** Largest box first; `trackId` breaks a tie so the choice is deterministic
 *  rather than dependent on detector ordering. */
function pickFirst(candidates: readonly TargetCandidate[]): TargetCandidate | null {
  let best: TargetCandidate | null = null
  for (const c of candidates) {
    if (best === null || c.areaPx > best.areaPx) {
      best = c
      continue
    }
    if (c.areaPx === best.areaPx && c.trackId < best.trackId) best = c
  }
  return best
}

export function selectTarget(
  state: TargetSelectionState,
  input: TargetSelectionInput,
): TargetSelectionResult {
  const held = state.trackId
  if (held !== null) {
    const observed = input.candidates.some((c) => c.trackId === held)
    if (observed) {
      return {
        state: { trackId: held, lastSeenAtMs: input.nowMs },
        trackId: held,
        present: true,
        reason: 'held',
      }
    }
    const lastSeen = state.lastSeenAtMs
    const goneForMs = lastSeen === null ? Number.POSITIVE_INFINITY : input.nowMs - lastSeen
    if (goneForMs < input.disappearDelayMs) {
      return { state, trackId: held, present: false, reason: 'held-absent' }
    }
    const replacement = pickFirst(input.candidates)
    if (replacement === null) {
      return {
        state: INITIAL_TARGET_SELECTION_STATE,
        trackId: null,
        present: false,
        reason: 'released',
      }
    }
    return {
      state: { trackId: replacement.trackId, lastSeenAtMs: input.nowMs },
      trackId: replacement.trackId,
      present: true,
      reason: 'switched',
    }
  }

  const picked = pickFirst(input.candidates)
  if (picked === null) {
    return {
      state: INITIAL_TARGET_SELECTION_STATE,
      trackId: null,
      present: false,
      reason: 'idle',
    }
  }
  return {
    state: { trackId: picked.trackId, lastSeenAtMs: input.nowMs },
    trackId: picked.trackId,
    present: true,
    reason: 'acquired',
  }
}
