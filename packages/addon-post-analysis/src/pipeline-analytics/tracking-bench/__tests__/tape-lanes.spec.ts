/**
 * The admin review view draws one lane per live track of a promoted tape, and
 * a track the store no longer holds can still be marked because the tape knows
 * its extent (spec §4.4). Both come from the tape's `live[]` bindings — never
 * from the thinned `positions` column.
 *
 * Disarm: count coasting emissions (no `det`) as bound frames — the
 * `boundFrames` expectation must fail.
 */
import { describe, expect, it } from 'vitest'
import { sampleEnd, sampleFrame, sampleHeader } from './tape-fixtures.js'
import type { Tape } from '../tape-codec.js'
import { tapeLanes, tapeTrackFacts } from '../tape-lanes.js'

const TAPE: Tape = {
  header: sampleHeader(),
  body: [
    sampleFrame(0, { live: [{ trk: 'a', det: 'd-0', m: true, st: 'moving' }] }),
    sampleFrame(100, { live: [{ trk: 'a', m: false, st: 'moving' }] }),
    sampleFrame(200, {
      dets: [
        { id: 'd-200', k: 'first-level', cls: 'person', s: 0.8, b: [1, 1, 2, 2], src: 'frame' },
        { id: 'v-200', k: 'first-level', cls: 'vehicle', s: 0.8, b: [5, 5, 9, 9], src: 'frame' },
      ],
      live: [
        { trk: 'a', det: 'd-200', m: true, st: 'moving' },
        { trk: 'b', det: 'v-200', m: true, st: 'new' },
      ],
    }),
  ],
  end: sampleEnd({ durationMs: 200, frames: 3 }),
}

describe('tapeLanes', () => {
  it('draws one lane per live track with its bound frames and class', () => {
    expect(tapeLanes(TAPE)).toEqual([
      { trackId: 'a', plane: 'pipeline', firstT: 0, lastT: 200, boundFrames: 2, cls: 'person' },
      { trackId: 'b', plane: 'pipeline', firstT: 200, lastT: 200, boundFrames: 1, cls: 'vehicle' },
    ])
  })
})

describe('tapeTrackFacts', () => {
  it('places a tape-known track in absolute time for the marks body', () => {
    expect(tapeTrackFacts(TAPE, 1_000_000, 101, 'a')).toEqual({
      trackId: 'a',
      deviceId: 101,
      firstSeen: 1_000_000,
      lastSeen: 1_000_200,
    })
    expect(tapeTrackFacts(TAPE, 1_000_000, 101, 'zzz')).toBeNull()
  })
})
