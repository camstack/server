/**
 * Follow-up 102, F1 fix round 3 (re-review MEDIUM-2, LOW-8): a frame the
 * tracker drops as out of order is decided BEFORE anything else reads it, and
 * `process()` returns at once. Before, the rest of the frame still ran on its
 * stale timestamp: the stationary gate staged a persisted `lastConfirmedAt`
 * up to 4 s in the past, and zones, tripwires, detection events, refusal
 * reports and the result's own timestamp (the TrackStore upsert, media, the
 * closer) all read it.
 *
 * A dropped frame now reaches nothing: no stationary gate, no state analyzer,
 * no tracked detections, no events. The result says so
 * (`droppedOutOfOrder`), and still carries the tape observation, so a replay
 * sees the frame and drops it the same way.
 *
 * Disarm: remove the `classifyFrame` short-circuit at the top of `process()`:
 * every test here goes RED.
 */
import type { FrameResult, ObjectDetection } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FrameProcessor,
  type StationaryFrameGate,
  type StationaryGateInput,
} from '../pipeline/frame-processor.js'
import { StateAnalyzer } from '../pipeline/tracker/state-analyzer.js'

function det(x: number): ObjectDetection {
  return {
    id: `d-${x}`,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x, y: 100, width: 60, height: 150 },
  }
}

function frame(timestamp: number, detections: readonly ObjectDetection[]): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: 4,
    timestamp,
    width: 1280,
    height: 720,
    detections,
  }
}

/** A gate that holds nothing and remembers every timestamp it was asked about. */
function recordingGate(seen: number[]): StationaryFrameGate {
  return {
    filter: (input: StationaryGateInput) => {
      seen.push(input.timestamp)
      return {
        suppressedIndices: new Set<number>(),
        continuableIndices: new Set<number>(),
        confirmed: [],
        woken: [],
      }
    },
  }
}

/** Eight in-order frames of one walker; the last at 1 000 + 7 × 133. */
function walk(p: FrameProcessor): void {
  for (let i = 0; i < 8; i++) {
    const ts = 1000 + i * 133
    p.process({ timestamp: ts, frame: frame(ts, [det(100 + i * 8)]) })
  }
}

describe('FrameProcessor — an out-of-order frame is dropped before anything reads it', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never reaches the stationary gate, the state analyzer or the event path', () => {
    const seen: number[] = []
    const p = new FrameProcessor(4)
    p.setStationaryGate(recordingGate(seen))
    walk(p)
    const analyze = vi.spyOn(StateAnalyzer.prototype, 'analyze')
    const gateCalls = seen.length
    const stale = 1000 + 7 * 133 - 1_200
    const out = p.process({ timestamp: stale, frame: frame(stale, [det(120)]) })
    expect(seen.length).toBe(gateCalls)
    expect(analyze).not.toHaveBeenCalled()
    expect(out).toMatchObject({
      droppedOutOfOrder: true,
      tracked: [],
      objectEvents: [],
      appearanceEvents: [],
      rawTrackedDetections: [],
      stationaryConfirmed: [],
      stationaryWoken: [],
    })
    expect(p.drainTrackerStats().outOfOrderFrames).toBe(1)
  })

  it('leaves the processor clock where it was', () => {
    const p = new FrameProcessor(4)
    walk(p)
    const before = p.frameNow(0)
    const stale = 1000 + 7 * 133 - 1_200
    p.process({ timestamp: stale, frame: frame(stale, [det(120)]) })
    expect(p.frameNow(0)).toBe(before)
  })

  it('still carries the tape observation, so a replay drops the same frame', () => {
    const p = new FrameProcessor(4)
    walk(p)
    const stale = 1000 + 7 * 133 - 1_200
    const out = p.process({ timestamp: stale, frame: frame(stale, [det(120)]), observe: true })
    expect(out.observation).toEqual({
      gate: { strong: [], weak: [], confirmed: [], woken: [] },
      live: [],
    })
  })
})
