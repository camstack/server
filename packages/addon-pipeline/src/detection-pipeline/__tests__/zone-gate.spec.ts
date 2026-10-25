/**
 * `applyZoneRuleGate` — the pure half of the source-level zone gate.
 * Runs AFTER the executor built the FrameResult (and its trace), which
 * makes zone-gate drops invisible to the pipeline counts — the gate
 * must therefore record them UNCONDITIONALLY on the discard trail as
 * reason `zone-gate` (the former `emitDiscarded` flag is gone),
 * converting the survivors' `{x,y,width,height}` pixel boxes to the
 * discard trail's `[x1,y1,x2,y2]` tuple.
 */

import type { FrameResult, ObjectDetection, Zone, ZoneRule } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { applyZoneRuleGate } from '../zone-gate.js'

const FRAME_W = 100
const FRAME_H = 100

/** Left half of the frame (normalised polygon). */
const leftHalfZone: Zone = {
  id: 'z-left',
  name: 'Left half',
  kind: 'polygon',
  polygon: [
    { x: 0, y: 0 },
    { x: 0.5, y: 0 },
    { x: 0.5, y: 1 },
    { x: 0, y: 1 },
  ],
  color: '#3b82f6',
}

const excludeLeft: ZoneRule = {
  id: 'r-1',
  zoneIds: ['z-left'],
  mode: 'exclude',
  enabled: true,
}

function firstLevel(
  id: string,
  macroClass: string,
  score: number,
  bbox: { x: number; y: number; width: number; height: number },
): ObjectDetection {
  return { id, kind: 'first-level', macroClass, score, bbox, labels: [] }
}

function detail(id: string, parentId: string): ObjectDetection {
  return {
    id,
    kind: 'detail',
    macroClass: 'face',
    score: 0.9,
    bbox: { x: 1, y: 1, width: 2, height: 2 },
    labels: [],
    parentId,
  }
}

function makeFrame(
  detections: readonly ObjectDetection[],
  discarded?: FrameResult['discarded'],
): FrameResult {
  return {
    kind: 'frame',
    frameId: 'f-1',
    deviceId: 101,
    timestamp: 0,
    width: FRAME_W,
    height: FRAME_H,
    detections,
    ...(discarded !== undefined ? { discarded } : {}),
  }
}

// Person centered at (20,50) → normalised (0.2, 0.5): inside the left zone.
const personInZone = firstLevel('d-person', 'person', 0.8, {
  x: 10,
  y: 40,
  width: 20,
  height: 20,
})
// Vehicle centered at (80,50) → (0.8, 0.5): outside the zone.
const vehicleOutside = firstLevel('d-vehicle', 'vehicle', 0.7, {
  x: 70,
  y: 40,
  width: 20,
  height: 20,
})

describe('applyZoneRuleGate — zone-gate discard recording', () => {
  it('an excluded first-level ALWAYS becomes a zone-gate discard (tuple bbox) — no flag', () => {
    // The former `emitDiscarded` parameter is gone: recording is
    // unconditional, so a zone-gated box can never again be the one
    // invisible discard (the 2026-07-31 "rule unable to fire for 15h").
    const gated = applyZoneRuleGate(
      makeFrame([personInZone, vehicleOutside]),
      [leftHalfZone],
      [excludeLeft],
    )
    expect(gated.detections.map((d) => d.id)).toEqual(['d-vehicle'])
    expect(gated.discarded).toEqual([
      {
        bbox: [10, 40, 30, 60],
        macroClass: 'person',
        score: 0.8,
        reason: 'zone-gate',
      },
    ])
  })

  it('appends to an existing executor discard trail instead of replacing it', () => {
    const executorDiscard = {
      bbox: [1, 2, 3, 4],
      macroClass: 'animal',
      score: 0.4,
      reason: 'below-threshold',
    } as const
    const gated = applyZoneRuleGate(
      makeFrame([personInZone], [executorDiscard]),
      [leftHalfZone],
      [excludeLeft],
    )
    expect(gated.detections).toHaveLength(0)
    expect(gated.discarded).toHaveLength(2)
    expect(gated.discarded?.[0]).toEqual(executorDiscard)
    expect(gated.discarded?.[1]?.reason).toBe('zone-gate')
  })

  it('a detail dies with its parent but is NOT double-counted as a discard', () => {
    const gated = applyZoneRuleGate(
      makeFrame([personInZone, detail('d-face', 'd-person')]),
      [leftHalfZone],
      [excludeLeft],
    )
    expect(gated.detections).toHaveLength(0)
    expect(gated.discarded).toHaveLength(1)
    expect(gated.discarded?.[0]?.macroClass).toBe('person')
  })

  it('nothing excluded → result returned unchanged (same reference)', () => {
    const frame = makeFrame([vehicleOutside])
    const gated = applyZoneRuleGate(frame, [leftHalfZone], [excludeLeft])
    expect(gated).toBe(frame)
  })
})
