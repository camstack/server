/**
 * Follow-up 102, F1: about 1 % of a camera's frames reach the tracker out of
 * capture order (up to 1.2 s back).
 *
 * Fix round 1 (review H1, M1, M2): staleness is decided ONCE per FRAME, at the
 * facade. Matched against the tracklets' NEWEST boxes, a stale box can land on
 * another subject — the walker in front's old box on the walker behind — and
 * was emitted under that id with that subject's box and appearance. A frame
 * stamped before the latest frame taken is now not associated at all: nothing
 * binds, spawns, splits or is demoted on it, the confirmed tracklets are
 * emitted as on a frame that matched nothing, and ONE `outOfOrder` fact is
 * reported for the frame (`behindMs`, the dropped detection count).
 *
 * The tracklet keeps its own guard (a sighting older than its last one is not
 * recorded) for a direct caller of L1.
 *
 * Disarms (each alone): drop the facade's `t < lastFrameT` gate: the facade
 * tests go RED; drop the tracklet's guard: the tracklet test goes RED.
 */
import type { BoundingBox, SpatialDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { sequentialTrackIdMinter } from '../../track-id.js'
import { TrackerV2 } from '../tracker-v2.js'
import { Tracklet } from '../tracklet.js'
import {
  DEFAULT_TRACKER_V2_CONFIG,
  type LinkDecisionFacts,
  type OutOfOrderFrameFacts,
  type TrackerV2FrameContext,
} from '../types.js'

const CTX: TrackerV2FrameContext = { frameWidth: 3840, frameHeight: 2160 }
const box = (x: number, y = 100): BoundingBox => ({ x, y, w: 100, h: 200 })
const det = (b: BoundingBox): SpatialDetection => ({
  class: 'person',
  originalClass: 'person',
  score: 0.9,
  bbox: b,
})

interface Harness {
  readonly tracker: TrackerV2
  readonly facts: OutOfOrderFrameFacts[]
  readonly splits: number[]
  readonly refusals: string[]
}

function harness(): Harness {
  const facts: OutOfOrderFrameFacts[] = []
  const splits: number[] = []
  const refusals: string[] = []
  const links: LinkDecisionFacts[] = []
  const tracker = new TrackerV2(DEFAULT_TRACKER_V2_CONFIG, {
    mintTrackId: sequentialTrackIdMinter(),
    observers: {
      outOfOrder: (f) => facts.push(f),
      split: (f) => splits.push(f.t),
      refusal: (f) => refusals.push(f.reason),
      link: (f) => links.push(f),
    },
  })
  return { tracker, facts, splits, refusals }
}

describe('a frame older than the latest frame (F1)', () => {
  it('the tracklet never rewinds on a stale sighting (belt and braces for a direct L1 caller)', () => {
    const tr = new Tracklet({
      id: 't1',
      startedAt: 0,
      det: det(box(100)),
      lineage: { kind: 'birth' },
      cohort: null,
      faceBearing: false,
    })
    tr.observeConfident(det(box(120)), 100, false)
    tr.observeConfident(det(box(140)), 200, false)
    const before = [tr.lastBox, tr.lastSeenAt, tr.assocBox, tr.velocity, [...tr.path], tr.hits]
    expect(tr.observeConfident(det(box(110)), 50, false)).toBe('stale')
    expect([tr.lastBox, tr.lastSeenAt, tr.assocBox, tr.velocity, [...tr.path], tr.hits]).toEqual(
      before,
    )
    expect(tr.observeConfident(det(box(160)), 300, false)).toBe('recorded')
    expect([tr.lastBox.x, tr.lastSeenAt]).toEqual([160, 300])
  })

  it("a stale box never binds another subject's tracklet, and is never emitted as a sighting (review H1)", () => {
    // Two walkers in a column, B 270 px behind A, 30 px a frame. A frame 1 170 ms
    // stale carries A's box of then — exactly on B's box now.
    const { tracker, facts } = harness()
    const a = (i: number): BoundingBox => box(1000 + 30 * i)
    const b = (i: number): BoundingBox => box(730 + 30 * i)
    let emitted: ReturnType<TrackerV2['update']> = []
    for (let i = 0; i < 12; i++) emitted = tracker.update([det(a(i)), det(b(i))], i * 130, CTX)
    const ids = emitted.map((e) => e.trackId)
    const stale = tracker.update([det(a(2)), det(b(2))], 2 * 130, CTX)
    expect(stale.map((e) => [e.trackId, e.matchedThisFrame])).toEqual(ids.map((id) => [id, false]))
    expect(stale.every((e) => e.appearance === undefined)).toBe(true)
    expect(facts).toEqual([
      { t: 260, lastFrameT: 1430, behindMs: 1170, detections: 2, pendingClockStep: 0 },
    ])
    // The next in-order frame binds both walkers on their own boxes, same ids.
    const next = tracker.update([det(a(12)), det(b(12))], 12 * 130, CTX)
    expect(next.map((e) => [e.trackId, e.matchedThisFrame, e.bbox.x])).toEqual([
      [ids[0], true, a(12).x],
      [ids[1], true, b(12).x],
    ])
  })

  it('a stale frame spawns no ghost, demotes nobody and splits nothing (review M1, M2)', () => {
    const { tracker, facts, splits, refusals } = harness()
    const car = (i: number): BoundingBox => ({ x: 1000 + 60 * i, y: 300, w: 400, h: 250 })
    for (let i = 0; i < 12; i++) tracker.update([det(car(i))], i * 130, CTX)
    // 1.17 s stale: the car's box of then (540 px back) is outside every gate.
    // Before the gate it spawned a ghost piece in the past that died
    // `unconfirmed-spawn-lost`, the only trace of the frame.
    tracker.update([det(car(2))], 2 * 130, CTX)
    expect(facts.map((f) => [f.behindMs, f.detections])).toEqual([[1170, 1]])
    for (let i = 12; i < 40; i++) tracker.update([det(car(i))], i * 130, CTX)
    tracker.advance(40 * 130 + 30_000)
    expect(splits).toEqual([])
    expect(refusals).toEqual([])
  })
})
