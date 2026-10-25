/**
 * Spec §6.2 step 1: every per-track container has a declared merge rule,
 * like `TRACK_CLOSE_MODES` does for close — and adopting a piece closes
 * nothing (review H4).
 *
 * Disarms (each alone, restored):
 *  - delete one key from `RESIDENT_MERGE_RULES` — the type check fails;
 *  - make `adopt` keep the survivor's best frame always: "the best shot follows the ranking" fails;
 *  - call `hooks.onClose(absorbedId)` inside `adopt` (the pre-review code):
 *    "adopting closes nothing; closing the survivor closes both" fails;
 *  - drop the fan-out from `close`: the same test fails on its second half.
 */
import { describe, expect, it } from 'vitest'
import { TrackResidentState } from '../pipeline/track-resident-state.js'

describe('TrackResidentState.adopt', () => {
  it('first frame from the survivor, last-frame clock from the absorbed piece, flags OR-ed', () => {
    const r = new TrackResidentState()
    r.markFirstFrameLanded(1, 'A')
    r.setLastFrameAt(1, 'A', 1000)
    r.setLastFrameAt(1, 'B', 8000)
    r.markConfirmed(1, 'B')
    r.setDebugMarked(1, 'B', true)
    r.adopt('A', 'B')
    expect(r.isFirstFrameLanded('A')).toBe(true)
    expect(r.lastFrameAt('A')).toBe(8000)
    expect(r.closure('A')?.confirmed).toBe(true)
    expect(r.isDebugMarked('A')).toBe(true)
    expect(r.trackIdsForDevice(1)).toEqual(['A'])
  })

  it('the best shot follows the ranking', () => {
    const r = new TrackResidentState()
    // A: low confidence, edge-touching, off-centre, small, no square/semantic
    // tier. B: high confidence, edge-clear, centred, large, square-contained
    // and semantic — a clear win on every axis `compareBestFrame` checks.
    r.observeBestFrame(1, 'A', 0.3, 100, false, 0.1, 0.1, 0.1, 0, false, 0.05)
    r.observeBestFrame(1, 'B', 0.95, 7000, true, 0.9, 0.95, 0.9, 1, true, 0.5)
    expect(r.adopt('A', 'B').bestShotFrom).toBe('absorbed')
  })

  it('adopting closes nothing; closing the survivor closes both', () => {
    const closed: string[] = []
    const adopted: string[] = []
    const r = new TrackResidentState({
      onClose: (id) => closed.push(id),
      onAdopt: (a, b, from) => adopted.push(`${b}->${a}:${from}`),
    })
    r.setLastFrameAt(1, 'A', 1000)
    r.setLastFrameAt(1, 'B', 8000)
    r.adopt('A', 'B')
    expect(closed).toEqual([])
    expect(adopted).toEqual(['B->A:survivor'])
    r.close('A', 'end')
    expect(closed.toSorted()).toEqual(['A', 'B'])
  })
})
