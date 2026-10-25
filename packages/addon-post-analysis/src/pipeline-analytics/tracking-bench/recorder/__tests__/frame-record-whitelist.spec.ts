/**
 * The whitelist guard of spec §3.5: feed the writer a `FrameResult` with EVERY
 * optional field populated (enforced by `satisfies Required<…>` in the
 * fixtures) and assert the record's key set EQUALS the schema's — so a field
 * whitelisted without a schema change fails here, and so does a schema field
 * the writer forgot to fill.
 *
 * And the privacy half (§3.6): the recognised name, the plate text, the base64
 * crops and vectors appear nowhere in the serialised record, and the runner's
 * arcface marker is not mistaken for an identity (review H2a).
 *
 * Disarms: add `labels: d.labels` to `tapeDetection` — the key-set test and
 * the schema parse must fail; delete `landmarks` from `FULL` — the premise test
 * must fail.
 */
import { describe, expect, it } from 'vitest'
import { TapeDetectionSchema, TapeFrameSchema } from '../../tape-schema.js'
import {
  buildFrameRecord,
  buildSkipRecord,
  DETECTION_FIELD_FATE,
  FRAME_FIELD_FATE,
  TapeFaceRemap,
} from '../frame-record.js'
import { FACE_AS_SHIPPED, FRAME, FULL, faces, OBSERVATION } from './frame-record-fixtures.js'

/** Ordinals follow `FRAME.detections`: FULL, FACE_AS_SHIPPED, FACE_RECOGNISED, PLATE. */
const FACE_AS_SHIPPED_ORDINAL = `d${String(FRAME.detections.indexOf(FACE_AS_SHIPPED))}`

describe('frame record whitelist', () => {
  const record = buildFrameRecord({
    t: 140,
    plane: 'pipeline',
    frame: FRAME,
    injectedIds: new Set(['p-1']),
    observation: OBSERVATION,
    faces,
  })

  it("populates every field the fate tables decide — the guard's premise", () => {
    expect(Object.keys(FULL).toSorted()).toEqual(Object.keys(DETECTION_FIELD_FATE).toSorted())
    expect(Object.keys(FRAME).toSorted()).toEqual(Object.keys(FRAME_FIELD_FATE).toSorted())
  })

  it('parses under the strict schema', () => {
    expect(() => TapeFrameSchema.parse(record)).not.toThrow()
  })

  it('fills exactly the whitelisted detection keys when the input populates everything', () => {
    const union = new Set(record.dets.flatMap((d) => Object.keys(d)))
    expect([...union].toSorted()).toEqual(Object.keys(TapeDetectionSchema.shape).toSorted())
  })

  it('fills exactly the whitelisted frame keys', () => {
    expect(Object.keys(record).toSorted()).toEqual(Object.keys(TapeFrameSchema.shape).toSorted())
  })

  it('keeps boxes verbatim and drops discards under 0.3', () => {
    expect(record.dets[0]?.b).toEqual([10.25, 20.5, 30, 90])
    // corners [1, 2, 3, 4] → [x, y, w, h] = [1, 2, 2, 2]
    expect(record.disc).toEqual([{ b: [1, 2, 2, 2], cls: 'animal', s: 0.31, r: 'below-threshold' }])
  })

  it('carries no name, plate text, crop, mask, vector or producer track id', () => {
    const json = JSON.stringify(record)
    for (const secret of [
      'Alice',
      'AB123CD',
      'SECRET',
      'ALIGNED',
      'AAAA',
      'clip',
      'embedding',
      'SECRETTRACK',
    ]) {
      expect(json).not.toContain(secret)
    }
    expect(record.dets.find((d) => d.fid !== undefined)?.fid).toMatch(/^h:[0-9a-f]{12}$/)
  })

  it('gives a face as the runner ships it (arcface marker only) no identity', () => {
    const face = record.dets.find((d) => d.id === FACE_AS_SHIPPED_ORDINAL)
    expect(face?.cls).toBe('face')
    expect(face?.fid).toBeUndefined()
    expect(face?.fs).toBeUndefined()
  })

  it('skip records carry the same detections and no live facts', () => {
    const skip = buildSkipRecord({ t: 0, plane: 'pipeline', frame: FRAME, faces })
    expect(skip.dets).toEqual(record.dets)
    expect(Object.keys(skip)).not.toContain('live')
  })
})

describe('TapeFaceRemap', () => {
  it('maps hub pseudonyms to p1, p2 by first appearance, stably', () => {
    const remap = new TapeFaceRemap()
    expect(remap.remap('h:aaaaaaaaaaaa')).toBe('p1')
    expect(remap.remap('h:bbbbbbbbbbbb')).toBe('p2')
    expect(remap.remap('h:aaaaaaaaaaaa')).toBe('p1')
  })
})
