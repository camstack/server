/**
 * CLEAR and HOTA ported from TrackEval (MIT), and the matching that turns
 * truth + replay into a TrackEval sequence (spec §5.4). Hand-computed values
 * are the cross-check; no reference implementation is run (D681).
 *
 *  - swap: CLEAR counts 2 IDSW, MOTA 0.75; HOTA = √(1/3) at every α;
 *  - matching: a bound output is matched to ITS detection with similarity 1,
 *    coasting outputs are excluded, outputs on ignore regions are removed,
 *    an output on a not-a-subject detection stays (a false positive);
 *  - a duplicate ground-truth box (two live tracks one identity, concurrently)
 *    is dropped into the ignore set, and the output bound to IT is excluded
 *    too — neither a false positive nor a true positive (fix round 1).
 *
 * Disarm 1: in `computeClear`, drop the `1000 ×` continuity bonus — the
 * "keeps a continuing match over a slightly better newcomer" test must fail.
 * Disarm 2: in `buildMetricSequence`, drop the duplicate box back to a plain
 * dedup (no ignore-folding) — the duplicate-identity test must fail.
 */
import { describe, expect, it } from 'vitest'
import type { Truth } from '../../ground-truth.js'
import type { ReplayResult } from '../../replay.js'
import { computeClear } from '../clear.js'
import { computeHota } from '../hota.js'
import { computeIdentity } from '../idf1.js'
import { buildMetricSequence } from '../matching.js'
import type { MetricSequence } from '../metric-sequence.js'

const ID = [
  [1, 0],
  [0, 1],
]
const SWAPPED = [
  [0, 1],
  [1, 0],
]
const swap: MetricSequence = {
  numGtIds: 2,
  numTrIds: 2,
  frames: [ID, ID, SWAPPED, SWAPPED].map((similarity) => ({
    gtIds: [0, 1],
    trIds: [0, 1],
    similarity,
  })),
}

describe('computeClear', () => {
  it('counts both switches of a swap', () => {
    expect(computeClear(swap)).toMatchObject({
      IDSW: 2,
      CLR_TP: 8,
      CLR_FN: 0,
      CLR_FP: 0,
      MOTA: 0.75,
      Frag: 0,
      MT: 2,
    })
  })

  it('keeps a continuing match over a slightly better newcomer', () => {
    const seq: MetricSequence = {
      numGtIds: 1,
      numTrIds: 2,
      frames: [
        { gtIds: [0], trIds: [0], similarity: [[0.8]] },
        { gtIds: [0], trIds: [0, 1], similarity: [[0.7, 0.8]] },
      ],
    }
    expect(computeClear(seq).IDSW).toBe(0)
  })

  it('an empty-tracker frame does not break continuity (TrackEval quirk)', () => {
    const seq: MetricSequence = {
      numGtIds: 1,
      numTrIds: 1,
      frames: [
        { gtIds: [0], trIds: [0], similarity: [[0.9]] },
        { gtIds: [0], trIds: [], similarity: [[]] },
        { gtIds: [0], trIds: [0], similarity: [[0.9]] },
      ],
    }
    expect(computeClear(seq)).toMatchObject({ Frag: 0, CLR_FN: 1, IDSW: 0 })
  })

  it('counts a fragmentation when the gap frame has an unmatched tracker box', () => {
    const seq: MetricSequence = {
      numGtIds: 1,
      numTrIds: 2,
      frames: [
        { gtIds: [0], trIds: [0], similarity: [[0.9]] },
        { gtIds: [0], trIds: [1], similarity: [[0]] },
        { gtIds: [0], trIds: [0], similarity: [[0.9]] },
      ],
    }
    expect(computeClear(seq)).toMatchObject({ Frag: 1, CLR_FN: 1, CLR_FP: 1, IDSW: 0 })
  })
})

describe('computeHota', () => {
  it('is 1 for a perfect sequence', () => {
    const perfect: MetricSequence = {
      numGtIds: 2,
      numTrIds: 2,
      frames: [ID, ID].map((similarity) => ({ gtIds: [0, 1], trIds: [0, 1], similarity })),
    }
    expect(computeHota(perfect)).toMatchObject({ HOTA: 1, DetA: 1, AssA: 1 })
  })

  it('is √(1/3) on a swap midway', () => {
    const r = computeHota(swap)
    expect(r.DetA).toBeCloseTo(1, 12)
    expect(r.AssA).toBeCloseTo(1 / 3, 12)
    expect(r.HOTA).toBeCloseTo(Math.sqrt(1 / 3), 12)
  })
})

describe('the three families on one scene', () => {
  it('agree on the swap: IDF1 ½, two switches, AssA ⅓', () => {
    expect(computeIdentity(swap).IDF1).toBe(0.5)
    expect(computeClear(swap).IDSW).toBe(2)
    expect(computeHota(swap).AssA).toBeCloseTo(1 / 3, 12)
  })
})

describe('buildMetricSequence', () => {
  const truth: Truth = {
    frames: [
      {
        t: 0,
        boxes: [{ detectionId: 'a', identity: 'X', box: [0, 0, 10, 10] }],
        ignoreDetections: ['ign'],
        ignoreBoxes: [],
        detectionBoxes: new Map([
          ['a', [0, 0, 10, 10]],
          ['ign', [50, 50, 10, 10]],
          ['fake', [80, 80, 10, 10]],
        ]),
      },
    ],
    presenceGaps: [],
    unscorableTracks: 0,
    ambiguousRelations: 0,
    suppressedAuto: [],
  }
  const replay: ReplayResult = {
    tracker: 'processor',
    plane: 'pipeline',
    hash: 'h',
    finalisations: [],
    frames: [
      {
        t: 0,
        outputs: [
          { liveId: 't1', detectionId: 'a', box: [0, 0, 10, 10], kind: 'bound', confirmed: true },
          {
            liveId: 't2',
            detectionId: 'ign',
            box: [50, 50, 10, 10],
            kind: 'bound',
            confirmed: true,
          },
          {
            liveId: 't3',
            detectionId: 'fake',
            box: [80, 80, 10, 10],
            kind: 'bound',
            confirmed: true,
          },
          { liveId: 't4', box: [0, 0, 10, 10], kind: 'coasting', confirmed: true },
        ],
      },
    ],
  }

  it('matches by detection, drops ignore and coasting, keeps a false positive', () => {
    const seq = buildMetricSequence(truth, replay, (id) => id)
    expect(seq.frames[0]).toEqual({ gtIds: [0], trIds: [0, 1], similarity: [[1, 0]] })
    expect(seq.numTrIds).toBe(2)
  })

  it('drops the output bound to a duplicate ground-truth box (neither FP nor TP)', () => {
    const dupTruth: Truth = {
      frames: [
        {
          t: 0,
          boxes: [
            { detectionId: 'a', identity: 'X', box: [0, 0, 10, 10] },
            { detectionId: 'b', identity: 'X', box: [100, 100, 10, 10] },
          ],
          ignoreDetections: [],
          ignoreBoxes: [],
          detectionBoxes: new Map([
            ['a', [0, 0, 10, 10]],
            ['b', [100, 100, 10, 10]],
          ]),
        },
      ],
      presenceGaps: [],
      unscorableTracks: 0,
      ambiguousRelations: 0,
      suppressedAuto: [],
    }
    const dupReplay: ReplayResult = {
      tracker: 'processor',
      plane: 'pipeline',
      hash: 'h',
      finalisations: [],
      frames: [
        {
          t: 0,
          outputs: [
            { liveId: 't1', detectionId: 'a', box: [0, 0, 10, 10], kind: 'bound', confirmed: true },
            {
              liveId: 't2',
              detectionId: 'b',
              box: [100, 100, 10, 10],
              kind: 'bound',
              confirmed: true,
            },
          ],
        },
      ],
    }
    const seq = buildMetricSequence(dupTruth, dupReplay, (id) => id)
    // Only the surviving box's output is scored; the duplicate's output never
    // enters `trIds` at all — not as an unmatched FP, not as a matched TP.
    expect(seq.frames[0]?.gtIds).toEqual([0])
    expect(seq.frames[0]?.trIds).toEqual([0])
    expect(seq.numTrIds).toBe(1)
    expect(computeClear(seq)).toMatchObject({ CLR_TP: 1, CLR_FP: 0, CLR_FN: 0 })
  })
})
