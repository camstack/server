/**
 * Step 1 of the training screen: the boxes the PIPELINE drew on a copied
 * frame, derived from the track store at read time — the decision the
 * operator is correcting, not a re-run of a model.
 */
import type { Track } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  PIPELINE_BOX_TOLERANCE_MS,
  pipelineBoxesForFrame,
  toRetrainClassTiers,
} from '../retrain-pipeline-boxes.js'

const AT = 1_700_000_000_000

function track(over: Partial<Track> & Pick<Track, 'trackId'>): Track {
  return {
    deviceId: 101,
    className: 'person',
    firstSeen: AT - 5_000,
    lastSeen: AT + 5_000,
    positions: [],
    snapshots: [],
    zonesVisited: [],
    frameWidth: 1000,
    frameHeight: 500,
    totalDistance: 0,
    state: 'left',
    active: false,
    ...over,
  }
}

function pos(timestamp: number, x: number, y: number, w: number, h: number, score?: number) {
  return {
    x: x + w / 2,
    y: y + h / 2,
    timestamp,
    bbox: { x, y, w, h },
    ...(score !== undefined ? { score } : {}),
  }
}

describe('pipelineBoxesForFrame', () => {
  it('uses the subject box recorded ON the source frame when there is one (exact)', () => {
    const own = track({
      trackId: 'own',
      modelId: 'yolov9m-320',
      positions: [pos(AT + 40, 0, 0, 10, 10, 0.81)],
    })
    const boxes = pipelineBoxesForFrame({
      frame: { deviceId: 101, trackId: 'own', capturedAt: AT },
      ownTrack: own,
      ownSubjectBox: { x: 100, y: 50, w: 200, h: 100, frameWidth: 1000, frameHeight: 500 },
      neighbours: [],
    })
    expect(boxes).toHaveLength(1)
    expect(boxes[0]).toMatchObject({
      trackId: 'own',
      basis: 'subject-box',
      deltaMs: 0,
      bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      macroClass: 'person',
      modelId: 'yolov9m-320',
      // The score is the nearest position's, within the tolerance.
      score: 0.81,
    })
  })

  it('falls back to the position nearest the capture time, normalised by the track frame', () => {
    const own = track({
      trackId: 'own',
      positions: [pos(AT - 2_000, 0, 0, 10, 10, 0.4), pos(AT + 120, 500, 250, 100, 50, 0.9)],
    })
    const boxes = pipelineBoxesForFrame({
      frame: { deviceId: 101, trackId: 'own', capturedAt: AT },
      ownTrack: own,
      ownSubjectBox: null,
      neighbours: [],
    })
    expect(boxes[0]).toMatchObject({
      basis: 'position',
      deltaMs: 120,
      bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
      score: 0.9,
    })
  })

  it('carries every OTHER track the pipeline had on that frame, never one outside the tolerance', () => {
    const own = track({ trackId: 'own', positions: [pos(AT, 0, 0, 100, 100, 0.7)] })
    const car = track({
      trackId: 'car',
      className: 'vehicle',
      label: 'car',
      positions: [pos(AT + 30, 200, 100, 300, 200, 0.66)],
    })
    const stale = track({
      trackId: 'stale',
      positions: [pos(AT + PIPELINE_BOX_TOLERANCE_MS + 1, 0, 0, 50, 50)],
    })
    const otherCamera = track({ trackId: 'x', deviceId: 102, positions: [pos(AT, 0, 0, 50, 50)] })
    const boxes = pipelineBoxesForFrame({
      frame: { deviceId: 101, trackId: 'own', capturedAt: AT },
      ownTrack: own,
      ownSubjectBox: null,
      neighbours: [own, car, stale, otherCamera],
    })
    expect(boxes.map((b) => b.trackId)).toEqual(['own', 'car'])
    expect(boxes[1]).toMatchObject({ macroClass: 'vehicle', label: 'car', score: 0.66 })
  })

  it('a recording still (no track) gets the boxes of every track alive at that instant', () => {
    const a = track({ trackId: 'a', positions: [pos(AT - 10, 0, 0, 100, 100)] })
    const boxes = pipelineBoxesForFrame({
      frame: { deviceId: 101, capturedAt: AT },
      ownTrack: null,
      ownSubjectBox: null,
      neighbours: [a],
    })
    expect(boxes.map((b) => b.trackId)).toEqual(['a'])
  })

  it('answers nothing it cannot place: no capture time, no frame size, degenerate boxes', () => {
    const noDims = track({
      trackId: 'n',
      frameWidth: undefined,
      frameHeight: undefined,
      positions: [pos(AT, 0, 0, 10, 10)],
    })
    const zero = track({ trackId: 'z', positions: [pos(AT, 10, 10, 0, 10)] })
    expect(
      pipelineBoxesForFrame({
        frame: { deviceId: 101 },
        ownTrack: null,
        ownSubjectBox: null,
        neighbours: [track({ trackId: 'a', positions: [pos(AT, 0, 0, 10, 10)] })],
      }),
    ).toEqual([])
    expect(
      pipelineBoxesForFrame({
        frame: { deviceId: 101, capturedAt: AT },
        ownTrack: null,
        ownSubjectBox: null,
        neighbours: [noDims, zero],
      }),
    ).toEqual([])
  })

  it('clamps a box that runs off the frame instead of drawing it outside', () => {
    const own = track({ trackId: 'own', positions: [pos(AT, 900, 400, 200, 200)] })
    const [box] = pipelineBoxesForFrame({
      frame: { deviceId: 101, trackId: 'own', capturedAt: AT },
      ownTrack: own,
      ownSubjectBox: null,
      neighbours: [],
    })
    expect(box?.bbox.x).toBeCloseTo(0.9)
    expect(box?.bbox.w).toBeCloseTo(0.1)
    expect(box?.bbox.y).toBeCloseTo(0.8)
    expect(box?.bbox.h).toBeCloseTo(0.2)
  })
})

describe('toRetrainClassTiers', () => {
  it('keeps a macro class in the macro tier and a detector class in the label tier', () => {
    expect(toRetrainClassTiers('vehicle', 'van')).toEqual({ macroClass: 'vehicle', label: 'van' })
    // A detector class maps through the COCO macro map; the class itself is the label.
    expect(toRetrainClassTiers('car', undefined)).toEqual({ macroClass: 'vehicle', label: 'car' })
    // Unmapped: the least-wrong macro, which the operator corrects.
    expect(toRetrainClassTiers('carrot', undefined)).toEqual({
      macroClass: 'person',
      label: 'carrot',
    })
  })

  it('never lets a macro class leak into the label tier', () => {
    expect(toRetrainClassTiers('person', 'person')).toEqual({ macroClass: 'person' })
    expect(toRetrainClassTiers('dog', 'Animal')).toEqual({ macroClass: 'animal', label: 'dog' })
  })
})
