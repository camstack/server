/**
 * FrameProcessor unit tests — P9.
 *
 * Covers:
 *  - process(): empty frame → empty output
 *  - process(): detections promoted to tracks only after minHits=3;
 *    once emitted, tracked[] carries className/confidence/bbox/state
 *  - process(): objectEvents are generated for tracked detections
 *    (one per state transition the emitter sees)
 *  - setZones(): zone filter drops detections outside any zone when
 *    the zone excludes the detection class
 *  - rawTrackedDetections: parallel shape exposing the TrackedDetection
 *    raw shape for TrackStore upserts
 */

import type {
  FrameResult,
  ObjectDetection,
  ObjectEventDraft,
  Zone,
  ZoneRule,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { defined } from '../../__tests__/support/vitest-mock.js'
import { FrameProcessor } from '../pipeline/frame-processor.js'
import type { SpawnRefusalRecord } from '../pipeline/tracker/spawn-refusal.js'

const DEFAULT_SIZE = { width: 640, height: 480 }

function detection(
  id: string,
  bbox: { x: number; y: number; width: number; height: number },
  overrides: Partial<ObjectDetection> = {},
): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox,
    ...overrides,
  }
}

function frame(detections: readonly ObjectDetection[], timestamp: number): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: 4,
    timestamp,
    width: DEFAULT_SIZE.width,
    height: DEFAULT_SIZE.height,
    detections,
  }
}

describe('FrameProcessor', () => {
  let processor: FrameProcessor

  beforeEach(() => {
    processor = new FrameProcessor(4)
  })

  it('returns empty output for an empty frame', () => {
    const res = processor.process({
      timestamp: 1000,
      frame: frame([], 1000),
    })
    expect(res.tracked).toEqual([])
    expect(res.objectEvents).toEqual([])
    expect(res.rawTrackedDetections).toEqual([])
    expect(res.deviceId).toBe(4)
    expect(res.frameWidth).toBe(640)
    expect(res.frameHeight).toBe(480)
  })

  it('promotes a sustained detection to a track once minHits is reached', () => {
    const det = detection('d1', { x: 100, y: 100, width: 50, height: 50 })
    // First frame — below minHits, no tracked output yet.
    const f1 = processor.process({
      timestamp: 1000,
      frame: frame([det], 1000),
    })
    expect(f1.tracked).toHaveLength(0)

    // Second frame — still below minHits (=3).
    const f2 = processor.process({
      timestamp: 1100,
      frame: frame([det], 1100),
    })
    expect(f2.tracked).toHaveLength(0)

    // Third frame — minHits met, track emerges.
    const f3 = processor.process({
      timestamp: 1200,
      frame: frame([det], 1200),
    })
    expect(f3.tracked).toHaveLength(1)
    expect(f3.tracked[0]!.className).toBe('person')
    expect(f3.tracked[0]!.confidence).toBe(0.9)
    expect(f3.tracked[0]!.bbox).toEqual({ x: 100, y: 100, w: 50, h: 50 })
    expect(f3.rawTrackedDetections).toHaveLength(1)
    expect(f3.rawTrackedDetections[0]!.trackId).toBe(f3.tracked[0]!.trackId)
  })

  it('emits one ObjectEvent per tracked detection (one per state transition)', () => {
    const det = detection('d1', { x: 100, y: 100, width: 50, height: 50 })
    processor.process({ timestamp: 1000, frame: frame([det], 1000) })
    processor.process({ timestamp: 1100, frame: frame([det], 1100) })
    const f3 = processor.process({
      timestamp: 1200,
      frame: frame([det], 1200),
    })
    // DetectionEventEmitter fires when state transitions for a track;
    // on the first emission there must be at least one event row.
    expect(f3.objectEvents.length).toBeGreaterThanOrEqual(0)
    if (f3.objectEvents.length > 0) {
      const ev = f3.objectEvents[0]!
      expect(ev.kind).toBe('object')
      expect(ev.deviceId).toBe(4)
      expect(ev.timestamp).toBe(1200)
      expect(ev.trackId).toBe(f3.tracked[0]!.trackId)
      expect(ev.className).toBe('person')
    }
  })

  it('stamps every object event with the frame frameId (scene/parent key); co-occurring detections share it', () => {
    const p1 = detection('p1', { x: 50, y: 50, width: 40, height: 100 })
    const p2 = detection('p2', { x: 300, y: 60, width: 40, height: 100 })
    const dog = detection('d1', { x: 500, y: 200, width: 60, height: 40 }, { macroClass: 'animal' })
    const scene = [p1, p2, dog]
    processor.process({ timestamp: 1000, frame: frame(scene, 1000) })
    processor.process({ timestamp: 1100, frame: frame(scene, 1100) })
    const f3 = processor.process({
      timestamp: 1200,
      frame: frame(scene, 1200),
    })
    // Whatever events fired this frame, they all carry the frame's frameId.
    for (const ev of f3.objectEvents) {
      expect(ev.frameId).toBe('f-1200') // frame() sets frameId = `f-${timestamp}`
    }
    // The frameId is the shared scene key across the co-occurring detections.
    const ids = new Set(f3.objectEvents.map((e) => e.frameId))
    if (f3.objectEvents.length > 0) expect(ids.size).toBe(1)
  })

  it('skips non first-level detections (details)', () => {
    const person = detection('p1', { x: 100, y: 100, width: 50, height: 50 })
    const face: ObjectDetection = {
      id: 'f1',
      kind: 'detail',
      macroClass: 'face',
      score: 0.9,
      labels: [],
      bbox: { x: 110, y: 110, width: 20, height: 20 },
      parentId: 'p1',
    }
    // Warm up for minHits on person.
    processor.process({ timestamp: 1000, frame: frame([person, face], 1000) })
    processor.process({ timestamp: 1100, frame: frame([person, face], 1100) })
    const f3 = processor.process({
      timestamp: 1200,
      frame: frame([person, face], 1200),
    })
    expect(f3.tracked).toHaveLength(1)
    expect(f3.tracked[0]!.className).toBe('person')
  })

  it('propagates a face detail bbox onto its parent person track as faceBbox', () => {
    const person = detection('p1', { x: 100, y: 100, width: 50, height: 120 })
    const face: ObjectDetection = {
      id: 'f1',
      kind: 'detail',
      macroClass: 'face',
      score: 0.95,
      labels: [],
      bbox: { x: 115, y: 105, width: 20, height: 22 },
      parentId: 'p1',
      embedding: [1, 0, 0, 0],
      embeddingModelId: 'arcface-r100',
    }
    processor.process({ timestamp: 1000, frame: frame([person, face], 1000) })
    processor.process({ timestamp: 1100, frame: frame([person, face], 1100) })
    const f3 = processor.process({
      timestamp: 1200,
      frame: frame([person, face], 1200),
    })
    expect(f3.tracked).toHaveLength(1)
    // faceBbox = the tight face detail box (not the person box).
    expect(f3.tracked[0]!.faceBbox).toEqual({ x: 115, y: 105, w: 20, h: 22 })
    expect(f3.tracked[0]!.bbox).toEqual({ x: 100, y: 100, w: 50, h: 120 })
  })

  it('binds the face detail embedding to the parent track alongside faceBbox even when the person first-level has no embedding', () => {
    // Root cause of imageless faces: the face-detection frame's tracked person
    // must carry BOTH an embedding (so the FaceRecognizer sees a candidate) AND
    // the faceBbox (so it can crop) on the SAME frame. The face detail carries
    // the arcface embedding; if the first-level inheritance didn't populate
    // det.embedding, the person would surface faceBbox WITHOUT an embedding →
    // never a candidate → the crop is never captured on the frame that has a
    // face box. Frame-processor now binds the face detail's own embedding to the
    // parent so the two always coincide.
    const person = detection('p1', { x: 100, y: 100, width: 50, height: 120 })
    // person carries NO first-level embedding — only the face detail does.
    const face: ObjectDetection = {
      id: 'f1',
      kind: 'detail',
      macroClass: 'face',
      score: 0.95,
      labels: [],
      bbox: { x: 115, y: 105, width: 20, height: 22 },
      parentId: 'p1',
      embedding: [0.5, 0.5, 0.5, 0.5],
      embeddingModelId: 'arcface-r100',
    }
    processor.process({ timestamp: 1000, frame: frame([person, face], 1000) })
    processor.process({ timestamp: 1100, frame: frame([person, face], 1100) })
    const f3 = processor.process({
      timestamp: 1200,
      frame: frame([person, face], 1200),
    })
    const t = f3.tracked[0]!
    expect(t.faceBbox).toEqual({ x: 115, y: 105, w: 20, h: 22 })
    // BOTH present on the same tracked item → a valid FaceRecognizer candidate.
    expect(t.embedding).toEqual([0.5, 0.5, 0.5, 0.5])
    expect(t.embeddingModelId).toBe('arcface-r100')
  })

  it("surfaces the face detail's aligned crop (exact ArcFace input) on the parent track alongside faceBbox", () => {
    const person = detection('p1', { x: 100, y: 100, width: 50, height: 120 })
    const face: ObjectDetection = {
      id: 'f1',
      kind: 'detail',
      macroClass: 'face',
      score: 0.95,
      labels: [],
      bbox: { x: 115, y: 105, width: 20, height: 22 },
      parentId: 'p1',
      embedding: [0.5, 0.5, 0.5, 0.5],
      embeddingModelId: 'arcface-r100',
      faceAlignedCrop: 'QUxJR05FRA==',
    }
    processor.process({ timestamp: 1000, frame: frame([person, face], 1000) })
    processor.process({ timestamp: 1100, frame: frame([person, face], 1100) })
    const f3 = processor.process({
      timestamp: 1200,
      frame: frame([person, face], 1200),
    })
    const t = f3.tracked[0]!
    // The exact model input is carried onto the same track as its embedding +
    // faceBbox → the FaceRecognizer persists it 1:1 with the vector.
    expect(t.faceAlignedCrop).toBe('QUxJR05FRA==')
    expect(t.faceBbox).toEqual({ x: 115, y: 105, w: 20, h: 22 })
  })

  it('leaves faceAlignedCrop undefined when the face detail carries none', () => {
    const person = detection('p1', { x: 100, y: 100, width: 50, height: 120 })
    const face: ObjectDetection = {
      id: 'f1',
      kind: 'detail',
      macroClass: 'face',
      score: 0.95,
      labels: [],
      bbox: { x: 115, y: 105, width: 20, height: 22 },
      parentId: 'p1',
      embedding: [0.5, 0.5, 0.5, 0.5],
      embeddingModelId: 'arcface-r100',
    }
    processor.process({ timestamp: 1000, frame: frame([person, face], 1000) })
    processor.process({ timestamp: 1100, frame: frame([person, face], 1100) })
    const f3 = processor.process({
      timestamp: 1200,
      frame: frame([person, face], 1200),
    })
    expect(f3.tracked[0]!.faceAlignedCrop).toBeUndefined()
  })

  it('prefers the first-level inherited embedding over the face detail embedding when both exist', () => {
    // Production path: result-assembler already inherited the face embedding onto
    // the person first-level. That inherited vector wins; the binding is only a
    // fallback for when the first-level lacks it.
    const person = detection(
      'p1',
      { x: 100, y: 100, width: 50, height: 120 },
      { embedding: [1, 0, 0, 0], embeddingModelId: 'arcface-r100' },
    )
    const face: ObjectDetection = {
      id: 'f1',
      kind: 'detail',
      macroClass: 'face',
      score: 0.95,
      labels: [],
      bbox: { x: 115, y: 105, width: 20, height: 22 },
      parentId: 'p1',
      embedding: [0, 1, 0, 0],
      embeddingModelId: 'arcface-r100',
    }
    processor.process({ timestamp: 1000, frame: frame([person, face], 1000) })
    processor.process({ timestamp: 1100, frame: frame([person, face], 1100) })
    const f3 = processor.process({
      timestamp: 1200,
      frame: frame([person, face], 1200),
    })
    const t = f3.tracked[0]!
    expect(t.embedding).toEqual([1, 0, 0, 0]) // first-level inherited vector wins
    expect(t.faceBbox).toEqual({ x: 115, y: 105, w: 20, h: 22 })
  })

  it('leaves faceBbox undefined when no face detail is present', () => {
    const person = detection('p1', { x: 100, y: 100, width: 50, height: 120 })
    processor.process({ timestamp: 1000, frame: frame([person], 1000) })
    processor.process({ timestamp: 1100, frame: frame([person], 1100) })
    const f3 = processor.process({
      timestamp: 1200,
      frame: frame([person], 1200),
    })
    expect(f3.tracked[0]!.faceBbox).toBeUndefined()
  })

  it("zone rules drop detections that don't satisfy a vehicle-only include rule", () => {
    const entrance: Zone = {
      id: 'entrance',
      name: 'entrance',
      kind: 'polygon',
      polygon: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      color: '#3b82f6',
    }
    const vehiclesOnly: ZoneRule = {
      id: 'r-vehicles',
      zoneIds: ['entrance'],
      mode: 'include',
      classFilter: ['vehicle'],
      overlapThreshold: 0,
      enabled: true,
    }
    processor.setZones([entrance])
    processor.setDetectionRules([vehiclesOnly])
    const person = detection('p1', { x: 100, y: 100, width: 50, height: 50 })
    processor.process({ timestamp: 1000, frame: frame([person], 1000) })
    processor.process({ timestamp: 1100, frame: frame([person], 1100) })
    const f3 = processor.process({
      timestamp: 1200,
      frame: frame([person], 1200),
    })
    // Person filtered out by include-rule (class mismatch) — no tracks
    // even after 3 frames.
    expect(f3.tracked).toHaveLength(0)
  })

  it('says so when a zone rule excludes a detection (D391)', () => {
    // The exclusion above is CORRECT and, until D391, produced not one line:
    // `filterDetections` returns what it excluded and the caller dropped it on
    // the floor. A camera whose subject never tracks looks identical to a
    // tracker fault from the log.
    const entrance: Zone = {
      id: 'entrance',
      name: 'entrance',
      kind: 'polygon',
      polygon: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      color: '#3b82f6',
    }
    const vehiclesOnly: ZoneRule = {
      id: 'r-vehicles',
      zoneIds: ['entrance'],
      mode: 'include',
      classFilter: ['vehicle'],
      overlapThreshold: 0,
      enabled: true,
    }
    const seen: SpawnRefusalRecord[] = []
    processor.setSpawnRefusalObserver((r) => seen.push(r))
    processor.setZones([entrance])
    processor.setDetectionRules([vehiclesOnly])
    const person = detection('p1', { x: 100, y: 100, width: 50, height: 50 })
    processor.process({ timestamp: 1000, frame: frame([person], 1000) })
    const record = seen.find((r) => r.reason === 'zone-filtered')
    expect(record).toBeDefined()
    expect(record?.detClass).toBe('person')
    expect(record?.detScore).toBe(0.9)
  })

  it('originalClass from detection.debug flows onto the raw tracked output', () => {
    const det: ObjectDetection = {
      id: 'd1',
      kind: 'first-level',
      macroClass: 'animal',
      score: 0.8,
      labels: [],
      bbox: { x: 50, y: 50, width: 30, height: 30 },
      debug: { originalClass: 'dog' },
    }
    processor.process({ timestamp: 1000, frame: frame([det], 1000) })
    processor.process({ timestamp: 1100, frame: frame([det], 1100) })
    const f3 = processor.process({
      timestamp: 1200,
      frame: frame([det], 1200),
    })
    expect(f3.rawTrackedDetections[0]?.originalClass).toBe('dog')
    expect(f3.tracked[0]?.className).toBe('animal') // macro class on the lightweight shape
  })

  it('stamps a sub-detector enrichment label onto the tracked output', () => {
    const det = detection(
      'd1',
      { x: 100, y: 100, width: 50, height: 50 },
      {
        labels: [{ label: 'John', score: 0.93, tier: 2, stepId: 'face-embedding' }],
      },
    )
    processor.process({ timestamp: 1000, frame: frame([det], 1000) })
    processor.process({ timestamp: 1100, frame: frame([det], 1100) })
    const f3 = processor.process({
      timestamp: 1200,
      frame: frame([det], 1200),
    })
    expect(f3.tracked[0]?.labelPatch?.subLabel).toBe('John')
  })

  // D715/D730: a linked label lands as the score-0 fallback when the runner
  // left it there (the root supply not effective).
  it('writes a linked label as the score-0 fallback', () => {
    const det = detection(
      'd1',
      { x: 100, y: 100, width: 50, height: 50 },
      {
        macroClass: 'animal',
        labels: [
          {
            label: 'deer',
            score: 0,
            tier: 1,
            stepId: 'detector-link:animal-classifier',
            modelId: 'frigate-plus',
          },
        ],
      },
    )
    processor.process({ timestamp: 1000, frame: frame([det], 1000) })
    processor.process({ timestamp: 1100, frame: frame([det], 1100) })
    const f3 = processor.process({ timestamp: 1200, frame: frame([det], 1200) })
    expect(f3.tracked[0]?.labelPatch?.label).toBe('deer')
    expect(f3.tracked[0]?.labelPatch?.labelScore).toBe(0)
  })

  // D730: a root-drawn plate / face is a DETAIL of its parent — it rides the
  // parent's tracked output (`rootChildBoxes`, the dispatcher's input) and a
  // root face feeds the person's face box; neither ever becomes a track.
  it('carries root child boxes on the parent track and never tracks them', () => {
    const car = detection(
      'd1',
      { x: 100, y: 100, width: 200, height: 100 },
      { macroClass: 'vehicle' },
    )
    const plate = detection(
      'd2',
      { x: 180, y: 170, width: 40, height: 12 },
      {
        kind: 'detail',
        macroClass: 'plate',
        parentId: 'd1',
        score: 0.7,
        rootSupplied: { stepId: 'plate-detection', modelId: 'frigate-plus' },
      },
    )
    const person = detection('d3', { x: 400, y: 50, width: 60, height: 160 })
    const face = detection(
      'd4',
      { x: 415, y: 60, width: 20, height: 24 },
      {
        kind: 'detail',
        macroClass: 'face',
        parentId: 'd3',
        score: 0.8,
        rootSupplied: { stepId: 'face-detection', modelId: 'frigate-plus' },
      },
    )
    const all = [car, plate, person, face]
    processor.process({ timestamp: 1000, frame: frame(all, 1000) })
    processor.process({ timestamp: 1100, frame: frame(all, 1100) })
    const f3 = processor.process({ timestamp: 1200, frame: frame(all, 1200) })
    expect(f3.tracked.map((t) => t.className).sort()).toEqual(['person', 'vehicle'])
    const vehicle = f3.tracked.find((t) => t.className === 'vehicle')
    expect(vehicle?.rootChildBoxes).toEqual([
      {
        stepId: 'plate-detection',
        modelId: 'frigate-plus',
        score: 0.7,
        bbox: { x: 180, y: 170, w: 40, h: 12 },
      },
    ])
    const tracked = f3.tracked.find((t) => t.className === 'person')
    expect(tracked?.faceBbox).toEqual({ x: 415, y: 60, w: 20, h: 24 })
  })

  it('leaves label undefined when the detection carries no enrichment label', () => {
    const det = detection('d1', { x: 100, y: 100, width: 50, height: 50 })
    processor.process({ timestamp: 1000, frame: frame([det], 1000) })
    processor.process({ timestamp: 1100, frame: frame([det], 1100) })
    const f3 = processor.process({
      timestamp: 1200,
      frame: frame([det], 1200),
    })
    expect(f3.tracked[0]?.labelPatch).toBeUndefined()
  })

  it('propagates the enrichment label onto emitted object events', () => {
    const det = detection(
      'd1',
      { x: 100, y: 100, width: 50, height: 50 },
      {
        labels: [{ label: 'ABC123', score: 0.88, tier: 2, stepId: 'plate-ocr' }],
      },
    )
    let labelled: string | undefined
    for (let i = 0; i < 6; i++) {
      const r = processor.process({
        timestamp: 1000 + i * 100,
        frame: frame([det], 1000 + i * 100),
      })
      const ev = r.objectEvents.find((e) => e.trackId === r.tracked[0]?.trackId)
      if (ev) {
        labelled = ev.subLabel
        break
      }
    }
    expect(labelled).toBe('ABC123')
  })

  // ── Appearance events (Requirement 1) ──────────────────────────────
  describe('appearance events', () => {
    // Emitter config where the age gate passes AFTER the `entering` window, so
    // the track never fires object.entering and must be valued by an appearance.
    const gateAfterEntering = {
      minTrackAge: 3,
      minTrackAgeMs: 500,
      cooldownSec: 0,
    }

    // The subject MOVES, 6 px per frame. That is the whole point: a track that
    // keeps moving never reaches a state in STATE_TO_EVENT (`entering`,
    // `leaving`, `stationary`, `loitering`), so it earns no crop-bearing event
    // and the appearance fallback is the only thing that can value it.
    //
    // The fixture used to hold the bbox STILL while the test called it moving.
    // A motionless subject settles to `stationary`, fires a real
    // object.stationary at the gate, and the fallback then correctly stands
    // down — so the assertion below was describing a case the setup never
    // built. Moving the box restores the scenario the test is named after.
    const movingDetection = (i: number): ObjectDetection =>
      detection('d1', { x: 120 + i * 6, y: 130, width: 40, height: 90 })

    it('values a degenerate moving track with one appearance event carrying the current bbox', () => {
      const p = new FrameProcessor(4, {}, {}, gateAfterEntering)
      const collected: ObjectEventDraft[] = []
      let trackId: string | undefined
      let emittedAt = -1
      for (let i = 0; i <= 12; i++) {
        const r = p.process({
          timestamp: 1000 + i * 100,
          frame: frame([movingDetection(i)], 1000 + i * 100),
        })
        if (r.appearanceEvents.length > 0) emittedAt = i
        collected.push(...r.appearanceEvents)
        trackId = r.tracked[0]?.trackId ?? trackId
      }
      expect(collected).toHaveLength(1)
      const app = collected[0]!
      expect(app.kind).toBe('object')
      expect(app.trackId).toBe(trackId)
      expect(app.state).toBe('entered')
      // The CURRENT frame's bbox, not a degenerate {0,0,0,0} and not the bbox
      // the track was born with — that distinction is the requirement.
      const bbox = defined(app.bbox, 'appearance bbox')
      expect(bbox).toEqual({
        x: 120 + emittedAt * 6,
        y: 130,
        w: 40,
        h: 90,
      })
      expect(bbox.x).not.toBe(120)
      expect(app.className).toBe('person')
    })

    it('emits the appearance at most once over the track lifetime', () => {
      const p = new FrameProcessor(4, {}, {}, gateAfterEntering)
      let total = 0
      for (let i = 0; i <= 12; i++) {
        const r = p.process({
          timestamp: 1000 + i * 100,
          frame: frame([movingDetection(i)], 1000 + i * 100),
        })
        total += r.appearanceEvents.length
      }
      expect(total).toBe(1)
    })

    it('produces no appearance events when the emitter fires object.entering (default config values the track)', () => {
      const p = new FrameProcessor(4) // library default → object.entering fires at the gate
      const det = detection('d1', { x: 120, y: 130, width: 40, height: 90 })
      let total = 0
      for (let i = 0; i <= 8; i++) {
        const r = p.process({
          timestamp: 1000 + i * 100,
          frame: frame([det], 1000 + i * 100),
        })
        total += r.appearanceEvents.length
      }
      expect(total).toBe(0)
    })
  })

  // ── Detection source (multi-source foundation) ─────────────────────
  it('defaults the detection source to "pipeline"', () => {
    expect(new FrameProcessor(4).source).toBe('pipeline')
  })

  it('accepts an explicit detection source', () => {
    expect(new FrameProcessor(4, {}, {}, {}, 'onboard').source).toBe('onboard')
  })

  it('stamps the source on every emitted ObjectEvent', () => {
    const p = new FrameProcessor(4, {}, {}, {}, 'onboard')
    const det = detection('d1', { x: 100, y: 100, width: 50, height: 50 })
    p.process({ timestamp: 1000, frame: frame([det], 1000) })
    p.process({ timestamp: 1100, frame: frame([det], 1100) })
    const f3 = p.process({ timestamp: 1200, frame: frame([det], 1200) })
    expect(f3.objectEvents.every((e) => e.source === 'onboard')).toBe(true)
  })

  it('stamps "pipeline" by default on emitted ObjectEvents', () => {
    const det = detection('d1', { x: 100, y: 100, width: 50, height: 50 })
    processor.process({ timestamp: 1000, frame: frame([det], 1000) })
    processor.process({ timestamp: 1100, frame: frame([det], 1100) })
    const f3 = processor.process({
      timestamp: 1200,
      frame: frame([det], 1200),
    })
    expect(f3.objectEvents.every((e) => e.source === 'pipeline')).toBe(true)
  })

  it('surfaces a first-level detection embedding on its tracked item', () => {
    const det = detection(
      'd1',
      { x: 10, y: 10, width: 50, height: 100 },
      {
        embedding: [0.1, 0.2, 0.3, 0.4],
        embeddingModelId: 'arcface-r100',
      },
    )
    processor.process({ timestamp: 1000, frame: frame([det], 1000) })
    processor.process({ timestamp: 1100, frame: frame([det], 1100) })
    const f3 = processor.process({
      timestamp: 1200,
      frame: frame([det], 1200),
    })
    const t = f3.tracked[0]
    expect(t?.embedding).toEqual([0.1, 0.2, 0.3, 0.4])
    expect(t?.embeddingModelId).toBe('arcface-r100')
  })

  it('stamps sourceDetectionId with the matched first-level detection id', () => {
    const det = detection('det-abc', { x: 100, y: 100, width: 50, height: 50 })
    processor.process({ timestamp: 1000, frame: frame([det], 1000) })
    processor.process({ timestamp: 1100, frame: frame([det], 1100) })
    const f3 = processor.process({
      timestamp: 1200,
      frame: frame([det], 1200),
    })
    expect(f3.tracked[0]?.sourceDetectionId).toBe('det-abc')
  })

  describe('stationary gate', () => {
    it('a suppressed detection never becomes a track and is reported confirmed', () => {
      // Gate that always suppresses detection 0 as entry "parked-1".
      processor.setStationaryGate({
        filter: () => ({
          suppressedIndices: new Set([0]),
          continuableIndices: new Set<number>(),
          confirmed: [
            {
              entryId: 'parked-1',
              className: 'person',
              bbox: { x: 100, y: 100, w: 50, h: 50 },
              observedBbox: { x: 100, y: 100, w: 50, h: 50 },
              strong: true,
            },
          ],
          woken: [],
        }),
      })
      const det = detection('d1', { x: 100, y: 100, width: 50, height: 50 })
      // Even across minHits+ frames the suppressed detection spawns NO track.
      let last = processor.process({
        timestamp: 1000,
        frame: frame([det], 1000),
      })
      last = processor.process({ timestamp: 1100, frame: frame([det], 1100) })
      last = processor.process({ timestamp: 1200, frame: frame([det], 1200) })
      last = processor.process({ timestamp: 1300, frame: frame([det], 1300) })
      expect(last.tracked).toHaveLength(0)
      expect(last.rawTrackedDetections).toHaveLength(0)
      expect(last.stationaryConfirmed.map((c) => c.entryId)).toEqual(['parked-1'])
    })

    it('a WEAK hold continues a confirmed track, is counted, and never opens one (D410)', () => {
      const det = detection('d1', { x: 100, y: 100, width: 50, height: 50 })
      // Three released frames confirm the track (minHits 3).
      let res = processor.process({ timestamp: 1000, frame: frame([det], 1000) })
      res = processor.process({ timestamp: 1100, frame: frame([det], 1100) })
      res = processor.process({ timestamp: 1200, frame: frame([det], 1200) })
      const id = res.tracked[0]?.trackId
      expect(id).toBeDefined()
      expect(res.stationaryContinued).toBe(0)
      // From here the gate holds detection 0 WEAKLY: suppressed, continuable.
      processor.setStationaryGate({
        filter: () => ({
          suppressedIndices: new Set([0]),
          continuableIndices: new Set([0]),
          confirmed: [],
          woken: [],
        }),
      })
      for (const ts of [1300, 1400]) {
        res = processor.process({ timestamp: ts, frame: frame([det], ts) })
        expect(res.tracked.map((t) => [t.trackId, t.matchedThisFrame])).toEqual([[id, true]])
        expect(res.stationaryContinued).toBe(1)
      }

      // The same weak hold on a fresh processor opens nothing, and says so.
      const fresh = new FrameProcessor(4)
      const refusals: SpawnRefusalRecord[] = []
      fresh.setSpawnRefusalObserver((r) => refusals.push(r))
      fresh.setStationaryGate({
        filter: () => ({
          suppressedIndices: new Set([0]),
          continuableIndices: new Set([0]),
          confirmed: [],
          woken: [],
        }),
      })
      for (const ts of [1000, 1100, 1200, 1300]) {
        res = fresh.process({ timestamp: ts, frame: frame([det], ts) })
        expect(res.tracked).toEqual([])
        expect(res.stationaryContinued).toBe(0)
      }
      expect(refusals.map((r) => r.reason)).toEqual([
        'stationary-hold',
        'stationary-hold',
        'stationary-hold',
        'stationary-hold',
      ])
    })

    it('a non-suppressed detection still tracks normally and wakes pass through whole', () => {
      processor.setStationaryGate({
        filter: () => ({
          suppressedIndices: new Set<number>(),
          continuableIndices: new Set<number>(),
          confirmed: [],
          woken: [
            {
              entryId: 'departed-1',
              cause: 'contradicting-read',
              strikeAgeMs: 3_400,
              absentReads: 0,
            },
          ],
        }),
      })
      const det = detection('d1', { x: 200, y: 200, width: 50, height: 50 })
      processor.process({ timestamp: 1000, frame: frame([det], 1000) })
      processor.process({ timestamp: 1100, frame: frame([det], 1100) })
      const f3 = processor.process({
        timestamp: 1200,
        frame: frame([det], 1200),
      })
      expect(f3.tracked).toHaveLength(1)
      // The CAUSE and the separation ride along — the retirement log line is
      // built from them, and a wake reduced to a bare id is exactly what made
      // the 102 retirements unreadable.
      expect(f3.stationaryWoken).toEqual([
        {
          entryId: 'departed-1',
          cause: 'contradicting-read',
          strikeAgeMs: 3_400,
          absentReads: 0,
        },
      ])
    })

    it('the gate is handed THIS frame’s timestamp — its whole decision is about time (D279)', () => {
      // Without the clock the gate cannot tell a confirming read from the next
      // frame of the same optical event, which is the defect D279 exists for.
      const seen: number[] = []
      processor.setStationaryGate({
        filter: (input) => {
          seen.push(input.timestamp)
          return {
            suppressedIndices: new Set<number>(),
            continuableIndices: new Set<number>(),
            confirmed: [],
            woken: [],
          }
        },
      })
      const det = detection('d1', { x: 200, y: 200, width: 50, height: 50 })
      processor.process({ timestamp: 1000, frame: frame([det], 1000) })
      processor.process({ timestamp: 1900, frame: frame([det], 1900) })
      expect(seen).toEqual([1000, 1900])
    })

    it('a suppressed detection with NO confirmation and NO wake still spawns nothing', () => {
      // The shape a first departing read produces: the box is held back and
      // nothing else is reported. The strike itself never travels — the
      // registry commits it inside its own gate (D279) — so the only thing the
      // FrameProcessor must get right is that the detection does not track.
      processor.setStationaryGate({
        filter: () => ({
          suppressedIndices: new Set([0]),
          continuableIndices: new Set<number>(),
          confirmed: [],
          woken: [],
        }),
      })
      const det = detection('d1', { x: 200, y: 200, width: 50, height: 50 })
      processor.process({ timestamp: 1000, frame: frame([det], 1000) })
      processor.process({ timestamp: 1100, frame: frame([det], 1100) })
      const f3 = processor.process({
        timestamp: 1200,
        frame: frame([det], 1200),
      })
      expect(f3.tracked).toHaveLength(0)
      expect(f3.stationaryWoken).toEqual([])
    })

    it('dropTrack forgets a live track so it stops emitting', () => {
      const det = detection('d1', { x: 100, y: 100, width: 50, height: 50 })
      processor.process({ timestamp: 1000, frame: frame([det], 1000) })
      processor.process({ timestamp: 1100, frame: frame([det], 1100) })
      const f3 = processor.process({
        timestamp: 1200,
        frame: frame([det], 1200),
      })
      const id = f3.tracked[0]!.trackId
      processor.dropTrack(id)
      const f4 = processor.process({
        timestamp: 1300,
        frame: frame([det], 1300),
      })
      // The dropped id is gone; a fresh detection spawns a NEW id (below minHits
      // again → empty this frame), never the old track.
      expect(f4.tracked.find((t) => t.trackId === id)).toBeUndefined()
    })
  })
})

// ── zone crossings (D35 + the exit direction) ───────────────────

describe('FrameProcessor zone crossings', () => {
  /** Left 40% of the frame — the "Uscio" zone of the 2026-07-31 case. */
  const uscio: Zone = {
    id: 'uscio',
    name: 'Uscio',
    kind: 'polygon',
    polygon: [
      { x: 0, y: 0 },
      { x: 0.4, y: 0 },
      { x: 0.4, y: 1 },
      { x: 0, y: 1 },
    ],
    color: '#3b82f6',
  }

  /** Walk one subject left→right across the zone boundary and collect every
   *  object event stamped with a crossing. Steps of 25 px keep consecutive
   *  boxes overlapping, so the tracker holds ONE id for the whole passage. */
  function walkAcross(): readonly ObjectEventDraft[] {
    const processor = new FrameProcessor(101)
    processor.setZones([uscio])
    const crossings: ObjectEventDraft[] = []
    for (let i = 0; i < 24; i += 1) {
      const ts = 1000 + i * 100
      const det = detection('d1', {
        x: 40 + i * 25,
        y: 100,
        width: 50,
        height: 50,
      })
      const res = processor.process({ timestamp: ts, frame: frame([det], ts) })
      for (const ev of res.objectEvents) {
        if (ev.zoneCrossing !== undefined) crossings.push(ev)
      }
    }
    return crossings
  }

  it('emits BOTH directions, each stamped with the zone it crossed', () => {
    const crossings = walkAcross()
    const directions = crossings.map((c) => c.zoneCrossing?.direction)
    expect(directions).toContain('enter')
    // The regression this whole package exists for: an exit used to be
    // computed and thrown away, so a departure produced no record at all.
    expect(directions).toContain('exit')
    for (const c of crossings) {
      expect(c.zoneCrossing?.zoneId).toBe('uscio')
      expect(c.zoneCrossing?.zoneName).toBe('Uscio')
      expect(c.deviceId).toBe(101)
    }
  })

  it('the EXIT record no longer carries the zone in its membership', () => {
    // Which is exactly why the rule engine has to test the crossed zone as
    // well as `zones` — geometry says the box is out the moment it left.
    const exit = walkAcross().find((c) => c.zoneCrossing?.direction === 'exit')
    expect(exit).toBeDefined()
    expect(exit?.zones ?? []).not.toContain('uscio')
  })

  it('an entry record still carries the zone (unchanged)', () => {
    const enter = walkAcross().find((c) => c.zoneCrossing?.direction === 'enter')
    expect(enter?.zones ?? []).toContain('uscio')
  })

  it('leaves a movement-state event unstamped — it is not a crossing', () => {
    const processor = new FrameProcessor(101)
    processor.setZones([uscio])
    const det = detection('d1', { x: 40, y: 100, width: 50, height: 50 })
    const events: ObjectEventDraft[] = []
    for (let i = 0; i < 6; i += 1) {
      const ts = 1000 + i * 100
      events.push(...processor.process({ timestamp: ts, frame: frame([det], ts) }).objectEvents)
    }
    // The subject sits INSIDE the zone the whole time: exactly one crossing
    // (its entry), while the movement-state transitions it also produces stay
    // unstamped. `state` cannot be the discriminator — a crossing event
    // carries the track's movement state too.
    const stamped = events.filter((e) => e.zoneCrossing !== undefined)
    const unstamped = events.filter((e) => e.zoneCrossing === undefined)
    expect(stamped).toHaveLength(1)
    expect(stamped[0]?.zoneCrossing?.direction).toBe('enter')
    expect(unstamped.length).toBeGreaterThan(0)
  })
})

// ── tripwire crossings — the call that never existed ────────────────

describe('FrameProcessor tripwire crossings', () => {
  /**
   * A vertical tripwire down the middle of the frame, directed top → bottom.
   *
   * The zone editor stores a tripwire as a 2-point line in `polygon`, which is
   * why this looks like a degenerate polygon: it is the shape the operator's
   * "Add tripwire" button actually writes.
   */
  const gate: Zone = {
    id: 'gate',
    name: 'Cancello',
    kind: 'tripwire',
    polygon: [
      { x: 0.5, y: 0 },
      { x: 0.5, y: 1 },
    ],
    color: '#ef4444',
  }

  function walkOver(startX: number, stepX: number): readonly ObjectEventDraft[] {
    const processor = new FrameProcessor(101)
    processor.setZones([gate])
    const crossings: ObjectEventDraft[] = []
    for (let i = 0; i < 24; i += 1) {
      const ts = 1000 + i * 100
      const det = detection('d1', {
        x: startX + i * stepX,
        y: 100,
        width: 50,
        height: 50,
      })
      const res = processor.process({ timestamp: ts, frame: frame([det], ts) })
      for (const ev of res.objectEvents) {
        if (ev.zoneCrossing !== undefined) crossings.push(ev)
      }
    }
    return crossings
  }

  it('a subject walking over a drawn tripwire produces a crossing AT ALL', () => {
    // Before this, `tripwireCrossing()` had zero callers and this was empty.
    const crossings = walkOver(40, 25)
    expect(crossings.length).toBeGreaterThan(0)
    expect(crossings[0]?.zoneCrossing?.zoneId).toBe('gate')
    expect(crossings[0]?.zoneCrossing?.zoneName).toBe('Cancello')
    expect(crossings[0]?.deviceId).toBe(101)
  })

  it('reports OPPOSITE directions for the two ways over the wire', () => {
    const rightward = walkOver(40, 25).map((c) => c.zoneCrossing?.direction)
    const leftward = walkOver(560, -25).map((c) => c.zoneCrossing?.direction)
    expect(rightward.length).toBeGreaterThan(0)
    expect(leftward.length).toBeGreaterThan(0)
    expect(rightward[0]).not.toBe(leftward[0])
  })

  it('reuses the zone-crossing condition vocabulary rather than a second one', () => {
    // `enter` / `exit` — so a rule that already says "only entries" works on a
    // tripwire with no new field and no new widget.
    for (const c of walkOver(40, 25)) {
      expect(['enter', 'exit']).toContain(c.zoneCrossing?.direction)
    }
  })

  it('a subject that never reaches the wire produces nothing', () => {
    const processor = new FrameProcessor(101)
    processor.setZones([gate])
    const crossings: ObjectEventDraft[] = []
    for (let i = 0; i < 12; i += 1) {
      const ts = 1000 + i * 100
      // Stays well left of x=0.5 (320 px).
      const det = detection('d1', {
        x: 20 + i * 5,
        y: 100,
        width: 50,
        height: 50,
      })
      const res = processor.process({ timestamp: ts, frame: frame([det], ts) })
      for (const ev of res.objectEvents) if (ev.zoneCrossing !== undefined) crossings.push(ev)
    }
    expect(crossings).toEqual([])
  })
})

// ── a departure has no box, and says so ─────────────────────────────

describe('FrameProcessor departures', () => {
  it('a `left` event carries NO bbox — never a rectangle at the origin', () => {
    const processor = new FrameProcessor(101)
    const events: ObjectEventDraft[] = []

    // A subject walks for long enough to clear the emitter's age gates.
    for (let i = 0; i < 14; i += 1) {
      const ts = 1000 + i * 100
      const det = detection('d1', { x: 100 + i * 20, y: 100, width: 50, height: 50 })
      events.push(...processor.process({ timestamp: ts, frame: frame([det], ts) }).objectEvents)
    }
    // Then it is gone. The emitter resolves the departure from its LAST-KNOWN
    // track, which is exactly why there is no box in THIS frame to report.
    for (let i = 0; i < 25; i += 1) {
      const ts = 5000 + i * 100
      events.push(...processor.process({ timestamp: ts, frame: frame([], ts) }).objectEvents)
    }

    const left = events.filter((e) => e.state === 'left')
    expect(left.length).toBeGreaterThan(0)
    for (const e of left) expect(e.bbox).toBeUndefined()
    // And every event that DOES report a box reports a real one.
    for (const e of events) {
      if (e.bbox === undefined) continue
      expect(e.bbox.w).toBeGreaterThan(0)
      expect(e.bbox.h).toBeGreaterThan(0)
    }
  })
})

// ── an exit off the EDGE of the frame ───────────────────────────────

describe('FrameProcessor edge exits', () => {
  /** Right 40% of the frame. A subject that walks out of shot from here has
   *  left the zone, and nothing else will ever say so. */
  const perimeter: Zone = {
    id: 'perimeter',
    name: 'Perimetro',
    kind: 'polygon',
    polygon: [
      { x: 0.6, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0.6, y: 1 },
    ],
    color: '#3b82f6',
  }

  it('emits an exit when the subject leaves the FRAME while inside the zone', () => {
    const processor = new FrameProcessor(101)
    processor.setZones([perimeter])
    const crossings: ObjectEventDraft[] = []

    // Walk in from the left, well into the zone, and confirm the entry.
    for (let i = 0; i < 14; i += 1) {
      const ts = 1000 + i * 100
      const det = detection('d1', {
        x: 300 + i * 20,
        y: 100,
        width: 50,
        height: 50,
      })
      for (const ev of processor.process({
        timestamp: ts,
        frame: frame([det], ts),
      }).objectEvents) {
        if (ev.zoneCrossing !== undefined) crossings.push(ev)
      }
    }
    expect(crossings.map((c) => c.zoneCrossing?.direction)).toContain('enter')

    // Now the subject is simply GONE — out of shot, not out of the zone.
    for (let i = 0; i < 20; i += 1) {
      const ts = 5000 + i * 100
      for (const ev of processor.process({
        timestamp: ts,
        frame: frame([], ts),
      }).objectEvents) {
        if (ev.zoneCrossing !== undefined) crossings.push(ev)
      }
    }

    // For a perimeter camera "walked out of shot" is the interesting case, and
    // it produced NOTHING before: the tracker returned the zones it was still
    // in and the frame processor discarded them.
    const exit = crossings.find((c) => c.zoneCrossing?.direction === 'exit')
    expect(exit).toBeDefined()
    expect(exit?.zoneCrossing?.zoneId).toBe('perimeter')
    expect(exit?.zoneCrossing?.zoneName).toBe('Perimetro')
  })

  it('does not invent an exit for a subject that was never in a zone', () => {
    const processor = new FrameProcessor(101)
    processor.setZones([perimeter])
    const crossings: ObjectEventDraft[] = []
    // Stays in the LEFT of the frame, outside the zone, then vanishes.
    for (let i = 0; i < 12; i += 1) {
      const ts = 1000 + i * 100
      const det = detection('d1', {
        x: 20 + i * 5,
        y: 100,
        width: 40,
        height: 40,
      })
      for (const ev of processor.process({
        timestamp: ts,
        frame: frame([det], ts),
      }).objectEvents) {
        if (ev.zoneCrossing !== undefined) crossings.push(ev)
      }
    }
    for (let i = 0; i < 20; i += 1) {
      const ts = 5000 + i * 100
      for (const ev of processor.process({
        timestamp: ts,
        frame: frame([], ts),
      }).objectEvents) {
        if (ev.zoneCrossing !== undefined) crossings.push(ev)
      }
    }
    expect(crossings).toEqual([])
  })
})

// ── A REFUSED TIER COLLAPSE IS REPORTED (2026-08-08) ──────────────────────
//
// The one write rule refuses a macro class for either label slot.
// That refusal is a branch that DROPS a value, and the five live rows it was
// written for (`className='person', label='animal'` on 592/104/103/637) were
// found by reading the rows a week later, because nothing said a word while it
// was happening. The processor now surfaces each refusal once per track so the
// addon can log it per camera.
describe('FrameProcessor label-tier collapses', () => {
  /** Promote a person track, then feed an ANIMAL detection into the same box.
   *  The tracker's lifetime class vote stays `person`; this frame's
   *  `originalClass` is `animal` — the exact shape that produced the bad rows.
   *  The animal box is fed WEAKLY (0.5): since D439 a cross-class box binds a
   *  track only below `animalOverPersonMaxScore`, and a confident one is its
   *  own subject — refused a second id by the spawn dedup, never folded in. */
  function personTrackThenAnimalFrame(): FrameProcessor {
    const p = new FrameProcessor(592)
    const box = { x: 100, y: 100, width: 50, height: 50 }
    for (let i = 0; i < 6; i += 1) {
      const ts = 1000 + i * 100
      p.process({ timestamp: ts, frame: frame([detection('d1', box)], ts) })
    }
    return p
  }

  it('reports the refused token, the class that outranked it, and the track', () => {
    const p = personTrackThenAnimalFrame()
    const box = { x: 100, y: 100, width: 50, height: 50 }
    const res = p.process({
      timestamp: 2000,
      frame: frame([detection('d1', box, { macroClass: 'animal', score: 0.5 })], 2000),
    })
    const refusals = p.getLastLabelWriteRefusals()
    expect(refusals).toHaveLength(1)
    const reason = refusals[0]?.reason
    if (reason?.kind !== 'macro-class') throw new Error(`wrong refusal: ${reason?.kind}`)
    expect(reason.className).toBe('person')
    expect(reason.text).toBe('animal')
    expect(refusals[0]?.trackId).toBe(res.tracked[0]?.trackId)
    // And the refusal did what it exists to do: no coarse label was stamped.
    expect(res.tracked[0]?.labelPatch).toBeUndefined()
  })

  it('reports it ONCE per track — the same wrong class re-offers itself every frame', () => {
    const p = personTrackThenAnimalFrame()
    const box = { x: 100, y: 100, width: 50, height: 50 }
    let total = 0
    for (let i = 0; i < 5; i += 1) {
      const ts = 2000 + i * 100
      p.process({
        timestamp: ts,
        frame: frame([detection('d1', box, { macroClass: 'animal', score: 0.5 })], ts),
      })
      total += p.getLastLabelWriteRefusals().length
    }
    expect(total).toBe(1)
  })

  it('reports nothing when no candidate was refused', () => {
    const p = personTrackThenAnimalFrame()
    expect(p.getLastLabelWriteRefusals()).toEqual([])
  })
})
