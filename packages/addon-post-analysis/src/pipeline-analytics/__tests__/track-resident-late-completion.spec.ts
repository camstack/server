/**
 * An async completion (capture batch, key-frame exec) that settles AFTER its
 * track closed must never re-create a resident: nothing would ever close it
 * (~60-125 KB per track on the live hub, ~300 MB/day).
 *
 * Disarm: drop the `closedIds.has` refusal in `TrackResidentState.ensure` —
 * the invariant and the batch-settle specs below both fail.
 */
import { describe, expect, it } from 'vitest'
import { TrackResidentState, type LateAbsorbedWork } from '../pipeline/track-resident-state.js'
import { TRACK_CLOSE_MODES } from './fixtures/track-close-modes.js'

type LateMutator = (r: TrackResidentState, deviceId: number, trackId: string) => void

/** Every mutator an async completion can reach (the creating ones). */
const LATE_MUTATORS: Readonly<Record<string, LateMutator>> = {
  retainRasterFallback: (r, d, t) =>
    r.retainRasterFallback(d, t, { jpeg: Buffer.alloc(64), timestamp: 1 }),
  markThumbnailLanded: (r, d, t) => r.markThumbnailLanded(d, t),
  markFirstFrameLanded: (r, d, t) => r.markFirstFrameLanded(d, t),
  setLastFrameAt: (r, d, t) => r.setLastFrameAt(d, t, 5),
  noteKeyFrameAttempt: (r, d, t) => r.noteKeyFrameAttempt(d, t, 5, false),
  setKeyFrameMediaId: (r, d, t) => r.setKeyFrameMediaId(d, t, 9),
  markKeyFrameLanded: (r, d, t) => r.markKeyFrameLanded(d, t),
}

describe('late completions never create a resident', () => {
  for (const mode of TRACK_CLOSE_MODES) {
    for (const [name, mutate] of Object.entries(LATE_MUTATORS)) {
      it(`${name} after close(${mode}) leaves size() == 0`, () => {
        const r = new TrackResidentState()
        r.open(1, 't1')
        r.close('t1', mode)
        mutate(r, 1, 't1')
        expect(r.size()).toBe(0)
        expect(r.isLive('t1')).toBe(false)
      })
    }
  }

  it('a new birth after close is live again', () => {
    const r = new TrackResidentState()
    r.open(1, 't1')
    r.close('t1', 'end')
    r.open(1, 't1')
    r.markThumbnailLanded(1, 't1')
    expect(r.size()).toBe(1)
  })

  it('5000 closed tracks with late capture-batch completions hold no resident and no raster', () => {
    const refused: LateAbsorbedWork[] = []
    const r = new TrackResidentState({ onLateAbsorbedWork: (w) => refused.push(w) })
    for (let i = 0; i < 5000; i++) {
      const id = `t${i}`
      r.open(1, id)
      r.close(id, 'end')
      // The batch `.then`, settling after the close.
      expect(r.isLive(id)).toBe(false)
      r.retainRasterFallback(1, id, { jpeg: Buffer.alloc(64), timestamp: 1 })
      r.markThumbnailLanded(1, id)
      r.markFirstFrameLanded(1, id)
      r.setLastFrameAt(1, id, 5)
    }
    expect(r.size()).toBe(0)
    expect(r.closure('t4999')).toBeUndefined()
    // Sampled, not per call, and it names the write kind.
    expect(refused.length).toBe(1)
    expect(refused[0]).toMatchObject({ reason: 'track-closed', deviceId: 1 })
    expect(refused[0]?.write).toBe('retainRasterFallback')
  })
})
