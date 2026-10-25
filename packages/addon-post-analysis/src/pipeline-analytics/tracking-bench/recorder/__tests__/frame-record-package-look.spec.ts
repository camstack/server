/**
 * A tape records whether the package step LOOKED at a frame (`pl`, D687).
 *
 * Without it the early pick-up rule could not be measured on real data: the
 * 2026-09-30 tapes of 101 show the parcel on six frames and nothing on the
 * other 22 516, and nothing says which of those the package step ran on.
 */
import type { FrameResult } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { TapeFrameSchema } from '../../tape-schema.js'
import { buildFrameRecord } from '../frame-record.js'
import { faces } from './frame-record-fixtures.js'

const FRAME: FrameResult = {
  kind: 'frame',
  frameId: 'f',
  deviceId: 101,
  timestamp: 0,
  width: 640,
  height: 360,
  detections: [],
}

function recordOf(frame: FrameResult) {
  return buildFrameRecord({
    t: 0,
    plane: 'pipeline',
    frame,
    injectedIds: new Set(),
    observation: { gate: { strong: [], weak: [], confirmed: [], woken: [] }, live: [] },
    faces,
  })
}

describe('the package look on a tape frame', () => {
  it('records pl when the package step ran, and the record still parses', () => {
    const rec = recordOf({ ...FRAME, packageLooked: true })
    expect(rec.pl).toBe(true)
    expect(TapeFrameSchema.parse(rec).pl).toBe(true)
  })

  it('omits pl when nobody looked — absence, never false', () => {
    expect('pl' in recordOf(FRAME)).toBe(false)
  })
})
