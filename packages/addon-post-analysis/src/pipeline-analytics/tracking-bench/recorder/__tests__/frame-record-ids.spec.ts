/**
 * A producer's detection id never reaches a tape (review H1). The onboard plane
 * mints `onboard-<Date.now()>-<i>` (`detection-source-plan.ts`), so a verbatim
 * id would carry the wall clock — and the hour of day — into every onboard
 * record of a public repo (§3.6). Every id is replaced by a per-frame ordinal,
 * and the SAME map rewrites every reference: `dets.id`, `pid`, `inj`,
 * `gate.strong.det`, `gate.weak`, `live.det`. Nothing binds a detection id
 * across frames (the tracker reports the id of THIS frame's box), so per-frame
 * is enough.
 *
 * Disarm: make `FrameIdMap.ordinal` return its input — the no-epoch test and
 * the ordinal test must fail.
 */
import type { FrameResult, ObjectDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { FrameObservation } from '../../../pipeline/frame-observation.js'
import { TapeFrameSchema } from '../../tape-schema.js'
import { buildFrameRecord, buildSkipRecord } from '../frame-record.js'
import { faces } from './frame-record-fixtures.js'

const EPOCH = '1727600000123'

function onboard(i: number, over: Partial<ObjectDetection> = {}): ObjectDetection {
  return {
    id: `onboard-${EPOCH}-${String(i)}`,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.8,
    labels: [],
    bbox: { x: 10 * i, y: 10, width: 20, height: 40 },
    ...over,
  }
}

const PERSON = onboard(0)
const OTHER = onboard(1)
const FACE = onboard(2, { kind: 'detail', macroClass: 'face', parentId: PERSON.id })

const FRAME: FrameResult = {
  kind: 'frame',
  frameId: `onboard-frame-${EPOCH}`,
  deviceId: 101,
  timestamp: Number(EPOCH),
  width: 1920,
  height: 1080,
  detections: [PERSON, OTHER, FACE],
}

const OBSERVATION: FrameObservation = {
  gate: {
    strong: [{ detectionId: OTHER.id, entryId: 'entry-1' }],
    weak: [FACE.id],
    confirmed: ['entry-1'],
    woken: [],
  },
  live: [
    { trackId: 'trk-a', detectionId: PERSON.id, matched: true, state: 'moving' },
    // A reference to a box that is not among the frame's detections still must
    // not be copied verbatim.
    { trackId: 'trk-b', detectionId: `onboard-${EPOCH}-9`, matched: true, state: 'moving' },
    { trackId: 'trk-c', matched: false, state: 'moving' },
  ],
}

describe('frame record detection ids', () => {
  const record = buildFrameRecord({
    t: 0,
    plane: 'onboard',
    frame: FRAME,
    injectedIds: new Set([OTHER.id]),
    observation: OBSERVATION,
    faces,
  })

  it('carries no producer id, so no absolute time, anywhere in the record', () => {
    expect(JSON.stringify(record)).not.toContain(EPOCH)
    expect(TapeFrameSchema.parse(record)).toEqual(record)
  })

  it('numbers detections by their order in the frame and rewrites every reference', () => {
    expect(record.dets.map((d) => d.id)).toEqual(['d0', 'd1', 'd2'])
    expect(record.dets[2]?.pid).toBe('d0')
    expect(record.inj).toEqual(['d1'])
    expect(record.gate?.strong).toEqual([{ det: 'd1', entry: 'entry-1' }])
    expect(record.gate?.weak).toEqual(['d2'])
    expect(record.live.map((l) => l.det)).toEqual(['d0', 'd3', undefined])
  })

  it('a skip record numbers the same frame the same way', () => {
    const skip = buildSkipRecord({ t: 0, plane: 'onboard', frame: FRAME, faces })
    expect(skip.dets).toEqual(record.dets)
    expect(JSON.stringify(skip)).not.toContain(EPOCH)
  })
})
