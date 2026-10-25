/**
 * Review C2: a camera whose frames STOP (the motion gate, D438) must still end
 * its tracklets, commit its fusions and let its rows close. The trigger is the
 * one production runs — `TrackerSweep.run`, called by `sweepExpiredTracks`
 * every 5 s — never a frame the test invents.
 *
 * Disarms (each alone, restored):
 *  - make `TrackerSweep.run` skip `advanceBySilence`: the first test fails;
 *  - make `canClose` return true: "keeps a row the tracker still holds" fails;
 *  - remove the per-processor try/catch in `TrackerSweep.run` (review H3):
 *    "one processor's throw is contained…" fails.
 */
import type { FrameResult, ObjectDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { FrameProcessor } from '../pipeline/frame-processor.js'
import { sequentialTrackIdMinter } from '../pipeline/track-id.js'
import { type SweepableProcessor, TrackerSweep } from '../pipeline/tracker-sweep.js'
import type { TrackFusion } from '../pipeline/tracker-v2/index.js'
import { type LogLine, makeRecordingLogger } from './boot-analytics.js'

const person = (x: number): ObjectDetection => ({
  id: `d${x}`,
  kind: 'first-level',
  macroClass: 'person',
  score: 0.9,
  labels: [],
  bbox: { x, y: 100, width: 100, height: 200 },
})
const frame = (t: number, dets: readonly ObjectDetection[]): FrameResult => ({
  kind: 'frame',
  frameId: `f${t}`,
  deviceId: 7,
  timestamp: t,
  width: 1920,
  height: 1080,
  detections: dets,
})

interface SweepSetup {
  readonly p: FrameProcessor
  readonly sweep: TrackerSweep
  readonly applied: TrackFusion[]
  readonly wall: { now: number }
}

function setup(): SweepSetup {
  const wall = { now: 0 }
  const p = new FrameProcessor(7, {}, {}, {}, 'pipeline', {
    mintTrackId: sequentialTrackIdMinter(),
    wallClock: () => wall.now,
  })
  const applied: TrackFusion[] = []
  const sweep = new TrackerSweep({
    processors: () => [['7:pipeline', p]],
    processorsOf: (deviceId) => (deviceId === 7 ? [p] : []),
    applyFusions: async (_d, _k, fusions) => {
      applied.push(...fusions)
    },
    logger: makeRecordingLogger([]),
  })
  return { p, sweep, applied, wall }
}

describe('TrackerSweep', () => {
  it('a silent camera ends its tracklets and commits its fusion through the 5 s sweep', async () => {
    const { p, sweep, applied, wall } = setup()
    for (let i = 0; i < 5; i++) {
      wall.now = i * 130
      p.process({ timestamp: i * 130, frame: frame(i * 130, [person(100 + i * 5)]) })
    }
    for (let t = 2420; t <= 3590; t += 130) {
      wall.now = t
      p.process({ timestamp: t, frame: frame(t, [person(230)]) })
    }
    // Silence. Only the sweep runs, every 5 s of wall clock.
    for (let w = 5000; w <= 20_000; w += 5000) {
      wall.now = w
      await sweep.run(w)
    }
    expect(p.isLive('t1')).toBe(false)
    expect(applied.map((f) => [f.survivorId, f.absorbedId])).toEqual([['t1', 't2']])
    expect(sweep.canClose({ deviceId: 7, trackId: 't1' }, 20_000)).toBe(true)
  })

  it('keeps a row the tracker still holds', async () => {
    // Round 4: no presence — a still subject is held only while it is SEEN.
    // Two seconds after its last frame it still coasts: the row must not close.
    const { p, sweep, wall } = setup()
    for (let i = 0; i < 12; i++) {
      wall.now = i * 600
      p.process({ timestamp: i * 600, frame: frame(i * 600, [person(500)]) })
    }
    wall.now = 11 * 600 + 2000
    await sweep.run(wall.now)
    expect(sweep.canClose({ deviceId: 7, trackId: 't1' }, wall.now)).toBe(false)
  })

  it("one processor's throw is contained: the others still advance, and it is logged with its camera", async () => {
    const advanced: number[] = []
    const stub = (deviceId: number, fail: boolean): SweepableProcessor => ({
      deviceId,
      advanceBySilence: () => {
        if (fail) throw new Error('boom')
        advanced.push(deviceId)
        return []
      },
      frameNow: () => null,
      isLive: () => false,
      isTailFinal: () => true,
    })
    const logs: LogLine[] = []
    const sweep = new TrackerSweep({
      processors: () => [
        ['1:pipeline', stub(1, true)],
        ['2:pipeline', stub(2, false)],
      ],
      processorsOf: () => [],
      applyFusions: async () => {},
      logger: makeRecordingLogger(logs),
    })
    await sweep.run(1000)
    expect(advanced).toEqual([2])
    const warn = logs.find((l) => l.level === 'warn')
    expect(warn?.extras).toMatchObject({ tags: { deviceId: 1 }, meta: { key: '1:pipeline' } })
  })
})
