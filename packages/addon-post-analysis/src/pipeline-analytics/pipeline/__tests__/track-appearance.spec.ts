/**
 * track-appearance unit tests.
 *
 * The SORT tracker resurrects a lost id back into the active set within
 * `resurrectionWindowMs`. Treating that re-entry as a brand-new track (the old
 * `!prevIds.has(id)` test alone) duplicated the track's `firstFrame` media,
 * re-emitted the `start` lifecycle event, re-seeded the snapshot clock, and
 * reset the update-gate memory. `classifyTrackAppearance` distinguishes a true
 * BIRTH (the track's very first sighting → positionsCount === 1) from a
 * RESURRECTION (a known track re-entering the active set → positionsCount > 1),
 * so only a genuine birth runs the once-per-track start work.
 */
import { describe, it, expect } from 'vitest'
import { classifyTrackAppearance } from '../track-appearance.js'

describe('classifyTrackAppearance', () => {
  it('continuing — id was active last frame', () => {
    expect(classifyTrackAppearance({ inPrevActive: true, positionsCount: 1 })).toBe('continuing')
    expect(classifyTrackAppearance({ inPrevActive: true, positionsCount: 9 })).toBe('continuing')
  })

  it('birth — not previously active AND first sighting (single position)', () => {
    expect(classifyTrackAppearance({ inPrevActive: false, positionsCount: 1 })).toBe('birth')
  })

  it('resurrection — not previously active but the track is already known (>1 position)', () => {
    expect(classifyTrackAppearance({ inPrevActive: false, positionsCount: 2 })).toBe('resurrection')
    expect(classifyTrackAppearance({ inPrevActive: false, positionsCount: 50 })).toBe(
      'resurrection',
    )
  })

  it('legit id reuse after full expiry is a birth (fresh track → single position)', () => {
    // After the TrackStore TTL fully expires a track, its active entry is
    // dropped; a later sighting of the SAME id creates a fresh track whose
    // positionsCount is 1 → correctly classified as a birth, not a resurrection.
    expect(classifyTrackAppearance({ inPrevActive: false, positionsCount: 1 })).toBe('birth')
  })
})
