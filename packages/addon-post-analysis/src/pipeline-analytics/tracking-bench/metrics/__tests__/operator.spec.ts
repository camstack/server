/**
 * Operator metrics (spec §5.4): what the operator notices — the same subject
 * under several ids, swaps, merges, a seated person broken into pieces, and
 * the second notification for one arrival. A swap and a merge are mutually
 * exclusive (plan decision 8): the alternating fixture below asserts
 * `swapsPer100 === 0` and the pure hand-over fixture asserts
 * `mergesPer100 === 0`, so neither can double-count the other's event.
 *
 * Disarm: in `stationaryBreaks`, count only BOUND hits — "a still subject
 * split around a coasting gap is two breaks" must fail (it reports 1).
 */
import { describe, expect, it } from 'vitest'
import type { Truth, TruthFrame } from '../../ground-truth.js'
import type { ReplayFrame, ReplayResult } from '../../replay.js'
import type { TapeBox } from '../../tape-schema.js'
import type { TapeFinalisation, TapeTrackOutput } from '../../trackers/tape-tracker.js'
import { computeOperatorMetrics } from '../operator.js'

interface Subject {
  readonly identity: string
  readonly box: TapeBox
}

/** Truth frame at `t` with one box per subject; detection ids `<identity>@<t>`. */
function truthFrame(t: number, subjects: readonly Subject[]): TruthFrame {
  const boxes = subjects.map((s) => ({
    detectionId: `${s.identity}@${String(t)}`,
    identity: s.identity,
    box: s.box,
  }))
  return {
    t,
    boxes,
    ignoreDetections: [],
    ignoreBoxes: [],
    detectionBoxes: new Map(boxes.map((b) => [b.detectionId, b.box])),
  }
}

function bound(
  liveId: string,
  identity: string,
  t: number,
  box: TapeBox,
  confirmed = true,
): TapeTrackOutput {
  return { liveId, detectionId: `${identity}@${String(t)}`, box, kind: 'bound', confirmed }
}

function replayOf(
  frames: readonly ReplayFrame[],
  finalisations: readonly TapeFinalisation[] = [],
): ReplayResult {
  return { tracker: 'test', plane: 'pipeline', frames, finalisations, hash: 'h' }
}

function truthOf(frames: readonly TruthFrame[], over: Partial<Truth> = {}): Truth {
  return {
    frames,
    presenceGaps: [],
    unscorableTracks: 0,
    ambiguousRelations: 0,
    suppressedAuto: [],
    ...over,
  }
}

const BOX_X: TapeBox = [0, 0, 50, 100]
const BOX_Y: TapeBox = [300, 0, 50, 100]
const ts = (from: number, to: number, step = 1_000): number[] =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step)

describe('computeOperatorMetrics', () => {
  it('counts a re-split presence and the tracks it costs per hour', () => {
    const times = ts(0, 4_000)
    const truth = truthOf(times.map((t) => truthFrame(t, [{ identity: 'X', box: BOX_X }])))
    const replay = replayOf(
      times.map((t) => ({ t, outputs: [bound(t < 2_000 ? 'a' : 'b', 'X', t, BOX_X)] })),
    )
    const m = computeOperatorMetrics(truth, replay)
    expect(m.idsPerPresence).toBe(2)
    expect(m.resplitShare).toBe(1)
    expect(m.tracksPerIdentityHour).toBeCloseTo(2 / (4_000 / 3_600_000), 9)
    expect(m.swapsPer100).toBe(0)
  })

  it('splits presences at a 15 s absence unless a continuous mark joins them', () => {
    const times = [...ts(0, 2_000), ...ts(30_000, 32_000)]
    const frames = times.map((t) => truthFrame(t, [{ identity: 'X', box: BOX_X }]))
    const replay = replayOf(
      times.map((t) => ({ t, outputs: [bound(t < 10_000 ? 'a' : 'b', 'X', t, BOX_X)] })),
    )
    expect(computeOperatorMetrics(truthOf(frames), replay).resplitShare).toBe(0)
    const joined = truthOf(frames, { presenceGaps: [{ identity: 'X', fromT: 2_000, toT: 30_000 }] })
    expect(computeOperatorMetrics(joined, replay).resplitShare).toBe(1)
  })

  it('tells a swap from a merge', () => {
    const times = ts(0, 3_000)
    const both = (t: number) =>
      truthFrame(t, [
        { identity: 'X', box: BOX_X },
        { identity: 'Y', box: BOX_Y },
      ])
    const swap = replayOf(
      times.map((t) => ({
        t,
        outputs:
          t < 2_000
            ? [bound('a', 'X', t, BOX_X), bound('b', 'Y', t, BOX_Y)]
            : [bound('a', 'Y', t, BOX_Y), bound('b', 'X', t, BOX_X)],
      })),
    )
    const s = computeOperatorMetrics(truthOf(times.map(both)), swap)
    expect(s.swapsPer100).toBe(100)
    expect(s.mergesPer100).toBe(0)

    const alternating = replayOf(
      times.map((t, i) => ({
        t,
        outputs: [i % 2 === 0 ? bound('a', 'X', t, BOX_X) : bound('a', 'Y', t, BOX_Y)],
      })),
    )
    const a = computeOperatorMetrics(truthOf(times.map(both)), alternating)
    expect(a.mergesPer100).toBe(100)
    expect(a.swapsPer100).toBe(0)
  })

  it('a still subject split around a coasting gap is two breaks', () => {
    const times = ts(0, 12_000)
    const truth = truthOf(times.map((t) => truthFrame(t, [{ identity: 'S', box: BOX_X }])))
    const coasting: TapeTrackOutput = { liveId: 'c', box: BOX_X, kind: 'coasting', confirmed: true }
    const replay = replayOf(
      times.map((t) => ({
        t,
        outputs:
          t <= 5_000
            ? [bound('a', 'S', t, BOX_X)]
            : t === 6_000
              ? [coasting]
              : [bound('b', 'S', t, BOX_X)],
      })),
    )
    const m = computeOperatorMetrics(truth, replay)
    expect(m.stationaryBreaks).toBe(2)
    expect(m.idsPerPresence).toBe(2)
  })

  it('counts a second confirmed id within 60 s as a duplicate notification, unless fused first', () => {
    const times = ts(0, 20_000)
    const truth = truthOf(times.map((t) => truthFrame(t, [{ identity: 'X', box: BOX_X }])))
    const frames = times.map((t) => ({
      t,
      outputs: [bound(t < 10_000 ? 'a' : 'b', 'X', t, BOX_X)],
    }))
    expect(computeOperatorMetrics(truth, replayOf(frames)).duplicateNotifications).toBe(1)
    const fused = replayOf(frames, [{ provisionalId: 'b', finalId: 'a', t: 10_000 }])
    const m = computeOperatorMetrics(truth, fused)
    expect(m.duplicateNotifications).toBe(0)
    expect(m.idsPerPresence).toBe(1)
  })

  it('reports latency 0 for an online tracker and the finalisation delay otherwise', () => {
    const times = ts(0, 20_000)
    const truth = truthOf(times.map((t) => truthFrame(t, [{ identity: 'X', box: BOX_X }])))
    const frames = times.map((t) => ({ t, outputs: [bound('a', 'X', t, BOX_X)] }))
    expect(computeOperatorMetrics(truth, replayOf(frames)).finalIdLatencyP95).toBe(0)
    const late = computeOperatorMetrics(
      truth,
      replayOf(frames, [{ provisionalId: 'a', finalId: 'A', t: 12_000 }]),
    )
    expect(late.finalIdLatencyP50).toBe(12_000)
    expect(late.finalIdLatencyP95).toBe(12_000)
  })

  it('passes the unscorable count through', () => {
    const truth = truthOf([truthFrame(0, [{ identity: 'X', box: BOX_X }])], { unscorableTracks: 3 })
    expect(computeOperatorMetrics(truth, replayOf([{ t: 0, outputs: [] }])).unscorableTracks).toBe(
      3,
    )
  })
})
