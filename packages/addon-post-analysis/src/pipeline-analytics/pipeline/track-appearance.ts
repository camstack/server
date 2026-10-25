/**
 * track-appearance — classify why a track id appears in the active set on a
 * given frame, so the once-per-track "start" work runs EXACTLY once per real
 * track even across a reappearance.
 *
 * Tracker v2 never resurrects an id across a gap (L2 links pieces instead, and
 * a destructive merge is reported on `fusions`) — but a ROOT id can still drop
 * out of the active set for a frame and come back: a fusion's survivor id is
 * the root id, reused across however many pieces link into it, so the same
 * store-level trackId can go quiet (its live piece coasted out, or ended) and
 * then reappear once a later piece is fused into that same survivor. The naive
 * "started" test (`id not in the previous frame's active set`) fires on every
 * such re-entry, which would duplicate the track's `firstFrame` media,
 * re-emit the `start` lifecycle event, re-seed the periodic-snapshot clock,
 * and reset the update-gate memory.
 *
 * The robust discriminator is the track's own history: the TrackStore upserts
 * the sighting BEFORE start-detection runs, so a track on its very first
 * sighting has exactly one recorded position, while a reappearing (already
 * known) track has more. A truly reused id — one the TrackStore fully expired
 * and dropped — starts fresh at a single position again, so it correctly reads
 * as a birth.
 */

export type TrackAppearance = 'continuing' | 'birth' | 'resurrection'

export interface TrackAppearanceInput {
  /** Was this id in the PREVIOUS frame's active set? */
  readonly inPrevActive: boolean
  /** The track's recorded position count AFTER this frame's upsert. A genuine
   *  first sighting has exactly 1; anything more means the track was already
   *  known (a resurrection / reappearance). */
  readonly positionsCount: number
}

/**
 * Pure: no side effects. `continuing` = still active from last frame;
 * `birth` = a brand-new track's first sighting; `resurrection` = a known track
 * re-entering the active set after being lost.
 */
export function classifyTrackAppearance(input: TrackAppearanceInput): TrackAppearance {
  if (input.inPrevActive) return 'continuing'
  return input.positionsCount > 1 ? 'resurrection' : 'birth'
}
