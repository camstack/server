/**
 * Follow-up 102, F1 fix rounds 2–3: a frame clock that steps BACK must not
 * blind the tracker, and one stray timestamp must not end every track.
 *
 * `FrameResult.timestamp` is the runner's wall clock, and the runner may be an
 * agent: an NTP correction, or a camera moved to a runner whose clock is
 * behind, steps the clock back. An unbounded stale-frame gate dropped every
 * frame until the new clock passed the old high mark (60 s back: 461 frames,
 * a new walker never tracked).
 *
 * The rule:
 *  - a frame up to `maxMissedMs` (4 s) behind the latest is OUT OF ORDER and
 *    dropped (nothing older can belong to a live tracklet's present; the
 *    measured disorder is ≤ 1.2 s);
 *  - a frame further back is dropped too, UNLESS it is the
 *    `CLOCK_STEP_CONFIRM_FRAMES`-th (3) consecutive such frame, each in order
 *    with the one before (within `maxMissedMs`). Then it is a CLOCK STEP (D49:
 *    a read that would destroy work needs a second — here a third — to
 *    agree): what L2 decided is committed, every live tracklet ends at its own
 *    last sighting, every undecided piece is decided `new` (no fusion crosses
 *    the step), the clock is rebased, and the frame is tracked.
 * One frame 4.5 s late (a backlog spike) therefore splits nothing, and two
 * interleaved runner clocks cannot thrash the camera.
 *
 * Disarms (each alone): `CLOCK_STEP_CONFIRM_FRAMES` = 1: "one late frame",
 * "interleaved clocks" and "K frames" go RED; the unbounded gate (every
 * backward frame dropped forever): the step tests go RED; skip ending the live
 * tracklets: "60 s back" goes RED; skip deciding undecided pieces: "nothing
 * undecided crosses" goes RED; translate fusions on drain instead of on push:
 * "a fusion queued at the step keeps its own time" goes RED.
 */
import type { BoundingBox, SpatialDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { sequentialTrackIdMinter } from '../../track-id.js'
import { TrackerV2 } from '../tracker-v2.js'
import { CLOCK_STEP_CONFIRM_FRAMES } from '../constants.js'
import {
  type ClockStepFacts,
  DEFAULT_TRACKER_V2_CONFIG,
  type LinkDecisionFacts,
  type OutOfOrderFrameFacts,
  type TrackerV2Emission,
  type TrackerV2FrameContext,
  type TrackletEndedFacts,
} from '../types.js'

const CTX: TrackerV2FrameContext = { frameWidth: 3840, frameHeight: 2160 }
const MAX_MISSED = DEFAULT_TRACKER_V2_CONFIG.maxMissedMs
const box = (x: number, y = 300): BoundingBox => ({ x, y, w: 100, h: 200 })
const det = (b: BoundingBox): SpatialDetection => ({
  class: 'person',
  originalClass: 'person',
  score: 0.9,
  bbox: b,
})

interface Harness {
  readonly tracker: TrackerV2
  readonly steps: ClockStepFacts[]
  readonly stale: OutOfOrderFrameFacts[]
  readonly links: LinkDecisionFacts[]
  readonly ended: TrackletEndedFacts[]
}

function harness(): Harness {
  const steps: ClockStepFacts[] = []
  const stale: OutOfOrderFrameFacts[] = []
  const links: LinkDecisionFacts[] = []
  const ended: TrackletEndedFacts[] = []
  const tracker = new TrackerV2(DEFAULT_TRACKER_V2_CONFIG, {
    mintTrackId: sequentialTrackIdMinter(),
    observers: {
      clockStep: (f) => steps.push(f),
      outOfOrder: (f) => stale.push(f),
      link: (f) => links.push(f),
      ended: (f) => ended.push(f),
    },
  })
  return { tracker, steps, stale, links, ended }
}

/** Walks a subject from `x0`, 20 px a frame, one frame every 130 ms from `t0`. */
function walk(
  h: Harness,
  t0: number,
  x0: number,
  frames: number,
): readonly (readonly TrackerV2Emission[])[] {
  const out: (readonly TrackerV2Emission[])[] = []
  for (let i = 0; i < frames; i++)
    out.push(h.tracker.update([det(box(x0 + 20 * i))], t0 + i * 130, CTX))
  return out
}

function idsOf(frames: readonly (readonly TrackerV2Emission[])[]): ReadonlySet<string> {
  return new Set(frames.flatMap((f) => f.filter((e) => e.matchedThisFrame).map((e) => e.trackId)))
}

/** Frames after a step's first frame before a new subject can be emitted matched. */
const STEP_FRAMES = CLOCK_STEP_CONFIRM_FRAMES - 1 + DEFAULT_TRACKER_V2_CONFIG.minHits

describe('a frame clock that steps back (C1, MEDIUM-1)', () => {
  it('60 s back: a step on the K-th frame; the new subject is tracked, the old one ends, no id spans the step', () => {
    const h = harness()
    const before = walk(h, 100_000, 500, 20)
    const a = [...idsOf(before)]
    expect(a).toHaveLength(1)
    const lastBefore = 100_000 + 19 * 130
    // Walker A left; the clock steps back 60 s and walker B enters elsewhere.
    const after = walk(h, lastBefore - 60_000, 2500, 20)
    const firstMatched = after.findIndex((f) => f.some((e) => e.matchedThisFrame))
    expect(firstMatched).toBeLessThan(STEP_FRAMES)
    const b = idsOf(after)
    expect(b.size).toBe(1)
    expect(b.has(a[0] ?? '')).toBe(false)
    const stepAt = lastBefore - 60_000 + (CLOCK_STEP_CONFIRM_FRAMES - 1) * 130
    expect(h.steps).toEqual([
      { t: stepAt, lastFrameT: lastBefore, behindMs: lastBefore - stepAt, ended: [a[0]] },
    ])
    // The first K−1 frames past the bound were dropped and said so.
    expect(h.stale.map((f) => f.pendingClockStep)).toEqual(
      Array.from({ length: CLOCK_STEP_CONFIRM_FRAMES - 1 }, (_, i) => i + 1),
    )
    // A ended at the step: not live, and its tail is final once the sweep runs.
    expect(h.tracker.isLive(a[0] ?? '')).toBe(false)
    h.tracker.advance(stepAt + 20 * 130)
    expect(h.tracker.isTailFinal(a[0] ?? '', stepAt + 20 * 130)).toBe(true)
    // And nothing fused across it, ever.
    h.tracker.advance(stepAt + 120_000)
    expect(h.tracker.drainFusions()).toEqual([])
  })

  it('ONE frame 4.5 s late is dropped: no step, the walker keeps its id', () => {
    const h = harness()
    const first = walk(h, 0, 500, 40)
    const last = 39 * 130
    h.tracker.update([det(box(700))], last - 4_500, CTX)
    const rest = walk(h, last + 130, 500 + 40 * 20, 20)
    expect([h.steps.length, h.stale.map((f) => [f.behindMs, f.pendingClockStep])]).toEqual([
      0,
      [[4_500, 1]],
    ])
    expect([...idsOf(rest)]).toEqual([...idsOf(first)])
  })

  it('K consecutive frames past the bound, in order with each other, are a step', () => {
    const h = harness()
    walk(h, 0, 500, 40)
    const last = 39 * 130
    for (let k = 0; k < CLOCK_STEP_CONFIRM_FRAMES; k++)
      h.tracker.update([det(box(2000))], last - 10_000 + k * 130, CTX)
    expect(h.steps.map((f) => f.t)).toEqual([last - 10_000 + (CLOCK_STEP_CONFIRM_FRAMES - 1) * 130])
  })

  it('two interleaved runner clocks 60 s apart: no step, the majority clock is one id, the other is dropped and counted', () => {
    const h = harness()
    walk(h, 100_000, 500, 10)
    const seen: (readonly TrackerV2Emission[])[] = []
    // A camera migrating between runners while both still deliver: A, B, A, B…
    for (let i = 0; i < 24; i++) {
      const t = 100_000 + (10 + i) * 130
      if (i % 2 === 0) seen.push(h.tracker.update([det(box(700 + i * 10))], t, CTX))
      else h.tracker.update([det(box(700 + i * 10))], t - 60_000, CTX)
    }
    expect(h.steps).toEqual([])
    expect(h.stale.length).toBe(12)
    expect(idsOf(seen).size).toBe(1)
  })

  it('…and in runs of K the minority clock steps at most once per run, never at frame rate', () => {
    // Pattern B B B A repeated: every run of three B frames is a step to B, and
    // the A frame after it is a FORWARD jump (taken, in order). Bounded: one
    // step per K+1 frames, each logged — not the 12-in-24 the per-frame rule gave.
    const h = harness()
    walk(h, 100_000, 500, 10)
    for (let i = 0; i < 24; i++) {
      const t = 100_000 + (10 + i) * 130
      h.tracker.update([det(box(700 + i * 10))], i % 4 === 3 ? t : t - 60_000, CTX)
    }
    expect(h.steps.length).toBe(6)
  })

  it('1.2 s back is out of order: dropped, no step', () => {
    const h = harness()
    walk(h, 0, 500, 20)
    h.tracker.update([det(box(800))], 19 * 130 - 1_200, CTX)
    expect([h.stale.map((f) => [f.behindMs, f.pendingClockStep]), h.steps]).toEqual([
      [[1_200, 0]],
      [],
    ])
  })

  it('exactly maxMissedMs back is plain disorder; 1 ms further starts a step run', () => {
    const h = harness()
    walk(h, 0, 500, 20)
    const last = 19 * 130
    h.tracker.update([det(box(800))], last - MAX_MISSED, CTX)
    h.tracker.update([det(box(800))], last - MAX_MISSED - 1, CTX)
    expect([h.stale.map((f) => f.pendingClockStep), h.steps.length]).toEqual([[0, 1], 0])
  })

  it('a forward jump that is corrected back takes the step path on the correction', () => {
    const h = harness()
    const before = walk(h, 0, 500, 10)
    // The runner clock jumps 3 h ahead for a few frames, then NTP corrects it.
    const jumped = walk(h, 3 * 3_600_000, 700, 6)
    const corrected = walk(h, 10 * 130 + 6 * 130, 820, 10)
    expect(h.steps).toHaveLength(1)
    const firstMatched = corrected.findIndex((f) => f.some((e) => e.matchedThisFrame))
    expect(firstMatched).toBeLessThan(STEP_FRAMES)
    // Extra ids are fine; one id across the correction is not.
    const late = idsOf(corrected)
    for (const id of [...idsOf(before), ...idsOf(jumped)]) expect(late.has(id)).toBe(false)
  })

  it('nothing undecided crosses the step: a piece pending in L2 is decided new', () => {
    const h = harness()
    walk(h, 0, 500, 10)
    // A gap of 2 s, then the walker again: a second piece L2 would link after
    // LINK_MAX_GAP_MS — the step comes first.
    walk(h, 9 * 130 + 2_000, 700, 6)
    const last = 9 * 130 + 2_000 + 5 * 130
    walk(h, last - 30_000, 900, 10)
    const pending = h.links.filter((f) => f.kind === 'new' && f.reason === 'clock-step')
    expect(pending.length).toBeGreaterThan(0)
    h.tracker.advance(last - 30_000 + 120_000)
    expect(h.tracker.drainFusions()).toEqual([])
  })

  it('after a step, facts and fusions are in the NEW clock (LOW-6)', () => {
    const h = harness()
    walk(h, 100_000, 500, 20)
    const t0 = 100_000 + 19 * 130 - 60_000
    walk(h, t0, 2500, 10)
    h.tracker.update([det(box(2700))], t0 + 9 * 130 - 500, CTX)
    expect(h.stale.slice(-1)).toEqual([
      {
        t: t0 + 9 * 130 - 500,
        lastFrameT: t0 + 9 * 130,
        behindMs: 500,
        detections: 1,
        pendingClockStep: 0,
      },
    ])
    // The walker vanishes 2 s and returns 120 px on (no overlap): L2 fuses the two pieces.
    walk(h, t0 + 9 * 130 + 2_000, 2800, 10)
    h.tracker.advance(t0 + 60_000)
    const fusions = h.tracker.drainFusions()
    expect(fusions).toHaveLength(1)
    expect(fusions[0]?.t).toBeGreaterThan(t0)
    expect(fusions[0]?.t).toBeLessThanOrEqual(t0 + 60_000)
    expect(h.tracker.frameClock()).toBe(t0 + 9 * 130 + 2_000 + 9 * 130)
    // Every fact after the step speaks the caller's clock (LOW-6).
    const afterStep = h.links.filter((f) => f.t >= t0 - 1)
    expect(afterStep.length).toBeGreaterThan(0)
    for (const f of afterStep) expect(f.t).toBeLessThanOrEqual(t0 + 60_000)
    for (const f of h.ended.filter((e) => e.reason !== 'clock-step'))
      expect(f.at).toBeLessThanOrEqual(t0 + 60_000)
  })

  it('a fusion queued before a step keeps its own time when drained after it (LOW-5)', () => {
    // The pieces fuse ~10 s after the first one's last sighting, while frames
    // still flow; the processor has not drained yet when the clock steps.
    const h = harness()
    walk(h, 100_000, 500, 10)
    // 2 s later, 120 px on, no overlap: a second piece within reach.
    walk(h, 100_000 + 9 * 130 + 2_000, 800, 80)
    const last = 100_000 + 9 * 130 + 2_000 + 79 * 130
    for (let k = 0; k < CLOCK_STEP_CONFIRM_FRAMES; k++)
      h.tracker.update([det(box(2500))], last - 60_000 + k * 130, CTX)
    const fusions = h.tracker.drainFusions()
    expect(fusions).toHaveLength(1)
    expect(fusions[0]?.t).toBeGreaterThanOrEqual(100_000 + 9 * 130 + 10_000)
    expect(fusions[0]?.t).toBeLessThanOrEqual(last)
  })
})
