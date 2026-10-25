/**
 * Discard boxes are recorded VERBATIM, degenerate and inverted ones included
 * (review L1). Decided, not defaulted: the live tracker reads these boxes
 * (`selectLowScoreContinuations`) and itself refuses a box with `w <= 0` or
 * `h <= 0`. A tape that normalised an inverted box would hand the replay a box
 * production refused; one that dropped it would hide what production was
 * given. Verbatim, plus an exact inverse, keeps the replay's input identical.
 *
 * Disarm: normalise in `tapeDiscards` (`Math.abs` on `w` and `h`) — the
 * inverted-box test and the production-parity test must fail.
 */
import type { DiscardedDetection, FrameResult } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { selectLowScoreContinuations } from '../../../pipeline/tracker/low-score-continuation.js'
import { buildFrameRecord, tapeDiscardCorners } from '../frame-record.js'
import { faces } from './frame-record-fixtures.js'

const DEGENERATE: DiscardedDetection = {
  bbox: [10, 20, 10, 60],
  macroClass: 'person',
  score: 0.5,
  reason: 'below-threshold',
}
const INVERTED: DiscardedDetection = {
  bbox: [50, 60, 30, 20],
  macroClass: 'person',
  score: 0.5,
  reason: 'below-threshold',
}
const NORMAL: DiscardedDetection = {
  bbox: [100, 100, 140, 200],
  macroClass: 'person',
  score: 0.5,
  reason: 'below-threshold',
}

const FRAME: FrameResult = {
  kind: 'frame',
  frameId: 'f',
  deviceId: 1,
  timestamp: 0,
  width: 640,
  height: 360,
  detections: [],
  discarded: [DEGENERATE, INVERTED, NORMAL],
}

const record = buildFrameRecord({
  t: 0,
  plane: 'pipeline',
  frame: FRAME,
  injectedIds: new Set(),
  observation: { gate: { strong: [], weak: [], confirmed: [], woken: [] }, live: [] },
  faces,
})

describe('discard boxes', () => {
  it('records a zero-area box with its zero width', () => {
    expect(record.disc[0]?.b).toEqual([10, 20, 0, 40])
  })

  it('records an inverted box with its negative size, not normalised', () => {
    expect(record.disc[1]?.b).toEqual([50, 60, -20, -40])
  })

  it('converts back to the exact corner tuples', () => {
    expect(record.disc.map((d) => tapeDiscardCorners(d.b))).toEqual(
      FRAME.discarded?.map((d) => d.bbox),
    )
  })

  it('gives the live tracker the same low-score boxes after a round trip', () => {
    const replayed: DiscardedDetection[] = record.disc.map((d) => ({
      bbox: tapeDiscardCorners(d.b),
      macroClass: d.cls,
      score: d.s,
      reason: d.r,
    }))
    const live = selectLowScoreContinuations(FRAME.discarded, 0.35)
    expect(live).toHaveLength(1)
    expect(selectLowScoreContinuations(replayed, 0.35)).toEqual(live)
  })
})
