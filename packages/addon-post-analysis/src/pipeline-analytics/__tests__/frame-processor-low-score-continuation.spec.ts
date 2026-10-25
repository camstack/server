/**
 * The frame processor hands the tracker the boxes the class floor refused —
 * from `FrameResult.discarded`, never from `detections` — and what comes out
 * for a held track is a coasting track (D665).
 *
 * D683: tracker v2 keeps the tier (L1 `lowScore`) and reports a hold on the
 * frame's observation (`heldByLowScore`), the fact the tape records — the old
 * tracker's per-minute counters (`drainLowScoreStats`) went with it.
 *
 * Disarm: in `FrameProcessor.process`, pass `lowScore: []` to the tracker —
 * the first test fails (the track coasts, held by nothing).
 */
import type {
  DiscardedDetection,
  FrameResult,
  ObjectDetection,
  Zone,
  ZoneRule,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { FrameProcessor } from '../pipeline/frame-processor.js'

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

function lowDrop(x: number, score = 0.5): DiscardedDetection {
  return { bbox: [x, 100, x + 60, 250], macroClass: 'person', score, reason: 'below-threshold' }
}

function frame(
  timestamp: number,
  detections: readonly ObjectDetection[],
  discarded?: readonly DiscardedDetection[],
): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: 4,
    timestamp,
    width: 1280,
    height: 720,
    detections,
    ...(discarded !== undefined ? { discarded } : {}),
  }
}

/** Three confident frames: a confirmed person track. */
function confirmed(p: FrameProcessor): string {
  let id: string | undefined
  for (let i = 0; i < 3; i++) {
    const ts = 1000 + i * 133
    id =
      p.process({ timestamp: ts, frame: frame(ts, [det(100 + i * 8)]) }).tracked[0]?.trackId ?? id
  }
  expect(id).toBeDefined()
  return id!
}

describe('FrameProcessor — low-score continuation (D665)', () => {
  it('a sub-floor box on the discard trail holds the track; the output is a coasting track', () => {
    const p = new FrameProcessor(4)
    p.setLowScoreContinuationFloor(0.35)
    const id = confirmed(p)
    const ts = 1000 + 3 * 133
    const out = p.process({ timestamp: ts, frame: frame(ts, [], [lowDrop(124)]), observe: true })
    expect(out.tracked.map((t) => t.trackId)).toEqual([id])
    expect(out.tracked[0]?.matchedThisFrame).toBe(false)
    expect(out.tracked[0]?.confidence).toBe(0.9)
    // Last CONFIDENT box, not the refused one.
    expect(out.tracked[0]?.bbox.x).toBe(116)
    expect(out.observation?.live[0]?.heldByLowScore).toBe(true)
    // …and the per-minute summary counts the hold (review L5).
    expect(p.drainTrackerStats().lowScoreHolds).toBe(1)
  })

  it('tier off (floor null): the discard trail is not read', () => {
    const p = new FrameProcessor(4)
    p.setLowScoreContinuationFloor(null)
    confirmed(p)
    const ts = 1000 + 3 * 133
    const out = p.process({ timestamp: ts, frame: frame(ts, [], [lowDrop(124)]), observe: true })
    // The track still coasts on its own budget — held by nothing.
    expect(out.observation?.live[0]?.matched).toBe(false)
    expect(out.observation?.live[0]?.heldByLowScore).toBeUndefined()
  })

  it('a sub-floor box a detection zone rule excludes is not evidence either', () => {
    const p = new FrameProcessor(4)
    p.setLowScoreContinuationFloor(0.35)
    confirmed(p)
    const everywhere: Zone = {
      id: 'z',
      name: 'z',
      kind: 'polygon',
      polygon: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      color: '#3b82f6',
    }
    const noPeople: ZoneRule = {
      id: 'r',
      zoneIds: ['z'],
      mode: 'exclude',
      classFilter: ['person'],
      overlapThreshold: 0,
      enabled: true,
    }
    p.setZones([everywhere])
    p.setDetectionRules([noPeople])
    const ts = 1000 + 3 * 133
    const out = p.process({ timestamp: ts, frame: frame(ts, [], [lowDrop(124)]), observe: true })
    expect(out.observation?.live[0]?.matched).toBe(false)
    expect(out.observation?.live[0]?.heldByLowScore).toBeUndefined()
  })
})
