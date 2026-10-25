/**
 * FrameProcessor on tracker v2 (spec §2, §6.2).
 *
 * Disarms (each alone, restored; each named test must turn RED):
 *  - in `applyFusions`, skip `stateAnalyzer.rename`: "a fused continuation …"
 *    fails on the continuation's state (a fresh `entered` under the survivor
 *    id). The emitter's own rename hides the absorbed id's `leaving` (it has
 *    no last-known track to attach it to), so this disarm alone cannot show it;
 *  - skip BOTH `stateAnalyzer.rename` and `eventEmitter.rename`: the same test
 *    fails on `t2:left`;
 *  - make `frameNow` return `wallNow` (the hub clock): "the silence clock is the frame clock";
 *  - in the `ended` observer, store every end on the `unconfirmed` side
 *    (review M2): "the summary counts …" fails.
 */
import type { FrameResult, ObjectDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { FrameProcessor } from '../pipeline/frame-processor.js'
import { sequentialTrackIdMinter } from '../pipeline/track-id.js'

function person(x: number): ObjectDetection {
  return {
    id: `d${x}`,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x, y: 100, width: 100, height: 200 },
  }
}

function frame(t: number, dets: readonly ObjectDetection[]): FrameResult {
  return {
    kind: 'frame',
    frameId: `f${t}`,
    deviceId: 1,
    timestamp: t,
    width: 1920,
    height: 1080,
    detections: dets,
  }
}

interface WallClock {
  now: number
}

function proc(wall: WallClock = { now: 0 }): FrameProcessor {
  return new FrameProcessor(1, {}, {}, {}, 'pipeline', {
    mintTrackId: sequentialTrackIdMinter(),
    wallClock: () => wall.now,
  })
}

describe('FrameProcessor on TrackerV2', () => {
  it('a fused continuation carries the survivor id and emits no leaving for the absorbed id', () => {
    const p = proc()
    let t = 0
    for (let i = 0; i < 5; i++, t += 130)
      p.process({ timestamp: t, frame: frame(t, [person(100 + i * 5)]) })
    const events: string[] = []
    const eventsAfterFusion: string[] = []
    const statesAfterFusion: string[] = []
    const fusions: string[] = []
    let lastIds: readonly string[] = []
    // 1.9 s later, 110 px away (no overlap): a new piece while t1 still coasts.
    for (t = 2420; t < 12_000; t += 130) {
      const r = p.process({ timestamp: t, frame: frame(t, [person(230)]) })
      for (const e of r.objectEvents) events.push(`${e.trackId}:${e.state}`)
      for (const f of r.fusions) fusions.push(`${f.absorbedId}->${f.survivorId}`)
      if (fusions.length > 0) {
        for (const e of r.objectEvents) eventsAfterFusion.push(`${e.trackId}:${e.state}`)
        for (const x of r.tracked) statesAfterFusion.push(`${x.trackId}:${x.state}`)
      }
      lastIds = r.tracked.map((x) => x.trackId)
    }
    expect(fusions).toEqual(['t2->t1'])
    expect(lastIds).toEqual(['t1'])
    // The draft names the analyzer's `leaving` as the track state `left`.
    expect(events.filter((e) => e === 't2:left')).toEqual([])
    // The continuation keeps ITS movement state under the survivor id: it is
    // not a subject that just entered (no second `entered`, no `new`/`entered`
    // state on the frames that follow the fusion).
    expect(eventsAfterFusion.filter((e) => e.startsWith('t1:entered'))).toEqual([])
    expect(statesAfterFusion.length).toBeGreaterThan(0)
    expect(statesAfterFusion.every((x) => x === 't1:moving' || x === 't1:idle')).toBe(true)
  })

  it('the silence clock is the frame clock (review M2)', () => {
    // Frames are stamped 1 000 000 ms by the runner; the hub receives them at wall 5 000 000.
    const wall = { now: 5_000_000 }
    const p = proc(wall)
    for (let i = 0; i < 5; i++) {
      wall.now = 5_000_000 + i * 130
      p.process({
        timestamp: 1_000_000 + i * 130,
        frame: frame(1_000_000 + i * 130, [person(100)]),
      })
    }
    wall.now = 5_000_520 + 2000
    expect(p.frameNow(wall.now)).toBe(1_000_520 + 2000)
    p.advanceBySilence(wall.now)
    // 2 s of silence is inside the 4 s coast budget: the track is still live.
    expect(p.isLive('t1')).toBe(true)
    wall.now = 5_000_520 + 4001
    p.advanceBySilence(wall.now)
    expect(p.isLive('t1')).toBe(false)
  })

  it('the summary counts ends by their birth gate, and the L2 decisions (review M1, M2)', () => {
    const p = proc()
    let t = 0
    for (let i = 0; i < 5; i++, t += 130)
      p.process({ timestamp: t, frame: frame(t, [person(100 + i * 5)]) })
    // A two-frame flicker far away: never confirmed.
    for (const ft of [700, 830]) p.process({ timestamp: ft, frame: frame(ft, [person(1500)]) })
    for (t = 2420; t < 12_000; t += 130) p.process({ timestamp: t, frame: frame(t, [person(230)]) })
    const stats = p.drainTrackerStats()
    expect(stats.linksCommitted).toBe(1)
    expect(stats.tracklets.confirmed.missed).toBe(1)
    expect(stats.tracklets.unconfirmed.missed).toBeGreaterThanOrEqual(1)
    expect(stats.linksNew).toBeGreaterThanOrEqual(1)
    // Drained: the next window starts at zero.
    expect(p.drainTrackerStats().linksCommitted).toBe(0)
  })
})
